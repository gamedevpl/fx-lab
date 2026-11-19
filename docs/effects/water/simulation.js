// CPU data generators and 128x128 zero-mean viscous shallow-water PDE solver
// for Evolution of Water.

import { clamp, lerp, smoothstep, hexToRgb01 } from "../../src/gl-utils.js";

// 1985 16-color ocean palette.
export const CLUT_16_HEX = [
  "#061224", "#092042", "#0d3163", "#124685", "#175ea6",
  "#1d7ac4", "#2798db", "#43b8ed", "#7ad8fa", "#cbf2ff",
  "#ffffff", "#94e2fc", "#4ec0eb", "#2389cc", "#145896", "#0c3061",
];
export const CLUT_16_F32 = new Float32Array(16 * 3);
CLUT_16_HEX.forEach((hex, i) => {
  const [r, g, b] = hexToRgb01(hex);
  CLUT_16_F32[i * 3 + 0] = r;
  CLUT_16_F32[i * 3 + 1] = g;
  CLUT_16_F32[i * 3 + 2] = b;
});

export const PAL_N = 80;
export const TILE_N = 64;
export const GW = 128, GH = 128;
export const POOL_HALF = 1.52;

// Cistern obstacles & impact coordinates shared with shaders.js.
export const PILLAR_X = 0.62, PILLAR_Z = -0.18, PILLAR_R = 0.19;
export const IMPACT_X = -0.38, IMPACT_Z = 0.18, IMPACT_T = 0.30;
export const DROP_COUNT = 24;

function hashJs(n) {
  const x = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
}

// Deterministic metadata for the 24 ballistic splash droplets (largest hero drops spawn secondary rings).
export const DROP_META = [];
for (let i = 0; i < DROP_COUNT; i++) {
  const isJet = i >= 18;
  const ang = (i / (isJet ? 6 : 18)) * Math.PI * 2.0 + (hashJs(i * 3.1) - 0.5) * 0.42;
  const r0 = isJet ? (0.02 + hashJs(i * 5.7) * 0.04) : (0.16 + hashJs(i * 5.7) * 0.09);
  const spd = isJet ? (0.16 + hashJs(i * 7.3) * 0.38) : (0.55 + hashJs(i * 7.3) * 0.68);
  const vUp = isJet ? (2.10 + hashJs(i * 11.9) * 1.10) : (1.85 + hashJs(i * 11.9) * 1.45);
  const tDelay = isJet ? (0.48 + hashJs(i * 13.7) * 0.24) : (0.02 + hashJs(i * 13.7) * 0.14);
  const rad = isJet ? (0.016 + hashJs(i * 17.1) * 0.018) : (0.013 + Math.pow(hashJs(i * 17.1), 1.4) * 0.021);
  const flightT = (2.0 * vUp) / 6.2;
  DROP_META.push({
    landT: IMPACT_T + tDelay + flightT,
    landX: IMPACT_X + Math.cos(ang) * (r0 + spd * flightT),
    landZ: IMPACT_Z + Math.sin(ang) * (r0 + spd * flightT),
    isHero: rad > 0.0285,
  });
}

// Static 80x80 wave index grid for the 1985 palette-cycling stage.
export function buildClutIndexBuffer() {
  const bytes = new Uint8Array(PAL_N * PAL_N);
  for (let y = 0; y < PAL_N; y++) {
    const nz = (y / (PAL_N - 1)) * 2.0 - 1.0;
    for (let x = 0; x < PAL_N; x++) {
      const nx = (x / (PAL_N - 1)) * 2.0 - 1.0;
      const r = Math.hypot(nx, nz);
      const waveA = nx * 8.5 + nz * 5.2 + Math.sin(nz * 6.5) * 1.15 + Math.cos(nx * 5.5) * 0.85;
      const waveB = r * 10.5 - Math.atan2(nz, nx) * 0.4;
      bytes[y * PAL_N + x] = 1 + (((Math.floor((waveA * 0.65 + waveB * 0.55) * 1.45) % 15) + 15) % 15);
    }
  }
  return bytes;
}

// Seamless 64x64 Voronoi ridge/wave tile for the 1994 dual scrolling UV stage.
export function buildRippleTile() {
  const bytes = new Uint8Array(TILE_N * TILE_N * 4);
  const pts = [
    [0.14, 0.18], [0.48, 0.12], [0.82, 0.22], [0.27, 0.46],
    [0.64, 0.42], [0.91, 0.56], [0.12, 0.78], [0.46, 0.74],
    [0.78, 0.84], [0.35, 0.92], [0.68, 0.06], [0.05, 0.52],
  ];
  for (let y = 0; y < TILE_N; y++) {
    const v = y / TILE_N;
    for (let x = 0; x < TILE_N; x++) {
      const u = x / TILE_N;
      let d1 = 9.0, d2 = 9.0;
      for (const [px, py] of pts) {
        let dx = Math.abs(u - px); if (dx > 0.5) dx = 1.0 - dx;
        let dy = Math.abs(v - py); if (dy > 0.5) dy = 1.0 - dy;
        const d = Math.hypot(dx, dy);
        if (d < d1) { d2 = d1; d1 = d; }
        else if (d < d2) { d2 = d; }
      }
      const ridge = clamp(1.0 - (d2 - d1) * 9.5, 0, 1);
      const cell = clamp(1.0 - d1 * 3.4, 0, 1);
      const wv = 0.5 + 0.5 * Math.sin((u * 2.0 + v) * Math.PI * 2.0) * Math.cos((v * 2.0 - u) * Math.PI * 2.0);
      const o = (y * TILE_N + x) * 4;
      bytes[o + 0] = Math.round(clamp(ridge * 0.85 + wv * 0.25, 0, 1) * 255);
      bytes[o + 1] = Math.round(clamp(cell * 0.7 + wv * 0.3, 0, 1) * 255);
      bytes[o + 2] = Math.round((0.5 + 0.45 * Math.sin(u * Math.PI * 4.0 + v * Math.PI * 2.0)) * 255);
      bytes[o + 3] = 255;
    }
  }
  return bytes;
}

// Plunge -> full submersion -> buoyant bobbing -> gentle drift -> quiet sink trajectory.
export function getColliderPos(lt) {
  if (lt < 0.0) return [IMPACT_X, -1.3, IMPACT_Z];
  if (lt < 0.30) {
    const p = lt / 0.30;
    return [IMPACT_X, lerp(1.95, 0.16, p * p), IMPACT_Z];
  }
  if (lt < 0.78) {
    const p = (lt - 0.30) / (0.78 - 0.30);
    return [
      IMPACT_X + 0.03 * p,
      lerp(0.16, -0.34, 1.0 - Math.pow(1.0 - p, 2.2)),
      IMPACT_Z - 0.02 * p,
    ];
  }
  if (lt < 3.90) {
    const dt = lt - 0.78;
    const bob = -0.32 * Math.exp(-dt * 1.65) * Math.cos(dt * 4.2);
    const driftP = smoothstep(0.65, 3.1, dt);
    return [
      IMPACT_X + 0.03 + 0.20 * Math.sin(driftP * Math.PI * 0.85),
      -0.02 + bob,
      IMPACT_Z - 0.02 + 0.24 * driftP,
    ];
  }
  if (lt < 4.90) {
    const p = smoothstep(3.90, 4.90, lt);
    return [
      IMPACT_X + 0.03 + 0.20 * Math.sin(Math.PI * 0.85),
      lerp(-0.02, -0.92, p * p),
      IMPACT_Z + 0.22,
    ];
  }
  return [IMPACT_X + 0.12, -1.25, IMPACT_Z + 0.22];
}

// Live 128x128 zero-mean Kelvin-Voigt viscous shallow-water wave solver.
export function createShallowWaterSim() {
  const N = GW * GH;
  let hPrev = new Float32Array(N);
  let hCurr = new Float32Array(N);
  let hNext = new Float32Array(N);
  const foam = new Float32Array(N);
  const solid = new Uint8Array(N);
  const rimSponge = new Float32Array(N);
  const texBuf = new Uint8Array(N * 4);
  let activeCells = 0;

  // Build circular stone cistern mask + soft energy-absorbing rim band.
  for (let j = 0; j < GH; j++) {
    const wz = ((j / (GH - 1)) * 2.0 - 1.0) * POOL_HALF;
    for (let i = 0; i < GW; i++) {
      const wx = ((i / (GW - 1)) * 2.0 - 1.0) * POOL_HALF;
      const rPool = Math.hypot(wx, wz);
      const rPil = Math.hypot(wx - PILLAR_X, wz - PILLAR_Z);
      if (rPool >= 1.435 || rPil <= PILLAR_R) {
        solid[j * GW + i] = 1;
      } else {
        activeCells++;
        rimSponge[j * GW + i] = smoothstep(1.22, 1.435, rPool) * 0.028;
      }
    }
  }

  // Strictly zero-sum concentric ring impulse (displaces center down and outer crest up equally).
  function injectZeroSumRing(wx0, wz0, rad, amp, foamAmp) {
    let wPos = 0, wNeg = 0;
    const tmpIdx = [];
    const tmpVal = [];
    for (let j = 1; j < GH - 1; j++) {
      const wz = ((j / (GH - 1)) * 2.0 - 1.0) * POOL_HALF;
      const dz = wz - wz0;
      if (Math.abs(dz) > rad * 2.6) continue;
      for (let i = 1; i < GW - 1; i++) {
        const idx = j * GW + i;
        if (solid[idx]) continue;
        const wx = ((i / (GW - 1)) * 2.0 - 1.0) * POOL_HALF;
        const d = Math.hypot(wx - wx0, dz);
        if (d < rad * 2.5) {
          const rn = d / rad;
          const v = (rn * rn * 1.15 - 1.0) * Math.exp(-rn * rn * 1.15);
          tmpIdx.push(idx);
          tmpVal.push(v);
          if (v > 0) wPos += v; else wNeg -= v;
          if (foamAmp > 0) {
            foam[idx] = Math.min(1.0, foam[idx] + foamAmp * Math.exp(-rn * rn * 1.8));
          }
        }
      }
    }
    const posScale = wPos > 1e-6 ? wNeg / wPos : 1.0;
    for (let k = 0; k < tmpIdx.length; k++) {
      const v = tmpVal[k];
      hCurr[tmpIdx[k]] += amp * (v > 0 ? v * posScale : v);
    }
  }

  // Single 120 Hz viscous wave substep with strict zero-mean projection.
  function stepSubstep() {
    const c2 = 0.135;
    const baseDamp = 0.0095;
    const visc = 0.018;
    let sumH = 0.0;

    for (let j = 1; j < GH - 1; j++) {
      for (let i = 1; i < GW - 1; i++) {
        const idx = j * GW + i;
        if (solid[idx]) {
          hNext[idx] = 0;
          foam[idx] = 0;
          continue;
        }
        const hc = hCurr[idx], hp = hPrev[idx];
        const lapC = (solid[idx - 1] ? hc : hCurr[idx - 1])
                   + (solid[idx + 1] ? hc : hCurr[idx + 1])
                   + (solid[idx - GW] ? hc : hCurr[idx - GW])
                   + (solid[idx + GW] ? hc : hCurr[idx + GW])
                   - 4.0 * hc;
        const lapP = (solid[idx - 1] ? hp : hPrev[idx - 1])
                   + (solid[idx + 1] ? hp : hPrev[idx + 1])
                   + (solid[idx - GW] ? hp : hPrev[idx - GW])
                   + (solid[idx + GW] ? hp : hPrev[idx + GW])
                   - 4.0 * hp;

        const dTotal = baseDamp + rimSponge[idx];
        const val = clamp(
          (2.0 - dTotal) * hc - (1.0 - dTotal) * hp + c2 * lapC + visc * (lapC - lapP),
          -0.14,
          0.14,
        );
        hNext[idx] = val;
        sumH += val;
        foam[idx] *= 0.978;
      }
    }

    // Subtract mean height so the whole pool level never drifts up or down.
    const meanH = sumH / Math.max(1, activeCells);
    for (let i = 0; i < N; i++) {
      if (!solid[i]) hNext[i] -= meanH;
    }

    const tmp = hPrev;
    hPrev = hCurr;
    hCurr = hNext;
    hNext = tmp;
  }

  // Packs height (R), gradient (G, B) and localized splash foam (A) into RGBA8.
  function packTexture() {
    for (let j = 0; j < GH; j++) {
      for (let i = 0; i < GW; i++) {
        const idx = j * GW + i;
        const h = hCurr[idx];
        const iL = Math.max(0, i - 1), iR = Math.min(GW - 1, i + 1);
        const jD = Math.max(0, j - 1), jU = Math.min(GH - 1, j + 1);
        const gx = (solid[j * GW + iR] ? h : hCurr[j * GW + iR]) - (solid[j * GW + iL] ? h : hCurr[j * GW + iL]);
        const gz = (solid[jU * GW + i] ? h : hCurr[jU * GW + i]) - (solid[jD * GW + i] ? h : hCurr[jD * GW + i]);
        texBuf[idx * 4 + 0] = clamp(Math.round(((h / 0.14) * 0.5 + 0.5) * 255), 0, 255);
        texBuf[idx * 4 + 1] = clamp(Math.round(((gx / 0.08) * 0.5 + 0.5) * 255), 0, 255);
        texBuf[idx * 4 + 2] = clamp(Math.round(((gz / 0.08) * 0.5 + 0.5) * 255), 0, 255);
        texBuf[idx * 4 + 3] = clamp(Math.round(clamp(foam[idx], 0, 1) * 255), 0, 255);
      }
    }
    return texBuf;
  }

  packTexture();
  return { injectZeroSumRing, stepSubstep, packTexture, texBuf };
}
