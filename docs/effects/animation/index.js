// Evolution of Character Animation (1989-2020) — Real Xbot Rig + Real Mixamo Mocap WebGL2 Controller.
import { clamp, lerp, norm3, cameraBasisFromOrbit, makeLookAt, makePerspective, FULL_VS, linkPrograms } from "../../src/gl-utils.js";
import {
  loadXbotRig, buildArenaGeometry, getArenaHeight,
  sampleClipLocal, blendLocalPoses, evaluateFK, applyFootIK, evaluateTwistPose,
  createArticulatedRagdoll, createMotionMatcher,
} from "./rig.js";
import { SKY_FS, CHAR_VS, CHAR_FS, ARENA_VS, ARENA_FS, ROTO_VS, ROTO_FS, LINE_VS, LINE_FS } from "./shaders.js";

function mulMat4(a, b) {
  const o = new Float32Array(16);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      o[c*4 + r] = a[r]*b[c*4] + a[4+r]*b[c*4+1] + a[8+r]*b[c*4+2] + a[12+r]*b[c*4+3];
    }
  }
  return o;
}

function makeCharVao(gl, verts, indices) {
  const vao = gl.createVertexArray();
  gl.bindVertexArray(vao);
  const vbo = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
  gl.bufferData(gl.ARRAY_BUFFER, verts, gl.STATIC_DRAW);
  const stride = 15 * 4;
  gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 3, gl.FLOAT, false, stride, 0);
  gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 3, gl.FLOAT, false, stride, 12);
  gl.enableVertexAttribArray(2); gl.vertexAttribPointer(2, 4, gl.FLOAT, false, stride, 24);
  gl.enableVertexAttribArray(3); gl.vertexAttribPointer(3, 4, gl.FLOAT, false, stride, 40);
  gl.enableVertexAttribArray(4); gl.vertexAttribPointer(4, 1, gl.FLOAT, false, stride, 56);
  const ibo = gl.createBuffer();
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibo);
  gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, indices, gl.STATIC_DRAW);
  gl.bindVertexArray(null);
  return { vao, count: indices.length };
}

function makeArenaVao(gl, geom) {
  const vao = gl.createVertexArray();
  gl.bindVertexArray(vao);
  const vbo = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
  gl.bufferData(gl.ARRAY_BUFFER, geom.vertices, gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 32, 0);
  gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 32, 12);
  gl.enableVertexAttribArray(2); gl.vertexAttribPointer(2, 2, gl.FLOAT, false, 32, 24);
  const ibo = gl.createBuffer();
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibo);
  gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, geom.indices, gl.STATIC_DRAW);
  gl.bindVertexArray(null);
  return { vao, count: geom.indices.length };
}

export async function createAnimationEffect(gl) {
  const baseUrl = new URL("./", import.meta.url).href;
  const rig = await loadXbotRig(baseUrl);

  const [progSky, progChar, progArena, progRoto, progLine] = linkPrograms(gl, [
    [FULL_VS, SKY_FS],
    [CHAR_VS, CHAR_FS],
    [ARENA_VS, ARENA_FS],
    [ROTO_VS, ROTO_FS],
    [LINE_VS, LINE_FS],
  ]);

  const uLoc = (p, names) => Object.fromEntries(names.map(n => [n, gl.getUniformLocation(p, n)]));
  const uSky   = uLoc(progSky,   ["uRetro", "uTime"]);
  const uChar  = uLoc(progChar,  ["uViewProj", "uBones", "uBonesB", "uDqReal", "uDqDual", "uDeformMode", "uMorphT", "uCamPos", "uFlatShade", "uShowTwistPattern"]);
  const uArena = uLoc(progArena, ["uViewProj", "uPelvisPos", "uFootL", "uFootR", "uShowFootRings", "uFloorScroll", "uTime"]);
  const uRoto  = uLoc(progRoto,  ["uViewProj", "uPos", "uCamRight", "uTime"]);
  const uLine  = uLoc(progLine,  ["uViewProj", "uPointSize"]);

  const fullVao = gl.createVertexArray();
  const smoothChar = makeCharVao(gl, rig.smoothVerts, rig.smoothIdx);
  const retroChar  = makeCharVao(gl, rig.retroVerts,  rig.retroIdx);
  const arenas = [0, 1, 2].map(m => makeArenaVao(gl, buildArenaGeometry(m)));

  const lineVao = gl.createVertexArray();
  const lineVbo = gl.createBuffer();
  gl.bindVertexArray(lineVao);
  gl.bindBuffer(gl.ARRAY_BUFFER, lineVbo);
  gl.bufferData(gl.ARRAY_BUFFER, 1024 * 6 * 4, gl.DYNAMIC_DRAW);
  gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 24, 0);
  gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 24, 12);
  gl.bindVertexArray(null);

  const ragPassive = createArticulatedRagdoll(rig);
  const ragActive  = createArticulatedRagdoll(rig);
  const matcher = createMotionMatcher(rig);

  let simTime = 2.6;
  let showSkeleton = false;
  let twistActive = true;
  let ragTimer = 0;
  let lastMmFK = null;
  let lastMmClip = "walk";

  // Motion Matching interactive steering (WASD or exact 3D raycast click-to-move!)
  const mm = { x: -0.25, z: 0.15, yaw: 0.65, speed: 1.05, turnRate: 0.35, targetX: 1.4, targetZ: 0.7, manualTimer: 0, clickPulse: 0 };
  let lastMmCam = null;
  const keys = { w: false, a: false, s: false, d: false };
  window.addEventListener("keydown", ev => { const k = ev.key?.toLowerCase(); if (k in keys) keys[k] = true; });
  window.addEventListener("keyup",   ev => { const k = ev.key?.toLowerCase(); if (k in keys) keys[k] = false; });

  function resetRagdolls() {
    ragPassive.reset(0.55);
    ragActive.reset(0.55);
    ragPassive.push(1.0);
    ragActive.push(1.0);
    ragTimer = 0;
  }

  function drawLineData(vp, floats, mode, pointSize) {
    if (!floats.length) return;
    gl.useProgram(progLine);
    gl.bindVertexArray(lineVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, lineVbo);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, new Float32Array(floats));
    gl.uniformMatrix4fv(uLine.uViewProj, false, vp);
    gl.uniform1f(uLine.uPointSize, pointSize);
    gl.drawArrays(mode, 0, floats.length / 6);
  }

  function drawSkeletonOverlay(vp, worldPos) {
    const segs = [], pts = [];
    for (let i = 0; i < worldPos.length; i++) {
      const p = rig.parents[i];
      if (p >= 0) segs.push(...worldPos[p], 0.22, 0.96, 0.72, ...worldPos[i], 0.22, 0.96, 0.72);
      pts.push(...worldPos[i], 1.0, 0.95, 0.78);
    }
    gl.disable(gl.DEPTH_TEST);
    drawLineData(vp, segs, gl.LINES, 1.0);
    drawLineData(vp, pts, gl.POINTS, 7.5);
    gl.enable(gl.DEPTH_TEST);
  }

  function drawMotionMatchingOverlay(vp) {
    // Draw live chosen future trajectory (only while moving toward target -> zero yellow pile-up on arrival!)
    const segs = [], pts = [];
    const distToGoal = Math.hypot(mm.targetX - mm.x, mm.targetZ - mm.z);
    if (distToGoal > 0.20) {
      let px = mm.x, pz = mm.z, pyaw = mm.yaw;
      const maxSteps = Math.min(18, Math.max(4, Math.ceil(distToGoal / 0.16)));
      for (let i = 0; i < maxSteps; i++) {
        const f = i / maxSteps;
        const dx = mm.targetX - px, dz = mm.targetZ - pz;
        const rem = Math.hypot(dx, dz);
        if (rem < 0.08) break;
        const desYaw = Math.atan2(dx, dz);
        let dyaw = desYaw - pyaw;
        while (dyaw > Math.PI) dyaw -= Math.PI * 2;
        while (dyaw < -Math.PI) dyaw += Math.PI * 2;
        pyaw += dyaw * 0.34;
        const step = Math.min(rem, 0.17);
        const nx = px + Math.sin(pyaw) * step;
        const nz = pz + Math.cos(pyaw) * step;
        const y0 = getArenaHeight(px, pz, 2) + 0.05;
        const y1 = getArenaHeight(nx, nz, 2) + 0.05;
        const rC = lerp(0.14, 1.0, f), gC = lerp(0.98, 0.72, f), bC = lerp(0.68, 0.20, f);
        const sideX = Math.cos(pyaw) * 0.035, sideZ = -Math.sin(pyaw) * 0.035;
        for (const s of [-1, 0, 1]) {
          segs.push(px + sideX*s, y0, pz + sideZ*s, rC, gC, bC, nx + sideX*s, y1, nz + sideZ*s, rC, gC, bC);
        }
        if (i % 3 === 0) pts.push(nx, y1 + 0.02, nz, 1.0, 0.95, 0.35);
        if (i === 0) {
          for (const candOff of [-0.68, -0.34, 0.34, 0.68]) {
            let cx = mm.x, cz = mm.z, cy = mm.yaw + candOff;
            for (let k = 0; k < 5; k++) {
              const cnx = cx + Math.sin(cy) * 0.16, cnz = cz + Math.cos(cy) * 0.16;
              segs.push(cx, getArenaHeight(cx, cz, 2) + 0.04, cz, 0.95, 0.36, 0.18,
                        cnx, getArenaHeight(cnx, cnz, 2) + 0.04, cnz, 0.60, 0.20, 0.12);
              cx = cnx; cz = cnz;
            }
          }
        }
        px = nx; pz = nz;
      }
    }
    // Bright gold destination beacon ring (+ expanding pulse ripple right when clicked!)
    const ty = getArenaHeight(mm.targetX, mm.targetZ, 2) + 0.05;
    for (let k = 0; k < 16; k++) {
      const a0 = (k / 16) * Math.PI * 2, a1 = ((k + 1) / 16) * Math.PI * 2;
      segs.push(mm.targetX + Math.cos(a0)*0.22, ty, mm.targetZ + Math.sin(a0)*0.22, 1.0, 0.85, 0.24,
                mm.targetX + Math.cos(a1)*0.22, ty, mm.targetZ + Math.sin(a1)*0.22, 1.0, 0.85, 0.24);
      if (mm.clickPulse > 0.01) {
        const pr = 0.22 + (1.0 - mm.clickPulse) * 0.55;
        const pa = mm.clickPulse;
        segs.push(mm.targetX + Math.cos(a0)*pr, ty + 0.01, mm.targetZ + Math.sin(a0)*pr, 0.25*pa + 0.75, 0.98, 0.65*pa + 0.2,
                  mm.targetX + Math.cos(a1)*pr, ty + 0.01, mm.targetZ + Math.sin(a1)*pr, 0.25*pa + 0.75, 0.98, 0.65*pa + 0.2);
      }
    }
    pts.push(mm.targetX, ty + 0.02, mm.targetZ, 1.0, 0.95, 0.45);
    drawLineData(vp, segs, gl.LINES, 1.0);
    drawLineData(vp, pts, gl.POINTS, 10.5);
  }

  function getStairWalkState(t) {
    const cyc = ((t % 7.6) + 7.6) % 7.6;
    if (cyc < 2.8) {
      const u = cyc / 2.8;
      return { x: lerp(-1.35, 1.35, u), yaw: Math.PI * 0.5, moving: 1.0, phase: u * 2.65 };
    } else if (cyc < 3.8) {
      const u = (cyc - 2.8) / 1.0;
      const s = u * u * (3 - 2 * u);
      return { x: 1.35, yaw: lerp(Math.PI * 0.5, -Math.PI * 0.5, s), moving: 0.0, phase: 2.65 };
    } else if (cyc < 6.6) {
      const u = (cyc - 3.8) / 2.8;
      return { x: lerp(1.35, -1.35, u), yaw: -Math.PI * 0.5, moving: 1.0, phase: 2.65 + u * 2.65 };
    }
    const u = (cyc - 6.6) / 1.0;
    const s = u * u * (3 - 2 * u);
    return { x: -1.35, yaw: lerp(-Math.PI * 0.5, Math.PI * 0.5, s), moving: 0.0, phase: 5.30 };
  }

  function renderSingleStage(stage, vp, basis) {
    gl.disable(gl.DEPTH_TEST);
    gl.useProgram(progSky);
    gl.bindVertexArray(fullVao);
    gl.uniform1i(uSky.uRetro, stage === 0 ? 1 : 0);
    gl.uniform1f(uSky.uTime, simTime);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

    const arenaMode = (stage === 4 || stage === 6 || stage === 98 || stage === 99) ? 1 : (stage === 7 ? 2 : 0);
    let fk = null, fkB = null, morphT = 0.0;
    let deformMode = 3, useRetro = false, flatShade = 0, showTwist = 0.0;
    let floorScroll = [0.0, 0.0];

    if (stage === 0) {
      fk = { worldPos: [[0, 0.9, 0]] };
      floorScroll = [2.6, 0.0];
    } else if (stage === 1) {
      // 1992-93 Rigid 1-bone puppet walking forward on stride-matched scrolling tiles (zero treadmill skating!)
      const yaw = 0.52;
      fk = evaluateFK(rig, sampleClipLocal(rig, "walk", simTime * 1.05), [0, 0, 0], yaw);
      deformMode = 0; useRetro = true; flatShade = 1;
      floorScroll = [Math.sin(yaw) * 2.15, Math.cos(yaw) * 2.15];
    } else if (stage === 2) {
      // 1996 Quake MDL: 3.8 Hz discrete keyframes of real running mocap at 3/4 side view -> unmistakable chord shrinking!
      const fps = 3.8, kf = Math.floor(simTime * fps), yaw = 0.72;
      morphT = simTime * fps - kf;
      fk  = evaluateFK(rig, sampleClipLocal(rig, "run", kf / fps),       [0, 0, 0], yaw);
      fkB = evaluateFK(rig, sampleClipLocal(rig, "run", (kf + 1) / fps), [0, 0, 0], yaw);
      deformMode = 1;
      floorScroll = [Math.sin(yaw) * 3.85, Math.cos(yaw) * 3.85];
    } else if (stage === 3) {
      // 1998 Half-Life / LBS: smooth live 0° -> 205° -> 0° forearm twist -> watch it collapse into a candy wrapper!
      const twist = twistActive ? (0.52 - 0.48 * Math.cos(simTime * 1.45)) * Math.PI * 1.18 : 0.0;
      fk = evaluateTwistPose(rig, simTime, twist);
      deformMode = 2; showTwist = 1.0;
    } else if (stage === 5) {
      // 2007 Dual Quaternion Skinning (Kavan et al., I3D 2007) — exact same live 0° -> 205° twist, ZERO volume collapse!
      const twist = twistActive ? (0.52 - 0.48 * Math.cos(simTime * 1.45)) * Math.PI * 1.18 : 0.0;
      fk = evaluateTwistPose(rig, simTime, twist);
      deformMode = 3; showTwist = 1.0;
    } else if (stage === 4 || stage === 98) {
      // 2006-09 Smooth constant-speed stair walk + graceful 180° landing pivots (ZERO snaps, ZERO moonwalking!)
      const sw = getStairWalkState(simTime);
      const baseY = stage === 98
        ? clamp((sw.x + 1.40) / 2.80, 0, 1) * 5 * 0.13 + 0.09
        : getArenaHeight(sw.x, 0, 1);
      const pWalk = sampleClipLocal(rig, "walk", sw.phase);
      const pIdle = sampleClipLocal(rig, "idle", simTime);
      const pose = sw.moving > 0.5 ? pWalk : blendLocalPoses(pIdle, pWalk, 0.25);
      const rawFk = evaluateFK(rig, pose, [sw.x, baseY, 0], sw.yaw);
      fk = stage === 4 ? applyFootIK(rig, rawFk, 1, sw.yaw) : rawFk;
      deformMode = 3;
    } else if (stage === 6) {
      fk = ragActive.toFK(true);
      deformMode = 3;
    } else if (stage === 99) {
      fk = ragPassive.toFK(false);
      deformMode = 3;
    } else {
      fk = lastMmFK || evaluateFK(rig, sampleClipLocal(rig, "walk", simTime), [0, 0, 0], 0);
      deformMode = 3;
    }

    gl.enable(gl.DEPTH_TEST);
    const ar = arenas[arenaMode];
    gl.useProgram(progArena);
    gl.bindVertexArray(ar.vao);
    gl.uniformMatrix4fv(uArena.uViewProj, false, vp);
    gl.uniform3fv(uArena.uPelvisPos, fk.worldPos[0] || [0, 1.0, 0]);
    gl.uniform3fv(uArena.uFootL, fk.worldPos[16] || [0, 0, 0]);
    gl.uniform3fv(uArena.uFootR, fk.worldPos[20] || [0, 0, 0]);
    gl.uniform1f(uArena.uShowFootRings, (stage === 4 || stage === 7) ? 1.0 : 0.0);
    gl.uniform2fv(uArena.uFloorScroll, floorScroll);
    gl.uniform1f(uArena.uTime, simTime);
    gl.drawElements(gl.TRIANGLES, ar.count, gl.UNSIGNED_SHORT, 0);

    if (stage === 0) {
      gl.useProgram(progRoto);
      gl.bindVertexArray(fullVao);
      gl.uniformMatrix4fv(uRoto.uViewProj, false, vp);
      gl.uniform3f(uRoto.uPos, 0, 0, 0);
      gl.uniform3fv(uRoto.uCamRight, basis.right);
      gl.uniform1f(uRoto.uTime, simTime);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    } else {
      const ch = useRetro ? retroChar : smoothChar;
      gl.useProgram(progChar);
      gl.bindVertexArray(ch.vao);
      gl.uniformMatrix4fv(uChar.uViewProj, false, vp);
      gl.uniformMatrix4fv(uChar.uBones, false, fk.mats);
      gl.uniformMatrix4fv(uChar.uBonesB, false, (fkB || fk).mats);
      gl.uniform4fv(uChar.uDqReal, fk.dqReal);
      gl.uniform4fv(uChar.uDqDual, fk.dqDual);
      gl.uniform1i(uChar.uDeformMode, deformMode);
      gl.uniform1f(uChar.uMorphT, morphT);
      gl.uniform3fv(uChar.uCamPos, basis.pos);
      gl.uniform1i(uChar.uFlatShade, flatShade);
      gl.uniform1f(uChar.uShowTwistPattern, showTwist);
      gl.drawElements(gl.TRIANGLES, ch.count, gl.UNSIGNED_SHORT, 0);

      if (stage === 7) drawMotionMatchingOverlay(vp);
      if (showSkeleton) drawSkeletonOverlay(vp, fk.worldPos);
    }
  }

  return {
    id: "animation",
    maxPixels: 920000,
    defaultCamera: {
      yaw: 0.16,
      pitch: 0.17,
      dist: 3.35,
      lookY: 1.02,
      fovDeg: 44,
      minDist: 1.35,
      maxDist: 6.4,
      minPitch: -0.05,
      maxPitch: 0.85,
      autoOrbitSpeed: 0.0,
    },

    enterStep(stepIdx) {
      if (stepIdx === 6) resetRagdolls();
      if (stepIdx === 3 || stepIdx === 5) twistActive = true;
    },

    onReset() {
      showSkeleton = false;
      twistActive = true;
      resetRagdolls();
    },

    triggerAction(actionId) {
      if (actionId === "twist") twistActive = !twistActive;
      else if (actionId === "push") resetRagdolls();
      else if (actionId === "skeleton") showSkeleton = !showSkeleton;
    },

    isActionActive(actionId) {
      if (actionId === "twist") return twistActive;
      if (actionId === "skeleton") return showSkeleton;
      return false;
    },

    onCanvasClick(ndcX, ndcY, w, h, step) {
      if (step?.stage === 6) {
        resetRagdolls();
        return;
      }
      if (!lastMmCam) return;
      // Exact 3D raycast from clicked pixel through active Stage 7 camera (handles Split off-center frustum & orbit!)
      const rx = (ndcX - lastMmCam.ndcShiftX) * lastMmCam.aspect * lastMmCam.tanHalfFov;
      const ry = ndcY * lastMmCam.tanHalfFov;
      const dir = norm3(
        lastMmCam.fwd[0] + lastMmCam.right[0] * rx + lastMmCam.up[0] * ry,
        lastMmCam.fwd[1] + lastMmCam.right[1] * rx + lastMmCam.up[1] * ry,
        lastMmCam.fwd[2] + lastMmCam.right[2] * rx + lastMmCam.up[2] * ry
      );
      if (dir[1] >= -0.02) return; // Clicked sky above horizon
      // Iterative intersection with exact uneven courtyard surface y = getArenaHeight(x, z, 2)
      let hy = 0.08, hx = mm.x, hz = mm.z;
      for (let it = 0; it < 6; it++) {
        const t = (hy - lastMmCam.pos[1]) / dir[1];
        if (t <= 0.1 || t > 35.0) return;
        hx = lastMmCam.pos[0] + dir[0] * t;
        hz = lastMmCam.pos[2] + dir[2] * t;
        hy = getArenaHeight(hx, hz, 2);
      }
      mm.targetX = clamp(hx, -2.85, 2.85);
      mm.targetZ = clamp(hz, -2.85, 2.85);
      mm.manualTimer = 14.0;
      mm.clickPulse = 1.0;
    },

    getTechBadge(stepIdx) {
      const labels = [
        "1989 · PRINCE OF PERSIA · 12 FPS ROTOSCOPE",
        "1992–93 · RIGID POLYGON PUPPET (1-BONE)",
        "1996 · QUAKE MDL · PER-VERTEX MORPHING",
        "1998 · HALF-LIFE / LBS · 190° CANDY-WRAPPER",
        "2006–09 · MIXAMO WALK + 2-BONE FOOT IK",
        "2007 · DUAL QUATERNION SKINNING (KAVAN)",
        "2008 · LIMP RAGDOLL vs ACTIVE EUPHORIA",
        `2016–20 · MOTION MATCH (${lastMmClip.toUpperCase()}) + INERTIALIZATION`,
      ];
      return labels[stepIdx] || "CHARACTER ANIMATION";
    },

    resize() {},

    update(dt, paused) {
      if (paused) return;
      const h = Math.min(dt, 0.04);
      simTime += h;

      ragTimer += h;
      if (ragTimer > 4.6) resetRagdolls();
      ragPassive.step(h, false);
      ragActive.step(h, true);

      mm.clickPulse = Math.max(0, mm.clickPulse - h * 2.4);
      // Motion Matching steering: exact point-to-click / WASD or autonomous figure-8 patrol!
      const kx = (keys.d ? 1 : 0) - (keys.a ? 1 : 0);
      const kz = (keys.s ? 1 : 0) - (keys.w ? 1 : 0);
      let wantSpeed = 1.0;
      if (kx || kz) {
        mm.targetX = clamp(mm.x + kx * 1.6, -2.85, 2.85);
        mm.targetZ = clamp(mm.z + kz * 1.6, -2.85, 2.85);
        mm.manualTimer = 8.0;
        wantSpeed = 1.32;
      } else if (mm.manualTimer > 0) {
        mm.manualTimer = Math.max(0, mm.manualTimer - h);
        const d = Math.hypot(mm.targetX - mm.x, mm.targetZ - mm.z);
        wantSpeed = d > 1.05 ? 1.32 : (d > 0.14 ? clamp(d * 1.15, 0.45, 0.88) : 0.0);
      } else {
        // Front-facing scenic courtyard patrol loop so you see Xbot's face, banking turns & glowing spline!
        const cyc = simTime % 10.0;
        if (cyc < 1.1) {
          wantSpeed = 0.0;
        } else {
          const ang = simTime * 0.56;
          mm.targetX = Math.sin(ang) * 1.75;
          mm.targetZ = Math.cos(ang) * 1.15 + 0.25;
          wantSpeed = (cyc > 4.2 && cyc < 8.6) ? 1.32 : 0.78;
        }
      }

      const dx = mm.targetX - mm.x, dz = mm.targetZ - mm.z;
      const dist = Math.hypot(dx, dz);
      const desYaw = dist > 0.12 ? Math.atan2(dx, dz) : mm.yaw;
      let dyaw = desYaw - mm.yaw;
      while (dyaw > Math.PI) dyaw -= Math.PI * 2;
      while (dyaw < -Math.PI) dyaw += Math.PI * 2;
      const turnGain = mm.manualTimer > 0 ? 9.5 : 5.5;
      mm.turnRate = lerp(mm.turnRate, clamp(dyaw * 2.4, -2.5, 2.5), Math.min(1, h * 8.0));
      mm.yaw += dyaw * Math.min(1, h * turnGain);
      mm.speed = lerp(mm.speed, dist > 0.12 ? wantSpeed : 0.0, Math.min(1, h * 6.0));
      const worldSpd = mm.speed > 0.96 ? 1.95 : (mm.speed > 0.16 ? 1.05 : 0.0);
      const prevX = mm.x, prevZ = mm.z;
      const moveStep = Math.min(dist, worldSpd * h);
      mm.x = clamp(mm.x + Math.sin(mm.yaw) * moveStep, -2.85, 2.85);
      mm.z = clamp(mm.z + Math.cos(mm.yaw) * moveStep, -2.85, 2.85);
      const actualMove = Math.hypot(mm.x - prevX, mm.z - prevZ);

      const res = matcher.evaluate(h, mm.speed, actualMove, mm.turnRate, mm.x, mm.z, mm.yaw, 2);
      lastMmFK = res.fk;
      lastMmClip = res.activeClip;
    },

    render(w, h, step, split, cam) {
      const aspect = w / Math.max(1, h);

      // Compute stage-centered focus target so walking/stair-climbing/falling Xbot stays framed cleanly!
      const focusFor = (st) => {
        if (st === 4 || st === 98) {
          const sw = getStairWalkState(simTime);
          return [sw.x, getArenaHeight(sw.x, 0, 1) + 0.94, 0];
        }
        if (st === 6)  return [ragActive.state.x,  getArenaHeight(ragActive.state.x, 0, 1) + 0.90, 0];
        if (st === 99) return [ragPassive.state.x, getArenaHeight(ragPassive.state.x, 0, 1) + 0.52, 0];
        if (st === 7)  return [mm.x * 0.45, getArenaHeight(mm.x, mm.z, 2) + 0.94, mm.z * 0.45];
        if (st === 3 || st === 5) return [0, 1.16, 0];
        return [0, cam.lookY || 1.02, 0];
      };

      const buildViewProj = (st, ndcShiftX) => {
        const foc = focusFor(st);
        const distScale = (st === 3 || st === 5) ? 0.80 : (st === 7 ? 1.24 : 1.0);
        const fovRad = ((cam.fovDeg || 44) * Math.PI) / 180;
        const basis = cameraBasisFromOrbit(cam.yaw, cam.pitch, cam.dist * distScale, foc[1]);
        basis.pos[0] += foc[0]; basis.pos[2] += foc[2];
        basis.target[0] += foc[0]; basis.target[2] += foc[2];
        const view = makeLookAt(basis.pos, basis.target, [0, 1, 0]);
        const proj = makePerspective(fovRad, aspect, 0.1, 40.0);
        // Frustum off-center shift puts target cleanly at left/right pane center without distorting angles!
        proj[8] -= ndcShiftX;
        if (st === 7) {
          lastMmCam = {
            pos: [...basis.pos], fwd: [...basis.fwd], right: [...basis.right], up: [...basis.up],
            tanHalfFov: Math.tan(fovRad * 0.5), aspect, ndcShiftX,
          };
        }
        return { vp: mulMat4(proj, view), basis };
      };

      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, w, h);
      gl.disable(gl.BLEND);

      if (split.enabled) {
        const sx = Math.max(1, Math.min(w - 1, Math.round(split.pos * w)));
        // Symmetric forearm twist stages (LBS vs DQS) keep Xbot dead-center so divider splits left/right arms!
        const isCenterSplit = (step.stage === 3 || step.stage === 5);
        const leftShift  = isCenterSplit ? 0.0 : -(1.0 - split.pos);
        const rightShift = isCenterSplit ? 0.0 : split.pos;

        gl.enable(gl.SCISSOR_TEST);
        gl.scissor(0, 0, sx, h);
        gl.clear(gl.DEPTH_BUFFER_BIT);
        const camL = buildViewProj(step.compareLeft, leftShift);
        renderSingleStage(step.compareLeft, camL.vp, camL.basis);

        gl.scissor(sx, 0, w - sx, h);
        gl.clear(gl.DEPTH_BUFFER_BIT);
        const camR = buildViewProj(step.compareRight, rightShift);
        renderSingleStage(step.compareRight, camR.vp, camR.basis);
        gl.disable(gl.SCISSOR_TEST);
      } else {
        gl.disable(gl.SCISSOR_TEST);
        gl.clear(gl.DEPTH_BUFFER_BIT);
        const camC = buildViewProj(step.stage, 0.0);
        renderSingleStage(step.stage, camC.vp, camC.basis);
      }
      gl.bindVertexArray(null);
    },
  };
}
