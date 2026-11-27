# Material Sandbox (FX Lab #31)

Interactive WebGL2 studio material playground showcasing how light behaves across six fundamentally different surface models on a single procedural 3D shaderball (or Torus Knot).

## Scene & Lighting
- **Procedural Shaderball SDF:** smooth sphere dome, precision-chamfered equatorial groove, crown lathe ring, circular chamfered aperture cavity, and recessed inner hero core seated on a dark anodized studio plinth.
- **Torus Knot `(2,3)` Toggle:** exact loop-free cylindrical-meridional SDF with analytical spine tangent for seam-free anisotropic brushed reflections.
- **Orbiting Rectangular Softbox:** Karis Most-Representative-Point (MRP) rectangular area-light specular + soft SDF shadows + 5-tap SDF cavity AO + 1-bounce glossy floor reflection. Drag the glowing light handle or click the studio backdrop to position the softbox manually.
- **3 Procedural HDR IBL Presets:** *Studio Softbox*, *Low Sun*, and *Neon Night*.

## 6 Material Presets
1. **2005 Plastic (Blinn-Phong):** non-energy-conserving white specular blob and flat ambient — reference baseline for `Split vs 2005 Phong`.
2. **Dry Clay (Oren-Nayar):** high roughness, retro-reflective grazing flattening, and micro-grain normal bump with zero plastic gloss.
3. **Brushed Steel (Anisotropic GGX):** directional Heitz/Filament anisotropic GGX lobe + multi-tap anisotropic IBL streaks + lathe micro-grooves.
4. **Car Paint (Clearcoat + Metal Flake):** sparkling 3D metallic aluminum flakes under a smooth, independent IOR 1.5 clearcoat layer.
5. **Velvet (Charlie Sheen):** Estevez & Kulla inverted-Gaussian sheen NDF producing a rich dark core and luminous grazing rim.
6. **Heat-Blued Titanium (Thin-Film Iridescence):** Belcour & Barla Airy optical thin-film interference shifting gold → violet → cobalt blue with viewing angle.

## Controls
- **5 Sliders:** `Roughness`, `Metallic`, `Clearcoat`, `Anisotropy`, `Iridescence` (`160–720 nm`).
- **3 Toggles:** `Split vs 2005 Phong`, `Orbit Light`, `Auto-Morph` (smooth continuous preset loop; URL shortcuts `?morph=1&hud=0`, `?shape=knot`, `?env=2`).
