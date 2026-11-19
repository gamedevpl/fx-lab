// 5 fast rasterized GLSL ES 3.00 shaders for Evolution of Cloth (1988-2026):
//   1. SKY_FS              — Golden-hour twilight sky behind the banner (backlights translucency)
//   2. SHADOW_VS/SHADOW_FS — Hardware depth pass for 512x512 cloth & cannonball shadow map
//   3. SOLID_VS/SOLID_FS   — Stone battlement dais, wrought-iron crossbar & brass cannonball with PCF shadows
//   4. CLOTH_VS/CLOTH_FS   — All 8 eras: 1988 2-frame pixel flip -> 2026 Charlie velvet sheen, weave normal & self-shadows
//   5. THREAD_VS/THREAD_FS — Loose crimson & gold shredded thread particles spawned during live tearing

export const SKY_FS = `#version 300 es
precision highp float;

in vec2 vUv;
uniform vec3 uCamRight;
uniform vec3 uCamUp;
uniform vec3 uCamFwd;
uniform float uTanHalfFov;
uniform float uAspect;
uniform vec3 uLightDir;

out vec4 outColor;

void main() {
  vec2 ndc = vUv * 2.0 - 1.0;
  vec3 rd = normalize(uCamFwd + ndc.x * uAspect * uTanHalfFov * uCamRight + ndc.y * uTanHalfFov * uCamUp);

  float h = clamp(vUv.y, 0.0, 1.0);
  vec3 cZen = vec3(0.05, 0.09, 0.20);
  vec3 cMid = vec3(0.11, 0.19, 0.34);
  vec3 cHor = vec3(0.36, 0.30, 0.38);
  vec3 cLow = vec3(0.07, 0.10, 0.18);

  vec3 col = (h > 0.34)
    ? mix(cHor, mix(cMid, cZen, smoothstep(0.32, 1.0, (h - 0.34) / 0.66)), smoothstep(0.0, 0.72, (h - 0.34) / 0.66))
    : mix(cLow, cHor, smoothstep(0.0, 1.0, h / 0.34));

  float sDot = max(dot(rd, normalize(uLightDir)), 0.0);
  col += vec3(0.95, 0.50, 0.22) * pow(sDot, 6.0) * 0.45;
  col += vec3(1.00, 0.82, 0.50) * pow(sDot, 85.0) * 0.90;
  col += vec3(1.80, 1.45, 0.95) * smoothstep(0.996, 0.9992, sDot);

  // ACES + sRGB gamma so backdrop matches the foreground meshes seamlessly.
  col = clamp((col * (2.51 * col + 0.03)) / (col * (2.43 * col + 0.59) + 0.14), 0.0, 1.0);
  outColor = vec4(pow(col, vec3(1.0 / 2.2)), 1.0);
}
`;

export const SHADOW_VS = `#version 300 es
precision highp float;

layout(location = 0) in vec3 aPos;
uniform mat4 uLightVP;
uniform vec3 uOffset;
uniform float uScale;

void main() {
  gl_Position = uLightVP * vec4(aPos * uScale + uOffset, 1.0);
}
`;

export const SHADOW_FS = `#version 300 es
precision highp float;
out vec4 outColor;
void main() {
  // Depth is written automatically to the DEPTH_COMPONENT24 texture attachment.
  outColor = vec4(1.0);
}
`;

export const SOLID_VS = `#version 300 es
precision highp float;

layout(location = 0) in vec3 aPos;
layout(location = 1) in vec3 aNorm;
layout(location = 2) in vec2 aUv;
layout(location = 3) in float aMat;

uniform mat4 uVP;
uniform mat4 uLightVP;
uniform vec3 uOffset;
uniform float uScale;

out vec3 vWorldPos;
out vec3 vNormal;
out vec2 vUv;
out float vMat;
out vec4 vLightSpace;

void main() {
  vec3 wp = aPos * uScale + uOffset;
  vWorldPos = wp;
  vNormal = normalize(aNorm);
  vUv = aUv;
  vMat = aMat;
  vLightSpace = uLightVP * vec4(wp, 1.0);
  gl_Position = uVP * vec4(wp, 1.0);
}
`;

export const SOLID_FS = `#version 300 es
precision highp float;

in vec3 vWorldPos;
in vec3 vNormal;
in vec2 vUv;
in float vMat;
in vec4 vLightSpace;

uniform sampler2D uShadowMap;
uniform vec3 uCamPos;
uniform vec3 uLightDir;
uniform vec3 uBackLightDir;
uniform int uStage;

out vec4 outColor;

float hash21(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}

float sampleShadowPCF(vec4 lsPos, float bias) {
  vec3 p = lsPos.xyz / lsPos.w * 0.5 + 0.5;
  if (p.x < 0.0 || p.x > 1.0 || p.y < 0.0 || p.y > 1.0 || p.z > 1.0) return 1.0;
  float lit = 0.0;
  float texel = 1.65 / 512.0;
  for (int y = -1; y <= 1; y++) {
    for (int x = -1; x <= 1; x++) {
      float d = texture(uShadowMap, p.xy + vec2(float(x), float(y)) * texel).r;
      lit += (p.z - bias <= d) ? 1.0 : 0.0;
    }
  }
  return lit / 9.0;
}

void main() {
  vec3 n = normalize(vNormal);
  vec3 v = normalize(uCamPos - vWorldPos);
  vec3 L = normalize(uLightDir);
  vec3 Lb = normalize(uBackLightDir);

  vec3 albedo = vec3(0.55, 0.52, 0.48);
  float metal = 0.0;
  float rough = 0.78;

  if (vMat < 1.5) {
    // Battlement travertine stone dais with block seams (warm sunlit floor shows the banner shadow clearly!).
    float topMask = smoothstep(0.65, 0.92, n.y);
    vec2 gv = vWorldPos.xz * 1.55;
    vec2 cid = floor(gv), cf = fract(gv);
    float grout = smoothstep(0.02, 0.05, min(cf.x, 1.0 - cf.x)) * smoothstep(0.02, 0.05, min(cf.y, 1.0 - cf.y));
    float tone = 0.88 + 0.18 * hash21(cid);
    vec3 topCol = mix(vec3(0.32, 0.28, 0.24), vec3(0.60, 0.54, 0.46) * tone, grout);
    vec3 sideCol = vec3(0.24, 0.24, 0.28) * (0.86 + 0.22 * hash21(floor(vec2(atan(vWorldPos.z, vWorldPos.x) * 6.0, vWorldPos.y * 5.0))));
    albedo = mix(sideCol, topCol, topMask);
    rough = 0.82;
  } else if (vMat < 2.5) {
    // Dark forged wrought-iron banner stand & crossbar.
    albedo = vec3(0.11, 0.12, 0.15);
    metal = 0.78;
    rough = 0.38;
  } else if (vMat < 3.5) {
    // Antique royal brass finials & hanging rings.
    albedo = vec3(0.68, 0.44, 0.10);
    metal = 0.90;
    rough = 0.24;
  } else {
    // Heavy forged cast-iron & bronze-banded cannonball (rich dark steel + warm engraved brass belt!).
    float band = smoothstep(0.76, 0.92, abs(sin(vUv.y * 12.566)));
    float pat = 0.85 + 0.28 * hash21(floor(vUv * 42.0));
    albedo = mix(vec3(0.14, 0.13, 0.15) * pat, vec3(0.72, 0.46, 0.12), band * 0.78);
    metal = mix(0.84, 0.94, band);
    rough = mix(0.32, 0.18, band);
  }

  float sh = (uStage >= 6) ? sampleShadowPCF(vLightSpace, 0.0045) : 1.0;
  float ndl = max(dot(n, L), 0.0);
  float ndlb = max(dot(n, Lb), 0.0);
  vec3 H = normalize(L + v);
  vec3 Hb = normalize(Lb + v);
  float spec = pow(max(dot(n, H), 0.0), mix(18.0, 140.0, 1.0 - rough)) * mix(0.10, 1.55, metal);
  float specB = pow(max(dot(n, Hb), 0.0), mix(24.0, 160.0, 1.0 - rough)) * mix(0.08, 1.35, metal);

  vec3 amb = mix(vec3(0.05, 0.07, 0.13), vec3(0.15, 0.22, 0.36), n.y * 0.5 + 0.5);
  vec3 sunCol = vec3(1.58, 1.24, 0.82);
  vec3 keyCol = vec3(0.85, 0.88, 1.05);

  vec3 col = albedo * amb * (1.0 - metal * 0.55);
  col += (albedo * (1.0 - metal * 0.72) * ndl + mix(vec3(1.0), albedo, metal) * spec) * sunCol * sh;
  col += (albedo * (1.0 - metal * 0.65) * ndlb + mix(vec3(1.0), albedo, metal) * specB) * keyCol * 0.52;

  if (metal > 0.5) {
    vec3 r = reflect(-v, n);
    float fres = 0.18 + 0.82 * pow(1.0 - max(dot(n, v), 0.0), 4.0);
    vec3 env = mix(vec3(0.08, 0.11, 0.20), vec3(0.55, 0.46, 0.44), smoothstep(-0.2, 0.7, r.y));
    col += env * albedo * fres * 0.85;
  }

  col = clamp((col * (2.51 * col + 0.03)) / (col * (2.43 * col + 0.59) + 0.14), 0.0, 1.0);
  outColor = vec4(pow(col, vec3(1.0 / 2.2)), 1.0);
}
`;

export const CLOTH_VS = `#version 300 es
precision highp float;

layout(location = 0) in vec3 aPos;
layout(location = 1) in vec3 aNorm;
layout(location = 2) in vec2 aUv;
layout(location = 3) in float aStrain;

uniform mat4 uVP;
uniform mat4 uLightVP;

out vec3 vWorldPos;
out vec3 vNormal;
out vec2 vUv;
out float vStrain;
out vec4 vLightSpace;

void main() {
  vWorldPos = aPos;
  vNormal = normalize(aNorm);
  vUv = aUv;
  vStrain = aStrain;
  vLightSpace = uLightVP * vec4(aPos, 1.0);
  gl_Position = uVP * vec4(aPos, 1.0);
}
`;

export const CLOTH_FS = `#version 300 es
precision highp float;

in vec3 vWorldPos;
in vec3 vNormal;
in vec2 vUv;
in float vStrain;
in vec4 vLightSpace;

uniform sampler2D uTexRetro0;
uniform sampler2D uTexRetro1;
uniform sampler2D uShadowMap;

uniform vec3 uCamPos;
uniform vec3 uLightDir;
uniform vec3 uBackLightDir;
uniform float uTime;
uniform int uStage;
uniform float uFreezeRetro;
uniform float uShowWire;

out vec4 outColor;

// Procedural heraldic crimson-and-gold banner pattern + embroidery relief height!
void evalBannerPattern(vec2 uv, out vec3 baseCol, out float isGold, out float relief) {
  float bx = min(uv.x, 1.0 - uv.x);
  float by = min(uv.y, 1.0 - uv.y);
  float edgeD = min(bx, by);

  // Outer gold trim + inner double gold piping
  float outerTrim = smoothstep(0.068, 0.056, edgeD);
  float innerPipe = smoothstep(0.012, 0.004, abs(edgeD - 0.105));

  // Center solar-diamond heraldic crest
  vec2 c = vec2((uv.x - 0.5) * 1.0, (uv.y - 0.47) * 1.15);
  float dDiam = abs(c.x) + abs(c.y);
  float rCirc = length(c);
  float crestRing = smoothstep(0.018, 0.006, abs(dDiam - 0.25)) + smoothstep(0.014, 0.004, abs(rCirc - 0.11));
  float rays = smoothstep(0.022, 0.008, min(abs(c.x), abs(c.y))) * smoothstep(0.26, 0.21, dDiam);
  float diagRays = smoothstep(0.018, 0.006, min(abs(c.x - c.y), abs(c.x + c.y))) * smoothstep(0.22, 0.17, dDiam);

  // Corner fleur-de-lis diamond studs
  vec2 cor = abs(uv - 0.5);
  float cornerStud = smoothstep(0.038, 0.024, abs(cor.x - 0.34) + abs(cor.y - 0.34));

  isGold = clamp(outerTrim + innerPipe + crestRing + rays + diagRays + cornerStud, 0.0, 1.0);
  relief = isGold * 0.75;

  // Deep linear-space royal crimson velvet + rich antique gold embroidery (never washes out to pastel pink!)
  vec3 crimson = mix(vec3(0.14, 0.008, 0.016), vec3(0.27, 0.014, 0.026), smoothstep(0.04, 0.35, edgeD));
  vec3 goldThread = vec3(0.76, 0.48, 0.08);
  baseCol = mix(crimson, goldThread, isGold);
}

// Procedural woven linen micro-normal perturbation (warp & weft threads).
vec3 applyWeaveNormal(vec3 n, vec2 uv, float isGold) {
  vec2 w = uv * vec2(128.0, 148.0);
  float warp = sin(w.x * 6.2831853);
  float weft = sin(w.y * 6.2831853);
  float checker = sign(sin(w.x * 3.14159) * sin(w.y * 3.14159));
  float amp = mix(0.14, 0.24, isGold);
  vec3 dp = vec3(warp * (0.6 + 0.4 * checker), weft * (0.6 - 0.4 * checker), 0.0) * amp;
  return normalize(n + dp);
}

// Estevez-Kulla ("Charlie") grazing velvet sheen distribution.
float charlieSheen(float roughness, float ndh) {
  float invR = 1.0 / max(0.05, roughness);
  float sin2h = max(1.0 - ndh * ndh, 0.0078125);
  return (2.0 + invR) * pow(sin2h, invR * 0.5) / (2.0 * 3.14159265);
}

float sampleShadowPCF(vec4 lsPos, float bias) {
  vec3 p = lsPos.xyz / lsPos.w * 0.5 + 0.5;
  if (p.x < 0.0 || p.x > 1.0 || p.y < 0.0 || p.y > 1.0 || p.z > 1.0) return 1.0;
  float lit = 0.0;
  float texel = 1.55 / 512.0;
  for (int y = -1; y <= 1; y++) {
    for (int x = -1; x <= 1; x++) {
      float d = texture(uShadowMap, p.xy + vec2(float(x), float(y)) * texel).r;
      lit += (p.z - bias <= d) ? 1.0 : 0.0;
    }
  }
  return lit / 9.0;
}

void main() {
  // Step 1 (1988): Flat 2-frame nearest-neighbor 32x24 pixel sprite — zero lighting!
  if (uStage == 0) {
    bool useF1 = (uFreezeRetro < 0.5) && (mod(floor(uTime * 3.6), 2.0) > 0.5);
    vec3 pix = useF1 ? texture(uTexRetro1, vUv).rgb : texture(uTexRetro0, vUv).rgb;
    outColor = vec4(pix, 1.0);
    return;
  }

  vec3 n = normalize(vNormal);
  bool front = gl_FrontFacing;
  if (!front) n = -n;
  vec3 v = normalize(uCamPos - vWorldPos);
  vec3 L = normalize(uLightDir);
  vec3 Lb = normalize(uBackLightDir);

  vec3 baseCol;
  float isGold, relief;
  evalBannerPattern(vUv, baseCol, isGold, relief);
  if (!front) baseCol *= 0.72; // Darker reverse side of the velvet banner!

  // Steps 2-4 (1996-2004): Early Lambert / glossy plastic Blinn-Phong without weave or PBR sheen.
  vec3 col;
  if (uStage <= 3) {
    // Low-res pixelated texture feel on Step 2 (1996 rigid flap)
    if (uStage == 1) {
      vec2 qUv = floor(vUv * vec2(48.0, 56.0)) / vec2(48.0, 56.0);
      evalBannerPattern(qUv, baseCol, isGold, relief);
      if (!front) baseCol *= 0.65;
    }
    // Use front-side key light Lb so early steps clearly read fold normals even with sun behind!
    float ndl = max(dot(n, Lb), 0.0) * 0.85 + max(dot(n, L), 0.0) * 0.45;
    vec3 H = normalize(Lb + v);
    float plasticSpec = (uStage >= 2) ? pow(max(dot(n, H), 0.0), 28.0) * 0.35 : 0.0;
    col = baseCol * (0.20 + 1.15 * ndl) + vec3(0.95, 0.90, 0.85) * plasticSpec;
  } else {
    // Steps 5-8 (2009-2026): Procedural woven linen normal map + metallic gold embroidery!
    vec3 nw = applyWeaveNormal(n, vUv, isGold);
    float ndlSun = max(dot(nw, L), 0.0);
    float ndlKey = max(dot(nw, Lb), 0.0);
    float ndv = max(dot(nw, v), 0.001);
    vec3 Hkey = normalize(Lb + v);
    float ndh = max(dot(nw, Hkey), 0.0);

    // Subtle warp/weft thread micro-contrast
    float weaveMod = 0.86 + 0.24 * sin(vUv.x * 128.0 * 6.2831) * sin(vUv.y * 148.0 * 6.2831);
    vec3 albedo = baseCol * mix(weaveMod, 1.08, isGold);

    // Self-shadowing & cannonball shadow map active on Steps 7 & 8!
    float sh = (uStage >= 6) ? sampleShadowPCF(vLightSpace, 0.0085) : 1.0;

    // Dramatic raking side key light sculpts deep crimson valleys & bright golden fold ridges!
    vec3 sunCol = vec3(1.55, 1.18, 0.72);
    vec3 keyCol = vec3(1.22, 1.14, 1.04);
    vec3 ambCol = mix(vec3(0.05, 0.07, 0.14), vec3(0.14, 0.20, 0.34), nw.y * 0.5 + 0.5);
    float metal = isGold * 0.88;
    float specPow = mix(24.0, 120.0, isGold);
    float spec = pow(ndh, specPow) * mix(0.04, 1.65, isGold);

    col = albedo * ambCol * (1.0 - metal * 0.45);
    col += (albedo * (1.0 - metal * 0.72) * ndlKey + mix(vec3(1.0), albedo, metal) * spec) * keyCol * (0.42 + 0.58 * sh);
    col += albedo * (1.0 - metal * 0.65) * ndlSun * sunCol * 0.65 * sh;

    // Steps 6-8 (2015-2026): Deep ruby-crimson Charlie velvet sheen + golden-sun backlit translucency!
    if (uStage >= 5) {
      float graz = pow(1.0 - ndv, 3.6);
      float sheen = charlieSheen(0.36, ndh) * 0.055 + graz * 0.48;
      vec3 sheenTint = mix(vec3(0.88, 0.08, 0.10), vec3(1.00, 0.78, 0.24), isGold);
      col += sheenTint * sheen * (0.28 + 0.72 * ndlKey * (0.35 + 0.65 * sh));

      // Backlit subsurface translucency: sun L from behind glows rich molten ruby through thin folds!
      float backGlow = max(0.0, dot(-nw, L)) * 0.85 + pow(max(0.0, dot(v, -L)), 3.2) * 0.55;
      vec3 sssCol = vec3(1.15, 0.055, 0.032) * (1.0 - isGold * 0.88);
      col += sssCol * backGlow * (0.35 + 0.65 * sh) * 0.92;
    }

    // Step 8 micro-fuzz golden rim highlight + subtle torn-edge light catch!
    if (uStage >= 7) {
      float rimFuzz = pow(1.0 - ndv, 4.5) * (0.25 + 0.75 * max(dot(nw, L), 0.0) + 0.45 * max(dot(-nw, L), 0.0));
      col += vec3(1.00, 0.62, 0.28) * rimFuzz * 0.65;
      col += vec3(0.35, 0.03, 0.02) * vStrain * 0.28;
    }
  }

  // Optional crisp quad wireframe overlay (Step 3 Sine Wave / Step 4 Verlet inspection)
  if (uShowWire > 0.5) {
    vec2 cell = fract(vUv * vec2(36.0, 28.0));
    float line = 1.0 - smoothstep(0.04, 0.11, min(min(cell.x, 1.0 - cell.x), min(cell.y, 1.0 - cell.y)));
    col = mix(col, vec3(0.96, 0.75, 0.28), line * 0.78);
  }

  // ACES filmic tone map + sRGB gamma
  col = clamp((col * (2.51 * col + 0.03)) / (col * (2.43 * col + 0.59) + 0.14), 0.0, 1.0);
  outColor = vec4(pow(col, vec3(1.0 / 2.2)), 1.0);
}
`;

export const THREAD_VS = `#version 300 es
precision highp float;

layout(location = 0) in vec3 aPos;
layout(location = 1) in float aLife;
layout(location = 2) in vec3 aCol;

uniform mat4 uVP;

out float vLife;
out vec3 vCol;

void main() {
  vLife = aLife;
  vCol = aCol;
  gl_Position = uVP * vec4(aPos, 1.0);
  gl_PointSize = (aLife > 0.01) ? clamp(22.0 / max(1.0, gl_Position.w), 3.0, 10.0) : 0.0;
}
`;

export const THREAD_FS = `#version 300 es
precision highp float;

in float vLife;
in vec3 vCol;
out vec4 outColor;

void main() {
  if (vLife <= 0.01) discard;
  vec2 p = gl_PointCoord * 2.0 - 1.0;
  // Elongated tiny fiber shred silhouette!
  float d = length(vec2(p.x * 2.2, p.y));
  if (d > 1.0) discard;
  outColor = vec4(vCol, clamp(vLife, 0.0, 1.0) * (1.0 - d * 0.4));
}
`;
