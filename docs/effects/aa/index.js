// Evolution of Anti-Aliasing & Temporal Upscaling (1990-2026) — WebGL2 Analytical AA Lab:
// - 8 historically accurate eras with a pixel-accurate 4x Magnifier Loupe & exact Motion Vectors:
//   0: 1990 Aliased 1x vs 4x4 SSAA (Haeberli & Akeley Accumulation Buffer, SIGGRAPH 1990)
//   1: 1993 Hardware 4x MSAA (RealityEngine 1993 -> PC GPUs): smooth geometry edges, specular aliasing remains!
//   2: 2011 FXAA (Timothy Lottes, NVIDIA 2011): fast luminance post-AA, visibly softens fine textures
//   3: 2012 SMAA (Jorge Jimenez et al., Eurographics 2012): sharper morphological patterns, subpixel wires still shimmer
//   4: 2010-13 Early TAA (Halo: Reach 2010 / Crysis 2 2011 / UE4 2013): fixes subpixel wires, causes motion ghosting!
//   5: 2014 TAA + YCoCg Clipping (Lottes 2011 / Malan 2012 / Karis SIGGRAPH 2014): Motion Vectors + Catmull-Rom + YCoCg clip
//   6: 2016 Specular AA (Toksvig 2005 / Kaplanyan 2016): normal-variance roughness filtering tames metallic shimmer
//   7: 2022-26 Temporal Upscaling (FSR 2 / TSR style): renders at 50% per axis (25% pixels) + Halton jitter -> 100% output!

import {
  clamp, cameraBasisFromOrbit,
  FULL_VS, linkPrograms, makeTex2D, hdrFormat,
} from "../../src/gl-utils.js";
import {
  SCENE_FS, FXAA_FS, SMAA_EDGE_FS, SMAA_BLEND_FS, TAA_FS, FINAL_FS,
} from "./shaders.js";

// 16-sample Halton(2, 3) low-discrepancy subpixel jitter sequence centered in [-0.5, +0.5]
function halton(idx, base) {
  let f = 1, r = 0, i = idx;
  while (i > 0) {
    f /= base;
    r += f * (i % base);
    i = Math.floor(i / base);
  }
  return r;
}
const HALTON_16 = Array.from({ length: 16 }, (_, k) => [
  halton(k + 1, 2) - 0.5,
  halton(k + 1, 3) - 0.5,
]);

// Curated default 4x Loupe inspection targets per step (user can click anywhere to move it!)
const STEP_LOUPE_TARGETS = [
  [0.50, 0.72], // 0: Diagonal roof eave + thin wires (stair-stepping vs 4x4 SSAA!)
  [0.34, 0.44], // 1: Fluted dark-chrome sphere specular aliasing (MSAA!)
  [0.36, 0.65], // 2: Fine vertical stripes on resolution sign (exposes FXAA texture blur!)
  [0.54, 0.62], // 3: Thin diagonal & horizontal wires (SMAA sharpens edges, wires still break!)
  [0.48, 0.50], // 4: Moving crimson pendulum sweeping past wires (exposes Early TAA ghosting!)
  [0.48, 0.50], // 5: Moving crimson pendulum with Motion Vectors + YCoCg Clipping!
  [0.34, 0.44], // 6: Fluted dark-chrome sphere specular micro-highlights (Toksvig/Kaplanyan Specular AA!)
  [0.44, 0.62], // 7: Thin wires + stripe sign reconstructed from 50%-axis (25% pixels) buffer!
];

export function createAaEffect(gl) {
  const fmt = hdrFormat(gl);
  const [progScene, progFxaa, progSmaaEdge, progSmaaBlend, progTaa, progFinal] = linkPrograms(gl, [
    [FULL_VS, SCENE_FS],
    [FULL_VS, FXAA_FS],
    [FULL_VS, SMAA_EDGE_FS],
    [FULL_VS, SMAA_BLEND_FS],
    [FULL_VS, TAA_FS],
    [FULL_VS, FINAL_FS],
  ]);

  const uLoc = (p, names) => Object.fromEntries(names.map(n => [n, gl.getUniformLocation(p, n)]));
  const uScene = uLoc(progScene, [
    "uCamPos", "uCamRight", "uCamUp", "uCamFwd",
    "uPrevCamPos", "uPrevCamRight", "uPrevCamUp", "uPrevCamFwd",
    "uTanHalfFov", "uAspect", "uRes", "uJitterPx", "uTime", "uPrevTime",
    "uStageLeft", "uStageRight", "uSplitX", "uNoAaLeft", "uSpecAaOn", "uRenderScale",
  ]);
  const uFxaa = uLoc(progFxaa, ["uSrc", "uTexel", "uStageLeft", "uStageRight", "uSplitX"]);
  const uSEdge = uLoc(progSmaaEdge, ["uSrc", "uTexel"]);
  const uSBlend = uLoc(progSmaaBlend, ["uSrc", "uEdges", "uTexel", "uStageLeft", "uStageRight", "uSplitX"]);
  const uTaa = uLoc(progTaa, [
    "uCurFull", "uCurHalf", "uVelFull", "uVelHalf", "uHistory",
    "uFullTexel", "uHalfTexel", "uFullRes",
    "uStageLeft", "uStageRight", "uSplitX", "uHistoryValid", "uShowRawHalf",
  ]);
  const uFinal = uLoc(progFinal, [
    "uSrc", "uRes", "uTexel", "uStageLeft", "uStageRight", "uSplitX",
    "uLoupeOn", "uLoupeTarget", "uLoupeCenter", "uLoupeHalf", "uShowRawHalf",
  ]);

  const vaoEmpty = gl.createVertexArray();

  // Render targets: Full-res MRT, 50%-axis (25% pixels) MRT, FXAA/SMAA scratch, ping-pong TAA history
  let bufW = 0, bufH = 0, halfW = 0, halfH = 0;
  let texColFull = null, texVelFull = null, fboFull = null;
  let texColHalf = null, texVelHalf = null, fboHalf = null;
  let texSpatial = null, fboSpatial = null;
  let texEdges = null, fboEdges = null;
  let texHist = [null, null], fboHist = [null, null];

  function allocTargets(w, h) {
    if (w === bufW && h === bufH) return;
    for (const t of [texColFull, texVelFull, texColHalf, texVelHalf, texSpatial, texEdges, ...texHist]) {
      if (t) gl.deleteTexture(t);
    }
    for (const f of [fboFull, fboHalf, fboSpatial, fboEdges, ...fboHist]) {
      if (f) gl.deleteFramebuffer(f);
    }
    bufW = w; bufH = h;
    halfW = Math.max(64, w >> 1);
    halfH = Math.max(64, h >> 1);

    texColFull = makeTex2D(gl, w, h, fmt.internalFmt, fmt.fmt, fmt.type, gl.LINEAR);
    texVelFull = makeTex2D(gl, w, h, fmt.internalFmt, fmt.fmt, fmt.type, gl.NEAREST);
    fboFull = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fboFull);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texColFull, 0);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT1, gl.TEXTURE_2D, texVelFull, 0);
    gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1]);

    // True 50% per axis = 25% total pixels render target for Stage 7 Temporal Upscaling!
    texColHalf = makeTex2D(gl, halfW, halfH, fmt.internalFmt, fmt.fmt, fmt.type, gl.LINEAR);
    texVelHalf = makeTex2D(gl, halfW, halfH, fmt.internalFmt, fmt.fmt, fmt.type, gl.NEAREST);
    fboHalf = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fboHalf);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texColHalf, 0);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT1, gl.TEXTURE_2D, texVelHalf, 0);
    gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1]);

    texSpatial = makeTex2D(gl, w, h, fmt.internalFmt, fmt.fmt, fmt.type, gl.LINEAR);
    fboSpatial = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fboSpatial);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texSpatial, 0);

    texEdges = makeTex2D(gl, w, h, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, gl.NEAREST);
    fboEdges = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fboEdges);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texEdges, 0);

    for (let i = 0; i < 2; i++) {
      texHist[i] = makeTex2D(gl, w, h, fmt.internalFmt, fmt.fmt, fmt.type, gl.LINEAR);
      fboHist[i] = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, fboHist[i]);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texHist[i], 0);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    historyValid = false;
  }

  let simTime = 0;
  let prevSimTime = 0;
  let frameCounter = 0;
  let histIdx = 0;
  let historyValid = false;
  let prevBasis = null;
  let lastStageKey = "";

  // Interactive controls
  let loupeOn = true;
  let loupeCustom = false;
  let loupeTarget = [...STEP_LOUPE_TARGETS[7]];
  let freezeMotion = false;
  let specAaOn = true;
  let showRawHalf = false;

  return {
    id: "aa",
    maxPixels: 560000,
    defaultCamera: {
      yaw: 0.04,
      pitch: 0.08,
      dist: 4.85,
      lookY: 1.38,
      fovDeg: 44,
      minDist: 2.6,
      maxDist: 7.5,
      minPitch: -0.15,
      maxPitch: 0.65,
      autoOrbitSpeed: 0.0,
    },
    enterStep(stepIdx) {
      if (!loupeCustom && STEP_LOUPE_TARGETS[stepIdx]) {
        loupeTarget = [...STEP_LOUPE_TARGETS[stepIdx]];
      }
      if (stepIdx !== 4) freezeMotion = false;
      if (stepIdx !== 6) specAaOn = true;
      if (stepIdx !== 7) showRawHalf = false;
      historyValid = false;
    },
    onReset() {
      loupeOn = true;
      loupeCustom = false;
      loupeTarget = [...STEP_LOUPE_TARGETS[7]];
      freezeMotion = false;
      specAaOn = true;
      showRawHalf = false;
      historyValid = false;
      prevBasis = null;
    },
    triggerAction(actionId) {
      if (actionId === "loupe") loupeOn = !loupeOn;
      else if (actionId === "freeze") freezeMotion = !freezeMotion;
      else if (actionId === "specAA") specAaOn = !specAaOn;
      else if (actionId === "rawInput") { showRawHalf = !showRawHalf; historyValid = false; }
    },
    isActionActive(actionId) {
      if (actionId === "loupe") return loupeOn;
      if (actionId === "freeze") return freezeMotion;
      if (actionId === "specAA") return specAaOn;
      if (actionId === "rawInput") return showRawHalf;
      return false;
    },
    onCanvasClick(ndcX, ndcY) {
      // Click anywhere on the scene to inspect that exact pixel cluster at 4x magnification!
      const u = clamp(ndcX * 0.5 + 0.5, 0.06, 0.94);
      const v = clamp(ndcY * 0.5 + 0.5, 0.08, 0.92);
      loupeTarget = [u, v];
      loupeCustom = true;
      loupeOn = true;
    },
    getTechBadge(stepIdx) {
      return [
        "1990 · HAEBERLI 4×4 SSAA",
        "1993 · HARDWARE 4× MSAA",
        "2011 · LOTTES FXAA",
        "2012 · JIMENEZ SMAA",
        freezeMotion ? "2010-13 · EARLY TAA (STATIC)" : "2010-13 · EARLY TAA (GHOST!)",
        "2014 · KARIS YCoCg CLIP",
        specAaOn ? "2016 · SPECULAR AA ON" : "2016 · SPECULAR AA OFF",
        showRawHalf ? "50% AXIS INPUT (25% PX)" : "FSR 2 / TSR · 25% PX → 100%",
      ][stepIdx] || "WEBGL2";
    },
    resize(w, h) {
      allocTargets(w, h);
    },
    update(dt, paused) {
      if (paused || freezeMotion) {
        prevSimTime = simTime;
        return;
      }
      prevSimTime = simTime;
      simTime += dt;
    },
    render(w, h, step, split, cam) {
      allocTargets(w, h);
      frameCounter++;

      const aspect = w / Math.max(1, h);
      const basis = cameraBasisFromOrbit(cam.yaw, cam.pitch, cam.dist, cam.lookY);
      const pBasis = prevBasis || basis;
      const tanHalfFov = Math.tan(((cam.fovDeg * Math.PI) / 180) * 0.5);

      const stageLeft = split.enabled ? step.compareLeft : step.stage;
      const stageRight = split.enabled ? step.compareRight : step.stage;
      const splitX = split.enabled ? split.pos : 0.0;
      const noAaLeft = split.enabled && !!step.noAaSplit ? 1.0 : 0.0;

      const stageKey = `${stageLeft}|${stageRight}|${split.enabled}`;
      if (stageKey !== lastStageKey) {
        lastStageKey = stageKey;
        historyValid = false;
      }

      const jitter = HALTON_16[frameCounter & 15];

      gl.disable(gl.DEPTH_TEST);
      gl.disable(gl.BLEND);
      gl.disable(gl.CULL_FACE);
      gl.bindVertexArray(vaoEmpty);

      const bindSceneCommon = (scale) => {
        gl.useProgram(progScene);
        gl.uniform3fv(uScene.uCamPos, basis.pos);
        gl.uniform3fv(uScene.uCamRight, basis.right);
        gl.uniform3fv(uScene.uCamUp, basis.up);
        gl.uniform3fv(uScene.uCamFwd, basis.fwd);
        gl.uniform3fv(uScene.uPrevCamPos, pBasis.pos);
        gl.uniform3fv(uScene.uPrevCamRight, pBasis.right);
        gl.uniform3fv(uScene.uPrevCamUp, pBasis.up);
        gl.uniform3fv(uScene.uPrevCamFwd, pBasis.fwd);
        gl.uniform1f(uScene.uTanHalfFov, tanHalfFov);
        gl.uniform1f(uScene.uAspect, aspect);
        gl.uniform2f(uScene.uRes, w, h);
        gl.uniform2f(uScene.uJitterPx, jitter[0], jitter[1]);
        gl.uniform1f(uScene.uTime, simTime);
        gl.uniform1f(uScene.uPrevTime, prevSimTime);
        gl.uniform1i(uScene.uStageLeft, stageLeft);
        gl.uniform1i(uScene.uStageRight, stageRight);
        gl.uniform1f(uScene.uSplitX, splitX);
        gl.uniform1f(uScene.uNoAaLeft, noAaLeft);
        gl.uniform1f(uScene.uSpecAaOn, (step.stage === 6 && !specAaOn) ? 0.0 : 1.0);
        gl.uniform1i(uScene.uRenderScale, scale);
      };

      const needsFull = (stageLeft < 7 && splitX > 0.005) || (stageRight < 7 && splitX < 0.995);
      const needsHalf = (stageLeft === 7 && splitX > 0.005) || (stageRight === 7 && splitX < 0.995);

      // PASS 1A: Full-resolution scene render (Stages 0..6)
      if (needsFull) {
        gl.bindFramebuffer(gl.FRAMEBUFFER, fboFull);
        gl.viewport(0, 0, w, h);
        bindSceneCommon(1);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      }

      // PASS 1B: True 50%-per-axis (25% pixels!) jittered render (Stage 7 Temporal Upscaling!)
      if (needsHalf) {
        gl.bindFramebuffer(gl.FRAMEBUFFER, fboHalf);
        gl.viewport(0, 0, halfW, halfH);
        bindSceneCommon(2);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      }

      let curFullTex = texColFull;

      // PASS 2: Spatial Post-Process AA (Stage 2 = FXAA 2011, Stage 3 = SMAA 2012)
      const needsFxaa = (stageLeft === 2 && splitX > 0.005) || (stageRight === 2 && splitX < 0.995);
      const needsSmaa = (stageLeft === 3 && splitX > 0.005) || (stageRight === 3 && splitX < 0.995);

      if (needsFxaa) {
        gl.bindFramebuffer(gl.FRAMEBUFFER, fboSpatial);
        gl.viewport(0, 0, w, h);
        gl.useProgram(progFxaa);
        gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, curFullTex);
        gl.uniform1i(uFxaa.uSrc, 0);
        gl.uniform2f(uFxaa.uTexel, 1.0 / w, 1.0 / h);
        gl.uniform1i(uFxaa.uStageLeft, stageLeft);
        gl.uniform1i(uFxaa.uStageRight, stageRight);
        gl.uniform1f(uFxaa.uSplitX, splitX);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
        curFullTex = texSpatial;
      }

      if (needsSmaa) {
        // SMAA Edge Detect -> Morphological Blend
        gl.bindFramebuffer(gl.FRAMEBUFFER, fboEdges);
        gl.viewport(0, 0, w, h);
        gl.useProgram(progSmaaEdge);
        gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, curFullTex);
        gl.uniform1i(uSEdge.uSrc, 0);
        gl.uniform2f(uSEdge.uTexel, 1.0 / w, 1.0 / h);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

        // If FXAA already wrote into texSpatial, read from texSpatial into fboHist[next] via SMAA, else write into texSpatial
        const smaaOutFbo = (curFullTex === texSpatial) ? fboFull : fboSpatial;
        const smaaOutTex = (curFullTex === texSpatial) ? texColFull : texSpatial;
        gl.bindFramebuffer(gl.FRAMEBUFFER, smaaOutFbo);
        gl.viewport(0, 0, w, h);
        gl.useProgram(progSmaaBlend);
        gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, curFullTex);
        gl.uniform1i(uSBlend.uSrc, 0);
        gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, texEdges);
        gl.uniform1i(uSBlend.uEdges, 1);
        gl.uniform2f(uSBlend.uTexel, 1.0 / w, 1.0 / h);
        gl.uniform1i(uSBlend.uStageLeft, stageLeft);
        gl.uniform1i(uSBlend.uStageRight, stageRight);
        gl.uniform1f(uSBlend.uSplitX, splitX);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
        curFullTex = smaaOutTex;
      }

      // PASS 3: Temporal Resolve (Early TAA / Karis YCoCg Clip / FSR2-TSR 25%-px Upscaling)
      const prevH = histIdx;
      const nextH = 1 - histIdx;
      histIdx = nextH;
      gl.bindFramebuffer(gl.FRAMEBUFFER, fboHist[nextH]);
      gl.viewport(0, 0, w, h);
      gl.useProgram(progTaa);
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, curFullTex);
      gl.uniform1i(uTaa.uCurFull, 0);
      gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, texColHalf);
      gl.uniform1i(uTaa.uCurHalf, 1);
      gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D, texVelFull);
      gl.uniform1i(uTaa.uVelFull, 2);
      gl.activeTexture(gl.TEXTURE3); gl.bindTexture(gl.TEXTURE_2D, texVelHalf);
      gl.uniform1i(uTaa.uVelHalf, 3);
      gl.activeTexture(gl.TEXTURE4); gl.bindTexture(gl.TEXTURE_2D, texHist[prevH]);
      gl.uniform1i(uTaa.uHistory, 4);
      gl.uniform2f(uTaa.uFullTexel, 1.0 / w, 1.0 / h);
      gl.uniform2f(uTaa.uHalfTexel, 1.0 / halfW, 1.0 / halfH);
      gl.uniform2f(uTaa.uFullRes, w, h);
      gl.uniform1i(uTaa.uStageLeft, stageLeft);
      gl.uniform1i(uTaa.uStageRight, stageRight);
      gl.uniform1f(uTaa.uSplitX, splitX);
      gl.uniform1f(uTaa.uHistoryValid, historyValid ? 1.0 : 0.0);
      gl.uniform1f(uTaa.uShowRawHalf, (step.stage === 7 && showRawHalf) ? 1.0 : 0.0);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      historyValid = true;
      prevBasis = basis;

      // PASS 4: ACES Tone-Map + RCAS + Pixel-Accurate 4x Magnifier Loupe
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, w, h);
      gl.useProgram(progFinal);
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, texHist[nextH]);
      gl.uniform1i(uFinal.uSrc, 0);
      gl.uniform2f(uFinal.uRes, w, h);
      gl.uniform2f(uFinal.uTexel, 1.0 / w, 1.0 / h);
      gl.uniform1i(uFinal.uStageLeft, stageLeft);
      gl.uniform1i(uFinal.uStageRight, stageRight);
      gl.uniform1f(uFinal.uSplitX, splitX);
      gl.uniform1f(uFinal.uLoupeOn, loupeOn ? 1.0 : 0.0);
      gl.uniform2fv(uFinal.uLoupeTarget, loupeTarget);
      // Keep 4x Loupe tucked cleanly in top-right quadrant (never overlaps bottom-left HUD card!)
      const loupeHalfY = 0.165;
      const loupeHalfX = loupeHalfY / Math.max(0.5, aspect);
      gl.uniform2f(uFinal.uLoupeCenter, 1.0 - loupeHalfX - 0.032, 0.67);
      gl.uniform2f(uFinal.uLoupeHalf, loupeHalfX, loupeHalfY);
      gl.uniform1f(uFinal.uShowRawHalf, (step.stage === 7 && showRawHalf) ? 1.0 : 0.0);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    },
  };
}
