// Deterministic procedural geometry & instance builders for Evolution of Grass & Foliage (1992-2026):
// - Sculpted rolling meadow hilltop island with mossy cliff rim
// - Ancient standing runestone + flat stepping stones + rolling brass-wood meadow orb
// - 420 crossed alpha-cutout X-cards (1996)
// - 10 stacked shell terrain layers (2001)
// - 22,000 GPU-instanced curved 3D grass blades (2007-2026)
// - 650 GPU-instanced 3D swaying wildflowers & 180 floating sunlit pollen motes (2022-2026)

import { mulberry32, norm3 } from "../../src/gl-utils.js";

export const MEADOW_R = 4.65;
export const TRAIL_RES = 128;
export const TRAIL_SPAN = 9.8; // covers [-4.9, +4.9] world XZ (~7.6 cm/texel crisp trail!)
export const STONE_POS = [-1.12, 0, -0.62];
export const ORB_R = 0.40;

export const STEP_STONES = [
  { x: -0.45, z: 0.25, r: 0.34, rot: 0.4 },
  { x:  0.22, z: 0.78, r: 0.31, rot: 1.2 },
  { x:  0.96, z: 1.18, r: 0.29, rot: 2.3 },
  { x: -1.82, z: -0.10, r: 0.28, rot: 0.9 },
];

// Smooth storybook rolling hilltop heightfield
export function hillHeight(x, z) {
  const r2 = x * x + z * z;
  const knoll = 0.56 * Math.exp(-r2 * 0.115);
  const undul =
    0.12 * Math.sin(x * 0.62 + 0.35) * Math.cos(z * 0.58 - 0.25) +
    0.055 * Math.cos(x * 1.15 - z * 0.95 + 0.8);
  const rimDrop = r2 > 18.5 ? -0.18 * Math.pow(Math.sqrt(r2) - Math.sqrt(18.5), 1.6) : 0.0;
  return knoll + undul + rimDrop - 0.16;
}

export function hillNormal(x, z) {
  const e = 0.04;
  const hx = hillHeight(x + e, z) - hillHeight(x - e, z);
  const hz = hillHeight(x, z + e) - hillHeight(x, z - e);
  return norm3(-hx, 2 * e, -hz);
}

// Wide, hero-framed sunlit meadow promenade (5 lively laps per 36s cycle — always in front of hilltop crest!)
export function sampleOrbPath(uPhase) {
  // Stays in x in [-1.75..+1.98], z in [-0.28..+2.00]: 100% visible in both 9:16 & 16:9, sweeping foreground at Hook & Finale!
  const a = 0.10 + uPhase * Math.PI * 2.0 * 5.0;
  let ox = 0.12 + 1.84 * Math.cos(a);
  let oz = 0.86 + 1.14 * Math.sin(a);
  // Smooth gentle detour around the standing runestone & companion boulder
  const sx = STONE_POS[0] - 0.14, sz = STONE_POS[2] + 0.04;
  const dx = ox - sx, dz = oz - sz;
  const d = Math.hypot(dx, dz);
  const minD = 1.42;
  if (d < minD && d > 1e-4) {
    const push = (minD - d);
    ox += (dx / d) * push;
    oz += (dz / d) * push;
  }
  const oy = hillHeight(ox, oz) + ORB_R * 1.01;
  return [ox, oy, oz];
}

// Rolling hilltop disc + earthy rock skirt underneath (stride: 9 floats -> pos3, norm3, uv2, skirt1)
export function buildHillMesh(rings = 34, segs = 72) {
  const verts = [];
  const indices = [];

  // Center vertex
  const cy = hillHeight(0, 0);
  const cn = hillNormal(0, 0);
  verts.push(0, cy, 0, cn[0], cn[1], cn[2], 0.5, 0.5, 0.0);

  for (let r = 1; r <= rings; r++) {
    const rf = r / rings;
    const rad = rf * MEADOW_R;
    for (let s = 0; s < segs; s++) {
      const th = (s / segs) * Math.PI * 2;
      const x = Math.cos(th) * rad;
      const z = Math.sin(th) * rad;
      const y = hillHeight(x, z);
      const n = hillNormal(x, z);
      verts.push(x, y, z, n[0], n[1], n[2], x / (MEADOW_R * 2) + 0.5, z / (MEADOW_R * 2) + 0.5, 0.0);
    }
  }

  // Top disc triangles
  for (let s = 0; s < segs; s++) {
    const sNext = (s + 1) % segs;
    indices.push(0, 1 + sNext, 1 + s);
  }
  for (let r = 1; r < rings; r++) {
    const row0 = 1 + (r - 1) * segs;
    const row1 = 1 + r * segs;
    for (let s = 0; s < segs; s++) {
      const sNext = (s + 1) % segs;
      indices.push(row0 + s, row0 + sNext, row1 + sNext);
      indices.push(row0 + s, row1 + sNext, row1 + s);
    }
  }

  // Earthy cliff skirt around the rim + dark flat underside cap
  const skirtBase = verts.length / 9;
  const skirtSteps = [
    { radMul: 1.00, dy:  0.00, ny: 0.25 },
    { radMul: 1.015, dy: -0.22, ny: -0.05 },
    { radMul: 0.94, dy: -0.62, ny: -0.35 },
    { radMul: 0.72, dy: -0.92, ny: -0.75 },
  ];
  for (let k = 0; k < skirtSteps.length; k++) {
    const st = skirtSteps[k];
    for (let s = 0; s < segs; s++) {
      const th = (s / segs) * Math.PI * 2;
      const wob = 1.0 + 0.025 * Math.sin(th * 7 + k * 1.4) + 0.018 * Math.cos(th * 13 - k);
      const rad = MEADOW_R * st.radMul * (k === 0 ? 1.0 : wob);
      const x = Math.cos(th) * rad;
      const z = Math.sin(th) * rad;
      const edgeY = hillHeight(Math.cos(th) * MEADOW_R, Math.sin(th) * MEADOW_R);
      const y = edgeY + st.dy;
      const n = norm3(Math.cos(th), st.ny, Math.sin(th));
      verts.push(x, y, z, n[0], n[1], n[2], s / segs, k / (skirtSteps.length - 1), 1.0);
    }
  }
  for (let k = 0; k < skirtSteps.length - 1; k++) {
    const row0 = skirtBase + k * segs;
    const row1 = skirtBase + (k + 1) * segs;
    for (let s = 0; s < segs; s++) {
      const sNext = (s + 1) % segs;
      indices.push(row0 + s, row0 + sNext, row1 + sNext);
      indices.push(row0 + s, row1 + sNext, row1 + s);
    }
  }

  return {
    vertices: new Float32Array(verts),
    indices: new Uint32Array(indices),
  };
}

// Sculpted ancient mossy standing runestone + flat stepping stones (stride: 9 floats -> pos3, norm3, uv2, matId)
// matId: 0 = standing stone, 1 = stepping stone
export function buildPropsMesh() {
  const verts = [];
  const indices = [];

  function pushTri(a, b, c, uva, uvb, uvc, matId) {
    const ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const ac = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    const n = norm3(
      ab[1] * ac[2] - ab[2] * ac[1],
      ab[2] * ac[0] - ab[0] * ac[2],
      ab[0] * ac[1] - ab[1] * ac[0]
    );
    const base = verts.length / 9;
    verts.push(
      a[0], a[1], a[2], n[0], n[1], n[2], uva[0], uva[1], matId,
      b[0], b[1], b[2], n[0], n[1], n[2], uvb[0], uvb[1], matId,
      c[0], c[1], c[2], n[0], n[1], n[2], uvc[0], uvc[1], matId
    );
    indices.push(base, base + 1, base + 2);
  }

  // 1. Standing ancient runestone (weathered flat-beveled Ghibli monolith + mossy companion boulder!)
  const sx = STONE_POS[0], sz = STONE_POS[2], sy = hillHeight(sx, sz) - 0.14;
  const tiltX = 0.07, tiltZ = 0.04;
  const layers = [
    { y: 0.00, rx: 0.50, rz: 0.24 },
    { y: 0.38, rx: 0.47, rz: 0.22 },
    { y: 0.92, rx: 0.41, rz: 0.19 },
    { y: 1.32, rx: 0.32, rz: 0.15 },
    { y: 1.54, rx: 0.16, rz: 0.08 },
  ];
  const sides = 8;
  const yaw = 0.18; // Face front broad side cleanly toward default camera!
  const cy = Math.cos(yaw), syaw = Math.sin(yaw);

  function stonePt(ly, rx, rz, idx) {
    const th = (idx / sides) * Math.PI * 2 + Math.PI / 8;
    const chip = 1.0 + 0.06 * Math.sin(idx * 2.7 + ly * 3.1);
    const lx = Math.cos(th) * rx * chip;
    const lz = Math.sin(th) * rz * chip;
    const wx = sx + (lx * cy - lz * syaw) + ly * tiltX;
    const wz = sz + (lx * syaw + lz * cy) + ly * tiltZ;
    return [wx, sy + ly, wz];
  }

  for (let l = 0; l < layers.length - 1; l++) {
    const L0 = layers[l], L1 = layers[l + 1];
    const v0 = l / (layers.length - 1), v1 = (l + 1) / (layers.length - 1);
    for (let i = 0; i < sides; i++) {
      const iN = (i + 1) % sides;
      const p00 = stonePt(L0.y, L0.rx, L0.rz, i);
      const p10 = stonePt(L0.y, L0.rx, L0.rz, iN);
      const p01 = stonePt(L1.y, L1.rx, L1.rz, i);
      const p11 = stonePt(L1.y, L1.rx, L1.rz, iN);
      const u0 = i / sides, u1 = (i + 1) / sides;
      pushTri(p00, p11, p10, [u0, v0], [u1, v1], [u1, v0], 0.0);
      pushTri(p00, p01, p11, [u0, v0], [u0, v1], [u1, v1], 0.0);
    }
  }
  const topL = layers[layers.length - 1];
  const topCenter = [sx + topL.y * tiltX, sy + topL.y + 0.05, sz + topL.y * tiltZ];
  for (let i = 0; i < sides; i++) {
    const iN = (i + 1) % sides;
    pushTri(
      stonePt(topL.y, topL.rx, topL.rz, iN),
      stonePt(topL.y, topL.rx, topL.rz, i),
      topCenter,
      [0.5, 1.0], [0.5, 1.0], [0.5, 1.0], 0.0
    );
  }

  // Mossy companion shoulder boulder nestled beside the monolith base
  const bx = sx - 0.50, bz = sz + 0.16, by0 = hillHeight(bx, bz) - 0.08;
  const bLayers = [
    { y: 0.00, r: 0.34 },
    { y: 0.22, r: 0.30 },
    { y: 0.42, r: 0.17 },
  ];
  for (let l = 0; l < bLayers.length - 1; l++) {
    const L0 = bLayers[l], L1 = bLayers[l + 1];
    for (let i = 0; i < 7; i++) {
      const a0 = (i / 7) * Math.PI * 2, a1 = ((i + 1) / 7) * Math.PI * 2;
      const p00 = [bx + Math.cos(a0) * L0.r, by0 + L0.y, bz + Math.sin(a0) * L0.r * 0.85];
      const p10 = [bx + Math.cos(a1) * L0.r, by0 + L0.y, bz + Math.sin(a1) * L0.r * 0.85];
      const p01 = [bx + Math.cos(a0) * L1.r, by0 + L1.y, bz + Math.sin(a0) * L1.r * 0.85];
      const p11 = [bx + Math.cos(a1) * L1.r, by0 + L1.y, bz + Math.sin(a1) * L1.r * 0.85];
      pushTri(p00, p10, p11, [0, 0.2], [1, 0.2], [1, 0.4], 1.0);
      pushTri(p00, p11, p01, [0, 0.2], [1, 0.4], [0, 0.4], 1.0);
    }
  }
  const bTop = [bx, by0 + 0.49, bz];
  for (let i = 0; i < 7; i++) {
    const a0 = (i / 7) * Math.PI * 2, a1 = ((i + 1) / 7) * Math.PI * 2;
    const r = bLayers[2].r;
    pushTri([bx + Math.cos(a0) * r, by0 + 0.42, bz + Math.sin(a0) * r * 0.85], [bx + Math.cos(a1) * r, by0 + 0.42, bz + Math.sin(a1) * r * 0.85], bTop, [0.5, 0.5], [0.5, 0.5], [0.5, 0.5], 1.0);
  }

  // 2. Flat mossy stepping stones embedded into the hillside
  for (const st of STEP_STONES) {
    const by = hillHeight(st.x, st.z);
    const n = hillNormal(st.x, st.z);
    const seg = 9;
    const h = 0.055;
    const topPts = [], botPts = [];
    for (let i = 0; i < seg; i++) {
      const th = (i / seg) * Math.PI * 2 + st.rot;
      const rad = st.r * (0.86 + 0.16 * Math.sin(i * 2.3 + st.rot));
      const px = st.x + Math.cos(th) * rad;
      const pz = st.z + Math.sin(th) * rad * 0.78;
      const py = hillHeight(px, pz);
      topPts.push([px + n[0] * h, py + h, pz + n[2] * h]);
      botPts.push([px, py - 0.06, pz]);
    }
    const cTop = [st.x + n[0] * (h + 0.015), by + h + 0.015, st.z + n[2] * (h + 0.015)];
    for (let i = 0; i < seg; i++) {
      const iN = (i + 1) % seg;
      pushTri(cTop, topPts[iN], topPts[i], [0.5, 0.5], [1, 0], [0, 1], 1.0);
      pushTri(botPts[i], botPts[iN], topPts[iN], [0, 0], [1, 0], [1, 1], 1.0);
      pushTri(botPts[i], topPts[iN], topPts[i], [0, 0], [1, 1], [0, 1], 1.0);
    }
  }

  return {
    vertices: new Float32Array(verts),
    indices: new Uint16Array(indices),
  };
}

// Rolling bronze-and-oak meadow orb mesh (unit sphere scaled by ORB_R, stride: 8 floats -> pos3, norm3, uv2)
export function buildOrbMesh(lat = 18, lon = 28) {
  const verts = [];
  const indices = [];
  for (let i = 0; i <= lat; i++) {
    const v = i / lat;
    const phi = v * Math.PI;
    const sp = Math.sin(phi), cp = Math.cos(phi);
    for (let j = 0; j <= lon; j++) {
      const u = j / lon;
      const th = u * Math.PI * 2;
      const nx = sp * Math.cos(th), ny = cp, nz = sp * Math.sin(th);
      verts.push(nx * ORB_R, ny * ORB_R, nz * ORB_R, nx, ny, nz, u, v);
    }
  }
  for (let i = 0; i < lat; i++) {
    for (let j = 0; j < lon; j++) {
      const a = i * (lon + 1) + j;
      const b = a + lon + 1;
      indices.push(a, a + 1, b + 1, a, b + 1, b);
    }
  }
  return { vertices: new Float32Array(verts), indices: new Uint16Array(indices) };
}

function isClearedForProp(x, z, pad = 0.0) {
  const ds = Math.hypot(x - STONE_POS[0], z - STONE_POS[2]);
  if (ds < 0.62 + pad) return true;
  if (Math.hypot(x - (STONE_POS[0] - 0.50), z - (STONE_POS[2] + 0.16)) < 0.36 + pad) return true;
  for (const st of STEP_STONES) {
    if (Math.hypot(x - st.x, z - st.z) < st.r * 1.12 + pad) return true;
  }
  return false;
}

// Step 2 (1996): 440 crossed alpha-cutout X-cards (2 intersecting vertical quads per tuft)
// Stride: 9 floats -> pos3, uv2, norm3, seed1
export function buildXCardsMesh(count = 440) {
  const rng = mulberry32(19960623);
  const verts = [];
  const indices = [];
  let placed = 0, tries = 0;

  while (placed < count && tries < count * 8) {
    tries++;
    const rad = Math.sqrt(rng()) * (MEADOW_R - 0.30);
    const th = rng() * Math.PI * 2;
    const x = Math.cos(th) * rad;
    const z = Math.sin(th) * rad;
    if (isClearedForProp(x, z, 0.08)) continue;

    const y = hillHeight(x, z) - 0.02;
    const h = 0.44 + rng() * 0.28;
    const hw = 0.28 + rng() * 0.14;
    const baseYaw = rng() * Math.PI;
    const seed = rng();

    // Two orthogonal crossed quads (X shape!)
    for (let q = 0; q < 2; q++) {
      const a = baseYaw + q * Math.PI * 0.5;
      const dx = Math.cos(a) * hw;
      const dz = Math.sin(a) * hw;
      const nx = -Math.sin(a), nz = Math.cos(a);
      const base = verts.length / 9;
      verts.push(
        x - dx, y,     z - dz, 0, 0, nx, 0.2, nz, seed,
        x + dx, y,     z + dz, 1, 0, nx, 0.2, nz, seed,
        x + dx, y + h, z + dz, 1, 1, nx, 0.2, nz, seed,
        x - dx, y + h, z - dz, 0, 1, nx, 0.2, nz, seed
      );
      indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
    }
    placed++;
  }
  return { vertices: new Float32Array(verts), indices: new Uint32Array(indices) };
}

// Step 3 (2001): 10 stacked shell terrain layers lifted along surface normal
// Stride: 7 floats -> pos3, norm3, layerFrac1
export function buildShellsMesh(layers = 10, rings = 22, segs = 56) {
  const verts = [];
  const indices = [];
  const maxH = 0.42;

  for (let l = 1; l <= layers; l++) {
    const lf = l / layers;
    const hOff = lf * maxH;
    const vStart = verts.length / 7;

    const cy = hillHeight(0, 0);
    const cn = hillNormal(0, 0);
    verts.push(cn[0] * hOff, cy + cn[1] * hOff, cn[2] * hOff, cn[0], cn[1], cn[2], lf);

    for (let r = 1; r <= rings; r++) {
      const rad = (r / rings) * (MEADOW_R - 0.14);
      for (let s = 0; s < segs; s++) {
        const th = (s / segs) * Math.PI * 2;
        const x = Math.cos(th) * rad;
        const z = Math.sin(th) * rad;
        const y = hillHeight(x, z);
        const n = hillNormal(x, z);
        verts.push(x + n[0] * hOff, y + n[1] * hOff, z + n[2] * hOff, n[0], n[1], n[2], lf);
      }
    }

    for (let s = 0; s < segs; s++) {
      const sN = (s + 1) % segs;
      indices.push(vStart, vStart + 1 + sN, vStart + 1 + s);
    }
    for (let r = 1; r < rings; r++) {
      const row0 = vStart + 1 + (r - 1) * segs;
      const row1 = vStart + 1 + r * segs;
      for (let s = 0; s < segs; s++) {
        const sN = (s + 1) % segs;
        indices.push(row0 + s, row0 + sN, row1 + sN);
        indices.push(row0 + s, row1 + sN, row1 + s);
      }
    }
  }
  return { vertices: new Float32Array(verts), indices: new Uint32Array(indices) };
}

// Steps 4-8 (2007-2026): Shared tapered 3D curved grass blade mesh (4 segments -> 9 verts, 7 tris)
// Attribute per vertex: aBlade(side in [-1, 1], t in [0..1])
export function buildBladeGeometry() {
  const verts = new Float32Array([
    -1.0, 0.00,  1.0, 0.00,
    -1.0, 0.25,  1.0, 0.25,
    -1.0, 0.50,  1.0, 0.50,
    -1.0, 0.75,  1.0, 0.75,
     0.0, 1.00,
  ]);
  const indices = new Uint16Array([
    0, 1, 3,  0, 3, 2,
    2, 3, 5,  2, 5, 4,
    4, 5, 7,  4, 7, 6,
    6, 7, 8,
  ]);
  return { vertices: verts, indices };
}

// 22,000 GPU-instanced grass blades packed into two vec4 instance attributes:
// instPosH: (x, y, z, height)
// instMeta: (yaw, width, lean, colorHash)
export function buildBladeInstances(count = 22000) {
  const rng = mulberry32(20260420);
  const posH = new Float32Array(count * 4);
  const meta = new Float32Array(count * 4);
  let placed = 0, tries = 0;

  while (placed < count && tries < count * 5) {
    tries++;
    const u = rng();
    const rad = Math.sqrt(u) * (MEADOW_R - 0.16);
    const th = rng() * Math.PI * 2;
    const x = Math.cos(th) * rad;
    const z = Math.sin(th) * rad;
    if (isClearedForProp(x, z, 0.02)) continue;

    const y = hillHeight(x, z) - 0.02;
    // Natural meadow height clumps (taller lush tufts in rolling patches, gently shorter near island edge)
    const patch = 0.5 + 0.5 * Math.sin(x * 1.1 + 0.5) * Math.cos(z * 1.05 - 0.4);
    const edgeTaper = rad > MEADOW_R - 0.75 ? Math.max(0.45, (MEADOW_R - 0.12 - rad) / 0.65) : 1.0;
    const h = (0.34 + patch * 0.24 + rng() * 0.22) * edgeTaper;
    const w = 0.044 + rng() * 0.024;
    const yaw = rng() * Math.PI * 2;
    const lean = 0.16 + rng() * 0.34;
    const colHash = rng();

    const o = placed * 4;
    posH[o] = x; posH[o + 1] = y; posH[o + 2] = z; posH[o + 3] = h;
    meta[o] = yaw; meta[o + 1] = w; meta[o + 2] = lean; meta[o + 3] = colHash;
    placed++;
  }

  return {
    count: placed,
    posH: posH.subarray(0, placed * 4),
    meta: meta.subarray(0, placed * 4),
  };
}

// Steps 7-8 (2022-2026): Shared 3D wildflower geometry (stem + 5-petal cup + warm center disc)
// Stride: 7 floats -> localPos3 (with y in [0..1] stalk height), norm3, partId (0=stem, 1=petal, 2=center)
export function buildFlowerGeometry() {
  const verts = [];
  const indices = [];

  function pushQuad(a, b, c, d, n, part) {
    const base = verts.length / 7;
    verts.push(
      a[0], a[1], a[2], n[0], n[1], n[2], part,
      b[0], b[1], b[2], n[0], n[1], n[2], part,
      c[0], c[1], c[2], n[0], n[1], n[2], part,
      d[0], d[1], d[2], n[0], n[1], n[2], part
    );
    indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }

  // Slender 2-plane crossed stem (0..0.95)
  const sw = 0.012;
  pushQuad([-sw, 0, 0], [sw, 0, 0], [sw * 0.7, 0.96, 0], [-sw * 0.7, 0.96, 0], [0, 0.2, 1], 0.0);
  pushQuad([0, 0, -sw], [0, 0, sw], [0, 0.96, sw * 0.7], [0, 0.96, -sw * 0.7], [1, 0.2, 0], 0.0);

  // 5-petal slightly cupped blossom at y = 0.98
  const petals = 5;
  const pLen = 0.088, pWid = 0.044;
  for (let i = 0; i < petals; i++) {
    const a = (i / petals) * Math.PI * 2;
    const ca = Math.cos(a), sa = Math.sin(a);
    const tx = -sa * pWid, tz = ca * pWid;
    const r0 = 0.018, rMid = pLen * 0.62, rTip = pLen;
    const base = verts.length / 7;
    const n = norm3(ca * 0.25, 0.95, sa * 0.25);
    verts.push(
      ca * r0, 0.96, sa * r0, n[0], n[1], n[2], 1.0,
      ca * rMid - tx, 0.995, sa * rMid - tz, n[0], n[1], n[2], 1.0,
      ca * rTip, 1.015, sa * rTip, n[0], n[1], n[2], 1.0,
      ca * rMid + tx, 0.995, sa * rMid + tz, n[0], n[1], n[2], 1.0
    );
    indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }

  // Golden center button (small 5-gon dome at y = 0.99..1.02)
  const cIdx = verts.length / 7;
  verts.push(0, 1.022, 0, 0, 1, 0, 2.0);
  const cRad = 0.028;
  for (let i = 0; i < petals; i++) {
    const a = (i / petals) * Math.PI * 2;
    verts.push(Math.cos(a) * cRad, 0.985, Math.sin(a) * cRad, Math.cos(a) * 0.3, 0.95, Math.sin(a) * 0.3, 2.0);
  }
  for (let i = 0; i < petals; i++) {
    indices.push(cIdx, cIdx + 1 + i, cIdx + 1 + ((i + 1) % petals));
  }

  return { vertices: new Float32Array(verts), indices: new Uint16Array(indices) };
}

// 650 organic wildflower clusters (buttercup yellow, white daisy, cornflower blue, rare coral poppy)
// instPosH: (x, y, z, height), instMeta: (yaw, scale, species 0..3, seed)
export function buildFlowerInstances(count = 650) {
  const rng = mulberry32(20220515);
  const posH = new Float32Array(count * 4);
  const meta = new Float32Array(count * 4);

  // Seed 18 organic wildflower cluster centers across the meadow
  const clusters = [];
  for (let i = 0; i < 18; i++) {
    const rad = 0.55 + rng() * (MEADOW_R - 1.15);
    const th = rng() * Math.PI * 2;
    const speciesRoll = rng();
    const species = speciesRoll < 0.34 ? 0 : (speciesRoll < 0.62 ? 1 : (speciesRoll < 0.82 ? 2 : 3));
    clusters.push({ x: Math.cos(th) * rad, z: Math.sin(th) * rad, species });
  }

  let placed = 0, tries = 0;
  while (placed < count && tries < count * 6) {
    tries++;
    let x, z, species;
    if (rng() < 0.78) {
      const cl = clusters[Math.floor(rng() * clusters.length)];
      const r = Math.sqrt(rng()) * 1.15;
      const a = rng() * Math.PI * 2;
      x = cl.x + Math.cos(a) * r;
      z = cl.z + Math.sin(a) * r;
      species = cl.species;
    } else {
      const r = Math.sqrt(rng()) * (MEADOW_R - 0.45);
      const a = rng() * Math.PI * 2;
      x = Math.cos(a) * r;
      z = Math.sin(a) * r;
      species = Math.floor(rng() * 3);
    }
    if (Math.hypot(x, z) > MEADOW_R - 0.38) continue;
    if (isClearedForProp(x, z, 0.14)) continue;

    const y = hillHeight(x, z) - 0.015;
    const h = 0.42 + rng() * 0.30;
    const scale = 0.85 + rng() * 0.50;
    const yaw = rng() * Math.PI * 2;
    const seed = rng();

    const o = placed * 4;
    posH[o] = x; posH[o + 1] = y; posH[o + 2] = z; posH[o + 3] = h;
    meta[o] = yaw; meta[o + 1] = scale; meta[o + 2] = species; meta[o + 3] = seed;
    placed++;
  }

  return {
    count: placed,
    posH: posH.subarray(0, placed * 4),
    meta: meta.subarray(0, placed * 4),
  };
}

// 180 floating golden sunlit pollen motes (x, yOff, z, phase)
export function buildPollenData(count = 180) {
  const rng = mulberry32(20260777);
  const data = new Float32Array(count * 4);
  for (let i = 0; i < count; i++) {
    const r = Math.sqrt(rng()) * (MEADOW_R - 0.3);
    const a = rng() * Math.PI * 2;
    const o = i * 4;
    data[o] = Math.cos(a) * r;
    data[o + 1] = 0.35 + rng() * 1.85;
    data[o + 2] = Math.sin(a) * r;
    data[o + 3] = rng();
  }
  return { count, data };
}
