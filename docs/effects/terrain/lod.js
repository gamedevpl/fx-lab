// Watertight Fixed-World Terrain & LOD Engine (1992-2024) powered by Hydraulically Eroded Alpine Heightmap!
//   - Zero world-origin snapping/jumping: fixed [-80, +80] world-space domain with 16-bit eroded alpine-height.png!
//   - True Duchaineau (1997) forced-split diamond ROAM bintree (mathematically ZERO T-junction cracks!)
//   - Fixed-root quadtree patch selector with Filip Strugar (2009) exact CDLOD morph ranges & frustum culling!
//   - Static GPU patch meshes (8x8 GeoMipMapping, 8x8 + Vertical Skirts, 16x16 CDLOD/BF3/Nanite, 28x28 Clipmap rings)!

import { clamp, lerp } from "../../src/gl-utils.js";

export const WORLD_SIZE = 160.0;
export const HALF_WORLD = WORLD_SIZE * 0.5;
export const HEIGHT_SCALE = 26.0;

// --- Async loader for 384x384 RGBA8 alpine-height.png (16-bit R*256+G height + B flow + A sediment) ---
const heightCache = new Map();

export async function loadAlpineHeightmap(baseUrl) {
  if (heightCache.has(baseUrl)) return heightCache.get(baseUrl);
  const img = await new Promise((resolve, reject) => {
    const im = new Image();
    im.crossOrigin = "anonymous";
    im.onload = () => resolve(im);
    im.onerror = () => reject(new Error("Failed to load alpine-height.png"));
    im.src = `${baseUrl}alpine-height.png`;
  });
  const w = img.naturalWidth, h = img.naturalHeight;
  const cvs = document.createElement("canvas");
  cvs.width = w; cvs.height = h;
  const ctx = cvs.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(img, 0, 0);
  const rgba = ctx.getImageData(0, 0, w, h).data;

  // Unpack exact 16-bit heights on CPU so CPU & GPU (texelFetch) match to 1e-6 meters!
  const heights = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) {
    heights[i] = ((rgba[i * 4] * 256 + rgba[i * 4 + 1]) / 65535.0) * HEIGHT_SCALE;
  }

  function sampleHeight(wx, wz) {
    const u = clamp((wx + HALF_WORLD) / WORLD_SIZE, 0.0, 1.0) * (w - 1);
    const v = clamp((wz + HALF_WORLD) / WORLD_SIZE, 0.0, 1.0) * (h - 1);
    const x0 = Math.floor(u), z0 = Math.floor(v);
    const x1 = Math.min(w - 1, x0 + 1), z1 = Math.min(h - 1, z0 + 1);
    const fx = u - x0, fz = v - z0;
    const h00 = heights[z0 * w + x0];
    const h10 = heights[z0 * w + x1];
    const h01 = heights[z1 * w + x0];
    const h11 = heights[z1 * w + x1];
    return lerp(lerp(h00, h10, fx), lerp(h01, h11, fx), fz);
  }

  const res = { w, h, rgba, heights, sampleHeight };
  heightCache.set(baseUrl, res);
  return res;
}

// --- Static GPU Patch Geometry Builders (aGrid.xy, aBary.xy, aSkirt, aClusterLocal) ---
// Vertex layout: 6 floats -> [gx, gz, bx, by, isSkirt, clusterId]
export function buildGridPatchGeometry(N, withSkirts = false, clusterSub = 4) {
  const verts = [];
  const pushTri = (ax, az, ask, bx, bz, bsk, cx, cz, csk, cid) => {
    verts.push(
      ax, az, 1, 0, ask, cid,
      bx, bz, 0, 1, bsk, cid,
      cx, cz, 0, 0, csk, cid,
    );
  };

  for (let iz = 0; iz < N; iz++) {
    for (let ix = 0; ix < N; ix++) {
      // Sub-cluster ID inside patch (e.g., 4x4 meshlets inside a 16x16 patch -> vivid Nanite cluster mosaic!)
      const cx = Math.floor((ix * clusterSub) / N);
      const cz = Math.floor((iz * clusterSub) / N);
      const cid = cz * clusterSub + cx;
      // Uniform '/' diagonal guarantees exact bit-for-bit parent quad topology when CDLOD morph reaches 1.0!
      pushTri(ix, iz, 0, ix, iz + 1, 0, ix + 1, iz, 0, cid);
      pushTri(ix + 1, iz, 0, ix, iz + 1, 0, ix + 1, iz + 1, 0, cid);
    }
  }

  if (withSkirts) {
    // 4 vertical perimeter curtains dropping smoothly below tile edges to seal 2000 GeoMipMapping T-junction cracks!
    const addEdgeSkirt = (x0, z0, x1, z1) => {
      pushTri(x0, z0, 0, x0, z0, 1, x1, z1, 0, 0);
      pushTri(x1, z1, 0, x0, z0, 1, x1, z1, 1, 0);
    };
    for (let i = 0; i < N; i++) {
      addEdgeSkirt(i, 0, i + 1, 0);
      addEdgeSkirt(i + 1, N, i, N);
      addEdgeSkirt(0, i + 1, 0, i);
      addEdgeSkirt(N, i, N, i + 1);
    }
  }

  return { data: new Float32Array(verts), vertCount: verts.length / 6, N };
}

// Nested Concentric Clipmap Ring Mesh (Losasso & Hoppe, SIGGRAPH 2004):
// Ring 0 is solid M x M; Rings 1..4 are hollow frames skipping the exact child footprint shifted by (offX, offZ) in {-1, 0, +1}!
export function buildClipmapRingGeometry(M, hollow, offX = 0, offZ = 0) {
  const verts = [];
  const half = M >> 1;
  const inner = M >> 2;
  const pushTri = (ax, az, bx, bz, cx, cz) => {
    verts.push(
      ax, az, 1, 0, 0, 0,
      bx, bz, 0, 1, 0, 0,
      cx, cz, 0, 0, 0, 0,
    );
  };
  for (let iz = 0; iz < M; iz++) {
    for (let ix = 0; ix < M; ix++) {
      if (hollow) {
        const dx = ix - half - offX, dz = iz - half - offZ;
        if (dx >= -inner && dx < inner && dz >= -inner && dz < inner) continue;
      }
      pushTri(ix, iz, ix, iz + 1, ix + 1, iz);
      pushTri(ix + 1, iz, ix, iz + 1, ix + 1, iz + 1);
    }
  }
  return { data: new Float32Array(verts), vertCount: verts.length / 6, M };
}

// --- Frustum AABB Test (for Freeze Frustum Culling Inspection!) ---
function boxInFrustum(cam, minX, maxX, minY, maxY, minZ, maxZ) {
  if (!cam.cullFrustum) return true;
  const cx = (minX + maxX) * 0.5, cy = (minY + maxY) * 0.5, cz = (minZ + maxZ) * 0.5;
  const r = Math.hypot((maxX - minX) * 0.5, (maxY - minY) * 0.5, (maxZ - minZ) * 0.5);
  const dx = cx - cam.pos[0], dy = cy - cam.pos[1], dz = cz - cam.pos[2];
  const f = dx * cam.fwd[0] + dy * cam.fwd[1] + dz * cam.fwd[2];
  if (f + r < 0.25 || f - r > 155.0) return false;
  const h = dx * cam.right[0] + dy * cam.right[1] + dz * cam.right[2];
  const v = dx * cam.up[0] + dy * cam.up[1] + dz * cam.up[2];
  const limH = Math.max(0.5, f) * cam.tanHalfH + r * 1.15;
  const limV = Math.max(0.5, f) * cam.tanHalfFov + r * 1.15;
  return Math.abs(h) <= limH && Math.abs(v) <= limV;
}

// --- Fixed-Root World-Space Quadtree Selector (ZERO origin jumping, exact Filip Strugar CDLOD morph ranges!) ---
export function selectQuadtreePatches(lodCam, mode, errScale = 1.0) {
  const patches = [];
  const maxDepth = (mode === "geomip_cracks" || mode === "chunked_skirts") ? 4 : 5;
  const baseSplitMul = (mode === "geomip_cracks" || mode === "chunked_skirts") ? 1.22 : (mode === "nanite" ? 2.10 : 1.85);
  const splitMul = baseSplitMul * clamp(errScale, 0.65, 1.55);

  let patchCounter = 0;

  function recurse(x0, z0, size, depth) {
    if (!boxInFrustum(lodCam, x0, x0 + size, -1.0, HEIGHT_SCALE + 2.0, z0, z0 + size)) return;

    const nearX = clamp(lodCam.pos[0], x0, x0 + size);
    const nearZ = clamp(lodCam.pos[2], z0, z0 + size);
    const dist = Math.hypot(nearX - lodCam.pos[0], nearZ - lodCam.pos[2], Math.max(0, lodCam.pos[1] - 10.0) * 0.45);

    const splitDist = size * splitMul;
    if (depth < maxDepth && dist < splitDist) {
      const half = size * 0.5;
      recurse(x0,        z0,        half, depth + 1);
      recurse(x0 + half, z0,        half, depth + 1);
      recurse(x0,        z0 + half, half, depth + 1);
      recurse(x0 + half, z0 + half, half, depth + 1);
      return;
    }

    const parentSplitDist = (size * 2.0) * splitMul;
    const morphStart = parentSplitDist * 0.64;
    const morphEnd   = parentSplitDist * 0.98;

    patches.push({
      x0, z0, size,
      level: maxDepth - depth,
      morphStart,
      morphEnd,
      patchId: patchCounter++,
    });
  }

  recurse(-HALF_WORLD, -HALF_WORLD, WORLD_SIZE, 0);
  return patches;
}

// --- True Watertight Forced-Split Diamond ROAM Bintree (Lindstrom '96 / Duchaineau '97) ---
// Fixed root [-80, +80]^2 (ZERO world jumping!) + forced base-neighbor diamond splits (ZERO T-junction cracks!)
export function createWatertightROAM(heightmap, maxNodes = 26000) {
  const ax = new Float32Array(maxNodes), az = new Float32Array(maxNodes);
  const bx = new Float32Array(maxNodes), bz = new Float32Array(maxNodes);
  const cx = new Float32Array(maxNodes), cz = new Float32Array(maxNodes);
  const depthArr = new Uint8Array(maxNodes);
  const lc = new Int32Array(maxNodes);
  const rc = new Int32Array(maxNodes);
  const ln = new Int32Array(maxNodes);
  const rn = new Int32Array(maxNodes);
  const bn = new Int32Array(maxNodes);
  const outBuf = new Float32Array(maxNodes * 3 * 6);
  let count = 0;

  function alloc(xA, zA, xB, zB, xC, zC, d, leftN, rightN, baseN) {
    if (count >= maxNodes) return -1;
    const id = count++;
    ax[id] = xA; az[id] = zA;
    bx[id] = xB; bz[id] = zB;
    cx[id] = xC; cz[id] = zC;
    depthArr[id] = d;
    lc[id] = -1; rc[id] = -1;
    ln[id] = leftN; rn[id] = rightN; bn[id] = baseN;
    return id;
  }

  function replaceNeighbor(triId, oldN, newN) {
    if (triId < 0) return;
    if (ln[triId] === oldN) ln[triId] = newN;
    else if (rn[triId] === oldN) rn[triId] = newN;
    else if (bn[triId] === oldN) bn[triId] = newN;
  }

  function split(id) {
    if (id < 0 || lc[id] >= 0 || count + 4 >= maxNodes) return;

    const base = bn[id];
    if (base >= 0 && bn[base] !== id) {
      split(base);
    }

    const mx = 0.5 * (bx[id] + cx[id]);
    const mz = 0.5 * (bz[id] + cz[id]);
    const d1 = depthArr[id] + 1;

    const L = alloc(mx, mz, ax[id], az[id], bx[id], bz[id], d1, -1, -1, ln[id]);
    const R = alloc(mx, mz, cx[id], cz[id], ax[id], az[id], d1, -1, -1, rn[id]);
    if (L < 0 || R < 0) return;
    lc[id] = L; rc[id] = R;

    ln[L] = R;
    rn[R] = L;
    replaceNeighbor(ln[id], id, L);
    replaceNeighbor(rn[id], id, R);

    const bNow = bn[id];
    if (bNow >= 0 && bn[bNow] === id) {
      const bL = alloc(mx, mz, ax[bNow], az[bNow], bx[bNow], bz[bNow], depthArr[bNow] + 1, -1, -1, ln[bNow]);
      const bR = alloc(mx, mz, cx[bNow], cz[bNow], ax[bNow], az[bNow], depthArr[bNow] + 1, -1, -1, rn[bNow]);
      if (bL < 0 || bR < 0) return;
      lc[bNow] = bL; rc[bNow] = bR;

      ln[bL] = bR;
      rn[bR] = bL;
      replaceNeighbor(ln[bNow], bNow, bL);
      replaceNeighbor(rn[bNow], bNow, bR);

      // Exact Duchaineau (1997) cross-stitching across shared diagonal hypotenuse!
      // id's left edge meets bNow's right edge, and id's right edge meets bNow's left edge!
      rn[L]  = bR;
      ln[bR] = L;
      ln[R]  = bL;
      rn[bL] = R;
    }
  }

  function build(lodCam, errScale = 1.0) {
    count = 0;
    const S = HALF_WORLD;
    alloc(-S,  S, -S, -S,  S,  S, 0, -1, -1,  1);
    alloc( S, -S,  S,  S, -S, -S, 0, -1, -1,  0);

    const maxDepth = 11;
    const budget = 1.35 * clamp(errScale, 0.65, 1.55);

    for (let i = 0; i < count; i++) {
      if (lc[i] >= 0 || depthArr[i] >= maxDepth || count + 12 >= maxNodes) continue;
      const mx = 0.5 * (bx[i] + cx[i]);
      const mz = 0.5 * (bz[i] + cz[i]);
      const edgeLen = Math.hypot(cx[i] - bx[i], cz[i] - bz[i]);
      if (lodCam.cullFrustum) {
        const minX = Math.min(ax[i], bx[i], cx[i]), maxX = Math.max(ax[i], bx[i], cx[i]);
        const minZ = Math.min(az[i], bz[i], cz[i]), maxZ = Math.max(az[i], bz[i], cz[i]);
        if (!boxInFrustum(lodCam, minX, maxX, -1, HEIGHT_SCALE + 2, minZ, maxZ)) continue;
      }
      const hm = heightmap.sampleHeight(mx, mz);
      const hb = heightmap.sampleHeight(bx[i], bz[i]);
      const hc = heightmap.sampleHeight(cx[i], cz[i]);
      const geomErr = Math.abs(hm - 0.5 * (hb + hc));
      const dist = Math.max(3.5, Math.hypot(mx - lodCam.pos[0], hm - lodCam.pos[1], mz - lodCam.pos[2]));
      const screenScore = ((edgeLen * 0.22 + geomErr * 2.4) / dist) * budget;
      if (depthArr[i] < 4 || screenScore > 0.088) {
        split(i);
      }
    }

    let vc = 0;
    for (let i = 0; i < count; i++) {
      if (lc[i] >= 0) continue;
      if (lodCam.cullFrustum) {
        const minX = Math.min(ax[i], bx[i], cx[i]), maxX = Math.max(ax[i], bx[i], cx[i]);
        const minZ = Math.min(az[i], bz[i], cz[i]), maxZ = Math.max(az[i], bz[i], cz[i]);
        if (!boxInFrustum(lodCam, minX, maxX, -1, HEIGHT_SCALE + 2, minZ, maxZ)) continue;
      }
      const lod = clamp(Math.floor((maxDepth - depthArr[i]) * 0.65), 0, 5);
      const o = vc * 6;
      const crossY = (bz[i] - az[i]) * (cx[i] - ax[i]) - (bx[i] - ax[i]) * (cz[i] - az[i]);
      if (crossY >= 0) {
        outBuf[o]    = ax[i]; outBuf[o+1]  = az[i]; outBuf[o+2]  = 1; outBuf[o+3]  = 0; outBuf[o+4]  = lod; outBuf[o+5]  = i;
        outBuf[o+6]  = bx[i]; outBuf[o+7]  = bz[i]; outBuf[o+8]  = 0; outBuf[o+9]  = 1; outBuf[o+10] = lod; outBuf[o+11] = i;
        outBuf[o+12] = cx[i]; outBuf[o+13] = cz[i]; outBuf[o+14] = 0; outBuf[o+15] = 0; outBuf[o+16] = lod; outBuf[o+17] = i;
      } else {
        outBuf[o]    = ax[i]; outBuf[o+1]  = az[i]; outBuf[o+2]  = 1; outBuf[o+3]  = 0; outBuf[o+4]  = lod; outBuf[o+5]  = i;
        outBuf[o+6]  = cx[i]; outBuf[o+7]  = cz[i]; outBuf[o+8]  = 0; outBuf[o+9]  = 1; outBuf[o+10] = lod; outBuf[o+11] = i;
        outBuf[o+12] = bx[i]; outBuf[o+13] = bz[i]; outBuf[o+14] = 0; outBuf[o+15] = 0; outBuf[o+16] = lod; outBuf[o+17] = i;
      }
      vc += 3;
    }
    return { data: outBuf, vertCount: vc };
  }

  return { build };
}
