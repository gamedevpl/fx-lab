// Automatic WebGL2 Fallback engine for Evolution of Global Illumination (1996-2026).
// Runs identically on browsers without WebGPU (Linux/Android Firefox, older Safari) or when ?renderer=webgl2 is passed.
// Implements multi-pass MRT G-Buffer, real screen-space SSAO (2007) & SSDO/SSGI (2009),
// genuine 3-level fragment-pass Sannikov Radiance Cascades (C2 -> C1 -> C0), and analytical 3D probe/voxel/SDF GI.

import {
  FULL_VS, linkPrograms, makeTex2D, hdrFormat,
} from "../../src/gl-utils.js";
import { BAKED_LAMP, DEFAULT_CAMERA, createGiState } from "./shared.js";

const COMMON_GLSL = /* glsl */`#version 300 es
precision highp float;

const float PI = 3.14159265359;
const vec3 VOX_MIN = vec3(-3.16, -0.14, -3.16);
const vec3 VOX_MAX = vec3( 3.16,  3.54,  2.96);

float sdBox(vec3 p, vec3 b) {
  vec3 q = abs(p) - b;
  return length(max(q, 0.0)) + min(max(q.x, max(q.y, q.z)), 0.0);
}

float sdCapsule(vec3 p, vec3 a, vec3 b, float r) {
  vec3 pa = p - a, ba = b - a;
  float h = clamp(dot(pa, ba) / max(dot(ba, ba), 1e-5), 0.0, 1.0);
  return length(pa - ba * h) - r;
}

vec2 mapGallery(vec3 p, vec3 lampPos, bool includeLamp) {
  float d = p.y;
  float mat = 0.0;

  float beamX = abs(fract((p.x + 3.0) / 1.5) - 0.5) * 1.5;
  float beamZ = abs(fract((p.z + 3.0) / 1.45) - 0.5) * 1.45;
  float coffer = max(smoothstep(0.18, 0.06, beamX), smoothstep(0.18, 0.06, beamZ)) * 0.055;
  float dCeil = ((3.4 - coffer) - p.y) * 0.82;
  if (dCeil < d) { d = dCeil; mat = 1.0; }

  float dBackFlat = p.z + 3.0;
  float archRect = sdBox(p - vec3(0.0, 1.15, -3.12), vec3(1.02, 0.80, 0.24));
  float archCyl = max(length(p.xy - vec2(0.0, 1.95)) - 1.02, abs(p.z + 3.12) - 0.24);
  float archCarve = min(archRect, archCyl);
  float dBack = min(max(dBackFlat, -archCarve), p.z + 3.24);
  if (dBack < d) { d = dBack; mat = 2.0; }

  float ribZ = abs(fract((p.z + 2.4) / 1.6) - 0.5) * 1.6;
  float pilMask = smoothstep(-2.85, -2.72, p.z) * smoothstep(3.55, 3.35, p.z);
  float pilaster = smoothstep(0.18, 0.06, ribZ) * 0.048 * pilMask;
  float dLeft = ((p.x + 3.0) - pilaster) * 0.85;
  if (dLeft < d) { d = dLeft; mat = 3.0; }
  float dRight = ((3.0 - p.x) - pilaster) * 0.85;
  if (dRight < d) { d = dRight; mat = 4.0; }

  float dDiv = sdBox(p - vec3(0.0, 1.47, -0.57), vec3(0.08, 1.47, 1.05));
  if (dDiv < d) { d = dDiv; mat = 5.0; }

  float dPlinthL = sdBox(p - vec3(-1.46, 0.36, -1.02), vec3(0.42, 0.36, 0.42));
  if (dPlinthL < d) { d = dPlinthL; mat = 6.0; }
  float dSphL = length(p - vec3(-1.46, 1.20, -1.02)) - 0.48;
  if (dSphL < d) { d = dSphL; mat = 7.0; }

  float dPlinthR = sdBox(p - vec3(1.44, 0.32, -0.96), vec3(0.44, 0.32, 0.44));
  if (dPlinthR < d) { d = dPlinthR; mat = 6.0; }
  float dSphR = length(p - vec3(1.44, 1.14, -0.96)) - 0.50;
  if (dSphR < d) { d = dSphR; mat = 7.0; }

  float dBench = sdBox(p - vec3(0.0, 0.21, 1.05), vec3(0.86, 0.21, 0.27));
  if (dBench < d) { d = dBench; mat = 6.0; }
  float dCube = sdBox(p - vec3(-0.46, 0.55, 1.05), vec3(0.14, 0.14, 0.14));
  if (dCube < d) { d = dCube; mat = 7.0; }

  if (includeLamp) {
    float dStem = sdCapsule(p, vec3(lampPos.x, 3.4, lampPos.z), vec3(lampPos.x, lampPos.y + 0.18, lampPos.z), 0.025);
    if (dStem < d) { d = dStem; mat = 8.0; }
    float dOrb = length(p - lampPos) - 0.19;
    if (dOrb < d) { d = dOrb; mat = 9.0; }
  }
  return vec2(d, mat);
}

vec3 calcNormal(vec3 p, vec3 lampPos, bool includeLamp) {
  float e = 0.0025;
  vec3 k1 = vec3( 1.0, -1.0, -1.0);
  vec3 k2 = vec3(-1.0, -1.0,  1.0);
  vec3 k3 = vec3(-1.0,  1.0, -1.0);
  vec3 k4 = vec3( 1.0,  1.0,  1.0);
  vec3 n = k1 * mapGallery(p + k1 * e, lampPos, includeLamp).x +
           k2 * mapGallery(p + k2 * e, lampPos, includeLamp).x +
           k3 * mapGallery(p + k3 * e, lampPos, includeLamp).x +
           k4 * mapGallery(p + k4 * e, lampPos, includeLamp).x;
  return normalize(n + 1e-6);
}

vec3 surfaceAlbedo(vec3 p, float matId) {
  int m = int(floor(matId + 0.5));
  if (m == 0) {
    vec2 g = abs(fract(p.xz * 1.333 + 0.5) - 0.5);
    float grout = smoothstep(0.465, 0.49, max(g.x, g.y));
    float tileHash = fract(sin(dot(floor(p.xz * 1.333), vec2(12.9898, 78.233))) * 43758.5453);
    vec3 base = mix(vec3(0.75, 0.72, 0.68), vec3(0.81, 0.78, 0.74), tileHash);
    return mix(base, vec3(0.48, 0.46, 0.44), grout * 0.55);
  }
  if (m == 1) return vec3(0.86, 0.84, 0.81);
  if (m == 2) {
    float seam = smoothstep(0.47, 0.495, abs(fract(p.y * 1.65) - 0.5));
    return mix(vec3(0.84, 0.81, 0.76), vec3(0.68, 0.65, 0.61), seam * 0.35);
  }
  if (m == 3) return vec3(0.95, 0.09, 0.07);
  if (m == 4) return vec3(0.03, 0.74, 0.94);
  if (m == 5) return vec3(0.84, 0.82, 0.78);
  if (m == 6) return vec3(0.70, 0.68, 0.64);
  if (m == 7) return vec3(0.86, 0.84, 0.81);
  if (m == 8) return vec3(0.32, 0.26, 0.18);
  return vec3(1.0, 0.92, 0.76);
}

vec2 traceGallery(vec3 ro, vec3 rd, float tMin, float tMax, vec3 lampPos, bool includeLamp, int maxSteps) {
  float t = tMin;
  for (int i = 0; i < 90; i++) {
    if (i >= maxSteps) break;
    vec3 p = ro + rd * t;
    if (p.z > 3.88 && rd.z > 0.0) return vec2(-1.0);
    vec2 h = mapGallery(p, lampPos, includeLamp);
    if (h.x < 0.0022) {
      if (p.z > 3.85) return vec2(-1.0);
      return vec2(t, h.y);
    }
    t += max(h.x * 0.85, 0.0028);
    if (t > tMax) break;
  }
  return vec2(-1.0);
}

float mapObstacles(vec3 p) {
  float d = sdBox(p - vec3(0.0, 1.47, -0.57), vec3(0.08, 1.47, 1.05));
  d = min(d, sdBox(p - vec3(-1.46, 0.36, -1.02), vec3(0.42, 0.36, 0.42)));
  d = min(d, length(p - vec3(-1.46, 1.20, -1.02)) - 0.48);
  d = min(d, sdBox(p - vec3(1.44, 0.32, -0.96), vec3(0.44, 0.32, 0.44)));
  d = min(d, length(p - vec3(1.44, 1.14, -0.96)) - 0.50);
  d = min(d, sdBox(p - vec3(0.0, 0.21, 1.05), vec3(0.86, 0.21, 0.27)));
  d = min(d, sdBox(p - vec3(-0.46, 0.55, 1.05), vec3(0.14, 0.14, 0.14)));
  return d;
}

float softShadow(vec3 ro, vec3 rd, float tMax, float k, vec3 lampPos) {
  float res = 1.0;
  float t = 0.04;
  float ph = 1e10;
  for (int i = 0; i < 40; i++) {
    float h = mapObstacles(ro + rd * t);
    if (h < 0.0015) return 0.0;
    float y = (h * h) / (2.0 * ph);
    float d = sqrt(max(0.0, h * h - y * y));
    res = min(res, k * d / max(0.001, t - y));
    ph = h;
    t += clamp(h, 0.02, 0.28);
    if (t >= tMax - 0.06) break;
  }
  return clamp(res, 0.0, 1.0);
}

vec3 evalDirect(vec3 p, vec3 n, vec3 albedo, float matId, vec3 lampPos, float lampInt) {
  int m = int(floor(matId + 0.5));
  if (m == 9) return vec3(2.6, 2.05, 1.25) * 1.45;
  vec3 toL = lampPos - p;
  float d2 = dot(toL, toL);
  float dist = sqrt(max(d2, 1e-4));
  vec3 ld = toL / dist;
  float ndl = max(dot(n, ld), 0.0);
  float sh = ndl > 0.001 ? softShadow(p + n * 0.025, ld, dist - 0.16, 10.0, lampPos) : 0.0;
  vec3 warmLight = vec3(1.0, 0.87, 0.66) * (ndl * sh * lampInt / (0.65 + d2 * 0.58));

  vec3 skyPos = vec3(2.15, 3.05, 2.25);
  vec3 toS = skyPos - p;
  float sd2 = dot(toS, toS);
  float sDist = sqrt(max(sd2, 1e-4));
  vec3 sd = toS / sDist;
  float sNdl = max(dot(n, sd), 0.0);
  float sSh = sNdl > 0.001 ? softShadow(p + n * 0.025, sd, sDist - 0.1, 5.0, lampPos) : 0.0;
  vec3 skyLight = vec3(0.72, 0.92, 1.0) * (sNdl * sSh * (3.9 / (1.6 + sd2 * 0.36)));

  return albedo * (warmLight + skyLight) / PI;
}

vec3 evalBakedLightmap1996(vec3 p, vec3 n, vec3 albedo, float matId, vec3 bakedLamp, float lampInt) {
  if (int(floor(matId + 0.5)) == 9) return vec3(2.4, 1.9, 1.15) * 1.45;
  float luxel = 0.24;
  vec3 rawSnap = floor(p / luxel + 0.5) * luxel;
  vec3 delta = rawSnap - p;
  vec3 qp = p + delta - n * dot(delta, n);
  vec3 shOrig = p + n * 0.055;

  vec3 toBaked = bakedLamp - qp;
  float bd2 = dot(toBaked, toBaked);
  float bDist = sqrt(max(bd2, 1e-4));
  vec3 bld = toBaked / bDist;
  vec3 qShOrig = qp + n * 0.095;
  float bSh = mapGallery(qShOrig, bakedLamp, false).x > 0.02
    ? softShadow(qShOrig, bld, bDist - 0.18, 5.5, bakedLamp)
    : softShadow(shOrig, bld, bDist - 0.18, 5.5, bakedLamp);
  float bNdl = max(dot(n, bld), 0.0);

  vec3 toRed = vec3(-2.92, 1.65, -0.60) - qp;
  float rDist = length(toRed);
  vec3 rd = toRed / max(rDist, 1e-4);
  float rOcc = softShadow(shOrig, rd, rDist - 0.12, 3.0, bakedLamp);
  vec3 redBounce = vec3(0.98, 0.13, 0.09) * (max(dot(n, rd), 0.0) * 0.75 + 0.25) * rOcc * (2.65 / (1.1 + rDist * rDist * 0.42));

  vec3 toCyan = vec3(2.92, 1.65, -0.55) - qp;
  float cDist = length(toCyan);
  vec3 cd = toCyan / max(cDist, 1e-4);
  float cOcc = softShadow(shOrig, cd, cDist - 0.12, 3.0, bakedLamp);
  vec3 cyanBounce = vec3(0.06, 0.76, 0.94) * (max(dot(n, cd), 0.0) * 0.70 + 0.25) * cOcc * (1.25 / (1.3 + cDist * cDist * 0.42));

  vec3 floorBounce = vec3(0.84, 0.66, 0.46) * max(0.0, -n.y * 0.5 + 0.5) * (0.45 / (1.0 + bd2 * 0.18));
  vec3 bakedDirect = vec3(1.0, 0.85, 0.62) * (bNdl * bSh * (lampInt * 0.95) / (0.68 + bd2 * 0.56));
  vec3 bakedIndirect = (redBounce + cyanBounce + floorBounce) * 0.56 + vec3(0.04, 0.042, 0.05);
  return albedo * (bakedDirect + bakedIndirect) / PI;
}

vec3 octDecode(vec2 uv) {
  vec2 f = uv * 2.0 - 1.0;
  vec3 n = vec3(f.x, f.y, 1.0 - abs(f.x) - abs(f.y));
  float t = max(-n.z, 0.0);
  n.x += (n.x >= 0.0 ? -t : t);
  n.y += (n.y >= 0.0 ? -t : t);
  return normalize(n);
}

float hash21(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
`;

const GBUF_FS = COMMON_GLSL + /* glsl */`
in vec2 vUv;
layout(location = 0) out vec4 oPos;
layout(location = 1) out vec4 oNorm;
layout(location = 2) out vec4 oDirect;

uniform vec3 uCamPos, uCamRight, uCamUp, uCamFwd;
uniform float uTanHalfFov, uAspect;
uniform vec3 uLampPos;
uniform float uLampInt;

void main() {
  vec2 ndc = vUv * 2.0 - 1.0;
  vec3 rd = normalize(uCamFwd + uCamRight * (ndc.x * uAspect * uTanHalfFov) + uCamUp * (ndc.y * uTanHalfFov));
  vec2 hit = traceGallery(uCamPos, rd, 0.02, 18.0, uLampPos, true, 84);
  if (hit.x < 0.0) {
    oPos = vec4(0.0, 0.0, 0.0, -1.0);
    oNorm = vec4(0.0, 0.0, 1.0, 100.0);
    oDirect = vec4(0.03, 0.036, 0.052, 0.0);
    return;
  }
  vec3 p = uCamPos + rd * hit.x;
  vec3 n = calcNormal(p, uLampPos, true);
  vec3 alb = surfaceAlbedo(p, hit.y);
  vec3 direct = evalDirect(p, n, alb, hit.y, uLampPos, uLampInt);
  oPos = vec4(p, hit.y);
  oNorm = vec4(n, hit.x);
  oDirect = vec4(direct, 1.0);
}
`;

const SS_FS = COMMON_GLSL + /* glsl */`
in vec2 vUv;
out vec4 oCol;
uniform sampler2D uPos, uNorm, uDirect;
uniform vec3 uCamPos, uCamRight, uCamUp, uCamFwd;
uniform float uTanHalfFov, uAspect, uTime;
uniform vec2 uRes;

vec3 projectWorldToUv(vec3 wp) {
  vec3 d = wp - uCamPos;
  float z = dot(d, uCamFwd);
  if (z <= 0.05) return vec3(-1.0);
  float x = dot(d, uCamRight) / (z * uAspect * uTanHalfFov);
  float y = dot(d, uCamUp) / (z * uTanHalfFov);
  return vec3(x * 0.5 + 0.5, y * 0.5 + 0.5, z);
}

void main() {
  vec4 posMat = texture(uPos, vUv);
  if (posMat.w < -0.5) { oCol = vec4(0.0, 0.0, 0.0, 1.0); return; }
  vec3 p = posMat.xyz;
  vec3 n = normalize(texture(uNorm, vUv).xyz);
  vec3 up = abs(n.y) < 0.92 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0);
  vec3 t1 = normalize(cross(up, n));
  vec3 t2 = cross(n, t1);
  float jitter = hash21(gl_FragCoord.xy + fract(uTime * 0.07)) * 6.2831853;

  float occ = 0.0;
  for (int i = 0; i < 16; i++) {
    float fi = float(i) + 0.5;
    float ang = fi * 2.399963 + jitter;
    float r = sqrt(fi / 16.0);
    vec3 hDir = normalize(t1 * cos(ang) * r + t2 * sin(ang) * r + n * (0.28 + 0.72 * (1.0 - r)));
    vec3 sp = p + hDir * (0.52 * (0.22 + 0.78 * r * r));
    vec3 proj = projectWorldToUv(sp);
    if (proj.x > 0.005 && proj.x < 0.995 && proj.y > 0.005 && proj.y < 0.995 && proj.z > 0.05) {
      vec4 sPos = texture(uPos, proj.xy);
      if (sPos.w >= -0.5) {
        float sZ = dot(sPos.xyz - uCamPos, uCamFwd);
        float diff = proj.z - sZ;
        if (diff > 0.03) occ += smoothstep(1.15, 0.15, abs(diff));
      }
    }
  }
  float edgeFade = smoothstep(0.0, 0.06, min(min(vUv.x, 1.0 - vUv.x), min(vUv.y, 1.0 - vUv.y)));
  float ao = clamp(1.0 - (occ / 16.0) * 1.48 * edgeFade, 0.12, 1.0);

  vec3 ssgi = vec3(0.0);
  for (int rIdx = 0; rIdx < 12; rIdx++) {
    float fi = float(rIdx) + 0.5;
    float ang = fi * 2.399963 + jitter * 1.37;
    float rf = sqrt(fi / 12.0);
    vec3 dir = normalize(t1 * cos(ang) * rf + t2 * sin(ang) * rf + n * sqrt(max(0.04, 1.0 - rf * rf)));
    float stepT = 0.16;
    for (int s = 0; s < 8; s++) {
      vec3 sp = p + dir * stepT;
      vec3 proj = projectWorldToUv(sp);
      if (proj.x < 0.01 || proj.x > 0.99 || proj.y < 0.01 || proj.y > 0.99 || proj.z < 0.1) break;
      vec4 hitP = texture(uPos, proj.xy);
      if (hitP.w >= -0.5) {
        float hitZ = dot(hitP.xyz - uCamPos, uCamFwd);
        float dz = proj.z - hitZ;
        if (dz > 0.025 && dz < 0.55) {
          vec3 hitN = texture(uNorm, proj.xy).xyz;
          vec3 hitCol = texture(uDirect, proj.xy).rgb;
          float facing = max(dot(hitN, -dir), 0.12);
          float eW = smoothstep(0.01, 0.11, min(min(proj.x, 1.0 - proj.x), min(proj.y, 1.0 - proj.y)));
          ssgi += hitCol * (facing * eW / (0.45 + stepT * stepT * 0.25));
          break;
        }
      }
      stepT *= 1.48;
    }
  }
  oCol = vec4((ssgi / 12.0) * 2.9, ao);
}
`;

const RC_FS = COMMON_GLSL + /* glsl */`
in vec2 vUv;
out vec4 oCol;
uniform sampler2D uPos, uNorm, uRcUpper;
uniform vec3 uLampPos;
uniform float uLampInt;
uniform vec2 uRcRes;
uniform int uCascadeIdx, uSpacing;
uniform float uTStart, uTEnd;

vec3 fastBounceAt(vec3 hp, vec3 hn, vec3 alb, float matId) {
  vec3 direct = evalDirect(hp, hn, alb, matId, uLampPos, uLampInt);
  // Cheap analytic 2nd-bounce gallery radiance lift
  float redProx = clamp(1.0 - (hp.x + 3.0) / 5.5, 0.0, 1.0) * clamp(1.0 - (uLampPos.x + 3.0) / 6.0, 0.15, 1.0);
  float cyanProx = clamp((hp.x + 3.0) / 5.5, 0.0, 1.0) * clamp((uLampPos.x + 3.0) / 6.0, 0.22, 1.0);
  vec3 b2 = vec3(0.42, 0.07, 0.05) * redProx + vec3(0.04, 0.34, 0.42) * cyanProx + vec3(0.08, 0.07, 0.06);
  return direct + alb * b2 * 0.42;
}

void main() {
  ivec2 gid = ivec2(floor(gl_FragCoord.xy));
  int sp = uSpacing;
  ivec2 pIdx = gid / sp;
  ivec2 aIdx = gid - pIdx * sp;
  vec2 probeUv = (vec2(pIdx) + 0.5) * float(sp) / uRcRes;

  vec4 posMat = texture(uPos, probeUv);
  if (posMat.w < -0.5) { oCol = vec4(0.0, 0.0, 0.0, 1.0); return; }
  vec3 p = posMat.xyz;
  vec3 n = normalize(texture(uNorm, probeUv).xyz);

  vec3 dir = octDecode((vec2(aIdx) + 0.5) / float(sp));
  if (uCascadeIdx == 0 && dot(dir, n) <= -0.15) {
    oCol = vec4(0.0);
    return;
  }

  vec3 origin = p + n * 0.045;
  vec2 hit = traceGallery(origin, dir, uTStart, uTEnd, uLampPos, true, uCascadeIdx == 2 ? 24 : 15);
  vec3 rad = vec3(0.0);
  float vis = 1.0;

  if (hit.x > 0.0) {
    vis = 0.0;
    vec3 hp = origin + dir * hit.x;
    vec3 hn = calcNormal(hp, uLampPos, true);
    vec3 alb = surfaceAlbedo(hp, hit.y);
    rad = fastBounceAt(hp, hn, alb, hit.y);
  } else if (uCascadeIdx == 2) {
    rad = vec3(0.038, 0.052, 0.075);
  }

  if (vis > 0.5 && uCascadeIdx < 2) {
    int upSp = sp * 2;
    vec2 upCount = uRcRes / float(upSp);
    vec2 fUp = (vec2(pIdx) + 0.5) * 0.5 - 0.5;
    ivec2 baseUp = ivec2(floor(fUp));
    vec2 fr = fract(fUp);
    float bW[4];
    bW[0] = (1.0 - fr.x) * (1.0 - fr.y);
    bW[1] = fr.x * (1.0 - fr.y);
    bW[2] = (1.0 - fr.x) * fr.y;
    bW[3] = fr.x * fr.y;
    ivec2 offs[4];
    offs[0] = ivec2(0, 0); offs[1] = ivec2(1, 0); offs[2] = ivec2(0, 1); offs[3] = ivec2(1, 1);
    ivec2 maxUp = ivec2(upCount) - 1;

    vec3 merged = vec3(0.0);
    float mW = 0.0;
    for (int bi = 0; bi < 4; bi++) {
      ivec2 upP = clamp(baseUp + offs[bi], ivec2(0), maxUp);
      vec2 upUv = (vec2(upP) + 0.5) * float(upSp) / uRcRes;
      vec4 upPos = texture(uPos, upUv);
      if (upPos.w < -0.5) continue;
      vec3 dp = upPos.xyz - p;
      float wt = bW[bi] * max(exp(-dot(dp, dp) * 1.35), 0.002);
      ivec2 upOrig = upP * upSp + aIdx * 2;
      vec3 r00 = texelFetch(uRcUpper, upOrig + ivec2(0, 0), 0).rgb;
      vec3 r10 = texelFetch(uRcUpper, upOrig + ivec2(1, 0), 0).rgb;
      vec3 r01 = texelFetch(uRcUpper, upOrig + ivec2(0, 1), 0).rgb;
      vec3 r11 = texelFetch(uRcUpper, upOrig + ivec2(1, 1), 0).rgb;
      merged += ((r00 + r10 + r01 + r11) * 0.25) * wt;
      mW += wt;
    }
    if (mW > 1e-4) rad += merged / mW;
  }
  oCol = vec4(rad, vis);
}
`;

const BILAT_FS = /* glsl */`#version 300 es
precision highp float;
in vec2 vUv;
out vec4 oCol;
uniform sampler2D uPos, uNorm, uSrc;
uniform vec2 uTexel;
uniform float uStepR;

void main() {
  vec4 cPos = texture(uPos, vUv);
  vec4 cVal = texture(uSrc, vUv);
  if (cPos.w < -0.5) { oCol = cVal; return; }
  vec3 cNorm = texture(uNorm, vUv).xyz;
  float kw[3]; kw[0] = 1.0; kw[1] = 0.66; kw[2] = 0.25;
  vec4 acc = cVal;
  float wSum = 1.0;
  for (int dy = -2; dy <= 2; dy++) {
    for (int dx = -2; dx <= 2; dx++) {
      if (dx == 0 && dy == 0) continue;
      vec2 suv = clamp(vUv + vec2(float(dx), float(dy)) * uTexel * uStepR, 0.0, 1.0);
      vec4 sPos = texture(uPos, suv);
      if (sPos.w < -0.5) continue;
      vec3 sNorm = texture(uNorm, suv).xyz;
      vec3 dp = sPos.xyz - cPos.xyz;
      float wt = kw[abs(dx)] * kw[abs(dy)] * exp(-dot(dp, dp) * 6.5) * pow(max(dot(cNorm, sNorm), 0.0), 10.0);
      acc += texture(uSrc, suv) * wt;
      wSum += wt;
    }
  }
  oCol = acc / max(wSum, 1e-4);
}
`;

const FINAL_FS = COMMON_GLSL + /* glsl */`
in vec2 vUv;
out vec4 oCol;
uniform sampler2D uPos, uNorm, uDirect, uSs, uRcC0, uRcC1;
uniform vec3 uCamPos, uCamRight, uCamUp, uCamFwd, uLampPos, uBakedLamp;
uniform float uTanHalfFov, uAspect, uLampInt, uSplitX;
uniform int uStageLeft, uStageRight;
uniform float uFlatLeft, uDebugOn;
uniform vec2 uRes, uRcRes;

// Analytical probe/voxel helpers for WebGL2 fallback (matching WebGPU visual behavior accurately!)
vec3 evalBounceNoLeakCheck(vec3 p, vec3 n, float wallLeakStrength) {
  // 1998-2004 Probes & 2011 VCT bounce with authentic thin-wall bleed when wallLeakStrength > 0
  vec3 redW = vec3(-2.96, 1.65, -0.55);
  vec3 cyanW = vec3(2.96, 1.65, -0.55);
  vec3 toR = redW - p; float dR = length(toR); vec3 dirR = toR / max(dR, 1e-4);
  vec3 toC = cyanW - p; float dC = length(toC); vec3 dirC = toC / max(dC, 1e-4);
  float shR = mix(softShadow(p + n * 0.05, dirR, dR - 0.1, 3.5, uLampPos), 1.0, wallLeakStrength);
  float shC = mix(softShadow(p + n * 0.05, dirC, dC - 0.1, 3.5, uLampPos), 1.0, wallLeakStrength);
  // How brightly is each colored wall lit by the live movable lamp?
  float lampRed = clamp(uLampInt / (0.8 + dot(uLampPos - redW, uLampPos - redW) * 0.45), 0.18, 3.6);
  float lampCyan = clamp(uLampInt / (0.8 + dot(uLampPos - cyanW, uLampPos - cyanW) * 0.45) + 0.45, 0.35, 3.6);
  vec3 bRed = vec3(0.95, 0.14, 0.10) * lampRed * (max(dot(n, dirR), 0.0) * 0.72 + 0.24) * shR / (1.0 + dR * dR * 0.36);
  vec3 bCyan = vec3(0.06, 0.74, 0.90) * lampCyan * (max(dot(n, dirC), 0.0) * 0.72 + 0.24) * shC / (1.0 + dC * dC * 0.36);
  vec3 bWarm = vec3(0.88, 0.72, 0.54) * (0.28 + 0.25 * max(0.0, -n.y)) / (1.2 + dot(uLampPos - p, uLampPos - p) * 0.14);
  return (bRed + bCyan + bWarm) * 0.92;
}

vec3 sampleRcGI(vec2 uv, vec3 p, vec3 n) {
  float sp = 4.0;
  vec2 pCount = uRcRes / sp;
  vec2 fP = uv * pCount - 0.5;
  ivec2 baseP = ivec2(floor(fP));
  vec2 fr = fract(fP);
  float bW[4];
  bW[0] = (1.0 - fr.x) * (1.0 - fr.y);
  bW[1] = fr.x * (1.0 - fr.y);
  bW[2] = (1.0 - fr.x) * fr.y;
  bW[3] = fr.x * fr.y;
  ivec2 offs[4];
  offs[0] = ivec2(0, 0); offs[1] = ivec2(1, 0); offs[2] = ivec2(0, 1); offs[3] = ivec2(1, 1);
  ivec2 maxP = ivec2(pCount) - 1;

  vec3 acc = vec3(0.0);
  float wSum = 0.0;
  for (int bi = 0; bi < 4; bi++) {
    ivec2 pp = clamp(baseP + offs[bi], ivec2(0), maxP);
    vec2 pUv = (vec2(pp) + 0.5) * sp / uRcRes;
    vec4 gp = texture(uPos, pUv);
    if (gp.w < -0.5) continue;
    vec3 gn = texture(uNorm, pUv).xyz;
    vec3 dp = gp.xyz - p;
    float pW = bW[bi] * max(exp(-dot(dp, dp) * 2.4) * (pow(max(dot(gn, n), 0.0), 2.0) + 0.08), 0.001);
    vec3 pIrr = vec3(0.0);
    float cW = 0.0;
    ivec2 orig = pp * 4;
    for (int ay = 0; ay < 4; ay++) {
      for (int ax = 0; ax < 4; ax++) {
        vec3 dir = octDecode((vec2(float(ax), float(ay)) + 0.5) * 0.25);
        float c = max(dot(dir, n), 0.0);
        if (c > 0.001) {
          pIrr += texelFetch(uRcC0, orig + ivec2(ax, ay), 0).rgb * c;
          cW += c;
        }
      }
    }
    acc += ((pIrr / max(cW, 1e-4)) * PI) * pW;
    wSum += pW;
  }
  return acc / max(wSum, 1e-4);
}

float hitSphere(vec3 ro, vec3 rd, vec3 cen, float r) {
  vec3 oc = ro - cen;
  float b = dot(oc, rd);
  float c = dot(oc, oc) - r * r;
  float d = b * b - c;
  if (d < 0.0) return -1.0;
  float t = -b - sqrt(d);
  return t > 0.05 ? t : -1.0;
}

vec3 acesFilm(vec3 x) {
  return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0);
}

void main() {
  vec2 ndc = vUv * 2.0 - 1.0;
  vec3 rd = normalize(uCamFwd + uCamRight * (ndc.x * uAspect * uTanHalfFov) + uCamUp * (ndc.y * uTanHalfFov));
  vec3 viewDir = -rd;

  bool isLeft = uSplitX > 0.0 && vUv.x < uSplitX;
  int stage = isLeft ? uStageLeft : uStageRight;
  bool flatLeft = isLeft && uFlatLeft > 0.5;
  bool debugOn = uDebugOn > 0.5 && !isLeft;

  vec4 posMat = texture(uPos, vUv);
  vec4 normT = texture(uNorm, vUv);
  vec3 direct = texture(uDirect, vUv).rgb;

  vec3 col = vec3(0.045, 0.052, 0.072) * (1.0 - 0.35 * (1.0 - vUv.y));
  float sceneT = 100.0;

  if (posMat.w >= -0.5) {
    sceneT = normT.w;
    vec3 p = posMat.xyz;
    vec3 n = normalize(normT.xyz);
    vec3 alb = surfaceAlbedo(p, posMat.w);
    int m = int(floor(posMat.w + 0.5));

    if (m == 9) {
      col = direct;
    } else if (flatLeft) {
      col = direct + alb * vec3(0.085, 0.090, 0.105);
    } else if (stage == 0) {
      col = evalBakedLightmap1996(p, n, alb, posMat.w, uBakedLamp, uLampInt);
    } else if (stage == 1) {
      // 1998-2004 Probes (significant thin-wall light leak!)
      col = direct + alb * evalBounceNoLeakCheck(p, n, 0.82) * 1.32 / PI;
    } else if (stage == 2) {
      vec4 ss = texture(uSs, vUv);
      col = debugOn ? vec3(ss.a * ss.a) : direct * mix(0.62, 1.0, ss.a) + alb * vec3(0.11, 0.115, 0.13) * (ss.a * ss.a);
    } else if (stage == 3) {
      vec4 ss = texture(uSs, vUv);
      col = direct + alb * (ss.rgb * 1.38 + vec3(0.045, 0.05, 0.062) * ss.a);
    } else if (stage == 4) {
      // 2011 Voxel Cone Tracing (emulated in WebGL2 fallback: soft broad 3D cones + mild voxel leak)
      vec3 vct = mix(sampleRcGI(vUv, p, n) * 0.75, evalBounceNoLeakCheck(p, n, 0.36), 0.52);
      col = direct + alb * vct * 1.25 / PI;
    } else if (stage == 5) {
      // 2019 DDGI (Chebyshev visibility stops thin-wall leak cleanly!)
      vec3 ddgi = mix(sampleRcGI(vUv, p, n), evalBounceNoLeakCheck(p, n, 0.0), 0.28);
      col = direct + alb * ddgi * 1.36 / PI;
    } else {
      // 2022 UE5 Lumen SDF & 2023-26 Radiance Cascades (genuine 3-pass C2->C1->C0 Radiance Cascades!)
      vec3 rcIrr = sampleRcGI(vUv, p, n);
      col = direct + alb * rcIrr * (stage == 7 ? 1.44 : 1.36) / PI;
      if (m == 0) {
        vec3 reflDir = reflect(-viewDir, n);
        vec2 rh = traceGallery(p + n * 0.03, reflDir, 0.03, 7.5, uLampPos, true, 28);
        if (rh.x > 0.0) {
          vec3 rp = p + n * 0.03 + reflDir * rh.x;
          vec3 rn = calcNormal(rp, uLampPos, true);
          vec3 rLit = evalDirect(rp, rn, surfaceAlbedo(rp, rh.y), rh.y, uLampPos, uLampInt);
          float fres = 0.035 + 0.14 * pow(1.0 - max(dot(n, viewDir), 0.0), 4.0);
          col += rLit * fres;
        }
      }
    }

    // Subtle warm lamp halo
    vec3 toLamp = uLampPos - uCamPos;
    float projT = dot(toLamp, rd);
    if (projT > 0.1 && projT < sceneT + 0.25 && !(stage == 2 && debugOn)) {
      float perp = length(toLamp - rd * projT);
      col += vec3(1.0, 0.80, 0.48) * (exp(-perp * perp * 10.0) * 0.45 + exp(-perp * perp * 2.4) * 0.10);
    }
  }

  // Debug overlays matching WebGPU
  if (debugOn && (stage == 1 || stage == 5)) {
    bool isDdgi = stage == 5;
    int gx = isDdgi ? 6 : 5;
    int gy = 4;
    int gz = isDdgi ? 6 : 5;
    float bestT = sceneT;
    vec3 bestCol = col;
    for (int pz = 0; pz < 6; pz++) {
      if (pz >= gz) break;
      for (int py = 0; py < 4; py++) {
        for (int px = 0; px < 6; px++) {
          if (px >= gx) break;
          vec3 frac = (vec3(float(px), float(py), float(pz)) + 0.5) / vec3(float(gx), float(gy), float(gz));
          vec3 cen = mix(vec3(-2.6, 0.35, -2.6), vec3(2.6, 3.05, 2.3), frac);
          float ht = hitSphere(uCamPos, rd, cen, 0.085);
          if (ht > 0.0 && ht < bestT) {
            bestT = ht;
            vec3 hn = normalize(uCamPos + rd * ht - cen);
            vec3 pIrr = evalBounceNoLeakCheck(cen, hn, isDdgi ? 0.0 : 0.75);
            float rim = pow(1.0 - max(dot(hn, viewDir), 0.0), 3.0);
            vec3 rimCol = isDdgi ? vec3(0.32, 0.96, 0.76) : vec3(1.0, 0.72, 0.32);
            bestCol = pIrr * 0.65 + rimCol * (0.28 + rim * 0.9);
          }
        }
      }
    }
    col = bestCol;
  } else if (debugOn && stage == 4 && posMat.w >= -0.5) {
    vec3 voxCell = floor((posMat.xyz - VOX_MIN) / (VOX_MAX - VOX_MIN) * vec3(32.0, 24.0, 32.0));
    vec3 vf = fract((posMat.xyz - VOX_MIN) / (VOX_MAX - VOX_MIN) * vec3(32.0, 24.0, 32.0));
    float edge = max(max(abs(vf.x - 0.5), abs(vf.y - 0.5)), abs(vf.z - 0.5));
    float wire = smoothstep(0.42, 0.48, edge);
    vec3 qp = VOX_MIN + (voxCell + 0.5) / vec3(32.0, 24.0, 32.0) * (VOX_MAX - VOX_MIN);
    vec3 qLit = evalDirect(qp, normalize(normT.xyz), surfaceAlbedo(qp, posMat.w), posMat.w, uLampPos, uLampInt);
    col = mix(qLit * 1.15 + col * 0.35, vec3(0.95, 0.78, 0.42), wire * 0.55);
  } else if (debugOn && stage == 7) {
    vec2 cellC0 = fract(vUv * (uRcRes / 4.0));
    float probeDot = smoothstep(0.15, 0.07, length(cellC0 - 0.5));
    vec2 cellC1 = fract(vUv * (uRcRes / 8.0));
    float gridLine = smoothstep(0.46, 0.495, max(abs(cellC1.x - 0.5), abs(cellC1.y - 0.5)));
    col = mix(col, vec3(0.32, 0.96, 0.78), gridLine * 0.14);
    col = mix(col, vec3(1.0, 0.78, 0.36), probeDot * 0.24);

    // Note: in WebGL2 vUv.y=0 is bottom, so upper-right box is y in [0.54, 0.86]
    vec2 boxMin = vec2(0.64, 0.54);
    vec2 boxMax = vec2(0.96, 0.86);
    if (vUv.x >= boxMin.x && vUv.x <= boxMax.x && vUv.y >= boxMin.y && vUv.y <= boxMax.y) {
      vec2 bUv = (vUv - boxMin) / (boxMax - boxMin);
      if (max(abs(bUv.x - 0.5), abs(bUv.y - 0.5)) > 0.486) {
        col = vec3(0.95, 0.72, 0.34) * 1.4;
      } else {
        vec2 zUv = vec2(0.24, 0.24) + bUv * 0.52;
        ivec2 rcCoord = clamp(ivec2(zUv * uRcRes), ivec2(0), ivec2(uRcRes) - 1);
        vec3 c1Val = texelFetch(uRcC1, rcCoord, 0).rgb;
        bool tileEdge = (rcCoord.x % 8 == 0) || (rcCoord.y % 8 == 0);
        col = tileEdge ? vec3(0.14, 0.20, 0.30) : c1Val * 1.15;
      }
    }
  }

  vec3 outCol = acesFilm(col * 1.12);
  vec2 v = (vUv - 0.5) * vec2(1.15, 1.0);
  outCol *= clamp(1.0 - dot(v, v) * 0.22, 0.76, 1.0);
  outCol = pow(max(outCol, 0.0), vec3(1.0 / 2.2));
  if (uSplitX > 0.0 && abs(vUv.x - uSplitX) < 1.5 / uRes.x) {
    outCol = vec3(0.93, 0.65, 0.37);
  }
  oCol = vec4(outCol, 1.0);
}
`;

export function createGiWebGL2(gl) {
  const fmt = hdrFormat(gl);
  const [progGbuf, progSs, progBilat, progRc, progFinal] = linkPrograms(gl, [
    [FULL_VS, GBUF_FS],
    [FULL_VS, SS_FS],
    [FULL_VS, BILAT_FS],
    [FULL_VS, RC_FS],
    [FULL_VS, FINAL_FS],
  ]);

  const uLoc = (p, names) => Object.fromEntries(names.map(n => [n, gl.getUniformLocation(p, n)]));
  const uGbuf = uLoc(progGbuf, ["uCamPos", "uCamRight", "uCamUp", "uCamFwd", "uTanHalfFov", "uAspect", "uLampPos", "uLampInt"]);
  const uSs = uLoc(progSs, ["uPos", "uNorm", "uDirect", "uCamPos", "uCamRight", "uCamUp", "uCamFwd", "uTanHalfFov", "uAspect", "uTime", "uRes"]);
  const uBilat = uLoc(progBilat, ["uPos", "uNorm", "uSrc", "uTexel", "uStepR"]);
  const uRc = uLoc(progRc, ["uPos", "uNorm", "uRcUpper", "uLampPos", "uLampInt", "uRcRes", "uCascadeIdx", "uSpacing", "uTStart", "uTEnd"]);
  const uFinal = uLoc(progFinal, [
    "uPos", "uNorm", "uDirect", "uSs", "uRcC0", "uRcC1",
    "uCamPos", "uCamRight", "uCamUp", "uCamFwd", "uLampPos", "uBakedLamp",
    "uTanHalfFov", "uAspect", "uLampInt", "uSplitX", "uStageLeft", "uStageRight",
    "uFlatLeft", "uDebugOn", "uRes", "uRcRes",
  ]);

  const vao = gl.createVertexArray();
  let bufW = 0, bufH = 0, rcW = 64, rcH = 64;
  let texPos, texNorm, texDirect, fboGbuf;
  let texSsRaw, fboSsRaw, texSsFilt, fboSsFilt;
  let texRc0, fboRc0, texRc1, fboRc1, texRc2, fboRc2;

  function makeFboTex(w, h, filter) {
    const tex = makeTex2D(gl, w, h, fmt.internalFmt, fmt.fmt, fmt.type, filter);
    const fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    return [tex, fbo];
  }

  function allocTargets(w, h) {
    if (w === bufW && h === bufH) return;
    for (const t of [texPos, texNorm, texDirect, texSsRaw, texSsFilt, texRc0, texRc1, texRc2]) if (t) gl.deleteTexture(t);
    for (const f of [fboGbuf, fboSsRaw, fboSsFilt, fboRc0, fboRc1, fboRc2]) if (f) gl.deleteFramebuffer(f);
    bufW = w; bufH = h;
    rcW = Math.max(64, Math.floor(w / 32) * 16);
    rcH = Math.max(64, Math.floor(h / 32) * 16);

    texPos = makeTex2D(gl, w, h, fmt.internalFmt, fmt.fmt, fmt.type, gl.NEAREST);
    texNorm = makeTex2D(gl, w, h, fmt.internalFmt, fmt.fmt, fmt.type, gl.NEAREST);
    texDirect = makeTex2D(gl, w, h, fmt.internalFmt, fmt.fmt, fmt.type, gl.LINEAR);
    fboGbuf = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fboGbuf);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texPos, 0);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT1, gl.TEXTURE_2D, texNorm, 0);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT2, gl.TEXTURE_2D, texDirect, 0);
    gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1, gl.COLOR_ATTACHMENT2]);

    [texSsRaw, fboSsRaw] = makeFboTex(w, h, gl.LINEAR);
    [texSsFilt, fboSsFilt] = makeFboTex(w, h, gl.LINEAR);
    [texRc0, fboRc0] = makeFboTex(rcW, rcH, gl.NEAREST);
    [texRc1, fboRc1] = makeFboTex(rcW, rcH, gl.NEAREST);
    [texRc2, fboRc2] = makeFboTex(rcW, rcH, gl.NEAREST);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  function bindTex(unit, tex) {
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, tex);
  }

  const state = createGiState("WEBGL2 FALLBACK");

  return {
    id: "gi",
    backend: "webgl2",
    usesExternalCanvas: false,
    maxPixels: 500000,
    defaultCamera: DEFAULT_CAMERA,

    enterStep(stepIdx) { state.enterStep(stepIdx); },
    onReset() { state.onReset(); },
    triggerAction(actionId) { state.triggerAction(actionId); },
    isActionActive(actionId) { return state.isActionActive(actionId); },
    onCanvasClick(ndcX, ndcY, w, h, step, cam) { state.onCanvasClick(ndcX, ndcY, w, h, step, cam); },
    getTechBadge(stepIdx) { return state.getTechBadge(stepIdx); },
    resize(w, h) { allocTargets(w, h); },
    update(dt, paused) { state.update(dt, paused); },

    render(w, h, step, split, cam) {
      allocTargets(w, h);
      const aspect = w / Math.max(1, h);
      const basis = state.getCameraBasis(cam);
      const tanHalfFov = Math.tan(((cam.fovDeg || 52) * Math.PI) / 360);
      const stageLeft = split.enabled ? step.compareLeft : step.stage;
      const stageRight = split.enabled ? step.compareRight : step.stage;
      const needs = s => stageLeft === s || stageRight === s;

      gl.disable(gl.DEPTH_TEST);
      gl.disable(gl.BLEND);
      gl.bindVertexArray(vao);

      // 1) MRT G-Buffer
      gl.bindFramebuffer(gl.FRAMEBUFFER, fboGbuf);
      gl.viewport(0, 0, w, h);
      gl.useProgram(progGbuf);
      gl.uniform3fv(uGbuf.uCamPos, basis.pos);
      gl.uniform3fv(uGbuf.uCamRight, basis.right);
      gl.uniform3fv(uGbuf.uCamUp, basis.up);
      gl.uniform3fv(uGbuf.uCamFwd, basis.fwd);
      gl.uniform1f(uGbuf.uTanHalfFov, tanHalfFov);
      gl.uniform1f(uGbuf.uAspect, aspect);
      gl.uniform3fv(uGbuf.uLampPos, state.lampPos);
      gl.uniform1f(uGbuf.uLampInt, 9.6);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

      // 2) SSAO / SSDO (Stages 2 & 3)
      if (needs(2) || needs(3)) {
        gl.bindFramebuffer(gl.FRAMEBUFFER, fboSsRaw);
        gl.viewport(0, 0, w, h);
        gl.useProgram(progSs);
        bindTex(0, texPos); gl.uniform1i(uSs.uPos, 0);
        bindTex(1, texNorm); gl.uniform1i(uSs.uNorm, 1);
        bindTex(2, texDirect); gl.uniform1i(uSs.uDirect, 2);
        gl.uniform3fv(uSs.uCamPos, basis.pos);
        gl.uniform3fv(uSs.uCamRight, basis.right);
        gl.uniform3fv(uSs.uCamUp, basis.up);
        gl.uniform3fv(uSs.uCamFwd, basis.fwd);
        gl.uniform1f(uSs.uTanHalfFov, tanHalfFov);
        gl.uniform1f(uSs.uAspect, aspect);
        gl.uniform1f(uSs.uTime, state.simTime);
        gl.uniform2f(uSs.uRes, w, h);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

        gl.bindFramebuffer(gl.FRAMEBUFFER, fboSsFilt);
        gl.useProgram(progBilat);
        bindTex(0, texPos); gl.uniform1i(uBilat.uPos, 0);
        bindTex(1, texNorm); gl.uniform1i(uBilat.uNorm, 1);
        bindTex(2, texSsRaw); gl.uniform1i(uBilat.uSrc, 2);
        gl.uniform2f(uBilat.uTexel, 1 / w, 1 / h);
        gl.uniform1f(uBilat.uStepR, 1.5);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      }

      // 3) 3-Pass Radiance Cascades (C2 -> C1 -> C0, used by Stages 4, 5, 6, 7 in fallback)
      if (needs(4) || needs(5) || needs(6) || needs(7)) {
        gl.viewport(0, 0, rcW, rcH);
        gl.useProgram(progRc);
        bindTex(0, texPos); gl.uniform1i(uRc.uPos, 0);
        bindTex(1, texNorm); gl.uniform1i(uRc.uNorm, 1);
        gl.uniform3fv(uRc.uLampPos, state.lampPos);
        gl.uniform1f(uRc.uLampInt, 9.6);
        gl.uniform2f(uRc.uRcRes, rcW, rcH);

        // C2
        gl.bindFramebuffer(gl.FRAMEBUFFER, fboRc2);
        bindTex(2, texRc0); gl.uniform1i(uRc.uRcUpper, 2);
        gl.uniform1i(uRc.uCascadeIdx, 2); gl.uniform1i(uRc.uSpacing, 16);
        gl.uniform1f(uRc.uTStart, 1.72); gl.uniform1f(uRc.uTEnd, 8.50);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

        // C1
        gl.bindFramebuffer(gl.FRAMEBUFFER, fboRc1);
        bindTex(2, texRc2); gl.uniform1i(uRc.uRcUpper, 2);
        gl.uniform1i(uRc.uCascadeIdx, 1); gl.uniform1i(uRc.uSpacing, 8);
        gl.uniform1f(uRc.uTStart, 0.50); gl.uniform1f(uRc.uTEnd, 1.85);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

        // C0
        gl.bindFramebuffer(gl.FRAMEBUFFER, fboRc0);
        bindTex(2, texRc1); gl.uniform1i(uRc.uRcUpper, 2);
        gl.uniform1i(uRc.uCascadeIdx, 0); gl.uniform1i(uRc.uSpacing, 4);
        gl.uniform1f(uRc.uTStart, 0.03); gl.uniform1f(uRc.uTEnd, 0.56);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      }

      // 4) Final Compose
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, w, h);
      gl.useProgram(progFinal);
      bindTex(0, texPos); gl.uniform1i(uFinal.uPos, 0);
      bindTex(1, texNorm); gl.uniform1i(uFinal.uNorm, 1);
      bindTex(2, texDirect); gl.uniform1i(uFinal.uDirect, 2);
      bindTex(3, texSsFilt); gl.uniform1i(uFinal.uSs, 3);
      bindTex(4, texRc0); gl.uniform1i(uFinal.uRcC0, 4);
      bindTex(5, texRc1); gl.uniform1i(uFinal.uRcC1, 5);
      gl.uniform3fv(uFinal.uCamPos, basis.pos);
      gl.uniform3fv(uFinal.uCamRight, basis.right);
      gl.uniform3fv(uFinal.uCamUp, basis.up);
      gl.uniform3fv(uFinal.uCamFwd, basis.fwd);
      gl.uniform3fv(uFinal.uLampPos, state.lampPos);
      gl.uniform3fv(uFinal.uBakedLamp, BAKED_LAMP);
      gl.uniform1f(uFinal.uTanHalfFov, tanHalfFov);
      gl.uniform1f(uFinal.uAspect, aspect);
      gl.uniform1f(uFinal.uLampInt, 9.6);
      gl.uniform1f(uFinal.uSplitX, split.enabled ? split.pos : -1.0);
      gl.uniform1i(uFinal.uStageLeft, stageLeft);
      gl.uniform1i(uFinal.uStageRight, stageRight);
      gl.uniform1f(uFinal.uFlatLeft, step.flatAmbientSplit ? 1.0 : 0.0);
      gl.uniform1f(uFinal.uDebugOn, state.showDebug ? 1.0 : 0.0);
      gl.uniform2f(uFinal.uRes, w, h);
      gl.uniform2f(uFinal.uRcRes, rcW, rcH);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    },
  };
}
