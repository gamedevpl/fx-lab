// Shared deterministic simulation core for Evolution of Destruction & Fracturing (1998-2023).
// Drives both the primary WebGPU Compute renderer (8,192 GPU debris + 48x72x48 GPU voxel grid)
// and the automatic WebGL2 fallback (1,024 debris + 32x48x32 3D texture voxel grid).

export const DEFAULT_CAMERA = {
  yaw: 0.54,
  pitch: 0.19,
  dist: 13.6,
  target: [0.0, 2.55, 0.0],
  fov: 42,
  minDist: 7.0,
  maxDist: 23.0,
  minPitch: 0.04,
  maxPitch: 1.25,
};

export const TOWER_BOUNDS = {
  minX: -1.85, maxX: 1.85,
  minY:  0.00, maxY: 5.75,
  minZ: -1.85, maxZ: 1.85,
};

export const MAX_INSTANCES = 1024;
export const MAX_CRATERS = 16;
export const MAX_DUST = 96;

// Deterministic PRNG (Mulberry32) so split-screen sides & video renders stay repeatable.
export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Build a subdivided 3D box mesh (4 vertical segments on sides) so the vertex shader can:
//  - shape 0: crisp architectural masonry / concrete block
//  - shape 1: asymmetric faceted Voronoi fracture wedge (per-instance seeded bevels)
//  - shape 2: smoothly plastically bent DMM steel girder / door panel
//  - shape 3: round artillery cannonball / wrecking shell
//  - shape 4: protruding bent steel rebar rod
export function createAdaptiveBlockMesh() {
  const positions = [];
  const normals = [];
  const uvs = [];
  const indices = [];

  function pushFace(origin, right, up, normal, segU, segV) {
    const base = positions.length / 3;
    for (let j = 0; j <= segV; j++) {
      const v = j / segV;
      for (let i = 0; i <= segU; i++) {
        const u = i / segU;
        const px = origin[0] + right[0] * u + up[0] * v;
        const py = origin[1] + right[1] * u + up[1] * v;
        const pz = origin[2] + right[2] * u + up[2] * v;
        positions.push(px, py, pz);
        normals.push(normal[0], normal[1], normal[2]);
        uvs.push(u, v);
      }
    }
    const stride = segU + 1;
    for (let j = 0; j < segV; j++) {
      for (let i = 0; i < segU; i++) {
        const a = base + j * stride + i;
        const b = a + 1;
        const c = a + stride;
        const d = c + 1;
        indices.push(a, b, d, a, d, c);
      }
    }
  }

  // Subdivide 2x4 on sides, 2x2 on caps so bending & Voronoi wedging look razor-sharp
  pushFace([-0.5, -0.5,  0.5], [ 1, 0, 0], [0, 1, 0], [ 0,  0,  1], 2, 4); // +Z
  pushFace([ 0.5, -0.5, -0.5], [-1, 0, 0], [0, 1, 0], [ 0,  0, -1], 2, 4); // -Z
  pushFace([ 0.5, -0.5,  0.5], [ 0, 0,-1], [0, 1, 0], [ 1,  0,  0], 2, 4); // +X
  pushFace([-0.5, -0.5, -0.5], [ 0, 0, 1], [0, 1, 0], [-1,  0,  0], 2, 4); // -X
  pushFace([-0.5,  0.5,  0.5], [ 1, 0, 0], [0, 0,-1], [ 0,  1,  0], 2, 2); // +Y
  pushFace([-0.5, -0.5, -0.5], [ 1, 0, 0], [0, 0, 1], [ 0, -1,  0], 2, 2); // -Y

  return {
    positions: new Float32Array(positions),
    normals: new Float32Array(normals),
    uvs: new Float32Array(uvs),
    indices: new Uint16Array(indices),
  };
}

// Camera math shared by both backends & ray-picking.
export function computeCameraBasis(cam, aspect) {
  const cy = Math.cos(cam.yaw), sy = Math.sin(cam.yaw);
  const cp = Math.cos(cam.pitch), sp = Math.sin(cam.pitch);
  const tx = cam.target[0], ty = cam.target[1], tz = cam.target[2];
  const ex = tx + cam.dist * cp * sy;
  const ey = ty + cam.dist * sp;
  const ez = tz + cam.dist * cp * cy;

  let fx = tx - ex, fy = ty - ey, fz = tz - ez;
  const fl = Math.hypot(fx, fy, fz) || 1;
  fx /= fl; fy /= fl; fz /= fl;

  let rx = -fz, ry = 0, rz = fx;
  const rl = Math.hypot(rx, ry, rz) || 1;
  rx /= rl; ry /= rl; rz /= rl;

  const ux = ry * fz - rz * fy;
  const uy = rz * fx - rx * fz;
  const uz = rx * fy - ry * fx;

  const tanHalf = Math.tan(((cam.fov || 42) * Math.PI) / 360);
  const near = 0.25, far = 95.0;

  // Column-major view matrix
  const view = new Float32Array([
    rx, ux, -fx, 0,
    ry, uy, -fy, 0,
    rz, uz, -fz, 0,
    -(rx * ex + ry * ey + rz * ez),
    -(ux * ex + uy * ey + uz * ez),
    (fx * ex + fy * ey + fz * ez),
    1,
  ]);

  const f = 1.0 / tanHalf;
  // OpenGL clip-space Z in [-1, 1]
  const projGL = new Float32Array([
    f / aspect, 0, 0, 0,
    0, f, 0, 0,
    0, 0, (far + near) / (near - far), -1,
    0, 0, (2 * far * near) / (near - far), 0,
  ]);

  // WebGPU clip-space Z in [0, 1]
  const projGPU = new Float32Array([
    f / aspect, 0, 0, 0,
    0, f, 0, 0,
    0, 0, far / (near - far), -1,
    0, 0, (far * near) / (near - far), 0,
  ]);

  function mulMat4(a, b) {
    const out = new Float32Array(16);
    for (let c = 0; c < 4; c++) {
      for (let r = 0; r < 4; r++) {
        out[c * 4 + r] =
          a[0 * 4 + r] * b[c * 4 + 0] +
          a[1 * 4 + r] * b[c * 4 + 1] +
          a[2 * 4 + r] * b[c * 4 + 2] +
          a[3 * 4 + r] * b[c * 4 + 3];
      }
    }
    return out;
  }

  return {
    eye: [ex, ey, ez],
    fwd: [fx, fy, fz],
    right: [rx, ry, rz],
    up: [ux, uy, uz],
    tanHalf,
    aspect,
    near,
    far,
    view,
    viewProjGL: mulMat4(projGL, view),
    viewProjGPU: mulMat4(projGPU, view),
  };
}

// Raycast NDC click against the watchtower AABB or ground plaza to aim shots interactively.
export function pickBlastPoint(ndcX, ndcY, cam, aspect) {
  const b = computeCameraBasis(cam, aspect);
  const dx = b.fwd[0] + b.right[0] * (ndcX * b.tanHalf * aspect) + b.up[0] * (ndcY * b.tanHalf);
  const dy = b.fwd[1] + b.right[1] * (ndcX * b.tanHalf * aspect) + b.up[1] * (ndcY * b.tanHalf);
  const dz = b.fwd[2] + b.right[2] * (ndcX * b.tanHalf * aspect) + b.up[2] * (ndcY * b.tanHalf);
  const dl = Math.hypot(dx, dy, dz) || 1;
  const rd = [dx / dl, dy / dl, dz / dl];
  const ro = b.eye;

  // Ray-AABB test against watchtower volume
  const bmin = [-1.72, 0.0, -1.72];
  const bmax = [ 1.72, 5.5,  1.72];
  let tmin = 0.2, tmax = 60.0;
  for (let i = 0; i < 3; i++) {
    const inv = 1 / (Math.abs(rd[i]) < 1e-6 ? 1e-6 : rd[i]);
    let t0 = (bmin[i] - ro[i]) * inv;
    let t1 = (bmax[i] - ro[i]) * inv;
    if (t0 > t1) { const tmp = t0; t0 = t1; t1 = tmp; }
    tmin = Math.max(tmin, t0);
    tmax = Math.min(tmax, t1);
  }
  if (tmax >= tmin) {
    return [
      ro[0] + rd[0] * tmin,
      Math.max(0.35, Math.min(5.2, ro[1] + rd[1] * tmin)),
      ro[2] + rd[2] * tmin,
    ];
  }
  // Fallback: hit front-left or front-center pillar facing camera
  return [-1.25, 1.35, 1.35];
}

// Build the iconic Mediterranean Brick & Concrete Watchtower as ~148 structural cells.
// Each block has role ("pillar" | "brick" | "slab" | "roof" | "glass" | "girder" | "rebar" | "beacon"),
// panelId (for 1998 Half-Life pop-out), load-bearing strength, and grid neighbor links.
function buildTowerBlocks() {
  const blocks = [];
  let nextId = 0;
  function add(x, y, z, sx, sy, sz, mat, role, panelId, strength, extras = {}) {
    blocks.push({
      id: nextId++,
      hx: x, hy: y, hz: z,
      x, y, z,
      rx: 0, ry: 0, rz: 0,
      sx, sy, sz,
      vx: 0, vy: 0, vz: 0,
      wx: 0, wy: 0, wz: 0,
      mat,
      role,
      panelId,
      strength,
      shape: extras.shape || 0,
      seed: ((nextId * 2654435761) >>> 0) / 4294967296,
      bendAmt: 0,
      crackGlow: 0,
      stress: 0.08,
      state: "static", // "static" | "cracking" | "dynamic" | "gone"
      crackTimer: 0,
      grounded: y - sy * 0.5 <= 0.12,
      pillarCol: extras.pillarCol ?? -1,
      groupId: -1,
      neighbors: [],
    });
  }

  // 1) Four corner reinforced concrete load-bearing pillars (FL=0, FR=1, BL=2, BR=3)
  const pCoords = [
    [-1.28,  1.28, 0],
    [ 1.28,  1.28, 1],
    [-1.28, -1.28, 2],
    [ 1.28, -1.28, 3],
  ];
  for (const [px, pz, col] of pCoords) {
    // 4 vertical courses per pillar (ground floor: 0..2.48, upper floor: 2.74..5.10)
    add(px, 0.62, pz, 0.64, 1.24, 0.64, 1, "pillar", col, 1.0, { pillarCol: col });
    add(px, 1.86, pz, 0.64, 1.24, 0.64, 1, "pillar", col, 1.0, { pillarCol: col });
    add(px, 3.34, pz, 0.62, 1.20, 0.62, 1, "pillar", col + 4, 0.95, { pillarCol: col });
    add(px, 4.54, pz, 0.62, 1.20, 0.62, 1, "pillar", col + 4, 0.95, { pillarCol: col });
  }

  // 2) Ground-floor terracotta brick infill walls (South +Z has arched entrance, others solid courses)
  const brickY0 = [0.36, 1.08, 1.80, 2.28];
  const brickH0 = [0.72, 0.72, 0.72, 0.36];
  // Front (+Z) & Back (-Z) ground walls
  for (let side = 0; side < 2; side++) {
    const z = side === 0 ? 1.32 : -1.32;
    const pBase = side === 0 ? 10 : 11;
    for (let r = 0; r < brickY0.length; r++) {
      for (let c = -1; c <= 1; c++) {
        // Leave clean open doorway in center bottom of front wall
        if (side === 0 && c === 0 && r <= 2) continue;
        add(c * 0.64, brickY0[r], z, 0.62, brickH0[r], 0.42, 0, "brick", pBase, 0.52);
      }
    }
  }
  // Left (-X) & Right (+X) ground walls
  for (let side = 0; side < 2; side++) {
    const x = side === 0 ? -1.32 : 1.32;
    const pBase = side === 0 ? 12 : 13;
    for (let r = 0; r < brickY0.length; r++) {
      for (let c = -1; c <= 1; c++) {
        add(x, brickY0[r], c * 0.64, 0.42, brickH0[r], 0.62, 0, "brick", pBase, 0.52);
      }
    }
  }

  // Structural steel girders spanning the front doorway & mid-level frame (visibly bend in 2008 DMM!)
  add(0.0, 2.24,  1.34, 1.92, 0.22, 0.34, 3, "girder", 20, 0.92, { shape: 2 });
  add(0.0, 2.24, -1.34, 1.92, 0.22, 0.34, 3, "girder", 20, 0.92, { shape: 2 });
  add(-1.34, 2.24, 0.0, 0.34, 0.22, 1.92, 3, "girder", 20, 0.92, { shape: 2 });
  add( 1.34, 2.24, 0.0, 0.34, 0.22, 1.92, 3, "girder", 20, 0.92, { shape: 2 });

  // Vertical steel blast-door mullions in front doorway (signature DMM bendables!)
  add(-0.34, 1.10, 1.34, 0.14, 2.05, 0.20, 3, "girder", 21, 0.88, { shape: 2 });
  add( 0.34, 1.10, 1.34, 0.14, 2.05, 0.20, 3, "girder", 21, 0.88, { shape: 2 });
  add( 0.00, 1.10, 1.30, 0.58, 1.95, 0.10, 4, "glass",  21, 0.35);

  // 3) Reinforced Concrete Mid-Floor Slab (y = 2.60, 3x3 modular tiles)
  for (let gx = -1; gx <= 1; gx++) {
    for (let gz = -1; gz <= 1; gz++) {
      const isEdge = Math.abs(gx) === 1 || Math.abs(gz) === 1;
      add(gx * 1.06, 2.61, gz * 1.06, 1.04, 0.26, 1.04, 1, "slab", 30 + (gx + 1), isEdge ? 0.90 : 0.82);
    }
  }

  // 4) Upper-floor terracotta walls with large framed cyan glass windows on all 4 faces
  const upY = [3.08, 3.82, 4.52, 4.96];
  const upH = [0.68, 0.80, 0.60, 0.32];
  for (let side = 0; side < 2; side++) {
    const z = side === 0 ? 1.30 : -1.30;
    const pBase = side === 0 ? 40 : 41;
    for (let r = 0; r < upY.length; r++) {
      for (let c = -1; c <= 1; c++) {
        if (c === 0 && (r === 1 || r === 2)) {
          if (r === 1) {
            // Cyan glass window pane + vertical steel mullion
            add(0.0, 4.10, z, 0.78, 1.32, 0.12, 4, "glass", pBase, 0.32);
            add(0.0, 4.10, z + (side === 0 ? 0.05 : -0.05), 0.10, 1.34, 0.14, 3, "girder", pBase, 0.85, { shape: 2 });
          }
          continue;
        }
        add(c * 0.64, upY[r], z, 0.62, upH[r], 0.40, 0, "brick", pBase, 0.50);
      }
    }
  }
  for (let side = 0; side < 2; side++) {
    const x = side === 0 ? -1.30 : 1.30;
    const pBase = side === 0 ? 42 : 43;
    for (let r = 0; r < upY.length; r++) {
      for (let c = -1; c <= 1; c++) {
        if (c === 0 && (r === 1 || r === 2)) {
          if (r === 1) {
            add(x, 4.10, 0.0, 0.12, 1.32, 0.78, 4, "glass", pBase, 0.32);
          }
          continue;
        }
        add(x, upY[r], c * 0.64, 0.40, upH[r], 0.62, 0, "brick", pBase, 0.50);
      }
    }
  }

  // 5) Concrete Roof Slab (y = 5.22, 3x3 tiles) + Dark Slate Parapet Battlements + Rooftop Beacon
  for (let gx = -1; gx <= 1; gx++) {
    for (let gz = -1; gz <= 1; gz++) {
      add(gx * 1.06, 5.22, gz * 1.06, 1.04, 0.24, 1.04, 2, "roof", 50, 0.84);
    }
  }
  const merlons = [
    [-1.40,  1.40], [ 0.00,  1.40], [ 1.40,  1.40],
    [-1.40, -1.40], [ 0.00, -1.40], [ 1.40, -1.40],
    [-1.40,  0.00], [ 1.40,  0.00],
  ];
  for (const [mx, mz] of merlons) {
    add(mx, 5.52, mz, 0.56, 0.36, 0.56, 2, "roof", 51, 0.68);
  }
  // Rooftop demolition beacon / steel antenna mast
  add(0.0, 5.62, 0.0, 0.24, 0.58, 0.24, 3, "roof", 52, 0.85);
  add(0.0, 6.02, 0.0, 0.26, 0.22, 0.26, 6, "beacon", 52, 0.70);

  // Build structural adjacency graph (touching/overlapping bounding boxes within tolerance 0.14)
  const tol = 0.16;
  for (let i = 0; i < blocks.length; i++) {
    const a = blocks[i];
    for (let j = i + 1; j < blocks.length; j++) {
      const b = blocks[j];
      const dx = Math.abs(a.hx - b.hx) - (a.sx + b.sx) * 0.5;
      const dy = Math.abs(a.hy - b.hy) - (a.sy + b.sy) * 0.5;
      const dz = Math.abs(a.hz - b.hz) - (a.sz + b.sz) * 0.5;
      if (dx <= tol && dy <= tol && dz <= tol) {
        // Require at least 2 axes genuinely overlapping so diagonal corner dust doesn't weld blocks
        const touchAxes = (dx <= 0.04 ? 1 : 0) + (dy <= 0.04 ? 1 : 0) + (dz <= 0.04 ? 1 : 0);
        if (touchAxes >= 2) {
          a.neighbors.push(j);
          b.neighbors.push(i);
        }
      }
    }
  }
  return blocks;
}

// Build procedural 3D Voxel Watchtower (for Stage 6 Teardown Voxels: 48x72x48 in WebGPU, 32x48x32 in WebGL2).
// Material IDs: 0=empty, 1=terracotta brick, 2=mortar/trim, 3=warm concrete, 4=dark slate roof,
// 5=cyan glass, 6=steel rebar/frame, 7=charred blast soot, 8=timber lintel, 9=red beacon.
export function buildVoxelTower(nx, ny, nz) {
  const grid = new Uint8Array(nx * ny * nz);
  const { minX, maxX, minY, maxY, minZ, maxZ } = TOWER_BOUNDS;
  const spanX = maxX - minX, spanY = maxY - minY, spanZ = maxZ - minZ;

  for (let z = 0; z < nz; z++) {
    const wz = minZ + ((z + 0.5) / nz) * spanZ;
    const az = Math.abs(wz);
    for (let y = 0; y < ny; y++) {
      const wy = minY + ((y + 0.5) / ny) * spanY;
      for (let x = 0; x < nx; x++) {
        const wx = minX + ((x + 0.5) / nx) * spanX;
        const ax = Math.abs(wx);
        let mat = 0;

        // Tower outer envelope
        if (ax <= 1.62 && az <= 1.62 && wy <= 5.66) {
          // 4 concrete corner pillars with internal dark steel rebar
          const inPillar = ax >= 0.96 && az >= 0.96 && wy <= 5.28;
          const inRebar = Math.abs(ax - 1.28) < 0.08 && Math.abs(az - 1.28) < 0.08 && wy <= 5.20;
          // Mid floor slab & roof slab
          const inMidSlab = wy >= 2.48 && wy <= 2.74 && ax <= 1.60 && az <= 1.60;
          const inRoofSlab = wy >= 5.08 && wy <= 5.34 && ax <= 1.62 && az <= 1.62;
          // Parapet merlons
          const inMerlon = wy > 5.34 && wy <= 5.66 && (ax >= 1.12 || az >= 1.12) &&
            (ax >= 1.12 && az >= 1.12 || ax < 0.30 || az < 0.30);
          // Outer masonry shell
          const onWall = (ax >= 1.12 || az >= 1.12) && ax <= 1.54 && az <= 1.54 && wy <= 5.10;

          if (inRebar) {
            mat = 6;
          } else if (inPillar) {
            mat = 3;
          } else if (inRoofSlab || inMerlon) {
            mat = 4;
          } else if (inMidSlab) {
            mat = (Math.abs(wx) < 0.1 || Math.abs(wz) < 0.1) ? 6 : 3;
          } else if (onWall) {
            // Front doorway cutout on +Z ground floor
            const inDoor = wz > 1.0 && ax < 0.48 && wy < 2.12;
            const inDoorFrame = wz > 1.0 && ax < 0.56 && wy >= 2.12 && wy < 2.34;
            // Upper-floor arched windows on all 4 sides
            const inWinZ = az > 1.0 && ax < 0.42 && wy > 3.35 && wy < 4.72;
            const inWinX = ax > 1.0 && az < 0.42 && wy > 3.35 && wy < 4.72;
            if (inDoor) {
              mat = (ax < 0.42 && Math.abs(wz - 1.32) < 0.07) ? 5 : 0;
            } else if (inDoorFrame) {
              mat = 8;
            } else if (inWinZ || inWinX) {
              const isPane = (inWinZ && Math.abs(az - 1.32) < 0.07) || (inWinX && Math.abs(ax - 1.32) < 0.07);
              const isMullion = isPane && (Math.abs(wx) < 0.06 || Math.abs(wz) < 0.06 || Math.abs(wy - 4.02) < 0.06);
              mat = isMullion ? 6 : (isPane ? 5 : 0);
            } else {
              // Staggered brick & mortar course tinting
              const row = Math.floor(wy * 5.2);
              const col = Math.floor((wx + wz) * 3.1 + (row & 1) * 0.5);
              mat = ((row + col * 3) & 7) === 0 ? 2 : 1;
            }
          } else if (wy > 5.34 && wy <= 5.66 && ax < 0.22 && az < 0.22) {
            mat = 9;
          }
        }
        grid[x + y * nx + z * nx * ny] = mat;
      }
    }
  }
  return grid;
}

// Carve jagged spherical crater in CPU voxel mirror + run fast 3D BFS connected-components
// flood-fill from grounded y=0 voxels to detach floating voxel islands!
export function carveVoxelsAndDetachIslands(grid, nx, ny, nz, hitPos, radius) {
  const { minX, maxX, minY, maxY, minZ, maxZ } = TOWER_BOUNDS;
  const spanX = maxX - minX, spanY = maxY - minY, spanZ = maxZ - minZ;
  const dxStep = spanX / nx, dyStep = spanY / ny, dzStep = spanZ / nz;

  const gx0 = Math.max(0, Math.floor(((hitPos[0] - radius * 1.35) - minX) / dxStep));
  const gx1 = Math.min(nx - 1, Math.ceil(((hitPos[0] + radius * 1.35) - minX) / dxStep));
  const gy0 = Math.max(0, Math.floor(((hitPos[1] - radius * 1.35) - minY) / dyStep));
  const gy1 = Math.min(ny - 1, Math.ceil(((hitPos[1] + radius * 1.35) - minY) / dyStep));
  const gz0 = Math.max(0, Math.floor(((hitPos[2] - radius * 1.35) - minZ) / dzStep));
  const gz1 = Math.min(nz - 1, Math.ceil(((hitPos[2] + radius * 1.35) - minZ) / dzStep));

  const carvedSamples = [];
  for (let z = gz0; z <= gz1; z++) {
    const wz = minZ + (z + 0.5) * dzStep;
    for (let y = gy0; y <= gy1; y++) {
      const wy = minY + (y + 0.5) * dyStep;
      for (let x = gx0; x <= gx1; x++) {
        const idx = x + y * nx + z * nx * ny;
        const m = grid[idx];
        if (m === 0) continue;
        const wx = minX + (x + 0.5) * dxStep;
        const d = Math.hypot(wx - hitPos[0], wy - hitPos[1], wz - hitPos[2]);
        // Deterministic spatial ruggedness matching the GPU compute shader
        const h = Math.sin(x * 12.9898 + y * 78.233 + z * 37.719) * 43758.5453;
        const jitter = (h - Math.floor(h) - 0.5) * 0.28 * radius;
        const effR = radius + jitter;
        if (d < effR) {
          grid[idx] = 0;
          if (carvedSamples.length < 96 && ((x + y * 3 + z * 5) & 7) === 0) {
            carvedSamples.push([wx, wy, wz, m]);
          }
        } else if (d < effR + 0.20) {
          grid[idx] = 7; // charred blast soot rim!
        }
      }
    }
  }

  // 3D Flood-Fill BFS from grounded voxels (y <= 1)
  const total = nx * ny * nz;
  const visited = new Uint8Array(total);
  const queue = new Int32Array(total);
  let head = 0, tail = 0;
  const slice = nx * ny;

  for (let z = 0; z < nz; z++) {
    for (let y = 0; y <= 1 && y < ny; y++) {
      for (let x = 0; x < nx; x++) {
        const idx = x + y * nx + z * slice;
        if (grid[idx] !== 0) {
          visited[idx] = 1;
          queue[tail++] = idx;
        }
      }
    }
  }

  while (head < tail) {
    const cur = queue[head++];
    const z = (cur / slice) | 0;
    const rem = cur - z * slice;
    const y = (rem / nx) | 0;
    const x = rem - y * nx;

    if (x > 0) { const n = cur - 1; if (grid[n] && !visited[n]) { visited[n] = 1; queue[tail++] = n; } }
    if (x + 1 < nx) { const n = cur + 1; if (grid[n] && !visited[n]) { visited[n] = 1; queue[tail++] = n; } }
    if (y > 0) { const n = cur - nx; if (grid[n] && !visited[n]) { visited[n] = 1; queue[tail++] = n; } }
    if (y + 1 < ny) { const n = cur + nx; if (grid[n] && !visited[n]) { visited[n] = 1; queue[tail++] = n; } }
    if (z > 0) { const n = cur - slice; if (grid[n] && !visited[n]) { visited[n] = 1; queue[tail++] = n; } }
    if (z + 1 < nz) { const n = cur + slice; if (grid[n] && !visited[n]) { visited[n] = 1; queue[tail++] = n; } }
  }

  // Group disconnected floating voxels into falling rigid-body voxel island clusters!
  const islands = [];
  for (let z = 0; z < nz; z++) {
    for (let y = 0; y < ny; y++) {
      for (let x = 0; x < nx; x++) {
        const idx = x + y * nx + z * slice;
        if (grid[idx] === 0 || visited[idx]) continue;

        // BFS this disconnected island
        let ih = 0, it = 0;
        const iq = [idx];
        visited[idx] = 1;
        let minIx = x, maxIx = x, minIy = y, maxIy = y, minIz = z, maxIz = z;
        let domMat = grid[idx];
        let count = 0;
        const islandVoxels = [];

        while (ih < iq.length) {
          const c = iq[ih++];
          const cz = (c / slice) | 0;
          const crem = c - cz * slice;
          const cy = (crem / nx) | 0;
          const cx = crem - cy * nx;
          const m = grid[c];
          grid[c] = 0; // Detach from static voxel world!
          count++;
          if (m !== 7) domMat = m;
          if (cx < minIx) minIx = cx; if (cx > maxIx) maxIx = cx;
          if (cy < minIy) minIy = cy; if (cy > maxIy) maxIy = cy;
          if (cz < minIz) minIz = cz; if (cz > maxIz) maxIz = cz;
          islandVoxels.push([cx, cy, cz, m]);

          if (cx > 0) { const n = c - 1; if (grid[n] && !visited[n]) { visited[n] = 1; iq.push(n); } }
          if (cx + 1 < nx) { const n = c + 1; if (grid[n] && !visited[n]) { visited[n] = 1; iq.push(n); } }
          if (cy > 0) { const n = c - nx; if (grid[n] && !visited[n]) { visited[n] = 1; iq.push(n); } }
          if (cy + 1 < ny) { const n = c + nx; if (grid[n] && !visited[n]) { visited[n] = 1; iq.push(n); } }
          if (cz > 0) { const n = c - slice; if (grid[n] && !visited[n]) { visited[n] = 1; iq.push(n); } }
          if (cz + 1 < nz) { const n = c + slice; if (grid[n] && !visited[n]) { visited[n] = 1; iq.push(n); } }
        }

        if (count >= 4) {
          // Subdivide big detached islands into 2-4 crisp voxel chunks so falling silhouettes look unmistakably chunky!
          const cx = minX + ((minIx + maxIx + 1) * 0.5) * dxStep;
          const cy = minY + ((minIy + maxIy + 1) * 0.5) * dyStep;
          const cz = minZ + ((minIz + maxIz + 1) * 0.5) * dzStep;
          const sx = Math.max(0.18, (maxIx - minIx + 1) * dxStep);
          const sy = Math.max(0.18, (maxIy - minIy + 1) * dyStep);
          const sz = Math.max(0.18, (maxIz - minIz + 1) * dzStep);
          islands.push({ cx, cy, cz, sx, sy, sz, mat: domMat, count, samples: islandVoxels.slice(0, 24) });
        }
      }
    }
  }

  return { carvedSamples, islands };
}

// Per-stage destruction simulation state (so Split Mode can run TWO different eras live side-by-side!).
export function createStageSim(stageIdx, voxelDims = [48, 72, 48]) {
  const [vx, vy, vz] = voxelDims;
  const rng = mulberry32(199801 + stageIdx * 7919);

  const sim = {
    stage: stageIdx,
    blocks: [],
    shards: [],     // Dynamic Voronoi wedges, Havok debris, Half-Life canned gibs, exposed rebar, detached voxel islands
    craters: [],    // [x, y, z, r] for Stage 1 Geo-Mod CSG & scorch decals
    shells: [],     // Flying cannonballs approaching impact point
    dust: [],       // Volumetric dust puffs & shockwave rings
    voxels: stageIdx === 6 ? buildVoxelTower(vx, vy, vz) : null,
    voxelDims: [vx, vy, vz],
    voxelDirty: stageIdx === 6,
    voxelCarveQueue: [], // Queued blasts for GPU compute voxelCarve
    gpuEmitQueue: [],    // Queued GPU debris burst events { pos, radius, power, count, stage }
    voronoiFlash: 0,
    voronoiOrigin: [0, 2.2, 1.3],
    flashTime: 0,
    flashPos: [0, 2.0, 1.3],
    stressOverlayBoost: 0,
    age: 0,
    blastCount: 0,
  };

  function reset() {
    sim.blocks = buildTowerBlocks();
    sim.shards = [];
    sim.craters = [];
    sim.shells = [];
    sim.dust = [];
    sim.voronoiFlash = 0;
    sim.flashTime = 0;
    sim.stressOverlayBoost = 0;
    sim.age = 0;
    sim.blastCount = 0;
    sim.gpuEmitQueue.push({ reset: true });
    if (stageIdx === 6) {
      sim.voxels = buildVoxelTower(vx, vy, vz);
      sim.voxelDirty = true;
      sim.voxelCarveQueue = [{ reset: true }];
    }
  }

  function spawnDust(x, y, z, count, scaleBase, isFire = false) {
    for (let i = 0; i < count; i++) {
      if (sim.dust.length >= MAX_DUST) sim.dust.shift();
      const ang = rng() * Math.PI * 2;
      const spd = (0.8 + rng() * 3.2) * (isFire ? 1.4 : 1.0);
      sim.dust.push({
        x: x + (rng() - 0.5) * 0.45,
        y: Math.max(0.15, y + (rng() - 0.5) * 0.45),
        z: z + (rng() - 0.5) * 0.45,
        vx: Math.cos(ang) * spd,
        vy: (isFire ? 1.8 : 0.8) + rng() * 2.6,
        vz: Math.sin(ang) * spd,
        scale: scaleBase * (0.6 + rng() * 0.9),
        age: 0,
        maxAge: isFire ? (0.28 + rng() * 0.25) : (1.6 + rng() * 1.6),
        kind: isFire ? 1 : 0, // 0=masonry dust, 1=fiery blast flash, 2=shockwave ring
      });
    }
  }

  // Structural load-bearing graph solver for Stage 4 (2009 Guerrilla) & Stage 7 (2023 The Finals)
  function solveStructuralStress(triggerCollapseDelay = 0.26) {
    const blocks = sim.blocks;
    const n = blocks.length;
    const alive = new Uint8Array(n);
    const supportDist = new Float32Array(n);
    const colAnchored = [false, false, false, false];

    for (let i = 0; i < n; i++) {
      const b = blocks[i];
      if (b.state === "static" || b.state === "cracking") {
        alive[i] = 1;
        supportDist[i] = 999;
        if (b.role === "pillar" && b.grounded) {
          colAnchored[b.pillarCol] = true;
        }
      }
    }

    // BFS shortest structural load path from grounded blocks
    const q = [];
    for (let i = 0; i < n; i++) {
      if (!alive[i]) continue;
      if (blocks[i].grounded) {
        supportDist[i] = 0;
        q.push(i);
      }
    }
    let head = 0;
    while (head < q.length) {
      const u = q[head++];
      const du = supportDist[u];
      const nbrs = blocks[u].neighbors;
      for (let k = 0; k < nbrs.length; k++) {
        const v = nbrs[k];
        if (!alive[v]) continue;
        // Pillars conduct vertical load easily; brick infill conducts weaker lateral load
        const stepCost = blocks[v].role === "pillar" ? 0.65 : (blocks[v].role === "slab" ? 0.85 : 1.15);
        if (du + stepCost < supportDist[v]) {
          supportDist[v] = du + stepCost;
          q.push(v);
        }
      }
    }

    // Count remaining intact ground-floor load pillars
    let intactPillars = 0;
    const pillarBaseAlive = [0, 0, 0, 0];
    for (let i = 0; i < n; i++) {
      const b = blocks[i];
      if (alive[i] && b.role === "pillar" && b.hy < 2.4) {
        pillarBaseAlive[b.pillarCol]++;
      }
    }
    for (let c = 0; c < 4; c++) if (pillarBaseAlive[c] >= 2) intactPillars++;

    // Find center of gravity of missing corner pillars to apply realistic collapse lean torque!
    let missX = 0, missZ = 0, missCount = 0;
    const pPos = [[-1.28, 1.28], [1.28, 1.28], [-1.28, -1.28], [1.28, -1.28]];
    for (let c = 0; c < 4; c++) {
      if (pillarBaseAlive[c] < 2) {
        missX += pPos[c][0];
        missZ += pPos[c][1];
        missCount++;
      }
    }
    if (missCount > 0) { missX /= missCount; missZ /= missCount; }

    // Evaluate per-block scalar stress [0..1]
    for (let i = 0; i < n; i++) {
      if (!alive[i]) continue;
      const b = blocks[i];
      const d = supportDist[i];
      let stress = 0.08;
      if (d >= 900) {
        stress = 1.0; // completely disconnected!
      } else {
        // Compute cantilever overhang over missing pillars
        let overhang = 0;
        if (missCount > 0 && b.hy > 2.2) {
          const towardMissing = (b.hx * missX + b.hz * missZ) / (Math.hypot(missX, missZ) + 0.01);
          overhang = Math.max(0, (towardMissing + 0.85) * 0.48) * (missCount >= 2 ? 1.65 : 1.08);
        }
        const pillarLossPenalty = (4 - intactPillars) * (b.hy > 2.2 ? 0.34 : 0.16);
        stress = Math.min(1.0, 0.08 + d * 0.095 + overhang + pillarLossPenalty);
      }
      b.stress = Math.max(b.stress, stress);

      // Overstressed or disconnected cells enter brief dramatic cracking state -> full tilt collapse!
      const threshold = b.role === "pillar" ? 0.86 : 0.80;
      if (d >= 900 || stress >= threshold) {
        if (b.state === "static") {
          b.state = "cracking";
          // Lower overloaded joints snap first, wave propagates upward!
          b.crackTimer = triggerCollapseDelay * (0.45 + Math.max(0, (b.hy - 1.5) * 0.14));
          // Store collapse lean impulse direction toward the missing corner!
          b._leanX = missCount > 0 ? missX : (b.hx * 0.5);
          b._leanZ = missCount > 0 ? missZ : (b.hz * 0.5);
        }
      }
    }
    if (missCount > 0) sim.stressOverlayBoost = Math.max(sim.stressOverlayBoost, 1.0);
  }

  function emitSfx(detail) {
    if (typeof window !== "undefined" && typeof CustomEvent !== "undefined") {
      window.dispatchEvent(new CustomEvent("fxlab:sfx", { detail }));
    }
  }

  function applyBlast(hitPos, radius = 1.35, power = 1.0, kind = "shell") {
    sim.blastCount++;
    emitSfx({ type: "blast", stage: stageIdx, power });
    sim.flashTime = 0.32;
    sim.flashPos = [hitPos[0], hitPos[1], hitPos[2]];

    // Push shockwave ring + blast flash
    if (sim.dust.length >= MAX_DUST) sim.dust.shift();
    sim.dust.push({
      x: hitPos[0], y: hitPos[1], z: hitPos[2],
      vx: 0, vy: 0, vz: 0,
      scale: radius * 0.55,
      age: 0,
      maxAge: 0.34,
      kind: 2, // expanding shockwave ring
    });
    spawnDust(hitPos[0], hitPos[1], hitPos[2], stageIdx === 0 ? 5 : 10, 0.55, true);
    spawnDust(hitPos[0], hitPos[1], hitPos[2], stageIdx === 0 ? 4 : 14, 0.72, false);

    // Record crater for Stage 1 CSG & ground scorch decals
    if (sim.craters.length < MAX_CRATERS) {
      sim.craters.push([hitPos[0], hitPos[1], hitPos[2], radius * (stageIdx === 1 ? 1.08 : 0.85)]);
    } else {
      sim.craters[sim.blastCount % MAX_CRATERS] = [hitPos[0], hitPos[1], hitPos[2], radius];
    }

    // ---- STAGE 0: 1998 HALF-LIFE (func_breakable pre-baked panel vanish + canned gibs) ----
    if (stageIdx === 0) {
      // Find nearest hit panelId and instantly delete every block in that rectangular panel
      const hitPanels = new Set();
      for (const b of sim.blocks) {
        if (b.state !== "static") continue;
        const d = Math.hypot(b.x - hitPos[0], b.y - hitPos[1], b.z - hitPos[2]);
        if (d < radius * 1.05) hitPanels.add(b.panelId);
      }
      for (const b of sim.blocks) {
        if (b.state === "static" && hitPanels.has(b.panelId)) {
          b.state = "gone";
        }
      }
      // Spawn 14 identical low-poly canned brick gibs on fixed deterministic ballistic arcs (zero bounce!)
      for (let i = 0; i < 14; i++) {
        const ang = (i / 14) * Math.PI * 2 + 0.25;
        const spd = 3.2 + (i % 3) * 1.4;
        sim.shards.push({
          x: hitPos[0] + Math.cos(ang) * 0.25,
          y: hitPos[1] + ((i % 4) - 1.5) * 0.18,
          z: hitPos[2] + Math.sin(ang) * 0.25,
          rx: 0, ry: ang, rz: 0,
          sx: 0.28, sy: 0.18, sz: 0.22,
          vx: Math.cos(ang) * spd + hitPos[0] * 0.5,
          vy: 2.5 + (i % 4) * 1.2,
          vz: Math.sin(ang) * spd + hitPos[2] * 0.5,
          wx: 1.8, wy: 2.2, wz: 1.2,
          mat: 8, // retro flat-shaded 1998 gib
          shape: 0,
          seed: i * 0.07,
          bendAmt: 0,
          stress: 0,
          age: 0,
          noBounce: true,
        });
      }
      return;
    }

    // ---- STAGE 1: 2001 RED FACTION GEO-MOD (Pure CSG Boolean Carving, NO gravity/physics!) ----
    if (stageIdx === 1) {
      // Tower is raymarched via exact CSG SDF minus sim.craters[]!
      // Only spawn a small handful of tiny stone chips so the floating upper tower steals the spotlight.
      sim.gpuEmitQueue.push({ pos: hitPos, radius: radius * 0.7, power: 0.65, count: 90, stage: 1 });
      return;
    }

    // ---- STAGE 6: 2020-22 TEARDOWN DENSE 3D VOXEL CARVING + BFS ISLAND DETACHMENT ----
    if (stageIdx === 6) {
      const { carvedSamples, islands } = carveVoxelsAndDetachIslands(
        sim.voxels, sim.voxelDims[0], sim.voxelDims[1], sim.voxelDims[2], hitPos, radius * 1.05
      );
      sim.voxelDirty = true;
      sim.voxelCarveQueue.push({ pos: hitPos, radius: radius * 1.05 });

      // Spawn detached floating voxel islands as tumbling rigid-body voxel chunks!
      for (const isl of islands.slice(0, 18)) {
        const dx = isl.cx - hitPos[0], dy = isl.cy - hitPos[1], dz = isl.cz - hitPos[2];
        const dl = Math.hypot(dx, dy, dz) || 1;
        // Split large islands into sub-blocks so they crash realistically
        const subs = isl.count > 120 ? 3 : 1;
        for (let s = 0; s < subs; s++) {
          const ox = subs > 1 ? ((s - 1) * isl.sx * 0.28) : 0;
          const oy = subs > 1 ? ((s % 2) * isl.sy * 0.18) : 0;
          sim.shards.push({
            x: isl.cx + ox, y: isl.cy + oy, z: isl.cz,
            rx: 0, ry: 0, rz: 0,
            sx: isl.sx / (subs > 1 ? 1.55 : 1),
            sy: isl.sy / (subs > 1 ? 1.35 : 1),
            sz: isl.sz / (subs > 1 ? 1.35 : 1),
            vx: (dx / dl) * (1.8 + rng() * 2.2) + (rng() - 0.5) * 1.2,
            vy: 0.8 + rng() * 1.8,
            vz: (dz / dl) * (1.8 + rng() * 2.2) + (rng() - 0.5) * 1.2,
            wx: (rng() - 0.5) * 3.8,
            wy: (rng() - 0.5) * 3.0,
            wz: (rng() - 0.5) * 3.8,
            mat: isl.mat === 1 ? 0 : (isl.mat === 3 ? 1 : (isl.mat === 4 ? 2 : (isl.mat === 5 ? 4 : 0))),
            shape: 0,
            seed: rng(),
            bendAmt: 0,
            stress: 0,
            age: 0,
            isVoxelIsland: true,
          });
        }
      }

      // Massive GPU micro-voxel cube shower!
      sim.gpuEmitQueue.push({ pos: hitPos, radius: radius * 1.1, power: power * 1.25, count: 1400, stage: 6 });
      return;
    }

    // ---- STAGES 2, 3, 4, 5, 7: Structural Blocks + Era-Specific Physics ----
    const blastR = radius * (stageIdx === 3 ? 1.15 : 1.12);
    for (const b of sim.blocks) {
      if (b.state !== "static" && b.state !== "cracking") continue;
      const dx = b.x - hitPos[0], dy = b.y - hitPos[1], dz = b.z - hitPos[2];
      const dist = Math.hypot(dx, dy, dz);

      // Stage 3 (2008 Bad Company + Force Unleashed DMM):
      // Concrete pillars & slabs stay an indestructible skeleton (Bad Company!),
      // steel girders plastically BEND (DMM!), brick infill blows cleanly off!
      if (stageIdx === 3) {
        if (b.role === "girder" && dist < blastR * 1.65) {
          const bendDir = (b.z > 0.1 || b.x > 0.1) ? -1 : 1;
          b.bendAmt = Math.max(-1.0, Math.min(1.0, b.bendAmt + bendDir * (1.0 - dist / (blastR * 1.7)) * 1.15));
          b.stress = Math.min(1.0, b.stress + 0.65);
          continue;
        }
        if ((b.role === "pillar" || b.role === "slab" || b.role === "roof") && dist < blastR * 1.4) {
          b.stress = Math.min(0.65, b.stress + 0.35);
          continue; // Indestructible Bad Company 2008 skeleton!
        }
      }

      if (dist < blastR) {
        const falloff = Math.max(0.25, 1.0 - dist / blastR);
        const dirLen = Math.max(0.05, dist);
        const nx = dx / dirLen, ny = dy / dirLen, nz = dz / dirLen;

        // Stage 5 (2013-19 Voronoi) & Stage 7 (2023 Compound):
        // Shatter blasted wall/pillar blocks into unique impact-centered jagged Voronoi wedges!
        if ((stageIdx === 5 || stageIdx === 7) && b.role !== "beacon") {
          b.state = "gone";
          const shardCount = b.role === "pillar" ? 4 : 3;
          for (let s = 0; s < shardCount; s++) {
            const ox = (rng() - 0.5) * b.sx * 0.7;
            const oy = (rng() - 0.5) * b.sy * 0.7;
            const oz = (rng() - 0.5) * b.sz * 0.7;
            const spd = (3.8 + rng() * 6.8) * falloff * power;
            sim.shards.push({
              x: b.x + ox, y: b.y + oy, z: b.z + oz,
              rx: rng() * 6.28, ry: rng() * 6.28, rz: rng() * 6.28,
              sx: b.sx * (0.36 + rng() * 0.38),
              sy: b.sy * (0.36 + rng() * 0.38),
              sz: b.sz * (0.36 + rng() * 0.38),
              vx: nx * spd + (rng() - 0.5) * 3.4,
              vy: Math.max(1.2, ny * spd + 2.2 + rng() * 3.2),
              vz: nz * spd + (rng() - 0.5) * 3.4,
              wx: (rng() - 0.5) * 9.5,
              wy: (rng() - 0.5) * 9.5,
              wz: (rng() - 0.5) * 9.5,
              mat: (s === 0 && b.role === "pillar") ? 7 : b.mat, // exposed rough concrete interior!
              shape: 1, // jagged Voronoi polygonal wedge!
              seed: rng(),
              bendAmt: 0,
              stress: 0,
              age: 0,
            });
          }
          // Stage 7: leave twisted exposed steel rebar protruding from blasted pillars!
          if (stageIdx === 7 && b.role === "pillar") {
            for (let r = 0; r < 2; r++) {
              sim.shards.push({
                x: b.x + (r === 0 ? -0.14 : 0.14),
                y: b.y,
                z: b.z + (r === 0 ? 0.12 : -0.12),
                rx: (rng() - 0.5) * 0.35, ry: rng() * 3.14, rz: (rng() - 0.5) * 0.35,
                sx: 0.06, sy: b.sy * 1.05, sz: 0.06,
                vx: 0, vy: 0, vz: 0, wx: 0, wy: 0, wz: 0,
                mat: 3, // rusted steel rebar
                shape: 2,
                seed: rng(),
                bendAmt: (rng() - 0.5) * 1.25,
                stress: 0,
                age: 0,
                staticRebar: true,
              });
            }
          }
        } else {
          // Stage 2 (Havok), Stage 3 (Bad Company pre-cut panel), Stage 4 (Guerrilla)
          b.state = "dynamic";
          const spd = (3.4 + rng() * 5.2) * falloff * power;
          b.vx = nx * spd + (rng() - 0.5) * 2.2;
          b.vy = Math.max(1.0, ny * spd + 1.8 + rng() * 2.6);
          b.vz = nz * spd + (rng() - 0.5) * 2.2;
          b.wx = (rng() - 0.5) * 7.2;
          b.wy = (rng() - 0.5) * 6.4;
          b.wz = (rng() - 0.5) * 7.2;
        }
      } else if (dist < blastR * 1.85) {
        // Highlight nearby Voronoi crack web / stress ripples
        b.crackGlow = Math.max(b.crackGlow, 1.0 - (dist - blastR) / (blastR * 0.85));
        if (stageIdx === 4 || stageIdx === 7) {
          b.stress = Math.min(0.95, b.stress + (1.0 - dist / (blastR * 2.0)) * 0.5);
        }
      }
    }

    if (stageIdx === 5) {
      sim.voronoiFlash = 1.0;
      sim.voronoiOrigin = [hitPos[0], hitPos[1], hitPos[2]];
    }

    // Trigger Structural Stress Graph Solver on Stage 4 (Guerrilla), Stage 5 (Voronoi), and Stage 7 (The Finals)
    if (stageIdx === 4 || stageIdx === 5 || stageIdx === 7) {
      solveStructuralStress(stageIdx === 4 ? 0.34 : 0.24);
    }

    // Emit GPU debris cascade (scales smoothly across eras — 8,192 capacity in WebGPU!)
    const emitCounts = [0, 90, 260, 320, 640, 820, 1400, 2200];
    const emitCount = emitCounts[stageIdx] || 400;
    if (emitCount > 0) {
      sim.gpuEmitQueue.push({
        pos: hitPos,
        radius: blastR,
        power: power * (stageIdx === 7 ? 1.35 : 1.0),
        count: emitCount,
        stage: stageIdx,
      });
    }
  }

  function fireShell(targetPos, radius = 1.35, power = 1.0) {
    emitSfx({ type: "shellLaunch", stage: stageIdx });
    // Launch glowing shell from front-left/camera direction with crisp 0.24 s travel arc
    const startPos = [
      targetPos[0] + (targetPos[0] < 0 ? -4.8 : 4.2),
      Math.max(1.2, targetPos[1] + 1.4),
      targetPos[2] + 6.4,
    ];
    sim.shells.push({
      start: startPos,
      target: [targetPos[0], targetPos[1], targetPos[2]],
      t: 0,
      dur: 0.24,
      radius,
      power,
    });
  }

  // Grok's killer button: blast out the front-left (+ front-right on 2nd press) load-bearing pillars!
  function removePillar() {
    const pillarHits = [
      [-1.28, 1.10,  1.28],
      [ 1.28, 1.15,  1.28],
      [-1.28, 1.15, -1.28],
    ];
    const idx = sim.blastCount % pillarHits.length;
    fireShell(pillarHits[idx], 1.48, 1.15);
  }

  function step(dt) {
    const clampedDt = Math.min(dt, 0.033);
    sim.age += clampedDt;
    if (sim.flashTime > 0) sim.flashTime = Math.max(0, sim.flashTime - clampedDt);
    if (sim.voronoiFlash > 0) sim.voronoiFlash = Math.max(0, sim.voronoiFlash - clampedDt * 1.45);
    if (sim.stressOverlayBoost > 0) sim.stressOverlayBoost = Math.max(0, sim.stressOverlayBoost - clampedDt * 0.22);

    // 1) Update approaching artillery shells
    for (let i = sim.shells.length - 1; i >= 0; i--) {
      const sh = sim.shells[i];
      sh.t += clampedDt;
      if (sh.t >= sh.dur) {
        sim.shells.splice(i, 1);
        applyBlast(sh.target, sh.radius, sh.power, "shell");
      }
    }

    // 2) Update structural blocks (cracking -> tipping collapse -> ground bounce + shatter!)
    const grav = -18.5;
    for (const b of sim.blocks) {
      if (b.crackGlow > 0) b.crackGlow = Math.max(0, b.crackGlow - clampedDt * 1.4);

      if (b.state === "cracking") {
        b.crackTimer -= clampedDt;
        // Visible pre-collapse shudder before snapping!
        b.x = b.hx + (rng() - 0.5) * 0.025;
        b.z = b.hz + (rng() - 0.5) * 0.025;
        if (b.crackTimer <= 0) {
          b.state = "dynamic";
          // Tilt dramatically toward the blown-out corner pillar!
          const lx = b._leanX || -1.0;
          const lz = b._leanZ || 1.0;
          const hFactor = Math.max(0.3, (b.hy - 1.5) * 0.45);
          b.vx = lx * (1.25 * hFactor) + (rng() - 0.5) * 0.8;
          b.vy = -0.5 + (rng() - 0.5) * 0.5;
          b.vz = lz * (1.25 * hFactor) + (rng() - 0.5) * 0.8;
          b.wx = lz * (1.35 + rng() * 0.6);
          b.wy = (rng() - 0.5) * 1.2;
          b.wz = -lx * (1.35 + rng() * 0.6);
        }
      } else if (b.state === "dynamic") {
        // Release structural load stress smoothly once the block snaps free so fallen rubble looks photorealistic!
        if (b.stress > 0) b.stress = Math.max(0, b.stress - clampedDt * 2.2);
        b.vy += grav * clampedDt;
        b.x += b.vx * clampedDt;
        b.y += b.vy * clampedDt;
        b.z += b.vz * clampedDt;
        b.rx += b.wx * clampedDt;
        b.ry += b.wy * clampedDt;
        b.rz += b.wz * clampedDt;

        // Ground collision with realistic bounce & rubble-pile friction
        const floorY = Math.min(b.sx, b.sy, b.sz) * 0.52;
        if (b.y < floorY) {
          const impactSpd = -b.vy;
          b.y = floorY;
          if (impactSpd > 6.5 && (stageIdx === 4 || stageIdx === 7)) {
            emitSfx({ type: "rubbleCrash", stage: stageIdx });
            // Secondary collapse shatter + sunlit dust burst when upper slabs slam into the plaza!
            spawnDust(b.x, 0.28, b.z, 3, 0.68, false);
            sim.gpuEmitQueue.push({
              pos: [b.x, 0.35, b.z],
              radius: 0.9,
              power: 0.62,
              count: stageIdx === 7 ? 120 : 32,
              stage: stageIdx,
            });
          }
          b.vy = impactSpd * 0.28;
          if (b.vy < 0.45) b.vy = 0;
          b.vx *= 0.68;
          b.vz *= 0.68;
          b.wx *= 0.60;
          b.wy *= 0.60;
          b.wz *= 0.60;
        }
      }
    }

    // 3) Update shards / Voronoi wedges / Half-Life gibs / Detached voxel islands
    for (let i = sim.shards.length - 1; i >= 0; i--) {
      const s = sim.shards[i];
      s.age += clampedDt;
      if (s.staticRebar) continue;

      s.vy += grav * clampedDt;
      s.x += s.vx * clampedDt;
      s.y += s.vy * clampedDt;
      s.z += s.vz * clampedDt;
      s.rx += s.wx * clampedDt;
      s.ry += s.wy * clampedDt;
      s.rz += s.wz * clampedDt;

      const floorY = Math.min(s.sx, s.sy, s.sz) * 0.48;
      if (s.y < floorY) {
        if (s.noBounce) {
          // 1998 Half-Life: gibs freeze/sink flat or vanish cleanly after hitting floor
          s.y = floorY;
          s.vx *= 0.2; s.vy = 0; s.vz *= 0.2;
          s.wx = 0; s.wy = 0; s.wz = 0;
          if (s.age > 3.2) sim.shards.splice(i, 1);
        } else {
          const imp = -s.vy;
          s.y = floorY;
          if (s.isVoxelIsland && imp > 5.0) {
            spawnDust(s.x, 0.25, s.z, 3, 0.55, false);
            sim.gpuEmitQueue.push({ pos: [s.x, 0.3, s.z], radius: 0.75, power: 0.55, count: 140, stage: 6 });
          }
          s.vy = imp * 0.34;
          if (s.vy < 0.4) s.vy = 0;
          s.vx *= 0.72;
          s.vz *= 0.72;
          s.wx *= 0.65;
          s.wy *= 0.65;
          s.wz *= 0.65;
        }
      }
    }
    if (sim.shards.length > 520) sim.shards.splice(0, sim.shards.length - 520);

    // 4) Update volumetric dust & shockwave plumes
    for (let i = sim.dust.length - 1; i >= 0; i--) {
      const d = sim.dust[i];
      d.age += clampedDt;
      if (d.age >= d.maxAge) {
        sim.dust.splice(i, 1);
        continue;
      }
      if (d.kind === 2) {
        d.scale += clampedDt * 12.5;
      } else {
        d.x += d.vx * clampedDt;
        d.y += d.vy * clampedDt;
        d.z += d.vz * clampedDt;
        d.vx *= 0.94;
        d.vz *= 0.94;
        d.vy = d.vy * 0.95 + (d.kind === 1 ? 0.8 : 0.35) * clampedDt;
        d.scale += clampedDt * (d.kind === 1 ? 1.8 : 0.85);
      }
    }
  }

  // Pack all active structural blocks + shards + flying cannonballs into a flat 16-float/instance buffer.
  // Layout (64 bytes = 4 x vec4f):
  //   v0: pos.xyz, matId
  //   v1: rot.xyz, shapeType (0=block, 1=voronoi, 2=bentBeam, 3=cannonball)
  //   v2: scale.xyz, stress
  //   v3: seed, bendAmt, crackGlow, age
  function packInstances(outFloat32, maxCount, forceStressView = false) {
    let count = 0;

    function push(x, y, z, mat, rx, ry, rz, shape, sx, sy, sz, stress, seed, bend, crack, age) {
      if (count >= maxCount) return;
      const o = count * 16;
      outFloat32[o + 0] = x; outFloat32[o + 1] = y; outFloat32[o + 2] = z; outFloat32[o + 3] = mat;
      outFloat32[o + 4] = rx; outFloat32[o + 5] = ry; outFloat32[o + 6] = rz; outFloat32[o + 7] = shape;
      outFloat32[o + 8] = sx; outFloat32[o + 9] = sy; outFloat32[o + 10] = sz; outFloat32[o + 11] = stress;
      outFloat32[o + 12] = seed; outFloat32[o + 13] = bend; outFloat32[o + 14] = crack; outFloat32[o + 15] = age;
      count++;
    }

    // Stages 1 (Geo-Mod CSG) and 6 (Teardown Voxels) raymarch the intact tower in Pass 1!
    // All other stages rasterize the structural blocks in Pass 2.
    if (stageIdx !== 1 && stageIdx !== 6) {
      const showStress = forceStressView || sim.stressOverlayBoost > 0.05;
      for (let i = 0; i < sim.blocks.length; i++) {
        const b = sim.blocks[i];
        if (b.state === "gone") continue;
        const mat = stageIdx === 0 && b.mat === 0 ? 8 : b.mat;
        const stressOut = showStress
          ? Math.max(b.stress, forceStressView ? 0.14 : 0.0)
          : (b.state === "cracking" ? b.stress : 0.0);
        const crackOut = stageIdx === 5 ? Math.max(b.crackGlow, sim.voronoiFlash * 0.85) : b.crackGlow * 0.4;
        push(
          b.x, b.y, b.z, mat,
          b.rx, b.ry, b.rz, b.shape,
          b.sx, b.sy, b.sz, stressOut,
          b.seed, b.bendAmt, crackOut, 0
        );
      }
    }

    // Pack dynamic shards, Voronoi wedges, detached voxel islands, Half-Life gibs, exposed rebar
    for (let i = 0; i < sim.shards.length; i++) {
      const s = sim.shards[i];
      push(
        s.x, s.y, s.z, s.mat,
        s.rx, s.ry, s.rz, s.shape,
        s.sx, s.sy, s.sz, 0.0,
        s.seed, s.bendAmt, 0.0, s.age
      );
    }

    // Pack flying artillery cannonballs (emissive glowing orange shell + trail bead)
    for (let i = 0; i < sim.shells.length; i++) {
      const sh = sim.shells[i];
      const u = Math.min(1, sh.t / sh.dur);
      const px = sh.start[0] + (sh.target[0] - sh.start[0]) * u;
      const py = sh.start[1] + (sh.target[1] - sh.start[1]) * u + Math.sin(u * Math.PI) * 0.55;
      const pz = sh.start[2] + (sh.target[2] - sh.start[2]) * u;
      push(px, py, pz, 6, 0, 0, 0, 3, 0.34, 0.34, 0.34, 0, 0.5, 0, 0, 0);
      // Glowing trail bead behind shell
      const u2 = Math.max(0, u - 0.12);
      const tx = sh.start[0] + (sh.target[0] - sh.start[0]) * u2;
      const ty = sh.start[1] + (sh.target[1] - sh.start[1]) * u2 + Math.sin(u2 * Math.PI) * 0.55;
      const tz = sh.start[2] + (sh.target[2] - sh.start[2]) * u2;
      push(tx, ty, tz, 6, 0, 0, 0, 3, 0.19, 0.19, 0.19, 0, 0.2, 0, 0, 0);
    }

    return count;
  }

  reset();

  return {
    sim,
    reset,
    fireShell,
    applyBlast,
    removePillar,
    step,
    packInstances,
  };
}

// High-level FX Lab controller managing dual synchronized stage sims (for live Split-Screen!),
// auto-demo impact choreography, click-to-blast, Remove Pillar!, Stress View toggle, and tech badges.
export function createDestructionController(backendName, voxelDims) {
  const sims = new Map();
  let stressView = false;
  let autoClock = 0;
  let userCooldown = 0;
  let shot1Done = false;
  let shot2Done = false;
  let activeStageL = 1;
  let activeStageR = 4;

  function getSim(stage) {
    if (!sims.has(stage)) {
      sims.set(stage, createStageSim(stage, voxelDims));
    }
    return sims.get(stage);
  }

  function resetActive() {
    getSim(activeStageL).reset();
    if (activeStageR !== activeStageL) getSim(activeStageR).reset();
    autoClock = 0;
    shot1Done = false;
    shot2Done = false;
  }

  function dispatchBoth(fn) {
    fn(getSim(activeStageL));
    if (activeStageR !== activeStageL) fn(getSim(activeStageR));
  }

  return {
    getSim,
    isStressView: () => stressView,
    setActiveStages(sL, sR) {
      if (sL !== activeStageL || sR !== activeStageR) {
        activeStageL = sL;
        activeStageR = sR;
        resetActive();
      }
    },
    enterStep(stepIdx) {
      stressView = stepIdx === 4; // Highlight live structural stress heatmap automatically on Step 5 (Guerrilla)!
      userCooldown = 0;
      autoClock = 0;
      shot1Done = false;
      shot2Done = false;
      for (const s of sims.values()) s.reset();
    },
    onReset() {
      userCooldown = 0;
      resetActive();
    },
    triggerAction(actionId) {
      if (actionId === "stress") {
        stressView = !stressView;
      } else if (actionId === "pillar") {
        userCooldown = 10.0;
        dispatchBoth(s => s.removePillar());
      } else if (actionId === "blast") {
        userCooldown = 10.0;
        const targets = [
          [-1.28, 1.15, 1.28],
          [ 0.15, 3.65, 1.32],
          [ 1.28, 1.20, 1.28],
          [-0.45, 2.55, 1.32],
        ];
        const simR = getSim(activeStageR).sim;
        const tgt = targets[simR.blastCount % targets.length];
        dispatchBoth(s => s.fireShell(tgt, 1.44, 1.12));
      } else if (actionId === "rebuild") {
        userCooldown = 0;
        resetActive();
      }
    },
    isActionActive(actionId) {
      return actionId === "stress" ? stressView : false;
    },
    onCanvasClick(ndcX, ndcY, w, h, step, cam) {
      const hit = pickBlastPoint(ndcX, ndcY, cam, w / Math.max(1, h));
      userCooldown = 11.0;
      dispatchBoth(s => s.fireShell(hit, 1.42, 1.12));
    },
    update(dt, paused) {
      if (paused) return;
      const cdt = Math.min(dt, 0.033);
      if (userCooldown > 0) {
        userCooldown = Math.max(0, userCooldown - cdt);
      } else {
        autoClock += cdt;
        // Rhythmic auto-demolition choreography:
        //  t = 0.45s: Blast #1 knocks out the front-left corner load-bearing pillar!
        //  t = 2.45s: Blast #2 knocks out the front-right pillar / upper masonry wall!
        //  t = 9.80s: Cleanly rebuild watchtower and repeat!
        if (!shot1Done && autoClock >= 0.45) {
          shot1Done = true;
          const r1 = (activeStageR === 6 || activeStageL === 6) ? 1.62 : 1.48;
          dispatchBoth(s => s.fireShell([-1.28, 1.12, 1.28], r1, 1.14));
        }
        if (!shot2Done && autoClock >= 2.45) {
          shot2Done = true;
          const t2 = (activeStageR === 3)
            ? [0.05, 1.65, 1.34] // Hit front girders & glass directly in 2008 DMM stage!
            : [1.28, 1.25, 1.28]; // Knock out 2nd corner pillar -> dramatic collapse vs Geo-Mod hover!
          const r2 = (activeStageR === 6 || activeStageL === 6) ? 1.68 : 1.46;
          dispatchBoth(s => s.fireShell(t2, r2, 1.16));
        }
        if (autoClock >= 9.8) {
          resetActive();
        }
      }

      getSim(activeStageL).step(cdt);
      if (activeStageR !== activeStageL) getSim(activeStageR).step(cdt);
    },
    getTechBadge(stepIdx) {
      const isGPU = backendName === "webgpu";
      const badges = [
        "1998 · HALF-LIFE FUNC_BREAKABLE",
        "2001 · RED FACTION GEO-MOD CSG",
        "2003 · MAX PAYNE 2 HAVOK DEBRIS",
        "2008 · BAD COMPANY & FORCE UNLEASHED DMM",
        "2009 · RED FACTION GUERRILLA STRESS GRAPH",
        "2013–19 · REAL-TIME VORONOI FRACTURE",
        isGPU ? "2020–22 · TEARDOWN 165K VOXELS · WEBGPU" : "2020–22 · TEARDOWN 49K VOXELS · WEBGL2",
        isGPU ? "2023 · THE FINALS · WEBGPU 8,192 DEBRIS" : "2023 · THE FINALS · WEBGL2 1,024 DEBRIS",
      ];
      return badges[stepIdx] || badges[7];
    },
  };
}
