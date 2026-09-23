/**
 * Match rules and flow (ROADMAP Phase 3): FFA and TDM over bot combatants,
 * with a countdown → live → over state machine, score limits, and a time
 * limit. Plain data + pure-ish step function on the sim's 60 Hz tick.
 *
 * Design (DESIGN.md core loop): spawn → fight → die/respawn → match end →
 * next match. The match owns scoring and end conditions; World owns entities
 * and delegates kill attribution here.
 */

import type { MapId } from "./maps";

export type ModeId = "ffa" | "tdm";

export interface MatchDef {
  mode: ModeId;
  map: MapId;
  /** Match length in seconds once live. */
  timeLimit: number;
  /** Score that ends the match early (per-player in FFA, per-team in TDM). */
  scoreLimit: number;
  /** Seconds of pre-live freeze (spawn-in countdown). */
  countdown: number;
}

/** Default "strangers can play 10 minutes unattended" match (ROADMAP gate). */
export const DEFAULT_MATCH: MatchDef = {
  mode: "tdm",
  map: "ringhold",
  timeLimit: 600,
  scoreLimit: 40,
  countdown: 3,
};

export type MatchPhase = "countdown" | "live" | "over";

export interface ScoreEntry {
  /** Combatant id: 0 = player, bots are their World ids. */
  id: number;
  name: string;
  /** Team index; -1 = no team (FFA). */
  team: number;
  kills: number;
  deaths: number;
  /** Headshot kills (match-end XP panel). */
  headshots: number;
  /** Streak of kills without dying (killfeed flourish later). */
  streak: number;
}

export interface MatchState {
  def: MatchDef;
  phase: MatchPhase;
  /** Seconds remaining in the current phase. */
  timer: number;
  scores: Map<number, ScoreEntry>;
  /** Winner id (player/bot) or team index for TDM; null while playing. */
  winner: { kind: "id"; id: number } | { kind: "team"; team: number } | null;
  /** Recent kills for the HUD feed, newest last: [killerId, victimId, headshot, t]. */
  feed: { killerId: number; victimId: number; headshot: boolean; t: number }[];
  /** Monotonic match clock (s) since construction, for feed expiry. */
  clock: number;
}

const NAMES = [
  "Rook", "Vex", "Havoc", "Nomad", "Pike", "Saber", "Drift", "Wren",
  "Onyx", "Falx", "Brisk", "Cinder", "Gale", "Mako", "Quill", "Tarn",
];

export function createMatch(def: MatchDef, playerTeam: number, botTeams: readonly number[]): MatchState {
  const scores = new Map<number, ScoreEntry>();
  scores.set(0, { id: 0, name: "You", team: playerTeam, kills: 0, deaths: 0, headshots: 0, streak: 0 });
  for (let i = 0; i < botTeams.length; i++) {
    const id = i + 1; // World bot ids are 0-based; scores shift by one for the player
    scores.set(id, {
      id,
      name: NAMES[i % NAMES.length]!,
      team: botTeams[i]!,
      kills: 0,
      deaths: 0,
      headshots: 0,
      streak: 0,
    });
  }
  return {
    def,
    phase: "countdown",
    timer: def.countdown,
    scores,
    winner: null,
    feed: [],
    clock: 0,
  };
}

export function scoreFor(m: MatchState, id: number): ScoreEntry {
  let e = m.scores.get(id);
  if (!e) {
    e = { id, name: id === 0 ? "You" : `Bot ${id}`, team: -1, kills: 0, deaths: 0, headshots: 0, streak: 0 };
    m.scores.set(id, e);
  }
  return e;
}

/** Attribute a kill: killer +1 (suicides just cost the victim), victim death. */
export function registerKill(m: MatchState, killerId: number, victimId: number, headshot: boolean): void {
  const victim = scoreFor(m, victimId);
  victim.deaths += 1;
  victim.streak = 0;
  if (killerId !== victimId) {
    const killer = scoreFor(m, killerId);
    killer.kills += 1;
    killer.streak += 1;
    if (headshot) killer.headshots += 1;
  }
  m.feed.push({ killerId, victimId, headshot, t: m.clock });
  if (m.feed.length > 6) m.feed.shift();
  checkEnd(m);
}

function teamScore(m: MatchState, team: number): number {
  let total = 0;
  for (const e of m.scores.values()) if (e.team === team) total += e.kills;
  return total;
}

/** Highest individual score; ties broken by lowest id (deterministic). */
function leader(m: MatchState): ScoreEntry {
  let best: ScoreEntry | null = null;
  for (const e of m.scores.values()) {
    if (!best || e.kills > best.kills || (e.kills === best.kills && e.id < best.id)) best = e;
  }
  return best!;
}

function checkEnd(m: MatchState): void {
  if (m.phase !== "live") return;
  if (m.def.scoreLimit > 0) {
    if (m.def.mode === "tdm") {
      // Two teams expected (0 = player's, 1 = opposition).
      const a = teamScore(m, 0);
      const b = teamScore(m, 1);
      if (a >= m.def.scoreLimit || b >= m.def.scoreLimit) {
        m.phase = "over";
        m.winner = { kind: "team", team: a >= m.def.scoreLimit && a > b ? 0 : b >= m.def.scoreLimit ? 1 : 0 };
        return;
      }
    } else {
      const top = leader(m);
      if (top.kills >= m.def.scoreLimit) {
        m.phase = "over";
        m.winner = { kind: "id", id: top.id };
        return;
      }
    }
  }
}

/** Advance the match clock one tick. Returns true on a phase transition. */
export function stepMatch(m: MatchState): boolean {
  m.clock += 1 / 60;
  if (m.phase === "over") return false;
  m.timer -= 1 / 60;

  if (m.phase === "countdown") {
    if (m.timer <= 0) {
      m.phase = "live";
      m.timer = m.def.timeLimit;
      return true;
    }
    return false;
  }

  // Live: feed expiry + time limit.
  while (m.feed.length > 0 && m.clock - m.feed[0]!.t > 5) m.feed.shift();
  if (m.timer <= 0) {
    m.phase = "over";
    if (m.def.mode === "tdm") {
      const a = teamScore(m, 0);
      const b = teamScore(m, 1);
      m.winner = { kind: "team", team: a > b ? 0 : b > a ? 1 : 0 };
    } else {
      m.winner = { kind: "id", id: leader(m).id };
    }
    return true;
  }
  return false;
}
