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
  let photoStamped = true;  // Stage 7: Viewfinder stamp + walk onto 3D bridge!
  let photoAmt = 1.0;
  let orangeOff = [0.0, 0.0];

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
      if (stepIdx === 4) antiAutoWalk = true;
      if (stepIdx === 5) flyInside = true;
      if (stepIdx === 7) photoStamped = true;
    },

    onReset() {
      sectorGlitch = false;
      limitDepth1 = false;
      antiAutoWalk = true;
      antiAngle = 0.0;
      flyInside = true;
      photoStamped = true;
      photoAmt = 1.0;
      orangeOff = [0.0, 0.0];
    },

    triggerAction(actionId) {
      if (actionId === "sectorGlitch") sectorGlitch = !sectorGlitch;
      else if (actionId === "recursion") limitDepth1 = !limitDepth1;
      else if (actionId === "lookAway") antiAutoWalk = !antiAutoWalk;
      else if (actionId === "inspectOutside") flyInside = !flyInside;
      else if (actionId === "placePhoto") photoStamped = !photoStamped;
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
      if (step && (step.stage === 3 || step.stage === 6)) {
        orangeOff = [clamp(ndcX * 0.95, -1.0, 0.85), clamp(ndcY * 0.55, -0.35, 0.52)];
      } else if (step && step.stage === 7) {
        photoStamped = !photoStamped;
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
        if (step && step.stage === 4 && antiAutoWalk) {
          antiAngle += dt * 0.62;
        }
      }
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

      if (stage === 0 || stage === 1) {
        basis = cameraBasisFromOrbit(cam.yaw + Math.sin(simTime * 0.55) * 0.34, cam.pitch, clamp(cam.dist, 2.2, 3.15), cam.lookY);
      } else if (stage === 2) {
        basis = cameraBasisFromOrbit(cam.yaw + 0.14 + Math.sin(simTime * 0.48) * 0.14, cam.pitch + 0.02, clamp(cam.dist * 0.74, 1.75, 2.38), cam.lookY);
      } else if (stage === 3 || stage === 6) {
        // TRULY INFINITE exact 5.30m wall-to-wall FPP fly-through (parity flips 0<->1 on every exact crossing -> ZERO color/position jump!)
        const travel = simTime * 1.45;
        const passIdx = Math.floor(travel / 5.30);
        portalParity = passIdx & 1;
        const loopZ = 2.646 - (travel - passIdx * 5.30) * (5.292 / 5.30);
        const cx = -0.10 + Math.sin(simTime * 0.6) * 0.18 + Math.sin(cam.yaw) * 0.42;
        const eye = [cx, 1.48 + cam.pitch * 0.5, loopZ];
        const target = [cx + Math.sin(cam.yaw) * -1.1, 1.48 - cam.pitch * 0.4, loopZ - 3.5];
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
        // CodeParade: C1-continuous orbit around 1.4m exterior -> fly 10.5m INSIDE 24m hall -> 360 look back at distant exit -> pull back out!
        if (flyInside) {
          const cycle = (simTime % 15.0) / 15.0;
          const ss = x => { const t = clamp(x, 0, 1); return t * t * (3 - 2 * t); };
          if (cycle < 0.28) {
            const p = ss(cycle / 0.28);
            basis = cameraBasisFromOrbit((1.0 - p) * 2.55 + cam.yaw, 0.04 + (1.0 - p) * 0.14 + cam.pitch, 4.65 - p * 1.35, 1.40);
          } else if (cycle < 0.56) {
            const p = ss((cycle - 0.28) / 0.28);
            const ez = 3.30 - p * 13.8;
            inHall = ez < 0.66 ? 1.0 : 0.0;
            basis = basisFromLookAt([Math.sin(p * Math.PI) * 0.12, 1.40, ez], [0.0, 1.38, ez - 5.0]);
          } else if (cycle < 0.78) {
            // Smooth 360 look-around inside the 24m hall showing the tiny distant sunny exit doorway behind you!
            const p = ss((cycle - 0.56) / 0.22);
            const ez = -10.5 + p * 5.2;
            inHall = 1.0;
            const yawLook = p * Math.PI * 2.0;
            basis = basisFromLookAt([0.0, 1.40, ez], [Math.sin(yawLook) * 4.5, 1.38, ez - Math.cos(yawLook) * 4.5]);
          } else if (cycle < 0.90) {
            // Pull smoothly backwards out the doorway watching the 24m hall shrink back into the tiny 1.4m arch!
            const p = ss((cycle - 0.78) / 0.12);
            const ez = -5.3 + p * 8.6;
            inHall = ez < 0.66 ? 1.0 : 0.0;
            basis = basisFromLookAt([0.0, 1.40, ez], [0.0, 1.38, ez - 5.0]);
          } else {
            const p = ss((cycle - 0.90) / 0.10);
            basis = cameraBasisFromOrbit(p * 2.55 + cam.yaw, 0.04 + p * 0.14 + cam.pitch, 3.30 + p * 1.35, 1.40);
          }
        } else {
          basis = cameraBasisFromOrbit(1.65 + cam.yaw + Math.sin(simTime * 0.5) * 0.4, 0.16 + cam.pitch, 4.95, 1.42);
        }
      } else {
        // Stage 7 (Viewfinder): when stamped, glide gently forward onto the sunlit 3D bridge & sway sideways to reveal the cut!
        const walkZ = photoAmt > 0.5 ? 1.85 - Math.sin((simTime * 0.55) % Math.PI) * 2.45 : 2.35;
        const swayX = Math.sin(simTime * 0.7) * (photoAmt > 0.5 ? 0.55 : 0.16) + Math.sin(cam.yaw) * 0.85;
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
      gl.uniform2fv(u.uOrangeOff, orangeOff);
      gl.uniform1f(u.uShiftState, shiftState);
      gl.uniform1f(u.uPhotoStamp, photoAmt);
      gl.uniform1f(u.uInHall, inHall);
      gl.uniform1i(u.uPortalParity, portalParity);

      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      gl.bindVertexArray(null);
    },
  };
}
