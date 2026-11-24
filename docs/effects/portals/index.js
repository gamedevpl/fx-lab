// Evolution of Portals & Impossible Spaces (1994-2023) — Interactive WebGL2 FPP Fly-Through Controller.

import { clamp, norm3, cross3, cameraBasisFromOrbit, FULL_VS, linkProgram } from "../../src/gl-utils.js";
import { PORTALS_FS } from "./shaders.js";

function basisFromLookAt(eye, target) {
  const fwd = norm3(target[0] - eye[0], target[1] - eye[1], target[2] - eye[2]);
  const right = norm3(...cross3(fwd, [0, 1, 0]));
  const up = cross3(right, fwd);
  return { pos: eye, fwd, right, up };
}

export function createPortalsEffect(gl) {
  const prog = linkProgram(gl, FULL_VS, PORTALS_FS);
  const uLoc = names => Object.fromEntries(names.map(n => [n, gl.getUniformLocation(prog, n)]));
  const u = uLoc([
    "uCamPos", "uCamRight", "uCamUp", "uCamFwd",
    "uTanHalfFov", "uAspect", "uTime", "uRes",
    "uSplitX", "uStageLeft", "uStageRight", "uDebugOn",
    "uOrangeOff", "uShiftState", "uPhotoStamp", "uInHall", "uPortalParity",
  ]);
  const vao = gl.createVertexArray();

  let simTime = 0;
  let sectorGlitch = false;
  let limitDepth1 = false;
  let antiAutoWalk = true;  // Stage 4: smooth 360-deg FPP walk around 5-room central monolith!
  let antiAngle = 0.0;
  let flyInside = true;     // Stage 5: CodeParade orbits 1.4m exterior AND flies 12m inside 24m hall!
  let flyTime = 0.0;
  let flyBlend = 1.0;
  let photoStamped = true;  // Stage 7: Viewfinder stamp + walk onto 3D bridge!
  let photoAmt = 1.0;
  let viewfinderT = 0.0;
  let orangeOff = [0.0, 0.0];
  let curOrangeOff = [0.0, 0.0];
  let portalTravel = 0.0;

  return {
    id: "portals",
    maxPixels: 560000,
    defaultCamera: {
      yaw: 0.04,
      pitch: 0.05,
      dist: 3.15,
      lookY: 1.52,
      fovDeg: 60,
      minDist: 1.6,
      maxDist: 5.8,
      minPitch: -0.22,
      maxPitch: 0.45,
      autoOrbitSpeed: 0.0,
    },

    enterStep(stepIdx) {
      if (stepIdx !== 1) sectorGlitch = false;
      if (stepIdx !== 3) limitDepth1 = false;
      if (stepIdx === 3) {
        orangeOff = [0.0, 0.0];
        curOrangeOff = [0.0, 0.0];
        portalTravel = 0.0;
      }
      if (stepIdx === 4) antiAutoWalk = true;
      if (stepIdx === 5) {
        flyInside = true;
        flyTime = 0.0;
        flyBlend = 1.0;
      }
      if (stepIdx === 6) {
        orangeOff = [0.0, 0.0];
        curOrangeOff = [0.0, 0.0];
      }
      if (stepIdx === 7) {
        photoStamped = true;
        photoAmt = 1.0;
        viewfinderT = 0.0;
      }
    },

    onReset() {
      sectorGlitch = false;
      limitDepth1 = false;
      antiAutoWalk = true;
      antiAngle = 0.0;
      flyInside = true;
      flyTime = 0.0;
      flyBlend = 1.0;
      photoStamped = true;
      photoAmt = 1.0;
      viewfinderT = 0.0;
      orangeOff = [0.0, 0.0];
      curOrangeOff = [0.0, 0.0];
      portalTravel = 0.0;
    },

    triggerAction(actionId) {
      if (actionId === "sectorGlitch") sectorGlitch = !sectorGlitch;
      else if (actionId === "recursion") limitDepth1 = !limitDepth1;
      else if (actionId === "lookAway") antiAutoWalk = !antiAutoWalk;
      else if (actionId === "inspectOutside") {
        flyInside = !flyInside;
        if (flyInside) flyTime = 0.22 * 15.0; // Smoothly line up with archway instead of jumping mid-cycle!
      } else if (actionId === "placePhoto") {
        photoStamped = !photoStamped;
        if (photoStamped) viewfinderT = 0.0;
      }
    },

    isActionActive(actionId) {
      if (actionId === "sectorGlitch") return sectorGlitch;
      if (actionId === "recursion") return limitDepth1;
      if (actionId === "lookAway") return antiAutoWalk;
      if (actionId === "inspectOutside") return flyInside;
      if (actionId === "placePhoto") return photoStamped;
      return false;
    },

    onCanvasClick(ndcX, ndcY, _w, _h, step) {
      if (step && step.stage === 3) {
        orangeOff = [clamp(ndcX * 0.95, -1.0, 0.85), clamp(ndcY * 0.55, -0.35, 0.52)];
      } else if (step && step.stage === 7) {
        photoStamped = !photoStamped;
        if (photoStamped) viewfinderT = 0.0;
      } else if (step && step.stage === 4) {
        antiAutoWalk = !antiAutoWalk;
      }
    },

    getTechBadge(stepIdx) {
      return [
        "1994 · MARATHON OVERLAPPING ROOMS",
        sectorGlitch ? "1996 · BUILD SECTOR GLITCH!" : "1996 · DUKE3D SECTORS + MIRROR",
        "2006 · PREY FIXED 3D PORTALS",
        limitDepth1 ? "2007 · PORTAL (DEPTH = 1)" : "2007 · PORTAL FPP LOOP (10×!)",
        "2013 · ANTICHAMBER (5 ROOMS IN 360°!)",
        flyInside ? "2018 · FLY-THROUGH (1.4M → 24M!)" : "2018 · EXTERIOR (1.4M BOX!)",
        "2022 · PORTAL RTX (LIGHT + SHADOWS)",
        photoStamped ? "2023 · VIEWFINDER (3D BRIDGE!)" : "2023 · VIEWFINDER (2D PHOTO)",
      ][stepIdx] || "WEBGL2";
    },

    resize() {},

    update(dt, paused, step) {
      if (!paused) {
        simTime += dt;
        if (step && step.stage === 3) {
          portalTravel += dt * 1.40;
        }
        if (step && step.stage === 4 && antiAutoWalk) {
          antiAngle += dt * 0.62;
        }
        if (step && step.stage === 5 && flyInside) {
          flyTime = (flyTime + dt) % 15.0;
        }
        if (step && step.stage === 7 && photoStamped) {
          viewfinderT += dt;
        }
      }
      const damp = Math.min(1.0, dt * 5.0);
      curOrangeOff[0] += (orangeOff[0] - curOrangeOff[0]) * damp;
      curOrangeOff[1] += (orangeOff[1] - curOrangeOff[1]) * damp;
      const tFly = flyInside ? 1.0 : 0.0;
      flyBlend += (tFly - flyBlend) * Math.min(1.0, dt * 4.5);
      const tPhoto = photoStamped ? 1.0 : 0.0;
      photoAmt += (tPhoto - photoAmt) * Math.min(1.0, dt * 5.0);
    },

    render(w, h, step, split, cam) {
      const aspect = w / Math.max(1, h);
      const stage = step.stage;
      let basis;
      let inHall = 0.0;
      let portalParity = 0;
      let shiftState = antiAngle + cam.yaw;
      const ss = x => { const t = clamp(x, 0, 1); return t * t * (3 - 2 * t); };

      if (stage === 0 || stage === 1) {
        basis = cameraBasisFromOrbit(cam.yaw + Math.sin(simTime * 0.55) * 0.34, cam.pitch, clamp(cam.dist, 2.2, 3.15), cam.lookY);
      } else if (stage === 2) {
        basis = cameraBasisFromOrbit(cam.yaw + 0.14 + Math.sin(simTime * 0.48) * 0.14, cam.pitch + 0.02, clamp(cam.dist * 0.74, 1.75, 2.38), cam.lookY);
      } else if (stage === 3) {
        // TRULY INFINITE exact 5.30m wall-to-wall FPP fly-through: enters blueCen at u=1 and exits orangeCen at u=0 -> ZERO jump even with offset portals!
        const passIdx = Math.floor(portalTravel / 5.30);
        portalParity = passIdx & 1;
        const u = (portalTravel - passIdx * 5.30) / 5.30;
        const su = ss(u);
        const loopZ = 2.646 - u * 5.292;
        const blueX = -0.08, blueY = 1.50;
        const orgX = clamp(-0.08 + curOrangeOff[0], -1.15, 0.95);
        const orgY = clamp(1.50 + curOrangeOff[1], 1.15, 2.05);
        const midArc = Math.sin(u * Math.PI);
        const cx = orgX + (blueX - orgX) * su + midArc * (0.14 + Math.sin(cam.yaw) * 0.35);
        const cy = orgY + (blueY - orgY) * su + midArc * (cam.pitch * 0.32);
        const eye = [cx, cy, loopZ];
        const target = [cx + Math.sin(cam.yaw) * -0.95, cy - cam.pitch * 0.35, loopZ - 3.5];
        basis = basisFromLookAt(eye, target);
      } else if (stage === 6) {
        // Stage 6 (Portal RTX): locked smooth architectural 3/4 view inside the dark chamber showcasing the blazing golden sunbeam, pillar shadow & glossy floor reflection!
        portalParity = 0;
        const eye = [
          -1.48 + Math.sin(simTime * 0.32) * 0.32 + Math.sin(cam.yaw) * 0.72,
          1.62 + Math.sin(simTime * 0.22) * 0.05 + cam.pitch * 0.42,
          2.16 + Math.cos(simTime * 0.26) * 0.14,
        ];
        const target = [-0.08 + Math.sin(cam.yaw) * 0.25, 0.92 - cam.pitch * 0.20, -1.25];
        basis = basisFromLookAt(eye, target);
      } else if (stage === 4) {
        // True 5-Room 360-deg FPP Walk around the central monolith at radius 1.85m (sculptures at r=2.88m -> zero clipping!)
        const ang = shiftState;
        const r = 1.85;
        const eye = [Math.sin(ang) * r, 1.54 + cam.pitch * 0.6, Math.cos(ang) * r];
        const ahead = ang + 0.74;
        const target = [Math.sin(ahead) * 2.45, 1.48 - cam.pitch * 0.5, Math.cos(ahead) * 2.45];
        basis = basisFromLookAt(eye, target);
      } else if (stage === 5) {
        // CodeParade: C1-continuous orbit -> exact archway alignment -> fly 10.5m INSIDE 24m hall -> 360 look back -> pull out (ZERO seam at cycle 0.28/0.90 or toggle!)
        const cycle = (flyTime % 15.0) / 15.0;
        let flyEye, flyTgt;
        if (cycle < 0.28) {
          const p = ss(cycle / 0.28);
          const orb = cameraBasisFromOrbit((1.0 - p) * (2.55 + cam.yaw), (1.0 - p) * (0.18 + cam.pitch), 4.65 - p * 1.35, 1.40);
          flyEye = orb.pos;
          flyTgt = [orb.pos[0] + orb.fwd[0] * 5.0, orb.pos[1] + orb.fwd[1] * 5.0, orb.pos[2] + orb.fwd[2] * 5.0];
        } else if (cycle < 0.56) {
          const p = ss((cycle - 0.28) / 0.28);
          const ez = 3.30 - p * 13.8;
          inHall = ez < 0.66 ? 1.0 : 0.0;
          flyEye = [Math.sin(p * Math.PI) * 0.12, 1.40, ez];
          flyTgt = [0.0, 1.40, ez - 5.0];
        } else if (cycle < 0.78) {
          const p = ss((cycle - 0.56) / 0.22);
          const ez = -10.5 + p * 5.2;
          inHall = 1.0;
          const yawLook = p * Math.PI * 2.0;
          flyEye = [0.0, 1.40, ez];
          flyTgt = [Math.sin(yawLook) * 5.0, 1.40, ez - Math.cos(yawLook) * 5.0];
        } else if (cycle < 0.90) {
          const p = ss((cycle - 0.78) / 0.12);
          const ez = -5.3 + p * 8.6;
          inHall = ez < 0.66 ? 1.0 : 0.0;
          flyEye = [0.0, 1.40, ez];
          flyTgt = [0.0, 1.40, ez - 5.0];
        } else {
          const p = ss((cycle - 0.90) / 0.10);
          const orb = cameraBasisFromOrbit(p * (2.55 + cam.yaw), p * (0.18 + cam.pitch), 3.30 + p * 1.35, 1.40);
          flyEye = orb.pos;
          flyTgt = [orb.pos[0] + orb.fwd[0] * 5.0, orb.pos[1] + orb.fwd[1] * 5.0, orb.pos[2] + orb.fwd[2] * 5.0];
        }
        const extOrb = cameraBasisFromOrbit(1.65 + cam.yaw + Math.sin(simTime * 0.5) * 0.4, 0.16 + cam.pitch, 4.95, 1.42);
        const extTgt = [extOrb.pos[0] + extOrb.fwd[0] * 5.0, extOrb.pos[1] + extOrb.fwd[1] * 5.0, extOrb.pos[2] + extOrb.fwd[2] * 5.0];
        const fb = ss(flyBlend);
        const eye = [
          extOrb.pos[0] + (flyEye[0] - extOrb.pos[0]) * fb,
          extOrb.pos[1] + (flyEye[1] - extOrb.pos[1]) * fb,
          extOrb.pos[2] + (flyEye[2] - extOrb.pos[2]) * fb,
        ];
        const tgt = [
          extTgt[0] + (flyTgt[0] - extTgt[0]) * fb,
          extTgt[1] + (flyTgt[1] - extTgt[1]) * fb,
          extTgt[2] + (flyTgt[2] - extTgt[2]) * fb,
        ];
        if (fb < 0.5) inHall = 0.0;
        basis = basisFromLookAt(eye, tgt);
      } else {
        // Stage 7 (Viewfinder): C1-continuous forward glide onto 3D bridge when stamped -> ZERO photoAmt > 0.5 teleport!
        const pBlend = ss(photoAmt);
        const walkZ = 2.35 - pBlend * (0.5 - 0.5 * Math.cos(viewfinderT * 0.58)) * 2.40;
        const swayX = (0.14 + 0.36 * pBlend) * Math.sin(simTime * 0.62) + Math.sin(cam.yaw) * 0.75;
        basis = basisFromLookAt([swayX, 1.52 + cam.pitch * 0.5, walkZ], [0.0, 1.52, walkZ - 4.0]);
      }

      const tanHalfFov = Math.tan(((cam.fovDeg || 60) * Math.PI) / 360);
      const stageLeft = split.enabled ? step.compareLeft : step.stage;
      const stageRight = split.enabled ? step.compareRight : step.stage;

      let debugOn = false;
      if (stage === 1) debugOn = sectorGlitch;
      else if (stage === 3) debugOn = limitDepth1;
      else if (stage === 4) debugOn = antiAutoWalk;
      else if (stage === 5) debugOn = flyInside;
      else if (stage === 7) debugOn = photoStamped;

      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, w, h);
      gl.disable(gl.DEPTH_TEST);
      gl.disable(gl.BLEND);
      gl.useProgram(prog);
      gl.bindVertexArray(vao);

      gl.uniform3fv(u.uCamPos, basis.pos);
      gl.uniform3fv(u.uCamRight, basis.right);
      gl.uniform3fv(u.uCamUp, basis.up);
      gl.uniform3fv(u.uCamFwd, basis.fwd);
      gl.uniform1f(u.uTanHalfFov, tanHalfFov);
      gl.uniform1f(u.uAspect, aspect);
      gl.uniform1f(u.uTime, simTime);
      gl.uniform2f(u.uRes, w, h);
      gl.uniform1f(u.uSplitX, split.enabled ? split.pos : -1.0);
      gl.uniform1i(u.uStageLeft, stageLeft);
      gl.uniform1i(u.uStageRight, stageRight);
      gl.uniform1f(u.uDebugOn, debugOn ? 1.0 : 0.0);
      gl.uniform2fv(u.uOrangeOff, curOrangeOff);
      gl.uniform1f(u.uShiftState, shiftState);
      gl.uniform1f(u.uPhotoStamp, photoAmt);
      gl.uniform1f(u.uInHall, inHall);
      gl.uniform1i(u.uPortalParity, portalParity);

      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      gl.bindVertexArray(null);
    },
  };
}
