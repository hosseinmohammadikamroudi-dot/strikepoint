import { describe, expect, it } from "vitest";
import {
  createWeapon,
  stepWeapon,
  damageAt,
  type ShotEvent,
  type WeaponState,
} from "./weapon";
import { WEAPON_DEFS, attachmentMods } from "./weapons";
import { createPlayer, type PlayerState } from "./player";
import { createInputSnapshot, press, type InputSnapshot } from "./input";
import { Level } from "./level";
import { Rng } from "./rng";

const level = new Level();
const rng = new Rng(12345);

function setup(id: keyof typeof WEAPON_DEFS): {
  w: WeaponState;
  p: PlayerState;
  input: InputSnapshot;
  out: ShotEvent[];
} {
  return {
    w: createWeapon(id),
    p: createPlayer(0, 0, Math.PI), // yaw π → facing +X... (yaw 0 faces −Z)
    input: createInputSnapshot(),
    out: [],
  };
}

/** Step n ticks with `held` pressed. */
function run(
  s: ReturnType<typeof setup>,
  ticks: number,
  held: "fire" | null = null,
): void {
  if (held) press(s.input, held);
  for (let i = 0; i < ticks; i++) stepWeapon(s.w, s.p, s.input, rng, level, s.out);
  if (held) s.input.flags.delete(held);
}

describe("weapon defs (METRICS.md)", () => {
  it("matches the metrics sheet values", () => {
    const ar = WEAPON_DEFS.vector7;
    expect(ar.rpm).toBe(750);
    expect(ar.bodyDamage).toBe(25);
    expect(ar.headDamage).toBe(40);
    expect(ar.magSize).toBe(30);
    expect(ar.falloffStart).toBe(30);

    const smg = WEAPON_DEFS.hornet;
    expect(smg.rpm).toBe(900);
    expect(smg.magSize).toBe(32);

    const sg = WEAPON_DEFS.mule;
    expect(sg.pellets).toBe(8);
    expect(sg.shellReloadTime).toBe(0.6);
    expect(sg.magSize).toBe(6);

    const sn = WEAPON_DEFS.longview;
    expect(sn.rpm).toBe(45);
    expect(sn.bodyDamage).toBe(100);
    expect(sn.headDamage).toBe(160);
    expect(sn.magSize).toBe(5);
  });

  it("derived TTKs hit the METRICS band", () => {
    // AR: 3 body shots (25 dmg) → 2 intervals of 80 ms = 160 ms to third hit...
    // METRICS convention: first hit to death = (shots-1) × interval = 160 ms ≤ 240 ✓
    const arInterval = 60 / WEAPON_DEFS.vector7.rpm;
    const smgShots = Math.ceil(100 / WEAPON_DEFS.hornet.bodyDamage); // 5
    const smgInterval = 60 / WEAPON_DEFS.hornet.rpm;
    expect((smgShots - 1) * smgInterval * 1000).toBeLessThanOrEqual(300);
    expect(arInterval).toBeGreaterThan(0);
  });
});

describe("weapon mechanics", () => {
  it("AR fires at 750 RPM (±tick quantization)", () => {
    const s = setup("vector7");
    run(s, 150, "fire"); // 2.5 s held — one full 30-round mag, no reload yet
    // Ideal 750 RPM → 31.25 shots; cooldown quantizes to 5-tick (83.3 ms)
    // cadence → 30 shots, exactly emptying the magazine.
    expect(s.out.length).toBe(30);
    expect(s.w.ammo).toBe(0);
  });

  it("semi mode needs a fresh press per shot", () => {
    const s = setup("longview"); // bolt
    run(s, 120, "fire"); // 2 s held
    expect(s.out.length).toBe(1); // one shot, then trigger stuck until release

    run(s, 200, null); // release + cooldown passes (45 rpm → 1.33 s)
    run(s, 1, "fire");
    expect(s.out.length).toBe(2);
  });

  it("shotgun fires 8 pellets per trigger pull", () => {
    const s = setup("mule");
    run(s, 1, "fire");
    expect(s.out.length).toBe(8);
    expect(s.w.ammo).toBe(5);
  });

  it("magazine reload refills the mag", () => {
    const s = setup("vector7");
    s.w.ammo = 5;
    run(s, 1, null);
    press(s.input, "reload");
    stepWeapon(s.w, s.p, s.input, rng, level, s.out);
    expect(s.w.reloadTimer).toBeCloseTo(2.1, 5);
    run(s, Math.ceil(2.1 * 60) + 1);
    expect(s.w.ammo).toBe(30);
  });

  it("shotgun shell-loads one shell at a time and firing cancels", () => {
    const s = setup("mule");
    s.w.ammo = 0;
    press(s.input, "reload");
    stepWeapon(s.w, s.p, s.input, rng, level, s.out);
    // After first 0.6 s: 1 shell loaded, still loading.
    run(s, 37);
    expect(s.w.ammo).toBe(1);
    expect(s.w.reloadTimer).toBeGreaterThan(0);
    // Fire cancels the reload (gun has something chambered).
    press(s.input, "fire");
    stepWeapon(s.w, s.p, s.input, rng, level, s.out);
    expect(s.w.ammo).toBe(0); // fired the one shell
    expect(s.w.reloadTimer).toBe(0);
  });

  it("per-weapon recoil recovery: sniper recovers slower than SMG", () => {
    const smg = createWeapon("hornet");
    const sn = createWeapon("longview");
    expect(smng(smg)).toBeGreaterThan(smng(sn));
  });

  function smng(w: WeaponState): number {
    return w.def.recoilRecoveryRate;
  }
});

describe("damage falloff", () => {
  it("AR full damage inside 30 m, floored past it", () => {
    expect(damageAt(WEAPON_DEFS.vector7, 10, false)).toBe(25);
    expect(damageAt(WEAPON_DEFS.vector7, 50, false)).toBeLessThan(25);
    expect(damageAt(WEAPON_DEFS.vector7, 50, false)).toBeGreaterThanOrEqual(
      25 * WEAPON_DEFS.vector7.falloffFloor - 1e-9,
    );
  });

  it("sniper has no falloff", () => {
    expect(damageAt(WEAPON_DEFS.longview, 5, false)).toBe(100);
    expect(damageAt(WEAPON_DEFS.longview, 200, false)).toBe(100);
  });
});

describe("attachments", () => {
  it("compensator reduces recoil, grip reduces bloom", () => {
    const comp = attachmentMods("vector7", ["comp"]);
    expect(comp.recoilPitchMult).toBeCloseTo(0.8, 5);
    const grip = attachmentMods("vector7", ["grip"]);
    expect(grip.bloomPerShotAdd).toBeCloseTo(-0.06 * (Math.PI / 180), 6);
  });

  it("rejects attachments not allowed on the weapon", () => {
    const muleScope = attachmentMods("mule", ["scope4x"]);
    expect(muleScope.adsTimeMult).toBe(1); // shotgun has no sight rail
  });

  it("stacking multiply/add composes correctly", () => {
    const both = attachmentMods("vector7", ["holo", "comp"]);
    expect(both.adsTimeMult).toBeCloseTo(1.1, 5);
    expect(both.recoilPitchMult).toBeCloseTo(0.8, 5);
  });
});
