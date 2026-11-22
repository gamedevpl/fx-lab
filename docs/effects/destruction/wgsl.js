// WGSL compute & render shaders for Evolution of Destruction & Fracturing (1998-2023) on WebGPU.
// Genuine GPU compute passes:
//   - DEBRIS_EMIT_WGSL: spawns up to 8,192 instanced PBR debris chunks, Voronoi micro-chips & sparks on GPU
//   - DEBRIS_SIM_WGSL:  60 FPS GPU rigid-body debris gravity, spin, rubble bounce & Coulomb friction
//   - VOXEL_CARVE_WGSL: 48x72x48 (165,888 voxels) 3D storage buffer blast carving & soot charring
// Render passes:
//   - ENV_RAYMARCH_WGSL: Sky, sunlit flagstone plaza, exact Geo-Mod CSG SDF & 48x72x48 DDA Voxel Raymarcher
//   - BLOCK_PBR_WGSL:    Hardware-instanced adaptive PBR masonry, bent DMM girders, Voronoi shards & 8,192 GPU debris
//   - DUST_PLUME_WGSL:   Depth-tested alpha-blended blast flash, shockwave rings & sunlit masonry dust plumes

export const DEBRIS_EMIT_WGSL = /* wgsl */`
struct Debris {
  v0: vec4f, // pos.xyz, matId
  v1: vec4f, // rot.xyz, shapeType
  v2: vec4f, // scale.xyz, life (<=0 dead)
  v3: vec4f, // vel.xyz, spinSeed
};

struct EmitUniforms {
  u0: vec4f, // hitPos.xyz, radius
  u1: vec4f, // power, startIdx, emitCount, seed
  u2: vec4f, // stage, resetFlag, 0, 0
};

@group(0) @binding(0) var<uniform> E: EmitUniforms;
@group(0) @binding(1) var<storage, read_write> debris: array<Debris>;

fn hash11(p: f32) -> f32 {
  let x = fract(p * 0.1031);
  let y = x * (x + 33.33);
  return fract(y * (y + y));
}

fn hash31(p: f32) -> vec3f {
  var p3 = fract(vec3f(p) * vec3f(0.1031, 0.1030, 0.0973));
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.xxy + p3.yzz) * p3.zyx);
}

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let idx = gid.x;
  let total = arrayLength(&debris);

  if (E.u2.y > 0.5) {
    if (idx < total) {
      debris[idx].v2 = vec4f(0.0, 0.0, 0.0, 0.0);
    }
    return;
  }

  let emitCount = u32(E.u1.z);
  if (idx >= emitCount) { return; }

  let slot = (u32(E.u1.y) + idx) % total;
  let stage = i32(E.u2.x + 0.5);
  let h = hash31(f32(idx) * 1.371 + E.u1.w * 91.7);
  let h2 = hash31(f32(idx) * 2.913 + E.u1.w * 47.3 + 11.1);

  // Spherical blast distribution biased outward from tower center
  let theta = h.x * 6.2831853;
  let cosPhi = h.y * 2.0 - 1.0;
  let sinPhi = sqrt(max(0.0, 1.0 - cosPhi * cosPhi));
  let dir = vec3f(sinPhi * cos(theta), cosPhi, sinPhi * sin(theta));

  let rad = E.u0.w * pow(h.z, 0.45);
  var pos = E.u0.xyz + dir * rad * 0.62;
  pos.y = max(0.14, pos.y);

  let isSpark = h2.x > (select(0.84, 0.74, stage == 7));
  let spd = (2.8 + h2.y * 9.5) * E.u1.x * select(1.0, 1.65, isSpark);
  var vel = dir * spd + vec3f(0.0, 2.2 + h2.z * 4.2, 0.0);
  // Push slightly outward from tower origin so debris showers visibly across the plaza
  let outXZ = normalize(vec2f(E.u0.x, E.u0.z) + vec2f(0.001, 0.002));
  vel.x += outXZ.x * (1.6 + h2.y * 2.4);
  vel.z += outXZ.y * (1.6 + h2.y * 2.4);

  var scale = vec3f(0.11, 0.075, 0.095) * (0.55 + h2.z * 1.15);
  var matId = 0.0; // terracotta brick
  var shapeType = 0.0;

  if (isSpark) {
    matId = 6.0; // glowing fiery ember spark
    scale = vec3f(0.055, 0.055, 0.055) * (0.65 + h.x * 0.8);
  } else if (stage == 6) {
    // Crisp uniform micro-voxel cubes for Teardown!
    let vs = 0.072 + h2.z * 0.048;
    scale = vec3f(vs, vs, vs);
    if (h.x < 0.46) { matId = 0.0; }
    else if (h.x < 0.74) { matId = 1.0; }
    else if (h.x < 0.88) { matId = 5.0; }
    else { matId = 2.0; }
  } else {
    if (h.x < 0.44) { matId = 0.0; }
    else if (h.x < 0.72) { matId = 1.0; }
    else if (h.x < 0.85) { matId = 7.0; }
    else if (h.x < 0.93) { matId = 4.0; }
    else { matId = 5.0; }
    if (stage == 5 || stage == 7) {
      shapeType = select(0.0, 1.0, h2.y > 0.32); // jagged Voronoi micro-shards!
    }
  }

  let life = select(4.5 + h.y * 4.5, 0.55 + h.y * 0.75, isSpark);
  debris[slot].v0 = vec4f(pos, matId);
  debris[slot].v1 = vec4f(h * 6.2831, shapeType);
  debris[slot].v2 = vec4f(scale, life);
  debris[slot].v3 = vec4f(vel, h2.x);
}
`;

export const DEBRIS_SIM_WGSL = /* wgsl */`
struct Debris {
  v0: vec4f, // pos.xyz, matId
  v1: vec4f, // rot.xyz, shapeType
  v2: vec4f, // scale.xyz, life
  v3: vec4f, // vel.xyz, spinSeed
};

struct SimUniforms {
  u0: vec4f, // dt, time, gravity, 0
};

@group(0) @binding(0) var<uniform> S: SimUniforms;
@group(0) @binding(1) var<storage, read_write> debris: array<Debris>;

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let idx = gid.x;
  if (idx >= arrayLength(&debris)) { return; }

  var d = debris[idx];
  var life = d.v2.w;
  if (life <= 0.0) { return; }

  let dt = S.u0.x;
  life = max(0.0, life - dt);
  if (life <= 0.0) {
    d.v2.w = 0.0;
    debris[idx] = d;
    return;
  }

  var pos = d.v0.xyz;
  var rot = d.v1.xyz;
  var vel = d.v3.xyz;
  let matId = d.v0.w;
  let isSpark = matId > 5.5 && matId < 6.5;

  let grav = select(-19.2, -11.5, isSpark);
  vel.y += grav * dt;
  if (isSpark) {
    vel *= max(0.0, 1.0 - 1.35 * dt);
  }
  pos += vel * dt;

  // Spin proportional to linear speed
  let spd = length(vel);
  let spinBase = 1.6 + d.v3.w * 4.2;
  if (spd > 0.25) {
    rot += vec3f(spinBase, spinBase * 0.77, -spinBase * 0.91) * dt * min(2.2, spd * 0.35);
  }

  // Ground collision with slight rubble-pile mound near tower base
  let rXZ = length(pos.xz);
  let mound = exp(-rXZ * rXZ * 0.14) * 0.05;
  let floorY = max(d.v2.y, d.v2.x) * 0.45 + mound;
  if (pos.y < floorY) {
    pos.y = floorY;
    if (vel.y < -0.55) {
      vel.y = -vel.y * select(0.34, 0.52, isSpark);
    } else {
      vel.y = 0.0;
    }
    vel.x *= 0.74;
    vel.z *= 0.74;
  }

  d.v0 = vec4f(pos, matId);
  d.v1 = vec4f(rot, d.v1.w);
  d.v2 = vec4f(d.v2.xyz, life);
  d.v3 = vec4f(vel, d.v3.w);
  debris[idx] = d;
}
`;

export const VOXEL_CARVE_WGSL = /* wgsl */`
struct CarveUniforms {
  u0: vec4f, // hitPos.xyz, radius
  u1: vec4f, // minX, minY, minZ, 0
  u2: vec4f, // spanX, spanY, spanZ, 0
  u3: vec4u, // nx, ny, nz, 0
};

@group(0) @binding(0) var<uniform> C: CarveUniforms;
@group(0) @binding(1) var<storage, read_write> voxels: array<u32>;

@compute @workgroup_size(4, 4, 4)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let nx = C.u3.x;
  let ny = C.u3.y;
  let nz = C.u3.z;
  if (gid.x >= nx || gid.y >= ny || gid.z >= nz) { return; }

  let idx = gid.x + gid.y * nx + gid.z * nx * ny;
  let mat = voxels[idx];
  if (mat == 0u) { return; }

  let uvw = (vec3f(gid) + 0.5) / vec3f(f32(nx), f32(ny), f32(nz));
  let wp = C.u1.xyz + uvw * C.u2.xyz;
  let dist = length(wp - C.u0.xyz);

  let h = fract(sin(f32(gid.x) * 12.9898 + f32(gid.y) * 78.233 + f32(gid.z) * 37.719) * 43758.5453);
  let effR = C.u0.w + (h - 0.5) * 0.28 * C.u0.w;
  if (dist < effR) {
    voxels[idx] = 0u;
  } else if (dist < effR + 0.20) {
    voxels[idx] = 7u;
  }
}
`;

export const ENV_RAYMARCH_WGSL = /* wgsl */`
struct FrameUniforms {
  viewProj: mat4x4f,
  camPos: vec4f,      // xyz, tanHalf
  camFwd: vec4f,      // xyz, aspect
  camRight: vec4f,    // xyz, time
  camUp: vec4f,       // xyz, stage
  flash: vec4f,       // flashPos.xyz, flashIntensity
  extra: vec4f,       // craterCount, stressView, voronoiFlash, isSplitSide
  voxMin: vec4f,      // minX, minY, minZ, nx
  voxSpan: vec4f,     // spanX, spanY, spanZ, ny
  voxExtra: vec4f,    // nz, 0, 0, 0
  craters: array<vec4f, 16>,
};

@group(0) @binding(0) var<uniform> U: FrameUniforms;
@group(0) @binding(1) var<storage, read> voxels: array<u32>;

struct VsOut {
  @builtin(position) pos: vec4f,
  @location(0) uv: vec2f,
};

@vertex
fn vsMain(@builtin(vertex_index) vid: u32) -> VsOut {
  var pts = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  var o: VsOut;
  o.pos = vec4f(pts[vid], 0.9999, 1.0);
  o.uv = pts[vid] * 0.5 + 0.5;
  return o;
}

const SUN_DIR: vec3f = vec3f(0.58, 0.72, 0.38);

fn hash3(p: vec3f) -> f32 {
  return fract(sin(dot(p, vec3f(12.9898, 78.233, 37.719))) * 43758.5453);
}

fn sdBox(p: vec3f, b: vec3f) -> f32 {
  let q = abs(p) - b;
  return length(max(q, vec3f(0.0))) + min(max(q.x, max(q.y, q.z)), 0.0);
}

// Watchtower CSG SDF for Stage 1 (2001 Red Faction Geo-Mod)
fn towerCSG(p: vec3f) -> vec2f {
  // Outer tower shell + corner pillars + parapet roof
  let outerBox = sdBox(p - vec3f(0.0, 2.65, 0.0), vec3f(1.56, 2.65, 1.56));
  let innerVoid = sdBox(p - vec3f(0.0, 2.50, 0.0), vec3f(1.08, 2.38, 1.08));
  let midSlab = sdBox(p - vec3f(0.0, 2.61, 0.0), vec3f(1.58, 0.14, 1.58));
  let roofSlab = sdBox(p - vec3f(0.0, 5.22, 0.0), vec3f(1.62, 0.14, 1.62));

  // Corner pillars slightly protruding
  let ap = abs(p.xz) - vec2f(1.28, 1.28);
  let pillars = sdBox(vec3f(ap.x, p.y - 2.62, ap.y), vec3f(0.34, 2.62, 0.34));

  // Doorway & upper window cutouts
  let doorCut = sdBox(p - vec3f(0.0, 1.08, 1.38), vec3f(0.45, 1.08, 0.45));
  let winZ = sdBox(vec3f(p.x, p.y - 4.08, abs(p.z) - 1.38), vec3f(0.40, 0.68, 0.45));
  let winX = sdBox(vec3f(abs(p.x) - 1.38, p.y - 4.08, p.z), vec3f(0.45, 0.68, 0.40));

  var d = max(outerBox, -innerVoid);
  d = min(d, midSlab);
  d = min(d, roofSlab);
  d = min(d, pillars);
  d = max(d, -doorCut);
  d = max(d, -winZ);
  d = max(d, -winX);

  // Parapet corner merlons
  let mp = abs(p.xz) - vec2f(1.36, 1.36);
  let merlon = sdBox(vec3f(mp.x, p.y - 5.50, mp.y), vec3f(0.28, 0.20, 0.28));
  d = min(d, merlon);

  var mat = 0.0; // terracotta brick
  if (pillars < outerBox + 0.04 || abs(p.y - 2.61) < 0.16) { mat = 1.0; } // concrete
  if (p.y > 5.08) { mat = 2.0; } // dark slate roof

  // Subtract Geo-Mod CSG blast craters with jagged rock interior!
  let nCrat = i32(U.extra.x + 0.5);
  for (var i = 0; i < 16; i++) {
    if (i >= nCrat) { break; }
    let c = U.craters[i];
    let rel = p - c.xyz;
    let rough = (sin(rel.x * 9.5) * cos(rel.y * 10.2) * sin(rel.z * 9.1)) * 0.12 * c.w;
    let cd = length(rel) - (c.w + rough);
    if (-cd > d) {
      d = -cd;
      mat = 5.0; // charred blasted CSG cavity interior!
    }
  }
  return vec2f(d, mat);
}

fn calcCSGNormal(p: vec3f) -> vec3f {
  let e = vec2f(0.008, -0.008);
  return normalize(
    e.xyy * towerCSG(p + e.xyy).x +
    e.yyx * towerCSG(p + e.yyx).x +
    e.yxy * towerCSG(p + e.yxy).x +
    e.xxx * towerCSG(p + e.xxx).x
  );
}

fn getVoxel(ix: i32, iy: i32, iz: i32) -> u32 {
  let nx = i32(U.voxMin.w);
  let ny = i32(U.voxSpan.w);
  let nz = i32(U.voxExtra.x);
  if (ix < 0 || iy < 0 || iz < 0 || ix >= nx || iy >= ny || iz >= nz) {
    return 0u;
  }
  return voxels[u32(ix + iy * nx + iz * nx * ny)];
}

fn voxMatColor(m: u32, cell: vec3i) -> vec3f {
  let jitter = (hash3(vec3f(cell)) - 0.5) * 0.06;
  if (m == 1u) { return vec3f(0.76, 0.34, 0.21) + jitter; }      // terracotta brick
  if (m == 2u) { return vec3f(0.68, 0.44, 0.31) + jitter; }      // warm brick mortar variation
  if (m == 3u) { return vec3f(0.79, 0.75, 0.67) + jitter * 0.7; } // warm poured concrete
  if (m == 4u) { return vec3f(0.24, 0.27, 0.33) + jitter * 0.5; } // dark slate roof
  if (m == 5u) { return vec3f(0.28, 0.68, 0.84); }                // cyan glass
  if (m == 6u) { return vec3f(0.29, 0.32, 0.37); }                // dark steel rebar
  if (m == 7u) { return vec3f(0.14, 0.13, 0.12) + jitter * 0.4; } // charred blast soot!
  if (m == 8u) { return vec3f(0.42, 0.26, 0.16); }                // timber lintel
  return vec3f(1.0, 0.34, 0.16);                                  // glowing red rooftop beacon
}

// Fast 3D DDA shadow ray through the 48x72x48 voxel volume
fn voxShadowRay(ro: vec3f, rd: vec3f) -> f32 {
  let dims = vec3f(U.voxMin.w, U.voxSpan.w, U.voxExtra.x);
  let gridPos = (ro - U.voxMin.xyz) / U.voxSpan.xyz * dims;
  var cell = vec3i(floor(gridPos));
  let stepDir = vec3i(select(-1, 1, rd.x >= 0.0), select(-1, 1, rd.y >= 0.0), select(-1, 1, rd.z >= 0.0));
  let invRd = 1.0 / (rd / U.voxSpan.xyz * dims + vec3f(1e-6));
  let nextB = (vec3f(cell) + select(vec3f(0.0), vec3f(1.0), rd >= vec3f(0.0)) - gridPos) * invRd;
  var tMax = nextB;
  let tDelta = abs(invRd);

  for (var i = 0; i < 48; i++) {
    if (tMax.x < tMax.y) {
      if (tMax.x < tMax.z) { cell.x += stepDir.x; tMax.x += tDelta.x; }
      else { cell.z += stepDir.z; tMax.z += tDelta.z; }
    } else {
      if (tMax.y < tMax.z) { cell.y += stepDir.y; tMax.y += tDelta.y; }
      else { cell.z += stepDir.z; tMax.z += tDelta.z; }
    }
    if (cell.x < 0 || cell.y < 0 || cell.z < 0 ||
        cell.x >= i32(dims.x) || cell.y >= i32(dims.y) || cell.z >= i32(dims.z)) {
      return 1.0;
    }
    if (getVoxel(cell.x, cell.y, cell.z) != 0u) {
      return 0.24;
    }
  }
  return 1.0;
}

fn skyColor(rd: vec3f) -> vec3f {
  let sun = normalize(SUN_DIR);
  let h = clamp(rd.y, 0.0, 1.0);
  var col = mix(vec3f(0.56, 0.66, 0.78), vec3f(0.14, 0.34, 0.66), pow(h, 0.45));
  col = mix(col, vec3f(0.06, 0.14, 0.34), smoothstep(0.28, 0.88, h));
  let sDot = max(0.0, dot(rd, sun));
  col += vec3f(1.0, 0.74, 0.42) * pow(sDot, 10.0) * 0.45;
  col += vec3f(1.0, 0.94, 0.78) * smoothstep(0.996, 0.9994, sDot) * 1.4;
  return col;
}

fn worldToDepth(wp: vec3f) -> f32 {
  let clip = U.viewProj * vec4f(wp, 1.0);
  return clamp(clip.z / clip.w, 0.0, 0.9999);
}

struct FragOut {
  @location(0) color: vec4f,
  @builtin(frag_depth) depth: f32,
};

@fragment
fn fsMain(inp: VsOut) -> FragOut {
  var out: FragOut;
  let ndc = vec2f(inp.uv.x * 2.0 - 1.0, inp.uv.y * 2.0 - 1.0);
  let rd = normalize(
    U.camFwd.xyz +
    U.camRight.xyz * (ndc.x * U.camPos.w * U.camFwd.w) +
    U.camUp.xyz * (ndc.y * U.camPos.w)
  );
  let ro = U.camPos.xyz;
  let sun = normalize(SUN_DIR);
  let stage = i32(U.camUp.w + 0.5);

  var col = skyColor(rd);
  var bestT = 1e6;
  var hitPos = ro + rd * 80.0;
  var didHit = false;

  // 1) Ground sunlit flagstone plaza (y = 0)
  if (rd.y < -0.001) {
    let tg = -ro.y / rd.y;
    if (tg > 0.1 && tg < 85.0) {
      bestT = tg;
      hitPos = ro + rd * tg;
      didHit = true;

      // Crisp tiled Mediterranean limestone plaza
      let p = hitPos.xz;
      let tile = floor(p * 0.75);
      let tf = fract(p * 0.75);
      let grout = smoothstep(0.025, 0.055, min(min(tf.x, 1.0 - tf.x), min(tf.y, 1.0 - tf.y)));
      let tv = (hash3(vec3f(tile.x, 0.0, tile.y)) - 0.5) * 0.06;
      var base = mix(vec3f(0.26, 0.24, 0.23), vec3f(0.46, 0.43, 0.39) + tv, grout);

      // Subtle architectural target ring around watchtower pad
      let padBox = max(abs(p.x), abs(p.y));
      if (padBox < 2.25 && padBox > 1.85) {
        base *= 0.82;
      }

      // Blast ground scorch decals
      let nCrat = i32(U.extra.x + 0.5);
      for (var i = 0; i < 16; i++) {
        if (i >= nCrat) { break; }
        let c = U.craters[i];
        let gd = length(hitPos.xz - c.xz);
        let scorch = smoothstep(c.w * 1.45, 0.15, gd) * smoothstep(3.4, 0.2, c.y);
        base = mix(base, vec3f(0.14, 0.12, 0.11), scorch * 0.65);
      }

      // Analytical directional tower shadow onto plaza
      let shHit = hitPos + sun * (2.6 / sun.y);
      let towerShadow = smoothstep(1.95, 1.35, max(abs(hitPos.x - sun.x * 1.8), abs(hitPos.z - sun.z * 1.8)));
      var shadow = 1.0 - towerShadow * 0.42;
      if (stage == 6) {
        // Real DDA shadow cast from the live 48x72x48 voxel tower onto the plaza!
        let bmin = U.voxMin.xyz;
        let bmax = U.voxMin.xyz + U.voxSpan.xyz;
        let invS = 1.0 / (sun + vec3f(1e-6));
        let t0 = (bmin - (hitPos + vec3f(0.0, 0.02, 0.0))) * invS;
        let t1 = (bmax - (hitPos + vec3f(0.0, 0.02, 0.0))) * invS;
        let tNear = max(max(min(t0.x, t1.x), min(t0.y, t1.y)), min(t0.z, t1.z));
        let tFar = min(min(max(t0.x, t1.x), max(t0.y, t1.y)), max(t0.z, t1.z));
        if (tFar > max(0.0, tNear)) {
          let entry = hitPos + vec3f(0.0, 0.02, 0.0) + sun * (max(0.0, tNear) + 0.01);
          shadow = voxShadowRay(entry, sun);
        } else {
          shadow = 1.0;
        }
      }

      // Soft contact AO under watchtower footprint
      let footDist = max(0.0, max(abs(p.x) - 1.62, abs(p.y) - 1.62));
      let ao = 0.72 + 0.28 * smoothstep(0.0, 0.85, footDist);

      let lit = base * (vec3f(0.30, 0.36, 0.46) * ao + vec3f(1.08, 0.96, 0.82) * sun.y * shadow);
      // Warm blast flash bounce light on ground
      let fDist = length(hitPos - U.flash.xyz);
      let flashLit = vec3f(1.0, 0.56, 0.20) * (U.flash.w * 2.8 / (1.0 + fDist * fDist * 0.55));
      // Distance aerial fog
      let fog = smoothstep(24.0, 78.0, tg);
      col = mix(lit + flashLit, skyColor(vec3f(rd.x, 0.05, rd.z)), fog);
    }
  }

  // 2) Stage 1 (2001 Red Faction Geo-Mod): Exact Real-Time CSG Boolean Tower Raymarch
  if (stage == 1) {
    let bmin = vec3f(-1.72, 0.0, -1.72);
    let bmax = vec3f( 1.72, 5.75, 1.72);
    let invRd = 1.0 / (rd + vec3f(1e-6));
    let t0 = (bmin - ro) * invRd;
    let t1 = (bmax - ro) * invRd;
    let tNear = max(max(min(t0.x, t1.x), min(t0.y, t1.y)), min(t0.z, t1.z));
    let tFar = min(min(max(t0.x, t1.x), max(t0.y, t1.y)), max(t0.z, t1.z));
    if (tFar > max(0.0, tNear) && tNear < bestT) {
      var t = max(0.02, tNear);
      for (var stp = 0; stp < 72; stp++) {
        if (t > min(tFar, bestT)) { break; }
        let p = ro + rd * t;
        let res = towerCSG(p);
        if (res.x < 0.004) {
          bestT = t;
          hitPos = p;
          didHit = true;
          let n = calcCSGNormal(p);
          var alb = vec3f(0.76, 0.35, 0.22);
          if (res.y < 0.5) {
            // Running-bond brick pattern
            let row = floor(p.y * 5.2);
            let u = select(p.z, p.x, abs(n.z) > 0.5) * 2.4 + (row % 2.0) * 0.5;
            let bm = step(0.08, fract(p.y * 5.2)) * step(0.06, fract(u));
            alb = mix(vec3f(0.62, 0.58, 0.52), vec3f(0.77, 0.34, 0.21), bm);
          } else if (res.y < 1.5) {
            alb = vec3f(0.80, 0.76, 0.68);
          } else if (res.y < 2.5) {
            alb = vec3f(0.24, 0.27, 0.34);
          } else {
            // Charred Geo-Mod carved rock cavity!
            let grain = hash3(floor(p * 14.0)) * 0.14;
            alb = vec3f(0.22, 0.20, 0.19) + grain;
          }
          let ndl = max(0.0, dot(n, sun));
          let hemi = 0.5 + 0.5 * n.y;
          let amb = mix(vec3f(0.28, 0.25, 0.24), vec3f(0.38, 0.48, 0.64), hemi);
          let fDist = length(p - U.flash.xyz);
          let fLit = vec3f(1.0, 0.55, 0.2) * (U.flash.w * 2.4 / (1.0 + fDist * fDist * 0.6));
          col = alb * (amb * 0.72 + vec3f(1.15, 1.0, 0.85) * ndl) + fLit;
          break;
        }
        t += max(0.012, res.x * 0.88);
      }
    }
  }

  // 3) Stage 6 (2020-22 Teardown): Exact 48x72x48 3D DDA Voxel Raymarching + Voxel AO + Voxel Shadows!
  if (stage == 6) {
    let bmin = U.voxMin.xyz;
    let bmax = U.voxMin.xyz + U.voxSpan.xyz;
    let invRd = 1.0 / (rd + vec3f(1e-6));
    let t0 = (bmin - ro) * invRd;
    let t1 = (bmax - ro) * invRd;
    let tNear = max(max(min(t0.x, t1.x), min(t0.y, t1.y)), min(t0.z, t1.z));
    let tFar = min(min(max(t0.x, t1.x), max(t0.y, t1.y)), max(t0.z, t1.z));

    if (tFar > max(0.0, tNear) && tNear < bestT) {
      let tStart = max(0.001, tNear) + 0.0005;
      let dims = vec3f(U.voxMin.w, U.voxSpan.w, U.voxExtra.x);
      let entry = ro + rd * tStart;
      let gridPos = clamp((entry - bmin) / U.voxSpan.xyz * dims, vec3f(0.001), dims - vec3f(0.001));
      var cell = vec3i(floor(gridPos));
      let stepDir = vec3i(select(-1, 1, rd.x >= 0.0), select(-1, 1, rd.y >= 0.0), select(-1, 1, rd.z >= 0.0));
      let rdGrid = rd / U.voxSpan.xyz * dims;
      let invG = 1.0 / (rdGrid + vec3f(1e-6));
      var tMax = (vec3f(cell) + select(vec3f(0.0), vec3f(1.0), rd >= vec3f(0.0)) - gridPos) * invG;
      let tDelta = abs(invG);

      // Determine entry face normal
      var mask = vec3i(0, 0, 0);
      if (tNear > 0.0) {
        let m0 = min(t0, t1);
        if (m0.x > m0.y && m0.x > m0.z) { mask = vec3i(-stepDir.x, 0, 0); }
        else if (m0.y > m0.z) { mask = vec3i(0, -stepDir.y, 0); }
        else { mask = vec3i(0, 0, -stepDir.z); }
      }

      var tCur = tStart;
      for (var iter = 0; iter < 150; iter++) {
        if (cell.x < 0 || cell.y < 0 || cell.z < 0 ||
            cell.x >= i32(dims.x) || cell.y >= i32(dims.y) || cell.z >= i32(dims.z)) {
          break;
        }
        let m = getVoxel(cell.x, cell.y, cell.z);
        if (m != 0u) {
          if (tCur < bestT) {
            bestT = tCur;
            hitPos = ro + rd * tCur;
            didHit = true;

            let n = vec3f(mask);
            // Analytical 4-neighbor voxel Ambient Occlusion (signature Teardown crispness!)
            let nc = cell + mask;
            var occ = 0.0;
            if (mask.x != 0) {
              occ += f32(getVoxel(nc.x, nc.y + 1, nc.z) != 0u) + f32(getVoxel(nc.x, nc.y - 1, nc.z) != 0u) +
                     f32(getVoxel(nc.x, nc.y, nc.z + 1) != 0u) + f32(getVoxel(nc.x, nc.y, nc.z - 1) != 0u);
            } else if (mask.y != 0) {
              occ += f32(getVoxel(nc.x + 1, nc.y, nc.z) != 0u) + f32(getVoxel(nc.x - 1, nc.y, nc.z) != 0u) +
                     f32(getVoxel(nc.x, nc.y, nc.z + 1) != 0u) + f32(getVoxel(nc.x, nc.y, nc.z - 1) != 0u);
            } else {
              occ += f32(getVoxel(nc.x + 1, nc.y, nc.z) != 0u) + f32(getVoxel(nc.x - 1, nc.y, nc.z) != 0u) +
                     f32(getVoxel(nc.x, nc.y + 1, nc.z) != 0u) + f32(getVoxel(nc.x, nc.y - 1, nc.z) != 0u);
            }
            let voxAO = 1.0 - occ * 0.14;

            // Subtle micro-bevel darkening along voxel edges so every micro-voxel pops!
            let fracP = fract((hitPos - bmin) / U.voxSpan.xyz * dims);
            let edge2 = select(
              select(min(min(fracP.x, 1.0 - fracP.x), min(fracP.y, 1.0 - fracP.y)),
                     min(min(fracP.x, 1.0 - fracP.x), min(fracP.z, 1.0 - fracP.z)), mask.y != 0),
              min(min(fracP.y, 1.0 - fracP.y), min(fracP.z, 1.0 - fracP.z)),
              mask.x != 0
            );
            let bevel = 0.87 + 0.13 * smoothstep(0.0, 0.14, edge2);

            let ndl = max(0.0, dot(n, sun));
            let sh = select(0.35, voxShadowRay(hitPos + n * 0.04, sun), ndl > 0.01);
            let alb = voxMatColor(m, cell) * bevel;
            let hemi = 0.5 + 0.5 * n.y;
            let amb = mix(vec3f(0.30, 0.27, 0.25), vec3f(0.42, 0.54, 0.72), hemi) * voxAO;
            var c = alb * (amb * 0.76 + vec3f(1.22, 1.06, 0.88) * ndl * sh);
            if (m == 5u) {
              // Specular sky reflection on voxel glass
              let refl = reflect(rd, n);
              c = mix(c, skyColor(refl), 0.42);
            } else if (m == 9u) {
              c += vec3f(1.2, 0.25, 0.08);
            }
            let fDist = length(hitPos - U.flash.xyz);
            c += vec3f(1.0, 0.55, 0.2) * (U.flash.w * 2.5 / (1.0 + fDist * fDist * 0.6));
            col = c;
          }
          break;
        }

        if (tMax.x < tMax.y) {
          if (tMax.x < tMax.z) {
            tCur = tStart + tMax.x;
            cell.x += stepDir.x;
            tMax.x += tDelta.x;
            mask = vec3i(-stepDir.x, 0, 0);
          } else {
            tCur = tStart + tMax.z;
            cell.z += stepDir.z;
            tMax.z += tDelta.z;
            mask = vec3i(0, 0, -stepDir.z);
          }
        } else {
          if (tMax.y < tMax.z) {
            tCur = tStart + tMax.y;
            cell.y += stepDir.y;
            tMax.y += tDelta.y;
            mask = vec3i(0, -stepDir.y, 0);
          } else {
            tCur = tStart + tMax.z;
            cell.z += stepDir.z;
            tMax.z += tDelta.z;
            mask = vec3i(0, 0, -stepDir.z);
          }
        }
      }
    }
  }

  // ACES-like filmic tone curve + gamma 2.2
  let mapped = (col * (2.51 * col + 0.03)) / (col * (2.43 * col + 0.59) + 0.14);
  out.color = vec4f(pow(clamp(mapped, vec3f(0.0), vec3f(1.0)), vec3f(1.0 / 2.2)), 1.0);
  out.depth = select(0.9998, worldToDepth(hitPos), didHit);
  return out;
}
`;

export const BLOCK_PBR_WGSL = /* wgsl */`
struct FrameUniforms {
  viewProj: mat4x4f,
  camPos: vec4f,      // xyz, tanHalf
  camFwd: vec4f,      // xyz, aspect
  camRight: vec4f,    // xyz, time
  camUp: vec4f,       // xyz, stage
  flash: vec4f,       // flashPos.xyz, flashIntensity
  extra: vec4f,       // craterCount, stressView, voronoiFlash, isDebrisPass
  voxMin: vec4f,
  voxSpan: vec4f,
  voxExtra: vec4f,
  craters: array<vec4f, 16>,
};

struct Instance {
  v0: vec4f, // pos.xyz, matId
  v1: vec4f, // rot.xyz, shapeType
  v2: vec4f, // scale.xyz, stress (or life if isDebrisPass > 0.5)
  v3: vec4f, // seed/vel.x, bendAmt/vel.y, crackGlow/vel.z, age/spinSeed
};

@group(0) @binding(0) var<uniform> U: FrameUniforms;
@group(0) @binding(1) var<storage, read> instances: array<Instance>;

struct VsIn {
  @location(0) pos: vec3f,
  @location(1) nrm: vec3f,
  @location(2) uv: vec2f,
};

struct VsOut {
  @builtin(position) clipPos: vec4f,
  @location(0) wPos: vec3f,
  @location(1) wNrm: vec3f,
  @location(2) lPos: vec3f,
  @location(3) scale: vec3f,
  @location(4) info: vec4f,   // matId, stress, crackGlow, seed
  @location(5) shapeF: f32,
};

fn rotXYZ(v: vec3f, r: vec3f) -> vec3f {
  var p = v;
  let cx = cos(r.x); let sx = sin(r.x);
  p = vec3f(p.x, p.y * cx - p.z * sx, p.y * sx + p.z * cx);
  let cy = cos(r.y); let sy = sin(r.y);
  p = vec3f(p.x * cy + p.z * sy, p.y, -p.x * sy + p.z * cy);
  let cz = cos(r.z); let sz = sin(r.z);
  p = vec3f(p.x * cz - p.y * sz, p.x * sz + p.y * cz, p.z);
  return p;
}

@vertex
fn vsMain(inp: VsIn, @builtin(instance_index) iid: u32) -> VsOut {
  var o: VsOut;
  let inst = instances[iid];
  let isDebris = U.extra.w > 0.5;

  // Cull dead GPU debris particles outside clip space cleanly
  if (isDebris && inst.v2.w <= 0.001) {
    o.clipPos = vec4f(2.0, 2.0, 2.0, 1.0);
    return o;
  }

  let shape = inst.v1.w;
  let seed = select(inst.v3.x, inst.v3.w, isDebris);
  let bendAmt = select(inst.v3.y, 0.0, isDebris);
  var lp = inp.pos;
  var ln = inp.nrm;

  if (shape > 2.5) {
    // Shape 3: Smooth artillery cannonball sphere
    lp = normalize(inp.pos) * 0.5;
    ln = normalize(inp.pos);
  } else if (shape > 1.5) {
    // Shape 2: DMM plastic beam bending (quadratic arch along length!)
    let arch = (1.0 - 4.0 * lp.y * lp.y) * bendAmt * 0.42;
    let archX = (1.0 - 4.0 * lp.x * lp.x) * bendAmt * 0.28;
    lp.z += arch + archX;
  } else if (shape > 0.5) {
    // Shape 1: Asymmetric faceted Voronoi fracture wedge!
    let s1 = fract(seed * 17.31);
    let s2 = fract(seed * 41.73);
    let s3 = fract(seed * 73.19);
    // Taper & skew corners along deterministic Voronoi cutting planes
    let taperX = mix(0.28, 1.18, clamp(lp.y + 0.5 + (s1 - 0.5) * 0.5, 0.0, 1.0));
    let taperZ = mix(0.32, 1.15, clamp(lp.x + 0.5 + (s2 - 0.5) * 0.5, 0.0, 1.0));
    lp.x *= taperX;
    lp.z *= taperZ;
    lp.y += (lp.x * (s2 - 0.5) + lp.z * (s3 - 0.5)) * 0.58;
  }

  let scaled = lp * inst.v2.xyz;
  let wp = inst.v0.xyz + rotXYZ(scaled, inst.v1.xyz);
  let wn = normalize(rotXYZ(ln, inst.v1.xyz));

  o.clipPos = U.viewProj * vec4f(wp, 1.0);
  o.wPos = wp;
  o.wNrm = wn;
  o.lPos = lp * inst.v2.xyz;
  o.scale = inst.v2.xyz;
  o.info = vec4f(
    inst.v0.w,
    select(inst.v2.w, 0.0, isDebris),
    select(inst.v3.z, 0.0, isDebris),
    seed
  );
  o.shapeF = shape;
  return o;
}

const SUN_DIR: vec3f = vec3f(0.58, 0.72, 0.38);

fn hash3(p: vec3f) -> f32 {
  return fract(sin(dot(p, vec3f(12.9898, 78.233, 37.719))) * 43758.5453);
}

fn voronoiEdge(p: vec3f) -> f32 {
  let n = floor(p);
  let f = fract(p);
  var md1 = 8.0;
  var md2 = 8.0;
  for (var z = -1; z <= 1; z++) {
    for (var y = -1; y <= 1; y++) {
      for (var x = -1; x <= 1; x++) {
        let g = vec3f(f32(x), f32(y), f32(z));
        let o = vec3f(
          hash3(n + g),
          hash3(n + g + vec3f(17.1, 31.7, 11.3)),
          hash3(n + g + vec3f(43.2, 7.9, 29.4))
        );
        let r = g + o * 0.82 - f;
        let d = dot(r, r);
        if (d < md1) { md2 = md1; md1 = d; }
        else if (d < md2) { md2 = d; }
      }
    }
  }
  return sqrt(md2) - sqrt(md1);
}

fn stressRamp(s: f32) -> vec3f {
  let t = clamp(s, 0.0, 1.0);
  if (t < 0.45) { return mix(vec3f(0.14, 0.82, 0.45), vec3f(1.0, 0.82, 0.16), t / 0.45); }
  return mix(vec3f(1.0, 0.82, 0.16), vec3f(1.0, 0.14, 0.12), (t - 0.45) / 0.55);
}

@fragment
fn fsMain(inp: VsOut) -> @location(0) vec4f {
  let sun = normalize(SUN_DIR);
  let viewDir = normalize(U.camPos.xyz - inp.wPos);
  let mat = i32(inp.info.x + 0.5);
  let stress = inp.info.y;
  let crackGlow = inp.info.z;
  let seed = inp.info.w;

  // Use crisp geometric face normal on Voronoi wedges & bent beams so facets sparkle!
  let rawFaceN = cross(dpdx(inp.wPos), dpdy(inp.wPos));
  let faceNLen = length(rawFaceN);
  var faceN = select(inp.wNrm, rawFaceN / max(faceNLen, 1e-5), faceNLen > 1e-5);
  faceN = select(faceN, -faceN, dot(faceN, inp.wNrm) < 0.0);
  let n = normalize(select(inp.wNrm, faceN, inp.shapeF > 0.5 && inp.shapeF < 2.5));

  var alb = vec3f(0.75, 0.35, 0.22);
  var rough = 0.72;
  var metal = 0.0;
  var emissive = vec3f(0.0);

  // Local UV edge bevel for crisp architectural masonry definition
  let lp = inp.lPos;
  let halfS = max(inp.scale * 0.5, vec3f(0.01));
  let edgeDist = min(
    min(halfS.x - abs(lp.x), halfS.y - abs(lp.y)),
    halfS.z - abs(lp.z)
  );
  let microBevel = 0.84 + 0.16 * smoothstep(0.0, 0.025, edgeDist);

  if (mat == 0) {
    // Terracotta staggered brick wall with warm lime mortar
    let by = (lp.y + halfS.y) * 5.2;
    let row = floor(by);
    let bx = (lp.x + lp.z + halfS.x + halfS.z) * 2.5 + (row % 2.0) * 0.5;
    let mortar = step(0.11, fract(by)) * step(0.07, fract(bx));
    let tint = (hash3(vec3f(floor(bx), row, floor(seed * 19.0))) - 0.5) * 0.14;
    alb = mix(vec3f(0.66, 0.61, 0.54), vec3f(0.78, 0.34, 0.21) + tint, mortar) * microBevel;
    rough = 0.78;
  } else if (mat == 1) {
    // Warm poured reinforced concrete with subtle formwork lines
    let grain = (hash3(floor(lp * 18.0 + seed * 7.0)) - 0.5) * 0.07;
    let seam = smoothstep(0.02, 0.06, abs(fract((lp.y + halfS.y) * 1.6) - 0.5));
    alb = (vec3f(0.81, 0.77, 0.69) + grain) * (0.90 + 0.10 * seam) * microBevel;
    rough = 0.74;
  } else if (mat == 2) {
    // Dark slate roof & parapet coping
    alb = vec3f(0.24, 0.27, 0.34) * microBevel;
    rough = 0.58;
  } else if (mat == 3) {
    // Structural steel girder / rebar with subtle industrial rust
    let rust = smoothstep(0.55, 0.85, hash3(floor(lp * 12.0 + seed * 9.0)));
    alb = mix(vec3f(0.32, 0.36, 0.42), vec3f(0.46, 0.24, 0.15), rust * 0.35);
    rough = 0.34;
    metal = 0.78;
  } else if (mat == 4) {
    // Tempered cyan glass with sky Fresnel & spiderweb impact cracks
    let fres = pow(1.0 - max(0.0, dot(n, viewDir)), 3.0);
    alb = mix(vec3f(0.16, 0.50, 0.68), vec3f(0.76, 0.92, 1.0), fres * 0.75);
    rough = 0.12;
    metal = 0.25;
  } else if (mat == 5) {
    // Charred blast soot
    alb = vec3f(0.13, 0.12, 0.11);
    rough = 0.92;
  } else if (mat == 6) {
    // Glowing artillery cannonball / fiery demolition spark / beacon
    alb = vec3f(1.0, 0.48, 0.14);
    emissive = vec3f(2.4, 0.92, 0.24);
    rough = 0.25;
  } else if (mat == 7) {
    // Exposed bright rough interior concrete fracture face (Voronoi core!)
    let agg = (hash3(floor(lp * 28.0 + seed * 13.0)) - 0.5) * 0.16;
    alb = vec3f(0.68, 0.66, 0.62) + agg;
    rough = 0.90;
  } else {
    // Mat 8: Deliberately retro 1998 Half-Life low-res pixelated flat brick/crate
    let px = floor((lp.x + lp.z) * 4.5);
    let py = floor(lp.y * 4.5);
    let chk = ((i32(px) + i32(py)) & 1) == 0;
    alb = select(vec3f(0.56, 0.28, 0.19), vec3f(0.70, 0.36, 0.23), chk);
    rough = 0.95;
  }

  // Real-time Structural Stress Heatmap & Glowing Fracture Seams (2009 Guerrilla & 2023 The Finals)
  if (stress > 0.04) {
    let sCol = stressRamp(stress);
    let mixAmt = select(smoothstep(0.30, 0.92, stress) * 0.68, 0.52 + stress * 0.35, U.extra.y > 0.5);
    alb = mix(alb, sCol, mixAmt);
    // Glowing red crack veins when near structural collapse threshold
    if (stress > 0.72) {
      let ve = voronoiEdge(inp.wPos * 3.1);
      let crackLine = smoothstep(0.11, 0.02, ve);
      let pulse = 0.75 + 0.25 * sin(U.camRight.w * 14.0);
      emissive += vec3f(1.6, 0.25, 0.08) * crackLine * smoothstep(0.72, 0.96, stress) * pulse;
    }
  }

  // Real-time Voronoi Fracture Diagram Flash on Stage 5 (2013-19)
  if (crackGlow > 0.03) {
    let ve = voronoiEdge(inp.wPos * 2.6 + vec3f(0.4, 0.7, 0.2));
    let web = smoothstep(0.11, 0.015, ve);
    emissive += vec3f(1.8, 0.88, 0.22) * web * crackGlow;
    alb = mix(alb, vec3f(0.95, 0.78, 0.45), web * crackGlow * 0.45);
  }

  // PBR-lite golden-hour directional + hemisphere + specular + blast point light
  let ndl = max(0.0, dot(n, sun));
  let hVec = normalize(sun + viewDir);
  let specPow = mix(96.0, 14.0, rough);
  let spec = pow(max(0.0, dot(n, hVec)), specPow) * mix(0.28, 0.95, metal) * (1.0 - rough * 0.65);

  let hemi = 0.5 + 0.5 * n.y;
  let amb = mix(vec3f(0.32, 0.27, 0.23), vec3f(0.42, 0.54, 0.74), hemi);
  let groundAO = 0.72 + 0.28 * smoothstep(0.0, 0.75, inp.wPos.y);

  let diff = alb * (1.0 - metal * 0.65);
  let specCol = mix(vec3f(1.0, 0.96, 0.88), alb, metal);
  let fDist = length(inp.wPos - U.flash.xyz);
  let flashLit = vec3f(1.0, 0.58, 0.22) * (U.flash.w * 3.0 / (1.0 + fDist * fDist * 0.5));

  var col = diff * (amb * 0.72 * groundAO + vec3f(1.20, 1.04, 0.86) * ndl) + specCol * spec * 0.85 + flashLit * alb + emissive;

  // ACES filmic + gamma 2.2
  let mapped = (col * (2.51 * col + 0.03)) / (col * (2.43 * col + 0.59) + 0.14);
  return vec4f(pow(clamp(mapped, vec3f(0.0), vec3f(1.0)), vec3f(1.0 / 2.2)), 1.0);
}
`;

export const DUST_PLUME_WGSL = /* wgsl */`
struct FrameUniforms {
  viewProj: mat4x4f,
  camPos: vec4f,
  camFwd: vec4f,
  camRight: vec4f,
  camUp: vec4f,
  flash: vec4f,
  extra: vec4f,
  voxMin: vec4f,
  voxSpan: vec4f,
  voxExtra: vec4f,
  craters: array<vec4f, 16>,
};

struct DustItem {
  v0: vec4f, // pos.xyz, scale
  v1: vec4f, // ageFrac, kind (0=dust, 1=fire, 2=shockwave), seed, 0
};

@group(0) @binding(0) var<uniform> U: FrameUniforms;
@group(0) @binding(1) var<storage, read> dust: array<DustItem>;

struct VsOut {
  @builtin(position) clipPos: vec4f,
  @location(0) uv: vec2f,
  @location(1) info: vec3f, // ageFrac, kind, seed
};

@vertex
fn vsMain(@builtin(vertex_index) vid: u32, @builtin(instance_index) iid: u32) -> VsOut {
  var quad = array<vec2f, 6>(
    vec2f(-1.0, -1.0), vec2f( 1.0, -1.0), vec2f( 1.0,  1.0),
    vec2f(-1.0, -1.0), vec2f( 1.0,  1.0), vec2f(-1.0,  1.0)
  );
  let q = quad[vid];
  let item = dust[iid];
  let scale = item.v0.w;
  var wp = item.v0.xyz + U.camRight.xyz * (q.x * scale) + U.camUp.xyz * (q.y * scale);
  var o: VsOut;
  o.clipPos = U.viewProj * vec4f(wp, 1.0);
  o.uv = q;
  o.info = item.v1.xyz;
  return o;
}

@fragment
fn fsMain(inp: VsOut) -> @location(0) vec4f {
  let r = length(inp.uv);
  if (r > 1.0) { discard; }
  let age = clamp(inp.info.x, 0.0, 1.0);
  let kind = i32(inp.info.y + 0.5);

  if (kind == 2) {
    // Crisp expanding pressure shockwave ring
    let ring = smoothstep(0.70, 0.88, r) * smoothstep(1.0, 0.89, r);
    let a = ring * (1.0 - age) * (1.0 - age) * 0.72;
    return vec4f(1.0, 0.88, 0.68, a);
  }
  if (kind == 1) {
    // Fiery blast core flash
    let core = pow(max(0.0, 1.0 - r), 1.8);
    let col = mix(vec3f(1.0, 0.38, 0.08), vec3f(1.0, 0.96, 0.74), core);
    let a = core * (1.0 - age) * 0.85;
    return vec4f(col, a);
  }
  // Sunlit drifting masonry dust plume
  let puff = pow(max(0.0, 1.0 - r * r), 1.6);
  let light = 0.78 + 0.22 * clamp(inp.uv.y * 0.5 + 0.5, 0.0, 1.0);
  let col = vec3f(0.82, 0.74, 0.64) * light;
  let fade = smoothstep(0.0, 0.14, age) * (1.0 - age);
  return vec4f(col, puff * fade * 0.34);
}
`;
