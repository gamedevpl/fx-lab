// Evolution of Portals & Impossible Spaces (1994-2023) — Interactive WebGL2 Controller.
//   0: 1994 Marathon Overlapping Rooms (two chambers occupy the same 3D coordinates)
//   1: 1996 Build / Duke Nukem 3D Overlapping Sectors + Portal Mirror (plus Descent '95; Sector Glitch toggle!)
//   2: 2006 Prey Fixed 3D Portals (plus Narbacular Drop '05)
//   3: 2007 Portal Recursive Portals (Blue <-> Orange infinite corridor; Recursion 1 vs 8; click to move Orange portal!)
//   4: 2013 Antichamber Shifting Rooms (Look Away morphs the room behind your back!)
//   5: 2018 CodeParade Bigger-on-the-Inside Tunnel (tiny 1.8m stone pavilion holds a 22m infinity hall!)
//   6: 2022 Portal with RTX (ray-traced light beams, shadows & reflections passing THROUGH portals!)
//   7: 2023 Viewfinder Photo-to-3D (stamp a 2D photograph into real 3D walkable geometry!)

import { clamp, norm3, cameraBasisFromOrbit, FULL_VS, linkProgram } from "../../src/gl-utils.js";
import { PORTALS_FS } from "./shaders.js";

export function createPortalsEffect(gl) {
  const prog = linkProgram(gl, FULL_VS, PORTALS_FS);
  const uLoc = names => Object.fromEntries(names.map(n => [n, gl.getUniformLocation(prog, n)]));
  const u = uLoc([
    "uCamPos", "uCamRight", "uCamUp", "uCamFwd",
    "uTanHalfFov", "uAspect", "uTime", "uRes",
    "uSplitX", "uStageLeft", "uStageRight", "uDebugOn",
    "uOrangeOff", "uShiftState", "uPhotoStamp",
  ]);
  const vao = gl.createVertexArray();

  let simTime = 0;
  let sectorGlitch = false; // Stage 1: Duke3D overlapping sector rendering glitch
  let limitDepth1 = false;  // Stage 3: toggle recursion depth 8 vs depth 1!
  let lookAway = false;     // Stage 4: Antichamber turn-away morph!
  let lookAwayAmt = 0.0;
  let shiftState = 0.0;
  let wasTurned = false;
  let inspectOutside = false; // Stage 5: CodeParade orbit around the tiny 1.8m box vs peer into 22m hall!
  let outsideAmt = 0.0;
  let photoStamped = true;  // Stage 7: Viewfinder 2D floating card vs stamped real 3D geometry!
  let photoAmt = 1.0;
  let orangeOff = [0.0, 0.0];

  return {
    id: "portals",
    maxPixels: 560000,
    defaultCamera: {
      yaw: 0.04,
      pitch: 0.06,
      dist: 3.15,
      lookY: 1.52,
      fovDeg: 58,
      minDist: 1.6,
      maxDist: 5.8,
      minPitch: -0.22,
      maxPitch: 0.45,
      autoOrbitSpeed: 0.0,
    },

    enterStep(stepIdx) {
      if (stepIdx !== 1) sectorGlitch = false;
      if (stepIdx !== 3) limitDepth1 = false;
      if (stepIdx !== 4) lookAway = false;
      if (stepIdx !== 5) inspectOutside = false;
      if (stepIdx === 7) photoStamped = true;
    },

    onReset() {
      sectorGlitch = false;
      limitDepth1 = false;
      lookAway = false;
      lookAwayAmt = 0.0;
      shiftState = 0.0;
      inspectOutside = false;
      outsideAmt = 0.0;
      photoStamped = true;
      photoAmt = 1.0;
      orangeOff = [0.0, 0.0];
    },

    triggerAction(actionId) {
      if (actionId === "sectorGlitch") sectorGlitch = !sectorGlitch;
      else if (actionId === "recursion") limitDepth1 = !limitDepth1;
      else if (actionId === "lookAway") lookAway = !lookAway;
      else if (actionId === "inspectOutside") inspectOutside = !inspectOutside;
      else if (actionId === "placePhoto") photoStamped = !photoStamped;
    },

    isActionActive(actionId) {
      if (actionId === "sectorGlitch") return sectorGlitch;
      if (actionId === "recursion") return limitDepth1;
      if (actionId === "lookAway") return lookAway;
      if (actionId === "inspectOutside") return inspectOutside;
      if (actionId === "placePhoto") return photoStamped;
      return false;
    },

    onCanvasClick(ndcX, ndcY, _w, _h, step) {
      if (step && (step.stage === 3 || step.stage === 6)) {
        // Move the Orange portal on the right wall!
        orangeOff = [clamp(ndcY * 0.55, -0.42, 0.55), clamp(-ndcX * 1.05, -1.05, 1.05)];
      } else if (step && step.stage === 7) {
        photoStamped = !photoStamped;
      } else if (step && step.stage === 4) {
        lookAway = !lookAway;
      }
    },

    getTechBadge(stepIdx) {
      return [
        "1994 · MARATHON OVERLAPPING ROOMS",
        sectorGlitch ? "1996 · BUILD SECTOR GLITCH!" : "1996 · DUKE3D SECTORS + MIRROR",
        "2006 · PREY FIXED 3D PORTALS",
        limitDepth1 ? "2007 · PORTAL (DEPTH = 1)" : "2007 · PORTAL (RECURSION = 8!)",
        "2013 · ANTICHAMBER SHIFTING ROOM",
        inspectOutside ? "2018 · OUTSIDE VIEW (1.8M BOX!)" : "2018 · CODEPARADE (22M INSIDE!)",
        "2022 · PORTAL RTX (LIGHT + SHADOWS)",
        photoStamped ? "2023 · VIEWFINDER (3D REALITY!)" : "2023 · VIEWFINDER (2D PHOTO)",
      ][stepIdx] || "WEBGL2";
    },

    resize() {},

    update(dt, paused) {
      if (!paused) simTime += dt;
      const tLook = lookAway ? 1.0 : 0.0;
      lookAwayAmt += (tLook - lookAwayAmt) * Math.min(1.0, dt * 4.2);
      // Antichamber trick: flip room variant cleanly at the peak of Look Away!
      if (lookAwayAmt > 0.82 && !wasTurned) {
        wasTurned = true;
        shiftState = (shiftState + 1.0) % 2.0;
      } else if (lookAwayAmt < 0.15) {
        wasTurned = false;
      }
      const tOut = inspectOutside ? 1.0 : 0.0;
      outsideAmt += (tOut - outsideAmt) * Math.min(1.0, dt * 2.8);
      const tPhoto = photoStamped ? 1.0 : 0.0;
      photoAmt += (tPhoto - photoAmt) * Math.min(1.0, dt * 5.0);
    },

    render(w, h, step, split, cam) {
      const aspect = w / Math.max(1, h);
      const stage = step.stage;

      // Per-stage optimal camera framing while respecting user orbit/zoom!
      let yaw = cam.yaw;
      let pitch = cam.pitch;
      let dist = cam.dist;
      let lookY = cam.lookY;

      if (stage === 0 || stage === 1) {
        // Gentle lateral sway across the center pillar so both overlapping Marathon/Duke rooms & mirror pop alive!
        yaw += Math.sin(simTime * 0.55) * 0.34;
        dist = clamp(cam.dist, 2.2, 3.15);
      } else if (stage === 2 || stage === 3 || stage === 6) {
        // Framed directly toward the glowing Back-Wall Blue Portal -> shows ALL 8 recursive tunnels + Companion Cube!
        yaw += 0.14 + Math.sin(simTime * 0.48) * 0.14;
        pitch += 0.02;
        dist = clamp(cam.dist * 0.74, 1.75, 2.38);
      } else if (stage === 4) {
        // Antichamber: Look Away spins camera toward pillar & snaps back revealing morphed geometry!
        yaw += Math.sin(lookAwayAmt * Math.PI) * 1.15;
        dist = clamp(cam.dist, 2.2, 3.2);
      } else if (stage === 5) {
        // CodeParade: at rest looks right into the 22m infinity hall; Inspect Outside orbits 105 deg sideways to prove it's a tiny 1.8m box!
        yaw += outsideAmt * 1.55 + Math.sin(simTime * 0.48) * 0.18;
        pitch += outsideAmt * 0.14;
        dist = clamp(cam.dist + 1.1 + outsideAmt * 1.35, 3.2, 6.2);
        lookY = 1.40;
      } else if (stage === 7) {
        // Viewfinder: gentle parallax sway makes the stamped 3D sandstone colonnade & sky pop out of the flat concrete wall!
        yaw += Math.sin(simTime * 0.62) * 0.34;
        dist = clamp(cam.dist, 2.1, 3.1);
      }

      const basis = cameraBasisFromOrbit(yaw, pitch, dist, lookY);
      const tanHalfFov = Math.tan(((cam.fovDeg || 58) * Math.PI) / 360);
      const stageLeft = split.enabled ? step.compareLeft : step.stage;
      const stageRight = split.enabled ? step.compareRight : step.stage;

      let debugOn = false;
      if (stage === 1) debugOn = sectorGlitch;
      else if (stage === 3) debugOn = limitDepth1;
      else if (stage === 4) debugOn = lookAway;
      else if (stage === 5) debugOn = inspectOutside;
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

      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      gl.bindVertexArray(null);
    },
  };
}
