# Isometric Pixel-Wave Toy (`pixelwave`)

Interactive low-resolution WebGL2 pixel-art voxel toy: a discrete `N × N` grid of isometric columns (`16×16`, `24×24`, `32×32`) driven by a live 2D heightmap, quantized to integer pixel steps, shaded with left-side directional light across 4 pixel-art biomes, and finished with a two-stage 2D sticker outline pass.

**Live demo:** <https://gamedevpl.github.io/fx-lab/pixelwave/>

## Pipeline (5 steps)

1. **2D Noise (`01`)** — Discrete grayscale 2D heightmap driving every column on the grid (`Diagonal Loop`, `Simplex Drift`, or `Click Ripple`).
2. **Iso Columns (`02`)** — Rigid orthographic `2:1` pixel-art projection (`dx = (x − z)·w`, `dy = −(x + z)·w/2 + y`) rendered into an un-antialiased low-res MRT framebuffer (`RGBA8` color + `RGBA8` depth/face/height metadata) and upscaled with strict `NEAREST`.
3. **Stepped Biomes (`03`)** — Integer pixel height quantization (`Height Steps`: smooth or `1–4 px`), left directional lighting (bright left face, shadowed right face, crisp top), and 4 hand-tuned pixel-art biomes:
   - **Meadow** — lush green top with stepped 2–3 px grass overhang + 1 px cast lip shadow over layered warm soil.
   - **Ocean** — deep turquoise water columns with Bayer-dithered crisp white foam appearing only on the highest wave crests.
   - **Magma** — dark basalt plates with pulsing orange-yellow glowing fissures in the wave troughs.
   - **Neon Grid** — dark navy body with cyan/magenta equalizer caps and discrete horizontal LED bar segments.
4. **1 px Ink (`04`)** — First 2D post-pass (`texelFetch` at virtual pixel resolution): airtight 1 px black silhouette + one-sided depth/step discontinuity edges (guarantees crisp 1 px internal lines, never doubled to 2 px).
5. **Sticker Pass (`05`)** — Second 2D post-pass: rounded 3 px white vinyl sticker outer border + subtle drop shadow over a biome-matched checkered cutting-mat backdrop, plus live `Show 2D Noise` inset and click/drag ripple picking.

## Files

- `shaders.js` — GLSL ES 3.00 instanced column vertex/fragment MRT shaders and 2D sticker/outline composite shader.
- `index.js` — CPU 2D Simplex Noise, seamless 2 s `Diagonal Loop`, `Click Ripple` emitter & isometric voxel ray-picker, reusable `createPixelwaveRenderer(gl)`, and FX Lab effect controls.
