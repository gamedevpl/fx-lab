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
      Math.max(groundY + 0.02, newFoot[1] + toeWorldOff[1]),
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

// --- TRUE ARTICULATED JOINT-LIMITED RAGDOLL vs REAL MOCAP-BACKED ACTIVE EUPHORIA (Stage 6!) ---
export function createArticulatedRagdoll(rig) {
  const state = {
    x: 0.55, y: 0.0, z: 0.0, vx: 0, vy: 0,
    pitch: 0, vp: 0, roll: 0, vr: 0,
    t: 0, stridePhase: 0,
  };

  function reset(startX = 0.55) {
    const g = getArenaHeight(startX, 0, 1);
    Object.assign(state, {
      x: startX, y: g + 1.0, z: 0.0, vx: 0, vy: 0,
      pitch: 0, vp: 0, roll: 0, vr: 0,
      t: 0, stridePhase: 0,
    });
  }

  function push(strength = 1.0) {
    state.vx = -2.20 * strength;
    state.vy =  0.55 * strength;
    state.vp = -3.30 * strength;
    state.vr =  0.55 * strength;
  }

  function step(dt, activeEuphoria) {
    const h = Math.min(dt, 0.025);
    state.t += h;
    const gUnder = getArenaHeight(state.x, state.z, 1);

    if (!activeEuphoria) {
      // 2000 HITMAN PASSIVE LIMP RAGDOLL: pure gravity tumble + asymmetric settling on stairs!
      state.vy -= 9.8 * h;
      state.x = clamp(state.x + state.vx * h, -2.15, 2.0);
      state.y += state.vy * h;
      state.pitch += state.vp * h;
      state.roll  += state.vr * h;

      const minPelvisY = gUnder + 0.16;
      if (state.y < minPelvisY) {
        state.y = minPelvisY;
        if (state.vy < 0) state.vy = -state.vy * 0.18;
        state.vx *= Math.pow(0.08, h);
        state.vp += (-1.46 - state.pitch) * 24.0 * h;
        state.vp *= Math.pow(0.04, h);
        state.vr *= Math.pow(0.06, h);
      } else {
        state.vp -= 2.4 * h;
        state.vp *= 0.985;
      }
      state.pitch = clamp(state.pitch, -1.58, 0.45);
      state.roll  = clamp(state.roll, -0.35, 0.35);
    } else {
      // 2008 GTA IV EUPHORIA ACTIVE MUSCLE REFLEXES:
      // Stumbles backward down the stairs using real Mixamo backpedal stride + PD upright recovery + wide balance arms!
      state.vx *= Math.pow(0.24, h);
      const prevX = state.x;
      state.x = clamp(state.x + state.vx * h, -1.85, 2.0);
      const moved = Math.abs(state.x - prevX);
      state.stridePhase += moved * 1.45 + h * 0.25;

      const gNew = getArenaHeight(state.x, state.z, 1);
      state.y = gNew;
      // Brief backward recoil on impact, then PD-controller pulls torso cleanly back upright!
      const leanGoal = state.t < 0.55 ? -0.22 : 0.04 * Math.sin(state.t * 3.8) * Math.exp(-state.t * 0.5);
      state.vp += ((leanGoal - state.pitch) * 34.0 - state.vp * 6.5) * h;
      state.pitch = clamp(state.pitch + state.vp * h, -0.36, 0.22);
    }
  }

  function toFK(activeEuphoria) {
    if (!activeEuphoria) {
      // Asymmetric natural limp ragdoll drape (zero stiff mirror mannequin!)
      const pose = restPoseLocal(rig);
      pose[0].t = [0, 0, 0];
      const f = smoothstep(0.0, 0.85, Math.abs(state.pitch));
      pose[1].q  = qMul(pose[1].q,  qEulerXYZ(-0.18 * f, 0.12 * f, 0.08 * f));
      pose[2].q  = qMul(pose[2].q,  qEulerXYZ(-0.14 * f, 0.10 * f, 0.06 * f));
      pose[5].q  = qMul(pose[5].q,  qEulerXYZ(0.22 * f,  0.34 * f, -0.18 * f));
      // Left arm flung overhead/sideways; right arm draped loosely across side
      pose[7].q  = qMul(pose[7].q,  qEulerXYZ(0.0, 0.25 * f, -0.35 + 0.65 * f));
      pose[8].q  = qMul(pose[8].q,  qEulerXYZ(0.0, -0.45 * f, 0.0));
      pose[11].q = qMul(pose[11].q, qEulerXYZ(0.0, 0.42 * f,  1.15 - 0.30 * f));
      pose[12].q = qMul(pose[12].q, qEulerXYZ(0.0,  0.85 * f, 0.0));
      // Asymmetric bent knees resting across stairs
      pose[14].q = qMul(pose[14].q, qEulerXYZ(-0.55 * f, 0.14 * f, 0.12 * f));
      pose[15].q = qMul(pose[15].q, qEulerXYZ( 0.92 * f, 0.0, 0.0));
      pose[18].q = qMul(pose[18].q, qEulerXYZ(-0.22 * f, -0.12 * f, -0.10 * f));
      pose[19].q = qMul(pose[19].q, qEulerXYZ( 0.38 * f, 0.0, 0.0));
      return evaluateFK(rig, pose, [state.x, state.y, state.z], Math.PI * 0.5, [state.pitch, state.roll]);
    }

    // Active Euphoria: blend REAL Mixamo reverse walk (stumbling backsteps!) -> REAL Mixamo idle as balance recovers!
    const panic = Math.exp(-state.t * 0.55);
    const stumbling = smoothstep(0.06, 0.35, Math.abs(state.vx) + panic * 0.35);
    const pWalk = sampleClipLocal(rig, "walk", -state.stridePhase);
    const pIdle = sampleClipLocal(rig, "idle", state.t);
    const pose = blendLocalPoses(pIdle, pWalk, stumbling);

    // Subtle athletic balance crouch + wide asymmetric flailing arms (layered cleanly on real Mixamo clavicles!)
    pose[0].t[1] -= 0.07 * panic;
    pose[1].q  = qMul(pose[1].q,  qEulerXYZ(0.14 * panic, Math.sin(state.t * 7.0) * 0.14 * panic, 0));
    pose[5].q  = qMul(pose[5].q,  qEulerXYZ(0.22 * panic, 0, 0)); // watches stairs footing!
    // Left arm & right arm flung wide OUT to sides (in Mixamo pose space, lifting arm out is +-Z, swinging is Y!)
    const flail = Math.sin(state.t * 9.0) * panic;
    pose[7].q  = qMul(pose[7].q,  qEulerXYZ(0, -0.35 * panic + flail * 0.45,  0.72 * panic + flail * 0.28));
    pose[11].q = qMul(pose[11].q, qEulerXYZ(0,  0.35 * panic + flail * 0.45, -0.72 * panic + flail * 0.28));

    const fk = evaluateFK(rig, pose, [state.x, state.y, state.z], Math.PI * 0.5, [state.pitch, 0]);
    return applyFootIK(rig, fk, 1, Math.PI * 0.5);
  }

  reset();
  return { reset, push, step, toFK, state };
}

// --- REAL MOTION MATCHING + DAVID BOLLO (GDC 2017) CUBIC INERTIALIZATION (Stage 7!) ---
export function createMotionMatcher(rig) {
  let curClip = "walk";
  let curClipT = 0.0;
  let inertTimer = 1.0;
  const INERT_DUR = 0.22;
  let offsetPose = restPoseLocal(rig).map(() => ({ t: [0, 0, 0], q: qId() }));
  let lastEvalPose = sampleClipLocal(rig, "walk", 0);
  let searchClock = 0.0;

  function triggerSwitch(nextClip, nextT) {
    const targetPose = sampleClipLocal(rig, nextClip, nextT);
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

  function evaluate(dt, desiredSpeed, moveDist, turnRate, x, z, yaw, stairsMode) {
    searchClock += dt;
    // Lock animation phase strictly to actual world displacement -> ZERO foot sliding!
    if (curClip === "idle") {
      curClipT += dt;
    } else if (curClip === "walk") {
      const strideLen = 1.04; // meters per Mixamo walk cycle
      curClipT += (moveDist / strideLen) * rig.clips.walk.duration;
    } else {
      const strideLen = 1.82; // meters per Mixamo run cycle
      curClipT += (moveDist / strideLen) * rig.clips.run.duration;
    }
    inertTimer = Math.min(INERT_DUR, inertTimer + dt);

    // Immediate stop to idle on arrival; 0.12s database search cadence between walk/run!
    const want = desiredSpeed < 0.16 ? "idle" : (desiredSpeed < 0.96 ? "walk" : "run");
    if (want !== curClip && (want === "idle" || curClip === "idle" || searchClock >= 0.12)) {
      searchClock = 0;
      const cOld = rig.clips[curClip], cNew = rig.clips[want];
      const phase = (curClip !== "idle" && cOld) ? ((curClipT % cOld.duration) / cOld.duration) : 0;
      triggerSwitch(want, phase * (cNew ? cNew.duration : 1.0));
    }

    const basePose = sampleClipLocal(rig, curClip, curClipT);
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
    // Natural spine & head anticipation banking into turns (pelvis stays level so boots never lift!)
    const bank = clamp(-turnRate * 0.18, -0.22, 0.22);
    outPose[1].q = qMul(outPose[1].q, qEulerXYZ(0.04 * desiredSpeed, bank * 0.40, bank * 0.45));
    outPose[2].q = qMul(outPose[2].q, qEulerXYZ(0.0, bank * 0.25, bank * 0.25));
    outPose[5].q = qMul(outPose[5].q, qEulerXYZ(0, bank * 0.75, 0));
    lastEvalPose = outPose;

    const gY = getArenaHeight(x, z, stairsMode);
    const fk = evaluateFK(rig, outPose, [x, gY, z], yaw, [0, 0]);
    return { fk: applyFootIK(rig, fk, stairsMode, yaw), activeClip: curClip };
  }

  return { evaluate, getClip: () => curClip };
}
