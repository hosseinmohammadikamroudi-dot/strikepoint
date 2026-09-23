/**
 * Progression skeleton (ROADMAP Phase 4). XP is awarded at match end from
 * the scoreline; levels gate nothing yet — they are the skeleton that
 * Phase 5/6 rewards and unlocks attach to. Pure functions + a testable XP
 * curve; persistence lives in save.ts.
 */

/** Cumulative XP required to *reach* level n (level 1 at 0 XP). */
export function xpForLevel(level: number): number {
  if (level <= 1) return 0;
  // Quadratic-ish curve: 1000 XP for level 2, then each level costs 25% more.
  // Level n requires 1000 * (1.25^(n-1) - 1) / 0.25 cumulative, rounded.
  const gain = (lvl: number): number => Math.round(1000 * Math.pow(1.25, lvl - 2));
  let total = 0;
  for (let l = 2; l <= level; l++) total += gain(l);
  return total;
}

/** Current level for a total XP amount. */
export function levelForXp(xp: number): number {
  let level = 1;
  while (xpForLevel(level + 1) <= xp && level < 200) level++;
  return level;
}

/** Progress into the current level: [xpIntoLevel, xpForNextLevel]. */
export function levelProgress(xp: number): { into: number; span: number } {
  const level = levelForXp(xp);
  const base = xpForLevel(level);
  const next = xpForLevel(level + 1);
  return { into: xp - base, span: next - base };
}

/** Derive a display name for a level (skeleton — cosmetics later). */
export function rankName(level: number): string {
  if (level >= 20) return "Veteran";
  if (level >= 10) return "Enforcer";
  if (level >= 5) return "Operator";
  return "Recruit";
}

export interface MatchXpInput {
  kills: number;
  deaths: number;
  /** True when the player's team/side won. */
  won: boolean;
}

export interface MatchXpAward {
  kills: number;
  win: number;
  /** Kill − death, floored at 0 (feeding shouldn't farm). */
  net: number;
  total: number;
}

/** XP from a finished match: 20/kill, 150 win bonus, net score × 10. */
export function matchXp(inp: MatchXpInput): MatchXpAward {
  const kills = inp.kills * 20;
  const win = inp.won ? 150 : 0;
  const net = Math.max(0, inp.kills - inp.deaths) * 10;
  return { kills, win, net, total: kills + win + net };
}
