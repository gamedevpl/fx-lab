// GLSL ES 3.00 shaders for Evolution of Toon & NPR Shading (1996-2026):
// 1. SKY_FS        — Era-styled procedural sky backdrop (cel clouds, blueprint, desert, anime, comic, painterly)
// 2. SHADOW_VS/FS  — 1024x1024 shadow map with shared smooth/stepped vertex animation
// 3. SCENE_VS/FS   — MRT G-buffer pass (Color, NormDepth, Aux) covering all 8 NPR lighting models
// 4. HULL_VS/FS    — Authentic back-face-culled Inverted Hull geometry extrusion (2000 Cel-Shaded Games Era)
// 5. TENSOR_FS     — Structure Tensor (Sobel gradients + Gaussian smooth) for Anisotropic Kuwahara (2026)
// 6. FINAL_FS      — Post-process NPR: Decaudin discontinuity edges, Gooch technical ink, Borderlands Sobel + hatching,
//                    Guilty Gear Xrd tinted contour, Spider-Verse Ben-Day halftone + shadow hatching + CMYK offset,
//                    and 8-sector Anisotropic Kuwahara painterly oil brushstrokes!

// Shared procedural animation helper injected into SHADOW_VS, SCENE_VS and HULL_VS
const ANIM_GLSL = `
void animateDiorama(inout vec3 p, inout vec3 n, inout vec3 en, vec2 uv, float grp, float t) {
  float hover = sin(t * 1.15) * 0.032;
  if (grp < 0.5) {
    // 0: Floating mossy stone pedestal
    p.y += hover;
  } else if (grp < 1.5) {
    // 1: Sentinel torso & helmet (subtle heroic breathing & proud poise)
    float breath = sin(t * 2.1) * 0.016;
    float sway = sin(t * 1.15 + 0.5) * 0.045;
    p.y += hover + breath * smoothstep(0.2, 1.5, p.y);
    float c = cos(sway), s = sin(sway);
    mat2 rotY = mat2(c, -s, s, c);
    p.xz = rotY * p.xz;
    n.xz = rotY * n.xz;
    en.xz = rotY * en.xz;
  } else if (grp < 2.5) {
    // 2: Flowing crimson scarf streaming in wind (uv.x = 0 at neck -> 1 at tip)
    float k = uv.x;
    float wave1 = sin(t * 4.4 - k * 5.2) * 0.20 * k * k;
    float wave2 = cos(t * 3.1 - k * 3.6) * 0.14 * k;
    float flutter = sin(t * 7.8 - k * 9.5) * 0.04 * k * k;
    p.y += hover + wave2 * 0.55 + flutter;
    p.z += wave1;
    p.x += sin(t * 2.2 - k * 2.5) * 0.05 * k;
    // Perturb scarf normal along travelling wave so cel shadow bands ripple cleanly across the cloth!
    float dw = cos(t * 4.4 - k * 5.2) * 0.55 * k;
    n = normalize(n + vec3(0.0, dw * 0.35, dw));
    en = n;
  } else {
    // 3, 4, 5: Three orbiting arcane crystal shards (wide ring so they frame the sentinel without crossing its eyes!)
    float idx = floor(grp - 2.5); // 0, 1, 2
    float ang = t * (0.85 + idx * 0.12) + idx * 2.0944 + 0.55;
    float rad = 1.54 + 0.12 * sin(t * 1.5 + idx * 2.1);
    float cy = 1.15 + idx * 0.36 + sin(t * 2.3 + idx * 1.9) * 0.20 + hover;
    // Spin shard on its own axis
    float sp = t * (2.2 + idx * 0.5) + idx;
    float cs = cos(sp), ss = sin(sp);
    mat2 spin = mat2(cs, -ss, ss, cs);
    p.xz = spin * p.xz;
    n.xz = spin * n.xz;
    en.xz = spin * en.xz;
    // Gentle tilt
    float tl = 0.22 * sin(t * 1.8 + idx);
    float ct = cos(tl), st = sin(tl);
    p.xy = mat2(ct, -st, st, ct) * p.xy;
    n.xy = mat2(ct, -st, st, ct) * n.xy;
    en.xy = n.xy;
    // Place on 3D orbit ring slightly behind center plane when passing front
    p += vec3(cos(ang) * rad, cy, sin(ang) * rad * 0.78 - 0.18);
  }
}
`;

// ============================================================================
// 1. ERA-STYLED SKY BACKDROP (renders into MRT so Kuwahara/Halftone see rich sky!)
// ============================================================================
export const SKY_FS = `#version 300 es
precision highp float;
precision highp int;

in vec2 vUv;
uniform vec3 uCamRight;
uniform vec3 uCamUp;
uniform vec3 uCamFwd;
uniform float uTanHalfFov;
uniform float uAspect;
uniform vec3 uLightDir;
uniform float uTime;
uniform int uStage;
uniform float uSolidLeft;

layout(location = 0) out vec4 outColor;
layout(location = 1) out vec4 outNormDepth;
layout(location = 2) out vec4 outAux;

float hash21(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(hash21(i), hash21(i + vec2(1.0, 0.0)), f.x),
    mix(hash21(i + vec2(0.0, 1.0)), hash21(i + vec2(1.0, 1.0)), f.x),
    f.y
  );
}
float fbm(vec2 p) {
  float v = 0.0, a = 0.5;
  for (int i = 0; i < 4; i++) { v += a * vnoise(p); p *= 2.03; a *= 0.5; }
  return v;
}

void main() {
  vec2 ndc = vUv * 2.0 - 1.0;
  vec3 rd = normalize(uCamFwd + ndc.x * uAspect * uTanHalfFov * uCamRight + ndc.y * uTanHalfFov * uCamUp);
  float h = clamp(rd.y * 0.5 + 0.5, 0.0, 1.0);
  float sunDot = max(dot(rd, normalize(uLightDir)), 0.0);
  // Seamless 360-deg non-mirrored sky cloud coordinates (zero vertical seam AND zero horizon mirror!)
  vec2 skyUv = vec2(rd.x * 1.9 + rd.z * 0.65, rd.y * 2.4 - 0.25) + vec2(uTime * 0.035, 0.0);
  float cl = fbm(skyUv * 1.65);

  vec3 col = vec3(0.2);
  if (uStage == 0 && uSolidLeft > 0.5) {
    // Classic 1996 smooth Gouraud/OpenGL studio grey-blue gradient
    col = mix(vec3(0.18, 0.21, 0.28), vec3(0.38, 0.48, 0.66), h);
  } else if (uStage == 0) {
    // 1996 Decaudin INRIA: clean cel-animation sky + flat cut cartoon clouds
    col = mix(vec3(0.56, 0.78, 0.96), vec3(0.24, 0.52, 0.88), smoothstep(0.35, 0.90, h));
    float cMask = step(0.56, cl) * smoothstep(0.38, 0.55, h);
    col = mix(col, vec3(0.96, 0.97, 0.99), cMask * 0.92);
  } else if (uStage == 1) {
    // 1998 Gooch SIGGRAPH: crisp technical illustration paper backdrop with faint drafting grid
    col = mix(vec3(0.84, 0.86, 0.90), vec3(0.94, 0.92, 0.87), h);
    vec2 g = abs(fract(vUv * vec2(24.0 * uAspect, 24.0) - 0.5) - 0.5);
    float grid = 1.0 - smoothstep(0.015, 0.035, min(g.x, g.y));
    col = mix(col, vec3(0.72, 0.77, 0.85), grid * 0.35);
  } else if (uStage == 2) {
    // 2000 Cel-Shaded Games Era (Dreamcast / Jet Set Radio): bold electric cyan-yellow street sky!
    col = mix(vec3(0.98, 0.88, 0.42), vec3(0.12, 0.66, 0.94), smoothstep(0.32, 0.78, h));
    col = mix(col, vec3(1.0, 0.98, 0.86), step(0.965, sunDot));
  } else if (uStage == 3) {
    // 2002 Wind Waker Style: vibrant azure sea-sky + bright stylized puffy cel clouds
    col = mix(vec3(0.52, 0.86, 0.98), vec3(0.10, 0.44, 0.88), smoothstep(0.30, 0.88, h));
    float cBand = smoothstep(0.50, 0.54, cl) * smoothstep(0.35, 0.52, h);
    float cShade = smoothstep(0.56, 0.60, cl);
    col = mix(col, mix(vec3(0.78, 0.91, 0.98), vec3(1.0, 1.0, 0.98), cShade), cBand);
    col += vec3(0.18, 0.16, 0.06) * pow(sunDot, 10.0);
  } else if (uStage == 4) {
    // 2009 Borderlands Style: dusty Pandora warm gold-terracotta horizon & turquoise zenith
    col = mix(vec3(0.88, 0.58, 0.30), vec3(0.24, 0.52, 0.66), smoothstep(0.32, 0.86, h));
    float cBand = smoothstep(0.52, 0.64, cl) * smoothstep(0.36, 0.58, h);
    col = mix(col, vec3(0.96, 0.84, 0.64), cBand * 0.65);
  } else if (uStage == 5) {
    // 2014 Guilty Gear Xrd: dramatic anime indigo-to-peach arena sky with crisp diagonal light beams!
    col = mix(vec3(0.96, 0.56, 0.42), vec3(0.14, 0.24, 0.56), smoothstep(0.28, 0.82, h));
    float beam = smoothstep(0.55, 0.62, sin((vUv.x * 2.2 - vUv.y * 1.1) * 9.0) * 0.5 + 0.5);
    col += vec3(0.10, 0.08, 0.14) * beam * h;
  } else if (uStage == 6) {
    // 2018 Spider-Verse Style: punchy comic magenta-violet twilight sky with golden horizon pop!
    col = mix(vec3(0.96, 0.28, 0.52), vec3(0.12, 0.14, 0.38), smoothstep(0.26, 0.82, h));
    float sunPop = smoothstep(0.92, 0.95, sunDot);
    col = mix(col, vec3(1.0, 0.86, 0.28), sunPop * 0.85);
  } else {
    // 2026 Painterly Anisotropic Kuwahara: lush impressionist sunset-indigo sky with bold cloud swirls
    vec3 low = vec3(0.96, 0.58, 0.36);
    vec3 mid = vec3(0.34, 0.42, 0.72);
    vec3 top = vec3(0.11, 0.18, 0.42);
    col = mix(low, mid, smoothstep(0.24, 0.58, h));
    col = mix(col, top, smoothstep(0.58, 0.94, h));
    float cSwirl = fbm(skyUv * 2.2 + vec2(cl * 1.1, -cl * 0.6));
    vec3 cCol = mix(vec3(0.56, 0.44, 0.64), vec3(1.0, 0.86, 0.66), smoothstep(0.45, 0.72, cSwirl));
    col = mix(col, cCol, smoothstep(0.46, 0.68, cSwirl) * 0.85);
    col += vec3(0.35, 0.22, 0.10) * pow(sunDot, 6.0);
  }

  outColor = vec4(col, 1.0);
  outNormDepth = vec4(0.0, 0.0, 1.0, 99.0); // Depth 99 marks sky!
  outAux = vec4(0.85, 0.0, 1.0, 0.0);      // matId 0 = sky
}
`;

// ============================================================================
// 2. 1024x1024 SHADOW MAP PASS (for razor-sharp cel cast shadows!)
// ============================================================================
export const SHADOW_VS = `#version 300 es
precision highp float;
precision highp int;

layout(location = 0) in vec3 aPos;
layout(location = 1) in vec3 aNorm;
layout(location = 2) in vec3 aEditNorm;
layout(location = 3) in vec2 aUv;
layout(location = 4) in vec3 aColor;
layout(location = 5) in vec4 aMeta;

uniform mat4 uLightVP;
uniform float uAnimTime;

` + ANIM_GLSL + `

void main() {
  vec3 p = aPos, n = aNorm, en = aEditNorm;
  animateDiorama(p, n, en, aUv, aMeta.w, uAnimTime);
  gl_Position = uLightVP * vec4(p, 1.0);
}
`;

export const SHADOW_FS = `#version 300 es
precision highp float;
void main() {}
`;

// ============================================================================
// 3. MAIN MRT SCENE PASS (Color + NormDepth + Aux) — ALL 8 NPR ERAS
// ============================================================================
export const SCENE_VS = `#version 300 es
precision highp float;
precision highp int;

layout(location = 0) in vec3 aPos;
layout(location = 1) in vec3 aNorm;
layout(location = 2) in vec3 aEditNorm;
layout(location = 3) in vec2 aUv;
layout(location = 4) in vec3 aColor;
layout(location = 5) in vec4 aMeta;

uniform mat4 uViewProj;
uniform mat4 uLightVP;
uniform vec3 uCamPos;
uniform float uAnimTime;

out vec3 vWorldPos;
out vec3 vNorm;
out vec3 vEditNorm;
out vec2 vUv;
out vec3 vColor;
out vec4 vMeta;
out vec4 vShadowPos;
out float vCamDist;

` + ANIM_GLSL + `

void main() {
  vec3 p = aPos, n = aNorm, en = aEditNorm;
  animateDiorama(p, n, en, aUv, aMeta.w, uAnimTime);
  vWorldPos = p;
  vNorm = normalize(n);
  vEditNorm = normalize(en);
  vUv = aUv;
  vColor = aColor;
  vMeta = aMeta;
  vShadowPos = uLightVP * vec4(p + normalize(n) * 0.025, 1.0);
  vCamDist = length(p - uCamPos);
  gl_Position = uViewProj * vec4(p, 1.0);
}
`;

export const SCENE_FS = `#version 300 es
precision highp float;
precision highp int;

in vec3 vWorldPos;
in vec3 vNorm;
in vec3 vEditNorm;
in vec2 vUv;
in vec3 vColor;
in vec4 vMeta;
in vec4 vShadowPos;
in float vCamDist;

uniform sampler2D uShadowMap;
uniform vec3 uLightDir;
uniform vec3 uCamPos;
uniform int uStage;
uniform float uSolidLeft;    // Step 1 Left: smooth 1996 Gouraud/Phong baseline
uniform float uUseRawNorms;  // Step 6 toggle: show raw 3D normals vs artist-edited anime normals!

layout(location = 0) out vec4 outColor;
layout(location = 1) out vec4 outNormDepth;
layout(location = 2) out vec4 outAux;

float sampleShadow(vec4 sp, float bias) {
  vec3 p = sp.xyz / max(sp.w, 1e-4) * 0.5 + 0.5;
  if (p.x < 0.0 || p.x > 1.0 || p.y < 0.0 || p.y > 1.0 || p.z > 1.0) return 1.0;
  float sum = 0.0;
  vec2 tx = vec2(1.0 / 1024.0);
  for (int dy = -1; dy <= 1; dy++) {
    for (int dx = -1; dx <= 1; dx++) {
      float d = texture(uShadowMap, p.xy + vec2(float(dx), float(dy)) * tx * 1.1).r;
      sum += (p.z - bias <= d) ? 1.0 : 0.0;
    }
  }
  return sum / 9.0;
}

float hash21(vec2 p) {
  p = fract(p * vec2(127.1, 311.7));
  p += dot(p, p + 19.19);
  return fract(p.x * p.y);
}

void main() {
  vec3 rawN = normalize(vNorm);
  if (!gl_FrontFacing) rawN = -rawN;
  vec3 edN = normalize(vEditNorm);
  if (!gl_FrontFacing) edN = -edN;

  // Guilty Gear Xrd (Stage 5) & Spider-Verse (Stage 6) benefit from artist-edited anime normals (toggleable in Stage 5!)
  bool useEdited = (uStage == 5 && uUseRawNorms < 0.5) || (uStage == 6);
  vec3 N = useEdited ? edN : rawN;
  vec3 L = normalize(uLightDir);
  vec3 V = normalize(uCamPos - vWorldPos);
  vec3 H = normalize(L + V);

  float ndl = dot(N, L);
  float ndv = max(dot(N, V), 0.0);
  float ndh = max(dot(N, H), 0.0);
  float sh = sampleShadow(vShadowPos, 0.0045);

  vec3 alb = vColor;
  float matId = vMeta.x;
  float ilmAO = vMeta.y;
  float innerLine = vMeta.z;

  // Detect glowing visor eyes & arcane crystals (stay luminous across all eras!)
  bool isEmissive = (matId > 0.46) || (alb.b > 0.95 && alb.g > 0.90 && alb.r < 0.45);
  vec3 col = alb;
  float shadeTone = clamp(ndl * 0.5 + 0.5, 0.0, 1.0);

  if (uStage == 0 && uSolidLeft > 0.5) {
    // 1996 Smooth 3D Baseline (classic Gouraud / Blinn-Phong plastic shading — BEFORE toon!)
    float diff = max(ndl, 0.0);
    float spec = pow(ndh, 28.0) * 0.45;
    col = alb * (0.24 + 0.78 * diff * (0.35 + 0.65 * sh)) + vec3(spec * sh);
    shadeTone = diff;
  } else if (uStage == 0) {
    // ERA 1 (1996): Philippe Decaudin (INRIA) — flat 2-tone cartoon shading + crisp hard shadow cutoff!
    float lit = step(0.14, ndl * (0.25 + 0.75 * sh));
    vec3 darkCol = alb * vec3(0.46, 0.48, 0.58);
    vec3 litCol = alb * 1.04;
    col = mix(darkCol, litCol, lit);
    shadeTone = lit;
  } else if (uStage == 1) {
    // ERA 2 (1998): Gooch Warm-to-Cool Technical Illustration (SIGGRAPH 1998)!
    // Cool blue shadows + warm amber highlights keep black ink lines 100% legible everywhere!
    float t = clamp(0.5 + 0.5 * ndl, 0.0, 1.0);
    vec3 kCool = vec3(0.10, 0.24, 0.56) + 0.38 * alb;
    vec3 kWarm = vec3(0.42, 0.32, 0.08) + 0.68 * alb;
    col = mix(kCool, kWarm, t * (0.45 + 0.55 * sh));
    col += vec3(0.95) * smoothstep(0.92, 0.95, ndh) * sh * 0.75;
    shadeTone = t;
  } else if (uStage == 2) {
    // ERA 3 (2000): Early Cel-Shaded Games (Jet Set Radio Era) — 1D 3-band toon ramp + punchy arcade color!
    float val = (ndl * 0.5 + 0.5) * (0.32 + 0.68 * sh);
    float band = (val > 0.62) ? 1.06 : ((val > 0.34) ? 0.72 : 0.44);
    vec3 tint = (val > 0.62) ? vec3(1.04, 1.02, 0.96) : vec3(0.86, 0.90, 1.08);
    col = alb * band * tint;
    col += vec3(0.32) * step(0.91, ndh) * sh;
    shadeTone = val;
  } else if (uStage == 3) {
    // ERA 4 (2002): Wind Waker Style — lush saturated 2-tone cel ramp, crisp turquoise shadows & clean white spec!
    float lit = smoothstep(0.06, 0.11, ndl * sh - 0.04);
    vec3 shadowCol = alb * vec3(0.44, 0.56, 0.74);
    vec3 brightCol = pow(alb, vec3(0.88)) * vec3(1.08, 1.05, 0.96);
    col = mix(shadowCol, brightCol, lit);
    // Clean Wind Waker bright specular cap & sky bounce rim
    float specBand = smoothstep(0.90, 0.93, ndh) * lit;
    col = mix(col, vec3(1.0, 0.99, 0.92), specBand * 0.55);
    col += vec3(0.12, 0.22, 0.28) * pow(1.0 - ndv, 3.0) * (1.0 - lit);
    shadeTone = lit;
  } else if (uStage == 4) {
    // ERA 5 (2009): Borderlands Style — bold comic cel shading with painted grit & shadow contrast!
    float val = ndl * (0.28 + 0.72 * sh);
    float b1 = smoothstep(-0.08, 0.02, val);
    float b2 = smoothstep(0.42, 0.50, val);
    vec3 darkC = alb * vec3(0.38, 0.34, 0.36);
    vec3 midC  = alb * vec3(0.86, 0.82, 0.76);
    vec3 hiC   = alb * vec3(1.12, 1.06, 0.96);
    col = mix(darkC, midC, b1);
    col = mix(col, hiC, b2);
    // Subtle hand-painted texture grain + edge bevel scratches along UV seams
    float grain = hash21(floor(vUv * 42.0)) * 0.08 - 0.04;
    col *= (1.0 + grain);
    col = mix(col, vec3(0.08, 0.07, 0.09), innerLine * 0.65);
    col += vec3(0.28) * smoothstep(0.90, 0.93, ndh) * b2;
    shadeTone = clamp(val * 0.5 + 0.5, 0.0, 1.0);
  } else if (uStage == 5) {
    // ERA 6 (2014): Guilty Gear Xrd (Motomura, GDC 2015) — artist-edited normals, ILM AO/Spec & UV inner ink lines!
    // ILM green channel hardcodes shadow threshold under chin & brow; sharp 2D anime cut!
    float ilmVal = (ndl * 0.5 + 0.5) * mix(0.45, 1.0, ilmAO) * (0.35 + 0.65 * sh);
    float lit = step(0.48, ilmVal);
    // Signature anime saturated shadow shift (warmer/deeper hue, NEVER muddy grey!)
    vec3 animeShadow = pow(alb, vec3(1.22)) * vec3(0.54, 0.46, 0.68);
    vec3 animeLit = pow(alb, vec3(0.92)) * vec3(1.06, 1.03, 0.98);
    col = mix(animeShadow, animeLit, lit);
    // Hard-edged anime specular highlight controlled by ILM mask
    float specCut = step(0.88, ndh * ilmAO) * lit;
    col = mix(col, vec3(1.0, 0.98, 0.92), specCut * 0.68);
    // Crisp axis-aligned UV inner ink lines (Motomura's signature non-aliased interior line trick!)
    vec3 inkTint = alb * 0.14;
    col = mix(col, inkTint, clamp(innerLine * 0.95, 0.0, 1.0));
    shadeTone = lit;
  } else if (uStage == 6) {
    // ERA 7 (2018): Spider-Verse Style — bold graphic comic lighting feeding Ben-Day halftone & shadow hatching!
    float val = (ndl * 0.5 + 0.5) * mix(0.55, 1.0, ilmAO) * (0.32 + 0.68 * sh);
    float lit = smoothstep(0.42, 0.48, val);
    vec3 deepShadow = pow(alb, vec3(1.18)) * vec3(0.42, 0.34, 0.66);
    vec3 keyLit = pow(alb, vec3(0.86)) * vec3(1.12, 1.04, 0.94);
    col = mix(deepShadow, keyLit, lit);
    // Electric magenta-cyan comic bounce rim light!
    float rim = smoothstep(0.60, 0.72, 1.0 - ndv);
    col += mix(vec3(0.95, 0.16, 0.52), vec3(0.14, 0.86, 0.98), step(0.0, vWorldPos.x)) * rim * 0.42;
    col = mix(col, vec3(0.05, 0.04, 0.09), innerLine * 0.85);
    shadeTone = clamp(val, 0.0, 1.0);
  } else {
    // ERA 8 (2026): Painterly Anisotropic Kuwahara (inspired by hand-painted 3D / Arcane!)
    // Rich warm key + cool cobalt-violet shadow + subtle brush pigment dabs so Kuwahara locks onto vivid impasto strokes!
    float d = clamp(ndl * 0.5 + 0.5, 0.0, 1.0);
    float lit = smoothstep(0.30, 0.64, d * (0.35 + 0.65 * sh) * mix(0.65, 1.0, ilmAO));
    // Multi-scale painted pigment brush variation across 3D surface before Kuwahara smoothing!
    float dab1 = hash21(floor(vWorldPos.xy * 11.0 + vWorldPos.z * 7.0)) - 0.5;
    float dab2 = hash21(floor(vWorldPos.yz * 19.0 - vWorldPos.x * 13.0)) - 0.5;
    vec3 paintAlb = alb * (1.0 + vec3(dab1 * 0.16, dab2 * 0.14, (dab1 - dab2) * 0.12));
    vec3 coolShadow = paintAlb * vec3(0.36, 0.44, 0.72) + vec3(0.03, 0.04, 0.11);
    vec3 warmMid = paintAlb * vec3(1.08, 0.97, 0.85);
    vec3 goldHi = paintAlb * vec3(1.26, 1.12, 0.88) + vec3(0.10, 0.06, 0.01);
    col = mix(coolShadow, warmMid, lit);
    col = mix(col, goldHi, smoothstep(0.70, 0.90, d * sh));
    col += vec3(1.0, 0.86, 0.60) * pow(ndh, 16.0) * sh * 0.52;
    col += vec3(0.98, 0.52, 0.30) * pow(1.0 - ndv, 2.5) * (0.28 + 0.58 * lit);
    col = mix(col, alb * 0.20, innerLine * 0.55);
    shadeTone = lit;
  }

  if (isEmissive) {
    col = mix(col, alb * 1.28 + vec3(0.12), 0.72);
    shadeTone = 1.0;
  }

  outColor = vec4(col, 1.0);
  outNormDepth = vec4(rawN, vCamDist);
  outAux = vec4(shadeTone, matId, sh, innerLine);
}
`;

// ============================================================================
// 4. AUTHENTIC GEOMETRIC INVERTED HULL OUTLINE PASS (2000 Cel-Shaded Games Era!)
// Rendered with gl.cullFace(gl.FRONT) -> extrudes back-faces along smooth normal!
// ============================================================================
export const HULL_VS = `#version 300 es
precision highp float;
precision highp int;

layout(location = 0) in vec3 aPos;
layout(location = 1) in vec3 aNorm;
layout(location = 2) in vec3 aEditNorm;
layout(location = 3) in vec2 aUv;
layout(location = 4) in vec3 aColor;
layout(location = 5) in vec4 aMeta;

uniform mat4 uViewProj;
uniform vec3 uCamPos;
uniform float uAnimTime;
uniform float uHullScale;

out float vCamDist;

` + ANIM_GLSL + `

void main() {
  vec3 p = aPos, n = aNorm, en = aEditNorm;
  animateDiorama(p, n, en, aUv, aMeta.w, uAnimTime);
  // Distance-compensated vertex extrusion along smooth normal (classic inverted hull!)
  float dist = length(p - uCamPos);
  vec3 extrudeDir = normalize(mix(n, en, 0.45));
  p += extrudeDir * (uHullScale * clamp(dist * 0.17, 0.7, 1.5));
  vCamDist = length(p - uCamPos);
  gl_Position = uViewProj * vec4(p, 1.0);
}
`;

export const HULL_FS = `#version 300 es
precision highp float;
precision highp int;

in float vCamDist;
uniform float uShowHull; // Toggle: highlight extruded back-face shell in electric red!

layout(location = 0) out vec4 outColor;
layout(location = 1) out vec4 outNormDepth;
layout(location = 2) out vec4 outAux;

void main() {
  vec3 col = (uShowHull > 0.5) ? vec3(0.98, 0.18, 0.28) : vec3(0.05, 0.05, 0.08);
  outColor = vec4(col, 1.0);
  outNormDepth = vec4(0.0, 0.0, 1.0, vCamDist);
  outAux = vec4(0.0, 0.99, 0.0, 1.0);
}
`;

// ============================================================================
// 5. STRUCTURE TENSOR PASS FOR ANISOTROPIC KUWAHARA (Kyprianidis et al. 2009)
// ============================================================================
export const TENSOR_FS = `#version 300 es
precision highp float;
precision highp int;

in vec2 vUv;
uniform sampler2D uColor;
uniform vec2 uTexel;
out vec4 outTensor; // R = Ix^2, G = Iy^2, B = Ix*Iy

float luma(vec2 uv) {
  return dot(texture(uColor, uv).rgb, vec3(0.2126, 0.7152, 0.0722));
}

void main() {
  vec2 t = uTexel;
  float tl = luma(vUv + vec2(-t.x,  t.y));
  float tc = luma(vUv + vec2( 0.0,  t.y));
  float tr = luma(vUv + vec2( t.x,  t.y));
  float ml = luma(vUv + vec2(-t.x,  0.0));
  float mr = luma(vUv + vec2( t.x,  0.0));
  float bl = luma(vUv + vec2(-t.x, -t.y));
  float bc = luma(vUv + vec2( 0.0, -t.y));
  float br = luma(vUv + vec2( t.x, -t.y));

  float gx = (-tl - 2.0 * ml - bl + tr + 2.0 * mr + br) * 0.25;
  float gy = (-tl - 2.0 * tc - tr + bl + 2.0 * bc + br) * 0.25;
  outTensor = vec4(gx * gx, gy * gy, gx * gy, 1.0);
}
`;

export const TENSOR_BLUR_FS = `#version 300 es
precision highp float;
precision highp int;

in vec2 vUv;
uniform sampler2D uSrc;
uniform vec2 uDir;
out vec4 outColor;

void main() {
  const float w[4] = float[4](0.227027, 0.194595, 0.121622, 0.054054);
  vec3 s = texture(uSrc, vUv).rgb * w[0];
  for (int i = 1; i <= 3; i++) {
    vec2 o = uDir * float(i) * 1.35;
    s += (texture(uSrc, vUv + o).rgb + texture(uSrc, vUv - o).rgb) * w[i];
  }
  outColor = vec4(s, 1.0);
}
`;

// ============================================================================
// 6. FINAL NPR POST-PROCESS COMPOSITE (ALL 8 ERAS + SPLIT-SCREEN SAFE!)
// ============================================================================
export const FINAL_FS = `#version 300 es
precision highp float;
precision highp int;

in vec2 vUv;
uniform sampler2D uColor;
uniform sampler2D uNormDepth;
uniform sampler2D uAux;
uniform sampler2D uTensor;
uniform vec2 uTexel;
uniform vec2 uRes;
uniform int uStageLeft;
uniform int uStageRight;
uniform float uSplitX;
uniform float uSolidLeft;
uniform float uInkOn; // Step 8 toggle: Ink + Paint vs Pure Oil Brushstrokes!
out vec4 outColor;

// Edge detection across linear depth, world normal & material ID (never crosses split divider!)
float detectEdge(vec2 uv, float radius, bool useLeft) {
  vec4 cND = texture(uNormDepth, uv);
  float cMat = texture(uAux, uv).g;
  vec2 t = uTexel * radius;

  // 3x3 Sobel on depth + normal difference + material ID jump
  float dMax = 0.0;
  float nMax = 0.0;
  float mJump = 0.0;
  for (int dy = -1; dy <= 1; dy++) {
    for (int dx = -1; dx <= 1; dx++) {
      if (dx == 0 && dy == 0) continue;
      vec2 suv = uv + vec2(float(dx), float(dy)) * t;
      if (uSplitX > 0.005 && uSplitX < 0.995 && ((suv.x < uSplitX) != useLeft)) continue;
      vec4 sND = texture(uNormDepth, suv);
      float sMat = texture(uAux, suv).g;
      float w = (dx == 0 || dy == 0) ? 1.0 : 0.7;
      float dRel = abs(cND.a - sND.a) / max(0.35, min(cND.a, sND.a) * 0.22);
      dMax = max(dMax, dRel * w);
      if (cND.a < 50.0 && sND.a < 50.0) {
        nMax = max(nMax, (1.0 - max(0.0, dot(normalize(cND.rgb), normalize(sND.rgb)))) * w);
        if (abs(cMat - sMat) > 0.03) mJump = 1.0;
      }
    }
  }
  float dEdge = smoothstep(0.28, 0.65, dMax);
  float nEdge = smoothstep(0.22, 0.50, nMax);
  return clamp(max(max(dEdge, nEdge), mJump * 0.85), 0.0, 1.0);
}

// 8-Sector Anisotropic Kuwahara Filter (Kyprianidis, Kang & Dollner 2009)
vec3 evalAnisotropicKuwahara(vec2 uv, bool useLeft) {
  vec3 ten = texture(uTensor, uv).rgb;
  float E = ten.x, G = ten.y, F = ten.z;
  float disc = sqrt(max(0.0, (E - G) * (E - G) + 4.0 * F * F));
  float lam1 = 0.5 * (E + G + disc);
  float lam2 = 0.5 * (E + G - disc);
  float aniso = (lam1 + lam2 > 1e-6) ? clamp((lam1 - lam2) / (lam1 + lam2), 0.0, 1.0) : 0.0;
  // Guard atan(0,0) strictly so flat sky/armor regions NEVER emit NaN!
  float phi = (abs(E - G) + abs(2.0 * F) > 1e-6) ? (0.5 * atan(2.0 * F, E - G) + 1.5707963) : 0.0;

  float ca = cos(phi), sa = sin(phi);
  mat2 rot = mat2(ca, -sa, sa, ca);
  float alpha = 1.0;
  float a = 6.2 * (alpha + aniso) / alpha; // Sweeping impasto brushstroke length along Structure Tensor flow!
  float b = 3.8 * alpha / (alpha + aniso); // Crisp edge preservation perpendicular to stroke!

  vec3 mean[8];
  vec3 sq[8];
  float wsum[8];
  for (int k = 0; k < 8; k++) { mean[k] = vec3(0.0); sq[k] = vec3(0.0); wsum[k] = 0.0; }

  // 7x7 elliptical kernel -> chiseled directional oil brushstrokes at locked 60 FPS!
  for (int j = -3; j <= 3; j++) {
    for (int i = -3; i <= 3; i++) {
      vec2 v = vec2(float(i), float(j)) / 3.0;
      if (dot(v, v) > 1.05) continue;
      vec2 off = (rot * vec2(v.x * a, v.y * b)) * uTexel;
      vec2 suv = clamp(uv + off, vec2(0.002), vec2(0.998));
      if (uSplitX > 0.005 && uSplitX < 0.995 && ((suv.x < uSplitX) != useLeft)) suv = uv;
      vec3 c = texture(uColor, suv).rgb;

      float ang = (i == 0 && j == 0) ? 0.0 : atan(v.y, v.x);
      float secF = fract(ang / 6.2831853) * 8.0;
      int s0 = int(floor(secF)) & 7;
      int s1 = (s0 + 1) & 7;
      float frac = fract(secF);
      float gW = exp(-dot(v, v) * 1.45);
      float w0 = gW * (1.0 - frac);
      float w1 = gW * frac;
      mean[s0] += c * w0; sq[s0] += c * c * w0; wsum[s0] += w0;
      mean[s1] += c * w1; sq[s1] += c * c * w1; wsum[s1] += w1;
    }
  }

  vec3 res = vec3(0.0);
  float totalW = 0.0;
  for (int k = 0; k < 8; k++) {
    float n = max(wsum[k], 1e-4);
    vec3 m = mean[k] / n;
    vec3 varV = max(sq[k] / n - m * m, vec3(0.0));
    float s2 = max(varV.r + varV.g + varV.b, 0.0);
    // Sharp Kuwahara q=8 sector selection -> crisp chiseled painted facets instead of soft blur!
    float tv = s2 * 850.0;
    float tv2 = tv * tv;
    float w = 1.0 / (1.0 + tv2 * tv2);
    res += m * w;
    totalW += w;
  }
  return res / max(totalW, 1e-4);
}

void main() {
  bool useLeft = (uSplitX >= 0.995) || ((uSplitX > 0.005) && (vUv.x < uSplitX));
  int st = useLeft ? uStageLeft : uStageRight;
  bool isSmoothBase = (st == 0) && useLeft && (uSolidLeft > 0.5);

  vec3 col = texture(uColor, vUv).rgb;
  vec4 nd = texture(uNormDepth, vUv);
  vec4 aux = texture(uAux, vUv);
  bool isObj = nd.a < 50.0;
  float tone = aux.r;
  vec2 px = vUv * uRes;

  if (isSmoothBase) {
    // 1996 Smooth Gouraud/Phong 3D baseline: untouched!
  } else if (st == 0) {
    // 1996 Decaudin (INRIA): sharp black outlines from depth & normal discontinuities!
    float edge = detectEdge(vUv, 1.15, useLeft);
    col = mix(col, vec3(0.04, 0.04, 0.07), edge);
  } else if (st == 1) {
    // 1998 Gooch (SIGGRAPH): fine crisp dark-navy technical illustration pen lines!
    float edge = detectEdge(vUv, 0.95, useLeft);
    col = mix(col, vec3(0.06, 0.10, 0.20), edge * 0.92);
  } else if (st == 2) {
    // 2000 Cel Games: NO screen-space edge filter (outline comes purely from the real geometric Inverted Hull!)
  } else if (st == 3) {
    // 2002 Wind Waker Style: vibrant clean cel-shaded frames without heavy black borders
    col = pow(max(col, vec3(0.0)), vec3(0.95));
  } else if (st == 4) {
    // 2009 Borderlands Style: thick Sobel depth+normal ink edges + bold diagonal comic cross-hatching!
    float edge = detectEdge(vUv, 1.70, useLeft);
    if (isObj) {
      float sc = 720.0 / max(400.0, min(uRes.x, uRes.y));
      vec2 pH = px * sc;
      float h1 = abs(fract((pH.x + pH.y) * 0.095) - 0.5);
      float h2 = abs(fract((pH.x - pH.y) * 0.095) - 0.5);
      float line1 = (1.0 - smoothstep(0.09, 0.17, h1)) * smoothstep(0.72, 0.44, tone);
      float line2 = (1.0 - smoothstep(0.09, 0.17, h2)) * smoothstep(0.45, 0.22, tone);
      float hatch = clamp(max(line1, line2), 0.0, 1.0);
      col = mix(col, vec3(0.06, 0.05, 0.07), hatch * 0.78);
    }
    col = mix(col, vec3(0.04, 0.04, 0.05), smoothstep(0.24, 0.62, edge));
  } else if (st == 5) {
    // 2014 Guilty Gear Xrd: crisp hue-tinted contour (darkened surface color, not harsh pure black!)
    float edge = detectEdge(vUv, 1.10, useLeft);
    vec3 tintedInk = col * 0.18 + vec3(0.02, 0.015, 0.04);
    col = mix(col, tintedInk, smoothstep(0.35, 0.78, edge) * 0.92);
  } else if (st == 6) {
    // 2018 Spider-Verse Style: CMYK print offset + bold Ben-Day halftone dots + shadow ink hatching!
    float edge = detectEdge(vUv, 1.50, useLeft);
    float sc = 760.0 / max(400.0, min(uRes.x, uRes.y));
    vec2 pS = px * sc;

    // Punchy CMYK print misregistration along edges & dark silhouettes!
    vec2 offC = vec2(3.2, -1.6) * uTexel;
    vec2 offM = vec2(-2.8, 1.9) * uTexel;
    vec2 uvC = (uSplitX > 0.005 && uSplitX < 0.995 && ((vUv.x + offC.x < uSplitX) != useLeft)) ? vUv : (vUv + offC);
    vec2 uvM = (uSplitX > 0.005 && uSplitX < 0.995 && ((vUv.x + offM.x < uSplitX) != useLeft)) ? vUv : (vUv + offM);
    vec3 cShift = vec3(texture(uColor, uvM).r, col.g, texture(uColor, uvC).b);
    col = mix(col, cShift, clamp(edge * 0.85 + 0.18, 0.0, 0.90));

    // Rotated 45-deg Ben-Day halftone dots in bright highlights/midtones + pop-art sky dots!
    mat2 rot45 = mat2(0.7071, -0.7071, 0.7071, 0.7071);
    vec2 cell = fract((rot45 * pS) * 0.088) - 0.5;
    float dDot = length(cell);
    if (isObj) {
      float dotR = smoothstep(0.42, 0.92, tone) * 0.36;
      float dotMask = 1.0 - smoothstep(dotR - 0.05, dotR + 0.05, dDot);
      col = mix(col, min(col * 1.28 + vec3(0.18, 0.10, 0.02), vec3(1.0)), dotMask * 0.48);
      // Tight comic ink hatching lines in shadow regions!
      float hLine = abs(fract((pS.x - pS.y * 0.85) * 0.12) - 0.5);
      float hatch = (1.0 - smoothstep(0.08, 0.16, hLine)) * smoothstep(0.50, 0.25, tone);
      col = mix(col, vec3(0.05, 0.04, 0.10), hatch * 0.78);
    } else {
      float skyDotR = smoothstep(0.12, 0.78, 1.0 - vUv.y) * 0.32;
      float skyDot = 1.0 - smoothstep(skyDotR - 0.05, skyDotR + 0.05, dDot);
      col = mix(col, col * vec3(1.22, 0.82, 1.12) + vec3(0.08, 0.02, 0.10), skyDot * 0.38);
    }
    col = mix(col, vec3(0.04, 0.03, 0.07), smoothstep(0.28, 0.68, edge));
  } else {
    // 2026 Painterly Anisotropic Kuwahara (inspired by hand-painted 3D / Arcane!)
    col = evalAnisotropicKuwahara(vUv, useLeft);
    // Subtle woven oil-canvas pigment grain
    float sc = 800.0 / max(400.0, min(uRes.x, uRes.y));
    vec2 pC = px * sc;
    float canvas = (sin(pC.x * 1.6) * sin(pC.y * 1.6)) * 0.022;
    col *= (1.0 + canvas);
    // Optional painterly ink accents along silhouettes & creases!
    if (uInkOn > 0.5) {
      float edge = detectEdge(vUv, 1.15, useLeft);
      vec3 brushInk = col * 0.22 + vec3(0.03, 0.02, 0.05);
      col = mix(col, brushInk, smoothstep(0.32, 0.75, edge) * 0.72);
    }
  }

  // Gentle vignette & sRGB-ready output
  vec2 q = vUv - 0.5;
  col *= 1.0 - dot(q, q) * 0.14;
  outColor = vec4(clamp(col, 0.0, 1.0), 1.0);
}
`;
