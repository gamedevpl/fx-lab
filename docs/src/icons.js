// Crisp 12x12 hand-crafted pixel-art SVG icons for each effect in FX Lab.
// Uses integer pixel coords + shape-rendering="crispEdges" so icons stay razor-sharp at 16px and 48px.

const ICONS = {
  // Floating pixel watchtower island (red roof, stone tower, green turf, cyan waterfall)
  splats:
    `<rect x="5" y="1" width="2" height="1" fill="#151423"/>` +
    `<rect x="4" y="2" width="4" height="1" fill="#e24a4a"/>` +
    `<rect x="5" y="2" width="2" height="1" fill="#ff7a59"/>` +
    `<rect x="3" y="3" width="6" height="1" fill="#d13b3b"/>` +
    `<rect x="4" y="3" width="3" height="1" fill="#ff7a59"/>` +
    `<rect x="4" y="4" width="4" height="3" fill="#f5e4c3"/>` +
    `<rect x="7" y="4" width="1" height="3" fill="#c7b08e"/>` +
    `<rect x="5" y="5" width="1" height="1" fill="#151423"/>` +
    `<rect x="2" y="7" width="8" height="2" fill="#46c25b"/>` +
    `<rect x="2" y="7" width="5" height="1" fill="#7be87a"/>` +
    `<rect x="3" y="9" width="6" height="1" fill="#4d5c82"/>` +
    `<rect x="4" y="10" width="4" height="1" fill="#323d59"/>` +
    `<rect x="7" y="8" width="2" height="3" fill="#56d1e3"/>` +
    `<rect x="7" y="8" width="1" height="2" fill="#b4f5ff"/>`,

  // Crackling pixel flame with golden core, rising ember & dark log base
  fire:
    `<rect x="9" y="1" width="1" height="1" fill="#ffd147"/>` +
    `<rect x="5" y="1" width="2" height="2" fill="#ff551f"/>` +
    `<rect x="4" y="3" width="4" height="2" fill="#ff6a17"/>` +
    `<rect x="3" y="4" width="1" height="4" fill="#d93223"/>` +
    `<rect x="8" y="4" width="1" height="4" fill="#d93223"/>` +
    `<rect x="4" y="5" width="4" height="4" fill="#ff941a"/>` +
    `<rect x="5" y="5" width="2" height="4" fill="#ffd84d"/>` +
    `<rect x="5" y="7" width="2" height="2" fill="#fff7d6"/>` +
    `<rect x="2" y="9" width="8" height="2" fill="#5c3828"/>` +
    `<rect x="3" y="9" width="6" height="1" fill="#824d36"/>`,

  // Cresting turquoise pixel wave with white seafoam & floating splash drops
  water:
    `<rect x="3" y="2" width="1" height="1" fill="#b8fcff"/>` +
    `<rect x="8" y="1" width="1" height="1" fill="#7ef2e2"/>` +
    `<rect x="5" y="3" width="3" height="1" fill="#e8fcff"/>` +
    `<rect x="4" y="4" width="5" height="1" fill="#7ef2e2"/>` +
    `<rect x="8" y="4" width="2" height="1" fill="#e8fcff"/>` +
    `<rect x="3" y="5" width="6" height="2" fill="#00d4b4"/>` +
    `<rect x="1" y="6" width="3" height="2" fill="#00a8c6"/>` +
    `<rect x="9" y="6" width="2" height="2" fill="#00a8c6"/>` +
    `<rect x="1" y="7" width="10" height="2" fill="#0089ba"/>` +
    `<rect x="2" y="7" width="4" height="1" fill="#38e4c8"/>` +
    `<rect x="1" y="9" width="10" height="2" fill="#134e8c"/>` +
    `<rect x="3" y="9" width="5" height="1" fill="#1e6fb8"/>`,

  // Golden sun casting a crisp diagonal shadow from a stone pillar onto warm tiles
  shadows:
    `<rect x="1" y="1" width="3" height="3" fill="#ffae19"/>` +
    `<rect x="1" y="1" width="2" height="2" fill="#ffe66d"/>` +
    `<rect x="4" y="3" width="1" height="1" fill="#ffcf4d"/>` +
    `<rect x="1" y="8" width="10" height="3" fill="#c9ae85"/>` +
    `<rect x="1" y="10" width="10" height="1" fill="#9c805d"/>` +
    `<rect x="6" y="8" width="5" height="2" fill="#23223b"/>` +
    `<rect x="7" y="9" width="4" height="2" fill="#151423"/>` +
    `<rect x="4" y="4" width="3" height="5" fill="#d9deeb"/>` +
    `<rect x="4" y="4" width="1" height="5" fill="#fff5df"/>` +
    `<rect x="6" y="4" width="1" height="5" fill="#7c85a6"/>`,

  // Waving crimson heraldic banner on a brass crossbar with golden diamond crest
  cloth:
    `<rect x="1" y="1" width="10" height="1" fill="#f2b84b"/>` +
    `<rect x="1" y="1" width="1" height="2" fill="#ffe08a"/>` +
    `<rect x="10" y="1" width="1" height="2" fill="#c78726"/>` +
    `<rect x="2" y="2" width="7" height="7" fill="#d92b44"/>` +
    `<rect x="3" y="3" width="7" height="5" fill="#e83f55"/>` +
    `<rect x="2" y="2" width="2" height="7" fill="#ff6678"/>` +
    `<rect x="8" y="3" width="2" height="6" fill="#94162b"/>` +
    `<rect x="5" y="4" width="2" height="2" fill="#ffd147"/>` +
    `<rect x="2" y="9" width="3" height="2" fill="#b81d35"/>` +
    `<rect x="7" y="9" width="3" height="2" fill="#94162b"/>`,

  // Red-fox totem face (pointy orange ears, fluffy cream cheeks, crisp eyes & nose)
  fur:
    `<rect x="2" y="1" width="2" height="2" fill="#151423"/>` +
    `<rect x="8" y="1" width="2" height="2" fill="#151423"/>` +
    `<rect x="2" y="2" width="2" height="2" fill="#e86f1c"/>` +
    `<rect x="8" y="2" width="2" height="2" fill="#e86f1c"/>` +
    `<rect x="3" y="3" width="6" height="4" fill="#f58225"/>` +
    `<rect x="4" y="3" width="4" height="2" fill="#ffa84d"/>` +
    `<rect x="2" y="5" width="8" height="4" fill="#f58225"/>` +
    `<rect x="2" y="7" width="3" height="3" fill="#fff3dc"/>` +
    `<rect x="7" y="7" width="3" height="3" fill="#fff3dc"/>` +
    `<rect x="4" y="8" width="4" height="3" fill="#fff3dc"/>` +
    `<rect x="3" y="6" width="1" height="1" fill="#151423"/>` +
    `<rect x="8" y="6" width="1" height="1" fill="#151423"/>` +
    `<rect x="5" y="8" width="2" height="1" fill="#151423"/>`,

  // Faceted crystal prism / diamond with ice-cyan highlights & rainbow caustic glint
  glass:
    `<rect x="5" y="1" width="2" height="1" fill="#e0fbff"/>` +
    `<rect x="4" y="2" width="4" height="1" fill="#8ce8ff"/>` +
    `<rect x="3" y="3" width="6" height="2" fill="#42c6eb"/>` +
    `<rect x="2" y="5" width="8" height="2" fill="#1b9fd6"/>` +
    `<rect x="3" y="7" width="6" height="2" fill="#0d6ea8"/>` +
    `<rect x="4" y="9" width="4" height="1" fill="#0a4c7d"/>` +
    `<rect x="5" y="10" width="2" height="1" fill="#0a4c7d"/>` +
    `<rect x="4" y="3" width="2" height="3" fill="#d9fbff"/>` +
    `<rect x="5" y="2" width="1" height="2" fill="#ffffff"/>` +
    `<rect x="7" y="7" width="1" height="2" fill="#ff7aa8"/>` +
    `<rect x="8" y="6" width="1" height="1" fill="#ffe066"/>`,

  // Fluffy cumulus cloud with golden sun peeking top-left & shaded blue-slate belly
  clouds:
    `<rect x="2" y="2" width="3" height="3" fill="#ffae19"/>` +
    `<rect x="2" y="2" width="2" height="2" fill="#ffe66d"/>` +
    `<rect x="5" y="3" width="3" height="2" fill="#ffffff"/>` +
    `<rect x="3" y="5" width="6" height="3" fill="#f2f7ff"/>` +
    `<rect x="2" y="6" width="8" height="3" fill="#dce9fa"/>` +
    `<rect x="1" y="7" width="10" height="2" fill="#b4cdf0"/>` +
    `<rect x="2" y="9" width="8" height="1" fill="#6f90c2"/>` +
    `<rect x="5" y="4" width="3" height="1" fill="#ffffff"/>` +
    `<rect x="3" y="5" width="4" height="1" fill="#ffffff"/>`,

  // Lush pixel meadow tuft with curving emerald blades & sunny yellow wildflower blossom
  grass:
    `<rect x="2" y="9" width="8" height="2" fill="#5c3d28"/>` +
    `<rect x="1" y="6" width="1" height="2" fill="#4ec946"/>` +
    `<rect x="2" y="7" width="1" height="2" fill="#2d9938"/>` +
    `<rect x="3" y="4" width="1" height="5" fill="#5fd94b"/>` +
    `<rect x="4" y="3" width="1" height="2" fill="#9bf257"/>` +
    `<rect x="5" y="5" width="1" height="4" fill="#2d9938"/>` +
    `<rect x="6" y="4" width="1" height="5" fill="#4ec946"/>` +
    `<rect x="8" y="6" width="1" height="3" fill="#2d9938"/>` +
    `<rect x="9" y="5" width="1" height="2" fill="#7be851"/>` +
    `<rect x="7" y="1" width="3" height="3" fill="#ffd84d"/>` +
    `<rect x="8" y="2" width="1" height="1" fill="#ff841f"/>`,

  // Iconic pixel Cornell Box (crimson left wall, teal right wall, ceiling softbox, glowing sphere & light ray)
  pathtracing:
    `<rect x="1" y="1" width="10" height="10" fill="#2b2b3d"/>` +
    `<rect x="1" y="1" width="2" height="10" fill="#d92b3a"/>` +
    `<rect x="1" y="2" width="1" height="8" fill="#ff5c6c"/>` +
    `<rect x="9" y="1" width="2" height="10" fill="#18a882"/>` +
    `<rect x="10" y="2" width="1" height="8" fill="#3be0b3"/>` +
    `<rect x="4" y="1" width="4" height="1" fill="#fff5cc"/>` +
    `<rect x="3" y="9" width="6" height="2" fill="#8f8b84"/>` +
    `<rect x="3" y="9" width="3" height="1" fill="#c77d7d"/>` +
    `<rect x="6" y="9" width="3" height="1" fill="#6fb5a8"/>` +
    `<rect x="5" y="2" width="1" height="2" fill="#ffd84d"/>` +
    `<rect x="4" y="5" width="4" height="4" fill="#f5b841"/>` +
    `<rect x="5" y="5" width="2" height="2" fill="#fff3c4"/>` +
    `<rect x="7" y="4" width="1" height="1" fill="#ffe066"/>` +
    `<rect x="8" y="3" width="1" height="1" fill="#7ef2e2"/>`,

  // Cel-shaded sentinel helmet with black ink outline, golden V-crest horns, cyan eyes & crimson scarf
  toon:
    `<rect x="1" y="1" width="2" height="2" fill="#ffd147"/>` +
    `<rect x="9" y="1" width="2" height="2" fill="#ffd147"/>` +
    `<rect x="2" y="2" width="2" height="2" fill="#f5a623"/>` +
    `<rect x="8" y="2" width="2" height="2" fill="#f5a623"/>` +
    `<rect x="3" y="2" width="6" height="7" fill="#151423"/>` +
    `<rect x="4" y="3" width="4" height="2" fill="#f5f3ef"/>` +
    `<rect x="5" y="2" width="2" height="2" fill="#e83f55"/>` +
    `<rect x="3" y="5" width="6" height="2" fill="#1b2238"/>` +
    `<rect x="4" y="5" width="1" height="1" fill="#47f2ff"/>` +
    `<rect x="7" y="5" width="1" height="1" fill="#47f2ff"/>` +
    `<rect x="4" y="7" width="4" height="1" fill="#c7d0e6"/>` +
    `<rect x="2" y="8" width="8" height="2" fill="#d92b3a"/>` +
    `<rect x="3" y="8" width="5" height="1" fill="#ff5c6c"/>` +
    `<rect x="9" y="9" width="2" height="2" fill="#ffd147"/>` +
    `<rect x="3" y="10" width="6" height="1" fill="#2d63bd"/>`,

  // 4x AA magnifier: jagged stair-stepped pixels on left vs smooth anti-aliased ramp on right inside amber frame
  aa:
    `<rect x="1" y="1" width="10" height="10" fill="#f2b84b"/>` +
    `<rect x="2" y="2" width="8" height="8" fill="#182238"/>` +
    `<rect x="2" y="7" width="2" height="3" fill="#e8eef7"/>` +
    `<rect x="4" y="5" width="2" height="5" fill="#e8eef7"/>` +
    `<rect x="6" y="4" width="1" height="6" fill="#e8eef7"/>` +
    `<rect x="7" y="3" width="1" height="7" fill="#e8eef7"/>` +
    `<rect x="8" y="2" width="2" height="8" fill="#e8eef7"/>` +
    `<rect x="6" y="3" width="1" height="1" fill="#70b8ff"/>` +
    `<rect x="7" y="2" width="1" height="1" fill="#46e8c8"/>` +
    `<rect x="5" y="4" width="1" height="1" fill="#4f6d9e"/>` +
    `<rect x="5" y="2" width="1" height="8" fill="#ff5c77"/>`,

  // Neon cyan & amber archway mirrored upside-down inside a dark wet puddle with magenta accent
  reflections:
    `<rect x="1" y="1" width="10" height="5" fill="#10182b"/>` +
    `<rect x="1" y="6" width="10" height="5" fill="#080d18"/>` +
    `<rect x="1" y="6" width="10" height="1" fill="#1c2c47"/>` +
    `<rect x="3" y="1" width="6" height="1" fill="#2bf0ff"/>` +
    `<rect x="2" y="2" width="1" height="4" fill="#ff9e2c"/>` +
    `<rect x="9" y="2" width="1" height="4" fill="#ff9e2c"/>` +
    `<rect x="4" y="3" width="1" height="3" fill="#ff2e88"/>` +
    `<rect x="7" y="4" width="2" height="2" fill="#d9e6ff"/>` +
    `<rect x="3" y="10" width="6" height="1" fill="#149cb0"/>` +
    `<rect x="2" y="7" width="1" height="3" fill="#a86419"/>` +
    `<rect x="9" y="7" width="1" height="3" fill="#a86419"/>` +
    `<rect x="4" y="7" width="1" height="2" fill="#b31c5e"/>` +
    `<rect x="7" y="7" width="2" height="2" fill="#637ba6"/>`,
};

const FALLBACK_ICON =
  `<rect x="5" y="1" width="2" height="10" fill="#eea75e"/>` +
  `<rect x="1" y="5" width="10" height="2" fill="#eea75e"/>` +
  `<rect x="4" y="4" width="4" height="4" fill="#fff3dc"/>`;

export function getEffectIconSvg(id, cls = "fx-ico") {
  const body = ICONS[id] || FALLBACK_ICON;
  return `<svg class="${cls}" viewBox="0 0 12 12" shape-rendering="crispEdges" aria-hidden="true">${body}</svg>`;
}
