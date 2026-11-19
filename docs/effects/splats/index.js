// Pixel-Art Gaussian Splats — WebGL2 renderer, radix depth sort and interactive state.

import {
  clamp, lerp, norm3, makeLookAt, makePerspective, FULL_VS, linkPrograms, makeTex2D,
} from "../../src/gl-utils.js";
import { PALETTE_F32, LANTERN_POS, buildIslandSplats, animateSplats } from "./scene.js";
import { SPLAT_VS, RAW_FS, HARD_MRT_FS, TRANS_FS, POST_FS } from "./shaders.js";

const FLOATS_PER_SPLAT = 20;

export function createSplatsEffect(gl) {
  const { all: splats, numOpaque, numTrans } = buildIslandSplats();
  const numAll = splats.length;

  const [progRaw, progHard, progTrans, progPost] = linkPrograms(gl, [
    [SPLAT_VS, RAW_FS],
    [SPLAT_VS, HARD_MRT_FS],
    [SPLAT_VS, TRANS_FS],
    [FULL_VS, POST_FS],
  ]);

  // Instanced unit quad + per-splat dynamic attribute buffer.
  const vao = gl.createVertexArray();
  gl.bindVertexArray(vao);

  const vboQuad = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, vboQuad);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, 1, 1, -1, -1, 1, 1, -1, 1]), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

  const splatData = new Float32Array(numAll * FLOATS_PER_SPLAT);
  const vboSplats = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, vboSplats);
  gl.bufferData(gl.ARRAY_BUFFER, splatData.byteLength, gl.DYNAMIC_DRAW);

  const stride = FLOATS_PER_SPLAT * 4;
  for (const [loc, size, off] of [[1, 3, 0], [2, 3, 3], [3, 3, 6], [4, 3, 9], [5, 3, 12], [6, 4, 15]]) {
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, size, gl.FLOAT, false, stride, off * 4);
    gl.vertexAttribDivisor(loc, 1);
  }
  gl.bindVertexArray(null);
  const vaoPost = gl.createVertexArray();

  // Reusable scratch buffers for animation and 2-pass 16-bit radix sort.
  const animX = new Float32Array(numAll);
  const animY = new Float32Array(numAll);
  const animZ = new Float32Array(numAll);
  const animOp = new Float32Array(numAll);
  const animSc = new Float32Array(numAll);
  const keys = new Uint32Array(numAll);
  const orderA = new Uint32Array(numAll);
  const orderB = new Uint32Array(numAll);
  const hist0 = new Uint32Array(256);
  const hist1 = new Uint32Array(256);

  let bufW = 0, bufH = 0, artW = 0, artH = 0, ssW = 0, ssH = 0;
  let texRaw = null, fboRaw = null;
  let texSmooth = null, texStepped = null, texDepthEnc = null, rbDepth = null, fboHard = null;
  let texTrans = null, fboTrans = null;

  let simTime = 0;
  let fineGrid = false;
  let revealActive = false;
  let revealBlend = 0;

  function allocTargets(w, h) {
    const aspect = w / Math.max(1, h);
    const baseH = aspect < 0.85 ? (fineGrid ? 260 : 196) : (fineGrid ? 216 : 148);
    const nextArtH = Math.max(64, Math.round(baseH));
    const nextArtW = Math.max(64, Math.round(nextArtH * aspect));
    if (w === bufW && h === bufH && nextArtW === artW && nextArtH === artH) return;

    for (const tex of [texRaw, texSmooth, texStepped, texDepthEnc, texTrans]) if (tex) gl.deleteTexture(tex);
    if (rbDepth) gl.deleteRenderbuffer(rbDepth);
    for (const fbo of [fboRaw, fboHard, fboTrans]) if (fbo) gl.deleteFramebuffer(fbo);

    bufW = w; bufH = h;
    artW = nextArtW; artH = nextArtH;
    ssW = artW * 2; ssH = artH * 2;

    texRaw = makeTex2D(gl, bufW, bufH, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, gl.LINEAR);
    fboRaw = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fboRaw);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texRaw, 0);

    texSmooth = makeTex2D(gl, ssW, ssH, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, gl.NEAREST);
    texStepped = makeTex2D(gl, ssW, ssH, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, gl.NEAREST);
    texDepthEnc = makeTex2D(gl, ssW, ssH, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, gl.NEAREST);
    rbDepth = gl.createRenderbuffer();
    gl.bindRenderbuffer(gl.RENDERBUFFER, rbDepth);
    gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT24, ssW, ssH);

    fboHard = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fboHard);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texSmooth, 0);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT1, gl.TEXTURE_2D, texStepped, 0);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT2, gl.TEXTURE_2D, texDepthEnc, 0);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, rbDepth);
    gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1, gl.COLOR_ATTACHMENT2]);

    texTrans = makeTex2D(gl, ssW, ssH, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, gl.NEAREST);
    fboTrans = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fboTrans);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texTrans, 0);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, rbDepth);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  function packSortedSplats(viewMat, startIdx, count, sortBackToFront) {
    const m2 = viewMat[2], m6 = viewMat[6], m10 = viewMat[10], m14 = viewMat[14];
    if (sortBackToFront) {
      hist0.fill(0);
      hist1.fill(0);
      for (let i = 0; i < count; i++) {
        const idx = startIdx + i;
        const zc = -(m2 * animX[idx] + m6 * animY[idx] + m10 * animZ[idx] + m14);
        const q = clamp(Math.round((32.0 - zc) * 2047.0), 0, 65535);
        keys[i] = q;
        orderA[i] = idx;
        hist0[q & 255]++;
        hist1[(q >> 8) & 255]++;
      }
      let sum0 = 0, sum1 = 0;
      for (let b = 0; b < 256; b++) {
        const c0 = hist0[b]; hist0[b] = sum0; sum0 += c0;
        const c1 = hist1[b]; hist1[b] = sum1; sum1 += c1;
      }
      for (let i = 0; i < count; i++) orderB[hist0[keys[i] & 255]++] = i;
      for (let i = 0; i < count; i++) {
        const orig = orderB[i];
        orderA[hist1[(keys[orig] >> 8) & 255]++] = startIdx + orig;
      }
    } else {
      for (let i = 0; i < count; i++) orderA[i] = startIdx + i;
    }

    for (let i = 0; i < count; i++) {
      const idx = orderA[i];
      const s = splats[idx];
      const o = i * FLOATS_PER_SPLAT;
      const sc = animSc[idx];
      splatData[o + 0] = animX[idx]; splatData[o + 1] = animY[idx]; splatData[o + 2] = animZ[idx];
      splatData[o + 3] = s.nx;       splatData[o + 4] = s.ny;       splatData[o + 5] = s.nz;
      splatData[o + 6] = s.tx;       splatData[o + 7] = s.ty;       splatData[o + 8] = s.tz;
      splatData[o + 9] = s.r1 * sc;  splatData[o + 10] = s.r2 * sc; splatData[o + 11] = s.r3 * sc;
      splatData[o + 12] = s.cr;      splatData[o + 13] = s.cg;      splatData[o + 14] = s.cb;
      splatData[o + 15] = animOp[idx];
      splatData[o + 16] = s.emissive;
      splatData[o + 17] = s.ao;
      splatData[o + 18] = s.objectId;
      splatData[o + 19] = 0;
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, vboSplats);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, splatData.subarray(0, count * FLOATS_PER_SPLAT));
  }

  function setSplatUniforms(prog, viewMat, projMat, vpW, vpH, focal, sunDir, splatScale, quadExtent, lowpass, snapGrid) {
    gl.useProgram(prog);
    gl.uniformMatrix4fv(gl.getUniformLocation(prog, "uView"), false, viewMat);
    gl.uniformMatrix4fv(gl.getUniformLocation(prog, "uProj"), false, projMat);
    gl.uniform2f(gl.getUniformLocation(prog, "uViewport"), vpW, vpH);
    gl.uniform1f(gl.getUniformLocation(prog, "uFocal"), focal);
    gl.uniform1f(gl.getUniformLocation(prog, "uSplatScale"), splatScale);
    gl.uniform1f(gl.getUniformLocation(prog, "uQuadExtent"), quadExtent);
    gl.uniform1f(gl.getUniformLocation(prog, "uLowpass"), lowpass);
    gl.uniform1f(gl.getUniformLocation(prog, "uSnapGrid"), snapGrid);
    const uSun = gl.getUniformLocation(prog, "uSunDir");
    if (uSun) gl.uniform3fv(uSun, sunDir);
    const uLan = gl.getUniformLocation(prog, "uLanternPos");
    if (uLan) gl.uniform3fv(uLan, LANTERN_POS);
    const uPulse = gl.getUniformLocation(prog, "uLanternPulse");
    if (uPulse) gl.uniform1f(uPulse, 0.92 + 0.10 * Math.sin(simTime * 2.9));
    const uRev = gl.getUniformLocation(prog, "uSurfelReveal");
    if (uRev) gl.uniform1f(uRev, revealBlend);
  }

  return {
    id: "splats",
    maxPixels: 1600000,
    defaultCamera: {
      yaw: 0.42,
      pitch: 0.27,
      dist: 9.8,
      lookY: 0.56,
      fovDeg: 38,
      minDist: 4.8,
      maxDist: 16.0,
      minPitch: -0.32,
      maxPitch: 1.15,
      autoOrbitSpeed: 0.15,
    },
    resize(w, h) {
      allocTargets(w, h);
    },
    enterStep(stepIdx) {
      if (stepIdx !== 0) revealActive = false;
    },
    triggerAction(actionId) {
      if (actionId === "reveal") revealActive = !revealActive;
      else if (actionId === "grid") fineGrid = !fineGrid;
    },
    isActionActive(actionId) {
      if (actionId === "reveal") return revealActive;
      if (actionId === "grid") return fineGrid;
      return false;
    },
    update(dt, paused) {
      if (!paused) simTime += dt;
      revealBlend += ((revealActive ? 1.0 : 0.0) - revealBlend) * Math.min(1, dt * 6.5);
    },
    getTechBadge(stepIdx) {
      if (stepIdx === 0) return `${numAll.toLocaleString("en-US")} 3D SPLATS`;
      return `${artW || 240}×${artH || 148} · 2× SSAA`;
    },
    render(w, h, step, split, cam) {
      allocTargets(w, h);
      animateSplats(splats, simTime, animX, animY, animZ, animOp, animSc);

      const aspect = w / Math.max(1, h);
      const portraitScale = aspect < 0.95 ? clamp(1.02 / Math.max(aspect, 0.52), 1.0, 1.55) : 1.0;
      const dist = cam.dist * portraitScale;
      const cp = Math.cos(cam.pitch);
      const eye = [
        Math.sin(cam.yaw) * cp * dist,
        cam.lookY + Math.sin(cam.pitch) * dist,
        Math.cos(cam.yaw) * cp * dist,
      ];
      const fovRad = (cam.fovDeg * Math.PI) / 180;
      const viewMat = makeLookAt(eye, [0, cam.lookY, 0], [0, 1, 0]);
      const projMat = makePerspective(fovRad, aspect, 0.4, 45.0);

      const sunAngle = Math.PI * 0.5 - cam.yaw - 0.88;
      const sunDir = norm3(Math.cos(sunAngle) * 0.78, 0.68, Math.sin(sunAngle) * 0.78);

      const stageLeft = split.enabled ? step.compareLeft : step.stage;
      const stageRight = split.enabled ? step.compareRight : step.stage;
      const wipeX = split.enabled ? split.pos : 0.0;

      const needRaw = (stageLeft === 0 && wipeX > 0.001) || (stageRight === 0 && wipeX < 0.999);
      const needHard = (stageLeft > 0 && wipeX > 0.001) || (stageRight > 0 && wipeX < 0.999);
      const splatScale = lerp(1.0, 0.52, revealBlend);

      gl.bindVertexArray(vao);

      if (needRaw) {
        packSortedSplats(viewMat, 0, numAll, true);
        gl.bindFramebuffer(gl.FRAMEBUFFER, fboRaw);
        gl.viewport(0, 0, bufW, bufH);
        gl.clearColor(0, 0, 0, 0);
        gl.clear(gl.COLOR_BUFFER_BIT);
        gl.disable(gl.DEPTH_TEST);
        gl.depthMask(false);
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
        const focalFull = (0.5 * bufH) / Math.tan(fovRad * 0.5);
        setSplatUniforms(progRaw, viewMat, projMat, bufW, bufH, focalFull, sunDir, splatScale, 2.55, 0.40, 0.0);
        gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, numAll);
      }

      if (needHard) {
        const focalSS = (0.5 * ssH) / Math.tan(fovRad * 0.5);
        packSortedSplats(viewMat, 0, numOpaque, false);
        gl.bindFramebuffer(gl.FRAMEBUFFER, fboHard);
        gl.viewport(0, 0, ssW, ssH);
        gl.clearColor(0, 0, 0, 0);
        gl.clearDepth(1.0);
        gl.depthMask(true);
        gl.enable(gl.DEPTH_TEST);
        gl.depthFunc(gl.LESS);
        gl.disable(gl.BLEND);
        gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
        setSplatUniforms(progHard, viewMat, projMat, ssW, ssH, focalSS, sunDir, 1.0, 1.52, 0.16, 1.0);
        gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, numOpaque);

        packSortedSplats(viewMat, numOpaque, numTrans, true);
        gl.bindFramebuffer(gl.FRAMEBUFFER, fboTrans);
        gl.viewport(0, 0, ssW, ssH);
        gl.clearColor(0, 0, 0, 0);
        gl.clear(gl.COLOR_BUFFER_BIT);
        gl.enable(gl.DEPTH_TEST);
        gl.depthMask(false);
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
        setSplatUniforms(progTrans, viewMat, projMat, ssW, ssH, focalSS, sunDir, 1.0, 2.20, 0.25, 0.0);
        gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, numTrans);
        gl.depthMask(true);
      }

      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, bufW, bufH);
      gl.disable(gl.DEPTH_TEST);
      gl.disable(gl.BLEND);
      gl.useProgram(progPost);
      gl.bindVertexArray(vaoPost);

      const binds = [texRaw, texSmooth, texStepped, texDepthEnc, texTrans];
      const names = ["uTexRaw", "uTexSmooth", "uTexStepped", "uTexDepth", "uTexTrans"];
      for (let i = 0; i < binds.length; i++) {
        gl.activeTexture(gl.TEXTURE0 + i);
        gl.bindTexture(gl.TEXTURE_2D, binds[i]);
        gl.uniform1i(gl.getUniformLocation(progPost, names[i]), i);
      }
      gl.uniform3fv(gl.getUniformLocation(progPost, "uPalette"), PALETTE_F32);
      gl.uniform2f(gl.getUniformLocation(progPost, "uArtSize"), artW, artH);
      gl.uniform2i(gl.getUniformLocation(progPost, "uSsMax"), ssW - 1, ssH - 1);
      gl.uniform1f(gl.getUniformLocation(progPost, "uAspect"), aspect);
      gl.uniform1i(gl.getUniformLocation(progPost, "uStageLeft"), stageLeft);
      gl.uniform1i(gl.getUniformLocation(progPost, "uStageRight"), stageRight);
      gl.uniform1f(gl.getUniformLocation(progPost, "uWipeX"), wipeX);
      gl.uniform1f(gl.getUniformLocation(progPost, "uTime"), simTime);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      gl.bindVertexArray(null);
    },
  };
}
