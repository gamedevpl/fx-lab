# Evolution of Shadows (1988–2026)

Eight eras of real-time game shadows rendered on a sunlit travertine sanctuary with a Gothic stained-glass arch, rotating brass astrolabe, fluted column, stone step, and crystal orb in raw WebGL2.

**Live demo:** <https://gamedevpl.github.io/fx-lab/shadows/>

## Stages

| Step | Era | Technique | What changes |
|---:|---|---|---|
| 1 | **1988** | **Blob Shadow** | Places soft circular discs directly under each object on the ground plane (`y = 0`). Grounds floating characters cheaply, but ignores object shape, walls, and sun direction. |
| 2 | **1996** | **Planar Projected Shadow** | Projects the true silhouette onto `y = 0` along the sun vector. Reveals the astrolabe rings and arch silhouette on the floor, but cuts off cleanly at the stone step and casts zero shadows onto vertical columns or itself. |
| 3 | **2000** | **Stencil Shadow Volumes** | Classic *Doom 3*-era geometric shadowing on every surface (floor, step, column, and self-shadowing across the rotating rings). Razor-sharp everywhere with zero penumbra regardless of distance. |
| 4 | **2004** | **Hard Shadow Map (`88×88`)** | Renders an actual orthographic depth buffer from the sun's viewpoint into an `88×88` nearest-sampled texture. Exposes authentic texel stair-stepping (*perspective aliasing*) and depth-bias trade-offs. Toggle `Texel Grid` to inspect the projected depth texels. |
| 5 | **2008** | **PCF Soft Shadows** | Upgrades to a `320×320` shadow map filtered with a 16-tap Poisson disk (*Percentage-Closer Filtering*). Removes jagged blocks, but blurs uniformly—making contact shadows at column bases look detached and muddy. |
| 6 | **2012** | **PCSS Contact-Hardening** | Runs a 12-tap blocker search to estimate average occluder distance $d_b$ and scales filter radius by $w_p = \frac{d_r - d_b}{d_b} \cdot w_{\text{light}}$. Crisp right where objects touch the stone; smoothly softer further away. |
| 7 | **2018** | **Ray-Traced Area Light & Sky Fill** | Replaces the discrete depth map with cone-traced SDF area shadows—eliminating texel bias—paired with crevice Ambient Occlusion and hemisphere sky light so shadows shift to cool sky blue instead of flat grey. |
| 8 | **2026** | **Colored Glass Shadows & GI Bounce** | Rays passing through the Gothic stained-glass window tint the shadow with ruby, cobalt, amber, and emerald light (softening with distance), the crystal orb focuses a refractive lens caustic inside its shadow, and bounced warm stone + stained-glass GI illuminates nearby shaded columns. Click anywhere on the courtyard to aim the sun or toggle `Wide Sun`. |

## Files

- [`shaders.js`](./shaders.js) — 5-pass GLSL ES 3.00 pipeline (`SHADOW_MAP_FS` real orthographic depth map → `GBUFFER_FS` camera raymarch with 16-bit depth & octahedral normals → `LIGHTING_FS` all 8 shadow eras, stained-glass transmission, crystal caustic & color-bounce GI → `BLUR_FS` separable HDR bloom → `FINAL_FS` ACES tone mapping).
- [`index.js`](./index.js) — WebGL2 orchestration, `88×88` + `320×320` shadow map targets, `Texel Grid` / `Wide Sun` / `Sweep Sun` actions, and click-to-aim sun raycasting.
