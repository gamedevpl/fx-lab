// Procedural Multi-Material GPU Glyph Atlas for #28 Real-Time 3D ASCII & CRT Shading.
// Generates a crisp 20x6 cell atlas (each glyph 28x28 px = 560x168 RGBA8 texture):
//   Cols 0..15 : Fill luminance / density ramp
//   Cols 16..19: Directional Sobel edge strokes [|, —, /, \] (for Screen-Space Sobel comparison)
//   Row 0: Coarse naive 10-char screen-space ramp (" .:-=+*#%@")
//   Row 1: Hero Robe & Gat Hat typography (" .:;=+zsSZeGENH#") — fine upright character cloud
//   Row 2: World-space Courtyard Floor tiles (" .,:;-_~;+<>=[H#") — iconic rhythmic < > + ; ~ ground
//   Row 3: Gothic Cathedral Architecture (" .,:;-=[]IHN#0@#") — walls, buttresses & glowing windows
//   Row 4: Organic Foliage, Grass & Embers (" .,'`~;^vwo&*yX@") — 3D floating tree & meadow tufts
//   Row 5: Korean Hangul jamo & syllables (density-sorted, with stroke fallback if font missing)

export const ATLAS_COLS = 20;
export const ATLAS_ROWS = 6;
const CELL = 28;

function drawHangulFallback(ctx, idx, ox, oy, s) {
  ctx.strokeStyle = "#ffffff";
  ctx.fillStyle = "#ffffff";
  ctx.lineWidth = Math.max(2, s * 0.11);
  ctx.lineCap = "square";
  const m = s * 0.22;
  const x0 = ox + m, x1 = ox + s - m, xm = ox + s * 0.5;
  const y0 = oy + m, y1 = oy + s - m, ym = oy + s * 0.5;
  ctx.beginPath();
  switch (idx) {
    case 0: break;
    case 1: ctx.fillRect(xm - 1.5, ym - 1.5, 3, 3); return;
    case 2: ctx.moveTo(x0, ym); ctx.lineTo(x1, ym); break;
    case 3: ctx.moveTo(xm, y0); ctx.lineTo(xm, y1); break;
    case 4: ctx.moveTo(x0, y0); ctx.lineTo(x1, y0); ctx.lineTo(x1, y1); break;
    case 5: ctx.moveTo(x0, y0); ctx.lineTo(x0, y1); ctx.lineTo(x1, y1); break;
    case 6: ctx.moveTo(xm, y0); ctx.lineTo(x0, y1); ctx.moveTo(xm, ym); ctx.lineTo(x1, y1); break;
    case 7: ctx.moveTo(x1, y0); ctx.lineTo(x0, y0); ctx.lineTo(x0, y1); ctx.lineTo(x1, y1); break;
    case 8: ctx.moveTo(x0, y0); ctx.lineTo(x1, y0); ctx.moveTo(xm, y0); ctx.lineTo(x0, y1); ctx.moveTo(xm, ym); ctx.lineTo(x1, y1); break;
    case 9: ctx.rect(x0, y0, x1 - x0, y1 - y0); break;
    case 10: ctx.moveTo(x0, y0); ctx.lineTo(x0, y1); ctx.lineTo(x1, y1); ctx.lineTo(x1, y0); ctx.moveTo(x0, ym); ctx.lineTo(x1, ym); break;
    case 11: ctx.moveTo(x0, y0); ctx.lineTo(x1, y0); ctx.lineTo(x1, ym); ctx.lineTo(x0, ym); ctx.lineTo(x0, y1); ctx.lineTo(x1, y1); break;
    case 12: ctx.moveTo(xm - 3, y0); ctx.lineTo(xm + 3, y0); ctx.moveTo(x0, y0 + 5); ctx.lineTo(x1, y0 + 5); ctx.stroke(); ctx.beginPath(); ctx.arc(xm, ym + 3, s * 0.2, 0, Math.PI * 2); break;
    case 13: ctx.moveTo(x0, y0 + 2); ctx.lineTo(xm, y0 + 2); ctx.lineTo(xm, y1 - 2); ctx.moveTo(x1 - 3, y0); ctx.lineTo(x1 - 3, y1); ctx.moveTo(x1 - 3, ym); ctx.lineTo(x1 + 1, ym); break;
    case 14: ctx.rect(x0, y0, s * 0.34, s * 0.42); ctx.moveTo(x1 - 3, y0); ctx.lineTo(x1 - 3, y1); ctx.moveTo(x1 - 3, ym); ctx.lineTo(x1 + 1, ym); ctx.moveTo(x0, y1); ctx.lineTo(x1, y1); break;
    default: ctx.rect(x0, y0, x1 - x0, s * 0.45); ctx.moveTo(x0, y1 - 3); ctx.lineTo(x1, y1 - 3); ctx.moveTo(x0, ym + 2); ctx.lineTo(x1, ym + 2); ctx.moveTo(xm, y0); ctx.lineTo(xm, y1); break;
  }
  ctx.stroke();
}

function drawEdgeStroke(ctx, dir, ox, oy, s, thick = 0.16) {
  ctx.strokeStyle = "#ffffff";
  ctx.lineWidth = Math.max(2.5, s * thick);
  ctx.lineCap = "round";
  const p = s * 0.12;
  ctx.beginPath();
  if (dir === 0) {
    ctx.moveTo(ox + s * 0.5, oy + p);
    ctx.lineTo(ox + s * 0.5, oy + s - p);
  } else if (dir === 1) {
    ctx.moveTo(ox + p, oy + s * 0.5);
    ctx.lineTo(ox + s - p, oy + s * 0.5);
  } else if (dir === 2) {
    ctx.moveTo(ox + p, oy + s - p);
    ctx.lineTo(ox + s - p, oy + p);
  } else {
    ctx.moveTo(ox + p, oy + p);
    ctx.lineTo(ox + s - p, oy + s - p);
  }
  ctx.stroke();
}

function measureGlyphDensity(char, font) {
  const c = document.createElement("canvas");
  c.width = CELL; c.height = CELL;
  const g = c.getContext("2d");
  g.fillStyle = "#000"; g.fillRect(0, 0, CELL, CELL);
  g.fillStyle = "#fff"; g.font = font;
  g.textAlign = "center"; g.textBaseline = "middle";
  g.fillText(char, CELL * 0.5, CELL * 0.54);
  const data = g.getImageData(0, 0, CELL, CELL).data;
  let sum = 0;
  for (let i = 0; i < data.length; i += 4) sum += data[i];
  return sum / (CELL * CELL * 255);
}

export function createGlyphAtlasTexture(gl) {
  const c = document.createElement("canvas");
  c.width = ATLAS_COLS * CELL;
  c.height = ATLAS_ROWS * CELL;
  const ctx = c.getContext("2d");
  ctx.fillStyle = "#000000";
  ctx.fillRect(0, 0, c.width, c.height);

  const monoFont = `800 ${Math.round(CELL * 0.86)}px "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, Monaco, monospace`;
  const krFont = `800 ${Math.round(CELL * 0.82)}px "Apple SD Gothic Neo", "Noto Sans KR", "Malgun Gothic", sans-serif`;

  const drawChar = (char, col, row, font) => {
    const ox = col * CELL, oy = row * CELL;
    ctx.fillStyle = "#ffffff";
    ctx.strokeStyle = "#ffffff";
    ctx.lineWidth = 0.55;
    ctx.font = font;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(char, ox + CELL * 0.5, oy + CELL * 0.54);
    ctx.strokeText(char, ox + CELL * 0.5, oy + CELL * 0.54);
  };

  // Row 0: Coarse 10-char naive screen-space ramp
  const naive10 = [" ", ".", ":", "-", "=", "+", "*", "#", "%", "@"];
  for (let i = 0; i < 16; i++) {
    const ch = naive10[Math.min(naive10.length - 1, Math.floor((i / 15.001) * naive10.length))];
    drawChar(ch, i, 0, monoFont);
  }
  for (let e = 0; e < 4; e++) drawEdgeStroke(ctx, e, (16 + e) * CELL, 0, CELL, 0.16);

  // Row 1: Hero Robe & Wide-Brimmed Gat Hat typography (S Z z s N H # G E)
  const heroSet = [" ", ".", ":", ";", "+", "=", "s", "z", "S", "Z", "e", "G", "E", "N", "H", "#"];
  for (let i = 0; i < 16; i++) drawChar(heroSet[i], i, 1, monoFont);
  for (let e = 0; e < 4; e++) drawEdgeStroke(ctx, e, (16 + e) * CELL, 1 * CELL, CELL, 0.16);

  // Row 2: World-Space Courtyard Ground (< > + ; ~ = - _)
  const groundSet = [" ", ".", ",", ":", "-", "_", "~", ";", "+", "<", ">", "=", "<", ">", "+", "#"];
  for (let i = 0; i < 16; i++) drawChar(groundSet[i], i, 2, monoFont);
  for (let e = 0; e < 4; e++) drawEdgeStroke(ctx, e, (16 + e) * CELL, 2 * CELL, CELL, 0.16);

  // Row 3: Cathedral Walls, Pillars & Glowing Lancet Windows ([ ] = I H N # 0)
  const archSet = [" ", ".", ",", ":", "-", "=", "[", "]", "|", "I", "T", "H", "N", "#", "0", "@"];
  for (let i = 0; i < 16; i++) drawChar(archSet[i], i, 3, monoFont);
  for (let e = 0; e < 4; e++) drawEdgeStroke(ctx, e, (16 + e) * CELL, 3 * CELL, CELL, 0.16);

  // Row 4: Organic 3D Foliage, Wild Grass & Ember Sparks (' , ~ ^ v w o & * y f)
  const orgSet = [" ", ".", "'", ",", "`", "~", ";", "^", "v", "w", "o", "&", "*", "y", "f", "X"];
  for (let i = 0; i < 16; i++) drawChar(orgSet[i], i, 4, monoFont);
  for (let e = 0; e < 4; e++) drawEdgeStroke(ctx, e, (16 + e) * CELL, 4 * CELL, CELL, 0.16);

  // Row 5: Korean Hangul jamo & syllables (auto-sorted by measured ink density)
  const hangulRaw = [" ", "ㆍ", "ㅡ", "ㅣ", "ㄱ", "ㄴ", "ㅅ", "ㄷ", "ㅈ", "ㅁ", "ㅂ", "ㄹ", "ㅎ", "가", "마", "한"];
  const hasHangul = measureGlyphDensity("한", krFont) > 0.08 && measureGlyphDensity("가", krFont) !== measureGlyphDensity("한", krFont);
  if (hasHangul) {
    const sortedKr = [" ", ...hangulRaw.slice(1)
      .map(ch => ({ ch, d: measureGlyphDensity(ch, krFont) }))
      .sort((a, b) => a.d - b.d)
      .map(o => o.ch)];
    for (let i = 0; i < 16; i++) drawChar(sortedKr[i], i, 5, krFont);
  } else {
    for (let i = 0; i < 16; i++) drawHangulFallback(ctx, i, i * CELL, 5 * CELL, CELL);
  }
  for (let e = 0; e < 4; e++) drawEdgeStroke(ctx, e, (16 + e) * CELL, 5 * CELL, CELL, 0.16);

  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, c.width, c.height, 0, gl.RGBA, gl.UNSIGNED_BYTE, c);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  return tex;
}
