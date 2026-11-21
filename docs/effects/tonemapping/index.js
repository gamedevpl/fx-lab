// Evolution of Tone Mapping & HDR (2002-2024) — Interactive RGBA16F WebGL2 Controller.
// Renders genuine unbounded floating-point HDR radiance (0 -> 60+), separable HDR Bloom,
// 8 historically verified tone mappers, interactive EV exposure control (-3..+6 EV), and a live response curve graph.

import { clamp, cameraBasisFromOrbit, FULL_VS, linkPrograms } from "../../src/gl-utils.js";
import { HDR_SCENE_FS, BLOOM_BLUR_FS, TONEMAP_FS } from "./shaders.js";

function makeHdrFbo(gl, w, h, useFloat) {
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texImage2D(
    gl.TEXTURE_2D, 0,
    useFloat ? gl.RGBA16F : gl.RGBA8,
    w, h, 0, gl.RGBA,
    useFloat ? gl.HALF_FLOAT : gl.UNSIGNED_BYTE,
    null
  );
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  const fbo = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  return { fbo, tex, w, h };
}

export function createTonemappingEffect(gl) {
  // Enable floating-point HDR render targets (standard in WebGL2 on Metal/ANGLE/Vulkan/D3D!)
  const hasFloat = !!(gl.getExtension("EXT_color_buffer_float") || gl.getExtension("EXT_color_buffer_half_float"));
  gl.getExtension("OES_texture_float_linear");
  gl.getExtension("OES_texture_half_float_linear");

  const [progScene, progBlur, progTm] = linkPrograms(gl, [
    [FULL_VS, HDR_SCENE_FS],
    [FULL_VS, BLOOM_BLUR_FS],
    [FULL_VS, TONEMAP_FS],
  ]);

  const uLoc = (p, names) => Object.fromEntries(names.map(n => [n, gl.getUniformLocation(p, n)]));
  const uS = uLoc(progScene, ["uCamPos", "uCamRight", "uCamUp", "uCamFwd", "uTanHalfFov", "uAspect", "uTime"]);
  const uB = uLoc(progBlur, ["uSrc", "uTexel", "uDir", "uPrefilter"]);
  const uT = uLoc(progTm, [
    "uHdrTex", "uBloomTex", "uRes", "uExposureEv", "uAutoAdaptEv",
    "uSplitX", "uStageLeft", "uStageRight", "uDebugOn", "uShowGraph",
  ]);
  const vao = gl.createVertexArray();

  let bufW = 0, bufH = 0;
  let fboHdr = null, fboBloomA = null, fboBloomB = null;

  function allocTargets(w, h) {
    if (w === bufW && h === bufH) return;
    for (const f of [fboHdr, fboBloomA, fboBloomB]) {
      if (f) { gl.deleteTexture(f.tex); gl.deleteFramebuffer(f.fbo); }
    }
    bufW = w; bufH = h;
    const bw = Math.max(64, w >> 2), bh = Math.max(64, h >> 2);
    fboHdr = makeHdrFbo(gl, w, h, hasFloat);
    fboBloomA = makeHdrFbo(gl, bw, bh, hasFloat);
    fboBloomB = makeHdrFbo(gl, bw, bh, hasFloat);
  }

  let simTime = 0;
  let exposureEv = 0.25;     // Balanced HDR exposure: sky clouds readable in AgX/Filmic while neons blast into Notorious-6 in ACES/Clamp!
  let autoEvSweep = false;   // Live -2..+4.5 EV oscillation toggle
  let altOperator = false;   // Per-stage alternate (Hejl vs Hable, Lottes vs GT, Tony vs PBR Neutral, AgX Base vs Punchy)
  let tunnelPulse = 0.0;     // Stage 2 (Far Cry / Lost Coast) eye adaptation flash

  return {
    id: "tonemapping",
    maxPixels: 560000,
    defaultCamera: {
      yaw: 0.0,
      pitch: 0.08,
      dist: 4.15,
      lookY: 1.24,
      fovDeg: 58,
      minDist: 2.2,
      maxDist: 6.4,
      minPitch: -0.10,
      maxPitch: 0.48,
      autoOrbitSpeed: 0.05,
    },

    enterStep(stepIdx) {
      altOperator = false;
      if (stepIdx === 2) tunnelPulse = 1.0;
    },

    onReset() {
      exposureEv = 0.25;
      autoEvSweep = false;
      altOperator = false;
      tunnelPulse = 0.0;
    },

    triggerAction(actionId) {
      if (actionId === "evSweep") autoEvSweep = !autoEvSweep;
      else if (actionId === "tunnelFlash") tunnelPulse = 1.0;
      else if (actionId === "altOp") altOperator = !altOperator;
    },

    isActionActive(actionId) {
      if (actionId === "evSweep") return autoEvSweep;
      if (actionId === "altOp") return altOperator;
      return false;
    },

    // Clicking anywhere on canvas sets live Exposure EV (-3.0 left -> +5.5 right)!
    onCanvasClick(ndcX) {
      autoEvSweep = false;
      exposureEv = clamp(-2.5 + (ndcX * 0.5 + 0.5) * 7.5, -3.0, 5.5);
    },

    getTechBadge(stepIdx) {
      const evStr = `${exposureEv >= 0 ? "+" : ""}${exposureEv.toFixed(1)} EV`;
      const labels = [
        `<2002 · RAW LDR CLAMP · ${evStr}`,
        `2002 · REINHARD x/(1+x) · ${evStr}`,
        `2004–05 · FAR CRY / LOST COAST HDR · ${evStr}`,
        altOperator ? `2010 · HEJL / BURGESS-DAWSON · ${evStr}` : `2010 · UNCHARTED 2 (HABLE) · ${evStr}`,
        `2014–17 · ACES FILMIC (UE4) · ${evStr}`,
        altOperator ? `2016 · LOTTES (AMD) · ${evStr}` : `2017 · GT TONE MAP (UCHIMURA) · ${evStr}`,
        altOperator ? `2023 · AGX BASE (BLENDER 4.0) · ${evStr}` : `2023 · AGX PUNCHY (BLENDER 4.0) · ${evStr}`,
        altOperator ? `2023 · TONY MCMAPFACE (BEVY) · ${evStr}` : `2024 · KHRONOS PBR NEUTRAL · ${evStr}`,
      ];
      return labels[stepIdx] || `HDR RGBA16F · ${evStr}`;
    },

    resize(w, h) { allocTargets(w, h); },

    update(dt, paused) {
      if (!paused) {
        simTime += dt;
        if (autoEvSweep) {
          exposureEv = 1.2 + Math.sin(simTime * 0.95) * 3.1;
        }
        if (tunnelPulse > 0.0) {
          tunnelPulse = Math.max(0.0, tunnelPulse - dt * 0.55);
        }
      }
    },

    render(w, h, step, split, cam) {
      allocTargets(w, h);
      const aspect = w / Math.max(1, h);
      const basis = cameraBasisFromOrbit(cam.yaw, cam.pitch, cam.dist, cam.lookY);
      const tanHalfFov = Math.tan(((cam.fovDeg || 58) * Math.PI) / 360);

      // Pass 1: Render linear unbounded HDR radiance into RGBA16F FBO
      gl.bindFramebuffer(gl.FRAMEBUFFER, fboHdr.fbo);
      gl.viewport(0, 0, w, h);
      gl.disable(gl.DEPTH_TEST); gl.disable(gl.BLEND);
      gl.useProgram(progScene);
      gl.bindVertexArray(vao);
      gl.uniform3fv(uS.uCamPos, basis.pos);
      gl.uniform3fv(uS.uCamRight, basis.right);
      gl.uniform3fv(uS.uCamUp, basis.up);
      gl.uniform3fv(uS.uCamFwd, basis.fwd);
      gl.uniform1f(uS.uTanHalfFov, tanHalfFov);
      gl.uniform1f(uS.uAspect, aspect);
      gl.uniform1f(uS.uTime, simTime);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

      // Pass 2: Separable Quarter-Res HDR Bloom (Prefilter -> Blur H -> Blur V -> Blur H -> Blur V)
      const bw = fboBloomA.w, bh = fboBloomA.h;
      gl.viewport(0, 0, bw, bh);
      gl.useProgram(progBlur);
      gl.uniform2f(uB.uTexel, 1 / bw, 1 / bh);

      // Prefilter bright HDR radiance (> 1.0)
      gl.bindFramebuffer(gl.FRAMEBUFFER, fboBloomA.fbo);
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, fboHdr.tex); gl.uniform1i(uB.uSrc, 0);
      gl.uniform1f(uB.uPrefilter, 1.0);
      gl.uniform2f(uB.uDir, 0, 0);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

      gl.uniform1f(uB.uPrefilter, 0.0);
      for (let pass = 0; pass < 2; pass++) {
        gl.bindFramebuffer(gl.FRAMEBUFFER, fboBloomB.fbo);
        gl.bindTexture(gl.TEXTURE_2D, fboBloomA.tex);
        gl.uniform2f(uB.uDir, 1.0, 0.0);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

        gl.bindFramebuffer(gl.FRAMEBUFFER, fboBloomA.fbo);
        gl.bindTexture(gl.TEXTURE_2D, fboBloomB.tex);
        gl.uniform2f(uB.uDir, 0.0, 1.0);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      }

      // Pass 3: Analytical Tone Mapping + Live Curve Graph
      const stageLeft = split.enabled ? step.compareLeft : step.stage;
      const stageRight = split.enabled ? step.compareRight : step.stage;
      // Stage 2 (Far Cry / Lost Coast) dramatic eye adaptation flash decaying smoothly back to balanced exposure!
      const autoAdaptEv = tunnelPulse * 2.8 + Math.sin(simTime * 0.75) * 0.65;

      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, w, h);
      gl.useProgram(progTm);
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, fboHdr.tex); gl.uniform1i(uT.uHdrTex, 0);
      gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, fboBloomA.tex); gl.uniform1i(uT.uBloomTex, 1);
      gl.uniform2f(uT.uRes, w, h);
      gl.uniform1f(uT.uExposureEv, exposureEv);
      gl.uniform1f(uT.uAutoAdaptEv, autoAdaptEv);
      gl.uniform1f(uT.uSplitX, split.enabled ? split.pos : -1.0);
      gl.uniform1i(uT.uStageLeft, stageLeft);
      gl.uniform1i(uT.uStageRight, stageRight);
      gl.uniform1f(uT.uDebugOn, altOperator ? 1.0 : 0.0);
      gl.uniform1f(uT.uShowGraph, 1.0);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      gl.bindVertexArray(null);
    },
  };
}
