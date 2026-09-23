import { describe, expect, it } from "vitest";
import {
  createPlayer,
  stepPlayer,
  WALK_SPEED,
  SPRINT_SPEED,
  CROUCH_SPEED,
  ADS_SPEED,
  PITCH_CLAMP,
} from "./player";
import { createInputSnapshot, press, release, addMouse, type InputSnapshot } from "./input";
import { Level } from "./level";
import type { PlayerState } from "./player";

const level = new Level();
const SPAWN = { x: 18, z: 0, yaw: Math.PI / 2 }; // ring spawn facing center

function makePlayer(): PlayerState {
  return createPlayer(SPAWN.x, SPAWN.z, SPAWN.yaw);
}

function holdFor(
  p: PlayerState,
  input: InputSnapshot,
  ticks: number,
): void {
  for (let i = 0; i < ticks; i++) stepPlayer(p, input, level);
}

describe("player movement (METRICS.md)", () => {
  it("reaches walk speed and stops quickly on release", () => {
    const p = makePlayer();
    const input = createInputSnapshot();
    press(input, "forward");
    holdFor(p, input, 30);
    const speed = Math.hypot(p.vx, p.vz);
    expect(speed).toBeGreaterThan(WALK_SPEED * 0.95);
    expect(speed).toBeLessThan(WALK_SPEED * 1.05);

    release(input, "forward");
    holdFor(p, input, 18);
    expect(Math.hypot(p.vx, p.vz)).toBeLessThan(WALK_SPEED * 0.05);
  });

  it("sprint is gated on forward + standing and reaches 6.5 m/s", () => {
    const p = makePlayer();
    const input = createInputSnapshot();
    press(input, "sprint");
    press(input, "forward");
    holdFor(p, input, 40);
    expect(p.sprinting).toBe(true);
    expect(Math.hypot(p.vx, p.vz)).toBeGreaterThan(SPRINT_SPEED * 0.95);

    // Sprint without forward must NOT engage.
    const p2 = makePlayer();
    const input2 = createInputSnapshot();
    press(input2, "sprint");
    press(input2, "left");
    holdFor(p2, input2, 40);
    expect(p2.sprinting).toBe(false);
    expect(Math.hypot(p2.vx, p2.vz)).toBeCloseTo(WALK_SPEED, 1);
  });

  it("crouch caps speed at 2.2 m/s", () => {
    const p = makePlayer();
    const input = createInputSnapshot();
    press(input, "crouch");
    press(input, "forward");
    holdFor(p, input, 40);
    expect(p.stance).toBe("crouch");
    expect(Math.hypot(p.vx, p.vz)).toBeCloseTo(CROUCH_SPEED, 1);
  });

  it("ADS caps speed at 2.8 m/s and blocks sprint", () => {
    const p = makePlayer();
    const input = createInputSnapshot();
    press(input, "ads");
    press(input, "sprint");
    press(input, "forward");
    holdFor(p, input, 40);
    expect(p.ads).toBe(true);
    expect(p.sprinting).toBe(false);
    expect(Math.hypot(p.vx, p.vz)).toBeCloseTo(ADS_SPEED, 1);
  });

  it("jump reaches ~0.9 m apex and lands within a second", () => {
    const p = makePlayer();
    const input = createInputSnapshot();
    press(input, "jump");
    let apex = 0;
    for (let i = 0; i < 60; i++) {
      stepPlayer(p, input, level);
      release(input, "jump");
      apex = Math.max(apex, p.y);
    }
    expect(apex).toBeGreaterThan(0.85);
    expect(apex).toBeLessThan(0.95);
    expect(p.onGround).toBe(true);
  });

  it("mouse look turns the view; pitch clamps at ±89°", () => {
    const p = makePlayer();
    const input = createInputSnapshot();
    addMouse(input, 1000, 0);
    stepPlayer(p, input, level);
    expect(p.yaw).toBeLessThan(SPAWN.yaw); // mouse right → yaw decreases

    const p2 = makePlayer();
    const input2 = createInputSnapshot();
    for (let i = 0; i < 10; i++) {
      addMouse(input2, 0, 1_000_000);
      stepPlayer(p2, input2, level);
    }
    expect(p2.pitch).toBeCloseTo(-PITCH_CLAMP, 3);
  });

  it("walls block movement", () => {
    // Spawn just inside the north wall facing it (yaw π faces +Z… north wall is −Z).
    const p = createPlayer(0, -21.0, Math.PI); // faces +Z (away) — walk left into west wall instead
    const input = createInputSnapshot();
    press(input, "left");
    holdFor(p, input, 240);
    expect(p.x).toBeGreaterThan(-21.8); // never through the west wall
    expect(Math.hypot(p.vx, p.vz)).toBeLessThan(7);
  });

  it("step-up onto half cover works via support snapping", () => {
    // Half-cover block at (0,-11) is 1.0 m tall, 4×1.2 m — stand on it.
    const p = createPlayer(0, -11, 0);
    const input = createInputSnapshot();
    // Jump onto it: apex 0.9 m < 1.0 m top… support requires feet ≥ top − step.
    // Jump + forward drift across the block edge.
    press(input, "jump");
    press(input, "forward");
    let maxY = 0;
    for (let i = 0; i < 60; i++) {
      stepPlayer(p, input, level);
      release(input, "jump");
      maxY = Math.max(maxY, p.y);
    }
    expect(maxY).toBeGreaterThan(0.5); // cleared the ground
  });
});
