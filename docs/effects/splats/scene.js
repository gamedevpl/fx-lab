// Procedural 3D Gaussian surfel scene: floating watchtower island, pines, lantern and waterfall.

import { clamp, lerp, smoothstep, norm3, cross3, hexToRgb01, mulberry32 } from "../../src/gl-utils.js";

// Curated 24-color hue-shifted pixel-art palette (index 0 is the 1 px ink outline).
export const PALETTE_HEX = [
  "#141426", "#273459", "#3e5482", "#637da8", "#c6dbed", "#fff2ad",
  "#30354f", "#515875", "#7b839e", "#aeb4c7", "#e6dfd1", "#5e213b",
  "#9c2f44", "#d64f4b", "#f28961", "#1b4047", "#2b7060", "#50a369",
  "#96d171", "#54332d", "#915a3f", "#26799e", "#56d1e3", "#ffb23d",
];

export const PALETTE_F32 = new Float32Array(24 * 3);
PALETTE_HEX.forEach((hex, i) => {
  const [r, g, b] = hexToRgb01(hex);
  PALETTE_F32[i * 3 + 0] = r;
  PALETTE_F32[i * 3 + 1] = g;
  PALETTE_F32[i * 3 + 2] = b;
});

// Scene landmark positions shared with the lighting shader.
const TOWER_X = -0.24;
const TOWER_Z = -0.10;
const TOWER_R = 0.56;
const TOWER_H = 1.56;
export const LANTERN_POS = [TOWER_X + 0.72, 1.24, TOWER_Z + 0.34];

const PINE1_X = 0.78, PINE1_Z = 0.14;
const PINE2_X = -1.00, PINE2_Z = 0.34;
const POND_X = 0.44, POND_Z = 0.88;
const LOOP_DURATION = 26.0;

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
  const ux = fx * fx * (3 - 2 * fx);
  const uy = fy * fy * (3 - 2 * fy);
  return lerp(
    lerp(hash2(ix, iy), hash2(ix + 1, iy), ux),
    lerp(hash2(ix, iy + 1), hash2(ix + 1, iy + 1), ux),
    uy,
  );
}

function islandTopRadius(theta) {
  return 1.56
    + 0.14 * Math.cos(theta * 2.0 - 0.5)
    + 0.10 * Math.sin(theta * 3.0 + 0.8)
    + 0.06 * Math.cos(theta * 5.0 + 1.1);
}

// Analytical ambient occlusion + soft tower/tree shadows baked into each surfel.
function computeBakedAO(x, y, z, nx, ny, nz, objId) {
  let ao = 1.0;
  const dTower = Math.hypot(x - TOWER_X, z - TOWER_Z);
  if (objId !== 3 && objId !== 5 && objId !== 7 && y < 0.35) {
    if (Math.hypot(x - TOWER_X + 0.55, z - TOWER_Z + 0.26) < TOWER_R * 1.15 && x < TOWER_X + 0.2) {
      ao *= 0.68;
    }
    if (dTower < TOWER_R + 0.22) {
      ao *= lerp(0.72, 1.0, clamp((dTower - TOWER_R) / 0.22, 0, 1));
    }
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
  if (ny < -0.2) {
    ao *= lerp(1.0, 0.62, clamp((-ny - 0.2) / 0.8, 0, 1));
  }
  return ao;
}

export function buildIslandSplats() {
  const rand = mulberry32(20261119);
  const opaque = [];
  const trans = [];

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

  // 1. Floating rocky crag underside (objectId = 1)
  {
    const rings = 32;
    const cragDepth = 1.72;
    for (let i = 0; i <= rings; i++) {
      const v = i / rings;
      const y = -0.02 - v * cragDepth;
      const profile = Math.pow(1.0 - v, 0.72) * (1.0 + 0.08 * Math.sin(v * 14.0));
      const count = Math.max(8, Math.round((2 * Math.PI * Math.max(0.06, 1.54 * profile)) / 0.075));
      for (let j = 0; j < count; j++) {
        const theta = ((j + (i % 2) * 0.5) / count) * Math.PI * 2.0 + (rand() - 0.5) * 0.04;
        const ridge = 1.0 + 0.11 * Math.cos(theta * 7.0 + v * 4.5) + 0.07 * Math.sin(theta * 11.0 - v * 6.0);
        const r = islandTopRadius(theta) * profile * ridge;
        const x = Math.cos(theta) * r;
        const z = Math.sin(theta) * r;
        const nx = Math.cos(theta) * 0.72 + 0.18 * Math.sin(theta * 7.0 + v * 4.5);
        const nz = Math.sin(theta) * 0.72 - 0.18 * Math.cos(theta * 7.0 + v * 4.5);
        const ny = -0.58 - 0.22 * v;
        const strata = valueNoise2(theta * 3.0, v * 9.0);
        const sz = lerp(0.079, 0.058, v) * (0.9 + rand() * 0.22);
        pushSplat(opaque, {
          pos: [x, y, z],
          normal: [nx, ny, nz],
          scale: [sz, sz * 0.9, sz * 0.45],
          color: [
            lerp(0.32, 0.54, strata) * lerp(1.0, 0.78, v),
            lerp(0.35, 0.57, strata) * lerp(1.0, 0.80, v),
            lerp(0.46, 0.68, strata) * lerp(1.0, 0.86, v),
          ],
          ao: computeBakedAO(x, y, z, nx, ny, nz, 1),
          objectId: 1,
        });
      }
    }
    for (let k = 0; k < 5; k++) {
      const th = k * 1.25 + 0.4;
      const baseY = -0.45 - (k % 3) * 0.25;
      const baseR = islandTopRadius(th) * 0.76;
      for (let s = 0; s < 72; s++) {
        const u = rand(), w = rand();
        const ang = th + (u - 0.5) * 0.35;
        const rr = baseR * (1.0 - w * 0.55) + 0.12 * Math.sin(w * Math.PI);
        pushSplat(opaque, {
          pos: [Math.cos(ang) * rr, baseY - w * 0.52, Math.sin(ang) * rr],
          normal: norm3(Math.cos(ang), -0.45, Math.sin(ang)),
          scale: [0.074, 0.068, 0.036],
          color: [0.40, 0.44, 0.56],
          ao: 0.78,
          objectId: 1,
        });
      }
    }
  }

  // 2. Grassy plateau, stepping stones, mossy rim and wildflowers (objectId = 2)
  {
    const rings = 22;
    for (let i = 0; i <= rings; i++) {
      const u = i / rings;
      const count = i === 0 ? 1 : Math.max(8, Math.round((2 * Math.PI * (u * 1.62)) / 0.073));
      for (let j = 0; j < count; j++) {
        const theta = ((j + (i % 2) * 0.5) / count) * Math.PI * 2.0 + (rand() - 0.5) * 0.03;
        const r = u * islandTopRadius(theta) * 1.03;
        const x = Math.cos(theta) * r;
        const z = Math.sin(theta) * r;
        if (Math.hypot(x - POND_X, z - POND_Z) < 0.42) continue;
        if (Math.hypot(x - TOWER_X, z - TOWER_Z) < TOWER_R * 0.90) continue;

        const y = 0.02 + 0.06 * Math.cos(u * Math.PI * 0.5) + 0.03 * Math.sin(x * 2.4 + z * 1.9);
        const nVal = valueNoise2(x * 3.1 + 4.0, z * 3.1 + 7.0);
        const distPath = Math.abs((x - 0.05) * 0.85 - (z - 0.45) * 0.52);
        const onPath = distPath < 0.14 && z > 0.25 && z < 0.85 && x > -0.15 && x < 0.38;
        const isStone = onPath && Math.sin((x + z) * 16.0) > -0.25;
        const oid = isStone ? 4 : 2;
        const color = isStone
          ? [0.66, 0.68, 0.74]
          : [lerp(0.24, 0.46, nVal), lerp(0.56, 0.74, nVal), lerp(0.35, 0.42, nVal)];
        const nx = (rand() - 0.5) * 0.18;
        const nz = (rand() - 0.5) * 0.18;
        const sz = 0.076 * (0.9 + rand() * 0.22);
        pushSplat(opaque, {
          pos: [x, y, z],
          normal: [nx, 1.0, nz],
          scale: [sz, sz, sz * 0.4],
          color,
          ao: computeBakedAO(x, y, z, nx, 1.0, nz, oid),
          objectId: oid,
        });
      }
    }

    for (let i = 0; i < 4; i++) {
      const v = i / 3;
      const count = 124;
      for (let j = 0; j < count; j++) {
        const theta = (j / count) * Math.PI * 2.0;
        const r = islandTopRadius(theta) * (1.035 - v * 0.03);
        const x = Math.cos(theta) * r;
        const z = Math.sin(theta) * r;
        if (Math.hypot(x - (POND_X + 0.26), z - (POND_Z + 0.34)) < 0.30) continue;
        const droop = 0.06 * Math.sin(theta * 9.0) + 0.04 * Math.cos(theta * 15.0);
        const y = 0.02 - v * (0.16 + Math.max(0, droop));
        const nx = Math.cos(theta), ny = lerp(0.45, -0.15, v), nz = Math.sin(theta);
        pushSplat(opaque, {
          pos: [x, y, z],
          normal: [nx, ny, nz],
          scale: [0.069, 0.065, 0.034],
          color: [lerp(0.32, 0.20, v), lerp(0.64, 0.48, v), lerp(0.38, 0.34, v)],
          ao: computeBakedAO(x, y, z, nx, ny, nz, 2),
          objectId: 2,
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
        pushSplat(opaque, {
          pos: [fx + Math.cos(a) * 0.04, 0.11 + (k % 2) * 0.02, fz + Math.sin(a) * 0.04],
          normal: [0, 1, 0],
          scale: [0.042, 0.042, 0.028],
          color: k % 2 === 0 ? [0.98, 0.85, 0.38] : [0.94, 0.48, 0.46],
          ao: 1.0,
          objectId: 2,
        });
      }
    }
  }

  // 3. Stone watchtower with glowing windows, oak doorway and battlements (objectId = 3)
  {
    const ySteps = 26;
    for (let i = 0; i <= ySteps; i++) {
      const v = i / ySteps;
      const y = 0.04 + v * TOWER_H;
      const r = TOWER_R + smoothstep(0.18, 0.0, v) * 0.09 + smoothstep(0.84, 0.95, v) * 0.08 - v * 0.03;
      const count = Math.round((2 * Math.PI * r) / 0.060);
      for (let j = 0; j < count; j++) {
        const theta = ((j + (i % 2) * 0.5) / count) * Math.PI * 2.0;
        const nx = Math.cos(theta), nz = Math.sin(theta);
        const x = TOWER_X + nx * r;
        const z = TOWER_Z + nz * r;

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
          pushSplat(opaque, {
            pos: [x - nx * 0.03, y, z - nz * 0.03],
            normal: [nx, 0, nz],
            scale: [0.056, 0.056, 0.03],
            color: [1.0, 0.80, 0.38],
            emissive: 0.92,
            ao: 1.0,
            objectId: 7,
          });
          continue;
        }
        if (inDoor) {
          const plank = 0.86 + 0.14 * Math.sin(dDoorA * 48.0);
          pushSplat(opaque, {
            pos: [x - nx * 0.035, y, z - nz * 0.035],
            normal: [nx, 0, nz],
            scale: [0.058, 0.058, 0.03],
            color: [0.48 * plank, 0.30 * plank, 0.22 * plank],
            ao: 0.85,
            objectId: 4,
          });
          continue;
        }

        const course = Math.floor(y * 7.2);
        const block = Math.floor(theta * 3.8 + (course % 2) * 0.5);
        const tone = hash2(course, block);
        const mortar = Math.abs((y * 7.2) % 1 - 0.5) > 0.44 ? 0.84 : 1.0;
        const color = inDoorArch
          ? [0.72, 0.73, 0.78]
          : [lerp(0.50, 0.74, tone) * mortar, lerp(0.53, 0.75, tone) * mortar, lerp(0.62, 0.82, tone) * mortar];
        pushSplat(opaque, {
          pos: [x, y, z],
          normal: [nx, 0.02, nz],
          scale: [0.063, 0.059, 0.032],
          color,
          ao: computeBakedAO(x, y, z, nx, 0.02, nz, 3),
          objectId: 3,
        });
      }
    }

    for (let c = 0; c < 8; c++) {
      const a0 = (c / 8) * Math.PI * 2.0;
      for (let u = 0; u < 5; u++) {
        for (let h = 0; h < 4; h++) {
          const th = a0 + (u - 2) * 0.085;
          const r = TOWER_R + 0.065;
          pushSplat(opaque, {
            pos: [TOWER_X + Math.cos(th) * r, TOWER_H + 0.05 + h * 0.055, TOWER_Z + Math.sin(th) * r],
            normal: [Math.cos(th), h === 3 ? 0.7 : 0.05, Math.sin(th)],
            scale: [0.058, 0.056, 0.036],
            color: [0.68, 0.70, 0.78],
            ao: 0.96,
            objectId: 3,
          });
        }
      }
    }
    for (let j = 0; j < 42; j++) {
      const th = (j / 42) * Math.PI * 2.0;
      const r = TOWER_R + 0.04;
      pushSplat(opaque, {
        pos: [TOWER_X + Math.cos(th) * r, TOWER_H + 0.04, TOWER_Z + Math.sin(th) * r],
        normal: [0, 1, 0],
        scale: [0.066, 0.066, 0.03],
        color: [0.70, 0.72, 0.80],
        ao: 0.94,
        objectId: 3,
      });
    }
  }

  // 4. Conical terracotta roof, waving pennant and chimney (objectId = 5)
  {
    const roofBaseY = TOWER_H + 0.14;
    const roofHeight = 1.18;
    const roofBaseR = TOWER_R + 0.20;
    const rows = 22;
    for (let i = 0; i <= rows; i++) {
      const v = i / rows;
      const y = roofBaseY + v * roofHeight;
      const r = Math.max(0.03, roofBaseR * Math.pow(1.0 - v, 0.88));
      const count = Math.max(6, Math.round((2 * Math.PI * r) / 0.058));
      for (let j = 0; j < count; j++) {
        const th = ((j + (i % 2) * 0.5) / count) * Math.PI * 2.0;
        const slopeN = norm3(Math.cos(th) * roofHeight, roofBaseR * 0.85, Math.sin(th) * roofHeight);
        const shingle = 0.86 + 0.16 * hash2(i, j) + 0.06 * Math.sin(v * 28.0);
        const sz = lerp(0.065, 0.047, v);
        pushSplat(opaque, {
          pos: [TOWER_X + Math.cos(th) * r, y, TOWER_Z + Math.sin(th) * r],
          normal: slopeN,
          scale: [sz, sz, sz * 0.38],
          color: [clamp(0.84 * shingle, 0, 1), clamp(0.32 * shingle, 0, 1), clamp(0.30 * shingle, 0, 1)],
          ao: lerp(0.88, 1.0, v),
          objectId: 5,
        });
      }
    }
    for (let j = 0; j < 42; j++) {
      const th = (j / 42) * Math.PI * 2.0;
      const r = roofBaseR * 0.92;
      pushSplat(opaque, {
        pos: [TOWER_X + Math.cos(th) * r, roofBaseY - 0.02, TOWER_Z + Math.sin(th) * r],
        normal: [0, -1, 0],
        scale: [0.068, 0.068, 0.03],
        color: [0.32, 0.14, 0.22],
        ao: 0.6,
        objectId: 5,
      });
    }

    const spireBaseY = roofBaseY + roofHeight;
    for (let k = 0; k < 8; k++) {
      pushSplat(opaque, {
        pos: [TOWER_X, spireBaseY + k * 0.048, TOWER_Z],
        normal: [0, 1, 0],
        scale: [0.032, 0.032, 0.032],
        color: k === 7 ? [1.0, 0.78, 0.32] : [0.36, 0.24, 0.22],
        emissive: k === 7 ? 0.35 : 0.0,
        ao: 1.0,
        objectId: 4,
      });
    }
    for (let fx = 0; fx < 10; fx++) {
      const u = (fx + 1) / 10;
      const hCount = Math.max(1, Math.round(3.5 * (1.0 - u * 0.75)));
      for (let fy = 0; fy < hCount; fy++) {
        pushSplat(opaque, {
          pos: [TOWER_X + u * 0.44, spireBaseY + 0.26 + (fy - (hCount - 1) * 0.5) * 0.045, TOWER_Z],
          normal: [0, 0.2, 1],
          scale: [0.046, 0.044, 0.025],
          color: fy === 0 ? [0.98, 0.74, 0.28] : [0.88, 0.32, 0.30],
          ao: 1.0,
          objectId: 5,
          animType: 2,
          animA: u,
        });
      }
    }

    const chimX = TOWER_X - 0.42, chimZ = TOWER_Z - 0.16;
    for (let cy = 0; cy < 11; cy++) {
      const y = roofBaseY + 0.28 + cy * 0.052;
      for (let s = 0; s < 12; s++) {
        const a = (s / 12) * Math.PI * 2.0;
        const r = cy >= 9 ? 0.125 : 0.105;
        pushSplat(opaque, {
          pos: [chimX + Math.cos(a) * r, y, chimZ + Math.sin(a) * r],
          normal: [Math.cos(a), 0.1, Math.sin(a)],
          scale: [0.046, 0.046, 0.028],
          color: [0.56, 0.58, 0.68],
          ao: 0.92,
          objectId: 3,
        });
      }
    }
  }

  // 5. Hanging glowing lantern and translucent halo (objectId = 7)
  {
    for (let k = 0; k < 7; k++) {
      const u = k / 6;
      pushSplat(opaque, {
        pos: [
          lerp(TOWER_X + 0.46, LANTERN_POS[0], u),
          LANTERN_POS[1] + 0.18,
          lerp(TOWER_Z + 0.22, LANTERN_POS[2], u),
        ],
        normal: [0, 1, 0],
        scale: [0.036, 0.036, 0.028],
        color: [0.24, 0.24, 0.32],
        ao: 0.9,
        objectId: 4,
      });
    }
    for (let j = 0; j < 8; j++) {
      const a = (j / 8) * Math.PI * 2.0;
      pushSplat(opaque, {
        pos: [LANTERN_POS[0] + Math.cos(a) * 0.05, LANTERN_POS[1] + 0.11, LANTERN_POS[2] + Math.sin(a) * 0.05],
        normal: [Math.cos(a), 0.7, Math.sin(a)],
        scale: [0.042, 0.042, 0.028],
        color: [0.26, 0.24, 0.32],
        ao: 1.0,
        objectId: 4,
      });
    }
    for (let k = 0; k < 24; k++) {
      const a = rand() * Math.PI * 2.0;
      const h = (rand() - 0.5) * 0.15;
      const r = 0.04 + rand() * 0.045;
      pushSplat(opaque, {
        pos: [LANTERN_POS[0] + Math.cos(a) * r, LANTERN_POS[1] + h, LANTERN_POS[2] + Math.sin(a) * r],
        normal: [Math.cos(a), 0.2, Math.sin(a)],
        scale: [0.056, 0.056, 0.046],
        color: k < 10 ? [1.0, 0.96, 0.70] : [1.0, 0.72, 0.26],
        emissive: 1.0,
        ao: 1.0,
        objectId: 7,
      });
    }
    for (let k = 0; k < 48; k++) {
      const u = rand() * Math.PI * 2.0;
      const v = Math.acos(2 * rand() - 1);
      const rad = 0.14 + Math.pow(rand(), 0.7) * 0.42;
      const fade = 1.0 - (rad - 0.14) / 0.44;
      pushSplat(trans, {
        pos: [
          LANTERN_POS[0] + Math.sin(v) * Math.cos(u) * rad,
          LANTERN_POS[1] + Math.cos(v) * rad,
          LANTERN_POS[2] + Math.sin(v) * Math.sin(u) * rad,
        ],
        normal: [0, 1, 0],
        scale: [0.10, 0.10, 0.10],
        color: [1.0, lerp(0.68, 0.95, fade), lerp(0.24, 0.65, fade)],
        opacity: clamp(0.42 * fade, 0.08, 0.45),
        emissive: 1.0,
        ao: 1.0,
        objectId: 7,
        animType: 5,
        animA: k,
        animB: rad,
      });
    }
  }

  // 6. Two tiered alpine pines (objectId = 6)
  function addPineTree(cx, cz, scaleH, scaleR, seedOffset) {
    for (let i = 0; i < 12; i++) {
      const y = 0.04 + (i / 11) * (0.48 * scaleH);
      for (let j = 0; j < 7; j++) {
        const a = (j / 7) * Math.PI * 2.0;
        const r = 0.075 * scaleR;
        pushSplat(opaque, {
          pos: [cx + Math.cos(a) * r, y, cz + Math.sin(a) * r],
          normal: [Math.cos(a), 0.05, Math.sin(a)],
          scale: [0.048, 0.048, 0.03],
          color: [0.46, 0.28, 0.22],
          ao: 0.75,
          objectId: 4,
        });
      }
    }
    const tiers = [
      { y0: 0.34, h: 0.56, r0: 0.52 },
      { y0: 0.68, h: 0.52, r0: 0.43 },
      { y0: 0.98, h: 0.46, r0: 0.33 },
      { y0: 1.24, h: 0.40, r0: 0.22 },
    ];
    for (let ti = 0; ti < tiers.length; ti++) {
      const tr = tiers[ti];
      const rows = 9;
      for (let i = 0; i <= rows; i++) {
        const v = i / rows;
        const y = (tr.y0 + v * tr.h) * scaleH;
        const baseR = Math.max(0.03, tr.r0 * scaleR * (1.0 - v * 0.88));
        const count = Math.max(5, Math.round((2 * Math.PI * baseR) / 0.058));
        for (let j = 0; j < count; j++) {
          const th = ((j + (i % 2) * 0.5) / count) * Math.PI * 2.0 + seedOffset;
          const lobe = 1.0 + 0.20 * Math.cos(th * 6.0 + ti * 1.1) * (1.0 - v * 0.6);
          const r = baseR * lobe;
          const [nx, nny, nz] = norm3(Math.cos(th), lerp(0.18, 0.72, v), Math.sin(th));
          const leafShade = lerp(0.76, 1.12, v) * (0.90 + 0.18 * rand());
          const sz = lerp(0.069, 0.049, v) * Math.max(0.85, scaleR);
          pushSplat(opaque, {
            pos: [cx + Math.cos(th) * r, y, cz + Math.sin(th) * r],
            normal: [nx, nny, nz],
            scale: [sz, sz, sz * 0.48],
            color: [0.22 * leafShade, lerp(0.46, 0.66, ti / 3) * leafShade, 0.36 * leafShade],
            ao: lerp(0.70, 1.0, (ti + v) / 4.2),
            objectId: 6,
          });
        }
      }
    }
  }
  addPineTree(PINE1_X, PINE1_Z, 1.12, 1.05, 0.2);
  addPineTree(PINE2_X, PINE2_Z, 0.84, 0.82, 1.7);

  // 7. Wooden barrel prop next to doorway (objectId = 4)
  {
    const bx = 0.28, bz = 0.16;
    for (let i = 0; i < 6; i++) {
      const v = i / 5;
      const y = 0.08 + v * 0.24;
      const r = 0.11 + 0.02 * Math.sin(v * Math.PI);
      for (let j = 0; j < 11; j++) {
        const a = (j / 11) * Math.PI * 2.0;
        const band = i === 1 || i === 4;
        pushSplat(opaque, {
          pos: [bx + Math.cos(a) * r, y, bz + Math.sin(a) * r],
          normal: [Math.cos(a), 0.1, Math.sin(a)],
          scale: [0.044, 0.044, 0.026],
          color: band ? [0.30, 0.32, 0.40] : [0.56, 0.35, 0.24],
          ao: 0.9,
          objectId: 4,
        });
      }
    }
    pushSplat(opaque, {
      pos: [bx, 0.33, bz],
      normal: [0, 1, 0],
      scale: [0.10, 0.10, 0.03],
      color: [0.58, 0.36, 0.25],
      ao: 0.95,
      objectId: 4,
    });
  }

  // 8. Turquoise pond, animated waterfall stream and mist (objectId = 8)
  {
    for (let i = 0; i < 64; i++) {
      const r = Math.sqrt(rand()) * 0.42;
      const a = rand() * Math.PI * 2.0;
      const foam = r > 0.32;
      pushSplat(opaque, {
        pos: [POND_X + Math.cos(a) * r, 0.015, POND_Z + Math.sin(a) * r],
        normal: [0, 1, 0],
        scale: [0.068, 0.068, 0.03],
        color: foam ? [0.85, 0.96, 0.98] : [0.24, 0.72, 0.84],
        emissive: foam ? 0.28 : 0.14,
        ao: 1.0,
        objectId: 8,
      });
    }
    const wfX = POND_X + 0.28, wfZ = POND_Z + 0.36;
    for (let i = 0; i < 160; i++) {
      const u = rand();
      const across = (rand() - 0.5) * 0.24;
      const isFoam = rand() < 0.24 || Math.abs(across) > 0.095;
      pushSplat(opaque, {
        pos: [wfX + across * 0.75, 0.0, wfZ - across * 0.65],
        normal: norm3(0.65, 0.15, 0.75),
        scale: [0.052, 0.078, 0.036],
        color: isFoam ? [0.76, 0.90, 0.98] : [0.22, 0.76, 0.88],
        emissive: isFoam ? 0.38 : 0.20,
        ao: 1.0,
        objectId: 8,
        animType: 3,
        animA: u,
        animB: across,
        animC: rand(),
      });
    }
    for (let i = 0; i < 22; i++) {
      pushSplat(trans, {
        pos: [wfX + 0.10, -1.42, wfZ + 0.12],
        normal: [0, 1, 0],
        scale: [0.068, 0.064, 0.064],
        color: [0.76, 0.92, 0.99],
        opacity: 0.16,
        emissive: 0.25,
        ao: 1.0,
        objectId: 8,
        animType: 4,
        animA: i / 22,
        animB: (rand() - 0.5) * 0.42,
        animC: (rand() - 0.5) * 0.42,
      });
    }
  }

  // 9. Floating mini-rock shards (animType = 1)
  {
    const shards = [
      { x: -1.42, y: -0.58, z: 0.78, rad: 0.24, freq: 2, phase: 0.2 },
      { x: 1.48, y: -0.78, z: -0.62, rad: 0.20, freq: 3, phase: 1.8 },
      { x: -0.68, y: -1.35, z: -1.08, rad: 0.19, freq: 2, phase: 3.1 },
      { x: 0.96, y: -1.24, z: 0.88, rad: 0.16, freq: 3, phase: 4.5 },
    ];
    for (const sh of shards) {
      for (let k = 0; k < 88; k++) {
        const u = rand() * Math.PI * 2.0;
        const v = Math.acos(2 * rand() - 1);
        const nx = Math.sin(v) * Math.cos(u);
        const ny = Math.cos(v);
        const nz = Math.sin(v) * Math.sin(u);
        const lump = 1.0 + 0.22 * Math.cos(u * 3.0 + ny * 4.0);
        pushSplat(opaque, {
          pos: [sh.x + nx * sh.rad * lump, sh.y + ny * sh.rad * 1.15 * lump, sh.z + nz * sh.rad * 0.92 * lump],
          normal: [nx, ny, nz],
          scale: [0.056, 0.054, 0.032],
          color: ny > 0.55 ? [0.34, 0.64, 0.40] : [0.42, 0.46, 0.58],
          ao: ny < 0 ? 0.72 : 0.98,
          objectId: 1,
          animType: 1,
          animA: sh.freq,
          animB: sh.phase,
          animC: 0.10,
        });
      }
    }
  }

  // 10. Chimney smoke puffs and orbiting fireflies (translucent pass)
  {
    const chimTop = [TOWER_X - 0.42, TOWER_H + 0.94, TOWER_Z - 0.16];
    for (let i = 0; i < 24; i++) {
      pushSplat(trans, {
        pos: chimTop,
        normal: [0, 1, 0],
        scale: [0.070, 0.070, 0.070],
        color: [0.80, 0.88, 0.96],
        opacity: 0.16,
        emissive: 0.18,
        ao: 1.0,
        objectId: 9,
        animType: 6,
        animA: i / 24,
        animB: (rand() - 0.5) * 0.18,
        animC: (rand() - 0.5) * 0.18,
      });
    }
    for (let i = 0; i < 24; i++) {
      pushSplat(trans, {
        pos: [0, 0.20 + rand() * 1.85, 0],
        normal: [0, 1, 0],
        scale: [0.048, 0.048, 0.048],
        color: i % 3 === 0 ? [1.0, 0.96, 0.68] : [1.0, 0.72, 0.30],
        opacity: 0.85,
        emissive: 1.0,
        ao: 1.0,
        objectId: 7,
        animType: 7,
        animA: (i / 24) * Math.PI * 2.0,
        animB: 1.15 + rand() * 0.72,
        animC: i % 2 === 0 ? 1 : -1,
      });
    }
  }

  return {
    all: opaque.concat(trans),
    numOpaque: opaque.length,
    numTrans: trans.length,
  };
}

// Updates animated surfel positions, opacities and scales for the current time.
export function animateSplats(splats, t, outX, outY, outZ, outOp, outSc) {
  const phaseT = (((t % LOOP_DURATION) + LOOP_DURATION) % LOOP_DURATION) / LOOP_DURATION;
  const tau = Math.PI * 2.0;

  for (let i = 0; i < splats.length; i++) {
    const s = splats[i];
    let x = s.px, y = s.py, z = s.pz, op = s.opacity, sc = 1.0;

    if (s.animType === 1) {
      y += Math.sin(tau * s.animA * phaseT + s.animB) * s.animC;
    } else if (s.animType === 2) {
      z += Math.sin(tau * 6.0 * phaseT - s.animA * 4.5) * 0.075 * s.animA;
      y += Math.cos(tau * 6.0 * phaseT - s.animA * 3.0) * 0.015 * s.animA;
    } else if (s.animType === 3) {
      const u = (s.animA + phaseT * 8.0) % 1.0;
      const curveOut = Math.sin(u * Math.PI * 0.5) * 0.18;
      x += curveOut * 0.7;
      z += curveOut * 0.7;
      y = 0.02 - u * 1.48;
      sc = lerp(0.92, 0.52, u * u);
    } else if (s.animType === 4) {
      const u = (s.animA + phaseT * 6.0) % 1.0;
      x += s.animB * (0.4 + u * 1.2);
      z += s.animC * (0.4 + u * 1.2);
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
      x = Math.cos(ang) * s.animB;
      z = Math.sin(ang) * s.animB;
      y += Math.sin(tau * 4.0 * phaseT + s.animA * 3.0) * 0.14;
      op = s.opacity * (0.55 + 0.45 * Math.sin(tau * 8.0 * phaseT + s.animA * 5.0));
    }

    outX[i] = x;
    outY[i] = y;
    outZ[i] = z;
    outOp[i] = op;
    outSc[i] = sc;
  }
}
