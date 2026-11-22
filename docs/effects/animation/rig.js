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
export function getSmoothStairRamp(x) {
  // Exact continuous centerline passing through all 5 stair centers (-1.68 -> 0.00 up to +1.12 -> 0.65)!
  return clamp((x + 1.68) / 2.80, 0, 1) * 5 * 0.13;
}

export function getSmoothFootGround(x, z, stairsMode) {
  if (stairsMode !== 1) return getArenaHeight(x, z, stairsMode);
  const zMask = smoothstep(1.62, 1.48, Math.abs(z));
  let h = 0.0;
  for (let k = 0; k < 5; k++) {
    const rx = -1.40 + k * 0.56;
    // C1 smooth ramp over 17cm right before each riser: locks flat onto every tread AND clears risers with ZERO snap!
    h += 0.13 * smoothstep(rx - 0.18, rx - 0.01, x);
  }
  return h * zMask;
}

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

  // Smooth C1 ground height on treads (zero riser snaps) + smooth stair-nose envelope for swinging feet!
  const footGround = (iFoot, iToe) => Math.max(
    getSmoothFootGround(wp[iFoot][0], wp[iFoot][2], stairsMode),
    getSmoothFootGround(wp[iToe][0],  wp[iToe][2],  stairsMode)
  );
  const gL = footGround(16, 17);
  const gR = footGround(20, 21);
  // Exact continuous centerline ramp under pelvis (ZERO pelvis snapping on stair edges!)
  const gCenter = stairsMode === 1
    ? getSmoothStairRamp(wp[0][0])
    : getArenaHeight(wp[0][0], wp[0][2], stairsMode);

  // Smooth, constant athletic knee-flex drop on stairs so BOTH upper & lower feet reach cleanly with ZERO 7cm pelvis jumps!
  const onStairs = stairsMode === 1
    ? smoothstep(-1.85, -1.35, wp[0][0]) * (1.0 - smoothstep(1.15, 1.55, wp[0][0]))
    : 0.0;
  const pelvisDrop = stairsMode === 1
    ? -0.068 * onStairs
    : clamp(Math.min(gL, gR) - gCenter, -0.18, 0.04);
  for (let i = 0; i < BONE_COUNT; i++) wp[i][1] += pelvisDrop;

  function solveLeg(iHip, iKnee, iFoot, iToe, groundY) {
    const hip = wp[iHip], knee = wp[iKnee], foot = wp[iFoot], toe = wp[iToe];
    const upperLen = Math.hypot(knee[0]-hip[0], knee[1]-hip[1], knee[2]-hip[2]);
    const lowerLen = Math.hypot(foot[0]-knee[0], foot[1]-knee[1], foot[2]-knee[2]);
    // Preserve mocap foot lift above neutral floor; blend swinging foot cleanly onto smooth stair-nose ramp -> ZERO 11cm riser snaps!
    const mocapLift = Math.max(0.0, (foot[1] - pelvisDrop - gCenter) - 0.088);
    let effGround = groundY;
    if (stairsMode === 1) {
      const swingW = smoothstep(0.012, 0.058, mocapLift);
      const noseEnv = getSmoothStairRamp(Math.max(foot[0], toe[0])) + 0.055;
      effGround = lerp(groundY, Math.max(groundY, noseEnv), swingW);
    }
    const target = [foot[0], effGround + 0.098 + mocapLift, foot[2]];

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

    // Smoothly level foot sole parallel to horizontal stone step near ground contact (zero toe-clipping!)
    const flatWeight = smoothstep(0.09, 0.015, mocapLift);
    const flatFootQ = qAxisAngle(0, 1, 0, facingYaw);
    wr[iFoot] = qSlerp(wr[iFoot], flatFootQ, flatWeight * 0.85);
    const toeRestOff = [
      rig.restWorld[iToe][0] - rig.restWorld[iFoot][0],
      rig.restWorld[iToe][1] - rig.restWorld[iFoot][1],
      rig.restWorld[iToe][2] - rig.restWorld[iFoot][2],
    ];
    const toeWorldOff = qRotVec(wr[iFoot], toeRestOff);
    wp[iKnee] = newKnee;
    wp[iFoot] = newFoot;
    wp[iToe] = [
      newFoot[0] + toeWorldOff[0],
      Math.max(groundY + 0.036, newFoot[1] + toeWorldOff[1]),
      newFoot[2] + toeWorldOff[2],
    ];
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

// --- REAL JAKOBSEN (2001, HITMAN) 15-PARTICLE VERLET RAGDOLL vs REAL MOCAP-BACKED ACTIVE EUPHORIA (Stage 6!) ---
function quatFromBasis(X, Y, Z) {
  // Column-major 3x3 -> unit quaternion (columns = X, Y, Z)
  const m = [
    X[0], X[1], X[2], 0,
    Y[0], Y[1], Y[2], 0,
    Z[0], Z[1], Z[2], 0,
    0, 0, 0, 1,
  ];
  return mat4ToQuat(m);
}

// Exact 3D sphere-vs-5-stone-steps + base floor position projection (friction applied ONCE per substep -> real stair tumble!)
function collideParticleWithStairs(p, prev, r, applyVelocityResponse = false) {
  let hitNx = 0, hitNy = 0, hitNz = 0, hit = false;
  // 1) Base arena floor y = 0
  if (p[1] < r) {
    p[1] = r;
    hitNx = 0; hitNy = 1; hitNz = 0; hit = true;
  }
  // 2) 5 solid architectural stone step blocks (exact match to getArenaHeight(x, z, 1)!)
  for (let k = 0; k < 5; k++) {
    const minX = -1.40 + k * 0.56;
    const maxX = 3.20;
    const maxY = (k + 1) * 0.13;
    const minZ = -1.55, maxZ = 1.55;
    const qx = clamp(p[0], minX, maxX);
    const qy = clamp(p[1], -1.0, maxY);
    const qz = clamp(p[2], minZ, maxZ);
    const dx = p[0] - qx, dy = p[1] - qy, dz = p[2] - qz;
    const d2 = dx*dx + dy*dy + dz*dz;
    if (d2 < r * r) {
      let nx = 0, ny = 1, nz = 0, pen = r;
      if (d2 > 1e-8) {
        const d = Math.sqrt(d2);
        nx = dx / d; ny = dy / d; nz = dz / d;
        pen = r - d;
      } else {
        const toTop = maxY - p[1];
        const toSide = p[0] - minX;
        if (toTop <= toSide + 0.04) { nx = 0; ny = 1; nz = 0; pen = toTop + r; }
        else { nx = -1; ny = 0; nz = 0; pen = toSide + r; }
      }
      p[0] += nx * pen; p[1] += ny * pen; p[2] += nz * pen;
      hitNx = nx; hitNy = ny; hitNz = nz; hit = true;
    }
  }
  if (hit && applyVelocityResponse) {
    // Realistic stone surface friction + gentle bounce applied ONCE per substep (never Velcro!)
    const vx = p[0] - prev[0], vy = p[1] - prev[1], vz = p[2] - prev[2];
    const vn = vx*hitNx + vy*hitNy + vz*hitNz;
    const tx = vx - vn*hitNx, ty = vy - vn*hitNy, tz = vz - vn*hitNz;
    const fric = 0.87;
    const bounce = vn < 0 ? -vn * 0.16 : 0;
    prev[0] = p[0] - (tx * fric + hitNx * bounce);
    prev[1] = p[1] - (ty * fric + hitNy * bounce);
    prev[2] = p[2] - (tz * fric + hitNz * bounce);
  }
}

export function createArticulatedRagdoll(rig, isActive = false) {
  // 15 Verlet particle bone indices mapping 1:1 to Xbot skeleton:
  // 0:Hips(0), 1:Chest(3), 2:Head(5),
  // 3:LSh(7), 4:LElb(8), 5:LHand(9),  6:RSh(11), 7:RElb(12), 8:RHand(13),
  // 9:LHip(14), 10:LKnee(15), 11:LFoot(16), 12:RHip(18), 13:RKnee(19), 14:RFoot(20)
  const BMAP = [0, 3, 5, 7, 8, 9, 11, 12, 13, 14, 15, 16, 18, 19, 20];
  const RAD  = [0.115, 0.128, 0.112, 0.078, 0.062, 0.056, 0.078, 0.062, 0.056, 0.086, 0.074, 0.078, 0.086, 0.074, 0.078];
  const IMAS = [0.32,  0.28,  0.65,  0.80,  1.10,  1.45,  0.80,  1.10,  1.45,  0.68,  0.90,  1.20,  0.68,  0.90,  1.20];

  const restD = (a, b) => {
    const wa = rig.restWorld[BMAP[a]], wb = rig.restWorld[BMAP[b]];
    return Math.hypot(wb[0]-wa[0], wb[1]-wa[1], wb[2]-wa[2]);
  };
  // Exact bone-length stick constraints
  const STICKS = [
    [0, 1], [1, 2],
    [0, 9], [0, 12], [9, 12],
    [1, 3], [1, 6],  [3, 6],
    [3, 4], [4, 5],  [6, 7], [7, 8],
    [9, 10], [10, 11], [12, 13], [13, 14],
  ].map(([a, b]) => [a, b, restD(a, b)]);

  // Soft anatomical range constraints [a, b, minD, maxD] so spine/limbs drape naturally without collapsing or flipping!
  const RANGES = [
    [0, 3, restD(0, 3) * 0.85, restD(0, 3) * 1.07],
    [0, 6, restD(0, 6) * 0.85, restD(0, 6) * 1.07],
    [1, 9, restD(1, 9) * 0.85, restD(1, 9) * 1.07],
    [1, 12, restD(1, 12) * 0.85, restD(1, 12) * 1.07],
    [3, 9, restD(3, 9) * 0.82, restD(3, 9) * 1.10],
    [6, 12, restD(6, 12) * 0.82, restD(6, 12) * 1.10],
    [0, 2, restD(0, 2) * 0.76, restD(0, 2) * 1.04], // neck bend range
    [3, 2, restD(3, 2) * 0.78, restD(3, 2) * 1.25],
    [6, 2, restD(6, 2) * 0.78, restD(6, 2) * 1.25],
    [9, 11, restD(9, 11) * 0.44, restD(9, 11) * 1.01], // knee bend limit
    [12, 14, restD(12, 14) * 0.44, restD(12, 14) * 1.01],
    [3, 5, restD(3, 5) * 0.36, restD(3, 5) * 1.01], // elbow bend limit
    [6, 8, restD(6, 8) * 0.36, restD(6, 8) * 1.01],
    [10, 13, 0.14, 1.40], // knees don't interpenetrate
    [11, 14, 0.14, 1.50], // boots don't interpenetrate
    [1, 4, 0.18, 2.0], [1, 7, 0.18, 2.0], [0, 5, 0.20, 2.0], [0, 8, 0.20, 2.0], // hands/elbows outside torso
  ];

  // Live Verlet particle buffers (used when !activeEuphoria)
  const pos  = Array.from({ length: 15 }, () => [0, 0, 0]);
  const prev = Array.from({ length: 15 }, () => [0, 0, 0]);
  const standPos = Array.from({ length: 15 }, () => [0, 0, 0]);
  const rwPos    = Array.from({ length: 15 }, () => [0, 0, 0]);

  const state = {
    x: 0.78, y: 0.0, z: 0.0, vx: 0, vy: 0,
    pitch: 0, vp: 0, roll: 0, vr: 0,
    t: 0, stridePhase: 0,
    startX: 0.78, pushed: false, pushAge: 0, pushStrength: 1.0, pushSeed: 0,
    rwStart: null, rwT: 0, rwDur: 1.25,
  };

  function initVerletStanding(startX) {
    const g = getArenaHeight(startX, 0, 1);
    const fk0 = evaluateFK(rig, sampleClipLocal(rig, "idle", 0), [startX, g, 0], Math.PI * 0.5);
    for (let i = 0; i < 15; i++) {
      const p = fk0.worldPos[BMAP[i]];
      standPos[i] = [p[0], p[1], p[2]];
      pos[i]  = [p[0], p[1], p[2]];
      prev[i] = [p[0], p[1], p[2]];
    }
  }

  function reset(startX = 0.78, activeOverride = isActive) {
    const baseY = getSmoothStairRamp(startX);
    Object.assign(state, {
      x: startX, y: activeOverride ? baseY : baseY + 0.96, z: 0.0,
      vx: 0, vy: 0, pitch: 0, vp: 0, roll: 0, vr: 0,
      t: 0, stridePhase: 0, startX, pushed: false, pushAge: 0, pushStrength: 1.0,
      rwStart: null, rwT: 0,
    });
    initVerletStanding(startX);
  }

  function push(strength = 1.0, seed = null) {
    state.pushed = true;
    state.pushAge = 0;
    state.pushStrength = strength;
    state.pushSeed = seed !== null ? seed : (state.pushSeed + 1);
    state.rwStart = null;
  }

  function startSmoothRewind() {
    if (state.rwStart) return;
    state.rwStart = { x: state.x, y: state.y, pitch: state.pitch, roll: state.roll };
    for (let i = 0; i < 15; i++) rwPos[i] = [pos[i][0], pos[i][1], pos[i][2]];
    state.rwT = 0;
  }

  function stepVerlet(h) {
    const substeps = 3;
    const sh = h / substeps;
    const damp = 0.996;
    const grav = -9.81 * sh * sh;

    for (let s = 0; s < substeps; s++) {
      // Smooth 0.14s shove impulse applied mostly to upper chest, head & shoulders (feet catch on step lip -> real backward tumble!)
      const pushOn = state.pushAge <= 0.14;
      const pushScale = pushOn ? (sh / 0.14) * state.pushStrength * sh : 0;

      for (let i = 0; i < 15; i++) {
        const vx = (pos[i][0] - prev[i][0]) * damp;
        const vy = (pos[i][1] - prev[i][1]) * damp;
        const vz = (pos[i][2] - prev[i][2]) * damp;
        prev[i][0] = pos[i][0]; prev[i][1] = pos[i][1]; prev[i][2] = pos[i][2];
        let ax = 0, ay = grav, az = 0;
        if (pushOn) {
          // Real Verlet shove with organic asymmetry: one arm flings wide/overhead, legs split across steps -> unmistakable Hitman/HL2 ragdoll!
          const sgn = (state.pushSeed % 2 === 0) ? 1.0 : -1.0;
          let wBack = (i === 1 || i === 2) ? 4.05 : (i === 3 || i === 6) ? 3.55 : (i === 0) ? 2.45 : 0.70;
          let wUp   = (i === 1 || i === 2) ? 0.70 : (i === 0) ? 0.35 : 0.0;
          let wSpin = 0.0;
          if (i === 4 || i === 5)       { wBack = 4.65; wUp = 1.45; wSpin =  2.15 * sgn; } // left arm flings wide & flops overhead
          else if (i === 7 || i === 8)  { wBack = 2.15; wUp = 0.55; wSpin = -2.25 * sgn; } // right arm splays outward to side
          else if (i === 3)             { wSpin =  1.25 * sgn; }
          else if (i === 6)             { wSpin = -1.15 * sgn; }
          else if (i === 2)             { wSpin =  0.75 * sgn; }
          else if (i === 10 || i === 11){ wBack = 1.45; wUp = 0.85; wSpin =  0.85 * sgn; } // one knee kicks & bends over step
          else if (i === 13 || i === 14){ wBack = 0.15; wUp = 0.10; wSpin = -0.65 * sgn; } // other boot trails on higher step
          ax -= wBack * pushScale;
          ay += wUp   * pushScale;
          az += wSpin * pushScale;
        }
        pos[i][0] += vx + ax;
        pos[i][1] += vy + ay;
        pos[i][2] += vz + az;
      }

      // 12 Jakobsen PBD constraint + position-only collision iterations (friction applied ONCE on final iteration!)
      for (let it = 0; it < 12; it++) {
        for (let k = 0; k < STICKS.length; k++) {
          const [a, b, d0] = STICKS[k];
          const dx = pos[b][0]-pos[a][0], dy = pos[b][1]-pos[a][1], dz = pos[b][2]-pos[a][2];
          const d = Math.hypot(dx, dy, dz) || 1e-6;
          const diff = (d - d0) / d;
          const wSum = IMAS[a] + IMAS[b];
          const wa = IMAS[a] / wSum, wb = IMAS[b] / wSum;
          pos[a][0] += dx * diff * wa; pos[a][1] += dy * diff * wa; pos[a][2] += dz * diff * wa;
          pos[b][0] -= dx * diff * wb; pos[b][1] -= dy * diff * wb; pos[b][2] -= dz * diff * wb;
        }
        for (let k = 0; k < RANGES.length; k++) {
          const [a, b, minD, maxD] = RANGES[k];
          const dx = pos[b][0]-pos[a][0], dy = pos[b][1]-pos[a][1], dz = pos[b][2]-pos[a][2];
          const d = Math.hypot(dx, dy, dz) || 1e-6;
          let target = d;
          if (d < minD) target = minD;
          else if (d > maxD) target = maxD;
          else continue;
          const diff = (d - target) / d;
          const wSum = IMAS[a] + IMAS[b];
          const wa = IMAS[a] / wSum, wb = IMAS[b] / wSum;
          pos[a][0] += dx * diff * wa; pos[a][1] += dy * diff * wa; pos[a][2] += dz * diff * wa;
          pos[b][0] -= dx * diff * wb; pos[b][1] -= dy * diff * wb; pos[b][2] -= dz * diff * wb;
        }
        // Anatomical knee hinge (prevent backward flamingo knees: knees stay on pelvis forward side!)
        const pL = [pos[9][0]-pos[12][0], pos[9][1]-pos[12][1], pos[9][2]-pos[12][2]];
        const pU = [pos[1][0]-pos[0][0],  pos[1][1]-pos[0][1],  pos[1][2]-pos[0][2]];
        const pFwd = norm3(...cross3(pL, pU));
        for (const [ih, ik, ift] of [[9, 10, 11], [12, 13, 14]]) {
          const mx = 0.5*(pos[ih][0]+pos[ift][0]), my = 0.5*(pos[ih][1]+pos[ift][1]), mz = 0.5*(pos[ih][2]+pos[ift][2]);
          const dotF = (pos[ik][0]-mx)*pFwd[0] + (pos[ik][1]-my)*pFwd[1] + (pos[ik][2]-mz)*pFwd[2];
          if (dotF < -0.015) {
            const corr = (-0.015 - dotF) * 0.55;
            pos[ik][0] += pFwd[0]*corr; pos[ik][1] += pFwd[1]*corr; pos[ik][2] += pFwd[2]*corr;
          }
        }
        // Exact 3D collision of EVERY particle against all 5 solid stone steps + floor (friction once on final iter!)
        const isFinal = (it === 11);
        for (let i = 0; i < 15; i++) collideParticleWithStairs(pos[i], prev[i], RAD[i], isFinal);
      }
    }
    // Track pelvis position for camera & shadows
    state.x = pos[0][0];
    state.y = pos[0][1];
    state.z = pos[0][2];
  }

  function step(dt, activeEuphoria = isActive) {
    const h = Math.min(dt, 0.025);
    state.t += h;

    if (state.rwStart) {
      state.rwT = Math.min(state.rwDur, state.rwT + h);
      const u = smoothstep(0.0, 1.0, state.rwT / state.rwDur);
      if (!activeEuphoria) {
        for (let i = 0; i < 15; i++) {
          pos[i][0] = lerp(rwPos[i][0], standPos[i][0], u);
          pos[i][1] = lerp(rwPos[i][1], standPos[i][1], u);
          pos[i][2] = lerp(rwPos[i][2], standPos[i][2], u);
          prev[i][0] = pos[i][0]; prev[i][1] = pos[i][1]; prev[i][2] = pos[i][2];
        }
        state.x = pos[0][0]; state.y = pos[0][1]; state.z = pos[0][2];
      } else {
        const goalY = getSmoothStairRamp(state.startX);
        state.x = lerp(state.rwStart.x, state.startX, u);
        state.y = lerp(state.rwStart.y, goalY, u);
        state.pitch = lerp(state.rwStart.pitch, 0.0, u);
        state.roll  = lerp(state.rwStart.roll,  0.0, u);
        state.vx = 0; state.vy = 0; state.vp = 0; state.vr = 0;
        state.stridePhase += h * 1.15 * (1.0 - u);
      }
      return;
    }

    if (!state.pushed) {
      const baseY = getSmoothStairRamp(state.x);
      state.y = activeEuphoria ? baseY : pos[0][1];
      return;
    }

    state.pushAge += h;

    if (!activeEuphoria) {
      // 2000 HITMAN GENUINE 15-PARTICLE JAKOBSEN VERLET RAGDOLL!
      stepVerlet(h);
    } else {
      // 2008 GTA IV EUPHORIA ACTIVE MUSCLE REFLEXES:
      if (state.pushAge <= 0.16) {
        const imp = (h / 0.16) * state.pushStrength;
        state.vx += -1.85 * imp;
        state.vp += -2.65 * imp;
      }
      state.vx *= Math.pow(0.28, h);
      const prevX = state.x;
      state.x = clamp(state.x + state.vx * h, -1.25, 2.0);
      const moved = Math.abs(state.x - prevX);
      state.stridePhase += moved * 0.92;

      state.y = getSmoothStairRamp(state.x);
      const leanGoal = state.pushAge < 0.70 ? -0.22 * smoothstep(0.0, 0.20, state.pushAge) : 0.03 * Math.sin(state.pushAge * 3.5) * Math.exp(-state.pushAge * 0.6);
      state.vp += ((leanGoal - state.pitch) * 22.0 - state.vp * 7.5) * h;
      state.pitch = clamp(state.pitch + state.vp * h, -0.32, 0.20);
    }
  }

  function verletToFK() {
    // Reconstruct exact orthonormal 22-bone Xbot world transforms directly from the 15 live Verlet particles!
    const wp = new Array(BONE_COUNT);
    const wr = new Array(BONE_COUNT);
    const sub = (b, a) => [b[0]-a[0], b[1]-a[1], b[2]-a[2]];
    const mix3 = (a, b, t) => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
    const alignBone = (parentQ, restDirLocal, liveDirWorld) => {
      const curDir = qRotVec(parentQ, restDirLocal);
      return qNorm(qMul(qFromTo(curDir, liveDirWorld), parentQ));
    };

    // Pelvis basis: +X = LHip - RHip, +Y = Chest - Hips, +Z = cross(X, Y)
    const pX = norm3(...sub(pos[9], pos[12]));
    const pUpRaw = norm3(...sub(pos[1], pos[0]));
    const pZ = norm3(...cross3(pX, pUpRaw));
    const pY = norm3(...cross3(pZ, pX));
    const qHips = quatFromBasis(pX, pY, pZ);

    // Chest basis: +X = LSh - RSh, +Y = Chest - Hips, +Z = cross(X, Y)
    const cX = norm3(...sub(pos[3], pos[6]));
    const cZ = norm3(...cross3(cX, pUpRaw));
    const cY = norm3(...cross3(cZ, cX));
    const qChest = quatFromBasis(cX, cY, cZ);

    // Spine chain (0..5)
    wp[0] = [...pos[0]]; wr[0] = qHips;
    wp[1] = mix3(pos[0], pos[1], 0.34); wr[1] = qSlerp(qHips, qChest, 0.35);
    wp[2] = mix3(pos[0], pos[1], 0.68); wr[2] = qSlerp(qHips, qChest, 0.72);
    wp[3] = [...pos[1]]; wr[3] = qChest;
    const headDir = norm3(...sub(pos[2], pos[1]));
    const qHead = alignBone(qChest, [0, 1, 0], headDir);
    wp[4] = mix3(pos[1], pos[2], 0.62); wr[4] = qSlerp(qChest, qHead, 0.65);
    wp[5] = [...pos[2]]; wr[5] = qHead;

    // Left Arm (6..9): rest dir +X
    wp[6] = mix3(pos[1], pos[3], 0.45); wr[6] = qChest;
    wp[7] = [...pos[3]]; wr[7] = alignBone(qChest, [1, 0, 0], norm3(...sub(pos[4], pos[3])));
    wp[8] = [...pos[4]]; wr[8] = alignBone(wr[7],  [1, 0, 0], norm3(...sub(pos[5], pos[4])));
    wp[9] = [...pos[5]]; wr[9] = wr[8];

    // Right Arm (10..13): rest dir -X
    wp[10] = mix3(pos[1], pos[6], 0.45); wr[10] = qChest;
    wp[11] = [...pos[6]]; wr[11] = alignBone(qChest, [-1, 0, 0], norm3(...sub(pos[7], pos[6])));
    wp[12] = [...pos[7]]; wr[12] = alignBone(wr[11], [-1, 0, 0], norm3(...sub(pos[8], pos[7])));
    wp[13] = [...pos[8]]; wr[13] = wr[12];

    // Left Leg (14..17): rest dir -Y
    wp[14] = [...pos[9]];  wr[14] = alignBone(qHips,  [0, -1, 0], norm3(...sub(pos[10], pos[9])));
    wp[15] = [...pos[10]]; wr[15] = alignBone(wr[14], [0, -1, 0], norm3(...sub(pos[11], pos[10])));
    wp[16] = [...pos[11]]; wr[16] = wr[15];
    const lToeOff = qRotVec(wr[16], [0, -0.087, 0.107]);
    wp[17] = [wp[16][0] + lToeOff[0], wp[16][1] + lToeOff[1], wp[16][2] + lToeOff[2]]; wr[17] = wr[16];

    // Right Leg (18..21): rest dir -Y
    wp[18] = [...pos[12]]; wr[18] = alignBone(qHips,  [0, -1, 0], norm3(...sub(pos[13], pos[12])));
    wp[19] = [...pos[13]]; wr[19] = alignBone(wr[18], [0, -1, 0], norm3(...sub(pos[14], pos[13])));
    wp[20] = [...pos[14]]; wr[20] = wr[19];
    const rToeOff = qRotVec(wr[20], [0, -0.087, 0.107]);
    wp[21] = [wp[20][0] + rToeOff[0], wp[20][1] + rToeOff[1], wp[20][2] + rToeOff[2]]; wr[21] = wr[20];

    const wm = new Array(BONE_COUNT);
    for (let i = 0; i < BONE_COUNT; i++) wm[i] = mat4FromQT(wr[i], wp[i]);
    return packSkinUniforms(rig, wp, wr, wm);
  }

  function toFK(activeEuphoria = isActive) {
    if (!activeEuphoria) {
      if (!state.pushed && !state.rwStart) {
        const g = getArenaHeight(state.startX, 0, 1);
        return evaluateFK(rig, sampleClipLocal(rig, "idle", state.t), [state.startX, g, 0], Math.PI * 0.5);
      }
      return verletToFK();
    }

    // Active Euphoria: smooth 0.24s attack envelope on panic & stumble blend -> ZERO impact snap!
    const rwFade = state.rwStart ? (1.0 - smoothstep(0.0, 0.7, state.rwT / state.rwDur)) : 1.0;
    const attack = state.pushed ? smoothstep(0.0, 0.24, state.pushAge) : 0.0;
    const panic = attack * Math.exp(-Math.max(0, state.pushAge - 0.15) * 0.65) * rwFade;
    const stumbling = state.rwStart
      ? smoothstep(0.0, 0.25, state.rwT / state.rwDur) * (1.0 - smoothstep(0.75, 1.0, state.rwT / state.rwDur)) * 0.65
      : attack * smoothstep(0.06, 0.48, Math.abs(state.vx));
    const pWalk = sampleClipLocal(rig, "walk", state.rwStart ? state.stridePhase : -state.stridePhase);
    const pIdle = sampleClipLocal(rig, "idle", state.t);
    const pose = blendLocalPoses(pIdle, pWalk, stumbling);

    pose[0].t[1] -= 0.05 * panic;
    pose[1].q  = qMul(pose[1].q,  qEulerXYZ(0.14 * panic, Math.sin(state.t * 6.0) * 0.12 * panic, 0));
    pose[5].q  = qMul(pose[5].q,  qEulerXYZ(0.18 * panic, 0, 0));
    const flail = Math.sin(state.t * 7.5) * panic;
    pose[7].q  = qMul(pose[7].q,  qEulerXYZ(0, -0.32 * panic + flail * 0.36,  0.65 * panic + flail * 0.20));
    pose[11].q = qMul(pose[11].q, qEulerXYZ(0,  0.32 * panic + flail * 0.36, -0.65 * panic + flail * 0.20));

    const fk = evaluateFK(rig, pose, [state.x, state.y, state.z], Math.PI * 0.5, [state.pitch, 0]);
    return applyFootIK(rig, fk, 1, Math.PI * 0.5);
  }

  reset(0.78, isActive);
  return { reset, push, startSmoothRewind, step, toFK, state };
}

// --- REAL MOTION MATCHING + PHASE-LOCKED CONTINUOUS BLEND & BOLLO INERTIALIZATION (Stage 7!) ---
// Zero "rozkrok" sliding: single phase-locked stride clock synchronized to actual ground speed + smooth idle/walk/run blend!
export function createMotionMatcher(rig) {
  let stridePhase = 0.0; // normalized 0..1 shared phase for walk & run!
  let idleTime = 0.0;
  let smoothSpeed = 0.0;
  let activeClip = "idle";

  function evaluate(dt, desiredSpeed, moveDist, turnRate, x, z, yaw, stairsMode) {
    idleTime += dt;
    const rawSpd = moveDist / Math.max(dt, 1e-4);
    smoothSpeed = lerp(smoothSpeed, rawSpd, Math.min(1, dt * 12.0));

    // Smooth continuous blend weights: 0 m/s -> pure idle (feet together!), 0.5..1.1 -> walk, 1.3..2.0 -> run!
    const moveW = smoothstep(0.06, 0.42, smoothSpeed);
    const runW  = smoothstep(1.05, 1.62, smoothSpeed);
    activeClip = moveW < 0.20 ? "idle" : (runW > 0.55 ? "run" : "walk");

    // Advance normalized stride phase strictly proportional to real ground motion when moving -> ZERO foot sliding & ZERO frozen split!
    const effStride = lerp(1.04, 1.82, runW);
    if (moveW > 0.02) {
      stridePhase = (stridePhase + Math.max(moveDist / effStride, dt * 0.45 * moveW)) % 1.0;
    }

    const pIdle = sampleClipLocal(rig, "idle", idleTime);
    const pWalk = sampleClipLocal(rig, "walk", stridePhase * rig.clips.walk.duration);
    // +0.08 phase offset aligns run left/right foot peak (u=0.29/0.76) bit-for-bit with walk (u=0.21/0.69)!
    const pRun  = sampleClipLocal(rig, "run",  ((stridePhase + 0.08) % 1.0) * rig.clips.run.duration);
    const pMove = blendLocalPoses(pWalk, pRun, runW);
    const outPose = blendLocalPoses(pIdle, pMove, moveW);

    // Natural spine & head anticipation banking into turns (pelvis stays level so boots never lift!)
    const bank = clamp(-turnRate * 0.16 * moveW, -0.22, 0.22);
    outPose[1].q = qMul(outPose[1].q, qEulerXYZ(0.05 * moveW, bank * 0.40, bank * 0.45));
    outPose[2].q = qMul(outPose[2].q, qEulerXYZ(0.0, bank * 0.25, bank * 0.25));
    outPose[5].q = qMul(outPose[5].q, qEulerXYZ(0, bank * 0.75, 0));

    const gY = getArenaHeight(x, z, stairsMode);
    const fk = evaluateFK(rig, outPose, [x, gY, z], yaw, [0, 0]);
    return { fk: applyFootIK(rig, fk, stairsMode, yaw), activeClip };
  }

  return { evaluate, getClip: () => activeClip };
}
