// Evolution of Glass & Caustics — 4-pass WebGL2 optical renderer:
// 1. 512x512 GPU Photon Caustic FBO (up to 55,296 real Snell-refracted spectral photons)
// 2. Fullscreen 8-Era Optical Ray Tracer (MRT: HDR + Bloom extract)
// 3. 1/4-res Separable Gaussian HDR Bloom
// 4. ACES Filmic Tone Mapping

import {
  clamp, norm3, cross3, cameraBasisFromOrbit, FULL_VS, linkPrograms, makeTex2D, hdrFormat,
} from "../../src/gl-utils.js";
import {
  DEFAULT_SUN_AZ, DEFAULT_SUN_EL, CAUSTIC_RES, PHOTON_GRID,
} from "./optics.js";
import {
  CAUSTIC_PHOTON_VS, CAUSTIC_PHOTON_FS, GLASS_MAIN_FS, BLUR_FS, FINAL_FS,
} from "./shaders.js";

function sunDirFromAngles(az, el) {
  const c = Math.cos(el);
  return norm3(Math.cos(az) * c, Math.sin(el), Math.sin(az) * c);
}

function sunBasis(sunDir) {
  const fwd = [-sunDir[0], -sunDir[1], -sunDir[2]];
  const right = norm3(...cross3(fwd, [0, 1, 0]));
  const up = cross3(right, fwd);
  return { right, up };
}

export function createGlassEffect(gl) {
  const fmt = hdrFormat(gl);
  const [progPhoton, progMain, progBlur, progFinal] = linkPrograms(gl, [
    [CAUSTIC_PHOTON_VS, CAUSTIC_PHOTON_FS],
    [FULL_VS, GLASS_MAIN_FS],
    [FULL_VS, BLUR_FS],
    [FULL_VS, FINAL_FS],
  ]);
  const vaoEmpty = gl.createVertexArray();

  // Persistent 512x512 photon-splat caustic map (RGBA16F when supported, scaled RGBA8 fallback)
  const texCaustic = makeTex2D(gl, CAUSTIC_RES, CAUSTIC_RES, fmt.internalFmt, fmt.fmt, fmt.type, gl.LINEAR);
  const fboCaustic = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, fboCaustic);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texCaustic, 0);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);

  let bufW = 0, bufH = 0, bw = 0, bh = 0;
  let texHdr = null, texBloom = null, fboMain = null;
  let texBlurA = null, texBlurB = null, fboBlurA = null, fboBlurB = null;

  function allocTargets(w, h) {
    if (w === bufW && h === bufH) return;
    for (const t of [texHdr, texBloom, texBlurA, texBlurB]) if (t) gl.deleteTexture(t);
    for (const f of [fboMain, fboBlurA, fboBlurB]) if (f) gl.deleteFramebuffer(f);
    bufW = w; bufH = h;
    bw = Math.max(64, w >> 2);
    bh = Math.max(64, h >> 2);

    texHdr = makeTex2D(gl, w, h, fmt.internalFmt, fmt.fmt, fmt.type, gl.LINEAR);
    texBloom = makeTex2D(gl, w, h, fmt.internalFmt, fmt.fmt, fmt.type, gl.LINEAR);
    fboMain = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fboMain);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texHdr, 0);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT1, gl.TEXTURE_2D, texBloom, 0);
    gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1]);

    texBlurA = makeTex2D(gl, bw, bh, fmt.internalFmt, fmt.fmt, fmt.type, gl.LINEAR);
    texBlurB = makeTex2D(gl, bw, bh, fmt.internalFmt, fmt.fmt, fmt.type, gl.LINEAR);
    fboBlurA = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fboBlurA);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texBlurA, 0);
    fboBlurB = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fboBlurB);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texBlurB, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  let simTime = 0;
  let highDispOn = false;
  let frostOn = false;
  let sunAzCur = DEFAULT_SUN_AZ, sunAzTarget = DEFAULT_SUN_AZ;
  let sunElCur = DEFAULT_SUN_EL, sunElTarget = DEFAULT_SUN_EL;
  let sweepT = -1.0;

  // Cache caustic key so we only re-splat when sun, spin, prism, bands, dispersion, or frost change
  let lastCausticKey = "";

  function renderCaustics(sunDir, spin, prismYaw, bands, dispStrength, frostAmt) {
    const basis = sunBasis(sunDir);
    const energyScale = fmt.isFloat ? 0.19 : 0.0475;
    gl.bindFramebuffer(gl.FRAMEBUFFER, fboCaustic);
    gl.viewport(0, 0, CAUSTIC_RES, CAUSTIC_RES);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.CULL_FACE);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);

    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE);
    gl.useProgram(progPhoton);
    gl.uniform3fv(gl.getUniformLocation(progPhoton, "uSunDir"), sunDir);
    gl.uniform3fv(gl.getUniformLocation(progPhoton, "uSunRight"), basis.right);
    gl.uniform3fv(gl.getUniformLocation(progPhoton, "uSunUp"), basis.up);
    gl.uniform1f(gl.getUniformLocation(progPhoton, "uSpin"), spin);
    gl.uniform1f(gl.getUniformLocation(progPhoton, "uPrismYaw"), prismYaw);
    gl.uniform1i(gl.getUniformLocation(progPhoton, "uBands"), bands);
    gl.uniform1f(gl.getUniformLocation(progPhoton, "uDispStrength"), dispStrength);
    gl.uniform1f(gl.getUniformLocation(progPhoton, "uFrost"), frostAmt);
    gl.uniform1f(gl.getUniformLocation(progPhoton, "uEnergyScale"), energyScale);
    gl.bindVertexArray(vaoEmpty);
    gl.drawArrays(gl.POINTS, 0, PHOTON_GRID * PHOTON_GRID * bands);
    gl.disable(gl.BLEND);
  }

  return {
    id: "glass",
    maxPixels: 950000,
    defaultCamera: {
      yaw: 0.24,
      pitch: 0.48,
      dist: 7.20,
      lookY: 0.54,
      fovDeg: 38,
      minDist: 3.8,
      maxDist: 12.5,
      minPitch: 0.10,
      maxPitch: 1.24,
      autoOrbitSpeed: 0.0,
    },
    enterStep(stepIdx) {
      if (stepIdx !== 5) highDispOn = false;
      if (stepIdx !== 6) frostOn = false;
      if (stepIdx === 7) sweepT = 0.0;
    },
    onReset() {
      sunAzTarget = DEFAULT_SUN_AZ;
      sunElTarget = DEFAULT_SUN_EL;
      sweepT = -1.0;
      highDispOn = false;
      frostOn = false;
    },
    triggerAction(actionId) {
      if (actionId === "disp") highDispOn = !highDispOn;
      else if (actionId === "frost") frostOn = !frostOn;
      else if (actionId === "sweep") {
        sweepT = 0.0;
        sunAzTarget = DEFAULT_SUN_AZ;
        sunElTarget = DEFAULT_SUN_EL;
      }
    },
    isActionActive(actionId) {
      if (actionId === "disp") return highDispOn;
      if (actionId === "frost") return frostOn;
      if (actionId === "sweep") return sweepT >= 0.0 && sweepT < 5.5;
      return false;
    },
    onCanvasClick(ndcX, ndcY, w, h, step, cam) {
      // Intersect click ray with y = 0 marble floor and steer sun opposite the clicked point
      // so the focused star-caustic & rainbow spectrum glide directly toward where you clicked!
      const aspect = w / Math.max(1, h);
      const portraitScale = aspect < 0.95 ? clamp(1.06 / Math.max(aspect, 0.54), 1.0, 1.56) : 1.0;
      const basis = cameraBasisFromOrbit(cam.yaw, cam.pitch, cam.dist * portraitScale, cam.lookY);
      const tanHalfFov = Math.tan(((cam.fovDeg * Math.PI) / 180) * 0.5);
      const rd = norm3(
        basis.fwd[0] + ndcX * aspect * tanHalfFov * basis.right[0] + ndcY * tanHalfFov * basis.up[0],
        basis.fwd[1] + ndcX * aspect * tanHalfFov * basis.right[1] + ndcY * tanHalfFov * basis.up[1],
        basis.fwd[2] + ndcX * aspect * tanHalfFov * basis.right[2] + ndcY * tanHalfFov * basis.up[2],
      );
      if (rd[1] >= -0.02) return;
      const t = -basis.pos[1] / rd[1];
      if (t <= 0 || t > 30) return;
      const hitX = basis.pos[0] + rd[0] * t;
      const hitZ = basis.pos[2] + rd[2] * t;
      if (Math.hypot(hitX, hitZ) > 3.2) return;
      // Aim sun opposite the clicked spot relative to crystal cluster center (0.2, 0, -0.22)
      const dx = hitX - 0.20, dz = hitZ + 0.22;
      const horiz = Math.max(0.25, Math.hypot(dx, dz));
      sunAzTarget = Math.atan2(-dz, -dx);
      sunElTarget = clamp(Math.atan2(0.95, horiz), 0.34, 0.95);
      sweepT = -1.0;
    },
    getTechBadge(stepIdx) {
      return [
        "1995 · FLAT ALPHA",
        "1999 · ENV + SPECULAR",
        "2003 · SCHLICK FRESNEL",
        "2007 · SNELL REFRACT",
        "2012 · THICK + BEER-LAMBERT",
        highDispOn ? "2016 · DIAMOND DISPERSION" : "2016 · CAUCHY DISPERSION",
        frostOn ? "2021 · FROSTED + CAUSTICS" : "2021 · 16K PHOTON CAUSTICS",
        "2026 · 98K SPECTRAL + TIR",
      ][stepIdx] || "WEBGL2";
    },
    resize(w, h) {
      allocTargets(w, h);
    },
    update(dt, paused) {
      if (!paused) {
        simTime += dt;
        if (sweepT >= 0.0) {
          sweepT += dt;
          if (sweepT < 5.5) {
            const p = sweepT / 5.5;
            sunAzTarget = DEFAULT_SUN_AZ + Math.sin(p * Math.PI * 2.0) * 0.62;
            sunElTarget = DEFAULT_SUN_EL + Math.sin(p * Math.PI * 2.0 + 0.8) * 0.14;
          } else {
            sweepT = -1.0;
            sunAzTarget = DEFAULT_SUN_AZ;
            sunElTarget = DEFAULT_SUN_EL;
          }
        }
      }
      // Smooth shortest-arc sun angle lerp
      let dAz = sunAzTarget - sunAzCur;
      while (dAz > Math.PI) dAz -= Math.PI * 2;
      while (dAz < -Math.PI) dAz += Math.PI * 2;
      const k = 1.0 - Math.exp(-dt * 5.2);
      sunAzCur += dAz * k;
      sunElCur += (sunElTarget - sunElCur) * k;
    },
    render(w, h, step, split, cam) {
      allocTargets(w, h);
      const aspect = w / Math.max(1, h);
      const portraitScale = aspect < 0.95 ? clamp(1.06 / Math.max(aspect, 0.54), 1.0, 1.56) : 1.0;
      const basis = cameraBasisFromOrbit(cam.yaw, cam.pitch, cam.dist * portraitScale, cam.lookY);
      const tanHalfFov = Math.tan(((cam.fovDeg * Math.PI) / 180) * 0.5);

      const stageLeft = split.enabled ? step.compareLeft : step.stage;
      const stageRight = split.enabled ? step.compareRight : step.stage;
      const splitX = split.enabled ? split.pos : 0.0;
      const opaqueLeft = split.enabled && !!step.opaqueSplit ? 1.0 : 0.0;

      const sunDir = sunDirFromAngles(sunAzCur, sunElCur);
      const spin = simTime * 0.28;
      // Prism angled at 2.02 rad (~116 deg) -> blazing 0.98-unit Newton rainbow across center-foreground marble!
      const prismYaw = 2.02 + Math.sin(simTime * 0.30) * 0.05;
      const dispStrength = (step.stage === 5 && highDispOn) ? 1.0 : (step.stage >= 7 ? 0.55 : 0.25);
      const frostAmt = (step.stage === 6 && frostOn) ? 1.0 : 0.0;
      const needCaustics = (stageLeft >= 6 || stageRight >= 6);
      const bands = (stageLeft >= 7 || stageRight >= 7) ? 6 : 1;

      if (needCaustics) {
        const key = `${sunDir[0].toFixed(3)},${sunDir[1].toFixed(3)},${sunDir[2].toFixed(3)},${spin.toFixed(3)},${prismYaw.toFixed(3)},${bands},${dispStrength.toFixed(2)},${frostAmt.toFixed(2)}`;
        if (key !== lastCausticKey) {
          renderCaustics(sunDir, spin, prismYaw, bands, dispStrength, frostAmt);
          lastCausticKey = key;
        }
      }

      // Pass 2: Fullscreen 8-Era Optical Ray Tracer (MRT)
      gl.bindFramebuffer(gl.FRAMEBUFFER, fboMain);
      gl.viewport(0, 0, w, h);
      gl.disable(gl.DEPTH_TEST);
      gl.disable(gl.BLEND);
      gl.useProgram(progMain);
      gl.uniform3fv(gl.getUniformLocation(progMain, "uCamPos"), basis.pos);
      gl.uniform3fv(gl.getUniformLocation(progMain, "uCamRight"), basis.right);
      gl.uniform3fv(gl.getUniformLocation(progMain, "uCamUp"), basis.up);
      gl.uniform3fv(gl.getUniformLocation(progMain, "uCamFwd"), basis.fwd);
      gl.uniform1f(gl.getUniformLocation(progMain, "uTanHalfFov"), tanHalfFov);
      gl.uniform1f(gl.getUniformLocation(progMain, "uAspect"), aspect);
      gl.uniform3fv(gl.getUniformLocation(progMain, "uSunDir"), sunDir);
      gl.uniform1f(gl.getUniformLocation(progMain, "uTime"), simTime);
      gl.uniform1f(gl.getUniformLocation(progMain, "uSpin"), spin);
      gl.uniform1f(gl.getUniformLocation(progMain, "uPrismYaw"), prismYaw);
      gl.uniform1i(gl.getUniformLocation(progMain, "uStageLeft"), stageLeft);
      gl.uniform1i(gl.getUniformLocation(progMain, "uStageRight"), stageRight);
      gl.uniform1f(gl.getUniformLocation(progMain, "uSplitX"), splitX);
      gl.uniform1f(gl.getUniformLocation(progMain, "uOpaqueLeft"), opaqueLeft);
      gl.uniform1f(gl.getUniformLocation(progMain, "uDispStrength"), dispStrength);
      gl.uniform1f(gl.getUniformLocation(progMain, "uFrost"), frostAmt);
      gl.uniform1f(gl.getUniformLocation(progMain, "uCausticDecode"), fmt.isFloat ? 1.0 : 4.0);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, texCaustic);
      gl.uniform1i(gl.getUniformLocation(progMain, "uTexCaustic"), 0);
      gl.bindVertexArray(vaoEmpty);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

      // Pass 3: 1/4-res Separable HDR Bloom
      gl.useProgram(progBlur);
      gl.uniform1i(gl.getUniformLocation(progBlur, "uSrc"), 0);
      gl.bindFramebuffer(gl.FRAMEBUFFER, fboBlurA);
      gl.viewport(0, 0, bw, bh);
      gl.bindTexture(gl.TEXTURE_2D, texBloom);
      gl.uniform2f(gl.getUniformLocation(progBlur, "uDir"), 1.0 / bw, 0.0);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

      gl.bindFramebuffer(gl.FRAMEBUFFER, fboBlurB);
      gl.bindTexture(gl.TEXTURE_2D, texBlurA);
      gl.uniform2f(gl.getUniformLocation(progBlur, "uDir"), 0.0, 1.0 / bh);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

      // Pass 4: ACES Filmic Composite
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, w, h);
      gl.useProgram(progFinal);
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, texHdr);
      gl.uniform1i(gl.getUniformLocation(progFinal, "uHdr"), 0);
      gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, texBlurB);
      gl.uniform1i(gl.getUniformLocation(progFinal, "uBloom"), 1);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    },
  };
}
