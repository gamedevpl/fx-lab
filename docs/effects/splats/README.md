# Pixel-Art Gaussian Splats

A 5-step WebGL2 pipeline that renders a floating medieval watchtower and waterfall from ~10,000 procedural **3D Gaussian surfels** (no triangle mesh) and converts them in real time into crisp, palette-locked pixel art.

**Live demo:** <https://gamedevpl.github.io/fx-lab/splats/>

## Pipeline overview

| Step | Stage | What happens on the GPU |
|---:|---|---|
| 1 | **3D Gaussian Surfels** | Each flat oriented 3D ellipsoid is projected into screen space using the EWA perspective Jacobian ($J \cdot M_c$), producing a 2×2 screen-space covariance matrix whose eigenvectors size and orient the splat quad. Sorted back-to-front via a 16-bit radix sort. |
| 2 | **Hard Pixel Grid** | Cuts the smooth Gaussian falloff at $r^2 \le 2.25$ into a hard circular disc, enables hardware depth testing, snaps projected centers to the low-res pixel grid, and renders opaque surfels into 3 MRTs at 2× supersampling (`2× SSAA`). |
| 3 | **Banded Surface Lighting** | Quantizes $N \cdot L \cdot \text{AO}$ into three hue-shifted bands (cool indigo shadow, neutral midtone, warm sunlit highlight) plus 2-step warm bounce from the hanging lantern. |
| 4 | **Palette by Vote** | Each `2×2` supersampled block maps covered sub-pixels to the nearest perceptually weighted color in a curated 24-color palette and picks the majority winner (ties broken by nearest depth). This avoids muddy anti-aliased blending between palette colors. |
| 5 | **Bayer 4×4 Dither & Outline** | Applies ordered 4×4 Bayer dithering to translucent lantern glow, chimney smoke, waterfall mist, and sky ramps. Adds a 1 px deep-ink outer silhouette outline and internal depth-jump creases between overlapping objects. |

## Files

- [`scene.js`](./scene.js) — Procedural scene generator for the rocky crag, grassy plateau, watchtower, conical roof, waving pennant, hanging lantern, pines, pond, cascading waterfall, chimney smoke, and fireflies, plus the 24-color palette and loop animation.
- [`shaders.js`](./shaders.js) — GLSL ES 3.00 vertex/fragment shaders for EWA splat projection, smooth and 3-band lighting, hard-disc MRT pass, translucent pass, and the fullscreen 2×2 voting + Bayer + outline compositor.
- [`index.js`](./index.js) — WebGL2 orchestration: instanced VAO layout, 2-pass 16-bit radix depth sort, responsive low-res FBO sizing, and interactive `Reveal Discs` / `Fine Grid` toggles.
