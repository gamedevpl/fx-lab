// Evolution of Clouds & Sky — 4-pass WebGL2 volumetric sky & cloud renderer:
// 0. Startup prepass (< 3 ms): Bakes tileable 64x64x64 RGBA8 Perlin-Worley TEXTURE_3D on GPU
// 1. CLOUDS_MAIN_FS (MRT): 8 eras of sky/clouds + alpine peak with cloud shadows + god-ray occlusion
// 2. GODRAYS_FS (1/2-res): 32-tap crepuscular volumetric light shafts through cumulus gaps
// 3. BLUR_FS (1/2-res): Separable Gaussian smooth on light shafts
// 4. FINAL_FS: ACES filmic tone mapping with clean split-screen masking

import {
  clamp, norm3, cameraBasisFromOrbit, FULL_VS, linkPrograms, makeTex2D, hdrFormat,
} from "../../src/gl-utils.js";
import {
  VOL_RES, DEFAULT_SUN_AZ, DEFAULT_SUN_EL, NOISE_BAKE_FS,
} from "./atmosphere.js";
import {
  CLOUDS_MAIN_FS, GODRAYS_FS, BLUR_FS, FINAL_FS,
} from "./shaders.js";

function sunDirFromAngles(az, el) {
  const c = Math.cos(el);
  return norm3(Math.sin(az) * c, Math.sin(el), -Math.cos(az) * c);
}

function dot3(a, b) {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

// Bake tileable 64^3 RGBA8 Perlin-Worley + multi-octave Worley noise into a native WebGL2 TEXTURE_3D
function bakeCloudNoise3D(gl, progBake, vaoEmpty) {
  const tex3D = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_3D, tex3D);
  gl.texImage3D(gl.TEXTURE_3D, 0, gl.RGBA8, VOL_RES, VOL_RES, VOL_RES, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
  gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_S, gl.REPEAT);
  gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_T, gl.REPEAT);
  gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_R, gl.REPEAT);

  const fbo = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  gl.viewport(0, 0, VOL_RES, VOL_RES);
  gl.disable(gl.DEPTH_TEST);
  gl.disable(gl.BLEND);
  gl.useProgram(progBake);
  const locZ = gl.getUniformLocation(progBake, "uZ");
  gl.bindVertexArray(vaoEmpty);
  for (let z = 0; z < VOL_RES; z++) {
    gl.framebufferTextureLayer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, tex3D, 0, z);
    gl.uniform1f(locZ, (z + 0.5) / VOL_RES);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.deleteFramebuffer(fbo);
  return tex3D;
}

export function createCloudsEffect(gl) {
  const fmt = hdrFormat(gl);
  const [progBake, progMain, progRays, progBlur, progFinal] = linkPrograms(gl, [
    [FULL_VS, NOISE_BAKE_FS],
    [FULL_VS, CLOUDS_MAIN_FS],
    [FULL_VS, GODRAYS_FS],
    [FULL_VS, BLUR_FS],
    [FULL_VS, FINAL_FS],
  ]);
  const vaoEmpty = gl.createVertexArray();

  // Bake tileable 64^3 Perlin-Worley volume once at boot (< 3 ms on GPU!)
  const texCloud3D = bakeCloudNoise3D(gl, progBake, vaoEmpty);
  gl.deleteProgram(progBake);

  let bufW = 0, bufH = 0, rw = 0, rh = 0;
  let texHdr = null, texOcc = null, fboMain = null;
  let texRays = null, texBlurA = null, texBlurB = null;
  let fboRays = null, fboBlurA = null, fboBlurB = null;

  function allocTargets(w, h) {
    if (w === bufW && h === bufH) return;
    for (const t of [texHdr, texOcc, texRays, texBlurA, texBlurB]) if (t) gl.deleteTexture(t);
    for (const f of [fboMain, fboRays, fboBlurA, fboBlurB]) if (f) gl.deleteFramebuffer(f);
    bufW = w; bufH = h;
    rw = Math.max(96, w >> 1);
    rh = Math.max(96, h >> 1);

    texHdr = makeTex2D(gl, w, h, fmt.internalFmt, fmt.fmt, fmt.type, gl.LINEAR);
    texOcc = makeTex2D(gl, w, h, fmt.internalFmt, fmt.fmt, fmt.type, gl.LINEAR);
    fboMain = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fboMain);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texHdr, 0);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT1, gl.TEXTURE_2D, texOcc, 0);
    gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1]);

    texRays = makeTex2D(gl, rw, rh, fmt.internalFmt, fmt.fmt, fmt.type, gl.LINEAR);
    fboRays = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fboRays);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texRays, 0);

    texBlurA = makeTex2D(gl, rw, rh, fmt.internalFmt, fmt.fmt, fmt.type, gl.LINEAR);
    texBlurB = makeTex2D(gl, rw, rh, fmt.internalFmt, fmt.fmt, fmt.type, gl.LINEAR);
    fboBlurA = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fboBlurA);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texBlurA, 0);
    fboBlurB = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fboBlurB);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texBlurB, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  let simTime = 0;
  let showCardsOn = false;
  let stormOn = false;
  let stormCur = 0.0;
  let sunAzCur = DEFAULT_SUN_AZ, sunAzTarget = DEFAULT_SUN_AZ;
  let sunElCur = DEFAULT_SUN_EL, sunElTarget = DEFAULT_SUN_EL;
  let sweepT = -1.0;

  return {
    id: "clouds",
    maxPixels: 820000,
    defaultCamera: {
      yaw: 0.0,
      pitch: -0.17, // Gentle upward skyward view framing alpine peak at bottom + towering clouds above!
      dist: 3.1,
      lookY: 0.62,
      fovDeg: 52,
      minDist: 2.0,
      maxDist: 6.5,
      minPitch: -0.46,
      maxPitch: 0.22,
      autoOrbitSpeed: 0.0,
    },
    enterStep(stepIdx) {
      if (stepIdx !== 2) showCardsOn = false;
      if (stepIdx !== 6) stormOn = false;
      if (stepIdx === 7) sweepT = 0.0;
    },
    onReset() {
      sunAzTarget = DEFAULT_SUN_AZ;
      sunElTarget = DEFAULT_SUN_EL;
      sweepT = -1.0;
      showCardsOn = false;
      stormOn = false;
    },
    triggerAction(actionId) {
      if (actionId === "cards") showCardsOn = !showCardsOn;
      else if (actionId === "storm") stormOn = !stormOn;
      else if (actionId === "sweep") {
        sweepT = 0.0;
        sunAzTarget = DEFAULT_SUN_AZ;
        sunElTarget = DEFAULT_SUN_EL;
      }
    },
    isActionActive(actionId) {
      if (actionId === "cards") return showCardsOn;
      if (actionId === "storm") return stormOn;
      if (actionId === "sweep") return sweepT >= 0.0 && sweepT < 6.0;
      return false;
    },
    onCanvasClick(ndcX, ndcY, w, h, step, cam) {
      // Aim the sun directly where the user clicked in the sky (noon azure -> golden sunset -> twilight)!
      const aspect = w / Math.max(1, h);
      const basis = cameraBasisFromOrbit(cam.yaw, cam.pitch, cam.dist, cam.lookY);
      const tanHalfFov = Math.tan(((cam.fovDeg * Math.PI) / 180) * 0.5);
      const rd = norm3(
        basis.fwd[0] + ndcX * aspect * tanHalfFov * basis.right[0] + ndcY * tanHalfFov * basis.up[0],
        basis.fwd[1] + ndcX * aspect * tanHalfFov * basis.right[1] + ndcY * tanHalfFov * basis.up[1],
        basis.fwd[2] + ndcX * aspect * tanHalfFov * basis.right[2] + ndcY * tanHalfFov * basis.up[2],
      );
      sunAzTarget = Math.atan2(rd[0], -rd[2]);
      sunElTarget = clamp(Math.asin(clamp(rd[1], -0.05, 0.85)), -0.02, 0.78);
      sweepT = -1.0;
    },
    getTechBadge(stepIdx) {
      return [
        "1992 · BANDED + 2D PIXEL",
        "1997 · SKYBOX + PLANE",
        showCardsOn ? "2002 · BILLBOARD QUADS" : "2002 · 3D BILLBOARDS",
        "2007 · RAYLEIGH + MIE",
        "2012 · 64³ PERLIN-WORLEY",
        "2016 · BEER + HG SILVER",
        stormOn ? "2020 · STORM ANVIL MS" : "2020 · MULTI-SCATTER",
        "2026 · GOD-RAYS + TOD",
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
          if (sweepT < 6.0) {
            const p = sweepT / 6.0;
            // Dramatic afternoon -> golden sunset -> warm dusk -> golden afternoon sweep!
            sunAzTarget = DEFAULT_SUN_AZ + Math.sin(p * Math.PI * 2.0) * 0.42;
            sunElTarget = DEFAULT_SUN_EL + Math.sin(p * Math.PI * 2.0) * 0.24 - Math.sin(p * Math.PI) * 0.14;
            sunElTarget = clamp(sunElTarget, 0.03, 0.62);
          } else {
            sweepT = -1.0;
            sunAzTarget = DEFAULT_SUN_AZ;
            sunElTarget = DEFAULT_SUN_EL;
          }
        }
      }
      let dAz = sunAzTarget - sunAzCur;
      while (dAz > Math.PI) dAz -= Math.PI * 2;
      while (dAz < -Math.PI) dAz += Math.PI * 2;
      const k = 1.0 - Math.exp(-dt * 4.8);
      sunAzCur += dAz * k;
      sunElCur += (sunElTarget - sunElCur) * k;
      stormCur += ((stormOn ? 1.0 : 0.0) - stormCur) * (1.0 - Math.exp(-dt * 4.5));
    },
    render(w, h, step, split, cam) {
      allocTargets(w, h);
      const aspect = w / Math.max(1, h);
      const basis = cameraBasisFromOrbit(cam.yaw, cam.pitch, cam.dist, cam.lookY);
      const tanHalfFov = Math.tan(((cam.fovDeg * Math.PI) / 180) * 0.5);

      const stageLeft = split.enabled ? step.compareLeft : step.stage;
      const stageRight = split.enabled ? step.compareRight : step.stage;
      const splitX = split.enabled ? split.pos : 0.0;
      const solidLeft = split.enabled && !!step.solidSplit ? 1.0 : 0.0;

      const sunDir = sunDirFromAngles(sunAzCur, sunElCur);

      // Project sun direction onto screen UV [0..1] for crepuscular god-rays pass
      const dFwd = dot3(sunDir, basis.fwd);
      const safeFwd = Math.max(0.15, dFwd);
      const sunNdcX = dot3(sunDir, basis.right) / (safeFwd * aspect * tanHalfFov);
      const sunNdcY = dot3(sunDir, basis.up) / (safeFwd * tanHalfFov);
      const sunUvX = sunNdcX * 0.5 + 0.5;
      const sunUvY = sunNdcY * 0.5 + 0.5;
      const sunVis = clamp((dFwd - 0.15) / 0.35, 0.0, 1.0) * clamp((sunDir[1] + 0.04) / 0.14, 0.0, 1.0);

      // Pass 1: 8-Era Sky, Volumetric Clouds & Alpine Peak (MRT)
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
      gl.uniform1i(gl.getUniformLocation(progMain, "uStageLeft"), stageLeft);
      gl.uniform1i(gl.getUniformLocation(progMain, "uStageRight"), stageRight);
      gl.uniform1f(gl.getUniformLocation(progMain, "uSplitX"), splitX);
      gl.uniform1f(gl.getUniformLocation(progMain, "uSolidLeft"), solidLeft);
      gl.uniform1f(gl.getUniformLocation(progMain, "uShowCards"), (step.stage === 2 && showCardsOn) ? 1.0 : 0.0);
      gl.uniform1f(gl.getUniformLocation(progMain, "uStorm"), stormCur);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_3D, texCloud3D);
      gl.uniform1i(gl.getUniformLocation(progMain, "uCloudTex3D"), 0);
      gl.bindVertexArray(vaoEmpty);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

      // Pass 2 & 3: Crepuscular God-Rays + Smooth (only when Step 8 is visible!)
      const needRays = (stageLeft >= 7 || stageRight >= 7);
      if (needRays) {
        gl.bindFramebuffer(gl.FRAMEBUFFER, fboRays);
        gl.viewport(0, 0, rw, rh);
        gl.useProgram(progRays);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, texOcc);
        gl.uniform1i(gl.getUniformLocation(progRays, "uOccTex"), 0);
        gl.uniform2f(gl.getUniformLocation(progRays, "uSunUv"), sunUvX, sunUvY);
        gl.uniform1f(gl.getUniformLocation(progRays, "uSunVis"), sunVis);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

        gl.useProgram(progBlur);
        gl.uniform1i(gl.getUniformLocation(progBlur, "uSrc"), 0);
        gl.bindFramebuffer(gl.FRAMEBUFFER, fboBlurA);
        gl.bindTexture(gl.TEXTURE_2D, texRays);
        gl.uniform2f(gl.getUniformLocation(progBlur, "uDir"), 1.0 / rw, 0.0);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

        gl.bindFramebuffer(gl.FRAMEBUFFER, fboBlurB);
        gl.bindTexture(gl.TEXTURE_2D, texBlurA);
        gl.uniform2f(gl.getUniformLocation(progBlur, "uDir"), 0.0, 1.0 / rh);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      }

      // Pass 4: ACES Filmic Composite (masks god-rays cleanly to Step 8 side of split!)
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, w, h);
      gl.useProgram(progFinal);
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, texHdr);
      gl.uniform1i(gl.getUniformLocation(progFinal, "uHdr"), 0);
      gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, texBlurB);
      gl.uniform1i(gl.getUniformLocation(progFinal, "uGodRays"), 1);
      gl.uniform1i(gl.getUniformLocation(progFinal, "uStageLeft"), stageLeft);
      gl.uniform1i(gl.getUniformLocation(progFinal, "uStageRight"), stageRight);
      gl.uniform1f(gl.getUniformLocation(progFinal, "uSplitX"), splitX);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    },
  };
}
