// WebGL2 GLSL ES 3.00 shaders for Isometric Pixel-Wave Toy (FX Lab #32).
// Pass 1: Instanced orthographic 2:1 pixel-art voxel columns with stepped height quantization,
// directional left-side studio lighting, and 4 pixel-art biomes (Meadow, Ocean, Magma, Neon Grid).
// Pass 2: 2-stage low-res pixel outline composite (1 px depth/silhouette ink + thick white vinyl
// sticker border + sticker drop shadow on subtle checkered studio backdrop + live 2D noise inset).

export const COLUMN_VS = `#version 300 es
precision highp float;
precision highp int;

layout(location = 0) in vec3 aPos;   // [0..1] cube corner
layout(location = 1) in vec2 aUv;    // face local UV (v=0 at top, v=1 at bottom for sides)
layout(location = 2) in float aFace; // 0 = top, 1 = left front (+Z), 2 = right front (+X)

uniform sampler2D uHeightTex; // N x N R32F/RGBA8 heightmap (r = raw 0..1, g = quant 0..1)
uniform vec2  uLowRes;        // virtual pixel buffer size (lowW, lowH)
uniform vec2  uCenterOffset;  // screen center offset in virtual pixels (for mobile card clearance)
uniform int   uGridN;         // grid side length (12..32)
uniform float uTileHalfW;     // exact integer half-width of one iso diamond in virtual px
uniform float uFlatCellPx;    // cell size in virtual px when viewing flat 2D heightmap
uniform float uMaxHeightPx;   // max wave amplitude in virtual px
uniform float uBaseThickPx;   // solid plinth thickness below wave trough in virtual px
uniform float uStepPx;        // height quantization step in virtual px (0 = smooth)
uniform float uIsoMorph;      // 0 = flat top-down 2D noise, 1 = rigid 2:1 pixel-art isometric
uniform int   uStage;         // 0=2D noise, 1=raw gray iso, 2=stepped biome, 3=+1px ink, 4=+white sticker

out vec2  vUv;
out float vFace;
out float vColH01;
out float vRawH01;
out float vYFromTopPx;
out float vDepth01;
out float vCellHash;
out vec2  vGridCoord;

float hash21(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}

void main() {
  int id = gl_InstanceID;
  int ix = id % uGridN;
  int iz = id / uGridN;

  // Hide side walls when flattened into pure 2D top-down noise (Step 1)
  if (uIsoMorph < 0.01 && aFace > 0.5) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    return;
  }

  vec4 hSample = texelFetch(uHeightTex, ivec2(ix, iz), 0);
  float rawH = clamp(hSample.r, 0.0, 1.0);

  // Height quantization: smooth in Step 2 (raw gray iso) or when Height Steps == 0; hard pixel steps otherwise
  float wavePx = rawH * uMaxHeightPx;
  float quantActive = (uStage >= 2 && uStepPx >= 0.5) ? 1.0 : 0.0;
  float qWavePx = (quantActive > 0.5)
    ? floor(wavePx / uStepPx + 0.5) * uStepPx
    : wavePx;

  float totalH = uBaseThickPx + qWavePx;
  float wy = aPos.y * totalH;

  float halfN = float(uGridN) * 0.5;
  float wx = (float(ix) + aPos.x) - halfN;
  float wz = (float(iz) + aPos.z) - halfN;

  // Smooth morph from pure flat top-down 2D grid (0 deg) -> exact integer 2:1 pixel isometric (45 deg)
  float ang = 0.78539816339 * uIsoMorph;
  float cs = cos(ang);
  float sn = sin(ang);
  float rx = wx * cs - wz * sn;
  float rz = wx * sn + wz * cs;

  float sxScale = mix(uFlatCellPx, uTileHalfW * 1.41421356237, uIsoMorph);
  float syScale = mix(uFlatCellPx, uTileHalfW * 0.70710678118, uIsoMorph);

  // Shift whole block down slightly when extruded so its visual silhouette stays balanced
  float yCenterShift = -0.5 * (uBaseThickPx + uMaxHeightPx * 0.48) * uIsoMorph;

  float sx = rx * sxScale + uCenterOffset.x;
  float sy = -rz * syScale + wy * uIsoMorph + yCenterShift + uCenterOffset.y;

  // Snap vertices cleanly when locked in rigid isometric mode so 2:1 lines never shimmer
  if (uIsoMorph > 0.995) {
    sx = floor(sx + 0.5);
    sy = floor(sy + 0.5);
  }

  vec2 ndc = (vec2(sx, sy) / (uLowRes * 0.5));

  // Monotonic orthographic depth: front-most columns (largest wx+wz) and higher points are closer
  float camDist = -(wx + wz) * uIsoMorph - (wy / max(uTileHalfW, 1.0)) * 0.42 * uIsoMorph;
  float depth01 = clamp((camDist + 48.0) / 96.0, 0.01, 0.99);

  gl_Position = vec4(ndc, depth01 * 2.0 - 1.0, 1.0);

  vUv = aUv;
  vFace = aFace;
  vColH01 = clamp(qWavePx / max(uMaxHeightPx, 1.0), 0.0, 1.0);
  vRawH01 = rawH;
  vYFromTopPx = (1.0 - aPos.y) * totalH;
  vDepth01 = depth01;
  vCellHash = hash21(vec2(float(ix), float(iz)));
  vGridCoord = vec2(float(ix), float(iz));
}
`;

export const COLUMN_FS = `#version 300 es
precision highp float;
precision highp int;

in vec2  vUv;
in float vFace;
in float vColH01;
in float vRawH01;
in float vYFromTopPx;
in float vDepth01;
in float vCellHash;
in vec2  vGridCoord;

uniform int   uStage;      // 0=2D noise, 1=raw gray iso, 2=stepped biome, 3=+1px ink, 4=+white sticker
uniform int   uBiome;      // 0=Meadow, 1=Ocean, 2=Magma, 3=Neon Grid
uniform float uTime;
uniform float uTileHalfW;

layout(location = 0) out vec4 oColor;
layout(location = 1) out vec4 oMeta;

// 2x2 Bayer threshold for crisp pixel-art foam / lava transitions
float bayer2(vec2 p) {
  ivec2 ip = ivec2(mod(floor(p), 2.0));
  int idx = ip.x + ip.y * 2;
  if (idx == 0) return 0.15;
  if (idx == 1) return 0.65;
  if (idx == 2) return 0.85;
  return 0.35;
}

void main() {
  int face = int(vFace + 0.5); // 0=top, 1=left (lit), 2=right (shadowed)
  vec3 col = vec3(0.5);
  float dither = bayer2(gl_FragCoord.xy);

  if (uStage == 0) {
    // Step 1: Crisp discrete 2D grayscale heightmap cells
    float g = mix(0.08, 0.96, vRawH01);
    col = vec3(g);
    // Subtle 1 px cell border so each voxel column origin is unmistakable
    float edge = step(0.92, max(vUv.x, vUv.y));
    col = mix(col, col * 0.72 + vec3(0.03), edge * 0.45);
  } else if (uStage == 1) {
    // Step 2: Raw uncolored isometric gray columns with clean directional left light
    float base = mix(0.54, 0.84, vRawH01);
    if (face == 0) {
      col = vec3(base * 1.06);
      // Crisp 1-pixel rim on sunlit upper-left edges
      float rim = step(vUv.x, 0.16) + step(vUv.y, 0.16);
      if (rim > 0.5) col *= 1.07;
    } else if (face == 1) {
      // Bright left face (directional light from left)
      col = vec3(base * 0.84) * mix(1.0, 0.82, clamp(vYFromTopPx / 26.0, 0.0, 1.0));
    } else {
      // Dark shadowed right face
      col = vec3(base * 0.52) * mix(1.0, 0.78, clamp(vYFromTopPx / 26.0, 0.0, 1.0));
    }
  } else {
    // Steps 3..5: Full 4 pixel-art biomes with left directional light + discrete pixel details
    if (uBiome == 0) {
      // ---------- BIOME 0: MEADOW (lush green grass overhang + warm brown soil) ----------
      vec3 grassTopLo  = vec3(0.28, 0.72, 0.28);
      vec3 grassTopHi  = vec3(0.58, 0.90, 0.32);
      vec3 grassTop    = mix(grassTopLo, grassTopHi, step(0.45, vColH01 + (vCellHash - 0.5) * 0.22));
      if (vColH01 > 0.76) grassTop = vec3(0.70, 0.95, 0.39);

      vec3 grassLeft   = vec3(0.26, 0.66, 0.26);
      vec3 grassRight  = vec3(0.14, 0.42, 0.20);
      vec3 soilLeft    = vec3(0.66, 0.41, 0.26);
      vec3 soilLeftDk  = vec3(0.55, 0.33, 0.21);
      vec3 soilRight   = vec3(0.41, 0.24, 0.17);
      vec3 soilRightDk = vec3(0.32, 0.18, 0.13);

      if (face == 0) {
        col = grassTop;
        // Sunlit top-left pixel highlight on each grass tile
        if (vUv.x < 0.20 || vUv.y < 0.20) col = mix(col, vec3(0.84, 0.98, 0.55), 0.36);
        // Tiny dark pixel tuft accent on a few cells
        if (vCellHash > 0.78 && abs(vUv.x - 0.55) < 0.14 && abs(vUv.y - 0.55) < 0.14) {
          col *= 0.82;
        }
      } else {
        // Stepped pixel-art grass overhang hanging down 2..4 virtual pixels over the soil
        float tooth = floor(fract(vUv.x * 2.0 + vCellHash * 1.7) * 3.0); // 0, 1, or 2
        float overhangPx = 2.0 + step(1.0, tooth) + step(1.9, tooth) * 0.75;
        if (vYFromTopPx < overhangPx) {
          col = (face == 1) ? grassLeft : grassRight;
          if (vYFromTopPx < 1.1 && face == 1) col *= 1.14;
        } else if (vYFromTopPx < overhangPx + 1.15) {
          // 1 px cast shadow directly beneath the overhanging grass lip!
          col = (face == 1) ? soilLeftDk * 0.78 : soilRightDk * 0.72;
        } else {
          // Layered pixel-art earth with occasional stone/clod speckles
          float strata = step(0.5, fract(floor(vYFromTopPx / 4.0) * 0.5 + vCellHash * 0.7));
          float speckle = step(0.86, fract(sin(dot(floor(vec2(vUv.x * 4.0, vYFromTopPx * 0.5)) + vGridCoord, vec2(12.9898, 78.233))) * 43758.5453));
          vec3 baseSoil = (face == 1) ? mix(soilLeft, soilLeftDk, strata * 0.55) : mix(soilRight, soilRightDk, strata * 0.55);
          if (speckle > 0.5) baseSoil *= (face == 1) ? 0.82 : 0.80;
          // Deepen toward base of block
          float depthShade = mix(1.0, 0.72, clamp((vYFromTopPx - 8.0) / 24.0, 0.0, 1.0));
          col = baseSoil * depthShade;
        }
      }
    } else if (uBiome == 1) {
      // ---------- BIOME 1: OCEAN (turquoise columns + crisp white foam ONLY on highest crests) ----------
      float crest = vColH01;
      bool isFoam = (crest > 0.73) || (crest > 0.64 && dither < (crest - 0.64) * 9.0);
      vec3 topDeep   = vec3(0.08, 0.54, 0.68);
      vec3 topMid    = vec3(0.14, 0.76, 0.80);
      vec3 topBright = vec3(0.35, 0.90, 0.89);
      vec3 foamCol   = vec3(0.95, 0.99, 1.00);
      vec3 foamShad  = vec3(0.76, 0.92, 0.96);

      if (face == 0) {
        if (isFoam) {
          col = foamCol;
        } else {
          col = (crest > 0.42) ? topMid : topDeep;
          if (crest > 0.58) col = topBright;
          if (vUv.x < 0.20) col = mix(col, vec3(0.65, 0.97, 0.97), 0.35);
        }
      } else {
        vec3 sideTop = (face == 1) ? vec3(0.13, 0.66, 0.77) : vec3(0.07, 0.39, 0.55);
        vec3 sideBot = (face == 1) ? vec3(0.06, 0.30, 0.49) : vec3(0.03, 0.18, 0.34);
        float band = floor(clamp(vYFromTopPx / 5.0, 0.0, 3.0)) / 3.0;
        col = mix(sideTop, sideBot, band);
        // White foam lip spilling 1-2 px down the side of only the highest wave crests
        if (crest > 0.73 && vYFromTopPx < (1.6 + step(0.5, vCellHash))) {
          col = (face == 1) ? foamCol : foamShad;
        } else if (vYFromTopPx < 1.2 && face == 1 && crest > 0.45) {
          col = mix(col, topBright, 0.45);
        }
      }
    } else if (uBiome == 2) {
      // ---------- BIOME 2: MAGMA (dark basalt + glowing orange/yellow cracks in wave troughs) ----------
      float trough = 1.0 - vColH01; // 1.0 = deepest valley, 0.0 = highest basalt crest
      float pulse = 0.5 + 0.5 * sin(uTime * 3.8 + vCellHash * 6.2831);
      vec3 basaltTop   = vec3(0.24, 0.22, 0.27);
      vec3 basaltLeft  = vec3(0.28, 0.25, 0.31);
      vec3 basaltRight = vec3(0.15, 0.13, 0.18);
      vec3 lavaRed     = vec3(0.84, 0.19, 0.08);
      vec3 lavaOrg     = vec3(1.00, 0.44, 0.09);
      vec3 lavaYel     = vec3(1.00, 0.84, 0.22);
      vec3 lavaHot     = vec3(1.00, 0.97, 0.68);

      if (face == 0) {
        if (trough > 0.76) {
          col = (trough > 0.88 && pulse > 0.35) ? lavaHot : lavaYel;
        } else if (trough > 0.62) {
          col = (dither < (trough - 0.62) * 7.0) ? lavaYel : lavaOrg;
        } else if (trough > 0.50) {
          // Glowing rim around molten fissures
          float border = step(0.76, max(abs(vUv.x - 0.5), abs(vUv.y - 0.5)) * 2.0);
          col = (border > 0.5) ? lavaRed : basaltTop * 1.05;
        } else {
          col = basaltTop;
          if (vUv.x < 0.20 || vUv.y < 0.20) col *= 1.18;
          if (vCellHash > 0.72) col *= 0.86;
        }
      } else {
        vec3 rock = (face == 1) ? basaltLeft : basaltRight;
        float strata = step(0.65, fract(floor(vYFromTopPx / 3.0) * 0.37 + vCellHash));
        col = mix(rock, rock * 0.78, strata);
        // Glowing magma seams radiating along troughs and deep column fissures!
        float crackWave = abs(fract(vYFromTopPx * 0.14 + vCellHash * 2.3) - 0.5);
        bool deepCrack = (trough > 0.55 && vYFromTopPx < 4.2) || (trough > 0.42 && crackWave < 0.12 && vYFromTopPx > 4.0);
        if (deepCrack) {
          col = (trough > 0.74) ? lavaYel : ((face == 1) ? lavaOrg : lavaRed);
        } else if (trough > 0.66 && vYFromTopPx < 6.0) {
          col = mix(col, lavaRed, 0.55);
        }
      }
    } else {
      // ---------- BIOME 3: NEON GRID (deep navy + cyan/magenta equalizer peaks & LED bars) ----------
      float h = vColH01;
      vec3 navyTop   = vec3(0.14, 0.16, 0.33);
      vec3 navyLeft  = vec3(0.13, 0.15, 0.31);
      vec3 navyRight = vec3(0.08, 0.09, 0.20);
      vec3 neonCyan  = vec3(0.16, 0.95, 1.00);
      vec3 neonViol  = vec3(0.64, 0.34, 1.00);
      vec3 neonMag   = vec3(1.00, 0.22, 0.72);
      vec3 neonHot   = vec3(1.00, 0.92, 1.00);

      vec3 peakCol = (h > 0.78) ? neonHot
                   : (h > 0.56) ? neonMag
                   : (h > 0.32) ? neonCyan
                   : mix(navyTop, neonViol, clamp(h * 2.5, 0.0, 1.0));

      if (face == 0) {
        col = peakCol;
        // Sharp crisp glowing frame around each equalizer cap
        float inner = step(0.18, vUv.x) * step(vUv.x, 0.82) * step(0.18, vUv.y) * step(vUv.y, 0.82);
        if (h <= 0.56 && inner > 0.5) col = mix(col, navyTop, 0.42);
        else if (h > 0.78 && inner < 0.5) col = neonMag;
      } else {
        vec3 baseNavy = (face == 1) ? navyLeft : navyRight;
        // Discrete horizontal LED equalizer segments every 3 virtual pixels
        float seg = fract(vYFromTopPx / 3.0);
        float segIdx = floor(vYFromTopPx / 3.0);
        float lit = step(0.32, seg) * step(segIdx, h * 5.2);
        vec3 ledCol = (segIdx < 1.0) ? peakCol : ((segIdx < 2.5) ? neonCyan : neonViol);
        float sideDim = (face == 1) ? 0.92 : 0.62;
        col = mix(baseNavy, ledCol * sideDim, lit * (0.45 + 0.55 * h));
      }
    }
  }

  oColor = vec4(col, 1.0);
  // Meta: R = orthographic depth, G = faceId (0 / 0.5 / 1), B = column height, A = solid mask
  oMeta  = vec4(vDepth01, vFace * 0.5, vColH01, 1.0);
}
`;

export const COMPOSITE_FS = `#version 300 es
precision highp float;
precision highp int;

in vec2 vUv;

uniform sampler2D uColorTex;
uniform sampler2D uMetaTex;
uniform sampler2D uHeightTex;
uniform vec2  uScreenRes;
uniform vec2  uLowRes;
uniform int   uLeftStage;
uniform int   uRightStage;
uniform int   uBiome;
uniform float uSplitX;        // < 0 disables split; 0..1 splits left/right stages
uniform float uShowNoise;     // > 0.5 draws crisp 2D heightmap inset
uniform int   uGridN;
uniform vec4  uInsetRect;     // normalized UV rect (x0, y0, x1, y1) for 2D noise inset
uniform vec2  uLastRippleUv;  // (u, v) of last click ripple for 2D inset feedback
uniform float uLastRippleAge; // seconds since last click ripple

out vec4 fragColor;

vec3 checkerBg(ivec2 px, vec2 uv, int biome, int stage) {
  // Subtle checkered cutting-mat backdrop tuned per biome so white sticker border pops cleanly!
  vec3 cA, cB;
  if (stage == 0) {
    cA = vec3(0.125, 0.135, 0.180);
    cB = vec3(0.155, 0.168, 0.220);
  } else if (biome == 0) {
    // Meadow: slate-sage studio mat
    cA = vec3(0.155, 0.195, 0.240);
    cB = vec3(0.185, 0.232, 0.282);
  } else if (biome == 1) {
    // Ocean: deep coastal navy mat
    cA = vec3(0.105, 0.158, 0.230);
    cB = vec3(0.132, 0.194, 0.275);
  } else if (biome == 2) {
    // Magma: warm volcanic charcoal mat
    cA = vec3(0.140, 0.115, 0.150);
    cB = vec3(0.172, 0.142, 0.184);
  } else {
    // Neon Grid: deep synth indigo mat
    cA = vec3(0.088, 0.084, 0.160);
    cB = vec3(0.118, 0.112, 0.208);
  }

  ivec2 tile = px / 12;
  float chk = float((tile.x + tile.y) & 1);
  vec3 col = mix(cA, cB, chk);
  // Subtle studio radial vignette
  vec2 d = (uv - 0.5) * vec2(1.15, 1.0);
  float vig = 1.0 - dot(d, d) * 0.34;
  return col * clamp(vig, 0.72, 1.06);
}

vec4 fetchColor(ivec2 p, ivec2 maxP) {
  if (p.x < 0 || p.y < 0 || p.x > maxP.x || p.y > maxP.y) return vec4(0.0);
  return texelFetch(uColorTex, p, 0);
}

vec4 fetchMeta(ivec2 p, ivec2 maxP) {
  if (p.x < 0 || p.y < 0 || p.x > maxP.x || p.y > maxP.y) return vec4(1.0, 0.0, 0.0, 0.0);
  return texelFetch(uMetaTex, p, 0);
}

// Evaluates 2D pixel-art post-processing at virtual pixel p for a given pipeline stage
vec3 evalPixelStage(ivec2 p, ivec2 maxP, vec2 uv, int stage) {
  vec4 cC = fetchColor(p, maxP);
  vec4 mC = fetchMeta(p, maxP);
  vec3 bg = checkerBg(p, uv, uBiome, stage);

  // Pure 2D Noise step (or left side of split when comparing vs Step 1)
  if (stage == 0) {
    // Map a clean centered square directly from uHeightTex so Split vs Step 1 works on any step!
    float aspect = uLowRes.x / max(uLowRes.y, 1.0);
    vec2 centered = (uv - 0.5) * vec2(aspect, 1.0);
    float halfBox = 0.36;
    vec2 boxUv = centered / (halfBox * 2.0) + 0.5;
    if (boxUv.x >= 0.0 && boxUv.x <= 1.0 && boxUv.y >= 0.0 && boxUv.y <= 1.0) {
      vec2 gridPos = vec2(boxUv.x, 1.0 - boxUv.y) * float(uGridN);
      ivec2 cell = clamp(ivec2(floor(gridPos)), ivec2(0), ivec2(uGridN - 1));
      float h = texelFetch(uHeightTex, cell, 0).r;
      vec3 g = vec3(mix(0.08, 0.96, h));
      vec2 f = fract(gridPos);
      float line = step(0.92, max(f.x, f.y));
      return mix(g, g * 0.72 + vec3(0.03), line * 0.45);
    }
    // Crisp 1-pixel frame around the 2D noise square
    float bd = max(abs(centered.x), abs(centered.y));
    if (bd <= halfBox + 0.008) return vec3(0.08, 0.075, 0.11);
    if (bd <= halfBox + 0.022) return vec3(0.96, 0.95, 0.92);
    return bg;
  }

  vec3 inkCol     = vec3(0.078, 0.070, 0.114); // Crisp deep pixel-art ink (#14121d)
  vec3 stickerCol = vec3(0.985, 0.976, 0.952); // Warm vinyl sticker white (#fbf9f3)

  if (mC.a > 0.5) {
    vec3 col = cC.rgb;
    if (stage >= 3) {
      // Pass 2A: 1 px crisp internal depth & column-step ink outline (one-sided -> ALWAYS 1 px, never 2 px!)
      vec4 mL = fetchMeta(p + ivec2(-1,  0), maxP);
      vec4 mR = fetchMeta(p + ivec2( 1,  0), maxP);
      vec4 mD = fetchMeta(p + ivec2( 0, -1), maxP);
      vec4 mU = fetchMeta(p + ivec2( 0,  1), maxP);

      // Depth jump: neighbor is significantly further behind -> draw 1 px ink on this closer edge
      float depthEps = 0.0155;
      bool depthEdge =
        (mL.a > 0.5 && (mL.r - mC.r) > depthEps) ||
        (mR.a > 0.5 && (mR.r - mC.r) > depthEps) ||
        (mD.a > 0.5 && (mD.r - mC.r) > depthEps) ||
        (mU.a > 0.5 && (mU.r - mC.r) > depthEps);

      // Distinct column height step edge (one-sided: taller column draws its 1 px ink border)
      float hEps = 0.042;
      bool heightEdge =
        (mL.a > 0.5 && (mC.b - mL.b) > hEps) ||
        (mR.a > 0.5 && (mC.b - mR.b) > hEps) ||
        (mD.a > 0.5 && (mC.b - mD.b) > hEps) ||
        (mU.a > 0.5 && (mC.b - mU.b) > hEps);

      // Subtle inner crease between top cap and shadowed right side / between front walls
      bool faceCrease =
        (mC.g < 0.25 && ((mD.a > 0.5 && mD.g > 0.25) || (mR.a > 0.5 && mR.g > 0.75))) ||
        (mC.g > 0.25 && mC.g < 0.75 && mR.a > 0.5 && mR.g > 0.75);

      if (depthEdge || heightEdge) {
        col = mix(col, inkCol, 0.88);
      } else if (faceCrease) {
        col = mix(col, inkCol, 0.34);
      }
    }
    return col;
  }

  // Pixel is outside the voxel block: check 1 px black silhouette outline (Stage >= 3) & thick white sticker border (Stage >= 4)
  if (stage >= 3) {
    // 8-neighbor check for airtight 1 px black silhouette outline along 2:1 diagonals
    bool adj4 =
      fetchMeta(p + ivec2(-1,  0), maxP).a > 0.5 ||
      fetchMeta(p + ivec2( 1,  0), maxP).a > 0.5 ||
      fetchMeta(p + ivec2( 0, -1), maxP).a > 0.5 ||
      fetchMeta(p + ivec2( 0,  1), maxP).a > 0.5;
    bool adjDiag =
      fetchMeta(p + ivec2(-1, -1), maxP).a > 0.5 ||
      fetchMeta(p + ivec2( 1, -1), maxP).a > 0.5 ||
      fetchMeta(p + ivec2(-1,  1), maxP).a > 0.5 ||
      fetchMeta(p + ivec2( 1,  1), maxP).a > 0.5;
    if (adj4 || adjDiag) {
      return inkCol;
    }
  }

  if (stage >= 4) {
    // Pass 2B: Thick rounded 3 px white vinyl sticker outline around the 1 px ink silhouette!
    float minD2 = 999.0;
    for (int dy = -4; dy <= 4; dy++) {
      for (int dx = -4; dx <= 4; dx++) {
        float d2 = float(dx * dx + dy * dy);
        if (d2 >= minD2 || d2 > 18.5) continue;
        if (fetchMeta(p + ivec2(dx, dy), maxP).a > 0.5) {
          minD2 = d2;
        }
      }
    }
    if (minD2 <= 17.5) {
      return stickerCol;
    }

    // Crisp vinyl sticker drop shadow shifted slightly down-right onto the checkered mat
    bool inShadow = false;
    for (int dy = 1; dy <= 5 && !inShadow; dy++) {
      for (int dx = -4; dx <= 2 && !inShadow; dx++) {
        float d2 = float((dx + 1) * (dx + 1) + (dy - 3) * (dy - 3));
        if (d2 <= 18.0 && fetchMeta(p + ivec2(dx, dy), maxP).a > 0.5) {
          inShadow = true;
        }
      }
    }
    if (inShadow) {
      return bg * 0.72;
    }
  }

  return bg;
}

void main() {
  // Map screen pixel cleanly to integer low-res virtual pixel (strict NEAREST, zero blur!)
  ivec2 maxP = ivec2(uLowRes) - ivec2(1);
  ivec2 p = clamp(ivec2(floor(vUv * uLowRes)), ivec2(0), maxP);

  int activeStage = (uSplitX >= 0.0 && vUv.x < uSplitX) ? uLeftStage : uRightStage;
  vec3 col = evalPixelStage(p, maxP, vUv, activeStage);

  // Subtle amber split divider hairline inside the shader (matches FX Lab split grip)
  if (uSplitX >= 0.0) {
    float pxDist = abs(vUv.x - uSplitX) * uScreenRes.x;
    if (pxDist < 1.2) col = vec3(0.93, 0.65, 0.37);
  }

  // Optional live 2D grayscale heightmap preview inset (Show 2D Noise toggle!)
  if (uShowNoise > 0.5 && activeStage != 0) {
    vec2 r0 = uInsetRect.xy;
    vec2 r1 = uInsetRect.zw;
    vec2 pxPos = vUv * uScreenRes;
    vec2 b0 = r0 * uScreenRes;
    vec2 b1 = r1 * uScreenRes;

    // Sticker shadow + thick white border + 2 px black ink frame around the 2D noise map
    bool insideBox = (pxPos.x >= b0.x && pxPos.x <= b1.x && pxPos.y >= b0.y && pxPos.y <= b1.y);
    bool inInk     = (pxPos.x >= b0.x - 2.0 && pxPos.x <= b1.x + 2.0 && pxPos.y >= b0.y - 2.0 && pxPos.y <= b1.y + 2.0);
    bool inSticker = (pxPos.x >= b0.x - 5.0 && pxPos.x <= b1.x + 5.0 && pxPos.y >= b0.y - 5.0 && pxPos.y <= b1.y + 5.0);
    bool inShadow  = (pxPos.x >= b0.x - 2.0 && pxPos.x <= b1.x + 9.0 && pxPos.y >= b0.y - 9.0 && pxPos.y <= b1.y + 2.0);

    if (insideBox) {
      vec2 iUv = (pxPos - b0) / max(b1 - b0, vec2(1.0));
      vec2 gridPos = vec2(iUv.x, 1.0 - iUv.y) * float(uGridN);
      ivec2 cell = clamp(ivec2(floor(gridPos)), ivec2(0), ivec2(uGridN - 1));
      float h = texelFetch(uHeightTex, cell, 0).r;
      vec3 g = vec3(mix(0.06, 0.97, h));
      vec2 f = fract(gridPos);
      float gridLine = step(0.91, max(f.x, f.y));
      col = mix(g, g * 0.72 + vec3(0.02), gridLine * 0.40);

      // Subtle expanding ripple ping ring on the 2D map when clicking
      if (uLastRippleAge >= 0.0 && uLastRippleAge < 1.2) {
        float dist = length(vec2(iUv.x, 1.0 - iUv.y) - uLastRippleUv);
        float ring = abs(dist - uLastRippleAge * 0.65);
        if (ring < 0.032) {
          float fade = 1.0 - uLastRippleAge / 1.2;
          col = mix(col, vec3(0.93, 0.65, 0.37), fade * 0.85);
        }
      }
    } else if (inInk) {
      col = vec3(0.078, 0.070, 0.114);
    } else if (inSticker) {
      col = vec3(0.985, 0.976, 0.952);
    } else if (inShadow) {
      col *= 0.68;
    }
  }

  fragColor = vec4(col, 1.0);
}
`;
