// Procedural articulated 3D humanoid mesh, stepped stone arena, skeletal hierarchy,
// 2-bone analytical Foot IK, Dual Quaternion math, Active/Passive Ragdoll, and Motion Matching.

import { clamp, lerp, smoothstep, norm3, cross3 } from "../../src/gl-utils.js";

// 13-bone humanoid hierarchy:
//  0: Pelvis (root)     1: Spine/Chest      2: Head
//  3: L_UpperArm        4: L_Forearm        5: R_UpperArm       6: R_Forearm
//  7: L_Thigh           8: L_Shin           9: L_Foot
// 10: R_Thigh          11: R_Shin          12: R_Foot
export const BONE_COUNT = 13;
export const BONE_PARENTS = [-1, 0, 1, 1, 3, 1, 5, 0, 7, 8, 0, 10, 11];

// Rest-pose joint origins in character space (character stands at y = 0, height ~1.82m)
export const REST_JOINTS = [
  [ 0.00, 0.94, 0.00], // 0 Pelvis
  [ 0.00, 1.24, 0.00], // 1 Chest
  [ 0.00, 1.56, 0.00], // 2 Head
  [-0.24, 1.44, 0.00], // 3 L_UpperArm
  [-0.54, 1.44, 0.00], // 4 L_Forearm (extends out along -X in T-pose)
  [ 0.24, 1.44, 0.00], // 5 R_UpperArm
  [ 0.54, 1.44, 0.00], // 6 R_Forearm (extends out along +X in T-pose)
  [-0.12, 0.90, 0.00], // 7 L_Thigh
  [-0.12, 0.48, 0.00], // 8 L_Shin
  [-0.12, 0.08, 0.00], // 9 L_Foot
  [ 0.12, 0.90, 0.00], // 10 R_Thigh
  [ 0.12, 0.48, 0.00], // 11 R_Shin
  [ 0.12, 0.08, 0.00], // 12 R_Foot
];

// --- Quaternion & Dual Quaternion math (exact Kavan et al. I3D 2007!) ---
export function qId() { return [0, 0, 0, 1]; }
export function qNorm(q) {
  const l = Math.hypot(q[0], q[1], q[2], q[3]) || 1;
  return [q[0] / l, q[1] / l, q[2] / l, q[3] / l];
}
export function qMul(a, b) {
  return [
    a[3]*b[0] + a[0]*b[3] + a[1]*b[2] - a[2]*b[1],
    a[3]*b[1] - a[0]*b[2] + a[1]*b[3] + a[2]*b[0],
    a[3]*b[2] + a[0]*b[1] - a[1]*b[0] + a[2]*b[3],
    a[3]*b[3] - a[0]*b[0] - a[1]*b[1] - a[2]*b[2],
  ];
}
export function qFromAxisAngle(ax, ay, az, ang) {
  const l = Math.hypot(ax, ay, az) || 1;
  const h = ang * 0.5, s = Math.sin(h) / l;
  return [ax * s, ay * s, az * s, Math.cos(h)];
}
export function qFromEulerXYZ(rx, ry, rz) {
  return qMul(qFromAxisAngle(0, 1, 0, ry), qMul(qFromAxisAngle(1, 0, 0, rx), qFromAxisAngle(0, 0, 1, rz)));
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

// Convert rigid (quat q, translation t) to 4x4 column-major mat4 AND unit dual quaternion (qr, qd)
export function rigidToMat4AndDQ(q, t) {
  const x = q[0], y = q[1], z = q[2], w = q[3];
  const xx = x*x, yy = y*y, zz = z*z;
  const xy = x*y, xz = x*z, yz = y*z;
  const wx = w*x, wy = w*y, wz = w*z;
  const m = [
    1 - 2*(yy + zz), 2*(xy + wz),     2*(xz - wy),     0,
    2*(xy - wz),     1 - 2*(xx + zz), 2*(yz + wx),     0,
    2*(xz + wy),     2*(yz - wx),     1 - 2*(xx + yy), 0,
    t[0],            t[1],            t[2],            1,
  ];
  // qd = 0.5 * (t_pure * qr)
  const qd = [
    0.5 * ( t[0]*w + t[1]*z - t[2]*y),
    0.5 * (-t[0]*z + t[1]*w + t[2]*x),
    0.5 * ( t[0]*y - t[1]*x + t[2]*w),
    0.5 * (-t[0]*x - t[1]*y - t[2]*z),
  ];
  return { m, qr: [x, y, z, w], qd };
}

// --- Stepped Stone Arena Terrain Height Function (shared by Foot IK, Ragdoll & Arena mesh!) ---
export function getArenaHeight(x, z, stairsMode) {
  if (stairsMode === 0) return 0.0; // flat arena
  // Clean ascending stone steps along Z (z in [-1.8..+1.8]) + sloped platform on left
  if (stairsMode === 1) {
    // 5 crisp stone steps along X for clear profile walking & Foot IK!
    const stepX = clamp(Math.floor((x + 1.5) / 0.55), 0, 5);
    const stairZ = Math.abs(z) < 1.35 ? 1.0 : 0.0;
    if (stairZ > 0.5 && x > -1.5 && x < 1.8) return stepX * 0.135;
    if (x >= 1.8 && Math.abs(z) < 1.35) return 5 * 0.135;
    return 0.0;
  }
  // Undulating terraced stone course for Motion Matching (Stage 7)
  const hill1 = 0.24 * Math.exp(-((x - 1.1)*(x - 1.1) + (z - 0.3)*(z - 0.3)) * 0.85);
  const hill2 = 0.18 * Math.exp(-((x + 1.1)*(x + 1.1) + (z + 0.5)*(z + 0.5)) * 0.95);
  const steps = Math.abs(z) < 0.75 && x > -0.6 && x < 0.6 ? Math.floor((x + 0.6) / 0.3) * 0.075 : 0.0;
  return Math.max(hill1 + hill2, steps);
}

// --- Build Continuous Skinned Humanoid Mesh (smooth sleeves & torso with crisp color bands!) ---
// Vertex format: [px,py,pz, nx,ny,nz, u,v, b0,b1, w0,w1, matId] (13 floats)
export function buildCharacterGeometry() {
  const verts = [];
  const idx = [];

  function pushVert(p, n, u, v, b0, b1, w0, w1, matId) {
    const i = verts.length / 13;
    verts.push(p[0], p[1], p[2], n[0], n[1], n[2], u, v, b0, b1, w0, w1, matId);
    return i;
  }

  // Smooth tubular limb / torso loft along a polyline with smooth skinning weights!
  function addTube(rings, segs, matId, closedCaps = true) {
    const startIdx = verts.length / 13;
    for (let r = 0; r < rings.length; r++) {
      const rg = rings[r];
      const vCoord = r / Math.max(1, rings.length - 1);
      // Tangent along tube
      const pPrev = rings[Math.max(0, r - 1)].c;
      const pNext = rings[Math.min(rings.length - 1, r + 1)].c;
      const tan = norm3(pNext[0] - pPrev[0], pNext[1] - pPrev[1], pNext[2] - pPrev[2]);
      const ref = Math.abs(tan[1]) < 0.9 ? [0, 1, 0] : [0, 0, 1];
      const uAx = norm3(...cross3(tan, ref));
      const vAx = norm3(...cross3(tan, uAx));
      for (let s = 0; s <= segs; s++) {
        const a = (s / segs) * Math.PI * 2;
        const ca = Math.cos(a), sa = Math.sin(a);
        const rx = rg.rx ?? rg.r, rz = rg.rz ?? rg.r;
        const ox = uAx[0]*ca*rx + vAx[0]*sa*rz;
        const oy = uAx[1]*ca*rx + vAx[1]*sa*rz;
        const oz = uAx[2]*ca*rx + vAx[2]*sa*rz;
        const n = norm3(
          uAx[0]*ca/Math.max(0.01, rx) + vAx[0]*sa/Math.max(0.01, rz),
          uAx[1]*ca/Math.max(0.01, rx) + vAx[1]*sa/Math.max(0.01, rz),
          uAx[2]*ca/Math.max(0.01, rx) + vAx[2]*sa/Math.max(0.01, rz),
        );
        pushVert([rg.c[0] + ox, rg.c[1] + oy, rg.c[2] + oz], n, s / segs, vCoord, rg.b0, rg.b1, rg.w0, rg.w1, rg.mat ?? matId);
      }
    }
    const stride = segs + 1;
    for (let r = 0; r < rings.length - 1; r++) {
      for (let s = 0; s < segs; s++) {
        const a = startIdx + r * stride + s;
        const b = a + 1;
        const c = a + stride;
        const d = c + 1;
        idx.push(a, c, b, b, c, d);
      }
    }
    if (closedCaps) {
      for (const end of [0, rings.length - 1]) {
        const rg = rings[end];
        const pPrev = rings[Math.max(0, end - 1)].c;
        const pNext = rings[Math.min(rings.length - 1, end + 1)].c;
        const tan = norm3(pNext[0] - pPrev[0], pNext[1] - pPrev[1], pNext[2] - pPrev[2]);
        const n = end === 0 ? [-tan[0], -tan[1], -tan[2]] : tan;
        const ci = pushVert(rg.c, n, 0.5, end === 0 ? 0 : 1, rg.b0, rg.b1, rg.w0, rg.w1, rg.mat ?? matId);
        const row = startIdx + end * stride;
        for (let s = 0; s < segs; s++) {
          if (end === 0) idx.push(ci, row + s, row + s + 1);
          else idx.push(ci, row + s + 1, row + s);
        }
      }
    }
  }

  function addSphere(center, rx, ry, rz, b0, b1, w0, w1, matId, stacks = 10, slices = 14) {
    const startIdx = verts.length / 13;
    for (let i = 0; i <= stacks; i++) {
      const phi = (i / stacks) * Math.PI;
      const sp = Math.sin(phi), cp = Math.cos(phi);
      for (let j = 0; j <= slices; j++) {
        const th = (j / slices) * Math.PI * 2;
        const nx = sp * Math.cos(th), ny = cp, nz = sp * Math.sin(th);
        const p = [center[0] + nx*rx, center[1] + ny*ry, center[2] + nz*rz];
        const n = norm3(nx/rx, ny/ry, nz/rz);
        pushVert(p, n, j / slices, i / stacks, b0, b1, w0, w1, matId);
      }
    }
    const stride = slices + 1;
    for (let i = 0; i < stacks; i++) {
      for (let j = 0; j < slices; j++) {
        const a = startIdx + i*stride + j;
        const b = a + 1, c = a + stride, d = c + 1;
        idx.push(a, b, c, b, d, c);
      }
    }
  }

  // 1) Torso (Pelvis 0 -> Chest 1 -> Neck 2) — sleek athletic stylized mannequin
  const torsoRings = [];
  const tData = [
    [0.86, 0.155, 0.115, 0, 1, 1.00, 0.00, 1],
    [0.94, 0.165, 0.120, 0, 1, 0.92, 0.08, 1],
    [1.04, 0.145, 0.108, 0, 1, 0.60, 0.40, 2],
    [1.16, 0.170, 0.120, 0, 1, 0.25, 0.75, 2],
    [1.30, 0.205, 0.132, 1, 0, 0.95, 0.05, 2],
    [1.43, 0.215, 0.125, 1, 2, 0.95, 0.05, 2],
    [1.50, 0.115, 0.095, 1, 2, 0.50, 0.50, 0],
    [1.55, 0.068, 0.068, 2, 1, 0.88, 0.12, 0],
  ];
  for (const [y, rx, rz, b0, b1, w0, w1, m] of tData) {
    torsoRings.push({ c: [0, y, 0], rx, rz, b0, b1, w0, w1, mat: m });
  }
  addTube(torsoRings, 18, 2, true);

  // 2) Head + visor stripe (facing +Z so silhouette and facing direction are unmistakable!)
  addSphere([0.0, 1.67, 0.01], 0.125, 0.145, 0.135, 2, 1, 1.0, 0.0, 0, 12, 16);
  // Crisp cyan/amber visor bar on face (+Z)
  addSphere([0.0, 1.685, 0.118], 0.092, 0.030, 0.036, 2, 1, 1.0, 0.0, 4, 6, 12);

  // 3) Arms (Left: bones 3->4 along -X, Right: bones 5->6 along +X)
  // High-segment dense sleeve tubes with wide smooth weight falloff -> showcases LBS candy-wrapper collapse vs DQS!
  function buildArm(sign, upperB, lowerB) {
    const rings = [];
    const N = 22;
    for (let i = 0; i <= N; i++) {
      const f = i / N; // 0 = tucked shoulder (0.14), 0.5 = elbow (0.54), 1.0 = wrist (0.87)
      const x = sign * lerp(0.14, 0.87, f);
      // Slight sculpted deltoid -> elbow -> muscular forearm -> tapered wrist
      const r = f < 0.22 ? lerp(0.088, 0.074, f / 0.22)
              : f < 0.55 ? lerp(0.074, 0.064, (f - 0.22) / 0.33)
              : f < 0.90 ? lerp(0.064, 0.052, (f - 0.55) / 0.35)
              : lerp(0.052, 0.036, (f - 0.90) / 0.10);
      // Smooth skin weight across elbow & forearm twist zone (f in 0.28..0.84)!
      const wLower = smoothstep(0.28, 0.84, f);
      const wUpper = 1.0 - wLower;
      const mat = f < 0.22 ? 2 : (f > 0.90 ? 0 : 3);
      rings.push({ c: [x, 1.44, 0.0], r, b0: upperB, b1: lowerB, w0: wUpper, w1: wLower, mat });
    }
    addTube(rings, 20, 3, true);
    // Stylized mitten/hand at end of forearm
    addSphere([sign * 0.91, 1.44, 0.0], 0.058, 0.044, 0.052, lowerB, upperB, 1.0, 0.0, 0, 8, 12);
  }
  buildArm(-1, 3, 4);
  buildArm(+1, 5, 6);

  // 4) Legs (Left: 7->8->9, Right: 10->11->12)
  function buildLeg(sign, thighB, shinB, footB) {
    const x = sign * 0.12;
    const rings = [];
    const N = 18;
    for (let i = 0; i <= N; i++) {
      const f = i / N; // 0 = hip (0.90), 0.5 = knee (0.48), 1.0 = ankle (0.09)
      const y = lerp(0.91, 0.09, f);
      const r = f < 0.5 ? lerp(0.092, 0.068, f * 2.0) : lerp(0.068, 0.052, (f - 0.5) * 2.0);
      let b0 = thighB, b1 = shinB, w0 = 1.0, w1 = 0.0;
      if (f < 0.35) { b0 = thighB; b1 = 0; w0 = smoothstep(0.0, 0.18, f) * 0.85 + 0.15; w1 = 1.0 - w0; }
      else if (f < 0.72) { b0 = thighB; b1 = shinB; w1 = smoothstep(0.36, 0.66, f); w0 = 1.0 - w1; }
      else { b0 = shinB; b1 = footB; w1 = smoothstep(0.84, 1.0, f); w0 = 1.0 - w1; }
      rings.push({ c: [x, y, 0.0], r, b0, b1, w0, w1, mat: f > 0.78 ? 5 : 1 });
    }
    addTube(rings, 16, 1, true);
    // Bold boot pointing forward (+Z) so Foot IK flat contact on stairs is super visible!
    const bootRings = [
      { c: [x, 0.055, -0.055], rx: 0.058, rz: 0.052, b0: footB, b1: shinB, w0: 1, w1: 0, mat: 5 },
      { c: [x, 0.052,  0.045], rx: 0.062, rz: 0.048, b0: footB, b1: shinB, w0: 1, w1: 0, mat: 5 },
      { c: [x, 0.042,  0.145], rx: 0.058, rz: 0.036, b0: footB, b1: shinB, w0: 1, w1: 0, mat: 5 },
      { c: [x, 0.032,  0.195], rx: 0.042, rz: 0.024, b0: footB, b1: shinB, w0: 1, w1: 0, mat: 5 },
    ];
    addTube(bootRings, 12, 5, true);
  }
  buildLeg(-1, 7, 8, 9);
  buildLeg(+1, 10, 11, 12);

  return {
    vertices: new Float32Array(verts),
    indices: new Uint16Array(idx),
  };
}

// --- Build Rigid Faceted Polygon Puppet (Stage 1: 1992 Alone in the Dark / 1993 Virtua Fighter!) ---
// Disconnected flat-shaded polygonal limb boxes/prisms with visible joint gaps!
export function buildRigidPuppetGeometry() {
  const verts = [];
  const idx = [];
  function addBox(c, half, bone, matId) {
    const [cx, cy, cz] = c, [hx, hy, hz] = half;
    const faces = [
      [[ 0, 0, 1], [[-1,-1, 1],[ 1,-1, 1],[ 1, 1, 1],[-1, 1, 1]]],
      [[ 0, 0,-1], [[ 1,-1,-1],[-1,-1,-1],[-1, 1,-1],[ 1, 1,-1]]],
      [[ 1, 0, 0], [[ 1,-1, 1],[ 1,-1,-1],[ 1, 1,-1],[ 1, 1, 1]]],
      [[-1, 0, 0], [[-1,-1,-1],[-1,-1, 1],[-1, 1, 1],[-1, 1,-1]]],
      [[ 0, 1, 0], [[-1, 1, 1],[ 1, 1, 1],[ 1, 1,-1],[-1, 1,-1]]],
      [[ 0,-1, 0], [[-1,-1,-1],[ 1,-1,-1],[ 1,-1, 1],[-1,-1, 1]]],
    ];
    for (const [n, corners] of faces) {
      const base = verts.length / 13;
      const uvs = [[0,0],[1,0],[1,1],[0,1]];
      for (let i = 0; i < 4; i++) {
        const cr = corners[i];
        verts.push(cx + cr[0]*hx, cy + cr[1]*hy, cz + cr[2]*hz, n[0], n[1], n[2], uvs[i][0], uvs[i][1], bone, bone, 1, 0, matId);
      }
      idx.push(base, base+1, base+2, base, base+2, base+3);
    }
  }
  addBox([ 0.00, 0.98, 0.00], [0.15, 0.11, 0.10], 0, 1); // Pelvis
  addBox([ 0.00, 1.31, 0.00], [0.19, 0.18, 0.11], 1, 2); // Chest
  addBox([ 0.00, 1.67, 0.01], [0.11, 0.13, 0.12], 2, 0); // Head
  addBox([ 0.00, 1.69, 0.125],[0.085,0.025,0.02], 2, 4); // Visor
  // Disconnected arms with clear gaps at elbows & shoulders!
  addBox([-0.38, 1.44, 0.00], [0.12, 0.058, 0.058], 3, 2);
  addBox([-0.69, 1.44, 0.00], [0.13, 0.050, 0.050], 4, 3);
  addBox([ 0.38, 1.44, 0.00], [0.12, 0.058, 0.058], 5, 2);
  addBox([ 0.69, 1.44, 0.00], [0.13, 0.050, 0.050], 6, 3);
  // Disconnected legs with clear gaps at knees & hips!
  addBox([-0.12, 0.69, 0.00], [0.072, 0.175, 0.072], 7, 1);
  addBox([-0.12, 0.28, 0.00], [0.056, 0.165, 0.056], 8, 1);
  addBox([-0.12, 0.05, 0.06], [0.058, 0.040, 0.115], 9, 5);
  addBox([ 0.12, 0.69, 0.00], [0.072, 0.175, 0.072], 10, 1);
  addBox([ 0.12, 0.28, 0.00], [0.056, 0.165, 0.056], 11, 1);
  addBox([ 0.12, 0.05, 0.06], [0.058, 0.040, 0.115], 12, 5);
  return { vertices: new Float32Array(verts), indices: new Uint16Array(idx) };
}

// --- Build Arena Mesh (Stepped Stone Staircase / Terraced Platform) ---
export function buildArenaGeometry(stairsMode) {
  const N = 48;
  const size = 5.4;
  const verts = []; // [x,y,z, nx,ny,nz, u,v]
  const idx = [];
  for (let iz = 0; iz <= N; iz++) {
    for (let ix = 0; ix <= N; ix++) {
      const u = ix / N, v = iz / N;
      const x = (u - 0.5) * size;
      const z = (v - 0.5) * size;
      const y = getArenaHeight(x, z, stairsMode);
      const eps = 0.04;
      const hx = getArenaHeight(x + eps, z, stairsMode) - getArenaHeight(x - eps, z, stairsMode);
      const hz = getArenaHeight(x, z + eps, stairsMode) - getArenaHeight(x, z - eps, stairsMode);
      const n = norm3(-hx, 2 * eps, -hz);
      verts.push(x, y, z, n[0], n[1], n[2], x, z);
    }
  }
  const stride = N + 1;
  for (let iz = 0; iz < N; iz++) {
    for (let ix = 0; ix < N; ix++) {
      const a = iz * stride + ix;
      const b = a + 1, c = a + stride, d = c + 1;
      idx.push(a, c, b, b, c, d);
    }
  }
  return { vertices: new Float32Array(verts), indices: new Uint16Array(idx) };
}

// --- Forward Kinematics: computes world joint positions + bone skinning matrices & dual quaternions ---
export function computeSkeleton(rootPos, localRots) {
  const worldPos = new Array(BONE_COUNT);
  const worldRot = new Array(BONE_COUNT);
  for (let i = 0; i < BONE_COUNT; i++) {
    const p = BONE_PARENTS[i];
    if (p < 0) {
      worldRot[i] = qNorm(localRots[i] || qId());
      worldPos[i] = [rootPos[0], rootPos[1], rootPos[2]];
    } else {
      const offset = [
        REST_JOINTS[i][0] - REST_JOINTS[p][0],
        REST_JOINTS[i][1] - REST_JOINTS[p][1],
        REST_JOINTS[i][2] - REST_JOINTS[p][2],
      ];
      const rotOff = qRotVec(worldRot[p], offset);
      worldPos[i] = [worldPos[p][0] + rotOff[0], worldPos[p][1] + rotOff[1], worldPos[p][2] + rotOff[2]];
      worldRot[i] = qNorm(qMul(worldRot[p], localRots[i] || qId()));
    }
  }
  return packSkinning(worldPos, worldRot);
}

// Convert world bone poses (worldPos, worldRot) into GPU skinning uniforms (mat4[] + DQ real/dual[])
export function packSkinning(worldPos, worldRot) {
  const mats = new Float32Array(BONE_COUNT * 16);
  const dqReal = new Float32Array(BONE_COUNT * 4);
  const dqDual = new Float32Array(BONE_COUNT * 4);
  for (let i = 0; i < BONE_COUNT; i++) {
    // Skin transform: p_world = R_i * (p_bind - J_i) + worldPos[i] = R_i * p_bind + (worldPos[i] - R_i * J_i)
    const rj = qRotVec(worldRot[i], REST_JOINTS[i]);
    const trans = [worldPos[i][0] - rj[0], worldPos[i][1] - rj[1], worldPos[i][2] - rj[2]];
    const { m, qr, qd } = rigidToMat4AndDQ(worldRot[i], trans);
    mats.set(m, i * 16);
    dqReal.set(qr, i * 4);
    dqDual.set(qd, i * 4);
  }
  return { worldPos, worldRot, mats, dqReal, dqDual };
}

// --- Analytical 2-Bone Leg IK (Law of Cosines, exact knee pole vector forward!) ---
export function solveTwoBoneLegIK(hipPos, targetFoot, fwdDir, upperLen = 0.42, lowerLen = 0.40) {
  const dx = targetFoot[0] - hipPos[0];
  const dy = targetFoot[1] - hipPos[1];
  const dz = targetFoot[2] - hipPos[2];
  const dist = clamp(Math.hypot(dx, dy, dz), 0.14, upperLen + lowerLen - 0.005);
  const dir = norm3(dx, dy, dz);
  // Compute knee bend plane perpendicular to right axis
  const right = norm3(...cross3([0, 1, 0], fwdDir));
  const bendAxis = norm3(...cross3(dir, right)); // points forward relative to leg line
  const cosHip = clamp((upperLen*upperLen + dist*dist - lowerLen*lowerLen) / (2 * upperLen * dist), -1, 1);
  const sinHip = Math.sqrt(Math.max(0, 1 - cosHip * cosHip));
  const kneePos = [
    hipPos[0] + (dir[0] * cosHip + bendAxis[0] * sinHip) * upperLen,
    hipPos[1] + (dir[1] * cosHip + bendAxis[1] * sinHip) * upperLen,
    hipPos[2] + (dir[2] * cosHip + bendAxis[2] * sinHip) * upperLen,
  ];
  const footPos = [
    hipPos[0] + dir[0] * dist,
    hipPos[1] + dir[1] * dist,
    hipPos[2] + dir[2] * dist,
  ];
  return { kneePos, footPos };
}

// Build orientation quaternion mapping local -Y (downward leg rest bone) to vector `dir`, aligned with `fwd`
function quatFromDownAndFwd(dir, fwd) {
  const down = norm3(dir[0], dir[1], dir[2]);
  const yAx = [-down[0], -down[1], -down[2]];
  const xAx = norm3(...cross3(yAx, fwd));
  const zAx = norm3(...cross3(xAx, yAx));
  // Rotation matrix columns: xAx, yAx, zAx -> quaternion
  const m00 = xAx[0], m01 = yAx[0], m02 = zAx[0];
  const m10 = xAx[1], m11 = yAx[1], m12 = zAx[1];
  const m20 = xAx[2], m21 = yAx[2], m22 = zAx[2];
  const tr = m00 + m11 + m22;
  let qw, qx, qy, qz;
  if (tr > 0) {
    const s = Math.sqrt(tr + 1.0) * 2;
    qw = 0.25 * s; qx = (m21 - m12) / s; qy = (m02 - m20) / s; qz = (m10 - m01) / s;
  } else if (m00 > m11 && m00 > m22) {
    const s = Math.sqrt(1.0 + m00 - m11 - m22) * 2;
    qw = (m21 - m12) / s; qx = 0.25 * s; qy = (m01 + m10) / s; qz = (m02 + m20) / s;
  } else if (m11 > m22) {
    const s = Math.sqrt(1.0 + m11 - m00 - m22) * 2;
    qw = (m02 - m20) / s; qx = (m01 + m10) / s; qy = 0.25 * s; qz = (m12 + m21) / s;
  } else {
    const s = Math.sqrt(1.0 + m22 - m00 - m11) * 2;
    qw = (m10 - m01) / s; qx = (m02 + m20) / s; qy = (m12 + m21) / s; qz = 0.25 * s;
  }
  return qNorm([qx, qy, qz, qw]);
}

// --- Pose Generators for All 8 Historical Animation Eras ---
export function evaluateWalkPose(t, opts = {}) {
  const {
    posX = 0, posZ = 0, facingYaw = Math.PI * 0.5,
    speed = 1.0, twistMode = false, twistAngle = 0,
    useIK = false, stairsMode = 0, leanRoll = 0, leanPitch = 0,
  } = opts;
  const cycle = t * 4.2 * speed;
  const stride = Math.sin(cycle);
  const liftL = Math.max(0, Math.cos(cycle));
  const liftR = Math.max(0, -Math.cos(cycle));
  const bob = Math.abs(Math.sin(cycle)) * 0.045 * clamp(speed, 0, 1.2);

  // Base ground height under pelvis
  const groundCenter = getArenaHeight(posX, posZ, stairsMode);
  const fwd = [Math.sin(facingYaw), 0, Math.cos(facingYaw)];
  const right = [Math.cos(facingYaw), 0, -Math.sin(facingYaw)];

  // Compute desired foot world targets when IK is ON
  let pelvisY = groundCenter + 0.92 + bob;
  const footLWorld = [
    posX - right[0] * 0.13 + fwd[0] * (stride * 0.34 * speed),
    0,
    posZ - right[2] * 0.13 + fwd[2] * (stride * 0.34 * speed),
  ];
  const footRWorld = [
    posX + right[0] * 0.13 - fwd[0] * (stride * 0.34 * speed),
    0,
    posZ + right[2] * 0.13 - fwd[2] * (stride * 0.34 * speed),
  ];
  const hL = getArenaHeight(footLWorld[0], footLWorld[2], stairsMode);
  const hR = getArenaHeight(footRWorld[0], footRWorld[2], stairsMode);
  footLWorld[1] = hL + 0.08 + liftL * 0.16 * clamp(speed, 0, 1.2);
  footRWorld[1] = hR + 0.08 + liftR * 0.16 * clamp(speed, 0, 1.2);

  if (useIK) {
    // Lower pelvis to keep lowest planted foot cleanly reachable (real game Foot IK!)
    const minFootGround = Math.min(hL, hR);
    pelvisY = Math.min(pelvisY, minFootGround + 0.87 + bob * 0.6);
  } else if (stairsMode === 1) {
    // Without IK: character walks on an averaged slope -> feet visibly float and clip into stone steps!
    const avgSlope = clamp((posX + 1.5) / 3.3, 0, 1) * 5 * 0.135;
    pelvisY = avgSlope + 0.94 + bob;
  }

  const rots = new Array(BONE_COUNT).fill(null).map(() => qId());
  rots[0] = qMul(qFromAxisAngle(0, 1, 0, facingYaw), qFromEulerXYZ(leanPitch + 0.05 * speed, -stride * 0.08 * speed, leanRoll));
  rots[1] = qFromEulerXYZ(0.05 * speed, stride * 0.12 * speed, 0);
  rots[2] = qFromEulerXYZ(-0.04, -stride * 0.05 * speed, 0);

  if (twistMode) {
    // Hero showcase pose for LBS Candy-Wrapper Collapse vs Dual Quaternion Skinning:
    // Both arms held horizontally out in clear front-3/4 view twisting 190° so Split Left=LBS vs Right=DQS is unmistakable!
    rots[0] = qFromAxisAngle(0, 1, 0, facingYaw);
    rots[1] = qFromEulerXYZ(0.0, Math.sin(t * 0.8) * 0.04, 0);
    rots[2] = qFromEulerXYZ(0.03, Math.sin(t * 0.6) * 0.06, 0);
    rots[3] = qFromEulerXYZ(0.0, 0.22, 0.24);
    rots[4] = qFromEulerXYZ(-twistAngle, 0.0, 0.0);
    rots[5] = qFromEulerXYZ(0.0, -0.22, -0.24);
    rots[6] = qFromEulerXYZ(twistAngle, 0.0, 0.0);
    rots[7] = qFromEulerXYZ(0.04, 0, 0.03);
    rots[8] = qFromEulerXYZ(0.06, 0, 0);
    rots[10] = qFromEulerXYZ(-0.04, 0, -0.03);
    rots[11] = qFromEulerXYZ(0.06, 0, 0);
    const sk = computeSkeleton([posX, pelvisY, posZ], rots);
    return { ...sk, footTargets: [footLWorld, footRWorld] };
  }

  // Normal arms swinging opposite legs
  rots[3] = qFromEulerXYZ(-stride * 0.55 * speed, 0.15, 1.18);
  rots[4] = qFromEulerXYZ(0, 0.42 + Math.max(0, stride) * 0.35 * speed, 0);
  rots[5] = qFromEulerXYZ(stride * 0.55 * speed, -0.15, -1.18);
  rots[6] = qFromEulerXYZ(0, -0.42 - Math.max(0, -stride) * 0.35 * speed, 0);

  // FK legs (used directly when IK is OFF; overridden cleanly by analytical 2-bone IK when ON!)
  rots[7]  = qFromEulerXYZ(-stride * 0.62 * speed - liftL * 0.25, 0, 0);
  rots[8]  = qFromEulerXYZ(Math.max(0.08, liftL * 0.95 * speed + 0.12), 0, 0);
  rots[9]  = qFromEulerXYZ(-liftL * 0.25, 0, 0);
  rots[10] = qFromEulerXYZ(stride * 0.62 * speed - liftR * 0.25, 0, 0);
  rots[11] = qFromEulerXYZ(Math.max(0.08, liftR * 0.95 * speed + 0.12), 0, 0);
  rots[12] = qFromEulerXYZ(-liftR * 0.25, 0, 0);

  const sk = computeSkeleton([posX, pelvisY, posZ], rots);
  if (!useIK) return { ...sk, footTargets: [footLWorld, footRWorld] };

  // Apply analytical 2-bone Foot IK directly on world leg joints (7->8->9 and 10->11->12)!
  const wp = sk.worldPos.map(v => [...v]);
  const wr = sk.worldRot.map(v => [...v]);
  const footYawQ = qFromAxisAngle(0, 1, 0, facingYaw);

  const ikL = solveTwoBoneLegIK(wp[7], footLWorld, fwd, 0.42, 0.40);
  wp[8] = ikL.kneePos; wp[9] = ikL.footPos;
  wr[7] = quatFromDownAndFwd([wp[8][0]-wp[7][0], wp[8][1]-wp[7][1], wp[8][2]-wp[7][2]], fwd);
  wr[8] = quatFromDownAndFwd([wp[9][0]-wp[8][0], wp[9][1]-wp[8][1], wp[9][2]-wp[8][2]], fwd);
  wr[9] = footYawQ;

  const ikR = solveTwoBoneLegIK(wp[10], footRWorld, fwd, 0.42, 0.40);
  wp[11] = ikR.kneePos; wp[12] = ikR.footPos;
  wr[10] = quatFromDownAndFwd([wp[11][0]-wp[10][0], wp[11][1]-wp[10][1], wp[11][2]-wp[10][2]], fwd);
  wr[11] = quatFromDownAndFwd([wp[12][0]-wp[11][0], wp[12][1]-wp[11][1], wp[12][2]-wp[11][2]], fwd);
  wr[12] = footYawQ;

  return { ...packSkinning(wp, wr), footTargets: [ikL.footPos, ikR.footPos] };
}

// --- Real Multi-Body Verlet Ragdoll & Active PD-Muscle Euphoria Simulation (Stage 6!) ---
export function createRagdollSim() {
  const pos = REST_JOINTS.map(v => [...v]);
  const prev = REST_JOINTS.map(v => [...v]);
  const constraints = [];
  for (let i = 1; i < BONE_COUNT; i++) {
    const p = BONE_PARENTS[i];
    const d = Math.hypot(
      REST_JOINTS[i][0] - REST_JOINTS[p][0],
      REST_JOINTS[i][1] - REST_JOINTS[p][1],
      REST_JOINTS[i][2] - REST_JOINTS[p][2],
    );
    constraints.push([p, i, d]);
  }
  // Extra cross-bracing constraints (shoulders & hips keep torso rigid!)
  const extra = [[3, 5], [7, 10], [0, 3], [0, 5], [1, 7], [1, 10]];
  for (const [a, b] of extra) {
    const d = Math.hypot(
      REST_JOINTS[a][0] - REST_JOINTS[b][0],
      REST_JOINTS[a][1] - REST_JOINTS[b][1],
      REST_JOINTS[a][2] - REST_JOINTS[b][2],
    );
    constraints.push([a, b, d]);
  }

  let impulseAge = 0;

  function reset(baseX = -0.35, baseZ = 0.0, stairsMode = 1) {
    const g = getArenaHeight(baseX, baseZ, stairsMode);
    for (let i = 0; i < BONE_COUNT; i++) {
      // Face +X up the stairs (rotate REST_JOINTS by +90° around Y)
      const rx = REST_JOINTS[i][2] + baseX;
      const ry = REST_JOINTS[i][1] + g;
      const rz = -REST_JOINTS[i][0] + baseZ;
      pos[i] = [rx, ry, rz];
      prev[i] = [rx, ry, rz];
    }
    impulseAge = 0;
  }

  function push(strength = 1.0) {
    // Knock chest & head backward (-X) and slightly up so character stumbles dramatically!
    prev[1][0] += 0.055 * strength;
    prev[2][0] += 0.068 * strength;
    prev[0][0] += 0.036 * strength;
    prev[1][1] -= 0.015 * strength;
    impulseAge = 0.001;
  }

  function step(dt, activeMuscle, stairsMode) {
    const h = Math.min(dt, 0.025);
    impulseAge += h;
    const damp = activeMuscle ? 0.978 : 0.992;
    const grav = -9.6;

    // Verlet integration + Active Euphoria PD-muscle balance reflexes!
    for (let i = 0; i < BONE_COUNT; i++) {
      const vx = (pos[i][0] - prev[i][0]) * damp;
      const vy = (pos[i][1] - prev[i][1]) * damp;
      const vz = (pos[i][2] - prev[i][2]) * damp;
      prev[i][0] = pos[i][0]; prev[i][1] = pos[i][1]; prev[i][2] = pos[i][2];
      let ax = 0, ay = grav, az = 0;

      if (activeMuscle) {
        // Active Euphoria reflexes:
        // 1. Torso & head fight gravity to stay upright & protect the head!
        const gY = getArenaHeight(pos[0][0], pos[0][2], stairsMode);
        if (i === 0) ay += (gY + 0.92 - pos[0][1]) * 38.0;
        if (i === 1) { ay += (pos[0][1] + 0.34 - pos[1][1]) * 48.0; ax += (pos[0][0] + 0.06 - pos[1][0]) * 26.0; }
        if (i === 2) { ay += (pos[1][1] + 0.34 - pos[2][1]) * 56.0; ax += (pos[1][0] + 0.08 - pos[2][0]) * 32.0; }
        // 2. Arms fling outward & forward to windmill and catch balance!
        if (i === 4) { ay += 11.5 + Math.sin(impulseAge * 14.0) * 8.0; az += 8.0; ax += 6.0; }
        if (i === 6) { ay += 11.5 - Math.sin(impulseAge * 14.0) * 8.0; az -= 8.0; ax += 6.0; }
        // 3. Feet actively step backward to brace beneath falling center of mass!
        if (i === 9 || i === 12) {
          const braceX = pos[0][0] + (i === 9 ? -0.32 : 0.14);
          ax += (braceX - pos[i][0]) * 24.0;
          ay += (gY + 0.08 - pos[i][1]) * 20.0;
        }
      }

      pos[i][0] += vx + ax * h * h;
      pos[i][1] += vy + ay * h * h;
      pos[i][2] += vz + az * h * h;
    }

    // Distance constraints + stepped-arena floor collision
    for (let iter = 0; iter < 8; iter++) {
      for (const [a, b, restD] of constraints) {
        const dx = pos[b][0] - pos[a][0];
        const dy = pos[b][1] - pos[a][1];
        const dz = pos[b][2] - pos[a][2];
        const d = Math.hypot(dx, dy, dz) || 1e-4;
        const diff = (d - restD) / d * 0.5;
        pos[a][0] += dx * diff; pos[a][1] += dy * diff; pos[a][2] += dz * diff;
        pos[b][0] -= dx * diff; pos[b][1] -= dy * diff; pos[b][2] -= dz * diff;
      }
      for (let i = 0; i < BONE_COUNT; i++) {
        const ground = getArenaHeight(pos[i][0], pos[i][2], stairsMode) + 0.075;
        if (pos[i][1] < ground) {
          pos[i][1] = ground;
          // Ground friction
          prev[i][0] = lerp(prev[i][0], pos[i][0], 0.35);
          prev[i][2] = lerp(prev[i][2], pos[i][2], 0.35);
        }
        pos[i][0] = clamp(pos[i][0], -2.3, 2.3);
        pos[i][2] = clamp(pos[i][2], -2.2, 2.2);
      }
    }
  }

  function toSkinning() {
    // Reconstruct exact bone orientations using shortest-arc quatFromTo from each bone's rest axis!
    const wp = pos.map(v => [...v]);
    const wr = new Array(BONE_COUNT);

    function quatFromTo(fromV, toV) {
      const f = norm3(fromV[0], fromV[1], fromV[2]);
      const t = norm3(toV[0], toV[1], toV[2]);
      const d = f[0]*t[0] + f[1]*t[1] + f[2]*t[2];
      if (d > 0.9998) return qId();
      if (d < -0.9998) {
        const ax = Math.abs(f[0]) < 0.8 ? cross3(f, [1, 0, 0]) : cross3(f, [0, 1, 0]);
        return qFromAxisAngle(ax[0], ax[1], ax[2], Math.PI);
      }
      const c = cross3(f, t);
      return qNorm([c[0], c[1], c[2], 1.0 + d]);
    }

    const torsoUp = norm3(wp[1][0] - wp[0][0], wp[1][1] - wp[0][1], wp[1][2] - wp[0][2]);
    const hipRight = norm3(wp[10][0] - wp[7][0], wp[10][1] - wp[7][1], wp[10][2] - wp[7][2]);
    const torsoFwd = norm3(...cross3(torsoUp, hipRight));

    wr[0] = quatFromDownAndFwd([-torsoUp[0], -torsoUp[1], -torsoUp[2]], torsoFwd);
    wr[1] = quatFromDownAndFwd([-(wp[2][0]-wp[1][0]), -(wp[2][1]-wp[1][1]), -(wp[2][2]-wp[1][2])], torsoFwd);
    wr[2] = wr[1];
    // Arms rest along -X (left: 3->4) and +X (right: 5->6) -> exact shortest-arc from ±X to world arm vector!
    const lArmDir = [wp[4][0]-wp[3][0], wp[4][1]-wp[3][1], wp[4][2]-wp[3][2]];
    const rArmDir = [wp[6][0]-wp[5][0], wp[6][1]-wp[5][1], wp[6][2]-wp[5][2]];
    wr[3] = quatFromTo([-1, 0, 0], lArmDir);
    wr[4] = wr[3];
    wr[5] = quatFromTo([ 1, 0, 0], rArmDir);
    wr[6] = wr[5];
    wr[7]  = quatFromDownAndFwd([wp[8][0]-wp[7][0],   wp[8][1]-wp[7][1],   wp[8][2]-wp[7][2]],   torsoFwd);
    wr[8]  = quatFromDownAndFwd([wp[9][0]-wp[8][0],   wp[9][1]-wp[8][1],   wp[9][2]-wp[8][2]],   torsoFwd);
    wr[9]  = wr[8];
    wr[10] = quatFromDownAndFwd([wp[11][0]-wp[10][0], wp[11][1]-wp[10][1], wp[11][2]-wp[10][2]], torsoFwd);
    wr[11] = quatFromDownAndFwd([wp[12][0]-wp[11][0], wp[12][1]-wp[11][1], wp[12][2]-wp[11][2]], torsoFwd);
    wr[12] = wr[11];

    return packSkinning(wp, wr);
  }

  reset();
  return { reset, push, step, toSkinning };
}
