# Strikepoint — Server Authority & Anti-Cheat Baseline

Phase 6 deliverable (ROADMAP). This documents the current trust model, its
known risks, and the concrete migration path to server authority for the
post-1.0 multiplayer track. Nothing here requires new runtime code today;
the enforcement that *is* automated lives in `src/sim/purity.test.ts` (CI).

## 1. Current trust model (single-player browser build)

- **Client-authoritative, client-only.** The sim runs locally; the only
  persistence is the player's own profile in `localStorage`. Nothing is at
  stake against other humans, so there is nothing to cheat *out of*.
- Known risks, accepted for 1.0:
  - Profile tampering: a user can hand-edit `strikepoint.profile.v1` to gain
    XP/level locally. Mitigations in place: schema versioning, clamped
    merge (garbage → defaults). Chasing local-truth cheaters is not worth
    complexity until profiles matter against other players.
  - Save-swap: the Phase 6 portable save lets a player carry a career across
    browsers. It validates through the same clamped pipeline; it can carry a
    tampered profile just as localStorage can. Same acceptance rationale.

## 2. Why the architecture is already cheat-resistant *by design*

The determinism contract is the anti-cheat asset:

- The sim (`src/sim/`) is pure: fixed 60 Hz ticks, seeded `Rng` for all
  gameplay randomness, no wall-clock reads, no browser globals. CI enforces
  this (`purity.test.ts`), plus a bit-for-bit replay/determinism test.
- All player influence enters as an `InputSnapshot` per tick.

That means the same binary sim can run on a trusted server: feed it the same
seed + input stream, get identical outcomes. Verification (not trust) settles
disputes. This is the founding bet of the project's netcode track.

## 3. Migration path (post-1.0, in order)

1. **Authoritative relay server (host migration lite).** Server runs the sim
   headless (Node, same TS — zero code changes; the purity scan is what
   guarantees this). Clients send input intents; the server ticks the sim,
   broadcasts resulting state deltas. Clients render with the existing
   interpolation view layer.
2. **Client-side prediction with server reconciliation.** The local sim
   already separates a predictable player controller from everything else;
   re-tick from the last acknowledged server state on correction.
3. **Input validation on the server.** Per-tick sanity bounds: mouse delta
   magnitude caps, action flags limited to the known set, fire-rate
   ceilings derived from weapon defs, movement speed ≤ cap × slack. Reject
   or clamp; log repeat offenders.
4. **Statistical anti-cheat.** Server-side telemetry (the Phase 5 per-weapon
   counters generalize naturally): accuracy, headshot ratio, snap-aim
   angular velocity vs. human envelopes. Flag outliers for review; never
   auto-ban on a single stat.
5. **Server-authoritative persistence.** Profile writes move behind an
   authenticated API; the local profile becomes a cache. XP awards are
   computed from server-simulated match results, so tampered clients simply
   disagree with the server and lose.

## 4. What 1.0 does instead

- Keeps the purity scan and determinism test as release gates — the longer
  the sim stays pure, the cheaper step 1 becomes.
- Treats leaderboards/telemetry as local-only (no cross-player surface to
  poison).
- Documents the acceptance risks above rather than pretending they aren't
  there.

## 5. Explicit non-goals before M6

- Obfuscation/anti-debug of the client bundle (security theater for a
  single-player build; costs more than it buys).
- Client-side "anti-cheat" code of any kind — it runs on the cheater's
  machine and is therefore not a control.
