# Evolution of Grass & Foliage (1992–2026)

Eight eras of real-time game grass and foliage rendered live in raw WebGL2 on a single sculpted sunlit hillside diorama with an ancient runestone, mossy stepping stones, and a live spring-damper trampling trail field.

## Eras

| Step | Year | Technique | What changes |
|---|---|---|---|
| **G1** | 1992 | **Flat Pixel Grass Tile** | Repeating 16×16 nearest-neighbor pixel-art tile painted flat onto low-poly ground with banded VGA sky. |
| **G2** | 1996 | **Crossed Alpha-Cutout X-Cards** | 440 pairs of orthogonal intersecting flat quads stamped with binary alpha-cutout pixel grass tufts. Toggle **Show X-Cards** to reveal the flat quad borders. |
| **G3** | 2001 | **Stacked Shell Grass** | 10 translucent terrain layers lifted along the hilltop normal with tapering alpha dots — fuzzy from above, visible pancake strata along the rim. |
| **G4** | 2007 | **22,000 GPU-Instanced 3D Blades** | Real 4-segment tapered curved blade geometry rendered in one `drawElementsInstanced` call with stiff flat Lambert lighting. Toggle **Blade Mesh** to inspect the geometry. |
| **G5** | 2012 | **Travelling Wind Waves & Root AO** | Multi-octave curl wind fronts with arc-length-preserving bending, dark earthy root ambient occlusion, and V-crease blade specular sheen across wave crests. |
| **G6** | 2017 | **Backlit SSS & Painterly Meadow** | Warm golden translucent subsurface scattering through backlit blade tips paired with painterly macro meadow color variation. |
| **G7** | 2022 | **Wildflowers, Cloud Shadows & Pollen** | 650 swaying 3D wildflowers (buttercups, daisies, cornflowers, poppies) synced to the wind field, drifting overhead cloud shadows, and sunlit floating pollen motes. Press **Wind Gust**! |
| **G8** | 2026 | **Live Interactive Meadow & Trails** | Real-time 128×128 persistent bend/spring trail field plus exact analytical sphere-blade parting driven by a rolling carved brass-and-oak orb and mouse/touch clicks. |

## Files

- [`scene.js`](./scene.js) — Rolling hilltop heightfield, runestone & stepping stones, rolling orb, 440 X-cards, 10 shell layers, 22,000 instanced blades, 650 instanced 3D wildflowers, and 180 pollen motes.
- [`shaders.js`](./shaders.js) — All 12 GLSL ES 3.00 shaders (Ghibli sky, terrain, stone props, rolling orb, X-cards, shell layers, instanced blades, flowers, pollen, HDR bloom, and ACES composite).
- [`index.js`](./index.js) — `createGrassEffect(gl)` with `gl.scissor` split-screen comparison, live 64×64 spring-damper trampling field, and terrain click raycasting.
