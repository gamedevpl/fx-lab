// GLSL ES 3.00 shaders for Evolution of Water, split into clean single-purpose passes
// for fast parallel GPU compilation and readable architecture:
//   Pass 1 (BASIN_FS)  — Stone cistern, aqueduct arch, lantern, pillar, shards & plunging sphere + depth
//   Pass 2 (WATER_FS)  — All 8 water eras, Beer-Lambert depth, Fresnel arch reflection, Gerstner/PDE & caustics
//   Pass 3 (SPLASH_FS) — Step 8 3D translucent liquid splash crown, Worthington jet & 24 ballistic droplets
//   Pass 4 (BLUR_FS)   — Separable Gaussian HDR bloom
//   Pass 5 (FINAL_FS)  — ACES filmic tone mapping

const COMMON_GLSL = `
const float PI = 3.14159265;
const vec3 SUN_DIR = normalize(vec3(-0.56, 0.34, -0.75));
const vec3 SUN_COL = vec3(1.0, 0.84, 0.62);
const vec3 MOON_DIR = normalize(vec3(0.42, 0.72, 0.55));
const vec3 LANTERN_POS = vec3(-0.08, 0.88, -1.28);
const vec2 IMPACT_XZ = vec2(-0.38, 0.18);

float hash11(float n) { return fract(sin(n * 127.1 + 311.7) * 43758.5453); }

float hash21(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}

float hash31(vec3 p) {
  p = fract(p * 0.1031);
  p += dot(p, p.yzx + 33.33);
  return fract((p.x + p.y) * p.z);
}

float noise2(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(hash21(i), hash21(i + vec2(1, 0)), f.x),
    mix(hash21(i + vec2(0, 1)), hash21(i + vec2(1, 1)), f.x),
    f.y
  );
}

float noise3(vec3 p) {
  vec3 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(mix(hash31(i), hash31(i + vec3(1, 0, 0)), f.x), mix(hash31(i + vec3(0, 1, 0)), hash31(i + vec3(1, 1, 0)), f.x), f.y),
    mix(mix(hash31(i + vec3(0, 0, 1)), hash31(i + vec3(1, 0, 1)), f.x), mix(hash31(i + vec3(0, 1, 1)), hash31(i + vec3(1, 1, 1)), f.x), f.y),
    f.z
  );
}

float fbm2(vec2 p) {
  float s = 0.0, a = 0.5;
  mat2 rot = mat2(0.8, 0.6, -0.6, 0.8);
  for (int i = 0; i < 4; i++) {
    s += a * noise2(p);
    p = rot * p * 2.04;
    a *= 0.5;
  }
  return s;
}

float sdBox(vec3 p, vec3 b) {
  vec3 q = abs(p) - b;
  return length(max(q, 0.0)) + min(max(q.x, max(q.y, q.z)), 0.0);
}

float sdCappedCylinder(vec3 p, float h, float r) {
  vec2 d = abs(vec2(length(p.xz), p.y)) - vec2(r, h);
  return min(max(d.x, d.y), 0.0) + length(max(d, 0.0));
}

vec2 opU(vec2 a, vec2 b) { return a.x < b.x ? a : b; }

// Sloped cistern floor: shallow shelf on the left, deep bowl on the right.
float basinFloorY(vec2 xz) {
  float r = length(xz);
  float shallowMask = smoothstep(0.18, -0.80, xz.x * 0.85 - xz.y * 0.35);
  float deepBowl = -0.58 + 0.16 * pow(clamp(r / 1.46, 0.0, 1.0), 2.0);
  float stepShelf = -0.17 - 0.04 * smoothstep(-1.1, -0.3, xz.x);
  return mix(deepBowl, stepShelf, shallowMask);
}

// Exact 16-bit depth packing into RGBA8 RG channels (range 0..32 world units).
vec2 packDepth16(float dist) {
  float d16 = floor(clamp(dist / 32.0, 0.0, 1.0) * 65535.0 + 0.5);
  return vec2(floor(d16 / 256.0), mod(d16, 256.0)) / 255.0;
}

float unpackDepth16(vec2 rg) {
  return (floor(rg.x * 255.0 + 0.5) * 256.0 + floor(rg.y * 255.0 + 0.5)) * (32.0 / 65535.0);
}

vec3 evalSky(vec3 rd, vec2 screenUv, float aspect, float time, bool isRefl) {
  float elev = isRefl ? clamp(rd.y * 0.95 + 0.30, 0.0, 1.0) : screenUv.y;
  vec3 cTop = vec3(0.08, 0.13, 0.27);
  vec3 cMid = vec3(0.16, 0.25, 0.44);
  vec3 cHor = vec3(0.32, 0.42, 0.60);
  vec3 cLow = vec3(0.12, 0.18, 0.34);

  vec3 col = (elev > 0.30)
    ? mix(cHor, mix(cMid, cTop, smoothstep(0.32, 1.0, clamp((elev - 0.30) / 0.70, 0.0, 1.0))), smoothstep(0.0, 0.78, clamp((elev - 0.30) / 0.70, 0.0, 1.0)))
    : mix(cLow, cHor, smoothstep(0.0, 1.0, clamp(elev / 0.30, 0.0, 1.0)));

  float sDot = max(dot(normalize(rd), SUN_DIR), 0.0);
  col += vec3(0.95, 0.56, 0.28) * pow(sDot, 7.0) * (isRefl ? 0.85 : 0.42);
  col += vec3(1.0, 0.88, 0.65) * pow(sDot, 80.0) * (isRefl ? 1.80 : 0.65);
  if (isRefl) col += vec3(1.8, 1.5, 1.1) * smoothstep(0.9965, 0.9992, sDot);

  if (!isRefl) {
    vec2 g = screenUv * vec2(26.0 * aspect, 26.0);
    vec2 cid = floor(g), f = fract(g) - 0.5;
    float sh = fract(sin(dot(cid, vec2(127.1, 311.7))) * 43758.5453);
    if (sh > 0.962 && screenUv.y > 0.46) {
      float tw = 0.55 + 0.45 * sin(time * 1.45 + sh * 90.0);
      col += vec3(0.95, 0.90, 0.75) * exp(-dot(f, f) * 28.0) * tw * 0.65;
    }
  } else {
    vec2 rg = vec2(atan(rd.z, rd.x) * 8.0, rd.y * 18.0);
    vec2 cid = floor(rg), f = fract(rg) - 0.5;
    if (hash21(cid) > 0.955 && rd.y > 0.16) {
      col += vec3(0.95, 0.90, 0.75) * exp(-dot(f, f) * 26.0) * 0.75;
    }
  }
  return col;
}
`;

// ============================================================================
// PASS 1: Solid stone cistern, aqueduct arch, lantern, pillar & plunging sphere
// ============================================================================
export const BASIN_FS = `#version 300 es
precision highp float;

in vec2 vUv;

uniform vec3 uCamPos;
uniform vec3 uCamRight;
uniform vec3 uCamUp;
uniform vec3 uCamFwd;
uniform float uTanHalfFov;
uniform float uAspect;
uniform float uTime;
uniform vec3 uColliderPos;
uniform float uColliderActive;
uniform float uSphereWet;

layout(location = 0) out vec4 outColor;
layout(location = 1) out vec4 outDepth; // rg = 16-bit hit distance / 32, b = matId / 10

${COMMON_GLSL}

vec2 mapBasin(vec3 p) {
  float r = length(p.xz);
  float ang = atan(p.z, p.x);
  float crag = 0.075 * sin(ang * 6.0 + p.y * 3.5) + 0.038 * cos(ang * 11.0 - p.y * 5.2);
  float belowRim = smoothstep(-0.14, -0.34, p.y);
  float rockTaper = (p.y > -0.16) ? 1.0 : clamp(1.0 + (p.y + 0.16) * 0.72, 0.10, 1.0);
  float outerRad = 1.82 * rockTaper + crag * belowRim;
  float floorY = basinFloorY(p.xz);
  float cavRad = min(1.46, max(0.20, outerRad - 0.30));
  float rimHeight = 0.22 - 0.07 * smoothstep(0.55, 1.05, p.z);
  float outerCyl = max(r - outerRad, max(p.y - rimHeight, -1.42 - p.y - crag * 0.25));
  float cavity = max(r - cavRad, floorY - p.y);
  float dBasin = max(outerCyl, -cavity);
  float matBasin = (r < cavRad - 0.025 && p.y < floorY + 0.055 && p.y > floorY - 0.12) ? 2.0 : 1.0;
  vec2 res = vec2(dBasin, matBasin);

  // Sunken pebbles
  res = opU(res, vec2(length((p - vec3(-0.78, floorY + 0.04,  0.34)) / vec3(0.24, 0.11, 0.19)) * 0.16 - 0.16, 4.0));
  res = opU(res, vec2(length((p - vec3(-0.24, floorY + 0.05, -0.58)) / vec3(0.28, 0.13, 0.22)) * 0.18 - 0.18, 4.0));
  res = opU(res, vec2(length((p - vec3( 0.18, floorY + 0.05,  0.68)) / vec3(0.21, 0.10, 0.17)) * 0.15 - 0.15, 4.0));

  // Mooring pillar
  float dPil = sdCappedCylinder(p - vec3(0.62, -0.06, -0.18), 0.52, 0.165);
  float dCap = sdCappedCylinder(p - vec3(0.62,  0.45, -0.18), 0.045, 0.195);
  res = opU(res, vec2(min(dPil, dCap), 3.0));

  // Aqueduct arch & glowing hanging lantern
  {
    vec3 ap = p - vec3(-0.08, 0.0, -1.28);
    float colL = sdBox(ap - vec3(-0.68, 0.56, 0.0), vec3(0.16, 0.48, 0.17)) - 0.02;
    float colR = sdBox(ap - vec3( 0.68, 0.56, 0.0), vec3(0.16, 0.48, 0.17)) - 0.02;
    float lintel = sdBox(ap - vec3(0.0, 1.02, 0.0), vec3(0.88, 0.26, 0.18)) - 0.02;
    float archCut = length(ap.xy - vec2(0.0, 0.56)) - 0.52;
    float cornice = sdBox(ap - vec3(0.0, 1.29, 0.0), vec3(0.94, 0.045, 0.21)) - 0.015;
    res = opU(res, vec2(min(min(colL, colR), min(max(lintel, -archCut), cornice)), 3.0));
    res = opU(res, vec2(sdCappedCylinder(p - vec3(-0.08, 1.02, -1.28), 0.12, 0.014), 1.0));
    res = opU(res, vec2(length(p - LANTERN_POS) - 0.085, 5.0));
  }

  // Orbiting mini-rock shards
  {
    float orb = uTime * 0.1745, bob = sin(uTime * 0.87) * 0.08;
    vec2 p1 = vec2(cos(orb) * (-1.86) - sin(orb) * 0.32, sin(orb) * (-1.86) + cos(orb) * 0.32);
    vec2 p2 = vec2(cos(orb) * ( 1.86) - sin(orb) * (-0.22), sin(orb) * ( 1.86) + cos(orb) * (-0.22));
    res = opU(res, vec2(length(p - vec3(p1.x, -0.64 + bob, p1.y)) - 0.12, 1.0));
    res = opU(res, vec2(length(p - vec3(p2.x, -0.52 - bob, p2.y)) - 0.11, 1.0));
    res = opU(res, vec2(length(p - vec3( 0.42, -1.46 + bob * 1.1,  0.85)) - 0.10, 1.0));
    res = opU(res, vec2(length(p - vec3(-1.22, -1.04 - bob * 1.1, -0.95)) - 0.11, 1.0));
  }

  if (uColliderActive > 0.5) {
    float dCol = max(length(p - uColliderPos) - 0.21, floorY - 0.02 - p.y);
    res = opU(res, vec2(dCol, 6.0));
  }
  return res;
}

vec3 calcNormal(vec3 p) {
  const vec2 k = vec2(1.0, -1.0);
  const float h = 0.0026;
  return normalize(
    k.xyy * mapBasin(p + k.xyy * h).x +
    k.yyx * mapBasin(p + k.yyx * h).x +
    k.yxy * mapBasin(p + k.yxy * h).x +
    k.xxx * mapBasin(p + k.xxx * h).x
  );
}

float softShadow(vec3 ro, vec3 rd) {
  float sh = 1.0, t = 0.04;
  for (int i = 0; i < 12; i++) {
    float h = mapBasin(ro + rd * t).x;
    sh = min(sh, clamp(6.0 * h / t, 0.0, 1.0));
    t += clamp(h, 0.05, 0.25);
    if (sh < 0.03 || t > 4.0) break;
  }
  return sh;
}

void main() {
  vec2 ndc = vUv * 2.0 - 1.0;
  vec3 ro = uCamPos;
  vec3 rd = normalize(uCamFwd + ndc.x * uAspect * uTanHalfFov * uCamRight + ndc.y * uTanHalfFov * uCamUp);

  vec3 col = evalSky(rd, vUv, uAspect, uTime, false);
  float hitDist = 31.9, hitMat = 0.0;

  vec3 oc = ro - vec3(0.0, -0.15, 0.0);
  float b = dot(oc, rd);
  float disc = b * b - (dot(oc, oc) - 3.65 * 3.65);
  if (disc > 0.0) {
    float t = max(0.05, -b - sqrt(disc));
    float tMax = min(22.0, -b + sqrt(disc));
    for (int i = 0; i < 68; i++) {
      vec2 h = mapBasin(ro + rd * t);
      if (h.x < 0.0024) { hitDist = t; hitMat = h.y; break; }
      t += h.x * 0.76;
      if (t > tMax) break;
    }
  }

  if (hitMat > 0.5) {
    vec3 pos = ro + rd * hitDist;
    vec3 n = calcNormal(pos);
    vec3 v = -rd;
    vec3 albedo = vec3(0.32, 0.34, 0.40);
    vec3 emissive = vec3(0.0);
    float rough = 0.78, metal = 0.0, wetClearcoat = 0.0;

    if (hitMat < 1.5) {
      float topMask = smoothstep(0.45, 0.85, n.y) * smoothstep(-0.02, 0.12, pos.y);
      float innerWall = smoothstep(1.56, 1.44, length(pos.xz)) * smoothstep(-0.85, 0.18, pos.y);
      float ang = atan(pos.z, pos.x), seg = fract(ang / (2.0 * PI) * 20.0);
      float seam = smoothstep(0.025, 0.065, min(seg, 1.0 - seg));
      float tone = hash21(vec2(floor(ang / (2.0 * PI) * 20.0), 3.0)), gr = noise3(pos * 12.0);
      vec3 rimStone = mix(vec3(0.11, 0.13, 0.20), vec3(0.28, 0.31, 0.40) * (0.82 + 0.32 * tone), seam) * (0.85 + 0.30 * gr);
      vec3 cragStone = vec3(0.11, 0.14, 0.22) * (0.75 + 0.42 * noise3(pos * 5.5));
      vec3 basinInner = vec3(0.22, 0.28, 0.36) * (0.85 + 0.25 * gr);
      float wet = smoothstep(0.16, 0.02, pos.y) * smoothstep(-0.08, 0.02, pos.y);
      albedo = mix(mix(cragStone, rimStone, topMask), basinInner, innerWall * (1.0 - topMask)) * (1.0 - 0.28 * wet);
      rough = mix(0.84, 0.28, wet);
    } else if (hitMat < 2.5) {
      vec2 tileUv = pos.xz * 4.4, cid = floor(tileUv), cf = fract(tileUv);
      float grout = smoothstep(0.04, 0.09, min(cf.x, 1.0 - cf.x)) * smoothstep(0.04, 0.09, min(cf.y, 1.0 - cf.y));
      float chk = mod(cid.x + cid.y, 2.0), varT = hash21(cid);
      albedo = mix(vec3(0.15, 0.18, 0.22), mix(vec3(0.22, 0.46, 0.58) * (0.85 + 0.25 * varT), vec3(0.80, 0.74, 0.62) * (0.88 + 0.22 * varT), chk), grout);
      rough = 0.55;
    } else if (hitMat < 3.5) {
      float brY = fract(pos.y * 4.8);
      float brX = fract((pos.x + pos.z) * 2.8 + mod(floor(pos.y * 4.8), 2.0) * 0.5);
      float mortar = smoothstep(0.03, 0.08, min(brY, 1.0 - brY)) * smoothstep(0.03, 0.08, min(brX, 1.0 - brX));
      float tone = hash21(vec2(floor(pos.y * 4.8), floor((pos.x + pos.z) * 2.8)));
      vec3 lime = mix(vec3(0.18, 0.20, 0.26), vec3(0.56, 0.53, 0.48) * (0.84 + 0.28 * tone), mortar);
      float wet = smoothstep(0.15, -0.04, pos.y);
      albedo = mix(lime, lime * vec3(0.58, 0.72, 0.68), wet * 0.62);
      rough = mix(0.76, 0.30, wet);
    } else if (hitMat < 4.5) {
      albedo = mix(vec3(0.32, 0.36, 0.34), vec3(0.58, 0.54, 0.46), noise3(pos * 8.0));
      rough = 0.48;
    } else if (hitMat < 5.5) {
      albedo = vec3(1.0, 0.85, 0.55);
      emissive = vec3(3.4, 2.2, 0.95);
      rough = 0.20;
    } else {
      // Plunging terracotta-bronze sphere with dynamic soaking wetness & clearcoat.
      vec3 lp = pos - uColliderPos;
      float band = smoothstep(0.80, 0.95, abs(sin(lp.y * 24.0 + lp.x * 6.0)));
      vec3 dryCol = mix(vec3(0.46, 0.38, 0.32), vec3(0.86, 0.62, 0.26), band * 0.72) * (0.88 + 0.24 * noise3(lp * 18.0));
      float wetAmt = uSphereWet;
      float rivulet = smoothstep(0.68, 0.94, noise2(vec2(atan(lp.z, lp.x) * 4.5, lp.y * 8.5 + uTime * 1.45)));
      albedo = dryCol * mix(1.0, 0.44, wetAmt);
      metal = mix(0.35, 0.58, band);
      rough = mix(0.60, 0.05, wetAmt);
      wetClearcoat = wetAmt * (0.82 + 0.18 * rivulet);
      if (wetAmt > 0.3) {
        float meniscus = smoothstep(0.055, 0.005, abs(pos.y)) * smoothstep(0.30, 0.65, noise2(pos.xz * 18.0 + uTime));
        albedo = mix(albedo, vec3(0.92, 0.98, 1.0), meniscus * 0.85);
        wetClearcoat = mix(wetClearcoat, 0.0, meniscus);
      }
    }

    vec3 amb = mix(vec3(0.10, 0.14, 0.24), vec3(0.28, 0.36, 0.54), n.y * 0.5 + 0.5);
    col = albedo * amb * (1.0 - metal * 0.55);
    float shSun = softShadow(pos + n * 0.015, SUN_DIR);
    float ndlSun = max(dot(n, SUN_DIR), 0.0);
    float specSun = pow(max(dot(n, normalize(SUN_DIR + v)), 0.0), mix(18.0, 140.0, 1.0 - rough)) * mix(0.20, 1.5, metal);
    col += (albedo * (1.0 - metal * 0.7) * ndlSun + mix(vec3(1.0), albedo, metal) * specSun) * SUN_COL * 1.15 * shSun;
    col += albedo * (1.0 - metal * 0.6) * max(dot(n, MOON_DIR), 0.0) * vec3(0.45, 0.58, 0.88) * 0.52;

    float lanFlicker = 1.0 + 0.10 * sin(uTime * 6.3) + 0.05 * cos(uTime * 11.7);
    vec3 toL = LANTERN_POS - pos;
    float distL = length(toL);
    col += albedo * vec3(1.0, 0.68, 0.32) * max(dot(n, toL / max(distL, 0.001)), 0.0) / (0.18 + distL * distL * 1.4) * 1.35 * lanFlicker;

    if (wetClearcoat > 0.01) {
      float fres = 0.06 + 0.94 * pow(1.0 - max(dot(n, v), 0.0), 3.4);
      vec3 envRefl = evalSky(reflect(-v, n), vUv, uAspect, uTime, true);
      float wetSpec = pow(max(dot(n, normalize(SUN_DIR + v)), 0.0), 340.0) * 4.2;
      float wetMoon = pow(max(dot(n, normalize(MOON_DIR + v)), 0.0), 160.0) * 1.4;
      col = mix(col, envRefl, fres * wetClearcoat * 0.90) + (SUN_COL * wetSpec + vec3(0.75, 0.90, 1.0) * wetMoon) * wetClearcoat;
    }
    col += emissive;
  }

  outColor = vec4(max(col, vec3(0.0)), 1.0);
  outDepth = vec4(packDepth16(hitDist), hitMat / 10.0, 1.0);
}
`;

// ============================================================================
// PASS 2: All 8 water eras (surface trace, underwater refraction & caustics, arch reflection)
// ============================================================================
export const WATER_FS = `#version 300 es
precision highp float;

in vec2 vUv;

uniform sampler2D uTexScene;
uniform sampler2D uTexDepth;
uniform sampler2D uTexPalIdx;
uniform sampler2D uTexTile;
uniform sampler2D uTexWave;
uniform vec3 uClut16[16];

uniform vec3 uCamPos;
uniform vec3 uCamRight;
uniform vec3 uCamUp;
uniform vec3 uCamFwd;
uniform float uTanHalfFov;
uniform float uAspect;
uniform float uTime;

uniform int uStageLeft;
uniform int uStageRight;
uniform float uWipeX;
uniform float uClutIndexOnly;
uniform vec3 uColliderPos;
uniform float uColliderActive;
uniform float uSplashTime;

layout(location = 0) out vec4 outHdr;
layout(location = 1) out vec4 outBloom;
layout(location = 2) out vec4 outWaterDepth;

${COMMON_GLSL}

// Lightweight SDF for mirror reflections above the water (arch, lantern & mooring pillar only).
vec2 mapAboveWater(vec3 p) {
  float dPil = sdCappedCylinder(p - vec3(0.62, -0.06, -0.18), 0.52, 0.165);
  float dCap = sdCappedCylinder(p - vec3(0.62,  0.45, -0.18), 0.045, 0.195);
  vec2 res = vec2(min(dPil, dCap), 3.0);

  vec3 ap = p - vec3(-0.08, 0.0, -1.28);
  float colL = sdBox(ap - vec3(-0.68, 0.56, 0.0), vec3(0.16, 0.48, 0.17)) - 0.02;
  float colR = sdBox(ap - vec3( 0.68, 0.56, 0.0), vec3(0.16, 0.48, 0.17)) - 0.02;
  float lintel = sdBox(ap - vec3(0.0, 1.02, 0.0), vec3(0.88, 0.26, 0.18)) - 0.02;
  float archCut = length(ap.xy - vec2(0.0, 0.56)) - 0.52;
  float cornice = sdBox(ap - vec3(0.0, 1.29, 0.0), vec3(0.94, 0.045, 0.21)) - 0.015;
  res = opU(res, vec2(min(min(colL, colR), min(max(lintel, -archCut), cornice)), 3.0));
  res = opU(res, vec2(length(p - LANTERN_POS) - 0.085, 5.0));
  return res;
}

vec3 gerstnerDisp(vec2 p, float t, float ampScale) {
  vec3 disp = vec3(0.0);
  vec4 ws[6];
  ws[0] = vec4( 0.84,  0.54,  4.1, 0.044);
  ws[1] = vec4(-0.62,  0.78,  5.8, 0.030);
  ws[2] = vec4( 0.30, -0.95,  7.6, 0.021);
  ws[3] = vec4(-0.92, -0.39,  9.8, 0.014);
  ws[4] = vec4( 0.55, -0.83, 12.8, 0.009);
  ws[5] = vec4(-0.28,  0.96, 16.2, 0.006);
  for (int i = 0; i < 6; i++) {
    vec2 d = ws[i].xy;
    float k = ws[i].z, a = ws[i].w * ampScale;
    float ph = dot(d, p) * k - t * sqrt(9.8 * k) * 0.42 + float(i) * 1.7;
    disp.xz += d * (-0.58 * a * sin(ph));
    disp.y  += a * cos(ph);
  }
  return disp;
}

float evalGerstnerHeight(vec2 xz, float t, float ampScale) {
  vec3 d0 = gerstnerDisp(xz, t, ampScale);
  return gerstnerDisp(xz - d0.xz, t, ampScale).y;
}

float evalSpectralHeight(vec2 xz, float t, float ampScale) {
  float h = evalGerstnerHeight(xz, t, ampScale * 1.08);
  float f1 = sin(dot(xz, vec2( 11.4,   8.6)) - t * 4.4) * cos(dot(xz, vec2(-5.2, 10.8)) - t * 3.1);
  float f2 = sin(dot(xz, vec2(-15.5,  11.2)) - t * 5.6 + 1.2);
  float f3 = sin(dot(xz, vec2(  8.8, -19.4)) - t * 6.8 + 2.4);
  float f4 = sin(dot(xz, vec2(-22.0, -14.5)) - t * 8.2 + 0.7);
  return h + (f1 * 0.011 + f2 * 0.0065 + f3 * 0.0042 + f4 * 0.0028) * ampScale;
}

vec4 sampleWavePDE(vec2 xz) {
  vec2 uv = xz / (2.0 * 1.52) + 0.5;
  if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) return vec4(0.0);
  vec4 raw = texture(uTexWave, uv);
  return vec4((raw.r - 0.5) * 0.28, (raw.g - 0.5) * 0.16, (raw.b - 0.5) * 0.16, raw.a);
}

float evalWaterHeight(vec2 xz, int st) {
  if (st < 4) return 0.0;
  float edgeDamp = smoothstep(1.48, 1.22, length(xz));
  if (st == 4 || st == 5) return evalGerstnerHeight(xz, uTime, 1.02 * edgeDamp);
  if (st == 6) return evalSpectralHeight(xz, uTime, 1.02 * edgeDamp);

  float spec = evalSpectralHeight(xz, uTime, 0.15 * edgeDamp);
  vec4 pde = sampleWavePDE(xz);
  float cavityDip = 0.0;
  if (uSplashTime > 0.0 && uSplashTime < 0.58) {
    float cEnv = sin(clamp(uSplashTime / 0.58, 0.0, 1.0) * PI);
    float dImp = length(xz - IMPACT_XZ);
    cavityDip = -0.15 * cEnv * exp(-dImp * dImp / 0.055);
  }
  return clamp(spec + pde.x * 1.05 + cavityDip, -0.24, 0.24);
}

vec3 evalWaterNormal(vec2 xz, int st) {
  if (st < 3) return vec3(0.0, 1.0, 0.0);
  if (st == 3) {
    float e = 0.02;
    float h0 = (fbm2(xz * 3.8 + vec2(uTime * 0.55, -uTime * 0.42)) - 0.5) * 0.028;
    float hx = (fbm2((xz + vec2(e, 0.0)) * 3.8 + vec2(uTime * 0.55, -uTime * 0.42)) - 0.5) * 0.028;
    float hz = (fbm2((xz + vec2(0.0, e)) * 3.8 + vec2(uTime * 0.55, -uTime * 0.42)) - 0.5) * 0.028;
    return normalize(vec3(h0 - hx, e, h0 - hz));
  }

  float e = (st == 7) ? 0.026 : 0.020;
  float hX1 = evalWaterHeight(xz + vec2(e, 0.0), st);
  float hX0 = evalWaterHeight(xz - vec2(e, 0.0), st);
  float hZ1 = evalWaterHeight(xz + vec2(0.0, e), st);
  float hZ0 = evalWaterHeight(xz - vec2(0.0, e), st);
  vec3 n = normalize(vec3(hX0 - hX1, 2.0 * e, hZ0 - hZ1));

  if (st >= 6) {
    float capScale = (st == 7) ? 0.22 : 1.0;
    vec2 p1 = xz * 14.0 + vec2(uTime * 1.35, -uTime * 0.95);
    vec2 p2 = xz * 23.0 + vec2(-uTime * 1.10, uTime * 1.65);
    float nx = (noise2(p1 + vec2(0.15, 0.0)) - noise2(p1 - vec2(0.15, 0.0))) * 0.055
             + (noise2(p2 + vec2(0.15, 0.0)) - noise2(p2 - vec2(0.15, 0.0))) * 0.035;
    float nz = (noise2(p1 + vec2(0.0, 0.15)) - noise2(p1 - vec2(0.0, 0.15))) * 0.055
             + (noise2(p2 + vec2(0.0, 0.15)) - noise2(p2 - vec2(0.0, 0.15))) * 0.035;
    n = normalize(n + vec3(nx, 0.0, nz) * capScale);
  }
  return n;
}

float causticLayer(vec2 p, float t) {
  vec2 i = floor(p), f = fract(p);
  float minD = 8.0, secD = 8.0;
  for (int y = -1; y <= 1; y++) {
    for (int x = -1; x <= 1; x++) {
      vec2 g = vec2(float(x), float(y));
      vec2 o = 0.5 + 0.42 * sin(t * 1.65 + 6.2831 * vec2(hash21(i + g), hash21(i + g + vec2(17.3, 41.9))));
      float d = length(g + o - f);
      if (d < minD) { secD = minD; minD = d; }
      else if (d < secD) { secD = d; }
    }
  }
  return pow(clamp(1.0 - (secD - minD) * 2.4, 0.0, 1.0), 4.0);
}

vec3 evalCaustics(vec3 worldPos, int st) {
  if (st < 5) return vec3(0.0);
  vec2 proj = worldPos.xz - SUN_DIR.xz * (max(0.0, -worldPos.y) / max(0.35, SUN_DIR.y)) * 0.65;
  if (st == 7) proj += sampleWavePDE(proj).yz * 2.6;
  vec2 disp = vec2(0.036, -0.024);
  vec2 drift = vec2(uTime * 0.25, -uTime * 0.18);
  float cR = causticLayer((proj + disp) * 3.4 + drift, uTime);
  float cG = causticLayer(proj * 3.4 + drift, uTime);
  float cB = causticLayer((proj - disp) * 3.4 + drift, uTime);
  float depthFade = smoothstep(-0.02, -0.14, worldPos.y) * smoothstep(-1.15, -0.30, worldPos.y);
  return vec3(cR, cG, cB) * vec3(1.18, 1.06, 0.94) * depthFade * ((st >= 6) ? 3.2 : 3.0);
}

// Fast underwater floor, wall, pebbles, pillar & submerged sphere intersection (no 3D SDF march).
void traceUnderwater(vec3 ro, vec3 rd, out float hitT, out vec3 hitPos, out vec3 hitN, out float hitMat) {
  // 1. Analytic inner cylinder wall (r = 1.46) as upper bound.
  hitT = 1.8;
  hitMat = 1.0;
  {
    float a = dot(rd.xz, rd.xz);
    float b = dot(ro.xz, rd.xz);
    float c = dot(ro.xz, ro.xz) - 1.46 * 1.46;
    float disc = b * b - a * c;
    if (disc > 0.0 && a > 1e-5) {
      float tw = (-b + sqrt(disc)) / a;
      if (tw > 0.01 && tw < hitT) hitT = tw;
    }
  }

  // 2. Intersect sloped basin floor heightfield up to wall distance.
  float tPrev = 0.015;
  vec3 pPrev = ro + rd * tPrev;
  float dPrev = pPrev.y - basinFloorY(pPrev.xz);
  if (dPrev <= 0.0 && tPrev < hitT) {
    hitT = tPrev;
    hitMat = 2.0;
  } else if (hitT > tPrev + 0.004) {
    float stepT = (hitT - tPrev) / 14.0;
    for (int i = 1; i <= 14; i++) {
      float tCur = tPrev + stepT;
      vec3 pCur = ro + rd * tCur;
      float dCur = pCur.y - basinFloorY(pCur.xz);
      if (dCur <= 0.0 && dPrev > 0.0) {
        float frac = dPrev / max(0.0001, dPrev - dCur);
        hitT = mix(tPrev, tCur, frac);
        hitMat = 2.0;
        break;
      }
      tPrev = tCur;
      dPrev = dCur;
    }
  }

  // 3. Analytic intersection with 3 sunken pebbles (ellipsoids on the floor).
  vec3 pebC = vec3(0.0);
  for (int i = 0; i < 3; i++) {
    vec2 pxz = (i == 0) ? vec2(-0.78, 0.34) : ((i == 1) ? vec2(-0.24, -0.58) : vec2(0.18, 0.68));
    vec3 rad = (i == 0) ? vec3(0.24, 0.11, 0.19) : ((i == 1) ? vec3(0.28, 0.13, 0.22) : vec3(0.21, 0.10, 0.17));
    vec3 cen = vec3(pxz.x, basinFloorY(pxz) + 0.04, pxz.y);
    vec3 o = (ro - cen) / rad;
    vec3 d = rd / rad;
    float a = dot(d, d), b = dot(o, d), c = dot(o, o) - 1.0;
    float disc = b * b - a * c;
    if (disc > 0.0) {
      float tp = (-b - sqrt(disc)) / a;
      if (tp > 0.01 && tp < hitT) {
        hitT = tp;
        hitMat = 4.0;
        pebC = cen;
      }
    }
  }

  // 4. Analytic intersection with submerged bronze sphere if active.
  if (uColliderActive > 0.5) {
    vec3 oc = ro - uColliderPos;
    float b = dot(oc, rd);
    float disc = b * b - (dot(oc, oc) - 0.21 * 0.21);
    if (disc > 0.0) {
      float ts = -b - sqrt(disc);
      if (ts > 0.01 && ts < hitT) {
        hitT = ts;
        hitMat = 6.0;
      }
    }
  }

  // 5. Analytic intersection with submerged mooring pillar cylinder.
  {
    vec2 oc = ro.xz - vec2(0.62, -0.18);
    float a = dot(rd.xz, rd.xz);
    float b = dot(oc, rd.xz);
    float c = dot(oc, oc) - 0.165 * 0.165;
    float disc = b * b - a * c;
    if (disc > 0.0 && a > 1e-5) {
      float tp = (-b - sqrt(disc)) / a;
      if (tp > 0.01 && tp < hitT) {
        hitT = tp;
        hitMat = 3.0;
      }
    }
  }

  hitPos = ro + rd * hitT;
  if (hitMat > 5.5) hitN = normalize(hitPos - uColliderPos);
  else if (hitMat > 3.5) hitN = normalize(hitPos - pebC + vec3(0.0, 0.08, 0.0));
  else if (hitMat > 2.5) hitN = normalize(vec3(hitPos.x - 0.62, 0.0, hitPos.z + 0.18));
  else if (hitMat < 1.5) hitN = normalize(vec3(-hitPos.x, 0.15, -hitPos.z));
  else hitN = vec3(0.0, 1.0, 0.0);
}

float traceWaterSurface(vec3 ro, vec3 rd, int st, float maxSolidT) {
  if (abs(rd.y) < 0.001) return -1.0;
  if (st < 4) {
    float t = -ro.y / rd.y;
    if (t <= 0.05 || t >= maxSolidT) return -1.0;
    return length((ro + rd * t).xz) < 1.47 ? t : -1.0;
  }

  float tTop = (0.30 - ro.y) / rd.y, tBot = (-0.28 - ro.y) / rd.y;
  float t0 = max(0.05, min(tTop, tBot)), t1 = min(maxSolidT, max(tTop, tBot));
  if (t0 >= t1) return -1.0;

  const int NSTEP = 26;
  float dt = (t1 - t0) / float(NSTEP), prevT = t0;
  vec3 prevP = ro + rd * prevT;
  float prevD = prevP.y - evalWaterHeight(prevP.xz, st);
  if (prevD <= 0.0 && length(prevP.xz) < 1.47) return prevT;

  for (int i = 1; i <= NSTEP; i++) {
    float curT = t0 + float(i) * dt;
    vec3 curP = ro + rd * curT;
    float curD = curP.y - evalWaterHeight(curP.xz, st);
    if (curD <= 0.0 && prevD > 0.0) {
      float a = prevT, b = curT;
      for (int k = 0; k < 4; k++) {
        float m = 0.5 * (a + b);
        vec3 mp = ro + rd * m;
        if (mp.y - evalWaterHeight(mp.xz, st) <= 0.0) b = m; else a = m;
      }
      float hitT = 0.5 * (a + b);
      return length((ro + rd * hitT).xz) < 1.475 ? hitT : -1.0;
    }
    prevT = curT;
    prevD = curD;
  }
  return -1.0;
}

void main() {
  vec2 ndc = vUv * 2.0 - 1.0;
  vec3 ro = uCamPos;
  vec3 rd = normalize(uCamFwd + ndc.x * uAspect * uTanHalfFov * uCamRight + ndc.y * uTanHalfFov * uCamUp);

  bool isLeft = (uWipeX <= 0.001) ? false : ((uWipeX >= 0.999) ? true : (vUv.x < uWipeX));
  int st = isLeft ? uStageLeft : uStageRight;

  vec3 sceneCol = texture(uTexScene, vUv).rgb;
  vec4 dp = texture(uTexDepth, vUv);
  float sceneDepth = unpackDepth16(dp.rg);
  float sceneMat = dp.b * 10.0;

  vec3 col = sceneCol;
  vec3 bloom = vec3(0.0);
  if (sceneMat > 4.5 && sceneMat < 5.5 && st >= 6) {
    bloom += vec3(1.6, 1.0, 0.35);
  }

  float wT = traceWaterSurface(ro, rd, st, sceneDepth);
  float finalDepth = sceneDepth;

  if (wT > 0.0 && wT < sceneDepth) {
    finalDepth = wT;
    vec3 wPos = ro + rd * wT;

    if (st == 0) {
      vec2 pUv = clamp(wPos.xz / 2.94 + 0.5, 0.0, 1.0);
      float rawIdx = floor(texture(uTexPalIdx, pUv).r * 255.0 + 0.5);
      if (isLeft && uClutIndexOnly > 0.5) {
        col = vec3((rawIdx / 15.0) * 0.72 + 0.08);
      } else {
        int ci = 1 + int(mod(rawIdx - 1.0 - floor(uTime * 18.0) + 1500.0, 15.0));
        col = uClut16[ci] * 1.10;
      }
    } else if (st == 1) {
      vec2 uvBase = wPos.xz * 0.55;
      uvBase.x += sin(uvBase.y * 20.0 + uTime * 3.8) * 0.032;
      uvBase.y += cos(uvBase.x * 16.0 - uTime * 2.9) * 0.022;
      float crest = clamp(
        texture(uTexTile, fract(uvBase + vec2(uTime * 0.11, uTime * 0.06))).r * 0.60
        + texture(uTexTile, fract(uvBase * 1.25 + vec2(-uTime * 0.08, uTime * 0.10))).r * 0.55,
        0.0, 1.0
      );
      vec3 flatWater = mix(vec3(0.06, 0.30, 0.58), vec3(0.55, 0.88, 1.00), pow(crest, 1.7));
      vec2 floorPt = wPos.xz + rd.xz * (-basinFloorY(wPos.xz) / max(0.15, -rd.y));
      vec2 cid = floor(floorPt * 4.4);
      vec3 underCol = mix(vec3(0.14, 0.28, 0.36), vec3(0.46, 0.44, 0.38), mod(cid.x + cid.y, 2.0));
      col = mix(underCol, flatWater, 0.66);
    } else {
      vec3 N = evalWaterNormal(wPos.xz, st);
      vec3 V = -rd;
      vec3 rdUnder = rd;
      if (st >= 5) {
        rdUnder = refract(rd, N, 1.0 / 1.333);
        rdUnder = length(rdUnder) < 0.01 ? rd : normalize(rdUnder);
      }

      float waterDepth, uMat;
      vec3 uPos, uN;
      traceUnderwater(wPos + rdUnder * 0.018, rdUnder, waterDepth, uPos, uN, uMat);

      vec3 uAlb = vec3(0.22, 0.28, 0.36);
      if (uMat > 5.5) {
        vec3 lp = uPos - uColliderPos;
        float band = smoothstep(0.80, 0.95, abs(sin(lp.y * 24.0 + lp.x * 6.0)));
        uAlb = mix(vec3(0.20, 0.17, 0.14), vec3(0.42, 0.30, 0.14), band * 0.72);
      } else if (uMat > 3.5) {
        uAlb = mix(vec3(0.32, 0.36, 0.34), vec3(0.56, 0.52, 0.44), noise3(uPos * 8.0));
      } else if (uMat > 2.5) {
        uAlb = vec3(0.36, 0.40, 0.38);
      } else if (uMat > 1.5) {
        vec2 tileUv = uPos.xz * 4.4, cid = floor(tileUv), cf = fract(tileUv);
        float grout = smoothstep(0.04, 0.09, min(cf.x, 1.0 - cf.x)) * smoothstep(0.04, 0.09, min(cf.y, 1.0 - cf.y));
        uAlb = mix(vec3(0.15, 0.18, 0.22), mix(vec3(0.22, 0.46, 0.58), vec3(0.80, 0.74, 0.62), mod(cid.x + cid.y, 2.0)), grout);
      }
      vec3 underCol = uAlb * (vec3(0.26, 0.34, 0.48) + SUN_COL * max(dot(uN, SUN_DIR), 0.0) * 0.95);
      if (st >= 5) {
        underCol += uAlb * evalCaustics(uPos, st) * clamp(uN.y * 0.75 + 0.35, 0.0, 1.0) * 1.45;
      }
      if (st == 7 && uSplashTime > 0.10 && uSplashTime < 2.20) {
        float dBub = length(wPos.xz - IMPACT_XZ);
        if (dBub < 0.42) {
          float bubPat = smoothstep(0.76, 0.94, noise2(wPos.xz * 26.0 + vec2(0.0, -uTime * 4.5)));
          underCol += vec3(0.55, 0.88, 0.98) * bubPat * smoothstep(2.20, 0.60, uSplashTime) * exp(-dBub * dBub / 0.06) * 0.75;
        }
      }

      vec3 transmittance = exp(-waterDepth * vec3(3.15, 0.90, 0.36));
      vec3 bodyCol = mix(vec3(0.015, 0.105, 0.215), underCol * transmittance, clamp(transmittance.b * 0.92 + 0.08, 0.0, 1.0));

      if (st == 2) {
        float r1 = fbm2(wPos.xz * 4.6 + vec2(uTime * 0.85, -uTime * 0.62));
        float r2 = fbm2(wPos.xz * 6.4 + vec2(-uTime * 0.68, uTime * 0.78));
        col = bodyCol + vec3(0.08, 0.24, 0.34) * smoothstep(0.42, 0.82, r1 * 0.55 + r2 * 0.55) * 0.75;
      } else {
        float cosTheta = clamp(dot(N, V), 0.0, 1.0);
        float reflWeight = clamp((0.02 + 0.98 * pow(1.0 - cosTheta, 5.0)) * 1.15 + 0.04, 0.0, 0.96);
        vec3 rdRefl = reflect(rd, N);
        if (rdRefl.y < 0.02) rdRefl = normalize(vec3(rdRefl.x, 0.02, rdRefl.z));
        vec3 reflCol = evalSky(rdRefl, vUv, uAspect, uTime, true);

        // Fast 18-step reflection ray against the aqueduct arch, lantern & pillar.
        float rt = 0.04;
        for (int i = 0; i < 18; i++) {
          vec3 rp = wPos + N * 0.02 + rdRefl * rt;
          vec2 rh = mapAboveWater(rp);
          if (rh.x < 0.004) {
            if (rh.y > 4.5) {
              reflCol = vec3(3.6, 2.4, 1.1);
            } else {
              float brY = fract(rp.y * 4.8);
              float brX = fract((rp.x + rp.z) * 2.8 + mod(floor(rp.y * 4.8), 2.0) * 0.5);
              float m = smoothstep(0.03, 0.08, min(brY, 1.0 - brY)) * smoothstep(0.03, 0.08, min(brX, 1.0 - brX));
              reflCol = mix(vec3(0.18, 0.20, 0.26), vec3(0.54, 0.52, 0.47), m) * vec3(0.75, 0.78, 0.86);
            }
            break;
          }
          rt += rh.x * 0.9;
          if (rt > 4.5) break;
        }

        col = mix(bodyCol, reflCol, reflWeight);

        float specSun = pow(max(dot(N, normalize(SUN_DIR + V)), 0.0), (st >= 6) ? 420.0 : 140.0) * ((st >= 6) ? 4.2 : 1.5);
        col += SUN_COL * specSun;
        if (st >= 6) bloom += SUN_COL * max(0.0, specSun - 0.85) * 0.95;

        float specLan = pow(max(dot(N, normalize(normalize(LANTERN_POS - wPos) + V)), 0.0), 110.0) * 1.35;
        col += vec3(1.0, 0.72, 0.34) * specLan;
        if (st >= 6) bloom += vec3(1.0, 0.72, 0.34) * max(0.0, specLan - 0.55) * 0.55;

        if (st >= 6) {
          float waveH = clamp((wPos.y + 0.015) / 0.13, 0.0, 1.0);
          float backLit = pow(max(dot(V, -SUN_DIR + N * 0.50), 0.0), 2.4);
          float graz = pow(1.0 - cosTheta, 1.8);
          vec3 sssCol = vec3(0.02, 0.92, 0.70);
          float sss = waveH * (0.55 + 1.65 * backLit) * (0.48 + 0.52 * graz);
          float pdeCalm = (st == 7) ? 0.58 : 1.0;
          col += sssCol * sss * 1.05 * pdeCalm;
          bloom += sssCol * max(0.0, sss - 0.78) * 0.30 * pdeCalm;
        }

        if (st >= 4) {
          float edgeDist = min(max(0.0, 1.46 - length(wPos.xz)), max(0.0, length(wPos.xz - vec2(0.62, -0.18)) - 0.165));
          if (st == 7 && uColliderActive > 0.5 && uColliderPos.y > -0.22 && uColliderPos.y < 0.22) {
            float subR = sqrt(max(0.01, 0.21 * 0.21 - uColliderPos.y * uColliderPos.y));
            edgeDist = min(edgeDist, max(0.0, length(wPos.xz - uColliderPos.xz) - subR) * 1.15);
          }
          float fNoise = fbm2(wPos.xz * 12.0 + vec2(uTime * 0.65, -uTime * 0.50));
          float edgeFoam = smoothstep(0.14 + fNoise * 0.08, 0.015, edgeDist) * smoothstep(0.32, 0.62, fNoise + (0.09 - edgeDist) * 3.5);
          float depthFoam = smoothstep(0.24, 0.06, waterDepth) * smoothstep(0.42, 0.72, fNoise) * 0.45;
          float crestFoam = (st >= 6) ? smoothstep(0.06, 0.15, wPos.y + clamp(1.0 - N.y, 0.0, 1.0) * 0.32) * smoothstep(0.42, 0.74, fNoise) * 0.65 : 0.0;
          float pdeFoam = 0.0;
          if (st == 7) {
            vec4 pde = sampleWavePDE(wPos.xz);
            pdeFoam = clamp(pde.w * 0.72, 0.0, 0.78) * smoothstep(0.36, 0.74, fNoise + pde.w * 0.35);
          }
          vec3 foamCol = mix(vec3(0.76, 0.88, 0.96), vec3(0.98, 0.99, 1.0), clamp(dot(N, SUN_DIR) * 0.5 + 0.5, 0.0, 1.0));
          col = mix(col, foamCol, clamp(edgeFoam + depthFoam + crestFoam + pdeFoam, 0.0, 1.0) * 0.90);
        }
      }
    }
  }

  outHdr = vec4(max(col, vec3(0.0)), 1.0);
  outBloom = vec4(max(bloom, vec3(0.0)), 1.0);
  outWaterDepth = vec4(packDepth16(finalDepth), 0.0, 1.0);
}
`;

// ============================================================================
// PASS 3: Step 8 3D translucent liquid splash crown, Worthington jet & 24 droplets
// ============================================================================
export const SPLASH_FS = `#version 300 es
precision highp float;

in vec2 vUv;

uniform sampler2D uTexHdr;
uniform sampler2D uTexBloom;
uniform sampler2D uTexDepth;
uniform vec3 uCamPos;
uniform vec3 uCamRight;
uniform vec3 uCamUp;
uniform vec3 uCamFwd;
uniform float uTanHalfFov;
uniform float uAspect;
uniform float uTime;
uniform int uStageLeft;
uniform int uStageRight;
uniform float uWipeX;
uniform float uSplashTime;

layout(location = 0) out vec4 outHdr;
layout(location = 1) out vec4 outBloom;

${COMMON_GLSL}

float smin(float a, float b, float k) {
  float h = clamp(0.5 + 0.5 * (b - a) / k, 0.0, 1.0);
  return mix(b, a, h) - k * h * (1.0 - h);
}

float mapSplash3D(vec3 p) {
  float d = 99.0, t = uSplashTime;
  if (t <= 0.0 || t > 1.32) return d;

  vec2 rel = p.xz - IMPACT_XZ;
  float r = length(rel), ang = atan(rel.y, rel.x);

  if (t < 0.82) {
    float pC = clamp(t / 0.82, 0.0, 1.0);
    float rise = sin(pow(pC, 0.72) * PI);
    float fingers = 0.11 * sin(ang * 11.0 + 0.4) + 0.065 * cos(ang * 17.0 - 1.3) + 0.035 * sin(ang * 7.0 + t * 5.0);
    float maxH = (0.54 * rise) + fingers * rise;
    if (maxH > 0.03) {
      float flare = 0.19 + t * 0.44 + max(0.0, p.y) * (0.38 + 0.34 * pC) + 0.020 * sin(ang * 11.0 + p.y * 5.0);
      float thick = mix(0.034, 0.015, clamp(p.y / max(0.08, maxH), 0.0, 1.0)) * (1.0 - 0.35 * pC);
      float dCrown = max(abs(r - flare) - thick, max(p.y - maxH, -0.05 - p.y));
      float dRim = length(vec2(r - flare, p.y - maxH)) - (0.026 * rise + 0.006);
      d = min(d, smin(dCrown, dRim, 0.022));
    }
  }

  if (t > 0.34 && t < 1.28) {
    float jt = clamp((t - 0.34) / (1.28 - 0.34), 0.0, 1.0);
    float jetRise = sin(pow(jt, 0.80) * PI);
    float jetH = 0.68 * jetRise;
    if (jetH > 0.04) {
      float ny = clamp(p.y / max(0.05, jetH), 0.0, 1.0);
      float pinch = 1.0 - 0.38 * smoothstep(0.55, 0.82, ny) * smoothstep(0.98, 0.82, ny);
      float radJ = mix(0.115, 0.036, ny) * pinch * (0.65 + 0.35 * jetRise);
      float dCol = max(r - radJ, max(p.y - jetH, -0.04 - p.y));
      float tipY = jetH + 0.045 * smoothstep(0.25, 0.75, jt);
      float dTip = length(vec3(rel.x, p.y - tipY, rel.y)) - (0.056 * jetRise);
      d = min(d, smin(dCol, dTip, 0.032));
    }
  }
  return d;
}

vec3 calcSplashNormal(vec3 p) {
  const vec2 k = vec2(1.0, -1.0);
  const float h = 0.0035;
  return normalize(
    k.xyy * mapSplash3D(p + k.xyy * h) +
    k.yyx * mapSplash3D(p + k.yyx * h) +
    k.yxy * mapSplash3D(p + k.yxy * h) +
    k.xxx * mapSplash3D(p + k.xxx * h)
  );
}

vec3 shadeLiquid(vec3 N, vec3 rd, vec3 bgCol, float rimFoam, out vec3 splashBloom) {
  vec3 V = -rd;
  float cosT = clamp(dot(N, V), 0.0, 1.0);
  float fres = 0.03 + 0.97 * pow(1.0 - cosT, 4.2);
  vec3 refl = evalSky(reflect(rd, N), vUv, uAspect, uTime, true) * 1.15;
  vec3 liquidTint = mix(vec3(0.05, 0.34, 0.52), vec3(0.72, 0.97, 1.00), pow(cosT, 0.75));
  vec3 trans = bgCol * liquidTint * 0.88 + vec3(0.03, 0.32, 0.44) * (1.0 - cosT) * 0.65;
  float backLit = pow(max(dot(V, -SUN_DIR + N * 0.4), 0.0), 2.4);
  vec3 sss = vec3(0.04, 0.86, 0.78) * (0.20 + 0.65 * backLit) * (1.0 - cosT * 0.6);
  float spec = pow(max(dot(N, normalize(SUN_DIR + V)), 0.0), 320.0) * 5.2;
  float moonSpec = pow(max(dot(N, normalize(MOON_DIR + V)), 0.0), 120.0) * 1.5;
  vec3 col = mix(trans + sss, refl, clamp(fres * 0.90 + 0.05, 0.0, 0.92)) + SUN_COL * spec + vec3(0.80, 0.92, 1.0) * moonSpec;
  vec3 foamC = vec3(0.95, 0.99, 1.0);
  col = mix(col, foamC, clamp(rimFoam, 0.0, 0.48));
  splashBloom = SUN_COL * max(0.0, spec - 1.2) * 0.70 + foamC * rimFoam * 0.10;
  return col;
}

void main() {
  vec3 col = texture(uTexHdr, vUv).rgb;
  vec3 bloom = texture(uTexBloom, vUv).rgb;
  bool isLeft = (uWipeX <= 0.001) ? false : ((uWipeX >= 0.999) ? true : (vUv.x < uWipeX));
  int st = isLeft ? uStageLeft : uStageRight;

  if (st == 7 && uSplashTime > 0.0 && uSplashTime < 1.65) {
    vec2 ndc = vUv * 2.0 - 1.0;
    vec3 ro = uCamPos;
    vec3 rd = normalize(uCamFwd + ndc.x * uAspect * uTanHalfFov * uCamRight + ndc.y * uTanHalfFov * uCamUp);
    vec4 dp = texture(uTexDepth, vUv);
    float baseT = unpackDepth16(dp.rg);

    // 1. Raymarch 3D splash crown & Worthington jet inside tight bounding sphere.
    float spT = -1.0;
    if (uSplashTime <= 1.32) {
      vec3 oc = ro - vec3(IMPACT_XZ.x, 0.32, IMPACT_XZ.y);
      float b = dot(oc, rd);
      float disc = b * b - (dot(oc, oc) - 0.95 * 0.95);
      if (disc > 0.0) {
        float t = max(0.05, -b - sqrt(disc));
        float tEnd = min(baseT, -b + sqrt(disc));
        for (int i = 0; i < 32; i++) {
          if (t > tEnd) break;
          float h = mapSplash3D(ro + rd * t);
          if (h < 0.0032) { spT = t; break; }
          t += max(0.007, h * 0.76);
        }
      }
    }

    // 2. Analytic ray-sphere intersection against 24 ballistic droplets.
    float bestT = (spT > 0.0) ? spT : baseT;
    vec3 bestC = vec3(0.0);
    bool hitDrop = false;
    for (int i = 0; i < 24; i++) {
      float fi = float(i);
      bool isJet = (i >= 18);
      float ang = (isJet ? (fi - 18.0) / 6.0 : fi / 18.0) * 6.2831853 + (hash11(fi * 3.1) - 0.5) * 0.42;
      float r0  = isJet ? (0.02 + hash11(fi * 5.7) * 0.04) : (0.16 + hash11(fi * 5.7) * 0.09);
      float spd = isJet ? (0.16 + hash11(fi * 7.3) * 0.38) : (0.55 + hash11(fi * 7.3) * 0.68);
      float vUp = isJet ? (2.10 + hash11(fi * 11.9) * 1.10) : (1.85 + hash11(fi * 11.9) * 1.45);
      float tDel = isJet ? (0.48 + hash11(fi * 13.7) * 0.24) : (0.02 + hash11(fi * 13.7) * 0.14);
      float rad  = isJet ? (0.016 + hash11(fi * 17.1) * 0.018) : (0.013 + pow(hash11(fi * 17.1), 1.4) * 0.021);
      float lt = uSplashTime - tDel;
      if (lt <= 0.0) continue;
      float py = 0.06 + vUp * lt - 3.1 * lt * lt;
      if (py < -0.02) continue;

      vec3 c = vec3(IMPACT_XZ.x + cos(ang) * (r0 + spd * lt), py, IMPACT_XZ.y + sin(ang) * (r0 + spd * lt));
      vec3 oc = ro - c;
      float b = dot(oc, rd);
      float disc = b * b - (dot(oc, oc) - rad * rad);
      if (disc > 0.0) {
        float th = -b - sqrt(disc);
        if (th > 0.05 && th < bestT) {
          bestT = th;
          bestC = c;
          hitDrop = true;
        }
      }
    }

    if (hitDrop) {
      vec3 dpPos = ro + rd * bestT, dBlm = vec3(0.0);
      col = shadeLiquid(normalize(dpPos - bestC), rd, col, 0.08, dBlm);
      bloom += dBlm;
    } else if (spT > 0.0) {
      vec3 spPos = ro + rd * spT, sBlm = vec3(0.0);
      float aerated = smoothstep(0.24, 0.54, spPos.y) * (0.35 + 0.65 * noise3(spPos * 16.0));
      col = shadeLiquid(calcSplashNormal(spPos), rd, col, aerated * 0.48, sBlm);
      bloom += sBlm;
    }
  }

  outHdr = vec4(max(col, vec3(0.0)), 1.0);
  outBloom = vec4(max(bloom, vec3(0.0)), 1.0);
}
`;

export const BLUR_FS = `#version 300 es
precision highp float;

in vec2 vUv;
uniform sampler2D uTex;
uniform vec2 uDir;
out vec4 outColor;

void main() {
  const float w[5] = float[5](0.227027, 0.1945946, 0.1216216, 0.054054, 0.016216);
  vec3 acc = texture(uTex, vUv).rgb * w[0];
  for (int i = 1; i < 5; i++) {
    vec2 off = uDir * float(i) * 1.7;
    acc += (texture(uTex, vUv + off).rgb + texture(uTex, vUv - off).rgb) * w[i];
  }
  outColor = vec4(acc, 1.0);
}
`;

export const FINAL_FS = `#version 300 es
precision highp float;

in vec2 vUv;
uniform sampler2D uTexHdr;
uniform sampler2D uTexBloom;
uniform int uStageLeft;
uniform int uStageRight;
uniform float uWipeX;
out vec4 outColor;

vec3 acesFilm(vec3 x) {
  return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0);
}

void main() {
  bool isLeft = (uWipeX <= 0.001) ? false : ((uWipeX >= 0.999) ? true : (vUv.x < uWipeX));
  int st = isLeft ? uStageLeft : uStageRight;
  vec3 hdr = texture(uTexHdr, vUv).rgb;
  vec3 blm = (st >= 6) ? texture(uTexBloom, vUv).rgb : vec3(0.0);
  outColor = vec4(pow(clamp(acesFilm((hdr + blm * 0.72) * 1.12), 0.0, 1.0), vec3(1.0 / 2.2)), 1.0);
}
`;
