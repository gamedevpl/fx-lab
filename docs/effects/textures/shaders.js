// Shaders for Evolution of Texture Mapping (1994-2026) — WebGL2.
// Implements:
//   0: 1994 PS1 Affine Texture Warping (exact noperspective via vAffUv / vClipW!) + GTE integer vertex snapping
//   1: 1996 Quake 16-Pixel Span Perspective (Michael Abrash) + nearest texels
//   2: 1996 3dfx Voodoo Bilinear Filtering (blurry up close, wild Moire shimmer on horizon!)
//   3: 1996 Mipmapping & Trilinear (Williams 1983 noted; hardware Voodoo/N64; Show Mip Levels overlay!)
//   4: 1998 S3TC / DXT1 4x4 Block Compression (real RGB565 2-endpoint 4x4 block quantization + Show 4x4 Blocks!)
//   5: 2001 16x Anisotropic Filtering (GeForce 3 vs optional Radeon 8500 angle-dependent artifact!)
//   6: 2011 MegaTexture / Virtual Texturing (RAGE / id Tech 5 — unique non-repeating world murals + live tile pop-in!)
//   7: 2020-26 Sampler Feedback Streaming (DX12 Ultimate, emulated — proactive tile residency + Feedback Map overlay!)

export const CORRIDOR_VS = /* glsl */`#version 300 es
precision highp float;

layout(location = 0) in vec3 aPos;
layout(location = 1) in vec3 aNorm;
layout(location = 2) in vec2 aUv;
layout(location = 3) in float aMat;

uniform mat4 uViewProj;
uniform float uVertexSnap; // >0.5 enables authentic 1994 PS1 GTE screen-space vertex quantization!
uniform float uSnapSplitX; // if split mode has PS1 only on one side, snap gracefully

out vec3 vWorldPos;
out vec3 vNorm;
out vec2 vUv;
out vec2 vAffUv;   // aUv * gl_Position.w -> divided by vClipW in FS gives EXACT screen-space affine interpolation!
out float vClipW;
out float vMat;

void main() {
  vec4 clip = uViewProj * vec4(aPos, 1.0);
  if (uVertexSnap > 0.5 && clip.w > 0.05) {
    // Authentic punchy PS1 integer GTE vertex snapping (visible immediately on walls & floor!)
    vec2 grid = vec2(96.0, 72.0);
    vec2 ndc = clip.xy / clip.w;
    if (uSnapSplitX < 0.0 || ndc.x * 0.5 + 0.5 < uSnapSplitX) {
      ndc = floor(ndc * grid + 0.5) / grid;
      clip.xy = ndc * clip.w;
    }
  }
  gl_Position = clip;
  vWorldPos = aPos;
  vNorm = aNorm;
  vUv = aUv;
  vAffUv = aUv * clip.w;
  vClipW = clip.w;
  vMat = aMat;
}
`;

export const CORRIDOR_FS = /* glsl */`#version 300 es
precision highp float;

in vec3 vWorldPos;
in vec3 vNorm;
in vec2 vUv;
in vec2 vAffUv;
in float vClipW;
in float vMat;

uniform sampler2D uTexFloor;
uniform sampler2D uTexWall;
uniform sampler2D uTexCrate;
uniform sampler2D uPageTable; // 64x64 virtual page residency: R = residentMip/8, G = feedbackTouched (0..1)

uniform vec3 uCamPos;
uniform vec2 uRes;
uniform float uTime;
uniform float uSplitX;
uniform int uStageLeft;
uniform int uStageRight;
uniform float uDebugOn;      // Stage 0: PS1 vertex jitter, Stage 3: Mip colors, Stage 4: 4x4 Block grid, Stage 5: Radeon 8500 angle-dep, Stage 7: Feedback Map
uniform float uBilinearLeft; // Stage 3 split: bilinear mipmap (visible seam!) vs trilinear!

out vec4 oCol;

const float TEX_SZ = 512.0;

// Sample the correct architectural atlas for vMat at exact UV and LOD
vec3 sampleBaseLod(int m, vec2 uv, float lod) {
  if (m == 0) return textureLod(uTexFloor, uv, lod).rgb;
  if (m == 1 || m == 4) return textureLod(uTexWall, uv, lod).rgb;
  return textureLod(uTexCrate, uv, lod).rgb;
}

// Nearest-neighbor sampling on level 0 (exact blocky 1994/1996 texels!)
vec3 sampleNearest0(int m, vec2 uv, float res) {
  vec2 snapped = (floor(uv * res) + 0.5) / res;
  return sampleBaseLod(m, snapped, 0.0);
}

// Exact manual bilinear on level 0 (zero mipmapping -> wild distant Moire shimmer like 1996 3dfx Voodoo without mips!)
vec3 sampleBilinear0(int m, vec2 uv, float res) {
  vec2 p = uv * res - 0.5;
  vec2 f = fract(p);
  vec2 b = (floor(p) + 0.5) / res;
  vec2 d = vec2(1.0 / res);
  vec3 c00 = sampleBaseLod(m, b, 0.0);
  vec3 c10 = sampleBaseLod(m, b + vec2(d.x, 0.0), 0.0);
  vec3 c01 = sampleBaseLod(m, b + vec2(0.0, d.y), 0.0);
  vec3 c11 = sampleBaseLod(m, b + d, 0.0);
  return mix(mix(c00, c10, f.x), mix(c01, c11, f.x), f.y);
}

// Compute isotropic screen-space mip LOD from exact Jacobian derivatives
float computeIsoLod(vec2 uv) {
  vec2 dx = dFdx(uv) * TEX_SZ;
  vec2 dy = dFdy(uv) * TEX_SZ;
  float rho = max(length(dx), length(dy));
  return clamp(log2(max(rho, 1.0)), 0.0, 8.0);
}

// Genuine real-time S3TC / DXT1 (BC1) 4x4 Block Compression!
// Quantizes endpoints to RGB565 and maps every texel inside the 4x4 block to the 4-level DXT1 palette!
vec3 quantRGB565(vec3 c) {
  return vec3(
    floor(c.r * 31.0 + 0.5) / 31.0,
    floor(c.g * 63.0 + 0.5) / 63.0,
    floor(c.b * 31.0 + 0.5) / 31.0
  );
}

vec3 sampleS3TC(int m, vec2 uv, float lod, out float blockEdge) {
  // Effective 128x128 texel base so 4x4 S3TC/DXT1 macroblocks & RGB565 banding are unmistakable inside the 4x loupe!
  float effRes = 128.0 / exp2(floor(clamp(lod, 0.0, 4.0)));
  vec2 tc = uv * effRes;
  vec2 blk = floor(tc * 0.25) * 4.0;
  vec2 inBlk = fract(tc * 0.25);
  blockEdge = smoothstep(0.43, 0.495, max(abs(inBlk.x - 0.5), abs(inBlk.y - 0.5)));

  // Sample 4 corner + center texels of the 4x4 block to determine DXT1 min/max luminance endpoints
  vec3 cMin = vec3(1.0), cMax = vec3(0.0);
  float lMin = 9.0, lMax = -1.0;
  vec3 endLo = vec3(0.0), endHi = vec3(1.0);
  for (int by = 0; by < 2; by++) {
    for (int bx = 0; bx < 2; bx++) {
      vec2 suv = (blk + vec2(float(bx) * 3.0 + 0.5, float(by) * 3.0 + 0.5)) / effRes;
      vec3 s = sampleBaseLod(m, suv, clamp(lod, 0.0, 5.0));
      float l = dot(s, vec3(0.299, 0.587, 0.114));
      if (l < lMin) { lMin = l; endLo = s; }
      if (l > lMax) { lMax = l; endHi = s; }
      cMin = min(cMin, s); cMax = max(cMax, s);
    }
  }
  vec3 e0 = quantRGB565(mix(endLo, cMin, 0.35));
  vec3 e1 = quantRGB565(mix(endHi, cMax, 0.35));

  // Project current texel onto the 1D RGB565 line segment [e0, e1] and quantize to 2-bit index {0, 1/3, 2/3, 1}!
  vec3 cur = sampleBaseLod(m, (floor(tc) + 0.5) / effRes, clamp(lod, 0.0, 5.0));
  vec3 axis = e1 - e0;
  float len2 = dot(axis, axis);
  float t = len2 > 1e-4 ? clamp(dot(cur - e0, axis) / len2, 0.0, 1.0) : 0.0;
  float q = floor(t * 3.0 + 0.5) / 3.0;
  return mix(e0, e1, q);
}

// Genuine 16x Anisotropic Filtering (EWA major-axis tap marching!)
// When radeon8500 is true, emulates the historical Radeon 8500 angle-dependent AF optimization:
// crisp 16x along 0/90 deg cardinal axes, collapsing toward blurry 2x isotropic at 45 deg diagonal angles!
vec3 sampleAnisotropic16(int m, vec2 uv, bool radeon8500) {
  vec2 dx = dFdx(uv) * TEX_SZ;
  vec2 dy = dFdy(uv) * TEX_SZ;
  float lx = length(dx);
  float ly = length(dy);
  vec2 majorV = lx >= ly ? dx : dy;
  float majorL = max(lx, ly);
  float minorL = max(min(lx, ly), 1e-4);

  float maxRatio = 16.0;
  if (radeon8500) {
    // Angle of major derivative axis relative to UV cardinal axes (peaks blurriness at 45 deg!)
    float ang = abs(atan(majorV.y, majorV.x));
    float diag = abs(sin(2.0 * ang)); // 0 along cardinal 0/90 deg, 1 at 45 deg!
    maxRatio = mix(16.0, 1.8, diag * diag);
  }

  float ratio = clamp(majorL / minorL, 1.0, maxRatio);
  int taps = int(clamp(ceil(ratio), 1.0, 16.0));
  float lod = clamp(log2(max(majorL / float(taps), 1.0)), 0.0, 7.0);

  vec2 stepUv = (majorV / TEX_SZ) / float(taps);
  vec3 acc = vec3(0.0);
  for (int i = 0; i < 16; i++) {
    if (i >= taps) break;
    float o = (float(i) + 0.5) - 0.5 * float(taps);
    acc += sampleBaseLod(m, uv + stepUv * o, lod);
  }
  return acc / float(taps);
}

// Unique non-repeating MegaTexture world-space fresco / weathered patina layer (id Tech 5 / RAGE style!)
vec3 megaUniqueTint(vec3 wp, int m, float lod) {
  // Unique painted gallery bay numerals, warm golden fresco arcs, and subtle weathering unique to every meter!
  float bay = floor((6.5 - wp.z) / 2.875);
  float h1 = fract(sin(bay * 127.1 + float(m) * 31.7) * 43758.5453);
  float h2 = fract(sin(bay * 269.5 + 11.3) * 43758.5453);
  vec3 patina = mix(vec3(1.0, 0.96, 0.90), vec3(0.86, 0.93, 1.0), h1);
  // Paint unique bold fresco medallions on walls & floor bays that soften accurately with virtual page mip LOD!
  float blur = clamp(lod * 0.08, 0.015, 0.45);
  vec2 local = vec2(wp.x * 0.45, fract((6.5 - wp.z) / 2.875) - 0.5);
  if (m == 0) {
    float ring = smoothstep(0.24 + blur, 0.21 - blur, abs(length(local - vec2((h2 - 0.5) * 0.7, 0.0)) - 0.16));
    vec3 decalCol = h1 > 0.5 ? vec3(0.92, 0.34, 0.22) : vec3(0.14, 0.72, 0.86);
    return mix(patina, decalCol, ring * 0.52 * (1.0 - clamp(lod / 6.5, 0.0, 0.85)));
  }
  if (m == 1) {
    // Unique painted geometric wall mural strips per bay
    float stripe = smoothstep(0.18 + blur, 0.12 - blur, abs(wp.y - (1.8 + h2 * 1.1)));
    vec3 mural = mix(vec3(0.90, 0.55, 0.22), vec3(0.18, 0.75, 0.88), h1);
    return mix(patina, mural, stripe * 0.44 * (1.0 - clamp(lod / 6.5, 0.0, 0.85)));
  }
  return patina;
}

// Color-coded mipmap level palette (LOD 0 red -> 1 orange -> 2 yellow -> 3 green -> 4 cyan -> 5 blue)
vec3 mipDebugColor(float lod) {
  int l = int(clamp(floor(lod), 0.0, 5.0));
  if (l == 0) return vec3(0.95, 0.22, 0.24);
  if (l == 1) return vec3(0.98, 0.58, 0.16);
  if (l == 2) return vec3(0.96, 0.88, 0.22);
  if (l == 3) return vec3(0.24, 0.86, 0.42);
  if (l == 4) return vec3(0.16, 0.78, 0.94);
  return vec3(0.28, 0.44, 0.96);
}

// Evaluate virtual page table coordinates from world position (covers entire 46m corridor in 64x64 unique virtual tiles!)
vec2 worldToVirtualUv(vec3 wp, int m) {
  float u = clamp((wp.x + 3.4) / 6.8 + (m == 1 ? (wp.y * 0.08) : 0.0), 0.01, 0.99);
  float v = clamp((6.8 - wp.z) / 47.0, 0.01, 0.99);
  return vec2(u, v);
}

vec3 acesFilm(vec3 x) {
  return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0);
}

void main() {
  vec2 screenUv = gl_FragCoord.xy / uRes;
  bool isLeft = uSplitX > 0.0 && screenUv.x < uSplitX;
  int stage = isLeft ? uStageLeft : uStageRight;
  bool debugOn = uDebugOn > 0.5 && !isLeft;
  int m = int(floor(vMat + 0.5));

  vec3 texCol = vec3(0.5);
  vec2 baseUv = vUv;
  float isoLod = computeIsoLod(baseUv);

  if (stage == 0) {
    // 1994 PS1 Affine Texture Mapping (EXACT noperspective via vAffUv / vClipW!) + blocky 160-texel nearest!
    vec2 affUv = vAffUv / max(vClipW, 0.001);
    texCol = sampleNearest0(m, affUv, 160.0);
  } else if (stage == 1) {
    // 1996 Quake 16-Pixel Span Perspective (Michael Abrash):
    // Perspective divide only at 16-screen-pixel span endpoints, linear in between + nearest-neighbor texels!
    float spanPx = 16.0;
    float fracX = fract(gl_FragCoord.x / spanPx);
    float dL = -fracX * spanPx;
    float dR = (1.0 - fracX) * spanPx;
    // Exact derivatives of perspective-divided UV vs linear screen-space span
    vec2 duDx = dFdx(baseUv);
    float dwDx = dFdx(vClipW);
    float wL = max(vClipW + dwDx * dL, 0.05);
    float wR = max(vClipW + dwDx * dR, 0.05);
    // Perspective-exact UVs at left & right 16-pixel span boundaries -> linearly interpolated across the span!
    vec2 uvL = baseUv + duDx * dL * (vClipW / wL);
    vec2 uvR = baseUv + duDx * dR * (vClipW / wR);
    vec2 spanUv = mix(uvL, uvR, fracX);
    texCol = sampleNearest0(m, spanUv, 224.0);
  } else if (stage == 2) {
    // 1996 3dfx Voodoo Bilinear Filtering (NO mipmaps -> blurry up close, intense distant shimmering on horizon!)
    texCol = sampleBilinear0(m, baseUv, 192.0);
  } else if (stage == 3) {
    // 1996 Mipmapping & Trilinear (Williams 1983 noted; Voodoo/N64 1996)
    bool forceBilinearMip = isLeft && uBilinearLeft > 0.5;
    float lod = forceBilinearMip ? floor(isoLod) : isoLod;
    texCol = sampleBaseLod(m, baseUv, lod);
    if (debugOn) {
      vec3 mc = forceBilinearMip
        ? mipDebugColor(floor(isoLod))
        : mix(mipDebugColor(floor(isoLod)), mipDebugColor(floor(isoLod) + 1.0), fract(isoLod));
      texCol = mix(texCol, mc, 0.62);
    }
  } else if (stage == 4) {
    // 1998 S3TC / DXT1 4x4 Block Compression (real RGB565 endpoints + 2-bit palette!)
    float blkEdge = 0.0;
    texCol = sampleS3TC(m, baseUv, isoLod, blkEdge);
    if (debugOn) {
      texCol = mix(texCol, vec3(1.0, 0.80, 0.25), blkEdge * 0.65);
    }
  } else if (stage == 5) {
    // 2001 16x Anisotropic Filtering (GeForce 3) vs optional Radeon 8500 angle-dependent mode!
    texCol = sampleAnisotropic16(m, baseUv, debugOn);
  } else if (stage == 6) {
    // 2011 MegaTexture / Virtual Texturing (id Tech 5 / RAGE):
    // Reads live 64x64 virtual page-table texture -> shows unmistakable blocky tile pop-in after Snap Turn!
    vec2 vUvPage = worldToVirtualUv(vWorldPos, m);
    vec4 page = texture(uPageTable, vUvPage);
    float resMip = page.r * 7.0; // high value = coarse blurry page still streaming in; 0 = sharp resident page!
    vec3 afCol = sampleAnisotropic16(m, baseUv, false);
    vec3 coarseCol = sampleBaseLod(m, baseUv, clamp(resMip, 0.0, 6.5));
    float popMix = smoothstep(0.35, 1.5, resMip);
    texCol = mix(afCol, coarseCol, popMix) * megaUniqueTint(vWorldPos, m, resMip);
    // Subtle tile boundary flash only while a page is actively streaming in!
    if (resMip > 0.65) {
      vec2 tileF = fract(vUvPage * 64.0);
      float tEdge = smoothstep(0.44, 0.495, max(abs(tileF.x - 0.5), abs(tileF.y - 0.5)));
      texCol = mix(texCol, vec3(1.0, 0.42, 0.22), tEdge * 0.42 * clamp(resMip / 4.0, 0.0, 1.0));
    }
  } else {
    // 2020-26 Sampler Feedback Streaming (DX12 Ultimate, emulated in WebGL2):
    // Proactive tile residency with zero pop-in + live Feedback Map showing ONLY tiles touched by the shader!
    vec2 vUvPage = worldToVirtualUv(vWorldPos, m);
    vec4 page = texture(uPageTable, vUvPage);
    vec3 afCol = sampleAnisotropic16(m, baseUv, false);
    texCol = afCol * megaUniqueTint(vWorldPos, m, isoLod * 0.35);
    if (debugOn) {
      vec2 tileF = fract(vUvPage * 32.0);
      float tEdge = smoothstep(0.45, 0.495, max(abs(tileF.x - 0.5), abs(tileF.y - 0.5)));
      // Show requested min-mip tier per virtual tile cleanly
      vec3 tierCol = mix(vec3(0.18, 0.96, 0.68), vec3(0.98, 0.72, 0.24), clamp(isoLod / 4.0, 0.0, 1.0));
      float touched = page.g;
      texCol = mix(texCol, tierCol, 0.28 * touched + tEdge * 0.55);
    }
  }

  // Architectural gallery lighting (warm periodic overhead skylight bays + crisp directional key + distant horizon portal glow!)
  vec3 n = normalize(vNorm);
  float bayGlow = 0.55 + 0.45 * cos((vWorldPos.z + 1.4) * 1.09);
  vec3 keyDir = normalize(vec3(0.32, 0.85, 0.42));
  float ndl = max(dot(n, keyDir), 0.0);
  vec3 fill = vec3(0.24, 0.28, 0.36) * (0.55 + 0.45 * n.y);
  vec3 key = vec3(1.05, 0.96, 0.84) * (ndl * 0.82 * (0.65 + 0.55 * bayGlow));

  // Luminous golden-cyan horizon portal light at z = -39.5
  float distEnd = max(0.0, vWorldPos.z - (-39.5));
  float portalGlow = exp(-distEnd * 0.14) * 0.65;
  vec3 lit = texCol * (fill + key) + texCol * vec3(0.95, 0.78, 0.52) * portalGlow;

  // Gentle depth atmosphere so the long corridor has dramatic gallery depth while preserving horizon sharpness for 16x AF!
  float viewDist = length(vWorldPos - uCamPos);
  float fog = 1.0 - exp(-viewDist * viewDist * 0.00075);
  lit = mix(lit, vec3(0.14, 0.17, 0.24), clamp(fog, 0.0, 0.52));

  // Subtle ACES filmic grade (keep PS1/Quake rawer & punchier)
  vec3 outCol = acesFilm(lit * 1.15);
  outCol = pow(max(outCol, 0.0), vec3(1.0 / 2.2));

  // Crisp amber split-screen divider
  if (uSplitX > 0.0 && abs(screenUv.x - uSplitX) < 1.5 / uRes.x) {
    outCol = vec3(0.93, 0.65, 0.37);
  }
  oCol = vec4(outCol, 1.0);
}
`;

// Pass 2: Interactive 4x Pixel Magnifier Loupe (nearest-neighbor zoomed view of horizon, PS1 edges, or S3TC 4x4 blocks!)
export const LOUPE_FS = /* glsl */`#version 300 es
precision highp float;

in vec2 vUv;
out vec4 oCol;

uniform sampler2D uSrc;
uniform vec2 uRes;
uniform vec2 uLoupeTarget; // normalized [0..1] reticle center
uniform float uLoupeOn;
uniform float uSplitX;

void main() {
  vec2 uv = vUv;
  vec3 col = texture(uSrc, uv).rgb;
  if (uLoupeOn < 0.5) { oCol = vec4(col, 1.0); return; }

  float aspect = uRes.x / max(1.0, uRes.y);
  vec2 px = uv * uRes;
  vec2 tgtPx = uLoupeTarget * uRes;

  // 4x Zoom Box anchored cleanly in upper-right safe area (desktop 16:9) or right-mid (9:16)
  float boxSizePx = min(uRes.x, uRes.y) * 0.32;
  vec2 boxCen = aspect > 1.0
    ? vec2(uRes.x - boxSizePx * 0.62 - 26.0, uRes.y - boxSizePx * 0.62 - 76.0)
    : vec2(uRes.x - boxSizePx * 0.58 - 22.0, uRes.y * 0.62);
  vec2 boxHalf = vec2(boxSizePx * 0.5);

  // Target reticle square (exact 1/4 region sampled by the loupe!)
  vec2 retHalf = boxHalf * 0.25;
  vec2 dRet = abs(px - tgtPx) - retHalf;
  float retEdge = max(dRet.x, dRet.y);
  if (abs(retEdge) < 2.2 && dRet.x < 3.0 && dRet.y < 3.0) {
    col = vec3(1.0, 0.84, 0.24);
  }

  // Thin crisp yellow connector line from reticle center toward loupe box
  vec2 seg = boxCen - tgtPx;
  float segLen = length(seg);
  if (segLen > 1.0) {
    vec2 dir = seg / segLen;
    float proj = clamp(dot(px - tgtPx, dir), length(retHalf) * 0.9, segLen - boxSizePx * 0.55);
    float distLine = length((px - tgtPx) - dir * proj);
    if (distLine < 1.35) {
      col = mix(col, vec3(1.0, 0.84, 0.24), 0.72);
    }
  }

  // Inside 4x Magnifier Loupe window!
  vec2 dBox = abs(px - boxCen) - boxHalf;
  float boxEdge = max(dBox.x, dBox.y);
  if (boxEdge < 0.0) {
    vec2 local = (px - boxCen) / boxHalf; // [-1, 1]
    vec2 samplePx = tgtPx + local * retHalf;
    vec2 sampleUv = clamp((floor(samplePx) + 0.5) / uRes, vec2(0.001), vec2(0.999));
    col = texture(uSrc, sampleUv).rgb;
    // Crisp subtle crosshair center tick
    if (min(abs(px.x - boxCen.x), abs(px.y - boxCen.y)) < 0.9 && length(px - boxCen) < 12.0) {
      col = mix(col, vec3(1.0, 0.86, 0.30), 0.65);
    }
  } else if (boxEdge < 3.5) {
    col = vec3(1.0, 0.84, 0.24);
  } else if (boxEdge < 5.5) {
    col = vec3(0.08, 0.09, 0.14);
  }

  oCol = vec4(col, 1.0);
}
`;
