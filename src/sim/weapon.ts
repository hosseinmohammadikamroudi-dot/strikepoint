/**
 * Def-driven hitscan weapon mechanics — one engine, parameterized by the
 * WeaponDefs in weapons.ts (METRICS.md v0.1). Deterministic: spread/recoil
 * draw from the World's Rng.
 *
 * Per-tick order (60 Hz):
 *  1. cooldown / bloom decay / sinceShot clock
 *  2. ADS progress (linear, per-def adsTime × attachment mult)
 *  3. recoil recovery — gated: only after 100 ms without firing, at the
 *     def's per-weapon rate (during a spray the kick outpaces recovery, so
 *     the view climbs; on release it returns)
 *  4. switch timer (weapon swap blocks fire/reload)
 *  5. reload progress (magazine: single timer; shotgun: one shell per
 *     interval, auto-continues until full, cancellable by firing)
 *  6. trigger (auto fires while held; semi/pump/bolt need a fresh press)
 *  7. fire: ammo, cooldown, bloom, recoil kick into player view, spread
 *     cone (hip bloom ↔ tight ADS base blended by adsAmount), one ray per
 *     pellet
 *
 * Damage application lives in world.ts (it owns the character lists).
 */
import { TICK_DT, lerp, clamp } from "./math";
import type { PlayerState } from "./player";
import type { InputSnapshot } from "./input";
import type { Level } from "./level";
import type { Rng } from "./rng";
import { WEAPON_DEFS, attachmentMods, type WeaponDef, type WeaponId } from "./weapons";

export const HEADSHOT_MULT = 1.6;
export const PITCH_LIMIT = 1.5533; // ±89°
const RECOVERY_GATE = 0.1; // s of no firing before recovery starts
export const SWITCH_TIME = 0.4; // s weapon-swap block

export interface WeaponState {
  readonly defId: WeaponId;
  readonly def: WeaponDef;
  /** Resolved attachment modifiers (static per instance). */
  readonly mods: ReturnType<typeof attachmentMods>;
  ammo: number;
  reloadTimer: number;
  cooldown: number;
  bloom: number; // current hipfire spread (rad)
  /** ADS progression 0..1 (drives spread blend + view FOV/pose). */
  adsAmount: number;
  /** Seconds since the last shot (gates recoil recovery). */
  sinceShot: number;
  /** Trigger edge tracking for semi/pump/bolt modes. */
  triggerHeld: boolean;
  /** > 0 while switching to this weapon (blocks fire/reload). */
  switchTimer: number;
}

export function createWeapon(id: WeaponId, attachmentIds?: readonly string[]): WeaponState {
  const def = WEAPON_DEFS[id];
  return {
    defId: id,
    def,
    mods: attachmentMods(id, attachmentIds),
    ammo: def.magSize,
    reloadTimer: 0,
    cooldown: 0,
    bloom: 0,
    adsAmount: 0,
    sinceShot: 999,
    triggerHeld: false,
    switchTimer: 0,
  };
}

export interface ShotEvent {
  /** Origin, world space (eye position). */
  ox: number;
  oy: number;
  oz: number;
  /** Unit direction including spread. */
  dx: number;
  dy: number;
  dz: number;
  /** Distance to level geometry along the ray (Infinity if none within max). */
  levelT: number;
  /** True for the first pellet of a trigger pull (shot counting in World). */
  first: boolean;
}

/**
 * Tick one weapon exactly once. Pushes one ShotEvent per pellet to `out`.
 */
export function stepWeapon(
  w: WeaponState,
  p: PlayerState,
  input: InputSnapshot,
  rng: Rng,
  level: Level,
  out: ShotEvent[],
): void {
  const def = w.def;
  w.cooldown = Math.max(0, w.cooldown - TICK_DT);
  w.bloom = Math.max(0, w.bloom * 0.9988);
  w.sinceShot += TICK_DT;
  if (w.switchTimer > 0) w.switchTimer = Math.max(0, w.switchTimer - TICK_DT);

  // --- ADS progression ---
  const adsTarget = p.ads ? 1 : 0;
  const adsRate = TICK_DT / Math.max(0.01, def.adsTime * w.mods.adsTimeMult);
  w.adsAmount = clamp(w.adsAmount + Math.sign(adsTarget - w.adsAmount) * Math.min(adsRate, Math.abs(adsTarget - w.adsAmount)), 0, 1);

  // --- Recoil recovery (per-def rate, gated on recent fire) ---
  if (w.sinceShot > RECOVERY_GATE && (p.recoilPitch !== 0 || p.recoilYaw !== 0)) {
    const step = def.recoilRecoveryRate * TICK_DT;
    const len = Math.hypot(p.recoilPitch, p.recoilYaw);
    const f = Math.min(1, step / len);
    const rp = p.recoilPitch * f;
    const ry = p.recoilYaw * f;
    p.recoilPitch -= rp;
    p.recoilYaw -= ry;
    p.recoilDebt = Math.max(0, p.recoilDebt - (Math.abs(rp) + Math.abs(ry)));
  }

  // --- Reload progress ---
  if (w.reloadTimer > 0) {
    w.reloadTimer -= TICK_DT;
    if (w.reloadTimer <= 0) {
      w.reloadTimer = 0;
      w.ammo += 1; // shell-reload model: one shell per completion…
      if (def.shellReloadTime === 0 || w.ammo >= def.magSize) {
        w.ammo = def.magSize; // …magazine reload fills the mag
      } else {
        w.reloadTimer = def.shellReloadTime; // auto-continue loading
      }
    }
    // Reload continues below trigger logic; firing may cancel a shell reload.
  }

  // --- Reload start (edge-triggered; blocked during match countdown) ---
  if (
    input.flags.has("reload") &&
    !p.frozen &&
    w.reloadTimer === 0 &&
    w.ammo < def.magSize &&
    w.switchTimer === 0
  ) {
    w.reloadTimer = def.shellReloadTime > 0 ? def.shellReloadTime : def.reloadTime;
    return;
  }

  // --- Trigger (match countdown freeze blocks fire) ---
  const firing = input.flags.has("fire") && !p.frozen;
  const freshPress = firing && !w.triggerHeld;
  w.triggerHeld = firing;
  if (!firing || w.switchTimer > 0) return;
  if (def.fireMode !== "auto" && !freshPress) return;
  if (w.cooldown > 0) return;

  // Firing cancels an in-progress shell reload (with something loaded);
  // a magazine reload runs to completion.
  if (w.reloadTimer > 0) {
    if (def.shellReloadTime === 0 || w.ammo === 0) return;
    w.reloadTimer = 0;
  }

  if (w.ammo <= 0) {
    w.reloadTimer = def.shellReloadTime > 0 ? def.shellReloadTime : def.reloadTime;
    return;
  }

  // --- Fire ---
  w.ammo -= 1;
  w.cooldown = 60 / def.rpm;
  w.sinceShot = 0;
  w.bloom = Math.min(def.hipBloomMax, w.bloom + Math.max(0, def.hipBloomPerShot + w.mods.bloomPerShotAdd));

  // Recoil kick straight into the player's view-recoil fields.
  const kickP = def.recoilKickPitch * w.mods.recoilPitchMult * (1 + 0.35 * rng.gauss());
  const kickY = def.recoilKickYaw * w.mods.recoilYawMult * rng.gauss();
  p.recoilPitch += kickP;
  p.recoilYaw += kickY;
  p.recoilDebt += Math.abs(kickP) + Math.abs(kickY);

  // Current aim angles (view + accumulated recoil).
  const yaw = p.yaw + p.recoilYaw;
  const pitch = clamp(p.pitch + p.recoilPitch, -PITCH_LIMIT, PITCH_LIMIT);

  // Spread: hip bloom blended to the tight ADS base by adsAmount.
  const adsBase = def.hipBloomPerShot * def.adsSpreadMult * w.mods.adsSpreadMult;
  const spread = Math.max(0, lerp(w.bloom, adsBase, w.adsAmount));

  const ox = p.x;
  const oy = p.y + 1.62; // eye height (METRICS.md)
  const oz = p.z;

  for (let i = 0; i < def.pellets; i++) {
    const yawS = yaw + spread * rng.gauss();
    const pitchS = clamp(pitch + spread * rng.gauss(), -PITCH_LIMIT, PITCH_LIMIT);
    const cp = Math.cos(pitchS);
    const dx = -Math.sin(yawS) * cp;
    const dy = Math.sin(pitchS);
    const dz = -Math.cos(yawS) * cp;
    const levelT = level.rayCast(ox, oy, oz, dx, dy, dz, 300);
    out.push({ ox, oy, oz, dx, dy, dz, levelT, first: i === 0 });
  }
}

/**
 * Damage after distance falloff, def-driven. Head values are absolute —
 * the defs already carry the ×1.6 headshot multiplier (METRICS.md).
 */
export function damageAt(def: WeaponDef, distance: number, headshot: boolean): number {
  const base = headshot ? def.headDamage : def.bodyDamage;
  if (distance >= def.falloffStart) {
    const t = Math.min(1, (distance - def.falloffStart) / 20);
    return base * (def.falloffFloor + (1 - def.falloffFloor) * (1 - t));
  }
  return base;
}
