// Evolution of Toon & NPR Shading (1996-2026) — WebGL2 MRT + Inverted Hull + Anisotropic Kuwahara renderer:
// - 8 historically grounded eras on one stylized Ronin-Sentinel hero diorama:
//   0: 1996 Decaudin Cartoon Rendering (INRIA) — flat 2-tone cel + depth/normal discontinuity ink
//   1: 1998 Gooch Shading (SIGGRAPH) — warm-to-cool technical illustration keeping ink lines legible
//   2: 2000 Cel-Shaded Games Era (Jet Set Radio era) — 1D toon ramp + authentic back-face Inverted Hull
//   3: 2002 Wind Waker Style — vibrant saturated cel shadows, crisp specular, no heavy black outline
//   4: 2009 Borderlands Style — 3x3 Sobel depth+normal ink outlines + comic cross-hatching in shadows
//   5: 2014 Guilty Gear Xrd (Motomura) — artist-edited normals, ILM AO/spec, UV inner lines & stepped timing
//   6: 2018 Spider-Verse Style — Ben-Day halftone dots, shadow hatching, CMYK offset & mixed 1s/2s motion
//   7: 2026 Painterly Anisotropic Kuwahara (Kyprianidis 2009, Structure Tensor; inspired by hand-painted 3D)

import {
  clamp, norm3, cameraBasisFromOrbit, makeLookAt, makePerspective,
  FULL_VS, linkPrograms, makeTex2D, hdrFormat,
} from "../../src/gl-utils.js";
import { buildToonDiorama } from "./scene.js";
import {
  SKY_FS, SHADOW_VS, SHADOW_FS, SCENE_VS, SCENE_FS,
  HULL_VS, HULL_FS, TENSOR_FS, TENSOR_BLUR_FS, FINAL_FS,
} from "./shaders.js";

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

function makeOrtho(l, r, b, t, n, f) {
  return new Float32Array([
    2 / (r - l), 0, 0, 0,
    0, 2 / (t - b), 0, 0,
    0, 0, -2 / (f - n), 0,
    -(r + l) / (r - l), -(t + b) / (t - b), -(f + n) / (f - n), 1,
  ]);
}

// Compute animation timestamp per era:
// - Stage 5 (Guilty Gear Xrd): crisp stepped limited animation (10 fps pose-to-pose hold!)
// - Stage 6 (Spider-Verse): mixed 1s & 2s (alternates 12 fps "on 2s" with brief fluid "on 1s" bursts!)
function getEraAnimTime(simTime, stage, mixedTwosOn) {
  if (stage === 5) {
    return Math.floor(simTime * 10.0) / 10.0;
  }
  if (stage === 6 && mixedTwosOn) {
    // Authentic mixed 1s & 2s: 2.2s on twos (12 fps) -> 1.0s snappy burst on ones (60 fps)!
    const cycle = simTime % 3.2;
    if (cycle < 2.2) return Math.floor(simTime * 12.0) / 12.0;
    return simTime;
  }
  return simTime;
}

export function createToonEffect(gl) {
  const fmt = hdrFormat(gl);
  const [
    progSky, progShadow, progScene, progHull,
    progTensor, progTensorBlur, progFinal,
  ] = linkPrograms(gl, [
    [FULL_VS, SKY_FS],
    [SHADOW_VS, SHADOW_FS],
    [SCENE_VS, SCENE_FS],
    [HULL_VS, HULL_FS],
    [FULL_VS, TENSOR_FS],
    [FULL_VS, TENSOR_BLUR_FS],
    [FULL_VS, FINAL_FS],
  ]);

  const uLoc = (p, names) => Object.fromEntries(names.map(n => [n, gl.getUniformLocation(p, n)]));
  const uSky = uLoc(progSky, ["uCamRight", "uCamUp", "uCamFwd", "uTanHalfFov", "uAspect", "uLightDir", "uTime", "uStage", "uSolidLeft"]);
  const uShad = uLoc(progShadow, ["uLightVP", "uAnimTime"]);
  const uScene = uLoc(progScene, ["uViewProj", "uLightVP", "uCamPos", "uAnimTime", "uShadowMap", "uLightDir", "uStage", "uSolidLeft", "uUseRawNorms"]);
  const uHull = uLoc(progHull, ["uViewProj", "uCamPos", "uAnimTime", "uHullScale", "uShowHull"]);
  const uTens = uLoc(progTensor, ["uColor", "uTexel"]);
  const uTBlur = uLoc(progTensorBlur, ["uSrc", "uDir"]);
  const uFinal = uLoc(progFinal, ["uColor", "uNormDepth", "uAux", "uTensor", "uTexel", "uRes", "uStageLeft", "uStageRight", "uSplitX", "uSolidLeft", "uInkOn"]);

  const vaoEmpty = gl.createVertexArray();

  // Build stylized Ronin-Sentinel hero diorama mesh once
  const mesh = buildToonDiorama();
  const vaoMesh = gl.createVertexArray();
  gl.bindVertexArray(vaoMesh);
  const vbo = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
  gl.bufferData(gl.ARRAY_BUFFER, mesh.vertices, gl.STATIC_DRAW);
  const stride = 18 * 4;
  // pos(3), norm(3), editNorm(3), uv(2), color(3), meta(4)
  for (const [loc, sz, off] of [
    [0, 3, 0], [1, 3, 3], [2, 3, 6], [3, 2, 9], [4, 3, 11], [5, 4, 14],
  ]) {
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, sz, gl.FLOAT, false, stride, off * 4);
  }
  const ibo = gl.createBuffer();
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibo);
  gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, mesh.indices, gl.STATIC_DRAW);
  gl.bindVertexArray(null);

  // 1024x1024 Depth Shadow Map FBO
  const SH_SIZE = 1024;
  const texShadow = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, texShadow);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.DEPTH_COMPONENT24, SH_SIZE, SH_SIZE, 0, gl.DEPTH_COMPONENT, gl.UNSIGNED_INT, null);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  const fboShadow = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, fboShadow);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.TEXTURE_2D, texShadow, 0);
  gl.drawBuffers([gl.NONE]);
  gl.readBuffer(gl.NONE);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);

  // MRT G-Buffer + Structure Tensor targets
  let bufW = 0, bufH = 0;
  let texColor = null, texNormDepth = null, texAux = null, rboDepth = null, fboGbuf = null;
  let texTensor = null, texTBlurA = null, texTBlurB = null;
  let fboTensor = null, fboTBlurA = null, fboTBlurB = null;

  function allocTargets(w, h) {
    if (w === bufW && h === bufH) return;
    for (const t of [texColor, texNormDepth, texAux, texTensor, texTBlurA, texTBlurB]) if (t) gl.deleteTexture(t);
    for (const f of [fboGbuf, fboTensor, fboTBlurA, fboTBlurB]) if (f) gl.deleteFramebuffer(f);
    if (rboDepth) gl.deleteRenderbuffer(rboDepth);
    bufW = w; bufH = h;

    texColor     = makeTex2D(gl, w, h, fmt.internalFmt, fmt.fmt, fmt.type, gl.LINEAR);
    texNormDepth = makeTex2D(gl, w, h, fmt.internalFmt, fmt.fmt, fmt.type, gl.NEAREST);
    texAux       = makeTex2D(gl, w, h, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, gl.NEAREST);
    rboDepth     = gl.createRenderbuffer();
    gl.bindRenderbuffer(gl.RENDERBUFFER, rboDepth);
    gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT24, w, h);

    fboGbuf = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fboGbuf);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texColor, 0);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT1, gl.TEXTURE_2D, texNormDepth, 0);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT2, gl.TEXTURE_2D, texAux, 0);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, rboDepth);
    gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1, gl.COLOR_ATTACHMENT2]);

    // Half-res Structure Tensor for fast 60 FPS Anisotropic Kuwahara orientation!
    const tw = Math.max(64, w >> 1), th = Math.max(64, h >> 1);
    texTensor = makeTex2D(gl, tw, th, fmt.internalFmt, fmt.fmt, fmt.type, gl.LINEAR);
    texTBlurA = makeTex2D(gl, tw, th, fmt.internalFmt, fmt.fmt, fmt.type, gl.LINEAR);
    texTBlurB = makeTex2D(gl, tw, th, fmt.internalFmt, fmt.fmt, fmt.type, gl.LINEAR);

    fboTensor = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fboTensor);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texTensor, 0);

    fboTBlurA = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fboTBlurA);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texTBlurA, 0);

    fboTBlurB = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fboTBlurB);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texTBlurB, 0);

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  let simTime = 0;
  let lightYaw = 0.62, lightPitch = 0.54;
  let targetLightYaw = 0.62, targetLightPitch = 0.54;
  let showHull = false;
  let useRawNorms = false;
  let mixedTwosOn = true;
  let inkOn = true;

  return {
    id: "toon",
    maxPixels: 950000,
    defaultCamera: {
      yaw: 0.22,
      pitch: 0.11,
      dist: 6.15,
      lookY: 0.92,
      fovDeg: 42,
      minDist: 3.2,
      maxDist: 9.2,
      minPitch: -0.25,
      maxPitch: 0.85,
      autoOrbitSpeed: 0.14,
    },
    enterStep(stepIdx) {
      if (stepIdx !== 2) showHull = false;
      if (stepIdx !== 5) useRawNorms = false;
    },
    onReset() {
      showHull = false;
      useRawNorms = false;
      mixedTwosOn = true;
      inkOn = true;
      targetLightYaw = 0.62;
      targetLightPitch = 0.54;
    },
    triggerAction(actionId) {
      if (actionId === "hull") showHull = !showHull;
      else if (actionId === "rawNorms") useRawNorms = !useRawNorms;
      else if (actionId === "twos") mixedTwosOn = !mixedTwosOn;
      else if (actionId === "ink") inkOn = !inkOn;
    },
    isActionActive(actionId) {
      if (actionId === "hull") return showHull;
      if (actionId === "rawNorms") return useRawNorms;
      if (actionId === "twos") return mixedTwosOn;
      if (actionId === "ink") return inkOn;
      return false;
    },
    onCanvasClick(ndcX, ndcY) {
      // Aim the key sun direction smoothly across the sky!
      targetLightYaw = clamp(ndcX * 1.65, -1.75, 1.75);
      targetLightPitch = clamp(0.45 + ndcY * 0.55, 0.16, 1.18);
    },
    getTechBadge(stepIdx) {
      return [
        "1996 · DECAUDIN INRIA",
        "1998 · GOOCH SIGGRAPH",
        showHull ? "2000 · INVERTED HULL RED" : "2000 · RAMP + HULL",
        "2002 · WIND WAKER CEL",
        "2009 · SOBEL + HATCH",
        useRawNorms ? "2014 · RAW 3D NORMALS" : "2014 · GG XRD EDITED",
        mixedTwosOn ? "2018 · MIXED 1s/2s HALFTONE" : "2018 · 60 FPS HALFTONE",
        inkOn ? "2026 · KUWAHARA + INK" : "2026 · PURE OIL PAINT",
      ][stepIdx] || "WEBGL2";
    },
    resize(w, h) {
      allocTargets(w, h);
    },
    update(dt, paused) {
      if (paused) return;
      simTime += dt;
      const b = 1.0 - Math.exp(-dt * 7.0);
      lightYaw += (targetLightYaw - lightYaw) * b;
      lightPitch += (targetLightPitch - lightPitch) * b;
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

      const cp = Math.cos(lightPitch);
      const lightDir = norm3(Math.sin(lightYaw) * cp, Math.sin(lightPitch), Math.cos(lightYaw) * cp);
      const lightEye = [lightDir[0] * 7.5, 0.9 + lightDir[1] * 7.5, lightDir[2] * 7.5];
      const lightVP = mulMat4(makeOrtho(-3.2, 3.2, -3.2, 3.2, 1.0, 16.0), makeLookAt(lightEye, [0, 0.9, 0], [0, 1, 0]));

      const stageLeft = split.enabled ? step.compareLeft : step.stage;
      const stageRight = split.enabled ? step.compareRight : step.stage;
      const splitX = split.enabled ? split.pos : 0.0;
      const splitPx = split.enabled ? clamp(Math.round(splitX * w), 0, w) : 0;
      const solidLeft = split.enabled && !!step.solidSplit ? 1.0 : 0.0;

      let lastShadowTime = -999;
      function updateShadowMap(animTime) {
        if (Math.abs(animTime - lastShadowTime) < 1e-4) return;
        lastShadowTime = animTime;
        gl.bindFramebuffer(gl.FRAMEBUFFER, fboShadow);
        gl.viewport(0, 0, SH_SIZE, SH_SIZE);
        gl.disable(gl.SCISSOR_TEST);
        gl.enable(gl.DEPTH_TEST);
        gl.depthMask(true);
        gl.disable(gl.CULL_FACE);
        gl.clearDepth(1.0);
        gl.clear(gl.DEPTH_BUFFER_BIT);
        gl.useProgram(progShadow);
        gl.uniformMatrix4fv(uShad.uLightVP, false, lightVP);
        gl.uniform1f(uShad.uAnimTime, animTime);
        gl.bindVertexArray(vaoMesh);
        gl.drawElements(gl.TRIANGLES, mesh.indices.length, gl.UNSIGNED_INT, 0);
      }

      function renderHalf(stage, sx, sw, solidAmt) {
        if (sw <= 0) return;
        const animTime = getEraAnimTime(simTime, stage, mixedTwosOn);
        updateShadowMap(animTime);

        gl.bindFramebuffer(gl.FRAMEBUFFER, fboGbuf);
        gl.viewport(0, 0, w, h);
        gl.enable(gl.SCISSOR_TEST);
        gl.scissor(sx, 0, sw, h);
        gl.clearDepth(1.0);
        gl.clear(gl.DEPTH_BUFFER_BIT);

        // 1. Stylized sky backdrop
        gl.disable(gl.DEPTH_TEST);
        gl.disable(gl.CULL_FACE);
        gl.useProgram(progSky);
        gl.uniform3fv(uSky.uCamRight, basis.right);
        gl.uniform3fv(uSky.uCamUp, basis.up);
        gl.uniform3fv(uSky.uCamFwd, basis.fwd);
        gl.uniform1f(uSky.uTanHalfFov, tanHalfFov);
        gl.uniform1f(uSky.uAspect, aspect);
        gl.uniform3fv(uSky.uLightDir, lightDir);
        gl.uniform1f(uSky.uTime, simTime);
        gl.uniform1i(uSky.uStage, stage);
        gl.uniform1f(uSky.uSolidLeft, solidAmt);
        gl.bindVertexArray(vaoEmpty);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

        // 2. Main Ronin-Sentinel 3D diorama into MRT
        gl.enable(gl.DEPTH_TEST);
        gl.depthMask(true);
        gl.disable(gl.CULL_FACE);
        gl.useProgram(progScene);
        gl.uniformMatrix4fv(uScene.uViewProj, false, viewProj);
        gl.uniformMatrix4fv(uScene.uLightVP, false, lightVP);
        gl.uniform3fv(uScene.uCamPos, basis.pos);
        gl.uniform1f(uScene.uAnimTime, animTime);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, texShadow);
        gl.uniform1i(uScene.uShadowMap, 0);
        gl.uniform3fv(uScene.uLightDir, lightDir);
        gl.uniform1i(uScene.uStage, stage);
        gl.uniform1f(uScene.uSolidLeft, solidAmt);
        gl.uniform1f(uScene.uUseRawNorms, (step.stage === 5 && useRawNorms) ? 1.0 : 0.0);
        gl.bindVertexArray(vaoMesh);
        gl.drawElements(gl.TRIANGLES, mesh.indices.length, gl.UNSIGNED_INT, 0);

        // 3. Stage 2 (2000 Cel-Shaded Games Era): AUTHENTIC geometric Inverted Hull back-face extrusion!
        if (stage === 2) {
          gl.enable(gl.CULL_FACE);
          gl.cullFace(gl.FRONT);
          gl.useProgram(progHull);
          gl.uniformMatrix4fv(uHull.uViewProj, false, viewProj);
          gl.uniform3fv(uHull.uCamPos, basis.pos);
          gl.uniform1f(uHull.uAnimTime, animTime);
          gl.uniform1f(uHull.uHullScale, (step.stage === 2 && showHull) ? 0.044 : 0.028);
          gl.uniform1f(uHull.uShowHull, (step.stage === 2 && showHull) ? 1.0 : 0.0);
          gl.bindVertexArray(vaoMesh);
          gl.drawElements(gl.TRIANGLES, mesh.indices.length, gl.UNSIGNED_INT, 0);
          gl.cullFace(gl.BACK);
          gl.disable(gl.CULL_FACE);
        }
      }

      if (splitPx > 0) renderHalf(stageLeft, 0, splitPx, solidLeft);
      if (splitPx < w) renderHalf(stageRight, splitPx, w - splitPx, 0.0);
      gl.disable(gl.SCISSOR_TEST);
      gl.disable(gl.DEPTH_TEST);
      gl.bindVertexArray(vaoEmpty);

      // 4. Structure Tensor Pass (only when Stage 7 Painterly Anisotropic Kuwahara is visible!)
      const needsKuwahara = (stageLeft === 7 && splitX > 0.005) || (stageRight === 7 && splitX < 0.995);
      if (needsKuwahara) {
        const tw = Math.max(64, w >> 1), th = Math.max(64, h >> 1);
        gl.viewport(0, 0, tw, th);
        gl.bindFramebuffer(gl.FRAMEBUFFER, fboTensor);
        gl.useProgram(progTensor);
        gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, texColor);
        gl.uniform1i(uTens.uColor, 0);
        gl.uniform2f(uTens.uTexel, 1.0 / w, 1.0 / h);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

        gl.useProgram(progTensorBlur);
        gl.uniform1i(uTBlur.uSrc, 0);
        gl.bindFramebuffer(gl.FRAMEBUFFER, fboTBlurA);
        gl.bindTexture(gl.TEXTURE_2D, texTensor);
        gl.uniform2f(uTBlur.uDir, 1.0 / tw, 0.0);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

        gl.bindFramebuffer(gl.FRAMEBUFFER, fboTBlurB);
        gl.bindTexture(gl.TEXTURE_2D, texTBlurA);
        gl.uniform2f(uTBlur.uDir, 0.0, 1.0 / th);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      }

      // 5. Final NPR Post-Process Composite
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, w, h);
      gl.useProgram(progFinal);
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, texColor);
      gl.uniform1i(uFinal.uColor, 0);
      gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, texNormDepth);
      gl.uniform1i(uFinal.uNormDepth, 1);
      gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D, texAux);
      gl.uniform1i(uFinal.uAux, 2);
      gl.activeTexture(gl.TEXTURE3); gl.bindTexture(gl.TEXTURE_2D, texTBlurB);
      gl.uniform1i(uFinal.uTensor, 3);
      gl.uniform2f(uFinal.uTexel, 1.0 / w, 1.0 / h);
      gl.uniform2f(uFinal.uRes, w, h);
      gl.uniform1i(uFinal.uStageLeft, stageLeft);
      gl.uniform1i(uFinal.uStageRight, stageRight);
      gl.uniform1f(uFinal.uSplitX, splitX);
      gl.uniform1f(uFinal.uSolidLeft, solidLeft);
      gl.uniform1f(uFinal.uInkOn, inkOn ? 1.0 : 0.0);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    },
  };
}
