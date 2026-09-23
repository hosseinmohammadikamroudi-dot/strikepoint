import { describe, expect, it } from "vitest";
import { World } from "./world";
import {
  createInputSnapshot,
  press,
  release,
  addMouse,
  type InputSnapshot,
  type ActionFlag,
} from "./input";
import { DUMMY_HP } from "./dummy";
import { applyPlayerDamage } from "./player";
import { createBot } from "./bot";

/**
 * Place the player 5 m from dummy `idx` along the first cardinal direction
 * with clear line-of-sight (robust to any map's cover layout), settle one
 * tick (collision push-out), then aim exactly at the dummy. Tests that need
 * a specific pitch override it after calling this.
 */
function approachDummy(w: World, idx: number, eyeY = 1.45): void {
  const d = w.dummies[idx]!;
  const cards: { dx: number; dz: number; yaw: number }[] = [
    { dx: -1, dz: 0, yaw: -Math.PI / 2 }, // from −X, facing +X
    { dx: 1, dz: 0, yaw: Math.PI / 2 },
    { dx: 0, dz: -1, yaw: 0 },
    { dx: 0, dz: 1, yaw: Math.PI },
  ];
  for (const c of cards) {
    const px = d.x + c.dx * 5;
    const pz = d.z + c.dz * 5;
    if (w.level.rayCast(px, eyeY, pz, -c.dx, 0, -c.dz, 5) >= 5) {
      w.player.x = px;
      w.player.z = pz;
      w.player.vx = 0;
      w.player.vz = 0;
      w.step(createInputSnapshot()); // settle: resolve any collision push-out
      const yaw = Math.atan2(-(d.x - w.player.x), -(d.z - w.player.z));
      w.player.yaw = yaw;
      w.player.pitch = 0;
      w.player.recoilPitch = 0;
      w.player.recoilYaw = 0;
      return;
    }
  }
  throw new Error("no clear cardinal approach to dummy");
}

/** Deterministic scripted input trace for reproducibility tests. */
function scriptedTrace(world: World, ticks: number): void {
  const input = createInputSnapshot();
  const script: { tick: number; do: (s: InputSnapshot) => void }[] = [
    { tick: 5, do: (s) => press(s, "forward") },
    { tick: 30, do: (s) => addMouse(s, 42, -17) },
    { tick: 60, do: (s) => press(s, "fire") },
    { tick: 120, do: (s) => addMouse(s, -25, 9) },
    { tick: 200, do: (s) => press(s, "reload") },
    { tick: 340, do: (s) => press(s, "ads") },
    { tick: 400, do: (s) => press(s, "jump") },
  ];
  let si = 0;
  for (let t = 0; t < ticks; t++) {
    while (si < script.length && script[si]!.tick === t) {
      script[si]!.do(input);
      si++;
    }
    if (t === 65) release(input, "forward");
    if (t === 90) release(input, "fire");
    if (t === 205) release(input, "reload");
    if (t === 340) press(input, "fire");
    if (t === 401) release(input, "jump");
    world.step(input);
  }
}

describe("world — firing range (no bots)", () => {
  it("dummy takes damage, dies, and respawns after 3 s", () => {
    const w = new World({ seed: 1, bots: false });
    const d = w.dummies[0]!;
    approachDummy(w, 0); // chest-height lane
    const input = createInputSnapshot();
    press(input, "fire");
    w.step(input);
    const hit = w.events.find((e) => e.kind === "hit");
    expect(hit).toBeDefined();
    expect(d.hp).toBeLessThan(DUMMY_HP);
    // Kill it: keep firing until dead.
    let guard = 0;
    while (d.status === "alive" && guard++ < 10) w.step(input);
    expect(d.status).toBe("dead");
    expect(w.events.some((e) => e.kind === "kill" || e.kind === "killHeadshot")).toBe(true);
    // 3 s = 180 ticks.
    for (let i = 0; i < 181; i++) w.step(createInputSnapshot());
    expect(d.status).toBe("alive");
    expect(d.hp).toBe(DUMMY_HP);
  });

  it("headshots deal ×1.6 damage", () => {
    const w = new World({ seed: 2, bots: false });
    const d = w.dummies[0]!;
    approachDummy(w, 0); // settles + aims at the dummy
    // Eye height 1.62 → level shot hits at 1.62 m ≥ 1.50 m head band.
    w.player.pitch = 0;
    const input = createInputSnapshot();
    press(input, "fire");
    w.step(input);
    const hit = w.events.find((e) => e.kind === "hit");
    expect(hit?.kind === "hit" && hit.zone).toBe("head");
    expect(d.hp).toBeCloseTo(DUMMY_HP - 40, 5); // HEAD_DAMAGE
  });

  it("fixed seed + scripted trace reproduces state bit-for-bit", () => {
    const run = (): {
      pos: string;
      kills: number;
      shots: number;
      hits: number;
      events: string;
      dummyHp: number[];
    } => {
      const w = new World({ seed: 1337 });
      scriptedTrace(w, 450);
      return {
        pos: `${w.player.x.toFixed(9)},${w.player.y.toFixed(9)},${w.player.z.toFixed(9)},${w.player.yaw.toFixed(9)},${w.player.pitch.toFixed(9)}`,
        kills: w.kills,
        shots: w.shotsFired,
        hits: w.shotsHit,
        events: w.events.map((e) => e.kind).join(","),
        dummyHp: w.dummies.map((d) => d.hp),
      };
    };
    const a = run();
    const b = run();
    expect(b.pos).toBe(a.pos);
    expect(b.kills).toBe(a.kills);
    expect(b.shots).toBe(a.shots);
    expect(b.hits).toBe(a.hits);
    expect(b.events).toBe(a.events);
    expect(b.dummyHp).toEqual(a.dummyHp);
  });

  it("no dummy damage past level geometry (wall blocks hitscan)", () => {
    const w = new World({ seed: 3, bots: false });
    const d = w.dummies[0]!;
    // Inject an explicit full-height wall between player (d.x−5) and dummy.
    w.level.boxes.push({ minX: d.x - 3, maxX: d.x - 2, minY: 0, maxY: 3, minZ: d.z - 3, maxZ: d.z + 3 });
    w.player.x = d.x - 5;
    w.player.z = d.z;
    w.player.yaw = -Math.PI / 2; // face +X toward dummy, through the wall
    w.player.pitch = 0;
    const input = createInputSnapshot();
    press(input, "fire");
    w.step(input);
    expect(w.events.some((e) => e.kind === "hit")).toBe(false);
  });

  it("stats track shots, hits, kills, headshots", () => {
    const w = new World({ seed: 4, bots: false });
    approachDummy(w, 1); // clear lane at dummy 1
    const input = createInputSnapshot();
    press(input, "fire");
    let guard = 0;
    while (w.shotsFired < 30 && guard++ < 200) w.step(input);
    expect(w.shotsFired).toBe(30);
    expect(w.shotsHit).toBeGreaterThan(0);
    expect(w.kills).toBeGreaterThan(0);
  });
});

describe("world — health & death (Phase 2)", () => {
  it("regenerates 40 hp/s after the 4.5 s delay", () => {
    const w = new World({ seed: 10, bots: false });
    applyPlayerDamage(w.player, 60); // 100 → 40
    const input = createInputSnapshot();
    for (let i = 0; i < 270; i++) w.step(input); // 4.5 s — delay not elapsed
    expect(w.player.hp).toBe(40);
    for (let i = 0; i < 60; i++) w.step(input); // +1 s of regen
    expect(w.player.hp).toBeCloseTo(80, 0); // +40 hp/s
    for (let i = 0; i < 200; i++) w.step(input);
    expect(w.player.hp).toBe(100);
  });

  it("bots can kill the player; respawn restores full health at a safe spawn", () => {
    const w = new World({ seed: 11 });
    // Stand right in rusher 0's facing line, 2 m away.
    w.player.x = -6.14;
    w.player.z = 14.76;
    const input = createInputSnapshot();
    let guard = 0;
    while (!w.playerDead && guard++ < 600) w.step(input);
    expect(w.playerDead).toBe(true);
    expect(w.deaths).toBe(1);
    expect(w.events.some((e) => e.kind === "playerDied")).toBe(true);
    // Respawn delay 3 s.
    guard = 0;
    while (w.playerDead && guard++ < 200) w.step(input);
    expect(w.player.hp).toBe(100);
    expect(w.events.some((e) => e.kind === "playerRespawned")).toBe(true);
  });

  it("player kills a bot with the AR", () => {
    const w = new World({ seed: 12, bots: false });
    // Single rusher, facing away (patrolling) — the player gets the drop.
    const bot = createBot("rusher", 8, 6, Math.PI, 0);
    bot.ammo = 32;
    bot.hp = 25; // pipeline test: dies on the first body hit, inside the bot's 0.4 s reaction window
    w.bots.push(bot);
    // Clear lane down z = 6 (clear of the center cross at z ∈ [−0.6, 0.6]).
    w.player.x = 0;
    w.player.z = 6;
    w.player.yaw = -Math.PI / 2; // face +X
    w.player.pitch = Math.atan2(0.8 - 1.62, 8); // chest-ish
    // Burst-fire like a player: full-auto spray climbs 0.5°/shot and would
    // walk off the target; 3-round bursts with pauses stay on it.
    const input = createInputSnapshot();
    let guard = 0;
    let burst = 0;
    while (bot.hp > 0 && guard++ < 600) {
      if (burst < 3) {
        press(input, "fire");
        burst++;
      } else {
        input.flags.delete("fire");
        if (w.weapon.sinceShot > 0.1) burst = 0; // recoil recovered, next burst
      }
      w.step(input);
    }
    expect(bot.hp).toBe(0);
    expect(w.kills).toBeGreaterThanOrEqual(1);
    expect(w.events.some((e) => e.kind === "botHit")).toBe(true);
  });
});

describe("world — weapon switching (Phase 2)", () => {
  it("switches slots, blocks fire during the swap, cancels reloads", () => {
    const w = new World({ seed: 13, bots: false });
    const input = createInputSnapshot();
    expect(w.activeSlot).toBe(0);
    press(input, "slot2");
    w.step(input);
    expect(w.activeSlot).toBe(1);
    expect(w.weapon.defId).toBe("hornet");
    expect(w.weapon.switchTimer).toBeGreaterThan(0);
    // Fire held during the swap window → no shots.
    press(input, "fire");
    for (let i = 0; i < 12; i++) w.step(input); // 0.2 s of 0.4 s swap
    expect(w.shotsFired).toBe(0);
    for (let i = 0; i < 60; i++) w.step(input); // swap long done; SMG cadence 4 ticks
    expect(w.shotsFired).toBeGreaterThanOrEqual(2);
  });

  it("switching cancels an in-progress reload", () => {
    const w = new World({ seed: 14, bots: false });
    w.weapon.ammo = 5;
    const input = createInputSnapshot();
    press(input, "reload");
    w.step(input);
    expect(w.weapon.reloadTimer).toBeGreaterThan(0);
    press(input, "slot3");
    w.step(input);
    expect(w.activeSlot).toBe(2);
    expect(w.weapons[0]!.reloadTimer).toBe(0);
    expect(w.weapons[0]!.ammo).toBe(5); // not refilled
  });
});

describe("phase 5 — locomotion events, impacts, per-weapon stats", () => {
  it("emits footstep events at a distance-based cadence while moving", () => {
    const w = new World({ seed: 3, bots: false });
    const input = createInputSnapshot();
    press(input, "forward");
    press(input, "sprint");
    let steps = 0;
    let sprintSteps = 0;
    for (let i = 0; i < 180; i++) {
      // 3 s of sprinting (≈19.5 m → ~9 steps at 2.1 m cadence)
      w.step(input);
      for (const e of w.events) {
        if (e.kind === "footstep") {
          steps++;
          if (e.sprint) sprintSteps++;
        }
      }
    }
    expect(steps).toBeGreaterThanOrEqual(4);
    expect(sprintSteps).toBe(steps); // sprint flag rides every step while sprinting
  });

  it("no footsteps while still or crouched", () => {
    const w = new World({ seed: 4, bots: false });
    const input = createInputSnapshot();
    for (let i = 0; i < 120; i++) w.step(input); // standing still
    press(input, "crouch");
    press(input, "forward");
    let steps = 0;
    for (let i = 0; i < 120; i++) {
      w.step(input);
      for (const e of w.events) if (e.kind === "footstep") steps++;
    }
    expect(steps).toBe(0); // crouch-walking is silent (cadence gate)
  });

  it("emits a landed event with severity after a fall, not after ground ticks", () => {
    const w = new World({ seed: 5, bots: false });
    const input = createInputSnapshot();
    press(input, "jump");
    w.step(input); // leaves ground
    release(input, "jump");
    let landed: number | null = null;
    for (let i = 0; i < 90 && landed === null; i++) {
      w.step(input);
      for (const e of w.events) if (e.kind === "landed") landed = e.severity;
    }
    expect(landed).not.toBeNull();
    expect(landed!).toBeGreaterThan(0);
    expect(landed!).toBeLessThanOrEqual(1);
    // No duplicate landing events on subsequent ticks.
    for (let i = 0; i < 30; i++) {
      w.step(input);
      for (const e of w.events) expect(e.kind).not.toBe("landed");
    }
  });

  it("hit events carry world-space impact coordinates", () => {
    const w = new World({ seed: 6, bots: false });
    approachDummy(w, 0);
    const d = w.dummies[0]!;
    const input = createInputSnapshot();
    // Face the dummy dead-on.
    const dx = d.x - w.player.x;
    const dz = d.z - w.player.z;
    w.player.yaw = Math.atan2(-dx, -dz);
    w.player.pitch = 0;
    press(input, "fire");
    w.step(input);
    const hit = w.events.find((e) => e.kind === "hit");
    expect(hit).toBeDefined();
    if (hit!.kind !== "hit") return;
    // Impact point must sit on the segment from the muzzle toward the dummy.
    const px = w.player.x;
    const pz = w.player.z;
    const dist = Math.hypot(hit!.ix - px, hit!.iz - pz);
    expect(dist).toBeGreaterThan(2); // well past the muzzle
    expect(dist).toBeLessThan(Math.hypot(dx, dz) + 1); // not beyond the target
  });

  it("tracks per-weapon shots fired/hit separately", () => {
    const w = new World({ seed: 7, bots: false });
    approachDummy(w, 0);
    const d = w.dummies[0]!;
    const input = createInputSnapshot();
    const aimAt = (): void => {
      w.player.yaw = Math.atan2(-(d.x - w.player.x), -(d.z - w.player.z));
      w.player.pitch = 0;
    };
    aimAt();
    press(input, "fire");
    for (let i = 0; i < 30; i++) w.step(input); // ~7 AR shots at slot 0
    release(input, "fire");
    press(input, "slot2");
    w.step(input);
    for (let i = 0; i < 24; i++) w.step(input); // burn the 0.4 s swap window
    aimAt();
    press(input, "fire");
    for (let i = 0; i < 30; i++) w.step(input); // ~7 SMG shots at slot 1
    release(input, "fire");
    // Slot separation: only slots 0 and 1 were used.
    expect(w.weaponShotsFired[0]).toBeGreaterThanOrEqual(5);
    expect(w.weaponShotsFired[1]).toBeGreaterThanOrEqual(5);
    expect(w.weaponShotsFired[2]! + w.weaponShotsFired[3]!).toBe(0);
    expect(w.weaponShotsHit[0]).toBeGreaterThanOrEqual(1);
    // The invariant the counters exist for: aggregates equal the slot sums.
    const sumFired = w.weaponShotsFired.reduce((a, b) => a + b, 0);
    const sumHit = w.weaponShotsHit.reduce((a, b) => a + b, 0);
    expect(sumFired).toBe(w.shotsFired);
    expect(sumHit).toBe(w.shotsHit);
  });

  it("bot shots carry the shooter's weapon defId for positional audio", () => {
    const w = new World({ seed: 8 }); // default roster: rusher + cover + sniper
    const input = createInputSnapshot();
    const ids = new Set<string>();
    for (let i = 0; i < 1200; i++) {
      w.step(input);
      for (const e of w.events) if (e.kind === "botShot") ids.add(e.shot.defId);
      if (ids.size >= 3) break;
    }
    // Every roster archetype must be audible with its own voice.
    expect(ids.has("hornet")).toBe(true); // rusher
    expect(ids.has("vector7")).toBe(true); // cover
    expect(ids.has("longview")).toBe(true); // sniper
  });
});

// Re-export guard: keep ActionFlag import used (trace helper may evolve).
export type { ActionFlag };
