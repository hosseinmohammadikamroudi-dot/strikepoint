/**
 * Phase 3 match-flow tests: countdown → live → over, FFA/TDM scoring, kill
 * attribution, feed lifecycle, and unattended bot-vs-bot combat.
 */
import { describe, expect, it } from "vitest";
import { World } from "./world";
import { createInputSnapshot, press } from "./input";
import { DEFAULT_MATCH, createMatch, registerKill, stepMatch, type MatchDef } from "./match";
import { scanTargets, createBot } from "./bot";
import { Level } from "./level";

const MATCH_60S: MatchDef = { mode: "tdm", map: "ringhold", timeLimit: 60, scoreLimit: 40, countdown: 0.5 };
const FFA_60S: MatchDef = { mode: "ffa", map: "ringhold", timeLimit: 60, scoreLimit: 40, countdown: 0 };

describe("match module", () => {
  it("countdown → live at 60 Hz, then live → over at the time limit", () => {
    const m = createMatch(MATCH_60S, 0, [1, 1, 1, 1]);
    expect(m.phase).toBe("countdown");
    for (let i = 0; i < 31; i++) stepMatch(m); // 0.5 s countdown
    expect(m.phase).toBe("live");
    expect(m.timer).toBeCloseTo(60, 1);
    for (let i = 0; i < 61 * 60; i++) stepMatch(m); // 61 s
    expect(m.phase).toBe("over");
    expect(m.winner).not.toBeNull();
  });

  it("TDM ends at the score limit with the leading team winning", () => {
    const m = createMatch(MATCH_60S, 0, [1, 1, 1, 1]);
    for (let i = 0; i < 31; i++) stepMatch(m); // → live
    for (let i = 0; i < 39; i++) registerKill(m, 1, 2 + (i % 3), false); // team 1 → 39
    expect(m.phase).toBe("live");
    registerKill(m, 1, 2, false); // 40th → team 1 wins
    expect(m.phase).toBe("over");
    expect(m.winner).toEqual({ kind: "team", team: 1 });
  });

  it("TDM: player team can win too", () => {
    const m = createMatch(MATCH_60S, 0, [1, 1, 1, 1]);
    for (let i = 0; i < 31; i++) stepMatch(m);
    for (let i = 0; i < 40; i++) registerKill(m, 0, 1, false); // player (team 0) x40
    expect(m.phase).toBe("over");
    expect(m.winner).toEqual({ kind: "team", team: 0 });
  });

  it("FFA: individual score limit ends the match", () => {
    const m = createMatch(FFA_60S, 0, [-1, -1, -1, -1]);
    for (let i = 0; i < 2; i++) stepMatch(m); // countdown 0 → live on first tick
    // Bot 2 farms two other bots (never itself — that would be a suicide).
    for (let i = 0; i < 40; i++) registerKill(m, 2, i % 2 === 0 ? 1 : 3, false);
    expect(m.phase).toBe("over");
    expect(m.winner).toEqual({ kind: "id", id: 2 });
  });

  it("registerKill attributes kills, streaks, and feeds; suicides only cost the victim", () => {
    const m = createMatch(MATCH_60S, 0, [1, 1]);
    registerKill(m, 0, 1, true);
    registerKill(m, 0, 1, true);
    registerKill(m, 2, 1, false); // bot 2 kills bot 1
    const p = m.scores.get(0)!;
    const b1 = m.scores.get(1)!;
    const b2 = m.scores.get(2)!;
    expect(p.kills).toBe(2);
    expect(p.streak).toBe(2);
    expect(b1.deaths).toBe(3);
    expect(b2.kills).toBe(1);
    expect(m.feed.length).toBe(3);
    expect(m.feed[2]).toEqual({ killerId: 2, victimId: 1, headshot: false, t: m.clock });
    // Suicide (fall damage later; here direct): victim death, no killer credit.
    registerKill(m, 1, 1, false);
    expect(m.scores.get(1)!.deaths).toBe(4);
    expect(m.scores.get(1)!.kills).toBe(0);
  });

  it("feed entries expire after 5 s", () => {
    const m = createMatch({ ...MATCH_60S, countdown: 0 }, 0, [1, 1]);
    registerKill(m, 0, 1, false);
    expect(m.feed.length).toBe(1);
    for (let i = 0; i < 6 * 60; i++) stepMatch(m); // 6 s
    expect(m.feed.length).toBe(0);
  });
});

describe("team filtering", () => {
  it("scanTargets skips same-team targets and self (combatant id +1)", () => {
    const level = new Level();
    const shooter = createBot("rusher", 0, 10, Math.PI, 0, 1); // team 1
    const mate = createBot("cover", 0, 18, Math.PI, 1, 1); // same team, in front
    const enemy = createBot("rusher", 0, 18, 0, 2, 2); // enemy, behind mate
    const targets = [
      { id: 0, team: 0, x: 0, y: 0, z: 18 }, // the player, enemy, in front
      { id: 2, team: 1, x: 0, y: 0, z: 18 }, // teammate at the same spot
      { id: 3, team: 2, x: 0, y: 0, z: 18 }, // enemy at the same spot
    ];
    // Shooter faces +Z (yaw π) toward all three; nearest visible enemy wins,
    // but the self-skip uses id + 1 = 1 (no entry), so id 0 must be seen.
    const idx = scanTargets(shooter, targets, level, 1.62);
    expect(idx).toBe(0);
    void mate;
    void enemy;
  });

  it("a bot in FFA (team -1) sees everyone", () => {
    const level = new Level();
    const b = createBot("rusher", 0, 10, Math.PI, 0, -1); // combatant id 1
    // Target id 5 ≠ own combatant id 1 → must be visible.
    const idx = scanTargets(b, [{ id: 5, team: -1, x: 0, y: 0, z: 16 }], level, 1.62);
    expect(idx).toBe(0);
  });
});

describe("world — unattended match flow", () => {
  it("bots fight each other without any player input; the scoreboard fills", () => {
    const w = new World({ seed: 77, match: { ...DEFAULT_MATCH, timeLimit: 600, countdown: 0.1 } });
    const input = createInputSnapshot();
    // 30 s unattended: bots must acquire and damage each other.
    for (let i = 0; i < 60 * 30; i++) w.step(input);
    const totalKills = [...w.match.scores.values()].reduce((a, e) => a + e.kills, 0);
    expect(totalKills).toBeGreaterThan(0);
    // Player idles at spawn — bots must not have been interrupted by freezing.
    expect(w.match.phase).toBe("live");
  });

  it("player kill credits the scoreboard and ends an early match via score limit", () => {
    const w = new World({
      seed: 78,
      match: { mode: "ffa", map: "ringhold", timeLimit: 600, scoreLimit: 1, countdown: 0 },
    });
    // FFA: everyone is an enemy. Track bot 0 from 4 m and hold fire until
    // the kill registers (bots roam, so the aim refreshes every tick).
    const input = createInputSnapshot();
    w.step(input); // countdown 0 → live on the first tick
    let guard = 0;
    while (w.match.phase === "live" && guard++ < 600) {
      const bot = w.bots[0]!;
      w.player.x = bot.x - 4;
      w.player.z = bot.z;
      w.player.yaw = -Math.PI / 2;
      w.player.pitch = Math.atan2(0.8 - 1.62, 4);
      w.player.frozen = false;
      if (w.kills === 0) press(input, "fire");
      w.step(input);
    }
    expect(w.match.phase).toBe("over");
    expect(w.match.winner).toEqual({ kind: "id", id: 0 });
    expect(w.kills).toBeGreaterThanOrEqual(1);
  });
});
