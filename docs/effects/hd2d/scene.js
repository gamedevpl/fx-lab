// Procedural 3D Dungeon Courtyard Diorama mesh builder + animated low-res 3D / 2D-sprite duelists,
// lit top/bottom Tilt-Shift landmarks (upper gothic windows, cyan arcane shrine, foreground braziers),
// and deterministic HDR fire/spark billboards for FX Lab #29: HD-2D Miniature Diorama.

import {
  TEX_BRICK, TEX_FLOOR, TEX_DOOR, TEX_BANNER,
  TEX_CAP, TEX_WOOD, TEX_WINDOW, TEX_WATER,
} from "./textures.js";
import { getFightersMeshes } from "./fighters-mesh.js";

// Vertex stride: 15 floats [px,py,pz, nx,ny,nz, tx,ty,tz, u,v, texId, cr,cg,cb]
// texId >= 0: sample Texture2DArray layer; texId == -1: matte/metallic vertex color; texId == -2: HDR emissive solid!
export const VERT_FLOATS = 15;

class MeshBuilder {
  constructor() {
    this.v = [];
    this.idx = [];
  }

  quad(p0, p1, p2, p3, n, t, uv0, uv1, uv2, uv3, texId, tint = [1, 1, 1]) {
    const base = this.v.length / VERT_FLOATS;
    const pts = [p0, p1, p2, p3];
    const uvs = [uv0, uv1, uv2, uv3];
    for (let i = 0; i < 4; i++) {
      this.v.push(
        pts[i][0], pts[i][1], pts[i][2],
        n[0], n[1], n[2],
        t[0], t[1], t[2],
        uvs[i][0], uvs[i][1],
        texId,
        tint[0], tint[1], tint[2],
      );
    }
    this.idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }

  // Axis-aligned box [x0..x1, y0..y1, z0..z1] with world-scaled pixel-art UV density!
  box(x0, y0, z0, x1, y1, z1, sideTex, topTex = sideTex, uvScale = 0.55, tint = [1, 1, 1], topTint = tint, skipBottom = true) {
    const dx = x1 - x0, dy = y1 - y0, dz = z1 - z0;
    const uX = dx * uvScale, uY = dy * uvScale, uZ = dz * uvScale;
    // +Z front
    this.quad([x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1], [0, 0, 1], [1, 0, 0], [0, uY], [uX, uY], [uX, 0], [0, 0], sideTex, tint);
    // -Z back
    this.quad([x1, y0, z0], [x0, y0, z0], [x0, y1, z0], [x1, y1, z0], [0, 0, -1], [-1, 0, 0], [0, uY], [uX, uY], [uX, 0], [0, 0], sideTex, tint);
    // +X right
    this.quad([x1, y0, z1], [x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [1, 0, 0], [0, 0, -1], [0, uY], [uZ, uY], [uZ, 0], [0, 0], sideTex, tint);
    // -X left
    this.quad([x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0], [-1, 0, 0], [0, 0, 1], [0, uY], [uZ, uY], [uZ, 0], [0, 0], sideTex, tint);
    // +Y top
    const topUvS = topTex === TEX_CAP ? 0.35 : uvScale;
    this.quad([x0, y1, z1], [x1, y1, z1], [x1, y1, z0], [x0, y1, z0], [0, 1, 0], [1, 0, 0], [0, 0], [dx * topUvS, 0], [dx * topUvS, dz * topUvS], [0, dz * topUvS], topTex, topTint);
    if (!skipBottom) {
      this.quad([x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1], [0, -1, 0], [1, 0, 0], [0, 0], [dx * uvScale, 0], [dx * uvScale, dz * uvScale], [0, dz * uvScale], sideTex, tint);
    }
  }

  // Rotated box around Y axis centered at (cx, cy, cz) with half-extents (hx, hy, hz)
  rotBox(cx, cy, cz, hx, hy, hz, yaw, texId, tint = [1, 1, 1], uvScale = 1.0) {
    const c = Math.cos(yaw), s = Math.sin(yaw);
    const xf = (lx, ly, lz) => [cx + lx * c + lz * s, cy + ly, cz - lx * s + lz * c];
    const nf = (lx, ly, lz) => [lx * c + lz * s, ly, -lx * s + lz * c];
    const uX = hx * 2 * uvScale, uY = hy * 2 * uvScale, uZ = hz * 2 * uvScale;
    // +Z
    this.quad(xf(-hx, -hy, hz), xf(hx, -hy, hz), xf(hx, hy, hz), xf(-hx, hy, hz), nf(0, 0, 1), nf(1, 0, 0), [0, uY], [uX, uY], [uX, 0], [0, 0], texId, tint);
    // -Z
    this.quad(xf(hx, -hy, -hz), xf(-hx, -hy, -hz), xf(-hx, hy, -hz), xf(hx, hy, -hz), nf(0, 0, -1), nf(-1, 0, 0), [0, uY], [uX, uY], [uX, 0], [0, 0], texId, tint);
    // +X
    this.quad(xf(hx, -hy, hz), xf(hx, -hy, -hz), xf(hx, hy, -hz), xf(hx, hy, hz), nf(1, 0, 0), nf(0, 0, -1), [0, uY], [uZ, uY], [uZ, 0], [0, 0], texId, tint);
    // -X
    this.quad(xf(-hx, -hy, -hz), xf(-hx, -hy, hz), xf(-hx, hy, hz), xf(-hx, hy, -hz), nf(-1, 0, 0), nf(0, 0, 1), [0, uY], [uZ, uY], [uZ, 0], [0, 0], texId, tint);
    // +Y
    this.quad(xf(-hx, hy, hz), xf(hx, hy, hz), xf(hx, hy, -hz), xf(-hx, hy, -hz), [0, 1, 0], nf(1, 0, 0), [0, 0], [uX, 0], [uX, uZ], [0, uZ], texId, tint);
    // -Y
    this.quad(xf(-hx, -hy, -hz), xf(hx, -hy, -hz), xf(hx, -hy, hz), xf(-hx, -hy, hz), [0, -1, 0], nf(1, 0, 0), [0, 0], [uX, 0], [uX, uZ], [0, uZ], texId, tint);
  }

  // Dedicated mapped front-facing panel (door, crimson banner niche, gothic window)
  panelZ(x0, y0, x1, y1, z, texId, tint = [1, 1, 1]) {
    this.quad([x0, y0, z], [x1, y0, z], [x1, y1, z], [x0, y1, z], [0, 0, 1], [1, 0, 0], [0, 1], [1, 1], [1, 0], [0, 0], texId, tint);
  }

  // Stone brazier stand + iron bowl
  brazier(x, y, z) {
    // Stone pedestal
    this.box(x - 0.30, y, z - 0.30, x + 0.30, y + 0.52, z + 0.30, TEX_BRICK, TEX_FLOOR, 0.78, [0.88, 0.86, 0.92]);
    // Dark wrought-iron rim & basin
    this.box(x - 0.36, y + 0.52, z - 0.36, x + 0.36, y + 0.76, z + 0.36, -1, -1, 1.0, [0.16, 0.18, 0.24]);
    // Recessed dark iron inner lip
    this.box(x - 0.28, y + 0.76, z - 0.28, x + 0.28, y + 0.80, z + 0.28, -1, -1, 1.0, [0.10, 0.11, 0.15]);
    // Compact hot amber ember core (melts into round bokeh on Step 7!)
    this.box(x - 0.16, y + 0.78, z - 0.16, x + 0.16, y + 0.90, z + 0.16, -2, -2, 1.0, [3.6, 1.45, 0.32]);
  }

  // Wall-mounted iron sconce bracket
  sconce(x, y, z, dirX, dirZ) {
    const cx = x + dirX * 0.14, cz = z + dirZ * 0.14;
    this.box(cx - 0.08, y - 0.22, cz - 0.08, cx + 0.08, y + 0.04, cz + 0.08, -1, -1, 1.0, [0.24, 0.25, 0.30]);
    // Glowing ember tip
    this.box(cx - 0.07, y + 0.04, cz - 0.07, cx + 0.07, y + 0.16, cz + 0.07, -2, -2, 1.0, [3.8, 2.0, 0.65]);
  }

  finish() {
    return {
      verts: new Float32Array(this.v),
      indices: new Uint32Array(this.idx),
    };
  }
}

export function buildStaticDungeon() {
  const m = new MeshBuilder();

  // ================= 1. MAIN COURTYARD FLOOR & MOAT =================
  // Wide outer dark dungeon base so camera orbits never reveal void gaps
  m.box(-12.5, -0.85, -10.5, 11.5, -0.58, 11.5, TEX_WATER, TEX_WATER, 0.36, [0.70, 0.80, 0.95], [0.75, 0.88, 1.0], true);

  // Main stone courtyard slabs (with recessed subterranean moat/canal on the right, matching reference!)
  m.box(-7.5, -0.58, -3.5, 1.9, 0.0, 4.9, TEX_BRICK, TEX_FLOOR, 0.56);
  // Right courtyard strip behind the moat
  m.box(1.9, -0.58, -3.5, 6.8, 0.0, 1.15, TEX_BRICK, TEX_FLOOR, 0.56);
  // Far-right embankment across the canal
  m.box(4.8, -0.58, 1.15, 8.2, 0.0, 5.4, TEX_BRICK, TEX_FLOOR, 0.56);
  // Stone bridge crossing the dark canal (echoing reference right side!)
  m.box(1.9, -0.22, 1.85, 4.8, -0.02, 3.35, TEX_BRICK, TEX_FLOOR, 0.60, [0.92, 0.90, 0.95]);
  // Low stone bridge curbs & flanking bridge gate pillars
  m.box(1.82, 0.0, 1.20, 2.26, 1.25, 1.64, TEX_BRICK, TEX_CAP, 0.72);
  m.box(1.82, 0.0, 3.45, 2.26, 0.96, 3.89, TEX_BRICK, TEX_CAP, 0.72);
  m.box(4.52, 0.0, 1.20, 4.96, 1.15, 1.64, TEX_BRICK, TEX_CAP, 0.72);
  m.box(4.52, 0.0, 3.45, 4.96, 0.95, 3.89, TEX_BRICK, TEX_CAP, 0.72);
  // Moat stone bridge wall sconce
  m.sconce(4.52, 0.98, 2.55, -1, 0);

  // ================= 2. ICONIC L-SHAPED DUNGEON WALL (CENTER FOCAL BAND) =================
  // Left main wall segment (runs along z = -1.35, dark cutaway top cap at y = 2.25)
  m.box(-6.6, 0.0, -2.55, -0.45, 2.25, -1.35, TEX_BRICK, TEX_CAP, 0.58);
  // Inner corner protruding pier (creates the signature stepped L-corner from reference!)
  m.box(-0.45, 0.0, -2.55, 0.42, 2.25, -0.58, TEX_BRICK, TEX_CAP, 0.58);
  // Right main wall segment behind the duel & wooden doorway
  m.box(0.42, 0.0, -2.55, 5.45, 2.25, -1.35, TEX_BRICK, TEX_CAP, 0.58);
  // Right return wall extending back
  m.box(4.65, 0.0, -4.4, 5.65, 2.25, -1.35, TEX_BRICK, TEX_CAP, 0.58);

  // Recessed Crimson Tapestry / Banner Niche on Left Wall (exact reference detail!)
  m.box(-2.55, 0.36, -1.42, -1.65, 1.68, -1.32, TEX_BRICK, TEX_CAP, 0.8);
  m.panelZ(-2.46, 0.44, -1.74, 1.60, -1.312, TEX_BANNER, [1.08, 1.0, 1.0]);

  // Studded Oak Dungeon Doorway beside the hero on Right Wall
  m.box(0.84, 0.0, -1.44, 2.02, 1.72, -1.32, TEX_BRICK, TEX_CAP, 0.8);
  m.panelZ(0.95, 0.02, 1.91, 1.62, -1.312, TEX_DOOR, [1.05, 1.0, 0.96]);
  // Stone step threshold in front of door
  m.box(0.85, 0.0, -1.32, 2.02, 0.11, -0.95, TEX_BRICK, TEX_FLOOR, 0.72);

  // Three Center Wall Sconces (left wall, inner duel corner, right wall)
  m.sconce(-3.25, 1.24, -1.35, 0, 1);
  m.sconce(0.42, 1.32, -0.92, 1, 0);
  m.sconce(2.85, 1.24, -1.35, 0, 1);

  // Courtyard Props (barrels, crates, stone plinths — crisp pixel silhouette details)
  m.box(-2.72, 0.0, 1.68, -2.18, 0.68, 2.22, TEX_WOOD, TEX_WOOD, 0.95); // front-left barrel
  m.box(-3.65, 0.0, -0.25, -3.05, 0.58, 0.35, TEX_WOOD, TEX_WOOD, 0.92); // wall crate
  m.box(-4.22, 0.0, -0.78, -3.68, 0.46, -0.24, TEX_WOOD, TEX_WOOD, 0.95); // stacked smaller crate
  m.box(3.55, 0.0, -0.82, 4.18, 0.62, -0.18, TEX_WOOD, TEX_WOOD, 0.92); // right wall crate
  m.box(5.12, 0.0, 0.15, 5.75, 0.95, 0.78, TEX_BRICK, TEX_CAP, 0.72); // stone bastion pier

  // ================= 3. LIT UPPER BACKGROUND (TOP OF FRAME — TILT-SHIFT BOKEH LANDMARKS!) =================
  // Upper terrace floor stepping slightly higher behind main L-wall so it shines clearly above wall cap!
  m.box(-4.8, -0.58, -8.5, 7.6, 0.28, -2.55, TEX_BRICK, TEX_FLOOR, 0.54, [0.88, 0.92, 1.05]);

  // Upper Citadel Gothic Gallery Wall (z = -4.55) with 3 GLOWING AMBER ARCHED WINDOWS!
  m.box(-3.2, 0.28, -5.55, 4.6, 2.75, -4.55, TEX_BRICK, TEX_CAP, 0.56, [0.92, 0.94, 1.02]);
  m.panelZ(-1.35, 0.92, -0.35, 2.25, -4.535, TEX_WINDOW, [1.25, 1.12, 0.92]);
  m.panelZ(0.45, 0.92, 1.45, 2.25, -4.535, TEX_WINDOW, [1.25, 1.12, 0.92]);
  m.panelZ(2.25, 0.92, 3.25, 2.25, -4.535, TEX_WINDOW, [1.25, 1.12, 0.92]);
  // Two Upper Gallery Wall Torches between windows
  m.sconce(0.05, 1.42, -4.55, 0, 1);
  m.sconce(1.85, 1.42, -4.55, 0, 1);

  // Far-Upper Keep Wall (z = -7.2) with 2 glowing turret windows — ensures 9:16 portrait TOP edge has vivid bokeh!
  m.box(-0.8, 0.28, -8.2, 6.4, 3.10, -7.15, TEX_BRICK, TEX_CAP, 0.54, [0.84, 0.88, 1.04]);
  m.panelZ(0.85, 1.15, 1.95, 2.55, -7.135, TEX_WINDOW, [1.20, 1.06, 0.88]);
  m.panelZ(3.15, 1.15, 4.25, 2.55, -7.135, TEX_WINDOW, [1.20, 1.06, 0.88]);

  // Upper-Right Glowing Cyan Arcane Crystal Shrine (clearly visible above right wall, echoes reference top-right blue orb!)
  m.box(3.35, 0.28, -4.15, 4.45, 1.18, -3.05, TEX_BRICK, TEX_FLOOR, 0.70, [0.80, 0.92, 1.12]);
  m.box(3.62, 1.18, -3.88, 4.18, 1.56, -3.32, -1, -1, 1.0, [0.24, 0.30, 0.42]);
  // Elevated glowing cyan arcane crystal core
  m.rotBox(3.90, 2.02, -3.60, 0.24, 0.36, 0.24, 0.62, -2, [0.55, 2.85, 4.60]);
  // Second distant cyan rune beacon in far upper-right (for 9:16 top corner!)
  m.box(4.95, 0.28, -6.25, 5.75, 1.12, -5.45, TEX_BRICK, TEX_FLOOR, 0.72, [0.80, 0.92, 1.10]);
  m.rotBox(5.35, 1.72, -5.85, 0.22, 0.34, 0.22, 0.4, -2, [0.48, 2.45, 4.10]);

  // ================= 4. LIT NEAR FOREGROUND (BOTTOM OF FRAME — TILT-SHIFT BOKEH LANDMARKS!) =================
  // Foreground ruined stone terrace & low parapet walls across z = +3.6 .. +7.4
  m.box(-7.5, -0.58, 3.6, 1.9, -0.05, 7.6, TEX_BRICK, TEX_FLOOR, 0.56, [0.90, 0.92, 0.98]);
  // Low ruined parapet wall framing bottom-left
  m.box(-5.6, -0.05, 2.8, -4.6, 0.92, 4.2, TEX_BRICK, TEX_CAP, 0.65);
  m.box(-4.6, -0.05, 3.85, -3.3, 0.62, 4.55, TEX_BRICK, TEX_CAP, 0.65);
  // Foreground stone column & mossy crate at bottom-center
  m.box(-2.95, -0.05, 4.45, -2.35, 0.56, 5.05, TEX_WOOD, TEX_WOOD, 0.92);
  // Foreground Bottom-Left Warm Fire Brazier (echoes bottom-left glow in reference!)
  m.brazier(-4.05, -0.05, 2.75);
  // Foreground Bottom-Right Warm Fire Brazier (echoes bottom-right glow in reference!)
  m.brazier(-0.55, -0.05, 4.55);
  // Foreground Bottom-Center-Left Teal Arcane Lantern Post (crisp color contrast in near bokeh!)
  m.box(-2.22, -0.05, 4.35, -1.86, 0.72, 4.71, TEX_BRICK, TEX_CAP, 0.8);
  m.box(-2.14, 0.72, 4.43, -1.94, 1.06, 4.63, -2, -2, 1.0, [0.45, 2.75, 2.55]);
  // Extra Lower-Foreground Brazier & Ruined Arch for 9:16 portrait bottom edge!
  m.brazier(-3.35, -0.05, 5.95);
  m.box(-4.6, -0.05, 5.65, -3.85, 1.15, 6.45, TEX_BRICK, TEX_CAP, 0.65);
  m.box(-1.6, -0.05, 6.15, -0.75, 0.82, 6.95, TEX_BRICK, TEX_CAP, 0.65);

  // ================= 5. OPTIONAL ROOF / MASONRY OVERHANG (STEP 1 ONLY — SLICED OFF IN STEP 2!) =================
  const roof = new MeshBuilder();
  // Tall un-cut masonry battlements on top of the L-wall (sliced into crisp black diorama cutaways on Pass 2!)
  roof.box(-6.6, 2.25, -2.55, -0.45, 3.45, -1.35, TEX_BRICK, TEX_BRICK, 0.58);
  roof.box(-0.45, 2.25, -2.55, 0.42, 3.45, -0.58, TEX_BRICK, TEX_BRICK, 0.58);
  roof.box(0.42, 2.25, -2.55, 5.45, 3.45, -1.35, TEX_BRICK, TEX_BRICK, 0.58);
  // Subtle pitched stone cornice cap (keeps courtyard & red banner visible while clearly un-cut!)
  roof.box(-6.75, 3.45, -2.75, 5.60, 3.72, -1.15, TEX_BRICK, TEX_FLOOR, 0.52, [0.86, 0.84, 0.88]);
  // Single stone archway lintel over the moat bridge on Step 1
  roof.box(1.82, 1.25, 1.20, 2.26, 2.35, 1.64, TEX_BRICK, TEX_BRICK, 0.72);
  roof.box(1.82, 0.96, 3.45, 2.26, 2.35, 3.89, TEX_BRICK, TEX_BRICK, 0.72);
  roof.box(1.78, 2.35, 1.15, 2.30, 2.75, 3.94, TEX_BRICK, TEX_FLOOR, 0.65);

  return {
    main: m.finish(),
    roof: roof.finish(),
  };
}

// Append an articulated Blender-sculpted character mesh into a MeshBuilder with smooth per-part animation!
function appendBlenderFighter(mb, pack, worldX, worldZ, facingYaw, scale, anim) {
  const baseVert = mb.v.length / VERT_FLOATS;
  const cy = Math.cos(facingYaw), sy = Math.sin(facingYaw);
  const { count, pos, norm, col, part, rough, idx } = pack;

  for (let i = 0; i < count; i++) {
    let lx = pos[i * 3 + 0];
    let ly = pos[i * 3 + 1];
    let lz = pos[i * 3 + 2];
    let nx = norm[i * 3 + 0];
    let ny = norm[i * 3 + 1];
    let nz = norm[i * 3 + 2];
    const p = part[i];

    // Subtle articulated part animation (pivoted around anatomical joints so limbs stay seamlessly attached!)
    if (p === 1) {
      // Torso/cape breathing lift + gentle combat twist
      ly += anim.breath;
      const ca = Math.cos(anim.torsoYaw), sa = Math.sin(anim.torsoYaw);
      const tx = lx * ca + lz * sa, tz = -lx * sa + lz * ca;
      const tnx = nx * ca + nz * sa, tnz = -nx * sa + nz * ca;
      lx = tx; lz = tz; nx = tnx; nz = tnz;
    } else if (p === 2) {
      // Head / helm breathing + subtle nod
      ly += anim.breath * 1.1;
      const ca = Math.cos(anim.headYaw), sa = Math.sin(anim.headYaw);
      const tx = lx * ca + lz * sa, tz = -lx * sa + lz * ca;
      const tnx = nx * ca + nz * sa, tnz = -nx * sa + nz * ca;
      lx = tx; lz = tz; nx = tnx; nz = tnz;
    } else if (p === 3) {
      // Shield arm guard bob around left shoulder pivot (+0.24, 1.00, 0.0) in flipped WebGL coords
      const px = 0.24, py = 1.00, pz = 0.0;
      const rx = lx - px, ry = ly - py, rz = lz - pz;
      const ca = Math.cos(anim.shieldPitch), sa = Math.sin(anim.shieldPitch);
      ly = py + ry * ca - rz * sa + anim.breath;
      lz = pz + ry * sa + rz * ca;
      lx = px + rx;
      const rny = ny * ca - nz * sa, rnz = ny * sa + nz * ca;
      ny = rny; nz = rnz;
    } else if (p === 4) {
      // Weapon arm combat swing around right shoulder pivot (-0.24, 1.00, 0.0) in flipped WebGL coords!
      const px = -0.24, py = 1.00, pz = 0.0;
      const rx = lx - px, ry = ly - py, rz = lz - pz;
      const ca = Math.cos(anim.swordPitch), sa = Math.sin(anim.swordPitch);
      ly = py + ry * ca - rz * sa + anim.breath;
      lz = pz + ry * sa + rz * ca;
      lx = px + rx;
      const rny = ny * ca - nz * sa, rnz = ny * sa + nz * ca;
      ny = rny; nz = rnz;
    }

    // Rotate by character facingYaw around Y (+Z local -> facing enemy) and scale into courtyard!
    const wx = worldX + (lx * cy + lz * sy) * scale;
    const wy = ly * scale;
    const wz = worldZ + (-lx * sy + lz * cy) * scale;
    const wnx = nx * cy + nz * sy;
    const wny = ny;
    const wnz = -nx * sy + nz * cy;

    const r = rough[i];
    // Encode roughness cleanly in texId: -2.0 = HDR emissive; -1.0 - rough = sculpted material!
    const texId = r < 0 ? -2.0 : (-1.0 - r);
    const emMul = (r < 0 && anim.emBoost) ? anim.emBoost : 1.0;

    mb.v.push(
      wx, wy, wz,
      wnx, wny, wnz,
      1, 0, 0,
      0, 0,
      texId,
      col[i * 3 + 0] * emMul, col[i * 3 + 1] * emMul, col[i * 3 + 2] * emMul,
    );
  }
  for (let k = 0; k < idx.length; k++) {
    mb.idx.push(baseVert + idx[k]);
  }
}

// Build dynamic sculpted Blender fighting characters + floating HP bar + HDR lights & sparks!
export function buildDynamicFrame(t, burstPhase = 0, use2dSprites = false) {
  const ch = new MeshBuilder();
  const meshes = getFightersMeshes();

  // Smooth deterministic combat stance & blade-flourish cycle
  const kBreath = Math.sin(t * 3.14159) * 0.018;
  const kSwing = Math.sin(t * 2.0944) * 0.24 - Math.sin(burstPhase * Math.PI) * 0.42;
  const sBreath = Math.sin(t * 2.618 + 1.2) * 0.016;
  const sSwing = Math.sin(t * 2.0944 + 2.4) * 0.18;

  // Heroic 3/4 side-profile duel right in front of the wooden doorway & corner torch:
  // Both fighters' fronts (Knight's plumed helm/cuirass/cape/shield & Skeleton's hooded skull/cyan eyes/ribcage)
  // read clearly from the isometric camera while casting dramatic parallel shadows forward across the flagstones!
  const kx = 0.78, kz = 0.28;
  const sx = -0.58, sz = -0.06;
  // Angle both slightly open (+18° / -22°) toward the viewer for classic theatrical 3/4 miniature staging!
  const kYaw = Math.atan2(sx - kx, sz - kz) - 0.22;
  const sYaw = Math.atan2(kx - sx, kz - sz) + 0.34;

  if (!use2dSprites) {
    appendBlenderFighter(ch, meshes.knight, kx, kz, kYaw, 0.98, {
      breath: kBreath,
      torsoYaw: Math.sin(t * 2.0944) * 0.08,
      headYaw: -Math.sin(t * 2.0944) * 0.05,
      shieldPitch: Math.sin(t * 2.0944 + 0.8) * 0.08,
      swordPitch: kSwing,
      emBoost: 0.95 + Math.sin(t * 7.5) * 0.16 + burstPhase * 0.75,
    });
    appendBlenderFighter(ch, meshes.skeleton, sx, sz, sYaw, 0.96, {
      breath: sBreath,
      torsoYaw: -Math.sin(t * 2.0944 + 0.5) * 0.07,
      headYaw: Math.sin(t * 1.57) * 0.06,
      shieldPitch: -Math.sin(t * 2.0944) * 0.09,
      swordPitch: sSwing,
      emBoost: 1.0 + Math.sin(t * 4.5) * 0.15,
    });
  }

  // Crisp floating pixel-art health bar cleanly above Skeleton Sentinel's hood!
  const hpY = 1.66 + sBreath;
  const hpYaw = -0.66;
  ch.rotBox(sx, hpY, sz, 0.28, 0.044, 0.016, hpYaw, -2, [0.05, 0.07, 0.13]);
  ch.rotBox(sx - 0.045, hpY, sz + 0.015, 0.175, 0.025, 0.012, hpYaw, -2, [1.05, 0.15, 0.20]);
  ch.rotBox(sx + 0.15, hpY, sz + 0.015, 0.070, 0.025, 0.012, hpYaw, -2, [0.18, 0.42, 1.05]);

  // ================= HDR LIGHT RIG (12 DYNAMIC POINT LIGHTS) =================
  const f1 = 0.92 + 0.10 * Math.sin(t * 7.3) + 0.05 * Math.sin(t * 17.1);
  const f2 = 0.92 + 0.10 * Math.sin(t * 8.1 + 1.4) + 0.05 * Math.sin(t * 15.7 + 0.7);
  const f3 = 0.92 + 0.10 * Math.sin(t * 6.7 + 2.8) + 0.05 * Math.sin(t * 19.3 + 2.1);
  const fSword = 0.95 + 0.22 * Math.sin(t * 6.283) + burstPhase * 1.2;
  const fOrb = 0.94 + 0.12 * Math.sin(t * 3.14159 + 0.8);

  // Format: [x, y, z, radius, r, g, b, intensity]
  // Note: light[1] (inner duel corner torch) is our PRIMARY shadow-casting courtyard key torch!
  const lights = [
    // Center focal courtyard torches (3) + Enchanted Sword (1)
    [-3.25, 1.48, -1.08, 4.4, 1.00, 0.54, 0.18, 2.5 * f1],
    [ 0.68, 1.80, -0.96, 8.2, 1.00, 0.60, 0.22, 5.8 * f2],    // PRIMARY shadow-casting courtyard torch!
    [ 2.85, 1.48, -1.08, 4.4, 1.00, 0.53, 0.17, 2.4 * f3],
    [ 0.14, 0.94,  0.14, 2.8, 1.00, 0.78, 0.30, 1.45 * fSword],
    // Upper background lit landmarks (4) — glow brightly & blur into lush bokeh at TOP!
    [ 3.90, 2.02, -3.60, 5.8, 0.22, 0.80, 1.00, 4.6 * fOrb],  // Upper-right cyan arcane orb!
    [ 0.05, 1.65, -4.32, 4.6, 1.00, 0.56, 0.20, 3.1 * f2],    // Upper gallery torch 1
    [ 1.85, 1.65, -4.32, 4.6, 1.00, 0.58, 0.21, 3.1 * f1],    // Upper gallery torch 2
    [ 5.35, 1.72, -5.85, 4.8, 0.22, 0.78, 1.00, 3.8 * fOrb],  // Far upper-right cyan beacon
    // Near foreground lit landmarks (4) — glow brightly & blur into lush bokeh at BOTTOM!
    [-4.05, 1.12,  2.75, 4.2, 1.00, 0.48, 0.14, 3.6 * f3],    // Bottom-left brazier
    [-0.55, 1.12,  4.55, 4.2, 1.00, 0.50, 0.16, 3.6 * f1],    // Bottom-right brazier
    [-2.04, 1.04,  4.53, 3.8, 0.24, 0.94, 0.88, 2.9 * fOrb],  // Bottom-center teal lantern
    [-3.35, 1.12,  5.95, 4.2, 1.00, 0.50, 0.15, 3.6 * f2],    // Lower 9:16 brazier
  ];

  // ================= HDR EMISSIVE BILLBOARDS (FLAMES, ORBS, GOLDEN SPELL SPARKS) =================
  // Each billboard: [x, y, z, size, r, g, b, shape] (shape: 0=soft flame/orb, 1=crisp pixel spark, 2=2D knight, 3=2D skeleton)
  const fx = [];
  const flameSources = [
    [-3.25, 1.44, -1.19, 0.34, 4.8, 2.4, 0.60, 0],
    [ 0.56, 1.52, -0.92, 0.35, 5.0, 2.6, 0.68, 0],
    [ 2.85, 1.44, -1.19, 0.34, 4.8, 2.4, 0.60, 0],
    [ 4.38, 1.18,  2.55, 0.28, 4.2, 2.1, 0.55, 0], // moat sconce
    [ 0.05, 1.62, -4.39, 0.38, 5.0, 2.5, 0.64, 0], // upper gallery torch 1
    [ 1.85, 1.62, -4.39, 0.38, 5.0, 2.6, 0.66, 0], // upper gallery torch 2
    [-4.05, 1.04,  2.75, 0.50, 5.4, 2.3, 0.48, 0], // bottom-left brazier flame!
    [-0.55, 1.04,  4.55, 0.50, 5.4, 2.4, 0.52, 0], // bottom-right brazier flame!
    [-3.35, 1.04,  5.95, 0.48, 5.2, 2.2, 0.48, 0], // far-bottom brazier flame!
    [ 3.90, 2.04, -3.60, 0.72, 0.75, 3.8, 5.8, 0], // upper-right cyan arcane orb glow!
    [ 5.35, 1.74, -5.85, 0.64, 0.70, 3.4, 5.0, 0], // far upper cyan beacon glow!
    [-2.04, 0.94,  4.53, 0.44, 0.70, 3.9, 3.6, 0], // foreground teal lantern glow!
  ];
  for (let i = 0; i < flameSources.length; i++) {
    const s = flameSources[i];
    const pulse = 1.0 + 0.14 * Math.sin(t * (6.5 + i * 0.7) + i * 1.9);
    const bob = Math.sin(t * (5.2 + i * 0.5) + i) * 0.03;
    fx.push(s[0], s[1] + bob, s[2], s[3] * pulse, s[4], s[5], s[6], s[7]);
  }

  // Rising golden enchanted-sword sparks centered cleanly on the extended rune blade!
  for (let i = 0; i < 36; i++) {
    const seed = i * 1.6180339;
    const life = (t * (0.68 + (i % 5) * 0.12) + seed) % 1.0;
    const ang = seed * 6.28318 + life * 2.4;
    const rad = (0.06 + life * (0.48 + burstPhase * 0.60)) * (0.65 + (i % 3) * 0.25);
    const px = 0.24 + Math.cos(ang) * rad;
    const py = 0.54 + life * 0.82 + Math.sin(life * 6.28) * 0.05;
    const pz = 0.12 + Math.sin(ang) * rad * 0.85;
    const fade = Math.sin(life * Math.PI);
    const sz = (0.044 + (i % 3) * 0.014) * (0.6 + fade * 0.55) * (1.0 + burstPhase * 0.45);
    const br = (2.5 + burstPhase * 1.8) * fade;
    fx.push(px, py, pz, sz, br * 1.2, br * 0.88, br * 0.28, 1);
  }
  // Rising embers from the 3 foreground braziers & 3 courtyard torches
  const emberAnchors = [
    [-3.25, 1.48, -1.18], [0.56, 1.56, -0.92], [2.85, 1.48, -1.18],
    [-4.05, 1.08,  2.75], [-0.55, 1.08, 4.55], [-3.35, 1.08, 5.95],
  ];
  for (let i = 0; i < 24; i++) {
    const a = emberAnchors[i % emberAnchors.length];
    const life = (t * (0.48 + (i % 4) * 0.09) + i * 0.37) % 1.0;
    const px = a[0] + Math.sin(life * 5.0 + i * 2.1) * 0.16;
    const py = a[1] + life * 0.95;
    const pz = a[2] + Math.cos(life * 4.2 + i * 1.7) * 0.16;
    const fade = Math.sin(life * Math.PI);
    fx.push(px, py, pz, 0.048 * fade, 4.2 * fade, 2.0 * fade, 0.45 * fade, 1);
  }

  // Optional classic Octopath-style 2D camera-facing pixel-art character sprites!
  if (use2dSprites) {
    fx.push(kx, 0.68 + kBreath, kz, 1.36, 1.0, 1.0, 1.0, 2);
    fx.push(sx, 0.66 + sBreath, sz, 1.32, 1.0, 1.0, 1.0, 3);
  }

  return {
    chars: ch.finish(),
    fx: new Float32Array(fx),
    fxCount: fx.length / 8,
    lights,
  };
}
