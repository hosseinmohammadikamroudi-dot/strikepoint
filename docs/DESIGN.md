# Strikepoint — Design Contract (v0.1, Phase 0)

Browser-based original FPS: fast movement, snappy hitscan gunplay, short time-to-kill,
arcade pacing. Original IP — no real-world factions, no licensed content, no
Call of Duty assets or branding (genre conventions only).

## Pillars (every feature must serve at least one)

1. **Movement feel first.** If moving isn't fun with no weapons, nothing else matters.
2. **Readable gunplay.** Deaths must be understandable: clear recoil, clear feedback,
   no random-feeling deaths. TTK stays short, but the player always knows why they died.
3. **Zero-friction access.** A URL, two clicks, in a match. No installer, no account
   required to play, no 60-second load.

## Core loop

Spawn → move/engage → kill or die → respawn → match end → progression tick → next match.
The inner loop (move → shoot → feedback) is the product; everything else supports it.

## Scope tiers (from DEVELOPMENT_PLAN)

- **Tier 1 — Prototype (M0):** one greybox map, one hitscan rifle, movement + damage +
  respawn vs. static dummies, 60fps in-browser. Proves *feel*.
- **Tier 2 — Playable (M4):** 3 maps, 6+ weapons + attachments, regen health, AI v1,
  FFA/TDM vs bots, full HUD/menus, audio, settings, local save, progression skeleton.
- **Tier 3 — Production (M6):** 6+ maps, 10+ weapons, accounts + cloud save,
  leaderboards, telemetry, deployment pipeline. Multiplayer is a **post-1.0** track.

## Non-goals (v1.0)

Vehicles, destructible environments, story campaign, cosmetics economy, mobile-first,
peer-to-peer multiplayer, third-person modes.

## Feel targets (normative — see METRICS.md)

Input-to-photon < 50 ms · 60 fps on integrated graphics · TTK 240–400 ms core weapons ·
ADS 180–350 ms per class · no loading screen longer than 5 s.
