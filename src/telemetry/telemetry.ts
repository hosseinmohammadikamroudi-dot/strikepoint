/**
 * Session telemetry (ROADMAP Phase 6). View-side only — the sim never reads
 * or writes this. Two jobs:
 *  1. Ring buffer of match records (last N matches this session) — the raw
 *     material for balance decisions (mode/map win rates, K/D, accuracy).
 *  2. FPS sampler — one `sample()` per second from the main loop; feeds the
 *     perf dashboard and the auto-quality downgrade trigger.
 *
 * Persistence boundary: career totals live in the profile (localStorage);
 * this buffer is deliberately session-scoped. Aggregates small enough to be
 * honest, no second long-term store to keep in sync.
 */

export interface MatchRecord {
  mode: string;
  map: string;
  won: boolean;
  kills: number;
  deaths: number;
  headshots: number;
  shotsFired: number;
  shotsHit: number;
  /** Wall-clock duration of the match (view-side timing; sim never sees it). */
  durationS: number;
}

export interface PerfSample {
  /** Seconds of session time this window covers. */
  atS: number;
  fps: number;
}

export interface TelemetryAggregate {
  matches: number;
  wins: number;
  winRate: number;
  kills: number;
  deaths: number;
  kd: number;
  acc: number;
  /** Mean FPS across all samples (0 when none). */
  avgFps: number;
  /** Worst FPS sample seen (0 when none). */
  minFps: number;
  /** Per-mode win/loss, balance-review friendly. */
  byMode: { mode: string; matches: number; wins: number }[];
}

export interface Telemetry {
  recordMatch(r: MatchRecord): void;
  readonly matches: readonly MatchRecord[];
  /** Push one FPS reading (call ~1 Hz from the main loop). */
  sampleFps(fps: number, atS: number): void;
  readonly perf: readonly PerfSample[];
  aggregate(): TelemetryAggregate;
}

const MAX_MATCHES = 20;
const MAX_SAMPLES = 600; // 10 minutes at 1 Hz

export function createTelemetry(): Telemetry {
  const records: MatchRecord[] = [];
  const perf: PerfSample[] = [];

  return {
    recordMatch(r) {
      records.push(r);
      if (records.length > MAX_MATCHES) records.shift();
    },
    get matches() {
      return records;
    },
    sampleFps(fps, atS) {
      perf.push({ atS, fps });
      if (perf.length > MAX_SAMPLES) perf.shift();
    },
    get perf() {
      return perf;
    },
    aggregate(): TelemetryAggregate {
      let wins = 0;
      let kills = 0;
      let deaths = 0;
      let fired = 0;
      let hit = 0;
      const modes = new Map<string, { matches: number; wins: number }>();
      for (const r of records) {
        if (r.won) wins++;
        kills += r.kills;
        deaths += r.deaths;
        fired += r.shotsFired;
        hit += r.shotsHit;
        const m = modes.get(r.mode) ?? { matches: 0, wins: 0 };
        m.matches++;
        if (r.won) m.wins++;
        modes.set(r.mode, m);
      }
      let fpsSum = 0;
      let fpsMin = Infinity;
      for (const s of perf) {
        fpsSum += s.fps;
        if (s.fps < fpsMin) fpsMin = s.fps;
      }
      return {
        matches: records.length,
        wins,
        winRate: records.length > 0 ? wins / records.length : 0,
        kills,
        deaths,
        kd: deaths > 0 ? kills / deaths : kills > 0 ? kills : 0,
        acc: fired > 0 ? hit / fired : 0,
        avgFps: perf.length > 0 ? fpsSum / perf.length : 0,
        minFps: perf.length > 0 ? fpsMin : 0,
        byMode: [...modes.entries()].map(([mode, m]) => ({ mode, ...m })),
      };
    },
  };
}
