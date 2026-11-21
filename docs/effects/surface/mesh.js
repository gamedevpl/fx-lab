// Procedural indexed GPU mesh builder for Evolution of Surface Detail (1978-2026):
// Builds 4 LOD tiers (Low-Poly, Tessellated, Meshlet-Clustered, Micropolygon) of a carved Romanesque
// stone column + cobblestone courtyard plinth with strictly right-handed CCW outward winding & matched TBN.
// Note: WebGL2 has no native hardware tessellation or mesh shaders, so Stages 5-7 emulate real displacement
// and spatial meshlet clusters using pre-subdivided vertex-displaced GPU meshes.

function buildColumnPart(segsU, segsV, clusterW, clusterH, radius, yMin, yMax, uRepeat, vRepeat, matPart, baseCluster) {
  const cols = segsU + 1;
  const rows = segsV + 1;
  const verts = new Float32Array(cols * rows * 13);
  const idx = new Uint32Array(segsU * segsV * 6);

  let vo = 0;
  for (let iy = 0; iy <= segsV; iy++) {
    const ty = iy / segsV;
    const y = yMin + (yMax - yMin) * ty;
    const cy = Math.floor(Math.min(segsV - 1, iy) / clusterH);
    for (let ix = 0; ix <= segsU; ix++) {
      const tx = ix / segsU;
      // Right-handed CCW around +Y: as tx increases, point moves rightward across the front (+Z) face!
      // At tx=0.25 -> ang=-PI/2 -> (0, y, -R); at tx=0.75 -> ang=-3PI/2 -> (0, y, +R), T = (+1, 0, 0), B = cross(N,T) = (0,+1,0)!
      const ang = -tx * Math.PI * 2.0;
      const ca = Math.cos(ang), sa = Math.sin(ang);
      const cx = Math.floor(Math.min(segsU - 1, ix) / clusterW);
      const cid = baseCluster + cy * Math.ceil(segsU / clusterW) + cx;

      // Position
      verts[vo++] = ca * radius;
      verts[vo++] = y;
      verts[vo++] = sa * radius;
      // Outward radial normal
      verts[vo++] = ca;
      verts[vo++] = 0.0;
      verts[vo++] = sa;
      // Tangent (+U direction = dPos/dtx normalized = (+sin(ang), 0, -cos(ang)); cross(N, T) = (0, +1, 0) = +V!)
      verts[vo++] = sa;
      verts[vo++] = 0.0;
      verts[vo++] = -ca;
      // UV
      verts[vo++] = tx * uRepeat;
      verts[vo++] = ty * vRepeat;
      // Meta: clusterId, matPart
      verts[vo++] = cid;
      verts[vo++] = matPart;
    }
  }

  let io = 0;
  for (let iy = 0; iy < segsV; iy++) {
    for (let ix = 0; ix < segsU; ix++) {
      const a = iy * cols + ix;
      const b = a + 1;
      const c = a + cols;
      const d = c + 1;
      // Strictly CCW outward: (a->b = +T right, a->c = +B up -> cross(+T, +B) = +N outward!)
      idx[io++] = a; idx[io++] = b; idx[io++] = c;
      idx[io++] = b; idx[io++] = d; idx[io++] = c;
    }
  }
  const nextCluster = baseCluster + Math.ceil(segsV / clusterH) * Math.ceil(segsU / clusterW);
  return { verts, idx, nextCluster };
}

function buildCapDisk(segsU, rings, clusterW, clusterH, radius, y, signY, uScale, matPart, baseCluster) {
  const cols = segsU + 1;
  const rows = rings + 1;
  const verts = new Float32Array(cols * rows * 13);
  const idx = new Uint32Array(segsU * rings * 6);

  let vo = 0;
  for (let ir = 0; ir <= rings; ir++) {
    const tr = ir / rings;
    const r = radius * tr;
    const cy = Math.floor(Math.min(rings - 1, ir) / clusterH);
    for (let ix = 0; ix <= segsU; ix++) {
      const tx = ix / segsU;
      const ang = -tx * Math.PI * 2.0;
      const ca = Math.cos(ang), sa = Math.sin(ang);
      const cx = Math.floor(Math.min(segsU - 1, ix) / clusterW);
      const cid = baseCluster + cy * Math.ceil(segsU / clusterW) + cx;

      const px = ca * r, pz = sa * r;
      verts[vo++] = px;
      verts[vo++] = y;
      verts[vo++] = pz;
      // Upward normal (0, +1, 0), T = (+1, 0, 0), B = cross(N, T) = (0, 0, -1) -> v increases with -z!
      verts[vo++] = 0.0;
      verts[vo++] = signY;
      verts[vo++] = 0.0;
      verts[vo++] = 1.0;
      verts[vo++] = 0.0;
      verts[vo++] = 0.0;
      verts[vo++] = px * uScale + 4.0;
      verts[vo++] = -pz * uScale + 4.0;
      verts[vo++] = cid;
      verts[vo++] = matPart;
    }
  }

  let io = 0;
  for (let ir = 0; ir < rings; ir++) {
    for (let ix = 0; ix < segsU; ix++) {
      const a = ir * cols + ix;
      const b = a + 1;
      const c = a + cols;
      const d = c + 1;
      // With ang = -2*PI*tx, a->b is CCW around +Y and a->c is outward radial:
      // cross(radial, CCW_tangent) = +Y! So (a, c, b) & (b, c, d) face UPWARD (+Y)!
      if (signY > 0) {
        idx[io++] = a; idx[io++] = c; idx[io++] = b;
        idx[io++] = b; idx[io++] = c; idx[io++] = d;
      } else {
        idx[io++] = a; idx[io++] = b; idx[io++] = c;
        idx[io++] = b; idx[io++] = d; idx[io++] = c;
      }
    }
  }
  const nextCluster = baseCluster + Math.ceil(rings / clusterH) * Math.ceil(segsU / clusterW);
  return { verts, idx, nextCluster };
}

function mergeParts(parts) {
  let totalV = 0, totalI = 0;
  for (const p of parts) { totalV += p.verts.length; totalI += p.idx.length; }
  const verts = new Float32Array(totalV);
  const idx = new Uint32Array(totalI);
  let vo = 0, io = 0, vBase = 0;
  for (const p of parts) {
    verts.set(p.verts, vo);
    for (let k = 0; k < p.idx.length; k++) idx[io + k] = p.idx[k] + vBase;
    vo += p.verts.length;
    io += p.idx.length;
    vBase += p.verts.length / 13;
  }
  return { verts, idx, triCount: totalI / 3 };
}

function uploadMesh(gl, data) {
  const vao = gl.createVertexArray();
  const vbo = gl.createBuffer();
  const ebo = gl.createBuffer();
  gl.bindVertexArray(vao);
  gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
  gl.bufferData(gl.ARRAY_BUFFER, data.verts, gl.STATIC_DRAW);
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ebo);
  gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, data.idx, gl.STATIC_DRAW);

  const stride = 13 * 4;
  gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 3, gl.FLOAT, false, stride, 0);
  gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 3, gl.FLOAT, false, stride, 12);
  gl.enableVertexAttribArray(2); gl.vertexAttribPointer(2, 3, gl.FLOAT, false, stride, 24);
  gl.enableVertexAttribArray(3); gl.vertexAttribPointer(3, 2, gl.FLOAT, false, stride, 36);
  gl.enableVertexAttribArray(4); gl.vertexAttribPointer(4, 2, gl.FLOAT, false, stride, 44);
  gl.bindVertexArray(null);
  return { vao, vbo, ebo, count: data.idx.length, triCount: data.triCount };
}

export function buildSurfaceMeshes(gl) {
  const tiers = [
    // Tier 0: Low-Poly baseline (Stages 0..4: Flat, Bump, Normal, Parallax, Relief, POM -> crisp flat silhouette!)
    { segU: 36, segV: 24, cw: 8, ch: 8, baseU: 36, baseR: 8 },
    // Tier 1: Programmable DX11 Tessellation & Displacement (Stage 5 -> real jagged brick silhouette!)
    { segU: 136, segV: 104, cw: 12, ch: 12, baseU: 96, baseR: 28 },
    // Tier 2: Mesh Shaders & Meshlets (Stage 6 -> explicit spatial meshlet packets!)
    { segU: 208, segV: 152, cw: 8, ch: 8, baseU: 128, baseR: 40 },
    // Tier 3: Virtualized Micropolygon Geometry (Stage 7 -> dense hierarchical micropolygon clusters!)
    { segU: 288, segV: 216, cw: 6, ch: 6, baseU: 160, baseR: 52 },
  ];

  return tiers.map(t => {
    let cid = 1;
    // Main carved stone pillar (y = -1.25 .. +1.65, radius = 0.86)
    const pCol = buildColumnPart(t.segU, t.segV, t.cw, t.ch, 0.86, -1.25, 1.65, 4.0, 3.0, 0.0, cid);
    cid = pCol.nextCluster;
    // Top weathered stone capital cap
    const pTop = buildCapDisk(t.segU, Math.max(4, Math.floor(t.baseR * 0.45)), t.cw, Math.max(3, Math.floor(t.ch * 0.6)), 0.90, 1.65, 1.0, 0.72, 2.0, cid);
    cid = pTop.nextCluster;
    // Broad circular cobblestone courtyard pedestal floor (y = -1.25, radius = 2.65)
    const pFloor = buildCapDisk(t.baseU, t.baseR, t.cw, Math.max(4, Math.floor(t.ch * 0.75)), 2.65, -1.25, 1.0, 0.65, 1.0, cid);
    cid = pFloor.nextCluster;
    // Outer stone curb rim around courtyard plinth
    const pCurb = buildColumnPart(t.baseU, Math.max(4, Math.floor(t.segV * 0.12)), t.cw, 4, 2.65, -1.58, -1.25, 8.0, 0.5, 2.0, cid);
    const merged = mergeParts([pCol, pTop, pFloor, pCurb]);
    return uploadMesh(gl, merged);
  });
}
