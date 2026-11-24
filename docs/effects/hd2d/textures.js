// Procedural pixel-art diffuse, normal & roughness Texture2DArray generator + 2D sprite sheet
// for FX Lab #29: HD-2D Miniature Diorama (100% deterministic, zero external images).

import { clamp, mulberry32 } from "../../src/gl-utils.js";

export const TEX_BRICK   = 0;
export const TEX_FLOOR   = 1;
export const TEX_DOOR    = 2;
export const TEX_BANNER  = 3;
export const TEX_CAP     = 4;
export const TEX_WOOD    = 5;
export const TEX_WINDOW  = 6;
export const TEX_WATER   = 7;
export const TEX_LAYERS  = 8;

const S = 64;

function makeLayerBuf() {
  return {
    albedo: new Uint8Array(S * S * 4),
    height: new Float32Array(S * S),
    rough: new Float32Array(S * S),
  };
}

function setPx(layer, x, y, r, g, b, h, rough, em = 0) {
  const ix = ((x % S) + S) % S;
  const iy = ((y % S) + S) % S;
  const i = iy * S + ix;
  layer.albedo[i * 4 + 0] = clamp(Math.round(r), 0, 255);
  layer.albedo[i * 4 + 1] = clamp(Math.round(g), 0, 255);
  layer.albedo[i * 4 + 2] = clamp(Math.round(b), 0, 255);
  // Store emissive strength hint in albedo alpha (0 = matte, 255 = strong emissive)
  layer.albedo[i * 4 + 3] = clamp(Math.round(em * 255), 0, 255);
  layer.height[i] = h;
  layer.rough[i] = rough;
}

function buildBricks(rng) {
  const L = makeLayerBuf();
  const rows = 8;
  const rowH = S / rows; // 8 px per brick course
  const cols = 4;
  const colW = S / cols; // 16 px per brick

  // Per-brick deterministic tint & depth
  const tints = [];
  for (let r = 0; r < rows; r++) {
    tints[r] = [];
    for (let c = 0; c < cols; c++) {
      tints[r][c] = {
        v: 0.84 + rng() * 0.28,
        warm: (rng() - 0.45) * 18,
        moss: (r >= 6 && rng() < 0.42) ? (0.35 + rng() * 0.4) : (rng() < 0.09 ? 0.25 : 0),
        hBase: 0.78 + rng() * 0.18,
        crackX: rng() < 0.35 ? (3 + Math.floor(rng() * (colW - 6))) : -1,
      };
    }
  }

  for (let y = 0; y < S; y++) {
    const row = Math.floor(y / rowH);
    const ly = y % rowH;
    const xOff = (row & 1) ? (colW >> 1) : 0;
    for (let x = 0; x < S; x++) {
      const sx = (x + xOff) % S;
      const col = Math.floor(sx / colW);
      const lx = sx % colW;
      const b = tints[row][col];
      const grain = (rng() - 0.5) * 16;

      const isMortar = ly === 0 || lx === 0;
      const isBevelTop = ly === 1 && lx > 0;
      const isBevelLeft = lx === 1 && ly > 0;
      const isBevelBot = ly === rowH - 1 && lx > 0;
      const isBevelRight = lx === colW - 1 && ly > 0;
      const isCrack = b.crackX > 0 && Math.abs(lx - b.crackX) === 0 && ly >= 2 && ly <= 5 && rng() < 0.8;

      if (isMortar) {
        setPx(L, x, y, 42 + grain * 0.3, 40 + grain * 0.3, 48 + grain * 0.3, 0.10, 0.96);
      } else if (isCrack) {
        setPx(L, x, y, 56 + grain * 0.3, 52 + grain * 0.3, 58 + grain * 0.3, 0.36, 0.92);
      } else {
        let r = (138 + b.warm) * b.v + grain;
        let g = (131 + b.warm * 0.65) * b.v + grain * 0.9;
        let bl = (122 - b.warm * 0.3) * b.v + grain * 0.8;
        let h = b.hBase + (rng() - 0.5) * 0.08;
        if (isBevelTop || isBevelLeft) {
          r += 22; g += 20; bl += 16; h -= 0.14;
        } else if (isBevelBot || isBevelRight) {
          r -= 24; g -= 24; bl -= 20; h -= 0.22;
        }
        if (b.moss > 0 && (ly >= rowH - 3 || rng() < 0.35)) {
          r = r * (1 - b.moss * 0.45) + 46 * b.moss;
          g = g * (1 - b.moss * 0.2) + 84 * b.moss;
          bl = bl * (1 - b.moss * 0.45) + 48 * b.moss;
        }
        setPx(L, x, y, r, g, bl, clamp(h, 0.2, 1.0), 0.78 + rng() * 0.14);
      }
    }
  }
  return L;
}

function buildFlagstones(rng) {
  const L = makeLayerBuf();
  // Hand-crafted medieval irregular slab grid on 64x64 (tiled cleanly)
  const slabs = [
    [0, 0, 20, 16], [20, 0, 16, 16], [36, 0, 28, 12],
    [0, 16, 14, 18], [14, 16, 22, 18], [36, 12, 14, 22], [50, 12, 14, 22],
    [0, 34, 24, 14], [24, 34, 18, 16], [42, 34, 22, 16],
    [0, 48, 16, 16], [16, 48, 26, 16], [42, 50, 22, 14],
  ];
  const cellId = new Int16Array(S * S).fill(-1);
  const slabMeta = slabs.map(() => ({
    v: 0.80 + rng() * 0.30,
    warm: (rng() - 0.4) * 20,
    damp: rng() < 0.32 ? (0.28 + rng() * 0.22) : (0.68 + rng() * 0.2),
    hBase: 0.76 + rng() * 0.20,
  }));

  slabs.forEach(([sx, sy, sw, sh], idx) => {
    for (let dy = 0; dy < sh; dy++) {
      for (let dx = 0; dx < sw; dx++) {
        const x = (sx + dx) % S;
        const y = (sy + dy) % S;
        cellId[y * S + x] = idx;
      }
    }
  });

  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const id = cellId[y * S + x];
      const meta = slabMeta[id < 0 ? 0 : id];
      const leftId = cellId[y * S + ((x + S - 1) % S)];
      const rightId = cellId[y * S + ((x + 1) % S)];
      const upId = cellId[((y + S - 1) % S) * S + x];
      const downId = cellId[((y + 1) % S) * S + x];
      const grain = (rng() - 0.5) * 14;

      const isGrout = (id !== leftId || id !== upId);
      const isEdge = (id !== rightId || id !== downId);
      if (isGrout) {
        setPx(L, x, y, 36 + grain * 0.3, 35 + grain * 0.3, 44 + grain * 0.3, 0.08, 0.95);
      } else {
        let r = (146 + meta.warm) * meta.v + grain;
        let g = (137 + meta.warm * 0.7) * meta.v + grain;
        let b = (124 - meta.warm * 0.2) * meta.v + grain;
        let h = meta.hBase + (rng() - 0.5) * 0.07;
        // Subtle pixel bevel around slab perimeter
        const idL2 = cellId[y * S + ((x + S - 2) % S)];
        const idU2 = cellId[((y + S - 2) % S) * S + x];
        if (id !== idL2 || id !== idU2) {
          r += 16; g += 15; b += 12; h -= 0.12;
        } else if (isEdge) {
          r -= 20; g -= 20; b -= 18; h -= 0.18;
        }
        // Tiny occasional pebble / dark fleck
        if (rng() < 0.04) { r -= 26; g -= 24; b -= 22; h -= 0.16; }
        setPx(L, x, y, r, g, b, clamp(h, 0.18, 1.0), meta.damp);
      }
    }
  }
  return L;
}

function buildDoor(rng) {
  const L = makeLayerBuf();
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const plank = Math.floor(x / 10);
      const lx = x % 10;
      const border = x < 3 || x >= S - 3 || y < 3 || y >= S - 3;
      const strap = (y >= 12 && y <= 17) || (y >= 44 && y <= 49);
      const rivet = strap && (x % 10 === 5) && (y === 14 || y === 15 || y === 46 || y === 47);
      const ring = Math.hypot(x - 48, y - 32) < 5.5 && Math.hypot(x - 48, y - 32) > 2.5;
      const grain = Math.sin(y * 0.5 + plank * 2.1) * 7 + (rng() - 0.5) * 9;

      if (border) {
        setPx(L, x, y, 52 + grain * 0.3, 46 + grain * 0.3, 44 + grain * 0.3, 0.90, 0.78);
      } else if (ring) {
        setPx(L, x, y, 205, 162, 74, 0.98, 0.28);
      } else if (rivet) {
        setPx(L, x, y, 165, 166, 174, 0.99, 0.32);
      } else if (strap) {
        const bevel = (y === 12 || y === 44) ? 18 : ((y === 17 || y === 49) ? -18 : 0);
        setPx(L, x, y, 66 + bevel, 68 + bevel, 76 + bevel, 0.88, 0.42);
      } else if (lx === 0) {
        setPx(L, x, y, 36, 24, 18, 0.22, 0.92);
      } else {
        const shade = (plank & 1) ? 1.05 : 0.94;
        setPx(L, x, y, (98 + grain) * shade, (69 + grain * 0.7) * shade, (48 + grain * 0.5) * shade, 0.65 + (lx === 1 ? 0.08 : 0), 0.74);
      }
    }
  }
  return L;
}

function buildBanner(rng) {
  const L = makeLayerBuf();
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const frame = x < 6 || x >= S - 6 || y < 5 || y >= S - 5;
      const goldTrim = !frame && (x === 8 || x === S - 9 || y === 7 || y === S - 8);
      const emblem = !frame && (Math.abs(x - 32) + Math.abs(y - 30) < 10) && ((Math.abs(x - 32) + Math.abs(y - 30)) > 5);
      const weave = ((x + y) & 1) ? 5 : -5;
      const fold = Math.sin((x - 32) * 0.35) * 14;
      const n = (rng() - 0.5) * 8;

      if (frame) {
        setPx(L, x, y, 92 + n, 86 + n, 84 + n, 0.88, 0.82);
      } else if (goldTrim || emblem) {
        setPx(L, x, y, 224 + fold * 0.5, 178 + fold * 0.4, 72, 0.72, 0.42);
      } else {
        setPx(L, x, y, 178 + fold + weave + n, 44 + fold * 0.3 + n * 0.5, 42 + fold * 0.3, 0.55 + Math.sin((x - 32) * 0.35) * 0.14, 0.84);
      }
    }
  }
  return L;
}

function buildCap(rng) {
  const L = makeLayerBuf();
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const edge = x < 2 || x >= S - 2 || y < 2 || y >= S - 2;
      const n = (rng() - 0.5) * 7;
      if (edge) {
        setPx(L, x, y, 36 + n, 43 + n, 60 + n, 0.72, 0.85);
      } else {
        setPx(L, x, y, 18 + n * 0.6, 23 + n * 0.6, 36 + n * 0.8, 0.60, 0.94);
      }
    }
  }
  return L;
}

function buildWood(rng) {
  const L = makeLayerBuf();
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const hoop = (y >= 10 && y <= 14) || (y >= 49 && y <= 53);
      const seam = (x % 8) === 0;
      const grain = (rng() - 0.5) * 14;
      if (hoop) {
        const hi = (y === 10 || y === 49) ? 20 : 0;
        setPx(L, x, y, 74 + hi, 76 + hi, 84 + hi, 0.90, 0.38);
      } else if (seam) {
        setPx(L, x, y, 42, 29, 20, 0.24, 0.90);
      } else {
        setPx(L, x, y, 118 + grain, 84 + grain * 0.7, 56 + grain * 0.5, 0.66, 0.76);
      }
    }
  }
  return L;
}

function buildWindow(rng) {
  const L = makeLayerBuf();
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const nx = (x - 31.5) / 22.0;
      const ny = (y - 36.0) / 24.0;
      const inArch = (y >= 26 && Math.abs(x - 31.5) < 20) || (y < 26 && Math.hypot(nx, (y - 26) / 20.0) < 0.92);
      const mullion = Math.abs(x - 31.5) < 2.2 || Math.abs(y - 28) < 2.2 || Math.abs(y - 46) < 2.0;
      const n = (rng() - 0.5) * 10;
      if (!inArch || y > 58 || y < 6) {
        setPx(L, x, y, 74 + n, 72 + n, 78 + n, 0.90, 0.85, 0.0);
      } else if (mullion) {
        setPx(L, x, y, 36, 34, 42, 0.78, 0.72, 0.0);
      } else {
        // Warm glowing leaded amber window panes — HDR emissive landmark at top of frame!
        const paneGlow = 0.86 + 0.14 * Math.sin(x * 0.4 + y * 0.25);
        setPx(L, x, y, 255 * paneGlow, 192 * paneGlow, 96 * paneGlow, 0.25, 0.22, 0.95);
      }
    }
  }
  return L;
}

function buildWater(rng) {
  const L = makeLayerBuf();
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const w1 = Math.sin(x * 0.39 + Math.sin(y * 0.29) * 1.4);
      const w2 = Math.cos(y * 0.49 - x * 0.2);
      const ripple = (w1 + w2) * 0.5;
      const hi = ripple > 0.65 ? 24 : 0;
      const n = (rng() - 0.5) * 6;
      setPx(L, x, y, 24 + hi * 0.6 + n, 44 + hi * 0.85 + n, 76 + hi + n, 0.50 + ripple * 0.22, 0.14);
    }
  }
  return L;
}

function heightToNormalRough(layer, strength = 2.6) {
  const out = new Uint8Array(S * S * 4);
  const h = (x, y) => layer.height[(((y % S) + S) % S) * S + (((x % S) + S) % S)];
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const dx = (h(x + 1, y) - h(x - 1, y)) * strength;
      const dy = (h(x, y + 1) - h(x, y - 1)) * strength;
      const nx = -dx;
      const ny = -dy;
      const nz = 1.0;
      const inv = 1.0 / Math.hypot(nx, ny, nz);
      const i = (y * S + x) * 4;
      out[i + 0] = clamp(Math.round((nx * inv * 0.5 + 0.5) * 255), 0, 255);
      out[i + 1] = clamp(Math.round((ny * inv * 0.5 + 0.5) * 255), 0, 255);
      out[i + 2] = clamp(Math.round((nz * inv * 0.5 + 0.5) * 255), 0, 255);
      out[i + 3] = clamp(Math.round(layer.rough[y * S + x] * 255), 0, 255);
    }
  }
  return out;
}

// Build crisp 64x32 pixel-art 2D billboard sprite sheet (left 32x32: Knight, right 32x32: Skeleton)
function buildSpriteSheet() {
  const W = 64, H = 32;
  const px = new Uint8Array(W * H * 4);
  const put = (x, y, r, g, b, a = 255) => {
    if (x < 0 || x >= W || y < 0 || y >= H) return;
    // Flip Y so UV v=0 is feet, v=1 is head
    const fy = H - 1 - y;
    const i = (fy * W + x) * 4;
    px[i] = r; px[i + 1] = g; px[i + 2] = b; px[i + 3] = a;
  };
  const rect = (x0, y0, w, h, r, g, b) => {
    for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) put(x, y, r, g, b);
  };

  // --- LEFT (0..31): Pixel-Art Knight / Adventurer holding glowing golden sword ---
  // Boots
  rect(12, 26, 3, 5, 58, 44, 38);
  rect(17, 26, 3, 5, 48, 36, 32);
  // Cloak / Tunic (deep sapphire + gold trim)
  rect(10, 14, 12, 12, 54, 72, 114);
  rect(12, 14, 8, 11, 78, 98, 144);
  rect(12, 23, 8, 2, 224, 178, 72);
  // Pauldrons & Helm
  rect(9, 13, 14, 4, 165, 176, 198);
  rect(12, 6, 8, 7, 196, 206, 224);
  rect(13, 9, 6, 2, 34, 42, 62); // visor
  rect(15, 3, 2, 3, 235, 180, 62); // crest
  // Glowing golden rune blade raised to the left
  rect(4, 16, 6, 2, 255, 224, 118);
  rect(2, 14, 3, 2, 255, 245, 185);
  rect(7, 15, 2, 4, 185, 132, 48); // crossguard

  // --- RIGHT (32..63): Pixel-Art Skeleton Sentinel with Shield & HP bar ---
  // Legs / bone shins
  rect(44, 25, 2, 6, 190, 188, 180);
  rect(49, 25, 2, 6, 168, 166, 160);
  // Tattered cloak & ribcage
  rect(42, 14, 11, 11, 84, 88, 102);
  rect(44, 15, 7, 8, 205, 202, 192);
  rect(45, 17, 5, 1, 52, 54, 66);
  rect(45, 20, 5, 1, 52, 54, 66);
  // Skull
  rect(44, 7, 7, 6, 226, 224, 214);
  rect(45, 9, 2, 2, 28, 32, 44);
  rect(49, 9, 2, 2, 28, 32, 44);
  // Iron kite shield on front-right
  rect(51, 15, 5, 9, 128, 136, 154);
  rect(52, 16, 3, 7, 156, 164, 182);
  // Steel blade
  rect(39, 13, 3, 9, 182, 194, 212);

  return { data: px, w: W, h: H };
}

export function createHd2dTextures(gl) {
  const rng = mulberry32(19042018);
  const layers = [
    buildBricks(rng),
    buildFlagstones(rng),
    buildDoor(rng),
    buildBanner(rng),
    buildCap(rng),
    buildWood(rng),
    buildWindow(rng),
    buildWater(rng),
  ];

  const albedoAll = new Uint8Array(S * S * 4 * TEX_LAYERS);
  const normRoughAll = new Uint8Array(S * S * 4 * TEX_LAYERS);
  const strengths = [3.2, 2.8, 2.6, 2.0, 1.0, 2.6, 1.8, 1.5];

  for (let i = 0; i < TEX_LAYERS; i++) {
    albedoAll.set(layers[i].albedo, i * S * S * 4);
    normRoughAll.set(heightToNormalRough(layers[i], strengths[i]), i * S * S * 4);
  }

  function uploadArray(data) {
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, tex);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage3D(gl.TEXTURE_2D_ARRAY, 0, gl.RGBA8, S, S, TEX_LAYERS, 0, gl.RGBA, gl.UNSIGNED_BYTE, data);
    // Crisp nearest-neighbor filtering — authentic pixel art texels in 3D!
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_S, gl.REPEAT);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_T, gl.REPEAT);
    return tex;
  }

  const texAlbedo = uploadArray(albedoAll);
  const texNormRough = uploadArray(normRoughAll);

  const spr = buildSpriteSheet();
  const texSprites = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, texSprites);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, spr.w, spr.h, 0, gl.RGBA, gl.UNSIGNED_BYTE, spr.data);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

  gl.bindTexture(gl.TEXTURE_2D_ARRAY, null);
  gl.bindTexture(gl.TEXTURE_2D, null);

  return { texAlbedo, texNormRough, texSprites };
}
