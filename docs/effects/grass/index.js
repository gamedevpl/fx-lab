// Evolution of Grass & Foliage (1992-2026) — GPU-instanced WebGL2 renderer:
// - 8 eras on one sculpted sunlit meadow hilltop with ancient standing runestone & stepping stones
// - Clean gl.scissor split-screen into RGBA16F HDR FBO + half-res bloom + ACES composite
// - Live 64x64 spring-damper trampling trail field driven by a rolling brass-wood orb & clicks!

import {
  clamp, norm3, cross3, cameraBasisFromOrbit, makeLookAt, makePerspective,
  FULL_VS, linkPrograms, makeTex2D, hdrFormat,
} from "../../src/gl-utils.js";
import {
  MEADOW_R, TRAIL_RES, TRAIL_SPAN, ORB_R,
  hillHeight, sampleOrbPath,
  buildHillMesh, buildPropsMesh, buildOrbMesh,
  buildXCardsMesh, buildShellsMesh,
  buildBladeGeometry, buildBladeInstances,
  buildFlowerGeometry, buildFlowerInstances, buildPollenData,
} from "./scene.js";
import {
  SKY_FS, TERRAIN_VS, TERRAIN_FS, PROP_VS, PROP_FS, ORB_VS, ORB_FS,
  XCARD_VS, XCARD_FS, SHELL_VS, SHELL_FS,
  BLADE_VS, BLADE_FS, FLOWER_VS, FLOWER_FS, POLLEN_VS, POLLEN_FS,
  BRIGHT_FS, BLUR_FS, FINAL_FS,
} from "./shaders.js";

const SUN_DIR = norm3(-0.48, 0.42, -0.77);

function mulMat4(a, b) {
  const out = new Float32Array(16);
  for (let col = 0; col < 4; col++) {
    const c4 = col * 4;
    for (let row = 0; row < 4; row++) {
      out[c4 + row] =
        a[row] * b[c4] +
        a[4 + row] * b[c4 + 1] +
        a[8 + row] * b[c4 + 2] +
        a[12 + row] * b[c4 + 3];
    }
  }
  return out;
}

// Rodrigues incremental 3x3 rotation (column-major Float32Array(9)) for true sphere rolling!
function rotateMat3Axis(m, ax, ay, az, angle) {
  const c = Math.cos(angle), s = Math.sin(angle), t = 1 - c;
  const r00 = t * ax * ax + c,      r01 = t * ax * ay - s * az, r02 = t * ax * az + s * ay;
  const r10 = t * ax * ay + s * az, r11 = t * ay * ay + c,      r12 = t * ay * az - s * ax;
  const r20 = t * ax * az - s * ay, r21 = t * ay * az + s * ax, r22 = t * az * az + c;
  // R * m (column-major)
  const o = new Float32Array(9);
  for (let col = 0; col < 3; col++) {
    const x = m[col * 3], y = m[col * 3 + 1], z = m[col * 3 + 2];
    o[col * 3]     = r00 * x + r01 * y + r02 * z;
    o[col * 3 + 1] = r10 * x + r11 * y + r12 * z;
    o[col * 3 + 2] = r20 * x + r21 * y + r22 * z;
  }
  return o;
}

function makeIndexedVao(gl, verts, indices, attribs, isUint32 = false) {
  const vao = gl.createVertexArray();
  gl.bindVertexArray(vao);
  const vbo = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
  gl.bufferData(gl.ARRAY_BUFFER, verts, gl.STATIC_DRAW);
  for (const [loc, size, stride, offset] of attribs) {
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, size, gl.FLOAT, false, stride * 4, offset * 4);
  }
  const ibo = gl.createBuffer();
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibo);
  gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, indices, gl.STATIC_DRAW);
  gl.bindVertexArray(null);
  return { vao, count: indices.length, type: isUint32 ? gl.UNSIGNED_INT : gl.UNSIGNED_SHORT };
}

export function createGrassEffect(gl) {
  const fmt = hdrFormat(gl);
  const [
    progSky, progTerrain, progProp, progOrb,
    progXCard, progShell, progBlade, progFlower, progPollen,
    progBright, progBlur, progFinal,
  ] = linkPrograms(gl, [
    [FULL_VS, SKY_FS],
    [TERRAIN_VS, TERRAIN_FS],
    [PROP_VS, PROP_FS],
    [ORB_VS, ORB_FS],
    [XCARD_VS, XCARD_FS],
    [SHELL_VS, SHELL_FS],
    [BLADE_VS, BLADE_FS],
    [FLOWER_VS, FLOWER_FS],
    [POLLEN_VS, POLLEN_FS],
    [FULL_VS, BRIGHT_FS],
    [FULL_VS, BLUR_FS],
    [FULL_VS, FINAL_FS],
  ]);

  const vaoEmpty = gl.createVertexArray();

  // Build static & instanced meshes once
  const hill = buildHillMesh();
  const vaoHill = makeIndexedVao(gl, hill.vertices, hill.indices, [
    [0, 3, 9, 0], [1, 3, 9, 3], [2, 2, 9, 6], [3, 1, 9, 8],
  ], true);

  const props = buildPropsMesh();
  const vaoProps = makeIndexedVao(gl, props.vertices, props.indices, [
    [0, 3, 9, 0], [1, 3, 9, 3], [2, 2, 9, 6], [3, 1, 9, 8],
  ], false);

  const orbMesh = buildOrbMesh();
  const vaoOrb = makeIndexedVao(gl, orbMesh.vertices, orbMesh.indices, [
    [0, 3, 8, 0], [1, 3, 8, 3], [2, 2, 8, 6],
  ], false);

  const xcards = buildXCardsMesh();
  const vaoXCards = makeIndexedVao(gl, xcards.vertices, xcards.indices, [
    [0, 3, 9, 0], [1, 2, 9, 3], [2, 3, 9, 5], [3, 1, 9, 8],
  ], true);

  const shells = buildShellsMesh();
  const vaoShells = makeIndexedVao(gl, shells.vertices, shells.indices, [
    [0, 3, 7, 0], [1, 3, 7, 3], [2, 1, 7, 6],
  ], true);

  // 22,000 GPU-instanced curved 3D grass blades
  const bladeGeo = buildBladeGeometry();
  const bladeInst = buildBladeInstances(22000);
  const vaoBlades = gl.createVertexArray();
  gl.bindVertexArray(vaoBlades);
  const bVbo = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, bVbo);
  gl.bufferData(gl.ARRAY_BUFFER, bladeGeo.vertices, gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 8, 0);
  const bIbo = gl.createBuffer();
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, bIbo);
  gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, bladeGeo.indices, gl.STATIC_DRAW);

  const bInstPos = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, bInstPos);
  gl.bufferData(gl.ARRAY_BUFFER, bladeInst.posH, gl.STATIC_DRAW);
  gl.enableVertexAttribArray(1);
  gl.vertexAttribPointer(1, 4, gl.FLOAT, false, 16, 0);
  gl.vertexAttribDivisor(1, 1);

  const bInstMeta = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, bInstMeta);
  gl.bufferData(gl.ARRAY_BUFFER, bladeInst.meta, gl.STATIC_DRAW);
  gl.enableVertexAttribArray(2);
  gl.vertexAttribPointer(2, 4, gl.FLOAT, false, 16, 0);
  gl.vertexAttribDivisor(2, 1);
  gl.bindVertexArray(null);

  // 650 GPU-instanced 3D wildflowers
  const flGeo = buildFlowerGeometry();
  const flInst = buildFlowerInstances(650);
  const vaoFlowers = gl.createVertexArray();
  gl.bindVertexArray(vaoFlowers);
  const fVbo = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, fVbo);
  gl.bufferData(gl.ARRAY_BUFFER, flGeo.vertices, gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 28, 0);
  gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 28, 12);
  gl.enableVertexAttribArray(2); gl.vertexAttribPointer(2, 1, gl.FLOAT, false, 28, 24);
  const fIbo = gl.createBuffer();
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, fIbo);
  gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, flGeo.indices, gl.STATIC_DRAW);

  const fInstPos = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, fInstPos);
  gl.bufferData(gl.ARRAY_BUFFER, flInst.posH, gl.STATIC_DRAW);
  gl.enableVertexAttribArray(3); gl.vertexAttribPointer(3, 4, gl.FLOAT, false, 16, 0); gl.vertexAttribDivisor(3, 1);

  const fInstMeta = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, fInstMeta);
  gl.bufferData(gl.ARRAY_BUFFER, flInst.meta, gl.STATIC_DRAW);
  gl.enableVertexAttribArray(4); gl.vertexAttribPointer(4, 4, gl.FLOAT, false, 16, 0); gl.vertexAttribDivisor(4, 1);
  gl.bindVertexArray(null);

  // 180 floating golden pollen motes
  const pollen = buildPollenData(180);
  const vaoPollen = gl.createVertexArray();
  gl.bindVertexArray(vaoPollen);
  const pVbo = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, pVbo);
  gl.bufferData(gl.ARRAY_BUFFER, pollen.data, gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 4, gl.FLOAT, false, 16, 0);
  gl.bindVertexArray(null);

  // 64x64 persistent spring-damper trampling trail texture (RGBA8: R=bendX, G=bendZ, B=flatten)
  const N = TRAIL_RES * TRAIL_RES;
  const trBX = new Float32Array(N);
  const trBZ = new Float32Array(N);
  const trFlat = new Float32Array(N);
  const trBytes = new Uint8Array(N * 4);
  for (let i = 0; i < N; i++) {
    trBytes[i * 4] = 128; trBytes[i * 4 + 1] = 128; trBytes[i * 4 + 2] = 0; trBytes[i * 4 + 3] = 255;
  }
  const texTrail = makeTex2D(gl, TRAIL_RES, TRAIL_RES, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, gl.LINEAR, trBytes, gl.CLAMP_TO_EDGE);

  function stampTrail(wx, wz, radius, pushStr, flatStr, vx = 0, vz = 0) {
    const half = TRAIL_SPAN * 0.5;
    const minI = Math.max(0, Math.floor(((wx - radius + half) / TRAIL_SPAN) * TRAIL_RES));
    const maxI = Math.min(TRAIL_RES - 1, Math.ceil(((wx + radius + half) / TRAIL_SPAN) * TRAIL_RES));
    const minJ = Math.max(0, Math.floor(((wz - radius + half) / TRAIL_SPAN) * TRAIL_RES));
    const maxJ = Math.min(TRAIL_RES - 1, Math.ceil(((wz + radius + half) / TRAIL_SPAN) * TRAIL_RES));
    const r2 = radius * radius;
    const vLen = Math.hypot(vx, vz);
    const vdx = vLen > 1e-4 ? vx / vLen : 0;
    const vdz = vLen > 1e-4 ? vz / vLen : 0;

    for (let j = minJ; j <= maxJ; j++) {
      const cz = ((j + 0.5) / TRAIL_RES) * TRAIL_SPAN - half;
      const dz = cz - wz;
      for (let i = minI; i <= maxI; i++) {
        const cx = ((i + 0.5) / TRAIL_RES) * TRAIL_SPAN - half;
        const dx = cx - wx;
        const d2 = dx * dx + dz * dz;
        if (d2 >= r2) continue;
        const d = Math.sqrt(d2);
        const w = 1.0 - d / radius;
        const smooth = w * w * (3 - 2 * w);
        const idx = j * TRAIL_RES + i;
        const rx = d > 1e-4 ? dx / d : vdx;
        const rz = d > 1e-4 ? dz / d : vdz;
        // Part blades radially outward + slight forward drag along rolling velocity
        const px = (rx * 0.78 + vdx * 0.35) * smooth * pushStr;
        const pz = (rz * 0.78 + vdz * 0.35) * smooth * pushStr;
        trBX[idx] = clamp(trBX[idx] * (1 - smooth * 0.65) + px, -1, 1);
        trBZ[idx] = clamp(trBZ[idx] * (1 - smooth * 0.65) + pz, -1, 1);
        trFlat[idx] = Math.max(trFlat[idx], clamp(smooth * flatStr, 0, 1));
      }
    }
  }

  function uploadTrail() {
    for (let i = 0; i < N; i++) {
      const o = i * 4;
      trBytes[o]     = clamp(Math.round((trBX[i] * 0.5 + 0.5) * 255), 0, 255);
      trBytes[o + 1] = clamp(Math.round((trBZ[i] * 0.5 + 0.5) * 255), 0, 255);
      trBytes[o + 2] = clamp(Math.round(trFlat[i] * 255), 0, 255);
      trBytes[o + 3] = 255;
    }
    gl.bindTexture(gl.TEXTURE_2D, texTrail);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, TRAIL_RES, TRAIL_RES, gl.RGBA, gl.UNSIGNED_BYTE, trBytes);
  }

  // HDR FBO + Depth Renderbuffer + Half-Res Bloom Chain
  let bufW = 0, bufH = 0, bw = 0, bh = 0;
  let texHdr = null, rboDepth = null, fboMain = null;
  let texBright = null, texBlurA = null, texBlurB = null;
  let fboBright = null, fboBlurA = null, fboBlurB = null;

  function allocTargets(w, h) {
    if (w === bufW && h === bufH) return;
    for (const t of [texHdr, texBright, texBlurA, texBlurB]) if (t) gl.deleteTexture(t);
    for (const f of [fboMain, fboBright, fboBlurA, fboBlurB]) if (f) gl.deleteFramebuffer(f);
    if (rboDepth) gl.deleteRenderbuffer(rboDepth);
    bufW = w; bufH = h;
    bw = Math.max(64, w >> 1);
    bh = Math.max(64, h >> 1);

    texHdr = makeTex2D(gl, w, h, fmt.internalFmt, fmt.fmt, fmt.type, gl.LINEAR);
    rboDepth = gl.createRenderbuffer();
    gl.bindRenderbuffer(gl.RENDERBUFFER, rboDepth);
    gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT24, w, h);

    fboMain = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fboMain);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texHdr, 0);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, rboDepth);

    texBright = makeTex2D(gl, bw, bh, fmt.internalFmt, fmt.fmt, fmt.type, gl.LINEAR);
    texBlurA  = makeTex2D(gl, bw, bh, fmt.internalFmt, fmt.fmt, fmt.type, gl.LINEAR);
    texBlurB  = makeTex2D(gl, bw, bh, fmt.internalFmt, fmt.fmt, fmt.type, gl.LINEAR);

    fboBright = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fboBright);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texBright, 0);

    fboBlurA = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fboBlurA);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texBlurA, 0);

    fboBlurB = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fboBlurB);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texBlurB, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  let simTime = 0;
  let orbPhase = 0;
  let orbPos = sampleOrbPath(0);
  let orbRot = new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1]);
  let orbBoost = 0;
  let showCardsOn = false;
  let showWireOn = false;
  let gustPulse = 0;

  return {
    id: "grass",
    maxPixels: 1100000,
    defaultCamera: {
      yaw: 0.24,
      pitch: 0.30,
      dist: 7.5,
      lookY: 0.42,
      fovDeg: 44,
      minDist: 3.4,
      maxDist: 11.5,
      minPitch: 0.08,
      maxPitch: 1.05,
      autoOrbitSpeed: 0.075,
    },
    enterStep(stepIdx) {
      if (stepIdx !== 1) showCardsOn = false;
      if (stepIdx !== 3) showWireOn = false;
    },
    onReset() {
      showCardsOn = false;
      showWireOn = false;
      gustPulse = 0;
      orbBoost = 0;
      trBX.fill(0); trBZ.fill(0); trFlat.fill(0);
      uploadTrail();
    },
    triggerAction(actionId) {
      if (actionId === "cards") showCardsOn = !showCardsOn;
      else if (actionId === "wire") showWireOn = !showWireOn;
      else if (actionId === "gust") gustPulse = 1.0;
      else if (actionId === "roll") {
        orbBoost = 1.0;
        gustPulse = Math.max(gustPulse, 0.72);
      }
    },
    isActionActive(actionId) {
      if (actionId === "cards") return showCardsOn;
      if (actionId === "wire") return showWireOn;
      if (actionId === "gust") return gustPulse > 0.12;
      if (actionId === "roll") return orbBoost > 0.12;
      return false;
    },
    onCanvasClick(ndcX, ndcY, w, h, step, cam) {
      if (step.stage < 4) return;
      const aspect = w / Math.max(1, h);
      const basis = cameraBasisFromOrbit(cam.yaw, cam.pitch, cam.dist, cam.lookY);
      const tanHalfFov = Math.tan(((cam.fovDeg * Math.PI) / 180) * 0.5);
      const rd = norm3(
        basis.fwd[0] + ndcX * aspect * tanHalfFov * basis.right[0] + ndcY * tanHalfFov * basis.up[0],
        basis.fwd[1] + ndcX * aspect * tanHalfFov * basis.right[1] + ndcY * tanHalfFov * basis.up[1],
        basis.fwd[2] + ndcX * aspect * tanHalfFov * basis.right[2] + ndcY * tanHalfFov * basis.up[2],
      );
      // March camera ray onto hillHeight(x, z)
      let hit = null;
      for (let t = 0.5; t < 18.0; t += 0.14) {
        const px = basis.pos[0] + rd[0] * t;
        const py = basis.pos[1] + rd[1] * t;
        const pz = basis.pos[2] + rd[2] * t;
        if (Math.hypot(px, pz) <= MEADOW_R && py <= hillHeight(px, pz) + 0.15) {
          hit = [px, pz];
          break;
        }
      }
      if (hit) {
        stampTrail(hit[0], hit[1], 1.15, 1.0, 0.92, 0.84, 0.54);
        uploadTrail();
      }
      gustPulse = Math.max(gustPulse, 0.85);
    },
    getTechBadge(stepIdx) {
      return [
        "1992 · PIXEL TILE",
        showCardsOn ? "1996 · X-CARDS EXPOSED" : "1996 · ALPHA X-CARDS",
        "2001 · 10 SHELL LAYERS",
        showWireOn ? "2007 · 22K BLADE MESH" : "2007 · 22K 3D BLADES",
        "2012 · WIND + ROOT AO",
        "2017 · BACKLIT SSS",
        "2022 · FLOWERS + CLOUDS",
        "2026 · LIVE TRAMPLING",
      ][stepIdx] || "WEBGL2";
    },
    resize(w, h) {
      allocTargets(w, h);
    },
    update(dt, paused, step) {
      if (paused) return;
      simTime += dt;
      gustPulse *= Math.exp(-dt * 1.15);
      orbBoost *= Math.exp(-dt * 1.05);

      // Exponential spring-back decay of flattened meadow trails (~3.8s visible curved wake!)
      const bendDecay = Math.exp(-dt * 0.62);
      const flatDecay = Math.exp(-dt * 0.30);
      for (let i = 0; i < N; i++) {
        trBX[i] *= bendDecay;
        trBZ[i] *= bendDecay;
        trFlat[i] *= flatDecay;
      }

      // Advance rolling brass-wood orb along meadow path and stamp its springy wake
      const orbSpeed = (1.0 / 36.0) * (1.0 + orbBoost * 1.85);
      orbPhase = (orbPhase + dt * orbSpeed) % 1.0;
      const nextPos = sampleOrbPath(orbPhase);
      const dx = nextPos[0] - orbPos[0];
      const dz = nextPos[2] - orbPos[2];
      const distMoved = Math.hypot(dx, dz);
      if (distMoved > 1e-5) {
        const up = [0, 1, 0];
        const vel = [dx / distMoved, 0, dz / distMoved];
        const axis = norm3(...cross3(up, vel));
        orbRot = rotateMat3Axis(orbRot, axis[0], axis[1], axis[2], distMoved / ORB_R);
      }
      orbPos = nextPos;

      if (step && step.stage >= 7) {
        stampTrail(orbPos[0], orbPos[2], 1.02, 1.0, 0.98, dx, dz);
      }
      uploadTrail();
    },
    render(w, h, step, split, cam) {
      allocTargets(w, h);
      const aspect = w / Math.max(1, h);
      const basis = cameraBasisFromOrbit(cam.yaw, cam.pitch, cam.dist, cam.lookY);
      const fovRad = (cam.fovDeg * Math.PI) / 180;
      const tanHalfFov = Math.tan(fovRad * 0.5);
      const view = makeLookAt(basis.pos, basis.target, [0, 1, 0]);
      const proj = makePerspective(fovRad, aspect, 0.1, 60.0);
      const viewProj = mulMat4(proj, view);

      const stageLeft = split.enabled ? step.compareLeft : step.stage;
      const stageRight = split.enabled ? step.compareRight : step.stage;
      const splitX = split.enabled ? split.pos : 0.0;
      const splitPx = split.enabled ? clamp(Math.round(splitX * w), 0, w) : 0;
      const solidLeft = split.enabled && !!step.solidSplit ? 1.0 : 0.0;
      const windPhase = (simTime / 36.0) % 1.0;

      gl.bindFramebuffer(gl.FRAMEBUFFER, fboMain);
      gl.viewport(0, 0, w, h);
      gl.enable(gl.SCISSOR_TEST);

      function renderHalf(stage, sx, sw, solidAmt) {
        if (sw <= 0) return;
        gl.scissor(sx, 0, sw, h);
        gl.clearDepth(1.0);
        gl.clear(gl.DEPTH_BUFFER_BIT);

        // 1. Sky backdrop (no depth write)
        gl.disable(gl.DEPTH_TEST);
        gl.disable(gl.BLEND);
        gl.useProgram(progSky);
        gl.uniform3fv(gl.getUniformLocation(progSky, "uCamRight"), basis.right);
        gl.uniform3fv(gl.getUniformLocation(progSky, "uCamUp"), basis.up);
        gl.uniform3fv(gl.getUniformLocation(progSky, "uCamFwd"), basis.fwd);
        gl.uniform1f(gl.getUniformLocation(progSky, "uTanHalfFov"), tanHalfFov);
        gl.uniform1f(gl.getUniformLocation(progSky, "uAspect"), aspect);
        gl.uniform3fv(gl.getUniformLocation(progSky, "uSunDir"), SUN_DIR);
        gl.uniform1i(gl.getUniformLocation(progSky, "uStage"), stage);
        gl.bindVertexArray(vaoEmpty);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

        // 2. Terrain hilltop & cliff rim
        gl.enable(gl.DEPTH_TEST);
        gl.depthMask(true);
        gl.disable(gl.CULL_FACE);
        gl.useProgram(progTerrain);
        gl.uniformMatrix4fv(gl.getUniformLocation(progTerrain, "uViewProj"), false, viewProj);
        gl.uniform3fv(gl.getUniformLocation(progTerrain, "uSunDir"), SUN_DIR);
        gl.uniform3fv(gl.getUniformLocation(progTerrain, "uOrbPos"), orbPos);
        gl.uniform1f(gl.getUniformLocation(progTerrain, "uWindPhase"), windPhase);
        gl.uniform1i(gl.getUniformLocation(progTerrain, "uStage"), stage);
        gl.uniform1f(gl.getUniformLocation(progTerrain, "uSolidLeft"), solidAmt);
        gl.bindVertexArray(vaoHill.vao);
        gl.drawElements(gl.TRIANGLES, vaoHill.count, vaoHill.type, 0);

        // 3. Ancient standing runestone & stepping stones
        gl.useProgram(progProp);
        gl.uniformMatrix4fv(gl.getUniformLocation(progProp, "uViewProj"), false, viewProj);
        gl.uniform3fv(gl.getUniformLocation(progProp, "uSunDir"), SUN_DIR);
        gl.uniform3fv(gl.getUniformLocation(progProp, "uCamPos"), basis.pos);
        gl.uniform1f(gl.getUniformLocation(progProp, "uWindPhase"), windPhase);
        gl.uniform1i(gl.getUniformLocation(progProp, "uStage"), stage);
        gl.bindVertexArray(vaoProps.vao);
        gl.drawElements(gl.TRIANGLES, vaoProps.count, vaoProps.type, 0);

        // 4. Era-specific grass geometry
        if (stage === 1) {
          // 1996: Crossed Alpha X-Cards
          gl.useProgram(progXCard);
          gl.uniformMatrix4fv(gl.getUniformLocation(progXCard, "uViewProj"), false, viewProj);
          gl.uniform3fv(gl.getUniformLocation(progXCard, "uSunDir"), SUN_DIR);
          gl.uniform1f(gl.getUniformLocation(progXCard, "uShowCards"), (step.stage === 1 && showCardsOn) ? 1.0 : 0.0);
          gl.bindVertexArray(vaoXCards.vao);
          gl.drawElements(gl.TRIANGLES, vaoXCards.count, vaoXCards.type, 0);
        } else if (stage === 2) {
          // 2001: 10 Stacked Shell Layers
          gl.useProgram(progShell);
          gl.uniformMatrix4fv(gl.getUniformLocation(progShell, "uViewProj"), false, viewProj);
          gl.uniform3fv(gl.getUniformLocation(progShell, "uSunDir"), SUN_DIR);
          gl.uniform1f(gl.getUniformLocation(progShell, "uWindPhase"), windPhase);
          gl.bindVertexArray(vaoShells.vao);
          gl.drawElements(gl.TRIANGLES, vaoShells.count, vaoShells.type, 0);
        } else if (stage >= 3) {
          // 2007-2026: 22,000 GPU-instanced 3D curved grass blades!
          gl.useProgram(progBlade);
          gl.uniformMatrix4fv(gl.getUniformLocation(progBlade, "uViewProj"), false, viewProj);
          gl.uniform3fv(gl.getUniformLocation(progBlade, "uCamPos"), basis.pos);
          gl.uniform3fv(gl.getUniformLocation(progBlade, "uSunDir"), SUN_DIR);
          gl.uniform3fv(gl.getUniformLocation(progBlade, "uOrbPos"), orbPos);
          gl.uniform1f(gl.getUniformLocation(progBlade, "uWindPhase"), windPhase);
          gl.uniform1f(gl.getUniformLocation(progBlade, "uGust"), gustPulse);
          gl.uniform1i(gl.getUniformLocation(progBlade, "uStage"), stage);
          gl.uniform1f(gl.getUniformLocation(progBlade, "uShowWire"), (step.stage === 3 && showWireOn) ? 1.0 : 0.0);
          gl.uniform1f(gl.getUniformLocation(progBlade, "uTrailSpan"), TRAIL_SPAN);
          gl.activeTexture(gl.TEXTURE0);
          gl.bindTexture(gl.TEXTURE_2D, texTrail);
          gl.uniform1i(gl.getUniformLocation(progBlade, "uTrailTex"), 0);
          gl.bindVertexArray(vaoBlades);
          gl.drawElementsInstanced(gl.TRIANGLES, bladeGeo.indices.length, gl.UNSIGNED_SHORT, 0, bladeInst.count);
        }

        // 5. Steps 7-8 (2022-2026): 650 swaying 3D wildflowers
        if (stage >= 6) {
          gl.useProgram(progFlower);
          gl.uniformMatrix4fv(gl.getUniformLocation(progFlower, "uViewProj"), false, viewProj);
          gl.uniform3fv(gl.getUniformLocation(progFlower, "uSunDir"), SUN_DIR);
          gl.uniform3fv(gl.getUniformLocation(progFlower, "uCamPos"), basis.pos);
          gl.uniform3fv(gl.getUniformLocation(progFlower, "uOrbPos"), orbPos);
          gl.uniform1f(gl.getUniformLocation(progFlower, "uWindPhase"), windPhase);
          gl.uniform1f(gl.getUniformLocation(progFlower, "uGust"), gustPulse);
          gl.uniform1i(gl.getUniformLocation(progFlower, "uStage"), stage);
          gl.uniform1f(gl.getUniformLocation(progFlower, "uTrailSpan"), TRAIL_SPAN);
          gl.activeTexture(gl.TEXTURE0);
          gl.bindTexture(gl.TEXTURE_2D, texTrail);
          gl.uniform1i(gl.getUniformLocation(progFlower, "uTrailTex"), 0);
          gl.bindVertexArray(vaoFlowers);
          gl.drawElementsInstanced(gl.TRIANGLES, flGeo.indices.length, gl.UNSIGNED_SHORT, 0, flInst.count);
        }

        // 6. Step 8 (2026): Rolling brass-wood meadow orb parting the grass
        if (stage >= 7) {
          gl.useProgram(progOrb);
          gl.uniformMatrix4fv(gl.getUniformLocation(progOrb, "uViewProj"), false, viewProj);
          gl.uniform3fv(gl.getUniformLocation(progOrb, "uOrbPos"), orbPos);
          gl.uniformMatrix3fv(gl.getUniformLocation(progOrb, "uOrbRot"), false, orbRot);
          gl.uniform3fv(gl.getUniformLocation(progOrb, "uSunDir"), SUN_DIR);
          gl.uniform3fv(gl.getUniformLocation(progOrb, "uCamPos"), basis.pos);
          gl.uniform1f(gl.getUniformLocation(progOrb, "uWindPhase"), windPhase);
          gl.bindVertexArray(vaoOrb.vao);
          gl.drawElements(gl.TRIANGLES, vaoOrb.count, vaoOrb.type, 0);
        }

        // 7. Steps 7-8 (2022-2026): Floating golden sunlit pollen motes (additive)
        if (stage >= 6) {
          gl.enable(gl.BLEND);
          gl.blendFunc(gl.SRC_ALPHA, gl.ONE);
          gl.depthMask(false);
          gl.useProgram(progPollen);
          gl.uniformMatrix4fv(gl.getUniformLocation(progPollen, "uViewProj"), false, viewProj);
          gl.uniform3fv(gl.getUniformLocation(progPollen, "uCamPos"), basis.pos);
          gl.uniform1f(gl.getUniformLocation(progPollen, "uWindPhase"), windPhase);
          gl.uniform1f(gl.getUniformLocation(progPollen, "uGust"), gustPulse);
          gl.uniform1f(gl.getUniformLocation(progPollen, "uHeightPx"), h);
          gl.bindVertexArray(vaoPollen);
          gl.drawArrays(gl.POINTS, 0, pollen.count);
          gl.depthMask(true);
          gl.disable(gl.BLEND);
        }
      }

      if (splitPx > 0) renderHalf(stageLeft, 0, splitPx, solidLeft);
      if (splitPx < w) renderHalf(stageRight, splitPx, w - splitPx, 0.0);
      gl.disable(gl.SCISSOR_TEST);
      gl.disable(gl.DEPTH_TEST);

      // Gentle HDR Bloom pass (for Steps 6-8 sunlit tips, glowing rune & golden pollen)
      if (stageLeft >= 5 || stageRight >= 5) {
        gl.bindVertexArray(vaoEmpty);
        gl.bindFramebuffer(gl.FRAMEBUFFER, fboBright);
        gl.viewport(0, 0, bw, bh);
        gl.useProgram(progBright);
        gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, texHdr);
        gl.uniform1i(gl.getUniformLocation(progBright, "uHdr"), 0);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

        gl.useProgram(progBlur);
        gl.uniform1i(gl.getUniformLocation(progBlur, "uSrc"), 0);
        gl.bindFramebuffer(gl.FRAMEBUFFER, fboBlurA);
        gl.bindTexture(gl.TEXTURE_2D, texBright);
        gl.uniform2f(gl.getUniformLocation(progBlur, "uDir"), 1.0 / bw, 0.0);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

        gl.bindFramebuffer(gl.FRAMEBUFFER, fboBlurB);
        gl.bindTexture(gl.TEXTURE_2D, texBlurA);
        gl.uniform2f(gl.getUniformLocation(progBlur, "uDir"), 0.0, 1.0 / bh);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      }

      // Final ACES Filmic Composite
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, w, h);
      gl.useProgram(progFinal);
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, texHdr);
      gl.uniform1i(gl.getUniformLocation(progFinal, "uHdr"), 0);
      gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, texBlurB);
      gl.uniform1i(gl.getUniformLocation(progFinal, "uBloom"), 1);
      gl.uniform1i(gl.getUniformLocation(progFinal, "uStageLeft"), stageLeft);
      gl.uniform1i(gl.getUniformLocation(progFinal, "uStageRight"), stageRight);
      gl.uniform1f(gl.getUniformLocation(progFinal, "uSplitX"), splitX);
      gl.bindVertexArray(vaoEmpty);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    },
  };
}
