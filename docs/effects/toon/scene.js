// Procedural 3D Hero Diorama for Evolution of Toon & NPR Shading (1996-2026):
// A sleek stylized Ronin-Sentinel bust/knight on a floating carved mossy stone pedestal
// with V-tapered cuirass, layered samurai pauldrons, sculpted helmet & twin gold kuwagata crest,
// 3D-thickness flowing animated crimson scarf, and 3 orbiting arcane crystal shards.
//
// Each vertex stores 18 floats:
//   pos(3), norm(3), editNorm(3), uv(2), color(3), meta(4)
// where:
//   - norm:     true geometric surface normal
//   - editNorm: artist-edited smooth proxy normal (Guilty Gear Xrd clean anime shadow lines!)
//   - meta.x:   material ID / 16.0
//   - meta.y:   ILM baked AO / crevice shadow weight (0 = deep crease, 1 = clean)
//   - meta.z:   UV-aligned inner ink line mask (0..1)
//   - meta.w:   animation group (0 = pedestal, 1 = sentinel body, 2 = waving scarf, 3..5 = crystals)

function norm3(x, y, z) {
  const l = Math.hypot(x, y, z) || 1;
  return [x / l, y / l, z / l];
}

function cross3(a, b) {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}

function hash2(x, y) {
  const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
  return s - Math.floor(s);
}

class MeshBuilder {
  constructor() {
    this.verts = [];
    this.indices = [];
  }

  v(px, py, pz, nx, ny, nz, enx, eny, enz, u, v, r, g, b, matId, ao, innerLine, animGrp) {
    const n = norm3(nx, ny, nz);
    const en = norm3(enx, eny, enz);
    const idx = this.verts.length / 18;
    this.verts.push(
      px, py, pz,
      n[0], n[1], n[2],
      en[0], en[1], en[2],
      u, v,
      r, g, b,
      matId / 16.0, ao, innerLine, animGrp,
    );
    return idx;
  }

  tri(a, b, c) { this.indices.push(a, b, c); }
  quad(a, b, c, d) { this.indices.push(a, b, c, a, c, d); }

  addEllipsoid({
    cx, cy, cz, rx, ry, rz,
    segU = 28, segV = 18,
    color = [0.8, 0.8, 0.8],
    matId = 1, aoBase = 1.0, animGrp = 1,
    editCenter = null,
    deform = null,
    colorFn = null,
    innerFn = null,
    aoFn = null,
  }) {
    const start = this.verts.length / 18;
    const cols = segU + 1;
    const ec = editCenter || [cx, cy, cz];

    for (let j = 0; j <= segV; j++) {
      const vf = j / segV;
      const phi = vf * Math.PI;
      const sp = Math.sin(phi), cp = Math.cos(phi);
      for (let i = 0; i <= segU; i++) {
        const uf = i / segU;
        const theta = uf * Math.PI * 2;
        const st = Math.sin(theta), ct = Math.cos(theta);

        let lx = sp * st * rx;
        let ly = cp * ry;
        let lz = sp * ct * rz;
        let nx = sp * st / Math.max(1e-4, rx);
        let ny = cp / Math.max(1e-4, ry);
        let nz = sp * ct / Math.max(1e-4, rz);

        if (deform) {
          const d = deform(lx, ly, lz, uf, vf, nx, ny, nz);
          lx = d[0]; ly = d[1]; lz = d[2];
          if (d.length >= 6) { nx = d[3]; ny = d[4]; nz = d[5]; }
        }
        const px = cx + lx, py = cy + ly, pz = cz + lz;
        const enx = (px - ec[0]) / Math.max(0.25, rx);
        const eny = (py - ec[1]) / Math.max(0.25, ry * 1.15);
        const enz = (pz - ec[2]) / Math.max(0.25, rz);

        const col = colorFn ? colorFn(px, py, pz, uf, vf) : color;
        const ao = aoFn ? aoFn(px, py, pz, uf, vf) : aoBase;
        const inL = innerFn ? innerFn(px, py, pz, uf, vf) : 0.0;
        this.v(px, py, pz, nx, ny, nz, enx, eny, enz, uf, vf, col[0], col[1], col[2], matId, ao, inL, animGrp);
      }
    }

    for (let j = 0; j < segV; j++) {
      for (let i = 0; i < segU; i++) {
        const a = start + j * cols + i;
        this.quad(a, a + cols, a + cols + 1, a + 1);
      }
    }
  }

  // Sculpted curved armor plate / samurai sode pauldron with watertight 3D thickness & guaranteed outward winding!
  addCurvedPlate({
    side = 1,
    cx = 0, cy = 0, cz = 0,
    width = 0.72, height = 0.36, thick = 0.065,
    tiltZ = 0.56, curve = 0.20,
    segU = 10, segV = 6,
    color = [0.95, 0.95, 0.97],
    trimColor = [0.96, 0.75, 0.24],
    matId = 5, animGrp = 1,
    editCenter = null,
  }) {
    // Positive tiltZ * side tucks the top edge inward toward the collar and flares the bottom outward (/ \)!
    const ang = tiltZ * side;
    const ct = Math.cos(ang), st = Math.sin(ang);
    const evalPt = (u, v, sOff) => {
      // u in [-1..1] front-to-back (Z), v in [-1..1] top-to-bottom
      const lz = u * width * 0.50;
      const dome = (1.0 - u * u) * curve;
      const lx0 = side * (dome + sOff * thick * 0.5);
      const ly0 = -v * height * 0.5;
      const rx = lx0 * ct - ly0 * st;
      const ry = lx0 * st + ly0 * ct;
      return [cx + rx, cy + ry, cz + lz];
    };

    const ec = editCenter || [cx - side * 0.45, cy - 0.25, cz];
    const pushOrientedQuad = (i0, i1, i2, i3, wantN) => {
      const p0 = [this.verts[i0 * 18], this.verts[i0 * 18 + 1], this.verts[i0 * 18 + 2]];
      const p1 = [this.verts[i1 * 18], this.verts[i1 * 18 + 1], this.verts[i1 * 18 + 2]];
      const p2 = [this.verts[i2 * 18], this.verts[i2 * 18 + 1], this.verts[i2 * 18 + 2]];
      const e1 = [p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]];
      const e2 = [p2[0] - p0[0], p2[1] - p0[1], p2[2] - p0[2]];
      const fn = cross3(e1, e2);
      if (fn[0] * wantN[0] + fn[1] * wantN[1] + fn[2] * wantN[2] >= 0) this.quad(i0, i1, i2, i3);
      else this.quad(i0, i3, i2, i1);
    };

    const buildShell = (sOff) => {
      const start = this.verts.length / 18;
      const cols = segU + 1;
      for (let j = 0; j <= segV; j++) {
        const vf = j / segV;
        const v = vf * 2 - 1;
        for (let i = 0; i <= segU; i++) {
          const uf = i / segU;
          const u = uf * 2 - 1;
          const p = evalPt(u, v, sOff);
          const pMid = evalPt(u, v, 0);
          // Exact outward normal from plate centerline to outer/inner face!
          const n = norm3(p[0] - pMid[0], p[1] - pMid[1], p[2] - pMid[2]);
          const en = norm3(p[0] - ec[0], p[1] - ec[1], p[2] - ec[2]);
          const isTrim = vf > 0.78 || uf < 0.09 || uf > 0.91;
          const col = isTrim ? trimColor : color;
          const inl = (Math.abs(vf - 0.78) < 0.08) ? 0.92 : 0.0;
          const ao = 0.78 + 0.22 * (1.0 - vf);
          this.v(p[0], p[1], p[2], n[0], n[1], n[2], en[0], en[1], en[2], uf, vf, col[0], col[1], col[2], matId, ao, inl, animGrp);
        }
      }
      for (let j = 0; j < segV; j++) {
        for (let i = 0; i < segU; i++) {
          const a = start + j * cols + i;
          const wantN = [this.verts[a * 18 + 3], this.verts[a * 18 + 4], this.verts[a * 18 + 5]];
          pushOrientedQuad(a, a + 1, a + cols + 1, a + cols, wantN);
        }
      }
      return { start, cols };
    };

    const outer = buildShell(1);
    const inner = buildShell(-1);
    const stitchRim = (a0, a1, b0, b1, wantDir) => {
      pushOrientedQuad(a0, a1, b1, b0, wantDir);
    };
    for (let i = 0; i < segU; i++) {
      stitchRim(outer.start + i, outer.start + i + 1, inner.start + i, inner.start + i + 1, [0, 1, 0]);
      const r = segV * outer.cols;
      stitchRim(outer.start + r + i, outer.start + r + i + 1, inner.start + r + i, inner.start + r + i + 1, [0, -1, 0]);
    }
    for (let j = 0; j < segV; j++) {
      const r0 = j * outer.cols, r1 = (j + 1) * outer.cols;
      stitchRim(outer.start + r0, outer.start + r1, inner.start + r0, inner.start + r1, [0, 0, -1]);
      stitchRim(outer.start + r0 + segU, outer.start + r1 + segU, inner.start + r0 + segU, inner.start + r1 + segU, [0, 0, 1]);
    }
  }

  addLathe({
    profile,
    cx = 0, cz = 0,
    segU = 24,
    color = [0.6, 0.6, 0.65],
    matId = 2, animGrp = 0,
    faceted = false,
    noiseAmp = 0.0,
    editCenter = null,
    colorFn = null,
  }) {
    const rings = profile.length;
    if (faceted) {
      for (let j = 0; j < rings - 1; j++) {
        const [r0, y0, ao0 = 1, in0 = 0] = profile[j];
        const [r1, y1, ao1 = 1, in1 = 0] = profile[j + 1];
        for (let i = 0; i < segU; i++) {
          const u0 = i / segU, u1 = (i + 1) / segU;
          const a0 = u0 * Math.PI * 2, a1 = u1 * Math.PI * 2;
          const j0 = 1 + (hash2(i, j) - 0.5) * noiseAmp;
          const j1 = 1 + (hash2((i + 1) % segU, j) - 0.5) * noiseAmp;
          const j2 = 1 + (hash2((i + 1) % segU, j + 1) - 0.5) * noiseAmp;
          const j3 = 1 + (hash2(i, j + 1) - 0.5) * noiseAmp;

          const p0 = [cx + Math.sin(a0) * r0 * j0, y0, cz + Math.cos(a0) * r0 * j0];
          const p1 = [cx + Math.sin(a1) * r0 * j1, y0, cz + Math.cos(a1) * r0 * j1];
          const p2 = [cx + Math.sin(a1) * r1 * j2, y1, cz + Math.cos(a1) * r1 * j2];
          const p3 = [cx + Math.sin(a0) * r1 * j3, y1, cz + Math.cos(a0) * r1 * j3];

          const e1 = [p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]];
          const e2 = [p3[0] - p0[0], p3[1] - p0[1], p3[2] - p0[2]];
          const n = norm3(...cross3(e1, e2));

          const pts = [
            [p0, u0, j / (rings - 1), ao0, in0],
            [p1, u1, j / (rings - 1), ao0, in0],
            [p2, u1, (j + 1) / (rings - 1), ao1, in1],
            [p3, u0, (j + 1) / (rings - 1), ao1, in1],
          ];
          const idxs = pts.map(([p, u, v, ao, inl]) => {
            const col = colorFn ? colorFn(p[0], p[1], p[2], u, v) : color;
            const en = editCenter ? norm3(p[0] - editCenter[0], p[1] - editCenter[1], p[2] - editCenter[2]) : n;
            return this.v(p[0], p[1], p[2], n[0], n[1], n[2], en[0], en[1], en[2], u, v, col[0], col[1], col[2], matId, ao, inl, animGrp);
          });
          this.quad(idxs[0], idxs[1], idxs[2], idxs[3]);
        }
      }
      return;
    }

    const start = this.verts.length / 18;
    const cols = segU + 1;
    for (let j = 0; j < rings; j++) {
      const [r, y, ao = 1, inl = 0] = profile[j];
      const rp = profile[Math.max(0, j - 1)];
      const rn = profile[Math.min(rings - 1, j + 1)];
      const dr = rn[0] - rp[0];
      const dy = rn[1] - rp[1];
      const vf = j / Math.max(1, rings - 1);
      for (let i = 0; i <= segU; i++) {
        const uf = i / segU;
        const ang = uf * Math.PI * 2;
        const sa = Math.sin(ang), ca = Math.cos(ang);
        const px = cx + sa * r, pz = cz + ca * r;
        const n = norm3(sa * dy, -dr, ca * dy);
        const en = editCenter ? norm3(px - editCenter[0], y - editCenter[1], pz - editCenter[2]) : n;
        const col = colorFn ? colorFn(px, y, pz, uf, vf) : color;
        this.v(px, y, pz, n[0], n[1], n[2], en[0], en[1], en[2], uf, vf, col[0], col[1], col[2], matId, ao, inl, animGrp);
      }
    }
    for (let j = 0; j < rings - 1; j++) {
      for (let i = 0; i < segU; i++) {
        const a = start + j * cols + i;
        this.quad(a, a + 1, a + cols + 1, a + cols);
      }
    }
  }

  addTube({ points, segR = 12, color = [0.95, 0.74, 0.24], matId = 4, animGrp = 1, innerLine = 0.0 }) {
    const start = this.verts.length / 18;
    const cols = segR + 1;
    const nPts = points.length;
    for (let j = 0; j < nPts; j++) {
      const cur = points[j];
      const prev = points[Math.max(0, j - 1)].p;
      const next = points[Math.min(nPts - 1, j + 1)].p;
      const tang = norm3(next[0] - prev[0], next[1] - prev[1], next[2] - prev[2]);
      const upRef = Math.abs(tang[1]) > 0.9 ? [1, 0, 0] : [0, 1, 0];
      const side = norm3(...cross3(tang, upRef));
      const up = norm3(...cross3(side, tang));
      const vf = j / Math.max(1, nPts - 1);
      for (let i = 0; i <= segR; i++) {
        const uf = i / segR;
        const ang = uf * Math.PI * 2;
        const ca = Math.cos(ang), sa = Math.sin(ang);
        const nx = side[0] * ca + up[0] * sa;
        const ny = side[1] * ca + up[1] * sa;
        const nz = side[2] * ca + up[2] * sa;
        const px = cur.p[0] + nx * cur.r;
        const py = cur.p[1] + ny * cur.r;
        const pz = cur.p[2] + nz * cur.r;
        const seam = (Math.abs(uf - 0.25) < 0.06 || Math.abs(uf - 0.75) < 0.06) ? innerLine : 0.0;
        this.v(px, py, pz, nx, ny, nz, nx, ny, nz, uf, vf, color[0], color[1], color[2], matId, cur.ao ?? 1.0, seam, animGrp);
      }
    }
    for (let j = 0; j < nPts - 1; j++) {
      for (let i = 0; i < segR; i++) {
        const a = start + j * cols + i;
        this.quad(a, a + cols, a + cols + 1, a + 1);
      }
    }
  }

  addCrystal({ cx, cy, cz, r = 0.17, h = 0.48, color = [0.22, 0.88, 0.96], matId = 8, animGrp = 3 }) {
    const sides = 6;
    const top = [cx, cy + h * 0.56, cz];
    const bot = [cx, cy - h * 0.44, cz];
    const mid = [];
    for (let i = 0; i < sides; i++) {
      const a = (i / sides) * Math.PI * 2;
      mid.push([cx + Math.sin(a) * r, cy + 0.04, cz + Math.cos(a) * r]);
    }
    const pushFace = (p0, p1, p2, ao) => {
      const e1 = [p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]];
      const e2 = [p2[0] - p0[0], p2[1] - p0[1], p2[2] - p0[2]];
      const n = norm3(...cross3(e1, e2));
      const a = this.v(p0[0], p0[1], p0[2], n[0], n[1], n[2], n[0], n[1], n[2], 0, 0, color[0], color[1], color[2], matId, ao, 0.0, animGrp);
      const b = this.v(p1[0], p1[1], p1[2], n[0], n[1], n[2], n[0], n[1], n[2], 1, 0, color[0], color[1], color[2], matId, ao, 0.0, animGrp);
      const c = this.v(p2[0], p2[1], p2[2], n[0], n[1], n[2], n[0], n[1], n[2], 0.5, 1, color[0], color[1], color[2], matId, ao, 0.0, animGrp);
      this.tri(a, b, c);
    };
    for (let i = 0; i < sides; i++) {
      const m0 = mid[i], m1 = mid[(i + 1) % sides];
      pushFace(m0, m1, top, 1.0);
      pushFace(m1, m0, bot, 0.82);
    }
  }

  build() {
    return { vertices: new Float32Array(this.verts), indices: new Uint32Array(this.indices) };
  }
}

export function buildToonDiorama() {
  const mb = new MeshBuilder();

  // ==========================================================================
  // 1. FLOATING CARVED STONE PEDESTAL + EMERALD MOSS CAP + GOLD RUNED RING
  // ==========================================================================
  mb.addLathe({
    profile: [
      [0.01, -1.55, 0.48, 0.0],
      [0.44, -1.36, 0.58, 0.0],
      [0.88, -1.02, 0.68, 0.0],
      [1.24, -0.62, 0.78, 0.0],
      [1.46, -0.28, 0.90, 0.0],
      [1.54, -0.14, 0.95, 0.0],
    ],
    segU: 16,
    matId: 1, animGrp: 0,
    faceted: true, noiseAmp: 0.14,
    colorFn: (x, y) => {
      const t = Math.max(0, Math.min(1, (y + 1.55) / 1.42));
      return [0.34 + t * 0.18, 0.36 + t * 0.16, 0.44 + t * 0.15];
    },
  });

  mb.addLathe({
    profile: [
      [1.52, -0.16, 0.80, 0.0],
      [1.60, -0.04, 0.96, 0.0],
      [1.50,  0.05, 1.00, 0.0],
      [1.06,  0.08, 1.00, 0.0],
      [0.48,  0.09, 0.96, 0.0],
      [0.01,  0.09, 0.94, 0.0],
    ],
    segU: 28,
    matId: 2, animGrp: 0,
    colorFn: (x, y, z) => {
      const r = Math.hypot(x, z);
      const rim = Math.max(0, Math.min(1, (r - 0.88) / 0.72));
      return [0.22 + rim * 0.08, 0.68 - rim * 0.12, 0.34 - rim * 0.05];
    },
  });

  mb.addLathe({
    profile: [
      [1.10, 0.07, 0.88, 0.0],
      [1.14, 0.13, 1.00, 0.6],
      [1.02, 0.15, 1.00, 0.0],
      [0.98, 0.08, 0.85, 0.0],
    ],
    segU: 32,
    color: [0.96, 0.74, 0.24],
    matId: 4, animGrp: 0,
  });

  mb.addEllipsoid({ cx: -1.04, cy: 0.15, cz: 0.62, rx: 0.24, ry: 0.15, rz: 0.21, segU: 12, segV: 8, color: [0.54, 0.56, 0.62], matId: 1, animGrp: 0 });
  mb.addEllipsoid({ cx:  1.02, cy: 0.16, cz: 0.54, rx: 0.20, ry: 0.16, rz: 0.19, segU: 12, segV: 8, color: [0.50, 0.52, 0.58], matId: 1, animGrp: 0 });
  mb.addEllipsoid({ cx: -0.92, cy: 0.18, cz: -0.76, rx: 0.28, ry: 0.20, rz: 0.24, segU: 12, segV: 8, color: [0.48, 0.50, 0.58], matId: 1, animGrp: 0 });

  // ==========================================================================
  // 2. SLEEK HEROIC V-TAPERED RONIN-SENTINEL TORSO & LAYERED SAMURAI PAULDRONS
  // ==========================================================================
  // Athletic V-taper waist -> broad heroic armored shoulders!
  mb.addLathe({
    profile: [
      [0.54, 0.08, 0.72, 0.0], // armored skirt flare
      [0.44, 0.26, 0.84, 0.0],
      [0.37, 0.44, 0.90, 0.85], // slim heroic waist + belt seam
      [0.42, 0.56, 0.96, 0.0],
      [0.64, 0.96, 1.00, 0.0], // broad chest
      [0.62, 1.24, 0.98, 0.0], // upper collarbone
      [0.36, 1.38, 0.82, 0.75], // gorget collar crease
    ],
    segU: 32,
    matId: 3, animGrp: 1,
    editCenter: [0, 0.88, 0.08],
    colorFn: (x, y, z) => {
      if (y > 0.39 && y < 0.51) return [0.96, 0.74, 0.24]; // Gold sash belt
      if (y < 0.30) return [0.14, 0.22, 0.46]; // Deep navy armored hakama/tassets
      if (y > 0.62 && y < 1.20 && z > 0.26 && Math.abs(x) < 0.28) return [0.94, 0.94, 0.97];
      return [0.16, 0.38, 0.76]; // Heroic cobalt armor
    },
  });

  // Sculpted Angular Chest Breastplate (clean silhouette + crisp anime panel seams!)
  mb.addEllipsoid({
    cx: 0, cy: 0.98, cz: 0.14, rx: 0.62, ry: 0.38, rz: 0.48,
    segU: 32, segV: 20,
    matId: 3, animGrp: 1,
    editCenter: [0, 0.96, 0.0],
    deform: (lx, ly, lz, u, v, nx, ny, nz) => {
      // Taper lower ribcage into sharp V-chest!
      const taper = 1.0 - Math.max(0, -ly / 0.38) * 0.28;
      const keel = Math.exp(-Math.pow(lx / 0.12, 2)) * (lz > 0 ? 0.055 : 0.0);
      return [lx * taper, ly, lz + keel, nx, ny, nz];
    },
    colorFn: (x, y, z) => {
      const d = Math.abs(x) * 1.45 + Math.abs(y - 1.02) * 1.20;
      if (z > 0.42 && d < 0.20) return [0.98, 0.78, 0.24]; // Gold diamond crest!
      if (z > 0.39 && d < 0.26) return [0.10, 0.18, 0.42]; // Dark navy bezel
      if (y > 1.20) return [0.94, 0.95, 0.98];
      return [0.18, 0.42, 0.82];
    },
    innerFn: (x, y, z) => {
      if (z > 0.20 && (Math.abs(Math.abs(x) - 0.26) < 0.022 || Math.abs(y - 0.80) < 0.018)) return 0.95;
      return 0.0;
    },
    aoFn: (x, y) => (y < 0.72 ? 0.65 : 1.0),
  });

  // Layered Samurai Sode / Swept Knight Pauldrons (draping heroically DOWNWARD & OUTWARD over the shoulders!)
  for (const side of [-1, 1]) {
    // Upper porcelain-white swept shoulder plate with gold rim
    mb.addCurvedPlate({
      side, cx: side * 0.72, cy: 1.24, cz: 0.02,
      width: 0.78, height: 0.42, thick: 0.075,
      tiltZ: 0.56, curve: 0.18,
      color: [0.95, 0.95, 0.97], trimColor: [0.96, 0.75, 0.24],
      matId: 5, animGrp: 1,
      editCenter: [side * 0.35, 1.02, 0.0],
    });
    // Lower cobalt secondary shoulder lame underneath
    mb.addCurvedPlate({
      side, cx: side * 0.86, cy: 0.92, cz: 0.02,
      width: 0.66, height: 0.32, thick: 0.068,
      tiltZ: 0.30, curve: 0.14,
      color: [0.18, 0.40, 0.80], trimColor: [0.96, 0.75, 0.24],
      matId: 3, animGrp: 1,
      editCenter: [side * 0.48, 0.82, 0.0],
    });
    // Dark armored upper-arm core tucked neatly under the pauldrons
    mb.addEllipsoid({
      cx: side * 0.64, cy: 0.86, cz: 0.02, rx: 0.20, ry: 0.26, rz: 0.22,
      segU: 16, segV: 12, color: [0.12, 0.17, 0.32], matId: 3, animGrp: 1, aoBase: 0.65,
    });
  }

  // Sculpted Crimson Scarf Collar wrapped around neck
  mb.addEllipsoid({
    cx: 0, cy: 1.38, cz: 0.04, rx: 0.44, ry: 0.17, rz: 0.42,
    segU: 28, segV: 14,
    matId: 6, animGrp: 1,
    editCenter: [0, 1.40, 0.05],
    deform: (lx, ly, lz, u, v, nx, ny, nz) => {
      const fold = Math.sin(u * Math.PI * 10.0) * 0.018;
      return [lx * (1 + fold), ly + Math.cos(u * Math.PI * 6.0) * 0.015, lz * (1 + fold), nx, ny, nz];
    },
    colorFn: (x, y) => (y < 1.31 ? [0.76, 0.13, 0.19] : [0.92, 0.19, 0.24]),
    innerFn: (x, y, z, u, v) => (Math.abs(v - 0.45) < 0.035 || Math.abs(v - 0.70) < 0.03) ? 0.85 : 0.0,
    aoFn: (x, y) => (y < 1.29 ? 0.62 : 0.96),
  });

  // ==========================================================================
  // 3. SLEEK HEROIC RONIN-MECHA HELMET, VISOR & TWIN GOLD KUWAGATA HORNS
  // ==========================================================================
  mb.addEllipsoid({
    cx: 0, cy: 1.92, cz: 0.02, rx: 0.48, ry: 0.56, rz: 0.52,
    segU: 36, segV: 24,
    matId: 7, animGrp: 1,
    editCenter: [0, 1.94, 0.08], // Smooth anime head normal proxy!
    deform: (lx, ly, lz, u, v, nx, ny, nz) => {
      let dx = lx, dy = ly, dz = lz;
      const chin = Math.max(0, -ly / 0.56);
      dx *= (1.0 - chin * 0.30); // Sleek heroic tapered samurai jaw!
      const brow = Math.exp(-Math.pow((ly - 0.09) / 0.065, 2)) * (lz > 0.15 ? 0.042 : 0.0);
      const crest = Math.exp(-Math.pow(lx / 0.075, 2)) * (ly > 0.08 ? 0.04 : 0.0);
      dz += brow + crest;
      // Geometric brow/cheek creases visible under raw 3D normals, smoothed cleanly by Guilty Gear Xrd editNorm!
      const pnx = nx + Math.sin(lx * 15.0) * 0.16 * (lz > 0.15 ? 1 : 0);
      const pny = ny + Math.sin((ly - 0.07) * 28.0) * 0.28 * (lz > 0.18 ? 1 : 0);
      return [dx, dy, dz, pnx, pny, nz];
    },
    colorFn: (x, y, z) => {
      if (z > 0.32 && y > 1.72 && y < 1.97 && Math.abs(x) < 0.34) {
        // Sharp determined anime eyes glowing cyan inside dark obsidian visor!
        const ex = Math.abs(x) - 0.135;
        const ey = (y - 1.845 + ex * 0.22) * 1.65;
        if (ex * ex + ey * ey < 0.0038) return [0.32, 0.98, 1.00];
        return [0.09, 0.12, 0.22];
      }
      if (Math.abs(x) > 0.36 && y < 2.02) return [0.16, 0.38, 0.78]; // Cobalt ear/temple guards
      if (y > 2.26 && Math.abs(x) < 0.09) return [0.94, 0.20, 0.24]; // Crimson top crest
      return [0.96, 0.95, 0.93];
    },
    innerFn: (x, y, z) => {
      if (z > 0.28 && Math.abs(x) < 0.37) {
        if (Math.abs(y - 1.97) < 0.015 || Math.abs(y - 1.72) < 0.015) return 1.0;
      }
      if (z > 0.24 && Math.abs(Math.abs(x) - 0.34) < 0.016 && y > 1.70 && y < 1.99) return 0.95;
      if (y > 2.00 && Math.abs(Math.abs(x) - 0.11) < 0.014) return 0.88;
      return 0.0;
    },
    aoFn: (x, y, z) => {
      if (y < 1.52) return 0.50;
      if (z > 0.28 && y > 1.94 && y < 2.02) return 0.58;
      return 1.0;
    },
  });

  // Swept Golden Kuwagata V-Crest Horns
  for (const side of [-1, 1]) {
    const pts = [];
    for (let k = 0; k <= 10; k++) {
      const t = k / 10;
      pts.push({
        p: [
          side * (0.04 + t * 0.78),
          2.16 + Math.pow(t, 1.32) * 0.72 - Math.sin(t * Math.PI) * 0.06,
          0.42 - t * 0.36,
        ],
        r: (0.090 * (1.0 - t * 0.84)) + 0.014,
        ao: 0.76 + t * 0.24,
      });
    }
    mb.addTube({ points: pts, segR: 12, color: [0.98, 0.76, 0.22], matId: 4, animGrp: 1, innerLine: 0.88 });
  }
  mb.addEllipsoid({ cx: 0, cy: 2.16, cz: 0.48, rx: 0.095, ry: 0.13, rz: 0.08, segU: 14, segV: 10, color: [0.95, 0.18, 0.26], matId: 6, animGrp: 1 });

  // ==========================================================================
  // 4. WATERTIGHT 3D-THICKNESS FLOWING CRIMSON SCARF (zero Inverted-Hull z-fight!)
  // ==========================================================================
  const scU = 22, scV = 6;
  const scCols = scV + 1;
  const halfT = 0.022;
  const evalScarf = (t, vf, sideSign) => {
    const bx = 0.22 + t * 1.56;
    const by = 1.38 - Math.sin(t * 2.1) * 0.16 - t * 0.28;
    const bz = -0.34 - t * 0.42;
    const halfW = (0.16 + Math.sin(t * Math.PI * 0.85) * 0.12) * (1.0 - t * 0.20);
    const wOff = (vf - 0.5) * 2.0 * halfW;
    return [bx, by + wOff, bz + Math.cos(vf * Math.PI) * 0.04 + sideSign * halfT];
  };

  const buildScarfSide = (sideSign) => {
    const start = mb.verts.length / 18;
    for (let i = 0; i <= scU; i++) {
      const t = i / scU;
      for (let j = 0; j <= scV; j++) {
        const vf = j / scV;
        const p = evalScarf(t, vf, sideSign);
        const isTrim = (vf < 0.17 || vf > 0.83 || t > 0.88);
        const col = isTrim ? [0.98, 0.78, 0.26] : [0.92, 0.17, 0.23];
        const inl = (Math.abs(vf - 0.18) < 0.05 || Math.abs(vf - 0.82) < 0.05) ? 0.90 : 0.0;
        const ao = 0.76 + 0.24 * t;
        const nz = sideSign * 0.96;
        mb.v(p[0], p[1], p[2], 0.12 * sideSign, 0.22 * sideSign, nz, 0.12 * sideSign, 0.22 * sideSign, nz, t, vf, col[0], col[1], col[2], 6, ao, inl, 2);
      }
    }
    for (let i = 0; i < scU; i++) {
      for (let j = 0; j < scV; j++) {
        const a = start + i * scCols + j;
        if (sideSign > 0) mb.quad(a, a + scCols, a + scCols + 1, a + 1);
        else mb.quad(a, a + 1, a + scCols + 1, a + scCols);
      }
    }
    return start;
  };
  const scFront = buildScarfSide(1);
  const scBack  = buildScarfSide(-1);
  // Stitch top, bottom & fluttering tail edges so scarf is a solid watertight ribbon!
  for (let i = 0; i < scU; i++) {
    const f0 = scFront + i * scCols, f1 = f0 + scCols;
    const b0 = scBack  + i * scCols, b1 = b0 + scCols;
    mb.quad(f0, b0, b1, f1);
    mb.quad(f0 + scV, f1 + scV, b1 + scV, b0 + scV);
  }
  for (let j = 0; j < scV; j++) {
    const fe = scFront + scU * scCols + j;
    const be = scBack  + scU * scCols + j;
    mb.quad(fe, be, be + 1, fe + 1);
  }

  // ==========================================================================
  // 5. THREE ORBITING ARCANE CRYSTAL SHARDS (animGrp=3, 4, 5)
  // ==========================================================================
  mb.addCrystal({ cx: 0, cy: 0, cz: 0, r: 0.17, h: 0.48, color: [0.22, 0.90, 0.98], matId: 8, animGrp: 3 });
  mb.addCrystal({ cx: 0, cy: 0, cz: 0, r: 0.15, h: 0.42, color: [1.00, 0.62, 0.18], matId: 9, animGrp: 4 });
  mb.addCrystal({ cx: 0, cy: 0, cz: 0, r: 0.14, h: 0.38, color: [0.96, 0.32, 0.66], matId: 10, animGrp: 5 });

  return mb.build();
}
