# Evolution of Water (1985–2026)

Eight eras of real-time game water inside a raymarched floating stone cistern with an aqueduct arch, glowing lantern, mooring pillar, and sunken tiles in raw WebGL2.

**Live demo:** <https://gamedevpl.github.io/fx-lab/water/>

## Stages

| Step | Era | Technique | What changes |
|---:|---|---|---|
| 1 | **1985** | **Palette Cycling (CLUT)** | A static `80×80` index map with a shifting 16-color ocean palette. Turn on Split to reveal the frozen grayscale indices on the left. |
| 2 | **1994** | **Scrolling UV & Scanline Warp** | Two tiled Voronoi/wave textures scroll in opposite directions with sine distortion and flat alpha blending over the submerged floor. |
| 3 | **2000** | **Beer–Lambert Depth Absorption** | Attenuates underwater light per channel with $\exp(-\sigma \cdot d)$ ($\sigma = (3.15, 0.90, 0.36)$): red dies first, leaving the shallow shelf turquoise and the deep basin navy. |
| 4 | **2004** | **Schlick Fresnel & Reflection** | Computes $F = F_0 + (1 - F_0)(1 - \cos\theta)^5$ with $F_0 = 0.02$ and traces reflection rays against the stone arch, lantern, and twilight sky. Orbit low toward the surface to see it turn into a mirror. |
| 5 | **2008** | **6-Wave Gerstner & Foam** | Sums six trochoidal waves that displace both horizontal and vertical coordinates for sharp peaks, plus noise-modulated contact foam around the rim and pillar. |
| 6 | **2014** | **Snell Refraction & RGB Caustics** | Bends underwater rays with $\text{IOR} = 1.333$ to distort floor tiles and projects two layers of chromatic-split Voronoi caustics onto submerged geometry. |
| 7 | **2020** | **Spectral Waves & Emerald SSS** | Adds multi-band capillary normal chop, backlit emerald subsurface scattering glowing through wave crests, and HDR sun glint bloom. |
| 8 | **2026** | **Live Shallow-Water PDE & 3D Splash** | Runs a live `128×128` viscous 2D shallow-water solver with strict zero-mean volume conservation (preventing whole-pool sloshing), Kelvin–Voigt velocity diffusion (damping grid-scale noise), and partial rim absorption. Plunging the bronze sphere spawns a raymarched 3D liquid crown, central Worthington rebound jet, 24 ballistic water droplets, and wet-clearcoat darkening on the sphere. Click anywhere on the water to inject live concentric ripples. |

## Files

- [`simulation.js`](./simulation.js) — CPU data & solver: 1985 CLUT index map, seamless Voronoi ripple tile, `128×128` zero-mean viscous shallow-water PDE, zero-sum concentric ring kernel, and sphere plunge/droplet trajectories.
- [`shaders.js`](./shaders.js) — 5-pass GLSL ES 3.00 pipeline (`BASIN_FS` solid cistern + 16-bit depth → `WATER_FS` all 8 water eras, Gerstner/spectral/PDE surface, Snell refraction, RGB caustics & arch reflection → `SPLASH_FS` Step 8 3D translucent splash crown, Worthington jet & 24 droplets → `BLUR_FS` separable Gaussian HDR bloom → `FINAL_FS` ACES tone mapping).
- [`index.js`](./index.js) — WebGL2 orchestration, 30 Hz (4× substep = 120 Hz) PDE stepping, `Drop Sphere` trigger, and cursor-to-pool raycasting for click-to-ripple.
