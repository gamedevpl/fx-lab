// Evolution of Fog & Volumetric Lighting (1997-2026) — Interactive WebGL2 Cathedral Hall Lab:
//   0: 1997 Distance Depth Fog (Turok 1997 / Silent Hill 1999; OpenGL 1.0 fog 1992 — hides short far clip!)
//   1: 2002 Analytical Aerial Perspective (Hoffman & Preetham, GDC 2002 / SIGGRAPH 2003 — Rayleigh + Mie scattering)
//   2: 2004 Shadow-Map / Slice Light Shafts (Dobashi '02 / James '03 / ATI GDC '04 — pre-2007 3D slices, coarse stepping)
//   3: 2007 Screen-Space Light Scattering (Kenny Mitchell, GPU Gems 3 Ch. 13 — real radial blur; fades out when looking away!)
//   4: 2009 Raymarched Volumetric Shadows (Tóth & Umenhoffer, Eurographics 2009 — 3D shadow march + interleaved jitter)
//   5: 2014 Temporal Froxel Volumetric Fog (Bart Wronski, SIGGRAPH 2014 / AC IV — 160x90x64 froxels, WebGL2 emulated!)
//   6: 2015 Heterogeneous Media & Local Lights (Sébastien Hillaire / Frostbite, SIGGRAPH 2015 — swirling mist + colored lamps)
//   7: 2020-26 Multi-Scattering & Stained-Glass Volumetrics (Hillaire, EGSR 2020 -> modern engines — rainbow sunbeams!)

import {
  clamp, norm3, cameraBasisFromOrbit,
  FULL_VS, linkPrograms, makeTex2D, hdrFormat,
} from "../../src/gl-utils.js";
import { SCENE_FS, VOL_FS, FINAL_FS } from "./shaders.js";

const WIN_CENTER = [-0.25, 2.38, -4.20];

export function createFogEffect(gl) {
  const fmt = hdrFormat(gl);
  const [progScene, progVol, progFinal] = linkPrograms(gl, [
    [FULL_VS, SCENE_FS],
    [FULL_VS, VOL_FS],
    [FULL_VS, FINAL_FS],
  ]);

  const uLoc = (p, names) => Object.fromEntries(names.map(n => [n, gl.getUniformLocation(p, n)]));
  const uScene = uLoc(progScene, [
    "uCamPos", "uCamRight", "uCamUp", "uCamFwd",
    "uTanHalfFov", "uAspect", "uTime", "uSunDir",
    "uStageLeft", "uStageRight", "uSplitX", "uNoFogLeft",
  ]);
  const uVol = uLoc(progVol, [
    "uSceneCol", "uSceneMask",
    "uCamPos", "uCamRight", "uCamUp", "uCamFwd",
    "uTanHalfFov", "uAspect", "uRes", "uTime", "uSunDir",
    "uSunScreenUv", "uSunVisFade",
    "uStageLeft", "uStageRight", "uSplitX", "uNoFogLeft",
    "uInterleaved", "uShowFroxels",
  ]);
  const uFinal = uLoc(progFinal, ["uSrc", "uTexel"]);

  const vaoEmpty = gl.createVertexArray();

  let bufW = 0, bufH = 0;
  let texCol = null, texMask = null, fboScene = null;
  let texVol = null, fboVol = null;

  function allocTargets(w, h) {
    if (w === bufW && h === bufH) return;
    for (const t of [texCol, texMask, texVol]) if (t) gl.deleteTexture(t);
    for (const f of [fboScene, fboVol]) if (f) gl.deleteFramebuffer(f);
    bufW = w; bufH = h;

    texCol = makeTex2D(gl, w, h, fmt.internalFmt, fmt.fmt, fmt.type, gl.LINEAR);
    texMask = makeTex2D(gl, w, h, fmt.internalFmt, fmt.fmt, fmt.type, gl.LINEAR);
    fboScene = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fboScene);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texCol, 0);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT1, gl.TEXTURE_2D, texMask, 0);
    gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1]);

    texVol = makeTex2D(gl, w, h, fmt.internalFmt, fmt.fmt, fmt.type, gl.LINEAR);
    fboVol = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fboVol);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texVol, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  let simTime = 0;
  let lookAway = false;       // Smoothly pans camera away from the rose window -> exposes 2007 Mitchell fade-out vs 3D volumetrics!
  let lookAwayAmt = 0.0;
  let interleavedOn = true;   // Stage 4 (2009 Tóth & Umenhoffer): toggle interleaved jitter vs raw step banding!
  let showFroxels = false;    // Stage 5 (2014 Wronski): toggle frustum froxel grid visualization!
  let customSun = null;       // [dx, dy] from clicking viewport

  function currentSunDir() {
    if (customSun) return norm3(customSun[0], customSun[1], -0.92);
    // Angled back-left -> diagonal sunbeams sweep majestically across the center altar & right nave!
    return norm3(-0.34 + Math.sin(simTime * 0.42) * 0.14, 0.32 + Math.cos(simTime * 0.42) * 0.05, -0.88);
  }

  // Project rose window sun origin into screen UV & compute smooth GPU Gems 3 Ch. 13 visibility fade!
  function projectSunScreen(basis, aspect, tanHalfFov) {
    const dx = WIN_CENTER[0] - basis.pos[0];
    const dy = WIN_CENTER[1] - basis.pos[1];
    const dz = WIN_CENTER[2] - basis.pos[2];
    const z = dx * basis.fwd[0] + dy * basis.fwd[1] + dz * basis.fwd[2];
    if (z <= 0.15) return { uv: [0.5, 0.5], fade: 0.0 };
    const x = (dx * basis.right[0] + dy * basis.right[1] + dz * basis.right[2]) / (z * aspect * tanHalfFov);
    const y = (dx * basis.up[0] + dy * basis.up[1] + dz * basis.up[2]) / (z * tanHalfFov);
    const u = x * 0.5 + 0.5;
    const v = y * 0.5 + 0.5;
    // Smooth edge & angular decay recommended by Kenny Mitchell (GPU Gems 3 Ch. 13)
    const distOff = Math.max(Math.abs(x), Math.abs(y));
    const edgeFade = 1.0 - clamp((distOff - 0.55) / 0.65, 0.0, 1.0);
    const smoothFade = edgeFade * edgeFade * (3.0 - 2.0 * edgeFade);
    return { uv: [clamp(u, -0.35, 1.35), clamp(v, -0.35, 1.35)], fade: smoothFade };
  }

  return {
    id: "fog",
    maxPixels: 540000,
    defaultCamera: {
      yaw: 0.06,
      pitch: 0.06,
      dist: 4.15,
      lookY: 1.55,
      fovDeg: 48,
      minDist: 2.2,
      maxDist: 5.2,
      minPitch: -0.18,
      maxPitch: 0.45,
      autoOrbitSpeed: 0.0,
    },
    enterStep(stepIdx) {
      if (stepIdx !== 3 && stepIdx !== 5 && stepIdx !== 7) lookAway = false;
      if (stepIdx !== 4) interleavedOn = true;
      if (stepIdx !== 5) showFroxels = false;
    },
    onReset() {
      lookAway = false;
      lookAwayAmt = 0.0;
      interleavedOn = true;
      showFroxels = false;
      customSun = null;
    },
    triggerAction(actionId) {
      if (actionId === "lookAway") lookAway = !lookAway;
      else if (actionId === "interleaved") interleavedOn = !interleavedOn;
      else if (actionId === "froxels") showFroxels = !showFroxels;
    },
    isActionActive(actionId) {
      if (actionId === "lookAway") return lookAway;
      if (actionId === "interleaved") return interleavedOn;
      if (actionId === "froxels") return showFroxels;
      return false;
    },
    onCanvasClick(ndcX, ndcY) {
      // Aim the sunbeam angle passing through the gothic rose window!
      customSun = [clamp(-ndcX * 0.52, -0.48, 0.48), clamp(0.18 + (ndcY + 1.0) * 0.24, 0.14, 0.62)];
    },
    getTechBadge(stepIdx) {
      return [
        "1997 · TUROK / SILENT HILL FOG",
        "2002 · HOFFMAN & PREETHAM",
        "2004 · SHADOW-MAP SLICES",
        lookAway ? "2007 · MITCHELL (FADES OUT!)" : "2007 · MITCHELL SCREEN-SPACE",
        interleavedOn ? "2009 · TÓTH INTERLEAVED 3D" : "2009 · RAW BANDING (18 STEPS)",
        showFroxels ? "2014 · FROXEL GRID (EMULATED)" : "2014 · WRONSKI FROXEL FOG",
        "2015 · HILLAIRE / FROSTBITE",
        lookAway ? "2020–26 · 3D SHAFTS INTACT!" : "2020–26 · MULTI-SCATTER + GLASS",
      ][stepIdx] || "WEBGL2";
    },
    resize(w, h) {
      allocTargets(w, h);
    },
    update(dt, paused) {
      const targetLook = lookAway ? 1.0 : 0.0;
      lookAwayAmt += (targetLook - lookAwayAmt) * Math.min(1.0, dt * 4.5);
      if (!paused) simTime += dt;
    },
    render(w, h, step, split, cam) {
      allocTargets(w, h);
      const aspect = w / Math.max(1, h);
      // Look Away smoothly pans the camera head right (~54 deg) so the rose window exits off the left edge of the screen!
      const baseBasis = cameraBasisFromOrbit(cam.yaw, cam.pitch, cam.dist, cam.lookY);
      let basis = baseBasis;
      if (lookAwayAmt > 0.001) {
        // Pan smoothly right (~38 deg) so the rose window exits left edge -> 2007 fades out, 3D diagonal shafts blaze right across the hall!
        const pan = lookAwayAmt * 0.66;
        const cp = Math.cos(pan), sp = Math.sin(pan);
        const f = norm3(
          baseBasis.fwd[0] * cp + baseBasis.right[0] * sp,
          baseBasis.fwd[1] * cp + baseBasis.right[1] * sp,
          baseBasis.fwd[2] * cp + baseBasis.right[2] * sp
        );
        const r = norm3(
          baseBasis.right[0] * cp - baseBasis.fwd[0] * sp,
          baseBasis.right[1] * cp - baseBasis.fwd[1] * sp,
          baseBasis.right[2] * cp - baseBasis.fwd[2] * sp
        );
        basis = { pos: baseBasis.pos, target: baseBasis.target, fwd: f, right: r, up: baseBasis.up };
      }

      const tanHalfFov = Math.tan(((cam.fovDeg * Math.PI) / 180) * 0.5);
      const sunDir = currentSunDir();
      const sunProj = projectSunScreen(basis, aspect, tanHalfFov);

      const stageLeft = split.enabled ? step.compareLeft : step.stage;
      const stageRight = split.enabled ? step.compareRight : step.stage;
      const splitX = split.enabled ? split.pos : 0.0;
      const noFogLeft = split.enabled && !!step.noFogSplit ? 1.0 : 0.0;

      gl.disable(gl.DEPTH_TEST);
      gl.disable(gl.BLEND);
      gl.disable(gl.CULL_FACE);
      gl.bindVertexArray(vaoEmpty);

      // PASS 1: Gothic Cathedral Hall + Depth & Window Occlusion Mask
      gl.bindFramebuffer(gl.FRAMEBUFFER, fboScene);
      gl.viewport(0, 0, w, h);
      gl.useProgram(progScene);
      gl.uniform3fv(uScene.uCamPos, basis.pos);
      gl.uniform3fv(uScene.uCamRight, basis.right);
      gl.uniform3fv(uScene.uCamUp, basis.up);
      gl.uniform3fv(uScene.uCamFwd, basis.fwd);
      gl.uniform1f(uScene.uTanHalfFov, tanHalfFov);
      gl.uniform1f(uScene.uAspect, aspect);
      gl.uniform1f(uScene.uTime, simTime);
      gl.uniform3fv(uScene.uSunDir, sunDir);
      gl.uniform1i(uScene.uStageLeft, stageLeft);
      gl.uniform1i(uScene.uStageRight, stageRight);
      gl.uniform1f(uScene.uSplitX, splitX);
      gl.uniform1f(uScene.uNoFogLeft, noFogLeft);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

      // PASS 2: Evaluate Fog / Volumetric Lighting Era (0..7)
      gl.bindFramebuffer(gl.FRAMEBUFFER, fboVol);
      gl.viewport(0, 0, w, h);
      gl.useProgram(progVol);
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, texCol);
      gl.uniform1i(uVol.uSceneCol, 0);
      gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, texMask);
      gl.uniform1i(uVol.uSceneMask, 1);
      gl.uniform3fv(uVol.uCamPos, basis.pos);
      gl.uniform3fv(uVol.uCamRight, basis.right);
      gl.uniform3fv(uVol.uCamUp, basis.up);
      gl.uniform3fv(uVol.uCamFwd, basis.fwd);
      gl.uniform1f(uVol.uTanHalfFov, tanHalfFov);
      gl.uniform1f(uVol.uAspect, aspect);
      gl.uniform2f(uVol.uRes, w, h);
      gl.uniform1f(uVol.uTime, simTime);
      gl.uniform3fv(uVol.uSunDir, sunDir);
      gl.uniform2fv(uVol.uSunScreenUv, sunProj.uv);
      gl.uniform1f(uVol.uSunVisFade, sunProj.fade);
      gl.uniform1i(uVol.uStageLeft, stageLeft);
      gl.uniform1i(uVol.uStageRight, stageRight);
      gl.uniform1f(uVol.uSplitX, splitX);
      gl.uniform1f(uVol.uNoFogLeft, noFogLeft);
      gl.uniform1f(uVol.uInterleaved, interleavedOn ? 1.0 : 0.0);
      gl.uniform1f(uVol.uShowFroxels, showFroxels ? 1.0 : 0.0);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

      // PASS 3: Atmospheric Bloom + ACES Tone-Mapping
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, w, h);
      gl.useProgram(progFinal);
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, texVol);
      gl.uniform1i(uFinal.uSrc, 0);
      gl.uniform2f(uFinal.uTexel, 1.0 / w, 1.0 / h);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    },
  };
}
