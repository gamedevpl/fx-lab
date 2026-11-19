// Evolution of Fire — 8-era live WebGL2 pipeline with real-time 24x36x24 3D Navier-Stokes fluid.

import {
  clamp, lerp, smoothstep, hexToRgb01, mulberry32,
  cameraBasisFromOrbit, FULL_VS, linkProgram, makeTex2D, hdrFormat,
} from "./gl-utils.js";

const CLUT_16_HEX = [
  "#000000", "#2b0506", "#540a08", "#82140a", "#b3240b",
  "#db3d0c", "#f25c10", "#ff8017", "#ffa624", "#ffc938",
  "#ffe65e", "#fff69e", "#ffe052", "#f58316", "#c9340b", "#691008",
];
const CLUT_16_F32 = new Float32Array(16 * 3);
CLUT_16_HEX.forEach((h, i) => {
  const [r, g, b] = hexToRgb01(h);
  CLUT_16_F32[i * 3] = r; CLUT_16_F32[i * 3 + 1] = g; CLUT_16_F32[i * 3 + 2] = b;
});

const DOOM_PALETTE_HEX = [
  "#070707", "#1f0707", "#2f0f07", "#470f07", "#571707", "#671f07", "#771f07", "#8f2707",
  "#9f2f07", "#af3f07", "#bf4707", "#c74707", "#df4f07", "#df5707", "#df5707", "#d75f07",
  "#d75f07", "#d7670f", "#cf6f0f", "#cf770f", "#cf7f0f", "#cf8717", "#c78717", "#c78f17",
  "#c7971f", "#bf9f1f", "#bf9f1f", "#bfa727", "#bfa727", "#bfaf2f", "#b7af2f", "#b7b72f",
  "#b7b737", "#cfcf6f", "#dfdf9f", "#efefc7", "#ffffff",
];
const DOOM_PAL_F32 = new Float32Array(37 * 3);
DOOM_PALETTE_HEX.forEach((h, i) => {
  const [r, g, b] = hexToRgb01(h);
  DOOM_PAL_F32[i * 3] = r; DOOM_PAL_F32[i * 3 + 1] = g; DOOM_PAL_F32[i * 3 + 2] = b;
});

const PAL_W = 64, PAL_H = 80;
const DOOM_W = 96, DOOM_H = 112;
const SPR_W = 64, SPR_H = 80, SPR_N = 8;
const NX = 24, NY = 36, NZ = 24, NV = NX * NY * NZ;
const VOL_MIN = [-1.15, 0.08, -1.15];
const VOL_MAX = [1.15, 2.48, 1.15];
const COLLIDER_RADIUS = 0.28;
const FLIP_COLS = 8, FLIP_ROWS = 4, FLIP_N = 32;
const FLIP_CW = 36, FLIP_CH = 48;
const FLIP_W = FLIP_COLS * FLIP_CW, FLIP_H = FLIP_ROWS * FLIP_CH;
const STAGE_GI = [0.14, 0.28, 0.38, 0.65, 1.15, 0.42, 1.75, 1.70];

function buildPalIdxBytes() {
  const bytes = new Uint8Array(PAL_W * PAL_H);
  for (let y = 0; y < PAL_H; y++) {
    const ny = y / (PAL_H - 1);
    for (let x = 0; x < PAL_W; x++) {
      const nx = (x / (PAL_W - 1)) * 2.0 - 1.0;
      const sway1 = 0.16 * Math.sin(ny * 8.5);
      const sway2 = 0.11 * Math.cos(ny * 12.0 + 1.0);
      const wMain = 0.56 * Math.pow(Math.max(0.0, 1.0 - ny), 0.78);
      const dMain = Math.abs(nx - sway1 * ny) / Math.max(0.02, wMain);
      const wLeft = 0.28 * Math.pow(Math.max(0.0, 1.0 - ny * 1.45), 0.72);
      const dLeft = Math.abs(nx + 0.30 - sway2 * ny) / Math.max(0.02, wLeft);
      const wRight = 0.26 * Math.pow(Math.max(0.0, 1.0 - ny * 1.55), 0.72);
      const dRight = Math.abs(nx - 0.30 + sway2 * ny) / Math.max(0.02, wRight);
      const d = Math.min(dMain, dLeft, dRight);
      const shape = (1.0 - d) * smoothstep(0.02, 0.10, ny) * smoothstep(0.92, 0.72, ny);
      if (shape > 0.10) {
        const wave = ny * 22.0 - d * 5.0 + Math.sin(nx * 7.5 + ny * 9.0) * 1.3;
        const band = ((Math.floor(wave) % 15) + 15) % 15;
        const env = clamp(Math.round(clamp(shape, 0, 1) * 15), 1, 15);
        bytes[y * PAL_W + x] = (env << 4) | (band + 1);
      }
    }
  }
  return bytes;
}

function buildSpriteAtlas() {
  const bytes = new Uint8Array(SPR_W * SPR_N * SPR_H * 4);
  const cols = [[1.0, 0.94, 0.56], [0.98, 0.54, 0.08], [0.82, 0.18, 0.04]];
  for (let f = 0; f < SPR_N; f++) {
    const ph = (f / SPR_N) * Math.PI * 2.0;
    for (let y = 0; y < SPR_H; y++) {
      const ny = y / (SPR_H - 1);
      for (let x = 0; x < SPR_W; x++) {
        const nx = (x / (SPR_W - 1)) * 2.0 - 1.0;
        const w0 = Math.sin(ny * 7.0 - ph) * 0.15 * ny;
        const w1 = Math.sin(ny * 10.0 - ph * 2.0 + 1.2) * 0.10 * ny;
        const dMain = Math.abs(nx - w0) / Math.max(0.04, 0.52 * Math.pow(Math.max(0, 1.0 - ny * 1.05), 0.68));
        const dLeft = Math.hypot((nx + 0.34 - w1) * 2.2, (ny - 0.28) * 2.3);
        const dRight = Math.hypot((nx - 0.33 + w1) * 2.3, (ny - 0.25) * 2.4);
        const val = (1.0 - Math.min(dMain, dLeft * 1.15, dRight * 1.15)) * smoothstep(0.0, 0.10, ny);
        let r = 0, g = 0, b = 0, a = 0;
        if (val > 0.58) { [r, g, b] = cols[0]; a = 0.95; }
        else if (val > 0.30) { [r, g, b] = cols[1]; a = 0.90; }
        else if (val > 0.08) { [r, g, b] = cols[2]; a = 0.80; }
        for (let s = 0; s < 3; s++) {
          const su = ((f / SPR_N) + s * 0.33) % 1.0;
          if (Math.hypot(nx - Math.sin(s * 2.7 + su * 5.0) * 0.36, ny - (0.24 + su * 0.66)) < 0.045) {
            r = 1.0; g = 0.82; b = 0.24; a = 0.95;
          }
        }
        const idx = (y * (SPR_W * SPR_N) + (f * SPR_W + x)) * 4;
        bytes[idx] = Math.round(r * 255);
        bytes[idx + 1] = Math.round(g * 255);
        bytes[idx + 2] = Math.round(b * 255);
        bytes[idx + 3] = Math.round(a * 255);
      }
    }
  }
  return bytes;
}

const SCENE_FS = `#version 300 es
precision highp float;
in vec2 vUv;

uniform vec3 uCamPos;
uniform vec3 uCamRight;
uniform vec3 uCamUp;
uniform vec3 uCamFwd;
uniform float uTanHalfFov;
uniform float uAspect;
uniform float uTime;
uniform float uFireIntensityLeft;
uniform float uFireIntensityRight;
uniform float uWipeX;
uniform vec3 uFireColor;
uniform vec3 uColliderPos;
uniform float uColliderActive;

layout(location = 0) out vec4 outColor;
layout(location = 1) out vec4 outDepth;

float hash31(vec3 p) {
  p = fract(p * 0.1031);
  p += dot(p, p.yzx + 33.33);
  return fract((p.x + p.y) * p.z);
}
float noise3(vec3 p) {
  vec3 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(mix(hash31(i), hash31(i+vec3(1,0,0)), f.x), mix(hash31(i+vec3(0,1,0)), hash31(i+vec3(1,1,0)), f.x), f.y),
    mix(mix(hash31(i+vec3(0,0,1)), hash31(i+vec3(1,0,1)), f.x), mix(hash31(i+vec3(0,1,1)), hash31(i+vec3(1,1,1)), f.x), f.y),
    f.z
  );
}
float sdCylinder(vec3 p, float r, float h) {
  vec2 d = abs(vec2(length(p.xz), p.y)) - vec2(r, h);
  return min(max(d.x, d.y), 0.0) + length(max(d, 0.0));
}
float sdCapsule(vec3 p, vec3 a, vec3 b, float r) {
  vec3 pa = p - a, ba = b - a;
  float h = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0);
  return length(pa - ba * h) - r;
}

vec2 mapScene(vec3 p) {
  vec2 res = vec2(1e5, 0.0);
  {
    float dTop = sdCylinder(p - vec3(0.0, -0.15, 0.0), 1.66, 0.15) - 0.025;
    float cragY = clamp((-p.y - 0.22) / 1.50, 0.0, 1.0);
    float cragR = 1.60 * pow(1.0 - cragY, 0.72) + 0.06 * sin(atan(p.z, p.x) * 6.0 + p.y * 3.5);
    float dCrag = max(length(p.xz) - max(0.05, cragR), max(p.y + 0.20, -1.68 - p.y));
    float dIsland = min(dTop, dCrag);
    float ph = uTime * 0.185;
    float s1 = length(p - vec3(-1.46, -0.72 + 0.08 * sin(ph * 2.0 + 0.4), 0.72)) - 0.17;
    float s2 = length(p - vec3( 1.52, -0.86 + 0.07 * sin(ph * 3.0 + 2.1), -0.45)) - 0.14;
    dIsland = min(dIsland, min(s1, s2));
    if (dIsland < res.x) res = vec2(dIsland, 1.0);
  }
  {
    float r = length(p.xz), ang = atan(p.x, -p.z);
    float dArc = abs(r - 1.34) - 0.15;
    float wallH = 1.92 + 0.08 * smoothstep(-0.2, 0.2, cos(ang * 7.0));
    float dWall = max(max(dArc, max(p.y - wallH, -p.y)), (abs(ang) - 1.08) * r) - 0.015;
    if (dWall < res.x) res = vec2(dWall, 2.0);
  }
  {
    float ang = atan(p.z, p.x), sector = 6.2831853 / 10.0;
    float aLocal = mod(ang + sector * 0.5, sector) - sector * 0.5;
    float r = length(p.xz);
    vec3 q = vec3(cos(aLocal) * r - 0.68, p.y - 0.11, sin(aLocal) * r);
    vec3 b = abs(q) - vec3(0.11, 0.095, 0.16);
    float dStone = length(max(b, 0.0)) + min(max(b.x, max(b.y, b.z)), 0.0) - 0.045 + 0.014 * (noise3(p * 8.5) - 0.5);
    if (dStone < res.x) res = vec2(dStone, 3.0);
  }
  {
    float l1 = sdCapsule(p, vec3(-0.44, 0.07,  0.34), vec3( 0.12, 0.54, -0.10), 0.092);
    float l2 = sdCapsule(p, vec3( 0.42, 0.08,  0.30), vec3(-0.10, 0.52, -0.12), 0.088);
    float l3 = sdCapsule(p, vec3(-0.14, 0.07, -0.44), vec3( 0.10, 0.48,  0.14), 0.088);
    float l4 = sdCapsule(p, vec3( 0.32, 0.06, -0.32), vec3(-0.22, 0.30,  0.22), 0.082);
    float dLogs = min(min(l1, l2), min(l3, l4));
    if (dLogs < res.x) res = vec2(dLogs, 4.0);
  }
  {
    float dEmb = length((p - vec3(0.0, 0.04, 0.0)) * vec3(1.0, 2.5, 1.0)) - 0.54;
    if (dEmb < res.x) res = vec2(dEmb, 5.0);
  }
  if (uColliderActive > 0.5) {
    float dCol = length(p - uColliderPos) - 0.25;
    if (dCol < res.x) res = vec2(dCol, 6.0);
  }
  return res;
}

vec3 calcNormal(vec3 p) {
  vec2 e = vec2(0.0028, 0.0);
  return normalize(vec3(
    mapScene(p + e.xyy).x - mapScene(p - e.xyy).x,
    mapScene(p + e.yxy).x - mapScene(p - e.yxy).x,
    mapScene(p + e.yyx).x - mapScene(p - e.yyx).x
  ));
}

float softShadow(vec3 ro, vec3 rd, float mint, float maxt, float k) {
  float sh = 1.0, t = mint;
  for (int i = 0; i < 16; i++) {
    float h = mapScene(ro + rd * t).x;
    sh = min(sh, clamp(k * h / t, 0.0, 1.0));
    t += clamp(h, 0.04, 0.25);
    if (sh < 0.02 || t > maxt) break;
  }
  return sh;
}

vec3 evalSky(vec2 uv) {
  vec3 cTop = vec3(0.08, 0.12, 0.25), cMid = vec3(0.16, 0.24, 0.42);
  vec3 cHor = vec3(0.30, 0.40, 0.58), cLow = vec3(0.12, 0.17, 0.33);
  vec3 col = (uv.y > 0.30)
    ? mix(cHor, mix(cMid, cTop, smoothstep(0.32, 1.0, clamp((uv.y - 0.30) / 0.70, 0.0, 1.0))), smoothstep(0.0, 0.78, clamp((uv.y - 0.30) / 0.70, 0.0, 1.0)))
    : mix(cLow, cHor, smoothstep(0.0, 1.0, clamp(uv.y / 0.30, 0.0, 1.0)));
  vec2 g = uv * vec2(26.0 * uAspect, 26.0);
  vec2 cid = floor(g), f = fract(g) - 0.5;
  float sh = fract(sin(dot(cid, vec2(127.1, 311.7))) * 43758.5453);
  if (sh > 0.962 && uv.y > 0.46) {
    float tw = 0.55 + 0.45 * sin(uTime * 1.45 + sh * 90.0);
    col += vec3(0.95, 0.90, 0.75) * exp(-dot(f, f) * 28.0) * tw * 0.65;
  }
  return col;
}

void main() {
  vec2 ndc = vUv * 2.0 - 1.0;
  vec3 ro = uCamPos;
  vec3 rd = normalize(uCamFwd + ndc.x * uAspect * uTanHalfFov * uCamRight + ndc.y * uTanHalfFov * uCamUp);

  vec3 oc = ro - vec3(0.0, 0.30, 0.0);
  float b = dot(oc, rd), disc = b * b - (dot(oc, oc) - 3.4 * 3.4);
  vec3 col = evalSky(vUv);
  float hitDist = 31.9, hitMat = 0.0;

  if (disc > 0.0) {
    float t = max(0.2, -b - sqrt(disc));
    float tMax = min(22.0, -b + sqrt(disc));
    for (int i = 0; i < 68; i++) {
      vec2 h = mapScene(ro + rd * t);
      if (h.x < 0.0024) { hitDist = t; hitMat = h.y; break; }
      t += h.x * 0.88;
      if (t > tMax) break;
    }
  }

  float fireGI = (uWipeX <= 0.001) ? uFireIntensityRight
               : ((uWipeX >= 0.999) ? uFireIntensityLeft
               : (vUv.x < uWipeX ? uFireIntensityLeft : uFireIntensityRight));

  if (hitMat > 0.5) {
    vec3 pos = ro + rd * hitDist, n = calcNormal(pos), v = -rd;
    vec3 albedo = vec3(0.18, 0.21, 0.29), emissive = vec3(0.0);
    float rough = 0.78, metal = 0.0;

    if (hitMat < 1.5) {
      float topMask = smoothstep(0.45, 0.85, n.y) * smoothstep(-0.08, 0.02, pos.y);
      float rad = length(pos.xz), ringIdx = floor(rad * 3.6);
      float angDiv = max(6.0, ringIdx * 5.0), ang = atan(pos.z, pos.x);
      float fx = fract(rad * 3.6);
      float fy = fract((ang / 6.2831853 + 0.5) * angDiv + mod(ringIdx, 2.0) * 0.5);
      float mortar = smoothstep(0.03, 0.08, min(fx, 1.0 - fx)) * smoothstep(0.03, 0.08, min(fy, 1.0 - fy));
      float tileTone = hash31(vec3(ringIdx, floor((ang / 6.2831853 + 0.5) * angDiv), 4.0));
      vec3 flagstone = mix(vec3(0.10, 0.12, 0.18), vec3(0.22, 0.24, 0.32) * (0.75 + 0.45 * tileTone), mortar) * (0.85 + 0.3 * noise3(pos * 14.0));
      vec3 cragStone = vec3(0.11, 0.13, 0.21) * (0.75 + 0.45 * noise3(pos * 6.0));
      albedo = mix(cragStone, flagstone, topMask);
      float puddle = smoothstep(0.50, 0.68, noise3(pos * 2.2 + vec3(2.4, 0.0, 1.1))) * topMask * mortar;
      rough = mix(0.76, 0.10, puddle);
    } else if (hitMat < 2.5) {
      float ang = atan(pos.x, -pos.z), row = floor(pos.y * 5.2);
      float bx = fract(ang * 4.5 + mod(row, 2.0) * 0.5), by = fract(pos.y * 5.2);
      float mortar = smoothstep(0.04, 0.09, min(bx, 1.0 - bx)) * smoothstep(0.06, 0.12, min(by, 1.0 - by));
      float bTone = hash31(vec3(floor(ang * 4.5 + mod(row, 2.0) * 0.5), row, 2.0));
      vec3 brick = mix(vec3(0.13, 0.15, 0.22), vec3(0.25, 0.27, 0.35), bTone) * (0.82 + 0.36 * noise3(pos * 16.0));
      albedo = mix(vec3(0.06, 0.07, 0.12), brick, mortar);
      rough = mix(0.90, 0.48, mortar);
    } else if (hitMat < 3.5) {
      float soot = smoothstep(0.76, 0.54, length(pos.xz));
      albedo = mix(vec3(0.16, 0.18, 0.25), vec3(0.28, 0.29, 0.36), noise3(pos * 11.0)) * mix(1.0, 0.35, soot);
      rough = 0.62;
    } else if (hitMat < 4.5) {
      float bark = noise3(pos * 20.0), nearFire = smoothstep(0.55, 0.10, length(pos.xz));
      albedo = mix(vec3(0.14, 0.09, 0.06), vec3(0.035, 0.03, 0.03), nearFire * 0.90) * (0.7 + 0.5 * bark);
      rough = 0.86;
      float crack = smoothstep(0.62, 0.76, noise3(pos * 24.0 + vec3(0.0, uTime * 0.45, 0.0)));
      emissive = vec3(2.2, 0.45, 0.05) * crack * nearFire * (0.30 + 0.70 * clamp(fireGI, 0.0, 1.2));
    } else if (hitMat < 5.5) {
      float ch = noise3(pos * 18.0 + vec3(0.0, uTime * 0.3, 0.0));
      albedo = vec3(0.04, 0.03, 0.03);
      emissive = mix(vec3(1.1, 0.18, 0.02), vec3(3.0, 0.95, 0.16), smoothstep(0.32, 0.76, ch)) * (0.35 + 0.75 * clamp(fireGI, 0.0, 1.3));
    } else {
      albedo = vec3(0.24, 0.27, 0.34); rough = 0.20; metal = 0.92;
    }

    vec3 moonDir = normalize(vec3(-0.62, 0.76, 0.45));
    float moonNdl = max(0.0, dot(n, moonDir));
    float moonSh = softShadow(pos + n * 0.02, moonDir, 0.05, 4.0, 6.0);
    vec3 skyAmb = mix(vec3(0.06, 0.08, 0.16), vec3(0.18, 0.24, 0.38), n.y * 0.5 + 0.5);
    vec3 lit = albedo * (skyAmb * 0.95 + vec3(0.42, 0.52, 0.78) * moonNdl * moonSh * 0.82);

    vec3 firePos = vec3(0.07 * sin(uTime * 11.5), 0.78 + 0.09 * cos(uTime * 15.3), 0.07 * cos(uTime * 9.2));
    vec3 fVec = firePos - pos;
    float fDist = length(fVec);
    vec3 fDir = fVec / max(0.01, fDist);
    float fNdl = max(0.0, dot(n, fDir));
    float fAtten = 1.0 / (0.28 + 0.95 * fDist * fDist);
    float fSh = softShadow(pos + n * 0.025, fDir, 0.06, min(fDist - 0.04, 3.6), 5.0);
    float specPow = mix(96.0, 10.0, rough);
    float spec = pow(max(0.0, dot(n, normalize(fDir + v))), specPow) * mix(2.6, 0.10, rough);
    vec3 fRad = uFireColor * fireGI * fAtten * (0.22 + 0.78 * fSh) * 1.85;
    lit += (albedo * (1.0 - metal * 0.75) * fNdl + mix(vec3(1.0, 0.65, 0.28), albedo, metal * 0.4) * spec) * fRad;
    lit += mix(vec3(0.55, 0.68, 0.95), albedo, metal) * pow(max(0.0, dot(n, normalize(moonDir + v))), specPow) * mix(0.9, 0.05, rough) * moonSh;

    col = lit + emissive;
  }

  float dNorm = clamp(hitDist / 32.0, 0.0, 0.9999);
  outColor = vec4(col, 1.0);
  outDepth = vec4(floor(dNorm * 255.0) / 255.0, fract(dNorm * 255.0), hitMat / 10.0, 1.0);
}
`;

const FIRE_FS = `#version 300 es
precision highp float;
precision highp sampler3D;
in vec2 vUv;

uniform sampler2D uTexScene;
uniform sampler2D uTexDepth;
uniform sampler2D uTexPalIdx;
uniform sampler2D uTexDoom;
uniform sampler2D uTexSprite;
uniform sampler2D uTexFlipA;
uniform sampler2D uTexFlipB;
uniform sampler2D uTexFlipC;
uniform sampler3D uTexFluid3D;

uniform vec3 uClut16[16];
uniform vec3 uDoomPal[37];
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
uniform float uQuadWire;
uniform float uSparseGridFlash;

layout(location = 0) out vec4 outHdr;
layout(location = 1) out vec4 outBloom;

float hash31(vec3 p) {
  p = fract(p * 0.1031);
  p += dot(p, p.yzx + 33.33);
  return fract((p.x + p.y) * p.z);
}
float vnoise(vec3 p) {
  vec3 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(mix(hash31(i), hash31(i+vec3(1,0,0)), f.x), mix(hash31(i+vec3(0,1,0)), hash31(i+vec3(1,1,0)), f.x), f.y),
    mix(mix(hash31(i+vec3(0,0,1)), hash31(i+vec3(1,0,1)), f.x), mix(hash31(i+vec3(0,1,1)), hash31(i+vec3(1,1,1)), f.x), f.y),
    f.z
  );
}
float fbm3(vec3 p) {
  float s = 0.0, a = 0.52;
  for (int i = 0; i < 4; i++) {
    s += a * vnoise(p);
    p = p * 2.08 + vec3(13.1, -7.4, 5.7);
    a *= 0.48;
  }
  return s;
}

vec3 blackbodyHDR(float temp01) {
  float t = clamp(temp01, 0.0, 1.35);
  if (t < 0.08) return vec3(0.0);
  vec3 c1 = vec3(0.85, 0.03, 0.002);
  vec3 c2 = vec3(2.10, 0.26, 0.012);
  vec3 c3 = vec3(3.60, 1.35, 0.12);
  vec3 c4 = vec3(5.80, 4.40, 2.30);
  vec3 col = mix(c1, c2, smoothstep(0.08, 0.38, t));
  col = mix(col, c3, smoothstep(0.38, 0.72, t));
  col = mix(col, c4, smoothstep(0.72, 1.12, t));
  return col * smoothstep(0.08, 0.26, t);
}

bool intersectBillboard(vec3 ro, vec3 rd, vec3 centerW, vec2 halfSize, bool upright, out vec2 uvB, out float tHit) {
  vec3 bFwd = normalize(uCamPos - centerW);
  vec3 bRight = normalize(cross(vec3(0.0, 1.0, 0.0), bFwd));
  vec3 bUp = upright ? vec3(0.0, 1.0, 0.0) : normalize(cross(bFwd, bRight));
  float denom = dot(rd, bFwd);
  if (abs(denom) < 1e-4) return false;
  float t = dot(centerW - ro, bFwd) / denom;
  if (t <= 0.1) return false;
  vec3 hitP = ro + rd * t - centerW;
  float lx = dot(hitP, bRight) / halfSize.x;
  float ly = dot(hitP, bUp) / halfSize.y;
  if (abs(lx) > 1.0 || abs(ly) > 1.0) return false;
  uvB = vec2(lx * 0.5 + 0.5, ly * 0.5 + 0.5);
  tHit = t;
  return true;
}

vec2 intersectBox(vec3 ro, vec3 rd, vec3 bMin, vec3 bMax) {
  vec3 invD = 1.0 / rd;
  vec3 t0 = (bMin - ro) * invD, t1 = (bMax - ro) * invD;
  vec3 tmin = min(t0, t1), tmax = max(t0, t1);
  return vec2(max(max(tmin.x, tmin.y), tmin.z), min(min(tmax.x, tmax.y), tmax.z));
}

void sampleFlipCell(int fIdx, vec2 uv, vec2 flowOff, out vec4 a, out vec4 b, out vec4 c) {
  int fi = ((fIdx % 32) + 32) % 32;
  int col = fi % 8, row = fi / 8;
  vec2 cuv = clamp(uv + flowOff, vec2(0.02), vec2(0.98));
  vec2 atlasUv = (vec2(float(col), float(row)) + cuv) / vec2(8.0, 4.0);
  a = texture(uTexFlipA, atlasUv);
  b = texture(uTexFlipB, atlasUv);
  c = texture(uTexFlipC, atlasUv);
}

vec2 evalProceduralVolume(vec3 p, float t) {
  vec3 q = p - vec3(0.0, 0.14, 0.0);
  float h = clamp(q.y / 2.22, 0.0, 1.0);
  if (q.y < -0.04 || q.y > 2.34) return vec2(0.0);

  float ang = t * 0.185, rise = t * 2.35;
  vec3 warpP = q * vec3(2.4, 1.75, 2.4) - vec3(0.0, rise, 0.0) + vec3(cos(ang), 0.0, sin(ang)) * 0.40;
  float n1 = fbm3(warpP);
  float n2 = fbm3(q * vec3(4.8, 3.2, 4.8) - vec3(0.0, rise * 1.75, 0.0) + vec3(n1 * 1.6, -n1 * 1.1, n1 * 1.3));
  float curlDetail = pow(1.0 - abs(n2 * 2.0 - 1.0), 1.35);

  vec2 xz = q.xz - vec2(n1 - 0.5, n2 - 0.5) * (0.18 + 0.62 * h);
  float r = length(xz);

  float flameRad = mix(0.50, 0.06, pow(h, 0.72)) * (0.55 + 0.90 * curlDetail);
  float flameMask = smoothstep(flameRad, flameRad * 0.14, r) * smoothstep(0.0, 0.10, h) * smoothstep(0.68, 0.16, h);
  float temp = clamp(flameMask * (0.45 + 1.15 * curlDetail) * (1.25 - 0.78 * h), 0.0, 1.25);

  float smokeRad = mix(0.38, 0.86, pow(h, 0.62)) * (0.68 + 0.62 * n1);
  float smokeMask = smoothstep(smokeRad, smokeRad * 0.22, r) * smoothstep(0.22, 0.46, h) * smoothstep(0.98, 0.68, h);
  float billow = smoothstep(0.28, 0.74, n1 * 0.58 + curlDetail * 0.52);
  return vec2(temp, clamp(smokeMask * billow * 1.65, 0.0, 1.35));
}

vec2 evalLiveFluidVolume(vec3 p, float t) {
  vec3 bMin = vec3(-1.15, 0.08, -1.15), bMax = vec3(1.15, 2.48, 1.15);
  vec3 uvw = (p - bMin) / (bMax - bMin);
  if (any(lessThan(uvw, vec3(0.02))) || any(greaterThan(uvw, vec3(0.98)))) return vec2(0.0);
  float boxFeather = smoothstep(0.02, 0.12, min(uvw.x, 1.0 - uvw.x))
                   * smoothstep(0.02, 0.12, min(uvw.z, 1.0 - uvw.z))
                   * smoothstep(0.98, 0.82, uvw.y);
  vec4 s = texture(uTexFluid3D, uvw);
  float hf = fbm3(p * 5.2 - vec3(0.0, t * 2.9, 0.0));
  float ridge = pow(1.0 - abs(hf * 2.0 - 1.0), 1.3);
  return vec2(
    clamp(s.r * (0.62 + 0.75 * ridge) * 1.15 * boxFeather, 0.0, 1.25),
    clamp(s.g * (0.58 + 0.82 * hf) * 1.55 * boxFeather, 0.0, 1.35)
  );
}

vec2 sampleVolField(vec3 p, int stage) {
  return (stage == 7) ? evalLiveFluidVolume(p, uTime) : evalProceduralVolume(p, uTime);
}

vec4 renderVolumetric(vec3 ro, vec3 rd, float sceneDepth, int stage) {
  vec3 bMin = vec3(-1.15, 0.08, -1.15), bMax = vec3(1.15, 2.48, 1.15);
  vec2 hit = intersectBox(ro, rd, bMin, bMax);
  if (hit.x >= hit.y || hit.y < 0.0) return vec4(0.0);

  float tStart = max(0.05, hit.x), tEnd = min(hit.y, sceneDepth);
  if (tStart >= tEnd) return vec4(0.0);

  const int STEPS = 44;
  float dt = (tEnd - tStart) / float(STEPS);
  float jitter = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
  float t = tStart + jitter * dt;

  vec3 accum = vec3(0.0);
  float transmittance = 1.0, brickWire = 0.0;
  bool useShadow = (stage >= 6);
  vec3 moonDir = normalize(vec3(-0.62, 0.76, 0.45));
  vec3 coreCenter = vec3(0.0, 0.52, 0.0);

  for (int i = 0; i < STEPS; i++) {
    vec3 p = ro + rd * t;
    vec2 ts = sampleVolField(p, stage);
    float temp = ts.x, smoke = ts.y;

    if (stage == 6 && uSparseGridFlash > 0.01 && (temp > 0.09 || smoke > 0.11)) {
      vec3 gCell = fract((p - bMin) / 0.38);
      vec3 edge = min(gCell, 1.0 - gCell);
      float secondE = max(min(edge.x, edge.y), min(max(edge.x, edge.y), edge.z));
      if (secondE < 0.036) brickWire = max(brickWire, smoothstep(0.036, 0.008, secondE) * transmittance);
    }

    float sigma = smoke * 3.45 + temp * 0.75;
    if (sigma > 0.015) {
      vec3 emit = blackbodyHDR(temp) * 2.25;
      vec3 smokeLight;
      if (useShadow && smoke > 0.03) {
        float optCore = 0.0;
        vec3 toCore = normalize(coreCenter - p);
        float dCore = length(coreCenter - p);
        for (int s = 1; s <= 4; s++) {
          optCore += sampleVolField(p + toCore * (float(s) * min(0.24, dCore * 0.24)), stage).y * 0.85;
        }
        float coreShadow = exp(-optCore * 2.6) / (0.35 + 1.15 * dCore * dCore);
        float optMoon = 0.0;
        for (int s = 1; s <= 3; s++) optMoon += sampleVolField(p + moonDir * (float(s) * 0.26), stage).y * 0.95;
        float moonShadow = exp(-optMoon * 3.2);
        smokeLight = (vec3(0.18, 0.24, 0.42) * (0.06 + 0.94 * moonShadow) + vec3(3.10, 0.82, 0.12) * coreShadow * 1.45) * vec3(0.24, 0.23, 0.26);
      } else {
        smokeLight = mix(vec3(0.32, 0.22, 0.16), vec3(0.24, 0.27, 0.35), smoothstep(0.35, 1.85, p.y));
      }
      vec3 stepRad = emit + smokeLight * smoke * 3.1;
      float stepTrans = exp(-sigma * dt);
      accum += transmittance * stepRad * (1.0 - stepTrans) / max(sigma, 0.001);
      transmittance *= stepTrans;
      if (transmittance < 0.015) break;
    }
    t += dt;
  }

  if (brickWire > 0.001 && uSparseGridFlash > 0.01) {
    accum += vec3(1.8, 1.15, 0.25) * brickWire * uSparseGridFlash * 0.95;
  }
  return vec4(accum, 1.0 - transmittance);
}

void evalStage(int stage, bool isLeft, vec2 uv, vec3 ro, vec3 rd, out vec3 colOut, out vec3 bloomOut) {
  vec3 sceneCol = texture(uTexScene, uv).rgb;
  vec4 dp = texture(uTexDepth, uv);
  float sceneDepth = (dp.r + dp.g / 255.0) * 32.0;
  colOut = sceneCol;
  bloomOut = vec3(0.0);

  if (stage == 0) {
    vec2 bUv; float bT;
    if (intersectBillboard(ro, rd, vec3(0.0, 0.96, 0.0), vec2(0.76, 1.02), true, bUv, bT) && bT < sceneDepth + 0.18) {
      vec2 qUv = (floor(bUv * vec2(64.0, 80.0)) + 0.5) / vec2(64.0, 80.0);
      float packed = texture(uTexPalIdx, qUv).r * 255.0;
      int rawBand = int(mod(packed, 16.0));
      int env = int(floor(packed / 16.0));
      if (rawBand > 0) {
        if (isLeft && uClutIndexOnly > 0.5) {
          float g = (float(rawBand) / 15.0) * 0.72 + 0.08;
          colOut = vec3(g * 0.85, g * 0.92, g);
        } else {
          int shift = int(floor(uTime * 14.0));
          int cycled = 1 + (((rawBand - 1) - shift) % 15 + 15) % 15;
          int finalIdx = clamp(int(round(float(cycled) * (0.45 + 0.55 * float(env) / 15.0))), 1, 15);
          colOut = pow(uClut16[finalIdx], vec3(2.1)) * 1.15;
        }
      }
    }
    return;
  }

  if (stage == 1) {
    vec2 bUv; float bT;
    if (intersectBillboard(ro, rd, vec3(0.0, 1.02, 0.0), vec2(0.90, 1.12), true, bUv, bT) && bT < sceneDepth + 0.22) {
      vec2 qUv = (floor(bUv * vec2(96.0, 112.0)) + 0.5) / vec2(96.0, 112.0);
      int heatIdx = clamp(int(round(texture(uTexDoom, qUv).r * 255.0)), 0, 36);
      if (heatIdx > 2) {
        vec3 doomCol = pow(uDoomPal[heatIdx], vec3(2.1)) * 1.25;
        colOut = mix(sceneCol, doomCol, smoothstep(2.0, 8.0, float(heatIdx)));
      }
    }
    return;
  }

  if (stage == 2) {
    vec2 bUv; float bT;
    if (intersectBillboard(ro, rd, vec3(0.0, 0.88, 0.0), vec2(0.86, 1.10), false, bUv, bT)) {
      if (bT < sceneDepth) {
        int frame = int(floor(uTime * 11.0)) % 8;
        vec4 sp = texture(uTexSprite, vec2((float(frame) + bUv.x) / 8.0, bUv.y));
        colOut = min(sceneCol + pow(sp.rgb, vec3(2.1)) * 1.05 * sp.a, vec3(1.15, 1.05, 0.65));
      }
      if (uQuadWire > 0.01) {
        float border = min(min(bUv.x, 1.0 - bUv.x), min(bUv.y, 1.0 - bUv.y));
        if (border < 0.014) {
          colOut = mix(colOut, (bT < sceneDepth) ? vec3(0.0, 1.25, 0.92) : vec3(1.60, 0.14, 0.16), uQuadWire * 0.92);
        }
      }
    }
    return;
  }

  if (stage == 3) {
    vec2 bUv; float bT;
    if (intersectBillboard(ro, rd, vec3(0.0, 1.32, 0.0), vec2(1.02, 1.40), true, bUv, bT) && bT < sceneDepth + 0.6) {
      float mask = smoothstep(0.50, 0.12, abs(bUv.x - 0.5)) * smoothstep(0.0, 0.22, bUv.y) * smoothstep(1.0, 0.42, bUv.y);
      float w1 = sin(bUv.y * 28.0 - uTime * 12.0 + sin(bUv.x * 16.0) * 1.8);
      float w2 = cos(bUv.y * 42.0 - uTime * 17.5 + bUv.x * 22.0);
      sceneCol = texture(uTexScene, clamp(uv + vec2(w1 * 0.0095, w2 * 0.0045) * mask, vec2(0.002), vec2(0.998))).rgb;
    }
    colOut = sceneCol;
    if (intersectBillboard(ro, rd, vec3(0.0, 0.94, 0.0), vec2(0.86, 1.12), true, bUv, bT)) {
      float softFade = smoothstep(-0.18, 0.44, sceneDepth - bT);
      if (softFade > 0.001) {
        vec2 p = bUv * 2.0 - 1.0;
        float n1 = fbm3(vec3(bUv * vec2(3.8, 3.2) - vec2(0.0, uTime * 2.4), uTime * 0.35));
        float n2 = fbm3(vec3(bUv * vec2(7.0, 5.5) - vec2(0.0, uTime * 3.8), uTime * 0.55));
        float distX = abs(p.x + (n1 - 0.5) * 0.65 * bUv.y) / mix(0.64, 0.10, pow(bUv.y, 0.75));
        float shape = smoothstep(1.0, 0.15, distX) * smoothstep(0.0, 0.14, bUv.y) * smoothstep(1.0, 0.18, bUv.y);
        float flame = clamp(shape * (0.55 + 1.1 * n2), 0.0, 1.0);
        vec3 ldrFire = mix(vec3(0.85, 0.12, 0.01), mix(vec3(1.1, 0.45, 0.04), vec3(1.15, 0.95, 0.50), smoothstep(0.45, 0.85, flame)), smoothstep(0.12, 0.55, flame));
        colOut = min(sceneCol + ldrFire * flame * softFade * 1.15, vec3(1.15, 1.0, 0.62));
      }
    }
    return;
  }

  if (stage == 4) {
    vec2 bUv; float bT;
    if (intersectBillboard(ro, rd, vec3(0.0, 1.42, 0.0), vec2(0.95, 1.25), true, bUv, bT) && bT < sceneDepth + 0.5) {
      float hm = smoothstep(0.48, 0.15, abs(bUv.x - 0.5)) * smoothstep(0.0, 0.25, bUv.y) * smoothstep(1.0, 0.52, bUv.y);
      sceneCol = texture(uTexScene, clamp(uv + vec2(sin(bUv.y * 30.0 - uTime * 13.0) * 0.005, 0.0) * hm, vec2(0.002), vec2(0.998))).rgb;
    }
    colOut = sceneCol;
    if (intersectBillboard(ro, rd, vec3(0.0, 1.24, 0.0), vec2(1.04, 1.24), true, bUv, bT)) {
      float softFade = smoothstep(-0.22, 0.45, sceneDepth - bT);
      float quadFeather = smoothstep(0.0, 0.14, min(bUv.x, 1.0 - bUv.x)) * smoothstep(1.0, 0.78, bUv.y) * smoothstep(0.0, 0.08, bUv.y);
      float mask = softFade * quadFeather;
      if (mask > 0.001) {
        float fCont = mod(uTime * 15.0, 32.0);
        int f0 = int(floor(fCont)), f1 = (f0 + 1) % 32;
        float blend = fract(fCont);
        vec4 a0, b0, c0, a1, b1, c1;
        sampleFlipCell(f0, bUv, vec2(0.0), a0, b0, c0);
        sampleFlipCell(f1, bUv, vec2(0.0), a1, b1, c1);
        vec2 flow0 = (a0.zw - 0.5) * 0.045, flow1 = (a1.zw - 0.5) * 0.045;
        sampleFlipCell(f0, bUv, -flow0 * blend, a0, b0, c0);
        sampleFlipCell(f1, bUv,  flow1 * (1.0 - blend), a1, b1, c1);
        vec4 a = mix(a0, a1, blend), b = mix(b0, b1, blend), c = mix(c0, c1, blend);
        float smoke = clamp(a.g * 1.45 * mask, 0.0, 0.94);
        float moon6 = b.g * 0.45 + b.b * 0.55 + c.r * 0.25;
        float fire6 = b.a * 0.72 + c.b * 0.95;
        vec3 litSmoke = (vec3(0.18, 0.24, 0.42) * (0.12 + 0.88 * moon6) + vec3(2.65, 0.78, 0.14) * fire6) * 0.28;
        vec3 emitHDR = blackbodyHDR(a.r * 1.12) * 0.92 * mask;
        colOut = mix(sceneCol, litSmoke, smoke) + emitHDR;
        bloomOut = max(vec3(0.0), emitHDR - vec3(0.85));
      }
    }
    return;
  }

  {
    vec2 bUv; float bT;
    if (intersectBillboard(ro, rd, vec3(0.0, 1.48, 0.0), vec2(1.0, 1.25), true, bUv, bT) && bT < sceneDepth + 0.5) {
      float hm = smoothstep(0.48, 0.15, abs(bUv.x - 0.5)) * smoothstep(0.0, 0.25, bUv.y) * smoothstep(1.0, 0.55, bUv.y);
      sceneCol = texture(uTexScene, clamp(uv + vec2(sin(bUv.y * 30.0 - uTime * 13.0) * 0.0045, 0.0) * hm, vec2(0.002), vec2(0.998))).rgb;
    }
  }
  vec4 vol = renderVolumetric(ro, rd, sceneDepth, stage);
  colOut = sceneCol * (1.0 - vol.a) + vol.rgb;
  bloomOut = max(vec3(0.0), vol.rgb - vec3(0.85));
}

void main() {
  vec2 ndc = vUv * 2.0 - 1.0;
  vec3 ro = uCamPos;
  vec3 rd = normalize(uCamFwd + ndc.x * uAspect * uTanHalfFov * uCamRight + ndc.y * uTanHalfFov * uCamUp);

  vec3 c, bl;
  if (uWipeX <= 0.001) evalStage(uStageRight, false, vUv, ro, rd, c, bl);
  else if (uWipeX >= 0.999) evalStage(uStageLeft, true, vUv, ro, rd, c, bl);
  else if (vUv.x < uWipeX) evalStage(uStageLeft, true, vUv, ro, rd, c, bl);
  else evalStage(uStageRight, false, vUv, ro, rd, c, bl);
  outHdr = vec4(c, 1.0);
  outBloom = vec4(bl, 1.0);
}
`;

const BLUR_FS = `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uTex;
uniform vec2 uDir;
out vec4 fragColor;
void main() {
  const float w[5] = float[5](0.227027, 0.1945946, 0.1216216, 0.054054, 0.016216);
  vec3 sum = texture(uTex, vUv).rgb * w[0];
  for (int i = 1; i < 5; i++) {
    vec2 off = uDir * float(i) * 1.5;
    sum += (texture(uTex, vUv + off).rgb + texture(uTex, vUv - off).rgb) * w[i];
  }
  fragColor = vec4(sum, 1.0);
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
out vec4 fragColor;

vec3 aces(vec3 x) {
  return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0);
}

void main() {
  vec3 hdr = texture(uTexHdr, vUv).rgb;
  int st = (uWipeX <= 0.001) ? uStageRight : ((uWipeX >= 0.999) ? uStageLeft : (vUv.x < uWipeX ? uStageLeft : uStageRight));
  vec3 bloom = (st >= 4) ? texture(uTexBloom, vUv).rgb * 0.34 : vec3(0.0);
  fragColor = vec4(pow(aces((hdr + bloom) * 1.18), vec3(1.0 / 2.15)), 1.0);
}
`;

export function createFireEffect(gl) {
  const fmt = hdrFormat(gl);
  const progScene = linkProgram(gl, FULL_VS, SCENE_FS);
  const progFire = linkProgram(gl, FULL_VS, FIRE_FS);
  const progBlur = linkProgram(gl, FULL_VS, BLUR_FS);
  const progFinal = linkProgram(gl, FULL_VS, FINAL_FS);
  const vaoFull = gl.createVertexArray();

  // Live PSX Doom fire automaton state
  const doomRand = mulberry32(19951116);
  const doomBuf = new Uint8Array(DOOM_W * DOOM_H);
  function stepDoom() {
    for (let x = 0; x < DOOM_W; x++) {
      const r = Math.abs((x / (DOOM_W - 1)) * 2.0 - 1.0);
      if (r < 0.56) {
        const edgeCool = r > 0.38 ? Math.floor(((r - 0.38) / 0.18) * 14) : 0;
        doomBuf[x] = clamp(36 - edgeCool - Math.floor(doomRand() * 3), 0, 36);
        doomBuf[DOOM_W + x] = clamp(36 - edgeCool - Math.floor(doomRand() * 4), 0, 36);
      } else {
        doomBuf[x] = 0;
        doomBuf[DOOM_W + x] = 0;
      }
    }
    for (let y = 1; y < DOOM_H; y++) {
      for (let x = 0; x < DOOM_W; x++) {
        const srcVal = doomBuf[(y - 1) * DOOM_W + x];
        if (srcVal === 0) {
          doomBuf[y * DOOM_W + x] = 0;
        } else {
          const r = Math.floor(doomRand() * 4);
          const nx = (x / (DOOM_W - 1)) * 2.0 - 1.0;
          const inward = (nx > 0.22 ? -1 : (nx < -0.22 ? 1 : 0)) * (doomRand() < 0.28 ? 1 : 0);
          const dstX = clamp(x + (r - 1) + inward, 0, DOOM_W - 1);
          const decay = (r & 1) * (doomRand() < 0.62 ? 1 : 0) + (doomRand() < 0.16 ? 1 : 0) + (Math.abs(nx) > 0.44 ? 1 : 0);
          doomBuf[y * DOOM_W + dstX] = Math.max(0, srcVal - decay);
        }
      }
    }
  }
  for (let i = 0; i < 120; i++) stepDoom();

  // Live 24x36x24 3D Navier-Stokes + Vorticity Confinement fluid solver
  let u = new Float32Array(NV), v = new Float32Array(NV), w = new Float32Array(NV);
  let u2 = new Float32Array(NV), v2 = new Float32Array(NV), w2 = new Float32Array(NV);
  let temp = new Float32Array(NV), temp2 = new Float32Array(NV);
  let smoke = new Float32Array(NV), smoke2 = new Float32Array(NV);
  let fuel = new Float32Array(NV), fuel2 = new Float32Array(NV);
  const div = new Float32Array(NV);
  let prs = new Float32Array(NV), prs2 = new Float32Array(NV);
  const ox = new Float32Array(NV), oy = new Float32Array(NV), oz = new Float32Array(NV), omag = new Float32Array(NV);
  const solid = new Uint8Array(NV);
  const fluidTexBuf = new Uint8Array(NV * 4);
  const IX = (x, y, z) => (z * NY + y) * NX + x;

  function sampleTri(arr, x, y, z) {
    const cx = clamp(x, 0.5, NX - 1.501), cy = clamp(y, 0.5, NY - 1.501), cz = clamp(z, 0.5, NZ - 1.501);
    const x0 = cx | 0, y0 = cy | 0, z0 = cz | 0;
    const fx = cx - x0, fy = cy - y0, fz = cz - z0;
    const i000 = IX(x0, y0, z0), sXY = NX * NY;
    const c00 = arr[i000] + (arr[i000 + 1] - arr[i000]) * fx;
    const c10 = arr[i000 + NX] + (arr[i000 + NX + 1] - arr[i000 + NX]) * fx;
    const c01 = arr[i000 + sXY] + (arr[i000 + sXY + 1] - arr[i000 + sXY]) * fx;
    const c11 = arr[i000 + sXY + NX] + (arr[i000 + sXY + NX + 1] - arr[i000 + sXY + NX]) * fx;
    return (c00 + (c10 - c00) * fy) * (1 - fz) + (c01 + (c11 - c01) * fy) * fz;
  }

  const sRand = mulberry32(20261119);
  const simDt = 1.0 / 30.0;
  let simStepCount = 0;
  let prevColPos = [9.0, 1.05, 0.0];

  function stepFluid(colPos) {
    const validPrev = Math.abs(colPos[0] - prevColPos[0]) < 1.5;
    const colVx = validPrev ? (colPos[0] - prevColPos[0]) / simDt : 0;
    const colVy = validPrev ? (colPos[1] - prevColPos[1]) / simDt : 0;
    const colVz = validPrev ? (colPos[2] - prevColPos[2]) / simDt : 0;
    prevColPos = colPos.slice();

    const sx = (VOL_MAX[0] - VOL_MIN[0]) / NX;
    const sy = (VOL_MAX[1] - VOL_MIN[1]) / NY;
    const sz = (VOL_MAX[2] - VOL_MIN[2]) / NZ;
    const swirlPh = (simStepCount++) * 0.30;

    solid.fill(0);
    for (let z = 1; z < NZ - 1; z++) {
      const wz = VOL_MIN[2] + (z + 0.5) * sz;
      for (let y = 1; y < NY - 1; y++) {
        const wy = VOL_MIN[1] + (y + 0.5) * sy;
        for (let x = 1; x < NX - 1; x++) {
          const wx = VOL_MIN[0] + (x + 0.5) * sx;
          const i = IX(x, y, z);
          const dxC = wx - colPos[0], dyC = wy - colPos[1], dzC = wz - colPos[2];
          const dC = Math.hypot(dxC, dyC, dzC);
          if (dC < COLLIDER_RADIUS * 1.15) {
            solid[i] = 1;
            const invD = 1.0 / Math.max(0.05, dC);
            u[i] = colVx * 3.4 + dxC * invD * 2.6;
            v[i] = colVy * 3.4 + dyC * invD * 2.6;
            w[i] = colVz * 3.4 + dzC * invD * 2.6;
            fuel[i] *= 0.15; temp[i] *= 0.25; smoke[i] *= 0.35;
            continue;
          }
          if (wy < 0.50) {
            const rad = Math.hypot(wx, wz);
            if (rad < 0.44) {
              const mask = (1.0 - rad / 0.44) * (1.0 - (wy - 0.08) / 0.44);
              const turb = 0.65 + 0.65 * Math.sin(wx * 8.0 + swirlPh) * Math.cos(wz * 8.0 - swirlPh * 1.3) + (sRand() - 0.5) * 0.55;
              fuel[i] = Math.min(1.6, fuel[i] + mask * 1.65 * Math.max(0.15, turb));
              temp[i] = Math.min(2.1, temp[i] + mask * 1.60 * Math.max(0.25, turb));
              v[i] += mask * 4.5;
              u[i] += (Math.cos(swirlPh * 1.2 + wz * 4.5) * 1.3 + (sRand() - 0.5) * 1.8) * mask;
              w[i] += (Math.sin(swirlPh * 0.9 + wx * 4.5) * 1.3 + (sRand() - 0.5) * 1.8) * mask;
            }
          }
          if (fuel[i] > 0.02) {
            const burn = Math.min(fuel[i], 0.58 * simDt * (0.6 + temp[i]));
            fuel[i] -= burn;
            temp[i] = Math.min(2.3, temp[i] + burn * 2.8);
            smoke[i] = Math.min(1.8, smoke[i] + burn * 2.25);
          }
          v[i] += (temp[i] * 7.2 - smoke[i] * 0.45) * simDt;
          u[i] += 0.35 * Math.sin(swirlPh * 0.45 + wy * 1.5) * simDt;
        }
      }
    }

    for (let z = 1; z < NZ - 1; z++) {
      for (let y = 1; y < NY - 1; y++) {
        for (let x = 1; x < NX - 1; x++) {
          const i = IX(x, y, z);
          const cx = (w[i + NX] - w[i - NX]) * 0.5 - (v[i + NX * NY] - v[i - NX * NY]) * 0.5;
          const cy = (u[i + NX * NY] - u[i - NX * NY]) * 0.5 - (w[i + 1] - w[i - 1]) * 0.5;
          const cz = (v[i + 1] - v[i - 1]) * 0.5 - (u[i + NX] - u[i - NX]) * 0.5;
          ox[i] = cx; oy[i] = cy; oz[i] = cz; omag[i] = Math.hypot(cx, cy, cz);
        }
      }
    }
    const vortEps = 3.1 * simDt;
    for (let z = 2; z < NZ - 2; z++) {
      for (let y = 2; y < NY - 2; y++) {
        for (let x = 2; x < NX - 2; x++) {
          const i = IX(x, y, z);
          if (solid[i]) continue;
          const gx = (omag[i + 1] - omag[i - 1]) * 0.5;
          const gy = (omag[i + NX] - omag[i - NX]) * 0.5;
          const gz = (omag[i + NX * NY] - omag[i - NX * NY]) * 0.5;
          const gl = Math.hypot(gx, gy, gz) + 1e-5;
          u[i] += ((gy / gl) * oz[i] - (gz / gl) * oy[i]) * vortEps;
          v[i] += ((gz / gl) * ox[i] - (gx / gl) * oz[i]) * vortEps;
          w[i] += ((gx / gl) * oy[i] - (gy / gl) * ox[i]) * vortEps;
        }
      }
    }

    div.fill(0); prs.fill(0);
    for (let z = 1; z < NZ - 1; z++) {
      for (let y = 1; y < NY - 1; y++) {
        for (let x = 1; x < NX - 1; x++) {
          const i = IX(x, y, z);
          if (!solid[i]) div[i] = -0.5 * ((u[i + 1] - u[i - 1]) + (v[i + NX] - v[i - NX]) + (w[i + NX * NY] - w[i - NX * NY]));
        }
      }
    }
    for (let it = 0; it < 7; it++) {
      for (let z = 1; z < NZ - 1; z++) {
        for (let y = 1; y < NY - 1; y++) {
          for (let x = 1; x < NX - 1; x++) {
            const i = IX(x, y, z);
            prs2[i] = solid[i] ? 0 : (div[i] + prs[i - 1] + prs[i + 1] + prs[i - NX] + prs[i + NX] + prs[i - NX * NY] + prs[i + NX * NY]) / 6.0;
          }
        }
      }
      const tmp = prs; prs = prs2; prs2 = tmp;
    }
    for (let z = 1; z < NZ - 1; z++) {
      for (let y = 1; y < NY - 1; y++) {
        for (let x = 1; x < NX - 1; x++) {
          const i = IX(x, y, z);
          if (solid[i]) continue;
          u[i] -= 0.5 * (prs[i + 1] - prs[i - 1]);
          v[i] -= 0.5 * (prs[i + NX] - prs[i - NX]);
          w[i] -= 0.5 * (prs[i + NX * NY] - prs[i - NX * NY]);
        }
      }
    }

    const advScale = simDt * 6.4;
    for (let z = 1; z < NZ - 1; z++) {
      for (let y = 1; y < NY - 1; y++) {
        for (let x = 1; x < NX - 1; x++) {
          const i = IX(x, y, z);
          if (solid[i]) { u2[i] = u[i]; v2[i] = v[i]; w2[i] = w[i]; temp2[i] = 0; smoke2[i] = 0; fuel2[i] = 0; continue; }
          const bx = x - u[i] * advScale, by = y - v[i] * advScale, bz = z - w[i] * advScale;
          u2[i] = sampleTri(u, bx, by, bz) * 0.96;
          v2[i] = sampleTri(v, bx, by, bz) * 0.96;
          w2[i] = sampleTri(w, bx, by, bz) * 0.96;
          const tVal = sampleTri(temp, bx, by, bz);
          const cool = 1.0 - simDt * (1.85 + 1.45 * tVal * tVal + (y / NY) * 2.2);
          temp2[i] = Math.max(0, tVal * Math.max(0.18, cool));
          smoke2[i] = sampleTri(smoke, bx, by, bz) * (y > NY - 6 ? 0.80 : 0.978);
          fuel2[i] = sampleTri(fuel, bx, by, bz) * 0.90;
        }
      }
    }
    let sw;
    sw = u; u = u2; u2 = sw; sw = v; v = v2; v2 = sw; sw = w; w = w2; w2 = sw;
    sw = temp; temp = temp2; temp2 = sw; sw = smoke; smoke = smoke2; smoke2 = sw; sw = fuel; fuel = fuel2; fuel2 = sw;
  }

  function packFluidTex() {
    for (let i = 0; i < NV; i++) {
      fluidTexBuf[i * 4 + 0] = Math.round(clamp(temp[i] / 1.85, 0, 1) * 255);
      fluidTexBuf[i * 4 + 1] = Math.round(clamp(smoke[i] / 1.15, 0, 1) * 255);
      fluidTexBuf[i * 4 + 2] = Math.round(clamp(Math.hypot(u[i], v[i], w[i]) / 8.0, 0, 1) * 255);
      fluidTexBuf[i * 4 + 3] = 255;
    }
  }

  // Warmup + bake 32-frame 6-way directional lit flipbook
  for (let i = 0; i < 36; i++) stepFluid([9.0, 1.05, 0.0]);
  const flipDataA = new Uint8Array(FLIP_W * FLIP_H * 4);
  const flipDataB = new Uint8Array(FLIP_W * FLIP_H * 4);
  const flipDataC = new Uint8Array(FLIP_W * FLIP_H * 4);
  for (let f = 0; f < FLIP_N; f++) {
    stepFluid([9.0, 1.05, 0.0]);
    const col = f % FLIP_COLS, row = (f / FLIP_COLS) | 0;
    for (let cy = 0; cy < FLIP_CH; cy++) {
      const gy = (cy / (FLIP_CH - 1)) * (NY - 1);
      for (let cx = 0; cx < FLIP_CW; cx++) {
        const gx = (cx / (FLIP_CW - 1)) * (NX - 1);
        let maxTemp = 0, accSmoke = 0, velX = 0, velY = 0, wSum = 0.001;
        let litPX = 0, litNX = 0, litPY = 0, litNY = 0, litPZ = 0, litNZ = 0, coreScat = 0, trans = 1.0;
        for (let zi = 2; zi < NZ - 2; zi++) {
          const tS = sampleTri(temp, gx, gy, zi), dS = sampleTri(smoke, gx, gy, zi);
          const dens = dS * 0.36 + tS * 0.14;
          if (dens > 0.01) {
            if (tS > maxTemp) maxTemp = tS;
            const wt = trans * dens;
            velX += sampleTri(u, gx, gy, zi) * wt; velY += sampleTri(v, gx, gy, zi) * wt; wSum += wt;
            litPX += wt * Math.exp(-(sampleTri(smoke, gx + 2.5, gy, zi) + sampleTri(smoke, gx + 5.0, gy, zi)) * 1.45);
            litNX += wt * Math.exp(-(sampleTri(smoke, gx - 2.5, gy, zi) + sampleTri(smoke, gx - 5.0, gy, zi)) * 1.45);
            litPY += wt * Math.exp(-(sampleTri(smoke, gx, gy + 2.5, zi) + sampleTri(smoke, gx, gy + 5.0, zi)) * 1.45);
            litNY += wt * Math.exp(-(sampleTri(smoke, gx, gy - 2.5, zi) + sampleTri(smoke, gx, gy - 5.0, zi)) * 1.45);
            litPZ += wt * Math.exp(-(sampleTri(smoke, gx, gy, zi + 2.5) + sampleTri(smoke, gx, gy, zi + 5.0)) * 1.45);
            litNZ += wt * Math.exp(-(sampleTri(smoke, gx, gy, zi - 2.5) + sampleTri(smoke, gx, gy, zi - 5.0)) * 1.45);
            coreScat += wt * clamp(sampleTri(temp, gx, Math.max(1, gy - 3.5), zi) * 1.3, 0, 1);
            trans *= Math.exp(-dens * 0.78);
            accSmoke = 1.0 - trans;
          }
        }
        const o = ((row * FLIP_CH + cy) * FLIP_W + (col * FLIP_CW + cx)) * 4;
        const normW = 1.0 / wSum;
        flipDataA[o + 0] = clamp(Math.round((maxTemp / 1.85) * 255), 0, 255);
        flipDataA[o + 1] = clamp(Math.round(accSmoke * 255), 0, 255);
        flipDataA[o + 2] = clamp(Math.round((velX * normW * 0.14 + 0.5) * 255), 0, 255);
        flipDataA[o + 3] = clamp(Math.round((velY * normW * 0.10 + 0.5) * 255), 0, 255);
        flipDataB[o + 0] = clamp(Math.round(litPX * normW * 255), 0, 255);
        flipDataB[o + 1] = clamp(Math.round(litNX * normW * 255), 0, 255);
        flipDataB[o + 2] = clamp(Math.round(litPY * normW * 255), 0, 255);
        flipDataB[o + 3] = clamp(Math.round(litNY * normW * 255), 0, 255);
        flipDataC[o + 0] = clamp(Math.round(litPZ * normW * 255), 0, 255);
        flipDataC[o + 1] = clamp(Math.round(litNZ * normW * 255), 0, 255);
        flipDataC[o + 2] = clamp(Math.round(coreScat * normW * 255), 0, 255);
        flipDataC[o + 3] = 255;
      }
    }
  }
  packFluidTex();

  const texPalIdx = makeTex2D(gl, PAL_W, PAL_H, gl.R8, gl.RED, gl.UNSIGNED_BYTE, gl.NEAREST, buildPalIdxBytes());
  const texDoom = makeTex2D(gl, DOOM_W, DOOM_H, gl.R8, gl.RED, gl.UNSIGNED_BYTE, gl.NEAREST, doomBuf);
  const texSprite = makeTex2D(gl, SPR_W * SPR_N, SPR_H, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, gl.NEAREST, buildSpriteAtlas());
  const texFlipA = makeTex2D(gl, FLIP_W, FLIP_H, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, gl.LINEAR, flipDataA);
  const texFlipB = makeTex2D(gl, FLIP_W, FLIP_H, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, gl.LINEAR, flipDataB);
  const texFlipC = makeTex2D(gl, FLIP_W, FLIP_H, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, gl.LINEAR, flipDataC);

  const texFluid3D = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_3D, texFluid3D);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  gl.texImage3D(gl.TEXTURE_3D, 0, gl.RGBA8, NX, NY, NZ, 0, gl.RGBA, gl.UNSIGNED_BYTE, fluidTexBuf);
  gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_R, gl.CLAMP_TO_EDGE);

  let bufW = 0, bufH = 0, bw = 0, bh = 0;
  let texSceneCol = null, texSceneDepth = null, fboScene = null;
  let texHdr = null, texBloomSrc = null, fboFire = null;
  let texBlurA = null, texBlurB = null, fboBlurA = null, fboBlurB = null;

  function allocTargets(w, h) {
    if (w === bufW && h === bufH) return;
    for (const t of [texSceneCol, texSceneDepth, texHdr, texBloomSrc, texBlurA, texBlurB]) if (t) gl.deleteTexture(t);
    for (const f of [fboScene, fboFire, fboBlurA, fboBlurB]) if (f) gl.deleteFramebuffer(f);
    bufW = w; bufH = h;
    bw = Math.max(64, (w >> 2)); bh = Math.max(64, (h >> 2));

    texSceneCol = makeTex2D(gl, w, h, fmt.internalFmt, fmt.fmt, fmt.type, gl.LINEAR);
    texSceneDepth = makeTex2D(gl, w, h, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, gl.NEAREST);
    fboScene = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fboScene);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texSceneCol, 0);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT1, gl.TEXTURE_2D, texSceneDepth, 0);
    gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1]);

    texHdr = makeTex2D(gl, w, h, fmt.internalFmt, fmt.fmt, fmt.type, gl.LINEAR);
    texBloomSrc = makeTex2D(gl, w, h, fmt.internalFmt, fmt.fmt, fmt.type, gl.LINEAR);
    fboFire = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fboFire);
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

  let simTime = 0, doomAcc = 0, fluidAcc = 0;
  let wireOn = false, wireBlend = 0;
  let voxelsOn = false, voxelsBlend = 0;
  let sweepT = -1.0;

  function colliderPosFor(t) {
    if (t < 0.0 || t > 3.15) return [9.0, 1.05, 0.0];
    const uS = smoothstep(0.0, 3.10, t);
    return [lerp(-1.72, 1.72, uS), 0.96 + 0.18 * Math.sin(uS * Math.PI), 0.16 * Math.sin(uS * Math.PI * 2.0)];
  }

  return {
    id: "fire",
    maxPixels: 920000,
    defaultCamera: {
      yaw: 0.22,
      pitch: 0.22,
      dist: 6.7,
      lookY: 0.80,
      fovDeg: 38,
      minDist: 3.6,
      maxDist: 12.0,
      minPitch: -0.18,
      maxPitch: 1.15,
      autoOrbitSpeed: 0.0,
    },
    enterStep(stepIdx) {
      if (stepIdx !== 2) wireOn = false;
      if (stepIdx !== 6) voxelsOn = false;
      if (stepIdx === 7) sweepT = 0.0;
    },
    triggerAction(actionId) {
      if (actionId === "wire") wireOn = !wireOn;
      else if (actionId === "voxels") voxelsOn = !voxelsOn;
      else if (actionId === "sweep") sweepT = 0.0;
    },
    isActionActive(actionId) {
      if (actionId === "wire") return wireOn;
      if (actionId === "voxels") return voxelsOn;
      if (actionId === "sweep") return sweepT >= 0.0 && sweepT <= 3.15;
      return false;
    },
    update(dt, paused, step, split) {
      wireBlend += ((wireOn ? 1 : 0) - wireBlend) * Math.min(1, dt * 8);
      voxelsBlend += ((voxelsOn ? 1 : 0) - voxelsBlend) * Math.min(1, dt * 8);
      if (paused) return;
      simTime += dt;

      const sL = split.enabled ? step.compareLeft : step.stage;
      const sR = split.enabled ? step.compareRight : step.stage;

      if (sL === 1 || sR === 1) {
        doomAcc += dt;
        let n = 0;
        while (doomAcc >= simDt && n < 2) {
          doomAcc -= simDt;
          stepDoom();
          n++;
        }
        if (n > 0) {
          gl.bindTexture(gl.TEXTURE_2D, texDoom);
          gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, DOOM_W, DOOM_H, gl.RED, gl.UNSIGNED_BYTE, doomBuf);
        }
      }

      if (sL === 7 || sR === 7) {
        if (sweepT >= 0.0) {
          sweepT += dt;
          if (sweepT > 3.35) sweepT = -1.0;
        }
        fluidAcc += dt;
        let n = 0;
        while (fluidAcc >= simDt && n < 2) {
          fluidAcc -= simDt;
          stepFluid(colliderPosFor(sweepT));
          n++;
        }
        if (n > 0) {
          packFluidTex();
          gl.bindTexture(gl.TEXTURE_3D, texFluid3D);
          gl.texSubImage3D(gl.TEXTURE_3D, 0, 0, 0, 0, NX, NY, NZ, gl.RGBA, gl.UNSIGNED_BYTE, fluidTexBuf);
        }
      }
    },
    getTechBadge(stepIdx) {
      const tags = [
        "64×80 STATIC · 16 CLUT",
        "96×112 · LIVE 30 HZ",
        "ADDITIVE QUAD · HARD CLIP",
        "DEPTH FADE + REFRACT",
        "OPTICAL FLOW · 6-WAY LIT",
        "44 STEPS · BEER–LAMBERT",
        "SPARSE GRID · SHADOW MARCH",
        "NAVIER–STOKES · 24×36×24",
      ];
      return tags[stepIdx] || "";
    },
    render(w, h, step, split, cam) {
      allocTargets(w, h);
      const aspect = w / Math.max(1, h);
      const portraitScale = aspect < 0.95 ? clamp(1.02 / Math.max(aspect, 0.54), 1.0, 1.48) : 1.0;
      const basis = cameraBasisFromOrbit(cam.yaw, cam.pitch, cam.dist * portraitScale, cam.lookY);
      const tanHalfFov = Math.tan(((cam.fovDeg * Math.PI) / 180) * 0.5);

      const stageLeft = split.enabled ? step.compareLeft : step.stage;
      const stageRight = split.enabled ? step.compareRight : step.stage;
      const wipeX = split.enabled ? split.pos : 0.0;
      const clutIndexOnly = split.enabled && step.clutSplit ? 1.0 : 0.0;

      const flicker = 0.88 + 0.12 * Math.sin(simTime * 13.7) + 0.07 * Math.cos(simTime * 29.3);
      const fireCol = [1.0, 0.44 + 0.06 * Math.sin(simTime * 17.0), 0.11];
      const giL = (clutIndexOnly > 0.5 ? 0.06 : STAGE_GI[stageLeft]) * flicker;
      const giR = STAGE_GI[stageRight] * flicker;
      const colliderActive = (stageLeft === 7 || stageRight === 7) && sweepT >= 0.0 && sweepT <= 3.15 ? 1.0 : 0.0;
      const colliderPos = colliderPosFor(sweepT);

      gl.bindVertexArray(vaoFull);
      gl.disable(gl.DEPTH_TEST);
      gl.disable(gl.BLEND);

      // Pass 1: Stone hearth courtyard + split GI
      gl.bindFramebuffer(gl.FRAMEBUFFER, fboScene);
      gl.viewport(0, 0, bufW, bufH);
      gl.useProgram(progScene);
      gl.uniform3fv(gl.getUniformLocation(progScene, "uCamPos"), basis.pos);
      gl.uniform3fv(gl.getUniformLocation(progScene, "uCamRight"), basis.right);
      gl.uniform3fv(gl.getUniformLocation(progScene, "uCamUp"), basis.up);
      gl.uniform3fv(gl.getUniformLocation(progScene, "uCamFwd"), basis.fwd);
      gl.uniform1f(gl.getUniformLocation(progScene, "uTanHalfFov"), tanHalfFov);
      gl.uniform1f(gl.getUniformLocation(progScene, "uAspect"), aspect);
      gl.uniform1f(gl.getUniformLocation(progScene, "uTime"), simTime);
      gl.uniform1f(gl.getUniformLocation(progScene, "uFireIntensityLeft"), giL);
      gl.uniform1f(gl.getUniformLocation(progScene, "uFireIntensityRight"), giR);
      gl.uniform1f(gl.getUniformLocation(progScene, "uWipeX"), wipeX);
      gl.uniform3fv(gl.getUniformLocation(progScene, "uFireColor"), fireCol);
      gl.uniform3fv(gl.getUniformLocation(progScene, "uColliderPos"), colliderPos);
      gl.uniform1f(gl.getUniformLocation(progScene, "uColliderActive"), colliderActive);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

      // Pass 2: Fire stages + bloom source
      gl.bindFramebuffer(gl.FRAMEBUFFER, fboFire);
      gl.viewport(0, 0, bufW, bufH);
      gl.useProgram(progFire);
      const texBinds = [
        ["uTexScene", texSceneCol, gl.TEXTURE_2D],
        ["uTexDepth", texSceneDepth, gl.TEXTURE_2D],
        ["uTexPalIdx", texPalIdx, gl.TEXTURE_2D],
        ["uTexDoom", texDoom, gl.TEXTURE_2D],
        ["uTexSprite", texSprite, gl.TEXTURE_2D],
        ["uTexFlipA", texFlipA, gl.TEXTURE_2D],
        ["uTexFlipB", texFlipB, gl.TEXTURE_2D],
        ["uTexFlipC", texFlipC, gl.TEXTURE_2D],
        ["uTexFluid3D", texFluid3D, gl.TEXTURE_3D],
      ];
      for (let i = 0; i < texBinds.length; i++) {
        gl.activeTexture(gl.TEXTURE0 + i);
        gl.bindTexture(texBinds[i][2], texBinds[i][1]);
        gl.uniform1i(gl.getUniformLocation(progFire, texBinds[i][0]), i);
      }
      gl.uniform3fv(gl.getUniformLocation(progFire, "uClut16"), CLUT_16_F32);
      gl.uniform3fv(gl.getUniformLocation(progFire, "uDoomPal"), DOOM_PAL_F32);
      gl.uniform3fv(gl.getUniformLocation(progFire, "uCamPos"), basis.pos);
      gl.uniform3fv(gl.getUniformLocation(progFire, "uCamRight"), basis.right);
      gl.uniform3fv(gl.getUniformLocation(progFire, "uCamUp"), basis.up);
      gl.uniform3fv(gl.getUniformLocation(progFire, "uCamFwd"), basis.fwd);
      gl.uniform1f(gl.getUniformLocation(progFire, "uTanHalfFov"), tanHalfFov);
      gl.uniform1f(gl.getUniformLocation(progFire, "uAspect"), aspect);
      gl.uniform1f(gl.getUniformLocation(progFire, "uTime"), simTime);
      gl.uniform1i(gl.getUniformLocation(progFire, "uStageLeft"), stageLeft);
      gl.uniform1i(gl.getUniformLocation(progFire, "uStageRight"), stageRight);
      gl.uniform1f(gl.getUniformLocation(progFire, "uWipeX"), wipeX);
      gl.uniform1f(gl.getUniformLocation(progFire, "uClutIndexOnly"), clutIndexOnly);
      gl.uniform1f(gl.getUniformLocation(progFire, "uQuadWire"), wireBlend);
      gl.uniform1f(gl.getUniformLocation(progFire, "uSparseGridFlash"), voxelsBlend);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

      // Pass 3: Separable Gaussian HDR Bloom
      if (stageLeft >= 4 || stageRight >= 4) {
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

      // Pass 4: Unified ACES tone map -> screen
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
