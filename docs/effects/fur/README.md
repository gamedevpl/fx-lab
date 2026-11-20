# Evolution of Fur (1992–2026)

Eight eras of real-time game fur rendered on a sculpted red-fox totem resting on a mossy forest stump in raw WebGL2—from a smooth painted polygon mesh through *Shell Texturing* to 30,000 clumped 3D hair strands with spring-damper wind & shake physics.

**Live demo:** <https://gamedevpl.github.io/fx-lab/fur/>

## Stages

| Step | Era | Technique | What changes |
|---:|---|---|---|
| 1 | **1992** | **Flat Painted Texture** | Low-resolution painted fur stripes mapped onto a smooth polygon mesh with basic Lambert shading. Silhouette edges remain completely bald and rigid. |
| 2 | **1998** | **Normal-Mapped Fur** | High-frequency directional strand normals catch light across the face and cheeks, yet the silhouette edge is still as smooth as plastic. |
| 3 | **2001** | **8-Layer Shell Texturing** | Renders 8 concentric extruded mesh shells (`gl.drawElementsInstanced`) discarded by a procedural hair-tip density map—breaking up the silhouette, while revealing classic *Star Fox Adventures* / *Conker* slice stair-stepping. Toggle `Shell Slices` to expose the stacked layers. |
| 4 | **2005** | **40 Dense Shells + Gravity & Root AO** | Scales up to 40 finely spaced shells (*Shadow of the Colossus* era), bends strands downward with gravity ($h^2$), and darkens hair roots for plush volume and self-occlusion. |
| 5 | **2011** | **Kajiya–Kay Anisotropic Specular** | Replaces blobby surface specular with strand-tangent *Kajiya–Kay* highlights ($\sin(T, H) = \sqrt{1 - (T \cdot H)^2}$), wrapping a silky broken-up sheen ribbon across the groomed coat. |
| 6 | **2016** | **Marschner Dual-Lobe & Backlit Rim** | Adds physical dual-lobe scattering (surface reflection $R$ + warm copper internal bounce $TRT$) plus golden backlit transmission ($TT$) glowing through the ears and cheeks. |
| 7 | **2020** | **30,000 Geometric Clumped Strands** | Leaves stacked shells behind for 30,000 camera-facing 5-segment tapered 3D ribbons grouped into ~720 organic fur clumps with varying length across cheeks, ruff, ears, and muzzle. |
| 8 | **2026** | **Live Physics Groom, Wind & Petting** | Drives all 30,000 strands with a live `64×32` spring-damper velocity/displacement field reacting to turbulent wind, head-shake inertia, and interactive brushing. Click the fur to pet & comb it, or press `Shake & Gust`. |

## Files

- [`groom.js`](./groom.js) — Analytic red-fox head & ear geometry, coat color/length masks (keeping eyes and nose clear), 30,000 clumped 3D strand generator, solid stump/eye/nose meshes, and the `64×32` spring-damper wind/inertia/petting solver.
- [`shaders.js`](./shaders.js) — 5 fast rasterized GLSL ES 3.00 shaders (`SKY`, `SOLID`, `SHELL` instanced shell layers, `STRAND` instanced 5-segment ribbons with Kajiya–Kay & Marschner shading, and `POLLEN` sunlit dust motes).
- [`index.js`](./index.js) — WebGL2 orchestration, `gl.SCISSOR_TEST` dual-technique split comparisons (including `40 SHELLS` vs `30K STRANDS`), `Shell Slices` / `Shake & Gust` actions, and click-to-pet raycasting.
