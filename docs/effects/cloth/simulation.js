// CPU physics, procedural geometry & heraldic cloth textures for Evolution of Cloth (1988-2026).
// Runs a real 37x29 Verlet / XPBD particle mesh with bending constraints, sphere collision,
// per-triangle aerodynamic drag & lift, dynamic tearing, and loose thread particles.

import { clamp, smoothstep } from "../../src/gl-utils.js";

export const COLS = 36; // 37 vertices wide
export const ROWS = 28; // 29 vertices tall
export const NX = COLS + 1;
export const NY = ROWS + 1;
export const VERTS = NX * NY;
export const CELLS = COLS * ROWS;

export const BANNER_W = 2.24;
export const BANNER_H = 2.48;
export const TOP_Y = 2.62;
export const SPHERE_R = 0.35;
export const MAX_THREADS = 128;

// ----------------------------------------------------------------------------
// 1. Procedural 1988 2-Frame Pixel Art Banner (32x24 nearest-neighbor sprite)
// ----------------------------------------------------------------------------
export function buildRetroBannerTexture(frameIdx) {
  const w = 32, h = 24;
  const data = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    const v = y / (h - 1);
    for (let x = 0; x < w; x++) {
      const u = x / (w - 1);
      // Simple 2-frame stepped wave offset at bottom edge for authentic 1988 flip animation.
      const waveShift = frameIdx === 0
        ? Math.round(Math.sin(u * Math.PI * 2.0) * v * 1.4)
        : Math.round(Math.sin(u * Math.PI * 2.0 + Math.PI) * v * 1.4);
      const sx = clamp(x + waveShift, 0, w - 1);
      const su = sx / (w - 1);

      const border = sx <= 2 || sx >= w - 3 || y <= 1 || y >= h - 3;
      const innerLine = (sx === 4 || sx === w - 5 || y === 3 || y === h - 5) && !border;
      const dx = (su - 0.5) * 1.85;
      const dy = (v - 0.46) * 2.15;
      const dDiamond = Math.abs(dx) + Math.abs(dy);
      const dCross = Math.min(Math.abs(dx), Math.abs(dy));
      const emblem = (dDiamond < 0.48 && dDiamond > 0.24) || (dDiamond < 0.42 && dCross < 0.085);

      // 8-bit 4-color palette: dark crimson, bright crimson, gold, pale highlight.
      const shadeBand = ((sx + y + frameIdx * 4) % 8 < 4) ? 1 : 0;
      let r = 162, g = 24, b = 36;
      if (border || emblem) {
        r = shadeBand ? 242 : 212;
        g = shadeBand ? 196 : 156;
        b = shadeBand ? 66 : 38;
      } else if (innerLine) {
        r = 104; g = 14; b = 22;
      } else if (shadeBand) {
        r = 188; g = 34, b = 48;
      }
      const o = (y * w + x) * 4;
      data[o] = r; data[o + 1] = g; data[o + 2] = b; data[o + 3] = 255;
    }
  }
  return { width: w, height: h, data };
}

// ----------------------------------------------------------------------------
// 2. Procedural 3D Solid Meshes (Stone Battlement, Wrought-Iron Pole, Sphere)
//    Vertex layout: [px, py, pz, nx, ny, nz, u, v, matId] (9 floats / vertex)
// ----------------------------------------------------------------------------
function pushVert(arr, px, py, pz, nx, ny, nz, u, v, mat) {
  const l = Math.hypot(nx, ny, nz) || 1;
  arr.push(px, py, pz, nx / l, ny / l, nz / l, u, v, mat);
}

function addCylinder(verts, idxs, x0, y0, z0, x1, y1, z1, r0, r1, segs, mat) {
  const dx = x1 - x0, dy = y1 - y0, dz = z1 - z0;
  const len = Math.hypot(dx, dy, dz) || 1;
  const ax = dx / len, ay = dy / len, az = dz / len;
  const ref = Math.abs(ay) < 0.9 ? [0, 1, 0] : [1, 0, 0];
  let tx = ay * ref[2] - az * ref[1];
  let ty = az * ref[0] - ax * ref[2];
  let tz = ax * ref[1] - ay * ref[0];
  const tl = Math.hypot(tx, ty, tz) || 1;
  tx /= tl; ty /= tl; tz /= tl;
  const bx = ay * tz - az * ty, by = az * tx - ax * tz, bz = ax * ty - ay * tx;

  const base = verts.length / 9;
  for (let i = 0; i <= segs; i++) {
    const a = (i / segs) * Math.PI * 2;
    const ca = Math.cos(a), sa = Math.sin(a);
    const nx = tx * ca + bx * sa, ny = ty * ca + by * sa, nz = tz * ca + bz * sa;
    pushVert(verts, x0 + nx * r0, y0 + ny * r0, z0 + nz * r0, nx, ny, nz, i / segs, 0, mat);
    pushVert(verts, x1 + nx * r1, y1 + ny * r1, z1 + nz * r1, nx, ny, nz, i / segs, 1, mat);
  }
  for (let i = 0; i < segs; i++) {
    const k = base + i * 2;
    idxs.push(k, k + 2, k + 1, k + 1, k + 2, k + 3);
  }

  // End caps
  for (const [cx, cy, cz, r, sign] of [[x0, y0, z0, r0, -1], [x1, y1, z1, r1, 1]]) {
    const cIdx = verts.length / 9;
    pushVert(verts, cx, cy, cz, ax * sign, ay * sign, az * sign, 0.5, 0.5, mat);
    for (let i = 0; i <= segs; i++) {
      const a = (i / segs) * Math.PI * 2;
      const ca = Math.cos(a), sa = Math.sin(a);
      const px = cx + (tx * ca + bx * sa) * r;
      const py = cy + (ty * ca + by * sa) * r;
      const pz = cz + (tz * ca + bz * sa) * r;
      pushVert(verts, px, py, pz, ax * sign, ay * sign, az * sign, 0.5 + 0.5 * ca, 0.5 + 0.5 * sa, mat);
    }
    for (let i = 0; i < segs; i++) {
      if (sign > 0) idxs.push(cIdx, cIdx + 1 + i, cIdx + 2 + i);
      else idxs.push(cIdx, cIdx + 2 + i, cIdx + 1 + i);
    }
  }
}

function addSphere(verts, idxs, cx, cy, cz, r, latN, lonN, mat) {
  const base = verts.length / 9;
  for (let y = 0; y <= latN; y++) {
    const v = y / latN;
    const phi = v * Math.PI;
    const sp = Math.sin(phi), cp = Math.cos(phi);
    for (let x = 0; x <= lonN; x++) {
      const u = x / lonN;
      const th = u * Math.PI * 2;
      const nx = sp * Math.cos(th), ny = cp, nz = sp * Math.sin(th);
      pushVert(verts, cx + nx * r, cy + ny * r, cz + nz * r, nx, ny, nz, u, v, mat);
    }
  }
  const stride = lonN + 1;
  for (let y = 0; y < latN; y++) {
    for (let x = 0; x < lonN; x++) {
      const a = base + y * stride + x;
      const b = a + stride;
      idxs.push(a, a + 1, b, b, a + 1, b + 1);
    }
  }
}

export function buildStaticStageMesh() {
  const verts = [], idxs = [];
  // 1. Stone battlement dais (mat 1 = travertine stone, mat 2 = wrought iron, mat 3 = antique brass).
  addCylinder(verts, idxs, 0, -0.34, 0, 0, 0.0, 0, 2.38, 2.48, 40, 1.0);
  addCylinder(verts, idxs, 0, -0.92, 0, 0, -0.34, 0, 1.15, 2.30, 36, 1.0);
  // Central pole socket stone plinth
  addCylinder(verts, idxs, -1.26, 0.0, -0.02, -1.26, 0.24, -0.02, 0.28, 0.22, 20, 1.0);
  addCylinder(verts, idxs,  1.26, 0.0, -0.02,  1.26, 0.24, -0.02, 0.28, 0.22, 20, 1.0);

  // 2. Twin wrought-iron banner standards + top crossbar holding the banner cleanly in view!
  addCylinder(verts, idxs, -1.26, 0.22, -0.02, -1.26, TOP_Y + 0.14, -0.02, 0.048, 0.042, 14, 2.0);
  addCylinder(verts, idxs,  1.26, 0.22, -0.02,  1.26, TOP_Y + 0.14, -0.02, 0.048, 0.042, 14, 2.0);
  addCylinder(verts, idxs, -1.36, TOP_Y + 0.02, -0.02, 1.36, TOP_Y + 0.02, -0.02, 0.036, 0.036, 14, 2.0);

  // 3. Brass finials & 7 hanging rings gathered slightly inward so the banner forms rich vertical drape folds!
  addSphere(verts, idxs, -1.26, TOP_Y + 0.22, -0.02, 0.092, 12, 16, 3.0);
  addSphere(verts, idxs,  1.26, TOP_Y + 0.22, -0.02, 0.092, 12, 16, 3.0);
  addSphere(verts, idxs, -1.40, TOP_Y + 0.02, -0.02, 0.064, 10, 14, 3.0);
  addSphere(verts, idxs,  1.40, TOP_Y + 0.02, -0.02, 0.064, 10, 14, 3.0);
  for (let i = 0; i < 7; i++) {
    const rx = -BANNER_W * 0.45 + (i / 6) * BANNER_W * 0.90;
    addCylinder(verts, idxs, rx - 0.018, TOP_Y + 0.02, -0.02, rx + 0.018, TOP_Y + 0.02, -0.02, 0.056, 0.056, 12, 3.0);
  }

  return { vertices: new Float32Array(verts), indices: new Uint16Array(idxs) };
}

export function buildUnitSphereMesh() {
  const verts = [], idxs = [];
  addSphere(verts, idxs, 0, 0, 0, 1.0, 22, 30, 4.0); // mat 4 = forged bronze-banded iron cannonball
  return { vertices: new Float32Array(verts), indices: new Uint16Array(idxs) };
}

// ----------------------------------------------------------------------------
// 3. Deterministic Iron-and-Brass Cannonball Trajectory (Step 7 wrap & Step 8 rip!)
// ----------------------------------------------------------------------------
export function getSphereState(ballT, mode) {
  if (ballT < 0.0) return { active: false, pos: [0, 1.38, -3.2], vel: [0, 0, 0] };
  if (mode === "wrap") {
    // Step 7: Smooth pendulum push from behind deep into the banner -> wraps cleanly with radial folds!
    const dur = 4.6;
    if (ballT > dur) return { active: false, pos: [0, 1.38, -3.2], vel: [0, 0, 0] };
    const p = ballT / dur;
    const z = -1.55 + 2.35 * Math.sin(p * Math.PI);
    const x = 0.22 * Math.sin(p * Math.PI * 2.0);
    const y = 1.40 + 0.14 * Math.cos(p * Math.PI * 2.0);
    return { active: true, pos: [x, y, z], vel: [0, 0, 0] };
  }
  // Step 8: High-energy cannonball shot cleanly through the banner -> splits it into two flapping halves!
  const dur = 2.8;
  if (ballT > dur) return { active: false, pos: [0, 1.35, 5.0], vel: [0, 0, 0] };
  const z = -1.95 + ballT * 2.75;
  const x = 0.14;
  const y = 1.48 - 0.09 * ballT * ballT;
  return { active: true, pos: [x, y, z], vel: [0, -0.18 * ballT, 2.75] };
}

// ----------------------------------------------------------------------------
// 4. Real-Time Verlet / XPBD Cloth Physics + Aerodynamics + Live Tearing
// ----------------------------------------------------------------------------
export function createClothSim() {
  const dx = BANNER_W / COLS;
  const dy = BANNER_H / ROWS;
  const dDiag = Math.hypot(dx, dy);

  const pos = new Float32Array(VERTS * 3);
  const prev = new Float32Array(VERTS * 3);
  const vel = new Float32Array(VERTS * 3);
  const invMass = new Float32Array(VERTS);
  const pinned = new Uint8Array(VERTS);
  const normals = new Float32Array(VERTS * 3);
  const strain = new Float32Array(VERTS);
  const cellAlive = new Uint8Array(CELLS);

  // Interleaved GPU vertex buffer: [px, py, pz, nx, ny, nz, u, v, strain] = 9 floats
  const gpuVerts = new Float32Array(VERTS * 9);
  const gpuIndices = new Uint16Array(CELLS * 6);
  let activeIndexCount = CELLS * 6;

  // Constraint lists: each constraint links particle a, b, rest length, and owning cells for tearing!
  // Type: 0 = structural H/V, 1 = shear diagonal, 2 = 2-hop bending
  const cA = [], cB = [], cRest = [], cType = [], cCell1 = [], cCell2 = [];
  const addConstraint = (a, b, rest, type, cell1, cell2) => {
    cA.push(a); cB.push(b); cRest.push(rest); cType.push(type); cCell1.push(cell1); cCell2.push(cell2);
  };

  for (let y = 0; y < NY; y++) {
    for (let x = 0; x < NX; x++) {
      const i = y * NX + x;
      // Horizontal structural edge (x -> x+1)
      if (x < COLS) {
        const cTop = y > 0 ? (y - 1) * COLS + x : -1;
        const cBot = y < ROWS ? y * COLS + x : -1;
        addConstraint(i, i + 1, dx, 0, cTop, cBot);
      }
      // Vertical structural edge (y -> y+1)
      if (y < ROWS) {
        const cL = x > 0 ? y * COLS + (x - 1) : -1;
        const cR = x < COLS ? y * COLS + x : -1;
        addConstraint(i, i + NX, dy, 0, cL, cR);
      }
      // Shear diagonals inside cell (x, y)
      if (x < COLS && y < ROWS) {
        const cid = y * COLS + x;
        addConstraint(i, i + NX + 1, dDiag, 1, cid, -1);
        addConstraint(i + 1, i + NX, dDiag, 1, cid, -1);
      }
      // 2-hop bending constraints (smooth, heavy medieval folds!)
      if (x + 2 < NX) {
        const c1 = y < ROWS ? y * COLS + x : -1;
        const c2 = y < ROWS ? y * COLS + (x + 1) : -1;
        addConstraint(i, i + 2, dx * 2, 2, c1, c2);
      }
      if (y + 2 < NY) {
        const c1 = x < COLS ? y * COLS + x : -1;
        const c2 = x < COLS ? (y + 1) * COLS + x : -1;
        addConstraint(i, i + NX * 2, dy * 2, 2, c1, c2);
      }
    }
  }

  const numC = cA.length;
  const cArrA = new Int32Array(cA);
  const cArrB = new Int32Array(cB);
  const cArrRest = new Float32Array(cRest);
  const cArrType = new Uint8Array(cType);
  const cArrCell1 = new Int32Array(cCell1);
  const cArrCell2 = new Int32Array(cCell2);
  const cBroken = new Uint8Array(numC);

  // Loose shredded thread particles spawned whenever a cell rips in Step 8!
  const threadPos = new Float32Array(MAX_THREADS * 3);
  const threadVel = new Float32Array(MAX_THREADS * 3);
  const threadLife = new Float32Array(MAX_THREADS);
  const threadCol = new Float32Array(MAX_THREADS * 3);
  let threadCursor = 0;

  let seed = 1337;
  function rand() {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  }

  function spawnThread(px, py, pz, vx, vy, vz, isGold) {
    const k = threadCursor % MAX_THREADS;
    threadCursor++;
    threadPos[k * 3] = px; threadPos[k * 3 + 1] = py; threadPos[k * 3 + 2] = pz;
    threadVel[k * 3] = vx + (rand() - 0.5) * 1.4;
    threadVel[k * 3 + 1] = vy + (rand() - 0.3) * 1.2;
    threadVel[k * 3 + 2] = vz + 0.6 + rand() * 1.6;
    threadLife[k] = 1.0;
    threadCol[k * 3] = isGold ? 0.96 : 0.78;
    threadCol[k * 3 + 1] = isGold ? 0.74 : 0.12;
    threadCol[k * 3 + 2] = isGold ? 0.22 : 0.16;
  }

  function rebuildIndices() {
    let ptr = 0;
    for (let y = 0; y < ROWS; y++) {
      for (let x = 0; x < COLS; x++) {
        if (!cellAlive[y * COLS + x]) continue;
        const a = y * NX + x;
        const b = a + 1;
        const c = a + NX;
        const d = c + 1;
        gpuIndices[ptr++] = a; gpuIndices[ptr++] = c; gpuIndices[ptr++] = b;
        gpuIndices[ptr++] = b; gpuIndices[ptr++] = c; gpuIndices[ptr++] = d;
      }
    }
    activeIndexCount = ptr;
  }

  function killCell(cid, impulseZ = 0.0) {
    if (cid < 0 || cid >= CELLS || !cellAlive[cid]) return;
    cellAlive[cid] = 0;
    const cx = cid % COLS;
    const cy = (cid / COLS) | 0;
    const i = cy * NX + cx;
    const u = cx / COLS, v = cy / ROWS;
    const isGold = u < 0.12 || u > 0.88 || v < 0.10 || v > 0.88 || (Math.abs(u - 0.5) + Math.abs(v - 0.45) < 0.24);
    spawnThread(pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2], vel[i * 3] * 0.4, vel[i * 3 + 1] * 0.4, vel[i * 3 + 2] * 0.5 + impulseZ, isGold);
  }

  function syncBrokenConstraintsToCells() {
    let changed = false;
    for (let k = 0; k < numC; k++) {
      if (cBroken[k]) continue;
      const c1 = cArrCell1[k], c2 = cArrCell2[k];
      // If all owning cells of this constraint are dead (or either owning cell for structural/bending), break it!
      if ((c1 >= 0 && !cellAlive[c1]) || (c2 >= 0 && !cellAlive[c2])) {
        cBroken[k] = 1;
        changed = true;
      }
    }
    if (changed) rebuildIndices();
  }

  function reset() {
    seed = 20261120;
    cellAlive.fill(1);
    cBroken.fill(0);
    strain.fill(0);
    threadLife.fill(0);
    for (let y = 0; y < NY; y++) {
      const v = y / ROWS;
      for (let x = 0; x < NX; x++) {
        const u = x / COLS;
        const i = y * NX + x;
        // Gather horizontal pins 10% inward so the velvet banner naturally drapes into rich sculptural folds!
        const gather = 0.90 + 0.10 * v;
        const px = (u - 0.5) * BANNER_W * gather;
        const py = TOP_Y - v * BANNER_H;
        const pz = Math.sin(u * Math.PI * 6.0) * 0.085 * (0.35 + 0.65 * v);
        pos[i * 3] = px; pos[i * 3 + 1] = py; pos[i * 3 + 2] = pz;
        prev[i * 3] = px; prev[i * 3 + 1] = py; prev[i * 3 + 2] = pz;
        vel[i * 3] = 0; vel[i * 3 + 1] = 0; vel[i * 3 + 2] = 0;

        // Pin 7 brass hanging rings along the top crossbar!
        const isPin = y === 0 && (x === 0 || x === COLS || x % 6 === 0);
        pinned[i] = isPin ? 1 : 0;
        invMass[i] = isPin ? 0.0 : 1.0;

        gpuVerts[i * 9 + 6] = u;
        gpuVerts[i * 9 + 7] = v;
      }
    }
    rebuildIndices();
  }

  function ripAtUV(u, v, radiusCells = 2.6) {
    const tx = u * COLS;
    const ty = v * ROWS;
    let ripped = false;
    for (let y = 1; y < ROWS; y++) {
      for (let x = 0; x < COLS; x++) {
        // Vertical jagged tear bias so ripped cloth splits into dramatic flapping halves!
        const d = Math.hypot((x + 0.5 - tx) * 1.45, (y + 0.5 - ty) * 0.62);
        if (d < radiusCells) {
          const cid = y * COLS + x;
          if (cellAlive[cid]) {
            killCell(cid, 1.4);
            ripped = true;
          }
        }
      }
    }
    if (ripped) {
      syncBrokenConstraintsToCells();
      rebuildIndices();
    }
    return ripped;
  }

  function applyGustAtUV(u, v, strength = 7.5) {
    const tx = u * NX, ty = v * NY;
    for (let y = 1; y < NY; y++) {
      for (let x = 0; x < NX; x++) {
        const i = y * NX + x;
        if (pinned[i]) continue;
        const d2 = (x - tx) * (x - tx) + (y - ty) * (y - ty);
        const w = Math.exp(-d2 / 28.0);
        if (w > 0.02) {
          prev[i * 3 + 2] -= strength * w * 0.016;
          prev[i * 3 + 0] -= (x - tx) * 0.06 * w * 0.016;
        }
      }
    }
  }

  // Analytical geometry modes for Steps 1, 2, 3 (no physics yet!).
  function fillAnalytic(mode, time) {
    cellAlive.fill(1);
    rebuildIndices();
    for (let y = 0; y < NY; y++) {
      const v = y / ROWS;
      for (let x = 0; x < NX; x++) {
        const u = x / COLS;
        const i = y * NX + x;
        let px = (u - 0.5) * BANNER_W;
        let py = TOP_Y - v * BANNER_H;
        let pz = 0.0;
        if (mode === "rigid1996") {
          // Step 2 (1996): Stiff wooden board swinging on a top hinge!
          const ang = 0.24 * Math.sin(time * 2.15) + 0.14;
          const dist = v * BANNER_H;
          py = TOP_Y - dist * Math.cos(ang);
          pz = dist * Math.sin(ang);
        } else if (mode === "sine2000") {
          // Step 3 (2000): Classic travelling sine wave vertex shader (rubbery, no gravity!).
          const w1 = Math.sin(u * 5.2 - time * 3.8 + v * 2.1) * 0.24;
          const w2 = Math.cos(v * 6.5 - time * 4.6) * 0.10;
          pz = (w1 + w2) * Math.pow(v, 0.85) + 0.14 * v;
        }
        pos[i * 3] = px; pos[i * 3 + 1] = py; pos[i * 3 + 2] = pz;
        strain[i] = 0.0;
      }
    }
    computeNormalsAndPack();
  }

  // Real physical Verlet / XPBD step!
  // qualityMode: "verlet2004" | "bend2009" | "xpbd2020" | "aero2026"
  function stepPhysics(dt, time, qualityMode, sphere, enableTearing) {
    const isVerlet04 = qualityMode === "verlet2004";
    const isAero = qualityMode === "aero2026";
    const substeps = isVerlet04 ? 2 : (qualityMode === "bend2009" ? 3 : 4);
    const iters = isVerlet04 ? 2 : (qualityMode === "bend2009" ? 5 : 6);
    const subDt = dt / substeps;
    const dt2 = subDt * subDt;
    const damp = isVerlet04 ? 0.992 : 0.994;

    // Lively swirling battlement wind field that billows the banner into deep dynamic folds!
    const gust = 0.85 + 0.55 * Math.sin(time * 1.55) + 0.30 * Math.sin(time * 3.2 + 0.9);
    const windBaseX = 2.65 * Math.sin(time * 0.95) + 1.35;
    const windBaseY = 0.45 * Math.cos(time * 1.8);
    const windBaseZ = 6.2 * gust;

    let rippedAny = false;

    for (let s = 0; s < substeps; s++) {
      // 1. Velocity integration + external forces (with stability clamp so torn edges never spike!)
      const maxDisp = 0.085;
      for (let i = 0; i < VERTS; i++) {
        if (pinned[i]) continue;
        const o = i * 3;
        let vx = (pos[o] - prev[o]) * damp;
        let vy = (pos[o + 1] - prev[o + 1]) * damp;
        let vz = (pos[o + 2] - prev[o + 2]) * damp;
        const spd = Math.hypot(vx, vy, vz);
        if (spd > maxDisp) {
          const k = maxDisp / spd;
          vx *= k; vy *= k; vz *= k;
        }
        prev[o] = pos[o]; prev[o + 1] = pos[o + 1]; prev[o + 2] = pos[o + 2];
        vel[o] = vx / subDt; vel[o + 1] = vy / subDt; vel[o + 2] = vz / subDt;

        // Simple wind force for Steps 4-7; Step 8 adds true per-triangle aerodynamic drag + lift below!
        let fx = 0.0, fy = -9.4, fz = 0.0;
        if (!isAero) {
          const px = pos[o], py = pos[o + 1];
          const turb = Math.sin(px * 3.2 - time * 3.8 + py * 1.6);
          fx = windBaseX * 0.65 + turb * 2.4;
          fz = windBaseZ * (0.62 + 0.48 * turb);
        }
        pos[o] += vx + fx * dt2;
        pos[o + 1] += vy + fy * dt2;
        pos[o + 2] += vz + fz * dt2;
      }

      // 2. Step 8: True per-triangle aerodynamic DRAG + LIFT from relative velocity & face normal!
      if (isAero) {
        for (let y = 0; y < ROWS; y++) {
          for (let x = 0; x < COLS; x++) {
            const cid = y * COLS + x;
            if (!cellAlive[cid]) continue;
            const i0 = y * NX + x;
            const i1 = i0 + 1;
            const i2 = i0 + NX;
            const i3 = i2 + 1;
            const tris = [[i0, i2, i1], [i1, i2, i3]];
            for (let t = 0; t < 2; t++) {
              const a = tris[t][0] * 3, b = tris[t][1] * 3, c = tris[t][2] * 3;
              const e1x = pos[b] - pos[a], e1y = pos[b + 1] - pos[a + 1], e1z = pos[b + 2] - pos[a + 2];
              const e2x = pos[c] - pos[a], e2y = pos[c + 1] - pos[a + 1], e2z = pos[c + 2] - pos[a + 2];
              const nx = e1y * e2z - e1z * e2y;
              const ny = e1z * e2x - e1x * e2z;
              const nz = e1x * e2y - e1y * e2x;
              const area2 = Math.hypot(nx, ny, nz);
              if (area2 < 1e-6) continue;
              const inx = nx / area2, iny = ny / area2, inz = nz / area2;

              const cx = (pos[a] + pos[b] + pos[c]) / 3;
              const cy = (pos[a + 1] + pos[b + 1] + pos[c + 1]) / 3;
              const swirl = Math.sin(cx * 3.4 - time * 4.5 + cy * 2.1);
              const rvx = (windBaseX * 1.15 + swirl * 3.2) - (vel[a] + vel[b] + vel[c]) / 3;
              const rvy = (windBaseY + Math.cos(cx * 2.8 + time * 3.4) * 1.1) - (vel[a + 1] + vel[b + 1] + vel[c + 1]) / 3;
              const rvz = (windBaseZ * 1.35 + swirl * 2.9) - (vel[a + 2] + vel[b + 2] + vel[c + 2]) / 3;
              const vDotN = rvx * inx + rvy * iny + rvz * inz;
              // Aerodynamic normal pressure (drag + lift) scaled by triangle area!
              const aero = vDotN * area2 * 28.0 * dt2;
              const dfx = inx * aero + rvx * area2 * 2.2 * dt2;
              const dfy = iny * aero + rvy * area2 * 2.2 * dt2;
              const dfz = inz * aero + rvz * area2 * 2.2 * dt2;
              for (let m = 0; m < 3; m++) {
                const idx = tris[t][m];
                if (!pinned[idx]) {
                  pos[idx * 3] += dfx;
                  pos[idx * 3 + 1] += dfy;
                  pos[idx * 3 + 2] += dfz;
                }
              }
            }
          }
        }
      }

      // 3. Constraint projection (XPBD distance + shear + optional bending + live tearing!)
      const useBend = !isVerlet04;
      const structStiff = isVerlet04 ? 0.42 : 0.96;
      const shearStiff = isVerlet04 ? 0.28 : 0.78;
      const bendStiff = 0.24;

      for (let it = 0; it < iters; it++) {
        for (let k = 0; k < numC; k++) {
          if (cBroken[k]) continue;
          const type = cArrType[k];
          if (type === 2 && !useBend) continue;
          const ia = cArrA[k], ib = cArrB[k];
          const wA = invMass[ia], wB = invMass[ib];
          const wSum = wA + wB;
          if (wSum === 0.0) continue;

          const oa = ia * 3, ob = ib * 3;
          const rx = pos[ob] - pos[oa], ry = pos[ob + 1] - pos[oa + 1], rz = pos[ob + 2] - pos[oa + 2];
          const d = Math.hypot(rx, ry, rz);
          if (d < 1e-6) continue;
          const rest = cArrRest[k];

          // Live tearing check on Step 8 when structural stretch exceeds tear threshold (keep top rings anchored!).
          if (enableTearing && type === 0 && it === 0 && ia >= NX * 3 && ib >= NX * 3 && d > rest * 1.48) {
            cBroken[k] = 1;
            killCell(cArrCell1[k], 1.2);
            killCell(cArrCell2[k], 1.2);
            rippedAny = true;
            continue;
          }

          const stiff = type === 0 ? structStiff : (type === 1 ? shearStiff : bendStiff);
          const corr = ((d - rest) / d) * (stiff / wSum);
          if (wA > 0) {
            pos[oa] += rx * corr * wA;
            pos[oa + 1] += ry * corr * wA;
            pos[oa + 2] += rz * corr * wA;
          }
          if (wB > 0) {
            pos[ob] -= rx * corr * wB;
            pos[ob + 1] -= ry * corr * wB;
            pos[ob + 2] -= rz * corr * wB;
          }
        }

        // 4. Hard sphere + ground collision (Steps 7 & 8!)
        if (sphere && sphere.active) {
          const sx = sphere.pos[0], sy = sphere.pos[1], sz = sphere.pos[2];
          const rPad = SPHERE_R + 0.032;
          const rPad2 = rPad * rPad;
          for (let i = 0; i < VERTS; i++) {
            if (pinned[i]) continue;
            const o = i * 3;
            const ddx = pos[o] - sx, ddy = pos[o + 1] - sy, ddz = pos[o + 2] - sz;
            const d2 = ddx * ddx + ddy * ddy + ddz * ddz;
            if (d2 < rPad2 && d2 > 1e-8) {
              // On Step 8 cannonball impact (once per substep), split the banner down the warp seam into two flapping halves!
              if (enableTearing && it === 0 && sphere.vel[2] > 1.0 && Math.abs(ddx) < 0.24 && ddz > -0.22) {
                const gx = i % NX, gy = (i / NX) | 0;
                if (gy >= 5 && gy < ROWS && gx >= 5 && gx < COLS - 5) {
                  killCell(gy * COLS + gx, sphere.vel[2] * 0.72);
                  // Propagate jagged warp tear downward to the bottom hem so both halves split wide open!
                  for (let ry = gy; ry < ROWS; ry++) {
                    const jitter = ((ry * 7 + gx) % 3) - 1;
                    const rx = clamp(gx + (ry > gy + 2 ? jitter : 0), 3, COLS - 4);
                    killCell(ry * COLS + rx, sphere.vel[2] * 0.45);
                  }
                  rippedAny = true;
                  continue;
                }
              }
              const d = Math.sqrt(d2);
              const nx = ddx / d, ny = ddy / d, nz = ddz / d;
              pos[o] = sx + nx * rPad;
              pos[o + 1] = sy + ny * rPad;
              pos[o + 2] = sz + nz * rPad;
              // Surface friction damping so cloth drapes smoothly over brass!
              prev[o] = prev[o] * 0.78 + pos[o] * 0.22;
              prev[o + 1] = prev[o + 1] * 0.78 + pos[o + 1] * 0.22;
              prev[o + 2] = prev[o + 2] * 0.78 + pos[o + 2] * 0.22;
            }
          }
        }

        // Keep banner above the stone dais floor y = 0.025
        for (let i = 0; i < VERTS; i++) {
          if (pos[i * 3 + 1] < 0.03) pos[i * 3 + 1] = 0.03;
        }
      }
    }

    // Cull any over-stretched cell on tearing edges so no stray stretched triangle can ever appear!
    if (enableTearing) {
      const maxEdge = Math.max(dx, dy) * 2.2;
      const maxEdge2 = maxEdge * maxEdge;
      for (let y = 0; y < ROWS; y++) {
        for (let x = 0; x < COLS; x++) {
          const cid = y * COLS + x;
          if (!cellAlive[cid]) continue;
          const a = (y * NX + x) * 3, b = a + 3, c = a + NX * 3, d = c + 3;
          const e1 = (pos[b] - pos[a]) ** 2 + (pos[b + 1] - pos[a + 1]) ** 2 + (pos[b + 2] - pos[a + 2]) ** 2;
          const e2 = (pos[c] - pos[a]) ** 2 + (pos[c + 1] - pos[a + 1]) ** 2 + (pos[c + 2] - pos[a + 2]) ** 2;
          const e3 = (pos[d] - pos[b]) ** 2 + (pos[d + 1] - pos[b + 1]) ** 2 + (pos[d + 2] - pos[b + 2]) ** 2;
          const e4 = (pos[d] - pos[c]) ** 2 + (pos[d + 1] - pos[c + 1]) ** 2 + (pos[d + 2] - pos[c + 2]) ** 2;
          if (e1 > maxEdge2 || e2 > maxEdge2 || e3 > maxEdge2 || e4 > maxEdge2) {
            killCell(cid, 0.8);
            rippedAny = true;
          }
        }
      }
    }

    if (rippedAny) {
      syncBrokenConstraintsToCells();
      rebuildIndices();
    }

    // Update loose thread particles
    for (let k = 0; k < MAX_THREADS; k++) {
      if (threadLife[k] <= 0) continue;
      threadLife[k] -= dt * 0.65;
      threadVel[k * 3] += (windBaseX * 0.6 - threadVel[k * 3] * 1.4) * dt;
      threadVel[k * 3 + 1] += (-3.4 - threadVel[k * 3 + 1] * 0.8) * dt;
      threadVel[k * 3 + 2] += (windBaseZ * 0.7 - threadVel[k * 3 + 2] * 1.4) * dt;
      threadPos[k * 3] += threadVel[k * 3] * dt;
      threadPos[k * 3 + 1] = Math.max(0.03, threadPos[k * 3 + 1] + threadVel[k * 3 + 1] * dt);
      threadPos[k * 3 + 2] += threadVel[k * 3 + 2] * dt;
    }

    // Compute per-vertex stretch strain (highlights tension lines around the sphere & torn edges!)
    strain.fill(0);
    for (let k = 0; k < numC; k++) {
      if (cBroken[k] || cArrType[k] !== 0) continue;
      const a = cArrA[k], b = cArrB[k];
      const d = Math.hypot(pos[b * 3] - pos[a * 3], pos[b * 3 + 1] - pos[a * 3 + 1], pos[b * 3 + 2] - pos[a * 3 + 2]);
      const st = clamp((d / cArrRest[k] - 1.0) * 6.0, 0.0, 1.0);
      if (st > strain[a]) strain[a] = st;
      if (st > strain[b]) strain[b] = st;
    }

    computeNormalsAndPack();
  }

  function computeNormalsAndPack() {
    normals.fill(0);
    for (let y = 0; y < ROWS; y++) {
      for (let x = 0; x < COLS; x++) {
        if (!cellAlive[y * COLS + x]) continue;
        const a = y * NX + x, b = a + 1, c = a + NX, d = c + 1;
        const tris = [[a, c, b], [b, c, d]];
        for (let t = 0; t < 2; t++) {
          const i0 = tris[t][0] * 3, i1 = tris[t][1] * 3, i2 = tris[t][2] * 3;
          const e1x = pos[i1] - pos[i0], e1y = pos[i1 + 1] - pos[i0 + 1], e1z = pos[i1 + 2] - pos[i0 + 2];
          const e2x = pos[i2] - pos[i0], e2y = pos[i2 + 1] - pos[i0 + 1], e2z = pos[i2 + 2] - pos[i0 + 2];
          const nx = e1y * e2z - e1z * e2y;
          const ny = e1z * e2x - e1x * e2z;
          const nz = e1x * e2y - e1y * e2x;
          for (let m = 0; m < 3; m++) {
            const k = tris[t][m] * 3;
            normals[k] += nx; normals[k + 1] += ny; normals[k + 2] += nz;
          }
        }
      }
    }

    for (let i = 0; i < VERTS; i++) {
      const o = i * 3, g = i * 9;
      let nx = normals[o], ny = normals[o + 1], nz = normals[o + 2];
      const l = Math.hypot(nx, ny, nz) || 1;
      nx /= l; ny /= l; nz /= l;
      gpuVerts[g + 0] = pos[o];
      gpuVerts[g + 1] = pos[o + 1];
      gpuVerts[g + 2] = pos[o + 2];
      gpuVerts[g + 3] = nx;
      gpuVerts[g + 4] = ny;
      gpuVerts[g + 5] = nz;
      gpuVerts[g + 8] = strain[i];
    }
  }

  // Raycast click against cloth triangles -> returns nearest { u, v } or null.
  function raycastUV(ro, rd) {
    let bestT = 1e9, bestU = -1, bestV = -1;
    for (let y = 0; y < ROWS; y++) {
      for (let x = 0; x < COLS; x++) {
        if (!cellAlive[y * COLS + x]) continue;
        const i = y * NX + x;
        const px = pos[i * 3], py = pos[i * 3 + 1], pz = pos[i * 3 + 2];
        const ocx = px - ro[0], ocy = py - ro[1], ocz = pz - ro[2];
        const t = ocx * rd[0] + ocy * rd[1] + ocz * rd[2];
        if (t <= 0.1 || t >= bestT) continue;
        const dx2 = ocx - rd[0] * t, dy2 = ocy - rd[1] * t, dz2 = ocz - rd[2] * t;
        if (dx2 * dx2 + dy2 * dy2 + dz2 * dz2 < 0.018) {
          bestT = t;
          bestU = (x + 0.5) / COLS;
          bestV = (y + 0.5) / ROWS;
        }
      }
    }
    return bestU >= 0 ? { u: bestU, v: bestV } : null;
  }

  reset();

  return {
    gpuVerts,
    gpuIndices,
    get activeIndexCount() { return activeIndexCount; },
    threadPos,
    threadLife,
    threadCol,
    reset,
    fillAnalytic,
    stepPhysics,
    ripAtUV,
    applyGustAtUV,
    raycastUV,
  };
}
