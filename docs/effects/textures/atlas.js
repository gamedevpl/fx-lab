// Procedural 512x512 crisp architectural textures + full mipmap pyramids for Evolution of Texture Mapping (1994-2026).
// Generates high-contrast checkerboard marble mosaic (for brutal grazing-angle shimmer/AF tests),
// warm terracotta brick masonry with fine mortar & heraldic trim (for S3TC 4x4 block tests),
// and carved limestone blocks.

function makeCanvasTex(gl, size, drawFn) {
  const c = document.createElement("canvas");
  c.width = size;
  c.height = size;
  const ctx = c.getContext("2d");
  drawFn(ctx, size);

  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, c);
  gl.generateMipmap(gl.TEXTURE_2D);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  return tex;
}

export function createTextureAtlases(gl) {
  // 1) Floor Mosaic Texture (512x512): crisp high-contrast ivory/obsidian checkerboard + gold brass inlay + cobalt/vermilion border!
  // Exposes PS1 diagonal bending, Bilinear distant Moire shimmer, Mipmap blur vs 16x Anisotropic razor sharpness, and S3TC 4x4 artifacts!
  const texFloor = makeCanvasTex(gl, 512, (ctx, S) => {
    const N = 8;
    const cell = S / N;
    for (let y = 0; y < N; y++) {
      for (let x = 0; x < N; x++) {
        const dark = (x + y) % 2 === 1;
        ctx.fillStyle = dark ? "#1c2436" : "#ece2ce";
        ctx.fillRect(x * cell, y * cell, cell, cell);

        // Inner micro-bevel & fine geometric diamond motif so 16x AF vs Trilinear pops brutally!
        ctx.strokeStyle = dark ? "#33425e" : "#cbbda2";
        ctx.lineWidth = 3;
        ctx.strokeRect(x * cell + 4, y * cell + 4, cell - 8, cell - 8);

        ctx.fillStyle = dark ? "#2a3954" : "#d8cab0";
        ctx.beginPath();
        const cx = (x + 0.5) * cell, cy = (y + 0.5) * cell, r = cell * 0.16;
        ctx.moveTo(cx, cy - r); ctx.lineTo(cx + r, cy); ctx.lineTo(cx, cy + r); ctx.lineTo(cx - r, cy);
        ctx.closePath(); ctx.fill();
      }
    }
    // Crisp terracotta + cobalt + gold runner stripes along tile seams (high-contrast chroma edges for S3TC 4x4!)
    ctx.fillStyle = "#c93b2b";
    ctx.fillRect(0, 0, 18, S);
    ctx.fillStyle = "#1896b8";
    ctx.fillRect(S - 18, 0, 18, S);
    ctx.fillStyle = "#e8b44c";
    ctx.fillRect(18, 0, 7, S);
    ctx.fillRect(S - 25, 0, 7, S);

    // Subtle stone grain speckles
    let seed = 1994;
    const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
    for (let i = 0; i < 4200; i++) {
      const px = rnd() * S, py = rnd() * S, a = rnd() * 0.09;
      ctx.fillStyle = rnd() > 0.5 ? `rgba(255,250,240,${a})` : `rgba(10,14,24,${a})`;
      ctx.fillRect(px, py, 2, 2);
    }
  });

  // 2) Wall Brick & Heraldic Stone Texture (512x512): warm Roman brick courses + colorful glazed ceramic frieze!
  const texWall = makeCanvasTex(gl, 512, (ctx, S) => {
    ctx.fillStyle = "#48423c"; // dark mortar
    ctx.fillRect(0, 0, S, S);

    const rows = 12, cols = 6;
    const rh = S / rows, cw = S / cols;
    let seed = 1996;
    const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };

    for (let r = 0; r < rows; r++) {
      const off = (r % 2) * (cw * 0.5);
      for (let c = -1; c <= cols; c++) {
        const bx = c * cw + off;
        const by = r * rh;
        const isFrieze = r === 3 || r === 8;
        if (isFrieze) {
          ctx.fillStyle = (c + r) % 2 === 0 ? "#1b8ca8" : "#d94b34";
        } else {
          const v = Math.floor(rnd() * 34);
          ctx.fillStyle = `rgb(${168 + v}, ${114 + Math.floor(v * 0.7)}, ${84 + Math.floor(v * 0.5)})`;
        }
        ctx.fillRect(bx + 3, by + 3, cw - 6, rh - 6);
        ctx.fillStyle = "rgba(255,244,220,0.16)";
        ctx.fillRect(bx + 3, by + 3, cw - 6, 4);
        ctx.fillStyle = "rgba(18,14,12,0.22)";
        ctx.fillRect(bx + 3, by + rh - 7, cw - 6, 4);
      }
    }
    // Crisp golden trim band across middle
    ctx.fillStyle = "#e6b04a";
    ctx.fillRect(0, S * 0.5 - 6, S, 12);
    ctx.fillStyle = "#1c2436";
    for (let x = 0; x < S; x += 32) ctx.fillRect(x + 8, S * 0.5 - 3, 16, 6);
  });

  // 3) Carved Stone / Crate Emblem Texture (512x512): crisp diagonal wood/brass braces + colorful heraldic shield (ultimate close-up S3TC + PS1 warp test!)
  const texCrate = makeCanvasTex(gl, 512, (ctx, S) => {
    ctx.fillStyle = "#c9b595";
    ctx.fillRect(0, 0, S, S);

    // Fine carved stone planks
    for (let i = 0; i < 8; i++) {
      ctx.fillStyle = i % 2 ? "#bca583" : "#d1be9f";
      ctx.fillRect(0, i * 64, S, 62);
    }

    // Thick crimson & navy frame border + brass studs
    ctx.strokeStyle = "#26334d";
    ctx.lineWidth = 42;
    ctx.strokeRect(21, 21, S - 42, S - 42);
    ctx.strokeStyle = "#e5a93e";
    ctx.lineWidth = 8;
    ctx.strokeRect(46, 46, S - 92, S - 92);

    // Bold diagonal X brace + center circle emblem (makes PS1 diagonal warping scream!)
    ctx.strokeStyle = "#b8362a";
    ctx.lineWidth = 24;
    ctx.beginPath();
    ctx.moveTo(56, 56); ctx.lineTo(S - 56, S - 56);
    ctx.moveTo(S - 56, 56); ctx.lineTo(56, S - 56);
    ctx.stroke();

    // Central high-contrast medallion with crisp gradient + red/cyan stripes (classic S3TC 4x4 chroma stress test!)
    const grd = ctx.createRadialGradient(256, 256, 16, 256, 256, 120);
    grd.addColorStop(0, "#fff2c6");
    grd.addColorStop(0.55, "#e09f3e");
    grd.addColorStop(1, "#1e6f8c");
    ctx.fillStyle = grd;
    ctx.beginPath(); ctx.arc(256, 256, 118, 0, Math.PI * 2); ctx.fill();

    ctx.strokeStyle = "#151423";
    ctx.lineWidth = 10;
    ctx.stroke();

    // Crisp concentric rings + fine radial ticks
    ctx.strokeStyle = "#f7eedc";
    ctx.lineWidth = 4;
    ctx.beginPath(); ctx.arc(256, 256, 72, 0, Math.PI * 2); ctx.stroke();
    ctx.fillStyle = "#d92b3a";
    ctx.beginPath(); ctx.arc(256, 256, 36, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = "#3ce0f0";
    ctx.beginPath(); ctx.arc(256, 256, 16, 0, Math.PI * 2); ctx.fill();
  });

  // Also create a 64x64 virtual page-table texture (R8) for live 2011 MegaTexture pop-in & 2020-26 Sampler Feedback streaming!
  const texPageTable = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, texPageTable);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 64, 64, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(64 * 64 * 4));

  return { texFloor, texWall, texCrate, texPageTable };
}
