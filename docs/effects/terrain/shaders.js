// WebGL2 Shaders for Evolution of Terrain & Level of Detail (1992-2024) — Eroded Swiss Alps Engine!
//   - 16-bit texelFetch bilinear sampling of 384x384 hydraulically eroded alpine-height.png (ZERO carry spikes!)
//   - Unified GPU vertex shader for Filip Strugar (2009) exact CDLOD geomorphing, Losasso & Hoppe (2004) Clipmaps,
//     Thatcher Ulrich (2002) vertical skirts, Willem de Boer (2000) GeoMipMapping, and Watertight Diamond ROAM!
//   - Pixel-perfect per-fragment central-difference normals + erosion snow couloirs + talus scree + glacial river!

const ALPINE_SAMPLER_GLSL = /* glsl */`
uniform sampler2D uHeightMap;

vec3 sampleAlpine(vec2 wxz) {
  vec2 uv = clamp((wxz + vec2(80.0)) / 160.0, vec2(0.0), vec2(1.0)) * 383.0;
  ivec2 i0 = ivec2(floor(uv));
  ivec2 i1 = min(i0 + ivec2(1), ivec2(383));
  vec2 f = uv - vec2(i0);
  vec4 t00 = texelFetch(uHeightMap, i0, 0);
  vec4 t10 = texelFetch(uHeightMap, ivec2(i1.x, i0.y), 0);
  vec4 t01 = texelFetch(uHeightMap, ivec2(i0.x, i1.y), 0);
  vec4 t11 = texelFetch(uHeightMap, i1, 0);
  float h00 = (t00.r * 65280.0 + t00.g * 255.0) / 65535.0;
  float h10 = (t10.r * 65280.0 + t10.g * 255.0) / 65535.0;
  float h01 = (t01.r * 65280.0 + t01.g * 255.0) / 65535.0;
  float h11 = (t11.r * 65280.0 + t11.g * 255.0) / 65535.0;
  float h    = mix(mix(h00, h10, f.x), mix(h01, h11, f.x), f.y) * 26.0;
  float flow = mix(mix(t00.b, t10.b, f.x), mix(t01.b, t11.b, f.x), f.y);
  float sed  = mix(mix(t00.a, t10.a, f.x), mix(t01.a, t11.a, f.x), f.y);
  return vec3(h, flow, sed);
}
`;

export const SKY_FS = /* glsl */`#version 300 es
precision highp float;
in vec2 vUv;
out vec4 oCol;
uniform vec3 uCamRight;
uniform vec3 uCamUp;
uniform vec3 uCamFwd;
uniform float uTanHalfFov;
uniform float uAspect;
uniform float uCrackFlash;
uniform float uTime;

float hash21(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash21(i), hash21(i + vec2(1, 0)), f.x),
             mix(hash21(i + vec2(0, 1)), hash21(i + vec2(1, 1)), f.x), f.y);
}

void main() {
  vec2 ndc = vUv * 2.0 - 1.0;
  vec3 rd = normalize(uCamFwd + uCamRight * (ndc.x * uTanHalfFov * uAspect) + uCamUp * (ndc.y * uTanHalfFov));
  vec3 sunDir = normalize(vec3(0.62, 0.34, -0.70));

  float y = clamp(rd.y, 0.0, 1.0);
  vec3 zenith  = vec3(0.11, 0.25, 0.52);
  vec3 horizon = vec3(0.68, 0.80, 0.92);
  vec3 sky = mix(horizon, zenith, pow(y, 0.58));

  // Crisp alpine golden-hour sun halo & drifting wispy cirrus clouds (eliminates static sky!)
  float sunAmt = max(dot(rd, sunDir), 0.0);
  sky += vec3(1.0, 0.84, 0.56) * pow(sunAmt, 10.0) * 0.42;
  sky += vec3(1.0, 0.96, 0.86) * pow(sunAmt, 180.0) * 1.1;

  if (rd.y > 0.02) {
    vec2 cloudUv = rd.xz / (rd.y + 0.18) * 1.15 + vec2(uTime * 0.018, -uTime * 0.011);
    float c = vnoise(cloudUv * 2.0) * 0.6 + vnoise(cloudUv * 4.5 + 3.1) * 0.4;
    float cloudMask = smoothstep(0.56, 0.84, c) * smoothstep(0.02, 0.22, rd.y);
    vec3 cloudCol = mix(vec3(0.92, 0.95, 0.99), vec3(1.0, 0.90, 0.76), pow(sunAmt, 3.0) * 0.6);
    sky = mix(sky, cloudCol, cloudMask * 0.42);
  }

  // On Stage 2 (2000 GeoMipMapping T-Junction Cracks), tint strictly below the valley floor so ONLY true cracks glow!
  if (uCrackFlash > 0.5) {
    sky = mix(sky, vec3(0.24, 0.96, 1.0), smoothstep(-0.14, -0.26, rd.y) * 0.92);
  }
  oCol = vec4(sky, 1.0);
}`;

// Stage 0: Authentic 1992 Comanche Voxel Space (NovaLogic vertical heightmap column strips, 0 polygons!)
export const VOXEL_FS = /* glsl */`#version 300 es
precision highp float;
in vec2 vUv;
out vec4 oCol;
uniform vec3 uCamPos;
uniform vec3 uCamRight;
uniform vec3 uCamUp;
uniform vec3 uCamFwd;
uniform float uTanHalfFov;
uniform float uAspect;
${ALPINE_SAMPLER_GLSL}

void main() {
  // Quantize screen into crisp 320-column retro VGA strips (classic 1992 Comanche 320x200 aesthetic!)
  float cols = 320.0;
  float colX = (floor(vUv.x * cols) + 0.5) / cols;
  float ndcX = colX * 2.0 - 1.0;
  float ndcY = (floor(vUv.y * 200.0) + 0.5) / 200.0 * 2.0 - 1.0;

  vec3 rdBase = normalize(uCamFwd + uCamRight * (ndcX * uTanHalfFov * uAspect));
  vec3 rdPix  = normalize(uCamFwd + uCamRight * (ndcX * uTanHalfFov * uAspect) + uCamUp * (ndcY * uTanHalfFov));
  vec3 skyCol = mix(vec3(0.76, 0.83, 0.78), vec3(0.24, 0.46, 0.74), clamp(rdPix.y * 2.1, 0.0, 1.0));
  vec3 col = skyCol;

  // Front-to-back vertical column painter's march along ray XZ
  vec2 dirXZ = normalize(rdBase.xz + vec2(1e-5));
  float maxY = -1e5;
  float z = 2.0;
  for (int i = 0; i < 128; i++) {
    vec2 p = uCamPos.xz + dirXZ * z;
    if (abs(p.x) > 79.5 || abs(p.y) > 79.5) break;
    vec3 samp = sampleAlpine(p);
    float h = samp.x;
    // Project terrain column top onto vertical view plane
    vec3 toTop = vec3(p.x, h, p.y) - uCamPos;
    float fwdD = max(0.5, dot(toTop, uCamFwd));
    float upD  = dot(toTop, uCamUp);
    float projY = upD / (fwdD * uTanHalfFov);

    if (projY > ndcY && projY > maxY) {
      // Classic Comanche shaded voxel column strip (sampled slope + height palette)
      float hL = sampleAlpine(p + vec2(0.85, -0.85)).x;
      float slopeShade = clamp(0.62 + (h - hL) * 0.42, 0.25, 1.25);
      vec3 c = h > 15.0 ? vec3(0.88, 0.90, 0.92)
             : (h > 8.0 ? vec3(0.46, 0.43, 0.36)
             : (h > 3.6 ? vec3(0.24, 0.42, 0.22) : vec3(0.18, 0.34, 0.42)));
      // Retro 16-level VGA color banding & distance fog!
      c = floor(c * slopeShade * 16.0) / 16.0;
      float fog = clamp((z - 18.0) / 92.0, 0.0, 1.0);
      col = mix(c, skyCol, fog * 0.82);
      break;
    }
    if (projY > maxY) maxY = projY;
    z += 0.42 + z * 0.014;
  }
  oCol = vec4(col, 1.0);
}`;

export const TERRAIN_VS = /* glsl */`#version 300 es
precision highp float;

layout(location = 0) in vec2 aGrid;        // Quadtree/Clipmap: (ix, iz); ROAM: (wx, wz)
layout(location = 1) in vec2 aBary;        // Triangle barycentric (bx, by)
layout(location = 2) in float aSkirtOrLod; // Patch: isSkirt (0/1); ROAM: lodLevel
layout(location = 3) in float aCluster;    // Patch: local cluster id; ROAM: tri id

uniform mat4 uViewProj;
uniform vec3 uLodCamPos;
uniform vec4 uPatchRect;    // Mode 0: (x0, z0, size, N); Mode 1: (originX, originZ, cellSize, M)
uniform vec2 uMorphRange;   // (morphStart, morphEnd) for Filip Strugar CDLOD geomorphing!
uniform int  uDrawMode;     // 0=Quadtree Patch, 1=Clipmap Ring, 2=Watertight ROAM
uniform float uUseMorph;
uniform float uPatchLod;
uniform float uPatchId;
${ALPINE_SAMPLER_GLSL}

out vec3 vWorldPos;
out vec2 vBary;
out float vLod;
out float vCluster;
out float vIsSkirt;
out float vMorphAmt;

void main() {
  vec2 wxz;
  float lod = uPatchLod;
  float cid = uPatchId * 64.0 + aCluster;
  float isSkirt = 0.0;
  float morphAmt = 0.0;

  if (uDrawMode == 0) {
    // Fixed-root World-Space Quadtree Patch (GeoMipMapping / Chunked Skirts / CDLOD / BF3 / Nanite!)
    float N = uPatchRect.w;
    vec2 baseXZ = uPatchRect.xy + (aGrid / N) * uPatchRect.z;
    vec2 gridPos = aGrid;
    isSkirt = aSkirtOrLod;

    if (uUseMorph > 0.5 && isSkirt < 0.5) {
      // Exact Filip Strugar (2009) CDLOD geomorphing: smoothly snap odd vertices onto parent even grid!
      float dist = length(vec3(baseXZ.x - uLodCamPos.x, max(0.0, uLodCamPos.y - 10.0) * 0.45, baseXZ.y - uLodCamPos.z));
      morphAmt = clamp((dist - uMorphRange.x) / max(uMorphRange.y - uMorphRange.x, 0.001), 0.0, 1.0);
      vec2 odd = mod(aGrid, 2.0);
      gridPos = aGrid - odd * morphAmt;
    }
    wxz = uPatchRect.xy + (gridPos / N) * uPatchRect.z;
  } else if (uDrawMode == 1) {
    // Losasso & Hoppe (2004) Nested Concentric Geometry Clipmaps with smooth outer-border parent transition!
    float M = uPatchRect.w;
    float halfM = M * 0.5;
    vec2 rel = aGrid - vec2(halfM);
    float edgeDist = max(abs(rel.x), abs(rel.y)) / halfM;
    morphAmt = smoothstep(0.74, 0.99, edgeDist);
    vec2 odd = mod(aGrid, 2.0);
    vec2 mGrid = aGrid - odd * morphAmt;
    wxz = uPatchRect.xy + (mGrid - vec2(halfM)) * uPatchRect.z;
  } else {
    // Duchaineau (1997) Watertight Diamond ROAM Bintree!
    wxz = aGrid;
    lod = aSkirtOrLod;
    cid = aCluster;
  }

  vec3 alp = sampleAlpine(wxz);
  float y = alp.x;
  if (isSkirt > 0.5) {
    // Thatcher Ulrich (2002) vertical perimeter skirt sealing GeoMipMapping T-junction cracks!
    y -= max(2.2, uPatchRect.z * 0.18);
  }

  vWorldPos = vec3(wxz.x, y, wxz.y);
  vBary = aBary;
  vLod = lod;
  vCluster = cid;
  vIsSkirt = isSkirt;
  vMorphAmt = morphAmt;
  gl_Position = uViewProj * vec4(vWorldPos, 1.0);
}`;

export const TERRAIN_FS = /* glsl */`#version 300 es
precision highp float;

in vec3 vWorldPos;
in vec2 vBary;
in float vLod;
in float vCluster;
in float vIsSkirt;
in float vMorphAmt;

uniform vec3 uCamPos;
uniform int uVisMode;      // 0=Shaded Alpine, 1=LOD Color Wireframe, 2=Nanite Pastel Clusters, 3=BF3 Virtual Tex Pages
uniform int uRichDetail;   // 1 on BF3 / Nanite (rich triplanar granite & erosion detail!)
uniform float uShowSkirts; // 1 highlights Thatcher Ulrich vertical skirts in vivid magenta!
${ALPINE_SAMPLER_GLSL}

out vec4 oCol;

float hash21(vec2 p) {
  p = fract(p * vec2(127.1, 311.7));
  p += dot(p, p + 34.53);
  return fract(p.x * p.y);
}
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash21(i), hash21(i + vec2(1, 0)), f.x),
             mix(hash21(i + vec2(0, 1)), hash21(i + vec2(1, 1)), f.x), f.y);
}
float fbm2(vec2 p) {
  return vnoise(p) * 0.62 + vnoise(p * 2.13 + 5.7) * 0.27 + vnoise(p * 4.41 + 11.3) * 0.11;
}

vec3 lodPalette(float lv) {
  int i = int(clamp(floor(lv + 0.5), 0.0, 5.0));
  if (i == 0) return vec3(0.16, 0.94, 0.62); // L0 finest: emerald mint
  if (i == 1) return vec3(0.24, 0.78, 1.00); // L1: sky cyan
  if (i == 2) return vec3(0.98, 0.84, 0.24); // L2: warm gold
  if (i == 3) return vec3(0.98, 0.46, 0.24); // L3: bright orange
  if (i == 4) return vec3(0.88, 0.28, 0.64); // L4: magenta
  return vec3(0.64, 0.42, 0.96);             // L5 coarsest: violet
}

vec3 nanitePastel(float id) {
  float h1 = fract(sin(id * 12.9898 + 1.23) * 43758.5453);
  float h2 = fract(sin(id * 78.2330 + 4.56) * 23421.6312);
  float h3 = fract(sin(id * 37.7190 + 7.89) * 19191.1919);
  return vec3(0.32 + 0.64 * h1, 0.34 + 0.62 * h2, 0.38 + 0.58 * h3);
}

void main() {
  // Highlight Thatcher Ulrich vertical skirts in vivid neon magenta when toggled!
  if (vIsSkirt > 0.08 && uShowSkirts > 0.5) {
    oCol = vec4(0.98, 0.14, 0.66, 1.0);
    return;
  }

  // Pixel-perfect central-difference normals directly from 16-bit alpine-height.png -> ZERO LOD normal flickering!
  vec2 wxz = vWorldPos.xz;
  float eps = 0.42;
  vec3 cData = sampleAlpine(wxz);
  float hL = sampleAlpine(wxz - vec2(eps, 0.0)).x;
  float hR = sampleAlpine(wxz + vec2(eps, 0.0)).x;
  float hD = sampleAlpine(wxz - vec2(0.0, eps)).x;
  float hU = sampleAlpine(wxz + vec2(0.0, eps)).x;
  vec3 N = normalize(vec3(hL - hR, 2.0 * eps, hD - hU));

  float h = cData.x;
  float flow = cData.y; // Hydraulic erosion gully/couloir mask!
  float sed  = cData.z; // Deposited scree/talus fan mask!

  // Rich procedural micro-strata & granite bump detail
  float rockNoise = fbm2(wxz * 0.45);
  float microNoise = uRichDetail == 1 ? fbm2(wxz * 2.6 + vec2(h * 0.9, -h * 0.6)) : rockNoise;
  if (uRichDetail == 1) {
    float strata = sin(h * 4.2 + rockNoise * 3.8) * 0.5 + 0.5;
    N = normalize(N + vec3((microNoise - 0.5) * 0.24, 0.0, (strata - 0.5) * 0.22) * (1.0 - smoothstep(0.75, 0.96, N.y)));
  }

  // High-contrast Swiss Alps Biome Shading driven by real elevation, slope & hydraulic erosion gullies!
  float slope = 1.0 - clamp(N.y, 0.0, 1.0);
  vec3 meadow = mix(vec3(0.09, 0.25, 0.07), vec3(0.19, 0.34, 0.10), rockNoise);
  vec3 pine   = mix(vec3(0.04, 0.13, 0.06), vec3(0.08, 0.19, 0.08), rockNoise);
  vec3 scree  = mix(vec3(0.22, 0.21, 0.20), vec3(0.34, 0.31, 0.28), microNoise);
  vec3 cliff  = mix(vec3(0.11, 0.13, 0.17), vec3(0.24, 0.25, 0.28), microNoise);
  vec3 snow   = vec3(0.95, 0.97, 1.00);

  // Rich emerald valley floor -> dark pine treeline -> dramatic charcoal granite cliffs -> crisp sunlit snow summits!
  vec3 albedo = mix(meadow, pine, smoothstep(3.2, 5.8, h) * (1.0 - smoothstep(8.2, 11.4, h)) * 0.86);
  albedo = mix(albedo, scree, smoothstep(6.8, 11.2, h) * 0.88);
  albedo = mix(albedo, cliff, smoothstep(0.11, 0.28, slope));

  // Crisp sunlit snow caps on high alpine summits (13m+) & snow-filled hydraulic erosion couloirs, leaving dark cliffs exposed!
  float snowMask = smoothstep(12.8, 16.8, h + rockNoise * 2.2 - slope * 9.5 + flow * 4.5);
  snowMask = max(snowMask, smoothstep(0.32, 0.72, flow) * smoothstep(8.5, 13.0, h) * 0.82);
  albedo = mix(albedo, snow, clamp(snowMask, 0.0, 1.0));

  // Glacial turquoise alpine creek winding through the lowest eroded valley floor!
  float isWater = (1.0 - smoothstep(2.45, 3.15, h)) * (1.0 - smoothstep(0.03, 0.12, slope));
  albedo = mix(albedo, vec3(0.04, 0.28, 0.42), isWater);

  // Sculptural golden-hour alpine cross-lighting + 4-step terrain self-shadowing + cool indigo shadow fill!
  vec3 sunDir = normalize(vec3(0.74, 0.36, -0.56));
  vec3 V = normalize(uCamPos - vWorldPos);
  float sh = 1.0;
  for (int k = 1; k <= 4; k++) {
    float sd = float(k) * 3.8;
    float shH = sampleAlpine(wxz + sunDir.xz * sd).x;
    float rayH = h + sunDir.y * sd;
    if (shH > rayH + 0.14) sh *= 0.56;
  }
  float ndl = max(dot(N, sunDir), 0.0) * sh;
  float skyAmb = 0.20 + 0.24 * clamp(N.y, 0.0, 1.0);
  float creviceAO = 1.0 - clamp(flow * 0.34, 0.0, 0.34);

  vec3 H = normalize(sunDir + V);
  float specStr = mix(0.05, 0.52, max(snowMask * 0.45, isWater));
  float spec = pow(max(dot(N, H), 0.0), mix(28.0, 96.0, isWater)) * specStr * sh;

  vec3 col = albedo * (skyAmb * vec3(0.46, 0.64, 0.94) * creviceAO + ndl * vec3(1.58, 1.34, 1.06))
           + vec3(1.0, 0.94, 0.84) * spec;

  // Clean distant aerial perspective (keeps foreground & midground peaks crisp and deeply contrasted!)
  float dist = length(uCamPos - vWorldPos);
  float fog = 1.0 - exp(-max(0.0, dist - 24.0) * 0.0052);
  vec3 fogCol = vec3(0.56, 0.72, 0.90);
  col = mix(col, fogCol, clamp(fog, 0.0, 0.72));

  // Crisp anti-aliased barycentric wireframe & diagnostic visualizations!
  vec3 b3 = vec3(vBary, max(0.0, 1.0 - vBary.x - vBary.y));
  vec3 fw = max(fwidth(b3), vec3(1e-4));
  float edge = 1.0 - smoothstep(0.0, 1.35, min(min(b3.x / fw.x, b3.y / fw.y), b3.z / fw.z));

  if (uVisMode == 1) {
    // Color-coded LOD level wireframe overlay (crystal clear ROAM / Clipmaps / CDLOD triangle density!)
    vec3 lc = lodPalette(vLod);
    col = mix(col * 0.78, lc, 0.16);
    col = mix(col, lc, edge * 0.86);
  } else if (uVisMode == 2) {
    // UE5 Nanite Cluster LOD visualization (crisp pastel meshlet mosaic + micro-triangle shading!)
    vec3 nc = nanitePastel(vCluster);
    vec3 shadedCluster = nc * (0.42 + 0.68 * max(dot(N, sunDir), 0.15));
    col = mix(shadedCluster, shadedCluster * 0.62, edge * 0.45);
    col = mix(col, fogCol, clamp(fog * 0.45, 0.0, 0.45));
  } else if (uVisMode == 3) {
    // Battlefield 3 Frostbite 2 Virtual Terrain Texture page-cache grid (tile size adapts with distance!)
    float mipSz = exp2(clamp(floor(log2(max(dist * 0.18, 1.0))), 0.0, 4.0)) * 4.0;
    vec2 tp = wxz / mipSz;
    vec2 g = abs(fract(tp - 0.5) - 0.5) / max(fwidth(tp), vec2(0.002));
    float tileBorder = 1.0 - smoothstep(0.0, 1.6, min(g.x, g.y));
    vec3 pageTint = lodPalette(log2(mipSz / 4.0));
    col = mix(col, pageTint, 0.14 + tileBorder * 0.78);
  }

  // Khronos-style crisp filmic tone map + gamma
  col = col / (col + 0.55) * 1.24;
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
