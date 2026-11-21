# Evolution of Reflections (1976–2026)

Interactive WebGL2 recreation of 50 years of real-time and offline reflection techniques on one rain-slicked neon courtyard (wet basalt puddles, dark concrete occluder monolith hiding a hot-magenta neon totem, high overhead cyan marquee, polished/brushed chrome sphere, and an interactive glowing gold plasma orb).

## 8 Eras Covered
1. **1976 — Equirectangular Environment Mapping (Blinn & Newell):** Latitude-longitude distant sky panorama only; zero local scene reflections or parallax.
2. **1996 — Planar Portal Mirror (*Duke Nukem 3D* 1996 · *Unreal* 1998):** Crisp mirrored geometry across a single flat floor plane; curved chrome sphere cannot use planar reflection.
3. **1999 — Hardware Cubemaps (GeForce 256 & DX7):** Works on curved surfaces as well as the floor, yet infinite-distance projection disconnects floor reflections from their bases.
4. **2011 — Screen-Space Reflections / SSR (*Crysis 2* DX11):** Real multi-pass screen-space raymarching against the primary G-buffer depth/color — captures live geometry and the moving orb, yet leaves missing holes behind the dark occluder monolith and clips reflections whenever neon exits the top of the screen.
5. **2012 — Parallax-Corrected Cubemaps (Bjorke 2004 · popularized by Lagarde & Zanuttini, SIGGRAPH 2012):** Room-box ray projection snaps courtyard reflections back onto their true floor contact lines and fills SSR holes, though static probes still omit the moving orb.
6. **2013 — Split-Sum Roughness IBL (Brian Karis / UE4, SIGGRAPH 2013):** Pre-filtered GGX roughness convolution + analytical Split-Sum BRDF across mirror puddles vs damp matte stone.
7. **2018 — Hardware Ray-Traced Reflections (*Battlefield V* DXR):** Full 3D 1-bounce secondary rays restore the hidden behind-monolith magenta totem, off-screen overhead neon marquee, and live moving orb everywhere.
8. **2022–2026 — Multi-Bounce Glossy RT (*UE5 Lumen* 2022 · *Cyberpunk 2077 RT Overdrive* 2023):** GGX importance-sampled stochastic glossy rays (contact hardening on damp stone) + true 2nd-bounce mirror-in-mirror reflections + jitter-free temporal accumulation.
