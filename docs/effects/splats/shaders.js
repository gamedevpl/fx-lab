// GLSL ES 3.00 shaders for the 5-stage Pixel-Art Gaussian Splats pipeline.

// Shared EWA 3D Gaussian surfel vertex shader: projects each oriented 3D ellipsoid
// into a 2x2 screen-space covariance ellipse and orients its billboard along eigenvectors.
export const SPLAT_VS = `#version 300 es
precision highp float;

layout(location = 0) in vec2 aQuad;
layout(location = 1) in vec3 aCenter;
layout(location = 2) in vec3 aNormal;
layout(location = 3) in vec3 aTangent;
layout(location = 4) in vec3 aScale;
layout(location = 5) in vec3 aColor;
layout(location = 6) in vec4 aMeta; // (opacity, emissive, ao, objectId)

uniform mat4 uView;
uniform mat4 uProj;
uniform vec2 uViewport;
uniform float uFocal;
uniform float uSplatScale;
uniform float uQuadExtent;
uniform float uLowpass;
uniform float uSnapGrid;

out vec2 vLocal;
out vec3 vNormal;
out vec3 vWorldPos;
out vec3 vColor;
out vec4 vMeta;
out float vViewDepth;

void main() {
  vec4 viewPos4 = uView * vec4(aCenter, 1.0);
  vec3 p = viewPos4.xyz;
  float zc = -p.z;
  if (zc < 0.2) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    return;
  }

  // Transform surfel ellipsoid axes into camera space.
  vec3 nW = normalize(aNormal);
  vec3 t1W = normalize(aTangent);
  vec3 t2W = cross(nW, t1W);

  mat3 R = mat3(uView);
  vec3 s = aScale * uSplatScale;
  vec3 c0 = R * (t1W * s.x);
  vec3 c1 = R * (t2W * s.y);
  vec3 c2 = R * (nW * s.z);

  // Perspective Jacobian J (2x3) and screen covariance Sigma_2D = (J * M) * (J * M)^T.
  float invZ = 1.0 / zc;
  float invZ2 = invZ * invZ;
  vec3 jRow0 = vec3(uFocal * invZ, 0.0, uFocal * p.x * invZ2);
  vec3 jRow1 = vec3(0.0, uFocal * invZ, uFocal * p.y * invZ2);

  vec3 tRow0 = vec3(dot(jRow0, c0), dot(jRow0, c1), dot(jRow0, c2));
  vec3 tRow1 = vec3(dot(jRow1, c0), dot(jRow1, c1), dot(jRow1, c2));

  float a = dot(tRow0, tRow0) + uLowpass;
  float b = dot(tRow0, tRow1);
  float c = dot(tRow1, tRow1) + uLowpass;

  // Eigenvalues and major/minor axes of the 2x2 screen-space covariance.
  float mid = 0.5 * (a + c);
  float detDiff = 0.5 * (a - c);
  float disc = sqrt(max(0.0, detDiff * detDiff + b * b));
  float lam1 = max(0.05, mid + disc);
  float lam2 = max(0.05, mid - disc);

  vec2 e1;
  if (abs(b) > 1e-5 || abs(a - c) > 1e-5) {
    vec2 vA = vec2(b, lam1 - a);
    vec2 vB = vec2(lam1 - c, b);
    e1 = normalize(dot(vA, vA) >= dot(vB, vB) ? vA : vB);
  } else {
    e1 = vec2(1.0, 0.0);
  }
  vec2 e2 = vec2(-e1.y, e1.x);

  float rad1 = min(sqrt(lam1) * uQuadExtent, uViewport.y * 0.35);
  float rad2 = min(sqrt(lam2) * uQuadExtent, uViewport.y * 0.35);

  vec4 clipCenter = uProj * viewPos4;
  vec2 ndcCenter = clipCenter.xy / clipCenter.w;

  // Optional snap onto the virtual art-pixel grid to stop sub-pixel swimming.
  if (uSnapGrid > 0.5) {
    vec2 grid = uViewport * 0.5;
    vec2 pxCoord = (ndcCenter * 0.5 + 0.5) * grid;
    pxCoord = (floor(pxCoord) + 0.5) / grid;
    ndcCenter = pxCoord * 2.0 - 1.0;
  }

  vec2 offsetPx = aQuad.x * e1 * rad1 + aQuad.y * e2 * rad2;
  vec2 ndcOffset = (offsetPx * 2.0) / uViewport;

  gl_Position = vec4((ndcCenter + ndcOffset) * clipCenter.w, clipCenter.z, clipCenter.w);
  vLocal = aQuad * uQuadExtent;
  vNormal = nW;
  vWorldPos = aCenter;
  vColor = aColor;
  vMeta = aMeta;
  vViewDepth = zc;
}
`;

// Shared smooth vs 3-band quantized cel lighting helper.
const LIGHTING_GLSL = `
uniform vec3 uSunDir;
uniform vec3 uLanternPos;
uniform float uLanternPulse;

vec3 evalLighting(vec3 albedo, vec3 n, vec3 worldPos, float ao, float emissive, bool stepped) {
  float ndl = dot(n, uSunDir);
  vec3 lVec = uLanternPos - worldPos;
  float lDist = length(lVec);
  float lAtten = 1.0 / (1.0 + 1.45 * lDist * lDist);
  float lNdl = max(0.0, dot(n, lVec / max(lDist, 0.001)));
  float lanternTerm = lAtten * (0.45 + 0.55 * lNdl) * uLanternPulse;

  if (!stepped) {
    float diff = max(0.0, ndl);
    vec3 skyCol = mix(vec3(0.28, 0.33, 0.52), vec3(0.55, 0.64, 0.86), n.y * 0.5 + 0.5);
    vec3 lit = albedo * (skyCol * 0.58 * ao + vec3(1.12, 1.02, 0.88) * diff * 0.88 * ao);
    lit += albedo * vec3(1.35, 0.82, 0.30) * lanternTerm * 1.15;
    return mix(lit, albedo * 1.12, emissive);
  }

  // 3-band hue-shifted pixel-art shading (cool indigo shadow -> crisp midtone -> warm highlight).
  float s = ndl * ao;
  vec3 lightTint = s > 0.42
    ? vec3(1.24, 1.18, 1.02)
    : (s > 0.02 ? vec3(0.95, 0.95, 0.98) : vec3(0.52, 0.56, 0.78));
  float lb = lanternTerm > 0.24 ? 0.85 : (lanternTerm > 0.09 ? 0.38 : 0.0);
  vec3 lit = albedo * lightTint + albedo * vec3(1.35, 0.82, 0.28) * lb;
  return mix(lit, albedo * 1.15, emissive);
}
`;

// Pass 1: Smooth full-resolution 3D Gaussian splats (premultiplied alpha).
export const RAW_FS = `#version 300 es
precision highp float;

in vec2 vLocal;
in vec3 vNormal;
in vec3 vWorldPos;
in vec3 vColor;
in vec4 vMeta;
in float vViewDepth;

uniform float uSurfelReveal;
${LIGHTING_GLSL}

out vec4 fragColor;

void main() {
  float r2 = dot(vLocal, vLocal);
  if (r2 > 6.76) discard;

  float g = exp(-0.5 * r2);
  float discRim = smoothstep(1.35, 1.85, r2) * smoothstep(2.55, 1.85, r2);
  float shape = mix(g, smoothstep(2.6, 0.9, r2), uSurfelReveal * 0.68);
  float alpha = vMeta.x * shape;
  if (alpha < 0.015) discard;

  vec3 lit = evalLighting(vColor, normalize(vNormal), vWorldPos, vMeta.z, vMeta.y, false);
  lit += vec3(0.45, 0.75, 0.95) * discRim * uSurfelReveal * 0.45;
  fragColor = vec4(lit * alpha, alpha);
}
`;

// Pass 2A: Hard-disc opaque surfels rendered into 3 MRTs at 2x supersampling.
export const HARD_MRT_FS = `#version 300 es
precision highp float;

in vec2 vLocal;
in vec3 vNormal;
in vec3 vWorldPos;
in vec3 vColor;
in vec4 vMeta;
in float vViewDepth;
${LIGHTING_GLSL}

layout(location = 0) out vec4 outSmooth;  // rgb = smooth lit, a = objectId / 255
layout(location = 1) out vec4 outStepped; // rgb = 3-band lit, a = emissive
layout(location = 2) out vec4 outDepth;   // rg = 16-bit view depth, b = objectId / 255

void main() {
  float r2 = dot(vLocal, vLocal);
  if (r2 > 2.25) discard;

  vec3 n = normalize(vNormal);
  vec3 smoothCol = evalLighting(vColor, n, vWorldPos, vMeta.z, vMeta.y, false);
  vec3 stepCol = evalLighting(vColor, n, vWorldPos, vMeta.z, vMeta.y, true);
  float objNorm = vMeta.w / 255.0;
  float dNorm = clamp((vViewDepth - 2.0) / 18.0, 0.0, 0.9999);

  outSmooth = vec4(clamp(smoothCol, 0.0, 1.0), objNorm);
  outStepped = vec4(clamp(stepCol, 0.0, 1.0), vMeta.y);
  outDepth = vec4(floor(dNorm * 255.0) / 255.0, fract(dNorm * 255.0), objNorm, 1.0);
}
`;

// Pass 2B: Translucent lantern halo, chimney smoke, waterfall mist and fireflies.
export const TRANS_FS = `#version 300 es
precision highp float;

in vec2 vLocal;
in vec3 vColor;
in vec4 vMeta;

out vec4 fragColor;

void main() {
  float r2 = dot(vLocal, vLocal);
  if (r2 > 4.84) discard;
  float alpha = vMeta.x * exp(-0.55 * r2);
  if (alpha < 0.02) discard;
  fragColor = vec4(vColor * alpha, alpha);
}
`;

// Pass 3: Fullscreen composite — 2x2 coverage, palette voting, Bayer 4x4 dithering,
// 1 px depth silhouette outline, and split-screen comparison.
export const POST_FS = `#version 300 es
precision highp float;

in vec2 vUv;

uniform sampler2D uTexRaw;
uniform sampler2D uTexSmooth;
uniform sampler2D uTexStepped;
uniform sampler2D uTexDepth;
uniform sampler2D uTexTrans;
uniform vec3 uPalette[24];
uniform vec2 uArtSize;
uniform ivec2 uSsMax;
uniform float uAspect;
uniform int uStageLeft;
uniform int uStageRight;
uniform float uWipeX;
uniform float uTime;

out vec4 fragColor;

float bayer4(ivec2 p) {
  int idx = (p.y & 3) * 4 + (p.x & 3);
  const float m[16] = float[16](
     0.0,  8.0,  2.0, 10.0,
    12.0,  4.0, 14.0,  6.0,
     3.0, 11.0,  1.0,  9.0,
    15.0,  7.0, 13.0,  5.0
  );
  return (m[idx] + 0.5) / 16.0;
}

int nearestPalette(vec3 c) {
  int best = 0;
  float bestD = 1e9;
  for (int i = 0; i < 24; i++) {
    vec3 d = c - uPalette[i];
    float dist = d.r * d.r * 2.2 + d.g * d.g * 4.0 + d.b * d.b * 3.0;
    if (dist < bestD) {
      bestD = dist;
      best = i;
    }
  }
  return best;
}

vec3 evalSky(vec2 uv, bool quantized, bool dithered, ivec2 artPx, bool smoothStars) {
  vec3 cTop = vec3(0.16, 0.21, 0.37);
  vec3 cMid = vec3(0.27, 0.37, 0.56);
  vec3 cHor = vec3(0.46, 0.57, 0.74);
  vec3 cLow = vec3(0.22, 0.29, 0.46);

  vec3 col;
  if (uv.y > 0.32) {
    float t = clamp((uv.y - 0.32) / 0.68, 0.0, 1.0);
    col = mix(cHor, mix(cMid, cTop, smoothstep(0.32, 1.0, t)), smoothstep(0.0, 0.78, t));
  } else {
    col = mix(cLow, cHor, smoothstep(0.0, 1.0, clamp(uv.y / 0.32, 0.0, 1.0)));
  }

  if (smoothStars) {
    vec2 g = uv * vec2(26.0 * uAspect, 26.0);
    vec2 cid = floor(g), f = fract(g) - 0.5;
    float sh = fract(sin(dot(cid, vec2(127.1, 311.7))) * 43758.5453);
    if (sh > 0.965 && uv.y > 0.46) {
      float tw = 0.55 + 0.45 * sin(uTime * 1.45 + sh * 90.0);
      col = mix(col, vec3(0.98, 0.94, 0.78), exp(-dot(f, f) * 28.0) * tw * 0.9);
    }
  } else {
    vec2 cell = floor(vec2(artPx) / 2.0);
    float sh = fract(sin(dot(cell, vec2(127.1, 311.7))) * 43758.5453);
    if (sh > 0.990 && uv.y > 0.46 && (artPx.x & 1) == 0 && (artPx.y & 1) == 0) {
      float tw = 0.55 + 0.45 * sin(uTime * 1.45 + sh * 90.0);
      col = mix(col, vec3(0.98, 0.94, 0.78), tw * 0.9);
    }
  }

  if (dithered) {
    col = clamp(col + (bayer4(artPx) - 0.5) * 0.052, 0.0, 1.0);
  }
  return quantized ? uPalette[nearestPalette(col)] : col;
}

float unpackDepth(vec4 d) {
  return d.r + d.g / 255.0;
}

void sampleArtCell(ivec2 artPx, out int hits, out float minDepth, out int fgObj) {
  hits = 0;
  minDepth = 1.0;
  fgObj = 0;
  ivec2 base = artPx * 2;
  for (int oy = 0; oy < 2; oy++) {
    for (int ox = 0; ox < 2; ox++) {
      vec4 dp = texelFetch(uTexDepth, clamp(base + ivec2(ox, oy), ivec2(0), uSsMax), 0);
      int oid = int(round(dp.b * 255.0));
      if (oid > 0) {
        hits++;
        float z = unpackDepth(dp);
        if (z < minDepth) {
          minDepth = z;
          fgObj = oid;
        }
      }
    }
  }
}

vec3 evalStage(int stage, vec2 uv) {
  ivec2 maxArt = ivec2(uArtSize) - ivec2(1);
  ivec2 artPx = clamp(ivec2(floor(uv * uArtSize)), ivec2(0), maxArt);
  vec2 artUv = (vec2(artPx) + 0.5) / uArtSize;

  // Stage 0: Full-resolution smooth 3D Gaussian splats.
  if (stage == 0) {
    vec3 sky = evalSky(uv, false, false, artPx, true);
    vec4 raw = texture(uTexRaw, uv);
    return raw.rgb + sky * (1.0 - raw.a);
  }

  // Stages 1..4: Gather the 2x2 supersampled hard-disc block for this art pixel.
  ivec2 base = artPx * 2;
  vec3 cols[4];
  float depths[4];
  int oids[4];
  float ems[4];
  int hits = 0, minIdx = 0, fgObj = 0;
  float minDepth = 1.0;

  for (int k = 0; k < 4; k++) {
    ivec2 sp = clamp(base + ivec2(k & 1, k >> 1), ivec2(0), uSsMax);
    vec4 sm = texelFetch(uTexSmooth, sp, 0);
    vec4 st = texelFetch(uTexStepped, sp, 0);
    vec4 dp = texelFetch(uTexDepth, sp, 0);
    int oid = int(round(dp.b * 255.0));
    oids[k] = oid;
    depths[k] = unpackDepth(dp);
    ems[k] = st.a;
    cols[k] = (stage == 1) ? sm.rgb : st.rgb;
    if (oid > 0) {
      hits++;
      if (depths[k] < minDepth) {
        minDepth = depths[k];
        minIdx = k;
        fgObj = oid;
      }
    }
  }

  vec4 trAvg = vec4(0.0);
  for (int k = 0; k < 4; k++) {
    trAvg += texelFetch(uTexTrans, clamp(base + ivec2(k & 1, k >> 1), ivec2(0), uSsMax), 0);
  }
  trAvg *= 0.25;

  bool isQuantized = (stage >= 3);
  bool isDithered = (stage >= 4);
  vec3 skyCol = evalSky(artUv, isQuantized, isDithered, artPx, false);

  // Background pixel (< 2 covered sub-pixels): check outer silhouette outline & mist/halo.
  if (hits < 2) {
    if (stage == 4) {
      int nh, no;
      float nd;
      bool touchesFg = false;
      sampleArtCell(artPx + ivec2( 1,  0), nh, nd, no); if (nh >= 2) touchesFg = true;
      sampleArtCell(artPx + ivec2(-1,  0), nh, nd, no); if (nh >= 2) touchesFg = true;
      sampleArtCell(artPx + ivec2( 0,  1), nh, nd, no); if (nh >= 2) touchesFg = true;
      sampleArtCell(artPx + ivec2( 0, -1), nh, nd, no); if (nh >= 2) touchesFg = true;
      if (touchesFg) return uPalette[0];
    }
    if (trAvg.a > 0.03) {
      vec3 trRgb = trAvg.rgb / max(trAvg.a, 0.001);
      if (isDithered) {
        if (trAvg.a * 1.45 > bayer4(artPx)) {
          return uPalette[nearestPalette(mix(skyCol, trRgb, clamp(trAvg.a * 1.5, 0.35, 0.92)))];
        }
        return skyCol;
      }
      if (isQuantized) {
        return uPalette[nearestPalette(trAvg.rgb + skyCol * (1.0 - trAvg.a))];
      }
      return trAvg.rgb + skyCol * (1.0 - trAvg.a);
    }
    return skyCol;
  }

  // Stages 1 & 2: Full-RGB average of covered sub-pixels.
  if (stage <= 2) {
    vec3 sum = vec3(0.0);
    for (int k = 0; k < 4; k++) if (oids[k] > 0) sum += cols[k];
    vec3 finalCol = sum / float(hits);
    if (trAvg.a > 0.02) finalCol = trAvg.rgb + finalCol * (1.0 - trAvg.a);
    return finalCol;
  }

  // Stages 3 & 4: Majority vote among the 2x2 palette picks (nearest depth breaks ties).
  float ditherAmt = isDithered ? (bayer4(artPx) - 0.5) * 0.105 : 0.0;
  int pIdx[4];
  for (int k = 0; k < 4; k++) {
    if (oids[k] > 0) {
      float dm = ems[k] > 0.5 ? 0.0 : ditherAmt;
      pIdx[k] = nearestPalette(clamp(cols[k] + vec3(dm), 0.0, 1.0));
    } else {
      pIdx[k] = -1;
    }
  }

  int winPalette = pIdx[minIdx];
  int bestVotes = 0;
  float bestWinDepth = 1e9;
  for (int k = 0; k < 4; k++) {
    if (pIdx[k] < 0) continue;
    int votes = 0;
    float dMin = 1e9;
    for (int j = 0; j < 4; j++) {
      if (pIdx[j] == pIdx[k]) {
        votes++;
        dMin = min(dMin, depths[j]);
      }
    }
    if (votes > bestVotes || (votes == bestVotes && dMin < bestWinDepth)) {
      bestVotes = votes;
      bestWinDepth = dMin;
      winPalette = pIdx[k];
    }
  }
  vec3 finalCol = uPalette[winPalette];

  // Stage 4: Internal 1 px depth-jump crease between distinct overlapping 3D objects.
  if (stage == 4) {
    int nh, no;
    float nd;
    bool innerCrease = false;
    sampleArtCell(artPx + ivec2( 1,  0), nh, nd, no); if (nh >= 2 && (minDepth - nd) > 0.038 && no != fgObj) innerCrease = true;
    sampleArtCell(artPx + ivec2(-1,  0), nh, nd, no); if (nh >= 2 && (minDepth - nd) > 0.038 && no != fgObj) innerCrease = true;
    sampleArtCell(artPx + ivec2( 0,  1), nh, nd, no); if (nh >= 2 && (minDepth - nd) > 0.038 && no != fgObj) innerCrease = true;
    sampleArtCell(artPx + ivec2( 0, -1), nh, nd, no); if (nh >= 2 && (minDepth - nd) > 0.038 && no != fgObj) innerCrease = true;
    if (innerCrease && ems[minIdx] < 0.5) {
      finalCol = uPalette[nearestPalette(finalCol * 0.42)];
    }
  }

  if (trAvg.a > 0.03) {
    vec3 trRgb = trAvg.rgb / max(trAvg.a, 0.001);
    if (isDithered) {
      if (trAvg.a * 1.4 > bayer4(artPx)) {
        finalCol = uPalette[nearestPalette(mix(finalCol, trRgb, clamp(trAvg.a * 1.4, 0.35, 0.88)))];
      }
    } else {
      finalCol = uPalette[nearestPalette(trAvg.rgb + finalCol * (1.0 - trAvg.a))];
    }
  }
  return finalCol;
}

void main() {
  vec3 col;
  if (uWipeX <= 0.001) {
    col = evalStage(uStageRight, vUv);
  } else if (uWipeX >= 0.999) {
    col = evalStage(uStageLeft, vUv);
  } else {
    col = (vUv.x < uWipeX) ? evalStage(uStageLeft, vUv) : evalStage(uStageRight, vUv);
  }
  fragColor = vec4(col, 1.0);
}
`;
