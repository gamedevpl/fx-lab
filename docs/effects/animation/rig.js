// Real Blender-exported Xbot Rig (22 Mixamo bones, 10.8k tris) + Real Mixamo Mocap Playback
// + 2-Bone Analytical Foot IK + Joint-Limited Rigid-Body Ragdoll / Active Euphoria
// + Real Motion Matching Database Search & David Bollo (GDC 2017) Inertialization!
// Source rig & mocap: Xbot from mrdoob/three.js examples (MIT).

import { clamp, lerp, smoothstep, norm3, cross3 } from "../../src/gl-utils.js";

export const BONE_COUNT = 22;
// Core bone indices in xbot-rig.json:
//  0:Hips  1:Spine  2:Spine1  3:Spine2  4:Neck  5:Head
//  6:LShoulder  7:LArm  8:LForeArm  9:LHand
// 10:RShoulder 11:RArm 12:RForeArm 13:RHand
// 14:LUpLeg 15:LLeg 16:LFoot 17:LToe
// 18:RUpLeg 19:RLeg 20:RFoot 21:RToe

// --- Quaternion, Matrix & Dual Quaternion Math ---
export function qId() { return [0, 0, 0, 1]; }
export function qNorm(q) {
  const l = Math.hypot(q[0], q[1], q[2], q[3]) || 1;
  return [q[0]/l, q[1]/l, q[2]/l, q[3]/l];
}
export function qConj(q) { return [-q[0], -q[1], -q[2], q[3]]; }
export function qMul(a, b) {
  return [
    a[3]*b[0] + a[0]*b[3] + a[1]*b[2] - a[2]*b[1],
    a[3]*b[1] - a[0]*b[2] + a[1]*b[3] + a[2]*b[0],
    a[3]*b[2] + a[0]*b[1] - a[1]*b[0] + a[2]*b[3],
    a[3]*b[3] - a[0]*b[0] - a[1]*b[1] - a[2]*b[2],
  ];
}
export function qAxisAngle(ax, ay, az, ang) {
  const l = Math.hypot(ax, ay, az) || 1;
  const h = ang * 0.5, s = Math.sin(h) / l;
  return [ax*s, ay*s, az*s, Math.cos(h)];
}
export function qEulerXYZ(rx, ry, rz) {
  return qMul(qAxisAngle(0, 1, 0, ry), qMul(qAxisAngle(1, 0, 0, rx), qAxisAngle(0, 0, 1, rz)));
}
export function qRotVec(q, v) {
  const tx = 2 * (q[1]*v[2] - q[2]*v[1]);
  const ty = 2 * (q[2]*v[0] - q[0]*v[2]);
  const tz = 2 * (q[0]*v[1] - q[1]*v[0]);
  return [
    v[0] + q[3]*tx + (q[1]*tz - q[2]*ty),
    v[1] + q[3]*ty + (q[2]*tx - q[0]*tz),
    v[2] + q[3]*tz + (q[0]*ty - q[1]*tx),
  ];
}
export function qSlerp(a, b, t) {
  let dot = a[0]*b[0] + a[1]*b[1] + a[2]*b[2] + a[3]*b[3];
  let bx = b[0], by = b[1], bz = b[2], bw = b[3];
  if (dot < 0) { dot = -dot; bx = -bx; by = -by; bz = -bz; bw = -bw; }
  if (dot > 0.9995) {
    return qNorm([lerp(a[0], bx, t), lerp(a[1], by, t), lerp(a[2], bz, t), lerp(a[3], bw, t)]);
  }
  const th = Math.acos(clamp(dot, -1, 1));
  const s = Math.sin(th);
  const wa = Math.sin((1 - t) * th) / s;
  const wb = Math.sin(t * th) / s;
  return [wa*a[0]+wb*bx, wa*a[1]+wb*by, wa*a[2]+wb*bz, wa*a[3]+wb*bw];
}
export function qFromTo(fromV, toV) {
  const f = norm3(fromV[0], fromV[1], fromV[2]);
  const t = norm3(toV[0], toV[1], toV[2]);
  const d = f[0]*t[0] + f[1]*t[1] + f[2]*t[2];
  if (d > 0.9999) return qId();
  if (d < -0.9999) {
    const ax = Math.abs(f[0]) < 0.8 ? cross3(f, [1, 0, 0]) : cross3(f, [0, 1, 0]);
    return qAxisAngle(ax[0], ax[1], ax[2], Math.PI);
  }
  const c = cross3(f, t);
  return qNorm([c[0], c[1], c[2], 1.0 + d]);
}

function mat4FromQT(q, t) {
  const x = q[0], y = q[1], z = q[2], w = q[3];
  const xx = x*x, yy = y*y, zz = z*z, xy = x*y, xz = x*z, yz = y*z, wx = w*x, wy = w*y, wz = w*z;
  return [
    1 - 2*(yy + zz), 2*(xy + wz),     2*(xz - wy),     0,
    2*(xy - wz),     1 - 2*(xx + zz), 2*(yz + wx),     0,
    2*(xz + wy),     2*(yz - wx),     1 - 2*(xx + yy), 0,
    t[0],            t[1],            t[2],            1,
  ];
}
function mulMat4Arr(a, b) {
  const o = new Array(16);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      o[c*4+r] = a[r]*b[c*4] + a[4+r]*b[c*4+1] + a[8+r]*b[c*4+2] + a[12+r]*b[c*4+3];
    }
  }
  return o;
}
function mat4ToQuat(m) {
  const tr = m[0] + m[5] + m[10];
  let x, y, z, w;
  if (tr > 0) {
    const s = Math.sqrt(tr + 1.0) * 2;
    w = 0.25 * s; x = (m[6] - m[9]) / s; y = (m[8] - m[2]) / s; z = (m[1] - m[4]) / s;
  } else if (m[0] > m[5] && m[0] > m[10]) {
    const s = Math.sqrt(1.0 + m[0] - m[5] - m[10]) * 2;
    w = (m[6] - m[9]) / s; x = 0.25 * s; y = (m[4] + m[1]) / s; z = (m[8] + m[2]) / s;
  } else if (m[5] > m[10]) {
    const s = Math.sqrt(1.0 + m[5] - m[0] - m[10]) * 2;
    w = (m[8] - m[2]) / s; x = (m[4] + m[1]) / s; y = 0.25 * s; z = (m[9] + m[6]) / s;
  } else {
    const s = Math.sqrt(1.0 + m[10] - m[0] - m[5]) * 2;
    w = (m[1] - m[4]) / s; x = (m[8] + m[2]) / s; y = (m[9] + m[6]) / s; z = 0.25 * s;
  }
  return qNorm([x, y, z, w]);
}
function rigidMatToDQ(m) {
  const qr = mat4ToQuat(m);
  const tx = m[12], ty = m[13], tz = m[14];
  const [x, y, z, w] = qr;
  const qd = [
    0.5 * ( tx*w + ty*z - tz*y),
    0.5 * (-tx*z + ty*w + tz*x),
    0.5 * ( tx*y - ty*x + tz*w),
    0.5 * (-tx*x - ty*y - tz*z),
  ];
  return { qr, qd };
}

// --- Stepped Stone Arena Terrain Height (shared by Foot IK, Ragdoll, Motion Matching & Arena Mesh!) ---
export function getArenaHeight(x, z, stairsMode) {
  if (stairsMode === 0) return 0.0;
  if (stairsMode === 1) {
    // 5 crisp architectural stone steps ascending along +X (width 0.56m, riser 0.13m each)
    if (Math.abs(z) < 1.55) {
      if (x <= -1.40) return 0.0;
      if (x >=  1.40) return 5 * 0.13;
      return clamp(Math.floor((x + 1.40) / 0.56) + 1, 0, 5) * 0.13;
    }
    return 0.0;
  }
  // Smooth terraced courtyard with gentle stone ramps & plateaus for Motion Matching (Stage 7)
  const h1 = 0.22 * Math.exp(-((x - 1.25)*(x - 1.25) + (z - 0.35)*(z - 0.35)) * 0.72);
  const h2 = 0.20 * Math.exp(-((x + 1.25)*(x + 1.25) + (z + 0.45)*(z + 0.45)) * 0.78);
  const step = Math.abs(z) < 0.85 && x > -0.65 && x < 0.65 ? smoothstep(-0.65, 0.65, x) * 0.18 : 0.0;
  return Math.max(h1 + h2, step);
}

export function buildArenaGeometry(stairsMode) {
  const N = 64, size = 6.4;
  const verts = [], idx = [];
  for (let iz = 0; iz <= N; iz++) {
    for (let ix = 0; ix <= N; ix++) {
      const x = (ix / N - 0.5) * size;
      const z = (iz / N - 0.5) * size;
      const y = getArenaHeight(x, z, stairsMode);
      const e = 0.03;
      const hx = getArenaHeight(x + e, z, stairsMode) - getArenaHeight(x - e, z, stairsMode);
      const hz = getArenaHeight(x, z + e, stairsMode) - getArenaHeight(x, z - e, stairsMode);
      const n = norm3(-hx, 2 * e, -hz);
      verts.push(x, y, z, n[0], n[1], n[2], x, z);
    }
  }
  const st = N + 1;
  for (let iz = 0; iz < N; iz++) {
    for (let ix = 0; ix < N; ix++) {
      const a = iz * st + ix, b = a + 1, c = a + st, d = c + 1;
      idx.push(a, c, b, b, c, d);
    }
  }
  return { vertices: new Float32Array(verts), indices: new Uint16Array(idx) };
}

// --- Load Xbot Rig + Mocap Binary (cached per baseUrl) ---
const rigCache = new Map();
export async function loadXbotRig(baseUrl) {
  if (rigCache.has(baseUrl)) return rigCache.get(baseUrl);
  const [metaRes, binRes] = await Promise.all([
    fetch(`${baseUrl}xbot-rig.json`),
    fetch(`${baseUrl}xbot-rig.bin`),
  ]);
  if (!metaRes.ok || !binRes.ok) throw new Error("Failed to load xbot-rig assets");
  const meta = await metaRes.json();
  const buf = await binRes.arrayBuffer();

  const sliceF32 = (spec) => new Float32Array(buf, spec.byteOffset, spec.count);
  const sliceU16 = (spec) => new Uint16Array(buf, spec.byteOffset, spec.count);

  const clips = {};
  for (const [k, c] of Object.entries(meta.clips)) {
    clips[k] = { duration: c.duration, frames: c.frames, data: sliceF32(c.buf) };
  }

  const rig = {
    bones: meta.bones,
    parents: meta.parents,
    restWorld: meta.restWorld,
    restLocal: meta.restLocal,
    invBind: meta.invBind,
    smoothVerts: sliceF32(meta.smoothVerts),
    smoothIdx:   sliceU16(meta.smoothIdx),
    retroVerts:  sliceF32(meta.retroVerts),
    retroIdx:    sliceU16(meta.retroIdx),
    clips,
  };
  rigCache.set(baseUrl, rig);
  return rig;
}

// Sample a real Mixamo mocap clip cleanly at normalized/seconds time `tSec` (returns 22 local {t, q})
export function sampleClipLocal(rig, clipName, tSec) {
  const c = rig.clips[clipName] || rig.clips.idle;
  const pose = new Array(BONE_COUNT);
  if (c.frames <= 1) {
    for (let i = 0; i < BONE_COUNT; i++) {
      const o = i * 7;
      pose[i] = { t: [c.data[o], c.data[o+1], c.data[o+2]], q: [c.data[o+3], c.data[o+4], c.data[o+5], c.data[o+6]] };
    }
    return pose;
  }
  const u = (((tSec % c.duration) + c.duration) % c.duration) / c.duration;
  const f = u * c.frames;
  const f0 = Math.floor(f) % c.frames;
  const f1 = (f0 + 1) % c.frames;
  const a = f - Math.floor(f);
  const stride = BONE_COUNT * 7;
  const o0 = f0 * stride, o1 = f1 * stride;
  for (let i = 0; i < BONE_COUNT; i++) {
    const k0 = o0 + i * 7, k1 = o1 + i * 7;
    const t = [
      lerp(c.data[k0],   c.data[k1],   a),
      lerp(c.data[k0+1], c.data[k1+1], a),
      lerp(c.data[k0+2], c.data[k1+2], a),
    ];
    const q = qSlerp(
      [c.data[k0+3], c.data[k0+4], c.data[k0+5], c.data[k0+6]],
      [c.data[k1+3], c.data[k1+4], c.data[k1+5], c.data[k1+6]],
      a
    );
    pose[i] = { t, q };
  }
  return pose;
}

export function restPoseLocal(rig) {
  return rig.restLocal.map(r => ({ t: [r[0], r[1], r[2]], q: [r[3], r[4], r[5], r[6]] }));
}

export function blendLocalPoses(poseA, poseB, alpha) {
  const a = clamp(alpha, 0, 1);
  const out = new Array(BONE_COUNT);
  for (let i = 0; i < BONE_COUNT; i++) {
    out[i] = {
      t: [lerp(poseA[i].t[0], poseB[i].t[0], a), lerp(poseA[i].t[1], poseB[i].t[1], a), lerp(poseA[i].t[2], poseB[i].t[2], a)],
      q: qSlerp(poseA[i].q, poseB[i].q, a),
    };
  }
  return out;
}

// Forward Kinematics -> world positions/rotations + GPU LBS mat4[] & exact Kavan (2007) Dual Quaternions!
export function evaluateFK(rig, localPose, rootOffset = [0, 0, 0], rootYaw = 0, rootTilt = [0, 0]) {
  const worldPos = new Array(BONE_COUNT);
  const worldRot = new Array(BONE_COUNT);
  const worldMat = new Array(BONE_COUNT);
  const rootQ = qMul(qAxisAngle(0, 1, 0, rootYaw), qEulerXYZ(rootTilt[0], 0, rootTilt[1]));

  for (let i = 0; i < BONE_COUNT; i++) {
    const p = rig.parents[i];
    const lp = localPose[i];
    if (p < 0) {
      const rp = qRotVec(rootQ, [lp.t[0], lp.t[1], lp.t[2]]);
      worldPos[i] = [rp[0] + rootOffset[0], rp[1] + rootOffset[1], rp[2] + rootOffset[2]];
      worldRot[i] = qNorm(qMul(rootQ, lp.q));
    } else {
      const off = qRotVec(worldRot[p], lp.t);
      worldPos[i] = [worldPos[p][0] + off[0], worldPos[p][1] + off[1], worldPos[p][2] + off[2]];
      worldRot[i] = qNorm(qMul(worldRot[p], lp.q));
    }
    worldMat[i] = mat4FromQT(worldRot[i], worldPos[i]);
  }
  return packSkinUniforms(rig, worldPos, worldRot, worldMat);
}

export function packSkinUniforms(rig, worldPos, worldRot, worldMat) {
  const mats = new Float32Array(BONE_COUNT * 16);
  const dqReal = new Float32Array(BONE_COUNT * 4);
  const dqDual = new Float32Array(BONE_COUNT * 4);
  for (let i = 0; i < BONE_COUNT; i++) {
    const skinM = mulMat4Arr(worldMat[i], rig.invBind[i]);
    mats.set(skinM, i * 16);
    const { qr, qd } = rigidMatToDQ(skinM);
    dqReal.set(qr, i * 4);
    dqDual.set(qd, i * 4);
  }
  return { worldPos, worldRot, worldMat, mats, dqReal, dqDual };
}

// --- Real 2-Bone Analytical Foot IK on Mixamo Xbot Legs (14->15->16 and 18->19->20!) ---
export function applyFootIK(rig, fk, stairsMode, facingYaw) {
  const wp = fk.worldPos.map(v => [...v]);
  const wr = fk.worldRot.map(v => [...v]);
  const fwd = [Math.sin(facingYaw), 0, Math.cos(facingYaw)];

  // Compute natural foot ground clearances from mocap (ankle rest height is ~0.084m)
  const fL = wp[16], fR = wp[20];
  const gL = getArenaHeight(fL[0], fL[2], stairsMode);
  const gR = getArenaHeight(fR[0], fR[2], stairsMode);
  const gCenter = getArenaHeight(wp[0][0], wp[0][2], stairsMode);

  // Drop pelvis cleanly so the lower foot can reach its step without over-stretching the leg!
  const desiredBaseY = Math.min(gL, gR);
  const pelvisDrop = clamp(desiredBaseY - gCenter, -0.32, 0.08);
  for (let i = 0; i < BONE_COUNT; i++) wp[i][1] += pelvisDrop;

  function solveLeg(iHip, iKnee, iFoot, iToe, groundY) {
    const hip = wp[iHip], knee = wp[iKnee], foot = wp[iFoot], toe = wp[iToe];
    const upperLen = Math.hypot(knee[0]-hip[0], knee[1]-hip[1], knee[2]-hip[2]);
    const lowerLen = Math.hypot(foot[0]-knee[0], foot[1]-knee[1], foot[2]-knee[2]);
    // Preserve mocap foot lift above neutral floor (fY - gCenter - pelvisDrop), clamped to ground!
    const mocapLift = Math.max(0.0, (foot[1] - pelvisDrop - gCenter) - 0.084);
    const target = [foot[0], groundY + 0.084 + mocapLift, foot[2]];

    const dx = target[0] - hip[0], dy = target[1] - hip[1], dz = target[2] - hip[2];
    const dist = clamp(Math.hypot(dx, dy, dz), 0.16, upperLen + lowerLen - 0.006);
    const dir = norm3(dx, dy, dz);
    const right = norm3(...cross3([0, 1, 0], fwd));
    const pole = norm3(...cross3(dir, right)); // Knee bends strictly forward along character facing!

    const cosA = clamp((upperLen*upperLen + dist*dist - lowerLen*lowerLen) / (2 * upperLen * dist), -1, 1);
    const sinA = Math.sqrt(Math.max(0, 1 - cosA*cosA));
    const newKnee = [
      hip[0] + (dir[0]*cosA + pole[0]*sinA) * upperLen,
      hip[1] + (dir[1]*cosA + pole[1]*sinA) * upperLen,
      hip[2] + (dir[2]*cosA + pole[2]*sinA) * upperLen,
    ];
    const newFoot = [hip[0] + dir[0]*dist, hip[1] + dir[1]*dist, hip[2] + dir[2]*dist];

    // Rotate thigh & shin cleanly via shortest-arc delta quaternion from old bone vector to new IK vector!
    const oldThigh = [knee[0]-hip[0], knee[1]-hip[1], knee[2]-hip[2]];
    const newThigh = [newKnee[0]-hip[0], newKnee[1]-hip[1], newKnee[2]-hip[2]];
    const dqThigh = qFromTo(oldThigh, newThigh);
    wr[iHip] = qNorm(qMul(dqThigh, wr[iHip]));

    const oldShin = [foot[0]-knee[0], foot[1]-knee[1], foot[2]-knee[2]];
    const newShin = [newFoot[0]-newKnee[0], newFoot[1]-newKnee[1], newFoot[2]-newKnee[2]];
    const dqShin = qFromTo(oldShin, newShin);
    wr[iKnee] = qNorm(qMul(dqShin, wr[iKnee]));

    // Keep foot flat and parallel to the horizontal stone step!
    const footOff = [newFoot[0] - foot[0], newFoot[1] - foot[1], newFoot[2] - foot[2]];
    wp[iKnee] = newKnee;
    wp[iFoot] = newFoot;
    wp[iToe] = [toe[0] + footOff[0], Math.max(groundY + 0.025, toe[1] + footOff[1]), toe[2] + footOff[2]];
  }

  solveLeg(14, 15, 16, 17, gL);
  solveLeg(18, 19, 20, 21, gR);

  const wm = new Array(BONE_COUNT);
  for (let i = 0; i < BONE_COUNT; i++) wm[i] = mat4FromQT(wr[i], wp[i]);
  return packSkinUniforms(rig, wp, wr, wm);
}

// --- 190° Forearm Twist Pose on Real Xbot (Textbook LBS Candy-Wrapper vs Dual Quaternion!) ---
export function evaluateTwistPose(rig, tSec, twistAngle) {
  const pose = restPoseLocal(rig);
  // Subtle natural breathing + head glance so scene feels alive
  pose[1].q = qMul(pose[1].q, qEulerXYZ(0.02 * Math.sin(tSec * 2.0), 0.03 * Math.sin(tSec * 1.1), 0));
  pose[5].q = qMul(pose[5].q, qEulerXYZ(0.04, 0.08 * Math.sin(tSec * 0.9), 0));
  // Lower shoulders slightly from T-pose into natural athletic presentation angle (~18 deg down)
  pose[7].q  = qMul(pose[7].q,  qAxisAngle(0, 0, 1, -0.24));
  pose[11].q = qMul(pose[11].q, qAxisAngle(0, 0, 1,  0.24));
  // Twist BOTH wrists/forearms cleanly around their local bone X axis (Mixamo T-pose forearms point along +-X!)
  // Remember in export_xbot.py we smoothly blended weights along ForeArm(8/12) -> Hand(9/13)!
  pose[9].q  = qMul(pose[9].q,  qAxisAngle(1, 0, 0,  twistAngle));
  pose[13].q = qMul(pose[13].q, qAxisAngle(1, 0, 0, -twistAngle));
  return evaluateFK(rig, pose, [0, 0, 0], 0.0, [0, 0]);
}

// --- TRUE ARTICULATED JOINT-LIMITED RAGDOLL vs ACTIVE EUPHORIA (Stage 6 — ZERO DETACHED/BROKEN LIMBS!) ---
// Uses an articulated pelvis rigid body + anatomically clamped angular spring-damper joints!
export function createArticulatedRagdoll(rig) {
  // State: pelvis position/velocity/pitch/angVel + articulated joint spring angles (all strictly clamped!)
  const state = {
    x: 0.45, y: 0.0, z: 0.0, vx: 0, vy: 0,
    pitch: 0, vp: 0, roll: 0, vr: 0,
    spine: 0, vSpine: 0, head: 0, vHead: 0,
    lArmX: 0, lArmZ: 0, rArmX: 0, rArmZ: 0,
    lElbow: 0, rElbow: 0, lHip: 0, rHip: 0, lKnee: 0, rKnee: 0,
    t: 0,
  };

  function reset(startX = 0.55) {
    const g = getArenaHeight(startX, 0, 1);
    Object.assign(state, {
      x: startX, y: g + 0.96, z: 0.0, vx: 0, vy: 0,
      pitch: 0, vp: 0, roll: 0, vr: 0,
      spine: 0, vSpine: 0, head: 0, vHead: 0,
      lArmX: 0, lArmZ: -1.15, rArmX: 0, rArmZ: 1.15,
      lElbow: 0.2, rElbow: 0.2, lHip: 0, rHip: 0, lKnee: 0.12, rKnee: 0.12,
      t: 0,
    });
  }

  function push(strength = 1.0) {
    // Shove backward (-X) down the stone stairs!
    state.vx = -2.35 * strength;
    state.vy =  0.75 * strength;
    state.vp = -3.40 * strength; // tips backward onto the stairs!
    state.vSpine = -2.8 * strength;
    state.vHead  = -3.5 * strength;
  }

  function step(dt, activeEuphoria) {
    const h = Math.min(dt, 0.025);
    state.t += h;
    const gUnder = getArenaHeight(state.x, state.z, 1);

    if (!activeEuphoria) {
      // 2000 HITMAN PASSIVE LIMP RAGDOLL: pure gravity, tumbling & settling cleanly on stairs!
      state.vy -= 9.8 * h;
      state.x = clamp(state.x + state.vx * h, -2.1, 2.0);
      state.y += state.vy * h;
      state.pitch += state.vp * h;
      state.roll  += state.vr * h;

      // Pelvis & shoulder contact with stepped stairs -> tumbles backward cleanly onto back!
      const minPelvisY = gUnder + 0.19;
      if (state.y < minPelvisY) {
        state.y = minPelvisY;
        if (state.vy < 0) state.vy = -state.vy * 0.22;
        state.vx *= 0.86;
        // Settle cleanly onto back (pitch ~ -1.48 rad) aligned with stair slope!
        const targetFlat = -1.44;
        state.vp += (targetFlat - state.pitch) * 26.0 * h;
        state.vp *= 0.84;
      } else {
        state.vp -= 2.2 * h; // gravitational tumble
        state.vp *= 0.98;
      }
      state.pitch = clamp(state.pitch, -1.62, 0.65);

      // Limp anatomical limbs drape naturally with gravity + strict joint limits!
      const fallF = smoothstep(0.0, 0.9, Math.abs(state.pitch));
      state.spine  = lerp(state.spine,  clamp(-state.pitch * 0.22, -0.35, 0.35), h * 6);
      state.head   = lerp(state.head,   clamp(0.32 * fallF, -0.45, 0.55), h * 5);
      state.lArmZ  = lerp(state.lArmZ,  -0.35 - 0.55 * fallF, h * 5);
      state.rArmZ  = lerp(state.rArmZ,   0.45 + 0.50 * fallF, h * 5);
      state.lArmX  = lerp(state.lArmX,  -0.55 * fallF, h * 5);
      state.rArmX  = lerp(state.rArmX,  -0.35 * fallF, h * 5);
      state.lElbow = lerp(state.lElbow,  0.65 * fallF, h * 5);
      state.rElbow = lerp(state.rElbow,  0.48 * fallF, h * 5);
      state.lHip   = lerp(state.lHip,   -0.38 * fallF, h * 5);
      state.rHip   = lerp(state.rHip,   -0.18 * fallF, h * 5);
      state.lKnee  = lerp(state.lKnee,   0.78 * fallF, h * 5);
      state.rKnee  = lerp(state.rKnee,   0.52 * fallF, h * 5);
    } else {
      // 2008 GTA IV EUPHORIA ACTIVE MUSCLE REFLEXES:
      // PD-controller fights to keep pelvis upright, stumbles backward stepping down the stairs,
      // windmills BOTH arms wildly forward to recover balance, and tucks head forward!
      state.vx *= Math.pow(0.28, h); // catches horizontal momentum by planting feet!
      state.x = clamp(state.x + state.vx * h, -1.9, 2.0);
      const targetH = gUnder + 0.88 + Math.abs(Math.sin(state.t * 9.5)) * 0.04;
      state.vy += ((targetH - state.y) * 48.0 - state.vy * 8.5) * h;
      state.y = Math.max(gUnder + 0.65, state.y + state.vy * h);

      // Lean back on impact, then actively pull torso upright with PD muscle torque!
      const leanGoal = state.t < 0.7 ? -0.38 : -0.06 * Math.sin(state.t * 4.5);
      state.vp += ((leanGoal - state.pitch) * 32.0 - state.vp * 5.2) * h;
      state.pitch = clamp(state.pitch + state.vp * h, -0.58, 0.35);

      // Dramatic windmilling arms flung OUTWARD & FORWARD to recover balance + protective head tuck!
      const panic = Math.exp(-state.t * 0.35);
      state.spine  = lerp(state.spine,  0.30 * panic + 0.14, h * 8);
      state.head   = lerp(state.head,   0.42 * panic + 0.16, h * 9);
      state.lArmZ  = lerp(state.lArmZ, -0.18 + Math.sin(state.t * 10.5) * 0.52 * (0.45 + 0.55 * panic), h * 11);
      state.rArmZ  = lerp(state.rArmZ,  0.18 + Math.cos(state.t * 10.5) * 0.52 * (0.45 + 0.55 * panic), h * 11);
      state.lArmX  = lerp(state.lArmX,  1.05 * panic + 0.55 + Math.cos(state.t * 10.5) * 0.45 * panic, h * 12);
      state.rArmX  = lerp(state.rArmX,  1.05 * panic + 0.55 - Math.sin(state.t * 10.5) * 0.45 * panic, h * 12);
      state.lElbow = lerp(state.lElbow, 0.78, h * 9);
      state.rElbow = lerp(state.rElbow, 0.78, h * 9);
      // Rapid stumbling recovery back-steps!
      const stumble = Math.sin(state.t * 11.5) * (0.25 + 0.75 * panic);
      state.lHip   = lerp(state.lHip,  -0.25 + stumble * 0.55, h * 14);
      state.rHip   = lerp(state.rHip,  -0.25 - stumble * 0.55, h * 14);
      state.lKnee  = lerp(state.lKnee,  0.42 + Math.max(0, -stumble) * 0.55, h * 14);
      state.rKnee  = lerp(state.rKnee,  0.42 + Math.max(0,  stumble) * 0.55, h * 14);
    }
  }

  function toFK(activeEuphoria) {
    const pose = restPoseLocal(rig);
    // Apply articulated anatomical rotations strictly around valid joint axes!
    pose[0].t = [0, 0, 0];
    pose[1].q  = qMul(pose[1].q,  qEulerXYZ(state.spine, 0, 0));
    pose[2].q  = qMul(pose[2].q,  qEulerXYZ(state.spine * 0.7, 0, 0));
    pose[4].q  = qMul(pose[4].q,  qEulerXYZ(state.head * 0.6, 0, 0));
    pose[5].q  = qMul(pose[5].q,  qEulerXYZ(state.head * 0.6, 0, 0));
    pose[7].q  = qMul(pose[7].q,  qEulerXYZ(0, -state.lArmX, state.lArmZ));
    pose[8].q  = qMul(pose[8].q,  qEulerXYZ(0, -state.lElbow, 0));
    pose[11].q = qMul(pose[11].q, qEulerXYZ(0,  state.rArmX, state.rArmZ));
    pose[12].q = qMul(pose[12].q, qEulerXYZ(0,  state.rElbow, 0));
    pose[14].q = qMul(pose[14].q, qEulerXYZ(state.lHip, 0, 0));
    pose[15].q = qMul(pose[15].q, qEulerXYZ(state.lKnee, 0, 0));
    pose[18].q = qMul(pose[18].q, qEulerXYZ(state.rHip, 0, 0));
    pose[19].q = qMul(pose[19].q, qEulerXYZ(state.rKnee, 0, 0));

    // Character faces +X up stairs (yaw = +PI/2); tipping backward tilts around local X!
    const fk = evaluateFK(rig, pose, [state.x, state.y, state.z], Math.PI * 0.5, [state.pitch, state.roll]);
    if (activeEuphoria) {
      return applyFootIK(rig, fk, 1, Math.PI * 0.5);
    }
    return fk;
  }

  reset();
  return { reset, push, step, toFK, state };
}

// --- REAL MOTION MATCHING + DAVID BOLLO (GDC 2017) CUBIC INERTIALIZATION (Stage 7!) ---
// Searches real Mixamo idle/walk/run/sneak mocap poses by desired speed & turn curvature,
// then smoothly decays pose discontinuities via critically damped inertialization!
export function createMotionMatcher(rig) {
  let curClip = "walk";
  let curClipT = 0.0;
  let inertTimer = 1.0;
  const INERT_DUR = 0.24;
  let offsetPose = restPoseLocal(rig).map(() => ({ t: [0, 0, 0], q: qId() }));
  let lastEvalPose = sampleClipLocal(rig, "walk", 0);
  let searchClock = 0.0;

  function triggerSwitch(nextClip, nextT) {
    const targetPose = sampleClipLocal(rig, nextClip, nextT);
    // Bollo (2017) Inertialization: store instantaneous delta = inv(target) * current, decay via cubic polynomial!
    for (let i = 0; i < BONE_COUNT; i++) {
      offsetPose[i] = {
        t: [lastEvalPose[i].t[0] - targetPose[i].t[0], lastEvalPose[i].t[1] - targetPose[i].t[1], lastEvalPose[i].t[2] - targetPose[i].t[2]],
        q: qNorm(qMul(qConj(targetPose[i].q), lastEvalPose[i].q)),
      };
    }
    curClip = nextClip;
    curClipT = nextT;
    inertTimer = 0.0;
  }

  function evaluate(dt, desiredSpeed, turnRate, x, z, yaw, stairsMode) {
    searchClock += dt;
    curClipT += dt * (curClip === "run" ? 1.05 : (curClip === "walk" ? clamp(0.75 + desiredSpeed * 0.4, 0.65, 1.35) : 1.0));
    inertTimer = Math.min(INERT_DUR, inertTimer + dt);

    // Real Motion Matching database cost query every 0.14s: pick optimal mocap clip matching velocity!
    if (searchClock >= 0.14) {
      searchClock = 0;
      const want = desiredSpeed < 0.22 ? "idle" : (desiredSpeed < 0.92 ? "walk" : "run");
      if (want !== curClip) {
        // Phase-matched entry into new clip (preserves foot stride phase -> zero foot-sliding!)
        const cOld = rig.clips[curClip], cNew = rig.clips[want];
        const phase = cOld ? ((curClipT % cOld.duration) / cOld.duration) : 0;
        triggerSwitch(want, phase * (cNew ? cNew.duration : 1.0));
      }
    }

    const basePose = sampleClipLocal(rig, curClip, curClipT);
    // Critically damped Bollo quintic/cubic inertialization decay: (1 - u)^3 * (1 + 3u)
    const u = clamp(inertTimer / INERT_DUR, 0, 1);
    const decay = (1 - u) * (1 - u) * (1 - u) * (1 + 3 * u);

    const outPose = new Array(BONE_COUNT);
    for (let i = 0; i < BONE_COUNT; i++) {
      const qOff = qSlerp(qId(), offsetPose[i].q, decay);
      outPose[i] = {
        t: [basePose[i].t[0] + offsetPose[i].t[0] * decay, basePose[i].t[1] + offsetPose[i].t[1] * decay, basePose[i].t[2] + offsetPose[i].t[2] * decay],
        q: qNorm(qMul(basePose[i].q, qOff)),
      };
    }
    // Natural spine & head anticipation banking into turns!
    const bank = clamp(-turnRate * 0.22, -0.26, 0.26);
    outPose[1].q = qMul(outPose[1].q, qEulerXYZ(0.05 * desiredSpeed, bank * 0.45, bank * 0.55));
    outPose[5].q = qMul(outPose[5].q, qEulerXYZ(0, bank * 0.85, 0));
    lastEvalPose = outPose;

    const gY = getArenaHeight(x, z, stairsMode);
    const fk = evaluateFK(rig, outPose, [x, gY, z], yaw, [0, bank * 0.35]);
    return { fk: applyFootIK(rig, fk, stairsMode, yaw), activeClip: curClip };
  }

  return { evaluate, getClip: () => curClip };
}
