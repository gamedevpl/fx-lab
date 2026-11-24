// Evolution of Surface Detail (1978-2026) — Analytical Heightfield + 8-Era WebGL2 Shaders:
//   0: 1978 Bump Mapping (Jim Blinn, SIGGRAPH 1978 — grayscale height derivative normal perturbation; split vs Flat Texture!)
//   1: 1998 Normal Mapping (Cohen & Cignoni 1998; Evolva/Giants 2000; popularized by Doom 3 2004 — sharp micro-bevels, flat silhouette)
//   2: 2001 Parallax / Offset Mapping (Kaneko 2001 / Welsh 2004 — 1-step UV offset gives depth, swims at grazing angles)
//   3: 2005 Relief Mapping (Policarpo et al., I3D 2005 — linear raymarch + binary search eliminates grazing swim, basic flat silhouette)
//   4: 2006 Parallax Occlusion Mapping / POM (Tatarchuk, GDC 2006 — adaptive march + crisp heightfield soft self-shadows, flat silhouette!)
//   5: 2009 Programmable DX11 Tessellation (Direct3D 11 / Heaven 2009; hardware tess existed earlier in TruForm '01 & Xbox 360 '05 — REAL 3D silhouette!)
//   6: 2018-20 Mesh Shaders & Meshlets (NVIDIA Turing 2018 -> DX12 Ultimate March 2020 — spatial 64-128 tri packets + cluster view!)
//   7: 2022-26 Virtualized Micropolygon Geometry (UE5 Nanite — demo 2020, UE 5.0 2022 — fine micro-stone chiseling & cluster LOD view!)
// Note: WebGL2 has no native hardware tessellation or mesh shaders, so Stages 5-7 emulate real displacement & meshlets via dense GPU meshes.

const HEIGHT_COMMON = /* glsl */`
float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

float vNoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(hash12(i), hash12(i + vec2(1.0, 0.0)), f.x),
    mix(hash12(i + vec2(0.0, 1.0)), hash12(i + vec2(1.0, 1.0)), f.x),
    f.y
  );
}

float fbm(vec2 p) {
  float v = 0.0, a = 0.5;
  mat2 m = mat2(0.8, 0.6, -0.6, 0.8);
  for (int i = 0; i < 3; i++) {
    v += a * vNoise(p);
    p = m * p * 2.03;
    a *= 0.5;
  }
  return v;
}

// Rich procedural architectural stone-and-relief heightfield shared identically by Fragment (POM) & Vertex (Displacement)!
// Returns vec4(height [0..1], mortarMask [0=stone,1=mortar], metalMask, blockId)
vec4 evalSurface(vec2 uv, float matPart, float microWeight) {
  if (matPart > 1.5) {
    // Weathered carved cornice / stone cap
    float n = fbm(uv * 3.5);
    float bevel = smoothstep(0.0, 0.15, fract(uv.x * 2.0)) * smoothstep(0.0, 0.15, 1.0 - fract(uv.x * 2.0));
    float h = clamp(0.45 + 0.35 * bevel + (n - 0.5) * 0.22 * (0.4 + 0.6 * microWeight), 0.0, 1.0);
    return vec4(h, 1.0 - bevel, 0.0, 0.5);
  }

  if (matPart > 0.5) {
    // Circular courtyard cobblestone floor (deep recessed mortar + proud rounded cobbles!)
    vec2 g = uv * vec2(2.4, 2.4);
    float row = floor(g.y);
    g.x += mod(row, 2.0) * 0.5;
    vec2 cell = floor(g);
    vec2 f = fract(g);
    float bid = hash12(cell + vec2(11.3, 4.7));
    float wX = 0.065 + 0.025 * hash12(cell + vec2(3.1, 7.2));
    float wY = 0.085;
    float edgeX = smoothstep(0.0, wX + 0.08, f.x) * smoothstep(0.0, wX + 0.08, 1.0 - f.x);
    float edgeY = smoothstep(0.0, wY + 0.08, f.y) * smoothstep(0.0, wY + 0.08, 1.0 - f.y);
    float dome = pow(clamp(edgeX * edgeY, 0.0, 1.0), 0.55);
    float crown = 0.42 + 0.44 * bid;
    float grain = (fbm(uv * 11.0 + bid * 7.0) - 0.5) * 0.14 * microWeight;
    float h = clamp(dome * crown + grain * dome, 0.0, 1.0);
    float mortar = 1.0 - smoothstep(0.10, 0.30, dome);
    return vec4(h, mortar, 0.0, bid);
  }

  // HERO CARVED ROMANESQUE STONE COLUMN (uv.x in [0..4], uv.y in [0..3])
  // Features:
  //   - Bottom & top running-bond deep ashlar stone blocks (proud alternating blocks push right past the silhouette!)
  //   - Central raised carved chevron & diamond relief frieze (uv.y in [1.18..1.82]) framed by riveted bronze bands!
  float vy = uv.y; // 0..3

  // Riveted bronze collar bands framing the central carved frieze
  float bandLo = 1.0 - smoothstep(0.055, 0.085, abs(vy - 1.14));
  float bandHi = 1.0 - smoothstep(0.055, 0.085, abs(vy - 1.86));
  float band = max(bandLo, bandHi);
  if (band > 0.05) {
    float rivetPhase = fract(uv.x * 6.0);
    float rDist = length(vec2((rivetPhase - 0.5) * 1.15, (min(abs(vy - 1.14), abs(vy - 1.86))) * 11.5));
    float rivet = smoothstep(0.42, 0.14, rDist);
    float hBand = clamp(0.62 * band + 0.34 * rivet, 0.0, 1.0);
    return vec4(hBand, 0.0, smoothstep(0.15, 0.6, band), 0.77);
  }

  // Central carved geometric relief medallion frieze (vy in 1.18..1.82)
  if (vy > 1.18 && vy < 1.82) {
    float fy = (vy - 1.18) / 0.64; // 0..1
    float fx = fract(uv.x * 2.0);   // 8 carved plaques around circumference
    float pid = hash12(vec2(floor(uv.x * 2.0), 19.0));
    vec2 p = abs(vec2(fx - 0.5, fy - 0.5));
    // Raised bevel frame + proud central diamond boss + recessed relief flutes
    float frame = max(smoothstep(0.36, 0.44, p.x), smoothstep(0.36, 0.44, p.y));
    float outerCut = smoothstep(0.495, 0.455, max(p.x, p.y));
    float diamond = smoothstep(0.33, 0.16, p.x + p.y);
    float innerGem = smoothstep(0.16, 0.05, max(p.x, p.y));
    float chisel = (fbm(uv * 18.0) - 0.5) * 0.12 * microWeight;
    float hFrieze = (0.16 + 0.42 * frame + 0.52 * diamond + 0.24 * innerGem) * outerCut + chisel * outerCut;
    float mortar = 1.0 - outerCut;
    return vec4(clamp(hFrieze, 0.0, 1.0), mortar, 0.0, pid);
  }

  // Deep running-bond Ashlar Stone & Weathered Masonry Courses!
  vec2 g = vec2(uv.x * 2.5, uv.y * 4.0); // 10 stones around circumference, 12 courses high
  float row = floor(g.y);
  g.x += mod(row, 2.0) * 0.5;
  vec2 cell = floor(g);
  vec2 f = fract(g);
  // Tile seamlessly around circumference (10 stones wide -> wrap cell.x mod 10!)
  vec2 wCell = vec2(mod(cell.x, 10.0), cell.y);
  float bid = hash12(wCell + vec2(5.1, 13.7));
  float bid2 = hash12(wCell + vec2(27.4, 2.9));

  // Crisp deep mortar seams + chunky proud stone faces with jagged hand-dressed edges
  float warp = (vNoise(vec2(uv.x * 16.0, uv.y * 16.0)) - 0.5) * 0.065;
  float edgeX = smoothstep(0.03, 0.14, f.x + warp) * smoothstep(0.03, 0.14, 1.0 - f.x - warp);
  float edgeY = smoothstep(0.04, 0.16, f.y + warp) * smoothstep(0.04, 0.16, 1.0 - f.y - warp);
  float blockMask = pow(clamp(edgeX * edgeY, 0.0, 1.0), 0.52);

  // Vary individual stone protrusion dramatically (0.45..0.95) so blocks physically JUT OUT of the silhouette!
  float protrusion = 0.46 + 0.50 * bid;
  // Subtle chisel face facet + weathered stone pits
  float faceTilt = ((f.x - 0.5) * (bid2 - 0.5) * 0.28 + (f.y - 0.5) * (bid - 0.5) * 0.22);
  float chisel = (fbm(uv * 16.0 + bid * 5.0) - 0.5) * 0.16 * microWeight;
  float crack = smoothstep(0.06, 0.0, abs(vNoise(uv * 10.0 + bid * 9.0) - 0.5)) * 0.16 * microWeight;

  float h = clamp(blockMask * (protrusion + faceTilt + chisel - crack), 0.0, 1.0);
  float mortar = 1.0 - smoothstep(0.12, 0.35, blockMask);
  return vec4(h, mortar, 0.0, bid);
}
`;

// ============================================================================
// BACKGROUND TWILIGHT ARCHITECTURAL STUDIO SKY (Full-Screen Quad)
// ============================================================================
export const BG_FS = `#version 300 es
precision highp float;

in vec2 vUv;
uniform vec3 uCamRight;
uniform vec3 uCamUp;
uniform vec3 uCamFwd;
uniform float uTanHalfFov;
uniform float uAspect;
uniform vec3 uLightPos;
uniform vec3 uCamPos;
uniform float uShowSilGuide; // Optional amber vertical reference line on Silhouette Check!
out vec4 outColor;

void main() {
  vec2 ndc = vUv * 2.0 - 1.0;
  vec3 rd = normalize(uCamFwd + ndc.x * uAspect * uTanHalfFov * uCamRight + ndc.y * uTanHalfFov * uCamUp);

  // Deep slate-blue twilight backdrop -> makes warm sunlit stone & cool blue rim silhouette POP!
  float h = clamp(rd.y * 0.5 + 0.5, 0.0, 1.0);
  vec3 bot = vec3(0.025, 0.036, 0.058);
  vec3 mid = vec3(0.058, 0.092, 0.155);
  vec3 top = vec3(0.018, 0.032, 0.072);
  vec3 col = mix(bot, mid, smoothstep(0.32, 0.54, h));
  col = mix(col, top, smoothstep(0.54, 0.92, h));

  // Subtle cool moonlit halo behind left edge of pillar to spotlight the silhouette!
  vec3 rimDir = normalize(vec3(-0.68, 0.22, -0.70));
  float rm = max(dot(rd, rimDir), 0.0);
  col += vec3(0.16, 0.34, 0.62) * pow(rm, 6.0) * 0.42;

  // Soft warm glow around the live orbiting/clickable grazing torch orb!
  vec3 toL = uLightPos - uCamPos;
  float ld = max(dot(rd, normalize(toL)), 0.0);
  col += vec3(1.0, 0.58, 0.18) * pow(ld, 24.0) * 0.35;
  col += vec3(1.0, 0.92, 0.72) * smoothstep(0.9975, 0.9994, ld) * 1.8;

  // Subtle radial vignette
  float vig = 1.0 - dot(ndc * vec2(0.55, 0.65), ndc * vec2(0.55, 0.65)) * 0.35;
  col *= vig;
  col = pow(clamp(col, 0.0, 1.0), vec3(1.0 / 2.2));
  outColor = vec4(col, 1.0);
}
`;

// ============================================================================
// MAIN SURFACE DETAIL MESH SHADER (Stages 0..7 + Wireframe & Meshlet Debug!)
// ============================================================================
export const MESH_VS = `#version 300 es
precision highp float;

layout(location = 0) in vec3 aPos;
layout(location = 1) in vec3 aNorm;
layout(location = 2) in vec3 aTan;
layout(location = 3) in vec2 aUv;
layout(location = 4) in vec2 aMeta; // x = clusterId, y = matPart

uniform mat4 uViewProj;
uniform int uStage;
uniform float uFlatMode; // Split-screen Stage 0 left: Flat diffuse texture (pre-1978)

out vec3 vWorldPos;
out vec3 vNorm;
out vec3 vTan;
out vec2 vUv;
out float vClusterId;
out float vMatPart;
out float vDispH;

${HEIGHT_COMMON}

void main() {
  vec3 pos = aPos;
  vec3 N = normalize(aNorm);
  vec3 T = normalize(aTan);
  float hOut = 0.0;

  // Stages 5 (2009 DX11 Tessellation), 6 (2018-20 Meshlets), 7 (2022-26 Virtualized Micropolygons):
  // TRUE 3D VERTEX DISPLACEMENT pushes protruding stone blocks OUT PAST the flat cylinder silhouette!
  if (uStage >= 5 && uFlatMode < 0.5) {
    float microW = (uStage == 7) ? 1.0 : ((uStage == 6) ? 0.75 : 0.45);
    vec4 s = evalSurface(aUv, aMeta.y, microW);
    float dispScale = (aMeta.y < 0.5) ? 0.155 : ((aMeta.y < 1.5) ? 0.115 : 0.045);
    // Taper gently at the very top/bottom cylinder seam so cap & floor meet cleanly without cracks!
    float seamMask = 1.0;
    if (aMeta.y < 0.5) {
      seamMask = smoothstep(0.0, 0.06, aUv.y) * smoothstep(3.0, 2.94, aUv.y);
    } else if (aMeta.y < 1.5) {
      float r = length(aPos.xz);
      seamMask = smoothstep(2.65, 2.42, r);
    }
    hOut = s.x * seamMask;
    pos += N * (hOut * dispScale);
  }

  vWorldPos = pos;
  vNorm = N;
  vTan = T;
  vUv = aUv;
  vClusterId = aMeta.x;
  vMatPart = aMeta.y;
  vDispH = hOut;
  gl_Position = uViewProj * vec4(pos, 1.0);
}
`;

export const MESH_FS = `#version 300 es
precision highp float;
precision highp int;

in vec3 vWorldPos;
in vec3 vNorm;
in vec3 vTan;
in vec2 vUv;
in float vClusterId;
in float vMatPart;
in float vDispH;

uniform vec3 uCamPos;
uniform vec3 uLightPos;
uniform int uStage;
uniform float uFlatMode;    // 1.0 = Pre-1978 flat texture baseline (no bump, no normal, no displacement)
uniform float uDebugMode;   // 0=Shaded, 1=Wireframe (Stage 5), 2=Meshlet/Nanite Cluster Colors (Stages 6-7)
uniform float uTime;

out vec4 outColor;

${HEIGHT_COMMON}

vec3 clusterColor(float id) {
  // Vibrant distinct UE5 Nanite / Meshlet debug palette (teal, coral, gold, violet, mint, sky, amber)
  vec3 c = 0.52 + 0.46 * cos(6.28318 * (fract(id * 0.381966 + 0.13) + vec3(0.00, 0.33, 0.67)));
  return c;
}

vec3 evalAlbedo(vec2 uv, vec4 surf, float matPart, float isLegacy) {
  float mortar = surf.y;
  float metal = surf.z;
  float bid = surf.w;

  // Warm Romanesque limestone / sandstone + weathered ochre & cool mortar variation
  vec3 stoneA = vec3(0.58, 0.52, 0.44);
  vec3 stoneB = vec3(0.42, 0.38, 0.35);
  vec3 stoneC = vec3(0.64, 0.49, 0.36);
  vec3 sCol = mix(mix(stoneA, stoneB, bid), stoneC, fract(bid * 3.7) * 0.55);
  if (matPart > 0.5 && matPart < 1.5) {
    // Darker slate cobblestones on courtyard floor
    sCol = mix(vec3(0.24, 0.27, 0.33), vec3(0.38, 0.35, 0.32), bid);
  }
  float grain = fbm(uv * 14.0 + bid * 3.0);
  sCol *= (0.82 + 0.34 * grain);
  // Subtle crevice grime near mortar
  vec3 mortarCol = vec3(0.14, 0.13, 0.12);
  vec3 col = mix(sCol, mortarCol, mortar * 0.85);
  // Riveted aged bronze collar bands
  vec3 bronzeCol = vec3(0.76, 0.54, 0.24) * (0.86 + 0.25 * grain);
  col = mix(col, bronzeCol, metal);
  // 1978 Bump era has slightly simpler matte stone tone
  if (isLegacy > 0.5) col = mix(col, vec3(0.48, 0.45, 0.41), 0.25);
  return col;
}

// Compute crisp tangent-space normal from procedural heightfield
vec3 evalNormalTS(vec2 uv, float matPart, float microWeight, float strength) {
  float eps = (microWeight > 0.8) ? 0.0045 : 0.0085;
  float hL = evalSurface(uv - vec2(eps, 0.0), matPart, microWeight).x;
  float hR = evalSurface(uv + vec2(eps, 0.0), matPart, microWeight).x;
  float hD = evalSurface(uv - vec2(0.0, eps), matPart, microWeight).x;
  float hU = evalSurface(uv + vec2(0.0, eps), matPart, microWeight).x;
  float dx = (hR - hL) / (2.0 * eps);
  float dy = (hU - hD) / (2.0 * eps);
  return normalize(vec3(-dx * strength, -dy * strength, 1.0));
}

// Soft heightfield self-shadowing (Tatarchuk GDC 2006 POM & displaced micro-shadows!)
float evalHeightShadow(vec2 uv, float h0, vec3 lDirTS, float matPart, vec2 depthScaleUv) {
  // Smooth grazing fade instead of hard lDirTS.z <= 0.04 step -> ZERO vertical shadow terminator seam on cylinder!
  float grazingFade = smoothstep(-0.02, 0.28, lDirTS.z);
  if (grazingFade <= 0.001) return 0.14;
  vec2 stepUv = (lDirTS.xy / max(lDirTS.z, 0.28)) * depthScaleUv;
  float sh = 0.0;
  const int S_STEPS = 10;
  for (int i = 1; i <= S_STEPS; i++) {
    float frac = float(i) / float(S_STEPS);
    float sampleH = evalSurface(uv + stepUv * frac, matPart, 0.4).x;
    float rayH = h0 + frac * (1.0 - h0);
    float occl = (sampleH - rayH) * (1.0 - frac * 0.42) * 4.8;
    sh = max(sh, occl);
  }
  return mix(0.14, clamp(1.0 - sh, 0.12, 1.0), grazingFade);
}

void main() {
  vec3 Ngeom = normalize(vNorm);
  vec3 T = normalize(vTan - Ngeom * dot(vTan, Ngeom));
  vec3 B = normalize(cross(Ngeom, T));
  mat3 TBN = mat3(T, B, Ngeom);

  vec3 V = normalize(uCamPos - vWorldPos);
  vec3 Vts = normalize(transpose(TBN) * V);
  vec3 Lvec = uLightPos - vWorldPos;
  float Ldist = length(Lvec);
  vec3 L = Lvec / max(Ldist, 0.001);
  vec3 Lts = normalize(transpose(TBN) * L);

  vec2 uv = vUv;
  // Exact UV-space height depth matching 3D vertex displacement (dispScale = 0.155 on cylinder, 0.115 on floor)!
  vec2 depthScaleUv = (vMatPart < 0.5) ? vec2(0.115, 0.160) : ((vMatPart < 1.5) ? vec2(0.075, 0.075) : vec2(0.03, 0.03));
  float selfShadow = 1.0;

  if (uFlatMode < 0.5) {
    if (uStage == 2) {
      // ERA 3 (2001): Kaneko (2001) / Welsh (2004) Single-Step Parallax / Offset Mapping
      // One UV offset -> gives illusion of depth straight-on, visibly SWIMS & STRETCHES at grazing angles!
      float h = evalSurface(uv, vMatPart, 0.45).x;
      vec2 offset = (Vts.xy / max(Vts.z, 0.30)) * depthScaleUv * ((1.0 - h) * 0.85);
      uv -= offset;
    } else if (uStage == 3) {
      // ERA 4 (2005): Policarpo et al. (I3D 2005) Relief Mapping — Linear Raymarch + 6-Step Binary Search!
      const int LIN = 18;
      vec2 deltaUv = (Vts.xy / max(Vts.z, 0.24)) * depthScaleUv;
      float curLayer = 1.0;
      float dLayer = 1.0 / float(LIN);
      vec2 dUv = deltaUv * dLayer;
      vec2 curUv = uv;
      float h = evalSurface(curUv, vMatPart, 0.5).x;
      for (int i = 0; i < LIN; i++) {
        if (curLayer <= h) break;
        curUv -= dUv;
        curLayer -= dLayer;
        h = evalSurface(curUv, vMatPart, 0.5).x;
      }
      vec2 stepUv = dUv * 0.5;
      float stepL = dLayer * 0.5;
      for (int b = 0; b < 6; b++) {
        h = evalSurface(curUv, vMatPart, 0.5).x;
        if (curLayer < h) { curUv += stepUv; curLayer += stepL; }
        else { curUv -= stepUv; curLayer -= stepL; }
        stepUv *= 0.5;
        stepL *= 0.5;
      }
      uv = curUv;
    } else if (uStage == 4) {
      // ERA 5 (2006): Tatarchuk (GDC 2006) Parallax Occlusion Mapping (POM) + Soft Self-Shadowing!
      float grazing = 1.0 - clamp(Vts.z, 0.0, 1.0);
      int steps = int(mix(12.0, 28.0, grazing));
      vec2 deltaUv = (Vts.xy / max(Vts.z, 0.22)) * depthScaleUv;
      float dLayer = 1.0 / float(steps);
      vec2 dUv = deltaUv * dLayer;
      vec2 curUv = uv;
      float curLayer = 1.0;
      float h = evalSurface(curUv, vMatPart, 0.6).x;
      vec2 prevUv = curUv;
      float prevH = h, prevL = curLayer;
      for (int i = 0; i < 28; i++) {
        if (i >= steps || curLayer <= h) break;
        prevUv = curUv; prevH = h; prevL = curLayer;
        curUv -= dUv;
        curLayer -= dLayer;
        h = evalSurface(curUv, vMatPart, 0.6).x;
      }
      float afterD = h - curLayer;
      float beforeD = prevL - prevH;
      float w = clamp(beforeD / max(beforeD + afterD, 1e-4), 0.0, 1.0);
      uv = mix(prevUv, curUv, w);
      float finalH = mix(prevH, h, w);
      selfShadow = evalHeightShadow(uv, finalH, Lts, vMatPart, depthScaleUv);
    }
  }

  float microW = (uStage == 7) ? 1.0 : ((uStage == 6) ? 0.80 : ((uStage >= 4) ? 0.65 : ((uStage >= 1) ? 0.55 : 0.25)));
  vec4 surf = evalSurface(uv, vMatPart, microW);

  // Compute surface normal per era
  vec3 N = Ngeom;
  if (uFlatMode < 0.5) {
    if (uStage == 0) {
      // 1978 Blinn Bump Mapping: softer grayscale height derivative (lower frequency, matte Blinn-Phong)
      vec3 nts = evalNormalTS(uv, vMatPart, 0.25, 0.048);
      N = normalize(TBN * nts);
    } else if (uStage >= 1 && uStage <= 4) {
      // 1998 Normal Mapping -> 2006 POM: crisp full tangent-space normal detail!
      vec3 nts = evalNormalTS(uv, vMatPart, microW, 0.078);
      N = normalize(TBN * nts);
    } else {
      // 2009 DX11 Tessellation -> 2022-26 Virtualized Micropolygons:
      vec3 geoN = normalize(cross(dFdx(vWorldPos), dFdy(vWorldPos)));
      if (dot(geoN, Ngeom) < 0.0) geoN = -geoN;
      vec3 nts = evalNormalTS(uv, vMatPart, microW, (uStage == 7) ? 0.072 : 0.056);
      vec3 detailN = normalize(TBN * nts);
      N = normalize(mix(geoN, detailN, (uStage == 7) ? 0.62 : 0.48));
      selfShadow = evalHeightShadow(uv, surf.x, Lts, vMatPart, depthScaleUv * 0.72);
    }
  }

  // Materials & physically-based lighting (Warm Grazing Forge Torch + Cool Moonlit Silhouette Rim!)
  vec3 alb = evalAlbedo(uv, surf, vMatPart, (uStage == 0 || uFlatMode > 0.5) ? 1.0 : 0.0);
  float metal = (uFlatMode > 0.5 || uStage == 0) ? 0.0 : surf.z;
  float rough = mix(0.76, 0.26, metal);
  if (uStage == 7) rough = clamp(rough - 0.08 * (1.0 - surf.y), 0.18, 0.85); // Crisp chiseled stone sheen

  // Crevice AO deep inside mortar grooves (height-driven)
  float ao = (uFlatMode > 0.5) ? 1.0 : mix(0.28, 1.0, smoothstep(0.02, 0.58, surf.x));

  // 1. Warm Grazing Torch Key Light (casts razor-dramatic relief & POM self-shadows!)
  float att = 1.0 / (0.28 + 0.11 * Ldist * Ldist);
  float ndl = max(dot(N, L), 0.0);
  vec3 H = normalize(L + V);
  float ndh = max(dot(N, H), 0.0);
  float specPow = mix(14.0, 72.0, 1.0 - rough);
  float specNorm = (uFlatMode > 0.5) ? 0.04 : mix(0.22, 1.35, metal);
  if (uStage == 0) { specPow = 18.0; specNorm = 0.14; }
  float spec = pow(ndh, specPow) * specNorm;

  vec3 keyCol = vec3(2.85, 1.85, 1.05) * att;
  vec3 diff = alb * (1.0 - metal * 0.80);
  vec3 specCol = mix(vec3(1.0, 0.92, 0.80), alb, metal) * spec;
  vec3 col = (diff * ndl + specCol * ndl) * keyCol * selfShadow;

  // 2. Cool Moonlit Back-Rim Light (illuminates left/right column edges -> makes flat vs jagged 3D silhouette POP!)
  vec3 rimL = normalize(vec3(-0.78, 0.35, -0.52));
  float rNdl = max(dot(N, rimL), 0.0);
  float fresRim = pow(1.0 - max(dot(N, V), 0.0), 3.2);
  vec3 rimCol = vec3(0.45, 0.72, 1.18);
  col += diff * rNdl * rimCol * 0.52 * ao;
  col += rimCol * fresRim * (0.38 + 0.35 * surf.x) * (0.4 + 0.6 * ao);

  // 3. Soft Sky / Ground Hemisphere Ambient
  vec3 amb = mix(vec3(0.055, 0.050, 0.055), vec3(0.11, 0.16, 0.26), 0.5 + 0.5 * N.y);
  col += diff * amb * ao * 1.15;

  // 4. Optional Debug Overlays:
  //    uDebugMode == 1.0 (Stage 5 DX11 Tessellation): Crisp adaptive triangle wireframe!
  //    uDebugMode == 2.0 (Stages 6-7 Meshlets / Nanite): Colorful per-cluster / per-triangle view!
  if (uDebugMode > 0.5 && uDebugMode < 1.5 && uStage >= 5 && uFlatMode < 0.5) {
    // Crisp adaptive triangle wireframe overlay (cleanly reveals both shaded 3D bricks & tessellated mesh!)
    vec2 cell = (vMatPart < 0.5) ? (vUv * vec2(17.0, 17.0)) : (vWorldPos.xz * 7.5);
    vec2 f = fract(cell);
    vec2 fw = max(fwidth(cell), vec2(0.001));
    float dEdge = min(min(f.x, 1.0 - f.x) / fw.x, min(f.y, 1.0 - f.y) / fw.y);
    float dDiag = abs(f.x + f.y - 1.0) / max(length(fw), 0.001);
    float wire = 1.0 - smoothstep(0.45, 1.15, min(dEdge, dDiag * 0.92));
    col = mix(col * 0.78, vec3(0.22, 0.96, 1.0), wire * 0.75);
  } else if (uDebugMode > 1.5 && uStage >= 6 && uFlatMode < 0.5) {
    // Organic Voronoi spatial triangle-cluster debug view (authentic UE5 Nanite / Turing Meshlets — NOT a regular UV grid!)
    vec2 cGrid = (uStage == 7)
      ? ((vMatPart < 0.5) ? vec2(11.5, 11.5) : vec2(5.2, 5.2))
      : ((vMatPart < 0.5) ? vec2(6.2, 6.2)   : vec2(2.8, 2.8));
    vec2 cPos = (vMatPart < 0.5) ? (vUv * cGrid) : (vWorldPos.xz * cGrid);
    vec2 iCell = floor(cPos);
    vec2 fCell = fract(cPos);
    float d1 = 9.0, d2 = 9.0;
    vec2 bestCell = iCell;
    for (int oy = -1; oy <= 1; oy++) {
      for (int ox = -1; ox <= 1; ox++) {
        vec2 nb = vec2(float(ox), float(oy));
        vec2 nCell = iCell + nb;
        vec2 seed = vec2(hash12(nCell + vec2(1.7, 9.2)), hash12(nCell + vec2(8.3, 2.8)));
        vec2 diffV = nb + (0.14 + 0.72 * seed) - fCell;
        float dist = length(diffV);
        if (dist < d1) { d2 = d1; d1 = dist; bestCell = nCell; }
        else if (dist < d2) { d2 = dist; }
      }
    }
    float cId = bestCell.x * 31.0 + bestCell.y * 17.0 + vMatPart * 113.0;
    vec3 cCol = clusterColor(cId);
    float clDiff = 0.34 + 0.66 * max(dot(N, L), 0.0) * 0.82 + 0.25 * max(dot(N, rimL), 0.0);
    // Stage 6 Meshlets: visibly dim grazing/backfacing clusters to demonstrate per-meshlet normal-cone culling!
    if (uStage == 6) {
      float coneDot = dot(Ngeom, V);
      float culledTint = smoothstep(0.16, 0.34, coneDot);
      cCol = mix(vec3(0.14, 0.16, 0.22), cCol, culledTint);
    }
    // Fine micropolygon triangle facet variation in Stage 7 Nanite debug view!
    if (uStage == 7) {
      vec3 flatN = normalize(cross(dFdx(vWorldPos), dFdy(vWorldPos)));
      float triTint = 0.80 + 0.32 * hash12(floor(cPos * 6.0));
      clDiff = (0.30 + 0.70 * abs(dot(flatN, L))) * triTint;
    }
    float fw = max(length(fwidth(cPos)), 0.002);
    float border = 1.0 - smoothstep(fw * 0.55, fw * 1.45, d2 - d1);
    vec3 dbg = cCol * clDiff * mix(1.0, 0.14, border);
    col = mix(col, dbg, 0.92);
  }

  // ACES Filmic Tone Mapping
  col *= 0.96;
  col = clamp((col * (2.51 * col + 0.03)) / (col * (2.43 * col + 0.59) + 0.14), 0.0, 1.0);
  col = pow(col, vec3(1.0 / 2.2));
  outColor = vec4(col, 1.0);
}
`;
