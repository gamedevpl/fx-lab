# Evolution of Surface Detail (1978–2026)

Interactive WebGL2 recreation of 48 years of surface detail and geometry techniques on a single carved Romanesque stone column and cobblestone plinth lit by a live grazing forge torch.

> **WebGL2 note:** WebGL2 does not expose native hardware tessellation (Hull/Domain) or Mesh Shader stages. Stages 6–8 emulate real displacement, adaptive density, and spatial meshlet clusters using pre-subdivided vertex-displaced GPU meshes sharing the exact same procedural heightfield as Stages 1–5.

## 8 Eras Covered
1. **1978 — Bump Mapping (Jim Blinn, SIGGRAPH 1978):** Grayscale height-derivative normal perturbation (compare vs pre-1978 flat texture in Split view).
2. **1998 — Normal Mapping (Cohen et al. & Cignoni et al. 1998 · *Evolva* / *Giants* 2000 · popularized by *Doom 3* 2004):** High-frequency normal vectors & metallic bevels on low-poly geometry — crisp straight-on, flat ruler-straight silhouette.
3. **2001 — Parallax / Offset Mapping (Kaneko et al. 2001 · Welsh 2004):** Single-step view-ray UV offset adds perceived depth straight-on, visibly swimming at grazing angles.
4. **2005 — Relief Mapping (Policarpo et al., I3D 2005):** Linear raymarch + binary-search heightfield intersection eliminates grazing swimming (basic version still has a flat silhouette, though silhouette-clipping variants exist).
5. **2006 — Parallax Occlusion Mapping / POM (Natalya Tatarchuk, GDC 2006):** Adaptive step march + linear secant interpolation + live heightfield soft self-shadowing; basic POM still leaves a smooth cylinder outline.
6. **2009 — Programmable DX11 Tessellation & Displacement (Direct3D 11 / Unigine *Heaven* 2009):** Following earlier hardware tessellation (ATI TruForm 2001, Xbox 360 2005), DX11 introduced programmable Hull/Domain shaders — pushing real 3D stone blocks past the silhouette (includes adaptive Wireframe toggle).
7. **2018–2020 — Mesh Shaders & Meshlets (NVIDIA Turing 2018 · DX12 Ultimate, March 2020):** Partitions dense displaced geometry into compact spatial meshlet packets (includes Meshlet Cluster debug overlay).
8. **2022–2026 — Virtualized Micropolygon Geometry (UE5 Nanite — demo 2020, production UE 5.0 2022):** Subpixel-scale chiseled stone micro-displacement & hierarchical micropolygon cluster debug view.
