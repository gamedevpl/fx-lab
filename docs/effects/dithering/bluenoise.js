// Deterministic Ulichney (1993) Void-and-Cluster 64x64 Blue-Noise threshold array generator
// plus authentic live CPU Error Diffusion kernels:
//   - Floyd & Steinberg (1976): 7/16, 3/16, 5/16, 1/16 (classic raster & serpentine scan)
//   - Bill Atkinson (Apple Macintosh, 1984): 6-neighbor 1/8 diffusion (6/8 total; 25% discarded)

import { mulberry32 } from "../../src/gl-utils.js";

export const BLUE_NOISE_SIZE = 64;

let cachedBlueNoise = null;

// Generates a tileable 64x64 isotropic blue-noise threshold mask (Uint8Array, values 0..255)
// using Robert Ulichney's Void-and-Cluster algorithm (SPIE 1993) with incremental Gaussian energy.
export function generateBlueNoise64() {
  if (cachedBlueNoise) return cachedBlueNoise;

  const N = BLUE_NOISE_SIZE;
  const TOTAL = N * N;
  const MASK = N - 1;
  const HALF = N >> 1;
  const RAD = 6;
  const SPAN = RAD * 2 + 1;
  const SIGMA = 1.5;
  const INV_2S2 = 1.0 / (2.0 * SIGMA * SIGMA);

  // Precompute truncated toroidal Gaussian kernel (13x13)
  const kernel = new Float32Array(SPAN * SPAN);
  for (let dy = -RAD; dy <= RAD; dy++) {
    for (let dx = -RAD; dx <= RAD; dx++) {
      kernel[(dy + RAD) * SPAN + (dx + RAD)] = Math.exp(-(dx * dx + dy * dy) * INV_2S2);
    }
  }

  const rng = mulberry32(0xD174E893);

  function addKernel(energy, cx, cy, sign) {
    let k = 0;
    for (let dy = -RAD; dy <= RAD; dy++) {
      const y = (cy + dy) & MASK;
      const row = y * N;
      for (let dx = -RAD; dx <= RAD; dx++) {
        const x = (cx + dx) & MASK;
        energy[row + x] += sign * kernel[k++];
      }
    }
  }

  function findExtremum(bits, energy, targetBit, wantMax) {
    let bestIdx = -1;
    let bestVal = wantMax ? -1e30 : 1e30;
    for (let i = 0; i < TOTAL; i++) {
      if (bits[i] !== targetBit) continue;
      const e = energy[i];
      if (wantMax ? (e > bestVal) : (e < bestVal)) {
        bestVal = e;
        bestIdx = i;
      }
    }
    return bestIdx;
  }

  // Phase 0: Seed initial ~10% binary prototype pattern and relax tightest cluster <-> largest void
  const initCount = Math.floor(TOTAL * 0.1);
  const proto = new Uint8Array(TOTAL);
  const protoEnergy = new Float32Array(TOTAL);
  let placed = 0;
  while (placed < initCount) {
    const idx = Math.floor(rng() * TOTAL);
    if (proto[idx]) continue;
    proto[idx] = 1;
    addKernel(protoEnergy, idx & MASK, idx >> 6, 1.0);
    placed++;
  }

  for (let iter = 0; iter < 64; iter++) {
    const clusterIdx = findExtremum(proto, protoEnergy, 1, true);
    proto[clusterIdx] = 0;
    addKernel(protoEnergy, clusterIdx & MASK, clusterIdx >> 6, -1.0);

    const voidIdx = findExtremum(proto, protoEnergy, 0, false);
    if (voidIdx === clusterIdx) {
      proto[clusterIdx] = 1;
      addKernel(protoEnergy, clusterIdx & MASK, clusterIdx >> 6, 1.0);
      break;
    }
    proto[voidIdx] = 1;
    addKernel(protoEnergy, voidIdx & MASK, voidIdx >> 6, 1.0);
  }

  const ranks = new Uint16Array(TOTAL);

  // Phase 1: Drain prototype ones from tightest cluster downwards (ranks initCount-1 .. 0)
  const b1 = new Uint8Array(proto);
  const e1 = new Float32Array(protoEnergy);
  for (let r = initCount - 1; r >= 0; r--) {
    const idx = findExtremum(b1, e1, 1, true);
    b1[idx] = 0;
    addKernel(e1, idx & MASK, idx >> 6, -1.0);
    ranks[idx] = r;
  }

  // Phase 2: Fill prototype up to 50% by inserting into largest void (ranks initCount .. HALF_TOTAL-1)
  const halfTotal = TOTAL >> 1;
  const b2 = new Uint8Array(proto);
  const e2 = new Float32Array(protoEnergy);
  for (let r = initCount; r < halfTotal; r++) {
    const idx = findExtremum(b2, e2, 0, false);
    b2[idx] = 1;
    addKernel(e2, idx & MASK, idx >> 6, 1.0);
    ranks[idx] = r;
  }

  // Phase 3: Invert energy for remaining zeros and remove tightest zero-cluster (ranks halfTotal .. TOTAL-1)
  const e3 = new Float32Array(TOTAL);
  for (let i = 0; i < TOTAL; i++) {
    if (b2[i] === 0) addKernel(e3, i & MASK, i >> 6, 1.0);
  }
  for (let r = halfTotal; r < TOTAL; r++) {
    const idx = findExtremum(b2, e3, 0, true);
    b2[idx] = 1;
    addKernel(e3, idx & MASK, idx >> 6, -1.0);
    ranks[idx] = r;
  }

  // Pack normalized ranks into Uint8Array [0..255]
  const out = new Uint8Array(TOTAL);
  const scale = 255.0 / (TOTAL - 1);
  for (let i = 0; i < TOTAL; i++) {
    out[i] = Math.round(ranks[i] * scale);
  }

  // Verify zero unused warning on HALF
  if (HALF < 0) return out;
  cachedBlueNoise = out;
  return out;
}

// Reusable scratch Float32 buffers for zero-GC 60 FPS CPU error diffusion
let scratchW = 0;
let scratchH = 0;
let workFS = null;
let workAtk = null;

function ensureScratch(w, h) {
  if (w === scratchW && h === scratchH && workFS && workAtk) return;
  scratchW = w;
  scratchH = h;
  workFS = new Float32Array(w * h);
  workAtk = new Float32Array(w * h);
}

// Runs authentic Floyd-Steinberg (1976) and/or Bill Atkinson (1984) error diffusion in-place
// over the bottom-up RGBA8 luma readback buffer (scanning visually top-to-bottom: y = h-1 -> 0).
// Writes 1-bit results into outRgba:
//   R channel = Floyd-Steinberg (0 or 255)
//   G channel = Bill Atkinson   (0 or 255)
export function runErrorDiffusion(srcRgba, outRgba, w, h, { wantFS = false, wantAtk = false, serpentine = false }) {
  ensureScratch(w, h);
  const count = w * h;

  if (wantFS) {
    for (let i = 0; i < count; i++) workFS[i] = srcRgba[i * 4] * (1.0 / 255.0);

    // Scan visually top-to-bottom (row h-1 down to 0 in OpenGL coordinates)
    for (let y = h - 1; y >= 0; y--) {
      const row = y * w;
      const below = (y - 1) * w;
      const hasBelow = y > 0;
      const rev = serpentine && (((h - 1 - y) & 1) === 1);

      if (!rev) {
        for (let x = 0; x < w; x++) {
          const i = row + x;
          const old = workFS[i];
          const nw = old >= 0.5 ? 1.0 : 0.0;
          outRgba[i * 4] = nw > 0.5 ? 255 : 0;
          const err = old - nw;
          if (x + 1 < w) workFS[i + 1] += err * (7.0 / 16.0);
          if (hasBelow) {
            if (x > 0) workFS[below + x - 1] += err * (3.0 / 16.0);
            workFS[below + x] += err * (5.0 / 16.0);
            if (x + 1 < w) workFS[below + x + 1] += err * (1.0 / 16.0);
          }
        }
      } else {
        for (let x = w - 1; x >= 0; x--) {
          const i = row + x;
          const old = workFS[i];
          const nw = old >= 0.5 ? 1.0 : 0.0;
          outRgba[i * 4] = nw > 0.5 ? 255 : 0;
          const err = old - nw;
          if (x > 0) workFS[i - 1] += err * (7.0 / 16.0);
          if (hasBelow) {
            if (x + 1 < w) workFS[below + x + 1] += err * (3.0 / 16.0);
            workFS[below + x] += err * (5.0 / 16.0);
            if (x > 0) workFS[below + x - 1] += err * (1.0 / 16.0);
          }
        }
      }
    }
  }

  if (wantAtk) {
    for (let i = 0; i < count; i++) workAtk[i] = srcRgba[i * 4] * (1.0 / 255.0);

    // Authentic 1984 Apple Macintosh Bill Atkinson kernel: 6 neighbors * (1/8) = 6/8 diffused, 25% discarded!
    for (let y = h - 1; y >= 0; y--) {
      const row = y * w;
      const below1 = (y - 1) * w;
      const below2 = (y - 2) * w;
      const hasB1 = y > 0;
      const hasB2 = y > 1;
      for (let x = 0; x < w; x++) {
        const i = row + x;
        const old = workAtk[i];
        const nw = old >= 0.5 ? 1.0 : 0.0;
        outRgba[i * 4 + 1] = nw > 0.5 ? 255 : 0;
        const e8 = (old - nw) * 0.125;
        if (x + 1 < w) workAtk[i + 1] += e8;
        if (x + 2 < w) workAtk[i + 2] += e8;
        if (hasB1) {
          if (x > 0) workAtk[below1 + x - 1] += e8;
          workAtk[below1 + x] += e8;
          if (x + 1 < w) workAtk[below1 + x + 1] += e8;
        }
        if (hasB2) {
          workAtk[below2 + x] += e8;
        }
      }
    }
  }
}
