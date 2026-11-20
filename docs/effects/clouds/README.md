# Evolution of Clouds & Sky (1992–2026)

Eight eras of real-time sky and volumetric cloud rendering running live in raw WebGL2 above an alpine sanctuary peak — from 1992 banded gradients and 2D pixel sprites to a real `64³` WebGL2 `TEXTURE_3D` Perlin–Worley raymarcher with Beer–Lambert silver linings, multi-scattering powder, and live crepuscular god-rays.

## Eras

| Step | Era | Technique | What changes visually |
|---|---|---|---|
| **CL1** | 1992 | **Banded Sky & 2D Pixel Clouds** | Early-90s quantized sky gradient with flat pixelated cloud sprites scrolling in 2D parallax — zero 3D perspective or atmospheric scatter. |
| **CL2** | 1997 | **Skybox Dome & Scrolling Plane** | N64 / PS1 era painted skybox with a single scrolling cloud sheet mapped onto a flat overhead plane — clouds visibly stretch toward the horizon. |
| **CL3** | 2002 | **3D Billboard Cloud Puffs** | Clusters of camera-facing alpha-blended puff quads floating in 3D space. Adds parallax volume, yet overlapping flat cards pop as you orbit. Toggle **Show Cards** to outline every quad. |
| **CL4** | 2007 | **Physical Rayleigh & Mie Sky** | Physically based atmospheric scattering: Rayleigh (`λ⁻⁴`) paints deep zenith blue and warm sunset horizons while Mie forward scattering builds a luminous solar halo and alpine aerial haze. |
| **CL5** | 2012 | **3D Perlin–Worley Raymarching** | *Horizon Zero Dawn / Nubis* breakthrough: marches camera rays through a live GPU-baked `64×64×64` tileable `TEXTURE_3D` Perlin–Worley noise volume for true 3D billowing cumulus silhouettes. |
| **CL6** | 2016 | **Beer–Lambert & HG Silver Lining** | Adds secondary shadow ray-marches toward the sun (`exp(-σ·d)`) plus a forward-peaked Henyey–Greenstein phase function — cloud edges near the sun erupt with glowing silver linings. |
| **CL7** | 2020 | **Multi-Scattering & Powder Effect** | Multi-octave energy-conserving scatter + Beer–Powder (`1 - exp(-2·σ·d)`) + cool blue sky bounce under cloud bases replace muddy dark bottoms with painterly volumetric depth. Toggle **Storm Front** to swell the cloud deck. |
| **CL8** | 2026 | **Crepuscular God-Rays & Dynamic Time-of-Day** | Real radial crepuscular light shafts streaming through gaps in the cumulus clouds, drifting cloud shadows over the alpine ridges, high-altitude cirrus wisps, HDR bloom, and live sun positioning (click anywhere in the sky or press **Sunset Sweep**!). |

## Files

- [`atmosphere.js`](./atmosphere.js) — Sun/time-of-day defaults, `NOISE_BAKE_FS` (GPU shader that bakes the tileable `64³` Perlin–Worley `TEXTURE_3D` in `< 3 ms`), Rayleigh/Mie atmospheric scattering, and alpine terrain SDF/heightfield helpers.
- [`shaders.js`](./shaders.js) — Four GLSL ES 3.00 shaders: `CLOUDS_MAIN_FS` (all 8 eras + split-screen), `GODRAYS_FS` (crepuscular radial light shafts), `BLUR_FS` (separable HDR bloom), and `FINAL_FS` (ACES filmic tone mapping with clean split-masking of god-rays).
- [`index.js`](./index.js) — WebGL2 controller: bakes the `64³` 3D texture once at startup, runs the 4-pass pipeline, handles sky click-to-aim sun, and drives `Show Cards`, `Storm Front`, and `Sunset Sweep`.
