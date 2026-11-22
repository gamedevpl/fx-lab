// WGSL compute & render shaders for Evolution of Collision Detection & Tunneling (1988-2024) on WebGPU.
// Genuine GPU compute pipelines:
//   - GRID_CLEAR_WGSL:  clears 16x8x16 (2,048 cells) 3D spatial hash atomic occupancy counters
//   - BULLET_SIM_WGSL:  simulates 4,096 live GPU projectiles / bouncing spatial-hash bodies with
//                       discrete tunneling vs exact analytic Swept-CCD + atomic 3D spatial grid hashing
// Render passes:
//   - ENV_FLOOR_WGSL:     tactical calibration lab floor, metric grid, Doom E/W range lanes & depth32float
//   - PRIMITIVE_PBR_WGSL: hardware-instanced PBR walls, hulls, ghosts, SAP brackets, spinning rod & 4,096 GPU bullets
//   - GRID_CELL_WGSL:     renders active occupied 3D GPU spatial hash cells (GPU Gems 3 Ch. 32 visualizer!)

export const GRID_CLEAR_WGSL = /* wgsl */`
@group(0) @binding(0) var<storage, read_write> gridCounts: array<atomic<u32>>;

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let idx = gid.x;
  if (idx < arrayLength(&gridCounts)) {
    atomicStore(&gridCounts[idx], 0u);
  }
}
`;

export const BULLET_SIM_WGSL = /* wgsl */`
struct Bullet {
  v0: vec4f, // pos.xyz, matId
  v1: vec4f, // vel.xyz, state (0=flying, 1=blocked/ricochet, 2=tunneled, 3=spatialOrb)
  v2: vec4f, // scale.xyz, life
  v3: vec4f, // seed, glow, 0, 0
};

struct SimParams {
  u0: vec4f, // dt, time, stage, resetFlag
  u1: vec4f, // wallHalfThick, shockwave, lowTick, 0
};

@group(0) @binding(0) var<uniform> P: SimParams;
@group(0) @binding(1) var<storage, read_write> bullets: array<Bullet>;
@group(0) @binding(2) var<storage, read_write> gridCounts: array<atomic<u32>>;

fn hash31(p: f32) -> vec3f {
  var p3 = fract(vec3f(p) * vec3f(0.1031, 0.1030, 0.0973));
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.xxy + p3.yzz) * p3.zyx);
}

fn spawnBullet(idx: u32, stage: i32, seedOff: f32) -> Bullet {
  var b: Bullet;
  let h = hash31(f32(idx) * 1.137 + seedOff * 19.3);
  let h2 = hash31(f32(idx) * 2.719 + seedOff * 7.1 + 3.7);

  if (stage == 4) {
    // 2007 GPU Gems 3: 4,096 spatial-hash bouncing micro-orbs swarming cleanly through glowing 3D grid cells!
    let ang = h.x * 6.2831853;
    let rad = 0.85 + pow(h.y, 0.55) * 3.35;
    let pos = vec3f(cos(ang) * rad, 0.25 + h.z * 3.1, sin(ang) * rad);
    let vel = (h2 - 0.5) * vec3f(7.5, 4.5, 7.5);
    b.v0 = vec4f(pos, 2.0);
    b.v1 = vec4f(vel, 3.0);
    b.v2 = vec4f(0.048, 0.048, 0.048, 1.0);
    b.v3 = vec4f(h.x, 0.45, 0.0, 0.0);
    return b;
  }

  // Ballistics swarm (Stages 0, 6, 7): firing from BACK (z = -4.2) straight forward (+Z) across horizontal thin wall (z = 0)!
  let xStart = (h.z - 0.5) * 6.80;
  let yStart = 0.28 + h.y * 2.05;
  let zStart = -4.25 + h.x * 3.85;
  let spd = 16.5 + h2.x * 11.5;
  let matId = select(2.0, 3.0, stage == 7);
  b.v0 = vec4f(xStart, yStart, zStart, matId);
  b.v1 = vec4f((h2.z - 0.5) * 0.45, (h2.y - 0.5) * 0.45, spd, 0.0);
  b.v2 = vec4f(0.062, 0.062, 0.062, 1.0 + h2.x * 1.4);
  b.v3 = vec4f(h.x, 0.72, 0.0, 0.0);
  return b;
}

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let idx = gid.x;
  if (idx >= arrayLength(&bullets)) { return; }

  let stage = i32(P.u0.z + 0.5);
  let dt = P.u0.x;

  // Stages 1 (Doom), 2 (SAP), 3 (Quake BSP/SAT), 5 (Speculative) use focused hero visualizations instead of 4K swarm
  if (stage == 1 || stage == 2 || stage == 3 || stage == 5) {
    bullets[idx].v2.w = 0.0;
    return;
  }

  if (P.u0.w > 0.5) {
    bullets[idx] = spawnBullet(idx, stage, P.u0.y + 1.0);
    return;
  }

  var b = bullets[idx];
  if (b.v2.w <= 0.001) {
    b = spawnBullet(idx, stage, P.u0.y + f32(idx) * 0.01);
  }

  var pos = b.v0.xyz;
  var vel = b.v1.xyz;
  var st = b.v1.w;
  var mat = b.v0.w;
  var glow = b.v3.y;

  // ---- STAGE 4: 2007 GPU SPATIAL HASH BROADPHASE ----
  if (stage == 4) {
    if (P.u1.y > 0.5) {
      let dir = normalize(pos - vec3f(0.0, 1.2, 0.0) + vec3f(0.001));
      vel += dir * 9.5 + vec3f(0.0, 3.0, 0.0);
    }
    vel.y -= 5.8 * dt;
    pos += vel * dt;

    // Arena box bounce [-4.35..4.35] x [0.15..3.75] x [-4.35..4.35]
    if (pos.x < -4.35) { pos.x = -4.35; vel.x = abs(vel.x) * 0.92; }
    if (pos.x >  4.35) { pos.x =  4.35; vel.x = -abs(vel.x) * 0.92; }
    if (pos.z < -4.35) { pos.z = -4.35; vel.z = abs(vel.z) * 0.92; }
    if (pos.z >  4.35) { pos.z =  4.35; vel.z = -abs(vel.z) * 0.92; }
    if (pos.y < 0.14)  { pos.y =  0.14; vel.y = abs(vel.y) * 0.88 + 0.8; }
    if (pos.y > 3.75)  { pos.y =  3.75; vel.y = -abs(vel.y) * 0.90; }

    // Central armored obstacle pillar collision [-0.54..0.54]
    if (abs(pos.x) < 0.56 && abs(pos.z) < 0.56 && pos.y < 2.75) {
      if (abs(pos.x) > abs(pos.z)) {
        pos.x = select(-0.56, 0.56, pos.x >= 0.0);
        vel.x = -vel.x * 0.95;
      } else {
        pos.z = select(-0.56, 0.56, pos.z >= 0.0);
        vel.z = -vel.z * 0.95;
      }
      mat = 3.0;
      glow = 1.0;
    } else {
      mat = select(2.0, 5.0, length(vel) > 5.8);
      glow = 0.65;
    }

    // Genuine GPU 3D Spatial Hash atomic insertion (16x8x16 cells)!
    let cellF = clamp((pos - vec3f(-4.8, 0.0, -4.8)) / vec3f(9.6, 4.8, 9.6) * vec3f(16.0, 8.0, 16.0), vec3f(0.0), vec3f(15.99, 7.99, 15.99));
    let ci = vec3u(cellF);
    let cellIdx = ci.x + ci.y * 16u + ci.z * 16u * 8u;
    atomicAdd(&gridCounts[cellIdx], 1u);

    b.v0 = vec4f(pos, mat);
    b.v1 = vec4f(vel, 3.0);
    b.v3.y = glow;
    bullets[idx] = b;
    return;
  }

  // ---- STAGES 0 (DISCRETE TUNNELING) vs 6 & 7 (SWEPT CCD 0% TUNNELING) across HORIZONTAL wall z = 0 ----
  let prevZ = pos.z;
  let wHalf = P.u1.x;
  let r = 0.07;

  if (st > 0.5 && st < 1.5) {
    vel.y -= 17.5 * dt;
    pos += vel * dt;
    if (pos.y < r) { pos.y = r; vel.y = -vel.y * 0.42; vel.x *= 0.72; vel.z *= 0.72; }
    b.v2.w -= dt * 1.15;
    if (b.v2.w <= 0.02 || pos.z < -5.5) {
      b = spawnBullet(idx, stage, P.u0.y + f32(idx) * 0.017);
      b.v0.z = -4.25;
      bullets[idx] = b;
      return;
    }
  } else {
    pos += vel * dt;
    let inXY = pos.y > 0.05 && pos.y < 2.52 && abs(pos.x) < 3.82;

    if (stage == 0) {
      // DISCRETE POINT CHECK AT END OF TICK -> FAST BULLETS TUNNEL CLEANLY TOWARD VIEWER (+Z)!
      let hitPlane = -(wHalf + r);
      let overlapsNow = inXY && abs(pos.z) <= (wHalf + r * 0.35);
      let jumpedWall = inXY && prevZ < -wHalf && pos.z > wHalf;
      if (overlapsNow && st < 0.5) {
        pos.z = hitPlane;
        vel = vec3f((b.v3.x - 0.5) * 4.0, 2.2 + b.v3.x * 3.5, -abs(vel.z) * 0.30);
        st = 1.0; mat = 5.0; glow = 1.0; b.v2.w = 0.85;
      } else if (jumpedWall && st < 0.5) {
        st = 2.0; // TUNNELED! Vivid crimson breach streaming straight toward the camera!
        mat = 4.0;
        glow = 1.0;
      }
    } else {
      // STAGES 6 & 7: EXACT CONTINUOUS SWEPT CCD SLAB TEST -> 0% LINEAR TUNNELING!
      let hitPlane = -(wHalf + r);
      if (inXY && prevZ <= hitPlane && pos.z >= hitPlane && st < 0.5) {
        pos.z = hitPlane;
        let h = hash31(f32(idx) * 3.17 + P.u0.y);
        vel = vec3f((h.z - 0.5) * 6.8, 1.6 + h.y * 5.0, -(2.5 + h.x * 5.2));
        st = 1.0;
        mat = select(5.0, 3.0, h.x > 0.45);
        glow = 1.0;
        b.v2.w = 0.72 + h.y * 0.65;
      }
    }

    if (pos.z > 4.6 || pos.z < -5.5) {
      b = spawnBullet(idx, stage, P.u0.y + f32(idx) * 0.013);
      b.v0.z = -4.25;
      bullets[idx] = b;
      return;
    }
  }

  b.v0 = vec4f(pos, mat);
  b.v1 = vec4f(vel, st);
  b.v3.y = glow;
  bullets[idx] = b;
}
`;

export const ENV_FLOOR_WGSL = /* wgsl */`
struct FrameUniforms {
  viewProj: mat4x4f,
  camPos: vec4f,   // xyz, tanHalf
  camFwd: vec4f,   // xyz, aspect
  camRight: vec4f, // xyz, time
  camUp: vec4f,    // xyz, stage
  extra: vec4f,    // wallFlashGood, wallFlashBad, isGPU, 0
};

@group(0) @binding(0) var<uniform> U: FrameUniforms;

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

struct FragOut {
  @location(0) color: vec4f,
  @builtin(frag_depth) depth: f32,
};

@fragment
fn fsMain(inp: VsOut) -> FragOut {
  var out: FragOut;
  let ndc = inp.uv * 2.0 - 1.0;
  let rd = normalize(
    U.camFwd.xyz +
    U.camRight.xyz * (ndc.x * U.camPos.w * U.camFwd.w) +
    U.camUp.xyz * (ndc.y * U.camPos.w)
  );
  let ro = U.camPos.xyz;
  let stage = i32(U.camUp.w + 0.5);

  // Deep atmospheric tactical ballistics lab backdrop
  let h = clamp(rd.y * 0.5 + 0.5, 0.0, 1.0);
  var col = mix(vec3f(0.055, 0.075, 0.125), vec3f(0.025, 0.038, 0.075), smoothstep(0.45, 0.95, h));
  // Soft cyan horizon studio rim glow
  col += vec3f(0.08, 0.18, 0.28) * exp(-abs(rd.y) * 9.0) * 0.45;
  var didHit = false;
  var hitPos = ro + rd * 80.0;

  if (rd.y < -0.001) {
    let tg = -ro.y / rd.y;
    if (tg > 0.1 && tg < 85.0) {
      hitPos = ro + rd * tg;
      didHit = true;

      let p = hitPos.xz;
      // Crisp 1-meter tactical grid + subtle 0.25m sub-grid
      let g1 = abs(fract(p + 0.5) - 0.5);
      let line1 = 1.0 - smoothstep(0.015, 0.032, min(g1.x, g1.y));
      let g4 = abs(fract(p * 4.0 + 0.5) - 0.5);
      let line4 = 1.0 - smoothstep(0.02, 0.05, min(g4.x, g4.y));

      let distCenter = length(p);
      var base = mix(vec3f(0.075, 0.095, 0.145), vec3f(0.045, 0.060, 0.095), smoothstep(2.0, 16.0, distCenter));
      base += vec3f(0.06, 0.12, 0.19) * line4 * 0.30;
      base += vec3f(0.14, 0.28, 0.42) * line1 * 0.55;

      // Highlight firing lane & Stage 1 Doom East (Emerald SAFE) vs West (Crimson BUG!) floor lanes!
      if (stage == 1) {
        let inLane = smoothstep(2.4, 2.0, abs(p.y));
        let eastZone = smoothstep(0.4, 0.8, p.x) * smoothstep(4.6, 3.8, p.x) * inLane;
        let westZone = smoothstep(-0.4, -0.8, p.x) * smoothstep(-4.6, -3.8, p.x) * inLane;
        base += vec3f(0.06, 0.34, 0.20) * eastZone * 0.42;
        base += vec3f(0.42, 0.07, 0.10) * westZone * 0.44;
      } else if (stage != 2 && stage != 4) {
        // Highlight breach / safe zone IN FRONT of horizontal steel wall (z > 0.15)!
        let inLane = smoothstep(4.2, 3.6, abs(p.x));
        let frontZone = smoothstep(0.15, 0.55, p.y) * smoothstep(4.6, 3.6, p.y) * inLane;
        let breachTint = select(vec3f(0.04, 0.24, 0.16), vec3f(0.45, 0.05, 0.09), stage == 0);
        base += breachTint * frontZone * (0.34 + U.extra.y * 0.40);
      }

      // Soft studio center spotlight + impact floor bounce glow
      let spot = exp(-distCenter * distCenter * 0.025);
      base *= 0.65 + 0.65 * spot;
      base += vec3f(0.12, 0.55, 0.35) * U.extra.w * exp(-distCenter * distCenter * 0.18) * 0.45;
      base += vec3f(0.65, 0.10, 0.14) * U.extra.y * exp(-distCenter * distCenter * 0.18) * 0.45;

      let fog = smoothstep(14.0, 52.0, tg);
      col = mix(base, col, fog);
    }
  }

  let mapped = (col * (2.51 * col + 0.03)) / (col * (2.43 * col + 0.59) + 0.14);
  out.color = vec4f(pow(clamp(mapped, vec3f(0.0), vec3f(1.0)), vec3f(1.0 / 2.2)), 1.0);
  if (didHit) {
    let clip = U.viewProj * vec4f(hitPos, 1.0);
    out.depth = clamp(clip.z / clip.w, 0.0, 0.9999);
  } else {
    out.depth = 0.9998;
  }
  return out;
}
`;

export const PRIMITIVE_PBR_WGSL = /* wgsl */`
struct FrameUniforms {
  viewProj: mat4x4f,
  camPos: vec4f,
  camFwd: vec4f,
  camRight: vec4f,
  camUp: vec4f,
  extra: vec4f, // passMode (0=opaqueInst, 1=transInst, 2=gpuBullets, 3=gpuGridCells), 0, 0, 0
};

struct Inst {
  v0: vec4f, // pos.xyz, matId
  v1: vec4f, // rot.xyz, shapeType (or vel.xyz, state if gpuBullets)
  v2: vec4f, // scale.xyz, alpha (or life if gpuBullets)
  v3: vec4f, // glow, seed, 0, 0
};

@group(0) @binding(0) var<uniform> U: FrameUniforms;
@group(0) @binding(1) var<storage, read> insts: array<Inst>;
@group(0) @binding(2) var<storage, read> gridCounts: array<u32>;

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
  @location(3) pInfo: vec4f, // matId, alpha, glow, shape
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
  let mode = i32(U.extra.x + 0.5);

  if (mode == 3) {
    // GPU 3D Spatial Hash Grid Cell Visualizer (16x8x16 = 2,048 cells) — highlight hot cells cleanly!
    let cnt = gridCounts[iid];
    if (cnt < 4u) {
      o.clipPos = vec4f(2.0, 2.0, 2.0, 1.0);
      return o;
    }
    let cz = iid / 128u;
    let rem = iid - cz * 128u;
    let cy = rem / 16u;
    let cx = rem - cy * 16u;
    let cellSize = vec3f(9.6 / 16.0, 4.8 / 8.0, 9.6 / 16.0);
    let center = vec3f(-4.8, 0.0, -4.8) + (vec3f(f32(cx), f32(cy), f32(cz)) + 0.5) * cellSize;
    let wp = center + inp.pos * (cellSize * 0.92);
    o.clipPos = U.viewProj * vec4f(wp, 1.0);
    o.wPos = wp;
    o.wNrm = inp.nrm;
    o.lPos = inp.pos;
    let crowded = clamp(f32(cnt - 3u) / 6.0, 0.0, 1.0);
    o.pInfo = vec4f(select(2.0, 3.0, cnt >= 7u), 0.12 + crowded * 0.20, 0.75, 0.0);
    return o;
  }

  let inst = insts[iid];
  let isGpuBullet = mode == 2;

  if (isGpuBullet) {
    if (inst.v2.w <= 0.001) {
      o.clipPos = vec4f(2.0, 2.0, 2.0, 1.0);
      return o;
    }
    let lp = normalize(inp.pos) * 0.5;
    let wp = inst.v0.xyz + lp * inst.v2.xyz * 2.0;
    o.clipPos = U.viewProj * vec4f(wp, 1.0);
    o.wPos = wp;
    o.wNrm = normalize(inp.pos);
    o.lPos = lp;
    o.pInfo = vec4f(inst.v0.w, 1.0, inst.v3.y, 1.0);
    return o;
  }

  // Opaque vs Translucent split filter
  let alpha = inst.v2.w;
  if ((mode == 0 && alpha < 0.98) || (mode == 1 && alpha >= 0.98)) {
    o.clipPos = vec4f(2.0, 2.0, 2.0, 1.0);
    return o;
  }

  let shape = inst.v1.w;
  var lp = inp.pos;
  var ln = inp.nrm;
  if (shape > 0.5 && shape < 1.5) {
    lp = normalize(inp.pos) * 0.5;
    ln = normalize(inp.pos);
  } else if (shape > 1.5) {
    // Shape 2: Flat glowing YZ impact/speculative halo ring
    lp = normalize(vec3f(0.0, inp.pos.y, inp.pos.z)) * 0.5;
    lp.x = inp.pos.x;
    ln = vec3f(-1.0, 0.0, 0.0);
  }

  let wp = inst.v0.xyz + rotXYZ(lp * inst.v2.xyz, inst.v1.xyz);
  let wn = normalize(rotXYZ(ln, inst.v1.xyz));
  o.clipPos = U.viewProj * vec4f(wp, 1.0);
  o.wPos = wp;
  o.wNrm = wn;
  o.lPos = inp.pos;
  o.pInfo = vec4f(inst.v0.w, alpha, inst.v3.x, shape);
  return o;
}

const KEY_LIGHT: vec3f = vec3f(0.42, 0.80, 0.42);

@fragment
fn fsMain(inp: VsOut) -> @location(0) vec4f {
  let mat = i32(inp.pInfo.x + 0.5);
  let alpha = inp.pInfo.y;
  let glow = inp.pInfo.z;
  let shape = inp.pInfo.w;
  let n = normalize(inp.wNrm);
  let vDir = normalize(U.camPos.xyz - inp.wPos);
  let sun = normalize(KEY_LIGHT);

  var alb = vec3f(0.22, 0.27, 0.36);
  var em = vec3f(0.0);
  var rough = 0.42;

  // Crisp edge wire highlight for translucent hulls & spatial hash cells
  let edgeMax = max(abs(inp.lPos.x), max(abs(inp.lPos.y), abs(inp.lPos.z)));
  let isFrame = smoothstep(0.42, 0.495, edgeMax);

  if (mat == 0) {
    // Armored Steel Test Bulkhead (flashes bright emerald on block, crimson on tunnel!)
    let panel = smoothstep(0.03, 0.06, abs(fract(inp.wPos.y * 1.4) - 0.5));
    alb = vec3f(0.26, 0.32, 0.42) * (0.88 + 0.12 * panel);
    if (glow > 0.01) { em += vec3f(0.18, 1.45, 0.72) * glow * 0.9; }
    if (glow < -0.01) { em += vec3f(1.85, 0.16, 0.24) * (-glow) * 1.1; }
    rough = 0.28;
  } else if (mat == 1) {
    // Dark tactical turret / pedestal steel
    alb = vec3f(0.18, 0.21, 0.29);
    rough = 0.55;
  } else if (mat == 2) {
    // Electric Cyan (Swept CCD / Quake Minkowski Hull / Spatial Hash)
    alb = vec3f(0.05, 0.72, 0.96);
    em = vec3f(0.04, 0.52, 0.85) * (0.35 + glow * 0.65 + isFrame * 0.75);
    rough = 0.20;
  } else if (mat == 3) {
    // Rich Fiery Orange / Gold (Doom Fireball / Ricochet Spark / Active SAP Pair)
    alb = vec3f(0.98, 0.48, 0.06);
    em = vec3f(1.32, 0.46, 0.04) * (0.45 + glow * 0.75);
    rough = 0.22;
  } else if (mat == 4) {
    // Deep Vivid Neon Crimson (TUNNELED! / Clipping Breach / OBB Overlap)
    alb = vec3f(0.96, 0.06, 0.14);
    em = vec3f(1.38, 0.04, 0.09) * (0.45 + glow * 0.85);
    rough = 0.22;
  } else if (mat == 5) {
    // Vivid Emerald Green (BLOCKED / SAFE / TOI Lock-On / Separated Plane)
    alb = vec3f(0.06, 0.88, 0.42);
    em = vec3f(0.04, 0.96, 0.34) * (0.40 + glow * 0.75);
    rough = 0.24;
  } else if (mat == 6) {
    // Ghost Tick Sphere (translucent pale cyan-white)
    alb = vec3f(0.76, 0.92, 1.0);
    em = vec3f(0.55, 0.82, 1.0) * 0.75;
    rough = 0.20;
  } else if (mat == 7) {
    // Brushed Steel Spinning Rod / Railgun Barrel
    alb = vec3f(0.68, 0.74, 0.84);
    rough = 0.18;
  } else {
    // Mat 8: Glowing Amber Laser Trajectory / Sub-Step Midpoint
    alb = vec3f(1.0, 0.82, 0.28);
    em = vec3f(1.65, 1.18, 0.30) * 0.95;
    rough = 0.20;
  }

  let ndl = max(0.0, dot(n, sun));
  let hVec = normalize(sun + vDir);
  let spec = pow(max(0.0, dot(n, hVec)), mix(72.0, 14.0, rough)) * 0.55;
  let fres = pow(1.0 - max(0.0, dot(n, vDir)), 2.8);
  let amb = mix(vec3f(0.12, 0.16, 0.26), vec3f(0.32, 0.42, 0.58), 0.5 + 0.5 * n.y);

  var col = alb * (amb * 0.82 + vec3f(1.05, 0.98, 0.92) * ndl) + vec3f(0.95, 0.98, 1.0) * spec + em;
  if (alpha < 0.98) {
    col += em * (fres * 0.65 + isFrame * 0.55);
  }

  // Hollow out shape 2 (Impact/Speculative Ring) into a crisp glowing ring!
  var outA = alpha;
  if (shape > 1.5) {
    let rr = length(inp.lPos.yz) * 2.0;
    let ring = smoothstep(0.62, 0.80, rr) * smoothstep(1.02, 0.88, rr);
    if (ring < 0.02) { discard; }
    outA = alpha * ring;
  }

  let mapped = (col * (2.51 * col + 0.03)) / (col * (2.43 * col + 0.59) + 0.14);
  return vec4f(pow(clamp(mapped, vec3f(0.0), vec3f(1.0)), vec3f(1.0 / 2.2)), outA);
}
`;
