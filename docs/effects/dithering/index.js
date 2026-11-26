// FX Lab #30: Evolution of Dithering & 1-Bit Stippling (1973–2026) — Interactive WebGL2 Controller
// Exports both createDitheringRenderer(gl) (shared 1:1 with the 9:16 & 16:9 film scenes) and
// createDitheringEffect(gl, { params }) (interactive FX Lab module).

import {
  clamp, cameraBasisFromOrbit, FULL_VS, linkPrograms, makeTex2D, hdrFormat,
} from "../../src/gl-utils.js";
import { BLUE_NOISE_SIZE, generateBlueNoise64, runErrorDiffusion } from "./bluenoise.js";
import { DITHER_SCENE_FS, DITHER_POST_FS } from "./shaders.js";

const PALETTE_NAMES = [
  "CREAM & OBSIDIAN",
  "1984 MACINTOSH B&W",
  "IBM GREEN CRT",
  "AMBER TERMINAL",
  "OBRA DINN PARCHMENT",
];

function makeMrtTarget(gl, w, h, surfFmt) {
  const texCol     = makeTex2D(gl, w, h, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, gl.NEAREST);
  const texLuma    = makeTex2D(gl, w, h, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, gl.NEAREST);
  const texSurf    = makeTex2D(gl, w, h, surfFmt.internalFmt, surfFmt.fmt, surfFmt.type, gl.NEAREST);
  const texStipple = makeTex2D(gl, w, h, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, gl.NEAREST);
  const texErrDiff = makeTex2D(gl, w, h, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, gl.NEAREST);

  const fbo = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texCol, 0);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT1, gl.TEXTURE_2D, texLuma, 0);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT2, gl.TEXTURE_2D, texSurf, 0);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT3, gl.TEXTURE_2D, texStipple, 0);
  gl.drawBuffers([
    gl.COLOR_ATTACHMENT0,
    gl.COLOR_ATTACHMENT1,
    gl.COLOR_ATTACHMENT2,
    gl.COLOR_ATTACHMENT3,
  ]);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);

  return {
    fbo, texCol, texLuma, texSurf, texStipple, texErrDiff, w, h,
    readBuf: new Uint8Array(w * h * 4),
    errBuf: new Uint8Array(w * h * 4),
  };
}

function disposeTarget(gl, t) {
  if (!t) return;
  gl.deleteTexture(t.texCol);
  gl.deleteTexture(t.texLuma);
  gl.deleteTexture(t.texSurf);
  gl.deleteTexture(t.texStipple);
  gl.deleteTexture(t.texErrDiff);
  gl.deleteFramebuffer(t.fbo);
}

// Reusable low-level WebGL2 renderer shared by FX Lab AND the 9:16 / 16:9 Short film scenes!
export function createDitheringRenderer(gl) {
  const surfFmt = hdrFormat(gl);
  const [progScene, progPost] = linkPrograms(gl, [
    [FULL_VS, DITHER_SCENE_FS],
    [FULL_VS, DITHER_POST_FS],
  ]);

  const uLoc = (p, names) => Object.fromEntries(names.map(n => [n, gl.getUniformLocation(p, n)]));
  const uS = uLoc(progScene, [
    "uCamPos", "uCamRight", "uCamUp", "uCamFwd", "uTanHalfFov", "uAspect", "uTime", "uLoopPeriod", "uRenderRes",
  ]);
  const uP = uLoc(progPost, [
    "uCol", "uLuma", "uSurf", "uStipple", "uErrDiff", "uBlueNoise",
    "uRes", "uGridRes", "uSplitX", "uStageLeft", "uStageRight", "uStageActive",
    "uPaletteIdx", "uBayer4On", "uCrtBlendOn", "uPs1DitherOn", "uSphereLockOn",
    "uCamRight", "uCamUp", "uCamFwd", "uTanHalfFov", "uAspect",
    "uLoupeTarget", "uLoupeOn", "uLoupeBox", "uDrawDivider",
  ]);

  const vao = gl.createVertexArray();

  // Generate deterministic 64x64 Ulichney Void-and-Cluster Blue Noise texture once
  const bnGray = generateBlueNoise64();
  const bnRgba = new Uint8Array(BLUE_NOISE_SIZE * BLUE_NOISE_SIZE * 4);
  for (let i = 0; i < bnGray.length; i++) {
    const v = bnGray[i];
    bnRgba[i * 4] = v;
    bnRgba[i * 4 + 1] = v;
    bnRgba[i * 4 + 2] = v;
    bnRgba[i * 4 + 3] = 255;
  }
  const texBlueNoise = makeTex2D(
    gl, BLUE_NOISE_SIZE, BLUE_NOISE_SIZE,
    gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, gl.NEAREST, bnRgba, gl.REPEAT,
  );

  let target = null;
  function ensureTarget(viewW, viewH, shortAxis = 336) {
    const aspect = viewW / Math.max(1, viewH);
    const dh = aspect >= 1.0
      ? Math.min(viewH, shortAxis)
      : Math.min(viewH, Math.round(shortAxis / Math.max(0.45, aspect)));
    const dw = Math.max(120, Math.round(dh * aspect));
    const rh = Math.max(120, Math.round(dh));
    if (target && target.w === dw && target.h === rh) return target;
    disposeTarget(gl, target);
    target = makeMrtTarget(gl, dw, rh, surfFmt);
    return target;
  }

  return {
    renderFrame(w, h, cam, stageL, stageR, splitX, opts = {}) {
      const tgt = ensureTarget(w, h, opts.gridShortAxis || 336);
      const aspect = w / Math.max(1, h);
      const fovRad = ((cam.fovDeg || 38) * Math.PI) / 180;
      const tanHalfFov = Math.tan(fovRad * 0.5);
      const basis = cameraBasisFromOrbit(
        cam.yaw,
        clamp(cam.pitch, -0.85, 0.85),
        cam.dist,
        cam.lookY ?? -0.05,
      );

      // Pass 1: Analytical 3D Ringed Gas Giant + Moon + Milky Way -> 4-attachment MRT FBO
      gl.bindFramebuffer(gl.FRAMEBUFFER, tgt.fbo);
      gl.viewport(0, 0, tgt.w, tgt.h);
      gl.disable(gl.DEPTH_TEST);
      gl.disable(gl.BLEND);
      gl.useProgram(progScene);
      gl.bindVertexArray(vao);
      gl.uniform3fv(uS.uCamPos, basis.pos);
      gl.uniform3fv(uS.uCamRight, basis.right);
      gl.uniform3fv(uS.uCamUp, basis.up);
      gl.uniform3fv(uS.uCamFwd, basis.fwd);
      gl.uniform1f(uS.uTanHalfFov, tanHalfFov);
      gl.uniform1f(uS.uAspect, aspect);
      gl.uniform1f(uS.uTime, opts.time ?? 0);
      gl.uniform1f(uS.uLoopPeriod, opts.loopPeriod ?? 0);
      gl.uniform2f(uS.uRenderRes, tgt.w, tgt.h);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

      // Live CPU Error Diffusion pass (ONLY when Floyd-Steinberg or Atkinson is visible!)
      const wantFS = (stageL === 2 || stageR === 2);
      const wantAtk = (stageL === 3 || stageR === 3);
      if (wantFS || wantAtk) {
        gl.readBuffer(gl.COLOR_ATTACHMENT1);
        gl.readPixels(0, 0, tgt.w, tgt.h, gl.RGBA, gl.UNSIGNED_BYTE, tgt.readBuf);
        runErrorDiffusion(tgt.readBuf, tgt.errBuf, tgt.w, tgt.h, {
          wantFS,
          wantAtk,
          serpentine: !!opts.serpentineOn,
        });
        gl.bindTexture(gl.TEXTURE_2D, tgt.texErrDiff);
        gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
        gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, tgt.w, tgt.h, gl.RGBA, gl.UNSIGNED_BYTE, tgt.errBuf);
      }

      // Pass 2: Full-viewport dithering compositor + optional split divider + 4x loupe
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, w, h);
      gl.disable(gl.DEPTH_TEST);
      gl.disable(gl.BLEND);
      gl.useProgram(progPost);
      gl.bindVertexArray(vao);

      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, tgt.texCol);     gl.uniform1i(uP.uCol, 0);
      gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, tgt.texLuma);    gl.uniform1i(uP.uLuma, 1);
      gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D, tgt.texSurf);    gl.uniform1i(uP.uSurf, 2);
      gl.activeTexture(gl.TEXTURE3); gl.bindTexture(gl.TEXTURE_2D, tgt.texStipple); gl.uniform1i(uP.uStipple, 3);
      gl.activeTexture(gl.TEXTURE4); gl.bindTexture(gl.TEXTURE_2D, tgt.texErrDiff); gl.uniform1i(uP.uErrDiff, 4);
      gl.activeTexture(gl.TEXTURE5); gl.bindTexture(gl.TEXTURE_2D, texBlueNoise);   gl.uniform1i(uP.uBlueNoise, 5);

      gl.uniform2f(uP.uRes, w, h);
      gl.uniform2f(uP.uGridRes, tgt.w, tgt.h);
      gl.uniform1f(uP.uSplitX, splitX);
      gl.uniform1i(uP.uStageLeft, stageL);
      gl.uniform1i(uP.uStageRight, stageR);
      gl.uniform1i(uP.uStageActive, opts.activeStage ?? stageR);

      gl.uniform1i(uP.uPaletteIdx, opts.paletteIdx ?? 0);
      gl.uniform1f(uP.uBayer4On, opts.bayer4On ? 1.0 : 0.0);
      gl.uniform1f(uP.uCrtBlendOn, opts.crtBlendOn ? 1.0 : 0.0);
      gl.uniform1f(uP.uPs1DitherOn, opts.ps1DitherOn ? 1.0 : 0.0);
      gl.uniform1f(uP.uSphereLockOn, opts.sphereLockOn ? 1.0 : 0.0);

      gl.uniform3fv(uP.uCamRight, basis.right);
      gl.uniform3fv(uP.uCamUp, basis.up);
      gl.uniform3fv(uP.uCamFwd, basis.fwd);
      gl.uniform1f(uP.uTanHalfFov, tanHalfFov);
      gl.uniform1f(uP.uAspect, aspect);

      const lt = opts.loupeTarget || [0.50, 0.65];
      const lb = opts.loupeBox || [0.0, 0.0, 0.0];
      gl.uniform2fv(uP.uLoupeTarget, lt);
      gl.uniform1f(uP.uLoupeOn, opts.loupeOn ? 1.0 : 0.0);
      gl.uniform3fv(uP.uLoupeBox, lb);
      gl.uniform1f(uP.uDrawDivider, opts.drawDivider === false ? 0.0 : 1.0);

      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      gl.bindVertexArray(null);
    },
  };
}

export function createDitheringEffect(gl, { params } = {}) {
  const core = createDitheringRenderer(gl);

  let simTime = 1.8;
  let paletteIdx = 0;
  let bayer4On = false;
  let serpentineOn = false;
  let crtBlendOn = true;
  let ps1DitherOn = true;
  let sphereLockOn = true;

  const defaultLoupe = [0.50, 0.65];
  let loupeTarget = [...defaultLoupe];
  let draggingLoupe = false;
  const loupeEnabled = params?.get("loupe") !== "0";

  return {
    id: "dithering",
    disableDblClickReset: true,
    maxPixels: 1100000,
    defaultCamera: {
      yaw: 0.24,
      pitch: 0.14,
      dist: 6.25,
      lookY: -0.05,
      fovDeg: 38,
      minDist: 2.9,
      maxDist: 10.5,
      minPitch: -0.85,
      maxPitch: 0.85,
      autoOrbitSpeed: 0.085,
    },

    enterStep(stepIdx) {
      if (stepIdx === 3 && paletteIdx === 0) paletteIdx = 1;
      else if (stepIdx === 6 && paletteIdx === 1) paletteIdx = 4;
      else if ((stepIdx === 0 || stepIdx === 7) && (paletteIdx === 1 || paletteIdx === 4)) paletteIdx = 0;
      if (stepIdx === 4) crtBlendOn = true;
      if (stepIdx === 5) ps1DitherOn = true;
      if (stepIdx === 6) sphereLockOn = true;
    },

    onReset() {
      simTime = 1.8;
      paletteIdx = 0;
      bayer4On = false;
      serpentineOn = false;
      crtBlendOn = true;
      ps1DitherOn = true;
      sphereLockOn = true;
      loupeTarget = [...defaultLoupe];
    },

    triggerAction(actionId) {
      if (actionId === "palette") paletteIdx = (paletteIdx + 1) % PALETTE_NAMES.length;
      else if (actionId === "bayer4") bayer4On = !bayer4On;
      else if (actionId === "serpentine") serpentineOn = !serpentineOn;
      else if (actionId === "crtBlend") crtBlendOn = !crtBlendOn;
      else if (actionId === "ps1Dither") ps1DitherOn = !ps1DitherOn;
      else if (actionId === "sphereLock") sphereLockOn = !sphereLockOn;
    },

    isActionActive(actionId) {
      if (actionId === "bayer4") return bayer4On;
      if (actionId === "serpentine") return serpentineOn;
      if (actionId === "crtBlend") return crtBlendOn;
      if (actionId === "ps1Dither") return ps1DitherOn;
      if (actionId === "sphereLock") return sphereLockOn;
      return false;
    },

    onPointerDown(ndcX, ndcY) {
      if (!loupeEnabled) return false;
      const uvX = ndcX * 0.5 + 0.5;
      const uvY = ndcY * 0.5 + 0.5;
      if (Math.hypot(uvX - loupeTarget[0], uvY - loupeTarget[1]) < 0.075) {
        draggingLoupe = true;
        return true;
      }
      return false;
    },

    onPointerMove(ndcX, ndcY) {
      if (!draggingLoupe) return;
      loupeTarget = [clamp(ndcX * 0.5 + 0.5, 0.06, 0.94), clamp(ndcY * 0.5 + 0.5, 0.08, 0.92)];
    },

    onPointerUp() { draggingLoupe = false; },

    onCanvasClick(ndcX, ndcY) {
      if (!loupeEnabled) return;
      loupeTarget = [clamp(ndcX * 0.5 + 0.5, 0.06, 0.94), clamp(ndcY * 0.5 + 0.5, 0.08, 0.92)];
    },

    getTechBadge(stepIdx) {
      const pal = PALETTE_NAMES[paletteIdx];
      return [
        `PRE-1973 · 1-BIT THRESHOLD · ${pal}`,
        `1973 · BAYER ${bayer4On ? "4×4" : "8×8"} ORDERED MATRIX`,
        `1976 · LIVE CPU FLOYD–STEINBERG${serpentineOn ? " (SERPENTINE)" : ""}`,
        `1984 · LIVE CPU MAC ATKINSON (6/8) · ${pal}`,
        crtBlendOn ? "1988–94 · STIPPLE ALPHA + CRT COMPOSITE" : "1988–94 · SHARP SCREEN-DOOR STIPPLE",
        ps1DitherOn ? "1994 · PS1 RGB555 + 4×4 HW DITHER" : "1994 · RAW RGB555 BANDING (NO DITHER!)",
        sphereLockOn ? "2018 · BLUE NOISE + OBRA DINN SPHERE-LOCK" : "1993 · SCREEN-SPACE BLUE NOISE (SWIMS!)",
        `2026 · 3D SURFACE-ANCHORED STIPPLING · ${pal}`,
      ][stepIdx] || "WEBGL2";
    },

    resize() {},

    update(dt, paused) {
      if (!paused) simTime += dt;
    },

    render(w, h, step, split, cam) {
      const stageLeft = split.enabled ? step.compareLeft : step.stage;
      const stageRight = split.enabled ? step.compareRight : step.stage;
      core.renderFrame(w, h, cam, stageLeft, stageRight, split.enabled ? split.pos : -1.0, {
        time: simTime,
        loopPeriod: 0,
        activeStage: step.stage,
        paletteIdx,
        bayer4On,
        serpentineOn,
        crtBlendOn,
        ps1DitherOn,
        sphereLockOn,
        loupeOn: loupeEnabled,
        loupeTarget,
        drawDivider: true,
      });
    },
  };
}
