// WebGL2 GLSL ES 3.00 Shaders for #28 Real-Time ASCII: Screen-Space vs 3D World-Space.
//   1) MESH_VS / MESH_FS:        Solid 3D Gothic Cathedral Courtyard + Gat-Hat Vampire (Clean 3D MRT + World-Space Surface ASCII)
//   2) GLYPH_VS / GLYPH_FS:      Hardware-Instanced ~10,500 3D Camera-Facing Upright Billboard Glyphs (Zero Screen Swim!)
//   3) EDGE_FS:                  3x3 Sobel Edge Detector (for Step 3 Screen-Space Sobel comparison)
//   4) COMPOSITE_CRT_FS:         Screen-Space vs World-Space Split Composite + Subtle Dark-Room Analog CRT Halation & Bloom

export const MESH_VS = /* glsl */`#version 300 es
precision highp float;

layout(location = 0) in vec3 aPos;
layout(location = 1) in vec3 aNorm;
layout(location = 2) in vec2 aUv;
layout(location = 3) in float aMatId;
layout(location = 4) in float aPartId;
layout(location = 5) in float aExtra;

uniform mat4 uViewProj;
uniform vec3 uHeroPos;
uniform float uHeroYaw;
uniform float uSwordAngle;
uniform float uWalkPhase;
uniform float uWalkAmp;
uniform float uTime;

out vec3 vWorldPos;
out vec3 vNormal;
out vec2 vUv;
out float vMatId;
out float vExtra;
out float vLinearDepth;

vec3 rotX(vec3 p, float a) {
  float c = cos(a), s = sin(a);
  return vec3(p.x, p.y * c - p.z * s, p.y * s + p.z * c);
}

vec3 rotY(vec3 p, float a) {
  float c = cos(a), s = sin(a);
  return vec3(c * p.x + s * p.z, p.y, -s * p.x + c * p.z);
}

void animatePriestPart(inout vec3 pos, inout vec3 nrm, int part, float wp, float wa, float staffAng, float t) {
  float sW = sin(wp);
  float cW = cos(wp);
  float bob = abs(sW) * 0.036 * wa;
  float lean = 0.045 * wa;

  if (part == 17 || part == 18) {
    // Articulated Left (17) & Right (18) Legs + Sculpted Boots pivoting cleanly from hip!
    float signL = (part == 17) ? 1.0 : -1.0;
    vec3 hip = vec3(-0.098 * signL, 0.84, 0.0);
    float ang = -sW * signL * 0.44 * wa;
    float lift = max(0.0, cW * signL) * 0.055 * wa;
    pos = rotX(pos - hip, ang) + hip;
    nrm = rotX(nrm, ang);
    pos.y += lift;
  } else if (part == 3) {
    // Right Arm + Ornate Brass Gothic Cross Staff & Hanging Lantern (pilgrim staff-planting stride!)
    vec3 sh = vec3(0.25, 1.25, 0.01);
    float ang = (-sW * 0.26 * wa) + staffAng;
    pos = rotX(pos - sh, ang) + sh;
    nrm = rotX(nrm, ang);
    pos.y += bob;
  } else if (part == 16) {
    // Left Arm + Embossed Leather Bible (natural counter-swing opposite left leg!)
    vec3 sh = vec3(-0.24, 1.25, 0.01);
    float ang = sW * 0.22 * wa;
    pos = rotX(pos - sh, ang) + sh;
    nrm = rotX(nrm, ang);
    pos.y += bob;
  } else if (part == 2) {
    // Smooth Face, White Roman Collar & Tall Pointed Gothic Mitre + Fluttering Infulae Ribbons!
    if (pos.z < -0.10 && pos.y < 1.68) {
      float tail = smoothstep(1.68, 1.28, pos.y);
      pos.z -= (0.025 * wa + sin(t * 3.8 + pos.y * 8.0) * 0.015) * tail;
    }
    pos = rotY(pos, -sW * 0.04 * wa);
    nrm = rotY(nrm, -sW * 0.04 * wa);
    pos.y += bob * 0.92 + sin(t * 2.0) * 0.005;
  } else {
    // part == 1: Flowing Cassock, Pellegrina Cape & Crimson Stole!
    // Lower skirt smoothly billows & strides around stepping left/right boots!
    float hemW = smoothstep(0.86, 0.16, pos.y);
    float sideB = smoothstep(-0.14, 0.14, pos.x);
    float skirtAng = mix(-sW, sW, sideB) * 0.30 * wa * hemW;
    vec3 hipP = vec3(pos.x, 0.84, 0.0);
    pos = rotX(pos - hipP, skirtAng) + hipP;
    nrm = rotX(nrm, skirtAng);
    // Subtle chest counter-twist & rhythmic walk bob
    float twist = sW * 0.075 * wa * smoothstep(0.80, 1.38, pos.y);
    pos = rotY(pos, twist);
    nrm = rotY(nrm, twist);
    pos.y += bob;
  }
  // Subtle natural forward walk lean above hips
  if (pos.y > 0.84) {
    vec3 hp = vec3(0.0, 0.84, 0.0);
    pos = rotX(pos - hp, -lean) + hp;
    nrm = rotX(nrm, -lean);
  }
}

void main() {
  vec3 pos = aPos;
  vec3 nrm = aNorm;

  if (aPartId > 0.5) {
    int pId = int(floor(aPartId + 0.5));
    animatePriestPart(pos, nrm, pId, uWalkPhase, uWalkAmp, uSwordAngle, uTime);
    pos = rotY(pos, uHeroYaw) + uHeroPos;
    nrm = normalize(rotY(nrm, uHeroYaw));
  }

  vec4 clip = uViewProj * vec4(pos, 1.0);
  gl_Position = clip;
  vWorldPos = pos;
  vNormal = normalize(nrm);
  vUv = aUv;
  vMatId = aMatId;
  vExtra = aExtra;
  vLinearDepth = clamp(clip.w / 28.0, 0.0, 1.0);
}
`;

export const MESH_FS = /* glsl */`#version 300 es
precision highp float;

in vec3 vWorldPos;
in vec3 vNormal;
in vec2 vUv;
in float vMatId;
in float vExtra;
in float vLinearDepth;

layout(location = 0) out vec4 oColor;
layout(location = 1) out vec4 oNormDepth;

uniform sampler2D uAtlasTex;
uniform vec3 uCamPos;
uniform vec3 uHeroPos;
uniform vec3 uLightPos;
uniform float uTime;
uniform int uRenderMode; // 0 = Clean 3D Lit + MRT, 1 = World-Space Surface ASCII + Occluders
uniform int uWorldStage; // 3 = Surface Grid only, 4..7 = Full World-Space 3D ASCII
uniform float uTileScale; // World-space tile size multiplier (from Cell slider!)
uniform int uCharset;    // 0 = Multi-Material ASCII, 1 = Uniform Code, 2 = Hangul
uniform int uPalette;    // 0 = Noir Gothic (reference!), 1 = Vampire Crimson, 2 = Amber CRT, 3 = P31 Green

float hash21(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}

float sampleAtlas(int colIdx, int rowIdx, vec2 localUv) {
  vec2 cellUv = vec2(localUv.x, 1.0 - localUv.y);
  vec2 uv = (vec2(float(colIdx), float(rowIdx)) + clamp(cellUv, 0.04, 0.96)) / vec2(20.0, 6.0);
  return smoothstep(0.20, 0.62, texture(uAtlasTex, uv).r);
}

vec3 tintPalette(vec3 col, int pal) {
  float lum = dot(col, vec3(0.2126, 0.7152, 0.0722));
  if (pal == 2) {
    return mix(vec3(0.22, 0.09, 0.01), vec3(1.0, 0.76, 0.28), pow(clamp(lum * 1.25, 0.0, 1.0), 0.85)) * smoothstep(0.01, 0.06, lum);
  }
  if (pal == 3) {
    return mix(vec3(0.03, 0.18, 0.08), vec3(0.32, 1.0, 0.56), pow(clamp(lum * 1.25, 0.0, 1.0), 0.85)) * smoothstep(0.01, 0.06, lum);
  }
  if (pal == 1) {
    // Vampire Crimson tint: push bone-white highlights slightly crimson-rose while keeping ember gold
    float warm = clamp((col.r - col.b) * 2.0, 0.0, 1.0);
    return mix(col * vec3(1.18, 0.62, 0.70), col * vec3(1.15, 0.88, 0.55), warm);
  }
  return col; // Palette 0: Authentic Noir Gothic Monochrome + Warm Candle Gold + Haunted Lavender + Mint
}

float pointedArchMask(vec2 uv) {
  // Gothic pointed lancet arch inside uv [0..1]x[0..1]
  float x = abs(uv.x - 0.5) * 2.0; // 0..1
  if (uv.y < 0.52) return step(x, 0.90);
  float dy = (uv.y - 0.52) / 0.48;
  float archX = sqrt(max(0.0, 1.0 - dy * dy * 0.98)) * 0.90;
  return step(x, archX);
}

void main() {
  vec3 N = normalize(vNormal);
  vec3 V = normalize(uCamPos - vWorldPos);
  vec3 moonDir = normalize(vec3(-0.52, 0.68, 0.52));

  // Warm glow spill from the 4 glowing amber gothic windows along z = -3.88
  float winGlow = 0.0;
  const float winXs[4] = float[4](-6.3, -3.3, -0.3, 5.7);
  for (int i = 0; i < 4; i++) {
    vec3 wp = vec3(winXs[i], 2.0, -3.6);
    float d = length(vWorldPos - wp);
    winGlow += 1.65 / (0.65 + d * d * 0.42);
  }
  // Orbiting subtle warm lantern light
  vec3 toL = uLightPos - vWorldPos;
  float dL = length(toL);
  float lanGlow = 1.9 / (0.45 + dL * dL * 0.55);
  float ndl = max(dot(N, normalize(toL)), 0.0);
  float ndm = max(dot(N, moonDir), 0.0);
  float rim = pow(1.0 - max(dot(N, V), 0.0), 2.8);

  // Soft cast shadows on ground from hero & tree
  float heroSh = smoothstep(0.18, 0.82, length((vWorldPos.xz - uHeroPos.xz) - vec2(0.35, -0.18)));
  float treeSh = smoothstep(1.15, 2.75, length(vWorldPos.xz - vec2(-6.7, -1.0)));
  float gShadow = (vMatId < 1.5 || abs(vMatId - 6.0) < 0.5) ? min(0.32 + 0.68 * heroSh, 0.25 + 0.75 * treeSh) : 1.0;

  // Pointed arch discard/wall fallback for material 4 (lancet windows)
  bool isWindowLit = false;
  if (abs(vMatId - 4.0) < 0.5) {
    if (vExtra > 0.5) {
      isWindowLit = pointedArchMask(vUv) > 0.5;
    } else {
      isWindowLit = true; // fence lantern finials
    }
  }

  // ---- MODE 0: CLEAN 3D LIT PASS (used for Step 1 Original 3D + Steps 2-3 Screen-Space ASCII!) ----
  if (uRenderMode == 0) {
    vec3 col = vec3(0.02);
    if (vMatId < 1.5) {
      // Stone courtyard
      vec2 tile = abs(fract(vWorldPos.xz * 0.85) - 0.5);
      float grout = smoothstep(0.45, 0.49, max(tile.x, tile.y));
      vec3 alb = mix(vec3(0.18, 0.18, 0.22), vec3(0.05, 0.05, 0.07), grout);
      col = alb * (0.14 + 0.72 * ndm) * gShadow + alb * vec3(1.0, 0.68, 0.34) * (winGlow * 0.32 + lanGlow * ndl * 0.55);
    } else if (vMatId < 2.5) {
      // Cathedral gothic stone walls & buttresses
      vec3 alb = vec3(0.16, 0.16, 0.21);
      col = alb * (0.12 + 0.68 * ndm) + alb * vec3(1.0, 0.65, 0.32) * (winGlow * 0.22 + lanGlow * ndl * 0.45) + vec3(0.20, 0.22, 0.30) * rim * 0.35;
    } else if (vMatId < 3.5) {
      // Steep gothic slate roof
      vec3 alb = vec3(0.09, 0.10, 0.14);
      col = alb * (0.16 + 0.65 * ndm) + vec3(0.18, 0.20, 0.28) * rim * 0.25;
    } else if (vMatId < 4.5) {
      // Glowing candle-gold lancet windows (or dark stone outside pointed arch)
      if (isWindowLit) {
        float mullion = step(0.45, abs(fract(vUv.x * 4.0) - 0.5)) + step(0.45, abs(fract(vUv.y * 6.0) - 0.5));
        col = mix(vec3(0.96, 0.70, 0.36), vec3(0.24, 0.14, 0.08), clamp(mullion, 0.0, 1.0));
      } else {
        col = vec3(0.09, 0.09, 0.12) * (0.2 + 0.6 * ndm);
      }
    } else if (vMatId < 5.5) {
      // Haunted lavender wrought-iron fence & crosses
      col = vec3(0.42, 0.36, 0.66) * (0.35 + 0.65 * ndm) + vec3(0.55, 0.48, 0.85) * rim * 0.4;
    } else if (vMatId < 6.5) {
      // Dark wild meadow slope
      float pd = length((vWorldPos.xz - vec2(0.2, 10.6)) * vec2(0.55, 1.0));
      col = pd < 2.35 ? vec3(0.015, 0.018, 0.028) : vec3(0.07, 0.075, 0.085) * (0.35 + 0.65 * ndm) * gShadow;
    } else if (vMatId < 7.25) {
      // Blender Priest gothic cassock, pellegrina cape & saturno hat
      col = vec3(0.16, 0.16, 0.20) * (0.18 + 0.85 * ndm) + vec3(0.82, 0.84, 0.92) * rim * 0.68 + vec3(1.0, 0.72, 0.42) * lanGlow * ndl * 0.42;
    } else if (vMatId < 7.55) {
      // Crisp bright-white Roman collar (koloratka)
      col = vec3(0.95, 0.95, 0.98) * (0.48 + 0.55 * ndm + rim * 0.3);
    } else if (vMatId < 7.72) {
      // Sculpted pale skin (face & hands)
      col = vec3(0.68, 0.56, 0.50) * (0.28 + 0.76 * ndm) + vec3(0.85, 0.72, 0.65) * rim * 0.35 + vec3(1.0, 0.70, 0.38) * lanGlow * ndl * 0.30;
    } else if (vMatId < 7.92) {
      // Crimson-burgundy liturgical stole & waist cincture!
      col = vec3(0.56, 0.13, 0.17) * (0.24 + 0.78 * ndm) + vec3(0.85, 0.42, 0.48) * rim * 0.32 + vec3(1.0, 0.70, 0.38) * lanGlow * ndl * 0.35;
    } else if (vMatId < 8.5) {
      // Glowing amber Sanctuary Lantern flame (vExtra > 0.5) vs gleaming brass Gothic Cross Staff & gold book emblem!
      if (vExtra > 0.5) {
        col = vec3(1.0, 0.84, 0.36);
      } else {
        col = vec3(0.95, 0.76, 0.30) * (0.48 + 0.62 * ndm + rim * 0.55);
      }
    } else {
      // Ghostly moonlit tree
      col = vec3(0.28, 0.46, 0.42) * (0.25 + 0.75 * ndm) + vec3(0.55, 0.82, 0.74) * rim * 0.45;
    }

    float luma = dot(col, vec3(0.2126, 0.7152, 0.0722));
    oColor = vec4(clamp(col, 0.0, 1.0), luma);
    oNormDepth = vec4(N * 0.5 + 0.5, vLinearDepth);
    return;
  }

  // ---- MODE 1: OPAQUE DEPTH-BUFFER OCCLUDERS ONLY (ZERO UV-MAPPED ASCII TEXTURES!) ----
  // Every single visible glyph in the entire 3D world is now a 100% upright camera-facing 3D billboard!
  vec3 bg = vec3(0.010, 0.010, 0.015);
  vec3 outCol = bg;

  if (vMatId < 1.5) {
    // Subtle warm glow pool on pitch-black courtyard stone beneath glowing amber windows
    outCol = bg + tintPalette(vec3(0.065, 0.038, 0.014) * clamp(winGlow * 0.22, 0.0, 0.42), uPalette);
  } else if (vMatId < 4.5 && abs(vMatId - 4.0) < 0.5 && isWindowLit) {
    // Faint warm amber backlit glass behind the glowing camera-facing H # 0 T window billboards!
    outCol = tintPalette(vec3(0.14, 0.065, 0.018), uPalette);
  } else if (vMatId < 6.5 && abs(vMatId - 6.0) < 0.5) {
    // Dark earthy meadow base in front + pitch-black moonlit pond hollow; obsidian black behind cathedral
    float pd = length((vWorldPos.xz - vec2(0.2, 10.8)) * vec2(0.52, 1.0));
    outCol = (vWorldPos.z < 3.5 || pd < 2.52) ? vec3(0.008, 0.008, 0.012) : tintPalette(vec3(0.042, 0.045, 0.052), uPalette);
  } else if (vMatId >= 6.5 && vMatId < 8.5) {
    // Hero core: on Step 4 (before Hero Billboard Cloud), show smooth dark silhouette; Steps 5..8 pure black Z-occluder!
    if (uWorldStage <= 3) {
      vec3 sil = vec3(0.16, 0.16, 0.20) * (0.2 + 0.8 * ndm) + vec3(0.62, 0.64, 0.72) * rim * 0.65;
      outCol = tintPalette(sil, uPalette);
    } else {
      outCol = vec3(0.008, 0.008, 0.012);
    }
  } else {
    // Cathedral walls, buttresses, roof, fence & tree core write pure dark Z-buffer occlusion!
    outCol = bg;
  }

  oColor = vec4(clamp(outCol, 0.0, 1.0), 1.0);
  oNormDepth = vec4(N * 0.5 + 0.5, vLinearDepth);
}
`;

export const GLYPH_VS = /* glsl */`#version 300 es
precision highp float;

// Per-vertex quad corner (divisor = 0)
layout(location = 0) in vec2 aCorner;
// Per-instance packed attributes (divisor = 1)
layout(location = 1) in vec4 aInstPosSize;
layout(location = 2) in vec4 aInstNormSet;
layout(location = 3) in vec4 aInstColPart;

uniform mat4 uViewProj;
uniform vec3 uCamRight;
uniform vec3 uCamUp;
uniform vec3 uCamPos;
uniform vec3 uHeroPos;
uniform float uHeroYaw;
uniform float uSwordAngle;
uniform float uWalkPhase;
uniform float uWalkAmp;
uniform float uTime;
uniform float uDashAmt;
uniform vec3 uDashDir;
uniform float uSizeScale;
uniform int uWorldStage;
uniform int uCharset;
uniform int uPalette;

out vec2 vQuadUv;
out float vGlyphCol;
out float vGlyphRow;
out vec3 vColor;
out float vAlpha;

vec3 rotX(vec3 p, float a) {
  float c = cos(a), s = sin(a);
  return vec3(p.x, p.y * c - p.z * s, p.y * s + p.z * c);
}

vec3 rotY(vec3 p, float a) {
  float c = cos(a), s = sin(a);
  return vec3(c * p.x + s * p.z, p.y, -s * p.x + c * p.z);
}

void animatePriestGlyph(inout vec3 pos, inout vec3 nrm, int part, float wp, float wa, float staffAng, float t) {
  float sW = sin(wp);
  float cW = cos(wp);
  float bob = abs(sW) * 0.036 * wa;
  float lean = 0.045 * wa;

  if (part == 17 || part == 18) {
    float signL = (part == 17) ? 1.0 : -1.0;
    vec3 hip = vec3(-0.098 * signL, 0.84, 0.0);
    float ang = -sW * signL * 0.44 * wa;
    float lift = max(0.0, cW * signL) * 0.055 * wa;
    pos = rotX(pos - hip, ang) + hip;
    nrm = rotX(nrm, ang);
    pos.y += lift;
  } else if (part == 3) {
    vec3 sh = vec3(0.25, 1.25, 0.01);
    float ang = (-sW * 0.26 * wa) + staffAng;
    pos = rotX(pos - sh, ang) + sh;
    nrm = rotX(nrm, ang);
    pos.y += bob;
  } else if (part == 16) {
    vec3 sh = vec3(-0.24, 1.25, 0.01);
    float ang = sW * 0.22 * wa;
    pos = rotX(pos - sh, ang) + sh;
    nrm = rotX(nrm, ang);
    pos.y += bob;
  } else if (part == 2) {
    if (pos.z < -0.10 && pos.y < 1.68) {
      float tail = smoothstep(1.68, 1.28, pos.y);
      pos.z -= (0.025 * wa + sin(t * 3.8 + pos.y * 8.0) * 0.015) * tail;
    }
    pos = rotY(pos, -sW * 0.04 * wa);
    nrm = rotY(nrm, -sW * 0.04 * wa);
    pos.y += bob * 0.92 + sin(t * 2.0) * 0.005;
  } else {
    float hemW = smoothstep(0.86, 0.16, pos.y);
    float sideB = smoothstep(-0.14, 0.14, pos.x);
    float skirtAng = mix(-sW, sW, sideB) * 0.30 * wa * hemW;
    vec3 hipP = vec3(pos.x, 0.84, 0.0);
    pos = rotX(pos - hipP, skirtAng) + hipP;
    nrm = rotX(nrm, skirtAng);
    float twist = sW * 0.075 * wa * smoothstep(0.80, 1.38, pos.y);
    pos = rotY(pos, twist);
    nrm = rotY(nrm, twist);
    pos.y += bob;
  }
  if (pos.y > 0.84) {
    vec3 hp = vec3(0.0, 0.84, 0.0);
    pos = rotX(pos - hp, -lean) + hp;
    nrm = rotX(nrm, -lean);
  }
}

void main() {
  vec2 corner = aCorner;
  vQuadUv = corner * 0.5 + 0.5;

  int part = int(floor(aInstColPart.w + 0.5));
  float rowF = floor(aInstNormSet.w);
  float seed = fract(aInstNormSet.w);

  // Stage gating (100% camera-facing 3D billboards everywhere!):
  //   Step 4 (uWorldStage==3): Courtyard (6), Cathedral Walls/Roof (8), Glowing Windows (9), Lavender Fence (15)
  //   Step 5 (uWorldStage==4): + Priest 3D Billboard Cloud (1, 2, 3, 16, 17, 18)
  //   Step 6 (uWorldStage==5): + 3D Chiaroscuro Lighting + Floating Tree (0) & 12.5K Grass Meadow (7)
  //   Step 7-8 (uWorldStage>=6): + Spectral Dash Afterimages (10..14) + Delicate Embers (4, 5)!
  bool isArch = (part == 6 || part == 8 || part == 9 || part == 15);
  bool isPriest = (part == 1 || part == 2 || part == 3 || part == 16 || part == 17 || part == 18);
  bool isDash = (part >= 10 && part <= 14);
  bool visible = true;
  if (uWorldStage <= 3 && !isArch) visible = false;
  else if (uWorldStage == 4 && (part == 0 || part == 7 || part == 4 || part == 5 || isDash)) visible = false;
  else if (uWorldStage == 5 && (part == 4 || part == 5 || isDash)) visible = false;
  if (isDash && (uWorldStage < 6 || uDashAmt < 0.04)) visible = false;

  if (!visible) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    vAlpha = 0.0;
    return;
  }

  vec3 pos = aInstPosSize.xyz;
  vec3 nrm = normalize(aInstNormSet.xyz);
  float sz = aInstPosSize.w * uSizeScale;
  float alpha = 1.0;

  if (isPriest || isDash) {
    float ghostIdx = isDash ? float(part - 9) : 0.0;
    float wp = uWalkPhase - ghostIdx * 0.42;
    animatePriestGlyph(pos, nrm, isDash ? 1 : part, wp, uWalkAmp, uSwordAngle, uTime);
    pos = rotY(pos, uHeroYaw) + uHeroPos;
    nrm = normalize(rotY(nrm, uHeroYaw));

    if (ghostIdx > 0.5) {
      pos -= uDashDir * (ghostIdx * 0.58 * uDashAmt);
      pos.y += sin(ghostIdx * 1.1) * 0.02;
      alpha = (1.0 - ghostIdx * 0.15) * uDashAmt * 0.85;
    }
  } else if (part == 4) {
    float cyc = fract(seed + uTime * (0.20 + seed * 0.16));
    vec3 localOff = vec3(
      pos.x * 0.55 + sin(uTime * 2.1 + seed * 19.0) * 0.14,
      0.35 + cyc * 1.35,
      pos.z * 0.55 + cos(uTime * 1.8 + seed * 13.0) * 0.14
    );
    pos = uHeroPos + localOff;
    alpha = sin(cyc * 3.14159) * 0.92;
  } else if (part == 5) {
    pos.y += sin(uTime * 1.2 + seed * 25.0) * 0.20;
    pos.x += cos(uTime * 0.7 + seed * 17.0) * 0.30;
    alpha = 0.45 + 0.45 * sin(uTime * 3.0 + seed * 31.0);
  } else if (part == 0 || part == 7) {
    float sway = sin(uTime * 1.6 + pos.x * 0.6 + pos.z * 0.4) * 0.028;
    pos.x += sway * smoothstep(-0.5, 3.5, pos.y + 0.5);
  }

  // Push billboards cleanly clear of pitch-black depth occluders so zero glyphs get Z-sliced!
  vec3 toCam = normalize(uCamPos - pos);
  float pushOut = (part == 6 || part == 7) ? 0.14 : ((part == 8 || part == 9 || part == 15) ? 0.12 : ((part == 3) ? 0.056 : (isPriest ? 0.040 : 0.02)));
  vec3 billPos = pos + toCam * pushOut
               + uCamRight * (corner.x * sz * 0.52)
               + uCamUp    * (corner.y * sz * 0.58);

  gl_Position = uViewProj * vec4(billPos, 1.0);

  // Harsh dramatic Noir side-lighting
  vec3 moonDir = normalize(vec3(-0.90, 0.28, 0.32));
  float ndl = max(dot(nrm, moonDir), 0.0);
  float rim = pow(1.0 - max(dot(nrm, toCam), 0.0), 2.8);

  float lum;
  if (part == 4 || part == 5 || part == 9) {
    // Embers & glowing amber cathedral lancet windows!
    float flick = (part == 9) ? (0.88 + 0.12 * sin(uTime * 3.5 + pos.x * 1.9 + seed * 6.28)) : 1.0;
    lum = 0.95 * flick;
  } else if (part == 8) {
    // Cathedral stone masonry & steep roof billboards
    lum = clamp(0.34 + 0.48 * ndl + 0.24 * seed, 0.22, 0.90);
  } else if (part == 15) {
    // Haunted lavender wrought-iron fence & cathedral crosses
    lum = clamp(0.68 + 0.30 * ndl + 0.14 * seed, 0.52, 0.98);
  } else if (part == 6) {
    float heroSh = smoothstep(0.24, 0.92, length((pos.xz - uHeroPos.xz) - vec2(0.35, -0.18)));
    float treeSh = smoothstep(1.20, 2.85, length(pos.xz - vec2(-6.7, -1.0)));
    float gShadow = min(0.24 + 0.76 * heroSh, 0.18 + 0.82 * treeSh);
    float wave = sin(pos.x * 0.9 + pos.z * 0.7) * 0.5 + 0.5;
    float backFade = smoothstep(-3.6, -0.4, pos.z);
    lum = clamp((0.26 + 0.34 * wave + 0.16 * seed) * (0.24 + 0.76 * backFade) * gShadow, 0.04, 0.78);
  } else if (part == 2) {
    // Smooth Face, Crisp White Roman Collar & Pointed Ivory-and-Gold Gothic Mitre!
    bool isGoldMitre = (aInstColPart.r > 0.96 && aInstColPart.g > 0.78 && aInstColPart.b < 0.52);
    bool isSilkOrCollar = (aInstColPart.r > 0.94 && aInstColPart.g > 0.92 && aInstColPart.b > 0.88);
    if (isGoldMitre) lum = clamp(0.84 + 0.16 * ndl, 0.80, 1.0);
    else if (isSilkOrCollar) lum = clamp(0.62 + 0.36 * ndl + 0.20 * rim, 0.52, 0.98);
    else lum = clamp(0.38 + 0.52 * ndl + 0.22 * rim, 0.32, 0.88);
  } else if (isPriest || isDash) {
    // Gleaming brass gothic cross, book cross & glowing warm amber lantern stay vividly luminous!
    bool isHolyGold = (!isDash && aInstColPart.r > 0.96 && aInstColPart.g > 0.74 && aInstColPart.b < 0.55);
    float flatDemo = (uWorldStage == 4) ? 0.55 : 0.0;
    float chiaroscuro = 0.18 + 0.76 * pow(ndl, 1.08) + 0.28 * rim;
    lum = isHolyGold ? clamp(0.80 + 0.20 * ndl + 0.08 * sin(uTime * 4.2 + seed * 6.28), 0.76, 1.0) : clamp(mix(chiaroscuro, 0.64, flatDemo), 0.15, 0.96);
  } else if (part == 7) {
    lum = clamp(0.26 + 0.42 * ndl + 0.24 * seed, 0.14, 0.78);
  } else {
    lum = clamp(0.18 + 0.78 * ndl + 0.22 * seed, 0.10, 0.96);
  }

  float finalRow = rowF;
  if (uCharset == 2) finalRow = 5.0;
  else if (uCharset == 1 && part >= 1 && part <= 3) finalRow = 3.0;

  float glyphIdx;
  if (part == 4 || part == 5) {
    glyphIdx = (seed < 0.35) ? 7.0 : ((seed < 0.72) ? 12.0 : 14.0);
  } else if (part == 9) {
    // Glowing amber lancet windows: H N # 0 (cols 11..14 of Row 3!)
    glyphIdx = 11.0 + floor(seed * 3.9);
  } else if (part == 8) {
    // Cathedral walls & roof: [ ] = I T H N (cols 4..12 of Row 3!)
    glyphIdx = 4.0 + floor(clamp(lum * 0.75 + seed * 0.35, 0.0, 0.99) * 8.5);
  } else if (part == 15) {
    // Wrought-iron fence & crosses: = [ ] | I (cols 5..9 of Row 3!)
    glyphIdx = (abs(nrm.y) > 0.5) ? 5.0 : (6.0 + floor(seed * 3.9));
  } else if (part == 6) {
    if (lum < 0.20) glyphIdx = 1.0 + floor(seed * 4.5);
    else glyphIdx = 6.0 + floor(fract(seed * 3.1 + pos.x * 0.2) * 6.9);
  } else if (part == 7) {
    glyphIdx = 4.0 + floor(fract(seed * 2.7 + lum * 0.4) * 6.5);
  } else if (part == 0 && rowF > 3.5) {
    glyphIdx = 8.0 + floor(clamp(lum * 0.65 + seed * 0.40, 0.0, 0.99) * 7.5);
  } else {
    glyphIdx = clamp(1.0 + floor(clamp(lum * 0.88 + seed * 0.16, 0.0, 0.99) * 14.5), 1.0, 15.0);
  }

  vec3 col = aInstColPart.rgb * (0.14 + 0.86 * lum);
  if (part == 6) col *= 0.80;
  if (part == 8) col = aInstColPart.rgb * (0.35 + 0.75 * lum);
  if (part == 9 || part == 4 || part == 5) col = aInstColPart.rgb * (0.95 + 0.22 * lum);

  if (uPalette == 2) {
    col = mix(vec3(0.26, 0.11, 0.02), vec3(1.0, 0.80, 0.34), lum) * (part == 6 || part == 8 ? 0.74 : 1.0);
  } else if (uPalette == 3) {
    col = mix(vec3(0.04, 0.22, 0.10), vec3(0.36, 1.0, 0.60), lum) * (part == 6 || part == 8 ? 0.74 : 1.0);
  } else if (uPalette == 1 && part != 4 && part != 5 && part != 9) {
    col *= vec3(1.18, 0.66, 0.72);
  }

  vGlyphCol = glyphIdx;
  vGlyphRow = finalRow;
  vColor = clamp(col, 0.0, 1.12);
  vAlpha = alpha;
}
`;

export const GLYPH_FS = /* glsl */`#version 300 es
precision highp float;

in vec2 vQuadUv;
in float vGlyphCol;
in float vGlyphRow;
in vec3 vColor;
in float vAlpha;

uniform sampler2D uAtlasTex;
layout(location = 0) out vec4 oColor;

void main() {
  if (vAlpha < 0.02) discard;
  vec2 cellUv = vec2(vQuadUv.x, 1.0 - vQuadUv.y);
  vec2 uv = (vec2(floor(vGlyphCol + 0.5), floor(vGlyphRow + 0.5)) + clamp(cellUv, 0.04, 0.96)) / vec2(20.0, 6.0);
  float ink = smoothstep(0.22, 0.60, texture(uAtlasTex, uv).r);
  if (ink < 0.08) discard;
  oColor = vec4(vColor, ink * vAlpha);
}
`;

export const EDGE_FS = /* glsl */`#version 300 es
precision highp float;

in vec2 vUv;
out vec4 oEdge;

uniform sampler2D uColorTex;
uniform sampler2D uNormDepthTex;
uniform vec2 uTexel;
uniform float uEdgeThresh;

void sampleGN(vec2 uv, out vec3 n, out float d, out float lum) {
  vec4 nd = texture(uNormDepthTex, uv);
  n = nd.rgb * 2.0 - 1.0;
  d = nd.a;
  lum = texture(uColorTex, uv).a;
}

void main() {
  vec3 nTL, nT, nTR, nL, nC, nR, nBL, nB, nBR;
  float dTL, dT, dTR, dL, dC, dR, dBL, dB, dBR;
  float lTL, lT, lTR, lL, lC, lR, lBL, lB, lBR;

  sampleGN(vUv + vec2(-1.0,  1.0) * uTexel, nTL, dTL, lTL);
  sampleGN(vUv + vec2( 0.0,  1.0) * uTexel, nT,  dT,  lT);
  sampleGN(vUv + vec2( 1.0,  1.0) * uTexel, nTR, dTR, lTR);
  sampleGN(vUv + vec2(-1.0,  0.0) * uTexel, nL,  dL,  lL);
  sampleGN(vUv,                             nC,  dC,  lC);
  sampleGN(vUv + vec2( 1.0,  0.0) * uTexel, nR,  dR,  lR);
  sampleGN(vUv + vec2(-1.0, -1.0) * uTexel, nBL, dBL, lBL);
  sampleGN(vUv + vec2( 0.0, -1.0) * uTexel, nB,  dB,  lB);
  sampleGN(vUv + vec2( 1.0, -1.0) * uTexel, nBR, dBR, lBR);

  float dGx = (-dTL - 2.0 * dL - dBL) + (dTR + 2.0 * dR + dBR);
  float dGy = (-dTL - 2.0 * dT - dTR) + (dBL + 2.0 * dB + dBR);

  vec3 nGxV = (-nTL - 2.0 * nL - nBL) + (nTR + 2.0 * nR + nBR);
  vec3 nGyV = (-nTL - 2.0 * nT - nTR) + (nBL + 2.0 * nB + nBR);
  vec3 nRef = vec3(0.37, 0.79, 0.49);
  float nGx = length(nGxV) * (dot(nGxV, nRef) >= 0.0 ? 1.0 : -1.0);
  float nGy = length(nGyV) * (dot(nGyV, nRef) >= 0.0 ? 1.0 : -1.0);

  float lGx = (-lTL - 2.0 * lL - lBL) + (lTR + 2.0 * lR + lBR);
  float lGy = (-lTL - 2.0 * lT - lTR) + (lBL + 2.0 * lB + lBR);

  vec2 gD = vec2(dGx, dGy) * 5.2;
  vec2 gN = vec2(nGx, nGy) * 0.45;
  vec2 gL = vec2(lGx, lGy) * 0.85;
  vec2 g = gD; float mag = length(gD);
  if (length(gN) > mag) { mag = length(gN); g = gN; }
  if (length(gL) > mag) { mag = length(gL); g = gL; }

  float dirId = 0.0;
  if (mag > uEdgeThresh) {
    float ang = atan(g.y, g.x);
    float a = mod(ang + 3.14159265, 3.14159265) / 3.14159265;
    if (a < 0.125 || a >= 0.875)      dirId = 0.25; // |
    else if (a >= 0.375 && a < 0.625) dirId = 0.50; // —
    else if (a >= 0.125 && a < 0.375) dirId = 1.00; // \
    else                              dirId = 0.75; // /
  }
  oEdge = vec4(clamp(mag, 0.0, 2.0), dirId, lC, 1.0);
}
`;

export const COMPOSITE_CRT_FS = /* glsl */`#version 300 es
precision highp float;

in vec2 vUv;
out vec4 fragColor;

uniform sampler2D uLitTex;
uniform sampler2D uNormDepthTex;
uniform sampler2D uEdgeTex;
uniform sampler2D uWorldTex;
uniform sampler2D uAtlasTex;
uniform vec2 uRes;
uniform float uCellPx;
uniform int uStageLeft;   // -1=Normals+Depth, 0=Original 3D, 1=Screen Luma, 2=Screen Sobel, 3..7=World-Space 3D ASCII!
uniform int uStageRight;
uniform float uSplitX;
uniform int uShowEdges;
uniform int uCrtEnabled;
uniform int uCharset;
uniform int uPalette;
uniform float uTime;

float sampleAtlas(int colIdx, int rowIdx, vec2 localUv) {
  vec2 cellUv = vec2(localUv.x, 1.0 - localUv.y);
  vec2 uv = (vec2(float(colIdx), float(rowIdx)) + clamp(cellUv, 0.04, 0.96)) / vec2(20.0, 6.0);
  return smoothstep(0.20, 0.62, texture(uAtlasTex, uv).r);
}

vec3 evalScreenSpaceAscii(vec2 uv, bool useSobel) {
  vec2 cellCount = max(vec2(16.0), floor(uRes / uCellPx));
  vec2 cellIdx = floor(uv * cellCount);
  vec2 cellUv0 = cellIdx / cellCount;
  vec2 cellStep = 1.0 / cellCount;
  vec2 localUv = fract(uv * cellCount);

  vec3 sumCol = vec3(0.0);
  float sumLum = 0.0;
  float votes[4];
  votes[0] = 0.0; votes[1] = 0.0; votes[2] = 0.0; votes[3] = 0.0;

  for (int sy = 0; sy < 4; sy++) {
    for (int sx = 0; sx < 4; sx++) {
      vec2 suv = cellUv0 + (vec2(float(sx) + 0.5, float(sy) + 0.5) * 0.25) * cellStep;
      vec3 c = texture(uLitTex, suv).rgb;
      sumCol += c;
      sumLum += dot(c, vec3(0.2126, 0.7152, 0.0722));
      if (useSobel) {
        vec4 se = texture(uEdgeTex, suv);
        if (se.g > 0.1) {
          int b = clamp(int(floor(se.g * 4.0 + 0.5)) - 1, 0, 3);
          votes[b] += 1.0;
        }
      }
    }
  }
  vec3 avgCol = sumCol / 16.0;
  float avgLum = sumLum / 16.0;

  int bestEdge = -1;
  if (useSobel) {
    float bestVotes = 2.5;
    for (int b = 0; b < 4; b++) {
      if (votes[b] > bestVotes) { bestVotes = votes[b]; bestEdge = b; }
    }
  }

  int row = (uCharset == 2) ? 5 : 0;
  float shaped = pow(clamp(avgLum * 1.45, 0.0, 1.0), 0.78);
  int fillIdx = clamp(int(floor(shaped * 15.99)), 0, 15);
  bool isEdge = useSobel && bestEdge >= 0;
  int colIdx = isEdge ? (16 + bestEdge) : fillIdx;
  float ink = sampleAtlas(colIdx, row, localUv);

  vec3 fg = mix(vec3(0.32, 0.34, 0.42), vec3(0.92, 0.92, 0.96), shaped);
  // Subtle tint from original 3D color
  fg = mix(fg, clamp(avgCol * 1.65, 0.0, 1.0), 0.55);
  if (uShowEdges == 1 && isEdge) fg = vec3(1.0, 0.80, 0.24);
  else if (isEdge) fg = mix(fg, vec3(1.0, 0.92, 0.72), 0.45);
  return mix(vec3(0.015, 0.015, 0.022), fg, ink);
}

vec3 evalStage(int stage, vec2 uv) {
  if (stage == -1) {
    vec4 nd = texture(uNormDepthTex, uv);
    return mix(nd.rgb, vec3(1.0 - nd.a), 0.30);
  }
  if (stage == 0) return texture(uLitTex, uv).rgb;
  if (stage == 1) return evalScreenSpaceAscii(uv, false);
  if (stage == 2) return evalScreenSpaceAscii(uv, true);
  return texture(uWorldTex, uv).rgb;
}

vec2 clampSide(vec2 uv, bool rightSide, vec2 px) {
  float minX = (uSplitX > 0.0 && rightSide) ? (uSplitX + px.x * 1.5) : 0.002;
  float maxX = (uSplitX > 0.0 && !rightSide) ? (uSplitX - px.x * 1.5) : 0.998;
  return vec2(clamp(uv.x, minX, maxX), clamp(uv.y, 0.002, 0.998));
}

float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

vec3 applyAnalogCrt(vec2 uv, bool rightSide) {
  vec2 px = 1.0 / uRes;
  vec2 safeUv = clampSide(uv, rightSide, px);

  // Subtle horizontal analog RGB halation / phosphor convergence fringe (stays razor-crisp on text!)
  float r = texture(uWorldTex, clampSide(safeUv + vec2(px.x * 0.95, 0.0), rightSide, px)).r;
  float g = texture(uWorldTex, safeUv).g;
  float b = texture(uWorldTex, clampSide(safeUv - vec2(px.x * 0.95, 0.0), rightSide, px)).b;
  vec3 col = vec3(r, g, b);

  // Soft dark-room phosphor bloom around white gat-hat rim, amber cathedral windows & embers!
  vec3 bloom = vec3(0.0);
  const vec2 offs[8] = vec2[8](
    vec2( 2.0,  0.0), vec2(-2.0,  0.0), vec2( 0.0,  2.0), vec2( 0.0, -2.0),
    vec2( 4.0,  3.0), vec2(-4.0,  3.0), vec2( 4.0, -3.0), vec2(-4.0, -3.0)
  );
  for (int i = 0; i < 8; i++) {
    vec3 s = texture(uWorldTex, clampSide(safeUv + offs[i] * px * 1.7, rightSide, px)).rgb;
    float lum = dot(s, vec3(0.299, 0.587, 0.114));
    bloom += s * smoothstep(0.42, 0.95, lum);
  }
  col += (bloom / 8.0) * 0.42;

  // Ultra-subtle CRT scanlines & faint analog VHS/phosphor film grain (preserves deep #050507 obsidian black!)
  float scan = 0.93 + 0.07 * sin(uv.y * uRes.y * 3.14159265 * 0.85);
  col *= scan;
  float grain = (hash12(uv * uRes + fract(uTime) * 137.0) - 0.5) * 0.032;
  col += grain * smoothstep(0.02, 0.16, dot(col, vec3(0.333)));

  // Soft dark-room vignette
  vec2 v = uv * (1.0 - uv);
  float vig = clamp(pow(v.x * v.y * 24.0, 0.16), 0.0, 1.0);
  col *= 0.72 + 0.28 * vig;
  return col;
}

void main() {
  bool rightSide = (uSplitX <= 0.0) || (vUv.x >= uSplitX);
  int stage = rightSide ? uStageRight : uStageLeft;

  vec3 col;
  if (stage == 7 && uCrtEnabled == 1) {
    col = applyAnalogCrt(vUv, rightSide);
  } else {
    col = evalStage(stage, vUv);
  }
  fragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
}
`;
