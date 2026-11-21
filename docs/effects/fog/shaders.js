// Evolution of Fog & Volumetric Lighting (1997-2026) — Analytical & Multi-Pass WebGL2 Shaders:
// - Pass 1 (SCENE_FS): Primary gothic clockwork cathedral hall -> HDR direct color + depth / window-light occlusion mask.
// - Pass 2 (VOL_FS): All 8 fact-checked volumetric eras (supports live split-screen comparison):
//     0: 1997 Distance Depth Fog (Turok 1997 / Silent Hill 1999; OpenGL 1.0 fog 1992 — masks short far clip!)
//     1: 2002 Analytical Aerial Perspective (Hoffman & Preetham, GDC 2002 / SIGGRAPH 2003 — Rayleigh + Mie scattering)
//     2: 2004 Shadow-Map / Slice Light Shafts (Dobashi '02 / James '03 / ATI GDC '04 — pre-2007 3D slices, coarse banding!)
//     3: 2007 Screen-Space Light Scattering (Kenny Mitchell, GPU Gems 3 Ch. 13 — real radial blur; fades smoothly when looking away!)
//     4: 2009 Raymarched Volumetric Shadows (Tóth & Umenhoffer, Eurographics 2009 — 3D shadow march + interleaved sampling!)
//     5: 2014 Temporal Froxel Volumetric Fog (Bart Wronski, SIGGRAPH 2014 / AC IV — 160x90x64-style froxels + HG phase, WebGL2 emulated)
//     6: 2015 Heterogeneous Media & Local Lights (Sébastien Hillaire / Frostbite, SIGGRAPH 2015 — 3D swirling fog + local colored lights)
//     7: 2020-26 Multi-Scattering & Stained-Glass Volumetrics (Hillaire, EGSR 2020 -> modern engines — multi-scatter + colored glass!)
// - Pass 3 (FINAL_FS): Soft bloom + ACES Filmic tone-mapping.

const HALL_COMMON = /* glsl */`
const float INF = 1e9;
const float PI  = 3.14159265;
const vec3 WIN_CENTER = vec3(-0.25, 2.38, -4.20);
const float WIN_RADIUS = 1.28;
const vec3 LAMP_AMBER = vec3( 1.72, 0.84, -0.75);
const vec3 LAMP_CYAN  = vec3(-1.78, 0.96,  0.45);

float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

float hash13(vec3 p3) {
  p3 = fract(p3 * 0.1031);
  p3 += dot(p3, p3.zyx + 31.32);
  return fract((p3.x + p3.y) * p3.z);
}

float noise3(vec3 p) {
  vec3 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float n000 = hash13(i);
  float n100 = hash13(i + vec3(1,0,0));
  float n010 = hash13(i + vec3(0,1,0));
  float n110 = hash13(i + vec3(1,1,0));
  float n001 = hash13(i + vec3(0,0,1));
  float n101 = hash13(i + vec3(1,0,1));
  float n011 = hash13(i + vec3(0,1,1));
  float n111 = hash13(i + vec3(1,1,1));
  return mix(
    mix(mix(n000, n100, f.x), mix(n010, n110, f.x), f.y),
    mix(mix(n001, n101, f.x), mix(n011, n111, f.x), f.y),
    f.z
  );
}

float fbm3(vec3 p) {
  float v = 0.0, a = 0.5;
  for (int i = 0; i < 3; i++) {
    v += a * noise3(p);
    p = p * 2.04 + vec3(13.1, 7.3, 5.7);
    a *= 0.5;
  }
  return v;
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

float iSphere(vec3 ro, vec3 rd, vec3 c, float r, out vec3 nOut) {
  vec3 oc = ro - c;
  float b = dot(oc, rd);
  float d2 = b * b - (dot(oc, oc) - r * r);
  if (d2 < 0.0) return INF;
  float t = -b - sqrt(d2);
  if (t < 0.002) return INF;
  nOut = (ro + rd * t - c) / r;
  return t;
}

// Gothic Rose Window aperture + tracery spokes + slowly rotating iron clockwork gear!
// Returns vec4(rgbTransmission, openMask [0=stone/iron shadow, 1=open glass])
vec4 evalRoseWindow(vec2 pRel, float t, bool stainedGlass) {
  float r = length(pRel);
  if (r > WIN_RADIUS) return vec4(0.0);
  float ang = atan(pRel.y, pRel.x);

  // Outer carved stone ring + concentric inner ring + 8 gothic radial mullions
  float outerRim = smoothstep(WIN_RADIUS, WIN_RADIUS - 0.06, r);
  float midRing = smoothstep(0.045, 0.075, abs(r - 0.62));
  float hub = smoothstep(0.16, 0.21, r);
  float spokes = smoothstep(0.042, 0.072, abs(sin(ang * 4.0)) * r);

  // Slowly rotating iron clockwork cross/gear behind the window -> dynamically slices volumetric sunbeams!
  float gAng = ang - t * 0.34906585; // Exact 2 revolutions per 36.0s (seamless periodic!)
  float gearBlades = smoothstep(0.065, 0.095, abs(sin(gAng * 2.0)) * r);
  float gearRing = smoothstep(0.042, 0.068, abs(r - 0.94));
  float openMask = outerRim * midRing * hub * spokes * gearBlades * gearRing;

  if (!stainedGlass) {
    // Warm sunlit golden-white cathedral daylight
    return vec4(vec3(1.0, 0.88, 0.68) * openMask, openMask);
  }

  // Stage 7 (2020-26): Rich jewel-toned stained-glass rose window (deep ruby, sapphire, molten gold, emerald!)
  float sector = floor(mod((ang + PI) / (2.0 * PI) * 8.0, 8.0));
  vec3 glassCol;
  if (r < 0.62) {
    glassCol = (mod(sector, 2.0) < 0.5) ? vec3(1.15, 0.62, 0.05) : vec3(1.15, 0.06, 0.16);
  } else {
    float m4 = mod(sector, 4.0);
    if (m4 < 0.5) glassCol = vec3(0.05, 0.52, 1.20);
    else if (m4 < 1.5) glassCol = vec3(1.18, 0.08, 0.24);
    else if (m4 < 2.5) glassCol = vec3(0.06, 0.96, 0.52);
    else glassCol = vec3(1.15, 0.68, 0.06);
  }
  return vec4(glassCol * openMask * 1.55, openMask);
}

// Analytical shadow-beam transmittance from any 3D point p inside the hall toward uSunDir through the rose window!
vec3 evalSunBeamAtPoint(vec3 p, vec3 sunDir, float t, bool stainedGlass) {
  // Ray from p along sunDir intersects the back window wall plane z = -4.20
  if (sunDir.z >= -0.05) return vec3(0.0);
  float tw = (WIN_CENTER.z - p.z) / sunDir.z;
  if (tw < 0.0) return vec3(0.0);
  vec3 wHit = p + sunDir * tw;
  vec2 pRel = wHit.xy - WIN_CENTER.xy;
  vec4 rw = evalRoseWindow(pRel, t, stainedGlass);
  if (rw.a < 0.01) return vec3(0.0);

  // Check if central interior pillars block the sunbeam -> true 3D volumetric shadows behind pillars!
  vec3 nTmp;
  if (iBox(p, sunDir, vec3(-2.30, 0.0, -2.55), vec3(-1.72, 4.4, -1.95), nTmp) < tw) return vec3(0.0);
  if (iBox(p, sunDir, vec3( 1.42, 0.0, -2.55), vec3( 2.00, 4.4, -1.95), nTmp) < tw) return vec3(0.0);
  if (iBox(p, sunDir, vec3(-0.35, 0.0, -1.45), vec3( 0.25, 1.18, -0.85), nTmp) < tw) return vec3(0.0);
  return rw.rgb;
}

// Henyey-Greenstein anisotropic scattering phase function
float hgPhase(float cosT, float g) {
  float g2 = g * g;
  return (1.0 - g2) / (4.0 * PI * pow(max(1.0 + g2 - 2.0 * g * cosT, 0.05), 1.5));
}

struct Hit {
  float t;
  vec3 pos;
  vec3 norm;
  int matId; // 0=sky/window glass, 1=stone floor, 2=gothic walls/vault/pillars, 3=altar, 4=amber brazier, 5=cyan lantern
  vec3 winCol;
};

Hit traceHall(vec3 ro, vec3 rd, float t, bool stainedGlass, float farClip) {
  Hit h;
  h.t = INF;
  h.matId = 0;
  h.norm = vec3(0.0, 1.0, 0.0);
  h.pos = ro + rd * 25.0;
  h.winCol = vec3(0.0);
  vec3 nTmp;

  // 1. Stone cathedral floor (y = 0) & dark ceiling vault (y = 4.45)
  if (rd.y < -1e-5) {
    float tf = -ro.y / rd.y;
    if (tf > 0.002 && tf < farClip && tf < h.t) {
      vec3 p = ro + rd * tf;
      if (abs(p.x) <= 3.45 && p.z >= -4.35 && p.z <= 5.5) {
        h.t = tf; h.pos = p; h.norm = vec3(0.0, 1.0, 0.0); h.matId = 1;
      }
    }
  } else if (rd.y > 1e-5) {
    float tc = (4.45 - ro.y) / rd.y;
    if (tc > 0.002 && tc < farClip && tc < h.t) {
      vec3 p = ro + rd * tc;
      if (abs(p.x) <= 3.45 && p.z >= -4.35 && p.z <= 5.5) {
        h.t = tc; h.pos = p; h.norm = vec3(0.0, -1.0, 0.0); h.matId = 2;
      }
    }
  }

  // 2. Side nave walls (x = +-3.35)
  if (rd.x < -1e-5) {
    float tx = (-3.35 - ro.x) / rd.x;
    if (tx > 0.002 && tx < farClip && tx < h.t) {
      vec3 p = ro + rd * tx;
      if (p.y >= 0.0 && p.y <= 4.45 && p.z >= -4.35 && p.z <= 5.5) {
        h.t = tx; h.pos = p; h.norm = vec3(1.0, 0.0, 0.0); h.matId = 2;
      }
    }
  } else if (rd.x > 1e-5) {
    float tx = (3.35 - ro.x) / rd.x;
    if (tx > 0.002 && tx < farClip && tx < h.t) {
      vec3 p = ro + rd * tx;
      if (p.y >= 0.0 && p.y <= 4.45 && p.z >= -4.35 && p.z <= 5.5) {
        h.t = tx; h.pos = p; h.norm = vec3(-1.0, 0.0, 0.0); h.matId = 2;
      }
    }
  }

  // 3. Back wall (z = -4.20) with Gothic Rose Window cutout!
  if (rd.z < -1e-5) {
    float tz = (-4.20 - ro.z) / rd.z;
    if (tz > 0.002 && tz < farClip && tz < h.t) {
      vec3 p = ro + rd * tz;
      if (abs(p.x) <= 3.45 && p.y >= 0.0 && p.y <= 4.45) {
        vec4 rw = evalRoseWindow(p.xy - WIN_CENTER.xy, t, stainedGlass);
        h.t = tz; h.pos = p; h.norm = vec3(0.0, 0.0, 1.0);
        if (rw.a > 0.08) {
          h.matId = 0; // Glowing window glass / sky!
          h.winCol = rw.rgb * 4.2;
        } else {
          h.matId = 2;
        }
      }
    }
  }

  // 4. Receding Gothic Nave Pillars (3 pairs -> visually dramatic for both 1997 depth fog & 3D god-ray occlusion!)
  float zP[3]; zP[0] = -2.25; zP[1] = -0.35; zP[2] = 1.65;
  for (int i = 0; i < 3; i++) {
    float zp = zP[i];
    float tPL = iBox(ro, rd, vec3(-2.30, 0.0, zp - 0.30), vec3(-1.72, 4.45, zp + 0.30), nTmp);
    if (tPL < farClip && tPL < h.t) { h.t = tPL; h.pos = ro + rd * tPL; h.norm = nTmp; h.matId = 2; }
    float tPR = iBox(ro, rd, vec3( 1.42, 0.0, zp - 0.30), vec3( 2.00, 4.45, zp + 0.30), nTmp);
    if (tPR < farClip && tPR < h.t) { h.t = tPR; h.pos = ro + rd * tPR; h.norm = nTmp; h.matId = 2; }
    // Overhead gothic stone transverse rib beam
    float tBeam = iBox(ro, rd, vec3(-3.35, 3.85, zp - 0.24), vec3(3.35, 4.45, zp + 0.24), nTmp);
    if (tBeam < farClip && tBeam < h.t) { h.t = tBeam; h.pos = ro + rd * tBeam; h.norm = nTmp; h.matId = 2; }
  }

  // 5. Central Carved Stone Pedestal / Altar (catches the colored stained-glass sunbeams right in the middle of the hall!)
  float tAlt = iBox(ro, rd, vec3(-0.35, 0.0, -1.45), vec3(0.25, 1.18, -0.85), nTmp);
  if (tAlt < farClip && tAlt < h.t) { h.t = tAlt; h.pos = ro + rd * tAlt; h.norm = nTmp; h.matId = 3; }

  // 6. Local Lantern Orbs (warm amber brazier & cool cyan relic lantern — light up on Stage 6 Frostbite 2015+)
  float tL1 = iSphere(ro, rd, LAMP_AMBER, 0.14, nTmp);
  if (tL1 < farClip && tL1 < h.t) { h.t = tL1; h.pos = ro + rd * tL1; h.norm = nTmp; h.matId = 4; }
  float tL2 = iSphere(ro, rd, LAMP_CYAN, 0.13, nTmp);
  if (tL2 < farClip && tL2 < h.t) { h.t = tL2; h.pos = ro + rd * tL2; h.norm = nTmp; h.matId = 5; }

  return h;
}

vec3 rayForUv(vec2 uv, vec3 camFwd, vec3 camRight, vec3 camUp, float aspect, float tanHalfFov) {
  vec2 ndc = uv * 2.0 - 1.0;
  return normalize(camFwd + ndc.x * aspect * tanHalfFov * camRight + ndc.y * tanHalfFov * camUp);
}
`;

// ============================================================================
// PASS 1: GOTHIC CATHEDRAL HALL DIRECT LIGHTING + DEPTH & OCCLUSION G-BUFFER
// ============================================================================
export const SCENE_FS = `#version 300 es
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
uniform vec3 uSunDir;
uniform int uStageLeft;
uniform int uStageRight;
uniform float uSplitX;
uniform float uNoFogLeft; // Step 1 split: raw un-fogged far-clip vs 1997 Turok / Silent Hill depth fog!

layout(location = 0) out vec4 outColor; // Linear HDR lit cathedral hall
layout(location = 1) out vec4 outMask;  // R = linear depth t, G = window sky brightness mask (for 2007 Mitchell SSRays!), B = matId, A = hitFlag

${HALL_COMMON}

void main() {
  bool useLeft = (uSplitX >= 0.995) || ((uSplitX > 0.005) && (vUv.x < uSplitX));
  int st = useLeft ? uStageLeft : uStageRight;
  bool noFogLeft = useLeft && (uNoFogLeft > 0.5);
  bool stained = (st == 7);
  // Step 1 (1997): demonstrate authentic short far-clip distance (8.8 units) masked by distance fog!
  float farClip = (st == 0) ? 8.8 : 24.0;

  vec3 rd = rayForUv(vUv, uCamFwd, uCamRight, uCamUp, uAspect, uTanHalfFov);
  Hit h = traceHall(uCamPos, rd, uTime, stained, farClip);

  if (h.t >= INF) {
    // Far-clipped / outside void (shows ugly hard pop-in without fog on Step 1 left!)
    vec3 skyVoid = noFogLeft ? vec3(0.14, 0.17, 0.22) : vec3(0.04, 0.06, 0.10);
    outColor = vec4(skyVoid, 1.0);
    outMask = vec4(farClip, 0.0, 0.0, 0.0);
    return;
  }

  if (h.matId == 0) {
    // Glowing Rose Window aperture!
    outColor = vec4(h.winCol, 1.0);
    float luma = dot(h.winCol, vec3(0.299, 0.587, 0.114));
    outMask = vec4(h.t, clamp(luma * 0.45, 0.0, 2.5), 0.0, 1.0);
    return;
  }

  if (h.matId == 4 || h.matId == 5) {
    // Local lanterns ignite on Stage 6-7 (Frostbite 2015+); unlit dark wrought-iron sconces earlier!
    if (st >= 6) {
      vec3 lc = (h.matId == 4) ? vec3(4.8, 2.1, 0.38) : vec3(0.38, 3.5, 4.8);
      outColor = vec4(lc, 1.0);
    } else {
      outColor = vec4(vec3(0.055, 0.060, 0.075), 1.0);
    }
    outMask = vec4(h.t, 0.0, float(h.matId), 1.0);
    return;
  }

  // Direct surface shading for stone floor, walls, pillars & altar
  vec3 N = normalize(h.norm);
  vec3 V = -rd;
  vec3 alb = vec3(0.14, 0.15, 0.18);
  float rough = 0.72;

  if (h.matId == 1) {
    // Flagstone cathedral floor with worn mortar & subtle specular sheen
    vec2 fuv = h.pos.xz * 1.15;
    vec2 ff = abs(fract(fuv) - 0.5);
    float grout = smoothstep(0.46, 0.495, max(ff.x, ff.y));
    float tid = hash12(floor(fuv));
    alb = vec3(0.13, 0.145, 0.175) * (0.78 + 0.36 * tid) * (1.0 - grout * 0.65);
    rough = mix(0.32, 0.75, grout);
  } else if (h.matId == 2) {
    // Gothic ashlar stone pillars & nave walls
    vec2 wuv = (abs(N.x) > 0.5) ? h.pos.zy : h.pos.xy;
    vec2 wf = abs(fract(wuv * vec2(1.2, 2.2)) - 0.5);
    float seam = smoothstep(0.45, 0.495, max(wf.x, wf.y));
    float stone = hash12(floor(wuv * vec2(1.2, 2.2)));
    alb = vec3(0.16, 0.17, 0.20) * (0.80 + 0.32 * stone) * (1.0 - seam * 0.55);
  } else if (h.matId == 3) {
    // Carved limestone central pedestal / altar
    alb = vec3(0.28, 0.27, 0.25);
    rough = 0.55;
  }

  // Sunbeam projection onto floor / altar / pillars directly through the rose window!
  vec3 sunBeam = evalSunBeamAtPoint(h.pos + N * 0.015, uSunDir, uTime, stained);
  float ndl = max(dot(N, uSunDir), 0.0);
  vec3 H = normalize(uSunDir + V);
  float spec = pow(max(dot(N, H), 0.0), mix(12.0, 54.0, 1.0 - rough)) * (1.0 - rough) * 0.45;
  vec3 col = alb * (vec3(0.055, 0.075, 0.125) * (0.55 + 0.45 * N.y));
  col += (alb * ndl + vec3(spec)) * sunBeam * 2.15;

  // Local colored lantern direct illumination (Stage 6 Frostbite 2015+!)
  if (st >= 6) {
    vec3 toA = LAMP_AMBER - h.pos;
    float dA = dot(toA, toA) + 0.35;
    col += alb * max(dot(N, normalize(toA)), 0.0) * vec3(2.8, 1.25, 0.28) / dA;
    vec3 toC = LAMP_CYAN - h.pos;
    float dC = dot(toC, toC) + 0.35;
    col += alb * max(dot(N, normalize(toC)), 0.0) * vec3(0.25, 2.1, 2.8) / dC;
  }

  outColor = vec4(col, 1.0);
  outMask = vec4(h.t, 0.0, float(h.matId), 1.0);
}
`;

// ============================================================================
// PASS 2: ALL 8 FOG & VOLUMETRIC LIGHTING ERAS (1997 -> 2026)
// ============================================================================
export const VOL_FS = `#version 300 es
precision highp float;
precision highp int;

in vec2 vUv;
uniform sampler2D uSceneCol;
uniform sampler2D uSceneMask;
uniform vec3 uCamPos;
uniform vec3 uCamRight;
uniform vec3 uCamUp;
uniform vec3 uCamFwd;
uniform float uTanHalfFov;
uniform float uAspect;
uniform vec2 uRes;
uniform float uTime;
uniform vec3 uSunDir;
uniform vec2 uSunScreenUv;   // Projected screen UV of window sun center (for 2007 Mitchell radial blur!)
uniform float uSunVisFade;   // Smooth off-screen / look-away fade (authentic to GPU Gems 3 Ch. 13!)
uniform int uStageLeft;
uniform int uStageRight;
uniform float uSplitX;
uniform float uNoFogLeft;
uniform float uInterleaved;  // Stage 4 (2009 Tóth & Umenhoffer): toggle interleaved jitter vs raw step banding!
uniform float uShowFroxels;  // Stage 5 (2014 Wronski): visualize 3D frustum-aligned froxel slices!
out vec4 outColor;

${HALL_COMMON}

// Heterogeneous animated swirling 3D dust/fog density (Hillaire / Frostbite SIGGRAPH 2015)
float evalFogDensity(vec3 p, float t, bool hetero) {
  float heightFalloff = exp(-max(p.y - 0.15, 0.0) * 0.24);
  if (!hetero) return 0.15 * (0.45 + 0.55 * heightFalloff);
  // Drifting organic dust plumes + ground mist curling slowly through the cathedral beams!
  vec3 q = p * 0.52 + vec3(t * 0.14, -t * 0.06, t * 0.09);
  float n = fbm3(q);
  float plumes = smoothstep(0.24, 0.78, n);
  float groundMist = exp(-max(p.y, 0.0) * 1.15) * 0.85;
  return 0.06 + (0.28 * plumes * heightFalloff + 0.22 * groundMist);
}

void main() {
  bool useLeft = (uSplitX >= 0.995) || ((uSplitX > 0.005) && (vUv.x < uSplitX));
  int st = useLeft ? uStageLeft : uStageRight;
  bool noFogLeft = useLeft && (uNoFogLeft > 0.5);

  vec3 baseCol = texture(uSceneCol, vUv).rgb;
  vec4 mask = texture(uSceneMask, vUv);
  float hitT = mask.r;
  vec3 rd = rayForUv(vUv, uCamFwd, uCamRight, uCamUp, uAspect, uTanHalfFov);
  float cosSun = dot(rd, uSunDir);

  if (noFogLeft) {
    // Step 1 Split Left: NO FOG (exposes ugly raw far-clipping geometry cutoff!)
    outColor = vec4(baseCol, 1.0);
    return;
  }

  vec3 col = baseCol;

  if (st == 0) {
    // ERA 1 (1997): Distance Depth Fog (Turok 1997 / Silent Hill 1999; OpenGL 1.0 fog 1992)
    // Uniform linear-to-exp depth fog hides the 8.8-unit far clip plane!
    float fogFactor = clamp((hitT - 2.2) / (8.6 - 2.2), 0.0, 1.0);
    fogFactor = fogFactor * fogFactor * (3.0 - 2.0 * fogFactor);
    vec3 fogColor = vec3(0.26, 0.30, 0.36);
    col = mix(baseCol, fogColor, fogFactor * 0.95);
  } else if (st == 1) {
    // ERA 2 (2002): Analytical Aerial Perspective (Hoffman & Preetham, GDC 2002 / SIGGRAPH 2003)
    // Physical wavelength-dependent Rayleigh + Mie extinction & warm sun in-scattering!
    vec3 betaR = vec3(0.032, 0.056, 0.095);
    vec3 betaM = vec3(0.048);
    vec3 ext = exp(-(betaR + betaM) * hitT * 1.15);
    float rayP = 0.75 * (1.0 + cosSun * cosSun);
    float mieP = hgPhase(cosSun, 0.72) * 3.8;
    vec3 inScatter = (betaR * rayP * vec3(0.65, 0.85, 1.25) + betaM * mieP * vec3(1.55, 1.18, 0.75)) / (betaR + betaM);
    col = baseCol * ext + inScatter * (1.0 - ext) * 0.72;
  } else if (st == 2) {
    // ERA 3 (2004): Pre-2007 Shadow-Map / View-Aligned Slice Light Shafts (Dobashi '02 / James '03 / ATI GDC '04)
    // Genuine coarse 10-slice planar stack through the hall shadow volume -> true 3D shafts, visible coarse planar slicing!
    const int SLICES = 10;
    float maxT = min(hitT, 9.5);
    vec3 accum = vec3(0.0);
    float phase = hgPhase(cosSun, 0.58) * 3.2;
    for (int i = 1; i <= SLICES; i++) {
      // Fixed view-aligned depth planes (authentic coarse planar card slicing of 2004!)
      float zPlane = float(i) * 0.85;
      float tSlice = zPlane / max(dot(rd, uCamFwd), 0.25);
      if (tSlice > maxT) break;
      vec3 sp = uCamPos + rd * tSlice;
      vec3 beam = evalSunBeamAtPoint(sp, uSunDir, uTime, false);
      accum += beam * (0.095 * (0.35 + 0.65 * phase));
    }
    vec3 ext = exp(-vec3(0.04, 0.05, 0.07) * hitT);
    col = baseCol * ext + vec3(0.03, 0.045, 0.07) * (1.0 - ext) + accum;
  } else if (st == 3) {
    // ERA 4 (2007): Screen-Space Volumetric Light Scattering (Kenny Mitchell, GPU Gems 3 Ch. 13)
    // Genuine 48-tap radial blur on Pass 1's window occlusion mask toward uSunScreenUv!
    // Authentically fades smoothly via uSunVisFade as the window exits the viewport when looking away!
    vec2 deltaUv = (vUv - uSunScreenUv) * (0.82 / 48.0);
    vec2 curUv = vUv;
    float illumDecay = 1.0;
    float rays = 0.0;
    for (int i = 0; i < 48; i++) {
      curUv -= deltaUv;
      vec2 clamped = clamp(curUv, vec2(0.002), vec2(0.998));
      float inBounds = step(0.0, curUv.x) * step(curUv.x, 1.0) * step(0.0, curUv.y) * step(curUv.y, 1.0);
      float s = texture(uSceneMask, clamped).g * inBounds;
      rays += s * illumDecay * 0.036;
      illumDecay *= 0.952;
    }
    vec3 shaftCol = vec3(1.0, 0.85, 0.58) * rays * uSunVisFade;
    vec3 ext = exp(-vec3(0.035, 0.045, 0.065) * hitT);
    col = baseCol * ext + vec3(0.03, 0.045, 0.07) * (1.0 - ext) + shaftCol;
  } else if (st == 4) {
    // ERA 5 (2009): Raymarched Volumetric Shadows + Interleaved Sampling (Tóth & Umenhoffer, Eurographics 2009)
    // True 3D raymarch stays alive even when looking completely away from the window!
    // Toggle uInterleaved=0 to expose classic coarse 16-step banding vs uInterleaved=1 interleaved jitter!
    const int STEPS = 18;
    float maxT = min(hitT, 10.5);
    float dt = maxT / float(STEPS);
    // 4x4 Bayer-like interleaved pixel offset (Tóth & Umenhoffer 2009!)
    vec2 ip = mod(floor(gl_FragCoord.xy), 4.0);
    float interOff = (ip.x * 4.0 + ip.y) / 16.0;
    float startOff = mix(0.5, interOff, uInterleaved);
    float phase = hgPhase(cosSun, 0.65) * 3.8 + 0.14;

    vec3 scatter = vec3(0.0);
    float trans = 1.0;
    for (int i = 0; i < STEPS; i++) {
      float tCur = (float(i) + startOff) * dt;
      vec3 sp = uCamPos + rd * tCur;
      float dens = 0.11;
      vec3 beam = evalSunBeamAtPoint(sp, uSunDir, uTime, false);
      vec3 li = beam * phase * 0.85 + vec3(0.025, 0.038, 0.062);
      float stepTrans = exp(-dens * dt);
      scatter += trans * li * (1.0 - stepTrans);
      trans *= stepTrans;
    }
    col = baseCol * trans + scatter;
  } else if (st == 5) {
    // ERA 6 (2014): Temporal Froxel Volumetric Fog (Bart Wronski, SIGGRAPH 2014 / AC IV — WebGL2 emulated!)
    // Quantizes ray integration onto frustum-aligned 160x90x64 logarithmic froxels + HG anisotropic scattering!
    const int STEPS = 32;
    float maxT = min(hitT, 11.5);
    // Snap XY direction to 160x90 froxel grid cell center (subtle authentic frustum voxel feel!)
    vec2 froxGrid = vec2(160.0, 90.0);
    vec2 froxUv = (floor(vUv * froxGrid) + 0.5) / froxGrid;
    vec3 froxRd = rayForUv(froxUv, uCamFwd, uCamRight, uCamUp, uAspect, uTanHalfFov);
    float phase = hgPhase(cosSun, 0.72) * 4.2 + 0.16;
    float jitter = hash12(gl_FragCoord.xy) * 0.85;

    vec3 scatter = vec3(0.0);
    float trans = 1.0;
    float prevT = 0.0;
    for (int i = 1; i <= STEPS; i++) {
      // Exponential froxel depth slice distribution (dense near camera, wider far away — Wronski 2014!)
      float zFrac = (float(i) - 0.5 + jitter * 0.35) / float(STEPS);
      float tCur = maxT * pow(zFrac, 1.35);
      float dt = max(tCur - prevT, 0.01);
      prevT = tCur;
      vec3 sp = uCamPos + froxRd * tCur;
      float dens = evalFogDensity(sp, uTime, false);
      vec3 beam = evalSunBeamAtPoint(sp, uSunDir, uTime, false);
      vec3 li = beam * phase * 0.92 + vec3(0.028, 0.044, 0.075);
      float stepTrans = exp(-dens * dt);
      scatter += trans * li * (1.0 - stepTrans);
      trans *= stepTrans;
    }
    col = baseCol * trans + scatter;

    // Optional Show Froxel Grid debug overlay (visualizes frustum XY cells + exponential depth slices!)
    if (uShowFroxels > 0.5) {
      vec2 gf = fract(vUv * vec2(32.0, 18.0));
      float gridXY = 1.0 - smoothstep(0.025, 0.065, min(min(gf.x, 1.0 - gf.x), min(gf.y, 1.0 - gf.y)));
      float sliceZ = 1.0 - smoothstep(0.03, 0.09, abs(fract(pow(clamp(hitT / 11.5, 0.0, 1.0), 0.74) * 14.0) - 0.5));
      col = mix(col, vec3(0.18, 0.92, 1.0), gridXY * 0.24);
      col = mix(col, vec3(1.0, 0.76, 0.24), sliceZ * 0.30);
    }
  } else if (st == 6) {
    // ERA 7 (2015): Heterogeneous Participating Media & Local Lights (Sébastien Hillaire / Frostbite, SIGGRAPH 2015)
    // Animated 3D swirling fog plumes + localized amber & cyan volumetric point lights!
    const int STEPS = 36;
    float maxT = min(hitT, 11.5);
    float dt = maxT / float(STEPS);
    float jitter = hash12(gl_FragCoord.xy);
    float phase = hgPhase(cosSun, 0.72) * 4.4 + 0.18;

    vec3 scatter = vec3(0.0);
    float trans = 1.0;
    for (int i = 0; i < STEPS; i++) {
      float tCur = (float(i) + jitter) * dt;
      vec3 sp = uCamPos + rd * tCur;
      float dens = evalFogDensity(sp, uTime, true);
      vec3 beam = evalSunBeamAtPoint(sp, uSunDir, uTime, false);
      // Local colored volumetric point lights (Frostbite 2015 signature!)
      float dA = dot(LAMP_AMBER - sp, LAMP_AMBER - sp) + 0.22;
      float dC = dot(LAMP_CYAN - sp, LAMP_CYAN - sp) + 0.22;
      vec3 localVol = vec3(3.4, 1.45, 0.28) / (dA * 2.2) + vec3(0.28, 2.45, 3.35) / (dC * 2.2);
      vec3 li = beam * phase * 0.95 + localVol * 0.52 + vec3(0.028, 0.042, 0.072);
      float stepTrans = exp(-dens * dt);
      scatter += trans * li * (1.0 - stepTrans);
      trans *= stepTrans;
    }
    col = baseCol * trans + scatter;
  } else {
    // ERA 8 (2020-26): Multi-Scattering & Colored Stained-Glass Volumetrics (Hillaire, EGSR 2020 -> modern engines)
    // Energy-conserving multi-octave scattering + dazzling rainbow stained-glass cathedral sunbeams + local lights!
    const int STEPS = 40;
    float maxT = min(hitT, 11.5);
    float dt = maxT / float(STEPS);
    float jitter = hash12(gl_FragCoord.xy);
    // Multi-scattering dual-lobe phase (sharp forward core + broad isotropic multi-scatter halo — Hillaire EGSR 2020!)
    float phase1 = hgPhase(cosSun, 0.76) * 4.6;
    float phase2 = hgPhase(cosSun, 0.22) * 1.45 + 0.22;

    vec3 scatter = vec3(0.0);
    float trans = 1.0;
    for (int i = 0; i < STEPS; i++) {
      float tCur = (float(i) + jitter) * dt;
      vec3 sp = uCamPos + rd * tCur;
      float dens = evalFogDensity(sp, uTime, true) * 1.12;
      vec3 beam = evalSunBeamAtPoint(sp, uSunDir, uTime, true);
      // Multi-scatter fill: soft luminous atmospheric bounce lifts shadowed air around glowing beams!
      float dA = dot(LAMP_AMBER - sp, LAMP_AMBER - sp) + 0.20;
      float dC = dot(LAMP_CYAN - sp, LAMP_CYAN - sp) + 0.20;
      vec3 localVol = vec3(3.6, 1.55, 0.30) / (dA * 2.1) + vec3(0.30, 2.55, 3.55) / (dC * 2.1);
      vec3 multiFill = vec3(0.065, 0.082, 0.135) * (0.65 + 0.35 * exp(-max(sp.y, 0.0) * 0.4));
      vec3 li = beam * (phase1 * 0.78 + phase2 * 0.42) + localVol * 0.56 + multiFill;
      // Multi-scattering transmittance conservation (slightly softer optical extinction for lush glowing mist!)
      float stepTrans = exp(-dens * dt * 0.88);
      scatter += trans * li * (1.0 - stepTrans);
      trans *= stepTrans;
    }
    col = baseCol * trans + scatter;
  }

  outColor = vec4(max(col, vec3(0.0)), 1.0);
}
`;

// ============================================================================
// PASS 3: SOFT VOLUMETRIC BLOOM + ACES FILMIC TONE MAPPING
// ============================================================================
export const FINAL_FS = `#version 300 es
precision highp float;

in vec2 vUv;
uniform sampler2D uSrc;
uniform vec2 uTexel;
out vec4 outColor;

vec3 aces(vec3 x) {
  return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0);
}

void main() {
  vec3 c = texture(uSrc, vUv).rgb;
  // Gentle 6-tap atmospheric bloom around sunlit rose window & lanterns
  vec3 glow = vec3(0.0);
  const vec2 ring[6] = vec2[6](
    vec2( 1.0,  0.0), vec2(-1.0,  0.0),
    vec2( 0.5,  0.866), vec2(-0.5,  0.866),
    vec2( 0.5, -0.866), vec2(-0.5, -0.866)
  );
  for (int i = 0; i < 6; i++) {
    vec3 s1 = texture(uSrc, clamp(vUv + ring[i] * uTexel * 2.0, vec2(0.002), vec2(0.998))).rgb;
    vec3 s2 = texture(uSrc, clamp(vUv + ring[i].yx * uTexel * 5.0, vec2(0.002), vec2(0.998))).rgb;
    glow += max(s1 - vec3(0.95), vec3(0.0)) * 0.036;
    glow += max(s2 - vec3(1.05), vec3(0.0)) * 0.022;
  }
  c += glow;
  vec3 col = pow(aces(c * 0.96), vec3(1.0 / 2.2));
  outColor = vec4(col, 1.0);
}
`;
