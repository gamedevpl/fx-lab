// Evolution of Cloth — dual-simulation rasterized WebGL2 renderer with gl.SCISSOR_TEST split screen,
// 512x512 hardware PCF shadow map, click-to-gust & click-to-rip interaction.

import {
  clamp, norm3, cross3, cameraBasisFromOrbit, FULL_VS, linkPrograms, makeTex2D,
} from "../../src/gl-utils.js";
import {
  SPHERE_R, MAX_THREADS,
  buildRetroBannerTexture, buildStaticStageMesh, buildUnitSphereMesh,
  getSphereState, createClothSim,
} from "./simulation.js";
import {
  SKY_FS, SHADOW_VS, SHADOW_FS, SOLID_VS, SOLID_FS, CLOTH_VS, CLOTH_FS, THREAD_VS, THREAD_FS,
} from "./shaders.js";

const SM_SIZE = 512;
const SIM_DT = 1.0 / 60.0;
const LIGHT_DIR = norm3(-0.56, 0.62, -0.55);     // Back-left golden sun: casts dramatic banner shadow forward & powers SSS!
const BACK_LIGHT_DIR = norm3(0.76, 0.52, 0.42);  // Raking side-front key light: sculpts deep velvet fold valleys & gold embroidery!

function mat4Mul(a, b) {
  const out = new Float32Array(16);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      out[c * 4 + r] =
        a[0 * 4 + r] * b[c * 4 + 0] +
        a[1 * 4 + r] * b[c * 4 + 1] +
        a[2 * 4 + r] * b[c * 4 + 2] +
        a[3 * 4 + r] * b[c * 4 + 3];
    }
  }
  return out;
}

function mat4Perspective(fovDeg, aspect, near, far) {
  const f = 1.0 / Math.tan((fovDeg * Math.PI) / 360);
  const nf = 1.0 / (near - far);
  return new Float32Array([
    f / aspect, 0, 0, 0,
    0, f, 0, 0,
    0, 0, (far + near) * nf, -1,
    0, 0, 2 * far * near * nf, 0,
  ]);
}

function mat4LookAt(eye, target) {
  const f = norm3(target[0] - eye[0], target[1] - eye[1], target[2] - eye[2]);
  const s = norm3(...cross3(f, [0, 1, 0]));
  const u = cross3(s, f);
  return new Float32Array([
    s[0], u[0], -f[0], 0,
    s[1], u[1], -f[1], 0,
    s[2], u[2], -f[2], 0,
    -(s[0] * eye[0] + s[1] * eye[1] + s[2] * eye[2]),
    -(u[0] * eye[0] + u[1] * eye[1] + u[2] * eye[2]),
    (f[0] * eye[0] + f[1] * eye[1] + f[2] * eye[2]),
    1,
  ]);
}

function mat4Ortho(l, r, b, t, n, f) {
  return new Float32Array([
    2 / (r - l), 0, 0, 0,
    0, 2 / (t - b), 0, 0,
    0, 0, -2 / (f - n), 0,
    -(r + l) / (r - l), -(t + b) / (t - b), -(f + n) / (f - n), 1,
  ]);
}

function createSolidBuffers(gl, mesh) {
  const vao = gl.createVertexArray();
  gl.bindVertexArray(vao);
  const vbo = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
  gl.bufferData(gl.ARRAY_BUFFER, mesh.vertices, gl.STATIC_DRAW);
  const ebo = gl.createBuffer();
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ebo);
  gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, mesh.indices, gl.STATIC_DRAW);
  const stride = 9 * 4;
  gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 3, gl.FLOAT, false, stride, 0);
  gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 3, gl.FLOAT, false, stride, 12);
  gl.enableVertexAttribArray(2); gl.vertexAttribPointer(2, 2, gl.FLOAT, false, stride, 24);
  gl.enableVertexAttribArray(3); gl.vertexAttribPointer(3, 1, gl.FLOAT, false, stride, 32);
  gl.bindVertexArray(null);
  return { vao, count: mesh.indices.length };
}

function createClothBuffers(gl, sim) {
  const vao = gl.createVertexArray();
  gl.bindVertexArray(vao);
  const vbo = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
  gl.bufferData(gl.ARRAY_BUFFER, sim.gpuVerts, gl.DYNAMIC_DRAW);
  const ebo = gl.createBuffer();
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ebo);
  gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, sim.gpuIndices, gl.DYNAMIC_DRAW);
  const stride = 9 * 4;
  gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 3, gl.FLOAT, false, stride, 0);
  gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 3, gl.FLOAT, false, stride, 12);
  gl.enableVertexAttribArray(2); gl.vertexAttribPointer(2, 2, gl.FLOAT, false, stride, 24);
  gl.enableVertexAttribArray(3); gl.vertexAttribPointer(3, 1, gl.FLOAT, false, stride, 32);
  gl.bindVertexArray(null);
  return { vao, vbo, ebo };
}

export function createClothEffect(gl) {
  const [progSky, progShadow, progSolid, progCloth, progThread] = linkPrograms(gl, [
    [FULL_VS, SKY_FS],
    [SHADOW_VS, SHADOW_FS],
    [SOLID_VS, SOLID_FS],
    [CLOTH_VS, CLOTH_FS],
    [THREAD_VS, THREAD_FS],
  ]);
  const vaoFull = gl.createVertexArray();

  // Hardware 512x512 depth texture shadow map for crisp PCF self-shadowing!
  const texShadow = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, texShadow);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.DEPTH_COMPONENT24, SM_SIZE, SM_SIZE, 0, gl.DEPTH_COMPONENT, gl.UNSIGNED_INT, null);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  const fboShadow = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, fboShadow);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.TEXTURE_2D, texShadow, 0);
  gl.drawBuffers([gl.NONE]);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);

  const retro0 = buildRetroBannerTexture(0);
  const retro1 = buildRetroBannerTexture(1);
  const texRetro0 = makeTex2D(gl, retro0.width, retro0.height, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, gl.NEAREST, retro0.data);
  const texRetro1 = makeTex2D(gl, retro1.width, retro1.height, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, gl.NEAREST, retro1.data);

  const stageMesh = createSolidBuffers(gl, buildStaticStageMesh());
  const sphereMesh = createSolidBuffers(gl, buildUnitSphereMesh());

  // Two independent cloth simulations so Split-Screen compares real distinct physics side-by-side!
  const simMain = createClothSim();
  const simAlt = createClothSim();
  const clothBufMain = createClothBuffers(gl, simMain);
  const clothBufAlt = createClothBuffers(gl, simAlt);

  // Thread particle VAO
  const vaoThreads = gl.createVertexArray();
  gl.bindVertexArray(vaoThreads);
  const vboThreadPos = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, vboThreadPos);
  gl.bufferData(gl.ARRAY_BUFFER, simMain.threadPos, gl.DYNAMIC_DRAW);
  gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
  const vboThreadLife = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, vboThreadLife);
  gl.bufferData(gl.ARRAY_BUFFER, simMain.threadLife, gl.DYNAMIC_DRAW);
  gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 1, gl.FLOAT, false, 0, 0);
  const vboThreadCol = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, vboThreadCol);
  gl.bufferData(gl.ARRAY_BUFFER, simMain.threadCol, gl.DYNAMIC_DRAW);
  gl.enableVertexAttribArray(2); gl.vertexAttribPointer(2, 3, gl.FLOAT, false, 0, 0);
  gl.bindVertexArray(null);

  const lightVP = mat4Mul(
    mat4Ortho(-3.2, 3.2, -3.2, 3.2, 0.5, 14.0),
    mat4LookAt([LIGHT_DIR[0] * 6.5, 1.3 + LIGHT_DIR[1] * 6.5, LIGHT_DIR[2] * 6.5], [0, 1.25, 0]),
  );

  let simTime = 0, acc = 0;
  let wireOn = false;
  let ballT = -1.0;
  let ballMode = "tear";
  let lastStage = -1;

  // Quick 20-step warmup so cloth already drapes naturally on Frame 1!
  for (let i = 0; i < 20; i++) {
    simMain.stepPhysics(SIM_DT, i * SIM_DT, "aero2026", null, false);
    simAlt.stepPhysics(SIM_DT, i * SIM_DT, "xpbd2020", null, false);
  }

  function qualityForStage(st) {
    if (st === 3) return "verlet2004";
    if (st === 4 || st === 5) return "bend2009";
    if (st === 6) return "xpbd2020";
    return "aero2026";
  }

  function updateSimForStage(sim, st, dt, sphere, isSplitLeftOfWrap) {
    if (st === 0) {
      sim.fillAnalytic("flat1988", simTime);
    } else if (st === 1) {
      sim.fillAnalytic("rigid1996", simTime);
    } else if (st === 2) {
      sim.fillAnalytic("sine2000", simTime);
    } else {
      const sp = (st >= 6 && !isSplitLeftOfWrap) ? sphere : null;
      const canTear = st === 7;
      sim.stepPhysics(dt, simTime, qualityForStage(st), sp, canTear);
    }
  }

  function uploadCloth(buf, sim) {
    gl.bindBuffer(gl.ARRAY_BUFFER, buf.vbo);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, sim.gpuVerts);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, buf.ebo);
    gl.bufferSubData(gl.ELEMENT_ARRAY_BUFFER, 0, sim.gpuIndices);
  }

  function renderShadowMap(buf, indexCount, sphere) {
    gl.bindFramebuffer(gl.FRAMEBUFFER, fboShadow);
    gl.viewport(0, 0, SM_SIZE, SM_SIZE);
    gl.disable(gl.SCISSOR_TEST);
    gl.enable(gl.DEPTH_TEST);
    gl.depthMask(true);
    gl.clear(gl.DEPTH_BUFFER_BIT);
    gl.useProgram(progShadow);
    gl.uniformMatrix4fv(gl.getUniformLocation(progShadow, "uLightVP"), false, lightVP);

    // Banner
    gl.uniform3f(gl.getUniformLocation(progShadow, "uOffset"), 0, 0, 0);
    gl.uniform1f(gl.getUniformLocation(progShadow, "uScale"), 1.0);
    gl.bindVertexArray(buf.vao);
    gl.drawElements(gl.TRIANGLES, indexCount, gl.UNSIGNED_SHORT, 0);

    // Static poles & dais
    gl.bindVertexArray(stageMesh.vao);
    gl.drawElements(gl.TRIANGLES, stageMesh.count, gl.UNSIGNED_SHORT, 0);

    // Cannonball if active
    if (sphere && sphere.active) {
      gl.uniform3fv(gl.getUniformLocation(progShadow, "uOffset"), sphere.pos);
      gl.uniform1f(gl.getUniformLocation(progShadow, "uScale"), SPHERE_R);
      gl.bindVertexArray(sphereMesh.vao);
      gl.drawElements(gl.TRIANGLES, sphereMesh.count, gl.UNSIGNED_SHORT, 0);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  function drawSceneHalf(vp, camPos, st, buf, sim, sphere, freezeRetro, drawThreads) {
    // 1. Solid battlement, wrought-iron pole & brass cannonball
    gl.enable(gl.DEPTH_TEST);
    gl.depthMask(true);
    gl.disable(gl.CULL_FACE);
    gl.useProgram(progSolid);
    gl.uniformMatrix4fv(gl.getUniformLocation(progSolid, "uVP"), false, vp);
    gl.uniformMatrix4fv(gl.getUniformLocation(progSolid, "uLightVP"), false, lightVP);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, texShadow);
    gl.uniform1i(gl.getUniformLocation(progSolid, "uShadowMap"), 0);
    gl.uniform3fv(gl.getUniformLocation(progSolid, "uCamPos"), camPos);
    gl.uniform3fv(gl.getUniformLocation(progSolid, "uLightDir"), LIGHT_DIR);
    gl.uniform3fv(gl.getUniformLocation(progSolid, "uBackLightDir"), BACK_LIGHT_DIR);
    gl.uniform1i(gl.getUniformLocation(progSolid, "uStage"), st);

    gl.uniform3f(gl.getUniformLocation(progSolid, "uOffset"), 0, 0, 0);
    gl.uniform1f(gl.getUniformLocation(progSolid, "uScale"), 1.0);
    gl.bindVertexArray(stageMesh.vao);
    gl.drawElements(gl.TRIANGLES, stageMesh.count, gl.UNSIGNED_SHORT, 0);

    if (sphere && sphere.active && st >= 6) {
      gl.uniform3fv(gl.getUniformLocation(progSolid, "uOffset"), sphere.pos);
      gl.uniform1f(gl.getUniformLocation(progSolid, "uScale"), SPHERE_R);
      gl.bindVertexArray(sphereMesh.vao);
      gl.drawElements(gl.TRIANGLES, sphereMesh.count, gl.UNSIGNED_SHORT, 0);
    }

    // 2. Banner cloth mesh
    gl.useProgram(progCloth);
    gl.uniformMatrix4fv(gl.getUniformLocation(progCloth, "uVP"), false, vp);
    gl.uniformMatrix4fv(gl.getUniformLocation(progCloth, "uLightVP"), false, lightVP);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, texRetro0);
    gl.uniform1i(gl.getUniformLocation(progCloth, "uTexRetro0"), 0);
    gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, texRetro1);
    gl.uniform1i(gl.getUniformLocation(progCloth, "uTexRetro1"), 1);
    gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D, texShadow);
    gl.uniform1i(gl.getUniformLocation(progCloth, "uShadowMap"), 2);
    gl.uniform3fv(gl.getUniformLocation(progCloth, "uCamPos"), camPos);
    gl.uniform3fv(gl.getUniformLocation(progCloth, "uLightDir"), LIGHT_DIR);
    gl.uniform3fv(gl.getUniformLocation(progCloth, "uBackLightDir"), BACK_LIGHT_DIR);
    gl.uniform1f(gl.getUniformLocation(progCloth, "uTime"), simTime);
    gl.uniform1i(gl.getUniformLocation(progCloth, "uStage"), st);
    gl.uniform1f(gl.getUniformLocation(progCloth, "uFreezeRetro"), freezeRetro ? 1.0 : 0.0);
    gl.uniform1f(gl.getUniformLocation(progCloth, "uShowWire"), (wireOn && (st === 2 || st === 3)) ? 1.0 : 0.0);
    gl.bindVertexArray(buf.vao);
    gl.drawElements(gl.TRIANGLES, sim.activeIndexCount, gl.UNSIGNED_SHORT, 0);

    // 3. Shredded loose thread particles on Step 8!
    if (drawThreads && st === 7) {
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      gl.depthMask(false);
      gl.useProgram(progThread);
      gl.uniformMatrix4fv(gl.getUniformLocation(progThread, "uVP"), false, vp);
      gl.bindBuffer(gl.ARRAY_BUFFER, vboThreadPos); gl.bufferSubData(gl.ARRAY_BUFFER, 0, sim.threadPos);
      gl.bindBuffer(gl.ARRAY_BUFFER, vboThreadLife); gl.bufferSubData(gl.ARRAY_BUFFER, 0, sim.threadLife);
      gl.bindBuffer(gl.ARRAY_BUFFER, vboThreadCol); gl.bufferSubData(gl.ARRAY_BUFFER, 0, sim.threadCol);
      gl.bindVertexArray(vaoThreads);
      gl.drawArrays(gl.POINTS, 0, MAX_THREADS);
      gl.depthMask(true);
      gl.disable(gl.BLEND);
    }
  }

  return {
    id: "cloth",
    maxPixels: 1400000,
    defaultCamera: {
      yaw: 0.36,
      pitch: 0.24,
      dist: 6.4,
      lookY: 1.32,
      fovDeg: 38,
      minDist: 3.6,
      maxDist: 12.0,
      minPitch: -0.05,
      maxPitch: 1.15,
      autoOrbitSpeed: 0.0,
    },
    enterStep(stepIdx) {
      if (stepIdx !== 2 && stepIdx !== 3) wireOn = false;
      if (stepIdx !== lastStage) {
        simMain.reset();
        simAlt.reset();
        for (let i = 0; i < 16; i++) {
          simMain.stepPhysics(SIM_DT, simTime + i * SIM_DT, qualityForStage(stepIdx), null, false);
          simAlt.stepPhysics(SIM_DT, simTime + i * SIM_DT, qualityForStage(Math.max(0, stepIdx - 1)), null, false);
        }
        lastStage = stepIdx;
      }
      if (stepIdx === 6) {
        ballMode = "wrap";
        ballT = 0.0;
      } else if (stepIdx === 7) {
        ballMode = "tear";
        ballT = 0.0;
      } else {
        ballT = -1.0;
      }
    },
    onReset() {
      simMain.reset();
      simAlt.reset();
      if (lastStage === 6) { ballMode = "wrap"; ballT = 0.0; }
      else if (lastStage === 7) { ballMode = "tear"; ballT = 0.0; }
    },
    triggerAction(actionId) {
      if (actionId === "wire") wireOn = !wireOn;
      else if (actionId === "wrap") {
        simMain.reset();
        simAlt.reset();
        ballMode = "wrap";
        ballT = 0.0;
      } else if (actionId === "tear") {
        simMain.reset();
        simAlt.reset();
        ballMode = "tear";
        ballT = 0.0;
      }
    },
    isActionActive(actionId) {
      if (actionId === "wire") return wireOn;
      if (actionId === "wrap") return ballMode === "wrap" && ballT >= 0.0 && ballT < 4.5;
      if (actionId === "tear") return ballMode === "tear" && ballT >= 0.0 && ballT < 3.1;
      return false;
    },
    onCanvasClick(ndcX, ndcY, w, h, step, cam) {
      if (step.stage < 3) return false;
      const aspect = w / Math.max(1, h);
      const portraitScale = aspect < 0.95 ? clamp(1.04 / Math.max(aspect, 0.54), 1.0, 1.56) : 1.0;
      const basis = cameraBasisFromOrbit(cam.yaw, cam.pitch, cam.dist * portraitScale, cam.lookY);
      const tanHalfFov = Math.tan(((cam.fovDeg * Math.PI) / 180) * 0.5);
      const rd = norm3(
        basis.fwd[0] + ndcX * aspect * tanHalfFov * basis.right[0] + ndcY * tanHalfFov * basis.up[0],
        basis.fwd[1] + ndcX * aspect * tanHalfFov * basis.right[1] + ndcY * tanHalfFov * basis.up[1],
        basis.fwd[2] + ndcX * aspect * tanHalfFov * basis.right[2] + ndcY * tanHalfFov * basis.up[2],
      );
      const hit = simMain.raycastUV(basis.pos, rd);
      if (!hit) return false;
      if (step.stage === 7) {
        simMain.ripAtUV(hit.u, hit.v, 2.7);
        simMain.applyGustAtUV(hit.u, hit.v, 8.5);
      } else {
        simMain.applyGustAtUV(hit.u, hit.v, 9.5);
      }
      return true;
    },
    update(dt, paused, step, split) {
      if (paused) return;
      simTime += dt;
      acc += Math.min(dt, 0.05);

      const stL = split.enabled ? step.compareLeft : step.stage;
      const stR = split.enabled ? step.compareRight : step.stage;
      const isWrapSplit = split.enabled && step.wrapSplit;

      let steps = 0;
      while (acc >= SIM_DT && steps < 3) {
        acc -= SIM_DT;
        if (ballT >= 0.0) {
          ballT += SIM_DT;
          const maxDur = ballMode === "wrap" ? 4.6 : 2.8;
          if (ballT > maxDur) ballT = -1.0;
        }
        const sphere = getSphereState(ballT, ballMode);
        updateSimForStage(simMain, stR, SIM_DT, sphere, false);
        if (split.enabled && (stL !== stR || isWrapSplit)) {
          updateSimForStage(simAlt, stL, SIM_DT, sphere, isWrapSplit);
        }
        steps++;
      }

      uploadCloth(clothBufMain, simMain);
      if (split.enabled && (stL !== stR || isWrapSplit)) {
        uploadCloth(clothBufAlt, simAlt);
      }
    },
    getTechBadge(stepIdx) {
      const tags = [
        "1988 · 32×24 2-FRAME",
        "1996 · RIGID HINGE",
        "2000 · SINE VERTEX",
        "2004 · VERLET SPRINGS",
        "2009 · BEND + WEAVE",
        "2015 · CHARLIE SHEEN + SSS",
        "2020 · XPBD + SPHERE",
        "2026 · AERO + TEAR · CLICK",
      ];
      return tags[stepIdx] || "";
    },
    render(w, h, step, split, cam) {
      const aspect = w / Math.max(1, h);
      const portraitScale = aspect < 0.95 ? clamp(1.04 / Math.max(aspect, 0.54), 1.0, 1.56) : 1.0;
      const basis = cameraBasisFromOrbit(cam.yaw, cam.pitch, cam.dist * portraitScale, cam.lookY);
      const tanHalfFov = Math.tan(((cam.fovDeg * Math.PI) / 180) * 0.5);

      const proj = mat4Perspective(cam.fovDeg, aspect, 0.1, 45.0);
      const view = mat4LookAt(basis.pos, [0, cam.lookY, 0]);
      const vp = mat4Mul(proj, view);

      const stL = split.enabled ? step.compareLeft : step.stage;
      const stR = split.enabled ? step.compareRight : step.stage;
      const sphere = getSphereState(ballT, ballMode);

      // 1. Hardware 512x512 shadow map pass (when Steps 7 or 8 are visible)
      if (stL >= 6 || stR >= 6) {
        renderShadowMap(clothBufMain, simMain.activeIndexCount, sphere);
      }

      // 2. Full-screen golden-hour twilight sky backdrop
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, w, h);
      gl.disable(gl.SCISSOR_TEST);
      gl.disable(gl.DEPTH_TEST);
      gl.depthMask(false);
      gl.useProgram(progSky);
      gl.uniform3fv(gl.getUniformLocation(progSky, "uCamRight"), basis.right);
      gl.uniform3fv(gl.getUniformLocation(progSky, "uCamUp"), basis.up);
      gl.uniform3fv(gl.getUniformLocation(progSky, "uCamFwd"), basis.fwd);
      gl.uniform1f(gl.getUniformLocation(progSky, "uTanHalfFov"), tanHalfFov);
      gl.uniform1f(gl.getUniformLocation(progSky, "uAspect"), aspect);
      gl.uniform3fv(gl.getUniformLocation(progSky, "uLightDir"), LIGHT_DIR);
      gl.bindVertexArray(vaoFull);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

      gl.depthMask(true);
      gl.clear(gl.DEPTH_BUFFER_BIT);

      // 3. Draw scene (single full viewport or true physical gl.SCISSOR_TEST split!)
      if (!split.enabled) {
        drawSceneHalf(vp, basis.pos, stR, clothBufMain, simMain, sphere, false, true);
      } else {
        const splitX = Math.round(clamp(split.pos, 0.02, 0.98) * w);
        const useAlt = stL !== stR || !!step.wrapSplit;

        gl.enable(gl.SCISSOR_TEST);
        // Left half
        gl.scissor(0, 0, splitX, h);
        gl.clear(gl.DEPTH_BUFFER_BIT);
        drawSceneHalf(
          vp, basis.pos, stL,
          useAlt ? clothBufAlt : clothBufMain,
          useAlt ? simAlt : simMain,
          sphere,
          step.retroSplit === true,
          !useAlt,
        );

        // Right half
        gl.scissor(splitX, 0, w - splitX, h);
        gl.clear(gl.DEPTH_BUFFER_BIT);
        drawSceneHalf(vp, basis.pos, stR, clothBufMain, simMain, sphere, false, true);
        gl.disable(gl.SCISSOR_TEST);
      }
      gl.bindVertexArray(null);
    },
  };
}
