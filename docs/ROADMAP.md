# Strikepoint — Milestone Roadmap

Companion to `DESIGN.md`, `METRICS.md`, and `ART_DIRECTION.md`. This is the
contract for what ships when and the exit gate for each phase. Dates are
intentionally absent; gates, not calendars, move the project forward.

## Tiers

| Tier | Gate | Definition |
|---|---|---|
| **1 — Minimum Viable Prototype** | **M0** | One greybox map, one weapon, movement + shooting + damage/respawn vs. bots, 60 fps in-browser. Proves the *feel*. |
| **2 — Complete Playable** | **M4** | 3 finished maps, 6+ weapons with attachments, regen health, 3 AI archetypes, FFA/TDM vs. bots, full HUD/menus, audio pass, settings, save/load, progression skeleton. |
| **3 — Production-Ready** | **M6** | 6+ maps, 10+ weapons, full progression/rewards, accounts + cloud save, telemetry, perf hardening, deploy pipeline, post-launch plan. Multiplayer is a post-1.0 track, enabled by the deterministic sim from day one. |

## Phase gates

| Phase | Focus | Exit gate |
|---|---|---|
| **0 — Pre-production** ✅ | Docs, metrics, pipeline spike | Design contract committed; render spike runs at 60 fps on WebGPU-or-WebGL2 with frame-time HUD; CI green (typecheck + tests + build). |
| **1 — Core loop** ✅ | Input, character controller, weapon fire, hitscan, dummy targets, respawn | Week 1: pointer-lock camera + WASD at target metrics. End: kill-and-respawn loop vs. dummies; weekly playtests running. |
| **2 — Systems** ✅ | Weapon defs + attachments, health/regen, 3 AI archetypes (rusher / cover-shooter / sniper), damage model, perf budget in CI | Bot combat feels fair; frame budget (16.7 ms) enforced in CI harness. |
| **3 — Content** ✅ | 3 greybox→art maps, FFA + TDM rules, spawn logic, match flow | Strangers can play a 10-minute match unattended. |
| **4 — UX shell** ✅ | Full HUD, menus, settings (graphics/audio/controls), save/load, progression skeleton | Onboarding works for a fresh player with no explanation. |
| **5 — Polish** ✅ | Audio pass, VFX, animation polish, balance from telemetry | Tier 2 gate (M4) review. |
| **6 — Hardening** ✅ | Accounts/cloud save, telemetry dashboards, deploy pipeline, anti-cheat baseline (server-authoritative plans), perf profiles | Tier 3 gate (M6): production 1.0. |
| **Post-1.0** | Multiplayer track (netcode over deterministic sim), new content cadence | — |

## Standing constraints

- Sim layer stays engine-agnostic and deterministic — no wall-clock reads, no
  non-seeded randomness in gameplay code.
- Every phase ends with green CI: typecheck, unit tests, build, perf budget.
- Scope discipline: no vehicles, destruction, procedural gen, campaign, or
  cosmetics economy before M6. The P0–P3 feature list in DESIGN.md is the only
  source of truth for what's in scope.
