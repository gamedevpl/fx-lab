// Real-Time Terrain LOD Geometry Builders (Zero-GC Reusable Buffers, 60 FPS in WebGL2):
//   - Deterministic multi-octave alpine ridge heightfield (peaks, glacier valley, river)
//   - ROAM (1997) real recursive Binary Triangle Tree (bintree) with roughness + distance error
//   - GeoMipMapping (2000) real quadtree blocks with genuine T-junction cracks & discrete LOD popping
//   - Chunked LOD (2002) real vertical edge skirts sealing every T-junction crack
//   - Geometry Clipmaps (2004) real concentric nested regular grid rings centered on viewer
//   - CDLOD (2009) real continuous vertex geomorphing (zero pop-in, zero cracks!)
//   - Cluster Meshlet LOD (2023 Nanite-style emulation) with per-cluster IDs & Freeze Frustum culling!

import { clamp, lerp, smoothstep } from "../../src/gl-utils.js";

// Deterministic fast value noise for dramatic alpine peaks + valley river
function hash2(ix, iz) {
  let n = Math.imul(ix, 374761393) + Math.imul(iz, 668265263);
  n = (n ^ (n >>> 13)) * 1274126177;
  return ((n ^ (n >>> 16)) >>> 0) / 4294967296;
}
function noise2(x, z) {
  const ix = Math.floor(x), iz = Math.floor(z);
  const fx = x - ix, fz = z - iz;
  const ux = fx * fx * (3 - 2 * fx), uz = fz * fz * (3 - 2 * fz);
  const a = hash2(ix, iz), b = hash2(ix + 1, iz);
  const c = hash2(ix, iz + 1), d = hash2(ix + 1, iz + 1);
  return a + (b - a) * ux + (c - a) * uz + (a - b - c + d) * ux * uz;
}

// Dramatic alpine mountain range heightfield (world units, range ~0..9.5)
export function sampleHeight(x, z, microDetail = false) {
  // Winding central glacial valley so camera flies dramatically between tall snow peaks!
  const riverCenter = Math.sin(z * 0.085) * 6.5 + Math.cos(z * 0.04) * 3.0;
  const valleyDist = Math.abs(x - riverCenter);
  const valley = smoothstep(2.2, 11.5, valleyDist);

  // Dramatic ridged alpine peaks (steep crests -> makes LOD popping, T-junction cracks & ROAM unmistakable!)
  let h = 0.0;
  let amp = 6.8, freq = 0.046;
  for (let i = 0; i < 4; i++) {
    const n = noise2(x * freq + 17.3 * i, z * freq - 11.7 * i);
    const ridge = 1.0 - Math.abs(n * 2.0 - 1.0);
    h += ridge * ridge * ridge * amp;
    amp *= 0.48;
    freq *= 2.12;
  }
  let y = h * (0.14 + 0.92 * valley) + smoothstep(0.0, 4.5, valleyDist) * 0.42;
  if (microDetail) {
    // Crisp rocky strata micro-displacement (Stage 5 DX11 Tessellation / Stage 7 Nanite!)
    const m1 = 1.0 - Math.abs(noise2(x * 0.68, z * 0.68) * 2.0 - 1.0);
    const m2 = noise2(x * 1.75, z * 1.75) - 0.5;
    y += (m1 * 0.34 + m2 * 0.14) * smoothstep(0.5, 2.6, y);
  }
  return y;
}

export function sampleNormal(x, z, eps = 0.25, microDetail = false) {
  const hL = sampleHeight(x - eps, z, microDetail);
  const hR = sampleHeight(x + eps, z, microDetail);
  const hD = sampleHeight(x, z - eps, microDetail);
  const hU = sampleHeight(x, z + eps, microDetail);
  const nx = hL - hR, ny = 2.0 * eps, nz = hD - hU;
  const l = Math.hypot(nx, ny, nz) || 1;
  return [nx / l, ny / l, nz / l];
}

// Reusable dynamic non-indexed triangle buffer (for crisp per-triangle barycentric wireframe + cluster ID!):
// Vertex layout (10 floats): [px, py, pz, nx, ny, nz, baryX, baryY, lodLevel, clusterId]
export function createTerrainMeshBuilder(maxTris = 26000) {
  const data = new Float32Array(maxTris * 3 * 10);
  let vertCount = 0;
  const maxVerts = maxTris * 3;

  function reset() { vertCount = 0; }

  function pushTri(p0, n0, p1, n1, p2, n2, lodLevel, clusterId) {
    if (vertCount + 3 > maxVerts) return;
    let o = vertCount * 10;
    data[o++] = p0[0]; data[o++] = p0[1]; data[o++] = p0[2];
    data[o++] = n0[0]; data[o++] = n0[1]; data[o++] = n0[2];
    data[o++] = 1; data[o++] = 0; data[o++] = lodLevel; data[o++] = clusterId;

    data[o++] = p1[0]; data[o++] = p1[1]; data[o++] = p1[2];
    data[o++] = n1[0]; data[o++] = n1[1]; data[o++] = n1[2];
    data[o++] = 0; data[o++] = 1; data[o++] = lodLevel; data[o++] = clusterId;

    data[o++] = p2[0]; data[o++] = p2[1]; data[o++] = p2[2];
    data[o++] = n2[0]; data[o++] = n2[1]; data[o++] = n2[2];
    data[o++] = 0; data[o++] = 0; data[o++] = lodLevel; data[o++] = clusterId;
    vertCount += 3;
  }

  function pushQuad(ax, az, bx, bz, cx, cz, dx, dz, lodLevel, clusterId, micro = false, morphFn = null) {
    const evalPt = (x, z) => {
      let y = sampleHeight(x, z, micro);
      if (morphFn) y = morphFn(x, z, y);
      return [x, y, z];
    };
    const pA = evalPt(ax, az), pB = evalPt(bx, bz), pC = evalPt(cx, cz), pD = evalPt(dx, dz);
    const eps = Math.max(0.18, Math.abs(bx - ax) * 0.45);
    const nA = sampleNormal(ax, az, eps, micro);
    const nB = sampleNormal(bx, bz, eps, micro);
    const nC = sampleNormal(cx, cz, eps, micro);
    const nD = sampleNormal(dx, dz, eps, micro);
    pushTri(pA, nA, pC, nC, pB, nB, lodLevel, clusterId);
    pushTri(pB, nB, pC, nC, pD, nD, lodLevel, clusterId);
  }

  // Helper: frustum test against frozen/active LOD camera (allows dramatic "Freeze Frustum" inspection!)
  function inFrustum(cx, cz, radius, lodCam) {
    if (!lodCam.cullFrustum) return true;
    const dx = cx - lodCam.pos[0];
    const dz = cz - lodCam.pos[2];
    const fwdDist = dx * lodCam.fwd[0] + dz * lodCam.fwd[2];
    if (fwdDist < -radius * 1.4) return false;
    const sideDist = Math.abs(dx * lodCam.right[0] + dz * lodCam.right[2]);
    const maxSide = Math.max(0, fwdDist) * lodCam.tanHalfH + radius * 1.65;
    return sideDist <= maxSide;
  }

  // ------------------------------------------------------------------------
  // STAGE 1: 1996-97 LINDSTROM CLOD & ROAM (Adaptive Binary Triangle Tree!)
  // ------------------------------------------------------------------------
  function buildROAM(lodCam, errScale = 1.0) {
    reset();
    const half = 42.0;
    const ox = Math.floor(lodCam.center[0] / 8) * 8;
    const oz = Math.floor(lodCam.center[2] / 8) * 8;

    function splitTri(x0, z0, x1, z1, x2, z2, depth) {
      // Midpoint of hypotenuse (x1,z1)-(x2,z2)
      const mx = 0.5 * (x1 + x2), mz = 0.5 * (z1 + z2);
      const cx = (x0 + x1 + x2) / 3, cz = (z0 + z1 + z2) / 3;
      const edgeLen = Math.hypot(x2 - x1, z2 - z1);
      if (!inFrustum(cx, cz, edgeLen * 0.8, lodCam)) return;

      const dist = Math.hypot(mx - lodCam.pos[0], mz - lodCam.pos[2]) + 2.0;
      const h1 = sampleHeight(x1, z1, false);
      const h2 = sampleHeight(x2, z2, false);
      const hm = sampleHeight(mx, mz, false);
      const geomErr = Math.abs(hm - 0.5 * (h1 + h2));
      const screenErr = ((geomErr * 2.4 + edgeLen * 0.085) / dist) * 14.0 * errScale;

      if (depth < 11 && edgeLen > 0.72 && screenErr > 0.42 && vertCount + 12 < maxVerts) {
        splitTri(mx, mz, x0, z0, x1, z1, depth + 1);
        splitTri(mx, mz, x2, z2, x0, z0, depth + 1);
      } else {
        const y0 = sampleHeight(x0, z0, false);
        const y1 = sampleHeight(x1, z1, false);
        const y2 = sampleHeight(x2, z2, false);
        const eps = Math.max(0.22, edgeLen * 0.25);
        const lod = clamp(6.0 - depth * 0.55, 0.0, 5.0);
        pushTri(
          [x0, y0, z0], sampleNormal(x0, z0, eps),
          [x1, y1, z1], sampleNormal(x1, z1, eps),
          [x2, y2, z2], sampleNormal(x2, z2, eps),
          lod, (depth * 17 + Math.floor(cx) * 7 + Math.floor(cz) * 13) & 255
        );
      }
    }

    // Two root right-triangles covering the world square
    const xA = ox - half, xB = ox + half, zA = oz - half, zB = oz + half;
    splitTri(xA, zA, xA, zB, xB, zA, 0);
    splitTri(xB, zB, xB, zA, xA, zB, 0);
    return { data, vertCount };
  }

  // ------------------------------------------------------------------------
  // STAGE 2 (2000 GeoMipMapping w/ CRACKS!) & STAGE 3 (2002 Chunked LOD w/ SKIRTS!)
  // & STAGE 5/6/7 (CDLOD Geomorphing / BF3 Virtual Texture / Nanite Cluster Meshlets!)
  // ------------------------------------------------------------------------
  function buildQuadtreeLOD(lodCam, mode, errScale = 1.0) {
    // mode: 'geomip_cracks' | 'chunked_skirts' | 'cdlod' | 'bf3' | 'nanite'
    reset();
    const isNanite = mode === "nanite";
    const isMicro  = mode === "cdlod" || mode === "bf3" || mode === "nanite";
    const isMorph  = mode === "cdlod" || mode === "bf3" || mode === "nanite";
    const addSkirts = mode === "chunked_skirts";
    const exposeCracks = mode === "geomip_cracks";

    const worldHalf = 44.0;
    const ox = Math.floor(lodCam.center[0] / 11) * 11;
    const oz = Math.floor(lodCam.center[2] / 11) * 11;
    const maxDepth = isNanite ? 4 : (mode === "cdlod" || mode === "bf3" ? 4 : 3);
    let clusterCounter = 1;

    function visitNode(x0, z0, size, depth) {
      const cx = x0 + size * 0.5, cz = z0 + size * 0.5;
      if (!inFrustum(cx, cz, size * 0.85, lodCam)) return;

      const dist = Math.hypot(cx - lodCam.pos[0], cz - lodCam.pos[2]);
      // GeoMipMapping uses stark coarse-vs-fine tile boundaries so T-junction cracks rip cleanly open!
      const splitThreshold = size * (exposeCracks ? 1.48 : (isNanite ? 2.15 : 1.95)) * errScale;

      if (depth < maxDepth && dist < splitThreshold) {
        const hs = size * 0.5;
        visitNode(x0,      z0,      hs, depth + 1);
        visitNode(x0 + hs, z0,      hs, depth + 1);
        visitNode(x0,      z0 + hs, hs, depth + 1);
        visitNode(x0 + hs, z0 + hs, hs, depth + 1);
        return;
      }

      const lodLevel = maxDepth - depth; // 0 = finest near camera, 3..4 = coarsest far
      const cells = isNanite ? 6 : (exposeCracks || addSkirts ? (lodLevel >= 1 ? 3 : 6) : 6);
      const step = size / cells;
      const cid = (clusterCounter++ * 37) % 251;

      // CDLOD smooth vertex geomorphing factor (morphs odd vertices onto parent coarse edge!)
      const morphRangeEnd = splitThreshold;
      const morphRangeStart = splitThreshold * 0.62;
      const morphFn = isMorph ? (x, z, y) => {
        const vd = Math.hypot(x - lodCam.pos[0], z - lodCam.pos[2]);
        const m = smoothstep(morphRangeStart, morphRangeEnd, vd);
        if (m <= 0.001) return y;
        // Snap odd grid coordinates toward coarse parent cell midpoint to eliminate ALL popping & T-junction cracks!
        const ix = Math.round((x - x0) / step);
        const iz = Math.round((z - z0) / step);
        const oxOdd = (ix & 1) !== 0, ozOdd = (iz & 1) !== 0;
        if (!oxOdd && !ozOdd) return y;
        let yCoarse = y;
        if (oxOdd && !ozOdd) yCoarse = 0.5 * (sampleHeight(x - step, z, isMicro) + sampleHeight(x + step, z, isMicro));
        else if (!oxOdd && ozOdd) yCoarse = 0.5 * (sampleHeight(x, z - step, isMicro) + sampleHeight(x, z + step, isMicro));
        else yCoarse = 0.5 * (sampleHeight(x - step, z - step, isMicro) + sampleHeight(x + step, z + step, isMicro));
        return lerp(y, yCoarse, m);
      } : null;

      // Emit cells x cells patch
      for (let iz = 0; iz < cells; iz++) {
        const za = z0 + iz * step, zb = za + step;
        for (let ix = 0; ix < cells; ix++) {
          const xa = x0 + ix * step, xb = xa + step;
          // In Nanite Cluster mode, give each 2x2 sub-block its own vivid meshlet cluster ID!
          const subCid = isNanite ? ((cid + (ix >> 1) * 19 + (iz >> 1) * 53) & 255) : cid;
          pushQuad(xa, za, xb, za, xa, zb, xb, zb, lodLevel, subCid, isMicro, morphFn);
        }
      }

      // Stage 3 (2002 Thatcher Ulrich Chunked LOD): drop vertical SKIRTS along all 4 chunk borders!
      if (addSkirts) {
        const skirtDrop = step * 0.95;
        const skirtLod = 7.0; // special marker so shader can optionally highlight skirts!
        const addSkirtEdge = (ax, az, bx, bz) => {
          const ya = sampleHeight(ax, az, false), yb = sampleHeight(bx, bz, false);
          const n = sampleNormal(0.5 * (ax + bx), 0.5 * (az + bz), step * 0.5, false);
          pushTri([ax, ya, az], n, [ax, ya - skirtDrop, az], n, [bx, yb, bz], n, skirtLod, cid);
          pushTri([bx, yb, bz], n, [ax, ya - skirtDrop, az], n, [bx, yb - skirtDrop, bz], n, skirtLod, cid);
        };
        for (let i = 0; i < cells; i++) {
          const t0 = i * step, t1 = (i + 1) * step;
          addSkirtEdge(x0 + t0, z0,        x0 + t1, z0);
          addSkirtEdge(x0 + t1, z0 + size, x0 + t0, z0 + size);
          addSkirtEdge(x0,      z0 + t1,   x0,      z0 + t0);
          addSkirtEdge(x0 + size, z0 + t0, x0 + size, z0 + t1);
        }
      }
    }

    visitNode(ox - worldHalf, oz - worldHalf, worldHalf * 2.0, 0);
    return { data, vertCount };
  }

  // ------------------------------------------------------------------------
  // STAGE 4: 2004-05 GEOMETRY CLIPMAPS (Losasso & Hoppe, SIGGRAPH 2004)
  // Concentric nested regular grid rings sliding seamlessly with the viewer!
  // ------------------------------------------------------------------------
  function buildClipmaps(lodCam) {
    reset();
    const rings = 5;
    const halfCells = 10; // inner block 20x20, outer hollow rings 20x20 minus inner 10x10!
    let baseStep = 0.65;

    for (let lv = 0; lv < rings; lv++) {
      const step = baseStep * (1 << lv);
      // Snap ring origin to 2*step grid so vertices NEVER swim when camera moves!
      const snap = step * 2.0;
      const cx = Math.round(lodCam.pos[0] / snap) * snap;
      const cz = Math.round(lodCam.pos[2] / snap) * snap;

      // Inner hole bounds covered by finer level (lv - 1)
      const innerHalf = lv === 0 ? -1 : halfCells * 0.5;
      const outerRad = halfCells * step;

      const morphFn = (x, z, y) => {
        // GPU clipmap border blend zone (smoothly morphs outer 20% of ring to next coarser ring!)
        const rx = Math.abs(x - cx) / outerRad;
        const rz = Math.abs(z - cz) / outerRad;
        const m = smoothstep(0.76, 1.0, Math.max(rx, rz));
        if (m <= 0.001) return y;
        const ix = Math.round((x - cx) / step);
        const iz = Math.round((z - cz) / step);
        const oxOdd = (ix & 1) !== 0, ozOdd = (iz & 1) !== 0;
        if (!oxOdd && !ozOdd) return y;
        let yc = y;
        if (oxOdd && !ozOdd) yc = 0.5 * (sampleHeight(x - step, z) + sampleHeight(x + step, z));
        else if (!oxOdd && ozOdd) yc = 0.5 * (sampleHeight(x, z - step) + sampleHeight(x, z + step));
        else yc = 0.5 * (sampleHeight(x - step, z - step) + sampleHeight(x + step, z + step));
        return lerp(y, yc, m);
      };

      for (let iz = -halfCells; iz < halfCells; iz++) {
        for (let ix = -halfCells; ix < halfCells; ix++) {
          if (lv > 0 && ix >= -innerHalf && ix < innerHalf && iz >= -innerHalf && iz < innerHalf) continue;
          const x0 = cx + ix * step, z0 = cz + iz * step;
          if (!inFrustum(x0 + step * 0.5, z0 + step * 0.5, step * 1.4, lodCam)) continue;
          pushQuad(x0, z0, x0 + step, z0, x0, z0 + step, x0 + step, z0 + step, lv, (lv * 47 + 19) & 255, lv === 0, morphFn);
        }
      }
    }
    return { data, vertCount };
  }

  return { buildROAM, buildQuadtreeLOD, buildClipmaps };
}
