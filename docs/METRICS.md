# Strikepoint — Metrics Sheet (v0.3, Phase 3)

**This file is the contract between design and code.** Phase 1 tuning constants must
cite these values; changes go through this file first, then code. All units SI.

## Player movement

| Parameter | Value | Notes |
|---|---|---|
| Eye height | 1.62 m | capsule height 1.8 m, radius 0.35 m |
| Walk speed | 4.5 m/s | default combat pace |
| Sprint speed | 6.5 m/s | weapon lowered while sprinting |
| Crouch speed | 2.2 m/s | |
| ADS move speed | 2.8 m/s | overrides walk while aiming |
| Jump height | 0.9 m | initial vertical velocity 6.0 m/s (= √(2·g·h)), g = 20 m/s² (game gravity) |
| Air control | 0.35 × ground accel | some, not full |
| Acceleration | 40 m/s² ground (raised to 60 in code) | 40 cannot sustain caps under 10/s friction; deviation logged for review |
| Friction | 10 /s exponential | stop within ~0.1 s of releasing keys |

## Health & TTK

| Parameter | Value |
|---|---|
| Max health | 100 |
| Regen delay | 4.5 s after last damage |
| Regen rate | 40 hp/s |
| Headshot multiplier | ×1.6 (helmet-piercing classes ×2.0) |
| Limb multiplier | ×0.9 |
| Target TTK (core AR, body shots) | 240–300 ms |
| Max TTK tolerance | ≤ 500 ms for any viable weapon |

## Weapons (v0.1 starting values, all hitscan)

| Stat | AR (M4-analog "Vector-7") | SMG "Hornet" | Shotgun "Mule" | Sniper "Longview" |
|---|---|---|---|---|
| RPM | 750 | 900 | 90 (pump) | 45 (bolt) |
| Body damage | 25 | 20 | 8 × 8 pellets | 100 |
| Head damage | 40 | 32 | 12 × 8 | 160 |
| Damage falloff start | 30 m | 18 m | 10 m | none |
| Falloff floor | ×0.65 | ×0.5 | ×0.2 | — |
| ADS time | 220 ms | 180 ms | 200 ms | 350 ms |
| Hipfire bloom/shot | 0.35° | 0.3° | 2.5° | 3° |
| Recoil climb/shot | 0.5° vert | 0.4° vert | 4° | 3.5° |
| Recoil recovery | 8°/s | 9°/s | 6°/s | 5°/s |
| Reload time | 2.1 s | 1.8 s | 2.8 s (per shell 0.6 s) | 3.0 s |
| Mag size | 30 | 32 | 6 | 5 |

Derived: AR TTK body = 3 shots @ 80 ms interval ≈ 240 ms ✓ · SMG = 4 shots ≈ 267 ms ✓

## Map metrics

| Parameter | Value |
|---|---|
| Lane structure | 3-lane (main + two flank), rotations ≤ 8 s sprint |
| Lane width | 6–8 m |
| Full cover height | 1.8 m |
| Half cover height | 1.0 m (crouch-cover, vaultable in Phase 2+) |
| Max intended sightline | 40 m (sniper lanes only) |
| Engagement band | 10–30 m |
| Spawn-to-action | ≤ 4 s |
| Player collision capsule | r 0.35 m, h 1.8 m |

## Performance budgets (enforced from Phase 2 CI)

| Budget | Target |
|---|---|
| Frame time | ≤ 16.6 ms (60 fps) on integrated GPU, default settings |
| Draw calls | ≤ 600 per frame |
| JS heap | stable after warmup; zero per-frame allocations in hot loops |
| Load to interactive | ≤ 5 s on mid broadband |
| Input-to-photon | ≤ 50 ms |

## Phase 2 additions (systems contract)

| Parameter | Value | Notes |
|---|---|---|
| Weapon switch time | 0.4 s | blocks fire/reload; cancels in-progress reload |
| ADS model | sim-driven `adsAmount` | linear ramp over per-def `adsTime` (× attachment mult); spread blends hip↔ADS by amount |
| Recoil recovery | per-weapon 5–9°/s | starts 100 ms after the last shot; during a spray the kick outpaces recovery |
| Semi/pump/bolt trigger | one shot per press | auto refires while held |
| Shotgun shell reload | 0.6 s/shell | auto-continues; firing cancels when ≥1 shell loaded |
| Bot archetypes | rusher / cover / sniper | see below |
| Bot reaction time | 0.4 / 0.55 / 0.9 s | rusher / cover / sniper — continuous LOS required before first shot |
| Bot FOV | 110° / 100° / 70° | horizontal, from facing |
| Bot view range | 30 / 40 / 70 m | rusher / cover / sniper |
| Bot aim error (σ) | 2.2° / 1.6° / 0.5° | rusher / cover / sniper |
| Bot speed mult | 1.0 / 0.92 / 0.85 | × player caps |
| Bot preferred band | 4–12 / 10–25 / 25–60 m | closes in, strafes, or backs off to stay inside |
| Bot damage scale | ×0.5 of weapon damage | near-perfect AI aim ≫ human; scale keeps fights fair — playtest knob |
| Bot respawn | 6 s | at spawn farthest from player |
| Player respawn | 3 s | at spawn farthest from living bots; full hp/ammo |
| Bot patrol ring | radii 8 / 14 m alternating | 8 waypoints, 45° apart |
| Perf CI gate | sim step < 1 ms average | full world (player + 4 bots + 6 dummies) — render share validated in-browser |

## Phase 3 additions (match flow contract)

| Parameter | Value | Notes |
|---|---|---|
| Match modes | FFA / TDM | TDM teams: player team 0, bots team 1 (allies added via roster) |
| Match length | 10:00 | default per ROADMAP gate "10-minute match" |
| Score limit | 40 | TDM: team total · FFA: individual — ends match early |
| Match countdown | 3 s | frozen look-only; sim blocks move/fire/reload, bots idle |
| Post-match delay | 8 s | scoreboard shown, then the map pool rotates automatically |
| Map pool | ringhold / foundry / longyard | rotation order TDM → FFA → TDM; ring sizes 22 / 20 / 24 m |
| Combatant ids | player 0 · bots id+1 | bot.id is a roster index; the +1 reserve keeps ids disjoint (tested) |
| Bot target scan | all enemy combatants | nearest visible enemy wins — bots fight each other in FFA and across teams |
| Team filter | same-team targets skipped | FFA (team −1) engages everyone |
| Spawn selection | farthest-from-enemies − 0.4 × closest-teammate | deterministic argmax; full hp/ammo on respawn |
| Bot respawn | 6 s | farthest spawn from enemies (per spawn selection) |
| Kill feed | 6 entries, 5 s expiry | scoreboard top 6 by kills, ties by lower id |
| Feed glyph | ⌖ headshot · » body | kill attribution goes through the Match, never directly to HUD counters |


| Parameter | Value | Notes |
|---|---|---|
| Fixed timestep | 60 Hz | sim ticks at 1/60 s; render decoupled, no wall-clock reads in sim |
| Mouse sensitivity | 0.0022 rad/count | baseline tuning; user setting arrives in Phase 4 |
| Look pitch clamp | ±89° | |
| Dummy count (greybox) | 6 | Phase 1 combat set |
| Dummy HP | 100 | no regen; auto-respawn 3 s after death |

## Phase 4 — UX shell (settings · save/load · progression)

| Parameter | Value | Notes |
|---|---|---|
| Settings schema | `strikepoint.settings.v1` | 7 fields: fov 60–110 (def 75), sensitivity 0.2–3 (def 1), resolutionScale 0.5–1, masterVolume/sfxVolume 0–1 (defs 0.8 / 0.9), showFps, invertY |
| Settings load | merge-over-defaults + per-field clamp | corrupt/partial/hand-edited payloads can't crash the shell (tested) |
| Profile schema | `strikepoint.profile.v1` v1 | xp + career (matches, wins, kills, deaths, headshots, shotsFired, shotsHit); corrupt load → fresh profile, never a throw |
| XP per match | kills × 20 + headshots × 10 + win 100 + score × 10 | score = kills + 0.5 × assists-capable total; awarded once at match end |
| XP curve | level n needs 1000 + 300 × (n−2) since n ≥ 2 | level 1 at 0 XP; levels gate nothing yet (Phase 5/6 attach rewards) |
| Mouse sensitivity | 0.0022 × userMult rad/count | live-updatable mid-match via World.setLook; invertY flips pitch sign |
| FOV range | 60–110° | applies live to the shared camera; default 75 per METRICS baseline |
| Resolution scale | 0.5–1.0 | renderer size factor; perf lever for weak GPUs |
| Audio | WebAudio synth, no assets | master → sfx bus; per-weapon one-shots, hitmarkers, hurt/death/respawn, UI ticks; unlock on first user gesture |
| Bot fire audibility | < 35 m | distant fire skipped this pass (positional audio is Phase 5) |
| Match-end flow | over → 8 s victory lap → XP screen | real-time lap timer (not sim timer — score-limit endings freeze the clock) |
| Reset career | two-click inline confirm | no window.confirm; re-arms after 3 s |

## Phase 5 — Polish (positional audio · VFX · animation)

| Parameter | Value | Notes |
|---|---|---|
| Audio paths | 2 | `play` stereo bus (own weapons/UI) · `play3d` HRTF panner (world sounds) |
| Positional attenuation | 1 / (1 + (d/9)^1.7) | hand-rolled; panner rolloff disabled; ref 9 m |
| Distance lowpass | 12000 − 150·d Hz (floor 700) | far fire muffles naturally |
| Audible range | 70 m | world voices beyond are culled before node creation |
| Listener update | per render frame | camera position + forward (main.ts post-render) |
| Ambience bed | wind LPF 240 Hz ±90 Hz LFO (11 s) + 55/55.7 Hz pair | 2.5 s fade-in on unlock; 0.7 Hz beating room hum |
| Footstep cadence | every 2.1 m ground distance | speed > 0.5 m/s; crouch silent (stride resets) |
| Footstep voice | bandpass 850 Hz ±18% jitter + 130→70 Hz knock | own steps center-quiet; others positional |
| Landing event | fall speed < −3 m/s | severity = min(1, \|vy\|/9); one-tick flag, World-clears |
| Landing FX | camera dip −0.16·severity (τ≈0.14 s) + viewmodel drop + thump | severity-scaled |
| Muzzle flash | quad pool 6 + shared PointLight (8 / 14 intensity) | 55 ms life; offset 0.55 m along bore (0.35 bots); big for mule/longview |
| Impacts | billboard pool 32, 0.28 s life | wall spark 0.22 m additive · flesh puff 0.40 m · dust 1.3 m (reserved) |
| Tracer + wall spark | spawn per shot incl. bot shots | impact offset 0.04 m along reflected dir |
| Viewmodel poses | switch lower (1−switch01)^1.5, reload sin-hill tilt/roll, sprint cant −0.45 yaw/−0.28 roll, idle sway, bob | all eased frame-rate-independent (1−e^(−k·dt)) |
| Per-weapon stats | weaponShotsFired/Hit per slot | match-end screen: top-4 rows by usage with acc % |
| Sim budget guard | perf test best-of-3 | single-sample runner noise (GC) no longer trips the 1 ms gate |

## Phase 6 — Hardening (telemetry · perf profiles · deploy · anti-cheat baseline)

| Parameter | Value | Notes |
|---|---|---|
| Telemetry buffer | 20 matches / 600 fps samples | session-scoped ring buffers; aggregates only, no second long-term store |
| Session dashboard | win rate · K/D · acc · per-mode W/L · FPS avg/min | main-menu panel; aggregates from the ring buffer |
| FPS sampling | 1 Hz from the main loop | view.fps meter read, sim untouched |
| Auto-quality | 8 consecutive s < 45 fps → drop one tier, once per session | ignores first 20 s (boot warmup) and menus; never yo-yos; manual re-raise allowed |
| Quality presets | high 1.0 / medium 0.75 / low 0.55 resolution scale | preset changes the slider; slider refines after |
| Perf gate | best-of-3 samples, < 1 ms sim step | unaffected by runner GC noise (Phase 5) |
| Purity scan | CI test greps src/sim for wall clocks / Math.random / browser globals | block comments stripped (docs may name APIs); guards the server-authority path |
| Portable save | `{app:"strikepoint", saveVersion:1, settings, profile}` JSON | export → textarea → paste elsewhere; import re-validates through the same clamped merge pipeline |
| Bundle | game code 22 kB gzip · three.js 211 kB gzip (isolated chunk) | hidden prod sourcemaps (maps shipped, no reference in bundle) |
| Deploy | GitHub Pages on push to main, gated on typecheck+tests+build | dist/404.html SPA fallback; ci.yml remains the PR gate |
| Accounts | deferred post-1.0 | plan in docs/SERVER_AUTHORITY.md §3.5 |
