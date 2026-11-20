# Evolution of Glass & Caustics (1995–2026)

Eight eras of real-time glass rendering and optical caustics running live in raw WebGL2 on the same sunlit marble observatory pedestal — featuring a sculpted 8-flute Venetian crystal orb and a beveled triangular optical prism.

## Eras

| Step | Era | Technique | What changes visually |
|---|---|---|---|
| **G1** | 1995 | **Flat Alpha Transparency** | Fixed-function alpha blend (`mix(bg, tint, 0.36)`): zero bending or reflections, looks like flat grey cellophane pasted over the tiles. |
| **G2** | 1999 | **Env-Map Chrome & Specular** | Adds spherical studio environment reflection and a Blinn–Phong sun highlight, while background tiles still pass straight through unbent. |
| **G3** | 2003 | **Schlick Fresnel** | Physical angle-dependent reflectivity (`F₀ = 0.04` for glass `IOR 1.52`): clear straight-on through the center, crisp mirror skylight reflections along grazing rims. |
| **G4** | 2007 | **Single-Surface Snell Refraction** | Real `refract(rd, N, 1 / 1.52)` bends rays on entry — magnifying and warping the inlaid marble checkerboard and brass observatory columns behind the glass. |
| **G5** | 2012 | **Thick Double Refraction & Beer–Lambert** | Traces rays through the solid glass to the back exit face (inverting the background like a real convex lens) and absorbs light exponentially by path length `exp(-σ·d)` for jewel-like aquamarine depth. |
| **G6** | 2016 | **Cauchy Chromatic Dispersion** | Replaces one IOR with wavelength-dependent Cauchy IOR across 5 spectral bands (`R: 1.49 → V: 1.59`), splitting high-contrast marble tiles and prism rims into crisp rainbows. |
| **G7** | 2021 | **Real-Time Photon Caustics & Microfacets** | GPU traces **16,384+ refracted sunlight photons** (`gl.POINTS` additive splats) into a `512×512` caustic map on the marble floor, focusing star-cusp caustics inside the orb shadow. Toggle **Frost Glass** for microfacet GGX roughness. |
| **G8** | 2026 | **Multi-Bounce TIR, Spectral Caustics & Prism Beam** | Full multi-bounce Total Internal Reflection (sparkling internal diamond facets), **6-wavelength (98,304-photon) spectral caustics** painting a living Newton rainbow fan across the marble tiles, subtle sunlit dust-beam glow, HDR bloom, and live sun aiming. |

## Files

- [`optics.js`](./optics.js) — Scene constants, sun & dispersion presets, analytical pedestal/column ray intersections, fluted-orb & triangular-prism SDFs, and procedural HDR studio skylight environment.
- [`shaders.js`](./shaders.js) — Five GLSL ES 3.00 shaders: `CAUSTIC_PHOTON_VS/FS` (real-time GPU photon splatting), `GLASS_MAIN_FS` (8-era refractive/reflective ray tracer + split-screen), `BLUR_FS` (separable HDR bloom), and `FINAL_FS` (ACES filmic tone mapping).
- [`index.js`](./index.js) — Four-pass WebGL2 pipeline (`512×512` caustic FBO → MRT HDR/bloom → 1/4-res blur → ACES), interactive marble floor click-to-aim sun, and action toggles (`High Dispersion`, `Frost Glass`, `Sweep Sun`).
