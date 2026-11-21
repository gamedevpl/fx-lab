// Evolution of 3D Pixel Art (1992-2023) — Interactive WebGL2 Controller with True Texel-Snapping & 4x Loupe.
// Renders left/right stages into dedicated MRT FBOs (Color + Normal/Depth) at authentic stage resolutions
// so Split-Screen compares Naive Low-Res 3D Shimmer (Stage 6) vs Real Texel-Snapped Sub-Pixel Camera (Stage 7) LIVE!

import { clamp, norm3, cross3, cameraBasisFromOrbit, FULL_VS, linkPrograms, makeTex2D } from "../../src/gl-utils.js";
import { PIXEL3D_SCENE_FS, PIXEL3D_POST_FS } from "./shaders.js";

function dot3(a, b) { return a[0]*b[0] + a[1]*b[1] + a[2]*b[2]; }

function makeMrtTarget(gl, w, h, filter) {
  const texCol = makeTex2D(gl, w, h, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, filter);
  const texGeom = makeTex2D(gl, w, h, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, gl.NEAREST);
  const fbo = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texCol, 0);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT1, gl.TEXTURE_2D, texGeom, 0);
  gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1]);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  return { fbo, texCol, texGeom, w, h };
}

function disposeTarget(gl, t) {
  if (!t) return;
  gl.deleteTexture(t.texCol);
  gl.deleteTexture(t.texGeom);
  gl.deleteFramebuffer(t.fbo);
}

export function createPixel3dEffect(gl) {
  const [progScene, progPost] = linkPrograms(gl, [
    [FULL_VS, PIXEL3D_SCENE_FS],
    [FULL_VS, PIXEL3D_POST_FS],
  ]);

  const uLoc = (p, names) => Object.fromEntries(names.map(n => [n, gl.getUniformLocation(p, n)]));
  const uS = uLoc(progScene, [
    "uCamPos", "uCamRight", "uCamUp", "uCamFwd", "uTanHalfFov", "uAspect", "uTime",
    "uOrthoSize", "uMode", "uQuantRot", "uLockDither", "uRenderRes",
  ]);
  const uP = uLoc(progPost, [
    "uColLeft", "uGeomLeft", "uColRight", "uGeomRight",
    "uRes", "uLowResLeft", "uLowResRight", "uSubPxLeft", "uSubPxRight",
    "uSplitX", "uStageLeft", "uStageRight", "uOutlineOn", "uLoupeTarget", "uLoupeOn",
  ]);
  const vao = gl.createVertexArray();

  // Dynamic MRT FBO cache keyed by slot ("L" / "R") & exact pixel dimensions
  const slots = { L: null, R: null };
  function ensureSlot(key, w, h, filter) {
    const cur = slots[key];
    if (cur && cur.w === w && cur.h === h && cur.filter === filter) return cur;
    disposeTarget(gl, cur);
    const t = makeMrtTarget(gl, w, h, filter);
    t.filter = filter;
    slots[key] = t;
    return t;
  }

  let simTime = 0;
  let lockDither = true;    // Stage 5 Obra Dinn: toggle World/Sphere-Locked vs Swimming Screen-Space Dither!
  let outlineOn = true;     // Stage 3/5/7: toggle 1-px pixel-art outlines
  let ultraLowRes = false;  // Stage 6/7: toggle 160p vs 240p resolution
  let loupeTarget = [0.50, 0.56]; // Default aimed squarely onto the rotating windmill blade & crimson roof slope!
  let draggingLoupe = false;

  function stageResolution(stage, viewW, viewH) {
    const aspect = viewW / Math.max(1, viewH);
    let targetH = ultraLowRes ? 136 : 180;
    if (stage === 0) targetH = 220; // Comanche self-quantizes into vertical columns
    else if (stage === 1) targetH = 160; // 1994 SNES pre-rendered sprite resolution
    else if (stage === 2) targetH = 240; // 1997 Blood crisp 3D voxels
    else if (stage === 3) targetH = 168; // Dead Cells crisp low-res sprite bake
    else if (stage === 4) targetH = Math.min(540, viewH); // HD-2D lush full-res 3D world + DoF!
    else if (stage === 5) targetH = Math.min(360, viewH); // Obra Dinn crisp Macintosh 1-bit resolution!
    else if (stage === 6 || stage === 7) targetH = ultraLowRes ? 128 : 168;
    const rh = Math.max(96, Math.round(targetH));
    const rw = Math.max(96, Math.round(rh * aspect));
    return [rw, rh, stage === 4 ? gl.LINEAR : gl.NEAREST];
  }

  function renderOneStage(slotKey, stage, viewW, viewH, cam) {
    const [rw, rh, filter] = stageResolution(stage, viewW, viewH);
    const tgt = ensureSlot(slotKey, rw, rh, filter);
    const aspect = viewW / Math.max(1, viewH);

    // Gentle continuous gliding diorama pan so Naive Low-Res 3D shimmer vs Texel-Snapped stability is unmistakable!
    const glideX = Math.sin(simTime * 0.62) * 0.42;
    const glideY = Math.cos(simTime * 0.44) * 0.14;
    let yaw = cam.yaw;
    // Stage 1 (DKC 1994): quantize camera yaw into 8 discrete 45-degree turntable sprite angles!
    if (stage === 1) {
      yaw = Math.round((cam.yaw + simTime * 0.35) / (Math.PI / 4)) * (Math.PI / 4);
    }

    const baseOrbit = cameraBasisFromOrbit(yaw, clamp(cam.pitch, 0.10, 0.72), cam.dist, cam.lookY);
    let camPos = [
      baseOrbit.pos[0] + baseOrbit.right[0] * glideX + baseOrbit.up[0] * glideY,
      baseOrbit.pos[1] + baseOrbit.right[1] * glideX + baseOrbit.up[1] * glideY,
      baseOrbit.pos[2] + baseOrbit.right[2] * glideX + baseOrbit.up[2] * glideY,
    ];

    let orthoSize = 0.0;
    let subPx = [0.0, 0.0];
    const fovRad = ((cam.fovDeg || 36) * Math.PI) / 180;
    const tanHalfFov = Math.tan(fovRad * 0.5);

    // Stage 7 (t3ssel8r 2021-2023): TRUE ORTHOGRAPHIC TEXEL-SNAPPED SUB-PIXEL CAMERA!!
    // Matched exactly to dist * tan(fov/2) so Split-Screen aligns pixel-for-pixel across Stage 6 vs Stage 7!
    if (stage === 7) {
      orthoSize = cam.dist * tanHalfFov;
      const texelWorld = (2.0 * orthoSize) / rh;
      const cx = dot3(camPos, baseOrbit.right);
      const cy = dot3(camPos, baseOrbit.up);
      const snapX = Math.floor(cx / texelWorld) * texelWorld;
      const snapY = Math.floor(cy / texelWorld) * texelWorld;
      const dx = snapX - cx;
      const dy = snapY - cy;
      camPos = [
        camPos[0] + baseOrbit.right[0] * dx + baseOrbit.up[0] * dy,
        camPos[1] + baseOrbit.right[1] * dx + baseOrbit.up[1] * dy,
        camPos[2] + baseOrbit.right[2] * dx + baseOrbit.up[2] * dy,
      ];
      subPx = [(cx - snapX) / texelWorld, (cy - snapY) / texelWorld];
    }

    gl.bindFramebuffer(gl.FRAMEBUFFER, tgt.fbo);
    gl.viewport(0, 0, rw, rh);
    gl.disable(gl.DEPTH_TEST); gl.disable(gl.BLEND);
    gl.useProgram(progScene);
    gl.bindVertexArray(vao);
    gl.uniform3fv(uS.uCamPos, camPos);
    gl.uniform3fv(uS.uCamRight, baseOrbit.right);
    gl.uniform3fv(uS.uCamUp, baseOrbit.up);
    gl.uniform3fv(uS.uCamFwd, baseOrbit.fwd);
    gl.uniform1f(uS.uTanHalfFov, tanHalfFov);
    gl.uniform1f(uS.uAspect, aspect);
    gl.uniform1f(uS.uTime, simTime);
    gl.uniform1f(uS.uOrthoSize, orthoSize);
    gl.uniform1i(uS.uMode, stage);
    gl.uniform1f(uS.uQuantRot, stage === 1 ? 1.0 : 0.0);
    gl.uniform1f(uS.uLockDither, lockDither ? 1.0 : 0.0);
    gl.uniform2f(uS.uRenderRes, rw, rh);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

    return { tgt, rw, rh, subPx };
  }

  return {
    id: "pixel3d",
    disableDblClickReset: true,
    maxPixels: 720000,
    defaultCamera: {
      yaw: 0.42,
      pitch: 0.34,
      dist: 6.8,
      lookY: 1.18,
      fovDeg: 36,
      minDist: 4.0,
      maxDist: 10.5,
      minPitch: 0.12,
      maxPitch: 0.72,
      autoOrbitSpeed: 0.0,
    },

    enterStep(stepIdx) {
      if (stepIdx === 5) lockDither = true;
      if (stepIdx === 7 || stepIdx === 6) outlineOn = true;
    },

    onReset() {
      lockDither = true;
      outlineOn = true;
      ultraLowRes = false;
      loupeTarget = [0.50, 0.56];
    },

    triggerAction(actionId) {
      if (actionId === "lockDither") lockDither = !lockDither;
      else if (actionId === "outlines") outlineOn = !outlineOn;
      else if (actionId === "lowRes") ultraLowRes = !ultraLowRes;
    },

    isActionActive(actionId) {
      if (actionId === "lockDither") return lockDither;
      if (actionId === "outlines") return outlineOn;
      if (actionId === "lowRes") return ultraLowRes;
      return false;
    },

    onPointerDown(ndcX, ndcY) {
      const uvX = ndcX * 0.5 + 0.5, uvY = ndcY * 0.5 + 0.5;
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
      loupeTarget = [clamp(ndcX * 0.5 + 0.5, 0.06, 0.94), clamp(ndcY * 0.5 + 0.5, 0.08, 0.92)];
    },

    getTechBadge(stepIdx) {
      const resTag = ultraLowRes ? "128P" : "168P";
      return [
        "1992 · COMANCHE VOXEL SPACE",
        "1994 · DKC PRE-RENDERED 8-ANGLE SPRITES",
        "1997 · BLOOD 3D VOXEL PROPS",
        "2018 · DEAD CELLS 3D→2D CEL SPRITES",
        "2018 · OCTOPATH HD-2D (DOF + BLOOM)",
        lockDither ? "2018 · OBRA DINN (WORLD-LOCKED 1-BIT!)" : "2018 · OBRA DINN (SWIMMING SCREEN DITHER!)",
        `2019 · A SHORT HIKE NAIVE ${resTag} (SHIMMER!)`,
        `2021–23 · T3SSEL8R TEXEL-SNAPPED ${resTag}`,
      ][stepIdx] || "WEBGL2";
    },

    resize() {},

    update(dt, paused) {
      if (!paused) simTime += dt;
    },

    render(w, h, step, split, cam) {
      const stageLeft = split.enabled ? step.compareLeft : step.stage;
      const stageRight = split.enabled ? step.compareRight : step.stage;

      const rightPass = renderOneStage("R", stageRight, w, h, cam);
      const leftPass = (split.enabled && stageLeft !== stageRight)
        ? renderOneStage("L", stageLeft, w, h, cam)
        : rightPass;

      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, w, h);
      gl.disable(gl.DEPTH_TEST); gl.disable(gl.BLEND);
      gl.useProgram(progPost);
      gl.bindVertexArray(vao);

      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, leftPass.tgt.texCol); gl.uniform1i(uP.uColLeft, 0);
      gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, leftPass.tgt.texGeom); gl.uniform1i(uP.uGeomLeft, 1);
      gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D, rightPass.tgt.texCol); gl.uniform1i(uP.uColRight, 2);
      gl.activeTexture(gl.TEXTURE3); gl.bindTexture(gl.TEXTURE_2D, rightPass.tgt.texGeom); gl.uniform1i(uP.uGeomRight, 3);

      gl.uniform2f(uP.uRes, w, h);
      gl.uniform2f(uP.uLowResLeft, leftPass.rw, leftPass.rh);
      gl.uniform2f(uP.uLowResRight, rightPass.rw, rightPass.rh);
      gl.uniform2fv(uP.uSubPxLeft, leftPass.subPx);
      gl.uniform2fv(uP.uSubPxRight, rightPass.subPx);
      gl.uniform1f(uP.uSplitX, split.enabled ? split.pos : -1.0);
      gl.uniform1i(uP.uStageLeft, stageLeft);
      gl.uniform1i(uP.uStageRight, stageRight);
      gl.uniform1f(uP.uOutlineOn, outlineOn ? 1.0 : 0.0);
      gl.uniform2fv(uP.uLoupeTarget, loupeTarget);
      gl.uniform1f(uP.uLoupeOn, 1.0);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      gl.bindVertexArray(null);
    },
  };
}
