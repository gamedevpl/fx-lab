// Evolution of Fire — WebGL2 renderer with lazy flipbook baking and live 30 Hz simulations.

import {
  clamp, cameraBasisFromOrbit, FULL_VS, linkPrograms, makeTex2D, hdrFormat,
} from "../../src/gl-utils.js";
import {
  CLUT_16_F32, DOOM_PAL_F32, PAL_W, PAL_H, DOOM_W, DOOM_H,
  SPR_W, SPR_H, SPR_N, NX, NY, NZ, FLIP_W, FLIP_H,
  buildClutIndexBuffer, createDoomFire, buildSpriteAtlas,
  createFluidSolver3D, getColliderPos,
} from "./simulations.js";
import { SCENE_FS, FIRE_FS, BLUR_FS, FINAL_FS } from "./shaders.js";

const STAGE_GI = [0.14, 0.28, 0.38, 0.65, 1.15, 0.42, 1.75, 1.70];
const SIM_DT = 1.0 / 30.0;

export function createFireEffect(gl) {
  const fmt = hdrFormat(gl);
  const [progScene, progFire, progBlur, progFinal] = linkPrograms(gl, [
    [FULL_VS, SCENE_FS],
    [FULL_VS, FIRE_FS],
    [FULL_VS, BLUR_FS],
    [FULL_VS, FINAL_FS],
  ]);
  const vaoFull = gl.createVertexArray();

  const doom = createDoomFire();
  const fluid = createFluidSolver3D();

  // Static & dynamic 2D textures (6-way flipbook textures start empty and bake lazily on Step 5).
  const texPalIdx = makeTex2D(gl, PAL_W, PAL_H, gl.R8, gl.RED, gl.UNSIGNED_BYTE, gl.NEAREST, buildClutIndexBuffer());
  const texDoom = makeTex2D(gl, DOOM_W, DOOM_H, gl.R8, gl.RED, gl.UNSIGNED_BYTE, gl.NEAREST, doom.buffer);
  const texSprite = makeTex2D(gl, SPR_W * SPR_N, SPR_H, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, gl.NEAREST, buildSpriteAtlas());

  const texFlipA = makeTex2D(gl, FLIP_W, FLIP_H, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, gl.LINEAR);
  const texFlipB = makeTex2D(gl, FLIP_W, FLIP_H, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, gl.LINEAR);
  const texFlipC = makeTex2D(gl, FLIP_W, FLIP_H, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, gl.LINEAR);
  let flipbookBaked = false;

  function ensureFlipbook() {
    if (flipbookBaked) return;
    flipbookBaked = true;
    const { dataA, dataB, dataC } = fluid.bakeSixWayFlipbook();
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.bindTexture(gl.TEXTURE_2D, texFlipA);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, FLIP_W, FLIP_H, gl.RGBA, gl.UNSIGNED_BYTE, dataA);
    gl.bindTexture(gl.TEXTURE_2D, texFlipB);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, FLIP_W, FLIP_H, gl.RGBA, gl.UNSIGNED_BYTE, dataB);
    gl.bindTexture(gl.TEXTURE_2D, texFlipC);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, FLIP_W, FLIP_H, gl.RGBA, gl.UNSIGNED_BYTE, dataC);
  }

  // Live 3D fluid volume texture (R = temp, G = smoke, B = speed).
  const texFluid3D = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_3D, texFluid3D);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  gl.texImage3D(gl.TEXTURE_3D, 0, gl.RGBA8, NX, NY, NZ, 0, gl.RGBA, gl.UNSIGNED_BYTE, fluid.texBuf);
  gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_R, gl.CLAMP_TO_EDGE);

  let bufW = 0, bufH = 0, bw = 0, bh = 0;
  let texSceneCol = null, texSceneDepth = null, fboScene = null;
  let texHdr = null, texBloomSrc = null, fboFire = null;
  let texBlurA = null, texBlurB = null, fboBlurA = null, fboBlurB = null;

  function allocTargets(w, h) {
    if (w === bufW && h === bufH) return;
    for (const t of [texSceneCol, texSceneDepth, texHdr, texBloomSrc, texBlurA, texBlurB]) if (t) gl.deleteTexture(t);
    for (const f of [fboScene, fboFire, fboBlurA, fboBlurB]) if (f) gl.deleteFramebuffer(f);
    bufW = w; bufH = h;
    bw = Math.max(64, w >> 2);
    bh = Math.max(64, h >> 2);

    texSceneCol = makeTex2D(gl, w, h, fmt.internalFmt, fmt.fmt, fmt.type, gl.LINEAR);
    texSceneDepth = makeTex2D(gl, w, h, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, gl.NEAREST);
    fboScene = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fboScene);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texSceneCol, 0);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT1, gl.TEXTURE_2D, texSceneDepth, 0);
    gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1]);

    texHdr = makeTex2D(gl, w, h, fmt.internalFmt, fmt.fmt, fmt.type, gl.LINEAR);
    texBloomSrc = makeTex2D(gl, w, h, fmt.internalFmt, fmt.fmt, fmt.type, gl.LINEAR);
    fboFire = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fboFire);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texHdr, 0);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT1, gl.TEXTURE_2D, texBloomSrc, 0);
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

  let simTime = 0, doomAcc = 0, fluidAcc = 0;
  let wireOn = false, wireBlend = 0;
  let voxelsOn = false, voxelsBlend = 0;
  let sweepT = -1.0;

  return {
    id: "fire",
    maxPixels: 900000,
    defaultCamera: {
      yaw: 0.22,
      pitch: 0.22,
      dist: 6.7,
      lookY: 0.80,
      fovDeg: 38,
      minDist: 3.6,
      maxDist: 12.0,
      minPitch: -0.18,
      maxPitch: 1.15,
      autoOrbitSpeed: 0.0,
    },
    enterStep(stepIdx) {
      if (stepIdx !== 2) wireOn = false;
      if (stepIdx !== 6) voxelsOn = false;
      if (stepIdx === 7) sweepT = 0.0;
    },
    triggerAction(actionId) {
      if (actionId === "wire") wireOn = !wireOn;
      else if (actionId === "voxels") voxelsOn = !voxelsOn;
      else if (actionId === "sweep") sweepT = 0.0;
    },
    isActionActive(actionId) {
      if (actionId === "wire") return wireOn;
      if (actionId === "voxels") return voxelsOn;
      if (actionId === "sweep") return sweepT >= 0.0 && sweepT <= 3.15;
      return false;
    },
    update(dt, paused, step, split) {
      wireBlend += ((wireOn ? 1 : 0) - wireBlend) * Math.min(1, dt * 8);
      voxelsBlend += ((voxelsOn ? 1 : 0) - voxelsBlend) * Math.min(1, dt * 8);
      if (paused) return;
      simTime += dt;

      const sL = split.enabled ? step.compareLeft : step.stage;
      const sR = split.enabled ? step.compareRight : step.stage;

      if (sL === 1 || sR === 1) {
        doom.ensureWarmed();
        doomAcc += dt;
        let n = 0;
        while (doomAcc >= SIM_DT && n < 2) {
          doomAcc -= SIM_DT;
          doom.step();
          n++;
        }
        if (n > 0) {
          gl.bindTexture(gl.TEXTURE_2D, texDoom);
          gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, DOOM_W, DOOM_H, gl.RED, gl.UNSIGNED_BYTE, doom.buffer);
        }
      }

      if (sL === 4 || sR === 4) ensureFlipbook();

      if (sL === 7 || sR === 7) {
        if (sweepT >= 0.0) {
          sweepT += dt;
          if (sweepT > 3.35) sweepT = -1.0;
        }
        fluidAcc += dt;
        let n = 0;
        while (fluidAcc >= SIM_DT && n < 2) {
          fluidAcc -= SIM_DT;
          fluid.step(getColliderPos(sweepT));
          n++;
        }
        if (n > 0) {
          gl.bindTexture(gl.TEXTURE_3D, texFluid3D);
          gl.texSubImage3D(gl.TEXTURE_3D, 0, 0, 0, 0, NX, NY, NZ, gl.RGBA, gl.UNSIGNED_BYTE, fluid.packTexture3D());
        }
      }
    },
    getTechBadge(stepIdx) {
      const tags = [
        "64×80 STATIC · 16 CLUT",
        "96×112 · LIVE 30 HZ",
        "ADDITIVE QUAD · HARD CLIP",
        "DEPTH FADE + REFRACT",
        "OPTICAL FLOW · 6-WAY LIT",
        "44 STEPS · BEER–LAMBERT",
        "SPARSE GRID · SHADOW MARCH",
        "NAVIER–STOKES · 24×36×24",
      ];
      return tags[stepIdx] || "";
    },
    render(w, h, step, split, cam) {
      allocTargets(w, h);
      const stageLeft = split.enabled ? step.compareLeft : step.stage;
      const stageRight = split.enabled ? step.compareRight : step.stage;
      if (stageLeft === 4 || stageRight === 4) ensureFlipbook();
      if (stageLeft === 1 || stageRight === 1) {
        doom.ensureWarmed();
        gl.bindTexture(gl.TEXTURE_2D, texDoom);
        gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, DOOM_W, DOOM_H, gl.RED, gl.UNSIGNED_BYTE, doom.buffer);
      }

      const aspect = w / Math.max(1, h);
      const portraitScale = aspect < 0.95 ? clamp(1.02 / Math.max(aspect, 0.54), 1.0, 1.48) : 1.0;
      const basis = cameraBasisFromOrbit(cam.yaw, cam.pitch, cam.dist * portraitScale, cam.lookY);
      const tanHalfFov = Math.tan(((cam.fovDeg * Math.PI) / 180) * 0.5);

      const wipeX = split.enabled ? split.pos : 0.0;
      const clutIndexOnly = split.enabled && step.clutSplit ? 1.0 : 0.0;
      const flicker = 0.88 + 0.12 * Math.sin(simTime * 13.7) + 0.07 * Math.cos(simTime * 29.3);
      const fireCol = [1.0, 0.44 + 0.06 * Math.sin(simTime * 17.0), 0.11];
      const giL = (clutIndexOnly > 0.5 ? 0.06 : STAGE_GI[stageLeft]) * flicker;
      const giR = STAGE_GI[stageRight] * flicker;
      const colliderActive = (stageLeft === 7 || stageRight === 7) && sweepT >= 0.0 && sweepT <= 3.15 ? 1.0 : 0.0;

      gl.bindVertexArray(vaoFull);
      gl.disable(gl.DEPTH_TEST);
      gl.disable(gl.BLEND);

      // Pass 1: Courtyard SDF + split GI
      gl.bindFramebuffer(gl.FRAMEBUFFER, fboScene);
      gl.viewport(0, 0, bufW, bufH);
      gl.useProgram(progScene);
      gl.uniform3fv(gl.getUniformLocation(progScene, "uCamPos"), basis.pos);
      gl.uniform3fv(gl.getUniformLocation(progScene, "uCamRight"), basis.right);
      gl.uniform3fv(gl.getUniformLocation(progScene, "uCamUp"), basis.up);
      gl.uniform3fv(gl.getUniformLocation(progScene, "uCamFwd"), basis.fwd);
      gl.uniform1f(gl.getUniformLocation(progScene, "uTanHalfFov"), tanHalfFov);
      gl.uniform1f(gl.getUniformLocation(progScene, "uAspect"), aspect);
      gl.uniform1f(gl.getUniformLocation(progScene, "uTime"), simTime);
      gl.uniform1f(gl.getUniformLocation(progScene, "uFireIntensityLeft"), giL);
      gl.uniform1f(gl.getUniformLocation(progScene, "uFireIntensityRight"), giR);
      gl.uniform1f(gl.getUniformLocation(progScene, "uWipeX"), wipeX);
      gl.uniform3fv(gl.getUniformLocation(progScene, "uFireColor"), fireCol);
      gl.uniform3fv(gl.getUniformLocation(progScene, "uColliderPos"), getColliderPos(sweepT));
      gl.uniform1f(gl.getUniformLocation(progScene, "uColliderActive"), colliderActive);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

      // Pass 2: Fire stages + bloom extraction
      gl.bindFramebuffer(gl.FRAMEBUFFER, fboFire);
      gl.viewport(0, 0, bufW, bufH);
      gl.useProgram(progFire);
      const texBinds = [
        ["uTexScene", texSceneCol, gl.TEXTURE_2D],
        ["uTexDepth", texSceneDepth, gl.TEXTURE_2D],
        ["uTexPalIdx", texPalIdx, gl.TEXTURE_2D],
        ["uTexDoom", texDoom, gl.TEXTURE_2D],
        ["uTexSprite", texSprite, gl.TEXTURE_2D],
        ["uTexFlipA", texFlipA, gl.TEXTURE_2D],
        ["uTexFlipB", texFlipB, gl.TEXTURE_2D],
        ["uTexFlipC", texFlipC, gl.TEXTURE_2D],
        ["uTexFluid3D", texFluid3D, gl.TEXTURE_3D],
      ];
      for (let i = 0; i < texBinds.length; i++) {
        gl.activeTexture(gl.TEXTURE0 + i);
        gl.bindTexture(texBinds[i][2], texBinds[i][1]);
        gl.uniform1i(gl.getUniformLocation(progFire, texBinds[i][0]), i);
      }
      gl.uniform3fv(gl.getUniformLocation(progFire, "uClut16"), CLUT_16_F32);
      gl.uniform3fv(gl.getUniformLocation(progFire, "uDoomPal"), DOOM_PAL_F32);
      gl.uniform3fv(gl.getUniformLocation(progFire, "uCamPos"), basis.pos);
      gl.uniform3fv(gl.getUniformLocation(progFire, "uCamRight"), basis.right);
      gl.uniform3fv(gl.getUniformLocation(progFire, "uCamUp"), basis.up);
      gl.uniform3fv(gl.getUniformLocation(progFire, "uCamFwd"), basis.fwd);
      gl.uniform1f(gl.getUniformLocation(progFire, "uTanHalfFov"), tanHalfFov);
      gl.uniform1f(gl.getUniformLocation(progFire, "uAspect"), aspect);
      gl.uniform1f(gl.getUniformLocation(progFire, "uTime"), simTime);
      gl.uniform1i(gl.getUniformLocation(progFire, "uStageLeft"), stageLeft);
      gl.uniform1i(gl.getUniformLocation(progFire, "uStageRight"), stageRight);
      gl.uniform1f(gl.getUniformLocation(progFire, "uWipeX"), wipeX);
      gl.uniform1f(gl.getUniformLocation(progFire, "uClutIndexOnly"), clutIndexOnly);
      gl.uniform1f(gl.getUniformLocation(progFire, "uQuadWire"), wireBlend);
      gl.uniform1f(gl.getUniformLocation(progFire, "uSparseGridFlash"), voxelsBlend);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

      // Pass 3: Separable Gaussian HDR bloom
      if (stageLeft >= 4 || stageRight >= 4) {
        gl.useProgram(progBlur);
        gl.viewport(0, 0, bw, bh);
        const uDir = gl.getUniformLocation(progBlur, "uDir");
        gl.uniform1i(gl.getUniformLocation(progBlur, "uTex"), 0);
        gl.activeTexture(gl.TEXTURE0);

        gl.bindFramebuffer(gl.FRAMEBUFFER, fboBlurA);
        gl.bindTexture(gl.TEXTURE_2D, texBloomSrc);
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

      // Pass 4: Unified ACES tone map -> screen
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, bufW, bufH);
      gl.useProgram(progFinal);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, texHdr);
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
