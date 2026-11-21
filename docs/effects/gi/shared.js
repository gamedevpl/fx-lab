// Shared state, camera, lamp placement, and tech badges for Evolution of Global Illumination (1996-2026).
// Used identically by both the WebGPU Compute primary engine and the WebGL2 Fallback engine.

import { clamp, norm3, cameraBasisFromOrbit } from "../../src/gl-utils.js";

export const BAKED_LAMP = [-1.52, 2.28, -0.18];
export const ALT_LAMP   = [ 1.52, 2.28, -0.18];

export const DEFAULT_CAMERA = {
  yaw: 0.04,
  pitch: 0.05,
  dist: 4.55,
  lookY: 1.52,
  fovDeg: 52,
  minDist: 2.35,
  maxDist: 5.75,
  minPitch: -0.22,
  maxPitch: 0.42,
  autoOrbitSpeed: 0.0,
};

export function createGiState(backendTag) {
  let simTime = 0;
  let frameIndex = 0;
  let moveLamp = false;
  let moveLampAmt = 0.0;
  let lookAway = false;
  let lookAwayAmt = 0.0;
  let showDebug = false;
  let customLamp = null; // [x, y, z] from user click
  let lampPos = [...BAKED_LAMP];
  let prevLampPos = [...BAKED_LAMP];
  let lampMovedSinceLast = false;

  function computeTargetLamp() {
    if (customLamp) return customLamp;
    // Smooth arc over/in front of the thin divider when Move Lamp is toggled on!
    const t = moveLampAmt;
    const x = BAKED_LAMP[0] + (ALT_LAMP[0] - BAKED_LAMP[0]) * t;
    const y = BAKED_LAMP[1] + Math.sin(t * Math.PI) * 0.28 + Math.sin(simTime * 0.9) * 0.06;
    const z = BAKED_LAMP[2] + Math.sin(t * Math.PI) * 0.85 + Math.cos(simTime * 0.7) * 0.08;
    return [x, y, z];
  }

  return {
    get simTime() { return simTime; },
    get frameIndex() { return frameIndex; },
    get moveLamp() { return moveLamp; },
    get moveLampAmt() { return moveLampAmt; },
    get lookAway() { return lookAway; },
    get lookAwayAmt() { return lookAwayAmt; },
    get showDebug() { return showDebug; },
    get lampPos() { return lampPos; },
    get lampMovedSinceLast() { return lampMovedSinceLast; },

    enterStep(stepIdx) {
      if (stepIdx !== 3 && stepIdx !== 7) lookAway = false;
      if (stepIdx !== 0 && stepIdx !== 6) {
        if (!customLamp) moveLamp = false;
      }
      if (stepIdx !== 1 && stepIdx !== 2 && stepIdx !== 4 && stepIdx !== 5 && stepIdx !== 7) {
        showDebug = false;
      }
      // Stage 0 (1996 Baked Lightmaps): start with lamp gliding across so the broken frozen lightmap is unmistakable on entry!
      if (stepIdx === 0 && !customLamp) {
        moveLamp = true;
      }
    },

    onReset() {
      moveLamp = false;
      moveLampAmt = 0.0;
      lookAway = false;
      lookAwayAmt = 0.0;
      showDebug = false;
      customLamp = null;
      lampPos = [...BAKED_LAMP];
      prevLampPos = [...BAKED_LAMP];
    },

    triggerAction(actionId) {
      if (actionId === "moveLamp") {
        customLamp = null;
        moveLamp = !moveLamp;
      } else if (actionId === "lookAway") {
        lookAway = !lookAway;
      } else if (actionId === "showDebug") {
        showDebug = !showDebug;
      }
    },

    isActionActive(actionId) {
      if (actionId === "moveLamp") return moveLamp || !!customLamp;
      if (actionId === "lookAway") return lookAway;
      if (actionId === "showDebug") return showDebug;
      return false;
    },

    onCanvasClick(ndcX, ndcY, w, h, _step, cam) {
      // Intersect click ray with the gallery vertical mid-plane z = -0.15 so user can place the glowing lamp anywhere!
      const aspect = w / Math.max(1, h);
      const basis = this.getCameraBasis(cam);
      const tanHalfFov = Math.tan(((cam.fovDeg || 52) * Math.PI) / 360);
      const rd = norm3(
        basis.fwd[0] + basis.right[0] * (ndcX * aspect * tanHalfFov) + basis.up[0] * (ndcY * tanHalfFov),
        basis.fwd[1] + basis.right[1] * (ndcX * aspect * tanHalfFov) + basis.up[1] * (ndcY * tanHalfFov),
        basis.fwd[2] + basis.right[2] * (ndcX * aspect * tanHalfFov) + basis.up[2] * (ndcY * tanHalfFov)
      );
      const planeZ = -0.15;
      const denom = Math.abs(rd[2]) > 0.08 ? rd[2] : -0.5;
      const t = clamp((planeZ - basis.pos[2]) / denom, 1.2, 8.0);
      let x = clamp(basis.pos[0] + rd[0] * t, -2.35, 2.35);
      let y = clamp(basis.pos[1] + rd[1] * t, 1.05, 2.85);
      let z = -0.15;
      // Keep lamp cleanly clear of the thin center divider wall (x in [-0.36, 0.36], z < 0.65, y < 2.75)
      if (Math.abs(x) < 0.42 && y < 2.78) {
        x = x < 0 ? -0.46 : 0.46;
      }
      customLamp = [x, y, z];
    },

    getCameraBasis(cam) {
      const base = cameraBasisFromOrbit(cam.yaw, cam.pitch, cam.dist, cam.lookY);
      if (lookAwayAmt <= 0.001) return base;
      // Smoothly pan camera head right (~32 deg) so the vivid crimson left wall exits off the left edge of viewport!
      // Exposes 2009 SSDO/SSGI losing red bounce while 3D VCT / DDGI / Lumen / Radiance Cascades keep it alive!
      const pan = lookAwayAmt * 0.56;
      const cp = Math.cos(pan), sp = Math.sin(pan);
      const fwd = norm3(
        base.fwd[0] * cp + base.right[0] * sp,
        base.fwd[1] * cp + base.right[1] * sp,
        base.fwd[2] * cp + base.right[2] * sp
      );
      const right = norm3(
        base.right[0] * cp - base.fwd[0] * sp,
        base.right[1] * cp - base.fwd[1] * sp,
        base.right[2] * cp - base.fwd[2] * sp
      );
      return { pos: base.pos, fwd, right, up: base.up };
    },

    update(dt, paused) {
      const targetMove = moveLamp ? 1.0 : 0.0;
      moveLampAmt += (targetMove - moveLampAmt) * Math.min(1.0, dt * 3.6);
      const targetLook = lookAway ? 1.0 : 0.0;
      lookAwayAmt += (targetLook - lookAwayAmt) * Math.min(1.0, dt * 4.2);
      if (!paused) {
        simTime += dt;
        frameIndex += 1;
      }
      const target = computeTargetLamp();
      const k = Math.min(1.0, dt * 7.5);
      prevLampPos = [...lampPos];
      lampPos = [
        lampPos[0] + (target[0] - lampPos[0]) * k,
        lampPos[1] + (target[1] - lampPos[1]) * k,
        lampPos[2] + (target[2] - lampPos[2]) * k,
      ];
      const delta = Math.hypot(
        lampPos[0] - prevLampPos[0],
        lampPos[1] - prevLampPos[1],
        lampPos[2] - prevLampPos[2]
      );
      lampMovedSinceLast = delta > 0.008;
    },

    getTechBadge(stepIdx) {
      const api = backendTag;
      const moved = moveLampAmt > 0.25 || !!customLamp;
      return [
        moved ? `1996 · QUAKE LIGHTMAP (FROZEN!) · ${api}` : `1996 · QUAKE BAKED LIGHTMAP · ${api}`,
        showDebug ? `1998–04 · PROBES (WALL LEAK!) · ${api}` : `1998–04 · IRRADIANCE PROBES · ${api}`,
        showDebug ? `2007 · SSAO BUFFER (NOT GI!) · ${api}` : `2007 · CRYSIS SSAO (NOT GI!) · ${api}`,
        lookAway ? `2009 · SSDO/SSGI (DROPS OFF!) · ${api}` : `2009 · RITSCHEL SSDO / SSGI · ${api}`,
        showDebug ? `2011 · 3D VOXEL RADIANCE · ${api}` : `2011 · CRASSIN VOXEL CONES · ${api}`,
        showDebug ? `2019 · DDGI OCTAHEDRAL PROBES · ${api}` : `2019 · DDGI CHEBYSHEV GI · ${api}`,
        `2022 · UE5 LUMEN SDF GI · ${api}`,
        showDebug ? `2023–26 · CASCADE PROBE GRID · ${api}` : `2023–26 · RADIANCE CASCADES · ${api}`,
      ][stepIdx] || api;
    },
  };
}
