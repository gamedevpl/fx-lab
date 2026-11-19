// Evolution of Water — multi-pass WebGL2 renderer (Basin -> Water -> Splash -> Bloom -> ACES),
// live 128x128 zero-mean shallow-water PDE stepper and click-to-ripple raycast.

import {
  clamp, smoothstep, cameraBasisFromOrbit, FULL_VS, linkPrograms, makeTex2D, hdrFormat,
} from "../../src/gl-utils.js";
import {
  CLUT_16_F32, PAL_N, TILE_N, GW, GH, PILLAR_X, PILLAR_Z, PILLAR_R,
  IMPACT_X, IMPACT_Z, IMPACT_T, DROP_COUNT, DROP_META,
  buildClutIndexBuffer, buildRippleTile, getColliderPos, createShallowWaterSim,
} from "./simulation.js";
import { BASIN_FS, WATER_FS, SPLASH_FS, BLUR_FS, FINAL_FS } from "./shaders.js";

const SIM_DT = 1.0 / 30.0;

export function createWaterEffect(gl) {
  const fmt = hdrFormat(gl);
  const [progBasin, progWater, progSplash, progBlur, progFinal] = linkPrograms(gl, [
    [FULL_VS, BASIN_FS],
    [FULL_VS, WATER_FS],
    [FULL_VS, SPLASH_FS],
    [FULL_VS, BLUR_FS],
    [FULL_VS, FINAL_FS],
  ]);
  const vaoFull = gl.createVertexArray();

  const sim = createShallowWaterSim();

  const texPalIdx = makeTex2D(gl, PAL_N, PAL_N, gl.R8, gl.RED, gl.UNSIGNED_BYTE, gl.NEAREST, buildClutIndexBuffer());
  const texTile = makeTex2D(gl, TILE_N, TILE_N, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, gl.NEAREST, buildRippleTile(), gl.REPEAT);
  const texWave = makeTex2D(gl, GW, GH, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, gl.LINEAR, sim.texBuf);

  let bufW = 0, bufH = 0, bw = 0, bh = 0;
  let texScene = null, texSceneDepth = null, fboBasin = null;
  let texHdrA = null, texBloomA = null, texWaterDepth = null, fboWater = null;
  let texHdrB = null, texBloomB = null, fboSplash = null;
  let texBlurA = null, texBlurB = null, fboBlurA = null, fboBlurB = null;

  function allocTargets(w, h) {
    if (w === bufW && h === bufH) return;
    for (const t of [texScene, texSceneDepth, texHdrA, texBloomA, texWaterDepth, texHdrB, texBloomB, texBlurA, texBlurB]) {
      if (t) gl.deleteTexture(t);
    }
    for (const f of [fboBasin, fboWater, fboSplash, fboBlurA, fboBlurB]) {
      if (f) gl.deleteFramebuffer(f);
    }
    bufW = w; bufH = h;
    bw = Math.max(64, w >> 2);
    bh = Math.max(64, h >> 2);

    texScene = makeTex2D(gl, w, h, fmt.internalFmt, fmt.fmt, fmt.type, gl.LINEAR);
    texSceneDepth = makeTex2D(gl, w, h, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, gl.NEAREST);
    fboBasin = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fboBasin);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texScene, 0);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT1, gl.TEXTURE_2D, texSceneDepth, 0);
    gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1]);

    texHdrA = makeTex2D(gl, w, h, fmt.internalFmt, fmt.fmt, fmt.type, gl.LINEAR);
    texBloomA = makeTex2D(gl, w, h, fmt.internalFmt, fmt.fmt, fmt.type, gl.LINEAR);
    texWaterDepth = makeTex2D(gl, w, h, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, gl.NEAREST);
    fboWater = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fboWater);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texHdrA, 0);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT1, gl.TEXTURE_2D, texBloomA, 0);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT2, gl.TEXTURE_2D, texWaterDepth, 0);
    gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1, gl.COLOR_ATTACHMENT2]);

    texHdrB = makeTex2D(gl, w, h, fmt.internalFmt, fmt.fmt, fmt.type, gl.LINEAR);
    texBloomB = makeTex2D(gl, w, h, fmt.internalFmt, fmt.fmt, fmt.type, gl.LINEAR);
    fboSplash = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fboSplash);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texHdrB, 0);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT1, gl.TEXTURE_2D, texBloomB, 0);
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

  let simTime = 0, waveAcc = 0;
  let dropT = -1.0;
  let plungeFired = false, jetFired = false, bobFired = false;
  const dropLanded = new Uint8Array(DROP_COUNT);

  function triggerDrop() {
    dropT = 0.0;
    plungeFired = false;
    jetFired = false;
    bobFired = false;
    dropLanded.fill(0);
  }

  return {
    id: "water",
    maxPixels: 900000,
    defaultCamera: {
      yaw: 0.24,
      pitch: 0.44,
      dist: 7.8,
      lookY: -0.04,
      fovDeg: 38,
      minDist: 4.0,
      maxDist: 14.0,
      minPitch: 0.07,
      maxPitch: 1.25,
      autoOrbitSpeed: 0.0,
    },
    enterStep(stepIdx) {
      if (stepIdx === 7) triggerDrop();
    },
    triggerAction(actionId) {
      if (actionId === "drop") triggerDrop();
    },
    isActionActive(actionId) {
      if (actionId === "drop") return dropT >= 0.0 && dropT < 4.9;
      return false;
    },
    onCanvasClick(ndcX, ndcY, w, h, step, cam) {
      if (step.stage !== 7) return false;
      const aspect = w / Math.max(1, h);
      const portraitScale = aspect < 0.95 ? clamp(1.04 / Math.max(aspect, 0.54), 1.0, 1.56) : 1.0;
      const basis = cameraBasisFromOrbit(cam.yaw, cam.pitch, cam.dist * portraitScale, cam.lookY);
      const tanHalfFov = Math.tan(((cam.fovDeg * Math.PI) / 180) * 0.5);

      const rx = basis.fwd[0] + ndcX * aspect * tanHalfFov * basis.right[0] + ndcY * tanHalfFov * basis.up[0];
      const ry = basis.fwd[1] + ndcX * aspect * tanHalfFov * basis.right[1] + ndcY * tanHalfFov * basis.up[1];
      const rz = basis.fwd[2] + ndcX * aspect * tanHalfFov * basis.right[2] + ndcY * tanHalfFov * basis.up[2];
      if (ry >= -0.02) return false;

      const t = -basis.pos[1] / ry;
      if (t <= 0) return false;
      const wx = basis.pos[0] + rx * t;
      const wz = basis.pos[2] + rz * t;
      if (Math.hypot(wx, wz) < 1.38 && Math.hypot(wx - PILLAR_X, wz - PILLAR_Z) > PILLAR_R + 0.04) {
        sim.injectZeroSumRing(wx, wz, 0.22, 0.095, 0.52);
        return true;
      }
      return false;
    },
    update(dt, paused, step, split) {
      if (paused) return;
      simTime += dt;

      const sL = split.enabled ? step.compareLeft : step.stage;
      const sR = split.enabled ? step.compareRight : step.stage;
      if (sL !== 7 && sR !== 7) return;

      waveAcc += dt;
      let steps = 0;
      while (waveAcc >= SIM_DT && steps < 2) {
        waveAcc -= SIM_DT;
        const prevDropT = dropT;
        if (dropT >= 0.0) {
          dropT += SIM_DT;
          if (dropT > 5.4) dropT = -1.0;
        }
        const [cx, , cz] = getColliderPos(dropT);
        for (let s = 0; s < 4; s++) {
          const subT = prevDropT >= 0.0 ? prevDropT + ((s + 1) / 4) * SIM_DT : -1.0;
          if (subT >= 0.0) {
            if (!plungeFired && subT >= IMPACT_T) {
              plungeFired = true;
              sim.injectZeroSumRing(IMPACT_X, IMPACT_Z, 0.30, 0.135, 0.92);
            }
            if (!jetFired && subT >= IMPACT_T + 0.72) {
              jetFired = true;
              sim.injectZeroSumRing(IMPACT_X, IMPACT_Z, 0.24, 0.068, 0.45);
            }
            if (!bobFired && subT >= 1.55) {
              bobFired = true;
              sim.injectZeroSumRing(cx, cz, 0.26, -0.042, 0.28);
            }
            for (let d = 0; d < DROP_COUNT; d++) {
              if (DROP_META[d].isHero && !dropLanded[d] && subT >= DROP_META[d].landT) {
                dropLanded[d] = 1;
                const dm = DROP_META[d];
                if (Math.hypot(dm.landX, dm.landZ) < 1.28 && Math.hypot(dm.landX - PILLAR_X, dm.landZ - PILLAR_Z) > 0.26) {
                  sim.injectZeroSumRing(dm.landX, dm.landZ, 0.14, 0.026, 0.18);
                }
              }
            }
          }
          sim.stepSubstep();
        }
        steps++;
      }

      if (steps > 0) {
        gl.bindTexture(gl.TEXTURE_2D, texWave);
        gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, GW, GH, gl.RGBA, gl.UNSIGNED_BYTE, sim.packTexture());
      }
    },
    getTechBadge(stepIdx) {
      const tags = [
        "80×80 STATIC · 16 CLUT",
        "DUAL UV · SCANLINE WARP",
        "BEER–LAMBERT · EXP(-σd)",
        "SCHLICK FRESNEL · F0=0.02",
        "6-WAVE GERSTNER · FOAM",
        "IOR 1.333 · RGB CAUSTICS",
        "SPECTRAL · EMERALD SSS",
        "128×128 PDE · CLICK POOL",
      ];
      return tags[stepIdx] || "";
    },
    render(w, h, step, split, cam) {
      allocTargets(w, h);
      const aspect = w / Math.max(1, h);
      const portraitScale = aspect < 0.95 ? clamp(1.04 / Math.max(aspect, 0.54), 1.0, 1.56) : 1.0;
      const basis = cameraBasisFromOrbit(cam.yaw, cam.pitch, cam.dist * portraitScale, cam.lookY);
      const tanHalfFov = Math.tan(((cam.fovDeg * Math.PI) / 180) * 0.5);

      const stageLeft = split.enabled ? step.compareLeft : step.stage;
      const stageRight = split.enabled ? step.compareRight : step.stage;
      const wipeX = split.enabled ? split.pos : 0.0;
      const clutIndexOnly = split.enabled && step.clutSplit ? 1.0 : 0.0;

      const colliderActive = (stageLeft === 7 || stageRight === 7) && dropT >= 0.02 && dropT <= 4.85 ? 1.0 : 0.0;
      const colliderPos = getColliderPos(dropT);
      const splashTime = dropT >= 0.0 ? dropT - IMPACT_T : -1.0;
      const sphereWet = dropT >= 0.0 ? smoothstep(IMPACT_T - 0.02, IMPACT_T + 0.08, dropT) : 0.0;

      gl.bindVertexArray(vaoFull);
      gl.disable(gl.DEPTH_TEST);
      gl.disable(gl.BLEND);

      // Pass 1: Solid stone cistern, arch, lantern, pillar & plunging sphere
      gl.bindFramebuffer(gl.FRAMEBUFFER, fboBasin);
      gl.viewport(0, 0, bufW, bufH);
      gl.useProgram(progBasin);
      gl.uniform3fv(gl.getUniformLocation(progBasin, "uCamPos"), basis.pos);
      gl.uniform3fv(gl.getUniformLocation(progBasin, "uCamRight"), basis.right);
      gl.uniform3fv(gl.getUniformLocation(progBasin, "uCamUp"), basis.up);
      gl.uniform3fv(gl.getUniformLocation(progBasin, "uCamFwd"), basis.fwd);
      gl.uniform1f(gl.getUniformLocation(progBasin, "uTanHalfFov"), tanHalfFov);
      gl.uniform1f(gl.getUniformLocation(progBasin, "uAspect"), aspect);
      gl.uniform1f(gl.getUniformLocation(progBasin, "uTime"), simTime);
      gl.uniform3fv(gl.getUniformLocation(progBasin, "uColliderPos"), colliderPos);
      gl.uniform1f(gl.getUniformLocation(progBasin, "uColliderActive"), colliderActive);
      gl.uniform1f(gl.getUniformLocation(progBasin, "uSphereWet"), sphereWet);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

      // Pass 2: All 8 water eras
      gl.bindFramebuffer(gl.FRAMEBUFFER, fboWater);
      gl.viewport(0, 0, bufW, bufH);
      gl.useProgram(progWater);
      const wBinds = [
        ["uTexScene", texScene],
        ["uTexDepth", texSceneDepth],
        ["uTexPalIdx", texPalIdx],
        ["uTexTile", texTile],
        ["uTexWave", texWave],
      ];
      for (let i = 0; i < wBinds.length; i++) {
        gl.activeTexture(gl.TEXTURE0 + i);
        gl.bindTexture(gl.TEXTURE_2D, wBinds[i][1]);
        gl.uniform1i(gl.getUniformLocation(progWater, wBinds[i][0]), i);
      }
      gl.uniform3fv(gl.getUniformLocation(progWater, "uClut16"), CLUT_16_F32);
      gl.uniform3fv(gl.getUniformLocation(progWater, "uCamPos"), basis.pos);
      gl.uniform3fv(gl.getUniformLocation(progWater, "uCamRight"), basis.right);
      gl.uniform3fv(gl.getUniformLocation(progWater, "uCamUp"), basis.up);
      gl.uniform3fv(gl.getUniformLocation(progWater, "uCamFwd"), basis.fwd);
      gl.uniform1f(gl.getUniformLocation(progWater, "uTanHalfFov"), tanHalfFov);
      gl.uniform1f(gl.getUniformLocation(progWater, "uAspect"), aspect);
      gl.uniform1f(gl.getUniformLocation(progWater, "uTime"), simTime);
      gl.uniform1i(gl.getUniformLocation(progWater, "uStageLeft"), stageLeft);
      gl.uniform1i(gl.getUniformLocation(progWater, "uStageRight"), stageRight);
      gl.uniform1f(gl.getUniformLocation(progWater, "uWipeX"), wipeX);
      gl.uniform1f(gl.getUniformLocation(progWater, "uClutIndexOnly"), clutIndexOnly);
      gl.uniform3fv(gl.getUniformLocation(progWater, "uColliderPos"), colliderPos);
      gl.uniform1f(gl.getUniformLocation(progWater, "uColliderActive"), colliderActive);
      gl.uniform1f(gl.getUniformLocation(progWater, "uSplashTime"), splashTime);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

      // Pass 3: Optional Step 8 3D splash crown, Worthington jet & 24 droplets
      let hdrTex = texHdrA, bloomTex = texBloomA;
      if ((stageLeft === 7 || stageRight === 7) && splashTime > 0.0 && splashTime < 1.65) {
        gl.bindFramebuffer(gl.FRAMEBUFFER, fboSplash);
        gl.viewport(0, 0, bufW, bufH);
        gl.useProgram(progSplash);
        gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, texHdrA);
        gl.uniform1i(gl.getUniformLocation(progSplash, "uTexHdr"), 0);
        gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, texBloomA);
        gl.uniform1i(gl.getUniformLocation(progSplash, "uTexBloom"), 1);
        gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D, texWaterDepth);
        gl.uniform1i(gl.getUniformLocation(progSplash, "uTexDepth"), 2);
        gl.uniform3fv(gl.getUniformLocation(progSplash, "uCamPos"), basis.pos);
        gl.uniform3fv(gl.getUniformLocation(progSplash, "uCamRight"), basis.right);
        gl.uniform3fv(gl.getUniformLocation(progSplash, "uCamUp"), basis.up);
        gl.uniform3fv(gl.getUniformLocation(progSplash, "uCamFwd"), basis.fwd);
        gl.uniform1f(gl.getUniformLocation(progSplash, "uTanHalfFov"), tanHalfFov);
        gl.uniform1f(gl.getUniformLocation(progSplash, "uAspect"), aspect);
        gl.uniform1f(gl.getUniformLocation(progSplash, "uTime"), simTime);
        gl.uniform1i(gl.getUniformLocation(progSplash, "uStageLeft"), stageLeft);
        gl.uniform1i(gl.getUniformLocation(progSplash, "uStageRight"), stageRight);
        gl.uniform1f(gl.getUniformLocation(progSplash, "uWipeX"), wipeX);
        gl.uniform1f(gl.getUniformLocation(progSplash, "uSplashTime"), splashTime);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
        hdrTex = texHdrB;
        bloomTex = texBloomB;
      }

      // Pass 4: Separable Gaussian HDR bloom
      if (stageLeft >= 6 || stageRight >= 6) {
        gl.useProgram(progBlur);
        gl.viewport(0, 0, bw, bh);
        const uDir = gl.getUniformLocation(progBlur, "uDir");
        gl.uniform1i(gl.getUniformLocation(progBlur, "uTex"), 0);
        gl.activeTexture(gl.TEXTURE0);

        gl.bindFramebuffer(gl.FRAMEBUFFER, fboBlurA);
        gl.bindTexture(gl.TEXTURE_2D, bloomTex);
        gl.uniform2f(uDir, 1.0 / bw, 0.0);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

        gl.bindFramebuffer(gl.FRAMEBUFFER, fboBlurB);
        gl.bindTexture(gl.TEXTURE_2D, texBlurA);
        gl.uniform2f(uDir, 0.0, 1.0 / bh);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

        gl.bindFramebuffer(gl.FRAMEBUFFER, fboBlurA);
        gl.bindTexture(gl.TEXTURE_2D, texBlurB);
        gl.uniform2f(uDir, 2.0 / bw, 0.0);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

        gl.bindFramebuffer(gl.FRAMEBUFFER, fboBlurB);
        gl.bindTexture(gl.TEXTURE_2D, texBlurA);
        gl.uniform2f(uDir, 0.0, 2.0 / bh);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      }

      // Pass 5: ACES filmic tone map -> screen
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, bufW, bufH);
      gl.useProgram(progFinal);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, hdrTex);
      gl.uniform1i(gl.getUniformLocation(progFinal, "uTexHdr"), 0);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, texBlurB);
      gl.uniform1i(gl.getUniformLocation(progFinal, "uTexBloom"), 1);
      gl.uniform1i(gl.getUniformLocation(progFinal, "uStageLeft"), stageLeft);
      gl.uniform1i(gl.getUniformLocation(progFinal, "uStageRight"), stageRight);
      gl.uniform1f(gl.getUniformLocation(progFinal, "uWipeX"), wipeX);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      gl.bindVertexArray(null);
    },
  };
}
