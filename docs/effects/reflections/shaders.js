// Evolution of Reflections (1976-2026) — Analytical & Multi-Pass WebGL2 Shaders:
// - Pass 1 (GBUFFER_FS): Primary camera view -> HDR color + linear depth / roughness / material G-buffer.
// - Pass 2 (REFLECT_FS): All 8 fact-checked reflection eras (supports live split-screen comparison):
//     0: 1976 Equirectangular Env Map (Blinn & Newell 1976 — lat-long distant panorama only)
//     1: 1996 Planar Portal Mirror (Duke Nukem 3D 1996 / Unreal 1998 — flat floor only, curved objects miss)
//     2: 1999 Hardware Cubemaps (GeForce 256 / DX7 — works on curves, infinite-distance parallax error on floor)
//     3: 2011 Screen-Space Reflections / SSR (Crysis 2 DX11 — genuine G-buffer raymarch: off-screen & behind-pillar holes!)
//     4: 2012 Parallax-Corrected Cubemaps (Bjorke 2004 · Lagarde & Zanuttini SIGGRAPH 2012 — fixes floor parallax, static only)
//     5: 2013 Split-Sum Roughness IBL (Karis UE4, SIGGRAPH 2013 — GGX pre-filtered roughness + Split-Sum BRDF across wet/dry)
//     6: 2018 Hardware Ray-Traced Reflections (Battlefield V DXR — 1-bounce full 3D RT heals all SSR holes & off-screen!)
//     7: 2022-26 Multi-Bounce Glossy RT (UE5 Lumen 2022 / Cyberpunk RT Overdrive 2023 — GGX stochastic + 2nd bounce + contact hardening)
// - Pass 3 (ACCUM_FS + FINAL_FS): Jitter-free temporal accumulation for Stage 7 stochastic glossy RT + smooth neon bloom + ACES.

const SCENE_COMMON = /* glsl */`
const float INF = 1e9;
const float PI  = 3.14159265;
const vec3 PROBE_POS = vec3(0.0, 1.42, -0.45);
const vec3 ROOM_MIN  = vec3(-3.30, 0.0, -2.85);
const vec3 ROOM_MAX  = vec3( 3.30, 3.85, 3.60);

float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

float vNoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float a = hash12(i);
  float b = hash12(i + vec2(1.0, 0.0));
  float c = hash12(i + vec2(0.0, 1.0));
  float d = hash12(i + vec2(1.0, 1.0));
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}

float fbm2(vec2 p) {
  float v = 0.0, a = 0.5;
  mat2 m = mat2(0.8, 0.6, -0.6, 0.8);
  for (int i = 0; i < 4; i++) {
    v += a * vNoise(p);
    p = m * p * 2.02;
    a *= 0.5;
  }
  return v;
}

// Expansive rain-puddle mask sweeping right across the hero foreground courtyard
// Leaves realistic damp matte basalt islands around edges & tile seams so Split-Sum & Glossy Contact Hardening shine!
float evalPuddleMask(vec2 xz, float wetness) {
  float mainBasin = exp(-dot((xz - vec2(-0.15, 0.72)) * vec2(0.38, 0.42), (xz - vec2(-0.15, 0.72)) * vec2(0.38, 0.42)));
  float archBasin = exp(-dot((xz - vec2( 0.05,-1.05)) * vec2(0.46, 0.58), (xz - vec2( 0.05,-1.05)) * vec2(0.46, 0.58)));
  float organic = fbm2(xz * 1.10 + vec2(2.7, 1.4));
  float field = max(mainBasin, archBasin) * 0.86 + organic * 0.48;
  float edge = mix(0.96, 0.43, clamp(wetness, 0.0, 1.0));
  return smoothstep(edge, edge + 0.12, field);
}

// Subtle concentric raindrop micro-ripples inside puddles
vec3 evalPuddleNormal(vec2 xz, float t, float puddle) {
  if (puddle < 0.05) return vec3(0.0, 1.0, 0.0);
  vec2 g = vec2(0.0);
  for (int i = 0; i < 3; i++) {
    float fi = float(i);
    float cycle = floor(t * 0.90 + fi * 0.37);
    float age = fract(t * 0.90 + fi * 0.37);
    vec2 center = vec2(
      (hash12(vec2(cycle, fi * 7.3 + 1.1)) - 0.5) * 3.8,
      (hash12(vec2(cycle, fi * 13.7 + 4.2)) - 0.5) * 3.0 + 0.45
    );
    vec2 d = xz - center;
    float r = length(d) + 1e-4;
    float ring = r - age * 0.95;
    float env = exp(-ring * ring * 70.0) * (1.0 - age) * smoothstep(0.0, 0.08, age);
    float slope = cos(ring * 32.0) * env * 0.0085;
    g += (d / r) * slope;
  }
  return normalize(vec3(-g.x * puddle, 1.0, -g.y * puddle));
}

// 1976 Blinn & Newell Equirectangular (latitude-longitude) distant neon-night skyline panorama
vec3 evalEquirectSky(vec3 dir) {
  vec3 d = normalize(dir);
  // Explicit equirectangular (longitude, latitude) projection as in Blinn & Newell (1976)
  float lon = atan(d.z, d.x) / (2.0 * PI) + 0.5;
  float lat = asin(clamp(d.y, -1.0, 1.0)) / PI + 0.5;

  vec3 zen = vec3(0.012, 0.025, 0.068);
  vec3 mid = vec3(0.035, 0.072, 0.165);
  vec3 hor = vec3(0.11, 0.20, 0.34);
  vec3 col = mix(hor, mid, smoothstep(0.50, 0.65, lat));
  col = mix(col, zen, smoothstep(0.65, 0.94, lat));
  col = mix(vec3(0.008, 0.014, 0.028), col, smoothstep(0.46, 0.51, lat));

  // Distant dark metropolitan skyline silhouette with subtle glowing skyscraper windows
  float cityCol = floor(lon * 48.0);
  float bH = 0.505 + hash12(vec2(cityCol, 3.1)) * 0.105;
  if (lat > 0.495 && lat < bH) {
    col *= 0.20;
    vec2 win = fract(vec2(lon * 48.0 * 3.0, (lat - 0.50) * 170.0));
    float lit = step(0.62, hash12(vec2(floor(lon * 144.0), floor(lat * 170.0))));
    float pane = step(0.24, win.x) * step(win.x, 0.76) * step(0.28, win.y) * step(win.y, 0.72);
    vec3 winCol = mix(vec3(0.18, 0.78, 0.95), vec3(0.95, 0.55, 0.20), hash12(vec2(cityCol, 9.7)));
    col += winCol * lit * pane * 0.55;
  }
  vec3 moonDir = normalize(vec3(0.32, 0.44, -0.84));
  float md = max(dot(d, moonDir), 0.0);
  col += vec3(0.35, 0.55, 0.88) * pow(md, 14.0) * 0.38;
  col += vec3(0.82, 0.92, 1.0) * pow(md, 200.0) * 1.15;
  float cloud = fbm2(vec2(lon * 10.0, lat * 6.0));
  col += vec3(0.06, 0.13, 0.24) * smoothstep(0.48, 0.82, cloud) * smoothstep(0.52, 0.78, lat) * 0.45;
  return col;
}

float iSphere(vec3 ro, vec3 rd, vec3 c, float r, out vec3 nOut) {
  vec3 oc = ro - c;
  float b = dot(oc, rd);
  float d2 = b * b - (dot(oc, oc) - r * r);
  if (d2 < 0.0) return INF;
  float sd = sqrt(d2);
  float t = -b - sd;
  if (t < 0.002) return INF;
  nOut = (ro + rd * t - c) / r;
  return t;
}

float iBox(vec3 ro, vec3 rd, vec3 bMin, vec3 bMax, out vec3 nOut) {
  vec3 inv = 1.0 / (rd + vec3(lessThan(abs(rd), vec3(1e-7))) * 1e-7);
  vec3 t0 = (bMin - ro) * inv;
  vec3 t1 = (bMax - ro) * inv;
  vec3 tSm = min(t0, t1);
  vec3 tBg = max(t0, t1);
  float tN = max(max(tSm.x, tSm.y), tSm.z);
  float tF = min(min(tBg.x, tBg.y), tBg.z);
  if (tF < max(tN, 0.002)) return INF;
  float t = (tN > 0.002) ? tN : tF;
  vec3 p = ro + rd * t;
  vec3 c = 0.5 * (bMin + bMax);
  vec3 h = 0.5 * (bMax - bMin);
  vec3 d = (p - c) / h;
  vec3 ad = abs(d);
  if (ad.x > ad.y && ad.x > ad.z) nOut = vec3(sign(d.x), 0.0, 0.0);
  else if (ad.y > ad.z) nOut = vec3(0.0, sign(d.y), 0.0);
  else nOut = vec3(0.0, 0.0, sign(d.z));
  return t;
}

float iCapsule(vec3 ro, vec3 rd, vec3 pa, vec3 pb, float r, out vec3 nOut) {
  vec3 ba = pb - pa;
  vec3 oa = ro - pa;
  float baba = dot(ba, ba);
  float bard = dot(ba, rd);
  float baoa = dot(ba, oa);
  float rdoa = dot(rd, oa);
  float oaoa = dot(oa, oa);
  float a = baba - bard * bard;
  float b = baba * rdoa - baoa * bard;
  float c = baba * oaoa - baoa * baoa - r * r * baba;
  float h = b * b - a * c;
  if (h >= 0.0) {
    float t = (-b - sqrt(h)) / max(a, 1e-6);
    float y = baoa + t * bard;
    if (t > 0.002 && y > 0.0 && y < baba) {
      vec3 p = ro + rd * t;
      nOut = normalize((p - pa) - ba * (y / baba));
      return t;
    }
    // Rounded spherical end-caps
    vec3 oc = (y <= 0.0) ? oa : ro - pb;
    float b2 = dot(rd, oc);
    float c2 = dot(oc, oc) - r * r;
    float h2 = b2 * b2 - c2;
    if (h2 > 0.0) {
      float tc = -b2 - sqrt(h2);
      if (tc > 0.002) {
        nOut = normalize((oc + rd * tc) / r);
        return tc;
      }
    }
  }
  return INF;
}

// Analytical Rain-Slicked Neon Courtyard Scene
//   perimeterOnly = true is used by baked static room cubemaps (1999 / 2012 / 2013) so the box probe cleanly captures
//   the perimeter archway & side walls without foreground interior objects corrupting the probe origin!
struct Hit {
  float t;
  vec3 pos;
  vec3 norm;
  int matId;
};

Hit traceScene(vec3 ro, vec3 rd, vec3 orbPos, bool includeDynamic, bool perimeterOnly) {
  Hit h;
  h.t = INF;
  h.matId = 0;
  h.norm = vec3(0.0, 1.0, 0.0);
  h.pos = ro + rd * 40.0;
  vec3 nTmp;

  // 1. Courtyard floor (y = 0)
  if (rd.y < -1e-5) {
    float tf = -ro.y / rd.y;
    if (tf > 0.002 && tf < 32.0 && tf < h.t) {
      h.t = tf; h.pos = ro + rd * tf; h.norm = vec3(0.0, 1.0, 0.0); h.matId = 1;
    }
  }

  // 2. Hero Tall Neon Archway Gantry (back wall plane z = -2.65 -> aligns cleanly with ROOM_MIN.z = -2.85!)
  float tL = iBox(ro, rd, vec3(-1.98, 0.0, -2.92), vec3(-1.60, 3.05, -2.44), nTmp);
  if (tL < h.t) { h.t = tL; h.pos = ro + rd * tL; h.norm = nTmp; h.matId = 2; }
  float tR = iBox(ro, rd, vec3( 1.60, 0.0, -2.92), vec3( 1.98, 3.05, -2.44), nTmp);
  if (tR < h.t) { h.t = tR; h.pos = ro + rd * tR; h.norm = nTmp; h.matId = 2; }
  float tTop = iBox(ro, rd, vec3(-2.14, 2.86, -2.96), vec3(2.14, 3.24, -2.40), nTmp);
  if (tTop < h.t) { h.t = tTop; h.pos = ro + rd * tTop; h.norm = nTmp; h.matId = 2; }

  // 3. Blazing CYAN Overhead Neon Bar + High Marquee Crown (exits top of viewport on Tilt Down -> dramatic SSR clip!)
  float tCyan1 = iCapsule(ro, rd, vec3(-1.64, 2.70, -2.52), vec3(1.64, 2.70, -2.52), 0.075, nTmp);
  if (tCyan1 < h.t) { h.t = tCyan1; h.pos = ro + rd * tCyan1; h.norm = nTmp; h.matId = 5; }
  float tCyan2 = iCapsule(ro, rd, vec3(-1.86, 3.42, -2.52), vec3(1.86, 3.42, -2.52), 0.088, nTmp);
  if (tCyan2 < h.t) { h.t = tCyan2; h.pos = ro + rd * tCyan2; h.norm = nTmp; h.matId = 5; }
  float tCyan3 = iCapsule(ro, rd, vec3(-0.92, 3.26, -2.52), vec3(-0.92, 3.66, -2.52), 0.056, nTmp);
  if (tCyan3 < h.t) { h.t = tCyan3; h.pos = ro + rd * tCyan3; h.norm = nTmp; h.matId = 5; }
  float tCyan4 = iCapsule(ro, rd, vec3( 0.92, 3.26, -2.52), vec3( 0.92, 3.66, -2.52), 0.056, nTmp);
  if (tCyan4 < h.t) { h.t = tCyan4; h.pos = ro + rd * tCyan4; h.norm = nTmp; h.matId = 5; }

  // 4. Blazing WARM AMBER Twin Vertical Archway Neon Tubes
  float tAmbL = iCapsule(ro, rd, vec3(-1.48, 0.14, -2.52), vec3(-1.48, 2.62, -2.52), 0.068, nTmp);
  if (tAmbL < h.t) { h.t = tAmbL; h.pos = ro + rd * tAmbL; h.norm = nTmp; h.matId = 6; }
  float tAmbR = iCapsule(ro, rd, vec3( 1.48, 0.14, -2.52), vec3( 1.48, 2.62, -2.52), 0.068, nTmp);
  if (tAmbR < h.t) { h.t = tAmbR; h.pos = ro + rd * tAmbR; h.norm = nTmp; h.matId = 6; }

  // 5. Blazing HOT-MAGENTA Tall Neon Totem (on left-center at z = -2.15, standing behind the dark monolith!)
  float tMag1 = iCapsule(ro, rd, vec3(-0.94, 0.16, -2.05), vec3(-0.94, 2.22, -2.05), 0.088, nTmp);
  if (tMag1 < h.t) { h.t = tMag1; h.pos = ro + rd * tMag1; h.norm = nTmp; h.matId = 7; }
  float tMag2 = iCapsule(ro, rd, vec3(-1.26, 0.92, -2.05), vec3(-0.62, 0.92, -2.05), 0.072, nTmp);
  if (tMag2 < h.t) { h.t = tMag2; h.pos = ro + rd * tMag2; h.norm = nTmp; h.matId = 7; }
  float tMag3 = iCapsule(ro, rd, vec3(-1.26, 1.62, -2.05), vec3(-0.62, 1.62, -2.05), 0.064, nTmp);
  if (tMag3 < h.t) { h.t = tMag3; h.pos = ro + rd * tMag3; h.norm = nTmp; h.matId = 7; }

  // 6. Rain-Damp Side Courtyard Walls (architectural frame & Parallax-Corrected Cubemap room box!)
  float tWL = iBox(ro, rd, vec3(-3.68, 0.0, -3.10), vec3(-3.26, 3.25, 2.60), nTmp);
  if (tWL < h.t) { h.t = tWL; h.pos = ro + rd * tWL; h.norm = nTmp; h.matId = 4; }
  float tWR = iBox(ro, rd, vec3( 3.26, 0.0, -3.10), vec3( 3.68, 3.25, 2.60), nTmp);
  if (tWR < h.t) { h.t = tWR; h.pos = ro + rd * tWR; h.norm = nTmp; h.matId = 4; }
  float tSideL = iCapsule(ro, rd, vec3(-3.20, 1.65, -2.30), vec3(-3.20, 1.65, 1.15), 0.056, nTmp);
  if (tSideL < h.t) { h.t = tSideL; h.pos = ro + rd * tSideL; h.norm = nTmp; h.matId = 5; }
  float tSideR = iCapsule(ro, rd, vec3( 3.20, 1.65, -2.30), vec3( 3.20, 1.65, 1.15), 0.056, nTmp);
  if (tSideR < h.t) { h.t = tSideR; h.pos = ro + rd * tSideR; h.norm = nTmp; h.matId = 6; }

  if (!perimeterOnly) {
    // 7. Foreground Dark Concrete SSR-Occluder Monolith (blocks camera's view of lower magenta totem -> giant SSR hole in puddle!)
    float tOcc = iBox(ro, rd, vec3(-1.32, 0.0, -0.45), vec3(-0.56, 1.48, -0.02), nTmp);
    if (tOcc < h.t) { h.t = tOcc; h.pos = ro + rd * tOcc; h.norm = nTmp; h.matId = 2; }

    // 8. Hero Polished/Brushed Chrome Sphere Sculpture on Right Plinth (proves Planar vs Cubemap vs 2-Bounce RT!)
    float tPlinth = iBox(ro, rd, vec3(0.46, 0.0, -0.82), vec3(1.52, 0.24, 0.22), nTmp);
    if (tPlinth < h.t) { h.t = tPlinth; h.pos = ro + rd * tPlinth; h.norm = nTmp; h.matId = 2; }
    float tSph = iSphere(ro, rd, vec3(0.99, 0.80, -0.30), 0.56, nTmp);
    if (tSph < h.t) { h.t = tSph; h.pos = ro + rd * tSph; h.norm = nTmp; h.matId = 3; }

    // 9. Dynamic Orbiting / Clickable Electric-Gold Plasma Orb (missing from 1999 & 2012 static cubemaps!)
    if (includeDynamic) {
      float tOrb = iSphere(ro, rd, orbPos, 0.25, nTmp);
      if (tOrb < h.t) { h.t = tOrb; h.pos = ro + rd * tOrb; h.norm = nTmp; h.matId = 8; }
    }
  }

  return h;
}

void evalMaterial(Hit h, float t, float wetness, float roughBoost, out vec3 alb, out float rough, out float metal, out vec3 N, out vec3 emissive, out float puddle) {
  N = normalize(h.norm);
  alb = vec3(0.08);
  rough = 0.65;
  metal = 0.0;
  emissive = vec3(0.0);
  puddle = 0.0;

  if (h.matId == 1) {
    // Dark rain-slicked basalt courtyard tiles + organic mirror puddles
    vec2 tileUv = h.pos.xz * 1.05;
    vec2 tf = abs(fract(tileUv) - 0.5);
    float grout = smoothstep(0.455, 0.492, max(tf.x, tf.y));
    float tileId = hash12(floor(tileUv));
    float micro = vNoise(h.pos.xz * 18.0);
    puddle = evalPuddleMask(h.pos.xz, wetness);
    vec3 dryCol = vec3(0.082, 0.095, 0.122) * (0.85 + 0.30 * tileId) * (0.9 + 0.2 * micro);
    vec3 wetCol = vec3(0.020, 0.026, 0.040);
    alb = mix(dryCol, wetCol, puddle * 0.86) * (1.0 - grout * 0.65);
    float dryRough = clamp(0.44 + 0.16 * micro + roughBoost * 0.22, 0.28, 0.85);
    float wetRough = clamp(0.022 + roughBoost * 0.18, 0.02, 0.30);
    rough = mix(dryRough, wetRough, puddle);
    vec3 pn = evalPuddleNormal(h.pos.xz, t, puddle);
    N = normalize(mix(vec3((micro - 0.5) * 0.05, 1.0, (vNoise(h.pos.xz * 19.0 + 7.1) - 0.5) * 0.05), pn, puddle));
  } else if (h.matId == 2) {
    // Matte architectural dark concrete monolith, gantry, and plinth
    float grain = vNoise(h.pos.xy * 10.0 + h.pos.z * 7.0);
    float seam = smoothstep(0.47, 0.50, abs(fract(h.pos.y * 2.2) - 0.5));
    alb = vec3(0.092, 0.102, 0.122) * (0.88 + 0.24 * grain) * (1.0 - seam * 0.35);
    rough = 0.78;
    metal = 0.04;
  } else if (h.matId == 3) {
    // Hero Chrome Sphere with subtle brushed equatorial band (showcases roughness & 2-bounce reflections!)
    vec3 rel = normalize(h.pos - vec3(0.99, 0.80, -0.30));
    float band = smoothstep(0.18, 0.24, abs(rel.y));
    alb = mix(vec3(0.76, 0.80, 0.88), vec3(0.93, 0.95, 0.99), band);
    rough = mix(0.24, 0.035, band);
    rough = clamp(rough + roughBoost * 0.18, 0.03, 0.55);
    metal = 0.96;
  } else if (h.matId == 4) {
    // Matte ribbed concrete courtyard side walls (kept properly rough so reflections stay cleanly on floor & chrome!)
    float rib = sin(h.pos.z * 14.0) * 0.5 + 0.5;
    float damp = smoothstep(2.4, 0.1, h.pos.y);
    alb = vec3(0.072, 0.084, 0.110) * (0.82 + 0.30 * rib) * mix(1.0, 0.72, damp);
    rough = mix(0.86, 0.72, damp);
    metal = 0.02;
  } else if (h.matId == 5) {
    alb = vec3(0.4, 0.95, 1.0);
    emissive = vec3(0.22, 3.85, 4.95);
    rough = 0.15;
  } else if (h.matId == 6) {
    alb = vec3(1.0, 0.72, 0.28);
    emissive = vec3(4.85, 1.95, 0.24);
    rough = 0.15;
  } else if (h.matId == 7) {
    alb = vec3(1.0, 0.35, 0.78);
    emissive = vec3(5.45, 0.30, 2.50);
    rough = 0.15;
  } else if (h.matId == 8) {
    alb = vec3(1.0, 0.90, 0.55);
    emissive = vec3(5.65, 3.45, 0.65);
    rough = 0.10;
  }
}

vec3 shadeDirect(vec3 P, vec3 N, vec3 V, vec3 alb, float rough, float metal, vec3 emissive, vec3 orbPos, bool includeOrb) {
  if (dot(emissive, emissive) > 0.01) return emissive;

  vec3 diff = alb * (1.0 - metal * 0.88);
  vec3 F0 = mix(vec3(0.04), alb, metal);
  vec3 col = diff * (vec3(0.045, 0.075, 0.145) * (0.55 + 0.45 * N.y));

  vec3 lPos[4];
  vec3 lCol[4];
  lPos[0] = vec3(0.0, 2.70, -2.45);  lCol[0] = vec3(0.25, 2.45, 3.15);
  lPos[1] = vec3(1.42, 1.45, -2.45); lCol[1] = vec3(2.85, 1.25, 0.20);
  lPos[2] = vec3(-0.94, 1.25, -1.95); lCol[2] = vec3(3.25, 0.22, 1.55);
  lPos[3] = orbPos;                   lCol[3] = includeOrb ? vec3(3.45, 2.15, 0.45) : vec3(0.0);

  float a2 = max(rough * rough, 0.015);
  for (int i = 0; i < 4; i++) {
    if (dot(lCol[i], lCol[i]) < 0.001) continue;
    vec3 toL = lPos[i] - P;
    float d2 = dot(toL, toL) + 0.55;
    vec3 L = normalize(toL);
    float ndl = max(dot(N, L), 0.0);
    if (ndl <= 0.0) continue;
    float att = 1.0 / d2;
    vec3 H = normalize(L + V);
    float ndh = max(dot(N, H), 0.0);
    float denom = ndh * ndh * (a2 - 1.0) + 1.0;
    float D = a2 / (PI * denom * denom + 1e-4);
    vec3 F = F0 + (1.0 - F0) * pow(1.0 - max(dot(H, V), 0.0), 5.0);
    vec3 spec = F * min(D * 0.24, 6.0);
    col += (diff * (1.0 / PI) + spec) * lCol[i] * ndl * att;
  }
  return col;
}

// Karis (SIGGRAPH 2013) Split-Sum Environmental BRDF Approximation
vec3 envBRDFApprox(vec3 F0, float rough, float ndv) {
  vec4 c0 = vec4(-1.0, -0.0275, -0.572, 0.022);
  vec4 c1 = vec4( 1.0,  0.0425,  1.040, -0.040);
  vec4 r = rough * c0 + c1;
  float a004 = min(r.x * r.x, exp2(-9.28 * ndv)) * r.x + r.y;
  vec2 ab = vec2(-1.04, 1.04) * a004 + r.zw;
  return F0 * ab.x + vec3(ab.y);
}

vec3 rayForUv(vec2 uv, vec3 camFwd, vec3 camRight, vec3 camUp, float aspect, float tanHalfFov) {
  vec2 ndc = uv * 2.0 - 1.0;
  return normalize(camFwd + ndc.x * aspect * tanHalfFov * camRight + ndc.y * tanHalfFov * camUp);
}
`;

// ============================================================================
// PASS 1: G-BUFFER (Primary Direct-Lit Color + Linear Depth + Roughness + MatId)
// ============================================================================
export const GBUFFER_FS = `#version 300 es
precision highp float;
precision highp int;

in vec2 vUv;
uniform vec3 uCamPos;
uniform vec3 uCamRight;
uniform vec3 uCamUp;
uniform vec3 uCamFwd;
uniform float uTanHalfFov;
uniform float uAspect;
uniform float uTime;
uniform float uWetness;
uniform float uRoughBoost;
uniform vec3 uOrbPos;

layout(location = 0) out vec4 outColor;
layout(location = 1) out vec4 outDepth;

${SCENE_COMMON}

void main() {
  vec3 rd = rayForUv(vUv, uCamFwd, uCamRight, uCamUp, uAspect, uTanHalfFov);
  Hit h = traceScene(uCamPos, rd, uOrbPos, true, false);
  if (h.matId == 0) {
    outColor = vec4(evalEquirectSky(rd), 1.0);
    outDepth = vec4(99.0, 1.0, 0.0, 0.0);
    return;
  }
  vec3 alb, N, emissive;
  float rough, metal, puddle;
  evalMaterial(h, uTime, uWetness, uRoughBoost, alb, rough, metal, N, emissive, puddle);
  vec3 direct = shadeDirect(h.pos, N, -rd, alb, rough, metal, emissive, uOrbPos, true);
  outColor = vec4(direct, 1.0);
  outDepth = vec4(h.t, rough, float(h.matId), puddle);
}
`;

// ============================================================================
// PASS 2: ALL 8 REFLECTION ERAS
// ============================================================================
export const REFLECT_FS = `#version 300 es
precision highp float;
precision highp int;

in vec2 vUv;
uniform sampler2D uGColor;
uniform sampler2D uGDepth;
uniform vec3 uCamPos;
uniform vec3 uCamRight;
uniform vec3 uCamUp;
uniform vec3 uCamFwd;
uniform vec3 uPrevCamPos;
uniform vec3 uPrevCamRight;
uniform vec3 uPrevCamUp;
uniform vec3 uPrevCamFwd;
uniform float uTanHalfFov;
uniform float uAspect;
uniform vec2 uRes;
uniform float uTime;
uniform float uWetness;
uniform float uRoughBoost;
uniform vec3 uOrbPos;
uniform int uStageLeft;
uniform int uStageRight;
uniform float uSplitX;
uniform int uFrameIdx;

layout(location = 0) out vec4 outColor;
layout(location = 1) out vec4 outVelocity;

${SCENE_COMMON}

vec2 projectToUv(vec3 worldPos, vec3 cPos, vec3 cRight, vec3 cUp, vec3 cFwd, out float linZ) {
  vec3 d = worldPos - cPos;
  linZ = dot(d, cFwd);
  if (linZ < 0.02) return vec2(-10.0);
  float x = dot(d, cRight) / (linZ * uAspect * uTanHalfFov);
  float y = dot(d, cUp) / (linZ * uTanHalfFov);
  return vec2(x, y) * 0.5 + 0.5;
}

// Static courtyard room cubemap captured at PROBE_POS (perimeter archway & walls only; no dynamic orb or interior occluders!)
vec3 evalStaticProbe(vec3 dir, float mipRough) {
  Hit h = traceScene(PROBE_POS, normalize(dir), vec3(0.0, -99.0, 0.0), false, true);
  if (h.matId == 0) {
    vec3 sky = evalEquirectSky(dir);
    return mix(sky, vec3(0.042, 0.075, 0.150), clamp(mipRough * 0.85, 0.0, 0.75));
  }
  vec3 alb, N, emissive;
  float rough, metal, puddle;
  evalMaterial(h, uTime, uWetness, uRoughBoost, alb, rough, metal, N, emissive, puddle);
  vec3 c = shadeDirect(h.pos, N, -normalize(dir), alb, rough, metal, emissive, vec3(0.0, -99.0, 0.0), false);
  // Pre-filtered GGX mip attenuation spreads thin emissive tubes softly over rougher lobes instead of sharp streaks!
  if (mipRough > 0.12 && dot(emissive, emissive) > 0.1) {
    c /= (1.0 + mipRough * mipRough * 10.0);
  }
  return mix(c, c * 0.55 + vec3(0.04, 0.07, 0.14), clamp(mipRough * 0.70, 0.0, 0.62));
}

// Parallax-Corrected Cubemap (Bjorke GPU Gems 2004; popularized by Lagarde & Zanuttini SIGGRAPH 2012)
vec3 parallaxCorrectDir(vec3 P, vec3 R) {
  vec3 invR = 1.0 / (R + vec3(lessThan(abs(R), vec3(1e-6))) * 1e-6);
  vec3 t0 = (ROOM_MIN - P) * invR;
  vec3 t1 = (ROOM_MAX - P) * invR;
  vec3 tMax = max(t0, t1);
  float tHit = min(min(tMax.x, tMax.y), tMax.z);
  vec3 boxHit = P + R * max(tHit, 0.05);
  return normalize(boxHit - PROBE_POS);
}

// GGX pre-filtered Split-Sum IBL lobe (Karis UE4, SIGGRAPH 2013)
vec3 evalSplitSumIBL(vec3 P, vec3 R, float rough) {
  if (rough < 0.08) {
    return evalStaticProbe(parallaxCorrectDir(P, R), rough);
  }
  vec3 up = abs(R.y) < 0.99 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0);
  vec3 T = normalize(cross(up, R));
  vec3 B = cross(R, T);
  float spread = rough * rough * 0.68;
  vec3 acc = evalStaticProbe(parallaxCorrectDir(P, R), rough) * 0.36;
  const vec2 offs[4] = vec2[4](
    vec2( 1.0,  0.3), vec2(-1.0, -0.3),
    vec2(-0.3,  1.0), vec2( 0.3, -1.0)
  );
  for (int i = 0; i < 4; i++) {
    vec3 rd = normalize(R + (T * offs[i].x + B * offs[i].y) * spread);
    acc += evalStaticProbe(parallaxCorrectDir(P, rd), rough) * 0.16;
  }
  return acc;
}

// GENUINE 2011 SCREEN-SPACE REFLECTIONS (Crysis 2 DX11):
// Marches reflection ray directly in screen space against Pass 1's depth & color buffers!
vec3 evalSSR(vec3 P, vec3 R, vec3 N, out float hitConf) {
  hitConf = 0.0;
  vec3 rayO = P + N * 0.035;
  float maxDist = 7.8;
  const int STEPS = 60;
  float stepLen = maxDist / float(STEPS);
  float jitter = hash12(gl_FragCoord.xy) * 0.65;

  float prevT = 0.0;
  vec2 hitUv = vec2(0.0);
  bool found = false;

  for (int i = 1; i <= STEPS; i++) {
    float t = (float(i) - jitter) * stepLen;
    vec3 sp = rayO + R * t;
    float linZ;
    vec2 uv = projectToUv(sp, uCamPos, uCamRight, uCamUp, uCamFwd, linZ);
    if (uv.x < 0.002 || uv.x > 0.998 || uv.y < 0.002 || uv.y > 0.998 || linZ <= 0.05) {
      break;
    }
    vec4 gd = texture(uGDepth, uv);
    float bufT = gd.r;
    float rayCamDist = length(sp - uCamPos);
    float diff = rayCamDist - bufT;
    if (diff > 0.015 && diff < 0.34 && bufT < 40.0) {
      float lo = prevT, hi = t;
      for (int b = 0; b < 5; b++) {
        float mid = 0.5 * (lo + hi);
        vec3 mp = rayO + R * mid;
        float mz;
        vec2 muv = projectToUv(mp, uCamPos, uCamRight, uCamUp, uCamFwd, mz);
        if (muv.x < 0.001 || muv.x > 0.999 || muv.y < 0.001 || muv.y > 0.999) { lo = mid; continue; }
        float mb = texture(uGDepth, muv).r;
        if (length(mp - uCamPos) > mb) hi = mid; else lo = mid;
      }
      vec3 fp = rayO + R * hi;
      float fz;
      hitUv = projectToUv(fp, uCamPos, uCamRight, uCamUp, uCamFwd, fz);
      float finalDiff = length(fp - uCamPos) - texture(uGDepth, hitUv).r;
      if (hitUv.x > 0.002 && hitUv.x < 0.998 && hitUv.y > 0.002 && hitUv.y < 0.998 && abs(finalDiff) < 0.24) {
        found = true;
      }
      break;
    }
    prevT = t;
  }

  if (!found) {
    return evalEquirectSky(R) * 0.36;
  }
  vec2 edge = smoothstep(vec2(0.0), vec2(0.045), hitUv) * smoothstep(vec2(0.0), vec2(0.045), 1.0 - hitUv);
  hitConf = clamp(edge.x * edge.y, 0.0, 1.0);
  vec3 hitCol = texture(uGColor, hitUv).rgb;
  return mix(evalEquirectSky(R) * 0.36, hitCol, hitConf);
}

// Analytical 1-bounce Hardware Ray-Traced reflection (Battlefield V DXR 2018)
vec3 evalRT1Bounce(vec3 P, vec3 R, vec3 N, out float hitDist) {
  Hit rh = traceScene(P + N * 0.008, R, uOrbPos, true, false);
  hitDist = rh.t;
  if (rh.matId == 0) return evalEquirectSky(R);
  vec3 alb, rN, emissive;
  float rough, metal, puddle;
  evalMaterial(rh, uTime, uWetness, uRoughBoost, alb, rough, metal, rN, emissive, puddle);
  vec3 col = shadeDirect(rh.pos, rN, -R, alb, rough, metal, emissive, uOrbPos, true);
  // 1-bounce limit: reflected chrome sphere shows dim sky only (NO mirror-in-mirror yet!)
  if (rh.matId == 3) {
    vec3 R2 = reflect(R, rN);
    col += alb * evalEquirectSky(R2) * 0.58;
  }
  return col;
}

vec3 sampleGGX(vec3 N, float rough, vec2 xi) {
  float a = max(rough * rough, 0.002);
  float phi = 2.0 * PI * xi.x;
  float cosT = sqrt((1.0 - xi.y) / (1.0 + (a * a - 1.0) * xi.y));
  float sinT = sqrt(max(0.0, 1.0 - cosT * cosT));
  vec3 up = abs(N.y) < 0.99 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0);
  vec3 T = normalize(cross(up, N));
  vec3 B = cross(N, T);
  return normalize(T * (cos(phi) * sinT) + B * (sin(phi) * sinT) + N * cosT);
}

// 2022-2026 Multi-Bounce Glossy RT (UE5 Lumen 2022 / Cyberpunk RT Overdrive 2023)
vec3 evalRTMultiBounce(vec3 P, vec3 V, vec3 N, float rough) {
  vec2 pix = gl_FragCoord.xy;
  float ft = float(uFrameIdx & 63);
  vec2 xi = fract(vec2(
    hash12(pix) + ft * 0.7548776662,
    hash12(pix + vec2(37.2, 19.8)) + ft * 0.5698402909
  ));
  xi.y = xi.y * 0.85;

  vec3 H = sampleGGX(N, rough, xi);
  vec3 R = reflect(-V, H);
  if (dot(R, N) <= 0.01) R = reflect(-V, N);

  Hit rh = traceScene(P + N * 0.008, R, uOrbPos, true, false);
  if (rh.matId == 0) return evalEquirectSky(R);

  vec3 alb, rN, emissive;
  float rRough, rMetal, rPuddle;
  evalMaterial(rh, uTime, uWetness, uRoughBoost, alb, rRough, rMetal, rN, emissive, rPuddle);
  vec3 col = shadeDirect(rh.pos, rN, -R, alb, rRough, rMetal, emissive, uOrbPos, true);

  // TRUE 2ND BOUNCE (mirror-inside-mirror!): puddle reflection of chrome sphere reflects the full neon courtyard!
  if (rh.matId == 3 || (rh.matId == 1 && rPuddle > 0.3)) {
    vec3 R2 = reflect(R, rN);
    Hit rh2 = traceScene(rh.pos + rN * 0.008, R2, uOrbPos, true, false);
    vec3 b2 = evalEquirectSky(R2);
    if (rh2.matId != 0) {
      vec3 a2, n2, e2;
      float ro2, m2, pu2;
      evalMaterial(rh2, uTime, uWetness, uRoughBoost, a2, ro2, m2, n2, e2, pu2);
      b2 = shadeDirect(rh2.pos, n2, -R2, a2, ro2, m2, e2, uOrbPos, true);
    }
    vec3 F2 = envBRDFApprox(mix(vec3(0.025), alb, rMetal), rRough, max(dot(rN, -R), 0.02));
    col += b2 * F2;
  }
  return col;
}

void main() {
  bool useLeft = (uSplitX >= 0.995) || ((uSplitX > 0.005) && (vUv.x < uSplitX));
  int st = useLeft ? uStageLeft : uStageRight;

  vec3 rd = rayForUv(vUv, uCamFwd, uCamRight, uCamUp, uAspect, uTanHalfFov);
  Hit h = traceScene(uCamPos, rd, uOrbPos, true, false);

  float prevZ;
  vec2 prevUv = (h.matId == 0)
    ? projectToUv(uCamPos + rd * 80.0, uPrevCamPos, uPrevCamRight, uPrevCamUp, uPrevCamFwd, prevZ)
    : projectToUv(h.pos, uPrevCamPos, uPrevCamRight, uPrevCamUp, uPrevCamFwd, prevZ);
  vec2 vel = vUv - prevUv;
  outVelocity = vec4(vel, h.t < INF ? h.t : 99.0, (h.matId == 8) ? 1.0 : 0.0);

  if (h.matId == 0) {
    outColor = vec4(evalEquirectSky(rd), 1.0);
    return;
  }

  vec3 alb, N, emissive;
  float rough, metal, puddle;
  evalMaterial(h, uTime, uWetness, uRoughBoost, alb, rough, metal, N, emissive, puddle);

  vec3 V = -rd;
  vec3 direct = shadeDirect(h.pos, N, V, alb, rough, metal, emissive, uOrbPos, true);
  if (dot(emissive, emissive) > 0.01) {
    outColor = vec4(direct, 1.0);
    return;
  }

  vec3 R = reflect(-V, N);
  float ndv = max(dot(N, V), 0.02);
  vec3 F0 = mix(vec3(h.matId == 1 ? mix(0.04, 0.028, puddle) : 0.04), alb, metal);

  vec3 reflCol = vec3(0.0);
  vec3 reflWeight = vec3(0.0);

  if (st == 0) {
    // ERA 1 (1976): Blinn & Newell Equirectangular Environment Map
    reflCol = evalEquirectSky(R);
    float fres = mix(0.10, 0.85, pow(1.0 - ndv, 3.0));
    float mask = (h.matId == 1) ? puddle * 0.94 : (h.matId == 3 ? 0.96 : 0.03);
    reflWeight = mix(vec3(fres), alb, metal) * mask;
  } else if (st == 1) {
    // ERA 2 (1996): Planar Portal Mirror (Duke Nukem 3D 1996 / Unreal 1998)
    if (h.matId == 1) {
      vec3 flatR = reflect(-V, vec3(0.0, 1.0, 0.0));
      float dHit;
      reflCol = evalRT1Bounce(h.pos, flatR, vec3(0.0, 1.0, 0.0), dHit);
      reflWeight = vec3(mix(0.08, 0.65, puddle));
    } else if (h.matId == 3) {
      reflCol = evalEquirectSky(R) * 0.72;
      reflWeight = alb * 0.78;
    } else {
      reflCol = evalEquirectSky(R) * 0.20;
      reflWeight = vec3(0.02);
    }
  } else if (st == 2) {
    // ERA 3 (1999): Hardware Cubemaps (GeForce 256 / DX7)
    reflCol = evalStaticProbe(R, 0.04);
    float fres = mix(0.12, 0.90, pow(1.0 - ndv, 3.2));
    float mask = (h.matId == 1) ? mix(0.015, 0.92, puddle) : (h.matId == 3 ? 0.96 : 0.02);
    reflWeight = mix(vec3(fres), alb, metal) * mask;
  } else if (st == 3) {
    // ERA 4 (2011): Screen-Space Reflections / SSR (Crysis 2 DX11)
    float hitConf;
    if (h.matId == 1 || h.matId == 3) {
      reflCol = evalSSR(h.pos, R, N, hitConf);
    } else {
      reflCol = evalEquirectSky(R) * 0.25;
    }
    float fres = mix(0.14, 0.94, pow(1.0 - ndv, 3.8));
    float mask = (h.matId == 1) ? mix(0.015, 0.95, puddle) : (h.matId == 3 ? 0.95 : 0.02);
    reflWeight = mix(vec3(fres), alb, metal) * mask;
  } else if (st == 4) {
    // ERA 5 (2012): Parallax-Corrected Cubemaps (Bjorke 2004 · Lagarde & Zanuttini SIGGRAPH 2012)
    vec3 pDir = parallaxCorrectDir(h.pos, R);
    reflCol = evalStaticProbe(pDir, 0.04);
    float fres = mix(0.14, 0.94, pow(1.0 - ndv, 3.8));
    float mask = (h.matId == 1) ? mix(0.015, 0.95, puddle) : (h.matId == 3 ? 0.96 : 0.02);
    reflWeight = mix(vec3(fres), alb, metal) * mask;
  } else if (st == 5) {
    // ERA 6 (2013): Split-Sum Roughness IBL (Brian Karis / UE4, SIGGRAPH 2013)
    if (h.matId == 1 || h.matId == 3) {
      reflCol = evalSplitSumIBL(h.pos, R, rough);
      reflWeight = envBRDFApprox(F0, rough, ndv);
      if (h.matId == 1) reflWeight *= mix(1.05, 1.55, puddle);
    } else {
      reflCol = evalEquirectSky(R) * 0.25;
      reflWeight = envBRDFApprox(F0, rough, ndv) * 0.35;
    }
  } else if (st == 6) {
    // ERA 7 (2018): Hardware Ray-Traced Reflections (Battlefield V DXR)
    float hitDist;
    if (h.matId == 3 || (h.matId == 1 && (puddle > 0.18 || rough < 0.42))) {
      reflCol = evalRT1Bounce(h.pos, R, N, hitDist);
      reflWeight = envBRDFApprox(F0, rough, ndv);
      if (h.matId == 1) reflWeight *= mix(1.05, 1.55, puddle);
    } else if (h.matId == 1) {
      reflCol = evalSplitSumIBL(h.pos, R, rough);
      reflWeight = envBRDFApprox(F0, rough, ndv);
    } else {
      reflCol = evalEquirectSky(R) * 0.25;
      reflWeight = envBRDFApprox(F0, rough, ndv) * 0.35;
    }
  } else {
    // ERA 8 (2022-26): Multi-Bounce Glossy RT (UE5 Lumen 2022 / Cyberpunk RT Overdrive 2023)
    if (h.matId == 1 || h.matId == 3) {
      reflCol = evalRTMultiBounce(h.pos, V, N, rough);
      reflWeight = envBRDFApprox(F0, rough, ndv);
      if (h.matId == 1) reflWeight *= mix(1.05, 1.60, puddle);
    } else {
      reflCol = evalRTMultiBounce(h.pos, V, N, rough);
      reflWeight = envBRDFApprox(F0, rough, ndv) * 0.40;
    }
  }

  vec3 finalCol = direct + reflCol * reflWeight;
  outColor = vec4(max(finalCol, vec3(0.0)), 1.0);
}
`;

// ============================================================================
// PASS 3A: TEMPORAL ACCUMULATION FOR STAGE 7 STOCHASTIC GLOSSY RT (Zero-Shake!)
// ============================================================================
export const ACCUM_FS = `#version 300 es
precision highp float;
precision highp int;

in vec2 vUv;
uniform sampler2D uCur;
uniform sampler2D uVel;
uniform sampler2D uHist;
uniform vec2 uTexel;
uniform int uStageLeft;
uniform int uStageRight;
uniform float uSplitX;
uniform float uHistoryValid;
out vec4 outColor;

vec3 tonemapK(vec3 c) { float l = max(c.r, max(c.g, c.b)); return c / (1.0 + l); }
vec3 invTonemapK(vec3 c) { float l = min(max(c.r, max(c.g, c.b)), 0.99); return c / max(1.0 - l, 0.01); }

void main() {
  bool useLeft = (uSplitX >= 0.995) || ((uSplitX > 0.005) && (vUv.x < uSplitX));
  int st = useLeft ? uStageLeft : uStageRight;
  vec3 cur = texture(uCur, vUv).rgb;

  if (st != 7 || uHistoryValid < 0.5) {
    outColor = vec4(cur, 1.0);
    return;
  }

  vec4 v = texture(uVel, vUv);
  vec2 prevUv = vUv - v.rg;
  bool offScreen = (prevUv.x < 0.002 || prevUv.x > 0.998 || prevUv.y < 0.002 || prevUv.y > 0.998);
  bool crossedSplit = (uSplitX > 0.005 && uSplitX < 0.995) && ((prevUv.x < uSplitX) != useLeft);
  if (offScreen || crossedSplit) {
    outColor = vec4(cur, 1.0);
    return;
  }

  vec3 m1 = vec3(0.0), m2 = vec3(0.0);
  for (int dy = -1; dy <= 1; dy++) {
    for (int dx = -1; dx <= 1; dx++) {
      vec3 s = tonemapK(texture(uCur, clamp(vUv + vec2(float(dx), float(dy)) * uTexel, vec2(0.002), vec2(0.998))).rgb);
      m1 += s;
      m2 += s * s;
    }
  }
  vec3 mu = m1 / 9.0;
  vec3 sig = sqrt(max(m2 / 9.0 - mu * mu, vec3(0.0)));
  vec3 lo = max(mu - sig * 1.85, vec3(0.0));
  vec3 hi = mu + sig * 1.85;

  vec3 histK = clamp(tonemapK(texture(uHist, prevUv).rgb), lo, hi);
  vec3 curK = tonemapK(cur);
  float motion = length(v.rg);
  float alpha = mix(0.11, 0.38, clamp(motion * 45.0 + v.a, 0.0, 1.0));
  outColor = vec4(max(invTonemapK(mix(histK, curK, alpha)), vec3(0.0)), 1.0);
}
`;

// ============================================================================
// PASS 3B: ACES FILMIC TONE-MAPPING + SMOOTH DUAL-RING NEON BLOOM
// ============================================================================
export const FINAL_FS = `#version 300 es
precision highp float;
precision highp int;

in vec2 vUv;
uniform sampler2D uSrc;
uniform vec2 uTexel;
out vec4 outColor;

vec3 aces(vec3 x) {
  return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0);
}

void main() {
  vec3 c = texture(uSrc, vUv).rgb;
  // Smooth dual-ring 12-tap neon bloom (no jagged end caps!)
  vec3 glow = vec3(0.0);
  const vec2 ring1[6] = vec2[6](
    vec2( 1.0,  0.0), vec2(-1.0,  0.0),
    vec2( 0.5,  0.866), vec2(-0.5,  0.866),
    vec2( 0.5, -0.866), vec2(-0.5, -0.866)
  );
  for (int i = 0; i < 6; i++) {
    vec3 s1 = texture(uSrc, clamp(vUv + ring1[i] * uTexel * 1.8, vec2(0.002), vec2(0.998))).rgb;
    vec3 s2 = texture(uSrc, clamp(vUv + ring1[i].yx * uTexel * 4.2, vec2(0.002), vec2(0.998))).rgb;
    glow += max(s1 - vec3(1.15), vec3(0.0)) * 0.032;
    glow += max(s2 - vec3(1.25), vec3(0.0)) * 0.018;
  }
  c += glow;
  vec3 col = pow(aces(c * 0.94), vec3(1.0 / 2.2));
  outColor = vec4(col, 1.0);
}
`;
