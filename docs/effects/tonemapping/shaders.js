// Evolution of Tone Mapping & HDR (2002-2024) — True RGBA16F HDR + Separable Bloom + Analytical Tone Mappers.
//   0: <2002  Raw LDR Clamp min(col, 1.0) ("Notorious 6" hue clipping & flat dead-white sky!)
//   1: 2002   Reinhard (SIGGRAPH 2002) — x / (1 + x) saves highlights but washes contrast to gray mud
//   2: 2004-5 Early HDR Bloom + Eye Adaptation (Far Cry 1.3 2004 · HL2: Lost Coast 2005)
//   3: 2010   Filmic S-Curve (John Hable / Uncharted 2 · Hejl & Burgess-Dawson, GDC 2010)
//   4: 2014-7 ACES Filmic (Krzysztof Narkowicz fit 2016 · Unreal Engine 4.15 2017 — infamous blue->purple & red->yellow hue skew!)
//   5: 2016-7 Parametric HDR Display Curves (Timothy Lottes AMD 2016 · Hajime Uchimura GT Sport 2017)
//   6: 2023   AgX (Troy Sobotka -> Blender 4.0 Nov 2023; preceded by Blender Filmic 2.79 2017) — exact analytical inset/outset + 6th-order sigmoid!
//   7: 2024   Khronos PBR Neutral (May 2024, glTF / three.js r162) & Tony McMapface (Tomasz Stachowiak 2023, Bevy 0.11)

// Pass 1: True Linear Radiance HDR Scene (writes unbounded floating-point HDR 0.0 -> 65.0+ to RGBA16F!)
export const HDR_SCENE_FS = /* glsl */`#version 300 es
precision highp float;

in vec2 vUv;
out vec4 oHdr;

uniform vec3 uCamPos, uCamRight, uCamUp, uCamFwd;
uniform float uTanHalfFov, uAspect, uTime;

const float PI = 3.14159265359;

float sdBox(vec3 p, vec3 b) {
  vec3 q = abs(p) - b;
  return length(max(q, 0.0)) + min(max(q.x, max(q.y, q.z)), 0.0);
}

float sdCapsule(vec3 p, vec3 a, vec3 b, float r) {
  vec3 pa = p - a, ba = b - a;
  float h = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0);
  return length(pa - ba * h) - r;
}

float sdCylinder(vec3 p, float r, float h) {
  vec2 d = abs(vec2(length(p.xz), p.y)) - vec2(r, h);
  return min(max(d.x, d.y), 0.0) + length(max(d, 0.0));
}

// 6 high-intensity "Notorious 6" neon light tubes arranged in a dramatic curved gallery arc!
// Pure primaries & secondaries (Red, Orange-Fire, Green, Cyan, Electric Blue, Magenta)
vec3 neonPos(int i) {
  float a = (float(i) - 2.5) * 0.40;
  return vec3(sin(a) * 3.45, 0.0, -cos(a) * 3.10 + 0.15);
}

vec3 neonHue(int i) {
  if (i == 0) return vec3(1.00, 0.015, 0.010); // Pure Red (twists yellow in Clamp/ACES!)
  if (i == 1) return vec3(1.00, 0.240, 0.008); // Blazing Fire Orange
  if (i == 2) return vec3(0.015, 1.00, 0.030); // Pure Neon Green
  if (i == 3) return vec3(0.008, 0.86, 1.000); // Pure Cyan
  if (i == 4) return vec3(0.015, 0.12, 1.000); // Electric Blue (twists purple/cyan in ACES!)
  return vec3(1.00, 0.020, 0.820);             // Hot Magenta
}

// Foreground PBR Color Checker Spheres (prove Khronos PBR Neutral 1:1 albedo accuracy!)
vec3 swatchPos(int i) {
  return vec3((float(i) - 2.0) * 0.72, 0.24, 0.45);
}

vec3 swatchAlbedo(int i) {
  if (i == 0) return vec3(0.72, 0.08, 0.07); // Matte Vermilion Red
  if (i == 1) return vec3(0.09, 0.56, 0.16); // Matte Emerald Green
  if (i == 2) return vec3(0.08, 0.22, 0.76); // Matte Cobalt Blue
  if (i == 3) return vec3(0.84, 0.68, 0.10); // Matte Ochre Yellow
  return vec3(0.78, 0.78, 0.80);             // Neutral Reference White
}

vec2 mapScene(vec3 p) {
  // Floor
  float d = p.y; float mat = 0.0;

  // Back courtyard dark archway framing the blazing HDR sunset sky!
  float archWall = sdBox(p - vec3(0.0, 2.6, -4.3), vec3(6.2, 2.6, 0.28));
  float archCut = min(
    sdBox(p - vec3(0.0, 1.6, -4.3), vec3(2.35, 1.65, 0.55)),
    length(vec2(p.x, p.y - 3.0)) - 2.35
  );
  archCut = max(archCut, abs(p.z + 4.3) - 0.55);
  float dArch = max(archWall, -archCut);
  if (dArch < d) { d = dArch; mat = 1.0; }

  // Low dark stone plinths flanking the courtyard
  float dSideL = sdBox(p - vec3(-4.5, 1.8, -1.6), vec3(0.35, 1.8, 3.0));
  float dSideR = sdBox(p - vec3( 4.5, 1.8, -1.6), vec3(0.35, 1.8, 3.0));
  float dSides = min(dSideL, dSideR);
  if (dSides < d) { d = dSides; mat = 1.0; }

  // Central dark altar pedestal holding a glowing incandescent plasma/fire orb!
  float dPed = sdCylinder(p - vec3(0.0, 0.28, -1.35), 0.58, 0.28);
  if (dPed < d) { d = dPed; mat = 2.0; }
  float flameY = 0.92 + sin(uTime * 2.2) * 0.06;
  float dFlame = length(p - vec3(0.0, flameY, -1.35)) - 0.34;
  if (dFlame < d) { d = dFlame; mat = 3.0; }

  // Central glowing neon arch ring crossing x=0 (left side Pure Red -> right side Electric Blue!)
  // -> guarantees BOTH Red & Blue Notorious-6 hue twists sit directly across the center Split-Screen divider!!
  float dArchTubeL = abs(length(vec2(p.x, p.y - 1.55)) - 1.55);
  float dRingL = length(vec2(dArchTubeL, p.z + 2.35)) - 0.085;
  if (p.y > 0.30 && p.x <= 0.0 && dRingL < d) { d = dRingL; mat = 10.0; }
  if (p.y > 0.30 && p.x >  0.0 && dRingL < d) { d = dRingL; mat = 14.0; }

  // 6 Vertical HDR Neon Light Tubes (mat 10..15) + dark metal bases
  for (int i = 0; i < 6; i++) {
    vec3 np = neonPos(i);
    float dBase = sdCylinder(p - vec3(np.x, 0.14, np.z), 0.24, 0.14);
    if (dBase < d) { d = dBase; mat = 2.0; }
    float dTube = sdCapsule(p, vec3(np.x, 0.28, np.z), vec3(np.x, 2.75, np.z), 0.115);
    if (dTube < d) { d = dTube; mat = 10.0 + float(i); }
  }

  // 5 Foreground Matte PBR Color Checker Spheres (mat 20..24) + low display rail
  float dRail = sdBox(p - vec3(0.0, 0.04, 0.45), vec3(1.85, 0.04, 0.24));
  if (dRail < d) { d = dRail; mat = 2.0; }
  for (int i = 0; i < 5; i++) {
    float ds = length(p - swatchPos(i)) - 0.18;
    if (ds < d) { d = ds; mat = 20.0 + float(i); }
  }

  return vec2(d, mat);
}

vec3 calcNormal(vec3 p) {
  vec2 e = vec2(0.0025, 0.0);
  return normalize(vec3(
    mapScene(p + e.xyy).x - mapScene(p - e.xyy).x,
    mapScene(p + e.yxy).x - mapScene(p - e.yxy).x,
    mapScene(p + e.yyx).x - mapScene(p - e.yyx).x
  ));
}

// Rich HDR sunset sky with readable golden clouds + blazing solar disc (radiance up to 48.0!)
vec3 evalHdrSky(vec3 rd) {
  vec3 sunDir = normalize(vec3(0.0, 0.25, -1.0));
  float up = clamp(rd.y, 0.0, 1.0);
  vec3 horizon = vec3(1.25, 0.42, 0.14);
  vec3 zenith  = vec3(0.03, 0.08, 0.26);
  vec3 sky = mix(horizon, zenith, pow(up, 0.45));
  // Subtle dramatic sunset cloud bands so Reinhard mud vs Filmic/AgX contrast reads clearly in the sky!
  float cld = smoothstep(0.15, 0.85, sin(rd.x * 9.0 + rd.y * 18.0) * cos(rd.x * 5.0 - rd.y * 12.0) * 0.5 + 0.5);
  sky = mix(sky, vec3(0.18, 0.09, 0.14), cld * smoothstep(0.05, 0.42, up) * 0.48);
  float sunCos = max(dot(rd, sunDir), 0.0);
  sky += vec3(2.4, 0.95, 0.26) * pow(sunCos, 12.0);
  sky += vec3(14.0, 6.2, 1.8) * pow(sunCos, 90.0);
  sky += vec3(46.0, 26.0, 10.0) * smoothstep(0.9945, 0.9988, sunCos);
  return sky;
}

vec3 shadeSurfaceHdr(vec3 p, vec3 n, vec3 rd, float matId) {
  int m = int(floor(matId + 0.5));

  // Emissive HDR Neon Tubes: vertical radiance ramp from 1.2 (base) to 38.0 (hot top core)
  // -> displays the ENTIRE highlight roll-off curve simultaneously on every single neon tube!!
  if (m >= 10 && m <= 15) {
    int idx = m - 10;
    float hNorm = clamp((p.y - 0.28) / 2.47, 0.0, 1.0);
    float ndv = clamp(dot(n, -rd), 0.0, 1.0);
    float radRamp = mix(1.0, 32.0, pow(hNorm, 1.75)) * (0.35 + 0.65 * pow(ndv, 0.75));
    return neonHue(idx) * radRamp;
  }

  // Central Glowing Incandescent Fire / Plasma Orb (radiance 4.0 -> 42.0!)
  if (m == 3) {
    float ndv = clamp(dot(n, -rd), 0.0, 1.0);
    float flick = 0.90 + 0.10 * sin(uTime * 7.0 + p.y * 8.0);
    vec3 core = mix(vec3(1.0, 0.16, 0.01), vec3(1.0, 0.62, 0.14), pow(ndv, 1.6));
    return core * mix(2.5, 42.0, pow(ndv, 2.2)) * flick;
  }

  // PBR diffuse + specular materials
  vec3 alb = vec3(0.10, 0.11, 0.14);
  float rough = 0.55;
  if (m == 0) {
    float tile = max(smoothstep(0.46, 0.495, abs(fract(p.x * 0.9) - 0.5)), smoothstep(0.46, 0.495, abs(fract(p.z * 0.9) - 0.5)));
    alb = mix(vec3(0.08, 0.09, 0.12), vec3(0.03, 0.04, 0.06), tile * 0.75);
    rough = 0.16; // glossy dark courtyard stone reflecting all 6 neon pillars!
  } else if (m == 1) {
    float brick = max(smoothstep(0.46, 0.495, abs(fract(p.x * 1.2) - 0.5)), smoothstep(0.46, 0.495, abs(fract(p.y * 1.6) - 0.5)));
    alb = mix(vec3(0.11, 0.12, 0.16), vec3(0.05, 0.06, 0.09), brick * 0.55);
    rough = 0.72;
  } else if (m == 2) {
    alb = vec3(0.06, 0.07, 0.09);
    rough = 0.35;
  } else if (m >= 20 && m <= 24) {
    alb = swatchAlbedo(m - 20);
    rough = 0.85; // calibrated matte PBR spheres
  }

  vec3 viewDir = -rd;
  vec3 hdr = alb * vec3(0.06, 0.08, 0.14) * (0.5 + 0.5 * n.y); // subtle cool ambient

  // Neutral overhead studio key light (illuminates the PBR color checker spheres evenly at ~1.0 radiance!)
  vec3 keyDir = normalize(vec3(0.25, 0.88, 0.42));
  float keyNdl = max(dot(n, keyDir), 0.0);
  hdr += alb * vec3(1.15, 1.12, 1.08) * keyNdl * 0.95;

  // Sunset backlight pouring through the back archway
  vec3 sunDir = normalize(vec3(0.0, 0.24, -1.0));
  float sunNdl = max(dot(n, sunDir), 0.0);
  hdr += alb * vec3(2.8, 1.3, 0.45) * sunNdl * 0.65;

  // Central plasma orb local radiance
  vec3 fPos = vec3(0.0, 0.92 + sin(uTime * 2.2) * 0.06, -1.35);
  vec3 toF = fPos - p;
  float dF = length(toF);
  vec3 lf = toF / max(dF, 1e-4);
  float attF = 6.5 / (0.35 + dF * dF * 1.15);
  hdr += alb * vec3(1.0, 0.34, 0.04) * (max(dot(n, lf), 0.0) * attF);
  vec3 hf = normalize(lf + viewDir);
  float specF = pow(max(dot(n, hf), 0.0), mix(12.0, 120.0, 1.0 - rough));
  hdr += vec3(1.0, 0.45, 0.08) * specF * attF * (1.0 - rough) * 0.65;

  // Dynamic HDR radiance from all 6 Notorious-6 neon tubes (diffuse bounce + glossy floor highlights!)
  for (int i = 0; i < 6; i++) {
    vec3 np = neonPos(i);
    float cy = clamp(p.y, 0.35, 2.65);
    vec3 lPos = vec3(np.x, cy, np.z);
    vec3 toL = lPos - p;
    float dist = length(toL);
    vec3 ld = toL / max(dist, 1e-4);
    float att = 4.2 / (0.28 + dist * dist * 1.15);
    vec3 nc = neonHue(i);
    hdr += alb * nc * (max(dot(n, ld), 0.0) * att);
    vec3 h = normalize(ld + viewDir);
    float spec = pow(max(dot(n, h), 0.0), mix(10.0, 140.0, 1.0 - rough));
    hdr += nc * spec * att * (1.0 - rough) * 0.95;
  }

  return hdr;
}

void main() {
  vec2 ndc = vUv * 2.0 - 1.0;
  vec3 rd = normalize(uCamFwd + uCamRight * (ndc.x * uAspect * uTanHalfFov) + uCamUp * (ndc.y * uTanHalfFov));

  float t = 0.04; vec2 hit = vec2(-1.0);
  for (int i = 0; i < 82; i++) {
    vec2 h = mapScene(uCamPos + rd * t);
    if (h.x < 0.0025) { hit = vec2(t, h.y); break; }
    t += max(h.x * 0.9, 0.004);
    if (t > 24.0) break;
  }

  vec3 hdrCol = vec3(0.0);
  if (hit.x < 0.0) {
    hdrCol = evalHdrSky(rd);
  } else {
    vec3 p = uCamPos + rd * hit.x;
    vec3 n = calcNormal(p);
    hdrCol = shadeSurfaceHdr(p, n, rd, hit.y);

    // Glossy dark floor reflection of the 6 neon tubes, fire orb & HDR sunset sky!
    if (int(floor(hit.y + 0.5)) == 0) {
      vec3 rRd = reflect(rd, n);
      vec3 rRo = p + n * 0.025;
      float rt = 0.04; vec2 rh = vec2(-1.0);
      for (int j = 0; j < 44; j++) {
        vec2 h2 = mapScene(rRo + rRd * rt);
        if (h2.x < 0.004) { rh = vec2(rt, h2.y); break; }
        rt += max(h2.x * 0.9, 0.006);
        if (rt > 16.0) break;
      }
      vec3 rCol = rh.x < 0.0 ? evalHdrSky(rRd) : shadeSurfaceHdr(rRo + rRd * rh.x, calcNormal(rRo + rRd * rh.x), rRd, rh.y);
      float fres = 0.14 + 0.52 * pow(1.0 - max(dot(n, -rd), 0.0), 3.0);
      hdrCol = mix(hdrCol, rCol, fres);
    }
  }

  oHdr = vec4(max(hdrCol, 0.0), 1.0);
}
`;

// Pass 2: Separable HDR Bloom Prefilter & Gaussian Blur (operates in true RGBA16F linear HDR!)
export const BLOOM_BLUR_FS = /* glsl */`#version 300 es
precision highp float;

in vec2 vUv;
out vec4 oCol;

uniform sampler2D uSrc;
uniform vec2 uTexel;
uniform vec2 uDir;
uniform float uPrefilter;

void main() {
  if (uPrefilter > 0.5) {
    vec3 c = texture(uSrc, vUv).rgb;
    float lum = max(c.r, max(c.g, c.b));
    float soft = smoothstep(0.85, 2.8, lum);
    // Clamp ultra-hot spikes slightly before blur so bloom halo stays rich & clean
    oCol = vec4(min(c, vec3(28.0)) * soft, 1.0);
    return;
  }
  const float w[5] = float[5](0.227027, 0.1945946, 0.1216216, 0.054054, 0.016216);
  vec3 acc = texture(uSrc, vUv).rgb * w[0];
  for (int i = 1; i < 5; i++) {
    vec2 off = uDir * uTexel * (float(i) * 1.85);
    acc += texture(uSrc, clamp(vUv + off, vec2(0.002), vec2(0.998))).rgb * w[i];
    acc += texture(uSrc, clamp(vUv - off, vec2(0.002), vec2(0.998))).rgb * w[i];
  }
  oCol = vec4(acc, 1.0);
}
`;

// Pass 3: Exact Analytical Tone Mapping Operators + Live Response Curve Graph & Exposure Meter!
export const TONEMAP_FS = /* glsl */`#version 300 es
precision highp float;

in vec2 vUv;
out vec4 oCol;

uniform sampler2D uHdrTex;
uniform sampler2D uBloomTex;
uniform vec2 uRes;
uniform float uExposureEv;     // -4.0 .. +6.0 EV
uniform float uAutoAdaptEv;    // Tunnel eye-adaptation EV offset on Stage 2 (Far Cry / Lost Coast!)
uniform float uSplitX;
uniform int uStageLeft, uStageRight;
uniform float uDebugOn;        // Per-stage alternate operator (Hejl vs Hable, Lottes vs GT, Tony vs PBR Neutral!)
uniform float uShowGraph;      // 1.0 -> draw live interactive Tone-Mapping Curve Graph in upper-right!

// 0: <2002 Raw LDR Clamp (flat clipping + Notorious 6 hue twist!)
vec3 tmClamp(vec3 x) {
  return clamp(x, 0.0, 1.0);
}

// 1: 2002 Reinhard (SIGGRAPH 2002) — x / (1 + x)
vec3 tmReinhard(vec3 x) {
  return x / (1.0 + x);
}

// 3a: 2010 John Hable / Uncharted 2 Filmic S-Curve (GDC 2010)
vec3 hablePartial(vec3 x) {
  const float A = 0.15, B = 0.50, C = 0.10, D = 0.20, E = 0.02, F = 0.30;
  return ((x * (A * x + C * B) + D * E) / (x * (A * x + B) + D * F)) - E / F;
}
vec3 tmUncharted2(vec3 x) {
  float exposureBias = 2.0;
  vec3 curr = hablePartial(x * exposureBias);
  vec3 whiteScale = 1.0 / hablePartial(vec3(11.2));
  return clamp(curr * whiteScale, 0.0, 1.0);
}

// 3b: 2010 Jim Hejl & Richard Burgess-Dawson Filmic (GDC 2010)
// Note: output already includes sRGB gamma encoding -> decode back to linear so final sRGB encode stays uniform!
vec3 tmHejl(vec3 x) {
  vec3 c = max(vec3(0.0), x - 0.004);
  vec3 srgb = (c * (6.2 * c + 0.5)) / (c * (6.2 * c + 1.7) + 0.06);
  return pow(clamp(srgb, 0.0, 1.0), vec3(2.2));
}

// 4: 2014-2017 ACES Filmic (Krzysztof Narkowicz Jan 2016 fit · Unreal 4.15 2017)
// Iconic cinema contrast, famous for "Notorious 6" hue skew on hot pure Blue (-> purple/cyan) & Red (-> yellow)!
vec3 tmAcesNarkowicz(vec3 x) {
  x *= 0.6;
  const float a = 2.51, b = 0.03, c = 2.43, d = 0.59, e = 0.14;
  return clamp((x * (a * x + b)) / (x * (c * x + d) + e), 0.0, 1.0);
}

// 5a: 2017 GT Tone Mapping (Hajime Uchimura, Gran Turismo Sport)
float uchimuraCh(float x) {
  const float P = 1.0;  // max display brightness
  const float a = 1.0;  // contrast
  const float m = 0.22; // linear section start
  const float l = 0.40; // linear section length
  const float c = 1.33; // black tightness
  const float b = 0.0;  // pedestal
  float l0 = ((P - m) * l) / a;
  float S0 = m + l0;
  float S1 = m + a * l0;
  float C2 = (a * P) / (P - S1);
  float CP = -C2 / P;
  float w0 = 1.0 - smoothstep(0.0, m, x);
  float w2 = step(m + l0, x);
  float w1 = 1.0 - w0 - w2;
  float T = m * pow(max(x / m, 1e-6), c) + b;
  float L = m + a * (x - m);
  float S = P - (P - S1) * exp(CP * (x - S0));
  return T * w0 + L * w1 + S * w2;
}
vec3 tmUchimuraGT(vec3 x) {
  return clamp(vec3(uchimuraCh(x.r), uchimuraCh(x.g), uchimuraCh(x.b)), 0.0, 1.0);
}

// 5b: 2016 Timothy Lottes (AMD GDC 2016)
vec3 tmLottes(vec3 x) {
  const vec3 a = vec3(1.6);
  const vec3 d = vec3(0.977);
  const vec3 hdrMax = vec3(8.0);
  const vec3 midIn = vec3(0.18);
  const vec3 midOut = vec3(0.267);
  vec3 b = (-pow(midIn, a) + pow(hdrMax, a) * midOut) / ((pow(hdrMax, a * d) - pow(midIn, a * d)) * midOut);
  vec3 c = (pow(hdrMax, a * d) * pow(midIn, a) - pow(hdrMax, a) * pow(midIn, a * d) * midOut) / ((pow(hdrMax, a * d) - pow(midIn, a * d)) * midOut);
  vec3 xa = pow(max(x, vec3(0.0)), a);
  return clamp(xa / (pow(max(x, vec3(0.0)), a * d) * b + c), 0.0, 1.0);
}

// 6: 2023 AgX (Troy Sobotka -> Blender 4.0 Nov 2023; exact analytical Benjamin Wrensch / Filament AgX fit!)
// Inset matrix gently rotates & desaturates extreme primaries BEFORE sigmoid -> clean incandescent white cores, ZERO hue break!
vec3 agxDefaultContrastApprox(vec3 x) {
  vec3 x2 = x * x;
  vec3 x4 = x2 * x2;
  return + 15.5     * x4 * x2
         - 40.14    * x4 * x
         + 31.96    * x4
         - 6.868    * x2 * x
         + 0.4298   * x2
         + 0.1191   * x
         - 0.00232;
}

vec3 tmAgX(vec3 val, bool punchy) {
  const mat3 agxMat = mat3(
    0.842479062253094,  0.0423282422610123, 0.0423756549057051,
    0.0784335999999992, 0.878468636469772,  0.0784336,
    0.0792237451477643, 0.0791661274605434, 0.879142973793104
  );
  const mat3 agxMatInv = mat3(
     1.19687900512017,   -0.0528968517574562, -0.0529716355144438,
    -0.0980208811401368,  1.15190312990417,   -0.0980434501171241,
    -0.0990297440797205, -0.0989611768448433,  1.15107367264116
  );
  const float minEv = -12.47393;
  const float maxEv =  4.026069;

  val = agxMat * max(val, vec3(1e-6));
  val = clamp(log2(val), minEv, maxEv);
  val = (val - minEv) / (maxEv - minEv);
  val = agxDefaultContrastApprox(val);
  if (punchy) {
    // Blender 4.0 AgX "Punchy" look (rich contrast + slight chroma preservation)
    float luma = dot(val, vec3(0.2126, 0.7152, 0.0722));
    val = pow(max(val, vec3(0.0)), vec3(1.22));
    val = mix(vec3(luma), val, 1.18);
  }
  val = agxMatInv * val;
  return clamp(pow(max(val, vec3(0.0)), vec3(2.2)), 0.0, 1.0);
}

// 7a: May 2024 Khronos PBR Neutral (exact official glTF specification formula — 1:1 albedo preservation!)
vec3 tmKhronosPbrNeutral(vec3 color) {
  const float startCompression = 0.8 - 0.04;
  const float desaturation = 0.15;
  float x = min(color.r, min(color.g, color.b));
  float offset = x < 0.08 ? x - 6.25 * x * x : 0.04;
  color -= offset;
  float peak = max(color.r, max(color.g, color.b));
  if (peak < startCompression) return clamp(color, 0.0, 1.0);
  float d = 1.0 - startCompression;
  float newPeak = 1.0 - d * d / (peak + d - startCompression);
  color *= newPeak / peak;
  float g = 1.0 - 1.0 / (desaturation * (peak - newPeak) + 1.0);
  return clamp(mix(color, vec3(newPeak), g), 0.0, 1.0);
}

// 7b: Feb 2023 Tony McMapface (Tomasz Stachowiak / Bevy 0.11 default — analytical hue-locked neutral compression!)
vec3 tmTonyApprox(vec3 x) {
  // Smooth luminance compression with subtle filmic desaturation in extreme highlights & strict midtone hue fidelity
  float l = max(dot(x, vec3(0.2126, 0.7152, 0.0722)), 1e-5);
  float lComp = l / (1.0 + l * 0.82);
  vec3 c = x * (lComp / l);
  float peak = max(c.r, max(c.g, c.b));
  if (peak > 0.75) {
    float t = clamp((peak - 0.75) / (peak + 0.55), 0.0, 1.0);
    c = mix(c, vec3(min(peak, 1.0)), t * 0.72);
  }
  return clamp(c / (1.0 + max(c - 0.92, vec3(0.0)) * 1.4), 0.0, 1.0);
}

vec3 evalTonemap(int stage, bool altMode, vec3 hdr) {
  if (stage == 0) return tmClamp(hdr);
  if (stage == 1) return tmReinhard(hdr);
  if (stage == 2) return tmReinhard(hdr); // Far Cry / HL2 Lost Coast era HDR + strong bloom + eye adaptation!
  if (stage == 3) return altMode ? tmHejl(hdr) : tmUncharted2(hdr);
  if (stage == 4) return tmAcesNarkowicz(hdr);
  if (stage == 5) return altMode ? tmLottes(hdr) : tmUchimuraGT(hdr);
  if (stage == 6) return tmAgX(hdr, !altMode);
  return altMode ? tmTonyApprox(hdr) : tmKhronosPbrNeutral(hdr);
}

vec3 linearToSrgb(vec3 c) {
  c = clamp(c, 0.0, 1.0);
  return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(vec3(0.0031308), c));
}

void main() {
  vec2 uv = vUv;
  bool isLeft = uSplitX > 0.0 && uv.x < uSplitX;
  int stage = isLeft ? uStageLeft : uStageRight;
  bool altMode = uDebugOn > 0.5 && !isLeft;

  vec3 hdr = texture(uHdrTex, uv).rgb;
  vec3 bloom = texture(uBloomTex, uv).rgb;

  // Stage 2 (2004-2005 Far Cry 1.3 / HL2 Lost Coast): strong iconic early-HDR bloom + live eye adaptation!
  float bloomAmt = (stage == 0) ? 0.0 : (stage == 2 ? 0.52 : (stage == 1 ? 0.04 : 0.14));
  float ev = uExposureEv + (stage == 2 ? uAutoAdaptEv : 0.0);
  float gain = exp2(ev);

  vec3 mapped = evalTonemap(stage, altMode, (hdr + bloom * bloomAmt) * gain);
  vec3 outCol = linearToSrgb(mapped);

  // Live Tone-Mapping Response Curve Graph (upper-right safe panel: compares input HDR 0..12 -> display 0..1!)
  if (uShowGraph > 0.5) {
    vec2 px = uv * uRes;
    float gw = min(uRes.x, uRes.y) * 0.28;
    float gh = gw * 0.72;
    vec2 gMin = vec2(uRes.x - gw - 28.0, uRes.y - gh - 76.0);
    vec2 gMax = gMin + vec2(gw, gh);

    if (px.x >= gMin.x - 4.0 && px.x <= gMax.x + 4.0 && px.y >= gMin.y - 4.0 && px.y <= gMax.y + 4.0) {
      bool border = px.x < gMin.x || px.x > gMax.x || px.y < gMin.y || px.y > gMax.y;
      if (border) {
        outCol = vec3(0.95, 0.74, 0.34);
      } else {
        vec2 gUv = (px - gMin) / vec2(gw, gh); // x: log input [-3..+4 EV], y: output [0..1]
        vec3 bg = vec3(0.05, 0.07, 0.12);
        // Subtle 4x4 grid + 1.0 clip line
        float grid = max(smoothstep(0.47, 0.498, abs(fract(gUv.x * 4.0) - 0.5)), smoothstep(0.47, 0.498, abs(fract(gUv.y * 4.0) - 0.5)));
        bg = mix(bg, vec3(0.14, 0.18, 0.28), grid * 0.75);
        // Input linear HDR value across graph X axis (log scale: 2^(-3) = 0.125 to 2^(+4) = 16.0)
        float linIn = exp2(mix(-3.0, 4.0, gUv.x)) * exp2(uExposureEv * 0.45);
        // Active Right/Primary tone-mapping curve (bright amber) + Left comparison curve (cool cyan when Split ON!)
        float yR = linearToSrgb(evalTonemap(uStageRight, uDebugOn > 0.5, vec3(linIn))).g;
        float dR = abs(gUv.y - yR);
        bg = mix(bg, vec3(1.0, 0.78, 0.26), smoothstep(0.028, 0.008, dR));
        if (uSplitX > 0.0) {
          float yL = linearToSrgb(evalTonemap(uStageLeft, false, vec3(linIn))).g;
          float dL = abs(gUv.y - yL);
          bg = mix(bg, vec3(0.28, 0.85, 1.0), smoothstep(0.024, 0.007, dL));
        }
        // Highlight current EV marker along bottom rail of graph!
        float evNorm = clamp((uExposureEv + 3.0) / 9.0, 0.0, 1.0);
        if (gUv.y < 0.09) {
          bg = mix(bg, gUv.x < evNorm ? vec3(0.95, 0.72, 0.28) : vec3(0.18, 0.22, 0.30), 0.9);
        }
        outCol = mix(outCol, bg, 0.86);
      }
    }
  }

  // Crisp amber split divider
  if (uSplitX > 0.0 && abs(uv.x - uSplitX) < 1.5 / uRes.x) {
    outCol = vec3(0.93, 0.65, 0.37);
  }
  oCol = vec4(outCol, 1.0);
}
`;
