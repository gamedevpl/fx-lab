// Procedural 3D vaulted gallery corridor mesh for Evolution of Texture Mapping (1994-2026).
// Intentionally uses coarse architectural quads (2.2m floor/wall panels + angled stone crates & pillars)
// so 1994 PS1 affine diagonal triangle warping and GTE vertex snapping are unmistakably visible!

export function buildCorridorGeometry() {
  const pos = [];
  const norm = [];
  const uv = [];
  const mat = []; // 0=floor checkerboard mosaic, 1=brick/plaster walls, 2=stone pillars/arches, 3=angled crate/plinth, 4=ceiling vault
  const idx = [];

  function pushQuad(p0, p1, p2, p3, n, u0, v0, u1, v1, mId) {
    const base = pos.length / 3;
    const pts = [p0, p1, p2, p3];
    const uvs = [[u0, v0], [u1, v0], [u1, v1], [u0, v1]];
    for (let i = 0; i < 4; i++) {
      pos.push(pts[i][0], pts[i][1], pts[i][2]);
      norm.push(n[0], n[1], n[2]);
      uv.push(uvs[i][0], uvs[i][1]);
      mat.push(mId);
    }
    // Single diagonal split per quad -> exposes authentic PS1 diagonal texture break!
    idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }

  function pushBox(cx, cy, cz, hx, hy, hz, yaw, mId, uvScale = 0.7) {
    const c = Math.cos(yaw), s = Math.sin(yaw);
    const xf = (x, y, z) => [cx + x * c - z * s, cy + y, cz + x * s + z * c];
    const nf = (x, y, z) => [x * c - z * s, y, x * s + z * c];
    // Front (+Z)
    pushQuad(xf(-hx, -hy, hz), xf(hx, -hy, hz), xf(hx, hy, hz), xf(-hx, hy, hz), nf(0, 0, 1), 0, 0, 2 * hx * uvScale, 2 * hy * uvScale, mId);
    // Back (-Z)
    pushQuad(xf(hx, -hy, -hz), xf(-hx, -hy, -hz), xf(-hx, hy, -hz), xf(hx, hy, -hz), nf(0, 0, -1), 0, 0, 2 * hx * uvScale, 2 * hy * uvScale, mId);
    // Left (-X)
    pushQuad(xf(-hx, -hy, -hz), xf(-hx, -hy, hz), xf(-hx, hy, hz), xf(-hx, hy, -hz), nf(-1, 0, 0), 0, 0, 2 * hz * uvScale, 2 * hy * uvScale, mId);
    // Right (+X)
    pushQuad(xf(hx, -hy, hz), xf(hx, -hy, -hz), xf(hx, hy, -hz), xf(hx, hy, hz), nf(1, 0, 0), 0, 0, 2 * hz * uvScale, 2 * hy * uvScale, mId);
    // Top (+Y)
    pushQuad(xf(-hx, hy, hz), xf(hx, hy, hz), xf(hx, hy, -hz), xf(-hx, hy, -hz), nf(0, 1, 0), 0, 0, 2 * hx * uvScale, 2 * hz * uvScale, mId);
  }

  const HALF_W = 3.2;
  const WALL_H = 4.2;
  const Z_START = 6.5;
  const Z_END = -39.5;
  const SEG_Z = 2.875; // 16 coarse bays -> dramatic PS1 affine warping across floor & walls!
  const N_BAYS = Math.round((Z_START - Z_END) / SEG_Z);

  for (let i = 0; i < N_BAYS; i++) {
    const z0 = Z_START - i * SEG_Z;
    const z1 = z0 - SEG_Z;
    const v0 = i * 1.0;
    const v1 = (i + 1) * 1.0;

    // Floor: 2 coarse quads across width so center line + diagonal seams warp unmistakably in 1994 PS1!
    pushQuad([-HALF_W, 0, z0], [0, 0, z0], [0, 0, z1], [-HALF_W, 0, z1], [0, 1, 0], 0.0, v0, 1.0, v1, 0);
    pushQuad([0, 0, z0], [HALF_W, 0, z0], [HALF_W, 0, z1], [0, 0, z1], [0, 1, 0], 1.0, v0, 2.0, v1, 0);

    // Left wall (x = -HALF_W)
    pushQuad([-HALF_W, 0, z0], [-HALF_W, 0, z1], [-HALF_W, WALL_H, z1], [-HALF_W, WALL_H, z0], [1, 0, 0], v0, 0, v1, 1.4, 1);

    // Right wall (x = +HALF_W)
    pushQuad([HALF_W, 0, z1], [HALF_W, 0, z0], [HALF_W, WALL_H, z0], [HALF_W, WALL_H, z1], [-1, 0, 0], v0, 0, v1, 1.4, 1);

    // Sloped vault ceiling (left + center + right)
    pushQuad([-HALF_W, WALL_H, z0], [-HALF_W, WALL_H, z1], [-1.3, WALL_H + 1.15, z1], [-1.3, WALL_H + 1.15, z0], [0.48, -0.88, 0], v0, 0, v1, 0.85, 4);
    pushQuad([-1.3, WALL_H + 1.15, z0], [-1.3, WALL_H + 1.15, z1], [1.3, WALL_H + 1.15, z1], [1.3, WALL_H + 1.15, z0], [0, -1, 0], 0, v0, 1.0, v1, 4);
    pushQuad([1.3, WALL_H + 1.15, z0], [1.3, WALL_H + 1.15, z1], [HALF_W, WALL_H, z1], [HALF_W, WALL_H, z0], [-0.48, -0.88, 0], v0, 0, v1, 0.85, 4);

    // Periodic stone pilasters + overhead transverse arches every 2 bays
    if (i > 0 && i < N_BAYS - 1 && i % 2 === 0) {
      pushBox(-HALF_W + 0.28, WALL_H * 0.5, z0, 0.28, WALL_H * 0.5, 0.28, 0, 2, 0.65);
      pushBox( HALF_W - 0.28, WALL_H * 0.5, z0, 0.28, WALL_H * 0.5, 0.28, 0, 2, 0.65);
      pushBox(0, WALL_H + 0.88, z0, HALF_W - 0.1, 0.28, 0.26, 0, 2, 0.45);
    }
  }

  // Far horizon portal wall at z = Z_END with luminous stained-glass/emblem frame
  pushQuad([-HALF_W, 0, Z_END], [HALF_W, 0, Z_END], [HALF_W, WALL_H + 1.15, Z_END], [-HALF_W, WALL_H + 1.15, Z_END], [0, 0, 1], 0, 0, 2.0, 1.6, 2);

  // Foreground angled architectural stone crates/monoliths (perfect close-up targets for PS1 warping, Bilinear blur & S3TC 4x4 blocks!)
  pushBox(-1.68, 0.58, -1.8, 0.58, 0.58, 0.58, 0.38, 3, 0.86);
  pushBox( 1.75, 0.72, -3.4, 0.56, 0.72, 0.56, -0.44, 3, 0.86);
  pushBox(-1.95, 0.46, -7.8, 0.48, 0.46, 0.48, 0.22, 3, 0.86);
  pushBox( 1.88, 0.54, -12.6, 0.54, 0.54, 0.54, -0.32, 3, 0.86);

  return {
    positions: new Float32Array(pos),
    normals: new Float32Array(norm),
    uvs: new Float32Array(uv),
    mats: new Float32Array(mat),
    indices: new Uint16Array(idx),
    indexCount: idx.length,
  };
}
