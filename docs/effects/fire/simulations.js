// CPU data generators and fluid solvers for Evolution of Fire:
// 1985 CLUT, live PSX Doom cellular automaton, 8-frame sprite sheet,
// and a real-time 24x36x24 3D Navier-Stokes + vorticity confinement solver.

import { clamp, lerp, smoothstep, hexToRgb01, mulberry32 } from "../../src/gl-utils.js";

// 1985 16-color fire CLUT (index 0 = transparent background).
export const CLUT_16_HEX = [
  "#000000", "#2b0506", "#540a08", "#82140a", "#b3240b",
  "#db3d0c", "#f25c10", "#ff8017", "#ffa624", "#ffc938",
  "#ffe65e", "#fff69e", "#ffe052", "#f58316", "#c9340b", "#691008",
];
export const CLUT_16_F32 = new Float32Array(16 * 3);
CLUT_16_HEX.forEach((hex, i) => {
  const [r, g, b] = hexToRgb01(hex);
  CLUT_16_F32[i * 3 + 0] = r;
  CLUT_16_F32[i * 3 + 1] = g;
  CLUT_16_F32[i * 3 + 2] = b;
});

// Classic 37-color PSX Doom fire palette.
export const DOOM_PALETTE_HEX = [
  "#070707", "#1f0707", "#2f0f07", "#470f07", "#571707", "#671f07", "#771f07", "#8f2707",
  "#9f2f07", "#af3f07", "#bf4707", "#c74707", "#df4f07", "#df5707", "#df5707", "#d75f07",
  "#d75f07", "#d7670f", "#cf6f0f", "#cf770f", "#cf7f0f", "#cf8717", "#c78717", "#c78f17",
  "#c7971f", "#bf9f1f", "#bf9f1f", "#bfa727", "#bfa727", "#bfaf2f", "#b7af2f", "#b7b72f",
  "#b7b737", "#cfcf6f", "#dfdf9f", "#efefc7", "#ffffff",
];
export const DOOM_PAL_F32 = new Float32Array(37 * 3);
DOOM_PALETTE_HEX.forEach((hex, i) => {
  const [r, g, b] = hexToRgb01(hex);
  DOOM_PAL_F32[i * 3 + 0] = r;
  DOOM_PAL_F32[i * 3 + 1] = g;
  DOOM_PAL_F32[i * 3 + 2] = b;
});

export const PAL_W = 64, PAL_H = 80;
export const DOOM_W = 96, DOOM_H = 112;
export const SPR_W = 64, SPR_H = 80, SPR_N = 8;

// 3D Eulerian fluid domain bounds & dimensions.
export const NX = 24, NY = 36, NZ = 24, NV = NX * NY * NZ;
export const VOL_MIN = [-1.15, 0.08, -1.15];
export const VOL_MAX = [ 1.15, 2.48,  1.15];
export const COLLIDER_RADIUS = 0.28;

// 6-Way directional flipbook atlas layout (4x4 = 16 optical-flow frames, baked lazily on Step 5).
export const FLIP_COLS = 4, FLIP_ROWS = 4, FLIP_N = 16;
export const FLIP_CW = 28, FLIP_CH = 36;
export const FLIP_W = FLIP_COLS * FLIP_CW;
export const FLIP_H = FLIP_ROWS * FLIP_CH;

// Static 64x80 flame silhouette index buffer — pixels never move, only the CLUT rotates.
export function buildClutIndexBuffer() {
  const bytes = new Uint8Array(PAL_W * PAL_H);
  for (let y = 0; y < PAL_H; y++) {
    const ny = y / (PAL_H - 1);
    for (let x = 0; x < PAL_W; x++) {
      const nx = (x / (PAL_W - 1)) * 2.0 - 1.0;
      const sway1 = 0.16 * Math.sin(ny * 8.5);
      const sway2 = 0.11 * Math.cos(ny * 12.0 + 1.0);

      const dMain = Math.abs(nx - sway1 * ny) / Math.max(0.02, 0.56 * Math.pow(Math.max(0.0, 1.0 - ny), 0.78));
      const dLeft = Math.abs(nx + 0.30 - sway2 * ny) / Math.max(0.02, 0.28 * Math.pow(Math.max(0.0, 1.0 - ny * 1.45), 0.72));
      const dRight = Math.abs(nx - 0.30 + sway2 * ny) / Math.max(0.02, 0.26 * Math.pow(Math.max(0.0, 1.0 - ny * 1.55), 0.72));
      const d = Math.min(dMain, dLeft, dRight);

      const shape = (1.0 - d) * smoothstep(0.02, 0.10, ny) * smoothstep(0.92, 0.72, ny);
      if (shape > 0.10) {
        const wave = ny * 22.0 - d * 5.0 + Math.sin(nx * 7.5 + ny * 9.0) * 1.3;
        const band = ((Math.floor(wave) % 15) + 15) % 15;
        const env = clamp(Math.round(clamp(shape, 0, 1) * 15), 1, 15);
        bytes[y * PAL_W + x] = (env << 4) | (band + 1);
      }
    }
  }
  return bytes;
}

// Genuine PSX Doom 2D cellular automaton (`spreadFire` algorithm).
export function createDoomFire() {
  const rand = mulberry32(19951116);
  const buffer = new Uint8Array(DOOM_W * DOOM_H);
  let warmed = false;

  function step() {
    for (let x = 0; x < DOOM_W; x++) {
      const r = Math.abs((x / (DOOM_W - 1)) * 2.0 - 1.0);
      if (r < 0.56) {
        const edgeCool = r > 0.38 ? Math.floor(((r - 0.38) / 0.18) * 14) : 0;
        buffer[x] = clamp(36 - edgeCool - Math.floor(rand() * 3), 0, 36);
        buffer[DOOM_W + x] = clamp(36 - edgeCool - Math.floor(rand() * 4), 0, 36);
      } else {
        buffer[x] = 0;
        buffer[DOOM_W + x] = 0;
      }
    }
    for (let y = 1; y < DOOM_H; y++) {
      for (let x = 0; x < DOOM_W; x++) {
        const srcVal = buffer[(y - 1) * DOOM_W + x];
        if (srcVal === 0) {
          buffer[y * DOOM_W + x] = 0;
          continue;
        }
        const r = Math.floor(rand() * 4);
        const nx = (x / (DOOM_W - 1)) * 2.0 - 1.0;
        const inward = (nx > 0.22 ? -1 : (nx < -0.22 ? 1 : 0)) * (rand() < 0.28 ? 1 : 0);
        const dstX = clamp(x + (r - 1) + inward, 0, DOOM_W - 1);
        const decay = (r & 1) * (rand() < 0.62 ? 1 : 0) + (rand() < 0.16 ? 1 : 0) + (Math.abs(nx) > 0.44 ? 1 : 0);
        buffer[y * DOOM_W + dstX] = Math.max(0, srcVal - decay);
      }
    }
  }

  function ensureWarmed() {
    if (warmed) return;
    warmed = true;
    for (let i = 0; i < 90; i++) step();
  }

  return { buffer, step, ensureWarmed };
}

// Procedural 8-frame pixel fire sprite sheet for the 1998 additive billboard stage.
export function buildSpriteAtlas() {
  const bytes = new Uint8Array(SPR_W * SPR_N * SPR_H * 4);
  const cols = [
    [1.00, 0.94, 0.56],
    [0.98, 0.54, 0.08],
    [0.82, 0.18, 0.04],
  ];
  for (let f = 0; f < SPR_N; f++) {
    const ph = (f / SPR_N) * Math.PI * 2.0;
    for (let y = 0; y < SPR_H; y++) {
      const ny = y / (SPR_H - 1);
      for (let x = 0; x < SPR_W; x++) {
        const nx = (x / (SPR_W - 1)) * 2.0 - 1.0;
        const w0 = Math.sin(ny * 7.0 - ph) * 0.15 * ny;
        const w1 = Math.sin(ny * 10.0 - ph * 2.0 + 1.2) * 0.10 * ny;
        const dMain = Math.abs(nx - w0) / Math.max(0.04, 0.52 * Math.pow(Math.max(0, 1.0 - ny * 1.05), 0.68));
        const dLeft = Math.hypot((nx + 0.34 - w1) * 2.2, (ny - 0.28) * 2.3);
        const dRight = Math.hypot((nx - 0.33 + w1) * 2.3, (ny - 0.25) * 2.4);
        const val = (1.0 - Math.min(dMain, dLeft * 1.15, dRight * 1.15)) * smoothstep(0.0, 0.10, ny);

        let r = 0, g = 0, b = 0, a = 0;
        if (val > 0.58) { [r, g, b] = cols[0]; a = 0.95; }
        else if (val > 0.30) { [r, g, b] = cols[1]; a = 0.90; }
        else if (val > 0.08) { [r, g, b] = cols[2]; a = 0.80; }

        for (let s = 0; s < 3; s++) {
          const su = ((f / SPR_N) + s * 0.33) % 1.0;
          if (Math.hypot(nx - Math.sin(s * 2.7 + su * 5.0) * 0.36, ny - (0.24 + su * 0.66)) < 0.045) {
            r = 1.0; g = 0.82; b = 0.24; a = 0.95;
          }
        }
        const idx = (y * (SPR_W * SPR_N) + (f * SPR_W + x)) * 4;
        bytes[idx + 0] = Math.round(r * 255);
        bytes[idx + 1] = Math.round(g * 255);
        bytes[idx + 2] = Math.round(b * 255);
        bytes[idx + 3] = Math.round(a * 255);
      }
    }
  }
  return bytes;
}

// Trajectory of the brushed-iron collider sphere sweeping through the live flames.
export function getColliderPos(sweepT) {
  if (sweepT < 0.0 || sweepT > 3.15) return [9.0, 1.05, 0.0];
  const u = smoothstep(0.0, 3.10, sweepT);
  return [
    lerp(-1.72, 1.72, u),
    0.96 + 0.18 * Math.sin(u * Math.PI),
    0.16 * Math.sin(u * Math.PI * 2.0),
  ];
}

// Real-time 24x36x24 Eulerian Navier-Stokes + vorticity confinement solver.
export function createFluidSolver3D() {
  let u = new Float32Array(NV), v = new Float32Array(NV), w = new Float32Array(NV);
  let u2 = new Float32Array(NV), v2 = new Float32Array(NV), w2 = new Float32Array(NV);
  let temp = new Float32Array(NV), temp2 = new Float32Array(NV);
  let smoke = new Float32Array(NV), smoke2 = new Float32Array(NV);
  let fuel = new Float32Array(NV), fuel2 = new Float32Array(NV);
  const div = new Float32Array(NV);
  let prs = new Float32Array(NV), prs2 = new Float32Array(NV);
  const ox = new Float32Array(NV), oy = new Float32Array(NV), oz = new Float32Array(NV), omag = new Float32Array(NV);
  const solid = new Uint8Array(NV);
  const texBuf = new Uint8Array(NV * 4);

  const rand = mulberry32(20261119);
  const dt = 1.0 / 30.0;
  const sXY = NX * NY;
  let stepCount = 0;
  let prevColPos = [9.0, 1.05, 0.0];

  const IX = (x, y, z) => (z * NY + y) * NX + x;

  function sampleTri(arr, x, y, z) {
    const cx = clamp(x, 0.5, NX - 1.501);
    const cy = clamp(y, 0.5, NY - 1.501);
    const cz = clamp(z, 0.5, NZ - 1.501);
    const x0 = cx | 0, y0 = cy | 0, z0 = cz | 0;
    const fx = cx - x0, fy = cy - y0, fz = cz - z0;
    const i000 = IX(x0, y0, z0);
    const c00 = arr[i000] + (arr[i000 + 1] - arr[i000]) * fx;
    const c10 = arr[i000 + NX] + (arr[i000 + NX + 1] - arr[i000 + NX]) * fx;
    const c01 = arr[i000 + sXY] + (arr[i000 + sXY + 1] - arr[i000 + sXY]) * fx;
    const c11 = arr[i000 + sXY + NX] + (arr[i000 + sXY + NX + 1] - arr[i000 + sXY + NX]) * fx;
    return (c00 + (c10 - c00) * fy) * (1 - fz) + (c01 + (c11 - c01) * fy) * fz;
  }

  function step(colPos) {
    const validPrev = Math.abs(colPos[0] - prevColPos[0]) < 1.5;
    const colVx = validPrev ? (colPos[0] - prevColPos[0]) / dt : 0;
    const colVy = validPrev ? (colPos[1] - prevColPos[1]) / dt : 0;
    const colVz = validPrev ? (colPos[2] - prevColPos[2]) / dt : 0;
    prevColPos = colPos.slice();

    const sx = (VOL_MAX[0] - VOL_MIN[0]) / NX;
    const sy = (VOL_MAX[1] - VOL_MIN[1]) / NY;
    const sz = (VOL_MAX[2] - VOL_MIN[2]) / NZ;
    const swirlPh = (stepCount++) * 0.30;

    // 1. Solid collider boundary, burner fuel injection, combustion and thermal buoyancy.
    solid.fill(0);
    for (let z = 1; z < NZ - 1; z++) {
      const wz = VOL_MIN[2] + (z + 0.5) * sz;
      for (let y = 1; y < NY - 1; y++) {
        const wy = VOL_MIN[1] + (y + 0.5) * sy;
        for (let x = 1; x < NX - 1; x++) {
          const wx = VOL_MIN[0] + (x + 0.5) * sx;
          const i = IX(x, y, z);

          const dxC = wx - colPos[0], dyC = wy - colPos[1], dzC = wz - colPos[2];
          const dC2 = dxC * dxC + dyC * dyC + dzC * dzC;
          if (dC2 < (COLLIDER_RADIUS * 1.15) * (COLLIDER_RADIUS * 1.15)) {
            solid[i] = 1;
            const dC = Math.sqrt(dC2);
            const invD = 1.0 / (dC > 0.05 ? dC : 0.05);
            u[i] = colVx * 3.4 + dxC * invD * 2.6;
            v[i] = colVy * 3.4 + dyC * invD * 2.6;
            w[i] = colVz * 3.4 + dzC * invD * 2.6;
            fuel[i] *= 0.15;
            temp[i] *= 0.25;
            smoke[i] *= 0.35;
            continue;
          }

          if (wy < 0.50) {
            const rad2 = wx * wx + wz * wz;
            if (rad2 < 0.44 * 0.44) {
              const rad = Math.sqrt(rad2);
              const mask = (1.0 - rad / 0.44) * (1.0 - (wy - 0.08) / 0.44);
              const turb = 0.65 + 0.65 * Math.sin(wx * 8.0 + swirlPh) * Math.cos(wz * 8.0 - swirlPh * 1.3) + (rand() - 0.5) * 0.55;
              fuel[i] = Math.min(1.6, fuel[i] + mask * 1.65 * Math.max(0.15, turb));
              temp[i] = Math.min(2.1, temp[i] + mask * 1.60 * Math.max(0.25, turb));
              v[i] += mask * 4.5;
              u[i] += (Math.cos(swirlPh * 1.2 + wz * 4.5) * 1.3 + (rand() - 0.5) * 1.8) * mask;
              w[i] += (Math.sin(swirlPh * 0.9 + wx * 4.5) * 1.3 + (rand() - 0.5) * 1.8) * mask;
            }
          }

          if (fuel[i] > 0.02) {
            const burn = Math.min(fuel[i], 0.58 * dt * (0.6 + temp[i]));
            fuel[i] -= burn;
            temp[i] = Math.min(2.3, temp[i] + burn * 2.8);
            smoke[i] = Math.min(1.8, smoke[i] + burn * 2.25);
          }

          v[i] += (temp[i] * 7.2 - smoke[i] * 0.45) * dt;
          u[i] += 0.35 * Math.sin(swirlPh * 0.45 + wy * 1.5) * dt;
        }
      }
    }

    // 2. Vorticity confinement (re-injects small swirling curls damped by coarse grids).
    for (let z = 1; z < NZ - 1; z++) {
      for (let y = 1; y < NY - 1; y++) {
        for (let x = 1; x < NX - 1; x++) {
          const i = IX(x, y, z);
          const cx = (w[i + NX] - w[i - NX]) * 0.5 - (v[i + sXY] - v[i - sXY]) * 0.5;
          const cy = (u[i + sXY] - u[i - sXY]) * 0.5 - (w[i + 1] - w[i - 1]) * 0.5;
          const cz = (v[i + 1] - v[i - 1]) * 0.5 - (u[i + NX] - u[i - NX]) * 0.5;
          ox[i] = cx; oy[i] = cy; oz[i] = cz;
          omag[i] = Math.sqrt(cx * cx + cy * cy + cz * cz);
        }
      }
    }
    const vortEps = 3.1 * dt;
    for (let z = 2; z < NZ - 2; z++) {
      for (let y = 2; y < NY - 2; y++) {
        for (let x = 2; x < NX - 2; x++) {
          const i = IX(x, y, z);
          if (solid[i]) continue;
          const gx = (omag[i + 1] - omag[i - 1]) * 0.5;
          const gy = (omag[i + NX] - omag[i - NX]) * 0.5;
          const gz = (omag[i + sXY] - omag[i - sXY]) * 0.5;
          const gl = Math.sqrt(gx * gx + gy * gy + gz * gz) + 1e-5;
          u[i] += ((gy / gl) * oz[i] - (gz / gl) * oy[i]) * vortEps;
          v[i] += ((gz / gl) * ox[i] - (gx / gl) * oz[i]) * vortEps;
          w[i] += ((gx / gl) * oy[i] - (gy / gl) * ox[i]) * vortEps;
        }
      }
    }

    // 3. Divergence-free Jacobi pressure projection.
    div.fill(0);
    prs.fill(0);
    for (let z = 1; z < NZ - 1; z++) {
      for (let y = 1; y < NY - 1; y++) {
        for (let x = 1; x < NX - 1; x++) {
          const i = IX(x, y, z);
          if (!solid[i]) {
            div[i] = -0.5 * ((u[i + 1] - u[i - 1]) + (v[i + NX] - v[i - NX]) + (w[i + sXY] - w[i - sXY]));
          }
        }
      }
    }
    for (let it = 0; it < 6; it++) {
      for (let z = 1; z < NZ - 1; z++) {
        for (let y = 1; y < NY - 1; y++) {
          for (let x = 1; x < NX - 1; x++) {
            const i = IX(x, y, z);
            prs2[i] = solid[i]
              ? 0
              : (div[i] + prs[i - 1] + prs[i + 1] + prs[i - NX] + prs[i + NX] + prs[i - sXY] + prs[i + sXY]) / 6.0;
          }
        }
      }
      const tmp = prs; prs = prs2; prs2 = tmp;
    }
    for (let z = 1; z < NZ - 1; z++) {
      for (let y = 1; y < NY - 1; y++) {
        for (let x = 1; x < NX - 1; x++) {
          const i = IX(x, y, z);
          if (solid[i]) continue;
          u[i] -= 0.5 * (prs[i + 1] - prs[i - 1]);
          v[i] -= 0.5 * (prs[i + NX] - prs[i - NX]);
          w[i] -= 0.5 * (prs[i + sXY] - prs[i - sXY]);
        }
      }
    }

    // 4. Semi-Lagrangian advection (shared trilinear weights for all 6 fields) + radiative cooling.
    const advScale = dt * 6.4;
    const maxX = NX - 1.501, maxY = NY - 1.501, maxZ = NZ - 1.501;
    for (let z = 1; z < NZ - 1; z++) {
      for (let y = 1; y < NY - 1; y++) {
        const yCool = (y / NY) * 2.2;
        const topFade = y > NY - 6 ? 0.80 : 0.978;
        for (let x = 1; x < NX - 1; x++) {
          const i = IX(x, y, z);
          if (solid[i]) {
            u2[i] = u[i]; v2[i] = v[i]; w2[i] = w[i];
            temp2[i] = 0; smoke2[i] = 0; fuel2[i] = 0;
            continue;
          }
          let bx = x - u[i] * advScale; if (bx < 0.5) bx = 0.5; else if (bx > maxX) bx = maxX;
          let by = y - v[i] * advScale; if (by < 0.5) by = 0.5; else if (by > maxY) by = maxY;
          let bz = z - w[i] * advScale; if (bz < 0.5) bz = 0.5; else if (bz > maxZ) bz = maxZ;

          const x0 = bx | 0, y0 = by | 0, z0 = bz | 0;
          const fx = bx - x0, fy = by - y0, fz = bz - z0;
          const fx1 = 1 - fx, fy1 = 1 - fy, fz1 = 1 - fz;
          const w000 = fx1 * fy1 * fz1, w100 = fx * fy1 * fz1;
          const w010 = fx1 * fy * fz1,  w110 = fx * fy * fz1;
          const w001 = fx1 * fy1 * fz,  w101 = fx * fy1 * fz;
          const w011 = fx1 * fy * fz,   w111 = fx * fy * fz;
          const i000 = (z0 * NY + y0) * NX + x0;
          const i100 = i000 + 1, i010 = i000 + NX, i110 = i010 + 1;
          const i001 = i000 + sXY, i101 = i001 + 1, i011 = i001 + NX, i111 = i011 + 1;

          u2[i] = (u[i000]*w000 + u[i100]*w100 + u[i010]*w010 + u[i110]*w110 + u[i001]*w001 + u[i101]*w101 + u[i011]*w011 + u[i111]*w111) * 0.96;
          v2[i] = (v[i000]*w000 + v[i100]*w100 + v[i010]*w010 + v[i110]*w110 + v[i001]*w001 + v[i101]*w101 + v[i011]*w011 + v[i111]*w111) * 0.96;
          w2[i] = (w[i000]*w000 + w[i100]*w100 + w[i010]*w010 + w[i110]*w110 + w[i001]*w001 + w[i101]*w101 + w[i011]*w011 + w[i111]*w111) * 0.96;
          const tVal = temp[i000]*w000 + temp[i100]*w100 + temp[i010]*w010 + temp[i110]*w110 + temp[i001]*w001 + temp[i101]*w101 + temp[i011]*w011 + temp[i111]*w111;
          const cool = 1.0 - dt * (1.85 + 1.45 * tVal * tVal + yCool);
          temp2[i] = tVal > 0 ? tVal * (cool > 0.18 ? cool : 0.18) : 0;
          smoke2[i] = (smoke[i000]*w000 + smoke[i100]*w100 + smoke[i010]*w010 + smoke[i110]*w110 + smoke[i001]*w001 + smoke[i101]*w101 + smoke[i011]*w011 + smoke[i111]*w111) * topFade;
          fuel2[i] = (fuel[i000]*w000 + fuel[i100]*w100 + fuel[i010]*w010 + fuel[i110]*w110 + fuel[i001]*w001 + fuel[i101]*w101 + fuel[i011]*w011 + fuel[i111]*w111) * 0.90;
        }
      }
    }

    let sw;
    sw = u; u = u2; u2 = sw;
    sw = v; v = v2; v2 = sw;
    sw = w; w = w2; w2 = sw;
    sw = temp; temp = temp2; temp2 = sw;
    sw = smoke; smoke = smoke2; smoke2 = sw;
    sw = fuel; fuel = fuel2; fuel2 = sw;
  }

  function packTexture3D() {
    for (let i = 0; i < NV; i++) {
      texBuf[i * 4 + 0] = Math.round(clamp(temp[i] / 1.85, 0, 1) * 255);
      texBuf[i * 4 + 1] = Math.round(clamp(smoke[i] / 1.15, 0, 1) * 255);
      const spd = Math.sqrt(u[i] * u[i] + v[i] * v[i] + w[i] * w[i]);
      texBuf[i * 4 + 2] = Math.round(clamp(spd / 8.0, 0, 1) * 255);
      texBuf[i * 4 + 3] = 255;
    }
    return texBuf;
  }

  // Lazily bakes 16 directional 6-way lit + optical-flow flipbook frames on demand (Step 5).
  function bakeSixWayFlipbook() {
    const dataA = new Uint8Array(FLIP_W * FLIP_H * 4);
    const dataB = new Uint8Array(FLIP_W * FLIP_H * 4);
    const dataC = new Uint8Array(FLIP_W * FLIP_H * 4);

    for (let f = 0; f < FLIP_N; f++) {
      step([9.0, 1.05, 0.0]);
      const col = f % FLIP_COLS;
      const row = (f / FLIP_COLS) | 0;

      for (let cy = 0; cy < FLIP_CH; cy++) {
        const gy = (cy / (FLIP_CH - 1)) * (NY - 1);
        for (let cx = 0; cx < FLIP_CW; cx++) {
          const gx = (cx / (FLIP_CW - 1)) * (NX - 1);
          let maxTemp = 0, accSmoke = 0, velX = 0, velY = 0, wSum = 0.001;
          let litPX = 0, litNX = 0, litPY = 0, litNY = 0, litPZ = 0, litNZ = 0, coreScat = 0;
          let trans = 1.0;

          for (let zi = 3; zi < NZ - 3; zi += 2) {
            const tS = sampleTri(temp, gx, gy, zi);
            const dS = sampleTri(smoke, gx, gy, zi);
            const dens = dS * 0.38 + tS * 0.14;
            if (dens <= 0.015) continue;

            if (tS > maxTemp) maxTemp = tS;
            const wt = trans * dens;
            velX += sampleTri(u, gx, gy, zi) * wt;
            velY += sampleTri(v, gx, gy, zi) * wt;
            wSum += wt;

            litPX += wt * Math.exp(-(sampleTri(smoke, gx + 2.5, gy, zi) + sampleTri(smoke, gx + 5.0, gy, zi)) * 1.45);
            litNX += wt * Math.exp(-(sampleTri(smoke, gx - 2.5, gy, zi) + sampleTri(smoke, gx - 5.0, gy, zi)) * 1.45);
            litPY += wt * Math.exp(-(sampleTri(smoke, gx, gy + 2.5, zi) + sampleTri(smoke, gx, gy + 5.0, zi)) * 1.45);
            litNY += wt * Math.exp(-(sampleTri(smoke, gx, gy - 2.5, zi) + sampleTri(smoke, gx, gy - 5.0, zi)) * 1.45);
            litPZ += wt * Math.exp(-(sampleTri(smoke, gx, gy, zi + 2.5) + sampleTri(smoke, gx, gy, zi + 5.0)) * 1.45);
            litNZ += wt * Math.exp(-(sampleTri(smoke, gx, gy, zi - 2.5) + sampleTri(smoke, gx, gy, zi - 5.0)) * 1.45);
            coreScat += wt * clamp(sampleTri(temp, gx, Math.max(1, gy - 3.5), zi) * 1.3, 0, 1);

            trans *= Math.exp(-dens * 1.45);
            accSmoke = 1.0 - trans;
          }

          const o = ((row * FLIP_CH + cy) * FLIP_W + (col * FLIP_CW + cx)) * 4;
          const normW = 1.0 / wSum;
          dataA[o + 0] = clamp(Math.round((maxTemp / 1.85) * 255), 0, 255);
          dataA[o + 1] = clamp(Math.round(accSmoke * 255), 0, 255);
          dataA[o + 2] = clamp(Math.round((velX * normW * 0.14 + 0.5) * 255), 0, 255);
          dataA[o + 3] = clamp(Math.round((velY * normW * 0.10 + 0.5) * 255), 0, 255);

          dataB[o + 0] = clamp(Math.round(litPX * normW * 255), 0, 255);
          dataB[o + 1] = clamp(Math.round(litNX * normW * 255), 0, 255);
          dataB[o + 2] = clamp(Math.round(litPY * normW * 255), 0, 255);
          dataB[o + 3] = clamp(Math.round(litNY * normW * 255), 0, 255);

          dataC[o + 0] = clamp(Math.round(litPZ * normW * 255), 0, 255);
          dataC[o + 1] = clamp(Math.round(litNZ * normW * 255), 0, 255);
          dataC[o + 2] = clamp(Math.round(coreScat * normW * 255), 0, 255);
          dataC[o + 3] = 255;
        }
      }
    }
    return { dataA, dataB, dataC };
  }

  // Fast 12-step warmup establishes a full flame plume immediately without stalling startup.
  for (let i = 0; i < 12; i++) step([9.0, 1.05, 0.0]);
  packTexture3D();

  return { step, packTexture3D, bakeSixWayFlipbook, texBuf };
}
