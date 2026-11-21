// Evolution of Skin & Subsurface Scattering (1975-2021) — WebGL2 RGBA16F Multi-Pass Shaders.
// Pass 1 (SKIN_BASE_FS): Raymarches an anatomically sculpted classical 3/4 bust (thin sculpted ear,
//   nose bridge, cheekbones, lips, brow, jawline, neck) + orbiting backlight orb, outputting:
//   - MRT0 (oDiff): Diffuse + subsurface radiance (to be convolved in screen space for SSSS stages!)
//   - MRT1 (oSpec): Dual-lobe GGX specular + micro-pore + peach-fuzz + background (kept razor-sharp!)
//   - MRT2 (oMeta): vec4(linearDepth, skinMask, thickness, curvature)
// Pass 2 & 3 (SSSS_BLUR_FS): Genuine Jimenez (2015) 2-Pass Separable Screen-Space Subsurface Scattering
//   (Horizontal -> Vertical) with Burley (2015) normalized RGB diffusion weights & depth-aware edge stopping!
// Pass 4 (SKIN_COMPOSITE_FS): Combines scattered diffuse + crisp dual-lobe specular + AgX-like filmic tone map + Split!

export const SKIN_BASE_FS = /* glsl */`#version 300 es
precision highp float;

in vec2 vUv;
layout(location = 0) out vec4 oDiff;
layout(location = 1) out vec4 oSpec;
layout(location = 2) out vec4 oMeta;

uniform vec3 uCamPos, uCamRight, uCamUp, uCamFwd;
uniform float uTanHalfFov, uAspect, uTime;
uniform vec3 uLightPos;
uniform int uStageLeft, uStageRight;
uniform float uSplitX;
uniform float uScatterScale; // 1.0 = human skin, 1.85 = deep subsurface scatter

const float PI = 3.14159265359;

// Smooth min / max for organic classical sculpture blending
float smin(float a, float b, float k) {
  float h = clamp(0.5 + 0.5 * (b - a) / k, 0.0, 1.0);
  return mix(b, a, h) - k * h * (1.0 - h);
}
float smax(float a, float b, float k) {
  return -smin(-a, -b, k);
}
float sdEllipsoid(vec3 p, vec3 r) {
  float k0 = length(p / r);
  float k1 = length(p / (r * r));
  return k0 * (k0 - 1.0) / max(k1, 1e-5);
}
float sdCapsule(vec3 p, vec3 a, vec3 b, float r) {
  vec3 pa = p - a, ba = b - a;
  float h = clamp(dot(pa, ba) / max(dot(ba, ba), 1e-5), 0.0, 1.0);
  return length(pa - ba * h) - r;
}
float sdTorus(vec3 p, vec2 t) {
  vec2 q = vec2(length(p.xy) - t.x, p.z);
  return length(q) - t.y;
}

// Fast 3D value noise for dermal micro-pores & fine skin grain
float hash31(vec3 p) {
  p = fract(p * 0.1031);
  p += dot(p, p.yzx + 33.33);
  return fract((p.x + p.y) * p.z);
}
float noise3(vec3 p) {
  vec3 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(mix(hash31(i+vec3(0,0,0)), hash31(i+vec3(1,0,0)), f.x),
        mix(hash31(i+vec3(0,1,0)), hash31(i+vec3(1,1,0)), f.x), f.y),
    mix(mix(hash31(i+vec3(0,0,1)), hash31(i+vec3(1,0,1)), f.x),
        mix(hash31(i+vec3(0,1,1)), hash31(i+vec3(1,1,1)), f.x), f.y),
    f.z
  );
}

// Classical Sculpted Human Bust SDF (facing +Z, symmetric in X, prominent thin anatomical ears at ±X!)
// Returns vec2(dist, matId): 1.0 = living skin bust, 2.0 = dark obsidian museum plinth
vec2 mapScene(vec3 p) {
  vec3 q = p - vec3(0.0, 0.12, 0.0);
  vec3 s = vec3(abs(q.x), q.y, q.z); // bilateral symmetry for clean classical facial proportions!

  // 1) Cranium & Jawline (harmonious classical Roman/Greek bust proportions)
  float cranium = sdEllipsoid(q - vec3(0.0, 0.14, -0.04), vec3(0.45, 0.49, 0.50));
  float jaw     = sdEllipsoid(q - vec3(0.0, -0.18, 0.05), vec3(0.35, 0.34, 0.37));
  float chin    = sdEllipsoid(q - vec3(0.0, -0.43, 0.23), vec3(0.165, 0.135, 0.175));
  float head    = smin(cranium, jaw, 0.16);
  head = smin(head, chin, 0.11);

  // Subtle classical brow ridge & smooth zygomatic cheekbones
  float brow    = sdCapsule(s, vec3(0.03, 0.16, 0.41), vec3(0.28, 0.14, 0.29), 0.072);
  float cheek   = sdEllipsoid(s - vec3(0.23, -0.06, 0.28), vec3(0.175, 0.16, 0.15));
  head = smin(head, brow, 0.08);
  head = smin(head, cheek, 0.10);

  // Smooth classical eye sockets + serene sculpted eyelids
  float socket  = sdEllipsoid(s - vec3(0.17, 0.065, 0.39), vec3(0.115, 0.072, 0.088));
  head = smax(head, -socket, 0.060);
  float eyelid  = sdEllipsoid(s - vec3(0.17, 0.062, 0.365), vec3(0.092, 0.060, 0.072));
  head = smin(head, eyelid, 0.032);

  // Refined classical straight nose bridge + thin translucent nasal tip & wings
  float bridge  = sdCapsule(q, vec3(0.0, 0.135, 0.41), vec3(0.0, -0.085, 0.515), 0.054);
  float noseTip = sdEllipsoid(q - vec3(0.0, -0.095, 0.515), vec3(0.066, 0.054, 0.064));
  float nostril = sdEllipsoid(s - vec3(0.066, -0.112, 0.458), vec3(0.048, 0.038, 0.050));
  float nose = smin(bridge, noseTip, 0.036);
  nose = smin(nose, nostril, 0.030);
  head = smin(head, nose, 0.052);

  // Classical sculpted lips (smooth closed mouth line — zero artifact dot!)
  float uLip = sdCapsule(s, vec3(0.0, -0.232, 0.422), vec3(0.102, -0.246, 0.372), 0.036);
  float lLip = sdCapsule(s, vec3(0.0, -0.278, 0.418), vec3(0.090, -0.272, 0.372), 0.040);
  head = smin(head, uLip, 0.026);
  head = smin(head, lLip, 0.028);

  // 2) HERO THIN SCULPTED EARS (clean outer helix + thin cartilage shell + lobe -> BLAZING RUBY GLOW WHEN BACKLIT!)
  vec3 ep = s - vec3(0.455, -0.02, -0.05);
  // Outward ear angle (~32 deg) so the thin ear cartilage catches the backlight dramatically!
  float ca = 0.85, sa = 0.53;
  ep.xz = vec2(ca * ep.x - sa * ep.z, sa * ep.x + ca * ep.z);
  float earPlate = sdEllipsoid(ep - vec3(0.02, 0.0, -0.02), vec3(0.030, 0.195, 0.130));
  float earHelix = sdTorus(vec3(ep.y, ep.z + 0.005, ep.x - 0.024), vec2(0.150, 0.026));
  float earBowl  = sdEllipsoid(ep - vec3(0.042, -0.01, 0.01), vec3(0.034, 0.110, 0.075));
  float earLobe  = sdEllipsoid(ep - vec3(0.016, -0.175, 0.02), vec3(0.026, 0.062, 0.055));
  float ear = smin(earPlate, earHelix, 0.025);
  ear = smax(ear, -earBowl, 0.022);
  ear = smin(ear, earLobe, 0.030);
  head = smin(head, ear, 0.045);

  // 3) Classical Neck & Upper Shoulders
  float neck = sdCapsule(q, vec3(0.0, -0.32, -0.06), vec3(0.0, -0.82, -0.08), 0.205);
  float shoulders = sdEllipsoid(q - vec3(0.0, -0.92, -0.07), vec3(0.62, 0.25, 0.30));
  float bust = smin(head, neck, 0.11);
  bust = smin(bust, shoulders, 0.14);
  // Clean classical museum bust cut at bottom
  float cut = -(q.y + 1.00);
  bust = smax(bust, cut, 0.03);

  // 4) Dark slate museum pedestal under bust
  float ped = max(length(p.xz - vec2(0.0, -0.07)) - 0.36, abs(p.y + 1.14) - 0.26);
  float d = bust; float mat = 1.0;
  if (ped < d) { d = ped; mat = 2.0; }
  return vec2(d, mat);
}

vec3 calcNormal(vec3 p) {
  const vec2 e = vec2(0.0018, -0.0018);
  return normalize(
    e.xyy * mapScene(p + e.xyy).x +
    e.yyx * mapScene(p + e.yyx).x +
    e.yxy * mapScene(p + e.yxy).x +
    e.xxx * mapScene(p + e.xxx).x
  );
}

// Smooth artifact-free surface curvature from normal divergence (ZERO SDF seam rings on Stage 6 Penner LUT!)
float calcCurvature(vec3 p, vec3 n) {
  float eps = 0.022;
  vec3 t1 = normalize(abs(n.y) < 0.9 ? cross(n, vec3(0,1,0)) : cross(n, vec3(1,0,0)));
  vec3 t2 = cross(n, t1);
  vec3 dn1 = calcNormal(p + t1 * eps) - calcNormal(p - t1 * eps);
  vec3 dn2 = calcNormal(p + t2 * eps) - calcNormal(p - t2 * eps);
  float k = (length(dn1) + length(dn2)) * 0.5 / (2.0 * eps);
  return clamp(k * 0.16 + 0.24, 0.22, 1.15);
}

// Real volumetric optical thickness march THROUGH the bust along light vector (makes ears & nose wings glow!)
float marchThickness(vec3 p, vec3 lightDir) {
  float inside = 0.0;
  float stepLen = 0.042;
  for (int i = 1; i <= 14; i++) {
    float t = float(i) * stepLen;
    float d = mapScene(p + lightDir * t).x;
    if (d < 0.0) inside += stepLen;
    else if (i > 2) break;
  }
  return inside; // meters of flesh light traveled through! (ear ~0.04-0.09, skull ~0.55+)
}

// Soft shadow raymarch (gives crisp nose/brow/ear shadows where SSS crimson bleeding pops!)
float calcShadow(vec3 ro, vec3 rd, float maxT) {
  float res = 1.0;
  float t = 0.025;
  for (int i = 0; i < 28; i++) {
    float h = mapScene(ro + rd * t).x;
    res = min(res, 7.0 * h / t);
    t += clamp(h, 0.015, 0.14);
    if (res < 0.02 || t > maxT) break;
  }
  return clamp(res, 0.0, 1.0);
}

// Eric Penner (SIGGRAPH 2011) Pre-Integrated Skin LUT analytical fit (NdotL, curvature -> RGB scatter!)
vec3 preIntegratedSkin(float ndl, float curv) {
  // Red scatters furthest into the negative N·L shadow terminator; green medium; blue almost none!
  float s = clamp(curv * uScatterScale, 0.15, 2.2);
  float r = smoothstep(-0.34 * s, 0.42, ndl) * (0.20 + 0.80 * smoothstep(-0.18 * s, 0.85, ndl));
  float g = smoothstep(-0.16 * s, 0.48, ndl) * (0.12 + 0.88 * smoothstep(-0.06 * s, 0.90, ndl));
  float b = smoothstep(-0.07 * s, 0.52, ndl) * (0.06 + 0.94 * smoothstep( 0.00,     0.94, ndl));
  // Characteristic warm crimson hemoglobin scatter band right around N·L = 0!
  float band = exp(-pow((ndl + 0.04 * s) / (0.20 * s), 2.0)) * 0.24 * clamp(s, 0.4, 1.5);
  return vec3(r + band, g + band * 0.18, b + band * 0.04);
}

// GGX Microfacet Specular (used for single-lobe & Dual-Lobe Skin Specular!)
float ggxSpec(vec3 N, vec3 V, vec3 L, float rough, float f0) {
  vec3 H = normalize(L + V);
  float ndh = max(dot(N, H), 0.0);
  float ndv = max(dot(N, V), 0.001);
  float ndl = max(dot(N, L), 0.001);
  float vdh = max(dot(V, H), 0.0);
  float a = max(rough * rough, 0.004);
  float a2 = a * a;
  float denom = ndh * ndh * (a2 - 1.0) + 1.0;
  float D = a2 / (PI * denom * denom);
  float k = (rough + 1.0); k = (k * k) / 8.0;
  float G = (ndv / (ndv * (1.0 - k) + k)) * (ndl / (ndl * (1.0 - k) + k));
  float F = f0 + (1.0 - f0) * pow(1.0 - vdh, 5.0);
  return (D * G * F) / (4.0 * ndv * ndl);
}

void main() {
  int stage = (uSplitX > 0.0 && vUv.x < uSplitX) ? uStageLeft : uStageRight;

  vec2 ndc = vUv * 2.0 - 1.0;
  vec3 ro = uCamPos;
  vec3 rd = normalize(uCamFwd + uCamRight * (ndc.x * uAspect * uTanHalfFov) + uCamUp * (ndc.y * uTanHalfFov));

  // Rich warm-indigo gallery studio background + glowing visible light orb!
  vec3 bg = mix(vec3(0.032, 0.036, 0.052), vec3(0.075, 0.088, 0.125), clamp(1.0 - length(ndc * vec2(0.75, 0.95)), 0.0, 1.0));

  // Raymarch scene
  float t = 0.0;
  float hitMat = 0.0;
  for (int i = 0; i < 88; i++) {
    vec2 h = mapScene(ro + rd * t);
    if (h.x < 0.0012) { hitMat = h.y; break; }
    t += h.x;
    if (t > 12.0) break;
  }

  // Visible warm golden sun/flashlight orb floating in studio (only if closer than hit!)
  vec3 toOrb = uLightPos - ro;
  float tOrb = dot(toOrb, rd);
  float orbDist = length(ro + rd * max(tOrb, 0.0) - uLightPos);
  float orbHalo = exp(-orbDist * 6.5) * 0.55;
  if (tOrb > 0.0 && (hitMat < 0.5 || tOrb < t)) {
    if (orbDist < 0.085) {
      oDiff = vec4(0.0);
      oSpec = vec4(vec3(3.2, 2.35, 1.45), 1.0);
      oMeta = vec4(tOrb, 0.0, 0.0, 0.0);
      return;
    }
    bg += vec3(1.15, 0.72, 0.36) * orbHalo;
  }

  if (hitMat < 0.5) {
    oDiff = vec4(0.0);
    oSpec = vec4(bg, 1.0);
    oMeta = vec4(12.0, 0.0, 0.0, 0.0);
    return;
  }

  vec3 p = ro + rd * t;
  vec3 N = calcNormal(p);
  vec3 V = -rd;
  vec3 Lvec = uLightPos - p;
  float lDist = length(Lvec);
  vec3 L = Lvec / max(lDist, 1e-4);
  float sh = calcShadow(p + N * 0.01, L, lDist);

  if (hitMat > 1.5) {
    // Dark museum obsidian plinth
    float ndl = max(dot(N, L), 0.0) * sh;
    float spec = ggxSpec(N, V, L, 0.28, 0.04) * ndl;
    vec3 col = vec3(0.05, 0.055, 0.07) * (0.35 + ndl * 1.4) + vec3(0.95, 0.88, 0.80) * spec * 1.2;
    oDiff = vec4(0.0);
    oSpec = vec4(col, 1.0);
    oMeta = vec4(t, 0.0, 0.0, 0.0);
    return;
  }

  // --- HUMAN SKIN MATERIAL & MICRO-DETAIL ---
  vec3 q = p - vec3(0.0, 0.12, 0.0);
  // Subtle natural epidermal color variation (warmer blood-rich cheeks, nose, lips & ears; cooler brow/chin!)
  float earMask   = smoothstep(0.32, 0.44, abs(q.x)) * smoothstep(-0.22, 0.08, q.y) * smoothstep(0.22, -0.04, q.y);
  float lipMask   = exp(-pow((q.y + 0.262) / 0.052, 2.0)) * exp(-pow(q.x / 0.125, 2.0)) * smoothstep(0.32, 0.42, q.z);
  float cheekMask = exp(-length((vec3(abs(q.x), q.y, q.z) - vec3(0.22, -0.05, 0.30)) * vec3(4.5, 5.5, 4.5)));
  float noseMask  = exp(-length((q - vec3(0.0, -0.09, 0.48)) * vec3(8.0, 8.0, 7.0)));

  vec3 albedo = vec3(0.76, 0.54, 0.43);
  albedo = mix(albedo, vec3(0.78, 0.44, 0.36), (cheekMask * 0.35 + noseMask * 0.30 + earMask * 0.38));
  albedo = mix(albedo, vec3(0.66, 0.31, 0.28), lipMask * 0.65);

  // Dermal micro-pores + fine skin grain (active in stages 6 & 7: Digital Ira / Separable / MetaHuman!)
  vec3 Nspec = N;
  float pore = noise3(p * 62.0) * 0.65 + noise3(p * 135.0) * 0.35;
  if (stage >= 6) {
    float e = 0.0025;
    float px = noise3((p + vec3(e,0,0)) * 68.0) - pore;
    float py = noise3((p + vec3(0,e,0)) * 68.0) - pore;
    float pz = noise3((p + vec3(0,0,e)) * 68.0) - pore;
    float bumpAmp = stage == 7 ? 0.11 : 0.075;
    Nspec = normalize(N - vec3(px, py, pz) * bumpAmp);
    albedo *= 0.96 + 0.07 * pore;
  }

  float ndl = dot(N, L);
  float ndlPos = max(ndl, 0.0);
  float curv = calcCurvature(p, N);
  float thick = marchThickness(p - N * 0.012, L); // optical path through ear/nostril/skull!

  // Pro 2-light Rembrandt portrait studio rig:
  //   K (frontKeyDir) = raking Rembrandt 3/4 key from front-left -> crisp dramatic nose/cheek shadow terminator!
  //   L (uLightPos)   = orbiting blazing warm backlight behind the thin ear -> deep ruby crimson ear translucency!
  vec3 frontKeyDir = normalize(vec3(-0.74, 0.42, 0.56));
  float kNdl = dot(N, frontKeyDir);
  float kNdlPos = max(kNdl, 0.0);
  float kSh = calcShadow(p + N * 0.01, frontKeyDir, 2.5);
  float kSigned = kNdl > 0.0 ? mix(kNdl * 0.15, kNdl, kSh) : kNdl;
  float lSigned = ndl  > 0.0 ? mix(ndl  * 0.15, ndl,  sh)  : ndl;

  vec3 fillDir = normalize(vec3(0.65, 0.30, 0.68));
  vec3 fillCol = vec3(0.07, 0.10, 0.16) * (0.30 + 0.70 * max(dot(N, fillDir), 0.0));
  vec3 portraitKeyCol = vec3(1.25, 1.12, 1.00);
  vec3 orbKeyCol      = vec3(2.20, 1.75, 1.35);

  // True physical Beer-Lambert thin-structure crimson transmission through ears & nose wings!
  float effThick = thick / max(0.35, uScatterScale);
  vec3 sigmaRGB = vec3(5.8, 22.0, 42.0);
  float backWrap = pow(clamp(dot(V, -L + N * 0.35), 0.0, 1.0), 1.8) * 0.85 + 0.22 * max(0.0, -ndl + 0.25);
  vec3 transmitRGB = exp(-effThick * sigmaRGB) * backWrap * vec3(3.6, 0.36, 0.08) * smoothstep(0.36, 0.01, thick);

  vec3 diffOut = vec3(0.0);
  vec3 specOut = vec3(0.0);
  float sssMask = 0.0;

  if (stage == 0) {
    // 1975 PHONG / BLINN-PHONG: harsh dead gray shadow terminator, waxy plastic specular, ZERO ear glow!
    vec3 plasticSkin = vec3(0.76, 0.56, 0.44);
    diffOut = plasticSkin * (portraitKeyCol * kNdlPos * kSh + orbKeyCol * ndlPos * sh * 0.65 + fillCol);
    vec3 Hk = normalize(frontKeyDir + V);
    vec3 Hl = normalize(L + V);
    float s1 = pow(max(dot(N, Hk), 0.0), 36.0) * 0.42 * step(0.0, kNdl) * kSh;
    float s2 = pow(max(dot(N, Hl), 0.0), 36.0) * 0.35 * step(0.0, ndl)  * sh;
    specOut = portraitKeyCol * s1 + orbKeyCol * s2;
    sssMask = 0.0;
  } else if (stage == 1) {
    // 2001 JENSEN DIPOLE BSSRDF: crimson shadow bleed + blazing ruby backlit ear!
    vec3 d1 = preIntegratedSkin(kSigned, curv * 1.10);
    vec3 d2 = preIntegratedSkin(lSigned, curv * 1.10);
    diffOut = albedo * (portraitKeyCol * d1 + orbKeyCol * d2 * 0.65 + fillCol * 1.15) + orbKeyCol * transmitRGB * 1.10;
    specOut = portraitKeyCol * ggxSpec(N, V, frontKeyDir, 0.42, 0.028) * kNdlPos * kSh * 0.55
            + orbKeyCol * ggxSpec(N, V, L, 0.42, 0.028) * ndlPos * sh * 0.45;
    sssMask = 0.65;
  } else if (stage == 2) {
    // 2004 WRAPPED DIFFUSE / HALF-LAMBERT (Green GPU Gems / HL2): wraps shadows softly, chalky/powdery, NO ear glow!
    float w = 0.52 * clamp(uScatterScale, 0.6, 1.4);
    float w1 = clamp((kNdl + w) / (1.0 + w), 0.0, 1.0) * mix(0.32, 1.0, kSh);
    float w2 = clamp((ndl  + w) / (1.0 + w), 0.0, 1.0) * mix(0.32, 1.0, sh);
    vec3 tint = vec3(1.03, 0.98, 0.95);
    diffOut = albedo * ((portraitKeyCol * w1 + orbKeyCol * w2 * 0.60) * tint + fillCol * 1.15);
    specOut = portraitKeyCol * ggxSpec(N, V, frontKeyDir, 0.48, 0.024) * kNdlPos * kSh * 0.38;
    sssMask = 0.0;
  } else if (stage == 3) {
    // 2007 TEXTURE-SPACE DIFFUSION (d'Eon & Luebke, GPU Gems 3 Ch. 14 / NVIDIA Human Head)
    vec3 d1 = preIntegratedSkin(kSigned, curv * 0.95);
    vec3 d2 = preIntegratedSkin(lSigned, curv * 0.95);
    diffOut = albedo * (portraitKeyCol * d1 + orbKeyCol * d2 * 0.65 + fillCol * 1.10) + orbKeyCol * transmitRGB * 0.95;
    specOut = portraitKeyCol * ggxSpec(N, V, frontKeyDir, 0.36, 0.028) * kNdlPos * kSh * 0.72
            + orbKeyCol * ggxSpec(N, V, L, 0.36, 0.028) * ndlPos * sh * 0.55;
    sssMask = 0.85;
  } else if (stage == 4) {
    // 2009 SCREEN-SPACE SSS (Jorge Jimenez et al., Eurographics 2009)
    diffOut = albedo * (portraitKeyCol * (kNdlPos * kSh) + orbKeyCol * (ndlPos * sh) * 0.65 + fillCol) + orbKeyCol * transmitRGB * 0.88;
    specOut = portraitKeyCol * ggxSpec(N, V, frontKeyDir, 0.35, 0.028) * kNdlPos * kSh * 0.75
            + orbKeyCol * ggxSpec(N, V, L, 0.35, 0.028) * ndlPos * sh * 0.55;
    sssMask = 1.0;
  } else if (stage == 5) {
    // 2011 PRE-INTEGRATED SKIN SHADING (Eric Penner, SIGGRAPH 2011) — pure analytic LUT(N·L, curvature), ZERO blur passes!
    vec3 d1 = preIntegratedSkin(kSigned, curv * 1.18);
    vec3 d2 = preIntegratedSkin(lSigned, curv * 1.18);
    diffOut = albedo * (portraitKeyCol * d1 + orbKeyCol * d2 * 0.65 + fillCol * 1.05) + orbKeyCol * transmitRGB * 0.92;
    specOut = portraitKeyCol * ggxSpec(N, V, frontKeyDir, 0.34, 0.028) * kNdlPos * kSh * 0.78
            + orbKeyCol * ggxSpec(N, V, L, 0.34, 0.028) * ndlPos * sh * 0.58;
    sssMask = 0.0;
  } else if (stage == 6) {
    // 2013-15 DIGITAL IRA (GDC '13) + SEPARABLE SSS (Jimenez '15) + BURLEY PROFILE (Pixar '15) + Dual-Lobe Specular!
    vec3 d1 = preIntegratedSkin(kSigned, curv * 0.75);
    vec3 d2 = preIntegratedSkin(lSigned, curv * 0.75);
    diffOut = albedo * (portraitKeyCol * mix(vec3(kNdlPos * kSh), d1, 0.62) + orbKeyCol * mix(vec3(ndlPos * sh), d2, 0.62) * 0.65 + fillCol)
            + orbKeyCol * transmitRGB * 1.25;
    float sK = (ggxSpec(Nspec, V, frontKeyDir, 0.18, 0.028) * 0.44 + ggxSpec(Nspec, V, frontKeyDir, 0.46, 0.028) * 0.66) * kNdlPos * kSh;
    float sL = (ggxSpec(Nspec, V, L,           0.18, 0.028) * 0.44 + ggxSpec(Nspec, V, L,           0.46, 0.028) * 0.66) * ndlPos  * sh;
    specOut = portraitKeyCol * sK + orbKeyCol * sL * 0.75;
    sssMask = 1.0;
  } else {
    // 2021 METAHUMAN-ERA SKIN & RANDOM-WALK SSS + Micro-Pore Dual-Lobe GGX + Golden Peach-Fuzz Vellus Sheen!
    float thick2 = marchThickness(p - N * 0.012, normalize(L + N * 0.30));
    float thick3 = marchThickness(p - N * 0.012, normalize(L - N * 0.25));
    float walkThick = (thick * 0.50 + thick2 * 0.28 + thick3 * 0.22) / max(0.35, uScatterScale);
    vec3 walkTransmit = exp(-walkThick * vec3(5.0, 18.0, 35.0)) * (backWrap * 1.15 + 0.18) * vec3(4.4, 0.56, 0.15) * smoothstep(0.42, 0.01, thick);

    vec3 d1 = preIntegratedSkin(kSigned, curv * 1.05);
    vec3 d2 = preIntegratedSkin(lSigned, curv * 1.05);
    diffOut = albedo * (portraitKeyCol * d1 + orbKeyCol * d2 * 0.68 + fillCol * 1.10) + orbKeyCol * walkTransmit;

    float sK = (ggxSpec(Nspec, V, frontKeyDir, 0.16, 0.028) * 0.50 + ggxSpec(Nspec, V, frontKeyDir, 0.45, 0.028) * 0.70) * kNdlPos * kSh;
    float sL = (ggxSpec(Nspec, V, L,           0.16, 0.028) * 0.50 + ggxSpec(Nspec, V, L,           0.45, 0.028) * 0.70) * ndlPos  * sh;
    float grazing = pow(1.0 - max(dot(N, V), 0.0), 4.2);
    vec3 peachFuzz = vec3(1.0, 0.85, 0.72) * grazing * (0.20 + 0.38 * max(0.0, dot(V, -L) * 0.5 + 0.5));
    specOut = portraitKeyCol * sK + orbKeyCol * sL * 0.75 + peachFuzz;
    sssMask = 0.65;
  }

  oDiff = vec4(diffOut, 1.0);
  oSpec = vec4(specOut, 1.0);
  oMeta = vec4(t, sssMask, thick, curv);
}`;

// Pass 2 & 3: Genuine Jimenez (2015) 2-Pass Separable Screen-Space Subsurface Scattering + Burley RGB Profile!
export const SSSS_BLUR_FS = /* glsl */`#version 300 es
precision highp float;
in vec2 vUv;
out vec4 oCol;

uniform sampler2D uDiffTex;
uniform sampler2D uMetaTex;
uniform vec2 uDir;         // (1/w, 0) for horizontal pass, (0, 1/h) for vertical pass
uniform float uScatterScale;

void main() {
  vec4 center = texture(uDiffTex, vUv);
  vec4 meta   = texture(uMetaTex, vUv);
  float depth = meta.r;
  float mask  = meta.g;

  if (mask < 0.02) {
    oCol = center;
    return;
  }

  // Smooth 13-tap Jimenez Separable SSS RGB kernel (zero horizontal striping!)
  const float offsets[13] = float[13](-6.0,-5.0,-4.0,-3.0,-2.0,-1.0, 0.0, 1.0, 2.0, 3.0, 4.0, 5.0, 6.0);
  // Perspective-correct tight step (~2.4px per tap at dist 2.3 -> smooth ~14px red radius, ~5px green, ~2.5px blue!)
  float stepPx = (4.8 * uScatterScale * mask) / max(depth, 0.85);
  vec3 acc = vec3(0.0);
  vec3 wSum = vec3(0.0);
  for (int i = 0; i < 13; i++) {
    float x = offsets[i];
    vec2 uv = clamp(vUv + uDir * (x * stepPx), 0.001, 0.999);
    vec4 sMeta = texture(uMetaTex, uv);
    float dDiff = abs(sMeta.r - depth);
    float edgeStop = exp(-dDiff * 24.0) * step(0.02, sMeta.g);
    // Analytic Burley-inspired RGB diffusion profile (wide red blood lobe, narrow green/blue!)
    vec3 gW = vec3(
      exp(-x * x / 18.0) * 0.72 + exp(-abs(x) * 0.55) * 0.28,
      exp(-x * x / 5.5)  * 0.80 + exp(-abs(x) * 1.10) * 0.20,
      exp(-x * x / 2.2)  * 0.88 + exp(-abs(x) * 1.80) * 0.12
    );
    vec3 w = gW * (i == 6 ? 1.0 : edgeStop);
    acc  += texture(uDiffTex, uv).rgb * w;
    wSum += w;
  }
  oCol = vec4(acc / max(wSum, vec3(1e-4)), 1.0);
}`;

// Pass 4: Final Linear HDR -> Khronos PBR Neutral Filmic Tone Map (faithful skin albedo + pure ruby ear glow!)
export const SKIN_COMPOSITE_FS = /* glsl */`#version 300 es
precision highp float;
in vec2 vUv;
out vec4 oCol;

uniform sampler2D uDiffBlurTex;
uniform sampler2D uSpecTex;
uniform sampler2D uMetaTex;
uniform float uShowThickness;

vec3 pbrNeutralToneMap(vec3 color) {
  color = max(color, vec3(0.0));
  const float startCompression = 0.8 - 0.04;
  const float desaturation = 0.15;
  float x = min(color.r, min(color.g, color.b));
  float offset = x < 0.08 ? x - 6.25 * x * x : 0.04;
  color -= offset;
  float peak = max(color.r, max(color.g, color.b));
  if (peak < startCompression) return color;
  const float d = 1.0 - startCompression;
  float newPeak = 1.0 - d * d / (peak + d - startCompression);
  color *= newPeak / peak;
  float g = 1.0 - 1.0 / (desaturation * (peak - newPeak) + 1.0);
  return mix(color, vec3(newPeak), g);
}

void main() {
  vec3 diff = texture(uDiffBlurTex, vUv).rgb;
  vec3 spec = texture(uSpecTex, vUv).rgb;
  vec4 meta = texture(uMetaTex, vUv);

  vec3 col = diff + spec;
  if (uShowThickness > 0.5 && meta.r < 10.0) {
    // Live thickness X-ray diagnostic: glowing crimson on thin ear/nostril, deep indigo on thick skull!
    float thin = exp(-meta.b * 7.5);
    col = mix(vec3(0.05, 0.08, 0.22), vec3(1.6, 0.14, 0.08), thin) + spec * 0.25;
  }

  col = pbrNeutralToneMap(col * 0.78);
  col = pow(clamp(col, 0.0, 1.0), vec3(1.0 / 2.2));
  oCol = vec4(col, 1.0);
}`;
