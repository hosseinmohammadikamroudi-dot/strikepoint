import { describe, expect, it } from "vitest";
import {
  ARCHETYPES,
  applyBotDamage,
  botSees,
  createBot,
  stepBot,
  type Bot,
  type BotShot,
  type TargetRef,
} from "./bot";
import { Level } from "./level";
import { Rng } from "./rng";
import { WEAPON_DEFS } from "./weapons";

const level = new Level();

/** Single-target list standing in for "the player" in these unit tests. */
function targetAt(px: number, pz: number): TargetRef[] {
  return [{ id: 0, team: -2, x: px, y: 0, z: pz }];
}

/** Step a bot n ticks toward/at a player; returns shots fired. */
function run(
  b: Bot,
  ticks: number,
  px: number,
  pz: number,
  shots: BotShot[] = [],
): BotShot[] {
  const def = WEAPON_DEFS[b.defId];
  const rng = new Rng(999);
  const targets = targetAt(px, pz);
  for (let i = 0; i < ticks; i++) {
    stepBot(b, level, targets, def.rpm, def.magSize, def.reloadTime, rng, shots, level.patrolPoints, b.defId);
  }
  return shots;
}

describe("perception", () => {
  it("sees a target inside FOV and range with clear LOS", () => {
    const b = createBot("rusher", 0, 10, Math.PI, 0); // facing +Z (yaw π)
    const d = botSees(b, 0, 0.9, 18, level, 1.62);
    expect(d).toBeGreaterThan(0);
  });

  it("does not see a target behind it", () => {
    const b = createBot("rusher", 0, 10, 0, 0); // facing −Z, target behind (+Z)
    expect(botSees(b, 0, 0.9, 18, level, 1.62)).toBe(-1);
  });

  it("does not see through walls", () => {
    const b = createBot("rusher", 0, -18, Math.PI, 0); // facing +Z, center wall at z=0
    // Center cross structure blocks the direct line.
    const d = botSees(b, 0, 0.9, 18, level, 1.62);
    // The cross is 1.2 m deep at x∈[-3,3]; bot at z=-18, target z=18 — blocked.
    expect(d).toBe(-1);
  });

  it("respects view range", () => {
    const b = createBot("rusher", 0, 0, 0, 0);
    expect(botSees(b, 0, 0.9, 60, level, 1.62)).toBe(-1); // rusher range 30
  });
});

describe("combat behavior", () => {
  it("respects reaction time before the first shot", () => {
    const b = createBot("rusher", 0, 10, Math.PI, 0);
    const shots: BotShot[] = [];
    const reactionTicks = Math.ceil(ARCHETYPES.rusher.reactionTime * 60);
    run(b, reactionTicks, 0, 16, shots);
    expect(shots.length).toBe(0);
    run(b, 30, 0, 16, shots);
    expect(shots.length).toBeGreaterThan(0);
  });

  it("rusher closes to its preferred band", () => {
    // Spawn 17 m out (beyond preferredMax 12) with clear LOS down the lane.
    const b = createBot("rusher", 10, 2, Math.PI, 0);
    run(b, 1, 0, 16, []); // acquire
    const start = Math.hypot(b.x - 0, b.z - 16);
    expect(start).toBeGreaterThan(ARCHETYPES.rusher.preferredMax);
    run(b, 240, 0, 16); // 4 s
    const end = Math.hypot(b.x - 0, b.z - 16);
    expect(end).toBeLessThan(start);
    expect(end).toBeLessThanOrEqual(ARCHETYPES.rusher.preferredMax);
  });

  it("sniper backs off when the player is inside its band", () => {
    const b = createBot("sniper", 0, 10, Math.PI, 0);
    run(b, 1, 0, 20, []); // acquire at 10 m < preferredMin 25
    const start = Math.hypot(b.x - 0, b.z - 20);
    run(b, 240, 0, 20);
    const end = Math.hypot(b.x - 0, b.z - 20);
    expect(end).toBeGreaterThan(start + 3);
  });

  it("stops firing while reloading, then resumes", () => {
    const b = createBot("rusher", 0, 10, Math.PI, 0);
    const shots: BotShot[] = [];
    run(b, 600, 0, 14, shots); // 10 s — must burn the 32-round mag at least once
    expect(b.reloadTimer).toBeGreaterThanOrEqual(0);
    expect(shots.length).toBeGreaterThan(32); // reloaded at least once
  });

  it("loses the target without LOS and chases last-seen", () => {
    const b = createBot("rusher", 0, 10, Math.PI, 0);
    run(b, 30, 0, 16); // acquire
    expect(b.mode).toBe("combat");
    // Target vanishes behind the bot (LOS drops); memory must keep it chasing
    // toward where the player was seen — not the player's new position.
    run(b, 60, 0, -16);
    expect(b.mode).toBe("chase");
    expect(b.lastSeenZ).toBeCloseTo(16, 1); // remembered, not (-16) current
  });
});

describe("damage & death", () => {
  it("dies and reports lethal", () => {
    const b = createBot("cover", 0, 0, 0, 1);
    expect(applyBotDamage(b, 50)).toBe(false);
    expect(applyBotDamage(b, 50)).toBe(true);
    expect(b.mode).toBe("dead");
    expect(b.hp).toBe(0);
  });

  it("ignores damage while dead", () => {
    const b = createBot("cover", 0, 0, 0, 1);
    applyBotDamage(b, 200);
    expect(applyBotDamage(b, 100)).toBe(false);
  });

  it("dead bots count down their respawn timer", () => {
    const b = createBot("cover", 0, 0, 0, 1);
    applyBotDamage(b, 200);
    const t0 = b.respawnTimer;
    run(b, 60, 0, 30);
    expect(b.respawnTimer).toBeLessThan(t0);
  });
});
