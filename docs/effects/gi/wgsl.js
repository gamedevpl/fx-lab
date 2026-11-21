// WGSL compute & render shaders for Evolution of Global Illumination (1996-2026) — WebGPU primary path.
// Shared analytical Cornell-inspired gallery + 3D Voxel storage textures (VCT), Ambient Cube probe storage buffer,
// DDGI octahedral + Chebyshev visibility atlases, G-Buffer SSAO & SSDO/SSGI, Software SDF multi-bounce GI,
// and 3-level Sannikov Radiance Cascades (C2 -> C1 -> C0) with depth-aware bilinear cascade merging.

export const COMMON_WGSL = /* wgsl */`
struct Uniforms {
  camPos:     vec4f, // xyz = pos, w = tanHalfFov
  camRight:   vec4f, // xyz = right, w = aspect
  camUp:      vec4f, // xyz = up, w = simTime
  camFwd:     vec4f, // xyz = fwd, w = frameIndex
  lampPos:    vec4f, // xyz = live lamp pos, w = lampIntensity
  bakedLamp:  vec4f, // xyz = baked 1996 lamp pos, w = splitX (-1 when disabled)
  stages:     vec4f, // x = stageLeft, y = stageRight, z = flatAmbientLeft (0/1), w = debugOverlay (0/1)
  res:        vec4f, // x = width, y = height, z = rcW, w = rcH
  rcParams:   vec4f, // x = cascadeIdx, y = spacing, z = tStart, w = tEnd
  extra:      vec4f, // x = lookAwayAmt, y = moveLampAmt, z = hysteresis, w = unused
};

const PI: f32 = 3.14159265359;
const ROOM_MIN: vec3f = vec3f(-3.0, 0.0, -3.0);
const ROOM_MAX: vec3f = vec3f(3.0, 3.4, 3.85);
const VOX_MIN:  vec3f = vec3f(-3.16, -0.14, -3.16);
const VOX_MAX:  vec3f = vec3f(3.16, 3.54, 3.20);

// Material IDs:
// 0 = floor travertine, 1 = ceiling plaster, 2 = back limestone wall,
// 3 = left crimson wall, 4 = right cyan wall, 5 = thin divider wall,
// 6 = plinths / bench, 7 = sculptural ivory spheres, 8 = brass lamp stem, 9 = glowing lamp orb

fn sdBox(p: vec3f, b: vec3f) -> f32 {
  let q = abs(p) - b;
  return length(max(q, vec3f(0.0))) + min(max(q.x, max(q.y, q.z)), 0.0);
}

fn sdCapsule(p: vec3f, a: vec3f, b: vec3f, r: f32) -> f32 {
  let pa = p - a;
  let ba = b - a;
  let h = clamp(dot(pa, ba) / max(dot(ba, ba), 1e-5), 0.0, 1.0);
  return length(pa - ba * h) - r;
}

// Signed distance to solid gallery surfaces (excluding lamp emissive orb unless includeLamp is true).
fn mapGallery(p: vec3f, lampPos: vec3f, includeLamp: bool) -> vec2f {
  // Interior walls (inverted open-front room shell)
  var d = p.y; // floor y = 0
  var mat = 0.0;

  // Ceiling y = 3.4 with smooth Lipschitz-safe architectural coffer beams
  let beamX = abs(fract((p.x + 3.0) / 1.5) - 0.5) * 1.5;
  let beamZ = abs(fract((p.z + 3.0) / 1.45) - 0.5) * 1.45;
  let coffer = max(smoothstep(0.18, 0.06, beamX), smoothstep(0.18, 0.06, beamZ)) * 0.055;
  let dCeil = ((3.4 - coffer) - p.y) * 0.82;
  if (dCeil < d) { d = dCeil; mat = 1.0; }

  // Back wall z = -3.0 with smooth recessed central gallery arch niche (continuous CSG subtraction!)
  let dBackFlat = p.z + 3.0;
  let archRect = sdBox(p - vec3f(0.0, 1.15, -3.12), vec3f(1.02, 0.80, 0.24));
  let archCyl = max(length(p.xy - vec2f(0.0, 1.95)) - 1.02, abs(p.z + 3.12) - 0.24);
  let archCarve = min(archRect, archCyl);
  let dBack = min(max(dBackFlat, -archCarve), p.z + 3.24);
  if (dBack < d) { d = dBack; mat = 2.0; }

  // Left crimson wall x = -3.0 with smooth Lipschitz-safe pilasters
  let ribZ = abs(fract((p.z + 2.4) / 1.6) - 0.5) * 1.6;
  let pilMask = smoothstep(-2.85, -2.72, p.z) * smoothstep(3.55, 3.35, p.z);
  let pilaster = smoothstep(0.18, 0.06, ribZ) * 0.048 * pilMask;
  let dLeft = ((p.x + 3.0) - pilaster) * 0.85;
  if (dLeft < d) { d = dLeft; mat = 3.0; }

  // Right cyan wall x = +3.0 with matching pilasters
  let dRight = ((3.0 - p.x) - pilaster) * 0.85;
  if (dRight < d) { d = dRight; mat = 4.0; }

  // Hero thin dividing partition wall (0.16m thick, 2.94m tall — light-leaking torture test!)
  // Clean 0.46m transom air gap above (y > 2.94), behind (z < -1.62) and in front (z > 0.48)
  let dDiv = sdBox(p - vec3f(0.0, 1.47, -0.57), vec3f(0.08, 1.47, 1.05));
  if (dDiv < d) { d = dDiv; mat = 5.0; }

  // Left chamber plinth + matte alabaster sphere
  let dPlinthL = sdBox(p - vec3f(-1.46, 0.36, -1.02), vec3f(0.42, 0.36, 0.42));
  if (dPlinthL < d) { d = dPlinthL; mat = 6.0; }
  let dSphL = length(p - vec3f(-1.46, 1.20, -1.02)) - 0.48;
  if (dSphL < d) { d = dSphL; mat = 7.0; }

  // Right chamber plinth + matte alabaster sphere (sits in direct shadow when lamp is on left!)
  let dPlinthR = sdBox(p - vec3f(1.44, 0.32, -0.96), vec3f(0.44, 0.32, 0.44));
  if (dPlinthR < d) { d = dPlinthR; mat = 6.0; }
  let dSphR = length(p - vec3f(1.44, 1.14, -0.96)) - 0.50;
  if (dSphR < d) { d = dSphR; mat = 7.0; }

  // Foreground gallery bench bridging left & right chambers
  let dBench = sdBox(p - vec3f(0.0, 0.21, 1.05), vec3f(0.86, 0.21, 0.27));
  if (dBench < d) { d = dBench; mat = 6.0; }

  // Small decorative dark stone cube on right side of bench to sharpen contact AO & shadows
  let dCube = sdBox(p - vec3f(-0.46, 0.55, 1.05), vec3f(0.14, 0.14, 0.14));
  if (dCube < d) { d = dCube; mat = 7.0; }

  if (includeLamp) {
    let dStem = sdCapsule(p, vec3f(lampPos.x, 3.4, lampPos.z), vec3f(lampPos.x, lampPos.y + 0.18, lampPos.z), 0.025);
    if (dStem < d) { d = dStem; mat = 8.0; }
    let dOrb = length(p - lampPos) - 0.19;
    if (dOrb < d) { d = dOrb; mat = 9.0; }
  }

  return vec2f(d, mat);
}

fn calcNormal(p: vec3f, lampPos: vec3f, includeLamp: bool) -> vec3f {
  let e = 0.0025;
  let k1 = vec3f( 1.0, -1.0, -1.0);
  let k2 = vec3f(-1.0, -1.0,  1.0);
  let k3 = vec3f(-1.0,  1.0, -1.0);
  let k4 = vec3f( 1.0,  1.0,  1.0);
  let n = k1 * mapGallery(p + k1 * e, lampPos, includeLamp).x +
          k2 * mapGallery(p + k2 * e, lampPos, includeLamp).x +
          k3 * mapGallery(p + k3 * e, lampPos, includeLamp).x +
          k4 * mapGallery(p + k4 * e, lampPos, includeLamp).x;
  return normalize(n + vec3f(1e-6));
}

fn surfaceAlbedo(p: vec3f, matId: f32) -> vec3f {
  let m = i32(round(matId));
  if (m == 0) {
    // Travertine floor tiles with crisp subtle grout lines
    let g = abs(fract(p.xz * 1.333 + 0.5) - 0.5);
    let grout = smoothstep(0.465, 0.49, max(g.x, g.y));
    let tileHash = fract(sin(dot(floor(p.xz * 1.333), vec2f(12.9898, 78.233))) * 43758.5453);
    let base = mix(vec3f(0.75, 0.72, 0.68), vec3f(0.81, 0.78, 0.74), tileHash);
    return mix(base, vec3f(0.48, 0.46, 0.44), grout * 0.55);
  }
  if (m == 1) { return vec3f(0.86, 0.84, 0.81); } // ceiling
  if (m == 2) {
    // Limestone back wall with gentle stone courses
    let seam = smoothstep(0.47, 0.495, abs(fract(p.y * 1.65) - 0.5));
    return mix(vec3f(0.84, 0.81, 0.76), vec3f(0.68, 0.65, 0.61), seam * 0.35);
  }
  if (m == 3) { return vec3f(0.95, 0.09, 0.07); } // vivid crimson wall
  if (m == 4) { return vec3f(0.03, 0.74, 0.94); } // vivid electric cyan wall
  if (m == 5) { return vec3f(0.84, 0.82, 0.78); } // thin dividing partition wall
  if (m == 6) { return vec3f(0.70, 0.68, 0.64); } // stone plinths & bench
  if (m == 7) { return vec3f(0.86, 0.84, 0.81); } // sculptural matte alabaster spheres
  if (m == 8) { return vec3f(0.32, 0.26, 0.18); } // brass lamp rod
  return vec3f(1.0, 0.92, 0.76);                  // glowing lamp orb
}

fn traceGallery(ro: vec3f, rd: vec3f, tMin: f32, tMax: f32, lampPos: vec3f, includeLamp: bool, maxSteps: i32) -> vec2f {
  var t = tMin;
  for (var i = 0; i < maxSteps; i = i + 1) {
    let p = ro + rd * t;
    // Allow exterior camera rays to enter open front of gallery (z > 3.85)
    if (p.z > 3.88 && rd.z > 0.0) { return vec2f(-1.0, -1.0); }
    let h = mapGallery(p, lampPos, includeLamp);
    if (h.x < 0.0020) {
      if (p.z > 3.85) { return vec2f(-1.0, -1.0); }
      return vec2f(t, h.y);
    }
    t = t + max(h.x * 0.85, 0.0025);
    if (t > tMax) { break; }
  }
  return vec2f(-1.0, -1.0);
}

// Distance to interior shadow-casting geometry ONLY (divider, plinths, spheres, bench) so outer walls/ceiling never cast spurious soft-shadow rings!
fn mapObstacles(p: vec3f) -> f32 {
  var d = sdBox(p - vec3f(0.0, 1.47, -0.57), vec3f(0.08, 1.47, 1.05));
  d = min(d, sdBox(p - vec3f(-1.46, 0.36, -1.02), vec3f(0.42, 0.36, 0.42)));
  d = min(d, length(p - vec3f(-1.46, 1.20, -1.02)) - 0.48);
  d = min(d, sdBox(p - vec3f(1.44, 0.32, -0.96), vec3f(0.44, 0.32, 0.44)));
  d = min(d, length(p - vec3f(1.44, 1.14, -0.96)) - 0.50);
  d = min(d, sdBox(p - vec3f(0.0, 0.21, 1.05), vec3f(0.86, 0.21, 0.27)));
  d = min(d, sdBox(p - vec3f(-0.46, 0.55, 1.05), vec3f(0.14, 0.14, 0.14)));
  return d;
}

// Sebastian Aaltonen (GDC 2018) improved triangulated soft shadows over interior obstacles — 100% ring-free!
fn softShadow(ro: vec3f, rd: vec3f, tMax: f32, k: f32, lampPos: vec3f) -> f32 {
  var res = 1.0;
  var t = 0.04;
  var ph = 1e10;
  for (var i = 0; i < 40; i = i + 1) {
    let h = mapObstacles(ro + rd * t);
    if (h < 0.0015) { return 0.0; }
    let y = (h * h) / (2.0 * ph);
    let d = sqrt(max(0.0, h * h - y * y));
    res = min(res, k * d / max(0.001, t - y));
    ph = h;
    t = t + clamp(h, 0.02, 0.28);
    if (t >= tMax - 0.06) { break; }
  }
  return clamp(res, 0.0, 1.0);
}

// Evaluates direct illumination from the warm movable pendant lamp + subtle cool front-right gallery clerestory fill.
fn evalDirect(p: vec3f, n: vec3f, albedo: vec3f, matId: f32, lampPos: vec3f, lampInt: f32) -> vec3f {
  let m = i32(round(matId));
  if (m == 9) {
    return vec3f(2.6, 2.05, 1.25) * 1.45;
  }
  // Primary movable warm tungsten pendant lamp
  let toL = lampPos - p;
  let d2 = dot(toL, toL);
  let dist = sqrt(max(d2, 1e-4));
  let ld = toL / dist;
  let ndl = max(dot(n, ld), 0.0);
  var sh = 0.0;
  if (ndl > 0.001) {
    sh = softShadow(p + n * 0.025, ld, dist - 0.16, 10.0, lampPos);
  }
  let atten = lampInt / (0.65 + d2 * 0.58);
  let warmLight = vec3f(1.0, 0.87, 0.66) * (ndl * sh * atten);

  // Subtle cool-neutral front-right gallery clerestory light so cyan wall holds crisp bounce energy even when lamp is left
  let skyPos = vec3f(2.15, 3.05, 2.25);
  let toS = skyPos - p;
  let sd2 = dot(toS, toS);
  let sDist = sqrt(max(sd2, 1e-4));
  let sd = toS / sDist;
  let sNdl = max(dot(n, sd), 0.0);
  var sSh = 0.0;
  if (sNdl > 0.001) {
    sSh = softShadow(p + n * 0.025, sd, sDist - 0.1, 5.0, lampPos);
  }
  let skyLight = vec3f(0.72, 0.92, 1.0) * (sNdl * sSh * (3.9 / (1.6 + sd2 * 0.36)));

  return albedo * (warmLight + skyLight) / PI;
}

// 1996 Quake-style static baked lightmap (chunky 0.24m luxels quantized along surface tangent plane — zero self-hit zebra lines!)
fn evalBakedLightmap1996(p: vec3f, n: vec3f, albedo: vec3f, matId: f32, bakedLamp: vec3f, lampInt: f32) -> vec3f {
  let m = i32(round(matId));
  if (m == 9) { return vec3f(2.4, 1.9, 1.15) * 1.45; }
  let luxel = 0.24;
  // Snap along tangent plane only (keep point cleanly on surface, NEVER pushed inside geometry!)
  let rawSnap = floor(p / luxel + 0.5) * luxel;
  let delta = rawSnap - p;
  let qp = p + delta - n * dot(delta, n);
  let shOrig = p + n * 0.055;

  let toBaked = bakedLamp - qp;
  let bd2 = dot(toBaked, toBaked);
  let bDist = sqrt(max(bd2, 1e-4));
  let bld = toBaked / bDist;
  // Quantized shadow check offset safely outside surface by normal
  let qShOrig = qp + n * 0.095;
  let bSh = select(softShadow(shOrig, bld, bDist - 0.18, 5.5, bakedLamp), softShadow(qShOrig, bld, bDist - 0.18, 5.5, bakedLamp), mapGallery(qShOrig, bakedLamp, false).x > 0.02);
  let bNdl = max(dot(n, bld), 0.0);

  // Static baked crimson bounce from left wall (frozen to u.bakedLamp!)
  let redWallP = vec3f(-2.92, 1.65, -0.60);
  let toRed = redWallP - qp;
  let rDist = length(toRed);
  let rd = toRed / max(rDist, 1e-4);
  let rOcc = softShadow(shOrig, rd, rDist - 0.12, 3.0, bakedLamp);
  let redBounce = vec3f(0.98, 0.13, 0.09) * (max(dot(n, rd), 0.0) * 0.75 + 0.25) * rOcc * (2.65 / (1.1 + rDist * rDist * 0.42));

  // Static baked cyan fill from right clerestory
  let cyanWallP = vec3f(2.92, 1.65, -0.55);
  let toCyan = cyanWallP - qp;
  let cDist = length(toCyan);
  let cd = toCyan / max(cDist, 1e-4);
  let cOcc = softShadow(shOrig, cd, cDist - 0.12, 3.0, bakedLamp);
  let cyanBounce = vec3f(0.06, 0.76, 0.94) * (max(dot(n, cd), 0.0) * 0.70 + 0.25) * cOcc * (1.25 / (1.3 + cDist * cDist * 0.42));

  let floorBounce = vec3f(0.84, 0.66, 0.46) * max(0.0, -n.y * 0.5 + 0.5) * (0.45 / (1.0 + bd2 * 0.18));
  let bakedDirect = vec3f(1.0, 0.85, 0.62) * (bNdl * bSh * (lampInt * 0.95) / (0.68 + bd2 * 0.56));
  let bakedIndirect = (redBounce + cyanBounce + floorBounce) * 0.56 + vec3f(0.04, 0.042, 0.05);
  return albedo * (bakedDirect + bakedIndirect) / PI;
}

// World-space octahedral mapping [0,1]^2 <-> unit sphere
fn octEncode(nIn: vec3f) -> vec2f {
  let n = nIn / (abs(nIn.x) + abs(nIn.y) + abs(nIn.z) + 1e-6);
  var o = n.xy;
  if (n.z < 0.0) {
    let sx = select(-1.0, 1.0, o.x >= 0.0);
    let sy = select(-1.0, 1.0, o.y >= 0.0);
    o = (1.0 - abs(o.yx)) * vec2f(sx, sy);
  }
  return o * 0.5 + 0.5;
}

fn octDecode(uv: vec2f) -> vec3f {
  let f = uv * 2.0 - 1.0;
  var n = vec3f(f.x, f.y, 1.0 - abs(f.x) - abs(f.y));
  let t = max(-n.z, 0.0);
  let sx = select(1.0, -1.0, n.x >= 0.0);
  let sy = select(1.0, -1.0, n.y >= 0.0);
  n.x = n.x + sx * t;
  n.y = n.y + sy * t;
  return normalize(n);
}

fn hash21(p: vec2f) -> f32 {
  var p3 = fract(vec3f(p.x, p.y, p.x) * 0.1031);
  p3 = p3 + dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

fn hash33(p3In: vec3f) -> vec3f {
  var p3 = fract(p3In * vec3f(0.1031, 0.1030, 0.0973));
  p3 = p3 + dot(p3, p3.yxz + 33.33);
  return fract((p3.xxy + p3.yxx) * p3.zyx);
}

fn worldToVoxUv(p: vec3f) -> vec3f {
  return clamp((p - VOX_MIN) / (VOX_MAX - VOX_MIN), vec3f(0.001), vec3f(0.999));
}

fn fibSphere(i: u32, n: u32, rotAngle: f32) -> vec3f {
  let fi = f32(i) + 0.5;
  let fn_ = f32(n);
  let y = 1.0 - 2.0 * (fi / fn_);
  let r = sqrt(max(0.0, 1.0 - y * y));
  let phi = 2.39996323 * fi + rotAngle;
  return vec3f(cos(phi) * r, y, sin(phi) * r);
}
`;

// 1) Compute Pass A: Inject live gallery direct radiance + 1-bounce feedback into 32x24x32 3D Storage Texture
export const VOX_INJECT_WGSL = COMMON_WGSL + /* wgsl */`
@group(0) @binding(0) var<uniform> u: Uniforms;
@group(0) @binding(1) var voxPrev: texture_3d<f32>;
@group(0) @binding(2) var voxSamp: sampler;
@group(0) @binding(3) var voxOut: texture_storage_3d<rgba16float, write>;

@compute @workgroup_size(4, 4, 4)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let dims = vec3u(32u, 24u, 32u);
  if (any(gid >= dims)) { return; }
  let uvw = (vec3f(gid) + 0.5) / vec3f(dims);
  let p = mix(VOX_MIN, VOX_MAX, uvw);
  let voxStep = (VOX_MAX - VOX_MIN) / vec3f(dims);
  let cellR = length(voxStep) * 0.56;

  // Emissive lamp voxels
  let dLamp = length(p - u.lampPos.xyz) - 0.22;
  if (dLamp < cellR) {
    textureStore(voxOut, vec3i(gid), vec4f(2.9, 2.35, 1.45, 0.92));
    return;
  }

  let h = mapGallery(p, u.lampPos.xyz, false);
  // Capture surface shell into 3D voxel volume (thin divider naturally occupies ~1 voxel thickness -> authentic VCT look!)
  if (abs(h.x) < cellR) {
    let n = calcNormal(p, u.lampPos.xyz, false);
    let sp = p - n * h.x;
    let alb = surfaceAlbedo(sp, h.y);
    let direct = evalDirect(sp, n, alb, h.y, u.lampPos.xyz, u.lampPos.w);
    // 2nd bounce feedback from coarser previous-frame voxel mip (keeps energy conserving < 0.75!)
    let fbUv = worldToVoxUv(sp + n * 0.35);
    let prevBounce = textureSampleLevel(voxPrev, voxSamp, fbUv, 0.0).rgb;
    let rad = direct + alb * prevBounce * 0.52;
    let op = clamp(1.0 - abs(h.x) / cellR * 0.35, 0.45, 1.0);
    textureStore(voxOut, vec3i(gid), vec4f(rad, op));
  } else if (h.x < 0.0) {
    textureStore(voxOut, vec3i(gid), vec4f(0.0, 0.0, 0.0, 0.95));
  } else {
    textureStore(voxOut, vec3i(gid), vec4f(0.0));
  }
}
`;

// 2) Compute Pass A2: 3D Voxel Mipmap Downsample (2x2x2 box filter into next 3D storage texture)
export const VOX_MIP_WGSL = /* wgsl */`
@group(0) @binding(0) var voxSrc: texture_3d<f32>;
@group(0) @binding(1) var voxDst: texture_storage_3d<rgba16float, write>;

@compute @workgroup_size(4, 4, 4)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let outDims = textureDimensions(voxDst);
  if (any(gid >= outDims)) { return; }
  let base = vec3i(gid) * 2;
  var sum = vec4f(0.0);
  var wSum = 0.0;
  for (var dz = 0; dz < 2; dz = dz + 1) {
    for (var dy = 0; dy < 2; dy = dy + 1) {
      for (var dx = 0; dx < 2; dx = dx + 1) {
        let v = textureLoad(voxSrc, base + vec3i(dx, dy, dz), 0);
        let w = max(v.a, 0.001);
        sum = sum + vec4f(v.rgb * w, v.a);
        wSum = wSum + w;
      }
    }
  }
  let avgRgb = select(vec3f(0.0), sum.rgb / max(wSum, 1e-4), sum.a > 0.001);
  let avgA = min(1.0, sum.a * 0.28);
  textureStore(voxDst, vec3i(gid), vec4f(avgRgb * min(1.0, avgA * 1.45), avgA));
}
`;

// 3) Compute Pass B: 1998-2004 Irradiance Volume / Valve Ambient Cube Probes (6x4x6 = 144 probes, NO visibility -> real light leak!)
export const PROBE_BASIC_WGSL = COMMON_WGSL + /* wgsl */`
@group(0) @binding(0) var<uniform> u: Uniforms;
@group(0) @binding(1) var<storage, read_write> probeCubes: array<vec4f>;

const PB_X: u32 = 6u;
const PB_Y: u32 = 4u;
const PB_Z: u32 = 6u;

@compute @workgroup_size(64, 1, 1)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let idx = gid.x;
  let total = PB_X * PB_Y * PB_Z;
  if (idx >= total) { return; }

  let px = idx % PB_X;
  let py = (idx / PB_X) % PB_Y;
  let pz = idx / (PB_X * PB_Y);
  let frac = (vec3f(f32(px), f32(py), f32(pz)) + 0.5) / vec3f(f32(PB_X), f32(PB_Y), f32(PB_Z));
  let pos = mix(vec3f(-2.65, 0.35, -2.65), vec3f(2.65, 3.05, 2.35), frac);

  var axes = array<vec3f, 6>(
    vec3f( 1.0, 0.0, 0.0), vec3f(-1.0, 0.0, 0.0),
    vec3f( 0.0, 1.0, 0.0), vec3f( 0.0,-1.0, 0.0),
    vec3f( 0.0, 0.0, 1.0), vec3f( 0.0, 0.0,-1.0)
  );
  var accum = array<vec3f, 6>(vec3f(0.0), vec3f(0.0), vec3f(0.0), vec3f(0.0), vec3f(0.0), vec3f(0.0));
  var wAcc = array<f32, 6>(0.0, 0.0, 0.0, 0.0, 0.0, 0.0);

  let N_RAYS = 24u;
  for (var i = 0u; i < N_RAYS; i = i + 1u) {
    let dir = fibSphere(i, N_RAYS, 0.37);
    let hit = traceGallery(pos, dir, 0.05, 9.0, u.lampPos.xyz, true, 36);
    var rad = vec3f(0.04, 0.05, 0.07);
    if (hit.x > 0.0) {
      let hp = pos + dir * hit.x;
      let hn = calcNormal(hp, u.lampPos.xyz, true);
      let alb = surfaceAlbedo(hp, hit.y);
      rad = evalDirect(hp, hn, alb, hit.y, u.lampPos.xyz, u.lampPos.w);
    }
    for (var a = 0; a < 6; a = a + 1) {
      let w = max(dot(dir, axes[a]), 0.0);
      let w2 = w * w;
      accum[a] = accum[a] + rad * w2;
      wAcc[a] = wAcc[a] + w2;
    }
  }

  let base = idx * 6u;
  for (var a = 0u; a < 6u; a = a + 1u) {
    let col = accum[a] / max(wAcc[a], 1e-4) * PI;
    probeCubes[base + a] = vec4f(col, 1.0);
  }
}
`;

// 4) Compute Pass C: 2019 DDGI Octahedral Irradiance + Chebyshev Depth/Depth^2 Visibility (8x5x8 = 320 probes, workgroup shared memory!)
export const DDGI_UPDATE_WGSL = COMMON_WGSL + /* wgsl */`
@group(0) @binding(0) var<uniform> u: Uniforms;
@group(0) @binding(1) var ddgiIrrPrev: texture_2d<f32>;
@group(0) @binding(2) var ddgiDepPrev: texture_2d<f32>;
@group(0) @binding(3) var voxMip1: texture_3d<f32>;
@group(0) @binding(4) var voxSamp: sampler;
@group(0) @binding(5) var ddgiIrrOut: texture_storage_2d<rgba16float, write>;
@group(0) @binding(6) var ddgiDepOut: texture_storage_2d<rgba16float, write>;

const DG_X: u32 = 8u;
const DG_Y: u32 = 5u;
const DG_Z: u32 = 8u;
const OCT_SZ: u32 = 8u;

var<workgroup> shRayDir: array<vec4f, 64>; // xyz = dir, w = hitDist
var<workgroup> shRayRad: array<vec4f, 64>; // xyz = radiance, w = backFace

@compute @workgroup_size(8, 8, 1)
fn main(
  @builtin(workgroup_id) wgid: vec3u,
  @builtin(local_invocation_id) lid: vec3u,
  @builtin(local_invocation_index) lidx: u32
) {
  let probeIdx = wgid.x;
  let total = DG_X * DG_Y * DG_Z;
  if (probeIdx >= total) { return; }

  let px = probeIdx % DG_X;
  let py = (probeIdx / DG_X) % DG_Y;
  let pz = probeIdx / (DG_X * DG_Y);
  let frac = (vec3f(f32(px), f32(py), f32(pz)) + 0.5) / vec3f(f32(DG_X), f32(DG_Y), f32(DG_Z));
  var pos = mix(vec3f(-2.75, 0.30, -2.75), vec3f(2.75, 3.12, 2.45), frac);

  // Small geometric relocation offset if a probe lands inside the thin divider or a plinth
  let dHere = mapGallery(pos, u.lampPos.xyz, false).x;
  if (dHere < 0.08) {
    let nOut = calcNormal(pos, u.lampPos.xyz, false);
    pos = pos + nOut * (0.12 - dHere);
  }

  // Step 1: Each of the 64 threads traces 1 Fibonacci-sphere ray and stores in shared memory
  let rot = fract(u.camFwd.w * 0.6180339887) * 6.2831853 + f32(probeIdx) * 0.31;
  let rayDir = fibSphere(lidx, 64u, rot);
  let hit = traceGallery(pos, rayDir, 0.03, 9.5, u.lampPos.xyz, true, 40);
  var rad = vec3f(0.035, 0.045, 0.06);
  var hitDist = 7.5;
  var isBack = 0.0;
  if (hit.x > 0.0) {
    hitDist = min(hit.x, 7.5);
    let hp = pos + rayDir * hit.x;
    let hn = calcNormal(hp, u.lampPos.xyz, true);
    if (dot(hn, rayDir) > 0.25) {
      isBack = 1.0;
      hitDist = hitDist * 0.2;
      rad = vec3f(0.0);
    } else {
      let alb = surfaceAlbedo(hp, hit.y);
      let direct = evalDirect(hp, hn, alb, hit.y, u.lampPos.xyz, u.lampPos.w);
      let multi = textureSampleLevel(voxMip1, voxSamp, worldToVoxUv(hp + hn * 0.32), 0.0).rgb;
      rad = direct + alb * multi * 0.55;
    }
  }
  shRayDir[lidx] = vec4f(rayDir, hitDist);
  shRayRad[lidx] = vec4f(rad, isBack);
  workgroupBarrier();

  // Step 2: Convolve 64 rays into octahedral irradiance texel + Chebyshev (meanDist, meanDist^2)
  let octUv = (vec2f(lid.xy) + 0.5) / f32(OCT_SZ);
  let texDir = octDecode(octUv);

  var irrSum = vec3f(0.0);
  var irrW = 0.0;
  var depSum = vec2f(0.0);
  var depW = 0.0;

  for (var i = 0u; i < 64u; i = i + 1u) {
    let rd = shRayDir[i].xyz;
    let hd = shRayDir[i].w;
    let rr = shRayRad[i].xyz;
    let cosA = max(dot(texDir, rd), 0.0);
    if (cosA > 0.001) {
      irrSum = irrSum + rr * cosA;
      irrW = irrW + cosA;
      let cw = pow(cosA, 8.0);
      depSum = depSum + vec2f(hd, hd * hd) * cw;
      depW = depW + cw;
    }
  }

  let newIrr = (irrSum / max(irrW, 1e-4)) * PI;
  let newDep = depSum / max(depW, 1e-4);

  // Atlas coords: X = (px + pz * 8) * 8 + lid.x  (width = 512), Y = py * 8 + lid.y (height = 40)
  let atlasCoord = vec2i(i32((px + pz * DG_X) * OCT_SZ + lid.x), i32(py * OCT_SZ + lid.y));
  let prevIrr = textureLoad(ddgiIrrPrev, atlasCoord, 0).rgb;
  let prevDep = textureLoad(ddgiDepPrev, atlasCoord, 0).rg;
  let h = u.extra.z;
  let outIrr = mix(newIrr, prevIrr, h);
  let outDep = mix(newDep, prevDep, h * 0.72);

  textureStore(ddgiIrrOut, atlasCoord, vec4f(outIrr, 1.0));
  textureStore(ddgiDepOut, atlasCoord, vec4f(outDep.x, outDep.y, 0.0, 1.0));
}
`;

// 5) Compute Pass D: Primary G-Buffer (WorldPos+Mat, WorldNorm+HitT, DirectLit+AlbedoLum)
export const GBUF_WGSL = COMMON_WGSL + /* wgsl */`
@group(0) @binding(0) var<uniform> u: Uniforms;
@group(0) @binding(1) var gPosOut: texture_storage_2d<rgba16float, write>;
@group(0) @binding(2) var gNormOut: texture_storage_2d<rgba16float, write>;
@group(0) @binding(3) var gDirectOut: texture_storage_2d<rgba16float, write>;

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let w = u32(u.res.x);
  let h = u32(u.res.y);
  if (gid.x >= w || gid.y >= h) { return; }

  let uv = (vec2f(gid.xy) + 0.5) / vec2f(f32(w), f32(h));
  let ndc = vec2f(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0);
  let rd = normalize(
    u.camFwd.xyz +
    u.camRight.xyz * (ndc.x * u.camRight.w * u.camPos.w) +
    u.camUp.xyz * (ndc.y * u.camPos.w)
  );

  let hit = traceGallery(u.camPos.xyz, rd, 0.02, 18.0, u.lampPos.xyz, true, 88);
  if (hit.x < 0.0) {
    textureStore(gPosOut, vec2i(gid.xy), vec4f(0.0, 0.0, 0.0, -1.0));
    textureStore(gNormOut, vec2i(gid.xy), vec4f(0.0, 0.0, 1.0, 100.0));
    textureStore(gDirectOut, vec2i(gid.xy), vec4f(0.03, 0.036, 0.052, 0.0));
    return;
  }

  let p = u.camPos.xyz + rd * hit.x;
  let n = calcNormal(p, u.lampPos.xyz, true);
  let alb = surfaceAlbedo(p, hit.y);
  let direct = evalDirect(p, n, alb, hit.y, u.lampPos.xyz, u.lampPos.w);

  textureStore(gPosOut, vec2i(gid.xy), vec4f(p, hit.y));
  textureStore(gNormOut, vec2i(gid.xy), vec4f(n, hit.x));
  textureStore(gDirectOut, vec2i(gid.xy), vec4f(direct, 1.0));
}
`;

// 6) Compute Pass E: Screen-Space SSAO (2007 Crysis) & SSDO / SSGI (2009 Ritschel et al.)
export const SS_PASS_WGSL = COMMON_WGSL + /* wgsl */`
@group(0) @binding(0) var<uniform> u: Uniforms;
@group(0) @binding(1) var gPos: texture_2d<f32>;
@group(0) @binding(2) var gNorm: texture_2d<f32>;
@group(0) @binding(3) var gDirect: texture_2d<f32>;
@group(0) @binding(4) var ssOut: texture_storage_2d<rgba16float, write>;

fn projectWorldToUv(wp: vec3f) -> vec3f {
  let d = wp - u.camPos.xyz;
  let z = dot(d, u.camFwd.xyz);
  if (z <= 0.05) { return vec3f(-1.0, -1.0, -1.0); }
  let x = dot(d, u.camRight.xyz) / (z * u.camRight.w * u.camPos.w);
  let y = dot(d, u.camUp.xyz) / (z * u.camPos.w);
  return vec3f(x * 0.5 + 0.5, 0.5 - y * 0.5, z);
}

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let w = u32(u.res.x);
  let h = u32(u.res.y);
  if (gid.x >= w || gid.y >= h) { return; }

  let posMat = textureLoad(gPos, vec2i(gid.xy), 0);
  if (posMat.w < -0.5) {
    textureStore(ssOut, vec2i(gid.xy), vec4f(0.0, 0.0, 0.0, 1.0));
    return;
  }
  let p = posMat.xyz;
  let normT = textureLoad(gNorm, vec2i(gid.xy), 0);
  let n = normalize(normT.xyz);

  // Build tangent basis
  let up = select(vec3f(1.0, 0.0, 0.0), vec3f(0.0, 1.0, 0.0), abs(n.y) < 0.92);
  let t1 = normalize(cross(up, n));
  let t2 = cross(n, t1);

  let jitter = hash21(vec2f(gid.xy) + fract(u.camUp.w * 0.07)) * 6.2831853;

  // 1) Genuine 2007 Crysis Screen-Space Ambient Occlusion (16 oriented hemisphere depth taps)
  var occ = 0.0;
  let aoRad = 0.52;
  for (var i = 0; i < 16; i = i + 1) {
    let fi = f32(i) + 0.5;
    let ang = fi * 2.399963 + jitter;
    let r = sqrt(fi / 16.0);
    let hDir = normalize(t1 * cos(ang) * r + t2 * sin(ang) * r + n * (0.28 + 0.72 * (1.0 - r)));
    let sampleP = p + hDir * (aoRad * (0.22 + 0.78 * r * r));
    let proj = projectWorldToUv(sampleP);
    if (proj.x > 0.005 && proj.x < 0.995 && proj.y > 0.005 && proj.y < 0.995 && proj.z > 0.05) {
      let sc = vec2i(clamp(vec2i(proj.xy * vec2f(f32(w), f32(h))), vec2i(0), vec2i(i32(w) - 1, i32(h) - 1)));
      let sPos = textureLoad(gPos, sc, 0);
      if (sPos.w >= -0.5) {
        let sZ = dot(sPos.xyz - u.camPos.xyz, u.camFwd.xyz);
        let diff = proj.z - sZ;
        // Classic 2007 Crysis SSAO range falloff (intentionally retains subtle halo at thin partition edge!)
        let rangeW = smoothstep(1.15, 0.15, abs(diff));
        if (diff > 0.03) {
          occ = occ + rangeW;
        }
      }
    }
  }
  // Subtle screen-edge AO fade (signature screen-space limitation!)
  let uv = (vec2f(gid.xy) + 0.5) / vec2f(f32(w), f32(h));
  let edgeFade = smoothstep(0.0, 0.06, min(min(uv.x, 1.0 - uv.x), min(uv.y, 1.0 - uv.y)));
  let ao = clamp(1.0 - (occ / 16.0) * 1.48 * edgeFade, 0.12, 1.0);

  // 2) Genuine 2009 Ritschel SSDO / Screen-Space GI (screen-space ray-march over G-Buffer direct lighting!)
  // Naturally vanishes when colored crimson/cyan wall leaves the screen on Look Away!
  var ssgi = vec3f(0.0);
  let nRays = 12;
  for (var rIdx = 0; rIdx < nRays; rIdx = rIdx + 1) {
    let fi = f32(rIdx) + 0.5;
    let ang = fi * 2.399963 + jitter * 1.37;
    let radFrac = sqrt(fi / f32(nRays));
    let dir = normalize(t1 * cos(ang) * radFrac + t2 * sin(ang) * radFrac + n * sqrt(max(0.04, 1.0 - radFrac * radFrac)));
    var stepT = 0.16;
    for (var s = 0; s < 8; s = s + 1) {
      let sp = p + dir * stepT;
      let proj = projectWorldToUv(sp);
      if (proj.x < 0.01 || proj.x > 0.99 || proj.y < 0.01 || proj.y > 0.99 || proj.z < 0.1) {
        break;
      }
      let sc = vec2i(clamp(vec2i(proj.xy * vec2f(f32(w), f32(h))), vec2i(0), vec2i(i32(w) - 1, i32(h) - 1)));
      let hitP = textureLoad(gPos, sc, 0);
      if (hitP.w >= -0.5) {
        let hitZ = dot(hitP.xyz - u.camPos.xyz, u.camFwd.xyz);
        let dz = proj.z - hitZ;
        if (dz > 0.025 && dz < 0.55) {
          let hitN = textureLoad(gNorm, sc, 0).xyz;
          let hitCol = textureLoad(gDirect, sc, 0).rgb;
          let facing = max(dot(hitN, -dir), 0.12);
          // Smooth viewport edge taper so color bleed disappears smoothly as crimson wall exits frame!
          let eW = smoothstep(0.01, 0.11, min(min(proj.x, 1.0 - proj.x), min(proj.y, 1.0 - proj.y)));
          let distAtten = 1.0 / (0.45 + stepT * stepT * 0.25);
          ssgi = ssgi + hitCol * (facing * eW * distAtten);
          break;
        }
      }
      stepT = stepT * 1.48;
    }
  }
  ssgi = (ssgi / f32(nRays)) * 2.9;

  // Store SSGI in rgb, SSAO in a!
  textureStore(ssOut, vec2i(gid.xy), vec4f(ssgi, ao));
}
`;

// 7) Compute Pass F: 2022 Software SDF GI (UE5 Lumen style — half-res rcW x rcH multi-bounce SDF ray tracing + surface cache -> 60 FPS!)
export const SDF_GI_WGSL = COMMON_WGSL + /* wgsl */`
@group(0) @binding(0) var<uniform> u: Uniforms;
@group(0) @binding(1) var gPos: texture_2d<f32>;
@group(0) @binding(2) var gNorm: texture_2d<f32>;
@group(0) @binding(3) var voxMip1: texture_3d<f32>;
@group(0) @binding(4) var voxSamp: sampler;
@group(0) @binding(5) var giOut: texture_storage_2d<rgba16float, write>;

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let rcW = u32(u.res.z);
  let rcH = u32(u.res.w);
  if (gid.x >= rcW || gid.y >= rcH) { return; }

  let uv = (vec2f(gid.xy) + 0.5) / vec2f(f32(rcW), f32(rcH));
  let gw = i32(u.res.x);
  let gh = i32(u.res.y);
  let gc = clamp(vec2i(uv * vec2f(f32(gw), f32(gh))), vec2i(0), vec2i(gw - 1, gh - 1));

  let posMat = textureLoad(gPos, gc, 0);
  if (posMat.w < -0.5) {
    textureStore(giOut, vec2i(gid.xy), vec4f(0.0));
    return;
  }
  let p = posMat.xyz;
  let n = normalize(textureLoad(gNorm, gc, 0).xyz);

  let up = select(vec3f(1.0, 0.0, 0.0), vec3f(0.0, 1.0, 0.0), abs(n.y) < 0.92);
  let t1 = normalize(cross(up, n));
  let t2 = cross(n, t1);

  let cell = vec2f(f32(gid.x & 3u), f32(gid.y & 3u));
  let bayer = fract(dot(cell, vec2f(0.25, 0.0625)) + hash21(vec2f(gid.xy)) * 0.18);
  let baseAng = bayer * 6.2831853;

  var irr = vec3f(0.0);
  let N_RAYS = 8;
  for (var i = 0; i < N_RAYS; i = i + 1) {
    let u1 = (f32(i) + 0.5) / f32(N_RAYS);
    let ang = f32(i) * 2.3999632 + baseAng;
    let r = sqrt(u1);
    let dir = normalize(t1 * (cos(ang) * r) + t2 * (sin(ang) * r) + n * sqrt(max(0.02, 1.0 - u1)));

    let hit = traceGallery(p + n * 0.032, dir, 0.02, 7.5, u.lampPos.xyz, true, 26);
    if (hit.x > 0.0) {
      let hp = p + n * 0.032 + dir * hit.x;
      let hn = calcNormal(hp, u.lampPos.xyz, true);
      let alb = surfaceAlbedo(hp, hit.y);
      // Fast surface-cache hit evaluation (direct + multi-bounce voxel cache!)
      let m = i32(round(hit.y));
      var rad = vec3f(0.0);
      if (m == 9) {
        rad = vec3f(2.6, 2.05, 1.25) * 1.45;
      } else {
        let toL = u.lampPos.xyz - hp;
        let d2 = dot(toL, toL);
        let ld = toL / sqrt(max(d2, 1e-4));
        let ndl = max(dot(hn, ld), 0.0);
        var sh = 0.0;
        if (ndl > 0.001) {
          sh = softShadow(hp + hn * 0.03, ld, sqrt(d2) - 0.18, 7.0, u.lampPos.xyz);
        }
        let direct = alb * vec3f(1.0, 0.86, 0.64) * (ndl * sh * u.lampPos.w / (0.65 + d2 * 0.58)) / PI;
        let sky = alb * vec3f(0.72, 0.92, 1.0) * (max(dot(hn, normalize(vec3f(2.15, 3.05, 2.25) - hp)), 0.0) * 0.42) / PI;
        let cacheBounce = textureSampleLevel(voxMip1, voxSamp, worldToVoxUv(hp + hn * 0.30), 0.0).rgb;
        rad = direct + sky + alb * cacheBounce * 0.72;
      }
      irr = irr + rad;
    } else {
      irr = irr + vec3f(0.04, 0.055, 0.08);
    }
  }
  irr = (irr / f32(N_RAYS)) * PI;
  textureStore(giOut, vec2i(gid.xy), vec4f(irr, 1.0));
}
`;

// 8) Compute Pass F2: Edge-Stopping À-Trous Bilateral Denoiser (supports both full-res SSDO/SSAO and half-res Lumen SDF!)
export const BILAT_WGSL = /* wgsl */`
struct Uniforms {
  camPos:     vec4f,
  camRight:   vec4f,
  camUp:      vec4f,
  camFwd:     vec4f,
  lampPos:    vec4f,
  bakedLamp:  vec4f,
  stages:     vec4f,
  res:        vec4f,
  rcParams:   vec4f, // x = stepRadius, y = isHalfRes (0=full, 1=rcW x rcH)
  extra:      vec4f,
};

@group(0) @binding(0) var<uniform> u: Uniforms;
@group(0) @binding(1) var gPos: texture_2d<f32>;
@group(0) @binding(2) var gNorm: texture_2d<f32>;
@group(0) @binding(3) var srcTex: texture_2d<f32>;
@group(0) @binding(4) var dstTex: texture_storage_2d<rgba16float, write>;

fn loadGPosAt(c: vec2i, w: i32, h: i32, halfRes: bool) -> vec4f {
  if (!halfRes) { return textureLoad(gPos, c, 0); }
  let uv = (vec2f(c) + 0.5) / vec2f(f32(w), f32(h));
  let gc = clamp(vec2i(uv * u.res.xy), vec2i(0), vec2i(i32(u.res.x) - 1, i32(u.res.y) - 1));
  return textureLoad(gPos, gc, 0);
}

fn loadGNormAt(c: vec2i, w: i32, h: i32, halfRes: bool) -> vec4f {
  if (!halfRes) { return textureLoad(gNorm, c, 0); }
  let uv = (vec2f(c) + 0.5) / vec2f(f32(w), f32(h));
  let gc = clamp(vec2i(uv * u.res.xy), vec2i(0), vec2i(i32(u.res.x) - 1, i32(u.res.y) - 1));
  return textureLoad(gNorm, gc, 0);
}

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let halfRes = u.rcParams.y > 0.5;
  let w = i32(select(u.res.x, u.res.z, halfRes));
  let h = i32(select(u.res.y, u.res.w, halfRes));
  let c = vec2i(gid.xy);
  if (c.x >= w || c.y >= h) { return; }

  let cPos = loadGPosAt(c, w, h, halfRes);
  let cVal = textureLoad(srcTex, c, 0);
  if (cPos.w < -0.5) {
    textureStore(dstTex, c, cVal);
    return;
  }
  let cNorm = loadGNormAt(c, w, h, halfRes);
  let stepR = max(1, i32(u.rcParams.x));
  let kw = array<f32, 3>(1.0, 0.72, 0.32);

  var acc = cVal * 1.0;
  var wSum = 1.0;
  for (var dy = -2; dy <= 2; dy = dy + 1) {
    for (var dx = -2; dx <= 2; dx = dx + 1) {
      if (dx == 0 && dy == 0) { continue; }
      let sc = clamp(c + vec2i(dx * stepR, dy * stepR), vec2i(0), vec2i(w - 1, h - 1));
      let sPos = loadGPosAt(sc, w, h, halfRes);
      if (sPos.w < -0.5) { continue; }
      let sNorm = loadGNormAt(sc, w, h, halfRes);
      let dp = sPos.xyz - cPos.xyz;
      let distW = exp(-dot(dp, dp) * 5.0);
      let normW = pow(max(dot(cNorm.xyz, sNorm.xyz), 0.0), 8.0);
      let spW = kw[abs(dx)] * kw[abs(dy)];
      let wt = spW * distW * normW;
      acc = acc + textureLoad(srcTex, sc, 0) * wt;
      wSum = wSum + wt;
    }
  }
  textureStore(dstTex, c, acc / max(wSum, 1e-4));
}
`;

// 9) Compute Pass G: 2023-2026 Sannikov Radiance Cascades (C2 -> C1 -> C0, real interval raymarching + depth-aware bilinear cascade merging!)
// Constant total texel count rcW x rcH across every cascade:
//   C0: spacing 4 (4x4 = 16 world octahedral dirs), interval [0.03, 0.56]
//   C1: spacing 8 (8x8 = 64 world octahedral dirs), interval [0.52, 1.85]
//   C2: spacing 16 (16x16 = 256 world octahedral dirs), interval [1.75, 8.50]
export const RC_PASS_WGSL = COMMON_WGSL + /* wgsl */`
@group(0) @binding(0) var<uniform> u: Uniforms;
@group(0) @binding(1) var gPos: texture_2d<f32>;
@group(0) @binding(2) var gNorm: texture_2d<f32>;
@group(0) @binding(3) var voxMip1: texture_3d<f32>;
@group(0) @binding(4) var voxSamp: sampler;
@group(0) @binding(5) var rcUpper: texture_2d<f32>;
@group(0) @binding(6) var rcOut: texture_storage_2d<rgba16float, write>;

fn sampleGbufAtRcUv(uv: vec2f) -> vec4f {
  let gw = i32(u.res.x);
  let gh = i32(u.res.y);
  let gc = clamp(vec2i(uv * vec2f(f32(gw), f32(gh))), vec2i(0), vec2i(gw - 1, gh - 1));
  return textureLoad(gPos, gc, 0);
}

fn sampleGnormAtRcUv(uv: vec2f) -> vec4f {
  let gw = i32(u.res.x);
  let gh = i32(u.res.y);
  let gc = clamp(vec2i(uv * vec2f(f32(gw), f32(gh))), vec2i(0), vec2i(gw - 1, gh - 1));
  return textureLoad(gNorm, gc, 0);
}

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let rcW = u32(u.res.z);
  let rcH = u32(u.res.w);
  if (gid.x >= rcW || gid.y >= rcH) { return; }

  let cIdx = i32(u.rcParams.x);
  let sp = u32(u.rcParams.y);     // 4, 8, or 16
  let tStart = u.rcParams.z;
  let tEnd = u.rcParams.w;

  let pIdx = gid.xy / sp;
  let aIdx = gid.xy % sp;
  let probeUv = (vec2f(pIdx) + 0.5) * f32(sp) / vec2f(f32(rcW), f32(rcH));

  let posMat = sampleGbufAtRcUv(probeUv);
  if (posMat.w < -0.5) {
    textureStore(rcOut, vec2i(gid.xy), vec4f(0.0, 0.0, 0.0, 1.0));
    return;
  }
  let p = posMat.xyz;
  let n = normalize(sampleGnormAtRcUv(probeUv).xyz);

  // Globally consistent world-space octahedral ray direction!
  let octUv = (vec2f(aIdx) + 0.5) / f32(sp);
  let dir = octDecode(octUv);

  // For Cascade 0, directions pointing behind the surface never contribute to cosine-weighted irradiance
  if (cIdx == 0 && dot(dir, n) <= -0.15) {
    textureStore(rcOut, vec2i(gid.xy), vec4f(0.0, 0.0, 0.0, 0.0));
    return;
  }

  let origin = p + n * 0.045;
  let maxSteps = select(26, 16, cIdx < 2);
  let hit = traceGallery(origin, dir, tStart, tEnd, u.lampPos.xyz, true, maxSteps);

  var rad = vec3f(0.0);
  var vis = 1.0;

  if (hit.x > 0.0) {
    vis = 0.0;
    let hp = origin + dir * hit.x;
    let hn = calcNormal(hp, u.lampPos.xyz, true);
    let alb = surfaceAlbedo(hp, hit.y);
    let direct = evalDirect(hp, hn, alb, hit.y, u.lampPos.xyz, u.lampPos.w);
    let bounce2 = textureSampleLevel(voxMip1, voxSamp, worldToVoxUv(hp + hn * 0.30), 0.0).rgb;
    rad = direct + alb * bounce2 * 0.62;
  } else if (cIdx == 2) {
    // Far-field ambient exterior sky at end of Cascade 2
    rad = vec3f(0.038, 0.052, 0.075);
  }

  // Sannikov Radiance Cascade Merge: if ray passed interval unoccluded, merge 4 bilinear upper probes x 2x2 child angles!
  if (vis > 0.5 && cIdx < 2) {
    let upSp = sp * 2u;
    let upCount = vec2f(f32(rcW / upSp), f32(rcH / upSp));
    let fUp = (vec2f(pIdx) + 0.5) * 0.5 - 0.5;
    let baseUp = vec2i(floor(fUp));
    let wFrac = fract(fUp);
    let bWeights = array<f32, 4>(
      (1.0 - wFrac.x) * (1.0 - wFrac.y),
      wFrac.x * (1.0 - wFrac.y),
      (1.0 - wFrac.x) * wFrac.y,
      wFrac.x * wFrac.y
    );
    let offs = array<vec2i, 4>(vec2i(0, 0), vec2i(1, 0), vec2i(0, 1), vec2i(1, 1));

    var mergedRad = vec3f(0.0);
    var mergedW = 0.0;
    let maxUp = vec2i(i32(upCount.x) - 1, i32(upCount.y) - 1);

    for (var bi = 0; bi < 4; bi = bi + 1) {
      let upP = clamp(baseUp + offs[bi], vec2i(0), maxUp);
      let upUv = (vec2f(upP) + 0.5) * f32(upSp) / vec2f(f32(rcW), f32(rcH));
      let upPos = sampleGbufAtRcUv(upUv);
      if (upPos.w < -0.5) { continue; }
      // Depth/position-aware cascade weight (stops bleeding across the thin dividing partition!)
      let dp = upPos.xyz - p;
      let dW = exp(-dot(dp, dp) * 1.35);
      let wt = bWeights[bi] * max(dW, 0.002);

      // Average 2x2 refined angular rays in upper cascade C+1
      let upOrigin = vec2i(upP) * i32(upSp) + vec2i(aIdx) * 2;
      let r00 = textureLoad(rcUpper, upOrigin + vec2i(0, 0), 0).rgb;
      let r10 = textureLoad(rcUpper, upOrigin + vec2i(1, 0), 0).rgb;
      let r01 = textureLoad(rcUpper, upOrigin + vec2i(0, 1), 0).rgb;
      let r11 = textureLoad(rcUpper, upOrigin + vec2i(1, 1), 0).rgb;
      let avgChild = (r00 + r10 + r01 + r11) * 0.25;

      mergedRad = mergedRad + avgChild * wt;
      mergedW = mergedW + wt;
    }

    if (mergedW > 1e-4) {
      rad = rad + mergedRad / mergedW;
    }
  }

  textureStore(rcOut, vec2i(gid.xy), vec4f(rad, vis));
}
`;

// 10) Final Fullscreen Render Pass: Evaluates all 8 eras, split-screen comparison, 3D debug overlays & ACES filmic grade
export const COMPOSE_WGSL = COMMON_WGSL + /* wgsl */`
@group(0) @binding(0) var<uniform> u: Uniforms;
@group(0) @binding(1) var linSamp: sampler;
@group(0) @binding(2) var gPos: texture_2d<f32>;
@group(0) @binding(3) var gNorm: texture_2d<f32>;
@group(0) @binding(4) var gDirect: texture_2d<f32>;
@group(0) @binding(5) var ssTex: texture_2d<f32>;
@group(0) @binding(6) var sdfGiTex: texture_2d<f32>;
@group(0) @binding(7) var rcC0: texture_2d<f32>;
@group(0) @binding(8) var rcC1: texture_2d<f32>;
@group(0) @binding(9) var voxMip0: texture_3d<f32>;
@group(0) @binding(10) var voxMip1: texture_3d<f32>;
@group(0) @binding(11) var voxMip2: texture_3d<f32>;
@group(0) @binding(12) var voxMip3: texture_3d<f32>;
@group(0) @binding(13) var ddgiIrr: texture_2d<f32>;
@group(0) @binding(14) var ddgiDep: texture_2d<f32>;
@group(0) @binding(15) var<storage, read> probeCubes: array<vec4f>;

struct VsOut {
  @builtin(position) pos: vec4f,
  @location(0) uv: vec2f,
};

@vertex
fn vsMain(@builtin(vertex_index) vid: u32) -> VsOut {
  var pts = array<vec2f, 3>(
    vec2f(-1.0, -1.0),
    vec2f( 3.0, -1.0),
    vec2f(-1.0,  3.0)
  );
  var out: VsOut;
  out.pos = vec4f(pts[vid], 0.0, 1.0);
  out.uv = vec2f(pts[vid].x * 0.5 + 0.5, 0.5 - pts[vid].y * 0.5);
  return out;
}

// Sample 1998-2004 Ambient Cube Irradiance Volume (6x4x6, pure trilinear -> real thin-wall light leak!)
fn sampleBasicProbes(p: vec3f, n: vec3f) -> vec3f {
  let g = clamp((p - vec3f(-2.65, 0.35, -2.65)) / vec3f(5.30, 2.70, 5.00), vec3f(0.0), vec3f(0.999));
  let f = g * vec3f(5.0, 3.0, 5.0);
  let i0 = vec3u(floor(f));
  let i1 = min(i0 + vec3u(1u), vec3u(5u, 3u, 5u));
  let fr = fract(f);
  let n2 = n * n;

  var irr = vec3f(0.0);
  for (var dz = 0u; dz < 2u; dz = dz + 1u) {
    let wz = select(1.0 - fr.z, fr.z, dz == 1u);
    let pz = select(i0.z, i1.z, dz == 1u);
    for (var dy = 0u; dy < 2u; dy = dy + 1u) {
      let wy = select(1.0 - fr.y, fr.y, dy == 1u);
      let py = select(i0.y, i1.y, dy == 1u);
      for (var dx = 0u; dx < 2u; dx = dx + 1u) {
        let wx = select(1.0 - fr.x, fr.x, dx == 1u);
        let px = select(i0.x, i1.x, dx == 1u);
        let base = (px + py * 6u + pz * 24u) * 6u;
        let cx = select(probeCubes[base + 1u].rgb, probeCubes[base + 0u].rgb, n.x >= 0.0);
        let cy = select(probeCubes[base + 3u].rgb, probeCubes[base + 2u].rgb, n.y >= 0.0);
        let cz = select(probeCubes[base + 5u].rgb, probeCubes[base + 4u].rgb, n.z >= 0.0);
        irr = irr + (cx * n2.x + cy * n2.y + cz * n2.z) * (wx * wy * wz);
      }
    }
  }
  return irr;
}

// Sample 2011 3D Voxel Cone Tracing hierarchy (4 true 3D textures: 32 -> 16 -> 8 -> 4!)
fn sampleVoxLevel(uvw: vec3f, lod: f32) -> vec4f {
  let l = clamp(lod, 0.0, 3.0);
  if (l < 1.0) {
    return mix(
      textureSampleLevel(voxMip0, linSamp, uvw, 0.0),
      textureSampleLevel(voxMip1, linSamp, uvw, 0.0),
      l
    );
  }
  if (l < 2.0) {
    return mix(
      textureSampleLevel(voxMip1, linSamp, uvw, 0.0),
      textureSampleLevel(voxMip2, linSamp, uvw, 0.0),
      l - 1.0
    );
  }
  return mix(
    textureSampleLevel(voxMip2, linSamp, uvw, 0.0),
    textureSampleLevel(voxMip3, linSamp, uvw, 0.0),
    l - 2.0
  );
}

fn traceVoxelCone(p: vec3f, dir: vec3f, aperture: f32) -> vec3f {
  var acc = vec3f(0.0);
  var alpha = 0.0;
  var dist = 0.24;
  for (var i = 0; i < 8; i = i + 1) {
    let sp = p + dir * dist;
    if (any(sp < VOX_MIN) || any(sp > VOX_MAX)) { break; }
    let diam = max(0.20, 2.0 * aperture * dist);
    let lod = clamp(log2(diam / 0.20), 0.0, 3.0);
    let s = sampleVoxLevel(worldToVoxUv(sp), lod);
    let rem = 1.0 - alpha;
    acc = acc + rem * s.rgb;
    alpha = alpha + rem * s.a * 0.78;
    if (alpha > 0.94) { break; }
    dist = dist + diam * 0.62;
  }
  return acc;
}

fn sampleVctGI(p: vec3f, n: vec3f) -> vec3f {
  let up = select(vec3f(1.0, 0.0, 0.0), vec3f(0.0, 1.0, 0.0), abs(n.y) < 0.92);
  let t1 = normalize(cross(up, n));
  let t2 = cross(n, t1);
  let orig = p + n * 0.14;
  var irr = traceVoxelCone(orig, n, 0.55) * 0.34;
  irr = irr + traceVoxelCone(orig, normalize(n * 0.65 + t1 * 0.76), 0.58) * 0.165;
  irr = irr + traceVoxelCone(orig, normalize(n * 0.65 - t1 * 0.76), 0.58) * 0.165;
  irr = irr + traceVoxelCone(orig, normalize(n * 0.65 + t2 * 0.76), 0.58) * 0.165;
  irr = irr + traceVoxelCone(orig, normalize(n * 0.65 - t2 * 0.76), 0.58) * 0.165;
  return irr * 2.85;
}

// Sample 2019 DDGI Probe Grid (8x5x8) with smooth backface + Chebyshev upper-bound visibility (kills thin-wall leaks!)
fn sampleDdgiAtlas(tex: texture_2d<f32>, px: u32, py: u32, pz: u32, dir: vec3f) -> vec4f {
  let octUv = octEncode(dir);
  let tilePos = vec2f(f32((px + pz * 8u) * 8u), f32(py * 8u));
  let atlasUv = (tilePos + 0.5 + octUv * 7.0) / vec2f(512.0, 40.0);
  return textureSampleLevel(tex, linSamp, atlasUv, 0.0);
}

fn sampleDdgiGI(p: vec3f, n: vec3f, viewDir: vec3f) -> vec3f {
  let pMin = vec3f(-2.75, 0.30, -2.75);
  let pMax = vec3f(2.75, 3.12, 2.45);
  let pStep = (pMax - pMin) / vec3f(7.0, 4.0, 7.0);
  let biasP = p + n * 0.09 + viewDir * 0.05;
  let g = clamp((biasP - pMin) / (pMax - pMin), vec3f(0.0), vec3f(0.999));
  let f = g * vec3f(7.0, 4.0, 7.0);
  let i0 = vec3u(floor(f));
  let i1 = min(i0 + vec3u(1u), vec3u(7u, 4u, 7u));
  let fr = fract(f);

  var sumIrr = vec3f(0.0);
  var sumW = 0.0;
  for (var dz = 0u; dz < 2u; dz = dz + 1u) {
    let wz = select(1.0 - fr.z, fr.z, dz == 1u);
    let pz = select(i0.z, i1.z, dz == 1u);
    for (var dy = 0u; dy < 2u; dy = dy + 1u) {
      let wy = select(1.0 - fr.y, fr.y, dy == 1u);
      let py = select(i0.y, i1.y, dy == 1u);
      for (var dx = 0u; dx < 2u; dx = dx + 1u) {
        let wx = select(1.0 - fr.x, fr.x, dx == 1u);
        let px = select(i0.x, i1.x, dx == 1u);

        let fracP = (vec3f(f32(px), f32(py), f32(pz)) + 0.5) / vec3f(8.0, 5.0, 8.0);
        var probePos = mix(pMin, pMax, fracP);
        let dHere = mapGallery(probePos, u.lampPos.xyz, false).x;
        if (dHere < 0.08) {
          probePos = probePos + calcNormal(probePos, u.lampPos.xyz, false) * (0.12 - dHere);
        }

        let toProbe = probePos - biasP;
        let dist = length(toProbe);
        let dirToProbe = toProbe / max(dist, 1e-4);

        // Smooth backface weight (Majercik JCGT 2019 eq. 4)
        let bf = (dot(dirToProbe, n) + 1.0) * 0.5;
        let bfW = bf * bf + 0.02;

        // Chebyshev upper-bound depth visibility (kills thin-wall light leaking!)
        let dep = sampleDdgiAtlas(ddgiDep, px, py, pz, -dirToProbe).rg;
        var chebW = 1.0;
        if (dist > dep.x) {
          let variance = abs(dep.y - dep.x * dep.x);
          let diff = dist - dep.x;
          chebW = variance / (variance + diff * diff + 1e-4);
          chebW = max(chebW * chebW * chebW, 0.001);
        }

        let trilin = wx * wy * wz;
        let wt = max(trilin * bfW * chebW, 1e-5);
        let irr = sampleDdgiAtlas(ddgiIrr, px, py, pz, n).rgb;
        sumIrr = sumIrr + irr * wt;
        sumW = sumW + wt;
      }
    }
  }
  return sumIrr / max(sumW, 1e-4);
}

// Integrate Cascade 0 (4x4 world octahedral dirs per probe) with depth+normal-aware bilinear probe gathering!
fn sampleRadianceCascadesGI(uv: vec2f, p: vec3f, n: vec3f) -> vec3f {
  let rcW = u.res.z;
  let rcH = u.res.w;
  let sp = 4.0;
  let pCount = vec2f(rcW / sp, rcH / sp);
  let fP = uv * pCount - 0.5;
  let baseP = vec2i(floor(fP));
  let fr = fract(fP);
  let bWeights = array<f32, 4>(
    (1.0 - fr.x) * (1.0 - fr.y),
    fr.x * (1.0 - fr.y),
    (1.0 - fr.x) * fr.y,
    fr.x * fr.y
  );
  let offs = array<vec2i, 4>(vec2i(0, 0), vec2i(1, 0), vec2i(0, 1), vec2i(1, 1));
  let maxP = vec2i(i32(pCount.x) - 1, i32(pCount.y) - 1);
  let gw = i32(u.res.x);
  let gh = i32(u.res.y);

  var acc = vec3f(0.0);
  var wSum = 0.0;
  for (var bi = 0; bi < 4; bi = bi + 1) {
    let pp = clamp(baseP + offs[bi], vec2i(0), maxP);
    let pUv = (vec2f(pp) + 0.5) * sp / vec2f(rcW, rcH);
    let gc = clamp(vec2i(pUv * vec2f(f32(gw), f32(gh))), vec2i(0), vec2i(gw - 1, gh - 1));
    let gp = textureLoad(gPos, gc, 0);
    if (gp.w < -0.5) { continue; }
    let gn = textureLoad(gNorm, gc, 0).xyz;
    let dp = gp.xyz - p;
    let dW = exp(-dot(dp, dp) * 2.4);
    let nW = pow(max(dot(gn, n), 0.0), 2.0) + 0.08;
    let pW = bWeights[bi] * max(dW * nW, 0.001);

    // Cosine-weighted hemisphere integral across the 4x4 = 16 world octahedral bins
    var probeIrr = vec3f(0.0);
    var cosW = 0.0;
    let orig = pp * 4;
    for (var ay = 0; ay < 4; ay = ay + 1) {
      for (var ax = 0; ax < 4; ax = ax + 1) {
        let dir = octDecode((vec2f(f32(ax), f32(ay)) + 0.5) * 0.25);
        let c = max(dot(dir, n), 0.0);
        if (c > 0.001) {
          let r = textureLoad(rcC0, orig + vec2i(ax, ay), 0).rgb;
          probeIrr = probeIrr + r * c;
          cosW = cosW + c;
        }
      }
    }
    probeIrr = (probeIrr / max(cosW, 1e-4)) * PI;
    acc = acc + probeIrr * pW;
    wSum = wSum + pW;
  }
  return acc / max(wSum, 1e-4);
}

fn shadeStage(stage: i32, flatAmbient: bool, debugOn: bool, uv: vec2f, p: vec3f, n: vec3f, matId: f32, direct: vec3f, viewDir: vec3f) -> vec3f {
  let alb = surfaceAlbedo(p, matId);
  let m = i32(round(matId));
  if (m == 9) { return direct; }

  // Early-1990s Constant Flat Ambient baseline (used for Split Left of Step 1 & Step 3)
  if (flatAmbient) {
    return direct + alb * vec3f(0.085, 0.090, 0.105);
  }

  // Stage 0: 1996 Baked Lightmaps (Quake) — crisp luxelized baked bounce frozen to u.bakedLamp!
  // Plus a faint live specular/direct cue on the lamp bulb itself so you see the lamp moved while baked lighting didn't!
  if (stage == 0) {
    let baked = evalBakedLightmap1996(p, n, alb, matId, u.bakedLamp.xyz, u.lampPos.w);
    // Add subtle dynamic spot on dynamic spheres only? No: classic Quake lightmaps were static on world brushes,
    // while the glowing lamp orb itself moves cleanly in space, exposing the frozen baked wall/floor bounce!
    return baked;
  }

  // Stage 1: 1998-2004 Irradiance Volumes & Valve Ambient Cube Probes (Greger '98 / HL2 '04)
  // Dynamic objects & walls update live, YET light visibly leaks through the thin dividing partition!
  if (stage == 1) {
    let irr = sampleBasicProbes(p, n);
    return direct + alb * irr * 1.32 / PI;
  }

  // Stage 2: 2007 SSAO (Crysis, Mittring SIGGRAPH 2007 — Occlusion ONLY, NOT true GI!)
  if (stage == 2) {
    let ss = textureSampleLevel(ssTex, linSamp, uv, 0.0);
    if (debugOn) {
      return vec3f(ss.a * ss.a);
    }
    return direct * mix(0.62, 1.0, ss.a) + alb * vec3f(0.11, 0.115, 0.13) * (ss.a * ss.a);
  }

  // Stage 3: 2009 SSDO / Screen-Space GI (Ritschel et al., I3D 2009)
  // Rich colored bounce light from visible crimson & cyan walls — vanishes when Look Away hides the wall!
  if (stage == 3) {
    let ss = textureSampleLevel(ssTex, linSamp, uv, 0.0);
    let ao = ss.a;
    let bounce = ss.rgb;
    return direct + alb * (bounce * 1.38 + vec3f(0.045, 0.05, 0.062) * ao);
  }

  // Stage 4: 2011 Voxel Cone Tracing / SVOGI (Crassin et al. 2011 / UE4 demo 2012)
  // True 3D multi-mip voxel cones: survives Look Away, softer cones + slight thin-wall voxel leak!
  if (stage == 4) {
    let irr = sampleVctGI(p, n);
    return direct + alb * (irr * 1.15 + vec3f(0.025, 0.03, 0.036)) / PI;
  }

  // Stage 5: 2019 DDGI — Dynamic Diffuse GI (Majercik et al., JCGT 2019)
  // Chebyshev depth visibility kills thin-wall light leaking!
  if (stage == 5) {
    let irr = sampleDdgiGI(p, n, viewDir);
    return direct + alb * (irr * 1.35) / PI;
  }

  // Stage 6: 2022 Software SDF GI (UE5 Lumen style) — multi-bounce SDF tracing + surface cache + subtle glossy floor bounce
  if (stage == 6) {
    let irr = textureSampleLevel(sdfGiTex, linSamp, uv, 0.0).rgb;
    var col = direct + alb * (irr * 1.38) / PI;
    if (m == 0) {
      let reflDir = reflect(-viewDir, n);
      let rh = traceGallery(p + n * 0.03, reflDir, 0.03, 7.5, u.lampPos.xyz, true, 32);
      if (rh.x > 0.0) {
        let rp = p + n * 0.03 + reflDir * rh.x;
        let rn = calcNormal(rp, u.lampPos.xyz, true);
        let rAlb = surfaceAlbedo(rp, rh.y);
        let rLit = evalDirect(rp, rn, rAlb, rh.y, u.lampPos.xyz, u.lampPos.w);
        let fres = 0.03 + 0.14 * pow(1.0 - max(dot(n, viewDir), 0.0), 4.0);
        col = col + rLit * fres;
      }
    }
    return col;
  }

  // Stage 7: 2023-2026 Radiance Cascades (Alexander Sannikov 2023 / Path of Exile 2 / three.js Split RC)
  let rcIrr = sampleRadianceCascadesGI(uv, p, n);
  var col = direct + alb * (rcIrr * 1.44) / PI;
  if (m == 0) {
    let reflDir = reflect(-viewDir, n);
    let rh = traceGallery(p + n * 0.03, reflDir, 0.03, 7.5, u.lampPos.xyz, true, 32);
    if (rh.x > 0.0) {
      let rp = p + n * 0.03 + reflDir * rh.x;
      let rn = calcNormal(rp, u.lampPos.xyz, true);
      let rAlb = surfaceAlbedo(rp, rh.y);
      let rLit = evalDirect(rp, rn, rAlb, rh.y, u.lampPos.xyz, u.lampPos.w);
      let fres = 0.035 + 0.15 * pow(1.0 - max(dot(n, viewDir), 0.0), 4.0);
      col = col + rLit * fres;
    }
  }
  return col;
}

// Ray-sphere intersection helper for floating 3D probe debug visualization
fn hitSphere(ro: vec3f, rd: vec3f, cen: vec3f, r: f32) -> f32 {
  let oc = ro - cen;
  let b = dot(oc, rd);
  let c = dot(oc, oc) - r * r;
  let disc = b * b - c;
  if (disc < 0.0) { return -1.0; }
  let t = -b - sqrt(disc);
  return select(-1.0, t, t > 0.05);
}

fn acesFilm(x: vec3f) -> vec3f {
  let a = 2.51;
  let b = 0.03;
  let c = 2.43;
  let d = 0.59;
  let e = 0.14;
  return clamp((x * (a * x + b)) / (x * (c * x + d) + e), vec3f(0.0), vec3f(1.0));
}

@fragment
fn fsMain(in: VsOut) -> @location(0) vec4f {
  let uv = in.uv;
  let w = i32(u.res.x);
  let h = i32(u.res.y);
  let pxCoord = clamp(vec2i(uv * vec2f(f32(w), f32(h))), vec2i(0), vec2i(w - 1, h - 1));

  let ndc = vec2f(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0);
  let rd = normalize(
    u.camFwd.xyz +
    u.camRight.xyz * (ndc.x * u.camRight.w * u.camPos.w) +
    u.camUp.xyz * (ndc.y * u.camPos.w)
  );
  let viewDir = -rd;

  let splitX = u.bakedLamp.w;
  let isLeft = splitX > 0.0 && uv.x < splitX;
  let stage = select(i32(u.stages.y), i32(u.stages.x), isLeft);
  let flatLeft = isLeft && u.stages.z > 0.5;
  let debugOn = u.stages.w > 0.5 && !isLeft;

  let posMat = textureLoad(gPos, pxCoord, 0);
  let normT = textureLoad(gNorm, pxCoord, 0);
  let direct = textureLoad(gDirect, pxCoord, 0).rgb;

  var col = vec3f(0.045, 0.052, 0.072) * (1.0 - 0.35 * uv.y);
  var sceneT = 100.0;

  if (posMat.w >= -0.5) {
    sceneT = normT.w;
    let p = posMat.xyz;
    let n = normalize(normT.xyz);
    col = shadeStage(stage, flatLeft, debugOn, uv, p, n, posMat.w, direct, viewDir);

    // Subtle soft glow halo around the warm pendant lamp bulb
    let toLamp = u.lampPos.xyz - u.camPos.xyz;
    let projT = dot(toLamp, rd);
    if (projT > 0.1 && projT < sceneT + 0.25) {
      let perp = length(toLamp - rd * projT);
      let glow = exp(-perp * perp * 10.0) * 0.45 + exp(-perp * perp * 2.4) * 0.10;
      if (!(stage == 2 && debugOn)) {
        col = col + vec3f(1.0, 0.80, 0.48) * glow;
      }
    }
  }

  // Interactive 3D Debug Overlays!
  if (debugOn && (stage == 1 || stage == 5)) {
    // Show Probes (Stage 1 = 6x4x6 Ambient Cubes; Stage 5 = 8x5x8 DDGI Octahedral Probes)
    let isDdgi = stage == 5;
    let gx = select(6u, 8u, isDdgi);
    let gy = select(4u, 5u, isDdgi);
    let gz = select(6u, 8u, isDdgi);
    let pMin = select(vec3f(-2.65, 0.35, -2.65), vec3f(-2.75, 0.30, -2.75), isDdgi);
    let pMax = select(vec3f(2.65, 3.05, 2.35), vec3f(2.75, 3.12, 2.45), isDdgi);
    var bestT = sceneT;
    var bestCol = col;
    for (var pz = 0u; pz < gz; pz = pz + 1u) {
      for (var py = 0u; py < gy; py = py + 1u) {
        for (var px = 0u; px < gx; px = px + 1u) {
          let frac = (vec3f(f32(px), f32(py), f32(pz)) + 0.5) / vec3f(f32(gx), f32(gy), f32(gz));
          let cen = mix(pMin, pMax, frac);
          let ht = hitSphere(u.camPos.xyz, rd, cen, 0.085);
          if (ht > 0.0 && ht < bestT) {
            bestT = ht;
            let hp = u.camPos.xyz + rd * ht;
            let hn = normalize(hp - cen);
            var pIrr = vec3f(0.0);
            if (isDdgi) {
              pIrr = sampleDdgiAtlas(ddgiIrr, px, py, pz, hn).rgb;
            } else {
              let base = (px + py * 6u + pz * 24u) * 6u;
              let n2 = hn * hn;
              let cx = select(probeCubes[base + 1u].rgb, probeCubes[base + 0u].rgb, hn.x >= 0.0);
              let cy = select(probeCubes[base + 3u].rgb, probeCubes[base + 2u].rgb, hn.y >= 0.0);
              let cz = select(probeCubes[base + 5u].rgb, probeCubes[base + 4u].rgb, hn.z >= 0.0);
              pIrr = cx * n2.x + cy * n2.y + cz * n2.z;
            }
            let rim = pow(1.0 - max(dot(hn, viewDir), 0.0), 3.0);
            let rimCol = select(vec3f(1.0, 0.72, 0.32), vec3f(0.32, 0.96, 0.76), isDdgi);
            bestCol = pIrr * 0.62 + rimCol * (0.28 + rim * 0.9);
          }
        }
      }
    }
    col = bestCol;
  } else if (debugOn && stage == 4) {
    // Show Voxels (Stage 4 = live 32x24x32 3D Storage Texture ray-casted!)
    var vCol = vec3f(0.0);
    var vA = 0.0;
    var t = 0.4;
    for (var s = 0; s < 52; s = s + 1) {
      if (t > sceneT + 0.25 || vA > 0.92) { break; }
      let vp = u.camPos.xyz + rd * t;
      if (all(vp > VOX_MIN) && all(vp < VOX_MAX)) {
        let uvw = worldToVoxUv(vp);
        let vc = vec3i(floor(uvw * vec3f(32.0, 24.0, 32.0)));
        let vs = textureLoad(voxMip0, clamp(vc, vec3i(0), vec3i(31, 23, 31)), 0);
        if (vs.a > 0.25) {
          let cellF = fract(uvw * vec3f(32.0, 24.0, 32.0));
          let edge = max(max(abs(cellF.x - 0.5), abs(cellF.y - 0.5)), abs(cellF.z - 0.5));
          let wire = smoothstep(0.41, 0.48, edge);
          let cubeCol = vs.rgb * 0.96 + vec3f(0.95, 0.78, 0.42) * wire * 0.30;
          vCol = vCol + (1.0 - vA) * cubeCol * 0.80;
          vA = vA + (1.0 - vA) * 0.72;
        }
      }
      t = t + 0.14;
    }
    col = mix(col * 0.28, vCol, clamp(vA, 0.0, 1.0));
  } else if (debugOn && stage == 7) {
    // Show Cascades (Stage 7 = subtle C0 probe grid overlay + live Cascade 1 angular radiance probe inset!)
    let rcW = u.res.z;
    let rcH = u.res.w;
    let cellC0 = fract(uv * vec2f(rcW / 4.0, rcH / 4.0));
    let dotDist = length(cellC0 - 0.5);
    let probeDot = smoothstep(0.15, 0.07, dotDist);
    let cellC1 = fract(uv * vec2f(rcW / 8.0, rcH / 8.0));
    let gridLine = smoothstep(0.46, 0.495, max(abs(cellC1.x - 0.5), abs(cellC1.y - 0.5)));
    col = mix(col, vec3f(0.32, 0.96, 0.78), gridLine * 0.14);
    col = mix(col, vec3f(1.0, 0.78, 0.36), probeDot * 0.24);

    // Picture-in-picture live Cascade 1 (8x8 angular radiance probe blocks!) in upper-right safe area
    let boxMin = vec2f(0.64, 0.14);
    let boxMax = vec2f(0.96, 0.46);
    if (uv.x >= boxMin.x && uv.x <= boxMax.x && uv.y >= boxMin.y && uv.y <= boxMax.y) {
      let bUv = (uv - boxMin) / (boxMax - boxMin);
      let border = max(abs(bUv.x - 0.5), abs(bUv.y - 0.5)) > 0.486;
      if (border) {
        col = vec3f(0.95, 0.72, 0.34) * 1.4;
      } else {
        // Zoom into central Cascade 1 probe blocks (8x8 angular radiance tiles per probe!)
        let zUv = vec2f(0.24, 0.24) + bUv * 0.52;
        let rcCoord = clamp(vec2i(zUv * vec2f(rcW, rcH)), vec2i(0), vec2i(i32(rcW) - 1, i32(rcH) - 1));
        let c1Val = textureLoad(rcC1, rcCoord, 0).rgb;
        let localA = vec2f(f32(rcCoord.x % 8), f32(rcCoord.y % 8)) / 8.0;
        let tileEdge = (localA.x < 0.02 || localA.y < 0.02);
        col = select(c1Val * 1.15, vec3f(0.14, 0.20, 0.30), tileEdge);
      }
    }
  }

  // Exposure + ACES Filmic + sRGB
  var outCol = acesFilm(col * 1.12);
  // Subtle theatrical vignette
  let v = (uv - 0.5) * vec2f(1.15, 1.0);
  outCol = outCol * clamp(1.0 - dot(v, v) * 0.22, 0.76, 1.0);
  outCol = pow(max(outCol, vec3f(0.0)), vec3f(1.0 / 2.2));

  // Crisp amber split-screen divider line
  if (splitX > 0.0 && abs(uv.x - splitX) < 1.5 / u.res.x) {
    outCol = vec3f(0.93, 0.65, 0.37);
  }

  return vec4f(outCol, 1.0);
}
`;
