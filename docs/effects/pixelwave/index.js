// Isometric Pixel-Wave Toy (FX Lab #32)
// Rigid 2:1 pixel-art orthographic voxel columns driven by a live 2D heightmap (Diagonal Loop,
// Simplex Drift, Click Ripple), stepped pixel height quantization, 4 biomes, 1 px depth/silhouette
// ink + thick white vinyl sticker outline, and optional live 2D noise inset.

import { FULL_VS, linkPrograms, clamp, lerp } from "../../src/gl-utils.js";
import { COLUMN_VS, COLUMN_FS, COMPOSITE_FS } from "./shaders.js";

export const BIOME_DEFS = [
  { id: "meadow", en: "Meadow",    pl: "Łąka",      dot: "#63c74d" },
  { id: "ocean",  en: "Ocean",     pl: "Ocean",     dot: "#2ed8d8" },
  { id: "magma",  en: "Magma",     pl: "Magma",     dot: "#ff6b1a" },
  { id: "neon",   en: "Neon Grid", pl: "Neon Grid", dot: "#ff38b8" },
];

export const WAVE_MODES = [
  { id: "loop",   en: "Loop",   pl: "Pętla"  },
  { id: "noise",  en: "Noise",  pl: "Szum"   },
  { id: "ripple", en: "Ripple", pl: "Kręgi"  },
];

// Fast deterministic 2D Simplex Noise (Gustavson / Ashima permutation-free hash variant)
const F2 = 0.5 * (Math.sqrt(3.0) - 1.0);
const G2 = (3.0 - Math.sqrt(3.0)) / 6.0;
const GRAD2 = [
  [1, 1], [-1, 1], [1, -1], [-1, -1],
  [1, 0], [-1, 0], [0, 1], [0, -1],
];

function hash2i(i, j) {
  let h = (Math.imul(i, 374761393) + Math.imul(j, 668265263)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) & 7;
}

function simplex2D(xin, yin) {
  const s = (xin + yin) * F2;
  const i = Math.floor(xin + s);
  const j = Math.floor(yin + s);
  const t = (i + j) * G2;
  const x0 = xin - (i - t);
  const y0 = yin - (j - t);
  const i1 = x0 > y0 ? 1 : 0;
  const j1 = x0 > y0 ? 0 : 1;
  const x1 = x0 - i1 + G2;
  const y1 = y0 - j1 + G2;
  const x2 = x0 - 1.0 + 2.0 * G2;
  const y2 = y0 - 1.0 + 2.0 * G2;

  let n0 = 0, n1 = 0, n2 = 0;
  let t0 = 0.5 - x0 * x0 - y0 * y0;
  if (t0 >= 0) {
    t0 *= t0;
    const g = GRAD2[hash2i(i, j)];
    n0 = t0 * t0 * (g[0] * x0 + g[1] * y0);
  }
  let t1 = 0.5 - x1 * x1 - y1 * y1;
  if (t1 >= 0) {
    t1 *= t1;
    const g = GRAD2[hash2i(i + i1, j + j1)];
    n1 = t1 * t1 * (g[0] * x1 + g[1] * y1);
  }
  let t2 = 0.5 - x2 * x2 - y2 * y2;
  if (t2 >= 0) {
    t2 *= t2;
    const g = GRAD2[hash2i(i + 1, j + 1)];
    n2 = t2 * t2 * (g[0] * x2 + g[1] * y2);
  }
  return 70.0 * (n0 + n1 + n2);
}

// 3 visible faces of an orthographic isometric voxel column: Top (+Y), Left Front (+Z), Right Front (+X)
function buildColumnGeometry() {
  // Each vertex: [x, y, z, u, v, face]
  const v = [
    // Face 0: Top (+Y, y = 1)
    0, 1, 0,  0, 0,  0,
    0, 1, 1,  0, 1,  0,
    1, 1, 1,  1, 1,  0,
    0, 1, 0,  0, 0,  0,
    1, 1, 1,  1, 1,  0,
    1, 1, 0,  1, 0,  0,

    // Face 1: Left Front (+Z, z = 1, lit from left)
    0, 0, 1,  0, 1,  1,
    1, 0, 1,  1, 1,  1,
    1, 1, 1,  1, 0,  1,
    0, 0, 1,  0, 1,  1,
    1, 1, 1,  1, 0,  1,
    0, 1, 1,  0, 0,  1,

    // Face 2: Right Front (+X, x = 1, shadowed)
    1, 0, 1,  0, 1,  2,
    1, 0, 0,  1, 1,  2,
    1, 1, 0,  1, 0,  2,
    1, 0, 1,  0, 1,  2,
    1, 1, 0,  1, 0,  2,
    1, 1, 1,  0, 0,  2,
  ];
  return new Float32Array(v);
}

// Evaluates 2D heightmap for all N x N columns on CPU (exact match for GPU texture + click ray-picking!)
export function evaluateHeightfield(outBytes, outFloats, N, time, modeIdx, ripples) {
  const invN = 1.0 / Math.max(1, N - 1);
  // Exact 2.0 second periodic diagonal wave loop (seamless for X/GIF!)
  const loopPhase = (time * 0.5) * Math.PI * 2.0;

  for (let iz = 0; iz < N; iz++) {
    const v = iz * invN;
    for (let ix = 0; ix < N; ix++) {
      const u = ix * invN;
      let h = 0.5;

      if (modeIdx === 0) {
        // Mode 0: Diagonal Loop (exact 2.0 s seamless loop!)
        const diag = u + v;
        const cross = u - v;
        const w1 = Math.sin(diag * Math.PI * 2.0 - loopPhase);
        const w2 = Math.sin(diag * Math.PI * 4.0 - loopPhase * 2.0 + cross * Math.PI * 1.0) * 0.24;
        const w3 = Math.cos(cross * Math.PI * 2.0) * 0.14;
        h = 0.5 + 0.36 * w1 + 0.20 * w2 + 0.10 * w3;
      } else if (modeIdx === 1) {
        // Mode 1: Simplex Drift (slow, organic 2-octave 2D Simplex Noise)
        const sx = u * 2.35 + time * 0.22;
        const sz = v * 2.35 + time * 0.15;
        const n1 = simplex2D(sx, sz);
        const n2 = simplex2D(u * 4.7 - time * 0.18 + 11.3, v * 4.7 + time * 0.24 - 5.1) * 0.34;
        h = 0.5 + (n1 + n2) * 0.40;
      } else {
        // Mode 2: Click Ripple (calm gently breathing plateau + crisp concentric click/drag rings)
        const calm = Math.sin((u + v) * Math.PI * 2.0 - time * 1.1) * 0.045;
        h = 0.38 + calm;
      }

      // Superimpose interactive click/drag ripples in ALL modes!
      for (let r = 0; r < ripples.length; r++) {
        const rp = ripples[r];
        const age = time - rp.t0;
        if (age < 0 || age > 3.6) continue;
        const dx = u - rp.u;
        const dz = v - rp.v;
        const dist = Math.hypot(dx, dz);
        const radius = age * 0.72;
        const band = dist - radius;
        const env = Math.exp(-band * band * 26.0) * Math.exp(-age * 1.05) * rp.amp;
        h += Math.cos(band * 22.0) * env;
      }

      const hc = clamp(h, 0.0, 1.0);
      const idx = iz * N + ix;
      outFloats[idx] = hc;
      const b = Math.round(hc * 255);
      const o = idx * 4;
      outBytes[o]     = b;
      outBytes[o + 1] = b;
      outBytes[o + 2] = b;
      outBytes[o + 3] = 255;
    }
  }
}

// Computes crisp integer virtual-pixel layout for any viewport & grid size
export function computePixelLayout(w, h, gridN, zoomScale = 1.0, isMobilePortrait = false, cleanCenter = false) {
  const baseScale = Math.max(2, Math.round(Math.min(w, h) / 235));
  const pxScale = clamp(Math.round(baseScale * zoomScale), 2, 7);
  const lowW = Math.max(96, Math.floor(w / pxScale));
  const lowH = Math.max(96, Math.floor(h / pxScale));

  // Choose an exact integer tileHalfW so every 2:1 isometric diamond aligns pixel-for-pixel!
  const availW = lowW * (cleanCenter ? 0.78 : (isMobilePortrait ? 0.84 : 0.60));
  const availH = lowH * (cleanCenter ? 0.72 : (isMobilePortrait ? 0.46 : 0.66));
  const maxTwByW = availW / (2.0 * gridN);
  const maxTwByH = (availH * 0.72) / gridN;
  const tileHalfW = Math.max(2, Math.floor(Math.min(maxTwByW, maxTwByH)));

  const flatCellPx = Math.max(2, Math.floor(Math.min(lowW, lowH) * 0.62 / gridN));
  const maxHeightPx = Math.max(10, Math.round(tileHalfW * gridN * 0.25));
  const baseThickPx = Math.max(7, Math.round(tileHalfW * gridN * 0.15));

  // On desktop center cleanly to the right of the left info card; on portrait mobile lift above bottom card
  const offsetX = (cleanCenter || isMobilePortrait) ? 0 : Math.round(lowW * 0.19);
  const offsetY = cleanCenter ? 0 : (isMobilePortrait ? Math.round(lowH * 0.14) : Math.round(lowH * 0.01));

  return { pxScale, lowW, lowH, tileHalfW, flatCellPx, maxHeightPx, baseThickPx, offsetX, offsetY };
}

// Reusable low-level WebGL2 renderer (shared by FX Lab UI + clean Shorts / X loop capture)
export function createPixelwaveRenderer(gl) {
  const [colProg, compProg] = linkPrograms(gl, [
    [COLUMN_VS, COLUMN_FS],
    [FULL_VS, COMPOSITE_FS],
  ]);

  const colVao = gl.createVertexArray();
  gl.bindVertexArray(colVao);
  const colVbo = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, colVbo);
  gl.bufferData(gl.ARRAY_BUFFER, buildColumnGeometry(), gl.STATIC_DRAW);
  const stride = 6 * 4;
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 3, gl.FLOAT, false, stride, 0);
  gl.enableVertexAttribArray(1);
  gl.vertexAttribPointer(1, 2, gl.FLOAT, false, stride, 3 * 4);
  gl.enableVertexAttribArray(2);
  gl.vertexAttribPointer(2, 1, gl.FLOAT, false, stride, 5 * 4);
  gl.bindVertexArray(null);

  const quadVao = gl.createVertexArray();

  // Heightmap texture (updated dynamically whenever N or wave updates)
  const heightTex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, heightTex);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

  // Offscreen low-res MRT framebuffer (colorTex + metaTex + depth renderbuffer, strict NEAREST!)
  const sceneFbo = gl.createFramebuffer();
  const colorTex = gl.createTexture();
  const metaTex  = gl.createTexture();
  const depthRb  = gl.createRenderbuffer();
  let fboW = 0, fboH = 0;

  function ensureFbo(w, h) {
    if (fboW === w && fboH === h) return;
    fboW = w; fboH = h;
    for (const tex of [colorTex, metaTex]) {
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    }
    gl.bindRenderbuffer(gl.RENDERBUFFER, depthRb);
    gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT16, w, h);

    gl.bindFramebuffer(gl.FRAMEBUFFER, sceneFbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, colorTex, 0);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT1, gl.TEXTURE_2D, metaTex, 0);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, depthRb);
    gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1]);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  const uCol = Object.fromEntries(
    ["uHeightTex", "uLowRes", "uCenterOffset", "uGridN", "uTileHalfW", "uFlatCellPx",
     "uMaxHeightPx", "uBaseThickPx", "uStepPx", "uIsoMorph", "uStage", "uBiome", "uTime"]
      .map(n => [n, gl.getUniformLocation(colProg, n)])
  );
  const uComp = Object.fromEntries(
    ["uColorTex", "uMetaTex", "uHeightTex", "uScreenRes", "uLowRes", "uLeftStage",
     "uRightStage", "uBiome", "uSplitX", "uShowNoise", "uGridN", "uInsetRect",
     "uLastRippleUv", "uLastRippleAge"]
      .map(n => [n, gl.getUniformLocation(compProg, n)])
  );

  let lastTexN = 0;

  return {
    uploadHeightfield(bytes, N) {
      gl.bindTexture(gl.TEXTURE_2D, heightTex);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
      if (N !== lastTexN) {
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, N, N, 0, gl.RGBA, gl.UNSIGNED_BYTE, bytes);
        lastTexN = N;
      } else {
        gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, N, N, gl.RGBA, gl.UNSIGNED_BYTE, bytes);
      }
    },

    renderFrame(w, h, state) {
      const {
        gridN, biomeIdx, stage, leftStage, rightStage, splitX,
        stepPx, isoMorph, time, showNoise, layout, insetRect,
        lastRippleUv, lastRippleAge,
      } = state;

      ensureFbo(layout.lowW, layout.lowH);

      // Pass 1: Render crisp low-res isometric columns into MRT FBO
      gl.bindFramebuffer(gl.FRAMEBUFFER, sceneFbo);
      gl.viewport(0, 0, layout.lowW, layout.lowH);
      gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1]);
      gl.enable(gl.DEPTH_TEST);
      gl.depthFunc(gl.LESS);
      gl.depthMask(true);
      gl.disable(gl.BLEND);
      gl.disable(gl.CULL_FACE);

      gl.clearBufferfv(gl.COLOR, 0, new Float32Array([0, 0, 0, 0]));
      gl.clearBufferfv(gl.COLOR, 1, new Float32Array([1, 0, 0, 0]));
      gl.clearBufferfi(gl.DEPTH_STENCIL, 0, 1.0, 0);

      gl.useProgram(colProg);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, heightTex);
      gl.uniform1i(uCol.uHeightTex, 0);
      gl.uniform2f(uCol.uLowRes, layout.lowW, layout.lowH);
      gl.uniform2f(uCol.uCenterOffset, layout.offsetX, layout.offsetY);
      gl.uniform1i(uCol.uGridN, gridN);
      gl.uniform1f(uCol.uTileHalfW, layout.tileHalfW);
      gl.uniform1f(uCol.uFlatCellPx, layout.flatCellPx);
      gl.uniform1f(uCol.uMaxHeightPx, layout.maxHeightPx);
      gl.uniform1f(uCol.uBaseThickPx, layout.baseThickPx);
      gl.uniform1f(uCol.uStepPx, stepPx);
      gl.uniform1f(uCol.uIsoMorph, isoMorph);
      gl.uniform1i(uCol.uStage, stage);
      gl.uniform1i(uCol.uBiome, biomeIdx);
      gl.uniform1f(uCol.uTime, time);

      gl.bindVertexArray(colVao);
      gl.drawArraysInstanced(gl.TRIANGLES, 0, 18, gridN * gridN);

      // Pass 2: Fullscreen NEAREST upscale + 2-stage 2D outline (1 px ink + thick white sticker) + 2D noise inset
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, w, h);
      gl.disable(gl.DEPTH_TEST);
      gl.disable(gl.BLEND);

      gl.useProgram(compProg);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, colorTex);
      gl.uniform1i(uComp.uColorTex, 0);

      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, metaTex);
      gl.uniform1i(uComp.uMetaTex, 1);

      gl.activeTexture(gl.TEXTURE2);
      gl.bindTexture(gl.TEXTURE_2D, heightTex);
      gl.uniform1i(uComp.uHeightTex, 2);

      gl.uniform2f(uComp.uScreenRes, w, h);
      gl.uniform2f(uComp.uLowRes, layout.lowW, layout.lowH);
      gl.uniform1i(uComp.uLeftStage, leftStage);
      gl.uniform1i(uComp.uRightStage, rightStage);
      gl.uniform1i(uComp.uBiome, biomeIdx);
      gl.uniform1f(uComp.uSplitX, splitX);
      gl.uniform1f(uComp.uShowNoise, showNoise ? 1.0 : 0.0);
      gl.uniform1i(uComp.uGridN, gridN);
      gl.uniform4fv(uComp.uInsetRect, insetRect);
      gl.uniform2f(uComp.uLastRippleUv, lastRippleUv[0], lastRippleUv[1]);
      gl.uniform1f(uComp.uLastRippleAge, lastRippleAge);

      gl.bindVertexArray(quadVao);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

      return { lowW: layout.lowW, lowH: layout.lowH, pxScale: layout.pxScale };
    },
  };
}

export function createPixelwaveEffect(gl, { params } = {}) {
  const core = createPixelwaveRenderer(gl);

  let gridN = 24;
  let biomeIdx = 0;      // 0=Meadow, 1=Ocean, 2=Magma, 3=Neon Grid
  let waveModeIdx = 0;   // 0=Diagonal Loop, 1=Simplex Drift, 2=Click Ripple
  let stepPx = 2.0;      // 0 = Smooth, 1..4 = discrete pixel steps
  let waveSpeed = 1.0;   // 0.25..2.0
  let showNoise = true;  // Show live 2D heightmap preview inset by default for instant visual hook!

  let simTime = 0.0;
  let activeStage = 4;
  let isoMorph = 1.0;
  let isoMorphTarget = 1.0;
  let ripples = [];
  let lastRippleUv = [0.5, 0.5];
  let lastRippleT0 = -99.0;
  let draggingRipple = false;
  let lastDragSpawn = -99.0;

  let heightBytes = new Uint8Array(32 * 32 * 4);
  let heightFloats = new Float32Array(32 * 32);
  let lastLayout = null;
  let lastInsetRect = [0.76, 0.62, 0.96, 0.88];
  let lastSplitX = -1.0;
  let lastLeftStage = 0;

  // Inline controls inside #card (4 biome buttons, 3 wave modes, 3 visual sliders)
  let ctrlEl = null;
  let biomeBtns = [];
  let modeBtns = [];
  let sliders = {};
  let valEls = {};
  let langListenerBound = false;

  function getLang() {
    return document.documentElement.lang === "pl" ? "pl" : "en";
  }

  function spawnRipple(u, v, amp = 0.42) {
    const cu = clamp(u, 0.02, 0.98);
    const cv = clamp(v, 0.02, 0.98);
    ripples.push({ u: cu, v: cv, t0: simTime, amp });
    if (ripples.length > 12) ripples.shift();
    lastRippleUv = [cu, cv];
    lastRippleT0 = simTime;
  }

  // Exact ray-march / inverse-projection pick from screen NDC to (u, v) on the voxel grid or 2D inset!
  function pickGridUv(ndcX, ndcY) {
    const uvX = ndcX * 0.5 + 0.5;
    const uvY = ndcY * 0.5 + 0.5;

    // 1. Check live 2D heightmap inset click/drag first
    if (showNoise && activeStage !== 0) {
      const [x0, y0, x1, y1] = lastInsetRect;
      if (uvX >= x0 && uvX <= x1 && uvY >= y0 && uvY <= y1) {
        const u = (uvX - x0) / Math.max(0.001, x1 - x0);
        const v = 1.0 - (uvY - y0) / Math.max(0.001, y1 - y0);
        return { u: clamp(u, 0, 1), v: clamp(v, 0, 1), hit: true };
      }
    }

    if (!lastLayout) return { u: 0.5, v: 0.5, hit: false };
    const L = lastLayout;

    // 2. Check full-stage 2D Noise (Step 1) OR left side of Split when comparing vs 2D Noise!
    const inLeftSplit2D = lastSplitX >= 0.0 && uvX < lastSplitX && lastLeftStage === 0;
    const inFull2D = lastSplitX < 0.0 && activeStage === 0;
    if (inLeftSplit2D || inFull2D) {
      const aspect = L.lowW / Math.max(1, L.lowH);
      const halfBox = Math.min(0.36, 0.38 * aspect);
      const bx = ((uvX - 0.5) * aspect) / (halfBox * 2.0) + 0.5;
      const by = (uvY - 0.5) / (halfBox * 2.0) + 0.5;
      if (bx >= -0.02 && bx <= 1.02 && by >= -0.02 && by <= 1.02) {
        return { u: clamp(bx, 0, 1), v: clamp(1.0 - by, 0, 1), hit: true };
      }
      return { u: 0.5, v: 0.5, hit: false };
    }

    const sx = ndcX * (L.lowW * 0.5) - L.offsetX;
    const sy = ndcY * (L.lowH * 0.5) - L.offsetY;
    const halfN = gridN * 0.5;

    // Rigid 2:1 Isometric pick: step top-down along column heights so clicking tall peaks hits the exact column!
    const yCenterShift = -0.5 * (L.baseThickPx + L.maxHeightPx * 0.48);
    const maxY = L.baseThickPx + L.maxHeightPx;
    const steps = 28;
    for (let s = 0; s <= steps; s++) {
      const testY = maxY * (1.0 - s / steps);
      const uDiff = sx / L.tileHalfW;
      const vSum  = -(sy - testY - yCenterShift) / (L.tileHalfW * 0.5);
      const wx = 0.5 * (uDiff + vSum);
      const wz = 0.5 * (vSum - uDiff);
      const ix = Math.floor(wx + halfN);
      const iz = Math.floor(wz + halfN);
      if (ix >= 0 && ix < gridN && iz >= 0 && iz < gridN) {
        const colH = L.baseThickPx + heightFloats[iz * gridN + ix] * L.maxHeightPx;
        if (testY <= colH + 1.0) {
          return { u: (ix + 0.5) / gridN, v: (iz + 0.5) / gridN, hit: true };
        }
      }
    }

    // Fallback check on mid-plane for crisp edges
    const midY = L.baseThickPx + L.maxHeightPx * 0.45;
    const uDiff = sx / L.tileHalfW;
    const vSum  = -(sy - midY - yCenterShift) / (L.tileHalfW * 0.5);
    const u = (0.5 * (uDiff + vSum) + halfN) / gridN;
    const v = (0.5 * (vSum - uDiff) + halfN) / gridN;
    if (u >= -0.03 && u <= 1.03 && v >= -0.03 && v <= 1.03) {
      return { u: clamp(u, 0, 1), v: clamp(v, 0, 1), hit: true };
    }
    return { u: 0.5, v: 0.5, hit: false };
  }

  function syncControlsUi() {
    if (!ctrlEl) return;
    const pl = getLang() === "pl";

    const rowLabels = {
      biome: pl ? "Biom" : "Biome",
      wave:  pl ? "Fala" : "Wave",
      grid:  pl ? "Siatka" : "Grid",
      steps: pl ? "Schodki" : "Steps",
      speed: pl ? "Prędkość" : "Speed",
    };
    for (const [k, txt] of Object.entries(rowLabels)) {
      const el = ctrlEl.querySelector(`[data-pw-lbl="${k}"]`);
      if (el) el.textContent = txt;
    }

    biomeBtns.forEach((b, i) => {
      const lbl = b.querySelector("span:last-child");
      if (lbl) lbl.textContent = BIOME_DEFS[i][pl ? "pl" : "en"];
      b.classList.toggle("is-on", i === biomeIdx);
      b.setAttribute("aria-pressed", String(i === biomeIdx));
    });

    modeBtns.forEach((b, i) => {
      b.textContent = WAVE_MODES[i][pl ? "pl" : "en"];
      b.classList.toggle("is-on", i === waveModeIdx);
      b.setAttribute("aria-pressed", String(i === waveModeIdx));
    });

    if (sliders.grid) sliders.grid.value = String(gridN);
    if (valEls.grid) valEls.grid.textContent = `${gridN}×${gridN}`;

    if (sliders.steps) sliders.steps.value = String(Math.round(stepPx));
    if (valEls.steps) valEls.steps.textContent = stepPx < 0.5 ? (pl ? "Płynne" : "Smooth") : `${Math.round(stepPx)} px`;

    if (sliders.speed) sliders.speed.value = String(Math.round(waveSpeed * 100));
    if (valEls.speed) valEls.speed.textContent = `${waveSpeed.toFixed(2)}×`;

    const tips = {
      grid:  pl ? ["16×16 (duże woksele)", "32×32 (gęsta siatka)"]   : ["16×16 (chunky voxels)", "32×32 (dense grid)"],
      steps: pl ? ["Płynny ruch (0 px)", "Twarde schodki (4 px)"]     : ["Smooth motion (0 px)", "Hard pixel steps (4 px)"],
      speed: pl ? ["Wolno (0.25×)", "Szybko (2.00×)"]                 : ["Slow (0.25×)", "Fast (2.00×)"],
    };
    const nearState = {
      grid:  [gridN <= 16, gridN >= 32],
      steps: [stepPx <= 0.1, stepPx >= 3.9],
      speed: [waveSpeed <= 0.35, waveSpeed >= 1.85],
    };
    for (const k of ["grid", "steps", "speed"]) {
      const lo = ctrlEl.querySelector(`[data-pw-sw="${k}:lo"]`);
      const hi = ctrlEl.querySelector(`[data-pw-sw="${k}:hi"]`);
      if (lo) { lo.title = tips[k][0]; lo.classList.toggle("is-near", nearState[k][0]); }
      if (hi) { hi.title = tips[k][1]; hi.classList.toggle("is-near", nearState[k][1]); }
    }
  }

  function ensureControls() {
    if (ctrlEl || typeof document === "undefined") return;
    const card = document.getElementById("card");
    if (!card) return;

    if (!document.getElementById("fxPwCtrlCss")) {
      const st = document.createElement("style");
      st.id = "fxPwCtrlCss";
      st.textContent = `
        .pw-ctrls{
          margin-top:8px;padding-top:8px;border-top:2px solid #312c46;
          display:flex;flex-direction:column;gap:6px;
          font:700 11px/1.2 var(--pix,"Courier New",monospace);color:var(--cream);
        }
        .pw-ctrls[hidden]{display:none!important}
        .pw-prow{display:flex;align-items:center;gap:5px;flex-wrap:wrap}
        .pw-rlbl{flex:none;min-width:44px;font-size:9.5px;text-transform:uppercase;letter-spacing:.07em;color:var(--mint)}
        .pw-pill{
          display:inline-flex;align-items:center;gap:5px;
          padding:4px 8px;min-height:24px;font:700 10.5px/1 var(--sans);
          background:#262238;color:#d8c8ae;border:0;
          box-shadow:0 0 0 1.5px var(--ink),2px 2px 0 1px rgba(0,0,0,.35);
          cursor:pointer;white-space:nowrap;
        }
        .pw-pill:hover{background:#373152;color:#fff3dc}
        .pw-pill.is-on{background:var(--amber);color:var(--ink)}
        .pw-pill.is-on:hover{background:#f5b877;color:var(--ink)}
        .pw-pill.is-mint.is-on{background:var(--mint);color:var(--ink)}
        .pw-dot{width:8px;height:8px;border-radius:1px;box-shadow:0 0 0 1.5px var(--ink);flex:none}
        .pw-sliders{display:flex;flex-direction:column;gap:5px;padding-top:1px}
        .pw-srow{display:flex;align-items:center;gap:6px;min-width:0}
        .pw-lbl{flex:none;width:54px;font-size:10px;text-transform:uppercase;letter-spacing:.05em;color:var(--muted)}
        .pw-sw{
          flex:none;width:18px;height:18px;min-width:18px;min-height:18px;padding:0;border:0;
          background:#252136;box-shadow:0 0 0 1.5px var(--ink);border-radius:3px;
          display:inline-flex;align-items:center;justify-content:center;
          color:#c7bcdb;cursor:pointer;transition:transform .12s ease,box-shadow .12s ease;
        }
        .pw-sw svg{width:14px;height:14px;display:block}
        .pw-sw:hover{background:#352f4d;color:#fff3dc;transform:scale(1.12)}
        .pw-sw.is-near{box-shadow:0 0 0 1.5px var(--amber);color:var(--amber)}
        .pw-rng{
          flex:1 1 auto;min-width:0;height:8px;margin:0;cursor:pointer;
          -webkit-appearance:none;appearance:none;border-radius:999px;
          box-shadow:inset 0 0 0 1px rgba(255,255,255,.15),0 0 0 1.5px var(--ink);
          background:#2b2740;
        }
        .pw-rng--grid{
          background:
            repeating-linear-gradient(90deg,rgba(255,255,255,.22) 0 1px,transparent 1px 10px),
            linear-gradient(90deg,#2d3b4e 0%,#4e6e88 100%);
        }
        .pw-rng--steps{
          background:linear-gradient(90deg,
            #354b66 0%,#5889b0 32%,
            #5889b0 34%,#6cc47a 34%,#6cc47a 56%,
            #eea75e 56%,#eea75e 78%,
            #ff6b6b 78%,#ff6b6b 100%
          );
        }
        .pw-rng--speed{
          background:linear-gradient(90deg,#252845 0%,#3a668c 45%,#46d8c0 80%,#f4d06f 100%);
        }
        .pw-rng::-webkit-slider-thumb{
          -webkit-appearance:none;appearance:none;
          width:10px;height:16px;border-radius:3px;
          background:#fff3dc;border:2px solid var(--ink);
          box-shadow:0 1px 3px rgba(0,0,0,.65);cursor:ew-resize;
        }
        .pw-rng:hover::-webkit-slider-thumb{background:var(--amber)}
        .pw-rng::-moz-range-thumb{
          width:10px;height:16px;border-radius:3px;box-sizing:border-box;
          background:#fff3dc;border:2px solid var(--ink);
          box-shadow:0 1px 3px rgba(0,0,0,.65);cursor:ew-resize;
        }
        .pw-val{flex:none;width:46px;text-align:right;font-size:10px;color:#fff3dc;font-variant-numeric:tabular-nums}
        @media(max-width:780px){
          .pw-ctrls{margin-top:6px;padding-top:6px;gap:4px}
          .pw-lbl{width:48px;font-size:9.5px}
          .pw-sw{width:16px;height:16px;min-width:16px;min-height:16px}
          .pw-sw svg{width:12px;height:12px}
          .pw-val{width:42px;font-size:9.5px}
          .pw-pill{padding:3px 7px;min-height:22px;font-size:10px}
        }
        body.no-hud .pw-ctrls{display:none!important}
      `;
      document.head.appendChild(st);
    }

    // Crisp 14x14 visual icons for slider endpoints
    const ICO = {
      gridLo:  `<svg viewBox="0 0 14 14" shape-rendering="crispEdges"><rect x="2" y="2" width="4" height="4" fill="currentColor"/><rect x="8" y="2" width="4" height="4" fill="currentColor"/><rect x="2" y="8" width="4" height="4" fill="currentColor"/><rect x="8" y="8" width="4" height="4" fill="currentColor"/></svg>`,
      gridHi:  `<svg viewBox="0 0 14 14" shape-rendering="crispEdges"><rect x="1" y="1" width="2" height="2" fill="currentColor"/><rect x="5" y="1" width="2" height="2" fill="currentColor"/><rect x="9" y="1" width="2" height="2" fill="currentColor"/><rect x="1" y="5" width="2" height="2" fill="currentColor"/><rect x="5" y="5" width="2" height="2" fill="currentColor"/><rect x="9" y="5" width="2" height="2" fill="currentColor"/><rect x="1" y="9" width="2" height="2" fill="currentColor"/><rect x="5" y="9" width="2" height="2" fill="currentColor"/><rect x="9" y="9" width="2" height="2" fill="currentColor"/></svg>`,
      stepLo:  `<svg viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M1.5 9.5 C4 3.5, 6 3.5, 7 7 C8 10.5, 10 10.5, 12.5 4.5"/></svg>`,
      stepHi:  `<svg viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="square"><path d="M1.5 11 H4.5 V8 H7.5 V5 H10.5 V2.5 H12.5"/></svg>`,
      speedLo: `<svg viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M2 7 Q4.5 4 7 7 T12 7"/></svg>`,
      speedHi: `<svg viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M1.5 7 Q3 2.5 4.5 7 T7.5 7 T10.5 7 T13 7"/></svg>`,
    };

    ctrlEl = document.createElement("div");
    ctrlEl.className = "pw-ctrls";
    ctrlEl.innerHTML = `
      <div class="pw-prow" id="pwBiomeRow"><span class="pw-rlbl" data-pw-lbl="biome">Biome</span></div>
      <div class="pw-prow" id="pwWaveRow"><span class="pw-rlbl" data-pw-lbl="wave">Wave</span></div>
      <div class="pw-sliders">
        <div class="pw-srow"><span class="pw-lbl" data-pw-lbl="grid">Grid</span><button class="pw-sw" type="button" data-pw-sw="grid:lo">${ICO.gridLo}</button><input class="pw-rng pw-rng--grid" id="pwGrid" type="range" min="16" max="32" step="8"><button class="pw-sw" type="button" data-pw-sw="grid:hi">${ICO.gridHi}</button><span class="pw-val" id="pwGridVal">24×24</span></div>
        <div class="pw-srow"><span class="pw-lbl" data-pw-lbl="steps">Steps</span><button class="pw-sw" type="button" data-pw-sw="steps:lo">${ICO.stepLo}</button><input class="pw-rng pw-rng--steps" id="pwSteps" type="range" min="0" max="4" step="1"><button class="pw-sw" type="button" data-pw-sw="steps:hi">${ICO.stepHi}</button><span class="pw-val" id="pwStepsVal">2 px</span></div>
        <div class="pw-srow"><span class="pw-lbl" data-pw-lbl="speed">Speed</span><button class="pw-sw" type="button" data-pw-sw="speed:lo">${ICO.speedLo}</button><input class="pw-rng pw-rng--speed" id="pwSpeed" type="range" min="25" max="200" step="5"><button class="pw-sw" type="button" data-pw-sw="speed:hi">${ICO.speedHi}</button><span class="pw-val" id="pwSpeedVal">1.00×</span></div>
      </div>
    `;

    const hint = document.getElementById("hintLine");
    if (hint && hint.parentNode === card) card.insertBefore(ctrlEl, hint);
    else card.appendChild(ctrlEl);

    const bRow = ctrlEl.querySelector("#pwBiomeRow");
    biomeBtns = BIOME_DEFS.map((bDef, i) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "pw-pill";
      b.innerHTML = `<span class="pw-dot" style="background:${bDef.dot}"></span><span>${bDef.en}</span>`;
      b.addEventListener("click", () => { biomeIdx = i; syncControlsUi(); });
      bRow.appendChild(b);
      return b;
    });

    const wRow = ctrlEl.querySelector("#pwWaveRow");
    modeBtns = WAVE_MODES.map((mDef, i) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "pw-pill is-mint";
      b.textContent = mDef.en;
      b.addEventListener("click", () => {
        waveModeIdx = i;
        if (i === 2) spawnRipple(0.5, 0.5, 0.48); // Instant visual ripple feedback!
        syncControlsUi();
      });
      wRow.appendChild(b);
      return b;
    });

    sliders.grid  = ctrlEl.querySelector("#pwGrid");
    sliders.steps = ctrlEl.querySelector("#pwSteps");
    sliders.speed = ctrlEl.querySelector("#pwSpeed");
    valEls.grid   = ctrlEl.querySelector("#pwGridVal");
    valEls.steps  = ctrlEl.querySelector("#pwStepsVal");
    valEls.speed  = ctrlEl.querySelector("#pwSpeedVal");

    sliders.grid.addEventListener("input", () => { gridN = Number(sliders.grid.value); syncControlsUi(); });
    sliders.steps.addEventListener("input", () => { stepPx = Number(sliders.steps.value); syncControlsUi(); });
    sliders.speed.addEventListener("input", () => { waveSpeed = Number(sliders.speed.value) / 100; syncControlsUi(); });

    ctrlEl.querySelector('[data-pw-sw="grid:lo"]')?.addEventListener("click", () => { gridN = 16; syncControlsUi(); });
    ctrlEl.querySelector('[data-pw-sw="grid:hi"]')?.addEventListener("click", () => { gridN = 32; syncControlsUi(); });
    ctrlEl.querySelector('[data-pw-sw="steps:lo"]')?.addEventListener("click", () => { stepPx = 0; syncControlsUi(); });
    ctrlEl.querySelector('[data-pw-sw="steps:hi"]')?.addEventListener("click", () => { stepPx = 4; syncControlsUi(); });
    ctrlEl.querySelector('[data-pw-sw="speed:lo"]')?.addEventListener("click", () => { waveSpeed = 0.25; syncControlsUi(); });
    ctrlEl.querySelector('[data-pw-sw="speed:hi"]')?.addEventListener("click", () => { waveSpeed = 2.0; syncControlsUi(); });

    if (!langListenerBound) {
      langListenerBound = true;
      document.addEventListener("fxlab:lang", () => syncControlsUi());
    }
    syncControlsUi();
  }

  return {
    id: "pixelwave",
    maxPixels: 2400000,
    disableDblClickReset: true,
    defaultCamera: {
      yaw: 0.785,
      pitch: 0.464,
      dist: 1.0,
      lookY: 0.0,
      fovDeg: 35,
      minDist: 0.55,
      maxDist: 1.85,
      minPitch: 0.464,
      maxPitch: 0.464,
      autoOrbitSpeed: 0.0,
    },

    setVisible(visible) {
      ensureControls();
      if (ctrlEl) ctrlEl.hidden = !visible;
    },

    enterStep(stepIdx) {
      ensureControls();
      if (ctrlEl) ctrlEl.hidden = false;
      activeStage = clamp(stepIdx, 0, 4);
      isoMorphTarget = activeStage === 0 ? 0.0 : 1.0;
      if (params?.get("director") === "1") isoMorph = isoMorphTarget;
      syncControlsUi();
    },

    onReset() {
      gridN = 24;
      biomeIdx = 0;
      waveModeIdx = 0;
      stepPx = 2.0;
      waveSpeed = 1.0;
      showNoise = true;
      ripples = [];
      syncControlsUi();
    },

    triggerAction(actionId) {
      if (actionId === "noise") {
        showNoise = !showNoise;
      } else if (actionId === "biome") {
        biomeIdx = (biomeIdx + 1) % BIOME_DEFS.length;
      } else if (actionId === "ripple") {
        spawnRipple(0.5, 0.5, 0.50);
      }
      syncControlsUi();
    },

    isActionActive(actionId) {
      if (actionId === "noise") return showNoise;
      return false;
    },

    onPointerDown(ndcX, ndcY) {
      const hit = pickGridUv(ndcX, ndcY);
      if (hit.hit) {
        draggingRipple = true;
        spawnRipple(hit.u, hit.v, 0.46);
        lastDragSpawn = simTime;
        return true;
      }
      return false;
    },

    onPointerMove(ndcX, ndcY) {
      if (!draggingRipple) return;
      if (simTime - lastDragSpawn < 0.075) return;
      const hit = pickGridUv(ndcX, ndcY);
      if (hit.hit) {
        spawnRipple(hit.u, hit.v, 0.34);
        lastDragSpawn = simTime;
      }
    },

    onPointerUp() {
      draggingRipple = false;
    },

    onCanvasClick(ndcX, ndcY) {
      const hit = pickGridUv(ndcX, ndcY);
      spawnRipple(hit.hit ? hit.u : 0.5, hit.hit ? hit.v : 0.5, 0.46);
    },

    getTechBadge(stepIdx) {
      const pl = getLang() === "pl";
      const b = BIOME_DEFS[biomeIdx][pl ? "pl" : "en"].toUpperCase();
      const m = WAVE_MODES[waveModeIdx][pl ? "pl" : "en"].toUpperCase();
      if (stepIdx === 0) return pl ? `${gridN}×${gridN} HEIGHTMAPA 2D · ${m}` : `${gridN}×${gridN} 2D HEIGHTMAP · ${m}`;
      if (stepIdx === 1) return pl ? `IZOMETRIA 2:1 · KOLUMNY ${gridN}×${gridN}` : `2:1 ORTHO ISO · ${gridN}×${gridN} COLUMNS`;
      if (stepIdx === 2) return `${b} · ${stepPx < 0.5 ? (pl ? "PŁYNNIE" : "SMOOTH") : `${Math.round(stepPx)} PX`} · ${m}`;
      if (stepIdx === 3) return pl ? `1 PX OBRYS GŁĘBI · ${b}` : `1 PX DEPTH INK · ${b}`;
      return pl ? `PODWÓJNY OBRYS NAKLEJKI · ${b}` : `DOUBLE STICKER OUTLINE · ${b}`;
    },

    // Scripting hook for clean Shorts / X loop captures
    setPixelwaveParams(patch = {}) {
      if (typeof patch.gridN === "number") gridN = clamp(Math.round(patch.gridN), 12, 32);
      if (typeof patch.biome === "number") biomeIdx = clamp(Math.round(patch.biome), 0, 3);
      if (typeof patch.waveMode === "number") waveModeIdx = clamp(Math.round(patch.waveMode), 0, 2);
      if (typeof patch.stepPx === "number") stepPx = clamp(patch.stepPx, 0, 6);
      if (typeof patch.waveSpeed === "number") waveSpeed = clamp(patch.waveSpeed, 0.1, 3.0);
      if (typeof patch.showNoise === "boolean") showNoise = patch.showNoise;
      if (typeof patch.isoMorph === "number") { isoMorph = clamp(patch.isoMorph, 0, 1); isoMorphTarget = isoMorph; }
      if (typeof patch.time === "number") simTime = patch.time;
      if (Array.isArray(patch.ripple) && patch.ripple.length >= 2) {
        spawnRipple(patch.ripple[0], patch.ripple[1], patch.ripple[2] ?? 0.48);
      }
      syncControlsUi();
      return { gridN, biomeIdx, waveModeIdx, stepPx, waveSpeed, showNoise, isoMorph, simTime };
    },

    resize() {},

    update(dt, paused) {
      if (paused) return;
      simTime += dt * waveSpeed;
      // Smoothly tilt between flat 2D noise (Step 1) and 2:1 isometric 3D (Steps 2..5)
      isoMorph = lerp(isoMorph, isoMorphTarget, clamp(dt * 7.5, 0, 1));
      if (Math.abs(isoMorph - isoMorphTarget) < 0.002) isoMorph = isoMorphTarget;
      // Gently drop an ambient ripple every few seconds in Click Ripple mode if quiet
      if (waveModeIdx === 2 && simTime - lastRippleT0 > 3.2) {
        const a = simTime * 1.1;
        spawnRipple(0.5 + Math.cos(a) * 0.22, 0.5 + Math.sin(a * 1.3) * 0.22, 0.44);
      }
    },

    render(w, h, step, split, cam) {
      const stage = step.stage;
      activeStage = stage;
      const isPortrait = h > w * 1.05;
      const hudHidden = typeof document !== "undefined" && document.body.classList.contains("no-hud");

      const zoomScale = clamp(1.0 / Math.max(0.5, cam?.dist ?? 1.0), 0.55, 1.85);
      const layout = computePixelLayout(w, h, gridN, zoomScale, isPortrait && !hudHidden, hudHidden);
      lastLayout = layout;

      // Compute clean non-overlapping UV rect for live 2D heightmap inset (top-right on desktop, top-left on portrait)
      const insetPx = Math.round(clamp(Math.min(w, h) * (isPortrait ? 0.22 : 0.20), 86, 176));
      const padR = Math.round(w * 0.025 + 10);
      const padT = hudHidden ? Math.round(h * 0.04) : (isPortrait ? 72 : 84);
      const x1 = isPortrait && !hudHidden ? (padR + insetPx) / w : (w - padR) / w;
      const x0 = isPortrait && !hudHidden ? padR / w : (w - padR - insetPx) / w;
      const y1 = 1.0 - padT / h;
      const y0 = 1.0 - (padT + insetPx) / h;
      lastInsetRect = [x0, y0, x1, y1];

      evaluateHeightfield(heightBytes, heightFloats, gridN, simTime, waveModeIdx, ripples);
      core.uploadHeightfield(heightBytes, gridN);

      const leftStage = split.enabled ? (step.compareLeft ?? 0) : stage;
      const rightStage = split.enabled ? (step.compareRight ?? stage) : stage;
      lastSplitX = split.enabled ? split.pos : -1.0;
      lastLeftStage = leftStage;

      return core.renderFrame(w, h, {
        gridN,
        biomeIdx,
        stage,
        leftStage,
        rightStage,
        splitX: split.enabled ? split.pos : -1.0,
        stepPx,
        isoMorph: stage === 0 ? 0.0 : isoMorph,
        time: simTime,
        showNoise,
        layout,
        insetRect: lastInsetRect,
        lastRippleUv,
        lastRippleAge: simTime - lastRippleT0,
      });
    },
  };
}
