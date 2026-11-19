// Evolution of Water — 8-era live WebGL2 pipeline with real-time 128x128 zero-mean viscous PDE,
// 3D liquid splash crown, Worthington rebound jet, 48 ballistic droplets and click-to-ripple.

import {
  clamp, lerp, smoothstep, hexToRgb01,
  cameraBasisFromOrbit, FULL_VS, linkProgram, makeTex2D, hdrFormat,
} from "./gl-utils.js";

const CLUT_16_HEX = [
  "#061224", "#092042", "#0d3163", "#124685", "#175ea6",
  "#1d7ac4", "#2798db", "#43b8ed", "#7ad8fa", "#cbf2ff",
  "#ffffff", "#94e2fc", "#4ec0eb", "#2389cc", "#145896", "#0c3061",
];
const CLUT_16_F32 = new Float32Array(16 * 3);
CLUT_16_HEX.forEach((h, i) => {
  const [r, g, b] = hexToRgb01(h);
  CLUT_16_F32[i * 3] = r; CLUT_16_F32[i * 3 + 1] = g; CLUT_16_F32[i * 3 + 2] = b;
});

const PAL_N = 80;
const TILE_N = 64;
const GW = 128, GH = 128;
const POOL_HALF = 1.52;
const PILLAR_X = 0.62, PILLAR_Z = -0.18, PILLAR_R = 0.19;
const IMPACT_X = -0.38, IMPACT_Z = 0.18, IMPACT_T = 0.30;
const DROP_COUNT = 48;

function hashJs(n) {
  const x = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
}

const dropMeta = [];
for (let i = 0; i < DROP_COUNT; i++) {
  const isJet = i >= 36;
  const ang = (i / (isJet ? 12 : 36)) * Math.PI * 2.0 + (hashJs(i * 3.1) - 0.5) * 0.42;
  const r0 = isJet ? (0.02 + hashJs(i * 5.7) * 0.04) : (0.16 + hashJs(i * 5.7) * 0.09);
  const spd = isJet ? (0.16 + hashJs(i * 7.3) * 0.38) : (0.55 + hashJs(i * 7.3) * 0.68);
  const vUp = isJet ? (2.10 + hashJs(i * 11.9) * 1.10) : (1.85 + hashJs(i * 11.9) * 1.45);
  const tDelay = isJet ? (0.48 + hashJs(i * 13.7) * 0.24) : (0.02 + hashJs(i * 13.7) * 0.14);
  const rad = isJet ? (0.015 + hashJs(i * 17.1) * 0.018) : (0.011 + Math.pow(hashJs(i * 17.1), 1.4) * 0.022);
  const flightT = (2.0 * vUp) / 6.2;
  dropMeta.push({
    landT: IMPACT_T + tDelay + flightT,
    landX: IMPACT_X + Math.cos(ang) * (r0 + spd * flightT),
    landZ: IMPACT_Z + Math.sin(ang) * (r0 + spd * flightT),
    isHero: rad > 0.0295,
  });
}

function buildPalIdxBytes() {
  const bytes = new Uint8Array(PAL_N * PAL_N);
  for (let y = 0; y < PAL_N; y++) {
    const nz = (y / (PAL_N - 1)) * 2.0 - 1.0;
    for (let x = 0; x < PAL_N; x++) {
      const nx = (x / (PAL_N - 1)) * 2.0 - 1.0;
      const r = Math.hypot(nx, nz);
      const waveA = nx * 8.5 + nz * 5.2 + Math.sin(nz * 6.5) * 1.15 + Math.cos(nx * 5.5) * 0.85;
      const waveB = r * 10.5 - Math.atan2(nz, nx) * 0.4;
      bytes[y * PAL_N + x] = 1 + (((Math.floor((waveA * 0.65 + waveB * 0.55) * 1.45) % 15) + 15) % 15);
    }
  }
  return bytes;
}

function buildTileBytes() {
  const bytes = new Uint8Array(TILE_N * TILE_N * 4);
  const pts = [
    [0.14, 0.18], [0.48, 0.12], [0.82, 0.22], [0.27, 0.46],
    [0.64, 0.42], [0.91, 0.56], [0.12, 0.78], [0.46, 0.74],
    [0.78, 0.84], [0.35, 0.92], [0.68, 0.06], [0.05, 0.52],
  ];
  for (let y = 0; y < TILE_N; y++) {
    const v = y / TILE_N;
    for (let x = 0; x < TILE_N; x++) {
      const u = x / TILE_N;
      let d1 = 9.0, d2 = 9.0;
      for (const [px, py] of pts) {
        let dx = Math.abs(u - px); if (dx > 0.5) dx = 1.0 - dx;
        let dy = Math.abs(v - py); if (dy > 0.5) dy = 1.0 - dy;
        const d = Math.hypot(dx, dy);
        if (d < d1) { d2 = d1; d1 = d; } else if (d < d2) { d2 = d; }
      }
      const ridge = clamp(1.0 - (d2 - d1) * 9.5, 0, 1);
      const cell = clamp(1.0 - d1 * 3.4, 0, 1);
      const wv = 0.5 + 0.5 * Math.sin((u * 2.0 + v) * Math.PI * 2.0) * Math.cos((v * 2.0 - u) * Math.PI * 2.0);
      const o = (y * TILE_N + x) * 4;
      bytes[o + 0] = Math.round(clamp(ridge * 0.85 + wv * 0.25, 0, 1) * 255);
      bytes[o + 1] = Math.round(clamp(cell * 0.7 + wv * 0.3, 0, 1) * 255);
      bytes[o + 2] = Math.round((0.5 + 0.45 * Math.sin(u * Math.PI * 4.0 + v * Math.PI * 2.0)) * 255);
      bytes[o + 3] = 255;
    }
  }
  return bytes;
}

function getColliderPos(lt) {
  if (lt < 0.0) return [IMPACT_X, -1.3, IMPACT_Z];
  if (lt < 0.30) {
    const p = lt / 0.30;
    return [IMPACT_X, lerp(1.95, 0.16, p * p), IMPACT_Z];
  }
  if (lt < 0.78) {
    const p = (lt - 0.30) / (0.78 - 0.30);
    return [IMPACT_X + 0.03 * p, lerp(0.16, -0.34, 1.0 - Math.pow(1.0 - p, 2.2)), IMPACT_Z - 0.02 * p];
  }
  if (lt < 3.90) {
    const dt = lt - 0.78;
    const bob = -0.32 * Math.exp(-dt * 1.65) * Math.cos(dt * 4.2);
    const driftP = smoothstep(0.65, 3.1, dt);
    return [IMPACT_X + 0.03 + 0.20 * Math.sin(driftP * Math.PI * 0.85), -0.02 + bob, IMPACT_Z - 0.02 + 0.24 * driftP];
  }
  if (lt < 4.90) {
    const p = smoothstep(3.90, 4.90, lt);
    return [IMPACT_X + 0.03 + 0.20 * Math.sin(Math.PI * 0.85), lerp(-0.02, -0.92, p * p), IMPACT_Z + 0.22];
  }
  return [IMPACT_X + 0.12, -1.25, IMPACT_Z + 0.22];
}

const WATER_FS = `#version 300 es
precision highp float;
in vec2 vUv;

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
uniform float uSphereWet;

layout(location = 0) out vec4 outHdr;
layout(location = 1) out vec4 outBloom;

const float PI = 3.14159265;
const vec3 SUN_DIR = normalize(vec3(-0.56, 0.34, -0.75));
const vec3 SUN_COL = vec3(1.0, 0.84, 0.62);
const vec3 MOON_DIR = normalize(vec3(0.42, 0.72, 0.55));
const vec3 LANTERN_POS = vec3(-0.08, 0.88, -1.28);
const vec2 IMPACT_XZ = vec2(-0.38, 0.18);

float hash11(float n) { return fract(sin(n * 127.1 + 311.7) * 43758.5453); }
float hash21(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
float hash31(vec3 p) { p = fract(p * 0.1031); p += dot(p, p.yzx + 33.33); return fract((p.x + p.y) * p.z); }
float noise2(vec2 p) {
  vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash21(i), hash21(i+vec2(1,0)), f.x), mix(hash21(i+vec2(0,1)), hash21(i+vec2(1,1)), f.x), f.y);
}
float noise3(vec3 p) {
  vec3 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(mix(hash31(i), hash31(i+vec3(1,0,0)), f.x), mix(hash31(i+vec3(0,1,0)), hash31(i+vec3(1,1,0)), f.x), f.y),
    mix(mix(hash31(i+vec3(0,0,1)), hash31(i+vec3(1,0,1)), f.x), mix(hash31(i+vec3(0,1,1)), hash31(i+vec3(1,1,1)), f.x), f.y),
    f.z
  );
}
float fbm2(vec2 p) {
  float s = 0.0, a = 0.5; mat2 rot = mat2(0.8, 0.6, -0.6, 0.8);
  for (int i = 0; i < 4; i++) { s += a * noise2(p); p = rot * p * 2.04; a *= 0.5; }
  return s;
}
float sdBox(vec3 p, vec3 b) { vec3 q = abs(p) - b; return length(max(q, 0.0)) + min(max(q.x, max(q.y, q.z)), 0.0); }
float sdCappedCylinder(vec3 p, float h, float r) { vec2 d = abs(vec2(length(p.xz), p.y)) - vec2(r, h); return min(max(d.x, d.y), 0.0) + length(max(d, 0.0)); }
vec2 opU(vec2 a, vec2 b) { return a.x < b.x ? a : b; }
float smin(float a, float b, float k) { float h = clamp(0.5 + 0.5 * (b - a) / k, 0.0, 1.0); return mix(b, a, h) - k * h * (1.0 - h); }

vec3 evalSky(vec3 rd, vec2 screenUv, bool isRefl) {
  float elev = isRefl ? clamp(rd.y * 0.95 + 0.30, 0.0, 1.0) : screenUv.y;
  vec3 cTop = vec3(0.08, 0.13, 0.27), cMid = vec3(0.16, 0.25, 0.44), cHor = vec3(0.32, 0.42, 0.60), cLow = vec3(0.12, 0.18, 0.34);
  vec3 col = (elev > 0.30)
    ? mix(cHor, mix(cMid, cTop, smoothstep(0.32, 1.0, clamp((elev - 0.30) / 0.70, 0.0, 1.0))), smoothstep(0.0, 0.78, clamp((elev - 0.30) / 0.70, 0.0, 1.0)))
    : mix(cLow, cHor, smoothstep(0.0, 1.0, clamp(elev / 0.30, 0.0, 1.0)));

  float sDot = max(dot(normalize(rd), SUN_DIR), 0.0);
  col += vec3(0.95, 0.56, 0.28) * pow(sDot, 7.0) * (isRefl ? 0.85 : 0.42);
  col += vec3(1.0, 0.88, 0.65) * pow(sDot, 80.0) * (isRefl ? 1.80 : 0.65);
  if (isRefl) col += vec3(1.8, 1.5, 1.1) * smoothstep(0.9965, 0.9992, sDot);

  if (!isRefl) {
    vec2 g = screenUv * vec2(26.0 * uAspect, 26.0);
    vec2 cid = floor(g), f = fract(g) - 0.5;
    float sh = fract(sin(dot(cid, vec2(127.1, 311.7))) * 43758.5453);
    if (sh > 0.962 && screenUv.y > 0.46) {
      float tw = 0.55 + 0.45 * sin(uTime * 1.45 + sh * 90.0);
      col += vec3(0.95, 0.90, 0.75) * exp(-dot(f, f) * 28.0) * tw * 0.65;
    }
  } else {
    vec2 rg = vec2(atan(rd.z, rd.x) * 8.0, rd.y * 18.0);
    vec2 cid = floor(rg), f = fract(rg) - 0.5;
    float sh = hash21(cid);
    if (sh > 0.955 && rd.y > 0.16) col += vec3(0.95, 0.90, 0.75) * exp(-dot(f, f) * 26.0) * 0.75;
  }
  return col;
}

float basinFloorY(vec2 xz) {
  float r = length(xz);
  float shallowMask = smoothstep(0.18, -0.80, xz.x * 0.85 - xz.y * 0.35);
  float deepBowl = -0.58 + 0.16 * pow(clamp(r / 1.46, 0.0, 1.0), 2.0);
  float stepShelf = -0.17 - 0.04 * smoothstep(-1.1, -0.3, xz.x);
  return mix(deepBowl, stepShelf, shallowMask);
}

vec2 mapScene(vec3 p) {
  float r = length(p.xz);
  float crag = (noise3(p * 2.5) - 0.5) * 0.16 + (noise3(p * 6.0) - 0.5) * 0.05;
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

  res = opU(res, vec2(length((p - vec3(-0.78, floorY + 0.04, 0.34)) / vec3(0.24, 0.11, 0.19)) * 0.16 - 0.16, 4.0));
  res = opU(res, vec2(length((p - vec3(-0.24, floorY + 0.05, -0.58)) / vec3(0.28, 0.13, 0.22)) * 0.18 - 0.18, 4.0));
  res = opU(res, vec2(length((p - vec3(0.18, floorY + 0.05, 0.68)) / vec3(0.21, 0.10, 0.17)) * 0.15 - 0.15, 4.0));

  float dPil = sdCappedCylinder(p - vec3(0.62, -0.06, -0.18), 0.52, 0.165);
  float dCap = sdCappedCylinder(p - vec3(0.62, 0.45, -0.18), 0.045, 0.195);
  res = opU(res, vec2(min(dPil, dCap), 3.0));

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
  {
    float orb = uTime * 0.1745, bob = sin(uTime * 0.87) * 0.08;
    vec2 p1 = vec2(cos(orb) * (-1.86) - sin(orb) * 0.32, sin(orb) * (-1.86) + cos(orb) * 0.32);
    vec2 p2 = vec2(cos(orb) * ( 1.86) - sin(orb) * (-0.22), sin(orb) * ( 1.86) + cos(orb) * (-0.22));
    res = opU(res, vec2(length(p - vec3(p1.x, -0.64 + bob, p1.y)) - 0.12, 1.0));
    res = opU(res, vec2(length(p - vec3(p2.x, -0.52 - bob, p2.y)) - 0.11, 1.0));
    res = opU(res, vec2(length(p - vec3( 0.42, -1.46 + bob * 1.1, 0.85)) - 0.10, 1.0));
    res = opU(res, vec2(length(p - vec3(-1.22, -1.04 - bob * 1.1, -0.95)) - 0.11, 1.0));
  }
  if (uColliderActive > 0.5) {
    float dCol = max(length(p - uColliderPos) - 0.21, floorY - 0.02 - p.y);
    res = opU(res, vec2(dCol, 6.0));
  }
  return res;
}

vec3 calcSolidNormal(vec3 p) {
  vec2 e = vec2(0.0026, 0.0);
  return normalize(vec3(
    mapScene(p + e.xyy).x - mapScene(p - e.xyy).x,
    mapScene(p + e.yxy).x - mapScene(p - e.yxy).x,
    mapScene(p + e.yyx).x - mapScene(p - e.yyx).x
  ));
}

float softShadow(vec3 ro, vec3 rd, float mint, float maxt, float k) {
  float sh = 1.0, t = mint;
  for (int i = 0; i < 14; i++) {
    float h = mapScene(ro + rd * t).x;
    sh = min(sh, clamp(k * h / t, 0.0, 1.0));
    t += clamp(h, 0.05, 0.25);
    if (sh < 0.03 || t > maxt) break;
  }
  return sh;
}

vec3 gerstnerDisp(vec2 p, float t, float ampScale) {
  vec3 disp = vec3(0.0);
  vec4 ws[6];
  ws[0]=vec4( 0.84,  0.54, 4.1, 0.044); ws[1]=vec4(-0.62,  0.78, 5.8, 0.030);
  ws[2]=vec4( 0.30, -0.95, 7.6, 0.021); ws[3]=vec4(-0.92, -0.39, 9.8, 0.014);
  ws[4]=vec4( 0.55, -0.83, 12.8, 0.009); ws[5]=vec4(-0.28,  0.96, 16.2, 0.006);
  for (int i = 0; i < 6; i++) {
    vec2 d = ws[i].xy; float k = ws[i].z, a = ws[i].w * ampScale;
    float ph = dot(d, p) * k - t * sqrt(9.8 * k) * 0.42 + float(i) * 1.7;
    disp.xz += d * (-0.58 * a * sin(ph));
    disp.y  += a * cos(ph);
  }
  return disp;
}
float evalGerstnerHeight(vec2 xz, float t, float ampScale) {
  vec3 d0 = gerstnerDisp(xz, t, ampScale);
  vec3 d1 = gerstnerDisp(xz - d0.xz, t, ampScale);
  return gerstnerDisp(xz - d1.xz, t, ampScale).y;
}
float evalSpectralHeight(vec2 xz, float t, float ampScale) {
  float h = evalGerstnerHeight(xz, t, ampScale * 1.08);
  float f1 = sin(dot(xz, vec2( 11.4,  8.6)) - t * 4.4) * cos(dot(xz, vec2(-5.2, 10.8)) - t * 3.1);
  float f2 = sin(dot(xz, vec2(-15.5, 11.2)) - t * 5.6 + 1.2);
  float f3 = sin(dot(xz, vec2(  8.8,-19.4)) - t * 6.8 + 2.4);
  float f4 = sin(dot(xz, vec2(-22.0,-14.5)) - t * 8.2 + 0.7);
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
    float nx = (noise2(p1 + vec2(0.15, 0.0)) - noise2(p1 - vec2(0.15, 0.0))) * 0.055 + (noise2(p2 + vec2(0.15, 0.0)) - noise2(p2 - vec2(0.15, 0.0))) * 0.035;
    float nz = (noise2(p1 + vec2(0.0, 0.15)) - noise2(p1 - vec2(0.0, 0.15))) * 0.055 + (noise2(p2 + vec2(0.0, 0.15)) - noise2(p2 - vec2(0.0, 0.15))) * 0.035;
    n = normalize(n + vec3(nx, 0.0, nz) * capScale);
  }
  return n;
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
  vec2 e = vec2(0.0035, 0.0);
  return normalize(vec3(
    mapSplash3D(p + e.xyy) - mapSplash3D(p - e.xyy),
    mapSplash3D(p + e.yxy) - mapSplash3D(p - e.yxy),
    mapSplash3D(p + e.yyx) - mapSplash3D(p - e.yyx)
  ));
}

float traceSplash3D(vec3 ro, vec3 rd, float maxT) {
  if (uSplashTime <= 0.0 || uSplashTime > 1.32) return -1.0;
  vec3 oc = ro - vec3(IMPACT_XZ.x, 0.32, IMPACT_XZ.y);
  float b = dot(oc, rd), disc = b * b - (dot(oc, oc) - 0.95 * 0.95);
  if (disc <= 0.0) return -1.0;
  float t = max(0.05, -b - sqrt(disc)), tEnd = min(maxT, -b + sqrt(disc));
  for (int i = 0; i < 38; i++) {
    if (t > tEnd) break;
    float h = mapSplash3D(ro + rd * t);
    if (h < 0.0028) return t;
    t += max(0.006, h * 0.72);
  }
  return -1.0;
}

vec4 traceBallisticDroplets(vec3 ro, vec3 rd, float maxT) {
  if (uSplashTime <= 0.01 || uSplashTime > 1.65) return vec4(-1.0);
  float bestT = maxT;
  vec3 bestC = vec3(0.0);
  float tS = uSplashTime;
  for (int i = 0; i < 48; i++) {
    float fi = float(i);
    bool isJet = (i >= 36);
    float ang = (isJet ? (fi - 36.0) / 12.0 : fi / 36.0) * 6.2831853 + (hash11(fi * 3.1) - 0.5) * 0.42;
    float r0  = isJet ? (0.02 + hash11(fi * 5.7) * 0.04) : (0.16 + hash11(fi * 5.7) * 0.09);
    float spd = isJet ? (0.16 + hash11(fi * 7.3) * 0.38) : (0.55 + hash11(fi * 7.3) * 0.68);
    float vUp = isJet ? (2.10 + hash11(fi * 11.9) * 1.10) : (1.85 + hash11(fi * 11.9) * 1.45);
    float tDel = isJet ? (0.48 + hash11(fi * 13.7) * 0.24) : (0.02 + hash11(fi * 13.7) * 0.14);
    float rad  = isJet ? (0.015 + hash11(fi * 17.1) * 0.018) : (0.011 + pow(hash11(fi * 17.1), 1.4) * 0.022);
    float lt = tS - tDel;
    if (lt <= 0.0) continue;
    float py = 0.06 + vUp * lt - 3.1 * lt * lt;
    if (py < -0.02) continue;
    vec3 c = vec3(IMPACT_XZ.x + cos(ang) * (r0 + spd * lt), py, IMPACT_XZ.y + sin(ang) * (r0 + spd * lt));
    vec3 oc = ro - c;
    float b = dot(oc, rd), disc = b * b - (dot(oc, oc) - rad * rad);
    if (disc > 0.0) {
      float th = -b - sqrt(disc);
      if (th > 0.05 && th < bestT) { bestT = th; bestC = c; }
    }
  }
  return (bestT < maxT) ? vec4(bestT, bestC) : vec4(-1.0);
}

float causticLayer(vec2 p, float t) {
  vec2 i = floor(p), f = fract(p);
  float minD = 8.0, secD = 8.0;
  for (int y = -1; y <= 1; y++) {
    for (int x = -1; x <= 1; x++) {
      vec2 g = vec2(float(x), float(y));
      vec2 o = 0.5 + 0.42 * sin(t * 1.65 + 6.2831 * vec2(hash21(i + g), hash21(i + g + vec2(17.3, 41.9))));
      float d = length(g + o - f);
      if (d < minD) { secD = minD; minD = d; } else if (d < secD) { secD = d; }
    }
  }
  return pow(clamp(1.0 - (secD - minD) * 2.4, 0.0, 1.0), 4.0);
}
vec3 evalCaustics(vec3 worldPos, int st) {
  if (st < 5) return vec3(0.0);
  vec2 proj = worldPos.xz - SUN_DIR.xz * (max(0.0, -worldPos.y) / max(0.35, SUN_DIR.y)) * 0.65;
  if (st == 7) proj += sampleWavePDE(proj).yz * 2.6;
  float t = uTime; vec2 disp = vec2(0.032, -0.022);
  float cR = causticLayer((proj + disp) * 3.1 + vec2(t * 0.25, -t * 0.18), t) + causticLayer((proj + disp) * 4.8 - vec2(t * 0.22, t * 0.28), t * 1.25) * 0.65;
  float cG = causticLayer(proj * 3.1 + vec2(t * 0.25, -t * 0.18), t) + causticLayer(proj * 4.8 - vec2(t * 0.22, t * 0.28), t * 1.25) * 0.65;
  float cB = causticLayer((proj - disp) * 3.1 + vec2(t * 0.25, -t * 0.18), t) + causticLayer((proj - disp) * 4.8 - vec2(t * 0.22, t * 0.28), t * 1.25) * 0.65;
  float depthFade = smoothstep(-0.02, -0.14, worldPos.y) * smoothstep(-1.15, -0.30, worldPos.y);
  return vec3(cR, cG, cB) * vec3(1.10, 1.00, 0.88) * depthFade * ((st >= 6) ? 2.45 : 2.30);
}

vec3 shadeSolid(vec3 pos, vec3 n, vec3 v, float mat, int st, bool underwater) {
  vec3 albedo = vec3(0.32, 0.34, 0.40), emissive = vec3(0.0);
  float rough = 0.78, metal = 0.0, wetClearcoat = 0.0;

  if (mat < 1.5) {
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
  } else if (mat < 2.5) {
    vec2 tileUv = pos.xz * 4.4, cid = floor(tileUv), cf = fract(tileUv);
    float grout = smoothstep(0.04, 0.09, min(cf.x, 1.0 - cf.x)) * smoothstep(0.04, 0.09, min(cf.y, 1.0 - cf.y));
    float chk = mod(cid.x + cid.y, 2.0), varT = hash21(cid);
    albedo = mix(vec3(0.15, 0.18, 0.22), mix(vec3(0.22, 0.46, 0.58) * (0.85 + 0.25 * varT), vec3(0.80, 0.74, 0.62) * (0.88 + 0.22 * varT), chk), grout);
    rough = 0.55;
  } else if (mat < 3.5) {
    float brY = fract(pos.y * 4.8), brX = fract((pos.x + pos.z) * 2.8 + mod(floor(pos.y * 4.8), 2.0) * 0.5);
    float mortar = smoothstep(0.03, 0.08, min(brY, 1.0 - brY)) * smoothstep(0.03, 0.08, min(brX, 1.0 - brX));
    float tone = hash21(vec2(floor(pos.y * 4.8), floor((pos.x + pos.z) * 2.8)));
    vec3 lime = mix(vec3(0.18, 0.20, 0.26), vec3(0.56, 0.53, 0.48) * (0.84 + 0.28 * tone), mortar);
    float wet = smoothstep(0.15, -0.04, pos.y);
    albedo = mix(lime, lime * vec3(0.58, 0.72, 0.68), wet * 0.62);
    rough = mix(0.76, 0.30, wet);
  } else if (mat < 4.5) {
    albedo = mix(vec3(0.32, 0.36, 0.34), vec3(0.58, 0.54, 0.46), noise3(pos * 8.0)); rough = 0.48;
  } else if (mat < 5.5) {
    albedo = vec3(1.0, 0.85, 0.55); emissive = vec3(3.4, 2.2, 0.95); rough = 0.20;
  } else {
    vec3 lp = pos - uColliderPos;
    float band = smoothstep(0.80, 0.95, abs(sin(lp.y * 24.0 + lp.x * 6.0)));
    vec3 dryCol = mix(vec3(0.46, 0.38, 0.32), vec3(0.86, 0.62, 0.26), band * 0.72) * (0.88 + 0.24 * noise3(lp * 18.0));
    float wetAmt = underwater ? 1.0 : uSphereWet;
    float rivulet = smoothstep(0.68, 0.94, noise2(vec2(atan(lp.z, lp.x) * 4.5, lp.y * 8.5 + uTime * 1.45)));
    albedo = dryCol * mix(1.0, 0.44, wetAmt);
    metal = mix(0.35, 0.58, band);
    rough = mix(0.60, 0.05, wetAmt);
    wetClearcoat = wetAmt * (0.82 + 0.18 * rivulet);
    if (!underwater && wetAmt > 0.3) {
      float wH = evalWaterHeight(pos.xz, st);
      float meniscus = smoothstep(0.055, 0.005, abs(pos.y - wH)) * smoothstep(0.30, 0.65, noise2(pos.xz * 18.0 + uTime));
      albedo = mix(albedo, vec3(0.92, 0.98, 1.0), meniscus * 0.85);
      wetClearcoat = mix(wetClearcoat, 0.0, meniscus);
    }
  }

  vec3 amb = mix(vec3(0.10, 0.14, 0.24), vec3(0.28, 0.36, 0.54), n.y * 0.5 + 0.5);
  vec3 col = albedo * amb * (1.0 - metal * 0.55);
  float shSun = underwater ? 1.0 : softShadow(pos + n * 0.015, SUN_DIR, 0.04, 4.0, 6.0);
  float ndlSun = max(dot(n, SUN_DIR), 0.0);
  float specSun = pow(max(dot(n, normalize(SUN_DIR + v)), 0.0), mix(18.0, 140.0, 1.0 - rough)) * mix(0.20, 1.5, metal);
  col += (albedo * (1.0 - metal * 0.7) * ndlSun + mix(vec3(1.0), albedo, metal) * specSun) * SUN_COL * 1.15 * shSun;
  col += albedo * (1.0 - metal * 0.6) * max(dot(n, MOON_DIR), 0.0) * vec3(0.45, 0.58, 0.88) * 0.52;

  float lanFlicker = 1.0 + 0.10 * sin(uTime * 6.3) + 0.05 * cos(uTime * 11.7);
  vec3 toL = LANTERN_POS - pos; float distL = length(toL);
  col += albedo * vec3(1.0, 0.68, 0.32) * max(dot(n, toL / max(distL, 0.001)), 0.0) / (0.18 + distL * distL * 1.4) * 1.35 * lanFlicker;

  if (wetClearcoat > 0.01 && !underwater) {
    float fres = 0.06 + 0.94 * pow(1.0 - max(dot(n, v), 0.0), 3.4);
    vec3 envRefl = evalSky(reflect(-v, n), vUv, true);
    float wetSpec = pow(max(dot(n, normalize(SUN_DIR + v)), 0.0), 340.0) * 4.2;
    float wetMoon = pow(max(dot(n, normalize(MOON_DIR + v)), 0.0), 160.0) * 1.4;
    col = mix(col, envRefl, fres * wetClearcoat * 0.90) + (SUN_COL * wetSpec + vec3(0.75, 0.90, 1.0) * wetMoon) * wetClearcoat;
  }

  if (underwater && st >= 5) {
    col += albedo * evalCaustics(pos, st) * clamp(n.y * 0.75 + 0.35, 0.0, 1.0) * 1.45;
  }
  return col + emissive;
}

vec2 traceSolid(vec3 ro, vec3 rd, float tMax, int steps) {
  float t = 0.02;
  for (int i = 0; i < 60; i++) {
    if (i >= steps) break;
    vec2 h = mapScene(ro + rd * t);
    if (h.x < 0.0024) return vec2(t, h.y);
    t += h.x * 0.88;
    if (t > tMax) break;
  }
  return vec2(99.0, 0.0);
}

float traceWaterSurface(vec3 ro, vec3 rd, int st, float maxSolidT) {
  if (abs(rd.y) < 0.001) return -1.0;
  if (st < 4) {
    float t = -ro.y / rd.y;
    if (t <= 0.05 || t >= maxSolidT) return -1.0;
    return length((ro + rd * t).xz) < 1.47 ? t : -1.0;
  }
  float tTop = (0.32 - ro.y) / rd.y, tBot = (-0.30 - ro.y) / rd.y;
  float t0 = max(0.05, min(tTop, tBot)), t1 = min(maxSolidT, max(tTop, tBot));
  if (t0 >= t1) return -1.0;
  const int NSTEP = 32;
  float dt = (t1 - t0) / float(NSTEP), prevT = t0;
  vec3 prevP = ro + rd * prevT;
  float prevD = prevP.y - evalWaterHeight(prevP.xz, st);
  if (prevD <= 0.0 && length(prevP.xz) < 1.47) return prevT;
  for (int i = 1; i <= NSTEP; i++) {
    float curT = t0 + float(i) * dt; vec3 curP = ro + rd * curT;
    float curD = curP.y - evalWaterHeight(curP.xz, st);
    if (curD <= 0.0 && prevD > 0.0) {
      float a = prevT, b = curT;
      for (int k = 0; k < 5; k++) {
        float m = 0.5 * (a + b); vec3 mp = ro + rd * m;
        if (mp.y - evalWaterHeight(mp.xz, st) <= 0.0) b = m; else a = m;
      }
      float hitT = 0.5 * (a + b);
      return length((ro + rd * hitT).xz) < 1.475 ? hitT : -1.0;
    }
    prevT = curT; prevD = curD;
  }
  return -1.0;
}

void shadeWater(vec3 ro, vec3 rd, vec3 wPos, int st, bool isLeft, out vec3 outCol, out vec3 outBloomCol) {
  outBloomCol = vec3(0.0);
  if (st == 0) {
    vec2 pUv = clamp(wPos.xz / 2.94 + 0.5, 0.0, 1.0);
    float rawIdx = floor(texture(uTexPalIdx, pUv).r * 255.0 + 0.5);
    if (isLeft && uClutIndexOnly > 0.5) { outCol = vec3((rawIdx / 15.0) * 0.72 + 0.08); return; }
    int ci = 1 + int(mod(rawIdx - 1.0 - floor(uTime * 18.0) + 1500.0, 15.0));
    outCol = uClut16[ci] * 1.10; return;
  }
  if (st == 1) {
    vec2 uvBase = wPos.xz * 0.55;
    uvBase.x += sin(uvBase.y * 20.0 + uTime * 3.8) * 0.032;
    uvBase.y += cos(uvBase.x * 16.0 - uTime * 2.9) * 0.022;
    float crest = clamp(texture(uTexTile, fract(uvBase + vec2(uTime * 0.11, uTime * 0.06))).r * 0.60
                      + texture(uTexTile, fract(uvBase * 1.25 + vec2(-uTime * 0.08, uTime * 0.10))).r * 0.55, 0.0, 1.0);
    vec3 flatWater = mix(vec3(0.06, 0.30, 0.58), vec3(0.55, 0.88, 1.00), pow(crest, 1.7));
    vec2 uHit = traceSolid(wPos + rd * 0.015, rd, 3.0, 22);
    vec3 underCol = (uHit.y > 0.5) ? shadeSolid(wPos + rd * (0.015 + uHit.x), calcSolidNormal(wPos + rd * (0.015 + uHit.x)), -rd, uHit.y, st, true) : vec3(0.08, 0.14, 0.22);
    outCol = mix(underCol, flatWater, 0.66); return;
  }

  vec3 N = evalWaterNormal(wPos.xz, st), V = -rd;
  vec3 rdUnder = rd;
  if (st >= 5) { rdUnder = refract(rd, N, 1.0 / 1.333); rdUnder = length(rdUnder) < 0.01 ? rd : normalize(rdUnder); }
  vec2 uHit = traceSolid(wPos + rdUnder * 0.018, rdUnder, 3.5, 28);
  float waterDepth = (uHit.y > 0.5) ? uHit.x : 1.4;
  vec3 underCol = (uHit.y > 0.5) ? shadeSolid(wPos + rdUnder * (0.018 + uHit.x), calcSolidNormal(wPos + rdUnder * (0.018 + uHit.x)), -rdUnder, uHit.y, st, true) : vec3(0.02, 0.06, 0.12);

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
    outCol = bodyCol + vec3(0.08, 0.24, 0.34) * smoothstep(0.42, 0.82, r1 * 0.55 + r2 * 0.55) * 0.75;
    return;
  }

  float cosTheta = clamp(dot(N, V), 0.0, 1.0);
  float reflWeight = clamp((0.02 + 0.98 * pow(1.0 - cosTheta, 5.0)) * 1.15 + 0.04, 0.0, 0.96);
  vec3 rdRefl = reflect(rd, N);
  if (rdRefl.y < 0.02) rdRefl = normalize(vec3(rdRefl.x, 0.02, rdRefl.z));
  vec3 reflCol = evalSky(rdRefl, vUv, true);
  vec2 rHit = traceSolid(wPos + N * 0.02, rdRefl, 5.0, 24);
  if (rHit.y > 0.5) {
    vec3 rPos = wPos + N * 0.02 + rdRefl * rHit.x;
    reflCol = shadeSolid(rPos, calcSolidNormal(rPos), -rdRefl, rHit.y, st, false);
  }
  vec3 col = mix(bodyCol, reflCol, reflWeight);

  float specSun = pow(max(dot(N, normalize(SUN_DIR + V)), 0.0), (st >= 6) ? 420.0 : 140.0) * ((st >= 6) ? 4.2 : 1.5);
  col += SUN_COL * specSun;
  if (st >= 6) outBloomCol += SUN_COL * max(0.0, specSun - 0.85) * 0.95;

  float specLan = pow(max(dot(N, normalize(normalize(LANTERN_POS - wPos) + V)), 0.0), 110.0) * 1.35;
  col += vec3(1.0, 0.72, 0.34) * specLan;
  if (st >= 6) outBloomCol += vec3(1.0, 0.72, 0.34) * max(0.0, specLan - 0.55) * 0.55;

  if (st >= 6) {
    float waveH = clamp((wPos.y + 0.015) / 0.13, 0.0, 1.0);
    float backLit = pow(max(dot(V, -SUN_DIR + N * 0.50), 0.0), 2.4);
    float graz = pow(1.0 - cosTheta, 1.8);
    vec3 sssCol = vec3(0.02, 0.92, 0.70);
    float sss = waveH * (0.55 + 1.65 * backLit) * (0.48 + 0.52 * graz);
    float pdeCalm = (st == 7) ? 0.58 : 1.0;
    col += sssCol * sss * 1.05 * pdeCalm;
    outBloomCol += sssCol * max(0.0, sss - 0.78) * 0.30 * pdeCalm;
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
  outCol = col;
}

vec3 shadeLiquidSplash(vec3 p, vec3 N, vec3 rd, vec3 bgCol, float rimFoam, out vec3 splashBloom) {
  vec3 V = -rd;
  float cosT = clamp(dot(N, V), 0.0, 1.0);
  float fres = 0.03 + 0.97 * pow(1.0 - cosT, 4.2);
  vec3 refl = evalSky(reflect(rd, N), vUv, true) * 1.15;
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
  vec2 ndc = vUv * 2.0 - 1.0;
  vec3 ro = uCamPos;
  vec3 rd = normalize(uCamFwd + ndc.x * uAspect * uTanHalfFov * uCamRight + ndc.y * uTanHalfFov * uCamUp);
  bool isLeft = (uWipeX <= 0.001) ? false : ((uWipeX >= 0.999) ? true : (vUv.x < uWipeX));
  int st = isLeft ? uStageLeft : uStageRight;

  vec3 col = evalSky(rd, vUv, false), bloom = vec3(0.0);
  float baseT = 99.0;

  vec3 oc = ro - vec3(0.0, -0.15, 0.0);
  float b = dot(oc, rd), disc = b * b - (dot(oc, oc) - 3.65 * 3.65);
  if (disc > 0.0) {
    float tMax = min(22.0, -b + sqrt(disc));
    vec2 sHit = traceSolid(ro, rd, tMax, 60);
    float wT = traceWaterSurface(ro, rd, st, sHit.x);
    if (wT > 0.0 && wT < sHit.x) {
      baseT = wT;
      shadeWater(ro, rd, ro + rd * wT, st, isLeft, col, bloom);
    } else if (sHit.y > 0.5) {
      baseT = sHit.x;
      vec3 pos = ro + rd * sHit.x;
      col = shadeSolid(pos, calcSolidNormal(pos), -rd, sHit.y, st, false);
      if (sHit.y > 4.5 && sHit.y < 5.5 && st >= 6) bloom += vec3(1.6, 1.0, 0.35);
    }
  }

  if (st == 7 && uSplashTime > 0.0) {
    float spT = traceSplash3D(ro, rd, baseT);
    vec4 drHit = traceBallisticDroplets(ro, rd, (spT > 0.0 ? spT : baseT));
    if (drHit.x > 0.0) {
      vec3 dp = ro + rd * drHit.x, dBlm = vec3(0.0);
      col = shadeLiquidSplash(dp, normalize(dp - drHit.yzw), rd, col, 0.08, dBlm);
      bloom += dBlm;
    } else if (spT > 0.0) {
      vec3 sp = ro + rd * spT, sBlm = vec3(0.0);
      float aerated = smoothstep(0.24, 0.54, sp.y) * (0.35 + 0.65 * noise3(sp * 16.0));
      col = shadeLiquidSplash(sp, calcSplashNormal(sp), rd, col, aerated * 0.48, sBlm);
      bloom += sBlm;
    }
  }

  outHdr = vec4(max(col, vec3(0.0)), 1.0);
  outBloom = vec4(max(bloom, vec3(0.0)), 1.0);
}
`;

const BLUR_FS = `#version 300 es
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

const FINAL_FS = `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uTexHdr;
uniform sampler2D uTexBloom;
uniform int uStageLeft;
uniform int uStageRight;
uniform float uWipeX;
out vec4 outColor;
vec3 acesFilm(vec3 x) { return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0); }
void main() {
  bool isLeft = (uWipeX <= 0.001) ? false : ((uWipeX >= 0.999) ? true : (vUv.x < uWipeX));
  int st = isLeft ? uStageLeft : uStageRight;
  vec3 hdr = texture(uTexHdr, vUv).rgb;
  vec3 blm = (st >= 6) ? texture(uTexBloom, vUv).rgb : vec3(0.0);
  outColor = vec4(pow(clamp(acesFilm((hdr + blm * 0.72) * 1.12), 0.0, 1.0), vec3(1.0 / 2.2)), 1.0);
}
`;

export function createWaterEffect(gl) {
  const fmt = hdrFormat(gl);
  const progWater = linkProgram(gl, FULL_VS, WATER_FS);
  const progBlur = linkProgram(gl, FULL_VS, BLUR_FS);
  const progFinal = linkProgram(gl, FULL_VS, FINAL_FS);
  const vaoFull = gl.createVertexArray();

  // Live 128x128 zero-mean viscous Shallow-Water PDE state
  const N = GW * GH;
  let hPrev = new Float32Array(N);
  let hCurr = new Float32Array(N);
  let hNext = new Float32Array(N);
  const foam = new Float32Array(N);
  const solid = new Uint8Array(N);
  const rimSponge = new Float32Array(N);
  const waveTexBuf = new Uint8Array(N * 4);
  let activeCells = 0;

  for (let j = 0; j < GH; j++) {
    const wz = ((j / (GH - 1)) * 2.0 - 1.0) * POOL_HALF;
    for (let i = 0; i < GW; i++) {
      const wx = ((i / (GW - 1)) * 2.0 - 1.0) * POOL_HALF;
      const rPool = Math.hypot(wx, wz);
      const rPil = Math.hypot(wx - PILLAR_X, wz - PILLAR_Z);
      if (rPool >= 1.435 || rPil <= PILLAR_R) {
        solid[j * GW + i] = 1;
      } else {
        activeCells++;
        rimSponge[j * GW + i] = smoothstep(1.22, 1.435, rPool) * 0.028;
      }
    }
  }

  function injectZeroSumRing(wx0, wz0, rad, amp, foamAmp) {
    let wPos = 0, wNeg = 0;
    const tmpIdx = [], tmpVal = [];
    for (let j = 1; j < GH - 1; j++) {
      const wz = ((j / (GH - 1)) * 2.0 - 1.0) * POOL_HALF;
      const dz = wz - wz0;
      if (Math.abs(dz) > rad * 2.6) continue;
      for (let i = 1; i < GW - 1; i++) {
        const idx = j * GW + i;
        if (solid[idx]) continue;
        const wx = ((i / (GW - 1)) * 2.0 - 1.0) * POOL_HALF;
        const d = Math.hypot(wx - wx0, dz);
        if (d < rad * 2.5) {
          const rn = d / rad;
          const v = (rn * rn * 1.15 - 1.0) * Math.exp(-rn * rn * 1.15);
          tmpIdx.push(idx); tmpVal.push(v);
          if (v > 0) wPos += v; else wNeg -= v;
          if (foamAmp > 0) foam[idx] = Math.min(1.0, foam[idx] + foamAmp * Math.exp(-rn * rn * 1.8));
        }
      }
    }
    const posScale = wPos > 1e-6 ? wNeg / wPos : 1.0;
    for (let k = 0; k < tmpIdx.length; k++) {
      const v = tmpVal[k];
      hCurr[tmpIdx[k]] += amp * (v > 0 ? v * posScale : v);
    }
  }

  function stepWaveSubstep() {
    const c2 = 0.135, baseDamp = 0.0095, visc = 0.018;
    let sumH = 0.0;
    for (let j = 1; j < GH - 1; j++) {
      for (let i = 1; i < GW - 1; i++) {
        const idx = j * GW + i;
        if (solid[idx]) { hNext[idx] = 0; foam[idx] = 0; continue; }
        const hc = hCurr[idx], hp = hPrev[idx];
        const lapC = (solid[idx - 1] ? hc : hCurr[idx - 1]) + (solid[idx + 1] ? hc : hCurr[idx + 1])
                   + (solid[idx - GW] ? hc : hCurr[idx - GW]) + (solid[idx + GW] ? hc : hCurr[idx + GW]) - 4.0 * hc;
        const lapP = (solid[idx - 1] ? hp : hPrev[idx - 1]) + (solid[idx + 1] ? hp : hPrev[idx + 1])
                   + (solid[idx - GW] ? hp : hPrev[idx - GW]) + (solid[idx + GW] ? hp : hPrev[idx + GW]) - 4.0 * hp;
        const dTotal = baseDamp + rimSponge[idx];
        const val = clamp((2.0 - dTotal) * hc - (1.0 - dTotal) * hp + c2 * lapC + visc * (lapC - lapP), -0.14, 0.14);
        hNext[idx] = val;
        sumH += val;
        foam[idx] *= 0.978;
      }
    }
    const meanH = sumH / Math.max(1, activeCells);
    for (let i = 0; i < N; i++) if (!solid[i]) hNext[i] -= meanH;
    const tmp = hPrev; hPrev = hCurr; hCurr = hNext; hNext = tmp;
  }

  function packWaveTex() {
    for (let j = 0; j < GH; j++) {
      for (let i = 0; i < GW; i++) {
        const idx = j * GW + i, h = hCurr[idx];
        const iL = Math.max(0, i - 1), iR = Math.min(GW - 1, i + 1);
        const jD = Math.max(0, j - 1), jU = Math.min(GH - 1, j + 1);
        const gx = (solid[j * GW + iR] ? h : hCurr[j * GW + iR]) - (solid[j * GW + iL] ? h : hCurr[j * GW + iL]);
        const gz = (solid[jU * GW + i] ? h : hCurr[jU * GW + i]) - (solid[jD * GW + i] ? h : hCurr[jD * GW + i]);
        waveTexBuf[idx * 4 + 0] = clamp(Math.round(((h / 0.14) * 0.5 + 0.5) * 255), 0, 255);
        waveTexBuf[idx * 4 + 1] = clamp(Math.round(((gx / 0.08) * 0.5 + 0.5) * 255), 0, 255);
        waveTexBuf[idx * 4 + 2] = clamp(Math.round(((gz / 0.08) * 0.5 + 0.5) * 255), 0, 255);
        waveTexBuf[idx * 4 + 3] = clamp(Math.round(clamp(foam[idx], 0, 1) * 255), 0, 255);
      }
    }
  }
  packWaveTex();

  const texPalIdx = makeTex2D(gl, PAL_N, PAL_N, gl.R8, gl.RED, gl.UNSIGNED_BYTE, gl.NEAREST, buildPalIdxBytes());
  const texTile = makeTex2D(gl, TILE_N, TILE_N, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, gl.NEAREST, buildTileBytes(), gl.REPEAT);
  const texWave = makeTex2D(gl, GW, GH, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, gl.LINEAR, waveTexBuf);

  let bufW = 0, bufH = 0, bw = 0, bh = 0;
  let texHdr = null, texBloomSrc = null, fboHdr = null;
  let texBlurA = null, texBlurB = null, fboBlurA = null, fboBlurB = null;

  function allocTargets(w, h) {
    if (w === bufW && h === bufH) return;
    for (const t of [texHdr, texBloomSrc, texBlurA, texBlurB]) if (t) gl.deleteTexture(t);
    for (const f of [fboHdr, fboBlurA, fboBlurB]) if (f) gl.deleteFramebuffer(f);
    bufW = w; bufH = h;
    bw = Math.max(64, (w >> 2)); bh = Math.max(64, (h >> 2));

    texHdr = makeTex2D(gl, w, h, fmt.internalFmt, fmt.fmt, fmt.type, gl.LINEAR);
    texBloomSrc = makeTex2D(gl, w, h, fmt.internalFmt, fmt.fmt, fmt.type, gl.LINEAR);
    fboHdr = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fboHdr);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texHdr, 0);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT1, gl.TEXTURE_2D, texBloomSrc, 0);
    gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1]);

    texBlurA = makeTex2D(gl, bw, bh, fmt.internalFmt, fmt.fmt, fmt.type, gl.LINEAR);
    texBlurB = makeTex2D(gl, bw, bh, fmt.internalFmt, fmt.fmt, fmt.type, gl.LINEAR);
    fboBlurA = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fboBlurA);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texBlurA, 0);
    fboBlurB = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fboBlurB);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texBlurB, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  let simTime = 0, waveAcc = 0;
  let dropT = -1.0;
  let plungeFired = false, jetFired = false, bobFired = false;
  const dropLanded = new Uint8Array(DROP_COUNT);
  const simDt = 1.0 / 30.0;

  function triggerDrop() {
    dropT = 0.0;
    plungeFired = false;
    jetFired = false;
    bobFired = false;
    dropLanded.fill(0);
  }

  return {
    id: "water",
    maxPixels: 860000,
    defaultCamera: {
      yaw: 0.24,
      pitch: 0.44,
      dist: 7.8,
      lookY: -0.04,
      fovDeg: 38,
      minDist: 4.0,
      maxDist: 14.0,
      minPitch: 0.07,
      maxPitch: 1.25,
      autoOrbitSpeed: 0.0,
    },
    enterStep(stepIdx) {
      if (stepIdx === 7) triggerDrop();
    },
    triggerAction(actionId) {
      if (actionId === "drop") triggerDrop();
    },
    isActionActive(actionId) {
      if (actionId === "drop") return dropT >= 0.0 && dropT < 4.9;
      return false;
    },
    onCanvasClick(ndcX, ndcY, w, h, step, cam) {
      if (step.stage !== 7) return false;
      const aspect = w / Math.max(1, h);
      const portraitScale = aspect < 0.95 ? clamp(1.04 / Math.max(aspect, 0.54), 1.0, 1.56) : 1.0;
      const basis = cameraBasisFromOrbit(cam.yaw, cam.pitch, cam.dist * portraitScale, cam.lookY);
      const tanHalfFov = Math.tan(((cam.fovDeg * Math.PI) / 180) * 0.5);
      const rx = basis.fwd[0] + ndcX * aspect * tanHalfFov * basis.right[0] + ndcY * tanHalfFov * basis.up[0];
      const ry = basis.fwd[1] + ndcX * aspect * tanHalfFov * basis.right[1] + ndcY * tanHalfFov * basis.up[1];
      const rz = basis.fwd[2] + ndcX * aspect * tanHalfFov * basis.right[2] + ndcY * tanHalfFov * basis.up[2];
      if (ry >= -0.02) return false;
      const t = -basis.pos[1] / ry;
      if (t <= 0) return false;
      const wx = basis.pos[0] + rx * t;
      const wz = basis.pos[2] + rz * t;
      if (Math.hypot(wx, wz) < 1.38 && Math.hypot(wx - PILLAR_X, wz - PILLAR_Z) > PILLAR_R + 0.04) {
        injectZeroSumRing(wx, wz, 0.22, 0.095, 0.52);
        return true;
      }
      return false;
    },
    update(dt, paused, step, split) {
      if (paused) return;
      simTime += dt;

      const sL = split.enabled ? step.compareLeft : step.stage;
      const sR = split.enabled ? step.compareRight : step.stage;
      if (sL !== 7 && sR !== 7) return;

      waveAcc += dt;
      let steps = 0;
      while (waveAcc >= simDt && steps < 2) {
        waveAcc -= simDt;
        const prevDropT = dropT;
        if (dropT >= 0.0) {
          dropT += simDt;
          if (dropT > 5.4) dropT = -1.0;
        }
        const [cx, , cz] = getColliderPos(dropT);
        for (let s = 0; s < 4; s++) {
          const subT = prevDropT >= 0.0 ? prevDropT + ((s + 1) / 4) * simDt : -1.0;
          if (subT >= 0.0) {
            if (!plungeFired && subT >= IMPACT_T) {
              plungeFired = true;
              injectZeroSumRing(IMPACT_X, IMPACT_Z, 0.30, 0.135, 0.92);
            }
            if (!jetFired && subT >= IMPACT_T + 0.72) {
              jetFired = true;
              injectZeroSumRing(IMPACT_X, IMPACT_Z, 0.24, 0.068, 0.45);
            }
            if (!bobFired && subT >= 1.55) {
              bobFired = true;
              injectZeroSumRing(cx, cz, 0.26, -0.042, 0.28);
            }
            for (let d = 0; d < DROP_COUNT; d++) {
              if (dropMeta[d].isHero && !dropLanded[d] && subT >= dropMeta[d].landT) {
                dropLanded[d] = 1;
                const dm = dropMeta[d];
                if (Math.hypot(dm.landX, dm.landZ) < 1.28 && Math.hypot(dm.landX - PILLAR_X, dm.landZ - PILLAR_Z) > 0.26) {
                  injectZeroSumRing(dm.landX, dm.landZ, 0.14, 0.026, 0.18);
                }
              }
            }
          }
          stepWaveSubstep();
        }
        steps++;
      }
      if (steps > 0) {
        packWaveTex();
        gl.bindTexture(gl.TEXTURE_2D, texWave);
        gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, GW, GH, gl.RGBA, gl.UNSIGNED_BYTE, waveTexBuf);
      }
    },
    getTechBadge(stepIdx) {
      const tags = [
        "80×80 STATIC · 16 CLUT",
        "DUAL UV · SCANLINE WARP",
        "BEER–LAMBERT · EXP(-σd)",
        "SCHLICK FRESNEL · F0=0.02",
        "6-WAVE GERSTNER · FOAM",
        "IOR 1.333 · RGB CAUSTICS",
        "SPECTRAL · EMERALD SSS",
        "128×128 PDE · CLICK POOL",
      ];
      return tags[stepIdx] || "";
    },
    render(w, h, step, split, cam) {
      allocTargets(w, h);
      const aspect = w / Math.max(1, h);
      const portraitScale = aspect < 0.95 ? clamp(1.04 / Math.max(aspect, 0.54), 1.0, 1.56) : 1.0;
      const basis = cameraBasisFromOrbit(cam.yaw, cam.pitch, cam.dist * portraitScale, cam.lookY);
      const tanHalfFov = Math.tan(((cam.fovDeg * Math.PI) / 180) * 0.5);

      const stageLeft = split.enabled ? step.compareLeft : step.stage;
      const stageRight = split.enabled ? step.compareRight : step.stage;
      const wipeX = split.enabled ? split.pos : 0.0;
      const clutIndexOnly = split.enabled && step.clutSplit ? 1.0 : 0.0;

      const colliderActive = (stageLeft === 7 || stageRight === 7) && dropT >= 0.02 && dropT <= 4.85 ? 1.0 : 0.0;
      const colliderPos = getColliderPos(dropT);
      const splashTime = dropT >= 0.0 ? dropT - IMPACT_T : -1.0;
      const sphereWet = dropT >= 0.0 ? smoothstep(IMPACT_T - 0.02, IMPACT_T + 0.08, dropT) : 0.0;

      gl.bindVertexArray(vaoFull);
      gl.disable(gl.DEPTH_TEST);
      gl.disable(gl.BLEND);

      // Pass 1: Basin + Water + Splash Crown + 48 Droplets
      gl.bindFramebuffer(gl.FRAMEBUFFER, fboHdr);
      gl.viewport(0, 0, bufW, bufH);
      gl.useProgram(progWater);

      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, texPalIdx);
      gl.uniform1i(gl.getUniformLocation(progWater, "uTexPalIdx"), 0);
      gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, texTile);
      gl.uniform1i(gl.getUniformLocation(progWater, "uTexTile"), 1);
      gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D, texWave);
      gl.uniform1i(gl.getUniformLocation(progWater, "uTexWave"), 2);

      gl.uniform3fv(gl.getUniformLocation(progWater, "uClut16"), CLUT_16_F32);
      gl.uniform3fv(gl.getUniformLocation(progWater, "uCamPos"), basis.pos);
      gl.uniform3fv(gl.getUniformLocation(progWater, "uCamRight"), basis.right);
      gl.uniform3fv(gl.getUniformLocation(progWater, "uCamUp"), basis.up);
      gl.uniform3fv(gl.getUniformLocation(progWater, "uCamFwd"), basis.fwd);
      gl.uniform1f(gl.getUniformLocation(progWater, "uTanHalfFov"), tanHalfFov);
      gl.uniform1f(gl.getUniformLocation(progWater, "uAspect"), aspect);
      gl.uniform1f(gl.getUniformLocation(progWater, "uTime"), simTime);
      gl.uniform1i(gl.getUniformLocation(progWater, "uStageLeft"), stageLeft);
      gl.uniform1i(gl.getUniformLocation(progWater, "uStageRight"), stageRight);
      gl.uniform1f(gl.getUniformLocation(progWater, "uWipeX"), wipeX);
      gl.uniform1f(gl.getUniformLocation(progWater, "uClutIndexOnly"), clutIndexOnly);
      gl.uniform3fv(gl.getUniformLocation(progWater, "uColliderPos"), colliderPos);
      gl.uniform1f(gl.getUniformLocation(progWater, "uColliderActive"), colliderActive);
      gl.uniform1f(gl.getUniformLocation(progWater, "uSplashTime"), splashTime);
      gl.uniform1f(gl.getUniformLocation(progWater, "uSphereWet"), sphereWet);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

      // Pass 2: HDR Bloom Blur
      if (stageLeft >= 6 || stageRight >= 6) {
        gl.useProgram(progBlur);
        gl.viewport(0, 0, bw, bh);
        const uDir = gl.getUniformLocation(progBlur, "uDir");
        gl.uniform1i(gl.getUniformLocation(progBlur, "uTex"), 0);
        gl.activeTexture(gl.TEXTURE0);

        gl.bindFramebuffer(gl.FRAMEBUFFER, fboBlurA);
        gl.bindTexture(gl.TEXTURE_2D, texBloomSrc);
        gl.uniform2f(uDir, 1.0 / bw, 0.0);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

        gl.bindFramebuffer(gl.FRAMEBUFFER, fboBlurB);
        gl.bindTexture(gl.TEXTURE_2D, texBlurA);
        gl.uniform2f(uDir, 0.0, 1.0 / bh);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

        gl.bindFramebuffer(gl.FRAMEBUFFER, fboBlurA);
        gl.bindTexture(gl.TEXTURE_2D, texBlurB);
        gl.uniform2f(uDir, 2.0 / bw, 0.0);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

        gl.bindFramebuffer(gl.FRAMEBUFFER, fboBlurB);
        gl.bindTexture(gl.TEXTURE_2D, texBlurA);
        gl.uniform2f(uDir, 0.0, 2.0 / bh);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      }

      // Pass 3: ACES Filmic Tone Mapping -> Screen
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, bufW, bufH);
      gl.useProgram(progFinal);
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, texHdr);
      gl.uniform1i(gl.getUniformLocation(progFinal, "uTexHdr"), 0);
      gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, texBlurB);
      gl.uniform1i(gl.getUniformLocation(progFinal, "uTexBloom"), 1);
      gl.uniform1i(gl.getUniformLocation(progFinal, "uStageLeft"), stageLeft);
      gl.uniform1i(gl.getUniformLocation(progFinal, "uStageRight"), stageRight);
      gl.uniform1f(gl.getUniformLocation(progFinal, "uWipeX"), wipeX);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      gl.bindVertexArray(null);
    },
  };
}
