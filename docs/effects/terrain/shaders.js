// WebGL2 Shaders for Evolution of Terrain & Level of Detail (1992-2024):
//   - Crisp sunlit Alpine Sky (makes T-junction cracks flash bright sky blue!)
//   - 1992 Comanche Voxel Space vertical column raymarcher
//   - Multi-LOD Terrain Mesh shader with razor-sharp barycentric wireframe, LOD ring colors,
//     Chunked Skirt highlight, BF3 Virtual Terrain Texturing, and Nanite Cluster Meshlet view!
//   - 3D Frozen Frustum Wireframe Pyramid overlay!

export const SKY_FS = /* glsl */`#version 300 es
precision highp float;
in vec2 vUv;
out vec4 oCol;
uniform vec3 uCamRight, uCamUp, uCamFwd;
uniform float uTanHalfFov, uAspect;
uniform float uCrackFlash; // Bright cyan-white sky glow on Stage 2 so T-junction cracks scream visually!

void main() {
  vec2 ndc = vUv * 2.0 - 1.0;
  vec3 rd = normalize(uCamFwd + uCamRight * (ndc.x * uAspect * uTanHalfFov) + uCamUp * (ndc.y * uTanHalfFov));
  vec3 sunDir = normalize(vec3(0.58, 0.42, -0.70));
  float y = clamp(rd.y, 0.0, 1.0);
  vec3 sky = mix(vec3(0.70, 0.85, 0.98), vec3(0.16, 0.40, 0.78), pow(y, 0.55));
  if (rd.y < 0.0) {
    // Bright sky-cyan beneath horizon so T-junction cracks in mountains pop unmistakably!
    sky = uCrackFlash > 0.5 ? vec3(0.74, 0.94, 1.0) : mix(vec3(0.68, 0.84, 0.96), vec3(0.32, 0.46, 0.62), clamp(-rd.y * 3.0, 0.0, 1.0));
  }
  float sunDot = max(dot(rd, sunDir), 0.0);
  sky += vec3(1.0, 0.88, 0.65) * (pow(sunDot, 16.0) * 0.35 + pow(sunDot, 220.0) * 1.4);
  oCol = vec4(sky, 1.0);
}`;

// Stage 0: 1992 Comanche Voxel Space (NovaLogic vertical heightmap terrain column strips, 0 polygons!)
export const VOXEL_FS = /* glsl */`#version 300 es
precision highp float;
in vec2 vUv;
out vec4 oCol;
uniform vec3 uCamPos, uCamRight, uCamUp, uCamFwd;
uniform float uTanHalfFov, uAspect;

float hash2(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
}
float noise2(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash2(i), hash2(i+vec2(1,0)), f.x),
             mix(hash2(i+vec2(0,1)), hash2(i+vec2(1,1)), f.x), f.y);
}
float terrainH(vec2 xz) {
  float river = sin(xz.y * 0.085) * 6.5 + cos(xz.y * 0.04) * 3.0;
  float vDist = abs(xz.x - river);
  float valley = smoothstep(2.2, 11.5, vDist);
  float h = 0.0, amp = 5.4, freq = 0.042;
  for (int i = 0; i < 4; i++) {
    float n = noise2(xz * freq + vec2(17.3, -11.7) * float(i));
    float r = 1.0 - abs(n * 2.0 - 1.0);
    h += r * r * amp;
    amp *= 0.46; freq *= 2.08;
  }
  return h * (0.18 + 0.88 * valley) + smoothstep(0.0, 4.5, vDist) * 0.45;
}

void main() {
  // Authentic 1992 320x200 chunky vertical column rasterization!
  vec2 qUv = (floor(vUv * vec2(260.0, 160.0)) + 0.5) / vec2(260.0, 160.0);
  vec2 ndc = qUv * 2.0 - 1.0;
  vec3 rd = normalize(uCamFwd + uCamRight * (ndc.x * uAspect * uTanHalfFov) + uCamUp * (ndc.y * uTanHalfFov));

  vec3 col = mix(vec3(0.70, 0.86, 0.96), vec3(0.18, 0.46, 0.82), clamp(rd.y * 1.6 + 0.1, 0.0, 1.0));
  float t = 1.0;
  for (int i = 0; i < 110; i++) {
    vec3 p = uCamPos + rd * t;
    vec2 cell = floor(p.xz * 1.4) / 1.4; // discrete vertical voxel column grid!
    float h = terrainH(cell);
    if (p.y <= h) {
      float hN = terrainH(cell + vec2(0.7, -0.5));
      float shade = clamp((h - hN) * 0.55 + 0.62, 0.25, 1.18);
      vec3 c = h < 0.72 ? vec3(0.14, 0.46, 0.64)
             : (h < 2.25 ? vec3(0.24, 0.54, 0.24)
             : (h < 4.50 ? vec3(0.48, 0.46, 0.42) : vec3(0.90, 0.93, 0.97)));
      float fog = smoothstep(22.0, 68.0, t);
      col = mix(c * shade, vec3(0.66, 0.82, 0.94), fog);
      break;
    }
    t += 0.35 + t * 0.025;
    if (t > 70.0) break;
  }
  oCol = vec4(col, 1.0);
}`;

export const TERRAIN_VS = /* glsl */`#version 300 es
precision highp float;

layout(location = 0) in vec3 aPos;
layout(location = 1) in vec3 aNorm;
layout(location = 2) in vec2 aBary;
layout(location = 3) in float aLod;
layout(location = 4) in float aCluster;

uniform mat4 uViewProj;

out vec3 vPos;
out vec3 vNorm;
out vec3 vBary;
out float vLod;
out float vCluster;

void main() {
  vPos = aPos;
  vNorm = aNorm;
  vBary = vec3(aBary.x, aBary.y, 1.0 - aBary.x - aBary.y);
  vLod = aLod;
  vCluster = aCluster;
  gl_Position = uViewProj * vec4(aPos, 1.0);
}`;

export const TERRAIN_FS = /* glsl */`#version 300 es
precision highp float;

in vec3 vPos;
in vec3 vNorm;
in vec3 vBary;
in float vLod;
in float vCluster;

uniform vec3 uCamPos;
uniform int uVisMode;      // 0=Shaded Alpine, 1=LOD Wireframe Overlay, 2=Nanite Pastel Clusters + Wire, 3=Virtual Tex Tiles
uniform int uRichDetail;   // 1 on Stage 6 (BF3 Virtual Texturing) & Stage 7 (Nanite Landscape)
uniform float uShowSkirts; // Highlight Stage 3 vertical skirts in vivid amber!

out vec4 oCol;

float hash21(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
}
float noise2(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash21(i), hash21(i+vec2(1,0)), f.x),
             mix(hash21(i+vec2(0,1)), hash21(i+vec2(1,1)), f.x), f.y);
}

vec3 lodColor(float lv) {
  int i = int(lv + 0.5);
  if (i == 0) return vec3(0.24, 0.94, 0.62); // L0 Finest: emerald mint
  if (i == 1) return vec3(0.32, 0.76, 1.00); // L1: electric cyan
  if (i == 2) return vec3(1.00, 0.80, 0.24); // L2: warm gold
  if (i == 3) return vec3(1.00, 0.44, 0.26); // L3: coral orange
  if (i == 7) return vec3(1.00, 0.26, 0.62); // Vertical Chunked Skirt: hot magenta!
  return vec3(0.72, 0.42, 0.96);             // L4+ Coarsest: violet
}

vec3 clusterColor(float id) {
  // Iconic UE5 Nanite pastel cluster palette!
  float h = fract(id * 0.61803398875);
  vec3 rgb = clamp(abs(mod(h * 6.0 + vec3(0.0, 4.0, 2.0), 6.0) - 3.0) - 1.0, 0.0, 1.0);
  return mix(vec3(0.95), rgb, 0.62);
}

void main() {
  vec3 N = normalize(vNorm);
  vec3 V = normalize(uCamPos - vPos);
  vec3 sunDir = normalize(vec3(0.58, 0.55, -0.60));
  float dist = length(vPos - uCamPos);

  // Micro-normal alpine rock strata detail (BF3 Virtual Texturing & Nanite!)
  if (uRichDetail == 1) {
    float n1 = noise2(vPos.xz * 1.6) - 0.5;
    float n2 = noise2(vPos.xz * 5.6 + vPos.y * 2.8) - 0.5;
    N = normalize(N + vec3(n1 * 0.32 + n2 * 0.22, 0.0, n2 * 0.26 - n1 * 0.22));
  }

  float slope = 1.0 - clamp(N.y, 0.0, 1.0);
  float h = vPos.y;

  // Dramatic sunlit alpine palette with high-contrast granite cliffs, emerald valleys & crisp snow!
  vec3 grass = vec3(0.14, 0.36, 0.15);
  vec3 moss  = vec3(0.26, 0.44, 0.18);
  vec3 rock  = vec3(0.32, 0.31, 0.32);
  vec3 cliff = vec3(0.18, 0.19, 0.21);
  vec3 snow  = vec3(0.95, 0.97, 1.00);
  vec3 river = vec3(0.08, 0.42, 0.62);

  float microTex = uRichDetail == 1 ? (noise2(vPos.xz * 2.4) * 0.55 + noise2(vPos.xz * 9.0) * 0.45) : noise2(vPos.xz * 0.7);
  vec3 alb = mix(grass, moss, microTex);
  float rockMask = smoothstep(0.13, 0.36, slope + (h - 2.0) * 0.09 + (microTex - 0.5) * 0.16);
  alb = mix(alb, mix(rock, cliff, smoothstep(0.32, 0.62, slope) + 0.28 * sin(h * 5.2 + microTex * 3.5)), rockMask);
  float snowMask = smoothstep(3.2, 4.7, h + (microTex - 0.5) * 0.85) * smoothstep(0.58, 0.22, slope);
  alb = mix(alb, snow, snowMask);
  float isWater = 1.0 - smoothstep(0.42, 0.62, h);
  alb = mix(alb, river, isWater);

  bool isSkirt = vLod > 6.5;
  if (isSkirt && uShowSkirts > 0.5) alb = vec3(1.0, 0.22, 0.58);

  float ndl = max(dot(N, sunDir), 0.0);
  float hemi = 0.20 + 0.20 * N.y;
  vec3 H = normalize(sunDir + V);
  float spec = pow(max(dot(N, H), 0.0), mix(24.0, 110.0, isWater)) * (isWater * 0.95 + snowMask * 0.26);

  vec3 col = alb * (vec3(0.56, 0.74, 0.98) * hemi + vec3(1.38, 1.24, 1.02) * ndl) + vec3(1.0, 0.94, 0.84) * spec;

  // Crisp anti-aliased barycentric wireframe (fwidth screen-space constant 1px!)
  vec3 dB = fwidth(vBary);
  vec3 edgeF = smoothstep(vec3(0.0), dB * 1.35, vBary);
  float wire = 1.0 - min(edgeF.x, min(edgeF.y, edgeF.z));

  if (uVisMode == 1) {
    // Color-coded LOD rings + razor-sharp wireframe overlay!
    vec3 lc = lodColor(vLod);
    col = mix(col * 0.68 + lc * 0.22, lc * 1.25, wire * 0.88);
  } else if (uVisMode == 2) {
    // UE5 Nanite-style vibrant pastel cluster meshlet visualization!
    vec3 cc = clusterColor(vCluster) * (0.45 + 0.65 * ndl);
    col = mix(cc, vec3(0.06, 0.08, 0.12), wire * 0.55);
  } else if (uVisMode == 3) {
    // BF3 Virtual Terrain Texture tile page grid overlay!
    vec2 tileUv = fract(vPos.xz * 0.22);
    vec2 g = min(tileUv, 1.0 - tileUv) / max(fwidth(vPos.xz * 0.22), vec2(0.002));
    float tileBorder = 1.0 - smoothstep(0.0, 1.6, min(g.x, g.y));
    col = mix(col, vec3(0.28, 0.92, 1.0), tileBorder * 0.65);
  }

  // Atmospheric alpine aerial perspective fog
  float fog = smoothstep(26.0, 74.0, dist);
  col = mix(col, vec3(0.68, 0.83, 0.96), fog);

  // Clean filmic rolloff + gamma
  col = col / (col + 0.68) * 1.28;
  col = pow(clamp(col, 0.0, 1.0), vec3(1.0 / 2.2));
  oCol = vec4(col, 1.0);
}`;

export const FRUSTUM_VS = /* glsl */`#version 300 es
precision highp float;
layout(location = 0) in vec3 aPos;
uniform mat4 uViewProj;
void main() { gl_Position = uViewProj * vec4(aPos, 1.0); }`;

export const FRUSTUM_FS = /* glsl */`#version 300 es
precision highp float;
out vec4 oCol;
void main() { oCol = vec4(1.0, 0.84, 0.22, 1.0); }`;
