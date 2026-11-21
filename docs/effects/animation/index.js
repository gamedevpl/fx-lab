// Evolution of Character Animation (1989-2020) — Interactive WebGL2 Controller.
//   0: 1989      Prince of Persia Rotoscoped 2D Sprites (12 fps VHS-traced silhouette)
//   1: 1992-93   Alone in the Dark / Virtua Fighter Rigid Faceted Polygon Puppet
//   2: 1996      Quake MDL Per-Vertex Keyframe Morphing (chord shrinking / swimming limbs!)
//   3: 1998      Half-Life Skeletal & LBS Candy-Wrapper Collapse (180° wrist twist!)
//   4: 2006-09   Gears of War UE3 Blend Trees & Foot IK on Uneven Stairs (GDC 2009 / FABRIK 2011)
//   5: 2007      Dual Quaternion Skinning (Ladislav Kavan et al., I3D 2007 — kills candy-wrapper!)
//   6: 2008      Ragdoll -> Active Physics (Trespasser '98 / Hitman '00 -> GTA IV Euphoria 2008!)
//   7: 2016-20   Motion Matching & Neural Locomotion (For Honor '16 · Inertialization '17 · PFNN '17 · LMM '20)

import { clamp, lerp, cameraBasisFromOrbit, makeLookAt, makePerspective, FULL_VS, linkPrograms } from "../../src/gl-utils.js";
import {
  BONE_PARENTS, buildCharacterGeometry, buildRigidPuppetGeometry, buildArenaGeometry,
  evaluateWalkPose, createRagdollSim, getArenaHeight,
} from "./mesh.js";
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

function makeCharVao(gl, geom) {
  const vao = gl.createVertexArray();
  gl.bindVertexArray(vao);
  const vbo = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
  gl.bufferData(gl.ARRAY_BUFFER, geom.vertices, gl.STATIC_DRAW);
  const stride = 13 * 4;
  gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 3, gl.FLOAT, false, stride, 0);
  gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 3, gl.FLOAT, false, stride, 12);
  gl.enableVertexAttribArray(2); gl.vertexAttribPointer(2, 2, gl.FLOAT, false, stride, 24);
  gl.enableVertexAttribArray(3); gl.vertexAttribPointer(3, 2, gl.FLOAT, false, stride, 32);
  gl.enableVertexAttribArray(4); gl.vertexAttribPointer(4, 2, gl.FLOAT, false, stride, 40);
  gl.enableVertexAttribArray(5); gl.vertexAttribPointer(5, 1, gl.FLOAT, false, stride, 48);
  const ibo = gl.createBuffer();
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibo);
  gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, geom.indices, gl.STATIC_DRAW);
  gl.bindVertexArray(null);
  return { vao, count: geom.indices.length };
}

function makeArenaVao(gl, geom) {
  const vao = gl.createVertexArray();
  gl.bindVertexArray(vao);
  const vbo = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
  gl.bufferData(gl.ARRAY_BUFFER, geom.vertices, gl.STATIC_DRAW);
  const stride = 8 * 4;
  gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 3, gl.FLOAT, false, stride, 0);
  gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 3, gl.FLOAT, false, stride, 12);
  gl.enableVertexAttribArray(2); gl.vertexAttribPointer(2, 2, gl.FLOAT, false, stride, 24);
  const ibo = gl.createBuffer();
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibo);
  gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, geom.indices, gl.STATIC_DRAW);
  gl.bindVertexArray(null);
  return { vao, count: geom.indices.length };
}

export function createAnimationEffect(gl) {
  const [progSky, progChar, progArena, progRoto, progLine] = linkPrograms(gl, [
    [FULL_VS, SKY_FS],
    [CHAR_VS, CHAR_FS],
    [ARENA_VS, ARENA_FS],
    [ROTO_VS, ROTO_FS],
    [LINE_VS, LINE_FS],
  ]);

  const uLoc = (p, names) => Object.fromEntries(names.map(n => [n, gl.getUniformLocation(p, n)]));
  const uSky   = uLoc(progSky,   ["uRetro"]);
  const uChar  = uLoc(progChar,  ["uViewProj", "uBones", "uBonesB", "uDqReal", "uDqDual", "uDeformMode", "uMorphT", "uCamPos", "uFlatShade"]);
  const uArena = uLoc(progArena, ["uViewProj", "uPelvisPos", "uFootL", "uFootR", "uShowFootRings", "uTime"]);
  const uRoto  = uLoc(progRoto,  ["uViewProj", "uPos", "uCamRight", "uTime"]);
  const uLine  = uLoc(progLine,  ["uViewProj", "uPointSize"]);

  const fullVao = gl.createVertexArray();
  const smoothChar = makeCharVao(gl, buildCharacterGeometry());
  const rigidChar  = makeCharVao(gl, buildRigidPuppetGeometry());
  const arenas = [
    makeArenaVao(gl, buildArenaGeometry(0)),
    makeArenaVao(gl, buildArenaGeometry(1)),
    makeArenaVao(gl, buildArenaGeometry(2)),
  ];

  // Dynamic VBO for X-Ray skeleton bones + Motion Matching trajectory curve
  const lineVao = gl.createVertexArray();
  const lineVbo = gl.createBuffer();
  gl.bindVertexArray(lineVao);
  gl.bindBuffer(gl.ARRAY_BUFFER, lineVbo);
  gl.bufferData(gl.ARRAY_BUFFER, 512 * 6 * 4, gl.DYNAMIC_DRAW);
  gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 24, 0);
  gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 24, 12);
  gl.bindVertexArray(null);

  // Two parallel ragdoll instances so Split-Screen compares Passive Limp vs Active Euphoria simultaneously!
  const ragPassive = createRagdollSim();
  const ragActive  = createRagdollSim();

  let simTime = 0;
  let showSkeleton = false;
  let twistActive = true;
  let ragTimer = 0;

  // Motion Matching autonomous + interactive click/WASD steering state (Stage 7)
  const mm = {
    x: 0.0, z: 0.0, yaw: 0.4, speed: 1.0, lean: 0.0,
    targetX: 1.1, targetZ: 0.6, manualTimer: 0.0,
  };
  const keys = { w: false, a: false, s: false, d: false };
  const onKey = (down) => (ev) => {
    const k = ev.key?.toLowerCase();
    if (k in keys) keys[k] = down;
  };
  window.addEventListener("keydown", onKey(true));
  window.addEventListener("keyup", onKey(false));

  function resetRagdolls() {
    ragPassive.reset(-0.20, 0.0, 1);
    ragActive.reset(-0.20, 0.0, 1);
    ragPassive.push(1.05);
    ragActive.push(1.05);
    ragTimer = 0;
  }

  function stageArenaMode(stage) {
    if (stage === 4 || stage === 6) return 1; // Stepped stone stairs for Foot IK & Ragdoll!
    if (stage === 7) return 2;                // Terraced undulating arena for Motion Matching!
    return 0;                                 // Clean studio floor for Rotoscope / Puppet / Quake / LBS / DQS!
  }

  function drawLineData(vp, floats, mode, pointSize = 7.0) {
    if (!floats.length) return;
    gl.useProgram(progLine);
    gl.bindVertexArray(lineVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, lineVbo);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, new Float32Array(floats));
    gl.uniformMatrix4fv(uLine.uViewProj, false, vp);
    gl.uniform1f(uLine.uPointSize, pointSize);
    gl.drawArrays(mode, 0, floats.length / 6);
  }

  function drawSkeletonOverlay(vp, worldPos, isHero) {
    const segs = [];
    const pts = [];
    const boneCol = isHero ? [0.22, 0.96, 0.72] : [1.0, 0.78, 0.24];
    const jointCol = [1.0, 0.96, 0.82];
    for (let i = 0; i < worldPos.length; i++) {
      const p = BONE_PARENTS[i];
      if (p >= 0) {
        segs.push(...worldPos[p], ...boneCol, ...worldPos[i], ...boneCol);
      }
      pts.push(...worldPos[i], ...jointCol);
    }
    gl.disable(gl.DEPTH_TEST);
    drawLineData(vp, segs, gl.LINES, 1.0);
    drawLineData(vp, pts, gl.POINTS, 8.0);
    gl.enable(gl.DEPTH_TEST);
  }

  function drawTrajectoryRibbon(vp) {
    // Glowing predicted Motion Matching future path + candidate footstep nodes!
    const segs = [];
    const pts = [];
    let px = mm.x, pz = mm.z, pyaw = mm.yaw;
    for (let i = 0; i <= 14; i++) {
      const f = i / 14;
      const dx = mm.targetX - px, dz = mm.targetZ - pz;
      const desYaw = Math.atan2(dx, dz);
      let dyaw = desYaw - pyaw;
      while (dyaw > Math.PI) dyaw -= Math.PI * 2;
      while (dyaw < -Math.PI) dyaw += Math.PI * 2;
      pyaw += dyaw * 0.22;
      const nx = px + Math.sin(pyaw) * 0.14;
      const nz = pz + Math.cos(pyaw) * 0.14;
      const y0 = getArenaHeight(px, pz, 2) + 0.04;
      const y1 = getArenaHeight(nx, nz, 2) + 0.04;
      const col = [lerp(0.24, 1.0, f), lerp(0.95, 0.55, f), lerp(0.88, 0.22, f)];
      segs.push(px, y0, pz, ...col, nx, y1, nz, ...col);
      if (i % 3 === 0) pts.push(nx, y1 + 0.01, nz, 1.0, 0.92, 0.35);
      px = nx; pz = nz;
    }
    drawLineData(vp, segs, gl.LINES, 1.0);
    drawLineData(vp, pts, gl.POINTS, 9.0);
  }

  function renderSingleStage(stage, vp, basis) {
    // 1) Background sky gradient
    gl.disable(gl.DEPTH_TEST);
    gl.useProgram(progSky);
    gl.bindVertexArray(fullVao);
    gl.uniform1i(uSky.uRetro, stage === 0 ? 1 : 0);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

    // 2) Compute character pose & skinning for this historical stage
    const arenaMode = stageArenaMode(stage);
    let sk = null, skB = null, morphT = 0.0;
    let deformMode = 3; // default DQS
    let useRigidMesh = false;
    let flatShade = 0;

    if (stage === 0) {
      // 1989 Prince of Persia: 2D rotoscoped sprite running smoothly across the studio floor
      sk = { worldPos: [[0, 0.92, 0]], footTargets: [[0, 0, 0], [0, 0, 0]] };
    } else if (stage === 1) {
      // 1992-93 Alone in the Dark / Virtua Fighter: rigid disconnected faceted polygon puppet
      sk = evaluateWalkPose(simTime, { posX: 0, posZ: 0, facingYaw: 0.35, speed: 0.95 });
      deformMode = 0; useRigidMesh = true; flatShade = 1;
    } else if (stage === 2) {
      // 1996 Quake MDL: 8 fps discrete vertex keyframes linearly morphed -> limbs shrink mid-arc!
      const fps = 4.5;
      const kf = Math.floor(simTime * fps);
      morphT = simTime * fps - kf;
      sk  = evaluateWalkPose(kf / fps,       { posX: 0, posZ: 0, facingYaw: 0.45, speed: 1.35 });
      skB = evaluateWalkPose((kf + 1) / fps, { posX: 0, posZ: 0, facingYaw: 0.45, speed: 1.35 });
      deformMode = 1;
    } else if (stage === 3) {
      // 1998 Half-Life -> Linear Blend Skinning (LBS): dramatic 190° forearm twist -> Candy-Wrapper Collapse!
      const twist = twistActive ? (0.72 + 0.28 * Math.sin(simTime * 1.6)) * Math.PI * 1.12 : 0.0;
      sk = evaluateWalkPose(simTime, { posX: 0.0, posZ: 0, facingYaw: 0.02, twistMode: true, twistAngle: twist });
      deformMode = 2; // Genuine LBS matrix blend!
    } else if (stage === 4) {
      // 2006-09 Gears of War Blend Trees & Foot IK on Uneven Stone Stairs!
      const walkX = Math.sin(simTime * 0.65) * 1.05;
      const dir = Math.cos(simTime * 0.65) >= 0 ? Math.PI * 0.5 : -Math.PI * 0.5;
      sk = evaluateWalkPose(simTime, { posX: walkX, posZ: 0.0, facingYaw: dir, speed: 0.95, useIK: true, stairsMode: 1 });
      deformMode = 3;
    } else if (stage === 5) {
      // 2007 Dual Quaternion Skinning (Kavan et al., I3D 2007) — exact same 190° twist, ZERO candy-wrapper pinch!
      const twist = twistActive ? (0.72 + 0.28 * Math.sin(simTime * 1.6)) * Math.PI * 1.12 : 0.0;
      sk = evaluateWalkPose(simTime, { posX: 0.0, posZ: 0, facingYaw: 0.02, twistMode: true, twistAngle: twist });
      deformMode = 3; // Exact GPU Dual Quaternion Skinning!
    } else if (stage === 6) {
      // 2008 Ragdoll (Trespasser/Hitman) vs Active Euphoria PD-Muscles (GTA IV)!
      sk = ragActive.toSkinning();
      deformMode = 3;
    } else if (stage === 98) {
      // Special split-left helper: Foot IK OFF on stairs (floating/clipping boots!)
      const walkX = Math.sin(simTime * 0.65) * 1.05;
      const dir = Math.cos(simTime * 0.65) >= 0 ? Math.PI * 0.5 : -Math.PI * 0.5;
      sk = evaluateWalkPose(simTime, { posX: walkX, posZ: 0.0, facingYaw: dir, speed: 0.95, useIK: false, stairsMode: 1 });
      deformMode = 3;
    } else if (stage === 99) {
      // Special split-left helper: Passive limp ragdoll (Hitman 2000) vs Active Euphoria (GTA IV 2008)
      sk = ragPassive.toSkinning();
      deformMode = 3;
    } else {
      // Stage 7: 2016-20 Motion Matching + Inertialization + Foot IK + DQS on uneven terraced arena!
      sk = evaluateWalkPose(simTime, {
        posX: mm.x, posZ: mm.z, facingYaw: mm.yaw, speed: mm.speed,
        useIK: true, stairsMode: 2, leanRoll: mm.lean,
      });
      deformMode = 3;
    }

    // 3) Render Arena / Stone Staircase
    gl.enable(gl.DEPTH_TEST);
    const ar = arenas[arenaMode];
    gl.useProgram(progArena);
    gl.bindVertexArray(ar.vao);
    gl.uniformMatrix4fv(uArena.uViewProj, false, vp);
    const pPos = sk.worldPos[0] || [0, 0.9, 0];
    const fL = sk.worldPos[9]  || sk.footTargets?.[0] || [0, 0, 0];
    const fR = sk.worldPos[12] || sk.footTargets?.[1] || [0, 0, 0];
    gl.uniform3fv(uArena.uPelvisPos, pPos);
    gl.uniform3fv(uArena.uFootL, fL);
    gl.uniform3fv(uArena.uFootR, fR);
    gl.uniform1f(uArena.uShowFootRings, (stage === 4 || stage === 7) ? 1.0 : 0.0);
    gl.uniform1f(uArena.uTime, simTime);
    gl.drawElements(gl.TRIANGLES, ar.count, gl.UNSIGNED_SHORT, 0);

    // 4) Render Character (2D Rotoscope Billboard for Stage 0, or Real 3D Skinned Mesh for Stages 1..7)
    if (stage === 0) {
      gl.useProgram(progRoto);
      gl.bindVertexArray(fullVao);
      gl.uniformMatrix4fv(uRoto.uViewProj, false, vp);
      gl.uniform3f(uRoto.uPos, 0.0, 0.0, 0.0);
      gl.uniform3fv(uRoto.uCamRight, basis.right);
      gl.uniform1f(uRoto.uTime, simTime);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    } else {
      const ch = useRigidMesh ? rigidChar : smoothChar;
      gl.useProgram(progChar);
      gl.bindVertexArray(ch.vao);
      gl.uniformMatrix4fv(uChar.uViewProj, false, vp);
      gl.uniformMatrix4fv(uChar.uBones, false, sk.mats);
      gl.uniformMatrix4fv(uChar.uBonesB, false, (skB || sk).mats);
      gl.uniform4fv(uChar.uDqReal, sk.dqReal);
      gl.uniform4fv(uChar.uDqDual, sk.dqDual);
      gl.uniform1i(uChar.uDeformMode, deformMode);
      gl.uniform1f(uChar.uMorphT, morphT);
      gl.uniform3fv(uChar.uCamPos, basis.pos);
      gl.uniform1i(uChar.uFlatShade, flatShade);
      gl.drawElements(gl.TRIANGLES, ch.count, gl.UNSIGNED_SHORT, 0);

      if (showSkeleton || stage === 4 || stage === 7) {
        if (stage === 7) drawTrajectoryRibbon(vp);
        if (showSkeleton) drawSkeletonOverlay(vp, sk.worldPos, stage === 5 || stage === 7);
      }
    }
  }

  return {
    id: "animation",
    maxPixels: 920000,
    defaultCamera: {
      yaw: 0.28,
      pitch: 0.20,
      dist: 3.15,
      lookY: 1.08,
      fovDeg: 46,
      minDist: 1.45,
      maxDist: 6.2,
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

    // Clicking arena pushes ragdoll (Stage 6), toggles twist (Stage 3/5), or sets Motion Matching destination (Stage 7)!
    onCanvasClick(ndcX, ndcY) {
      mm.targetX = clamp(ndcX * 1.9, -1.8, 1.8);
      mm.targetZ = clamp(-ndcY * 1.9, -1.7, 1.7);
      mm.manualTimer = 6.0;
      resetRagdolls();
    },

    getTechBadge(stepIdx) {
      const labels = [
        "1989 · PRINCE OF PERSIA · 12 FPS ROTOSCOPE",
        "1992–93 · ALONE IN THE DARK / VIRTUA FIGHTER",
        "1996 · QUAKE MDL · PER-VERTEX MORPHING",
        "1998 · HALF-LIFE / LBS · 180° CANDY-WRAPPER",
        "2006–09 · BLEND TREES & 2-BONE FOOT IK",
        "2007 · DUAL QUATERNION SKINNING (KAVAN)",
        "2008 · PASSIVE RAGDOLL vs ACTIVE EUPHORIA",
        "2016–20 · MOTION MATCHING + INERTIALIZATION",
      ];
      return labels[stepIdx] || "CHARACTER ANIMATION";
    },

    resize() {},

    update(dt, paused) {
      if (paused) return;
      const h = Math.min(dt, 0.05);
      simTime += h;

      // Step Ragdolls & periodically auto-repush every 4.2s so Stage 6 stays lively!
      ragTimer += h;
      if (ragTimer > 4.2) resetRagdolls();
      ragPassive.step(h, false, 1);
      ragActive.step(h, true, 1);

      // Update Motion Matching autonomous figure-8 / interactive WASD/click steering
      const keyX = (keys.d ? 1 : 0) - (keys.a ? 1 : 0);
      const keyZ = (keys.s ? 1 : 0) - (keys.w ? 1 : 0);
      if (keyX || keyZ) {
        mm.targetX = clamp(mm.x + keyX * 1.2, -1.8, 1.8);
        mm.targetZ = clamp(mm.z + keyZ * 1.2, -1.7, 1.7);
        mm.manualTimer = 3.0;
      } else if (mm.manualTimer > 0) {
        mm.manualTimer = Math.max(0, mm.manualTimer - h);
      } else {
        // Smooth figure-8 patrol over the terraced hills
        mm.targetX = Math.sin(simTime * 0.55) * 1.45;
        mm.targetZ = Math.sin(simTime * 1.10) * 0.95;
      }
      const dx = mm.targetX - mm.x, dz = mm.targetZ - mm.z;
      const dist = Math.hypot(dx, dz);
      const desYaw = dist > 0.08 ? Math.atan2(dx, dz) : mm.yaw;
      let dyaw = desYaw - mm.yaw;
      while (dyaw > Math.PI) dyaw -= Math.PI * 2;
      while (dyaw < -Math.PI) dyaw += Math.PI * 2;
      mm.yaw += dyaw * Math.min(1, h * 5.2);
      mm.lean = lerp(mm.lean, clamp(-dyaw * 0.35, -0.25, 0.25), Math.min(1, h * 6.0));
      const spd = clamp(dist * 1.4, 0.0, 1.15);
      mm.speed = lerp(mm.speed, spd, Math.min(1, h * 5.0));
      mm.x = clamp(mm.x + Math.sin(mm.yaw) * mm.speed * h * 1.15, -1.9, 1.9);
      mm.z = clamp(mm.z + Math.cos(mm.yaw) * mm.speed * h * 1.15, -1.8, 1.8);
    },

    render(w, h, step, split, cam) {
      const aspect = w / Math.max(1, h);
      const basis = cameraBasisFromOrbit(cam.yaw, cam.pitch, cam.dist, cam.lookY);
      const view = makeLookAt(basis.pos, basis.target, [0, 1, 0]);
      const proj = makePerspective(((cam.fovDeg || 46) * Math.PI) / 180, aspect, 0.1, 40.0);
      const vp = mulMat4(proj, view);

      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, w, h);
      gl.disable(gl.BLEND);

      if (split.enabled) {
        const sx = Math.max(1, Math.min(w - 1, Math.round(split.pos * w)));
        gl.enable(gl.SCISSOR_TEST);
        // Left side of split
        gl.scissor(0, 0, sx, h);
        gl.clear(gl.DEPTH_BUFFER_BIT);
        renderSingleStage(step.compareLeft, vp, basis);
        // Right side of split
        gl.scissor(sx, 0, w - sx, h);
        gl.clear(gl.DEPTH_BUFFER_BIT);
        renderSingleStage(step.compareRight, vp, basis);
        gl.disable(gl.SCISSOR_TEST);
      } else {
        gl.disable(gl.SCISSOR_TEST);
        gl.clear(gl.DEPTH_BUFFER_BIT);
        renderSingleStage(step.stage, vp, basis);
      }
      gl.bindVertexArray(null);
    },
  };
}
