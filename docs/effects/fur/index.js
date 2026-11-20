// Evolution of Fur — instanced Shell Texturing + 24,000 Geometric Clumped 3D Strands renderer,
// live 64x32 spring-damper wind & shake groom solver, gl.SCISSOR_TEST split screen, and click-to-pet!

import {
  clamp, norm3, cross3, cameraBasisFromOrbit, FULL_VS, linkPrograms, makeTex2D,
} from "../../src/gl-utils.js";
import {
  GROOM_W, GROOM_H, POLLEN_COUNT,
  buildFoxShellMesh, buildBasePedestalMesh, buildFoxFeaturesMesh,
  buildClumpedStrands, createGroomSim, buildPollenBuffer,
} from "./groom.js";
import {
  SKY_FS, SOLID_VS, SOLID_FS, SHELL_VS, SHELL_FS, STRAND_VS, STRAND_FS, POLLEN_VS, POLLEN_FS,
} from "./shaders.js";

const SIM_DT = 1.0 / 60.0;
const BACK_SUN_DIR = norm3(-0.62, 0.58, -0.58); // Golden forest sun behind ears -> backlit rim halo!
const FRONT_KEY_DIR = norm3(0.68, 0.56, 0.52);  // Warm key light sculpting cheeks & Kajiya-Kay sheen!

function mat4Mul(a, b) {
  const out = new Float32Array(16);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      out[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
    }
  }
  return out;
}

function mat4Perspective(fovDeg, aspect, near, far) {
  const f = 1.0 / Math.tan((fovDeg * Math.PI) / 360), nf = 1.0 / (near - far);
  return new Float32Array([f / aspect, 0, 0, 0, 0, f, 0, 0, 0, 0, (far + near) * nf, -1, 0, 0, 2 * far * near * nf, 0]);
}

function mat4LookAt(eye, target) {
  const f = norm3(target[0] - eye[0], target[1] - eye[1], target[2] - eye[2]);
  const s = norm3(...cross3(f, [0, 1, 0]));
  const u = cross3(s, f);
  return new Float32Array([
    s[0], u[0], -f[0], 0, s[1], u[1], -f[1], 0, s[2], u[2], -f[2], 0,
    -(s[0] * eye[0] + s[1] * eye[1] + s[2] * eye[2]),
    -(u[0] * eye[0] + u[1] * eye[1] + u[2] * eye[2]),
    (f[0] * eye[0] + f[1] * eye[1] + f[2] * eye[2]), 1,
  ]);
}

function createSolidVao(gl, mesh) {
  const vao = gl.createVertexArray(); gl.bindVertexArray(vao);
  const vbo = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, vbo); gl.bufferData(gl.ARRAY_BUFFER, mesh.vertices, gl.STATIC_DRAW);
  const ebo = gl.createBuffer(); gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ebo); gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, mesh.indices, gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 36, 0);
  gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 36, 12);
  gl.enableVertexAttribArray(2); gl.vertexAttribPointer(2, 2, gl.FLOAT, false, 36, 24);
  gl.enableVertexAttribArray(3); gl.vertexAttribPointer(3, 1, gl.FLOAT, false, 36, 32);
  gl.bindVertexArray(null);
  return { vao, count: mesh.indices.length };
}

export function createFurEffect(gl) {
  const [progSky, progSolid, progShell, progStrand, progPollen] = linkPrograms(gl, [
    [FULL_VS, SKY_FS],
    [SOLID_VS, SOLID_FS],
    [SHELL_VS, SHELL_FS],
    [STRAND_VS, STRAND_FS],
    [POLLEN_VS, POLLEN_FS],
  ]);
  const vaoFull = gl.createVertexArray();

  const pedMesh = createSolidVao(gl, buildBasePedestalMesh());
  const featMesh = createSolidVao(gl, buildFoxFeaturesMesh());

  // Sculpted fox shell mesh VAO (12 floats / vertex = 48 bytes)
  const shellData = buildFoxShellMesh();
  const vaoShell = gl.createVertexArray(); gl.bindVertexArray(vaoShell);
  const vboShell = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, vboShell);
  gl.bufferData(gl.ARRAY_BUFFER, shellData.vertices, gl.STATIC_DRAW);
  const eboShell = gl.createBuffer(); gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, eboShell);
  gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, shellData.indices, gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 48, 0);
  gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 48, 12);
  gl.enableVertexAttribArray(2); gl.vertexAttribPointer(2, 2, gl.FLOAT, false, 48, 24);
  gl.enableVertexAttribArray(3); gl.vertexAttribPointer(3, 3, gl.FLOAT, false, 48, 32);
  gl.enableVertexAttribArray(4); gl.vertexAttribPointer(4, 1, gl.FLOAT, false, 48, 44);
  gl.bindVertexArray(null);
  const shellIdxCount = shellData.indices.length;

  // 24,000 instanced clumped 3D fur strands VAO (12 floats / instance = 48 bytes)
  const strands = buildClumpedStrands();
  const vaoStrands = gl.createVertexArray(); gl.bindVertexArray(vaoStrands);
  const vboStrands = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, vboStrands);
  gl.bufferData(gl.ARRAY_BUFFER, strands.data, gl.STATIC_DRAW);
  for (let loc = 0; loc < 4; loc++) {
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 3, gl.FLOAT, false, 48, loc * 12);
    gl.vertexAttribDivisor(loc, 1);
  }
  gl.bindVertexArray(null);

  // Sunlit forest pollen motes VAO
  const vaoPollen = gl.createVertexArray(); gl.bindVertexArray(vaoPollen);
  const vboPollen = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, vboPollen);
  gl.bufferData(gl.ARRAY_BUFFER, buildPollenBuffer(), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 4, gl.FLOAT, false, 0, 0);
  gl.bindVertexArray(null);

  // Live 64x32 groom velocity/displacement texture
  const groom = createGroomSim();
  const texGroom = makeTex2D(gl, GROOM_W, GROOM_H, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, gl.LINEAR, groom.texBuf, gl.REPEAT);

  let simTime = 0, acc = 0;
  let showSlices = false;
  let shakeT = -1.0;
  let headYaw = 0.0;
  let prevHeadYaw = 0.0;
  let prevHeadVel = 0.0;

  function evalShakeYaw(t) {
    if (t < 0.0 || t > 3.2) return 0.0;
    // Playful fox head shake: quick left-right-left-right decay like shaking off forest dew!
    const env = Math.sin(Math.min(1, t / 0.35) * Math.PI * 0.5) * Math.exp(-Math.max(0, t - 0.35) * 1.45);
    return Math.sin(t * 14.5) * 0.52 * env;
  }

  function drawSceneHalf(vp, camPos, st, untexLeft) {
    gl.enable(gl.DEPTH_TEST);
    gl.depthMask(true);
    gl.disable(gl.CULL_FACE);

    // 1. Solid forest stump (fixed) + glossy fox eyes & nose (rotating with headYaw!)
    gl.useProgram(progSolid);
    gl.uniformMatrix4fv(gl.getUniformLocation(progSolid, "uVP"), false, vp);
    gl.uniform3fv(gl.getUniformLocation(progSolid, "uCamPos"), camPos);
    gl.uniform3fv(gl.getUniformLocation(progSolid, "uLightDir"), BACK_SUN_DIR);
    gl.uniform3fv(gl.getUniformLocation(progSolid, "uKeyDir"), FRONT_KEY_DIR);
    gl.uniform1f(gl.getUniformLocation(progSolid, "uHeadYaw"), st === 7 ? headYaw : 0.0);

    gl.uniform1f(gl.getUniformLocation(progSolid, "uApplyHeadRot"), 0.0);
    gl.bindVertexArray(pedMesh.vao);
    gl.drawElements(gl.TRIANGLES, pedMesh.count, gl.UNSIGNED_SHORT, 0);

    gl.uniform1f(gl.getUniformLocation(progSolid, "uApplyHeadRot"), 1.0);
    gl.bindVertexArray(featMesh.vao);
    gl.drawElements(gl.TRIANGLES, featMesh.count, gl.UNSIGNED_SHORT, 0);

    // 2. Base fox head & instanced shell layers (1 for flat/normal/undercoat, 8 for Step 3, 40 for Steps 4-6!)
    const layers = st === 2 ? 8 : (st >= 3 && st <= 5 ? 40 : 1);
    gl.useProgram(progShell);
    gl.uniformMatrix4fv(gl.getUniformLocation(progShell, "uVP"), false, vp);
    gl.uniform1f(gl.getUniformLocation(progShell, "uHeadYaw"), st === 7 ? headYaw : 0.0);
    gl.uniform1i(gl.getUniformLocation(progShell, "uLayerCount"), layers);
    gl.uniform1i(gl.getUniformLocation(progShell, "uStage"), st);
    gl.uniform1f(gl.getUniformLocation(progShell, "uShowSlices"), (showSlices && st === 2) ? 1.0 : 0.0);
    gl.uniform1f(gl.getUniformLocation(progShell, "uTime"), simTime);
    gl.uniform3fv(gl.getUniformLocation(progShell, "uCamPos"), camPos);
    gl.uniform3fv(gl.getUniformLocation(progShell, "uLightDir"), BACK_SUN_DIR);
    gl.uniform3fv(gl.getUniformLocation(progShell, "uKeyDir"), FRONT_KEY_DIR);
    gl.uniform1f(gl.getUniformLocation(progShell, "uUntexLeft"), untexLeft ? 1.0 : 0.0);
    gl.bindVertexArray(vaoShell);
    gl.drawElementsInstanced(gl.TRIANGLES, shellIdxCount, gl.UNSIGNED_SHORT, 0, layers);

    // 3. Steps 7-8: 24,000 geometric clumped 5-segment 3D fur ribbons!
    if (st >= 6) {
      gl.useProgram(progStrand);
      gl.uniformMatrix4fv(gl.getUniformLocation(progStrand, "uVP"), false, vp);
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, texGroom);
      gl.uniform1i(gl.getUniformLocation(progStrand, "uTexGroom"), 0);
      gl.uniform3fv(gl.getUniformLocation(progStrand, "uCamPos"), camPos);
      gl.uniform1f(gl.getUniformLocation(progStrand, "uHeadYaw"), st === 7 ? headYaw : 0.0);
      gl.uniform1f(gl.getUniformLocation(progStrand, "uTime"), simTime);
      gl.uniform1i(gl.getUniformLocation(progStrand, "uStage"), st);
      gl.uniform3fv(gl.getUniformLocation(progStrand, "uLightDir"), BACK_SUN_DIR);
      gl.uniform3fv(gl.getUniformLocation(progStrand, "uKeyDir"), FRONT_KEY_DIR);
      gl.bindVertexArray(vaoStrands);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 12, strands.count);
    }

    // 4. Sunlit golden forest pollen motes on Step 8!
    if (st === 7) {
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE);
      gl.depthMask(false);
      gl.useProgram(progPollen);
      gl.uniformMatrix4fv(gl.getUniformLocation(progPollen, "uVP"), false, vp);
      gl.uniform1f(gl.getUniformLocation(progPollen, "uTime"), simTime);
      gl.bindVertexArray(vaoPollen);
      gl.drawArrays(gl.POINTS, 0, POLLEN_COUNT);
      gl.depthMask(true);
      gl.disable(gl.BLEND);
    }
  }

  return {
    id: "fur",
    maxPixels: 1400000,
    defaultCamera: {
      yaw: 0.24,
      pitch: 0.16,
      dist: 6.25,
      lookY: 1.08,
      fovDeg: 38,
      minDist: 3.0,
      maxDist: 10.5,
      minPitch: -0.15,
      maxPitch: 1.10,
      autoOrbitSpeed: 0.0,
    },
    enterStep(stepIdx) {
      if (stepIdx !== 2) showSlices = false;
      if (stepIdx === 7) shakeT = 0.0;
    },
    onReset() {
      groom.reset();
      shakeT = -1.0;
      headYaw = 0.0;
    },
    triggerAction(actionId) {
      if (actionId === "slices") showSlices = !showSlices;
      else if (actionId === "shake") shakeT = 0.0;
    },
    isActionActive(actionId) {
      if (actionId === "slices") return showSlices;
      if (actionId === "shake") return shakeT >= 0.0 && shakeT < 3.1;
      return false;
    },
    onCanvasClick(ndcX, ndcY, w, h, step, cam) {
      if (step.stage !== 7) return false;
      const aspect = w / Math.max(1, h);
      const portraitScale = aspect < 0.95 ? clamp(1.04 / Math.max(aspect, 0.54), 1.0, 1.56) : 1.0;
      const basis = cameraBasisFromOrbit(cam.yaw, cam.pitch, cam.dist * portraitScale, cam.lookY);
      const tanHalfFov = Math.tan(((cam.fovDeg * Math.PI) / 180) * 0.5);
      const rd = norm3(
        basis.fwd[0] + ndcX * aspect * tanHalfFov * basis.right[0] + ndcY * tanHalfFov * basis.up[0],
        basis.fwd[1] + ndcX * aspect * tanHalfFov * basis.right[1] + ndcY * tanHalfFov * basis.up[1],
        basis.fwd[2] + ndcX * aspect * tanHalfFov * basis.right[2] + ndcY * tanHalfFov * basis.up[2],
      );
      // Ray-sphere test against fox head center (0, 1.12, 0), radius 1.15
      const oc = [basis.pos[0], basis.pos[1] - 1.12, basis.pos[2]];
      const b = oc[0] * rd[0] + oc[1] * rd[1] + oc[2] * rd[2];
      const c = oc[0] * oc[0] + oc[1] * oc[1] + oc[2] * oc[2] - 1.18 * 1.18;
      const disc = b * b - c;
      if (disc <= 0) return false;
      const t = -b - Math.sqrt(disc);
      if (t <= 0.1) return false;
      const hx = oc[0] + rd[0] * t, hy = oc[1] + rd[1] * t, hz = oc[2] + rd[2] * t;
      const [dx, dy, dz] = norm3(hx, hy, hz);
      const u = (Math.atan2(dz, dx) / (Math.PI * 2) + 1.25) % 1.0;
      const v = Math.acos(clamp(dy, -1, 1)) / Math.PI;
      // Comb fur gently upward/sideways where clicked ("pet the fox"!)
      groom.petAtUV(u, v, basis.right[0] * 0.9, 0.55, basis.right[2] * 0.9, 0.20);
      return true;
    },
    update(dt, paused, step, split) {
      if (paused) return;
      simTime += dt;
      acc += Math.min(dt, 0.05);

      const stL = split.enabled ? step.compareLeft : step.stage;
      const stR = split.enabled ? step.compareRight : step.stage;
      if (stL !== 7 && stR !== 7) {
        headYaw = 0.0;
        return;
      }

      let steps = 0;
      while (acc >= SIM_DT && steps < 3) {
        acc -= SIM_DT;
        if (shakeT >= 0.0) {
          shakeT += SIM_DT;
          if (shakeT > 3.2) shakeT = -1.0;
        }
        prevHeadYaw = headYaw;
        headYaw = evalShakeYaw(shakeT);
        const curVel = (headYaw - prevHeadYaw) / SIM_DT;
        const headAngAcc = clamp((curVel - prevHeadVel) * 0.08, -3.5, 3.5);
        prevHeadVel = curVel;

        const gust = 0.65 + 0.45 * Math.sin(simTime * 1.6) + (shakeT >= 0 && shakeT < 2.2 ? 0.85 : 0.0);
        groom.step(SIM_DT, simTime, gust, headAngAcc);
        steps++;
      }

      if (steps > 0) {
        gl.bindTexture(gl.TEXTURE_2D, texGroom);
        gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, GROOM_W, GROOM_H, gl.RGBA, gl.UNSIGNED_BYTE, groom.texBuf);
      }
    },
    getTechBadge(stepIdx) {
      const tags = [
        "1992 · FLAT PAINTED",
        "1998 · NORMAL MAP",
        "2001 · 8 SHELL LAYERS",
        "2005 · 40 SHELLS + AO",
        "2011 · KAJIYA–KAY",
        "2016 · MARSCHNER + RIM",
        "2020 · 30K 3D STRANDS",
        "2026 · LIVE GROOM · CLICK",
      ];
      return tags[stepIdx] || "";
    },
    render(w, h, step, split, cam) {
      const aspect = w / Math.max(1, h);
      const portraitScale = aspect < 0.95 ? clamp(1.04 / Math.max(aspect, 0.54), 1.0, 1.56) : 1.0;
      const basis = cameraBasisFromOrbit(cam.yaw, cam.pitch, cam.dist * portraitScale, cam.lookY);
      const tanHalfFov = Math.tan(((cam.fovDeg * Math.PI) / 180) * 0.5);
      const vp = mat4Mul(mat4Perspective(cam.fovDeg, aspect, 0.1, 40.0), mat4LookAt(basis.pos, [0, cam.lookY, 0]));

      const stL = split.enabled ? step.compareLeft : step.stage;
      const stR = split.enabled ? step.compareRight : step.stage;

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
      gl.uniform3fv(gl.getUniformLocation(progSky, "uLightDir"), BACK_SUN_DIR);
      gl.bindVertexArray(vaoFull);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

      gl.depthMask(true);
      gl.clear(gl.DEPTH_BUFFER_BIT);

      if (!split.enabled) {
        drawSceneHalf(vp, basis.pos, stR, false);
      } else {
        const splitX = Math.round(clamp(split.pos, 0.02, 0.98) * w);
        gl.enable(gl.SCISSOR_TEST);
        gl.scissor(0, 0, splitX, h);
        gl.clear(gl.DEPTH_BUFFER_BIT);
        drawSceneHalf(vp, basis.pos, stL, step.untexSplit === true);

        gl.scissor(splitX, 0, w - splitX, h);
        gl.clear(gl.DEPTH_BUFFER_BIT);
        drawSceneHalf(vp, basis.pos, stR, false);
        gl.disable(gl.SCISSOR_TEST);
      }
      gl.bindVertexArray(null);
    },
  };
}
