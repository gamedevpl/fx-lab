// Procedural 3D Gothic Courtyard & Blender-Sculpted Gothic Priest ("Ksiadz") + 40K Micro-Glyph Cloud.
// Deterministic mulberry32 RNG (zero Math.random()!).
// Designed specifically for the OPTICAL FUSION -> 7.4x EXPONENTIAL ZOOM-IN / ZOOM-OUT effect:
//   - At Wide Isometric Cathedral distance (dist ~ 40.5): micro-glyphs are ~3-4 px tall and optically
//     fuse into a moody dark-fantasy painting where imagination fills in stone, glass, leaves & cloth!
//   - On 7.4x Zoom-In (dist ~ 5.5): the exact same 100% camera-facing 3D billboards magnify into razor-sharp
//     keyboard characters (< > + ; ~ =, S Z z N H # G E, [ ] I H) with ZERO screen swim & ZERO UV textures!

import { mulberry32 } from "../../src/gl-utils.js";
import { getPriestMeshVerts, getPriestGlyphSamples } from "./priest-mesh.js";

function createMeshBuilder() {
  const verts = [];
  const pushV = (px, py, pz, nx, ny, nz, u, v, mat, part = 0, extra = 0) => {
    verts.push(px, py, pz, nx, ny, nz, u, v, mat, part, extra);
  };
  const quad = (p0, p1, p2, p3, n, u0, v0, u1, v1, mat, part = 0, extra = 0) => {
    pushV(p0[0], p0[1], p0[2], n[0], n[1], n[2], u0, v0, mat, part, extra);
    pushV(p1[0], p1[1], p1[2], n[0], n[1], n[2], u1, v0, mat, part, extra);
    pushV(p2[0], p2[1], p2[2], n[0], n[1], n[2], u1, v1, mat, part, extra);
    pushV(p0[0], p0[1], p0[2], n[0], n[1], n[2], u0, v0, mat, part, extra);
    pushV(p2[0], p2[1], p2[2], n[0], n[1], n[2], u1, v1, mat, part, extra);
    pushV(p3[0], p3[1], p3[2], n[0], n[1], n[2], u0, v1, mat, part, extra);
  };
  const box = (cx, cy, cz, sx, sy, sz, mat, part = 0, uvScale = 1.0, extra = 0) => {
    const hx = sx * 0.5, hy = sy * 0.5, hz = sz * 0.5;
    const x0 = cx - hx, x1 = cx + hx, y0 = cy - hy, y1 = cy + hy, z0 = cz - hz, z1 = cz + hz;
    quad([x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1], [0, 0, 1], x0 * uvScale, y0 * uvScale, x1 * uvScale, y1 * uvScale, mat, part, extra);
    quad([x1, y0, z0], [x0, y0, z0], [x0, y1, z0], [x1, y1, z0], [0, 0, -1], x0 * uvScale, y0 * uvScale, x1 * uvScale, y1 * uvScale, mat, part, extra);
    quad([x1, y0, z1], [x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [1, 0, 0], z0 * uvScale, y0 * uvScale, z1 * uvScale, y1 * uvScale, mat, part, extra);
    quad([x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0], [-1, 0, 0], z0 * uvScale, y0 * uvScale, z1 * uvScale, y1 * uvScale, mat, part, extra);
    quad([x0, y1, z1], [x1, y1, z1], [x1, y1, z0], [x0, y1, z0], [0, 1, 0], x0 * uvScale, z0 * uvScale, x1 * uvScale, z1 * uvScale, mat, part, extra);
    quad([x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1], [0, -1, 0], x0 * uvScale, z0 * uvScale, x1 * uvScale, z1 * uvScale, mat, part, extra);
  };
  // Tapered tilted limb / blade segment from point A (r0) to point B (r1)
  const tube = (a, b, r0, r1, segs, mat, part = 0, extra = 0) => {
    const dx = b[0] - a[0], dy = b[1] - a[1], dz = b[2] - a[2];
    const len = Math.hypot(dx, dy, dz) || 1;
    const ax = dx / len, ay = dy / len, az = dz / len;
    const ref = Math.abs(ay) < 0.9 ? [0, 1, 0] : [1, 0, 0];
    // orthonormal basis u, v perpendicular to axis
    let ux = ay * ref[2] - az * ref[1], uy = az * ref[0] - ax * ref[2], uz = ax * ref[1] - ay * ref[0];
    const ul = Math.hypot(ux, uy, uz) || 1; ux /= ul; uy /= ul; uz /= ul;
    const vx = ay * uz - az * uy, vy = az * ux - ax * uz, vz = ax * uy - ay * ux;
    for (let i = 0; i < segs; i++) {
      const t0 = (i / segs) * Math.PI * 2, t1 = ((i + 1) / segs) * Math.PI * 2;
      const c0 = Math.cos(t0), s0 = Math.sin(t0), c1 = Math.cos(t1), s1 = Math.sin(t1);
      const n0 = [ux * c0 + vx * s0, uy * c0 + vy * s0, uz * c0 + vz * s0];
      const n1 = [ux * c1 + vx * s1, uy * c1 + vy * s1, uz * c1 + vz * s1];
      const p00 = [a[0] + n0[0] * r0, a[1] + n0[1] * r0, a[2] + n0[2] * r0];
      const p10 = [a[0] + n1[0] * r0, a[1] + n1[1] * r0, a[2] + n1[2] * r0];
      const p11 = [b[0] + n1[0] * r1, b[1] + n1[1] * r1, b[2] + n1[2] * r1];
      const p01 = [b[0] + n0[0] * r1, b[1] + n0[1] * r1, b[2] + n0[2] * r1];
      pushV(...p00, ...n0, i / segs, 0, mat, part, extra);
      pushV(...p10, ...n1, (i + 1) / segs, 0, mat, part, extra);
      pushV(...p11, ...n1, (i + 1) / segs, 1, mat, part, extra);
      pushV(...p00, ...n0, i / segs, 0, mat, part, extra);
      pushV(...p11, ...n1, (i + 1) / segs, 1, mat, part, extra);
      pushV(...p01, ...n0, i / segs, 1, mat, part, extra);
    }
  };
  // Lathe profile around Y with optional waist/flute modulation for graceful cloth draping!
  const lathe = (cx, cz, profile, segs, mat, part = 0, pleatAmp = 0.0, sx = 1.0, sz = 1.0) => {
    for (let r = 0; r < profile.length - 1; r++) {
      const [y0, r0] = profile[r];
      const [y1, r1] = profile[r + 1];
      const dy = y1 - y0, dr = r0 - r1;
      const ln = Math.hypot(dy, dr) || 1;
      const ny = dr / ln, nr = dy / ln;
      for (let i = 0; i < segs; i++) {
        const a0 = (i / segs) * Math.PI * 2, a1 = ((i + 1) / segs) * Math.PI * 2;
        const f0 = 1.0 + pleatAmp * Math.sin(a0 * 7.0) * (1.0 - r / (profile.length - 1));
        const f1 = 1.0 + pleatAmp * Math.sin(a1 * 7.0) * (1.0 - r / (profile.length - 1));
        const c0 = Math.cos(a0), s0 = Math.sin(a0), c1 = Math.cos(a1), s1 = Math.sin(a1);
        const p00 = [cx + c0 * r0 * f0 * sx, y0, cz + s0 * r0 * f0 * sz];
        const p10 = [cx + c1 * r0 * f1 * sx, y0, cz + s1 * r0 * f1 * sz];
        const p11 = [cx + c1 * r1 * f1 * sx, y1, cz + s1 * r1 * f1 * sz];
        const p01 = [cx + c0 * r1 * f0 * sx, y1, cz + s0 * r1 * f0 * sz];
        const n0 = [c0 * nr, ny, s0 * nr], n1 = [c1 * nr, ny, s1 * nr];
        pushV(...p00, ...n0, i / segs, r / (profile.length - 1), mat, part, 0);
        pushV(...p10, ...n1, (i + 1) / segs, r / (profile.length - 1), mat, part, 0);
        pushV(...p11, ...n1, (i + 1) / segs, (r + 1) / (profile.length - 1), mat, part, 0);
        pushV(...p00, ...n0, i / segs, r / (profile.length - 1), mat, part, 0);
        pushV(...p11, ...n1, (i + 1) / segs, (r + 1) / (profile.length - 1), mat, part, 0);
        pushV(...p01, ...n0, i / segs, (r + 1) / (profile.length - 1), mat, part, 0);
      }
    }
  };
  return { verts, quad, box, tube, lathe, build: () => new Float32Array(verts) };
}

// Evaluate graceful pleated Joseon durumagi coat radius along height h in [0..1]
function coatRadiusAt(h) {
  // Hem flare -> narrow belted waist at h=0.56 -> sculpted broad shoulders at h=0.84 -> narrow neck at h=1.0
  if (h < 0.56) {
    const t = h / 0.56;
    return 0.255 - t * 0.085; // 0.255 hem tapering cleanly to 0.170 waist
  }
  if (h < 0.85) {
    const t = (h - 0.56) / 0.29;
    return 0.170 + Math.sin(t * Math.PI * 0.5) * 0.068; // 0.170 waist -> 0.238 shoulders
  }
  const t = (h - 0.85) / 0.15;
  return 0.238 * (1.0 - t * 0.52); // 0.238 shoulders -> 0.114 collar/neck
}

export function buildSceneMeshes() {
  const m = createMeshBuilder();

  // 1) Courtyard stone terrace (y = 0, x in [-11.5, 11.5], z in [-4.0, 3.8])
  m.quad([-11.5, 0, 3.8], [11.5, 0, 3.8], [11.5, 0, -4.0], [-11.5, 0, -4.0], [0, 1, 0], -11.5, 3.8, 11.5, -4.0, 1, 0);

  // Foreground wild grass meadow slope + rear woods ground
  m.quad([-16, -1.2, 15.0], [16, -1.2, 15.0], [16, -0.02, 3.8], [-16, -0.02, 3.8], [0, 0.99, 0.11], -16, 15, 16, 3.8, 6, 0);
  m.quad([-16, -0.04, -4.0], [16, -0.04, -4.0], [16, -0.04, -14.0], [-16, -0.04, -14.0], [0, 1, 0], -16, -4, 16, -14, 6, 0);

  // 2) Gothic Cathedral Nave Wall (z = -4.0) & Right Transept Wing
  m.box(0, 2.55, -4.25, 19.6, 5.1, 0.65, 2, 0, 1.0);
  m.quad([-10.2, 5.05, -3.75], [10.2, 5.05, -3.75], [10.2, 9.85, -7.85], [-10.2, 9.85, -7.85], [0, 0.65, 0.76], -10.2, 0, 10.2, 6.4, 3, 0);
  m.box(9.6, 2.9, -1.8, 3.2, 5.8, 4.8, 2, 0, 1.0);
  m.quad([7.96, 1.15, -0.75], [7.96, 1.15, -2.55], [7.96, 3.75, -2.55], [7.96, 3.75, -0.75], [-1, 0, 0], 0, 0, 1, 1, 4, 0, 1.0);

  // 3) Repeating Gothic Buttresses + Glowing Warm Amber Arched Lancet Windows
  const bayXs = [-7.8, -4.8, -1.8, 1.2, 4.2, 7.2];
  for (let i = 0; i < bayXs.length; i++) {
    const bx = bayXs[i];
    m.box(bx, 2.65, -3.65, 0.60, 5.3, 0.72, 2, 0, 1.0);
    m.tube([bx, 5.3, -3.65], [bx, 6.25, -3.65], 0.30, 0.03, 4, 2, 0);

    if (i < bayXs.length - 1) {
      const wx = (bx + bayXs[i + 1]) * 0.5;
      if (i === 3) {
        m.box(wx, 1.9, -3.88, 1.95, 3.8, 0.14, 2, 0, 1.0);
        m.box(wx, 1.95, -3.76, 0.14, 2.9, 0.09, 5, 0, 1.0);
        m.box(wx, 2.35, -3.76, 1.55, 0.13, 0.09, 5, 0, 1.0);
      } else {
        m.quad([wx - 1.02, 0.72, -3.88], [wx + 1.02, 0.72, -3.88], [wx + 1.02, 4.05, -3.88], [wx - 1.02, 4.05, -3.88], [0, 0, 1], 0, 0, 1, 1, 4, 0, 1.0);
        m.box(wx, 2.1, -3.80, 1.96, 0.09, 0.07, 5, 0, 1.0);
        m.box(wx, 2.2, -3.80, 0.09, 3.1, 0.07, 5, 0, 1.0);
      }
    }
  }

  // 4) Haunted Lavender Wrought-Iron Fence along terrace edge (z = 3.72)
  for (let fx = -10.8; fx <= 10.8; fx += 2.16) {
    m.box(fx, 0.72, 3.72, 0.15, 1.44, 0.15, 5, 0, 1.0);
    m.box(fx, 1.50, 3.72, 0.22, 0.15, 0.22, 4, 0, 0.5);
  }
  m.box(0, 1.18, 3.72, 21.8, 0.08, 0.08, 5, 0, 1.0);
  m.box(0, 0.42, 3.72, 21.8, 0.08, 0.08, 5, 0, 1.0);
  for (let px = -10.4; px <= 10.4; px += 0.36) {
    m.box(px, 0.78, 3.72, 0.04, 0.92, 0.04, 5, 0, 1.0);
  }

  // 5) Ghostly Moonlit Tree (x = -7.6, z = -1.6)
  m.tube([-7.6, 0.0, -1.6], [-7.65, 3.5, -1.6], 0.36, 0.18, 8, 9, 0);
  m.lathe(-7.6, -1.6, [[2.9, 0.3], [3.6, 1.45], [4.6, 1.78], [5.5, 1.42], [6.1, 0.2]], 12, 9, 0);

  // 6) BLENDER-SCULPTED GOTHIC PRIEST ("KSIADZ": cassock, pellegrina cape, Roman collar, stole, saturno hat, Bible & brass cross lantern!)
  const priestVerts = getPriestMeshVerts();
  const baseData = m.build();
  const combined = new Float32Array(baseData.length + priestVerts.length);
  combined.set(baseData, 0);
  combined.set(priestVerts, baseData.length);

  return {
    data: combined,
    vertexCount: combined.length / 11,
  };
}

// Build ~40,000+ MICRO-SCALE instanced 3D camera-facing upright ASCII billboards!
// At Wide Cathedral zoom (dist = 40.5): micro-glyphs are ~3-4px and OPTICALLY FUSE into a moody painting!
// At 7.4x Close-Up zoom (dist = 5.5): every single micro-glyph reveals razor-sharp keyboard typography!
export function buildGlyphCloud() {
  const rng = mulberry32(20261123);
  const inst = [];
  const pushG = (x, y, z, sz, nx, ny, nz, row, r, g, b, part) => {
    const nl = Math.hypot(nx, ny, nz) || 1;
    const seed = rng() * 0.96;
    inst.push(x, y, z, sz, nx / nl, ny / nl, nz / nl, row + seed, r, g, b, part);
  };

  // --- A) BLENDER SURFACE-SAMPLED GOTHIC PRIEST MICRO-TYPOGRAPHY (3,600 crisp S Z z N H # G E glyphs!) ---
  const priestSamples = getPriestGlyphSamples();
  const sampleCount = priestSamples.length / 11;
  const addPriestGlyphs = (ghostPart, stride, colorMult = 1.0) => {
    for (let i = 0; i < sampleCount; i += stride) {
      const o = i * 11;
      const px = priestSamples[o + 0];
      const py = priestSamples[o + 1];
      const pz = priestSamples[o + 2];
      const sz = priestSamples[o + 3];
      const nx = priestSamples[o + 4];
      const ny = priestSamples[o + 5];
      const nz = priestSamples[o + 6];
      const cr = priestSamples[o + 7] * colorMult;
      const cg = priestSamples[o + 8] * colorMult;
      const cb = priestSamples[o + 9] * colorMult;
      const origPart = Math.round(priestSamples[o + 10]);
      const part = ghostPart > 0 ? ghostPart : origPart;
      pushG(px, py, pz, sz, nx, ny, nz, 1, cr, cg, cb, part);
    }
  };

  // Main Blender Priest (all 5,200 crisp surface-sampled micro-glyphs!)
  addPriestGlyphs(0, 1, 1.0);
  // 5 Spectral Dash Afterimage Ghosts (partId 10..14, ~740 glyphs each!)
  for (let g = 0; g < 5; g++) {
    addPriestGlyphs(10 + g, 7, 0.88);
  }

  // --- B) GHOSTLY MOONLIT TREE CANOPY (2,400 FINE painterly mint-sage leaf glyphs: v w o & * y!) ---
  for (let i = 0; i < 2400; i++) {
    const u = rng(), v = rng();
    const theta = u * Math.PI * 2;
    const phi = Math.acos(2 * v - 1);
    const rad = 0.68 + Math.pow(rng(), 0.42) * 1.58;
    const lx = Math.sin(phi) * Math.cos(theta) * rad * 1.12;
    const ly = Math.cos(phi) * rad * 0.94;
    const lz = Math.sin(phi) * Math.sin(theta) * rad * 1.04;
    const tint = 0.68 + rng() * 0.30;
    pushG(-7.6 + lx, 4.65 + ly, -1.6 + lz, 0.095 + rng() * 0.065, lx, ly + 0.55, lz, 4, 0.62 * tint, 0.90 * tint, 0.82 * tint, 0);
  }
  for (let i = 0; i < 220; i++) {
    const a = rng() * Math.PI * 2;
    const h = rng() * 3.4;
    const r = 0.38 - h * 0.05;
    pushG(-7.6 + Math.cos(a) * r, 0.08 + h, -1.6 + Math.sin(a) * r, 0.085, Math.cos(a), 0, Math.sin(a), 4, 0.22, 0.24, 0.28, 0);
  }

  // --- C) DENSE LUSH WILD GRASS MEADOW (~12,500 FINE dark ash-grey overlapping micro-strokes!) ---
  for (let i = 0; i < 12500; i++) {
    const back = i >= 10200;
    const gx = (rng() - 0.5) * 26.0;
    const gz = back ? (-4.4 - rng() * 8.0) : (3.92 + rng() * 10.5);
    if (!back) {
      const pd = Math.hypot((gx - 0.2) * 0.52, gz - 10.8);
      if (pd < 2.55) continue;
    }
    const gy = back ? 0.06 : (-0.02 - (gz - 3.8) * 0.105 + 0.09);
    const isGoldPatch = !back && (
      Math.hypot(gx + 3.4, gz - 6.2) < 0.58 ||
      Math.hypot(gx - 2.4, gz - 8.4) < 0.52 ||
      Math.hypot(gx + 6.4, gz - 8.8) < 0.48
    );
    const shade = 0.24 + rng() * 0.42;
    const cr = isGoldPatch ? 0.96 : shade * 0.94;
    const cg = isGoldPatch ? 0.84 : shade * 0.97;
    const cb = isGoldPatch ? 0.42 : shade * 1.02;
    pushG(gx, gy + rng() * 0.12, gz, 0.13 + rng() * 0.08, (rng() - 0.5) * 0.4, 1.0, 0.3, 4, cr, cg, cb, 7);
  }

  // --- D) MICRO-SCALE WORLD-SPACE COURTYARD FLOOR (< > + ; ~ = — Dead-Horizontal Rows at Isometric Yaw!) ---
  // Aligned to the isometric camera horizontal axis (yaw = -0.34 rad) & pitch-compensated (du=0.088, dv=0.185)
  // so courtyard rows read as crisp dead-horizontal terminal lines at EVERY zoom level from 1x Wide to 7.4x Close-Up!
  const isoYaw = -0.34;
  const cY = Math.cos(isoYaw), sY = Math.sin(isoYaw);
  for (let iv = -36; iv <= 36; iv++) {
    for (let iu = -132; iu <= 132; iu++) {
      const u = iu * 0.088;
      const v = iv * 0.185;
      // rightXZ = (cY, -sY), fwdXZ = (sY, cY)
      const gx = u * cY + v * sY;
      const gz = -u * sY + v * cY;
      if (gx < -10.7 || gx > 10.7 || gz < -3.72 || gz > 3.62) continue;
      const edgeDist = Math.max(Math.abs(gx) / 10.7, Math.abs(gz) / 3.72);
      if (edgeDist > 0.92 && rng() > (1.0 - edgeDist) * 10.0) continue;
      pushG(gx, 0.03, gz, 0.082, 0, 1, 0, 2, 0.84, 0.82, 0.88, 6);
    }
  }

  // --- E) 100% CAMERA-FACING 3D BILLBOARD CATHEDRAL (WALLS, BUTTRESSES, ROOF, AMBER WINDOWS & LAVENDER FENCE!) ---
  // ZERO UV-mapped ASCII textures anywhere — EVERY single glyph in the entire scene faces the camera upright!
  // partId = 8: Cathedral stone walls, buttresses & slate roof (dark charcoal [ ] = I H N #)
  // partId = 9: Glowing warm amber pointed-arch lancet windows & finial lanterns (H # 0 T!)
  // partId = 15: Haunted lavender wrought-iron fence & cathedral crosses (| + = [)
  const bayXs = [-7.8, -4.8, -1.8, 1.2, 4.2, 7.2];
  const isInsideWindow = (wx, wy) => {
    for (let i = 0; i < bayXs.length - 1; i++) {
      if (i === 3) continue; // portal bay with lavender cross
      const cx = (bayXs[i] + bayXs[i + 1]) * 0.5;
      const u = (wx - (cx - 1.02)) / 2.04;
      const v = (wy - 0.72) / 3.33;
      if (u >= 0 && u <= 1 && v >= 0 && v <= 1) {
        const ax = Math.abs(u - 0.5) * 2.0;
        if (v < 0.52 && ax <= 0.90) return true;
        if (v >= 0.52) {
          const dy = (v - 0.52) / 0.48;
          if (ax <= Math.sqrt(Math.max(0, 1 - dy * dy * 0.98)) * 0.90) return true;
        }
      }
    }
    return false;
  };

  // 1) Main Cathedral Facade Wall (z = -3.88, x in [-9.6..9.6], y in [0.15..5.05])
  for (let wy = 0.16; wy <= 5.04; wy += 0.155) {
    for (let wx = -9.5; wx <= 9.5; wx += 0.160) {
      if (isInsideWindow(wx, wy)) continue;
      if (rng() < 0.08) continue;
      const nearWin = Math.min(Math.abs(wx + 6.3), Math.abs(wx + 3.3), Math.abs(wx + 0.3), Math.abs(wx - 5.7));
      const warmSpill = Math.max(0, 1.0 - nearWin / 2.2) * (wy < 4.2 ? 0.55 : 0.15);
      const base = 0.28 + rng() * 0.30;
      const cr = base + warmSpill * 0.52;
      const cg = base + warmSpill * 0.34;
      const cb = base * 1.10 + warmSpill * 0.14;
      pushG(wx, wy, -3.86, 0.128, 0, 0, 1, 3, cr, cg, cb, 8);
    }
  }
  // 2) Protruding Gothic Buttress Pillars (front & side edges!)
  for (const bx of bayXs) {
    for (let wy = 0.16; wy <= 5.30; wy += 0.155) {
      for (const ox of [-0.22, 0.0, 0.22]) {
        const shade = 0.34 + rng() * 0.36;
        pushG(bx + ox, wy, -3.26, 0.122, ox * 1.2, 0, 1, 3, shade, shade, shade * 1.14, 8);
      }
      // Left/right cheek of buttress pillar
      pushG(bx - 0.31, wy, -3.54, 0.116, -1, 0, 0.2, 3, 0.36 + rng() * 0.24, 0.36 + rng() * 0.24, 0.42 + rng() * 0.24, 8);
      pushG(bx + 0.31, wy, -3.54, 0.116, 1, 0, 0.2, 3, 0.22 + rng() * 0.18, 0.22 + rng() * 0.18, 0.28 + rng() * 0.18, 8);
    }
    // Buttress spire finial
    for (let s = 0; s < 16; s++) {
      const t = s / 16;
      const r = 0.24 * (1 - t);
      const a = s * 1.9;
      pushG(bx + Math.cos(a) * r, 5.35 + t * 0.88, -3.65 + Math.sin(a) * r, 0.105, Math.cos(a), 0.5, Math.sin(a), 3, 0.48, 0.50, 0.58, 8);
    }
  }
  // 3) Right Cathedral Transept Wing Wall (x = 7.98, z in [-3.9..0.55]) + Glowing Amber Right Lancet Window!
  for (let wy = 0.18; wy <= 5.65; wy += 0.160) {
    for (let wz = -3.85; wz <= 0.45; wz += 0.160) {
      const u = (wz - (-2.55)) / 1.80;
      const v = (wy - 1.15) / 2.60;
      let inW = false;
      if (u >= 0 && u <= 1 && v >= 0 && v <= 1) {
        const ax = Math.abs(u - 0.5) * 2.0;
        if (v < 0.52 && ax <= 0.90) inW = true;
        else if (v >= 0.52) {
          const dy = (v - 0.52) / 0.48;
          if (ax <= Math.sqrt(Math.max(0, 1 - dy * dy * 0.98)) * 0.90) inW = true;
        }
      }
      if (inW) {
        const gCol = 0.88 + rng() * 0.14;
        pushG(7.92, wy, wz, 0.118, -1, 0, 0, 3, 1.0 * gCol, 0.68 * gCol, 0.30 * gCol, 9);
      } else if (rng() > 0.14) {
        const sh = 0.26 + rng() * 0.26;
        pushG(7.94, wy, wz, 0.122, -1, 0, 0, 3, sh, sh, sh * 1.14, 8);
      }
    }
  }
  // 4) Steeply Pitched Cathedral Slate Roof (dense shimmering carpet of upright camera-facing micro-glyphs!)
  for (let row = 0; row < 38; row++) {
    const t = row / 37;
    const ry = 5.10 + t * 4.76;
    const rz = -3.72 - t * 4.10;
    const isRidge = row === 37;
    const stepX = isRidge ? 0.17 : 0.165;
    for (let rx = -10.0; rx <= 10.0; rx += stepX) {
      const sh = isRidge ? 0.80 : (0.28 + rng() * 0.26);
      pushG(rx, ry, rz, isRidge ? 0.135 : 0.118, 0, 0.65, 0.76, 3, sh, sh * 1.03, sh * 1.18, 8);
    }
  }
  // 5) Glowing Warm Amber Pointed-Arch Lancet Windows (4 tall bays on facade — pure upright camera-facing H # 0 T!)
  for (let i = 0; i < bayXs.length - 1; i++) {
    if (i === 3) continue;
    const cx = (bayXs[i] + bayXs[i + 1]) * 0.5;
    for (let wy = 0.78; wy <= 4.00; wy += 0.145) {
      for (let wx = cx - 0.94; wx <= cx + 0.94; wx += 0.135) {
        if (!isInsideWindow(wx, wy)) continue;
        // Subtle vertical/horizontal dark leaded-glass bar gaps
        const vBar = Math.abs(wx - cx) < 0.06;
        const hBar = Math.abs(wy - 2.10) < 0.06;
        if (vBar || hBar) continue;
        const gVar = 0.85 + rng() * 0.20;
        pushG(wx, wy, -3.84, 0.108, 0, 0, 1, 3, 1.0 * gVar, (0.64 + rng() * 0.22) * gVar, (0.24 + rng() * 0.18) * gVar, 9);
      }
    }
    // Haunted lavender wrought-iron cross over each window
    for (let wx = cx - 0.95; wx <= cx + 0.95; wx += 0.125) pushG(wx, 2.10, -3.74, 0.115, 0, 0, 1, 3, 0.74, 0.66, 1.0, 15);
    for (let wy = 0.75; wy <= 3.70; wy += 0.125) pushG(cx, wy, -3.74, 0.115, 0, 0, 1, 3, 0.74, 0.66, 1.0, 15);
  }
  // Central dark portal lavender gothic cross (bay 3: x = 2.7)
  for (let wy = 0.55; wy <= 3.40; wy += 0.12) pushG(2.7, wy, -3.70, 0.135, 0, 0, 1, 3, 0.78, 0.70, 1.0, 15);
  for (let wx = 1.90; wx <= 3.50; wx += 0.12) pushG(wx, 2.35, -3.70, 0.135, 0, 0, 1, 3, 0.78, 0.70, 1.0, 15);

  // 6) Haunted Lavender Wrought-Iron Terrace Fence (z = 3.72 — 100% upright camera-facing billboards + gold finials!)
  for (let fx = -10.8; fx <= 10.8; fx += 2.16) {
    for (let fy = 0.10; fy <= 1.40; fy += 0.12) {
      pushG(fx, fy, 3.72, 0.135, 0, 0, 1, 3, 0.74, 0.66, 1.0, 15);
    }
    // Warm candle-gold finial lantern tip atop each fence post!
    pushG(fx, 1.52, 3.72, 0.185, 0, 1, 0, 3, 1.0, 0.84, 0.42, 9);
  }
  for (let rx = -10.8; rx <= 10.8; rx += 0.145) {
    pushG(rx, 1.18, 3.72, 0.115, 0, 0, 1, 3, 0.70, 0.62, 1.0, 15);
    pushG(rx, 0.42, 3.72, 0.115, 0, 0, 1, 3, 0.66, 0.58, 0.96, 15);
  }
  for (let px = -10.4; px <= 10.4; px += 0.34) {
    for (let py = 0.46; py <= 1.14; py += 0.14) {
      pushG(px, py, 3.72, 0.095, 0, 0, 1, 3, 0.62, 0.54, 0.94, 15);
    }
  }

  // 7) Delicate floating ember & firefly sparks around hero & courtyard
  for (let i = 0; i < 48; i++) {
    const isHeroSpark = i < 30;
    const x = isHeroSpark ? (rng() - 0.5) * 0.95 : (rng() - 0.5) * 14.0;
    const y = isHeroSpark ? (0.35 + rng() * 1.15) : (0.6 + rng() * 3.4);
    const z = isHeroSpark ? (rng() - 0.5) * 0.70 : (-3.3 + rng() * 6.0);
    const warm = rng();
    const cr = 1.0;
    const cg = warm > 0.3 ? (0.66 + rng() * 0.24) : 0.34;
    const cb = warm > 0.3 ? 0.14 : 0.38;
    pushG(x, y, z, 0.036 + rng() * 0.018, 0, 1, 0, 4, cr, cg, cb, isHeroSpark ? 4 : 5);
  }

  return {
    data: new Float32Array(inst),
    instanceCount: inst.length / 12,
  };
}
