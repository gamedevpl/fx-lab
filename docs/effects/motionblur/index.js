// Evolution of Motion Blur (1999-2024) — Interactive 4-Pass RGBA16F WebGL2 Controller.
// Genuine Per-Object + Camera Velocity Buffer, McGuire (I3D 2012) TileMax & 3x3 NeighborMax,
// Guertin/McGuire (HPG 2014) Soft-Z Depth Reconstruction, Curved Rotational Arc Blur, and 1999 Frame-Trails Ping-Pong!

import { clamp, cameraBasisFromOrbit, makeLookAt, makePerspective, FULL_VS, linkPrograms } from "../../src/gl-utils.js";
import { MB_SCENE_FS, MB_TILEMAX_FS, MB_NEIGHBORMAX_FS, MB_RESOLVE_FS, MB_ACCUM_FS } from "./shaders.js";

function mulMat4(a, b) {
  const o = new Float32Array(16);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      o[c*4 + r] = a[r]*b[c*4] + a[4+r]*b[c*4+1] + a[8+r]*b[c*4+2] + a[12+r]*b[c*4+3];
    }
  }
  return o;
}

function projectPointUv(vp, p) {
  const x = vp[0]*p[0] + vp[4]*p[1] + vp[8]*p[2] + vp[12];
  const y = vp[1]*p[0] + vp[5]*p[1] + vp[9]*p[2] + vp[13];
  const w = vp[3]*p[0] + vp[7]*p[1] + vp[11]*p[2] + vp[15];
  if (Math.abs(w) < 1e-4) return [0.5, 0.5];
  return [x / w * 0.5 + 0.5, y / w * 0.5 + 0.5];
}

function makeTex(gl, w, h, useFloat, nearest = false) {
  const t = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, t);
  gl.texImage2D(
    gl.TEXTURE_2D, 0,
    useFloat ? gl.RGBA16F : gl.RGBA8,
    w, h, 0, gl.RGBA,
    useFloat ? gl.HALF_FLOAT : gl.UNSIGNED_BYTE,
    null
  );
  const f = nearest ? gl.NEAREST : gl.LINEAR;
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, f);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, f);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  return t;
}

export function createMotionblurEffect(gl) {
  const hasFloat = !!(gl.getExtension("EXT_color_buffer_float") || gl.getExtension("EXT_color_buffer_half_float"));
  gl.getExtension("OES_texture_float_linear");
  gl.getExtension("OES_texture_half_float_linear");

  const [progScene, progTile, progNeigh, progResolve, progAccum] = linkPrograms(gl, [
    [FULL_VS, MB_SCENE_FS],
    [FULL_VS, MB_TILEMAX_FS],
    [FULL_VS, MB_NEIGHBORMAX_FS],
    [FULL_VS, MB_RESOLVE_FS],
    [FULL_VS, MB_ACCUM_FS],
  ]);

  const uLoc = (p, names) => Object.fromEntries(names.map(n => [n, gl.getUniformLocation(p, n)]));
  const uScene = uLoc(progScene, ["uCamPos", "uCamRight", "uCamUp", "uCamFwd", "uTanHalfFov", "uAspect", "uCurrVP", "uPrevVP", "uTime", "uPrevTime", "uShutterScale", "uStageLeft", "uStageRight", "uSplitX"]);
  const uTile  = uLoc(progTile,  ["uVelTex", "uTexelSize"]);
  const uNeigh = uLoc(progNeigh, ["uTileTex", "uTileTexel"]);
  const uRes   = uLoc(progResolve, ["uColorTex", "uVelTex", "uNeighTex", "uAccumTex", "uStageLeft", "uStageRight", "uSplitX", "uShowVelocity", "uHubUv", "uAspect", "uTime"]);
  const uAcc   = uLoc(progAccum, ["uCurrTex", "uPrevAccumTex", "uBlend"]);
  const vao = gl.createVertexArray();

  let bufW = 0, bufH = 0, tileW = 0, tileH = 0;
  let fboScene = null, texColor = null, texVel = null;
  let fboTile = null, texTile = null, fboNeigh = null, texNeigh = null;
  let fboAcc = [null, null], texAcc = [null, null], accIdx = 0, accPrimed = false;

  function allocTargets(w, h) {
    if (w === bufW && h === bufH) return;
    for (const f of [fboScene, fboTile, fboNeigh, fboAcc[0], fboAcc[1]]) if (f) gl.deleteFramebuffer(f);
    for (const t of [texColor, texVel, texTile, texNeigh, texAcc[0], texAcc[1]]) if (t) gl.deleteTexture(t);
    bufW = w; bufH = h;
    tileW = Math.max(8, Math.ceil(w / 16));
    tileH = Math.max(8, Math.ceil(h / 16));

    texColor = makeTex(gl, w, h, hasFloat, false);
    texVel   = makeTex(gl, w, h, hasFloat, true);
    fboScene = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fboScene);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texColor, 0);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT1, gl.TEXTURE_2D, texVel, 0);
    gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1]);

    texTile = makeTex(gl, tileW, tileH, hasFloat, true);
    fboTile = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fboTile);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texTile, 0);

    texNeigh = makeTex(gl, tileW, tileH, hasFloat, true);
    fboNeigh = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fboNeigh);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texNeigh, 0);

    for (let i = 0; i < 2; i++) {
      texAcc[i] = makeTex(gl, w, h, hasFloat, false);
      fboAcc[i] = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, fboAcc[i]);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texAcc[i], 0);
    }
    accPrimed = false;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  let simTime = 1.15;
  let prevSimTime = 1.15 - (1 / 60);
  let showVelocity = false;
  let strobe30 = false;
  let strobeAccum = 0;
  let boostTimer = 0;
  let prevVP = null;

  return {
    id: "motionblur",
    maxPixels: 520000,
    defaultCamera: {
      yaw: 0.08,
      pitch: 0.14,
      dist: 4.55,
      lookY: 1.08,
      fovDeg: 44,
      minDist: 2.2,
      maxDist: 7.2,
      minPitch: -0.05,
      maxPitch: 0.72,
      autoOrbitSpeed: 0.0,
    },

    enterStep() {
      accPrimed = false;
    },

    onReset() {
      showVelocity = false;
      strobe30 = false;
      boostTimer = 0;
      accPrimed = false;
    },

    triggerAction(actionId) {
      if (actionId === "velocity") showVelocity = !showVelocity;
      else if (actionId === "strobe") strobe30 = !strobe30;
      else if (actionId === "boost") boostTimer = 2.6;
    },

    isActionActive(actionId) {
      if (actionId === "velocity") return showVelocity;
      if (actionId === "strobe") return strobe30;
      if (actionId === "boost") return boostTimer > 0;
      return false;
    },

    onCanvasClick() {
      boostTimer = 2.6; // Click anywhere to trigger a 2x turbine + drone speed burst!
    },

    getTechBadge(stepIdx) {
      const labels = [
        "1999 · GTA III FRAME BLENDING TRAILS",
        "2004 · CAMERA-ONLY BLUR (NAUSEA SMEAR!)",
        "2007 · PER-OBJECT VELOCITY (SILHOUETTE CLIP)",
        "2012 · MCGUIRE TILEMAX + NEIGHBORMAX",
        "2014 · SOFT-Z DEPTH RECONSTRUCTION",
        "2016 · CURVED ROTATIONAL ARC BLUR",
        "2019 · 180° CINEMA SHUTTER EXPOSURE",
        "2024 · MULTI-SAMPLE + ARC + SOFT-Z",
      ];
      return showVelocity ? "LIVE 2D SCREEN-SPACE VELOCITY BUFFER (RG)" : (labels[stepIdx] || "MOTION BLUR");
    },

    resize() {},

    update(dt, paused) {
      if (paused) return;
      const h = Math.min(dt, 0.04);
      boostTimer = Math.max(0, boostTimer - h);
      const speedMult = boostTimer > 0 ? 1.65 : 1.0;

      if (strobe30) {
        strobeAccum += h;
        if (strobeAccum >= 1 / 24) {
          prevSimTime = simTime;
          simTime += strobeAccum * speedMult;
          strobeAccum = 0;
        }
      } else {
        prevSimTime = simTime;
        simTime += h * speedMult;
      }
    },

    render(w, h, step, split, cam) {
      allocTargets(w, h);
      const aspect = w / Math.max(1, h);
      const fovRad = ((cam.fovDeg || 44) * Math.PI) / 180;
      const tanHalfFov = Math.tan(fovRad * 0.5);
      const basis = cameraBasisFromOrbit(cam.yaw, cam.pitch, cam.dist, cam.lookY || 1.08);
      const view = makeLookAt(basis.pos, basis.target, [0, 1, 0]);
      const proj = makePerspective(fovRad, aspect, 0.1, 40.0);
      const currVP = mulMat4(proj, view);
      if (!prevVP) prevVP = currVP;

      const stageL = split.enabled ? step.compareLeft : step.stage;
      const stageR = split.enabled ? step.compareRight : step.stage;
      const splitX = split.enabled ? split.pos : -1.0;

      // Keep crisp cinema 180° shutter delta even when paused so user can drag Split across live frozen motion blur!
      const effectivePrevT = Math.abs(simTime - prevSimTime) > 1e-4 ? prevSimTime : (simTime - 1 / 60);
      const shutterScale = (boostTimer > 0 ? 1.55 : 1.18) * (strobe30 ? 0.55 : 1.0);

      gl.disable(gl.DEPTH_TEST);
      gl.disable(gl.BLEND);
      gl.bindVertexArray(vao);

      // PASS 1: 3D Studio Scene -> HDR Color + Exact Screen-Space Velocity & Depth MRT!
      gl.bindFramebuffer(gl.FRAMEBUFFER, fboScene);
      gl.viewport(0, 0, w, h);
      gl.useProgram(progScene);
      gl.uniform3fv(uScene.uCamPos, basis.pos);
      gl.uniform3fv(uScene.uCamRight, basis.right);
      gl.uniform3fv(uScene.uCamUp, basis.up);
      gl.uniform3fv(uScene.uCamFwd, basis.fwd);
      gl.uniform1f(uScene.uTanHalfFov, tanHalfFov);
      gl.uniform1f(uScene.uAspect, aspect);
      gl.uniformMatrix4fv(uScene.uCurrVP, false, currVP);
      gl.uniformMatrix4fv(uScene.uPrevVP, false, prevVP);
      gl.uniform1f(uScene.uTime, simTime);
      gl.uniform1f(uScene.uPrevTime, effectivePrevT);
      gl.uniform1f(uScene.uShutterScale, shutterScale);
      gl.uniform1i(uScene.uStageLeft, stageL);
      gl.uniform1i(uScene.uStageRight, stageR);
      gl.uniform1f(uScene.uSplitX, splitX);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

      // Update authentic 1999 Frame Accumulation ping-pong buffer (Stage 0!)
      const nextAcc = 1 - accIdx;
      gl.bindFramebuffer(gl.FRAMEBUFFER, fboAcc[nextAcc]);
      gl.viewport(0, 0, w, h);
      gl.useProgram(progAccum);
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, texColor);
      gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, texAcc[accIdx]);
      gl.uniform1i(uAcc.uCurrTex, 0);
      gl.uniform1i(uAcc.uPrevAccumTex, 1);
      gl.uniform1f(uAcc.uBlend, accPrimed ? 0.24 : 1.0);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      accIdx = nextAcc;
      accPrimed = true;

      // PASS 2: McGuire TileMax (16x16 tiles)
      gl.bindFramebuffer(gl.FRAMEBUFFER, fboTile);
      gl.viewport(0, 0, tileW, tileH);
      gl.useProgram(progTile);
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, texVel);
      gl.uniform1i(uTile.uVelTex, 0);
      gl.uniform2f(uTile.uTexelSize, 1 / w, 1 / h);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

      // PASS 3: McGuire 3x3 NeighborMax
      gl.bindFramebuffer(gl.FRAMEBUFFER, fboNeigh);
      gl.viewport(0, 0, tileW, tileH);
      gl.useProgram(progNeigh);
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, texTile);
      gl.uniform1i(uNeigh.uTileTex, 0);
      gl.uniform2f(uNeigh.uTileTexel, 1 / tileW, 1 / tileH);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

      // PASS 4: Final Reconstruction Resolve + ACES Filmic Tone Mapping!
      const hubUv = projectPointUv(currVP, [0.72, 1.46, -0.32]);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, w, h);
      gl.useProgram(progResolve);
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, texColor);
      gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, texVel);
      gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D, texNeigh);
      gl.activeTexture(gl.TEXTURE3); gl.bindTexture(gl.TEXTURE_2D, texAcc[accIdx]);
      gl.uniform1i(uRes.uColorTex, 0);
      gl.uniform1i(uRes.uVelTex, 1);
      gl.uniform1i(uRes.uNeighTex, 2);
      gl.uniform1i(uRes.uAccumTex, 3);
      gl.uniform1i(uRes.uStageLeft, stageL);
      gl.uniform1i(uRes.uStageRight, stageR);
      gl.uniform1f(uRes.uSplitX, splitX);
      gl.uniform1i(uRes.uShowVelocity, showVelocity ? 1 : 0);
      gl.uniform2fv(uRes.uHubUv, hubUv);
      gl.uniform1f(uRes.uAspect, aspect);
      gl.uniform1f(uRes.uTime, simTime);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

      gl.bindVertexArray(null);
      prevVP = currVP;
    },
  };
}
