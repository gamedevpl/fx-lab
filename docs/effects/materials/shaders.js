// FX Lab #31: Material Sandbox — WebGL2 Studio Raymarcher & Physically Based Material BRDFs
// Features:
//  - Procedural CNC Shaderball (smooth dome, chamfered equatorial groove, crown ring, deep aperture cavity + inner core)
//  - Exact loop-free (2,3) Torus Knot SDF with analytical spine tangent
//  - Real orbiting rectangular area softbox (Karis MRP specular + soft SDF shadows + 5-tap cavity AO + glossy floor bounce)
//  - 3 procedural HDR IBL environments: Studio Softbox, Low Sun, Neon Night
//  - 6 seamlessly morphable material models: 2005 Blinn-Phong, Oren-Nayar Dry Clay, Anisotropic GGX Brushed Steel,
//    Clearcoat + 3D Metal Flake Car Paint, Charlie Sheen Velvet, and Airy Thin-Film Heat-Blued Titanium.

export const MATERIALS_FS = `#version 300 es
precision highp float;

in vec2 vUv;
out vec4 fragColor;

uniform vec2  uRes;
uniform vec3  uCamPos;
uniform vec3  uCamRight;
uniform vec3  uCamUp;
uniform vec3  uCamFwd;
uniform float uTanHalfFov;
uniform float uAspect;
uniform float uTime;

// Scene & Studio controls
uniform int   uShape;          // 0 = Shaderball, 1 = Torus Knot
uniform int   uEnv;            // 0 = Studio Softbox, 1 = Low Sun, 2 = Neon Night
uniform vec3  uLightPos;       // Orbiting / manually dragged softbox center
uniform vec3  uLightRight;
uniform vec3  uLightUp;
uniform vec3  uLightFwd;       // Points from softbox toward object
uniform float uSplitX;         // <0 = off; 0..1 = divider X (left = 2005 Blinn-Phong, right = live PBR)
uniform float uShowLightHandle;

// Material parameters (continuously interpolated between presets & live sliders)
uniform vec3  uBaseColor;      // Linear RGB albedo / metallic F0
uniform vec3  uSheenColor;     // Linear RGB velvet sheen tint
uniform float uRoughness;      // 0.04..1.0
uniform float uMetallic;       // 0.0..1.0
uniform float uClearcoat;      // 0.0..1.0
uniform float uAnisotropy;     // 0.0..1.0
uniform float uIridescence;    // 0.0..1.0 (maps to thin-film thickness 140..760 nm)
uniform float uSheen;          // 0.0..1.0 (Charlie sheen intensity)
uniform float uFlakes;         // 0.0..1.0 (3D metallic flake sparkle under clearcoat)
uniform float uClayGrain;      // 0.0..1.0 (micro-grain matte bump + Oren-Nayar blend)
uniform float uPhongMix;       // 0.0..1.0 (1.0 = legacy 2005 Blinn-Phong preset)

const float PI = 3.14159265359;
const float SOFTBOX_HW = 0.92;
const float SOFTBOX_HH = 0.44;
const vec3  HERO_CENTER = vec3(0.0, 0.96, 0.0);

// ---------- Fast deterministic 3D hashes for flakes & clay micro-grain ----------
vec3 hash33(vec3 p) {
  p = fract(p * vec3(0.1031, 0.1030, 0.0973));
  p += dot(p, p.yxz + 33.33);
  return fract((p.xxy + p.yxx) * p.zyx);
}

float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

float noise3(vec3 p) {
  vec3 i = floor(p);
  vec3 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float n000 = hash33(i + vec3(0,0,0)).x;
  float n100 = hash33(i + vec3(1,0,0)).x;
  float n010 = hash33(i + vec3(0,1,0)).x;
  float n110 = hash33(i + vec3(1,1,0)).x;
  float n001 = hash33(i + vec3(0,0,1)).x;
  float n101 = hash33(i + vec3(1,0,1)).x;
  float n011 = hash33(i + vec3(0,1,1)).x;
  float n111 = hash33(i + vec3(1,1,1)).x;
  float nx00 = mix(n000, n100, f.x);
  float nx10 = mix(n010, n110, f.x);
  float nx01 = mix(n001, n101, f.x);
  float nx11 = mix(n011, n111, f.x);
  float nxy0 = mix(nx00, nx10, f.y);
  float nxy1 = mix(nx01, nx11, f.y);
  return mix(nxy0, nxy1, f.z);
}

mat2 rot2(float a) {
  float c = cos(a), s = sin(a);
  return mat2(c, -s, s, c);
}

// Smooth boolean ops for crisp CNC bevels / chamfers
float opSmoothSub(float dCut, float dBase, float k) {
  float h = clamp(0.5 - 0.5 * (dBase + dCut) / k, 0.0, 1.0);
  return mix(dBase, -dCut, h) + k * h * (1.0 - h);
}

float opSmoothUnion(float a, float b, float k) {
  float h = clamp(0.5 + 0.5 * (b - a) / k, 0.0, 1.0);
  return mix(b, a, h) - k * h * (1.0 - h);
}

float sdCylinderChamfer(vec3 p, float r, float h, float ch) {
  vec2 d = abs(vec2(length(p.xz), p.y)) - vec2(r - ch, h - ch);
  return min(max(d.x, d.y), 0.0) + length(max(d, 0.0)) - ch;
}

// ---------- Procedural Hero Geometry ----------
// Shape 0: Studio Shaderball (smooth outer dome, chamfered equatorial ring groove,
//          crown lathe groove, circular chamfered cavity porthole + recessed inner hero core)
float sdShaderballHero(vec3 p) {
  vec3 q = p - HERO_CENTER;
  float r = length(q);

  // Main outer sphere, seated cleanly above plinth (y >= 0.115)
  float dShell = r - 0.90;
  dShell = opSmoothSub(p.y - 0.115, dShell, 0.028);

  // Equatorial precision-milled groove with crisp beveled shoulders
  float dGroove = max(abs(q.y + 0.06) - 0.115, 0.725 - r);
  dShell = opSmoothSub(dGroove, dShell, 0.024);

  // Secondary upper crown lathe step (catches overhead softbox rim glint)
  float dCrown = max(abs(q.y - 0.55) - 0.026, 0.855 - r);
  dShell = opSmoothSub(dCrown, dShell, 0.012);

  // Front-right architectural aperture & deep hollow chamber
  vec3 cavDir = normalize(vec3(0.30, 0.18, 0.937));
  float proj = dot(q, cavDir);
  float perp = length(q - cavDir * proj);
  float dPort = max(perp - 0.365, -proj + 0.04);
  float dHollow = r - 0.62;
  float dCavity = opSmoothUnion(dHollow, dPort, 0.028);
  dShell = opSmoothSub(dCavity, dShell, 0.028);

  // Recessed inner floating hero core sphere (shows off deep cavity shadows, rim & reflection!)
  float dCore = r - 0.335;

  return min(dShell, dCore);
}

// Shape 1: Exact loop-free (2,3) Trefoil Torus Knot SDF (C-infinity smooth, zero UV seams!)
vec3 knotLocal(vec3 p) {
  vec3 q = p - vec3(0.0, 0.98, 0.0);
  // Subtle dramatic tilt so the woven knot silhouette shines from the studio camera
  q.yz = rot2(0.42) * q.yz;
  q.xz = rot2(0.22) * q.xz;
  return q;
}

float sdTorusKnotHero(vec3 p) {
  vec3 q = knotLocal(p);
  float R = 0.58;
  float rk = 0.21;
  float tube = 0.162;
  float phi = atan(q.z, q.x);
  vec2 m = vec2(length(q.xz) - R, q.y);
  float a = 1.5 * phi;
  vec2 c = rk * vec2(cos(a), sin(a));
  // Both opposite strands pierce the meridional plane -> exact unordered pair, zero branch seam!
  float d = min(length(m - c), length(m + c)) - tube;
  return d * 0.56; // Conservative Lipschitz factor eliminates any crease on tight inner twists
}

// Dark anodized machined studio base plinth / core stem
float sdPlinth(vec3 p) {
  if (uShape == 1) {
    // Low slim studio shadow plinth under torus knot
    return sdCylinderChamfer(p - vec3(0.0, 0.032, 0.0), 0.76, 0.032, 0.010);
  }
  // Shaderball machined plinth + discreet inner stem supporting the recessed core
  float baseRing = sdCylinderChamfer(p - vec3(0.0, 0.058, 0.0), 0.56, 0.058, 0.016);
  float innerStem = sdCylinderChamfer(p - vec3(0.0, 0.38, 0.0), 0.135, 0.34, 0.012);
  return min(baseRing, innerStem);
}

vec2 mapScene(vec3 p) {
  float dFloor = p.y;
  vec2 res = vec2(dFloor, 0.0);

  // Bounding sphere early-out for hero object + plinth
  float dBound = length(p - vec3(0.0, 0.96, 0.0)) - 1.28;
  if (dBound < res.x) {
    float dHero = (uShape == 0) ? sdShaderballHero(p) : sdTorusKnotHero(p);
    if (dHero < res.x) res = vec2(dHero, 1.0);
    float dBase = sdPlinth(p);
    if (dBase < res.x) res = vec2(dBase, 2.0);
  }
  return res;
}

float mapDistanceOnly(vec3 p) {
  float d = p.y;
  float dBound = length(p - vec3(0.0, 0.96, 0.0)) - 1.28;
  if (dBound < d) {
    float dHero = (uShape == 0) ? sdShaderballHero(p) : sdTorusKnotHero(p);
    d = min(d, dHero);
    d = min(d, sdPlinth(p));
  }
  return d;
}

vec3 calcNormal(vec3 p) {
  const float e = 0.00075;
  const vec2 k = vec2(1.0, -1.0);
  return normalize(
    k.xyy * mapDistanceOnly(p + k.xyy * e) +
    k.yyx * mapDistanceOnly(p + k.yyx * e) +
    k.yxy * mapDistanceOnly(p + k.yxy * e) +
    k.xxx * mapDistanceOnly(p + k.xxx * e)
  );
}

// Analytical tangent frame for brushed-metal anisotropy (lathe azimuth on Shaderball, spine curve on Torus Knot!)
void calcTangentFrame(vec3 p, vec3 N, out vec3 T, out vec3 B) {
  if (uShape == 1) {
    vec3 q = knotLocal(p);
    float R = 0.58;
    float rk = 0.21;
    float phi = atan(q.z, q.x);
    vec2 m = vec2(length(q.xz) - R, q.y);
    float a = 1.5 * phi;
    vec2 c = rk * vec2(cos(a), sin(a));
    float s = (length(m - c) < length(m + c)) ? 1.0 : -1.0;
    float ca = s * cos(a), sa = s * sin(a);
    float rc = R + rk * ca;
    float dr = -1.5 * rk * sa;
    float dy =  1.5 * rk * ca;
    float cp = cos(phi), sp = sin(phi);
    vec3 dC = vec3(dr * cp - rc * sp, dy, dr * sp + rc * cp);
    // Transform spine tangent back to world space (inverse of knotLocal rotations)
    dC.xz = rot2(-0.22) * dC.xz;
    dC.yz = rot2(-0.42) * dC.yz;
    vec3 projT = dC - N * dot(dC, N);
    T = (dot(projT, projT) > 1e-6) ? normalize(projT) : normalize(cross(vec3(0.0, 1.0, 0.0), N));
    B = normalize(cross(N, T));
    return;
  }

  // Shaderball: CNC lathe azimuthal direction around Y axis (smooth fallback near poles)
  vec3 upAxis = (abs(N.y) < 0.985) ? vec3(0.0, 1.0, 0.0) : vec3(0.0, 0.0, 1.0);
  T = normalize(cross(upAxis, N));
  B = normalize(cross(N, T));
}

// Multi-tap SDF cavity Ambient Occlusion (carves realistic depth inside groove & hollow cavity!)
float calcAO(vec3 p, vec3 N) {
  float occ = 0.0;
  float sca = 1.0;
  for (int i = 0; i < 5; i++) {
    float h = 0.025 + 0.075 * float(i) * float(i) * 0.45;
    float d = mapDistanceOnly(p + h * N);
    occ += (h - d) * sca;
    sca *= 0.68;
  }
  return clamp(1.0 - 2.35 * occ, 0.04, 1.0);
}

// Soft SDF penumbra shadow toward light target
float calcSoftShadow(vec3 ro, vec3 rd, float mint, float maxt, float k) {
  float res = 1.0;
  float t = mint;
  for (int i = 0; i < 36; i++) {
    float h = mapDistanceOnly(ro + rd * t);
    if (h < 0.0008) return 0.0;
    res = min(res, k * h / t);
    t += clamp(h, 0.015, 0.22);
    if (t > maxt) break;
  }
  return clamp(res, 0.0, 1.0);
}

vec2 raymarch(vec3 ro, vec3 rd, float maxT) {
  float t = 0.0;
  for (int i = 0; i < 96; i++) {
    vec3 p = ro + rd * t;
    vec2 h = mapScene(p);
    if (h.x < 0.00045 * (1.0 + t * 0.22)) return vec2(t, h.y);
    t += h.x;
    if (t > maxT) break;
  }
  return vec2(-1.0, -1.0);
}

// Smooth museum-grade photography cyclorama backdrop (used for camera rays & seamless floor fade)
vec3 evalStudioBackdrop(vec3 rd, int envIdx) {
  float gy = smoothstep(-0.35, 0.75, rd.y);
  if (envIdx == 0) {
    // Neutral dark charcoal photography studio sweep
    return mix(vec3(0.015, 0.017, 0.022), vec3(0.036, 0.041, 0.052), gy);
  }
  if (envIdx == 1) {
    // Low Sun: deep warm-to-twilight dusk sweep
    vec3 lo = vec3(0.068, 0.036, 0.022);
    vec3 hi = vec3(0.024, 0.038, 0.072);
    return mix(lo, hi, gy);
  }
  // Neon Night: moody deep obsidian-indigo backdrop with subtle dual neon atmosphere
  vec3 base = mix(vec3(0.010, 0.009, 0.022), vec3(0.028, 0.018, 0.055), gy);
  float cyanGlow = pow(max(dot(rd, normalize(vec3(-0.75, 0.15, 0.45))), 0.0), 4.0);
  float magGlow  = pow(max(dot(rd, normalize(vec3(0.75, 0.20, -0.45))), 0.0), 4.0);
  return base + vec3(0.01, 0.065, 0.095) * cyanGlow + vec3(0.095, 0.012, 0.065) * magGlow;
}

// ---------- Procedural HDR IBL Studio Environments (3 Presets) ----------
// Evaluates directional HDR radiance with analytical roughness-convolved softbox panels!
vec3 evalEnvLight(vec3 dir, float rough, int envIdx) {
  float r = clamp(rough, 0.02, 1.0);
  float edge = mix(0.018, 0.55, r * r);
  float blurEnergy = 1.0 / (1.0 + 5.8 * r * r);

  // Orbiting primary rectangular softbox projected onto directional sphere
  vec3 toBox = normalize(uLightPos - HERO_CENTER);
  float dFwd = dot(dir, toBox);
  float boxMask = 0.0;
  if (dFwd > 0.05) {
    vec3 proj = dir / max(dFwd, 0.12) - toBox;
    float u = dot(proj, uLightRight) / (SOFTBOX_HW / 3.15);
    float v = dot(proj, uLightUp)    / (SOFTBOX_HH / 3.15);
    float bx = 1.0 - smoothstep(1.0 - edge, 1.0 + edge * 2.2, abs(u));
    float by = 1.0 - smoothstep(1.0 - edge, 1.0 + edge * 2.2, abs(v));
    // Soft internal diffuser falloff so studio softbox looks genuinely photographic
    float diffGrad = 0.82 + 0.18 * (1.0 - clamp(u * u * 0.35 + v * v * 0.35, 0.0, 1.0));
    boxMask = bx * by * diffGrad * blurEnergy;
  }

  // Secondary cool rim strip on opposite back-side of the orbiting key light
  vec3 rimDir = normalize(vec3(-toBox.x, 0.30, -toBox.z));
  vec3 rimRight = normalize(cross(vec3(0.0, 1.0, 0.0), rimDir));
  vec3 rimUp = cross(rimDir, rimRight);
  float dRim = dot(dir, rimDir);
  float rimMask = 0.0;
  if (dRim > 0.05) {
    vec3 pr = dir / max(dRim, 0.15) - rimDir;
    float ru = dot(pr, rimRight) / 0.16;
    float rv = dot(pr, rimUp)    / 0.62;
    float rx = 1.0 - smoothstep(1.0 - edge, 1.0 + edge * 2.4, abs(ru));
    float ry = 1.0 - smoothstep(1.0 - edge, 1.0 + edge * 2.4, abs(rv));
    rimMask = rx * ry * blurEnergy;
  }

  // Overhead accent strip light (gives crisp vertical curvature readability!)
  float topMask = smoothstep(0.68 - r * 0.45, 0.96, dir.y)
                * (1.0 - smoothstep(0.22, 0.28 + r * 0.45, abs(dir.z))) * blurEnergy;

  if (envIdx == 0) {
    // 0: STUDIO SOFTBOX (neutral high-contrast photography studio)
    vec3 dome = mix(vec3(0.020, 0.023, 0.030), vec3(0.075, 0.085, 0.105), smoothstep(-0.25, 0.85, dir.y));
    // Subtle dark horizon studio band & soft bounce floor
    float horiz = exp(-pow(dir.y * 5.2, 2.0));
    dome += vec3(0.035, 0.040, 0.050) * horiz;
    if (dir.y < 0.0) dome *= mix(0.45, 0.85, r);
    // Warm-neutral 5800K key softbox + cool ice-blue rim strip + crisp overhead strip
    vec3 col = dome;
    col += vec3(5.6, 5.35, 5.05) * boxMask;
    col += vec3(1.55, 2.25, 3.25) * rimMask;
    col += vec3(1.95, 2.05, 2.25) * topMask;
    return col;
  }

  if (envIdx == 1) {
    // 1: LOW SUN (cinematic golden-hour sun + deep twilight cobalt sky)
    vec3 skyLo = vec3(0.42, 0.19, 0.08);
    vec3 skyHi = vec3(0.045, 0.085, 0.21);
    vec3 gnd   = vec3(0.055, 0.040, 0.032);
    vec3 dome  = dir.y >= 0.0
      ? mix(skyLo, skyHi, pow(clamp(dir.y, 0.0, 1.0), 0.55))
      : mix(skyLo * 0.45, gnd, clamp(-dir.y * 3.0, 0.0, 1.0));
    float sunGlow = pow(max(dot(dir, toBox), 0.0), mix(18.0, 3.0, r));
    vec3 col = dome * 0.72;
    col += vec3(6.8, 3.6, 1.35) * boxMask;
    col += vec3(1.6, 0.72, 0.22) * sunGlow * (0.45 + 0.55 * blurEnergy);
    col += vec3(0.85, 1.45, 2.90) * rimMask;
    col += vec3(0.55, 0.82, 1.55) * topMask * 0.65;
    return col;
  }

  // 2: NEON NIGHT (saturated cyan/magenta/amber light bars for clearcoat & titanium!)
  vec3 dome = mix(vec3(0.012, 0.010, 0.028), vec3(0.045, 0.028, 0.095), smoothstep(-0.2, 0.9, dir.y));
  // Fixed neon magenta & cyan vertical studio tubes in the reflection dome
  vec3 cyanDir = normalize(vec3(-0.78, 0.22, 0.58));
  vec3 magDir  = normalize(vec3(0.76, 0.28, -0.58));
  float cyanBar = pow(max(dot(dir, cyanDir), 0.0), mix(44.0, 4.0, r * r)) * (0.35 + 0.65 * blurEnergy);
  float magBar  = pow(max(dot(dir, magDir),  0.0), mix(44.0, 4.0, r * r)) * (0.35 + 0.65 * blurEnergy);
  // Crisp neon horizon ring reflection
  float neonRing = exp(-pow((dir.y - 0.04) * mix(22.0, 4.0, r), 2.0)) * blurEnergy;
  vec3 ringCol = mix(vec3(0.0, 2.4, 2.8), vec3(2.8, 0.18, 1.55), 0.5 + 0.5 * sin(atan(dir.z, dir.x) * 2.0));
  vec3 col = dome;
  col += vec3(1.1, 4.8, 6.2) * boxMask;        // Electric cyan softbox key
  col += vec3(5.2, 0.65, 3.4) * rimMask;       // Hot magenta rim strip
  col += vec3(3.6, 2.4, 0.45) * topMask * 0.9; // Warm sodium overhead bar
  col += vec3(0.15, 2.6, 3.4) * cyanBar;
  col += vec3(3.4, 0.25, 2.1) * magBar;
  col += ringCol * neonRing * 0.45;
  return col;
}

// Diffuse hemisphere irradiance approximation matched to each IBL preset
vec3 evalEnvDiffuse(vec3 N, int envIdx) {
  vec3 upCol = evalEnvLight(vec3(0.0, 1.0, 0.0), 0.95, envIdx);
  vec3 dnCol = evalEnvLight(vec3(0.0, -1.0, 0.0), 0.95, envIdx);
  vec3 toBox = normalize(uLightPos - HERO_CENTER);
  vec3 keySide = evalEnvLight(toBox, 0.92, envIdx) * (0.30 + 0.70 * max(dot(N, toBox), 0.0));
  vec3 rimSide = evalEnvLight(normalize(vec3(-toBox.x, 0.25, -toBox.z)), 0.92, envIdx)
               * (0.20 + 0.80 * max(dot(N, normalize(vec3(-toBox.x, 0.25, -toBox.z))), 0.0));
  vec3 hemi = mix(dnCol, upCol, N.y * 0.5 + 0.5);
  return hemi * 0.55 + keySide * 0.34 + rimSide * 0.24;
}

// ---------- Physically Based BRDF Functions ----------
vec3 fresnelSchlick(float cosTheta, vec3 F0) {
  float f = pow(clamp(1.0 - cosTheta, 0.0, 1.0), 5.0);
  return F0 + (1.0 - F0) * f;
}

vec3 fresnelSchlickRoughness(float cosTheta, vec3 F0, float rough) {
  float f = pow(clamp(1.0 - cosTheta, 0.0, 1.0), 5.0);
  return F0 + (max(vec3(1.0 - rough), F0) - F0) * f;
}

float D_GGX(float NoH, float a) {
  float a2 = a * a;
  float d = (NoH * a2 - NoH) * NoH + 1.0;
  return a2 / (PI * d * d + 1e-6);
}

float V_SmithGGXCorrelated(float NoV, float NoL, float a) {
  float a2 = a * a;
  float ggxV = NoL * sqrt(NoV * NoV * (1.0 - a2) + a2);
  float ggxL = NoV * sqrt(NoL * NoL * (1.0 - a2) + a2);
  return 0.5 / max(ggxV + ggxL, 1e-5);
}

// Filament / Heitz Anisotropic GGX NDF & correlated Smith visibility
float D_GGX_Aniso(float NoH, float ToH, float BoH, float at, float ab) {
  float a2 = at * ab;
  vec3 v = vec3(ab * ToH, at * BoH, a2 * NoH);
  float v2 = dot(v, v);
  float w2 = a2 / max(v2, 1e-6);
  return a2 * w2 * w2 / PI;
}

float V_SmithGGXCorrelated_Aniso(float at, float ab, float ToV, float BoV, float ToL, float BoL, float NoV, float NoL) {
  float lambdaV = NoL * length(vec3(at * ToV, ab * BoV, NoV));
  float lambdaL = NoV * length(vec3(at * ToL, ab * BoL, NoL));
  return 0.5 / max(lambdaV + lambdaL, 1e-5);
}

// Qualitative Oren-Nayar rough diffuse BRDF (authentic chalky Dry Clay!)
float diffuseOrenNayar(float NoL, float NoV, float LoV, float rough) {
  float s = rough * 1.15;
  float s2 = s * s;
  float A = 1.0 - 0.5 * (s2 / (s2 + 0.33));
  float B = 0.45 * (s2 / (s2 + 0.09));
  float sTerm = LoV - NoL * NoV;
  float t = (sTerm > 0.0) ? max(NoL, NoV) : 1.0;
  return (A + B * sTerm / max(t, 1e-4)) / PI;
}

// Estevez & Kulla (2017) Charlie inverted-Gaussian Sheen NDF for Velvet
float D_Charlie(float rough, float NoH) {
  float r = max(rough, 0.08);
  float invR = 1.0 / r;
  float cos2h = NoH * NoH;
  float sin2h = max(1.0 - cos2h, 0.0078125);
  return (2.0 + invR) * pow(sin2h, invR * 0.5) / (2.0 * PI);
}

float V_Ashikhmin(float NoV, float NoL) {
  return 1.0 / max(4.0 * (NoL + NoV - NoL * NoV), 1e-4);
}

// Belcour & Barla (2017) Airy Thin-Film Optical Interference (Heat-Blued Titanium!)
// Produces authentic exhaust-titanium gold -> crimson-violet -> electric cobalt blue shift.
vec3 evalThinFilmIridescence(float cosTheta1, float iridStrength, vec3 baseF0) {
  if (iridStrength <= 0.001) return fresnelSchlick(cosTheta1, baseF0);
  // Map slider [0..1] across physically vibrant TiO2 oxide thicknesses [160nm..720nm]
  float dNm = mix(160.0, 720.0, iridStrength);
  float nFilm = 1.48; // Wide-angle optical thin-film oxide sweep (cobalt -> violet -> burnished gold!)
  float sin2t2 = (1.0 - cosTheta1 * cosTheta1) / (nFilm * nFilm);
  float cosTheta2 = sqrt(max(1.0 - sin2t2, 0.01));
  float opd = 2.0 * nFilm * dNm * cosTheta2;

  // Spectral interference at R(635nm), G(540nm), B(460nm) with exact metallic half-wave phase flip (+PI)
  vec3 lambda = vec3(635.0, 540.0, 460.0);
  vec3 phi = 2.0 * PI * opd / lambda + PI;
  vec3 F1 = fresnelSchlick(cosTheta1, vec3(0.12));
  vec3 F2 = fresnelSchlick(cosTheta2, clamp(baseF0, 0.30, 0.98));
  vec3 amp = 2.0 * sqrt(F1 * F2);
  vec3 irid = clamp(F1 + F2 + amp * cos(phi), 0.04, 1.0);
  // Crisp chromatic separation so gold/violet/cobalt bands read unmistakably at every angle
  float lum = dot(irid, vec3(0.2126, 0.7152, 0.0722));
  irid = clamp(mix(vec3(lum), irid, 1.48), 0.02, 1.0);

  vec3 baseF = fresnelSchlick(cosTheta1, baseF0);
  float blendW = smoothstep(0.0, 0.16, iridStrength);
  return mix(baseF, irid, blendW);
}

// ---------- Rectangular Softbox Area Light Evaluation (Karis MRP) ----------
struct AreaLightSample {
  vec3  Ldiff;
  vec3  Lspec;
  float atten;
  float alphaBoost;
  vec3  color;
};

AreaLightSample sampleSoftboxLight(vec3 pos, vec3 N, vec3 V, float rough) {
  AreaLightSample s;
  vec3 toCenter = uLightPos - pos;
  float distC = length(toCenter);
  s.Ldiff = toCenter / max(distC, 1e-4);

  // Key softbox color matches active IBL preset
  if (uEnv == 0)      s.color = vec3(4.3, 4.15, 3.95);
  else if (uEnv == 1) s.color = vec3(5.6, 3.05, 1.20);
  else                s.color = vec3(0.95, 4.1, 5.2);

  // Representative point on the rectangular softbox plane along reflection ray R
  vec3 R = reflect(-V, N);
  float denom = dot(R, uLightFwd);
  vec3 closestPt;
  if (abs(denom) > 1e-4) {
    float tPlane = dot(uLightPos - pos, uLightFwd) / denom;
    if (tPlane > 0.0) {
      vec3 hit = pos + R * tPlane;
      vec3 rel = hit - uLightPos;
      float cu = clamp(dot(rel, uLightRight), -SOFTBOX_HW, SOFTBOX_HW);
      float cv = clamp(dot(rel, uLightUp),    -SOFTBOX_HH, SOFTBOX_HH);
      closestPt = uLightPos + uLightRight * cu + uLightUp * cv;
    } else {
      // Fallback: project N toward rectangle when reflection points away
      vec3 rel = -toCenter;
      float cu = clamp(dot(rel, uLightRight), -SOFTBOX_HW, SOFTBOX_HW);
      float cv = clamp(dot(rel, uLightUp),    -SOFTBOX_HH, SOFTBOX_HH);
      closestPt = uLightPos + uLightRight * cu + uLightUp * cv;
    }
  } else {
    closestPt = uLightPos;
  }

  vec3 toSpec = closestPt - pos;
  float distS = length(toSpec);
  s.Lspec = toSpec / max(distS, 1e-4);

  // Physical inverse-square falloff stabilized for studio distance
  float avgR = 0.5 * (SOFTBOX_HW + SOFTBOX_HH);
  s.atten = 9.8 / (distC * distC + 1.8);
  s.alphaBoost = clamp(avgR / max(distS * 2.4, 0.5), 0.0, 0.35);
  return s;
}

// ---------- Legacy 2005 Blinn-Phong Shader (Point of Reference & Split Left Side) ----------
vec3 evalPhong2005(vec3 pos, vec3 N, vec3 V, vec3 baseCol) {
  vec3 L = normalize(uLightPos - pos);
  vec3 H = normalize(L + V);
  float NoL = max(dot(N, L), 0.0);
  float NoH = max(dot(N, H), 0.0);

  // Classic 2005 mistakes: flat ambient, zero energy conservation, white unnormalized Blinn-Phong blob, no Fresnel!
  float spec = pow(NoH, 34.0) * 1.25;
  vec3 keyTint = (uEnv == 1) ? vec3(1.15, 0.95, 0.78) : ((uEnv == 2) ? vec3(0.75, 1.05, 1.15) : vec3(1.0));

  // Weak secondary fill light from opposite side (typical 2005 2-light rig)
  vec3 L2 = normalize(vec3(-L.x, 0.35, -L.z));
  float NoL2 = max(dot(N, L2), 0.0);
  vec3 H2 = normalize(L2 + V);
  float spec2 = pow(max(dot(N, H2), 0.0), 28.0) * 0.25;

  // Deliberately NO cavity AO and NO IBL softbox reflection — authentic flat-ambient 2005 wet plastic!
  vec3 diff = baseCol * (0.14 + NoL * 0.88 * keyTint + NoL2 * 0.16);
  vec3 specCol = vec3(1.0) * (spec * keyTint + spec2);
  return diff + specCol;
}

// ---------- Modern Unified Physically Based Material Evaluator ----------
vec3 evalPbrMaterial(vec3 pos, vec3 Ngeom, vec3 V, vec3 T, vec3 B, float ao) {
  float rough = clamp(uRoughness, 0.04, 1.0);
  float metal = clamp(uMetallic, 0.0, 1.0);
  float coat  = clamp(uClearcoat, 0.0, 1.0);
  float aniso = clamp(uAnisotropy, 0.0, 1.0);
  float irid  = clamp(uIridescence, 0.0, 1.0);
  float sheen = clamp(uSheen, 0.0, 1.0);

  // Subtle surface micro-normals per material family:
  vec3 N = Ngeom;

  // 1) Dry Clay tactile fine mineral micro-grain (subtle chalky ceramic pores, never lumpy!)
  if (uClayGrain > 0.01) {
    vec3 gp = pos * 92.0;
    vec3 gN = vec3(
      noise3(gp + vec3(0.35, 0.0, 0.0)) - noise3(gp - vec3(0.35, 0.0, 0.0)),
      noise3(gp + vec3(0.0, 0.35, 0.0)) - noise3(gp - vec3(0.0, 0.35, 0.0)),
      noise3(gp + vec3(0.0, 0.0, 0.35)) - noise3(gp - vec3(0.0, 0.0, 0.35))
    );
    vec3 gp2 = pos * 210.0;
    vec3 gN2 = vec3(
      noise3(gp2 + vec3(0.4, 0.0, 0.0)) - noise3(gp2 - vec3(0.4, 0.0, 0.0)),
      noise3(gp2 + vec3(0.0, 0.4, 0.0)) - noise3(gp2 - vec3(0.0, 0.4, 0.0)),
      noise3(gp2 + vec3(0.0, 0.0, 0.4)) - noise3(gp2 - vec3(0.0, 0.0, 0.4))
    );
    N = normalize(N + (gN * 0.048 + gN2 * 0.032) * uClayGrain);
  }

  // 2) Brushed Steel fine CNC lathe micro-grooves along bitangent (perpendicular to brush streaks)
  if (aniso > 0.05) {
    float coord = (uShape == 0)
      ? (pos.y * 135.0 + noise3(pos * 18.0) * 1.2)
      : (length(pos - HERO_CENTER) * 140.0 + pos.y * 90.0);
    float groove = sin(coord) * 0.5 + sin(coord * 2.37 + 1.3) * 0.35 + sin(coord * 5.13) * 0.15;
    N = normalize(N + B * (groove * 0.032 * aniso));
  }

  // Re-orthonormalize tangent frame around perturbed normal
  T = normalize(T - N * dot(T, N));
  B = normalize(cross(N, T));

  // 3) Car Paint ultra-fine microscopic metallic aluminum flakes under clearcoat (smooth circular sub-mm grains!)
  vec3 Nbase = N;
  float flakeBoost = 0.0;
  if (uFlakes > 0.01) {
    vec3 fp = pos * 265.0;
    vec3 cell = floor(fp);
    vec3 frac = fract(fp);
    vec3 rnd = hash33(cell);
    // Circular micro-flake kernel inside each 3D cell (zero square voxel blocks!)
    float dFlake = length(frac - (0.22 + 0.56 * rnd));
    float flakeMask = smoothstep(0.42, 0.12, dFlake) * smoothstep(0.32, 0.68, rnd.z) * uFlakes;
    vec3 jitter = normalize(hash33(cell + 19.7) * 2.0 - 1.0);
    Nbase = normalize(mix(N, normalize(N + jitter * 0.14), flakeMask));
    flakeBoost = flakeMask * (0.45 + 0.55 * rnd.x);
  }

  float NoV = max(dot(Nbase, V), 0.001);
  float NoVcoat = max(dot(Ngeom, V), 0.001);

  vec3 baseCol = uBaseColor;
  // Subtle dry-clay mottled mineral warmth variation
  if (uClayGrain > 0.01) {
    float mott = noise3(pos * 7.5) * 0.14 - 0.07;
    baseCol *= (1.0 + mott * uClayGrain);
  }

  vec3 F0 = mix(vec3(0.04), baseCol, metal);
  vec3 diffuseColor = baseCol * (1.0 - metal);

  // Anisotropic GGX roughness axes: stretch highlight strongly along B (perpendicular to brush T)
  float alpha = max(rough * rough, 0.002);
  float at = max(alpha * (1.0 + aniso * 0.92), 0.002);
  float ab = max(alpha * (1.0 - aniso * 0.86), 0.002);

  // --- Direct Key Light: Orbiting Rectangular Area Softbox ---
  AreaLightSample key = sampleSoftboxLight(pos, Nbase, V, rough);
  float shadow = calcSoftShadow(pos + Ngeom * 0.008, key.Ldiff, 0.03, 3.6, 7.5);
  // Soften shadows slightly because softbox is a wide area light
  shadow = mix(0.10, 1.0, shadow);

  float NoLdiff = max(dot(Nbase, key.Ldiff), 0.0);
  float NoLspec = max(dot(Nbase, key.Lspec), 0.0);
  vec3  Hkey = normalize(key.Lspec + V);
  float NoH = max(dot(Nbase, Hkey), 0.0);
  float VoH = max(dot(V, Hkey), 0.0);
  float LoV = dot(key.Ldiff, V);

  // Diffuse term: blend Lambert -> Oren-Nayar based on roughness & clay grain
  float onDiff = diffuseOrenNayar(NoLdiff, NoV, LoV, rough);
  float diffBRDF = mix(1.0 / PI, onDiff, clamp(rough * 0.65 + uClayGrain * 0.5, 0.0, 1.0));
  vec3 Fkey = evalThinFilmIridescence(VoH, irid, F0);
  vec3 kD = (1.0 - Fkey) * (1.0 - metal);

  // Specular term: Anisotropic GGX with area-light energy normalization
  float atArea = min(1.0, at + key.alphaBoost * 0.55);
  float abArea = min(1.0, ab + key.alphaBoost * 0.55);
  float normArea = (at * ab) / max(atArea * abArea, 1e-5);
  float ToH = dot(T, Hkey), BoH = dot(B, Hkey);
  float ToV = dot(T, V),    BoV = dot(B, V);
  float ToL = dot(T, key.Lspec), BoL = dot(B, key.Lspec);

  float Dspec = D_GGX_Aniso(NoH, ToH, BoH, atArea, abArea) * mix(1.0, normArea, 0.55);
  float Vspec = V_SmithGGXCorrelated_Aniso(atArea, abArea, ToV, BoV, ToL, BoL, NoV, NoLspec);
  vec3  specKey = Dspec * Vspec * Fkey * NoLspec;

  // Sparkle boost for tilted microscopic aluminum flakes in Car Paint
  if (flakeBoost > 0.01) {
    float spark = pow(NoH, 110.0) * flakeBoost * 3.4 * NoLspec;
    specKey += mix(vec3(0.82, 0.92, 1.0), baseCol * 2.4 + 0.22, 0.55) * spark;
  }

  // Velvet Charlie sheen direct term (tight grazing angle so front core stays deep plush burgundy!)
  vec3 sheenKey = vec3(0.0);
  if (sheen > 0.01) {
    float Ds = D_Charlie(0.32, NoH);
    float Vs = V_Ashikhmin(NoV, NoLdiff);
    float edgeMask = pow(clamp(1.0 - NoV, 0.0, 1.0), 1.6);
    sheenKey = uSheenColor * (Ds * Vs * NoLdiff * sheen * 0.26 * (0.25 + 0.75 * edgeMask));
  }

  // Direct Clearcoat layer (independent smooth dielectric top coat on geometric normal Ngeom!)
  vec3 coatKey = vec3(0.0);
  float coatAtten = 1.0;
  if (coat > 0.01) {
    AreaLightSample keyCoat = sampleSoftboxLight(pos, Ngeom, V, 0.040);
    vec3 Hc = normalize(keyCoat.Lspec + V);
    float NoHc = max(dot(Ngeom, Hc), 0.0);
    float VoHc = max(dot(V, Hc), 0.0);
    float NoLc = max(dot(Ngeom, keyCoat.Lspec), 0.0);
    float aCoat = 0.032 * 0.032 + keyCoat.alphaBoost * 0.045;
    float Dc = D_GGX(NoHc, sqrt(aCoat));
    float Vc = V_SmithGGXCorrelated(NoVcoat, NoLc, sqrt(aCoat));
    float Fc = (0.045 + 0.955 * pow(1.0 - VoHc, 5.0)) * coat;
    coatKey = vec3(Dc * Vc * Fc * NoLc) * keyCoat.color * keyCoat.atten * shadow * 0.65;
    coatAtten = 1.0 - Fc * 0.80;
  }

  // Dampen standard dielectric specular when Velvet micro-fibers dominate (zero plastic glint on velvet!)
  specKey *= (1.0 - sheen * 0.88);
  vec3 directKey = ((diffuseColor * kD * diffBRDF * NoLdiff + specKey + sheenKey) * coatAtten)
                 * key.color * key.atten * shadow + coatKey;

  // --- Secondary Cool Rim Light (opposite side of orbiting key light) ---
  vec3 toKey = normalize(uLightPos - HERO_CENTER);
  vec3 Lrim = normalize(vec3(-toKey.x, 0.34, -toKey.z));
  vec3 rimCol = (uEnv == 0) ? vec3(0.95, 1.38, 1.95)
              : ((uEnv == 1) ? vec3(0.65, 1.05, 2.05) : vec3(2.8, 0.40, 1.95));
  float NoLrim = max(dot(Nbase, Lrim), 0.0);
  vec3 Hrim = normalize(Lrim + V);
  float NoHrim = max(dot(Nbase, Hrim), 0.0);
  float VoHrim = max(dot(V, Hrim), 0.0);
  vec3 Frim = evalThinFilmIridescence(VoHrim, irid, F0);
  float Drim = D_GGX_Aniso(NoHrim, dot(T, Hrim), dot(B, Hrim), at, ab);
  float Vrim = V_SmithGGXCorrelated_Aniso(at, ab, ToV, BoV, dot(T, Lrim), dot(B, Lrim), NoV, NoLrim);
  vec3 rimDirect = (diffuseColor * (1.0 - Frim) * (1.0 - metal) * (1.0 / PI) * NoLrim
                  + Drim * Vrim * Frim * NoLrim * (1.0 - sheen * 0.88)) * rimCol * ao;
  if (sheen > 0.01) {
    float DsR = D_Charlie(0.32, NoHrim);
    float edgeR = pow(clamp(1.0 - NoV, 0.0, 1.0), 1.4);
    rimDirect += uSheenColor * (DsR * V_Ashikhmin(NoV, NoLrim) * NoLrim * sheen * 0.55 * edgeR) * rimCol * ao;
  }

  // --- Procedural HDR IBL (Diffuse + Anisotropic Specular + Clearcoat + Velvet Rim) ---
  vec3 envDiff = evalEnvDiffuse(Nbase, uEnv);
  vec3 Fibl = evalThinFilmIridescence(NoV, irid, F0);
  vec3 kDibl = (1.0 - Fibl) * (1.0 - metal);
  vec3 iblDiff = diffuseColor * kDibl * envDiff * ao;

  // Anisotropic multi-tap IBL reflection fan (visibly streaks rectangular softbox along brushed metal!)
  vec3 envSpec = vec3(0.0);
  if (aniso > 0.06) {
    // Bend normal along tangent/bitangent to emulate anisotropic lobe in IBL
    float spread = aniso * rough * 0.72;
    vec3 acc = vec3(0.0);
    for (int k = -2; k <= 2; k++) {
      float f = float(k) * 0.5;
      vec3 nTap = normalize(Nbase + B * (f * spread));
      vec3 rTap = reflect(-V, nTap);
      float w = (k == 0) ? 0.30 : ((abs(k) == 1) ? 0.23 : 0.12);
      acc += evalEnvLight(rTap, rough * (1.0 - aniso * 0.45), uEnv) * w;
    }
    envSpec = acc;
  } else {
    vec3 R = reflect(-V, Nbase);
    envSpec = evalEnvLight(R, rough, uEnv);
  }

  // Specular occlusion inside deep cavities (Lagarde formula prevents glowing crevices!)
  float specAO = clamp(pow(NoV + ao, exp2(-16.0 * rough - 1.0)) - 1.0 + ao, 0.08, 1.0);
  // Roughness-attenuated Fresnel for IBL
  vec3 FiblRough = mix(fresnelSchlickRoughness(NoV, F0, rough), Fibl, clamp(irid * 1.2 + metal * 0.6, 0.0, 1.0));
  vec3 iblSpec = envSpec * FiblRough * specAO * mix(0.85, 1.08, metal) * (1.0 - sheen * 0.85);

  // Subtle metallic flake IBL twinkle in Car Paint
  if (flakeBoost > 0.01) {
    vec3 rFlake = reflect(-V, Nbase);
    vec3 fEnv = evalEnvLight(rFlake, 0.12, uEnv);
    iblSpec += fEnv * flakeBoost * 0.28 * mix(vec3(0.88, 0.94, 1.0), baseCol * 2.2, 0.55) * specAO;
  }

  // Velvet grazing sheen IBL halo: DEEP dark plush center + luminous bright silhouette & bevel rims!
  vec3 iblSheen = vec3(0.0);
  if (sheen > 0.01) {
    float grazTight = pow(clamp(1.0 - NoV, 0.0, 1.0), 3.6);
    float grazMid   = pow(clamp(1.0 - NoV, 0.0, 1.0), 2.1) * 0.16;
    float nap = 0.88 + 0.24 * noise3(pos * 145.0);
    vec3 rimEnv = mix(vec3(0.45, 0.42, 0.46), evalEnvLight(reflect(-V, Nbase), 0.72, uEnv), 0.45);
    iblSheen = uSheenColor * (grazTight * 1.35 + grazMid) * rimEnv * nap * sheen * ao;
    // Deep velvet light-trap absorption head-on so center stays dark, rich royal burgundy!
    float headOnTrap = mix(1.0, 0.36 + 0.64 * pow(1.0 - NoV, 1.5), sheen);
    iblDiff *= headOnTrap;
    directKey *= mix(1.0, 0.48 + 0.52 * pow(1.0 - NoV, 1.2), sheen);
  }

  // Clearcoat IBL specular (razor-sharp crisp rectangular softbox gliding cleanly on top!)
  vec3 iblCoat = vec3(0.0);
  float iblCoatAtten = 1.0;
  if (coat > 0.01) {
    vec3 Rc = reflect(-V, Ngeom);
    float Fc = (0.048 + 0.952 * pow(1.0 - NoVcoat, 5.0)) * coat;
    float coatSpecAO = clamp(pow(NoVcoat + ao, exp2(-1.35)) - 1.0 + ao, 0.15, 1.0);
    iblCoat = evalEnvLight(Rc, 0.030, uEnv) * Fc * coatSpecAO * 1.32;
    iblCoatAtten = 1.0 - Fc * 0.75;
  }

  vec3 color = directKey + rimDirect * coatAtten + (iblDiff + iblSpec + iblSheen) * iblCoatAtten + iblCoat;
  return color;
}

// ---------- Studio Floor & Machined Base Plinth Shading ----------
vec3 shadeFloor(vec3 pos, vec3 V, vec3 backdropCol) {
  vec3 N = vec3(0.0, 1.0, 0.0);
  float distOrigin = length(pos.xz);
  float ao = calcAO(pos, N);
  vec3 L = normalize(uLightPos - pos);
  float sh = calcSoftShadow(pos + vec3(0.0, 0.01, 0.0), L, 0.04, 4.8, 5.2);
  sh = mix(0.14, 1.0, sh);

  vec3 floorAlbedo = (uEnv == 0) ? vec3(0.036, 0.040, 0.050)
                   : ((uEnv == 1) ? vec3(0.048, 0.036, 0.030) : vec3(0.022, 0.020, 0.038));

  // Subtle precision studio turntable calibration rings around base
  float ring1 = smoothstep(0.008, 0.0, abs(distOrigin - 0.96)) * 0.022;
  float ring2 = smoothstep(0.006, 0.0, abs(distOrigin - 1.48)) * 0.014;
  floorAlbedo += vec3(ring1 + ring2);

  float NoL = max(dot(N, L), 0.0);
  vec3 keyCol = (uEnv == 0) ? vec3(2.4, 2.35, 2.25)
              : ((uEnv == 1) ? vec3(3.1, 1.75, 0.75) : vec3(0.65, 2.25, 2.85));

  vec3 col = floorAlbedo * (evalEnvDiffuse(N, uEnv) * ao + keyCol * NoL * sh * 0.42);

  // Subtle satin specular sheen from softbox & subtle grounded reflection of hero object
  vec3 R = reflect(-V, N);
  float F = 0.03 + 0.22 * pow(1.0 - max(dot(N, V), 0.0), 4.0);
  vec3 reflCol = evalEnvLight(R, 0.36, uEnv) * 0.38;

  // Fast 1-bounce glossy floor reflection of hero object (huge studio realism boost!)
  if (distOrigin < 2.2) {
    vec2 rHit = raymarch(pos + vec3(0.0, 0.012, 0.0), R, 3.2);
    if (rHit.y > 0.5) {
      vec3 rp = pos + R * rHit.x;
      vec3 rN = calcNormal(rp);
      vec3 rEnv = evalEnvLight(reflect(R, rN), max(uRoughness, 0.22), uEnv);
      vec3 heroGlow = mix(uBaseColor * 0.45, rEnv * mix(vec3(0.45), uBaseColor, uMetallic), 0.55);
      if (uIridescence > 0.1) heroGlow *= evalThinFilmIridescence(max(dot(rN, -R), 0.05), uIridescence, vec3(0.8));
      reflCol = mix(reflCol, heroGlow, 0.72 * exp(-rHit.x * 0.55));
    }
  }

  col += reflCol * F * ao * sh;

  // Seamless cyclorama fade into exact studio backdrop color (100% zero horizon seam!)
  float fog = smoothstep(2.0, 7.2, distOrigin);
  return mix(col, backdropCol, fog);
}

vec3 shadePlinth(vec3 pos, vec3 N, vec3 V) {
  float ao = calcAO(pos, N);
  vec3 base = vec3(0.045, 0.048, 0.056);
  vec3 L = normalize(uLightPos - pos);
  float NoL = max(dot(N, L), 0.0);
  vec3 H = normalize(L + V);
  float spec = pow(max(dot(N, H), 0.0), 48.0) * 0.25;
  vec3 R = reflect(-V, N);
  float F = 0.04 + 0.30 * pow(1.0 - max(dot(N, V), 0.0), 5.0);
  return base * (evalEnvDiffuse(N, uEnv) * ao + NoL * 0.65)
       + evalEnvLight(R, 0.34, uEnv) * F * ao * 0.45
       + vec3(spec) * ao;
}

// ACES Filmic Tone Mapping (Stephen Hill / Narkowicz fitted curve)
vec3 acesToneMap(vec3 x) {
  const float a = 2.51;
  const float b = 0.03;
  const float c = 2.43;
  const float d = 0.59;
  const float e = 0.14;
  return clamp((x * (a * x + b)) / (x * (c * x + d) + e), 0.0, 1.0);
}

void main() {
  vec2 ndc = vUv * 2.0 - 1.0;
  vec3 rd = normalize(
    uCamFwd +
    uCamRight * (ndc.x * uAspect * uTanHalfFov) +
    uCamUp    * (ndc.y * uTanHalfFov)
  );
  vec3 ro = uCamPos;

  // Dark neutral photography studio cyclorama backdrop (zero distracting horizon seam or glare blotches)
  vec3 backdropCol = evalStudioBackdrop(rd, uEnv);
  float centerGlow = exp(-dot(ndc * vec2(uAspect * 0.75, 1.0), ndc * vec2(uAspect * 0.75, 1.0)) * 1.6);
  vec3 glowTint = (uEnv == 0) ? vec3(0.032, 0.037, 0.048)
                : ((uEnv == 1) ? vec3(0.075, 0.038, 0.018) : vec3(0.032, 0.018, 0.070));
  backdropCol += glowTint * centerGlow;
  vec3 col = backdropCol;

  vec2 hit = raymarch(ro, rd, 22.0);
  bool isLeftSplit = (uSplitX > 0.0 && vUv.x < uSplitX);

  if (hit.y >= 0.0) {
    vec3 pos = ro + rd * hit.x;
    vec3 V = -rd;
    if (hit.y < 0.5) {
      col = shadeFloor(pos, V, backdropCol);
    } else if (hit.y > 1.5) {
      vec3 N = calcNormal(pos);
      col = shadePlinth(pos, N, V);
    } else {
      vec3 N = calcNormal(pos);
      vec3 T, B;
      calcTangentFrame(pos, N, T, B);
      float ao = calcAO(pos, N);

      if (isLeftSplit) {
        // Split left side ALWAYS shows legacy 2005 Blinn-Phong for instant side-by-side proof!
        col = evalPhong2005(pos, N, V, uBaseColor);
      } else {
        vec3 pbrCol = evalPbrMaterial(pos, N, V, T, B, ao);
        if (uPhongMix > 0.001) {
          vec3 oldCol = evalPhong2005(pos, N, V, uBaseColor);
          col = mix(pbrCol, oldCol, uPhongMix);
        } else {
          col = pbrCol;
        }
      }
    }
  }

  // Subtle studio softbox handle indicator (visible only when HUD is active so user can drag the light!)
  if (uShowLightHandle > 0.5) {
    vec3 toLight = uLightPos - ro;
    float zCam = dot(toLight, uCamFwd);
    if (zCam > 0.25) {
      float lx = dot(toLight, uCamRight) / (zCam * uAspect * uTanHalfFov);
      float ly = dot(toLight, uCamUp)    / (zCam * uTanHalfFov);
      vec2 lUv = vec2(lx, ly) * 0.5 + 0.5;
      vec2 dPx = (vUv - lUv) * uRes;
      float rPx = length(dPx);
      float ring = smoothstep(2.0, 0.6, abs(rPx - 13.0)) * 0.72;
      float core = smoothstep(4.5, 1.5, rPx) * 0.95;
      // Subtle amber-white studio light marker (never dominates the frame)
      vec3 markerCol = (uEnv == 2) ? vec3(0.35, 0.95, 1.0) : vec3(1.0, 0.82, 0.48);
      col = mix(col, markerCol * 1.6, clamp(ring + core, 0.0, 0.85));
    }
  }

  // ACES Filmic tone mapping + sRGB gamma + subtle dither to eliminate 8-bit studio gradient banding
  col = acesToneMap(col * 1.08);
  col = pow(col, vec3(1.0 / 2.2));
  col += (hash12(gl_FragCoord.xy + fract(uTime) * 17.0) - 0.5) / 255.0;

  // Crisp amber split divider line when Split vs 2005 Phong is active
  if (uSplitX > 0.0) {
    float dx = abs(vUv.x - uSplitX) * uRes.x;
    if (dx < 1.25) {
      col = mix(col, vec3(0.93, 0.65, 0.37), smoothstep(1.25, 0.4, dx));
    }
  }

  fragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
}
`;
