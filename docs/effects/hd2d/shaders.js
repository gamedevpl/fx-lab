// GLSL ES 3.00 Shaders for FX Lab #29: HD-2D Miniature Diorama (8 Steps)
// 1) Shadow Map Pass (directional key shadow)
// 2) Main 3D Scene Pass -> MRT0 RGBA16F Linear HDR Color + MRT1 Linear View-Depth & Mask
// 3) Emissive Billboards & Optional 2D Pixel Sprites Pass (flames, arcane orb, golden sparks, 2D sprites)
// 4) Half-Res Separable HDR Bloom Extract & Gaussian Blur
// 5) Final Composite: Drifting Foreground Mist + 24-Tap HDR Vogel-Disk Tilt-Shift DoF (1904 Scheimpflug) + ACES Filmic Grade + Split-Screen

export const SHADOW_VS = `#version 300 es
precision highp float;
layout(location=0) in vec3 aPos;
uniform mat4 uLightVP;
void main() {
  gl_Position = uLightVP * vec4(aPos, 1.0);
}
`;

export const SHADOW_FS = `#version 300 es
precision highp float;
out vec4 fragColor;
void main() {
  fragColor = vec4(1.0);
}
`;

export const SCENE_VS = `#version 300 es
precision highp float;
layout(location=0) in vec3 aPos;
layout(location=1) in vec3 aNorm;
layout(location=2) in vec3 aTang;
layout(location=3) in vec2 aUv;
layout(location=4) in float aTexId;
layout(location=5) in vec3 aTint;

uniform mat4 uViewProj;
uniform mat4 uView;
uniform mat4 uLightVP;
uniform mat4 uTorchVP;

out vec3 vWorldPos;
out vec3 vNorm;
out vec3 vTang;
out vec2 vUv;
out float vTexId;
out vec3 vTint;
out float vViewZ;
out vec4 vShadowPos;
out vec4 vTorchShadowPos;

void main() {
  vWorldPos = aPos;
  vNorm = aNorm;
  vTang = aTang;
  vUv = aUv;
  vTexId = aTexId;
  vTint = aTint;
  vec4 vp = uView * vec4(aPos, 1.0);
  vViewZ = -vp.z;
  vShadowPos = uLightVP * vec4(aPos, 1.0);
  vTorchShadowPos = uTorchVP * vec4(aPos, 1.0);
  gl_Position = uViewProj * vec4(aPos, 1.0);
}
`;

export const SCENE_FS = `#version 300 es
precision highp float;
precision highp sampler2DArray;

in vec3 vWorldPos;
in vec3 vNorm;
in vec3 vTang;
in vec2 vUv;
in float vTexId;
in vec3 vTint;
in float vViewZ;
in vec4 vShadowPos;
in vec4 vTorchShadowPos;

uniform sampler2DArray uAlbedoArr;
uniform sampler2DArray uNormRoughArr;
uniform sampler2D uShadowMap;
uniform sampler2D uTorchShadowMap;
uniform vec3 uCamPos;
uniform float uTime;
uniform int uStage;
uniform int uNormalOn;
uniform int uCoolAmbient;
uniform vec4 uLightPosRad[12];
uniform vec4 uLightColInt[12];

layout(location=0) out vec4 outHdr;
layout(location=1) out vec4 outDepth;

float sampleShadowPcf(sampler2D smap, vec4 sp, vec3 N, vec3 L, float baseBias) {
  if (sp.w <= 0.001) return 1.0;
  vec3 p = (sp.xyz / sp.w) * 0.5 + 0.5;
  if (p.x < 0.008 || p.x > 0.992 || p.y < 0.008 || p.y > 0.992 || p.z < 0.0 || p.z > 0.998) return 1.0;
  float bias = max(baseBias, baseBias * 2.8 * (1.0 - max(dot(N, L), 0.0)));
  vec2 texel = vec2(1.0 / 1024.0);
  float s = 0.0;
  for (int y = -1; y <= 1; y++) {
    for (int x = -1; x <= 1; x++) {
      float d = texture(smap, p.xy + vec2(float(x), float(y)) * texel).r;
      s += (p.z - bias <= d) ? 1.0 : 0.0;
    }
  }
  return s / 9.0;
}

// Grounded contact ambient occlusion beneath fighters, props, and wall-floor creases!
float computeContactAO(vec3 wp, vec3 N, int stage) {
  float ao = 1.0;
  if (N.y > 0.5 && wp.y < 0.14 && wp.y > -0.15) {
    // Wall-base crevice darkening along the iconic L-shaped dungeon wall
    float dWallMain = abs(wp.z + 1.35);
    if (wp.x > -6.6 && wp.x < 5.5 && wp.z > -1.45) {
      ao *= mix(0.42, 1.0, smoothstep(0.0, 0.58, dWallMain));
    }
    // Inner corner pier base crevice
    if (wp.x > -0.6 && wp.x < 1.0 && wp.z > -1.5 && wp.z < 0.15) {
      float dPier = max(abs(wp.x + 0.02) - 0.44, abs(wp.z + 1.1) - 0.55);
      ao *= mix(0.45, 1.0, smoothstep(0.0, 0.42, max(dPier, 0.0)));
    }
    // Crisp soft contact shadows right under the Knight & Skeleton boots (Step 5+)!
    if (stage >= 4) {
      float dKnight = length(wp.xz - vec2(0.78, 0.28));
      float dSkel   = length(wp.xz - vec2(-0.58, -0.06));
      ao *= mix(0.18, 1.0, smoothstep(0.16, 0.66, dKnight));
      ao *= mix(0.18, 1.0, smoothstep(0.16, 0.64, dSkel));
    }
    // Grounded contact shadows beneath courtyard barrel & wooden crates
    float dCrate1 = length(wp.xz - vec2(-2.45, 1.95));
    float dCrate2 = length(wp.xz - vec2(-3.35, 0.05));
    float dCrate3 = length(wp.xz - vec2( 3.86, -0.50));
    ao *= mix(0.32, 1.0, smoothstep(0.24, 0.62, dCrate1));
    ao *= mix(0.35, 1.0, smoothstep(0.24, 0.62, dCrate2));
    ao *= mix(0.35, 1.0, smoothstep(0.24, 0.62, dCrate3));
  }
  return ao;
}

void main() {
  vec3 Ngeom = normalize(vNorm);
  vec3 T = normalize(vTang - Ngeom * dot(Ngeom, vTang));
  vec3 B = cross(Ngeom, T);

  vec3 albedo = vTint;
  float rough = 0.72;
  float metallic = 0.0;
  float emissiveMask = 0.0;
  vec3 N = Ngeom;

  if (vTexId >= -0.5) {
    int layer = int(floor(vTexId + 0.5));
    vec2 uv = vUv;
    // Gentle animated pixel-ripple scroll on subterranean canal water (layer 7)
    if (layer == 7) {
      uv += vec2(uTime * 0.06, -uTime * 0.04);
    }
    vec4 albSample = texture(uAlbedoArr, vec3(uv, float(layer)));
    vec4 nrSample = texture(uNormRoughArr, vec3(uv, float(layer)));
    albedo = pow(albSample.rgb, vec3(2.2)) * vTint;
    emissiveMask = albSample.a;
    rough = nrSample.a;

    // Step 3+ (uStage >= 2): Tangent-space nearest-neighbor pixel-art normal mapping!
    if (uStage >= 2 && uNormalOn == 1) {
      vec3 tn = nrSample.xyz * 2.0 - 1.0;
      tn.xy *= (uStage == 2 ? 1.85 : 1.35);
      N = normalize(T * tn.x + B * tn.y + Ngeom * tn.z);
    }
  } else if (vTexId > -1.95) {
    // Sculpted Blender fighter or wrought-iron prop: decode per-part roughness from (-1.0 - rough)
    albedo = pow(max(vTint, vec3(0.0)), vec3(2.2));
    rough = clamp(-vTexId - 1.0, 0.14, 0.92);
    // Low-roughness pieces (knight steel plate, gold trim, blades, iron shield) get crisp metallic specular!
    metallic = smoothstep(0.38, 0.22, rough);
  } else {
    // HDR Emissive solid (enchanted rune sword blade, undead glowing cyan eyes, torch embers, pixel HP bar)
    outHdr = vec4(vTint, 1.0);
    outDepth = vec4(vViewZ, 1.0, 1.0, 1.0);
    return;
  }

  vec3 V = normalize(uCamPos - vWorldPos);
  vec3 col = vec3(0.0);

  if (uStage <= 1) {
    // PASS 1 & 2: Flat cheap neutral lighting (no normal relief, no shadows, no warm/cool mood)
    vec3 Lflat = normalize(vec3(0.35, 0.85, 0.42));
    float ndl = max(dot(Ngeom, Lflat), 0.0);
    col = albedo * (0.48 + 0.56 * ndl);
    if (emissiveMask > 0.1) col += pow(vec3(0.95, 0.80, 0.52), vec3(2.2)) * emissiveMask * 0.7;
  } else if (uStage == 2) {
    // PASS 3: Pixel-Art Normal Maps isolated with dramatic grazing raking key light!
    vec3 Lrake = normalize(vec3(0.76, 0.30, 0.58));
    float ndl = max(dot(N, Lrake), 0.0);
    vec3 H = normalize(Lrake + V);
    float spec = pow(max(dot(N, H), 0.0), mix(44.0, 8.0, rough)) * (1.0 - rough) * 0.58;
    vec3 hemi = mix(vec3(0.08, 0.10, 0.15), vec3(0.22, 0.23, 0.26), N.y * 0.5 + 0.5);
    col = albedo * (hemi + vec3(1.32, 1.12, 0.88) * ndl) + vec3(1.0, 0.92, 0.78) * spec;
    if (emissiveMask > 0.1) col += vec3(1.2, 0.78, 0.28) * emissiveMask;
  } else {
    // PASS 4..8: Rich Moody Chiaroscuro + DUAL REAL SHADOW MAPS (Moonlight + Primary Courtyard Torch!) + Contact AO!
    vec3 moonDir = normalize(vec3(0.55, 0.72, 0.42));
    float moonSh = sampleShadowPcf(uShadowMap, vShadowPos, Ngeom, moonDir, 0.0022);
    vec3 torchPos = vec3(0.72, 2.25, -0.96);
    vec3 torchDir = normalize(torchPos - vWorldPos);
    float torchSh = sampleShadowPcf(uTorchShadowMap, vTorchShadowPos, Ngeom, torchDir, 0.0014);
    float ao = computeContactAO(vWorldPos, Ngeom, uStage);

    float moonNdl = max(dot(N, moonDir), 0.0);
    vec3 ambSky = (uCoolAmbient == 1) ? vec3(0.055, 0.112, 0.265) : vec3(0.055, 0.055, 0.055);
    vec3 ambGnd = (uCoolAmbient == 1) ? vec3(0.016, 0.032, 0.082) : vec3(0.02, 0.02, 0.02);
    vec3 hemi = mix(ambGnd, ambSky, clamp(N.y * 0.5 + 0.5, 0.0, 1.0)) * ao;
    vec3 moonCol = (uCoolAmbient == 1) ? vec3(0.18, 0.32, 0.62) : vec3(0.16, 0.16, 0.16);

    // Subtle cool moonlight rim on sculpted armor, capes, skull & stone edges!
    float rim = pow(1.0 - max(dot(N, V), 0.0), 2.8) * (0.28 + 0.52 * clamp(N.y + 0.35, 0.0, 1.0));
    vec3 specTint = mix(vec3(1.0), albedo * 1.45 + vec3(0.18), metallic);
    col = albedo * (1.0 - metallic * 0.32) * (hemi + moonCol * moonNdl * (0.14 + 0.86 * moonSh))
        + moonCol * specTint * rim * (0.26 + 0.38 * metallic) * (0.35 + 0.65 * moonSh);

    // 12 HDR Dynamic Point Lights — with REAL perspective shadow casting from our primary courtyard duel torch!
    for (int i = 0; i < 12; i++) {
      // On Pass 4 (stage == 3, before characters are added), skip hero's sword light (index 3)
      if (uStage == 3 && i == 3) continue;
      vec3 lp = uLightPosRad[i].xyz;
      float rad = uLightPosRad[i].w;
      vec3 lcol = uLightColInt[i].rgb;
      float lint = uLightColInt[i].w;

      vec3 toL = lp - vWorldPos;
      float d2 = dot(toL, toL);
      float d = sqrt(d2);
      if (d > rad) continue;
      vec3 L = toL / max(d, 1e-4);

      float att = pow(clamp(1.0 - d / rad, 0.0, 1.0), 1.80) / (0.32 + d2 * 0.40);
      float ndl = max(dot(N, L), 0.0);
      float wrap = max(dot(N, L) * 0.72 + 0.28, 0.0) * 0.18;

      vec3 H = normalize(L + V);
      float shininess = mix(96.0, 10.0, rough);
      float spec = pow(max(dot(N, H), 0.0), shininess) * (1.0 - rough) * (0.68 + 0.85 * metallic);

      // REAL dramatic cast shadows!
      // Light 1 (primary corner torch) uses full 94% perspective torch shadow;
      // neighboring courtyard torches (0, 2) inherit crisp directional/torch shadow grounding so cast shadows stay dark & unmistakable!
      float localSh = 1.0;
      if (i == 1) {
        localSh = 0.06 + 0.94 * torchSh;
      } else if (i == 0 || i == 2) {
        localSh = (0.38 + 0.62 * torchSh) * (0.55 + 0.45 * moonSh);
      } else {
        localSh = 0.45 + 0.55 * moonSh;
      }

      col += (albedo * (1.0 - metallic * 0.28) * (ndl + wrap) + specTint * spec) * lcol * lint * att * localSh * (0.40 + 0.60 * ao);
    }

    // Glowing stained-glass gothic windows (layer 6 emissive mask -> bright HDR for Bloom + Top Bokeh!)
    if (emissiveMask > 0.1) {
      float winBoost = (uStage >= 5) ? 3.4 : 1.75;
      col += vec3(1.05, 0.68, 0.22) * emissiveMask * winBoost;
    }

    // Subtle deep blue distance dungeon haze in far corners (gives lush miniature depth separation)
    if (uStage >= 3) {
      float fogAmt = smoothstep(14.5, 29.0, vViewZ) * (uStage >= 5 ? 0.42 : 0.22);
      vec3 fogCol = (uCoolAmbient == 1) ? vec3(0.032, 0.058, 0.135) : vec3(0.04, 0.04, 0.05);
      col = mix(col, fogCol, fogAmt);
    }
  }

  outHdr = vec4(col, 1.0);
  outDepth = vec4(vViewZ, 0.0, 1.0, 1.0);
}
`;

// Camera-facing HDR Emissive Billboards (flames, arcane orb halo, golden sparks) + 2D Pixel Sprites
export const BILLBOARD_VS = `#version 300 es
precision highp float;
// Quad corner (-0.5..+0.5)
layout(location=0) in vec2 aCorner;
// Per-instance: aInstPosSize = (x,y,z,size), aInstColShape = (r,g,b,shape)
layout(location=1) in vec4 aInstPosSize;
layout(location=2) in vec4 aInstColShape;

uniform mat4 uViewProj;
uniform mat4 uView;
uniform vec3 uCamRight;
uniform vec3 uCamUp;

out vec2 vUv;
out vec3 vCol;
out float vShape;
out float vViewZ;

void main() {
  vec3 center = aInstPosSize.xyz;
  float sz = aInstPosSize.w;
  float shape = aInstColShape.w;

  // 2D character sprites (shape >= 1.5) stand upright in world Y while facing camera horizontally!
  vec3 upAxis = (shape >= 1.5) ? vec3(0.0, 1.0, 0.0) : uCamUp;
  vec3 worldPos = center + uCamRight * (aCorner.x * sz) + upAxis * (aCorner.y * sz);

  vUv = aCorner + 0.5;
  vCol = aInstColShape.rgb;
  vShape = shape;
  vec4 vp = uView * vec4(worldPos, 1.0);
  vViewZ = -vp.z;
  gl_Position = uViewProj * vec4(worldPos, 1.0);
}
`;

export const BILLBOARD_FS = `#version 300 es
precision highp float;
in vec2 vUv;
in vec3 vCol;
in float vShape;
in float vViewZ;

uniform sampler2D uSprites;
uniform int uStage;

layout(location=0) out vec4 outHdr;
layout(location=1) out vec4 outDepth;

void main() {
  if (vShape >= 1.5) {
    // Crisp nearest-neighbor 2D Octopath-style pixel-art character sprite!
    float isSkel = (vShape >= 2.5) ? 1.0 : 0.0;
    vec2 suv = vec2(vUv.x * 0.5 + isSkel * 0.5, vUv.y);
    vec4 s = texture(uSprites, suv);
    if (s.a < 0.5) discard;
    vec3 lin = pow(s.rgb, vec3(2.2));
    // Warm torchlit shading on the 2D billboard so it sits convincingly in the dungeon!
    vec3 lit = lin * vec3(1.18, 0.96, 0.78) + vec3(0.04, 0.07, 0.14) * lin;
    // Golden rune sword pixels emit HDR glow
    if (isSkel < 0.5 && s.r > 0.9 && s.g > 0.78 && s.b < 0.75) {
      lit *= (uStage >= 5 ? 3.2 : 1.6);
    }
    outHdr = vec4(lit, 1.0);
    outDepth = vec4(vViewZ, 0.0, 1.0, 1.0);
    return;
  }

  vec2 p = vUv * 2.0 - 1.0;
  float r2 = dot(p, p);
  if (vShape < 0.5) {
    // Soft glowing torch flame / arcane crystal orb core
    if (r2 > 1.0) discard;
    float core = exp(-r2 * 4.2);
    float halo = exp(-r2 * 1.6) * 0.35;
    float boost = (uStage >= 5) ? 1.0 : 0.55;
    vec3 c = vCol * (core + halo) * boost;
    float alpha = clamp(core * 1.15 + halo, 0.0, 1.0);
    outHdr = vec4(c, alpha);
    outDepth = vec4(vViewZ, 1.0, alpha, 1.0);
  } else {
    // Crisp square pixel-art golden spell spark / rising ember!
    if (abs(p.x) > 0.85 || abs(p.y) > 0.85) discard;
    float boost = (uStage >= 5) ? 1.0 : 0.65;
    outHdr = vec4(vCol * boost, 1.0);
    outDepth = vec4(vViewZ, 1.0, 1.0, 1.0);
  }
}
`;

// Separable Bloom Extract (Pass A) & Blur (Pass B/C)
export const BLOOM_FS = `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uSrc;
uniform vec2 uDir;
uniform int uExtract;
out vec4 fragColor;

void main() {
  if (uExtract == 1) {
    // 4-tap box downsample + soft knee HDR threshold (> 0.82)
    vec2 h = uDir;
    vec3 c = (
      texture(uSrc, vUv + vec2(-h.x, -h.y)).rgb +
      texture(uSrc, vUv + vec2( h.x, -h.y)).rgb +
      texture(uSrc, vUv + vec2(-h.x,  h.y)).rgb +
      texture(uSrc, vUv + vec2( h.x,  h.y)).rgb
    ) * 0.25;
    float luma = dot(c, vec3(0.2126, 0.7152, 0.0722));
    float soft = smoothstep(0.75, 1.65, luma);
    fragColor = vec4(c * soft, 1.0);
    return;
  }
  // 9-tap wide Gaussian blur
  const float w[5] = float[5](0.227027, 0.1945946, 0.1216216, 0.054054, 0.016216);
  vec3 sum = texture(uSrc, vUv).rgb * w[0];
  for (int i = 1; i < 5; i++) {
    vec2 off = uDir * float(i) * 1.45;
    sum += texture(uSrc, vUv + off).rgb * w[i];
    sum += texture(uSrc, vUv - off).rgb * w[i];
  }
  fragColor = vec4(sum, 1.0);
}
`;

// FINAL COMPOSITE:
// - Per-side stage evaluation for Split-Screen (handles both dual-buffer & single-buffer comparisons!)
// - 24-Tap Golden-Angle Vogel Spiral Disk HDR Tilt-Shift DoF (1904 Scheimpflug tilted focal plane!)
// - Drifting Translucent Foreground Mist ("rozmyta mgła na pierwszym planie" — in front of the glass!)
// - Scheimpflug Focus-Band Heatmap visualizer
// - ACES Filmic Tone Mapping + Warm/Cool Split Grading + Vignette
export const COMPOSITE_FS = `#version 300 es
precision highp float;
in vec2 vUv;

uniform sampler2D uHdrL;
uniform sampler2D uDepthL;
uniform sampler2D uBloomL;
uniform sampler2D uHdrR;
uniform sampler2D uDepthR;
uniform sampler2D uBloomR;

uniform vec2 uRes;
uniform float uTime;
uniform float uSplitX;
uniform int uStageL;
uniform int uStageR;
uniform int uDualBuf;
uniform float uFocusY;
uniform float uTiltAngle;
uniform int uTiltShiftOn;
uniform int uFrontMistOn;
uniform int uShowFocusMap;
uniform vec2 uClickUv;
uniform float uClickPulse;

out vec4 fragColor;

float hash21(vec2 p) {
  p = fract(p * vec2(234.34, 435.345));
  p += dot(p, p + 34.23);
  return fract(p.x * p.y);
}

float vnoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float a = hash21(i);
  float b = hash21(i + vec2(1.0, 0.0));
  float c = hash21(i + vec2(0.0, 1.0));
  float d = hash21(i + vec2(1.0, 1.0));
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}

float fbm(vec2 p) {
  float v = 0.0, a = 0.5;
  for (int i = 0; i < 4; i++) {
    v += a * vnoise(p);
    p = p * 2.06 + vec2(17.1, 31.7);
    a *= 0.5;
  }
  return v;
}

// Compute signed Scheimpflug Tilted-Plane Circle of Confusion:
// Negative = Near Foreground Blur (bottom), ~0 = Crisp Focal Band (center duel + L-wall), Positive = Far Background Blur (top)
float computeTiltCoc(vec2 uv, float linearZ) {
  // Tilted focal line aligned with the isometric dungeon courtyard & L-wall (Scheimpflug tilted plane!)
  float planeDelta = (uv.y - uFocusY) - uTiltAngle * (uv.x - 0.5);
  float zDelta = (linearZ - 17.6) * 0.026;
  float signedD = mix(planeDelta, zDelta, 0.18);
  float deadzone = 0.095; // razor-sharp central focal strip across duel, banner & door!
  float mag = max(0.0, abs(signedD) - deadzone);
  float coc = smoothstep(0.0, 0.29, mag);
  return sign(signedD) * coc;
}

// 36-Tap Golden-Angle Vogel Spiral Disk Bokeh Gather in linear RGBA16F HDR!
// Butter-smooth optical glass blur with zero sample stepping; bright top/bottom lights bloom into round HDR bokeh!
vec3 sampleTiltShiftDof(sampler2D hdrTex, sampler2D depthTex, vec2 uv, float centerCoc) {
  float absCoc = abs(centerCoc);
  if (absCoc < 0.012) return texture(hdrTex, uv).rgb;

  float aspect = uRes.x / max(uRes.y, 1.0);
  float maxRadY = 0.034;
  float radY = absCoc * maxRadY;
  vec2 rad = vec2(radY / aspect, radY);

  const float GOLDEN = 2.39996323;
  // Subtle per-pixel angle jitter eliminates concentric ringing on high-contrast pixel brick edges!
  float jitter = hash21(gl_FragCoord.xy) * 6.28318;
  vec3 acc = vec3(0.0);
  float wSum = 0.0;

  vec3 c0 = texture(hdrTex, uv).rgb;
  acc += c0 * 0.7;
  wSum += 0.7;

  for (int i = 0; i < 36; i++) {
    float fi = (float(i) + 0.5) / 36.0;
    float r = sqrt(fi);
    float ang = float(i) * GOLDEN + jitter * 0.35;
    vec2 off = vec2(cos(ang), sin(ang)) * (r * rad);
    vec2 suv = clamp(uv + off, vec2(0.002), vec2(0.998));

    vec3 sc = texture(hdrTex, suv).rgb;
    float sZ = texture(depthTex, suv).r;
    float sCoc = computeTiltCoc(suv, sZ);

    float w = 1.0;
    if (centerCoc > 0.0 && abs(sCoc) < absCoc * 0.42) {
      w = 0.18;
    }
    float luma = dot(sc, vec3(0.2126, 0.7152, 0.0722));
    float bokehBoost = 1.0 + smoothstep(1.1, 4.2, luma) * 0.65;
    acc += sc * (w * bokehBoost);
    wSum += w;
  }
  return acc / max(wSum, 1e-4);
}

// Drifting Foreground Mist ("rozmyta mgła na pierwszym planie" — unmistakable atmospheric veil before the glass!)
vec3 applyForegroundMist(vec3 col, vec2 uv, float t, float coc) {
  float lowerMask = smoothstep(0.46, 0.0, uv.y);
  float upperRim = smoothstep(0.66, 1.0, uv.y) * 0.52;
  float cornerVail = smoothstep(0.36, 0.78, length((uv - vec2(0.5, 0.50)) * vec2(1.0, 1.12))) * 0.42;
  float mistZone = clamp(lowerMask * 1.05 + upperRim + cornerVail, 0.0, 1.0);

  vec2 p1 = uv * vec2(2.4, 2.8) + vec2(t * 0.075, -t * 0.022);
  vec2 p2 = uv * vec2(4.6, 5.4) + vec2(-t * 0.048, t * 0.015);
  float wisp = fbm(p1) * 0.62 + fbm(p2) * 0.38;
  float density = smoothstep(0.20, 0.82, wisp) * mistZone * 0.68;

  // Cool slate-navy mist catching warm orange forward scatter near foreground braziers & cool cyan near upper orb!
  float warmScatter = exp(-length((uv - vec2(0.35, 0.06)) * vec2(1.4, 2.2)) * 2.5)
                    + exp(-length((uv - vec2(0.72, 0.10)) * vec2(1.4, 2.2)) * 2.5);
  float cyanScatter = exp(-length((uv - vec2(0.62, 0.90)) * vec2(1.6, 2.2)) * 2.6);
  vec3 mistCol = vec3(0.068, 0.125, 0.255)
               + vec3(0.34, 0.16, 0.05) * warmScatter * 0.75
               + vec3(0.08, 0.28, 0.42) * cyanScatter * 0.65;

  float blurBoost = 1.0 + smoothstep(0.0, 0.75, abs(coc)) * 0.28;
  return mix(col, mistCol, clamp(density * blurBoost, 0.0, 0.74));
}

vec3 acesToneMap(vec3 x) {
  const float a = 2.51, b = 0.03, c = 2.43, d = 0.59, e = 0.14;
  return clamp((x * (a * x + b)) / (x * (c * x + d) + e), 0.0, 1.0);
}

vec3 evalSide(sampler2D hdrTex, sampler2D depthTex, sampler2D bloomTex, int stage, vec2 uv) {
  float z = texture(depthTex, uv).r;
  float coc = computeTiltCoc(uv, z);

  // Step 7 & 8 (stage >= 6): Real HDR Tilt-Shift DoF! (Toggleable on Step 8 via uTiltShiftOn)
  bool doTilt = (stage == 6) || (stage >= 7 && uTiltShiftOn == 1);
  vec3 col = doTilt ? sampleTiltShiftDof(hdrTex, depthTex, uv, coc) : texture(hdrTex, uv).rgb;

  // Step 6+ (stage >= 5): Add multi-pass separable HDR Bloom!
  if (stage >= 5) {
    vec3 bl = texture(bloomTex, uv).rgb;
    col += bl * (stage >= 7 ? 0.68 : 0.58);
  }

  // Step 6+ (stage >= 5): Drifting Foreground Mist ("rozmyta mgła na pierwszym planie")
  if (stage >= 5 && uFrontMistOn == 1) {
    col = applyForegroundMist(col, uv, uTime, doTilt ? coc : 0.0);
  }

  // Tone mapping & Color Grading
  if (stage <= 1) {
    // Raw LDR clamp + sRGB gamma (authentic flat 1998/early indie look!)
    col = pow(clamp(col, 0.0, 1.0), vec3(1.0 / 2.2));
  } else if (stage <= 6) {
    // Clean HDR Reinhard/Filmic transition
    col = acesToneMap(col * 1.12);
    col = pow(col, vec3(1.0 / 2.2));
  } else {
    // Step 8 (Final HD-2D Miniature Diorama): Rich ACES Filmic Grade + Warm/Cool Split Toning + Lens Vignette!
    col = acesToneMap(col * 1.20);
    // Subtle lush shadow indigo & warm amber highlight kiss
    float luma = dot(col, vec3(0.2126, 0.7152, 0.0722));
    col = mix(col, col * vec3(0.88, 0.96, 1.14), smoothstep(0.42, 0.02, luma) * 0.34);
    col = mix(col, col * vec3(1.06, 1.01, 0.92), smoothstep(0.45, 0.92, luma) * 0.24);
    // Soft diorama lens vignette
    vec2 vc = (uv - 0.5) * vec2(1.05, 1.12);
    float vig = 1.0 - smoothstep(0.32, 0.88, dot(vc, vc)) * 0.34;
    col *= vig;
    col = pow(clamp(col, 0.0, 1.0), vec3(1.0 / 2.2));
  }

  // Optional Scheimpflug Tilt-Shift Focal-Band Heatmap (Step 7 action button!)
  if (uShowFocusMap == 1 && stage >= 6) {
    float absC = abs(coc);
    vec3 heat = (coc < 0.0)
      ? mix(vec3(0.16, 0.90, 0.56), vec3(0.18, 0.82, 1.00), absC)  // Near foreground blur = Cyan
      : mix(vec3(0.16, 0.90, 0.56), vec3(1.00, 0.72, 0.18), absC); // Far background blur = Gold
    // Highlight the exact crisp Scheimpflug focal centerline!
    float planeDist = abs((uv.y - uFocusY) - uTiltAngle * (uv.x - 0.5));
    float centerLine = smoothstep(0.005, 0.001, planeDist);
    float bandBorder = smoothstep(0.005, 0.001, abs(planeDist - 0.105));
    col = mix(col, heat, 0.58) + vec3(1.0) * centerLine * 0.85 + vec3(0.28, 1.0, 0.68) * bandBorder * 0.65;
  }

  return col;
}

void main() {
  bool isRight = (uSplitX > 0.0 && vUv.x > uSplitX);
  vec3 col;
  if (!isRight) {
    col = evalSide(uHdrL, uDepthL, uBloomL, uStageL, vUv);
  } else if (uDualBuf == 1) {
    col = evalSide(uHdrR, uDepthR, uBloomR, uStageR, vUv);
  } else {
    col = evalSide(uHdrL, uDepthL, uBloomL, uStageR, vUv);
  }

  // Subtle interactive click focus-reticle ring when user clicks to shift Tilt-Shift focal strip!
  if (uClickPulse > 0.01) {
    float aspect = uRes.x / max(uRes.y, 1.0);
    vec2 d = (vUv - uClickUv) * vec2(aspect, 1.0);
    float r = length(d);
    float ringR = mix(0.014, 0.068, 1.0 - uClickPulse);
    float ring = smoothstep(0.004, 0.001, abs(r - ringR)) * uClickPulse;
    // Brief horizontal tilted focal-line flash
    float lineD = abs((vUv.y - uFocusY) - uTiltAngle * (vUv.x - 0.5));
    float fLine = smoothstep(0.003, 0.0005, lineD) * uClickPulse * 0.55;
    col = mix(col, vec3(1.0, 0.84, 0.42), clamp(ring + fLine, 0.0, 0.92));
  }

  fragColor = vec4(col, 1.0);
}
`;
