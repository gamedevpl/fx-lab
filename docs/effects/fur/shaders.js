// 5 fast rasterized GLSL ES 3.00 shaders for Evolution of Fur (1992-2026):
//   1. SKY_FS               — Sunlit golden-hour forest clearing backdrop (warm bokeh sun behind ears)
//   2. SOLID_VS/SOLID_FS    — Mossy wood stump, antique brass collar, glossy obsidian fox eyes & nose
//   3. SHELL_VS/SHELL_FS    — Steps 1-6: Flat painted -> Normal map -> 8 Shells -> 40 Shells -> Kajiya-Kay -> Marschner Rim
//   4. STRAND_VS/STRAND_FS  — Steps 7-8: 24,000 instanced 5-segment tapered 3D clumped fur ribbons + live 64x32 groom physics
//   5. POLLEN_VS/POLLEN_FS  — Floating sunlit forest pollen motes drifting in the wind

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

  // Warm sunlit emerald-pine & golden-hour woodland backdrop (makes red-orange fox coat pop!)
  float h = clamp(vUv.y, 0.0, 1.0);
  vec3 cTop = vec3(0.05, 0.14, 0.15);
  vec3 cMid = vec3(0.10, 0.24, 0.21);
  vec3 cHor = vec3(0.30, 0.32, 0.22);
  vec3 cLow = vec3(0.05, 0.10, 0.09);

  vec3 col = (h > 0.34)
    ? mix(cHor, mix(cMid, cTop, smoothstep(0.32, 1.0, (h - 0.34) / 0.66)), smoothstep(0.0, 0.72, (h - 0.34) / 0.66))
    : mix(cLow, cHor, smoothstep(0.0, 1.0, h / 0.34));

  // Soft forest sunbeam halo behind the fox silhouette (powers Step 6-8 backlit fur rim!).
  float sDot = max(dot(rd, normalize(uLightDir)), 0.0);
  col += vec3(0.95, 0.62, 0.24) * pow(sDot, 5.0) * 0.42;
  col += vec3(1.00, 0.86, 0.52) * pow(sDot, 65.0) * 0.95;

  col = clamp((col * (2.51 * col + 0.03)) / (col * (2.43 * col + 0.59) + 0.14), 0.0, 1.0);
  outColor = vec4(pow(col, vec3(1.0 / 2.2)), 1.0);
}
`;

export const SOLID_VS = `#version 300 es
precision highp float;

layout(location = 0) in vec3 aPos;
layout(location = 1) in vec3 aNorm;
layout(location = 2) in vec2 aUv;
layout(location = 3) in float aMat;

uniform mat4 uVP;
uniform float uHeadYaw;
uniform float uApplyHeadRot;

out vec3 vWorldPos;
out vec3 vNormal;
out vec2 vUv;
out float vMat;

vec3 rotY(vec3 p, float a) {
  float c = cos(a), s = sin(a);
  return vec3(c * p.x + s * p.z, p.y, -s * p.x + c * p.z);
}

void main() {
  vec3 p = aPos;
  vec3 n = aNorm;
  if (uApplyHeadRot > 0.5) {
    p.y -= 1.12;
    p = rotY(p, uHeadYaw);
    p.y += 1.12;
    n = rotY(n, uHeadYaw);
  }
  vWorldPos = p;
  vNormal = normalize(n);
  vUv = aUv;
  vMat = aMat;
  gl_Position = uVP * vec4(p, 1.0);
}
`;

export const SOLID_FS = `#version 300 es
precision highp float;

in vec3 vWorldPos;
in vec3 vNormal;
in vec2 vUv;
in float vMat;

uniform vec3 uCamPos;
uniform vec3 uLightDir;
uniform vec3 uKeyDir;

out vec4 outColor;

float hash21(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}

float noise2(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(hash21(i), hash21(i + vec2(1.0, 0.0)), f.x),
    mix(hash21(i + vec2(0.0, 1.0)), hash21(i + vec2(1.0, 1.0)), f.x),
    f.y
  );
}

void main() {
  vec3 n = normalize(vNormal);
  vec3 v = normalize(uCamPos - vWorldPos);
  vec3 Lb = normalize(uLightDir);
  vec3 Lk = normalize(uKeyDir);

  vec3 albedo = vec3(0.22, 0.14, 0.09);
  float metal = 0.0;
  float rough = 0.84;

  if (vMat < 1.5) {
    // Weathered woodland tree-stump bark & growth rings on top
    float top = smoothstep(0.65, 0.92, n.y);
    float bark = 0.72 + 0.45 * noise2(vec2(vUv.x * 28.0, vUv.y * 5.0));
    float rings = 0.80 + 0.25 * sin(length(vWorldPos.xz) * 26.0 + noise2(vWorldPos.xz * 6.0) * 2.0);
    vec3 barkCol = vec3(0.18, 0.11, 0.065) * bark;
    vec3 woodTop = vec3(0.42, 0.28, 0.16) * rings;
    albedo = mix(barkCol, woodTop, top);
  } else if (vMat < 2.5) {
    // Plush forest moss cap on stump
    float m = noise2(vWorldPos.xz * 9.0 + vWorldPos.y * 6.0);
    albedo = mix(vec3(0.08, 0.22, 0.07), vec3(0.18, 0.38, 0.10), m);
    rough = 0.92;
  } else if (vMat < 3.5) {
    // Glossy obsidian fox eyes & wet black nose with crisp bright catchlight!
    albedo = vec3(0.015, 0.014, 0.018);
    rough = 0.06;
  } else {
    // Antique brass totem collar
    albedo = vec3(0.72, 0.48, 0.12);
    metal = 0.90;
    rough = 0.26;
  }

  float ndlK = max(dot(n, Lk), 0.0);
  float ndlB = max(dot(n, Lb), 0.0);
  vec3 Hk = normalize(Lk + v);
  vec3 Hb = normalize(Lb + v);
  float specPow = mix(18.0, 260.0, 1.0 - rough);
  float specK = pow(max(dot(n, Hk), 0.0), specPow) * mix(0.12, 2.2, 1.0 - rough);
  float specB = pow(max(dot(n, Hb), 0.0), specPow) * mix(0.08, 1.6, 1.0 - rough);

  vec3 amb = mix(vec3(0.05, 0.09, 0.08), vec3(0.16, 0.24, 0.22), n.y * 0.5 + 0.5);
  vec3 col = albedo * amb * (1.0 - metal * 0.55);
  col += (albedo * (1.0 - metal * 0.72) * ndlK + mix(vec3(1.0), albedo, metal) * specK) * vec3(1.38, 1.24, 1.05);
  col += (albedo * (1.0 - metal * 0.65) * ndlB + mix(vec3(1.0), albedo, metal) * specB) * vec3(1.45, 0.96, 0.45) * 0.65;

  // Glossy Fresnel eye catchlight so the fox face sparkles with life!
  if (vMat > 2.5 && vMat < 3.5) {
    float fres = 0.04 + 0.96 * pow(1.0 - max(dot(n, v), 0.0), 4.2);
    col += vec3(0.75, 0.88, 0.95) * fres * 0.65 + vec3(1.8, 1.7, 1.5) * pow(max(dot(n, Hk), 0.0), 340.0) * 2.8;
  }

  col = clamp((col * (2.51 * col + 0.03)) / (col * (2.43 * col + 0.59) + 0.14), 0.0, 1.0);
  outColor = vec4(pow(col, vec3(1.0 / 2.2)), 1.0);
}
`;

// ============================================================================
// SHELL SHADER (Steps 1..6: Flat -> Normal Map -> 8 Shells -> 40 Shells -> Kajiya-Kay -> Marschner)
// Also renders the dark undercoat skin underneath the 24,000 strands on Steps 7 & 8!
// ============================================================================
export const SHELL_VS = `#version 300 es
precision highp float;
precision highp int;

layout(location = 0) in vec3 aPos;
layout(location = 1) in vec3 aNorm;
layout(location = 2) in vec2 aUv;
layout(location = 3) in vec3 aCol;
layout(location = 4) in float aLen;

uniform mat4 uVP;
uniform float uHeadYaw;
uniform int uLayerCount;
uniform int uStage;
uniform float uShowSlices;
uniform float uTime;

out vec3 vWorldPos;
out vec3 vNormal;
out vec2 vUv;
out vec3 vCol;
out float vHeight;
out float vFurLen;

vec3 rotY(vec3 p, float a) {
  float c = cos(a), s = sin(a);
  return vec3(c * p.x + s * p.z, p.y, -s * p.x + c * p.z);
}

void main() {
  float h = (uLayerCount > 1) ? (float(gl_InstanceID) / float(uLayerCount - 1)) : 0.0;
  vec3 p = aPos;
  vec3 n = normalize(aNorm);

  // Rotate sculpted head + fur around head center (0, 1.12, 0).
  p.y -= 1.12;
  p = rotY(p, uHeadYaw);
  p.y += 1.12;
  n = rotY(n, uHeadYaw);

  // Extrude shell outward along surface normal; add gravity combing & gentle wind on Steps 4-6!
  float sliceScale = (uShowSlices > 0.5) ? 1.48 : 1.0;
  float len = (uLayerCount > 1) ? (aLen * sliceScale) : 0.0;
  vec3 offset = n * (h * len);

  if (uStage >= 3 && uLayerCount > 1) {
    // Classic Shadow of the Colossus gravity sag + subtle breeze combed downward along h^2!
    vec3 comb = vec3(0.06 * sin(uTime * 2.2 + p.y * 3.0), -0.46, -0.14);
    offset += comb * (h * h * len);
  }

  vec3 wp = p + offset;
  vWorldPos = wp;
  vNormal = n;
  vUv = aUv;
  vCol = aCol;
  vHeight = h;
  vFurLen = aLen;
  gl_Position = uVP * vec4(wp, 1.0);
}
`;

export const SHELL_FS = `#version 300 es
precision highp float;
precision highp int;

in vec3 vWorldPos;
in vec3 vNormal;
in vec2 vUv;
in vec3 vCol;
in float vHeight;
in float vFurLen;

uniform vec3 uCamPos;
uniform vec3 uLightDir;
uniform vec3 uKeyDir;
uniform int uStage;
uniform float uUntexLeft;
uniform float uShowSlices;

out vec4 outColor;

float hash21(vec2 p) {
  p = fract(p * vec2(127.1, 311.7));
  p += dot(p, p + 34.53);
  return fract(p.x * p.y);
}

// Kajiya-Kay strand specular: sin(T, H)^p
float kajiyaSpec(vec3 T, vec3 H, float expPow) {
  float tdh = clamp(dot(T, H), -1.0, 1.0);
  float sinTH = sqrt(max(0.0, 1.0 - tdh * tdh));
  return pow(sinTH, expPow);
}

void main() {
  vec3 n = normalize(vNormal);
  vec3 v = normalize(uCamPos - vWorldPos);
  vec3 Lb = normalize(uLightDir); // Back-left golden sun
  vec3 Lk = normalize(uKeyDir);   // Front-right key light

  // Steps 7-8 undercoat skin underneath the 24,000 geometric strands (deep ambient-occluded base).
  if (uStage >= 6) {
    float ndl = max(dot(n, Lk), 0.0);
    vec3 col = vCol * (0.10 + 0.28 * ndl);
    col = clamp((col * (2.51 * col + 0.03)) / (col * (2.43 * col + 0.59) + 0.14), 0.0, 1.0);
    outColor = vec4(pow(col, vec3(1.0 / 2.2)), 1.0);
    return;
  }

  // Step 1 (1992): Flat low-res painted fur texture (or untextured smooth grey mesh on Split Left!).
  if (uStage == 0) {
    float ndl = max(dot(n, Lk), 0.0) * 0.85 + max(dot(n, Lb), 0.0) * 0.25;
    if (uUntexLeft > 0.5) {
      vec3 grey = vec3(0.42, 0.44, 0.48) * (0.24 + 0.82 * ndl);
      outColor = vec4(pow(clamp(grey, 0.0, 1.0), vec3(1.0 / 2.2)), 1.0);
      return;
    }
    vec2 qUv = floor(vUv * vec2(68.0, 46.0)) / vec2(68.0, 46.0);
    float stripe = 0.82 + 0.34 * hash21(floor(qUv * vec2(68.0, 20.0)));
    vec3 col = vCol * stripe * (0.22 + 0.92 * ndl);
    col = clamp((col * (2.51 * col + 0.03)) / (col * (2.43 * col + 0.59) + 0.14), 0.0, 1.0);
    outColor = vec4(pow(col, vec3(1.0 / 2.2)), 1.0);
    return;
  }

  // Step 2 (1998): High-frequency normal-mapped fur on a completely smooth bald silhouette!
  if (uStage == 1) {
    vec2 st = vUv * vec2(180.0, 42.0);
    float s1 = hash21(floor(st));
    float s2 = hash21(floor(st + vec2(1.0, 0.0)));
    float gx = (s2 - s1) * 0.55;
    float gy = (hash21(floor(st + vec2(0.0, 1.0))) - s1) * 0.25;
    vec3 nb = normalize(n + vec3(gx, gy, 0.0));
    float ndl = max(dot(nb, Lk), 0.0);
    vec3 H = normalize(Lk + v);
    float spec = pow(max(dot(nb, H), 0.0), 36.0) * 0.24;
    vec3 col = vCol * (0.85 + 0.30 * s1) * (0.18 + 1.10 * ndl) + vec3(0.95, 0.88, 0.78) * spec;
    col = clamp((col * (2.51 * col + 0.03)) / (col * (2.43 * col + 0.59) + 0.14), 0.0, 1.0);
    outColor = vec4(pow(col, vec3(1.0 / 2.2)), 1.0);
    return;
  }

  // Steps 3-6 (2001-2016): Real Instanced Shell Texturing!
  // Fine 2D hair-cone grid on UV (keep base layer h == 0 solid so skin never leaks!).
  vec2 grid = vUv * vec2(190.0, 118.0);
  vec2 cid = floor(grid);
  vec2 cf = fract(grid) - 0.5;
  float hRand = hash21(cid);
  float hMax = 0.26 + 0.74 * hRand;
  float dist = length(cf);
  float thickness = mix(0.60, 0.10, clamp(vHeight / max(0.08, hMax), 0.0, 1.0));

  if (vHeight > 0.001) {
    if (vHeight > hMax || dist > thickness) discard;
  }

  // Root-to-tip ambient occlusion (classic Shadow of the Colossus depth trick on Steps 4-6!)
  float rootAO = (uStage >= 3) ? mix(0.18, 1.0, pow(vHeight, 0.65)) : mix(0.58, 1.0, vHeight);
  float strandVar = 0.82 + 0.36 * hash21(cid + 19.7);
  vec3 albedo = vCol * strandVar;

  // Educational Shell Slices visualizer on Step 3 (highlights each of the 8 extruded layers!)
  if (uStage == 2 && uShowSlices > 0.5 && vHeight > 0.01) {
    float rimSlice = smoothstep(thickness * 0.55, thickness, dist);
    albedo = mix(albedo, vec3(1.00, 0.78, 0.24), rimSlice * 0.75);
  }

  float ndlK = max(dot(n, Lk), 0.0);
  float ndlB = max(dot(n, Lb), 0.0);
  vec3 amb = mix(vec3(0.06, 0.10, 0.09), vec3(0.16, 0.24, 0.22), n.y * 0.5 + 0.5);
  vec3 sunKey = vec3(1.42, 1.24, 0.98);
  vec3 sunBack = vec3(1.55, 0.92, 0.36);

  vec3 col = albedo * amb * rootAO;

  if (uStage <= 3) {
    // Steps 3-4 (2001-2005): Wrap Lambert shell lighting + root AO.
    float wrapK = clamp((dot(n, Lk) + 0.35) / 1.35, 0.0, 1.0);
    col += albedo * wrapK * sunKey * rootAO * 1.05;
    col += albedo * ndlB * sunBack * rootAO * 0.30;
  } else {
    // Steps 5-6 (2011-2016): Kajiya-Kay Anisotropic Strand Tangent Specular!
    vec3 downDir = normalize(vec3(0.0, -1.0, -0.15) - n * dot(vec3(0.0, -1.0, -0.15), n));
    float tShift = (hRand - 0.5) * 0.42;
    vec3 T1 = normalize(downDir + n * (0.28 + tShift));
    vec3 T2 = normalize(downDir + n * (-0.18 + tShift));
    vec3 Hk = normalize(Lk + v);

    float wrapK = clamp((dot(n, Lk) + 0.45) / 1.45, 0.0, 1.0);
    float specPrimary = kajiyaSpec(T1, Hk, 48.0) * 0.48 * smoothstep(0.15, 0.85, vHeight);
    float specSecondary = kajiyaSpec(T2, Hk, 16.0) * 0.62 * smoothstep(0.10, 0.75, vHeight);

    col += albedo * wrapK * sunKey * rootAO;
    col += vec3(1.00, 0.94, 0.86) * specPrimary * (0.35 + 0.65 * ndlK) * rootAO;
    col += (albedo * 1.45 + vec3(0.25, 0.08, 0.02)) * specSecondary * (0.35 + 0.65 * ndlK) * rootAO;

    // Step 6 (2016): Marschner Dual-Lobe warm copper TRT scatter + golden backlit TT halo!
    if (uStage >= 5) {
      float graz = pow(1.0 - max(dot(n, v), 0.0), 2.8);
      float backAlign = pow(max(dot(v, -Lb), 0.0), 2.2) * 0.65 + max(dot(n, Lb), 0.0) * 0.55 + 0.25;
      vec3 rimCol = mix(vec3(1.25, 0.58, 0.14), vec3(1.35, 1.15, 0.76), clamp(vCol.b * 1.8, 0.0, 1.0));
      col += rimCol * graz * backAlign * smoothstep(0.15, 0.95, vHeight) * 1.25;
      // Rich copper internal scatter (TRT) on sunlit transition zone
      col += (albedo * albedo * 2.2 + vec3(0.32, 0.06, 0.01)) * pow(wrapK, 1.5) * rootAO * 0.35;
    }
  }

  col = clamp((col * (2.51 * col + 0.03)) / (col * (2.43 * col + 0.59) + 0.14), 0.0, 1.0);
  outColor = vec4(pow(col, vec3(1.0 / 2.2)), 1.0);
}
`;

// ============================================================================
// GEOMETRIC 3D STRAND SHADER (Steps 7-8: 24,000 instanced 5-segment tapered ribbons!)
// ============================================================================
export const STRAND_VS = `#version 300 es
precision highp float;
precision highp int;

// Per-instance strand attributes (12 floats = 3 vec4s!)
layout(location = 0) in vec3 aRoot;
layout(location = 1) in vec3 aNorm;
layout(location = 2) in vec3 aCol;
layout(location = 3) in vec3 aMeta; // x = length, y = uGroom, z = floor(seed) + fract(vGroom)

uniform sampler2D uTexGroom;
uniform mat4 uVP;
uniform vec3 uCamPos;
uniform float uHeadYaw;
uniform float uTime;
uniform int uStage;

out vec3 vWorldPos;
out vec3 vNormal;
out vec3 vTangent;
out vec3 vCol;
out float vT;
out float vSeed;

vec3 rotY(vec3 p, float a) {
  float c = cos(a), s = sin(a);
  return vec3(c * p.x + s * p.z, p.y, -s * p.x + c * p.z);
}

void main() {
  // 5 quad segments = 12 triangle-strip vertices (gl_VertexID = 0..11)
  int seg = gl_VertexID >> 1;          // 0..5
  float side = float((gl_VertexID & 1) * 2 - 1); // -1 or +1
  float t = float(seg) / 5.0;          // 0 at root -> 1 at sharp tapered tip!

  float len = aMeta.x;
  float uG = aMeta.y;
  float vG = fract(aMeta.z);
  float seed = floor(aMeta.z) * 0.01;

  vec3 root = aRoot;
  vec3 n = normalize(aNorm);
  root.y -= 1.12;
  root = rotY(root, uHeadYaw);
  root.y += 1.12;
  n = rotY(n, uHeadYaw);

  // Natural downward-and-backwards groomed flow + subtle curl per strand
  vec3 comb = vec3(sin(seed * 62.8) * 0.14, -0.52, -0.18 + cos(seed * 41.2) * 0.10);

  // Step 8 (2026): Live 64x32 spring-damper wind waves, head-shake inertia & interactive petting!
  vec3 dynDisp = vec3(0.0);
  if (uStage >= 7) {
    vec4 g = texture(uTexGroom, vec2(uG, vG));
    vec3 field = (g.rgb * 2.0 - 1.0);
    // High-frequency individual strand flutter riding on top of the clump groom field
    float flutter = sin(uTime * 11.5 + seed * 120.0 + root.x * 5.0) * (0.04 + 0.12 * g.a);
    dynDisp = field * 0.92 + vec3(flutter, flutter * 0.4, -flutter * 0.6);
  }

  // Evaluate curved 3D spine point P(t) and exact analytical tangent T(t) = dP/dt!
  vec3 bend = (comb + dynDisp) * len;
  vec3 pCenter = root + n * (t * len) + bend * (t * t);
  vec3 tang = normalize(n * len + bend * (2.0 * t));

  // Silky fine camera-facing ribbon width (30,000 fine tapered strands -> plush Pixar coat!)
  vec3 viewDir = normalize(uCamPos - pCenter);
  vec3 sideVec = normalize(cross(tang, viewDir));
  float halfWidth = mix(0.0118, 0.0012, pow(t, 0.85)) * (0.85 + 0.35 * fract(seed * 17.3));

  vec3 wp = pCenter + sideVec * (side * halfWidth);
  vWorldPos = wp;
  vNormal = n;
  vTangent = tang;
  vCol = aCol;
  vT = t;
  vSeed = seed;
  gl_Position = uVP * vec4(wp, 1.0);
}
`;

export const STRAND_FS = `#version 300 es
precision highp float;
precision highp int;

in vec3 vWorldPos;
in vec3 vNormal;
in vec3 vTangent;
in vec3 vCol;
in float vT;
in float vSeed;

uniform vec3 uCamPos;
uniform vec3 uLightDir;
uniform vec3 uKeyDir;

out vec4 outColor;

float kajiyaSpec(vec3 T, vec3 H, float expPow) {
  float tdh = clamp(dot(T, H), -1.0, 1.0);
  float sinTH = sqrt(max(0.0, 1.0 - tdh * tdh));
  return pow(sinTH, expPow);
}

void main() {
  vec3 n = normalize(vNormal);
  vec3 T = normalize(vTangent);
  vec3 v = normalize(uCamPos - vWorldPos);
  vec3 Lb = normalize(uLightDir); // Back-left golden sun
  vec3 Lk = normalize(uKeyDir);   // Front-right key light

  // Root-to-tip self-occlusion & slightly lighter sun-bleached hair tips!
  float rootAO = mix(0.16, 1.0, pow(vT, 0.62));
  vec3 albedo = vCol * mix(0.76, 1.18, vT);

  // Kajiya-Kay diffuse: sin(T, L) gives natural cylindrical strand shading!
  float sinTLk = sqrt(max(0.0, 1.0 - pow(dot(T, Lk), 2.0)));
  float wrapK = clamp((dot(n, Lk) + 0.50) / 1.50, 0.0, 1.0);
  float diffK = mix(wrapK, sinTLk, 0.45);

  vec3 Hk = normalize(Lk + v);
  float shift = (fract(vSeed * 37.1) - 0.5) * 0.36;
  vec3 T1 = normalize(T + n * (0.22 + shift));
  vec3 T2 = normalize(T + n * (-0.18 + shift));

  // Marschner R (white surface highlight) + TRT (warm copper secondary gleam) + TT (golden backlit rim!)
  float specR = kajiyaSpec(T1, Hk, 64.0) * 0.48 * smoothstep(0.12, 0.88, vT);
  float specTRT = kajiyaSpec(T2, Hk, 18.0) * 0.68 * smoothstep(0.10, 0.80, vT);

  vec3 amb = mix(vec3(0.05, 0.09, 0.08), vec3(0.15, 0.23, 0.21), n.y * 0.5 + 0.5);
  vec3 sunKey = vec3(1.44, 1.24, 0.96);

  vec3 col = albedo * amb * rootAO;
  col += albedo * diffK * sunKey * rootAO;
  col += vec3(1.00, 0.95, 0.88) * specR * wrapK * rootAO;
  col += (albedo * 1.55 + vec3(0.28, 0.07, 0.01)) * specTRT * wrapK * rootAO;

  // Golden forest-sun backlit transmission (TT) glowing right through the 3D fur silhouette!
  float graz = pow(1.0 - max(dot(n, v), 0.0), 2.4);
  float backAlign = pow(max(dot(v, -Lb), 0.0), 2.0) * 0.72 + max(dot(n, Lb), 0.0) * 0.52 + 0.28;
  vec3 rimTint = mix(vec3(1.38, 0.62, 0.14), vec3(1.45, 1.22, 0.80), clamp(vCol.b * 1.8, 0.0, 1.0));
  col += rimTint * graz * backAlign * smoothstep(0.10, 0.92, vT) * 1.38;

  col = clamp((col * (2.51 * col + 0.03)) / (col * (2.43 * col + 0.59) + 0.14), 0.0, 1.0);
  outColor = vec4(pow(col, vec3(1.0 / 2.2)), 1.0);
}
`;

export const POLLEN_VS = `#version 300 es
precision highp float;

layout(location = 0) in vec4 aSeed;
uniform mat4 uVP;
uniform float uTime;

out float vAlpha;

void main() {
  vec3 p = aSeed.xyz;
  float ph = aSeed.w * 6.2831;
  p.x = mod(p.x + uTime * (0.28 + 0.22 * aSeed.w) + 2.2, 4.4) - 2.2;
  p.y += sin(uTime * 1.4 + ph) * 0.16;
  p.z += cos(uTime * 1.1 + ph) * 0.18;
  gl_Position = uVP * vec4(p, 1.0);
  gl_PointSize = clamp(18.0 / max(1.0, gl_Position.w), 2.5, 7.5);
  vAlpha = (0.35 + 0.65 * sin(uTime * 2.4 + ph) * 0.5 + 0.5) * smoothstep(2.2, 1.4, abs(p.x));
}
`;

export const POLLEN_FS = `#version 300 es
precision highp float;

in float vAlpha;
out vec4 outColor;

void main() {
  vec2 p = gl_PointCoord * 2.0 - 1.0;
  float r2 = dot(p, p);
  if (r2 > 1.0) discard;
  outColor = vec4(1.0, 0.88, 0.52, exp(-r2 * 3.2) * vAlpha * 0.58);
}
`;
