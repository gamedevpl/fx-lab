# Evolution of Cloth (1988–2026)

Eight eras of real-time game cloth rendered on a crimson-and-gold medieval banner suspended from a wrought-iron crossbar over a stone battlement in raw WebGL2—from a 2-frame pixel flip to an aerodynamic XPBD solver with live tearing.

**Live demo:** <https://gamedevpl.github.io/fx-lab/cloth/>

## Stages

| Step | Era | Technique | What changes |
|---:|---|---|---|
| 1 | **1988** | **2-Frame Pixel Flip** | A flat low-res `32×24` pixel banner snapping between two pre-drawn frames. Zero 3D geometry, zero lighting, zero physics. Turn on Split to compare a frozen sprite against the 2-frame flip. |
| 2 | **1996** | **Rigid Hinged Flap** | A single rigid textured quad swinging on a top hinge—common on early 3D consoles. Moves in 3D space with basic Lambert shading, yet bends like a wooden board. |
| 3 | **2000** | **Sine-Wave Vertex Shader** | Subdivides the banner into a 3D mesh displaced by travelling `sin(u, t)` waves. Looks fluid at a glance, but has no gravity, no drape, and visibly stretches like rubber. Toggle `Wireframe` to inspect the mesh. |
| 4 | **2004** | **Verlet Mass-Spring** | Real particle physics arrives: a `37×29` grid driven by Verlet integration, gravity, wind, and 2 structural constraint iterations. Drapes naturally, but low stiffness lets the cloth sag and crease sharply with plastic shading. |
| 5 | **2009** | **Bending Stiffness & Weave** | Adds 2-hop bending constraints and higher solver stiffness for heavy, sculptural folds, paired with a procedural woven linen normal map and raised metallic gold embroidery. |
| 6 | **2015** | **Velvet Sheen & Translucency** | Physically based cloth shading: grazing micro-fiber *Charlie* sheen highlights fold silhouettes while backlit subsurface translucency lets golden sunlight glow warmly through thin crimson creases. |
| 7 | **2020** | **XPBD & Sphere Collision** | Upgrades to sub-stepped *Extended Position-Based Dynamics* (virtually stretch-free) with frictional sphere collision. A brass cannonball pushes into the banner—turn on Split to compare pass-through vs real wrapping. |
| 8 | **2026** | **Aerodynamic Wind, Shadows & Tearing** | Per-triangle aerodynamic drag & lift ($\vec{F}_d + \vec{F}_l$ from relative wind velocity and triangle normal), live `512×512` PCF self-shadowing across folds and stonework, and dynamic edge tearing with loose thread particles. Click the banner to rip it live, or press `Launch Ball`. |

## Files

- [`simulation.js`](./simulation.js) — Procedural textures (1988 `32×24` pixel frames, heraldic banner), 3D stonework/pole/sphere meshes, Verlet/XPBD cloth solver, per-triangle aerodynamics, dynamic tearing topology, and loose-thread particles.
- [`shaders.js`](./shaders.js) — 5 fast rasterized GLSL ES 3.00 shaders (`SKY`, `SHADOW`, `SOLID`, `CLOTH`, `THREAD`) implementing all 8 cloth eras, woven micro-normals, Charlie velvet sheen, backlit translucency, and PCF self-shadows.
- [`index.js`](./index.js) — WebGL2 orchestration, `gl.SCISSOR_TEST` dual-simulation split-screen comparisons, `512×512` shadow map pass, click-to-gust / click-to-rip raycasting, and interactive stage actions.
