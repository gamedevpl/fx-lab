// WebGL2 Shaders for Evolution of Depth of Field & Bokeh (1998-2024) — Genuine 4-Pass RGBA16F HDR Optical Pipeline!
//   Pass 1 (DOF_SCENE_FS):   3D Optical Studio + 36 HDR Night Bokeh Lights (radiance up to 30.0!) -> MRT0 HDR + MRT1 Thin-Lens CoC/Depth
//   Pass 2 (DOF_NEAR_H_FS):  Half-res Horizontal Near-Field CoC Max/Soft Dilation (Crysis / UE4 Layered Near/Far!)
//   Pass 3 (DOF_NEAR_V_FS):  Half-res Vertical Near-Field CoC Max/Soft Dilation
//   Pass 4 (DOF_RESOLVE_FS): All 8 optical eras: Pinhole, 2001 Gaussian Halo Bleed, 2004 Depth-Aware, 2007 Near/Far Layers,
//                            2011 Hexagonal Aperture, 2014 Vogel Disk + Rim, 2018 Cat's-Eye Vignette, 2024 Anamorphic + LoCA!

export const DOF_SCENE_FS = /* glsl */`#version 300 es
precision highp float;

in vec2 vUv;
layout(location = 0) out vec4 oHdr;
layout(location = 1) out vec4 oCocDepth; // r = signedCoC (-1..1), g = linearDepth, b = nearCoC (0..1), a = 1.0

uniform vec3 uCamPos;
uniform vec3 uCamRight;
uniform vec3 uCamUp;
uniform vec3 uCamFwd;
uniform float uTanHalfFov;
uniform float uAspect;
uniform float uTime;
uniform float uFocusDist;
uniform float uAperture; // f-number (e.g. 1.4 = shallow, 5.6 = deep)

float sdBox(vec3 p, vec3 b) {
  vec3 q = abs(p) - b;
  return length(max(q, 0.0)) + min(max(q.x, max(q.y, q.z)), 0.0);
}

float sdTorus(vec3 p, vec2 t) {
  vec2 q = vec2(length(p.xz) - t.x, p.y);
  return length(q) - t.y;
}

float sdCylinderY(vec3 p, float r, float h) {
  vec2 d = abs(vec2(length(p.xz), p.y)) - vec2(r, h);
  return min(max(d.x, d.y), 0.0) + length(max(d, 0.0));
}

float sdOctahedron(vec3 p, float s) {
  p = abs(p);
  return (p.x + p.y + p.z - s) * 0.57735027;
}

mat2 rot2(float a) {
  float c = cos(a), s = sin(a);
  return mat2(c, -s, s, c);
}

// Returns vec2(dist, matId)
// 1 = wet dark studio table, 2 = sharp hero optical statue/gyro, 3 = hero brass/gold accents,
// 4 = hero glowing sapphire lens core, 5 = near-foreground crystal/pillar (tests foreground blur over hero!)
vec2 mapScene(vec3 p, float t) {
  vec2 res = vec2(p.y, 1.0); // Glossy wet studio floor y = 0

  // --- NEAR FOREGROUND (z = +1.72, depth ~1.9m — raised cleanly ABOVE bottom-left UI card!) ---
  vec3 pNearL = p - vec3(-0.84, 1.08, 1.72);
  pNearL.xz = rot2(t * 0.5235988) * pNearL.xz;
  float dCrystal = sdOctahedron(pNearL * vec3(1.15, 0.65, 1.15), 0.30);
  float dNearStand = sdCylinderY(p - vec3(-0.84, 0.40, 1.72), 0.055, 0.40);
  float dNearL = min(dCrystal, dNearStand);
  if (dNearL < res.x) res = vec2(dNearL, 5.0);

  // Right-foreground floating brass optical ring right beside hero!
  vec3 pNearR = p - vec3(0.88, 0.78, 1.65);
  pNearR.yz = rot2(1.15) * pNearR.yz;
  float dNearRing = sdTorus(pNearR, vec2(0.22, 0.042));
  if (dNearRing < res.x) res = vec2(dNearRing, 5.0);

  // --- HERO FOCAL PLANE SUBJECT (z = 0.0, depth ~3.65m — RAZOR SHARP FOCAL TARGET!) ---
  // Sculpted vintage optical lens & brass astrolabe sculpture standing on a matte ceramic plinth
  float dPlinth = sdCylinderY(p - vec3(0.0, 0.18, 0.0), 0.44, 0.18) - 0.02;
  float dStem   = sdCylinderY(p - vec3(0.0, 0.44, 0.0), 0.12, 0.16);
  if (min(dPlinth, dStem) < res.x) res = vec2(min(dPlinth, dStem), 2.0);

  vec3 qh = p - vec3(0.0, 1.06, 0.0);
  // Outer dark anodized cinema barrel housing
  vec3 qBar = qh;
  qBar.yz = rot2(1.5707963) * qBar.yz;
  float dHousing = sdCylinderY(qBar, 0.40, 0.22) - 0.02;
  // Carve recessed lens front aperture cavity
  float dCavity = length(qh - vec3(0.0, 0.0, 0.24)) - 0.30;
  dHousing = max(dHousing, -dCavity);
  if (dHousing < res.x) res = vec2(dHousing, 2.0);

  // Precision machined brass focus rings + gently rotating astrolabe halo!
  vec3 qR1 = qh;
  qR1.yz = rot2(1.5707963) * qR1.yz;
  float dBrass1 = sdTorus(qR1 - vec3(0.0, 0.14, 0.0), vec2(0.415, 0.028));
  float dBrass2 = sdTorus(qR1 - vec3(0.0, -0.10, 0.0), vec2(0.415, 0.022));
  vec3 qHalo = qh;
  qHalo.xz = rot2(t * 0.5235988) * qHalo.xz;
  qHalo.xy = rot2(0.42 + 0.12 * sin(t * 0.6981317)) * qHalo.xy;
  float dHalo = sdTorus(qHalo, vec2(0.56, 0.026));
  float dGold = min(min(dBrass1, dBrass2), dHalo);
  if (dGold < res.x) res = vec2(dGold, 3.0);

  // Curved glowing sapphire glass inner lens element!
  float dGlass = length(qh - vec3(0.0, 0.0, 0.06)) - 0.27;
  if (dGlass < res.x) res = vec2(dGlass, 4.0);

  return res;
}

vec3 calcNormal(vec3 p, float t) {
  const float e = 0.002;
  vec2 k = vec2(1.0, -1.0);
  return normalize(
    k.xyy * mapScene(p + k.xyy * e, t).x +
    k.yyx * mapScene(p + k.yyx * e, t).x +
    k.yxy * mapScene(p + k.yxy * e, t).x +
    k.xxx * mapScene(p + k.xxx * e, t).x
  );
}

// Analytical 3D HDR night fairy-light / city bokeh field (40 luminous bulbs sized for Nyquist-clean 64-tap bokeh!)
void evalBokehLights(vec3 ro, vec3 rd, float maxT, float t, inout vec3 col, inout float hitDepth) {
  float closestT = maxT;
  vec3 bestCol = vec3(0.0);
  bool hitLight = false;

  for (int i = 0; i < 40; i++) {
    float fi = float(i);
    float h1 = fract(sin(fi * 127.1 + 31.7) * 43758.5453);
    float h2 = fract(sin(fi * 269.5 + 17.3) * 43758.5453);
    float h3 = fract(sin(fi * 419.2 + 53.1) * 43758.5453);
    float z = mix(-2.2, -7.2, h3);
    float x = (h1 - 0.5) * mix(4.6, 9.2, h3) + 0.14 * sin(t * 0.3490658 + fi * 1.3);
    float y = 0.25 + h2 * mix(2.0, 3.6, h3) + 0.07 * cos(t * 0.5235988 + fi * 1.9);
    vec3 lc = vec3(x, y, z);
    // Larger Nyquist-clean glowing bulb radius (0.09..0.15m) -> 64-tap gather yields 100% SOLID, SILKY HEXAGONS & OVALS!
    float rad = mix(0.095, 0.155, fract(h1 * 7.3));

    vec3 oc = ro - lc;
    float b = dot(oc, rd);
    float c = dot(oc, oc) - rad * rad;
    float disc = b * b - c;
    if (disc > 0.0) {
      float th = -b - sqrt(disc);
      if (th > 0.1 && th < closestT) {
        closestT = th;
        hitLight = true;
        int cid = int(mod(fi, 5.0));
        vec3 baseL = cid == 0 ? vec3(1.00, 0.62, 0.16)
                   : cid == 1 ? vec3(0.14, 0.88, 1.00)
                   : cid == 2 ? vec3(1.00, 0.22, 0.54)
                   : cid == 3 ? vec3(1.00, 0.88, 0.56)
                              : vec3(0.18, 0.98, 0.62);
        float pulse = 0.86 + 0.14 * sin(t * 0.6981317 + fi * 2.1);
        // Smooth radial bulb core falloff + high RGBA16F HDR radiance (12..22!) -> rich glowing cinema bokeh!
        float edgeN = sqrt(max(0.0, disc)) / rad;
        bestCol = baseL * mix(11.0, 20.0, h2) * (0.45 + 0.55 * edgeN) * pulse;
      }
    }
  }
  if (hitLight) {
    col = bestCol;
    hitDepth = closestT;
  }
}

void main() {
  vec2 ndc = vUv * 2.0 - 1.0;
  vec3 rd = normalize(uCamFwd + uCamRight * (ndc.x * uAspect * uTanHalfFov) + uCamUp * (ndc.y * uTanHalfFov));

  float dist = 0.0;
  float matId = 0.0;
  bool hit = false;
  for (int i = 0; i < 72; i++) {
    vec2 h = mapScene(uCamPos + rd * dist, uTime);
    if (h.x < 0.0018) { hit = true; matId = h.y; break; }
    dist += h.x;
    if (dist > 14.0) break;
  }

  // Deep midnight-indigo cinema backdrop so HDR polygonal & anamorphic bokeh discs POP like jewels!
  vec3 col = mix(vec3(0.010, 0.016, 0.036), vec3(0.032, 0.052, 0.105), clamp(rd.y * 1.4 + 0.35, 0.0, 1.0));
  col += vec3(0.10, 0.045, 0.03) * exp(-abs(rd.y - 0.03) * 8.5);
  float rayT = hit ? dist : 14.0;
  float linDepth = hit ? dot((uCamPos + rd * dist) - uCamPos, uCamFwd) : 14.0;

  if (hit) {
    vec3 p = uCamPos + rd * dist;
    vec3 N = calcNormal(p, uTime);
    vec3 V = -rd;
    vec3 L1 = normalize(vec3(0.62, 0.82, 0.58));
    vec3 L2 = normalize(vec3(-0.78, 0.35, -0.45));
    float ndl1 = max(dot(N, L1), 0.0);
    float ndl2 = max(dot(N, L2), 0.0);
    float fres = pow(1.0 - max(dot(N, V), 0.0), 4.5);

    vec3 albedo = vec3(0.5);
    float rough = 0.30;
    float metal = 0.25;
    vec3 emissive = vec3(0.0);

    if (matId < 1.5) {
      // Wet glossy dark studio table with crisp distance grid & specular bokeh reflections!
      vec2 gf = abs(fract(p.xz * 1.0) - 0.5);
      float gLine = smoothstep(0.465, 0.495, max(gf.x, gf.y));
      albedo = mix(vec3(0.035, 0.045, 0.068), vec3(0.11, 0.16, 0.24), gLine * 0.55);
      rough = 0.11; metal = 0.35;
      // Ground contact AO beneath hero & near crystal
      float aoH = smoothstep(0.25, 0.85, length(p.xz)) * 0.65 + 0.35;
      float aoN = smoothstep(0.12, 0.55, length(p.xz - vec2(-0.98, 1.72))) * 0.55 + 0.45;
      albedo *= min(aoH, aoN);
      // Mirror-bounce specular glints of the 32 HDR bokeh lights right onto the wet dark floor!
      vec3 refl = reflect(rd, N);
      vec3 rCol = vec3(0.0);
      float rT = 14.0;
      evalBokehLights(p + vec3(0.0, 0.005, 0.0), refl, 14.0, uTime, rCol, rT);
      emissive += rCol * (0.28 + 0.52 * fres);
    } else if (matId < 2.5) {
      // Sharp hero matte charcoal anodized camera barrel + crisp white millimeter scale ticks!
      float ticks = smoothstep(0.42, 0.48, abs(fract(atan(p.x, p.z) * 7.639) - 0.5));
      float scaleBand = step(0.14, abs(p.y - 1.06)) * step(abs(p.y - 1.06), 0.20);
      albedo = mix(vec3(0.14, 0.16, 0.21), vec3(0.92, 0.94, 0.98), ticks * scaleBand * 0.75);
      if (p.y < 0.38) albedo = vec3(0.84, 0.86, 0.90); // bright ceramic pedestal contrast!
      rough = 0.26; metal = 0.32;
    } else if (matId < 3.5) {
      // Machined gold/brass optical rings & rotating astrolabe!
      albedo = vec3(0.96, 0.74, 0.28);
      rough = 0.14; metal = 0.92;
      emissive += vec3(0.18, 0.10, 0.02);
    } else if (matId < 4.5) {
      // Multi-coated sapphire cinema glass front element (vivid cyan/violet coating sheen!)
      albedo = vec3(0.05, 0.18, 0.32);
      rough = 0.06; metal = 0.20;
      emissive += mix(vec3(0.08, 0.55, 0.95), vec3(0.62, 0.22, 0.95), fres) * (0.65 + 2.2 * fres);
    } else {
      // Near-foreground warm amber crystal & bronze ring (vivid contrast to show foreground blur OVER sharp hero!)
      float facet = 0.65 + 0.35 * abs(N.x + N.y);
      albedo = vec3(0.96, 0.48, 0.14) * facet;
      rough = 0.14; metal = 0.48;
      emissive += vec3(0.95, 0.38, 0.10) * (0.28 + 0.95 * fres);
    }

    vec3 H1 = normalize(L1 + V);
    vec3 H2 = normalize(L2 + V);
    float specPow = mix(140.0, 14.0, rough);
    float s1 = pow(max(dot(N, H1), 0.0), specPow) * mix(0.35, 1.35, metal);
    float s2 = pow(max(dot(N, H2), 0.0), specPow * 0.5) * 0.55;
    vec3 diff = albedo * (1.0 - metal * 0.72) * (vec3(0.16, 0.20, 0.28) + vec3(1.12, 1.04, 0.94) * ndl1 + vec3(0.24, 0.52, 0.95) * ndl2 * 0.75);
    vec3 specCol = mix(vec3(1.0), albedo, metal);
    col = diff + specCol * (s1 + s2) + vec3(0.30, 0.55, 0.95) * fres * 0.42 + emissive;
  }

  // Intersect analytical HDR bokeh light orbs (only if in front of hit geometry!)
  float lightHitT = rayT;
  vec3 lightCol = col;
  evalBokehLights(uCamPos, rd, rayT, uTime, lightCol, lightHitT);
  if (lightHitT < rayT) {
    col = lightCol;
    linDepth = dot((uCamPos + rd * lightHitT) - uCamPos, uCamFwd);
  }

  // --- PHYSICAL THIN-LENS CIRCLE OF CONFUSION (signedCoC in [-1..+1]) ---
  // CoC ∝ (1 / fNumber) * (z - zFocus) / z
  float fScale = 1.45 / max(uAperture, 0.8);
  float signedCoc = clamp(((linDepth - uFocusDist) / max(linDepth, 0.45)) * 1.48 * fScale, -1.0, 1.0);
  // Subtle deadzone right on the focal plane so the focused subject is razor sharp
  signedCoc = sign(signedCoc) * max(0.0, abs(signedCoc) - 0.035) / 0.965;
  float nearCoc = max(0.0, -signedCoc);

  oHdr = vec4(col, 1.0);
  oCocDepth = vec4(signedCoc, linDepth, nearCoc, 1.0);
}`;

// Pass 2 & 3: Separable Half-Res Near-Field CoC Max/Soft Dilation (Crysis / UE4 Layered Foreground Blur!)
export const DOF_NEAR_DILATE_FS = /* glsl */`#version 300 es
precision highp float;
in vec2 vUv;
out vec4 oNear;
uniform sampler2D uSrcTex;
uniform vec2 uDir; // (1/w, 0) for H-pass, (0, 1/h) for V-pass
uniform int uIsFirstPass;

void main() {
  float maxC = 0.0;
  float avgC = 0.0;
  float wSum = 0.0;
  for (int i = -7; i <= 7; i++) {
    vec2 uv = clamp(vUv + uDir * float(i) * 2.0, 0.001, 0.999);
    vec4 s = texture(uSrcTex, uv);
    float c = (uIsFirstPass == 1) ? s.b : s.r;
    float w = exp(-float(i * i) * 0.045);
    maxC = max(maxC, c * w);
    avgC += c * w;
    wSum += w;
  }
  float dilated = max(maxC, avgC / wSum);
  oNear = vec4(dilated, avgC / wSum, 0.0, 1.0);
}`;

// Pass 4: All 8 Authentic Optical Depth of Field & Bokeh Eras + ACES Filmic + CoC Heatmap!
export const DOF_RESOLVE_FS = /* glsl */`#version 300 es
precision highp float;
in vec2 vUv;
out vec4 oCol;

uniform sampler2D uHdrTex;
uniform sampler2D uCocTex;
uniform sampler2D uNearTex;
uniform int uStageLeft;
uniform int uStageRight;
uniform float uSplitX;
uniform int uShowCoc;
uniform float uAspect;
uniform vec2 uFocusClickUv;
uniform float uFocusPulse;

const float GOLDEN_ANGLE = 2.39996323;

vec3 acesToneMap(vec3 x) {
  const float a = 2.51, b = 0.03, c = 2.43, d = 0.59, e = 0.14;
  return clamp((x * (a * x + b)) / (x * (c * x + d) + e), 0.0, 1.0);
}

// Signed polygon radius factor for 6-blade hexagonal aperture (returns ~1 inside hex, >1 outside!)
float hexRadius(vec2 p) {
  float a = atan(p.y, p.x);
  float r = length(p);
  float sector = 1.04719755; // pi / 3 (6 blades!)
  float d = cos(floor(0.5 + a / sector) * sector - a) * r;
  return d / 0.8660254;
}

void main() {
  int stage = (uSplitX > 0.0 && vUv.x >= uSplitX) ? uStageRight : uStageLeft;

  vec3 centerHdr = texture(uHdrTex, vUv).rgb;
  vec4 cd        = texture(uCocTex, vUv);
  float cCoc     = cd.r; // signed: <0 near, >0 far
  float cDepth   = cd.g;
  float nearDil  = texture(uNearTex, vUv).r;

  // Optional Optical CoC Heatmap Inspector (Cyan-Blue = Near Field, Dark = Focal Plane, Gold-Orange = Far Field!)
  if (uShowCoc == 1) {
    vec3 heat = vec3(0.06, 0.08, 0.12);
    if (cCoc < -0.01) heat = mix(vec3(0.06, 0.16, 0.28), vec3(0.14, 0.92, 1.0), clamp(-cCoc * 1.4, 0.0, 1.0));
    else if (cCoc > 0.01) heat = mix(vec3(0.22, 0.12, 0.05), vec3(1.0, 0.62, 0.12), clamp(cCoc * 1.4, 0.0, 1.0));
    else heat = vec3(0.18, 0.96, 0.56); // razor sharp focal plane band!
    vec3 baseM = acesToneMap(centerHdr);
    vec3 vis = mix(baseM * 0.45, heat, 0.68);
    oCol = vec4(pow(clamp(vis, 0.0, 1.0), vec3(1.0 / 2.2)), 1.0);
    return;
  }

  vec3 outHdr = centerHdr;
  float maxRad = 0.046; // Rich big cinema bokeh discs (4.6% viewport height -> unmistakable hexagons, cat's-eyes & anamorphic ovals!)
  vec2 aspectInv = vec2(1.0 / max(uAspect, 0.4), 1.0);

  if (stage == 0) {
    // 1998 Pinhole Camera: ZERO Depth of Field (infinite sharpness everywhere!)
    outHdr = centerHdr;
  } else if (stage == 1) {
    // 2001 Naive Gaussian Z-Blur (Metal Gear Solid 2):
    // Blurs WITHOUT depth rejection -> UGLY HDR halo leaks straight across the sharp hero silhouette + muddy Gaussian blobs!
    float blurR = max(abs(cCoc), nearDil * 0.65) * maxRad;
    // Also intentionally slightly dilate center radius on sharp edges near far lights to demonstrate classic naive Z-bleed!
    float probeR = max(blurR, 0.014);
    vec3 acc = vec3(0.0);
    float wSum = 0.0;
    for (int i = 0; i < 36; i++) {
      float fi = float(i) + 0.5;
      float r = sqrt(fi / 36.0);
      float a = fi * GOLDEN_ANGLE;
      vec2 off = vec2(cos(a), sin(a)) * r * probeR * aspectInv;
      vec2 suv = clamp(vUv + off, 0.001, 0.999);
      vec4 scd = texture(uCocTex, suv);
      float sCoc = abs(scd.r);
      // Naive Gaussian kernel: bleeds bright background right ONTO the sharp hero!
      float gW = exp(-r * r * 3.8) * (0.25 + sCoc * 2.2);
      // LDR-clamped gather (2001 8-bit framebuffers killed specular HDR bokeh!)
      vec3 sCol = min(texture(uHdrTex, suv).rgb, vec3(1.65));
      acc += sCol * gW;
      wSum += gW;
    }
    float mixAmt = clamp(max(abs(cCoc), nearDil * 0.7) * 1.2 + 0.22 * smoothstep(0.05, 0.45, length(acc / max(wSum, 1e-4) - min(centerHdr, vec3(1.65)))), 0.0, 1.0);
    outHdr = mix(centerHdr, acc / max(wSum, 1e-4), mixAmt);
  } else if (stage == 2) {
    // 2004 Depth-Aware CoC Gather (GPU Gems 1, Scheuermann):
    // Rejects samples behind a sharp hero -> fixes background halo, but foreground crystal stays cut off hard!
    float rCenter = abs(cCoc) * maxRad;
    if (rCenter > 0.0008) {
      vec3 acc = centerHdr * 0.4;
      float wSum = 0.4;
      for (int i = 0; i < 40; i++) {
        float fi = float(i) + 0.5;
        float r = sqrt(fi / 40.0);
        float a = fi * GOLDEN_ANGLE;
        vec2 off = vec2(cos(a), sin(a)) * r * rCenter * aspectInv;
        vec2 suv = clamp(vUv + off, 0.001, 0.999);
        vec4 scd = texture(uCocTex, suv);
        // Depth-aware rejection: background cannot bleed onto nearer sharp subject!
        float depthOk = (scd.g >= cDepth - 0.12) ? 1.0 : 0.0;
        float w = depthOk * smoothstep(0.0, 0.15, abs(scd.r));
        acc += min(texture(uHdrTex, suv).rgb, vec3(4.5)) * w;
        wSum += w;
      }
      outHdr = acc / max(wSum, 1e-4);
    }
  } else {
    // Stages 3..7: True Layered Near/Far Field + RGBA16F HDR Optical Bokeh!
    //   Stage 3 (2007 Crysis):    Layered Near/Far Field (smooth foreground blur OVER sharp hero!)
    //   Stage 4 (2011 BF3):       6-Blade Hexagonal Aperture Bokeh in full RGBA16F HDR!
    //   Stage 5 (2014 UE4):       Thin-Lens Vogel Disk + Optical Spherical Aberration Rim ("soap-bubble" edge!)
    //   Stage 6 (2018 Cinema):    Cat's-Eye Mechanical Barrel Vignetting toward screen corners!
    //   Stage 7 (2024 Anamorphic):2:1 Vertical Anamorphic Oval Bokeh + Longitudinal Chromatic Aberration (LoCA)!
    float farRad  = max(0.0, cCoc) * maxRad * (stage >= 4 ? 1.18 : 1.0);
    float nearRad = nearDil * maxRad * 1.15;
    float gatherR = max(farRad, nearRad);

    if (gatherR > 0.0008) {
      vec3 farAcc = vec3(0.0);  float farW = 0.0;
      vec3 nearAcc = vec3(0.0); float nearW = 0.0;

      // Off-axis screen vector for Cat's-Eye mechanical barrel vignetting (Stages 6 & 7!)
      vec2 screenOff = (vUv - 0.5) * 2.0;
      vec2 vignetteShift = screenOff * (stage >= 6 ? 0.68 : 0.0);

      // 2x Anamorphic squeeze on Stage 7 (tall dramatic vertical cinema ovals!)
      vec2 anamScale = (stage == 7) ? vec2(0.50, 1.44) : vec2(1.0, 1.0);

      const int TAPS = 72;
      for (int i = 0; i < TAPS; i++) {
        float fi = float(i) + 0.5;
        float r = sqrt(fi / float(TAPS));
        float a = fi * GOLDEN_ANGLE;
        vec2 disk = vec2(cos(a), sin(a)) * r;

        // Stage 4: Crisp 6-Blade Hexagonal Aperture mask!
        if (stage == 4 && hexRadius(disk) > 0.96) continue;

        // Stage 6 & 7: Authentic Cat's-Eye Mechanical Barrel Vignetting (clips aperture sharply off-axis!)
        if (stage >= 6 && length(disk - vignetteShift) > 1.04) continue;

        // Optical rim weighting (spherical aberration bright bokeh ring on Stages 5..7!)
        float rimBoost = (stage >= 5) ? mix(0.70, 1.55, smoothstep(0.58, 0.98, r)) : 1.0;

        vec2 off = disk * anamScale * gatherR * aspectInv;
        vec2 suv = clamp(vUv + off, 0.001, 0.999);
        vec4 scd = texture(uCocTex, suv);
        vec3 sCol = texture(uHdrTex, suv).rgb;

        // Distinct Longitudinal Chromatic Aberration (LoCA) on Stage 7:
        // Far bokeh rims glow cyan-emerald; near bokeh rims glow warm magenta-amber!
        if (stage == 7) {
          float rimEdge = smoothstep(0.52, 0.98, r);
          if (scd.r > 0.05) sCol *= mix(vec3(1.0), vec3(0.76, 1.12, 1.24), rimEdge * 0.72);
          else if (scd.r < -0.05) sCol *= mix(vec3(1.0), vec3(1.26, 0.80, 1.12), rimEdge * 0.72);
        }

        // Far-field contribution: out-of-focus bokeh lights (7m) scatter cleanly IN FRONT OF distant sky (14m),
        // while never bleeding onto the razor-sharp focal hero (where cCoc ~ 0)!
        if (farRad > 0.0008 && scd.r > 0.01) {
          float sRad = scd.r * maxRad * (stage >= 4 ? 1.18 : 1.0);
          float sampDist = r * gatherR;
          float cover = smoothstep(sampDist - 0.003, sampDist + 0.003, sRad);
          float bgOk = max(smoothstep(cDepth - 0.18, cDepth + 0.06, scd.g), smoothstep(0.03, 0.22, cCoc));
          float w = cover * bgOk * rimBoost;
          farAcc += sCol * w;
          farW += w;
        }

        // Near-field foreground contribution (expands smoothly OVER the sharp hero behind it!)
        if (nearRad > 0.0008 && scd.r < -0.01) {
          float sNearR = (-scd.r) * maxRad * 1.15;
          float sampDist = r * gatherR;
          float cover = smoothstep(sampDist - 0.004, sampDist + 0.004, sNearR);
          float w = cover * rimBoost;
          nearAcc += sCol * w;
          nearW += w;
        }
      }

      // Composite: sharp center / far bokeh base -> soft foreground bokeh layer on top!
      vec3 baseLayer = (farW > 0.01 && cCoc > 0.01) ? (farAcc / farW) : centerHdr;
      if (farW > 0.01 && cCoc > 0.0 && cCoc < 0.12) {
        baseLayer = mix(centerHdr, farAcc / farW, smoothstep(0.0, 0.12, cCoc));
      }
      float nearAlpha = clamp((nearW / (float(TAPS) * 0.42)) * smoothstep(0.02, 0.28, nearDil), 0.0, 1.0);
      if (cCoc < -0.02) nearAlpha = max(nearAlpha, smoothstep(-0.02, -0.14, cCoc));
      vec3 nearLayer = (nearW > 0.01) ? (nearAcc / nearW) : baseLayer;
      outHdr = mix(baseLayer, nearLayer, nearAlpha);
    }
  }

  vec3 mapped = acesToneMap(outHdr);

  // Subtle cinema rack-focus target reticle pulsing when the user clicks to refocus!
  if (uFocusPulse > 0.01) {
    vec2 dp = (vUv - uFocusClickUv) * vec2(uAspect, 1.0);
    float d = length(dp);
    float ringR = 0.024 + (1.0 - uFocusPulse) * 0.028;
    float ring = smoothstep(0.0035, 0.001, abs(d - ringR));
    float crossHair = (abs(dp.x) < 0.0016 && d > ringR * 0.55 && d < ringR * 1.35) ||
                      (abs(dp.y) < 0.0016 && d > ringR * 0.55 && d < ringR * 1.35) ? 1.0 : 0.0;
    mapped = mix(mapped, vec3(0.24, 0.98, 0.72), max(ring, crossHair) * uFocusPulse * 0.9);
  }

  // Gentle optical lens vignette
  vec2 v2 = (vUv - 0.5) * 2.0;
  mapped *= 1.0 - 0.16 * dot(v2, v2);
  oCol = vec4(pow(clamp(mapped, 0.0, 1.0), vec3(1.0 / 2.2)), 1.0);
}`;
