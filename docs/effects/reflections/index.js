// Evolution of Reflections (1976-2026) — Analytical & Multi-Pass WebGL2 Lab:
//   0: 1976 Equirectangular Env Map (Blinn & Newell 1976 — lat-long distant panorama only)
//   1: 1996 Planar Portal Mirror (Duke Nukem 3D 1996 / Unreal 1998 — flat floor only, curved objects miss)
//   2: 1999 Hardware Cubemaps (GeForce 256 / DX7 — works on curves, infinite-distance parallax error on floor)
//   3: 2011 Screen-Space Reflections / SSR (Crysis 2 DX11 — genuine G-buffer raymarch: off-screen & behind-pillar holes!)
//   4: 2012 Parallax-Corrected Cubemaps (Bjorke 2004 · Lagarde & Zanuttini SIGGRAPH 2012 — fixes parallax, static only)
//   5: 2013 Split-Sum Roughness IBL (Karis UE4, SIGGRAPH 2013 — GGX pre-filtered roughness + Split-Sum BRDF)
//   6: 2018 Hardware Ray-Traced Reflections (Battlefield V DXR — 1-bounce full 3D RT heals all SSR artifacts!)
//   7: 2022-26 Multi-Bounce Glossy RT (UE5 Lumen 2022 / Cyberpunk RT Overdrive 2023 — GGX stochastic + 2nd bounce!)

import {
  clamp, cameraBasisFromOrbit,
  FULL_VS, linkPrograms, makeTex2D, hdrFormat,
} from "../../src/gl-utils.js";
import {
  GBUFFER_FS, REFLECT_FS, ACCUM_FS, FINAL_FS,
} from "./shaders.js";

export function createReflectionsEffect(gl) {
  const fmt = hdrFormat(gl);
  const [progGBuf, progRefl, progAccum, progFinal] = linkPrograms(gl, [
    [FULL_VS, GBUFFER_FS],
    [FULL_VS, REFLECT_FS],
    [FULL_VS, ACCUM_FS],
    [FULL_VS, FINAL_FS],
  ]);

  const uLoc = (p, names) => Object.fromEntries(names.map(n => [n, gl.getUniformLocation(p, n)]));
  const uGBuf = uLoc(progGBuf, [
    "uCamPos", "uCamRight", "uCamUp", "uCamFwd",
    "uTanHalfFov", "uAspect", "uTime", "uWetness", "uRoughBoost", "uOrbPos",
  ]);
  const uRefl = uLoc(progRefl, [
    "uGColor", "uGDepth",
    "uCamPos", "uCamRight", "uCamUp", "uCamFwd",
    "uPrevCamPos", "uPrevCamRight", "uPrevCamUp", "uPrevCamFwd",
    "uTanHalfFov", "uAspect", "uRes", "uTime", "uWetness", "uRoughBoost", "uOrbPos",
    "uStageLeft", "uStageRight", "uSplitX", "uFrameIdx",
  ]);
  const uAccum = uLoc(progAccum, [
    "uCur", "uVel", "uHist", "uTexel",
    "uStageLeft", "uStageRight", "uSplitX", "uHistoryValid",
  ]);
  const uFinal = uLoc(progFinal, ["uSrc", "uTexel"]);

  const vaoEmpty = gl.createVertexArray();

  let bufW = 0, bufH = 0;
  let texGCol = null, texGDep = null, fboGBuf = null;
  let texRCol = null, texRVel = null, fboRefl = null;
  let texHist = [null, null], fboHist = [null, null];

  function allocTargets(w, h) {
    if (w === bufW && h === bufH) return;
    for (const t of [texGCol, texGDep, texRCol, texRVel, ...texHist]) {
      if (t) gl.deleteTexture(t);
    }
    for (const f of [fboGBuf, fboRefl, ...fboHist]) {
      if (f) gl.deleteFramebuffer(f);
    }
    bufW = w; bufH = h;

    texGCol = makeTex2D(gl, w, h, fmt.internalFmt, fmt.fmt, fmt.type, gl.LINEAR);
    texGDep = makeTex2D(gl, w, h, fmt.internalFmt, fmt.fmt, fmt.type, gl.NEAREST);
    fboGBuf = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fboGBuf);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texGCol, 0);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT1, gl.TEXTURE_2D, texGDep, 0);
    gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1]);

    texRCol = makeTex2D(gl, w, h, fmt.internalFmt, fmt.fmt, fmt.type, gl.LINEAR);
    texRVel = makeTex2D(gl, w, h, fmt.internalFmt, fmt.fmt, fmt.type, gl.NEAREST);
    fboRefl = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fboRefl);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texRCol, 0);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT1, gl.TEXTURE_2D, texRVel, 0);
    gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1]);

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
  let frameCounter = 0;
  let histIdx = 0;
  let historyValid = false;
  let prevBasis = null;
  let lastStageKey = "";

  // Interactive controls
  let wetness = 1.0;        // 1.0 = large rain puddles, 0.25 = mostly damp stone
  let roughBoost = 0.0;     // 0.0 = mirror puddles, 0.72 = satin/brushed wet stone
  let tiltDown = false;     // Tilts camera slightly down to slice overhead cyan neon off-screen on SSR!
  let tiltAmt = 0.0;
  let customOrb = null;     // User-clicked [x, y, z] position for dynamic electric-gold plasma orb

  function currentOrbPos() {
    if (customOrb) {
      return [customOrb[0], customOrb[1] + Math.sin(simTime * 2.4) * 0.07, customOrb[2]];
    }
    return [
      Math.sin(simTime * 0.85) * 0.95 - 0.08,
      1.06 + Math.sin(simTime * 1.70) * 0.16,
      -1.22 + Math.cos(simTime * 0.85) * 0.42,
    ];
  }

  return {
    id: "reflections",
    maxPixels: 560000,
    defaultCamera: {
      yaw: 0.02,
      pitch: 0.195,
      dist: 6.15,
      lookY: 0.96,
      fovDeg: 45,
      minDist: 2.8,
      maxDist: 8.6,
      minPitch: -0.05,
      maxPitch: 0.68,
      autoOrbitSpeed: 0.0,
    },
    enterStep(stepIdx) {
      if (stepIdx !== 3 && stepIdx !== 6) tiltDown = false;
      if (stepIdx !== 5 && stepIdx !== 7) roughBoost = 0.0;
      historyValid = false;
    },
    onReset() {
      wetness = 1.0;
      roughBoost = 0.0;
      tiltDown = false;
      tiltAmt = 0.0;
      customOrb = null;
      historyValid = false;
      prevBasis = null;
    },
    triggerAction(actionId) {
      if (actionId === "wetness") {
        wetness = wetness > 0.6 ? 0.25 : 1.0;
        historyValid = false;
      } else if (actionId === "tiltDown") {
        tiltDown = !tiltDown;
      } else if (actionId === "roughSweep") {
        roughBoost = roughBoost > 0.3 ? 0.0 : 0.72;
        historyValid = false;
      }
    },
    isActionActive(actionId) {
      if (actionId === "wetness") return wetness > 0.6;
      if (actionId === "tiltDown") return tiltDown;
      if (actionId === "roughSweep") return roughBoost > 0.3;
      return false;
    },
    onCanvasClick(ndcX, ndcY, w, h, _step, cam) {
      // Cast primary ray onto courtyard floor y=0 and place the glowing gold plasma orb there!
      const aspect = w / Math.max(1, h);
      const effPitch = cam.pitch + tiltAmt * 0.21;
      const effLookY = cam.lookY - tiltAmt * 0.72;
      const basis = cameraBasisFromOrbit(cam.yaw, effPitch, cam.dist, effLookY);
      const tanHalfFov = Math.tan(((cam.fovDeg * Math.PI) / 180) * 0.5);
      const rx = basis.fwd[0] + ndcX * aspect * tanHalfFov * basis.right[0] + ndcY * tanHalfFov * basis.up[0];
      const ry = basis.fwd[1] + ndcX * aspect * tanHalfFov * basis.right[1] + ndcY * tanHalfFov * basis.up[1];
      const rz = basis.fwd[2] + ndcX * aspect * tanHalfFov * basis.right[2] + ndcY * tanHalfFov * basis.up[2];
      const rl = Math.hypot(rx, ry, rz) || 1;
      const d = [rx / rl, ry / rl, rz / rl];
      if (d[1] < -0.02) {
        const t = -basis.pos[1] / d[1];
        if (t > 0.5 && t < 18.0) {
          const hx = clamp(basis.pos[0] + d[0] * t, -2.4, 2.4);
          const hz = clamp(basis.pos[2] + d[2] * t, -2.15, 1.35);
          customOrb = [hx, 1.02, hz];
          historyValid = false;
        }
      }
    },
    getTechBadge(stepIdx) {
      return [
        "1976 · BLINN & NEWELL EQUIRECT",
        "1996 · PLANAR PORTAL MIRROR",
        "1999 · HARDWARE CUBEMAPS",
        tiltDown ? "2011 · SSR (OFF-SCREEN CLIP!)" : "2011 · CRYSIS 2 SSR",
        "2012 · PARALLAX CUBEMAPS",
        roughBoost > 0.3 ? "2013 · SPLIT-SUM (SATIN)" : "2013 · KARIS SPLIT-SUM IBL",
        tiltDown ? "2018 · DXR RT (OFF-SCREEN OK!)" : "2018 · BATTLEFIELD V DXR RT",
        roughBoost > 0.3 ? "2022–26 · GLOSSY CONTACT RT" : "2022–26 · LUMEN / RT OVERDRIVE",
      ][stepIdx] || "WEBGL2";
    },
    resize(w, h) {
      allocTargets(w, h);
    },
    update(dt, paused) {
      const targetTilt = tiltDown ? 1.0 : 0.0;
      tiltAmt += (targetTilt - tiltAmt) * Math.min(1.0, dt * 6.5);
      if (!paused) simTime += dt;
    },
    render(w, h, step, split, cam) {
      allocTargets(w, h);
      frameCounter++;

      const aspect = w / Math.max(1, h);
      const effPitch = cam.pitch + tiltAmt * 0.21;
      const effLookY = cam.lookY - tiltAmt * 0.72;
      const basis = cameraBasisFromOrbit(cam.yaw, effPitch, cam.dist, effLookY);
      const pBasis = prevBasis || basis;
      const tanHalfFov = Math.tan(((cam.fovDeg * Math.PI) / 180) * 0.5);
      const orb = currentOrbPos();

      const stageLeft = split.enabled ? step.compareLeft : step.stage;
      const stageRight = split.enabled ? step.compareRight : step.stage;
      const splitX = split.enabled ? split.pos : 0.0;

      const stageKey = `${stageLeft}|${stageRight}|${split.enabled}`;
      if (stageKey !== lastStageKey) {
        lastStageKey = stageKey;
        historyValid = false;
      }

      gl.disable(gl.DEPTH_TEST);
      gl.disable(gl.BLEND);
      gl.disable(gl.CULL_FACE);
      gl.bindVertexArray(vaoEmpty);

      // PASS 1: Primary G-buffer (only strictly needed when SSR stage 3 is active, cheap enough to run whenever stageLeft==3 || stageRight==3)
      const needsGBuf = (stageLeft === 3 && splitX > 0.005) || (stageRight === 3 && splitX < 0.995);
      if (needsGBuf) {
        gl.bindFramebuffer(gl.FRAMEBUFFER, fboGBuf);
        gl.viewport(0, 0, w, h);
        gl.useProgram(progGBuf);
        gl.uniform3fv(uGBuf.uCamPos, basis.pos);
        gl.uniform3fv(uGBuf.uCamRight, basis.right);
        gl.uniform3fv(uGBuf.uCamUp, basis.up);
        gl.uniform3fv(uGBuf.uCamFwd, basis.fwd);
        gl.uniform1f(uGBuf.uTanHalfFov, tanHalfFov);
        gl.uniform1f(uGBuf.uAspect, aspect);
        gl.uniform1f(uGBuf.uTime, simTime);
        gl.uniform1f(uGBuf.uWetness, wetness);
        gl.uniform1f(uGBuf.uRoughBoost, roughBoost);
        gl.uniform3fv(uGBuf.uOrbPos, orb);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      }

      // PASS 2: Evaluate Reflection Era (0..7) + Exact Analytical Camera Motion Vectors
      gl.bindFramebuffer(gl.FRAMEBUFFER, fboRefl);
      gl.viewport(0, 0, w, h);
      gl.useProgram(progRefl);
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, texGCol);
      gl.uniform1i(uRefl.uGColor, 0);
      gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, texGDep);
      gl.uniform1i(uRefl.uGDepth, 1);
      gl.uniform3fv(uRefl.uCamPos, basis.pos);
      gl.uniform3fv(uRefl.uCamRight, basis.right);
      gl.uniform3fv(uRefl.uCamUp, basis.up);
      gl.uniform3fv(uRefl.uCamFwd, basis.fwd);
      gl.uniform3fv(uRefl.uPrevCamPos, pBasis.pos);
      gl.uniform3fv(uRefl.uPrevCamRight, pBasis.right);
      gl.uniform3fv(uRefl.uPrevCamUp, pBasis.up);
      gl.uniform3fv(uRefl.uPrevCamFwd, pBasis.fwd);
      gl.uniform1f(uRefl.uTanHalfFov, tanHalfFov);
      gl.uniform1f(uRefl.uAspect, aspect);
      gl.uniform2f(uRefl.uRes, w, h);
      gl.uniform1f(uRefl.uTime, simTime);
      gl.uniform1f(uRefl.uWetness, wetness);
      gl.uniform1f(uRefl.uRoughBoost, roughBoost);
      gl.uniform3fv(uRefl.uOrbPos, orb);
      gl.uniform1i(uRefl.uStageLeft, stageLeft);
      gl.uniform1i(uRefl.uStageRight, stageRight);
      gl.uniform1f(uRefl.uSplitX, splitX);
      gl.uniform1i(uRefl.uFrameIdx, frameCounter);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

      // PASS 3A: Jitter-Free Temporal Denoiser for Stage 7 Stochastic Multi-Bounce Glossy RT
      const prevH = histIdx;
      const nextH = 1 - histIdx;
      histIdx = nextH;
      gl.bindFramebuffer(gl.FRAMEBUFFER, fboHist[nextH]);
      gl.viewport(0, 0, w, h);
      gl.useProgram(progAccum);
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, texRCol);
      gl.uniform1i(uAccum.uCur, 0);
      gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, texRVel);
      gl.uniform1i(uAccum.uVel, 1);
      gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D, texHist[prevH]);
      gl.uniform1i(uAccum.uHist, 2);
      gl.uniform2f(uAccum.uTexel, 1.0 / w, 1.0 / h);
      gl.uniform1i(uAccum.uStageLeft, stageLeft);
      gl.uniform1i(uAccum.uStageRight, stageRight);
      gl.uniform1f(uAccum.uSplitX, splitX);
      gl.uniform1f(uAccum.uHistoryValid, historyValid ? 1.0 : 0.0);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      historyValid = true;
      prevBasis = basis;

      // PASS 3B: ACES Filmic Tone Mapping + Crisp HDR Neon Bloom
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, w, h);
      gl.useProgram(progFinal);
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, texHist[nextH]);
      gl.uniform1i(uFinal.uSrc, 0);
      gl.uniform2f(uFinal.uTexel, 1.0 / w, 1.0 / h);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    },
  };
}
