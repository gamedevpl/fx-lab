// Pixel-Art Gaussian Splats — 5-stage live WebGL2 EWA 3D surfel pipeline.

import {
  clamp, lerp, smoothstep, norm3, cross3, hexToRgb01, mulberry32,
  makeLookAt, makePerspective, FULL_VS, linkProgram, makeTex2D,
} from "./gl-utils.js";

const PALETTE_HEX = [
  "#141426", "#273459", "#3e5482", "#637da8", "#c6dbed", "#fff2ad",
  "#30354f", "#515875", "#7b839e", "#aeb4c7", "#e6dfd1", "#5e213b",
  "#9c2f44", "#d64f4b", "#f28961", "#1b4047", "#2b7060", "#50a369",
  "#96d171", "#54332d", "#915a3f", "#26799e", "#56d1e3", "#ffb23d",
];

const PALETTE_F32 = new Float32Array(24 * 3);
PALETTE_HEX.forEach((h, i) => {
  const [r, g, b] = hexToRgb01(h);
  PALETTE_F32[i * 3] = r;
  PALETTE_F32[i * 3 + 1] = g;
  PALETTE_F32[i * 3 + 2] = b;
});

const TOWER_X = -0.24, TOWER_Z = -0.10, TOWER_R = 0.56, TOWER_H = 1.56;
const LANTERN_POS = [TOWER_X + 0.72, 1.24, TOWER_Z + 0.34];
const PINE1_X = 0.78, PINE1_Z = 0.14;
const PINE2_X = -1.00, PINE2_Z = 0.34;
const POND_X = 0.44, POND_Z = 0.88;
const LOOP_T = 26.0;

function basisFromNormal(nx, ny, nz) {
  const n = norm3(nx, ny, nz);
  const up = Math.abs(n[1]) < 0.92 ? [0, 1, 0] : [1, 0, 0];
  const t1 = norm3(...cross3(up, n));
  const t2 = cross3(n, t1);
  return [t1, t2, n];
}

function hash2(x, y) {
  const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453123;
  return s - Math.floor(s);
}

function valueNoise2(x, y) {
  const ix = Math.floor(x), iy = Math.floor(y);
  const fx = x - ix, fy = y - iy;
  const ux = fx * fx * (3 - 2 * fx), uy = fy * fy * (3 - 2 * fy);
  const a = hash2(ix, iy), b = hash2(ix + 1, iy);
  const c = hash2(ix, iy + 1), d = hash2(ix + 1, iy + 1);
  return lerp(lerp(a, b, ux), lerp(c, d, ux), uy);
}

function islandTopRadius(theta) {
  return 1.56
    + 0.14 * Math.cos(theta * 2.0 - 0.5)
    + 0.10 * Math.sin(theta * 3.0 + 0.8)
    + 0.06 * Math.cos(theta * 5.0 + 1.1);
}

function computeBakedAO(x, y, z, nx, ny, nz, objId) {
  let ao = 1.0;
  const dTower = Math.hypot(x - TOWER_X, z - TOWER_Z);
  if (objId !== 3 && objId !== 5 && objId !== 7 && y < 0.35) {
    const sx = x - TOWER_X + 0.55;
    const sz = z - TOWER_Z + 0.26;
    if (Math.hypot(sx, sz) < TOWER_R * 1.15 && x < TOWER_X + 0.2) ao *= 0.68;
    if (dTower < TOWER_R + 0.22) ao *= lerp(0.72, 1.0, clamp((dTower - TOWER_R) / 0.22, 0, 1));
  }
  if (objId === 2) {
    const dp1 = Math.hypot(x - PINE1_X, z - PINE1_Z);
    if (dp1 < 0.58) ao *= lerp(0.58, 1.0, dp1 / 0.58);
    const dp2 = Math.hypot(x - PINE2_X, z - PINE2_Z);
    if (dp2 < 0.44) ao *= lerp(0.62, 1.0, dp2 / 0.44);
  }
  if (objId === 3 && y > 1.32 && y < 1.66) {
    ao *= lerp(0.62, 1.0, clamp((1.62 - y) / 0.30, 0, 1));
  }
  if (ny < -0.2) ao *= lerp(1.0, 0.62, clamp((-ny - 0.2) / 0.8, 0, 1));
  return ao;
}

function buildIslandSplats() {
  const rand = mulberry32(20261119);
  const opaqueSplats = [];
  const transSplats = [];

  function pushSplat(list, {
    pos, normal, scale, color, opacity = 0.94, emissive = 0.0, ao = 1.0,
    objectId = 1, animType = 0, animA = 0, animB = 0, animC = 0,
  }) {
    const [t1, , n] = basisFromNormal(normal[0], normal[1], normal[2]);
    const r1 = Array.isArray(scale) ? scale[0] : scale;
    const r2 = Array.isArray(scale) ? scale[1] : scale;
    const r3 = Array.isArray(scale) && scale.length > 2 ? scale[2] : Math.min(r1, r2) * 0.32;
    list.push({
      px: pos[0], py: pos[1], pz: pos[2],
      nx: n[0], ny: n[1], nz: n[2],
      tx: t1[0], ty: t1[1], tz: t1[2],
      r1, r2, r3,
      cr: clamp(color[0], 0, 1), cg: clamp(color[1], 0, 1), cb: clamp(color[2], 0, 1),
      opacity, emissive, ao: clamp(ao, 0.25, 1.0), objectId,
      animType, animA, animB, animC,
    });
  }

  // Rocky floating crag
  {
    const rings = 34;
    const cragDepth = 1.72;
    for (let i = 0; i <= rings; i++) {
      const v = i / rings;
      const y = -0.02 - v * cragDepth;
      const profile = Math.pow(1.0 - v, 0.72) * (1.0 + 0.08 * Math.sin(v * 14.0));
      const avgR = Math.max(0.06, 1.54 * profile);
      const count = Math.max(8, Math.round(2 * Math.PI * avgR / 0.072));
      for (let j = 0; j < count; j++) {
        const theta = (j + (i % 2) * 0.5) / count * Math.PI * 2.0 + (rand() - 0.5) * 0.04;
        const baseR = islandTopRadius(theta) * profile;
        const ridge = 1.0 + 0.11 * Math.cos(theta * 7.0 + v * 4.5) + 0.07 * Math.sin(theta * 11.0 - v * 6.0);
        const r = baseR * ridge;
        const x = Math.cos(theta) * r, z = Math.sin(theta) * r;
        const nx = Math.cos(theta) * 0.72 + 0.18 * Math.sin(theta * 7.0 + v * 4.5);
        const nz = Math.sin(theta) * 0.72 - 0.18 * Math.cos(theta * 7.0 + v * 4.5);
        const ny = -0.58 - 0.22 * v;
        const strata = valueNoise2(theta * 3.0, v * 9.0);
        const cr = lerp(0.32, 0.54, strata) * lerp(1.0, 0.78, v);
        const cg = lerp(0.35, 0.57, strata) * lerp(1.0, 0.80, v);
        const cb = lerp(0.46, 0.68, strata) * lerp(1.0, 0.86, v);
        const sz = lerp(0.078, 0.058, v) * (0.9 + rand() * 0.22);
        pushSplat(opaqueSplats, {
          pos: [x, y, z], normal: [nx, ny, nz], scale: [sz, sz * 0.9, sz * 0.45],
          color: [cr, cg, cb], ao: computeBakedAO(x, y, z, nx, ny, nz, 1), objectId: 1,
        });
      }
    }
    for (let k = 0; k < 5; k++) {
      const th = k * 1.25 + 0.4;
      const baseY = -0.45 - (k % 3) * 0.25;
      const baseR = islandTopRadius(th) * 0.76;
      for (let s = 0; s < 80; s++) {
        const u = rand(), w = rand();
        const ang = th + (u - 0.5) * 0.35;
        const yy = baseY - w * 0.52;
        const rr = baseR * (1.0 - w * 0.55) + 0.12 * Math.sin(w * Math.PI);
        const x = Math.cos(ang) * rr, z = Math.sin(ang) * rr;
        const [nx, ny, nz] = norm3(Math.cos(ang), -0.45, Math.sin(ang));
        pushSplat(opaqueSplats, {
          pos: [x, yy, z], normal: [nx, ny, nz], scale: [0.074, 0.068, 0.036],
          color: [0.40, 0.44, 0.56], ao: 0.78, objectId: 1,
        });
      }
    }
  }

  // Grassy moss plateau + overhang rim + wildflowers
  {
    const rings = 23;
    for (let i = 0; i <= rings; i++) {
      const u = i / rings;
      const count = i === 0 ? 1 : Math.max(8, Math.round(2 * Math.PI * (u * 1.62) / 0.070));
      for (let j = 0; j < count; j++) {
        const theta = (j + (i % 2) * 0.5) / count * Math.PI * 2.0 + (rand() - 0.5) * 0.03;
        const r = u * islandTopRadius(theta) * 1.03;
        const x = Math.cos(theta) * r, z = Math.sin(theta) * r;
        if (Math.hypot(x - POND_X, z - POND_Z) < 0.42) continue;
        if (Math.hypot(x - TOWER_X, z - TOWER_Z) < TOWER_R * 0.90) continue;
        const y = 0.02 + 0.06 * Math.cos(u * Math.PI * 0.5) + 0.03 * Math.sin(x * 2.4 + z * 1.9);
        const nVal = valueNoise2(x * 3.1 + 4.0, z * 3.1 + 7.0);
        const distPath = Math.abs((x - 0.05) * 0.85 - (z - 0.45) * 0.52);
        const onPath = distPath < 0.14 && z > 0.25 && z < 0.85 && x > -0.15 && x < 0.38;
        let cr, cg, cb, oid = 2;
        if (onPath && Math.sin((x + z) * 16.0) > -0.25) {
          cr = 0.66; cg = 0.68; cb = 0.74; oid = 4;
        } else {
          cr = lerp(0.24, 0.46, nVal);
          cg = lerp(0.56, 0.74, nVal);
          cb = lerp(0.35, 0.42, nVal);
        }
        const nx = (rand() - 0.5) * 0.18, nz = (rand() - 0.5) * 0.18, ny = 1.0;
        const sz = 0.074 * (0.9 + rand() * 0.22);
        pushSplat(opaqueSplats, {
          pos: [x, y, z], normal: [nx, ny, nz], scale: [sz, sz, sz * 0.4],
          color: [cr, cg, cb], ao: computeBakedAO(x, y, z, nx, ny, nz, oid), objectId: oid,
        });
      }
    }
    for (let i = 0; i < 4; i++) {
      const v = i / 3;
      const count = 130;
      for (let j = 0; j < count; j++) {
        const theta = (j / count) * Math.PI * 2.0;
        const r = islandTopRadius(theta) * (1.035 - v * 0.03);
        const x = Math.cos(theta) * r, z = Math.sin(theta) * r;
        if (Math.hypot(x - (POND_X + 0.26), z - (POND_Z + 0.34)) < 0.30) continue;
        const droop = 0.06 * Math.sin(theta * 9.0) + 0.04 * Math.cos(theta * 15.0);
        const y = 0.02 - v * (0.16 + Math.max(0, droop));
        const nx = Math.cos(theta), ny = lerp(0.45, -0.15, v), nz = Math.sin(theta);
        pushSplat(opaqueSplats, {
          pos: [x, y, z], normal: [nx, ny, nz], scale: [0.068, 0.064, 0.034],
          color: [lerp(0.32, 0.20, v), lerp(0.64, 0.48, v), lerp(0.38, 0.34, v)],
          ao: computeBakedAO(x, y, z, nx, ny, nz, 2), objectId: 2,
        });
      }
    }
    const flowers = [
      [0.32, 0.42], [0.88, -0.45], [-0.85, -0.52], [0.12, 1.02],
      [-0.52, 0.92], [1.12, 0.56], [-1.08, -0.12], [0.58, -0.78],
    ];
    for (const [fx, fz] of flowers) {
      for (let k = 0; k < 5; k++) {
        const a = k * 1.25;
        pushSplat(opaqueSplats, {
          pos: [fx + Math.cos(a) * 0.04, 0.11 + (k % 2) * 0.02, fz + Math.sin(a) * 0.04],
          normal: [0, 1, 0], scale: [0.042, 0.042, 0.028],
          color: k % 2 === 0 ? [0.98, 0.85, 0.38] : [0.94, 0.48, 0.46],
          ao: 1.0, objectId: 2,
        });
      }
    }
  }

  // Stone watchtower + glowing windows + wooden door + battlements
  {
    const ySteps = 27;
    for (let i = 0; i <= ySteps; i++) {
      const v = i / ySteps;
      const y = 0.04 + v * TOWER_H;
      const r = TOWER_R + smoothstep(0.18, 0.0, v) * 0.09 + smoothstep(0.84, 0.95, v) * 0.08 - v * 0.03;
      const count = Math.round(2 * Math.PI * r / 0.058);
      for (let j = 0; j < count; j++) {
        const theta = (j + (i % 2) * 0.5) / count * Math.PI * 2.0;
        const x = TOWER_X + Math.cos(theta) * r, z = TOWER_Z + Math.sin(theta) * r;
        const nx = Math.cos(theta), nz = Math.sin(theta), ny = 0.02;
        const dDoorA = Math.atan2(Math.sin(theta - 1.05), Math.cos(theta - 1.05));
        const inDoor = Math.abs(dDoorA) < 0.32 && y < 0.58 - dDoorA * dDoorA * 1.4;
        const inDoorArch = !inDoor && Math.abs(dDoorA) < 0.42 && y < 0.67 - dDoorA * dDoorA * 1.25;
        const dWin1 = Math.atan2(Math.sin(theta - 0.32), Math.cos(theta - 0.32));
        const dWin2 = Math.atan2(Math.sin(theta - 2.35), Math.cos(theta - 2.35));
        const dWin3 = Math.atan2(Math.sin(theta + 1.55), Math.cos(theta + 1.55));
        const inWin = (Math.abs(dWin1) < 0.17 && y > 0.92 && y < 1.30)
          || (Math.abs(dWin2) < 0.17 && y > 0.78 && y < 1.16)
          || (Math.abs(dWin3) < 0.17 && y > 0.90 && y < 1.28);

        if (inWin) {
          pushSplat(opaqueSplats, {
            pos: [x - nx * 0.03, y, z - nz * 0.03], normal: [nx, 0, nz],
            scale: [0.056, 0.056, 0.03], color: [1.0, 0.80, 0.38],
            emissive: 0.92, ao: 1.0, objectId: 7,
          });
          continue;
        }
        if (inDoor) {
          const plank = 0.86 + 0.14 * Math.sin(dDoorA * 48.0);
          pushSplat(opaqueSplats, {
            pos: [x - nx * 0.035, y, z - nz * 0.035], normal: [nx, 0, nz],
            scale: [0.058, 0.058, 0.03], color: [0.48 * plank, 0.30 * plank, 0.22 * plank],
            ao: 0.85, objectId: 4,
          });
          continue;
        }
        const course = Math.floor(y * 7.2);
        const block = Math.floor(theta * 3.8 + (course % 2) * 0.5);
        const blockTone = hash2(course, block);
        const mortar = Math.abs((y * 7.2) % 1 - 0.5) > 0.44 ? 0.84 : 1.0;
        const cr = inDoorArch ? 0.72 : lerp(0.50, 0.74, blockTone) * mortar;
        const cg = inDoorArch ? 0.73 : lerp(0.53, 0.75, blockTone) * mortar;
        const cb = inDoorArch ? 0.78 : lerp(0.62, 0.82, blockTone) * mortar;
        pushSplat(opaqueSplats, {
          pos: [x, y, z], normal: [nx, ny, nz], scale: [0.062, 0.058, 0.032],
          color: [cr, cg, cb], ao: computeBakedAO(x, y, z, nx, ny, nz, 3), objectId: 3,
        });
      }
    }
    for (let c = 0; c < 8; c++) {
      const a0 = (c / 8) * Math.PI * 2.0;
      for (let u = 0; u < 5; u++) {
        for (let h = 0; h < 4; h++) {
          const th = a0 + (u - 2) * 0.085, r = TOWER_R + 0.065;
          const x = TOWER_X + Math.cos(th) * r, z = TOWER_Z + Math.sin(th) * r;
          pushSplat(opaqueSplats, {
            pos: [x, TOWER_H + 0.05 + h * 0.055, z],
            normal: [Math.cos(th), h === 3 ? 0.7 : 0.05, Math.sin(th)],
            scale: [0.058, 0.056, 0.036], color: [0.68, 0.70, 0.78], ao: 0.96, objectId: 3,
          });
        }
      }
    }
    for (let j = 0; j < 44; j++) {
      const th = (j / 44) * Math.PI * 2.0, r = TOWER_R + 0.04;
      pushSplat(opaqueSplats, {
        pos: [TOWER_X + Math.cos(th) * r, TOWER_H + 0.04, TOWER_Z + Math.sin(th) * r],
        normal: [0, 1, 0], scale: [0.066, 0.066, 0.03], color: [0.70, 0.72, 0.80], ao: 0.94, objectId: 3,
      });
    }
  }

  // Conical terracotta roof + waving pennant + chimney
  {
    const roofBaseY = TOWER_H + 0.14, roofHeight = 1.18, roofBaseR = TOWER_R + 0.20, rows = 23;
    for (let i = 0; i <= rows; i++) {
      const v = i / rows, y = roofBaseY + v * roofHeight;
      const r = Math.max(0.03, roofBaseR * Math.pow(1.0 - v, 0.88));
      const count = Math.max(6, Math.round(2 * Math.PI * r / 0.056));
      for (let j = 0; j < count; j++) {
        const th = (j + (i % 2) * 0.5) / count * Math.PI * 2.0;
        const slopeN = norm3(Math.cos(th) * roofHeight, roofBaseR * 0.85, Math.sin(th) * roofHeight);
        const shingle = 0.86 + 0.16 * hash2(i, j) + 0.06 * Math.sin(v * 28.0);
        const sz = lerp(0.064, 0.046, v);
        pushSplat(opaqueSplats, {
          pos: [TOWER_X + Math.cos(th) * r, y, TOWER_Z + Math.sin(th) * r],
          normal: slopeN, scale: [sz, sz, sz * 0.38],
          color: [clamp(0.84 * shingle, 0, 1), clamp(0.32 * shingle, 0, 1), clamp(0.30 * shingle, 0, 1)],
          ao: lerp(0.88, 1.0, v), objectId: 5,
        });
      }
    }
    for (let j = 0; j < 44; j++) {
      const th = (j / 44) * Math.PI * 2.0, r = roofBaseR * 0.92;
      pushSplat(opaqueSplats, {
        pos: [TOWER_X + Math.cos(th) * r, roofBaseY - 0.02, TOWER_Z + Math.sin(th) * r],
        normal: [0, -1, 0], scale: [0.068, 0.068, 0.03], color: [0.32, 0.14, 0.22], ao: 0.6, objectId: 5,
      });
    }
    const spireBaseY = roofBaseY + roofHeight;
    for (let k = 0; k < 8; k++) {
      pushSplat(opaqueSplats, {
        pos: [TOWER_X, spireBaseY + k * 0.048, TOWER_Z], normal: [0, 1, 0],
        scale: [0.032, 0.032, 0.032], color: k === 7 ? [1.0, 0.78, 0.32] : [0.36, 0.24, 0.22],
        emissive: k === 7 ? 0.35 : 0.0, ao: 1.0, objectId: 4,
      });
    }
    for (let fx = 0; fx < 10; fx++) {
      const u = (fx + 1) / 10;
      const hCount = Math.max(1, Math.round(3.5 * (1.0 - u * 0.75)));
      for (let fy = 0; fy < hCount; fy++) {
        pushSplat(opaqueSplats, {
          pos: [TOWER_X + u * 0.44, spireBaseY + 0.26 + (fy - (hCount - 1) * 0.5) * 0.045, TOWER_Z],
          normal: [0, 0.2, 1], scale: [0.046, 0.044, 0.025],
          color: fy === 0 ? [0.98, 0.74, 0.28] : [0.88, 0.32, 0.30],
          ao: 1.0, objectId: 5, animType: 2, animA: u,
        });
      }
    }
    const chimX = TOWER_X - 0.42, chimZ = TOWER_Z - 0.16;
    for (let cy = 0; cy < 11; cy++) {
      const y = roofBaseY + 0.28 + cy * 0.052;
      for (let s = 0; s < 12; s++) {
        const a = (s / 12) * Math.PI * 2.0, r = cy >= 9 ? 0.125 : 0.105;
        pushSplat(opaqueSplats, {
          pos: [chimX + Math.cos(a) * r, y, chimZ + Math.sin(a) * r],
          normal: [Math.cos(a), 0.1, Math.sin(a)], scale: [0.046, 0.046, 0.028],
          color: [0.56, 0.58, 0.68], ao: 0.92, objectId: 3,
        });
      }
    }
  }

  // Hanging lantern + translucent glow halo
  {
    for (let k = 0; k < 7; k++) {
      const u = k / 6;
      pushSplat(opaqueSplats, {
        pos: [lerp(TOWER_X + 0.46, LANTERN_POS[0], u), LANTERN_POS[1] + 0.18, lerp(TOWER_Z + 0.22, LANTERN_POS[2], u)],
        normal: [0, 1, 0], scale: [0.036, 0.036, 0.028], color: [0.24, 0.24, 0.32], ao: 0.9, objectId: 4,
      });
    }
    for (let j = 0; j < 8; j++) {
      const a = (j / 8) * Math.PI * 2.0;
      pushSplat(opaqueSplats, {
        pos: [LANTERN_POS[0] + Math.cos(a) * 0.05, LANTERN_POS[1] + 0.11, LANTERN_POS[2] + Math.sin(a) * 0.05],
        normal: [Math.cos(a), 0.7, Math.sin(a)], scale: [0.042, 0.042, 0.028], color: [0.26, 0.24, 0.32], ao: 1.0, objectId: 4,
      });
    }
    for (let k = 0; k < 24; k++) {
      const a = rand() * Math.PI * 2.0, h = (rand() - 0.5) * 0.15, r = 0.04 + rand() * 0.045;
      pushSplat(opaqueSplats, {
        pos: [LANTERN_POS[0] + Math.cos(a) * r, LANTERN_POS[1] + h, LANTERN_POS[2] + Math.sin(a) * r],
        normal: [Math.cos(a), 0.2, Math.sin(a)], scale: [0.056, 0.056, 0.046],
        color: k < 10 ? [1.0, 0.96, 0.70] : [1.0, 0.72, 0.26], emissive: 1.0, ao: 1.0, objectId: 7,
      });
    }
    for (let k = 0; k < 48; k++) {
      const u = rand() * Math.PI * 2.0, v = Math.acos(2 * rand() - 1);
      const rad = 0.14 + Math.pow(rand(), 0.7) * 0.42;
      const fade = 1.0 - (rad - 0.14) / 0.44;
      pushSplat(transSplats, {
        pos: [
          LANTERN_POS[0] + Math.sin(v) * Math.cos(u) * rad,
          LANTERN_POS[1] + Math.cos(v) * rad,
          LANTERN_POS[2] + Math.sin(v) * Math.sin(u) * rad,
        ],
        normal: [0, 1, 0], scale: [0.10, 0.10, 0.10],
        color: [1.0, lerp(0.68, 0.95, fade), lerp(0.24, 0.65, fade)],
        opacity: clamp(0.42 * fade, 0.08, 0.45), emissive: 1.0, ao: 1.0, objectId: 7,
        animType: 5, animA: k, animB: rad,
      });
    }
  }

  // Two alpine pines
  function addPineTree(cx, cz, scaleH, scaleR, seedOffset) {
    for (let i = 0; i < 13; i++) {
      const y = 0.04 + (i / 12) * (0.48 * scaleH);
      for (let j = 0; j < 7; j++) {
        const a = (j / 7) * Math.PI * 2.0, r = 0.075 * scaleR;
        pushSplat(opaqueSplats, {
          pos: [cx + Math.cos(a) * r, y, cz + Math.sin(a) * r],
          normal: [Math.cos(a), 0.05, Math.sin(a)], scale: [0.048, 0.048, 0.03],
          color: [0.46, 0.28, 0.22], ao: 0.75, objectId: 4,
        });
      }
    }
    const tiers = [
      { y0: 0.34, h: 0.56, r0: 0.52 }, { y0: 0.68, h: 0.52, r0: 0.43 },
      { y0: 0.98, h: 0.46, r0: 0.33 }, { y0: 1.24, h: 0.40, r0: 0.22 },
    ];
    for (let ti = 0; ti < tiers.length; ti++) {
      const tr = tiers[ti], rows = 9;
      for (let i = 0; i <= rows; i++) {
        const v = i / rows, y = (tr.y0 + v * tr.h) * scaleH;
        const baseR = Math.max(0.03, tr.r0 * scaleR * (1.0 - v * 0.88));
        const count = Math.max(5, Math.round(2 * Math.PI * baseR / 0.056));
        for (let j = 0; j < count; j++) {
          const th = (j + (i % 2) * 0.5) / count * Math.PI * 2.0 + seedOffset;
          const lobe = 1.0 + 0.20 * Math.cos(th * 6.0 + ti * 1.1) * (1.0 - v * 0.6);
          const r = baseR * lobe;
          const [nx, nny, nz] = norm3(Math.cos(th), lerp(0.18, 0.72, v), Math.sin(th));
          const leafShade = lerp(0.76, 1.12, v) * (0.90 + 0.18 * rand());
          const sz = lerp(0.068, 0.048, v) * Math.max(0.85, scaleR);
          pushSplat(opaqueSplats, {
            pos: [cx + Math.cos(th) * r, y, cz + Math.sin(th) * r],
            normal: [nx, nny, nz], scale: [sz, sz, sz * 0.48],
            color: [0.22 * leafShade, lerp(0.46, 0.66, ti / 3) * leafShade, 0.36 * leafShade],
            ao: lerp(0.70, 1.0, (ti + v) / 4.2), objectId: 6,
          });
        }
      }
    }
  }
  addPineTree(PINE1_X, PINE1_Z, 1.12, 1.05, 0.2);
  addPineTree(PINE2_X, PINE2_Z, 0.84, 0.82, 1.7);

  // Wooden barrel prop
  {
    const bx = 0.28, bz = 0.16;
    for (let i = 0; i < 6; i++) {
      const v = i / 5, y = 0.08 + v * 0.24, r = 0.11 + 0.02 * Math.sin(v * Math.PI);
      for (let j = 0; j < 11; j++) {
        const a = (j / 11) * Math.PI * 2.0, band = i === 1 || i === 4;
        pushSplat(opaqueSplats, {
          pos: [bx + Math.cos(a) * r, y, bz + Math.sin(a) * r],
          normal: [Math.cos(a), 0.1, Math.sin(a)], scale: [0.044, 0.044, 0.026],
          color: band ? [0.30, 0.32, 0.40] : [0.56, 0.35, 0.24], ao: 0.9, objectId: 4,
        });
      }
    }
    pushSplat(opaqueSplats, {
      pos: [bx, 0.33, bz], normal: [0, 1, 0], scale: [0.10, 0.10, 0.03],
      color: [0.58, 0.36, 0.25], ao: 0.95, objectId: 4,
    });
  }

  // Pond + animated waterfall + mist
  {
    for (let i = 0; i < 65; i++) {
      const r = Math.sqrt(rand()) * 0.42, a = rand() * Math.PI * 2.0, foam = r > 0.32 ? 1.0 : 0.0;
      pushSplat(opaqueSplats, {
        pos: [POND_X + Math.cos(a) * r, 0.015, POND_Z + Math.sin(a) * r],
        normal: [0, 1, 0], scale: [0.068, 0.068, 0.03],
        color: foam ? [0.85, 0.96, 0.98] : [0.24, 0.72, 0.84],
        emissive: foam ? 0.28 : 0.14, ao: 1.0, objectId: 8,
      });
    }
    const wfX = POND_X + 0.28, wfZ = POND_Z + 0.36;
    for (let i = 0; i < 165; i++) {
      const u = rand(), across = (rand() - 0.5) * 0.24;
      const isFoam = rand() < 0.24 || Math.abs(across) > 0.095;
      pushSplat(opaqueSplats, {
        pos: [wfX + across * 0.75, 0.0, wfZ - across * 0.65],
        normal: norm3(0.65, 0.15, 0.75), scale: [0.052, 0.078, 0.036],
        color: isFoam ? [0.76, 0.90, 0.98] : [0.22, 0.76, 0.88],
        emissive: isFoam ? 0.38 : 0.20, ao: 1.0, objectId: 8,
        animType: 3, animA: u, animB: across, animC: rand(),
      });
    }
    for (let i = 0; i < 22; i++) {
      pushSplat(transSplats, {
        pos: [wfX + 0.10, -1.42, wfZ + 0.12], normal: [0, 1, 0], scale: [0.068, 0.064, 0.064],
        color: [0.76, 0.92, 0.99], opacity: 0.16, emissive: 0.25, ao: 1.0, objectId: 8,
        animType: 4, animA: i / 22, animB: (rand() - 0.5) * 0.42, animC: (rand() - 0.5) * 0.42,
      });
    }
  }

  // Floating mini-rock shards
  {
    const shards = [
      { x: -1.42, y: -0.58, z: 0.78, rad: 0.24, freq: 2, phase: 0.2 },
      { x: 1.48, y: -0.78, z: -0.62, rad: 0.20, freq: 3, phase: 1.8 },
      { x: -0.68, y: -1.35, z: -1.08, rad: 0.19, freq: 2, phase: 3.1 },
      { x: 0.96, y: -1.24, z: 0.88, rad: 0.16, freq: 3, phase: 4.5 },
    ];
    for (const sh of shards) {
      for (let k = 0; k < 95; k++) {
        const u = rand() * Math.PI * 2.0, v = Math.acos(2 * rand() - 1);
        const nx = Math.sin(v) * Math.cos(u), ny = Math.cos(v), nz = Math.sin(v) * Math.sin(u);
        const lump = 1.0 + 0.22 * Math.cos(u * 3.0 + ny * 4.0);
        pushSplat(opaqueSplats, {
          pos: [sh.x + nx * sh.rad * lump, sh.y + ny * sh.rad * 1.15 * lump, sh.z + nz * sh.rad * 0.92 * lump],
          normal: [nx, ny, nz], scale: [0.056, 0.054, 0.032],
          color: ny > 0.55 ? [0.34, 0.64, 0.40] : [0.42, 0.46, 0.58],
          ao: ny < 0 ? 0.72 : 0.98, objectId: 1,
          animType: 1, animA: sh.freq, animB: sh.phase, animC: 0.10,
        });
      }
    }
  }

  // Rising chimney smoke + orbiting fireflies
  {
    const chimTop = [TOWER_X - 0.42, TOWER_H + 0.94, TOWER_Z - 0.16];
    for (let i = 0; i < 24; i++) {
      pushSplat(transSplats, {
        pos: chimTop, normal: [0, 1, 0], scale: [0.070, 0.070, 0.070],
        color: [0.80, 0.88, 0.96], opacity: 0.16, emissive: 0.18, ao: 1.0, objectId: 9,
        animType: 6, animA: i / 24, animB: (rand() - 0.5) * 0.18, animC: (rand() - 0.5) * 0.18,
      });
    }
    for (let i = 0; i < 24; i++) {
      pushSplat(transSplats, {
        pos: [0, 0.20 + rand() * 1.85, 0], normal: [0, 1, 0], scale: [0.048, 0.048, 0.048],
        color: i % 3 === 0 ? [1.0, 0.96, 0.68] : [1.0, 0.72, 0.30],
        opacity: 0.85, emissive: 1.0, ao: 1.0, objectId: 7,
        animType: 7, animA: (i / 24) * Math.PI * 2.0, animB: 1.15 + rand() * 0.72, animC: i % 2 === 0 ? 1 : -1,
      });
    }
  }

  return {
    all: opaqueSplats.concat(transSplats),
    numOpaque: opaqueSplats.length,
    numTrans: transSplats.length,
  };
}

const SPLAT_VS = `#version 300 es
precision highp float;

layout(location = 0) in vec2 aQuad;
layout(location = 1) in vec3 aCenter;
layout(location = 2) in vec3 aNormal;
layout(location = 3) in vec3 aTangent;
layout(location = 4) in vec3 aScale;
layout(location = 5) in vec3 aColor;
layout(location = 6) in vec4 aMeta;

uniform mat4 uView;
uniform mat4 uProj;
uniform vec2 uViewport;
uniform float uFocal;
uniform float uSplatScale;
uniform float uQuadExtent;
uniform float uLowpass;
uniform float uSnapGrid;

out vec2 vLocal;
out vec3 vNormal;
out vec3 vWorldPos;
out vec3 vColor;
out vec4 vMeta;
out float vViewDepth;

void main() {
  vec4 viewPos4 = uView * vec4(aCenter, 1.0);
  vec3 p = viewPos4.xyz;
  float zc = -p.z;
  if (zc < 0.2) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    return;
  }

  vec3 nW = normalize(aNormal);
  vec3 t1W = normalize(aTangent);
  vec3 t2W = cross(nW, t1W);

  mat3 R = mat3(uView);
  vec3 s = aScale * uSplatScale;
  vec3 c0 = R * (t1W * s.x);
  vec3 c1 = R * (t2W * s.y);
  vec3 c2 = R * (nW * s.z);

  float invZ = 1.0 / zc;
  float invZ2 = invZ * invZ;
  vec3 jRow0 = vec3(uFocal * invZ, 0.0, uFocal * p.x * invZ2);
  vec3 jRow1 = vec3(0.0, uFocal * invZ, uFocal * p.y * invZ2);

  vec3 tRow0 = vec3(dot(jRow0, c0), dot(jRow0, c1), dot(jRow0, c2));
  vec3 tRow1 = vec3(dot(jRow1, c0), dot(jRow1, c1), dot(jRow1, c2));

  float a = dot(tRow0, tRow0) + uLowpass;
  float b = dot(tRow0, tRow1);
  float c = dot(tRow1, tRow1) + uLowpass;

  float mid = 0.5 * (a + c);
  float detDiff = 0.5 * (a - c);
  float disc = sqrt(max(0.0, detDiff * detDiff + b * b));
  float lam1 = max(0.05, mid + disc);
  float lam2 = max(0.05, mid - disc);

  vec2 e1;
  if (abs(b) > 1e-5 || abs(a - c) > 1e-5) {
    vec2 vA = vec2(b, lam1 - a);
    vec2 vB = vec2(lam1 - c, b);
    e1 = normalize(dot(vA, vA) >= dot(vB, vB) ? vA : vB);
  } else {
    e1 = vec2(1.0, 0.0);
  }
  vec2 e2 = vec2(-e1.y, e1.x);

  float rad1 = min(sqrt(lam1) * uQuadExtent, uViewport.y * 0.35);
  float rad2 = min(sqrt(lam2) * uQuadExtent, uViewport.y * 0.35);

  vec4 clipCenter = uProj * viewPos4;
  vec2 ndcCenter = clipCenter.xy / clipCenter.w;

  if (uSnapGrid > 0.5) {
    vec2 grid = uViewport * 0.5;
    vec2 pxCoord = (ndcCenter * 0.5 + 0.5) * grid;
    pxCoord = (floor(pxCoord) + 0.5) / grid;
    ndcCenter = pxCoord * 2.0 - 1.0;
  }

  vec2 offsetPx = aQuad.x * e1 * rad1 + aQuad.y * e2 * rad2;
  vec2 ndcOffset = (offsetPx * 2.0) / uViewport;

  gl_Position = vec4((ndcCenter + ndcOffset) * clipCenter.w, clipCenter.z, clipCenter.w);
  vLocal = aQuad * uQuadExtent;
  vNormal = nW;
  vWorldPos = aCenter;
  vColor = aColor;
  vMeta = aMeta;
  vViewDepth = zc;
}
`;

const LIGHTING_GLSL = `
uniform vec3 uSunDir;
uniform vec3 uLanternPos;
uniform float uLanternPulse;

vec3 evalLighting(vec3 albedo, vec3 n, vec3 worldPos, float ao, float emissive, bool stepped) {
  float ndl = dot(n, uSunDir);
  vec3 lVec = uLanternPos - worldPos;
  float lDist = length(lVec);
  float lAtten = 1.0 / (1.0 + 1.45 * lDist * lDist);
  float lNdl = max(0.0, dot(n, lVec / max(lDist, 0.001)));
  float lanternTerm = lAtten * (0.45 + 0.55 * lNdl) * uLanternPulse;

  if (!stepped) {
    float diff = max(0.0, ndl);
    vec3 skyCol = mix(vec3(0.28, 0.33, 0.52), vec3(0.55, 0.64, 0.86), n.y * 0.5 + 0.5);
    vec3 lit = albedo * (skyCol * 0.58 * ao + vec3(1.12, 1.02, 0.88) * diff * 0.88 * ao);
    lit += albedo * vec3(1.35, 0.82, 0.30) * lanternTerm * 1.15;
    return mix(lit, albedo * 1.12, emissive);
  } else {
    float s = ndl * ao;
    vec3 lightTint = s > 0.42 ? vec3(1.24, 1.18, 1.02)
      : (s > 0.02 ? vec3(0.95, 0.95, 0.98) : vec3(0.52, 0.56, 0.78));
    float lb = lanternTerm > 0.24 ? 0.85 : (lanternTerm > 0.09 ? 0.38 : 0.0);
    vec3 lit = albedo * lightTint + albedo * vec3(1.35, 0.82, 0.28) * lb;
    return mix(lit, albedo * 1.15, emissive);
  }
}
`;

const RAW_FS = `#version 300 es
precision highp float;
in vec2 vLocal;
in vec3 vNormal;
in vec3 vWorldPos;
in vec3 vColor;
in vec4 vMeta;
in float vViewDepth;
uniform float uSurfelReveal;
${LIGHTING_GLSL}
out vec4 fragColor;

void main() {
  float r2 = dot(vLocal, vLocal);
  if (r2 > 6.76) discard;
  float g = exp(-0.5 * r2);
  float discRim = smoothstep(1.35, 1.85, r2) * smoothstep(2.55, 1.85, r2);
  float shape = mix(g, smoothstep(2.6, 0.9, r2), uSurfelReveal * 0.68);
  float alpha = vMeta.x * shape;
  if (alpha < 0.015) discard;
  vec3 lit = evalLighting(vColor, normalize(vNormal), vWorldPos, vMeta.z, vMeta.y, false);
  lit += vec3(0.45, 0.75, 0.95) * discRim * uSurfelReveal * 0.45;
  fragColor = vec4(lit * alpha, alpha);
}
`;

const HARD_MRT_FS = `#version 300 es
precision highp float;
in vec2 vLocal;
in vec3 vNormal;
in vec3 vWorldPos;
in vec3 vColor;
in vec4 vMeta;
in float vViewDepth;
${LIGHTING_GLSL}
layout(location = 0) out vec4 outSmooth;
layout(location = 1) out vec4 outStepped;
layout(location = 2) out vec4 outDepth;

void main() {
  float r2 = dot(vLocal, vLocal);
  if (r2 > 2.25) discard;
  vec3 n = normalize(vNormal);
  vec3 smoothCol = evalLighting(vColor, n, vWorldPos, vMeta.z, vMeta.y, false);
  vec3 stepCol = evalLighting(vColor, n, vWorldPos, vMeta.z, vMeta.y, true);
  float objNorm = vMeta.w / 255.0;
  float dNorm = clamp((vViewDepth - 2.0) / 18.0, 0.0, 0.9999);
  outSmooth = vec4(clamp(smoothCol, 0.0, 1.0), objNorm);
  outStepped = vec4(clamp(stepCol, 0.0, 1.0), vMeta.y);
  outDepth = vec4(floor(dNorm * 255.0) / 255.0, fract(dNorm * 255.0), objNorm, 1.0);
}
`;

const TRANS_FS = `#version 300 es
precision highp float;
in vec2 vLocal;
in vec3 vColor;
in vec4 vMeta;
out vec4 fragColor;

void main() {
  float r2 = dot(vLocal, vLocal);
  if (r2 > 4.84) discard;
  float alpha = vMeta.x * exp(-0.55 * r2);
  if (alpha < 0.02) discard;
  fragColor = vec4(vColor * alpha, alpha);
}
`;

const POST_FS = `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uTexRaw;
uniform sampler2D uTexSmooth;
uniform sampler2D uTexStepped;
uniform sampler2D uTexDepth;
uniform sampler2D uTexTrans;
uniform vec3 uPalette[24];
uniform vec2 uArtSize;
uniform ivec2 uSsMax;
uniform float uAspect;
uniform int uStageLeft;
uniform int uStageRight;
uniform float uWipeX;
uniform float uTime;
out vec4 fragColor;

float bayer4(ivec2 p) {
  int idx = (p.y & 3) * 4 + (p.x & 3);
  const float m[16] = float[16](
     0.0,  8.0,  2.0, 10.0,
    12.0,  4.0, 14.0,  6.0,
     3.0, 11.0,  1.0,  9.0,
    15.0,  7.0, 13.0,  5.0
  );
  return (m[idx] + 0.5) / 16.0;
}

int nearestPalette(vec3 c) {
  int best = 0;
  float bestD = 1e9;
  for (int i = 0; i < 24; i++) {
    vec3 d = c - uPalette[i];
    float dist = d.r * d.r * 2.2 + d.g * d.g * 4.0 + d.b * d.b * 3.0;
    if (dist < bestD) { bestD = dist; best = i; }
  }
  return best;
}

vec3 evalSky(vec2 uv, bool quantized, bool dithered, ivec2 artPx, bool smoothStars) {
  vec3 cTop = vec3(0.16, 0.21, 0.37);
  vec3 cMid = vec3(0.27, 0.37, 0.56);
  vec3 cHor = vec3(0.46, 0.57, 0.74);
  vec3 cLow = vec3(0.22, 0.29, 0.46);
  vec3 col;
  if (uv.y > 0.32) {
    float t = clamp((uv.y - 0.32) / 0.68, 0.0, 1.0);
    col = mix(cHor, mix(cMid, cTop, smoothstep(0.32, 1.0, t)), smoothstep(0.0, 0.78, t));
  } else {
    col = mix(cLow, cHor, smoothstep(0.0, 1.0, clamp(uv.y / 0.32, 0.0, 1.0)));
  }
  if (smoothStars) {
    vec2 g = uv * vec2(26.0 * uAspect, 26.0);
    vec2 cid = floor(g), f = fract(g) - 0.5;
    float sh = fract(sin(dot(cid, vec2(127.1, 311.7))) * 43758.5453);
    if (sh > 0.965 && uv.y > 0.46) {
      float tw = 0.55 + 0.45 * sin(uTime * 1.45 + sh * 90.0);
      col = mix(col, vec3(0.98, 0.94, 0.78), exp(-dot(f, f) * 28.0) * tw * 0.9);
    }
  } else {
    vec2 cell = floor(vec2(artPx) / 2.0);
    float sh = fract(sin(dot(cell, vec2(127.1, 311.7))) * 43758.5453);
    if (sh > 0.990 && uv.y > 0.46 && (artPx.x & 1) == 0 && (artPx.y & 1) == 0) {
      float tw = 0.55 + 0.45 * sin(uTime * 1.45 + sh * 90.0);
      col = mix(col, vec3(0.98, 0.94, 0.78), tw * 0.9);
    }
  }
  if (dithered) col = clamp(col + (bayer4(artPx) - 0.5) * 0.052, 0.0, 1.0);
  return quantized ? uPalette[nearestPalette(col)] : col;
}

float unpackDepth(vec4 d) { return d.r + d.g / 255.0; }

void sampleArtCell(ivec2 artPx, out int hits, out float minDepth, out int fgObj) {
  hits = 0; minDepth = 1.0; fgObj = 0;
  ivec2 base = artPx * 2;
  for (int oy = 0; oy < 2; oy++) {
    for (int ox = 0; ox < 2; ox++) {
      vec4 dp = texelFetch(uTexDepth, clamp(base + ivec2(ox, oy), ivec2(0), uSsMax), 0);
      int oid = int(round(dp.b * 255.0));
      if (oid > 0) {
        hits++;
        float z = unpackDepth(dp);
        if (z < minDepth) { minDepth = z; fgObj = oid; }
      }
    }
  }
}

vec3 evalStage(int stage, vec2 uv) {
  ivec2 maxArt = ivec2(uArtSize) - ivec2(1);
  ivec2 artPx = clamp(ivec2(floor(uv * uArtSize)), ivec2(0), maxArt);
  vec2 artUv = (vec2(artPx) + 0.5) / uArtSize;

  if (stage == 0) {
    vec3 sky = evalSky(uv, false, false, artPx, true);
    vec4 raw = texture(uTexRaw, uv);
    return raw.rgb + sky * (1.0 - raw.a);
  }

  ivec2 base = artPx * 2;
  vec3 cols[4];
  float depths[4];
  int oids[4];
  float ems[4];
  int hits = 0, minIdx = 0, fgObj = 0;
  float minDepth = 1.0;

  for (int k = 0; k < 4; k++) {
    ivec2 sp = clamp(base + ivec2(k & 1, k >> 1), ivec2(0), uSsMax);
    vec4 sm = texelFetch(uTexSmooth, sp, 0);
    vec4 st = texelFetch(uTexStepped, sp, 0);
    vec4 dp = texelFetch(uTexDepth, sp, 0);
    int oid = int(round(dp.b * 255.0));
    oids[k] = oid;
    depths[k] = unpackDepth(dp);
    ems[k] = st.a;
    cols[k] = (stage == 1) ? sm.rgb : st.rgb;
    if (oid > 0) {
      hits++;
      if (depths[k] < minDepth) { minDepth = depths[k]; minIdx = k; fgObj = oid; }
    }
  }

  vec4 trAvg = vec4(0.0);
  for (int k = 0; k < 4; k++) {
    trAvg += texelFetch(uTexTrans, clamp(base + ivec2(k & 1, k >> 1), ivec2(0), uSsMax), 0);
  }
  trAvg *= 0.25;

  bool isQuantized = (stage >= 3);
  bool isDithered = (stage >= 4);
  vec3 skyCol = evalSky(artUv, isQuantized, isDithered, artPx, false);

  if (hits < 2) {
    if (stage == 4) {
      int nh, no; float nd;
      bool touchesFg = false;
      sampleArtCell(artPx + ivec2( 1,  0), nh, nd, no); if (nh >= 2) touchesFg = true;
      sampleArtCell(artPx + ivec2(-1,  0), nh, nd, no); if (nh >= 2) touchesFg = true;
      sampleArtCell(artPx + ivec2( 0,  1), nh, nd, no); if (nh >= 2) touchesFg = true;
      sampleArtCell(artPx + ivec2( 0, -1), nh, nd, no); if (nh >= 2) touchesFg = true;
      if (touchesFg) return uPalette[0];
    }
    if (trAvg.a > 0.03) {
      vec3 trRgb = trAvg.rgb / max(trAvg.a, 0.001);
      if (isDithered) {
        if (trAvg.a * 1.45 > bayer4(artPx)) {
          return uPalette[nearestPalette(mix(skyCol, trRgb, clamp(trAvg.a * 1.5, 0.35, 0.92)))];
        }
        return skyCol;
      } else if (isQuantized) {
        return uPalette[nearestPalette(trAvg.rgb + skyCol * (1.0 - trAvg.a))];
      }
      return trAvg.rgb + skyCol * (1.0 - trAvg.a);
    }
    return skyCol;
  }

  vec3 finalCol;
  if (stage <= 2) {
    vec3 sum = vec3(0.0);
    for (int k = 0; k < 4; k++) if (oids[k] > 0) sum += cols[k];
    finalCol = sum / float(hits);
    if (trAvg.a > 0.02) finalCol = trAvg.rgb + finalCol * (1.0 - trAvg.a);
    return finalCol;
  }

  float ditherAmt = isDithered ? (bayer4(artPx) - 0.5) * 0.105 : 0.0;
  int pIdx[4];
  for (int k = 0; k < 4; k++) {
    if (oids[k] > 0) {
      float dm = ems[k] > 0.5 ? 0.0 : ditherAmt;
      pIdx[k] = nearestPalette(clamp(cols[k] + vec3(dm), 0.0, 1.0));
    } else {
      pIdx[k] = -1;
    }
  }

  int winPalette = pIdx[minIdx], bestVotes = 0;
  float bestWinDepth = 1e9;
  for (int k = 0; k < 4; k++) {
    if (pIdx[k] < 0) continue;
    int votes = 0;
    float dMin = 1e9;
    for (int j = 0; j < 4; j++) {
      if (pIdx[j] == pIdx[k]) { votes++; dMin = min(dMin, depths[j]); }
    }
    if (votes > bestVotes || (votes == bestVotes && dMin < bestWinDepth)) {
      bestVotes = votes; bestWinDepth = dMin; winPalette = pIdx[k];
    }
  }
  finalCol = uPalette[winPalette];

  if (stage == 4) {
    int nh, no; float nd;
    bool innerCrease = false;
    sampleArtCell(artPx + ivec2( 1,  0), nh, nd, no); if (nh >= 2 && (minDepth - nd) > 0.038 && no != fgObj) innerCrease = true;
    sampleArtCell(artPx + ivec2(-1,  0), nh, nd, no); if (nh >= 2 && (minDepth - nd) > 0.038 && no != fgObj) innerCrease = true;
    sampleArtCell(artPx + ivec2( 0,  1), nh, nd, no); if (nh >= 2 && (minDepth - nd) > 0.038 && no != fgObj) innerCrease = true;
    sampleArtCell(artPx + ivec2( 0, -1), nh, nd, no); if (nh >= 2 && (minDepth - nd) > 0.038 && no != fgObj) innerCrease = true;
    if (innerCrease && ems[minIdx] < 0.5) finalCol = uPalette[nearestPalette(finalCol * 0.42)];
  }

  if (trAvg.a > 0.03) {
    vec3 trRgb = trAvg.rgb / max(trAvg.a, 0.001);
    if (isDithered) {
      if (trAvg.a * 1.4 > bayer4(artPx)) {
        finalCol = uPalette[nearestPalette(mix(finalCol, trRgb, clamp(trAvg.a * 1.4, 0.35, 0.88)))];
      }
    } else {
      finalCol = uPalette[nearestPalette(trAvg.rgb + finalCol * (1.0 - trAvg.a))];
    }
  }
  return finalCol;
}

void main() {
  vec3 col;
  if (uWipeX <= 0.001) col = evalStage(uStageRight, vUv);
  else if (uWipeX >= 0.999) col = evalStage(uStageLeft, vUv);
  else col = (vUv.x < uWipeX) ? evalStage(uStageLeft, vUv) : evalStage(uStageRight, vUv);
  fragColor = vec4(col, 1.0);
}
`;

export function createSplatsEffect(gl) {
  const { all: ALL_SPLATS, numOpaque: NUM_OPAQUE, numTrans: NUM_TRANS } = buildIslandSplats();
  const NUM_ALL = ALL_SPLATS.length;

  const progRaw = linkProgram(gl, SPLAT_VS, RAW_FS);
  const progHard = linkProgram(gl, SPLAT_VS, HARD_MRT_FS);
  const progTrans = linkProgram(gl, SPLAT_VS, TRANS_FS);
  const progPost = linkProgram(gl, FULL_VS, POST_FS);

  const quadVerts = new Float32Array([-1, -1, 1, -1, 1, 1, -1, -1, 1, 1, -1, 1]);
  const vao = gl.createVertexArray();
  gl.bindVertexArray(vao);
  const vboQuad = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, vboQuad);
  gl.bufferData(gl.ARRAY_BUFFER, quadVerts, gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

  const FLOATS_PER_SPLAT = 20;
  const splatData = new Float32Array(NUM_ALL * FLOATS_PER_SPLAT);
  const vboSplats = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, vboSplats);
  gl.bufferData(gl.ARRAY_BUFFER, splatData.byteLength, gl.DYNAMIC_DRAW);
  const STRIDE = FLOATS_PER_SPLAT * 4;
  for (const [loc, size, off] of [[1, 3, 0], [2, 3, 3], [3, 3, 6], [4, 3, 9], [5, 3, 12], [6, 4, 15]]) {
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, size, gl.FLOAT, false, STRIDE, off * 4);
    gl.vertexAttribDivisor(loc, 1);
  }
  gl.bindVertexArray(null);
  const vaoPost = gl.createVertexArray();

  const animX = new Float32Array(NUM_ALL);
  const animY = new Float32Array(NUM_ALL);
  const animZ = new Float32Array(NUM_ALL);
  const animOp = new Float32Array(NUM_ALL);
  const animSc = new Float32Array(NUM_ALL);
  const keys = new Uint32Array(NUM_ALL);
  const orderA = new Uint32Array(NUM_ALL);
  const orderB = new Uint32Array(NUM_ALL);
  const hist0 = new Uint32Array(256);
  const hist1 = new Uint32Array(256);

  let bufW = 0, bufH = 0, artW = 0, artH = 0, ssW = 0, ssH = 0;
  let texRaw = null, fboRaw = null;
  let texSmooth = null, texStepped = null, texDepthEnc = null, rbDepth = null, fboHard = null;
  let texTrans = null, fboTrans = null;

  let simTime = 0;
  let fineGrid = false;
  let revealActive = false;
  let revealBlend = 0;

  function allocTargets(w, h) {
    const aspect = w / Math.max(1, h);
    const baseH = aspect < 0.85 ? (fineGrid ? 260 : 196) : (fineGrid ? 216 : 148);
    const nextArtH = Math.max(64, Math.round(baseH));
    const nextArtW = Math.max(64, Math.round(nextArtH * aspect));
    if (w === bufW && h === bufH && nextArtW === artW && nextArtH === artH) return;

    for (const tex of [texRaw, texSmooth, texStepped, texDepthEnc, texTrans]) if (tex) gl.deleteTexture(tex);
    if (rbDepth) gl.deleteRenderbuffer(rbDepth);
    for (const fbo of [fboRaw, fboHard, fboTrans]) if (fbo) gl.deleteFramebuffer(fbo);

    bufW = w; bufH = h; artW = nextArtW; artH = nextArtH;
    ssW = artW * 2; ssH = artH * 2;

    texRaw = makeTex2D(gl, bufW, bufH, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, gl.LINEAR);
    fboRaw = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fboRaw);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texRaw, 0);

    texSmooth = makeTex2D(gl, ssW, ssH, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, gl.NEAREST);
    texStepped = makeTex2D(gl, ssW, ssH, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, gl.NEAREST);
    texDepthEnc = makeTex2D(gl, ssW, ssH, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, gl.NEAREST);
    rbDepth = gl.createRenderbuffer();
    gl.bindRenderbuffer(gl.RENDERBUFFER, rbDepth);
    gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT24, ssW, ssH);

    fboHard = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fboHard);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texSmooth, 0);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT1, gl.TEXTURE_2D, texStepped, 0);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT2, gl.TEXTURE_2D, texDepthEnc, 0);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, rbDepth);
    gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1, gl.COLOR_ATTACHMENT2]);

    texTrans = makeTex2D(gl, ssW, ssH, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, gl.NEAREST);
    fboTrans = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fboTrans);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texTrans, 0);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, rbDepth);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  function evaluateAnimation(t) {
    const phaseT = ((t % LOOP_T) + LOOP_T) % LOOP_T / LOOP_T;
    const tau = Math.PI * 2.0;
    for (let i = 0; i < NUM_ALL; i++) {
      const s = ALL_SPLATS[i];
      let x = s.px, y = s.py, z = s.pz, op = s.opacity, sc = 1.0;
      if (s.animType === 1) {
        y += Math.sin(tau * s.animA * phaseT + s.animB) * s.animC;
      } else if (s.animType === 2) {
        z += Math.sin(tau * 6.0 * phaseT - s.animA * 4.5) * 0.075 * s.animA;
        y += Math.cos(tau * 6.0 * phaseT - s.animA * 3.0) * 0.015 * s.animA;
      } else if (s.animType === 3) {
        const u = (s.animA + phaseT * 8.0) % 1.0;
        const curveOut = Math.sin(u * Math.PI * 0.5) * 0.18;
        x += curveOut * 0.7; z += curveOut * 0.7;
        y = 0.02 - u * 1.48;
        sc = lerp(0.92, 0.52, u * u);
      } else if (s.animType === 4) {
        const u = (s.animA + phaseT * 6.0) % 1.0;
        x += s.animB * (0.4 + u * 1.2); z += s.animC * (0.4 + u * 1.2);
        y += Math.sin(u * Math.PI) * 0.28;
        op = s.opacity * Math.sin(u * Math.PI);
        sc = 0.7 + u * 0.9;
      } else if (s.animType === 5) {
        sc = 1.0 + 0.08 * Math.sin(tau * 4.0 * phaseT + s.animA * 0.4);
      } else if (s.animType === 6) {
        const u = (s.animA + phaseT * 5.0) % 1.0;
        x += u * 0.46 + s.animB * (0.4 + u * 1.4) + Math.sin(u * 5.0 + s.animA * 6.28) * 0.04;
        z += u * 0.12 + s.animC * (0.4 + u * 1.4);
        y += u * 0.96;
        op = s.opacity * Math.sin(u * Math.PI) * (1.0 - 0.35 * u);
        sc = 0.65 + u * 1.15;
      } else if (s.animType === 7) {
        const ang = s.animA + s.animC * tau * phaseT;
        x = Math.cos(ang) * s.animB; z = Math.sin(ang) * s.animB;
        y += Math.sin(tau * 4.0 * phaseT + s.animA * 3.0) * 0.14;
        op = s.opacity * (0.55 + 0.45 * Math.sin(tau * 8.0 * phaseT + s.animA * 5.0));
      }
      animX[i] = x; animY[i] = y; animZ[i] = z; animOp[i] = op; animSc[i] = sc;
    }
  }

  function packSortedSplats(viewMat, startIdx, count, sortBackToFront) {
    const m2 = viewMat[2], m6 = viewMat[6], m10 = viewMat[10], m14 = viewMat[14];
    if (sortBackToFront) {
      hist0.fill(0); hist1.fill(0);
      for (let i = 0; i < count; i++) {
        const idx = startIdx + i;
        const zc = -(m2 * animX[idx] + m6 * animY[idx] + m10 * animZ[idx] + m14);
        const q = clamp(Math.round((32.0 - zc) * 2047.0), 0, 65535);
        keys[i] = q; orderA[i] = idx;
        hist0[q & 255]++; hist1[(q >> 8) & 255]++;
      }
      let sum0 = 0, sum1 = 0;
      for (let b = 0; b < 256; b++) {
        const c0 = hist0[b]; hist0[b] = sum0; sum0 += c0;
        const c1 = hist1[b]; hist1[b] = sum1; sum1 += c1;
      }
      for (let i = 0; i < count; i++) orderB[hist0[keys[i] & 255]++] = i;
      for (let i = 0; i < count; i++) {
        const orig = orderB[i];
        orderA[hist1[(keys[orig] >> 8) & 255]++] = startIdx + orig;
      }
    } else {
      for (let i = 0; i < count; i++) orderA[i] = startIdx + i;
    }
    for (let i = 0; i < count; i++) {
      const idx = orderA[i], s = ALL_SPLATS[idx], o = i * FLOATS_PER_SPLAT, sc = animSc[idx];
      splatData[o + 0] = animX[idx]; splatData[o + 1] = animY[idx]; splatData[o + 2] = animZ[idx];
      splatData[o + 3] = s.nx; splatData[o + 4] = s.ny; splatData[o + 5] = s.nz;
      splatData[o + 6] = s.tx; splatData[o + 7] = s.ty; splatData[o + 8] = s.tz;
      splatData[o + 9] = s.r1 * sc; splatData[o + 10] = s.r2 * sc; splatData[o + 11] = s.r3 * sc;
      splatData[o + 12] = s.cr; splatData[o + 13] = s.cg; splatData[o + 14] = s.cb;
      splatData[o + 15] = animOp[idx]; splatData[o + 16] = s.emissive; splatData[o + 17] = s.ao;
      splatData[o + 18] = s.objectId; splatData[o + 19] = 0;
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, vboSplats);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, splatData.subarray(0, count * FLOATS_PER_SPLAT));
  }

  function setSplatUniforms(prog, viewMat, projMat, vpW, vpH, focal, sunDir, splatScale, quadExtent, lowpass, snapGrid) {
    gl.useProgram(prog);
    gl.uniformMatrix4fv(gl.getUniformLocation(prog, "uView"), false, viewMat);
    gl.uniformMatrix4fv(gl.getUniformLocation(prog, "uProj"), false, projMat);
    gl.uniform2f(gl.getUniformLocation(prog, "uViewport"), vpW, vpH);
    gl.uniform1f(gl.getUniformLocation(prog, "uFocal"), focal);
    gl.uniform1f(gl.getUniformLocation(prog, "uSplatScale"), splatScale);
    gl.uniform1f(gl.getUniformLocation(prog, "uQuadExtent"), quadExtent);
    gl.uniform1f(gl.getUniformLocation(prog, "uLowpass"), lowpass);
    gl.uniform1f(gl.getUniformLocation(prog, "uSnapGrid"), snapGrid);
    const uSun = gl.getUniformLocation(prog, "uSunDir");
    if (uSun) gl.uniform3fv(uSun, sunDir);
    const uLan = gl.getUniformLocation(prog, "uLanternPos");
    if (uLan) gl.uniform3fv(uLan, LANTERN_POS);
    const uPulse = gl.getUniformLocation(prog, "uLanternPulse");
    if (uPulse) gl.uniform1f(uPulse, 0.92 + 0.10 * Math.sin(simTime * 2.9));
    const uRev = gl.getUniformLocation(prog, "uSurfelReveal");
    if (uRev) gl.uniform1f(uRev, revealBlend);
  }

  return {
    id: "splats",
    maxPixels: 1800000,
    defaultCamera: {
      yaw: 0.42,
      pitch: 0.27,
      dist: 9.8,
      lookY: 0.56,
      fovDeg: 38,
      minDist: 4.8,
      maxDist: 16.0,
      minPitch: -0.32,
      maxPitch: 1.15,
      autoOrbitSpeed: 0.15,
    },
    resize(w, h) {
      allocTargets(w, h);
    },
    enterStep(stepIdx) {
      if (stepIdx !== 0) revealActive = false;
    },
    triggerAction(actionId) {
      if (actionId === "reveal") revealActive = !revealActive;
      else if (actionId === "grid") fineGrid = !fineGrid;
    },
    isActionActive(actionId) {
      if (actionId === "reveal") return revealActive;
      if (actionId === "grid") return fineGrid;
      return false;
    },
    update(dt, paused) {
      if (!paused) simTime += dt;
      const targetRev = revealActive ? 1.0 : 0.0;
      revealBlend += (targetRev - revealBlend) * Math.min(1, dt * 6.5);
    },
    getTechBadge(stepIdx) {
      if (stepIdx === 0) return `${NUM_ALL.toLocaleString("en-US")} 3D SPLATS`;
      return `${artW || 240}×${artH || 148} · 2× SSAA`;
    },
    render(w, h, step, split, cam) {
      allocTargets(w, h);
      evaluateAnimation(simTime);

      const aspect = w / Math.max(1, h);
      const portraitScale = aspect < 0.95 ? clamp(1.02 / Math.max(aspect, 0.52), 1.0, 1.55) : 1.0;
      const dist = cam.dist * portraitScale;
      const cp = Math.cos(cam.pitch);
      const eye = [
        Math.sin(cam.yaw) * cp * dist,
        cam.lookY + Math.sin(cam.pitch) * dist,
        Math.cos(cam.yaw) * cp * dist,
      ];
      const fovRad = (cam.fovDeg * Math.PI) / 180;
      const viewMat = makeLookAt(eye, [0, cam.lookY, 0], [0, 1, 0]);
      const projMat = makePerspective(fovRad, aspect, 0.4, 45.0);

      // Co-rotating 3/4 key light so cel bands stay crisp as the user orbits
      const sunAngle = (Math.PI * 0.5 - cam.yaw) - 0.88;
      const sunDir = norm3(Math.cos(sunAngle) * 0.78, 0.68, Math.sin(sunAngle) * 0.78);

      const stageLeft = split.enabled ? step.compareLeft : step.stage;
      const stageRight = split.enabled ? step.compareRight : step.stage;
      const wipeX = split.enabled ? split.pos : 0.0;

      const needRaw = (stageLeft === 0 && wipeX > 0.001) || (stageRight === 0 && wipeX < 0.999);
      const needHard = (stageLeft > 0 && wipeX > 0.001) || (stageRight > 0 && wipeX < 0.999);
      const splatScale = lerp(1.0, 0.52, revealBlend);

      gl.bindVertexArray(vao);

      if (needRaw) {
        packSortedSplats(viewMat, 0, NUM_ALL, true);
        gl.bindFramebuffer(gl.FRAMEBUFFER, fboRaw);
        gl.viewport(0, 0, bufW, bufH);
        gl.clearColor(0, 0, 0, 0);
        gl.clear(gl.COLOR_BUFFER_BIT);
        gl.disable(gl.DEPTH_TEST);
        gl.depthMask(false);
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
        const focalFull = (0.5 * bufH) / Math.tan(fovRad * 0.5);
        setSplatUniforms(progRaw, viewMat, projMat, bufW, bufH, focalFull, sunDir, splatScale, 2.55, 0.40, 0.0);
        gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, NUM_ALL);
      }

      if (needHard) {
        const focalSS = (0.5 * ssH) / Math.tan(fovRad * 0.5);
        packSortedSplats(viewMat, 0, NUM_OPAQUE, false);
        gl.bindFramebuffer(gl.FRAMEBUFFER, fboHard);
        gl.viewport(0, 0, ssW, ssH);
        gl.clearColor(0, 0, 0, 0);
        gl.clearDepth(1.0);
        gl.depthMask(true);
        gl.enable(gl.DEPTH_TEST);
        gl.depthFunc(gl.LESS);
        gl.disable(gl.BLEND);
        gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
        setSplatUniforms(progHard, viewMat, projMat, ssW, ssH, focalSS, sunDir, 1.0, 1.52, 0.16, 1.0);
        gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, NUM_OPAQUE);

        packSortedSplats(viewMat, NUM_OPAQUE, NUM_TRANS, true);
        gl.bindFramebuffer(gl.FRAMEBUFFER, fboTrans);
        gl.viewport(0, 0, ssW, ssH);
        gl.clearColor(0, 0, 0, 0);
        gl.clear(gl.COLOR_BUFFER_BIT);
        gl.enable(gl.DEPTH_TEST);
        gl.depthMask(false);
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
        setSplatUniforms(progTrans, viewMat, projMat, ssW, ssH, focalSS, sunDir, 1.0, 2.20, 0.25, 0.0);
        gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, NUM_TRANS);
        gl.depthMask(true);
      }

      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, bufW, bufH);
      gl.disable(gl.DEPTH_TEST);
      gl.disable(gl.BLEND);
      gl.useProgram(progPost);
      gl.bindVertexArray(vaoPost);

      const binds = [texRaw, texSmooth, texStepped, texDepthEnc, texTrans];
      const names = ["uTexRaw", "uTexSmooth", "uTexStepped", "uTexDepth", "uTexTrans"];
      for (let i = 0; i < binds.length; i++) {
        gl.activeTexture(gl.TEXTURE0 + i);
        gl.bindTexture(gl.TEXTURE_2D, binds[i]);
        gl.uniform1i(gl.getUniformLocation(progPost, names[i]), i);
      }
      gl.uniform3fv(gl.getUniformLocation(progPost, "uPalette"), PALETTE_F32);
      gl.uniform2f(gl.getUniformLocation(progPost, "uArtSize"), artW, artH);
      gl.uniform2i(gl.getUniformLocation(progPost, "uSsMax"), ssW - 1, ssH - 1);
      gl.uniform1f(gl.getUniformLocation(progPost, "uAspect"), aspect);
      gl.uniform1i(gl.getUniformLocation(progPost, "uStageLeft"), stageLeft);
      gl.uniform1i(gl.getUniformLocation(progPost, "uStageRight"), stageRight);
      gl.uniform1f(gl.getUniformLocation(progPost, "uWipeX"), wipeX);
      gl.uniform1f(gl.getUniformLocation(progPost, "uTime"), simTime);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      gl.bindVertexArray(null);
    },
  };
}
