# Strikepoint — Art Direction (v0.1, Phase 0)

**Vibe:** clean military-fiction, slightly stylized. Readability beats realism —
on the web we win by being legible at 1080p on integrated GPUs, not by chasing AAA.

## Palette

| Role | Color | Use |
|---|---|---|
| Base neutral | `#2A2F38` concrete | floors, walls |
| Secondary neutral | `#4A5261` gunmetal | props, trim |
| Signal accent | `#FF6B35` orange | interactables, enemy markers, crates |
| Cool accent | `#3EC1D3` teal | friendly markers, UI highlights |
| Warning | `#E5484D` red | damage states, danger zones |
| UI text | `#CFD8E3` on `#0E1116` | HUD |

Rule: environments stay desaturated; **players, pickups, and objectives carry the
saturated colors** so silhouettes read instantly.

## Lighting

- One directional "sun" + ambient/sky fill per map. No baked GI pipelines in v1.
- Ambient occlusion via cheap SSAO later only if the frame budget survives it.
- Emissive strips allowed for wayfinding (spawn markers, capture points).

## Materials & assets

- Blender → glTF/GLB; textures KTX2 (UASTC for albedo/normal, ETC1S for masks);
  geometry meshopt-compressed. Budgets: 1,500 tris/viewmodel, 12k tris/character,
  150k tris total per scene, 2k² max texture (most 1k²).
- Flat-ish PBR, roughness-driven; avoid mirror-smooth metals (aliasing on web).

## Effects

- Particles always pooled (zero allocation at runtime).
- Muzzle flash: one sprite + one transient light, ≤ 80 ms.
- Tracers: thin stretched quads, fade 60 ms.
- Impacts: surface-typed sparks/dust; blood kept minimal and desaturated (rating).
- Damage feedback: red vignette + directional indicator, never full-screen flashes
  (accessibility: motion/flash reduction toggle required by Tier 2).

## Camera

- FOV 75 default (player-adjustable 60–110).
- Screenshake: additive, capped, never applied during ADS beyond 20%.
