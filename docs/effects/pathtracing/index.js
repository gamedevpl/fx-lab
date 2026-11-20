// Evolution of Path Tracing (1975-2026) — Analytical Cornell Gallery WebGL2 renderer:
// - 8 eras on one unified Cornell Gallery scene:
//   0: 1975 Blinn-Phong rasterization (local lighting, zero shadows/reflections)
//   1: 1980 Whitted ray tracing (hard point shadows, sharp chrome mirror, Snell glass)
//   2: 1984 Cook distributed RT (soft area shadows, glossy gold, thin-lens DoF, motion blur)
//   3: 1986 Kajiya path tracing (1 SPP unbiased Monte Carlo GI -> red/teal color bleed + heavy noise)
//   4: 1998 Multi-SPP progressive accumulation (slowly converges when static, resets on camera move)
//   5: 2005 Importance sampling + NEE + Veach MIS (dramatically less noise at same 2 SPP budget!)
//   6: 2020 ReSTIR multi-light RIS + 4-pass edge-stopping A-Trous SVGF denoiser
//   7: 2026 Real-time browser path tracing (interactive moving glowing orb + neon accent + live SVGF)

import {
  clamp, norm3, cameraBasisFromOrbit,
  FULL_VS, linkPrograms, makeTex2D, hdrFormat,
} from "../../src/gl-utils.js";
import { PT_TRACE_FS, ACCUM_FS, ATROUS_FS, FINAL_FS } from "./shaders.js";

const ORB_PRESETS = [
  { pos: [ 0.08, 1.88,  0.22], col: [15.5, 9.2, 3.2] },  // Warm tungsten amber
  { pos: [-1.42, 2.38,  0.35], col: [16.0, 4.2, 8.8] },  // Vivid gallery magenta-rose
  { pos: [ 1.38, 1.56,  0.65], col: [ 3.4, 13.8, 15.2] }, // Cool electric cyan
  { pos: [ 0.05, 0.92, -0.35], col: [16.5, 12.2, 4.8] }, // Low floor-bounce gold
];

export function createPathtracingEffect(gl) {
  const fmt = hdrFormat(gl);
  const [progTrace, progAccum, progAtrous, progFinal] = linkPrograms(gl, [
    [FULL_VS, PT_TRACE_FS],
    [FULL_VS, ACCUM_FS],
    [FULL_VS, ATROUS_FS],
    [FULL_VS, FINAL_FS],
  ]);

  // Cache uniform locations once per program to avoid per-frame string lookups
  const uLoc = (p, names) => Object.fromEntries(names.map(n => [n, gl.getUniformLocation(p, n)]));
  const uTrace = uLoc(progTrace, [
    "uCamPos", "uCamRight", "uCamUp", "uCamFwd",
    "uTanHalfFov", "uAspect", "uRes", "uTime", "uFrame",
    "uStageLeft", "uStageRight", "uSplitX",
    "uSolidLeft", "uRawLeft", "uDofBoost", "uRawNoisy", "uExtraSpp",
    "uLightOrbPos", "uLightOrbCol",
  ]);
  const uAccum = uLoc(progAccum, [
    "uCurRad", "uPrevAccum", "uBlendAlpha",
    "uStageLeft", "uStageRight", "uSplitX",
  ]);
  const uAtrous = uLoc(progAtrous, [
    "uSrc", "uNormDepth", "uAlbedo", "uTexel", "uStepSize",
    "uStageLeft", "uStageRight", "uSplitX",
  ]);
  const uFinal = uLoc(progFinal, [
    "uRad", "uAlbedo", "uStageLeft", "uStageRight", "uSplitX",
  ]);

  const vaoEmpty = gl.createVertexArray();

  // Render targets: MRT path-trace G-buffer + ping-pong accum + ping-pong A-Trous SVGF
  let bufW = 0, bufH = 0;
  let texRad = null, texNormDepth = null, texAlbedo = null, fboTrace = null;
  let texAccum = [null, null], fboAccum = [null, null];
  let texDenoise = [null, null], fboDenoise = [null, null];

  function allocTargets(w, h) {
    if (w === bufW && h === bufH) return;
    for (const t of [texRad, texNormDepth, texAlbedo, ...texAccum, ...texDenoise]) {
      if (t) gl.deleteTexture(t);
    }
    for (const f of [fboTrace, ...fboAccum, ...fboDenoise]) {
      if (f) gl.deleteFramebuffer(f);
    }
    bufW = w;
    bufH = h;

    texRad       = makeTex2D(gl, w, h, fmt.internalFmt, fmt.fmt, fmt.type, gl.NEAREST);
    texNormDepth = makeTex2D(gl, w, h, fmt.internalFmt, fmt.fmt, fmt.type, gl.NEAREST);
    texAlbedo    = makeTex2D(gl, w, h, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, gl.NEAREST);

    fboTrace = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fboTrace);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texRad, 0);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT1, gl.TEXTURE_2D, texNormDepth, 0);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT2, gl.TEXTURE_2D, texAlbedo, 0);
    gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1, gl.COLOR_ATTACHMENT2]);

    for (let i = 0; i < 2; i++) {
      texAccum[i] = makeTex2D(gl, w, h, fmt.internalFmt, fmt.fmt, fmt.type, gl.NEAREST);
      fboAccum[i] = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, fboAccum[i]);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texAccum[i], 0);

      texDenoise[i] = makeTex2D(gl, w, h, fmt.internalFmt, fmt.fmt, fmt.type, gl.NEAREST);
      fboDenoise[i] = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, fboDenoise[i]);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texDenoise[i], 0);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    accumCount = 0;
  }

  let simTime = 0;
  let frameCounter = 0;
  let accumIdx = 0;
  let accumCount = 0;
  let lastCamKey = "";

  // Interactive effect state
  let dofBoost = false;
  let rawNoisy = false;
  let autoOrb = true;
  let orbPresetIdx = 0;
  let orbPos = [0.10, 1.86, 0.25];
  let orbTarget = [0.10, 1.86, 0.25];
  let orbCol = [...ORB_PRESETS[0].col];
  let orbTargetCol = [...ORB_PRESETS[0].col];
  let prevOrbPos = [...orbPos];

  function resetAccum() {
    accumCount = 0;
    lastCamKey = "";
  }

  function keepOrbClear(x, y, z) {
    let ox = clamp(x, -2.18, 2.18);
    let oy = clamp(y, 0.42, 2.88);
    let oz = clamp(z, -2.10, 1.85);
    // Keep clear of the 3 hero spheres so the glowing orb never clips inside them
    const obstacles = [
      [-1.04, 1.72, -1.13, 0.84],
      [ 1.12, 0.74, -0.92, 1.02],
      [-0.34, 0.56,  0.68, 0.86],
    ];
    for (const [cx, cy, cz, minR] of obstacles) {
      const dx = ox - cx, dy = oy - cy, dz = oz - cz;
      const d = Math.hypot(dx, dy, dz);
      if (d < minR && d > 1e-4) {
        ox = cx + (dx / d) * minR;
        oy = cy + (dy / d) * minR;
        oz = cz + (dz / d) * minR;
      }
    }
    return [clamp(ox, -2.18, 2.18), clamp(oy, 0.42, 2.88), clamp(oz, -2.10, 1.85)];
  }

  return {
    id: "pathtracing",
    maxPixels: 520000,
    defaultCamera: {
      yaw: 0.0,
      pitch: 0.045,
      dist: 5.55,
      lookY: 1.48,
      fovDeg: 45,
      minDist: 2.8,
      maxDist: 7.4,
      minPitch: -0.34,
      maxPitch: 0.52,
      autoOrbitSpeed: 0.0,
    },
    enterStep(stepIdx) {
      if (stepIdx !== 2) dofBoost = false;
      if (stepIdx !== 6) rawNoisy = false;
      resetAccum();
    },
    onReset() {
      dofBoost = false;
      rawNoisy = false;
      autoOrb = true;
      orbPresetIdx = 0;
      orbTargetCol = [...ORB_PRESETS[0].col];
      resetAccum();
    },
    triggerAction(actionId) {
      if (actionId === "dof") {
        dofBoost = !dofBoost;
      } else if (actionId === "resetAccum") {
        resetAccum();
      } else if (actionId === "raw") {
        rawNoisy = !rawNoisy;
        resetAccum();
      } else if (actionId === "cycleLight") {
        autoOrb = false;
        orbPresetIdx = (orbPresetIdx + 1) % ORB_PRESETS.length;
        orbTarget = [...ORB_PRESETS[orbPresetIdx].pos];
        orbTargetCol = [...ORB_PRESETS[orbPresetIdx].col];
      }
    },
    isActionActive(actionId) {
      if (actionId === "dof") return dofBoost;
      if (actionId === "raw") return rawNoisy;
      return false;
    },
    onCanvasClick(ndcX, ndcY, w, h, step, cam) {
      if (step.stage === 4) {
        resetAccum();
        return;
      }
      if (step.stage < 6) return;
      const aspect = w / Math.max(1, h);
      const basis = cameraBasisFromOrbit(cam.yaw, cam.pitch, cam.dist, cam.lookY);
      const tanHalfFov = Math.tan(((cam.fovDeg * Math.PI) / 180) * 0.5);
      const rd = norm3(
        basis.fwd[0] + ndcX * aspect * tanHalfFov * basis.right[0] + ndcY * tanHalfFov * basis.up[0],
        basis.fwd[1] + ndcX * aspect * tanHalfFov * basis.right[1] + ndcY * tanHalfFov * basis.up[1],
        basis.fwd[2] + ndcX * aspect * tanHalfFov * basis.right[2] + ndcY * tanHalfFov * basis.up[2],
      );
      // Intersect camera ray with the gallery mid-plane z = 0.15
      if (Math.abs(rd[2]) > 1e-4) {
        const t = (0.15 - basis.pos[2]) / rd[2];
        if (t > 0.3 && t < 14.0) {
          const px = basis.pos[0] + rd[0] * t;
          const py = basis.pos[1] + rd[1] * t;
          const pz = basis.pos[2] + rd[2] * t;
          autoOrb = false;
          orbTarget = keepOrbClear(px, py, pz);
          // Warm gold on left/center, cool cyan-teal accent near right!
          const warm = clamp(0.5 - orbTarget[0] * 0.25, 0, 1);
          orbTargetCol = [
            4.5 + warm * 12.0,
            12.8 - warm * 2.6,
            15.2 - warm * 11.4,
          ];
        }
      }
    },
    getTechBadge(stepIdx) {
      return [
        "1975 · BLINN-PHONG",
        "1980 · WHITTED RT",
        dofBoost ? "1984 · COOK WIDE f/1.4" : "1984 · COOK DISTRIBUTED",
        "1986 · KAJIYA 1 SPP",
        "1998 · MULTI-SPP ACCUM",
        "2005 · NEE + VEACH MIS",
        rawNoisy ? "2020 · RAW 1 SPP INPUT" : "2020 · ReSTIR + SVGF",
        "2026 · LIVE BROWSER PT",
      ][stepIdx] || "WEBGL2";
    },
    resize(w, h) {
      allocTargets(w, h);
    },
    update(dt, paused, step) {
      if (paused) return;
      simTime += dt;
      prevOrbPos = [...orbPos];

      if (autoOrb) {
        // Smooth gallery hover in the open center-right corridor (never eclipses the left ceramic sphere!)
        const ang = simTime * 0.65;
        orbTarget = keepOrbClear(
          0.55 + Math.sin(ang) * 0.68,
          1.84 + Math.sin(ang * 2.0) * 0.34,
          0.22 + Math.cos(ang) * 0.48,
        );
        const tint = 0.5 + 0.5 * Math.sin(simTime * 0.42);
        orbTargetCol = [
          16.2 * (1 - tint * 0.50) + 12.5 * tint,
          7.2 * (1 - tint * 0.35) + 4.8 * tint,
          2.0 + tint * 10.2,
        ];
      }

      const blend = 1.0 - Math.exp(-dt * 6.5);
      for (let i = 0; i < 3; i++) {
        orbPos[i] += (orbTarget[i] - orbPos[i]) * blend;
        orbCol[i] += (orbTargetCol[i] - orbCol[i]) * blend;
      }

      if (step && step.stage !== 4 && accumCount > 8) {
        accumCount = 8;
      }
    },
    render(w, h, step, split, cam) {
      allocTargets(w, h);
      frameCounter++;

      const aspect = w / Math.max(1, h);
      const basis = cameraBasisFromOrbit(cam.yaw, cam.pitch, cam.dist, cam.lookY);
      const tanHalfFov = Math.tan(((cam.fovDeg * Math.PI) / 180) * 0.5);

      const stageLeft = split.enabled ? step.compareLeft : step.stage;
      const stageRight = split.enabled ? step.compareRight : step.stage;
      const splitX = split.enabled ? split.pos : 0.0;
      const solidLeft = split.enabled && !!step.solidSplit ? 1.0 : 0.0;
      const rawLeft = split.enabled && !!step.rawSplit ? 1.0 : 0.0;

      // Track camera & state changes to reset Stage 4 progressive accumulation immediately on drag!
      const camKey = `${cam.yaw.toFixed(4)}|${cam.pitch.toFixed(4)}|${cam.dist.toFixed(4)}|${cam.lookY.toFixed(4)}|${stageLeft}|${stageRight}|${splitX.toFixed(3)}|${rawNoisy}|${dofBoost}`;
      const camChanged = camKey !== lastCamKey;
      if (camChanged) {
        lastCamKey = camKey;
        accumCount = 1;
      } else {
        accumCount = Math.min(accumCount + 1, 512);
      }

      const orbSpeed = Math.hypot(
        orbPos[0] - prevOrbPos[0],
        orbPos[1] - prevOrbPos[1],
        orbPos[2] - prevOrbPos[2],
      );
      const usesStage4 = (stageLeft === 4 && splitX > 0.005) || (stageRight === 4 && splitX < 0.995);
      let blendAlpha = 1.0;
      if (usesStage4) {
        blendAlpha = 1.0 / Math.max(1, accumCount);
      } else if (!camChanged) {
        blendAlpha = orbSpeed > 0.003 ? 0.52 : 0.24;
      }

      gl.disable(gl.DEPTH_TEST);
      gl.disable(gl.BLEND);
      gl.disable(gl.CULL_FACE);
      gl.bindVertexArray(vaoEmpty);

      // PASS 1: Analytical Cornell Gallery Path Tracer (MRT: Rad, NormDepth, Albedo)
      gl.bindFramebuffer(gl.FRAMEBUFFER, fboTrace);
      gl.viewport(0, 0, w, h);
      gl.useProgram(progTrace);
      gl.uniform3fv(uTrace.uCamPos, basis.pos);
      gl.uniform3fv(uTrace.uCamRight, basis.right);
      gl.uniform3fv(uTrace.uCamUp, basis.up);
      gl.uniform3fv(uTrace.uCamFwd, basis.fwd);
      gl.uniform1f(uTrace.uTanHalfFov, tanHalfFov);
      gl.uniform1f(uTrace.uAspect, aspect);
      gl.uniform2f(uTrace.uRes, w, h);
      gl.uniform1f(uTrace.uTime, simTime);
      gl.uniform1i(uTrace.uFrame, frameCounter);
      gl.uniform1i(uTrace.uStageLeft, stageLeft);
      gl.uniform1i(uTrace.uStageRight, stageRight);
      gl.uniform1f(uTrace.uSplitX, splitX);
      gl.uniform1f(uTrace.uSolidLeft, solidLeft);
      gl.uniform1f(uTrace.uRawLeft, rawLeft);
      gl.uniform1f(uTrace.uDofBoost, (step.stage === 2 && dofBoost) ? 1.0 : 0.0);
      gl.uniform1f(uTrace.uRawNoisy, (step.stage === 6 && rawNoisy) ? 1.0 : 0.0);
      gl.uniform1i(uTrace.uExtraSpp, 0);
      gl.uniform3fv(uTrace.uLightOrbPos, orbPos);
      gl.uniform3fv(uTrace.uLightOrbCol, orbCol);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

      // PASS 2: Temporal Accumulation (progressive convergence on Stage 4 + gentle stabilization on Stages 6-7)
      const prevIdx = accumIdx;
      const nextIdx = 1 - accumIdx;
      accumIdx = nextIdx;
      gl.bindFramebuffer(gl.FRAMEBUFFER, fboAccum[nextIdx]);
      gl.useProgram(progAccum);
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, texRad);
      gl.uniform1i(uAccum.uCurRad, 0);
      gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, texAccum[prevIdx]);
      gl.uniform1i(uAccum.uPrevAccum, 1);
      gl.uniform1f(uAccum.uBlendAlpha, blendAlpha);
      gl.uniform1i(uAccum.uStageLeft, stageLeft);
      gl.uniform1i(uAccum.uStageRight, stageRight);
      gl.uniform1f(uAccum.uSplitX, splitX);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

      let finalRadTex = texAccum[nextIdx];

      // PASS 3: 4-Pass Edge-Stopping Joint-Bilateral A-Trous SVGF Denoiser (Stages 6-7 diffuse irradiance only!)
      const needsDenoise = (stageLeft >= 6 && splitX > 0.005) || (stageRight >= 6 && splitX < 0.995);
      if (needsDenoise) {
        gl.useProgram(progAtrous);
        gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, texNormDepth);
        gl.uniform1i(uAtrous.uNormDepth, 1);
        gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D, texAlbedo);
        gl.uniform1i(uAtrous.uAlbedo, 2);
        gl.uniform2f(uAtrous.uTexel, 1.0 / w, 1.0 / h);
        gl.uniform1i(uAtrous.uStageLeft, stageLeft);
        gl.uniform1i(uAtrous.uStageRight, stageRight);
        gl.uniform1f(uAtrous.uSplitX, splitX);

        const steps = [1.0, 2.0, 4.0, 8.0];
        let srcTex = finalRadTex;
        for (let i = 0; i < steps.length; i++) {
          const dst = i & 1;
          gl.bindFramebuffer(gl.FRAMEBUFFER, fboDenoise[dst]);
          gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, srcTex);
          gl.uniform1i(uAtrous.uSrc, 0);
          gl.uniform1f(uAtrous.uStepSize, steps[i]);
          gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
          srcTex = texDenoise[dst];
        }
        finalRadTex = srcTex;
      }

      // PASS 4: Albedo Re-Modulation + ACES Filmic Tone Mapping
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, w, h);
      gl.useProgram(progFinal);
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, finalRadTex);
      gl.uniform1i(uFinal.uRad, 0);
      gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, texAlbedo);
      gl.uniform1i(uFinal.uAlbedo, 1);
      gl.uniform1i(uFinal.uStageLeft, stageLeft);
      gl.uniform1i(uFinal.uStageRight, stageRight);
      gl.uniform1f(uFinal.uSplitX, splitX);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    },
  };
}
