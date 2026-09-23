# Strikepoint

An original browser-based first-person shooter — fast movement, snappy hitscan
gunplay, short TTK, arcade pacing. Inspired by the *genre*, built from scratch:
no CoD assets, characters, maps, or branding.

**Status: Phase 0 (Pre-Production)** — render spike + repo scaffold.

## Stack

TypeScript · Vite · Three.js (`WebGPURenderer`, WebGPU-first with WebGL2 fallback)
· Vitest. Full stack rationale and architecture live in the development plan.

## Getting started

```bash
npm install
npm run dev        # http://localhost:5173
npm run typecheck  # tsc --noEmit
npm test           # vitest
npm run build      # production bundle in dist/
```

## Docs

- [`docs/DESIGN.md`](docs/DESIGN.md) — design contract: pillars, loop, scope tiers
- [`docs/METRICS.md`](docs/METRICS.md) — **single source of truth** for tuning numbers
- [`docs/ART_DIRECTION.md`](docs/ART_DIRECTION.md) — palette, lighting, asset budgets

## Milestones

M0 prototype feel-lock → M2 match modes → M4 playable version → M6 v1.0 launch →
post-1.0 multiplayer track (authoritative servers; sim is written deterministic
from day one so this is a track, not a rewrite).
