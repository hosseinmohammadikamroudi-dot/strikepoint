/**
 * Deterministic player controller. State is plain data; `stepPlayer` mutates
 * it by exactly one 60 Hz tick. All tuning constants cite METRICS.md.
 *
 * Movement model: look → stance/sprint → friction → projected acceleration
 * (Quake-style, capped at the stance cap) → gravity/jump → integrate →
 * horizontal capsule push-out → vertical resolve vs ground/box tops.
 * Recoil is applied directly to view angles by the weapon as a kick; a
 * rate-limited recovery returns part of it and the player compensates the rest.
 */
import { clamp, decay, GRAVITY, TICK_DT } from "./math";
import { PLAYER_RADIUS, type Level } from "./level";
import { takeMouse, type InputSnapshot } from "./input";

// METRICS.md: Player movement
export const WALK_SPEED = 4.5;
export const SPRINT_SPEED = 6.5;
export const CROUCH_SPEED = 2.2;
export const ADS_SPEED = 2.8;
export const JUMP_VELOCITY = 6.0; // 0.9 m apex at g = 20
export const AIR_CONTROL = 0.35;
/**
 * Ground acceleration. METRICS.md contract says 40 m/s², but 40 cannot sustain
 * the speed caps under 10/s friction (per-tick balance needs ≥ 45 for walk).
 * 60 gives instant-feeling convergence to the exact cap; METRICS Phase 1
 * additions notes the deviation for review.
 */
export const GROUND_ACCEL = 60;
export const FRICTION_HALF_LIFE = Math.LN2 / 10; // "10 /s exponential"
export const LOOK_SENS = 0.0022; // rad per mouse count
export const PITCH_CLAMP = 1.5533; // ±89°

// METRICS.md: Health & TTK
export const MAX_HP = 100;
export const REGEN_DELAY = 4.5; // s after last damage
export const REGEN_RATE = 40; // hp/s

export type Stance = "stand" | "crouch";

export interface PlayerState {
  x: number;
  y: number; // feet height
  z: number;
  vx: number;
  vy: number;
  vz: number;
  yaw: number;
  pitch: number;
  onGround: boolean;
  stance: Stance;
  sprinting: boolean;
  ads: boolean;
  /** Upward recoil kick not yet recovered (radians, positive = kicks up). */
  recoilPitch: number;
  /** Sideways recoil kick not yet recovered (radians, positive = kicks right). */
  recoilYaw: number;
  /** Recoil debt: amount the player still owns from compensation (radians). */
  recoilDebt: number;
  /** Current health (0 = dead; World handles respawn). */
  hp: number;
  /** Set for one tick when an airborne fall ends (view camera dip). */
  landed: boolean;
  /** Impact speed of the landing captured into `landVy` (negative down). */
  landVy: number;
  /** Vertical velocity tracker while airborne (for landing severity). */
  fallVy: number;
  /** Distance accumulator for the footstep cadence. */
  strideAccum: number;
  /** Set for one tick when a footstep fires (World → `footstep` event). */
  footstep: boolean;
  /** Seconds since last damage taken — gates regen. */
  sinceDamage: number;
  /**
   * Match countdown freeze (Phase 3): look freely, no move/fire/reload/jump.
   * Set by the World while the match is in its countdown phase.
   */
  frozen: boolean;
}

export function createPlayer(x: number, z: number, yaw: number): PlayerState {
  return {
    x,
    y: 0,
    z,
    vx: 0,
    vy: 0,
    vz: 0,
    yaw,
    pitch: 0,
    onGround: true,
    stance: "stand",
    sprinting: false,
    ads: false,
    recoilPitch: 0,
    recoilYaw: 0,
    recoilDebt: 0,
    hp: MAX_HP,
    sinceDamage: 999,
    frozen: false,
    landed: false,
    landVy: 0,
    fallVy: 0,
    strideAccum: 0,
    footstep: false,
  };
}

/** Current horizontal movement cap given stance/ADS state. */
export function speedCap(p: PlayerState): number {
  if (p.ads) return ADS_SPEED;
  if (p.stance === "crouch") return CROUCH_SPEED;
  if (p.sprinting && p.onGround) return SPRINT_SPEED;
  return WALK_SPEED;
}

/** Apply damage; resets the regen clock. Returns true if this hit was lethal. */
export function applyPlayerDamage(p: PlayerState, amount: number): boolean {
  if (p.hp <= 0) return false;
  p.hp -= amount;
  p.sinceDamage = 0;
  if (p.hp <= 0) {
    p.hp = 0;
    return true;
  }
  return false;
}

/** Full respawn: position, velocity, health, recoil. */
export function respawnPlayer(p: PlayerState, x: number, z: number, yaw: number): void {
  p.x = x;
  p.y = 0;
  p.z = z;
  p.vx = 0;
  p.vy = 0;
  p.vz = 0;
  p.yaw = yaw;
  p.pitch = 0;
  p.hp = MAX_HP;
  p.sinceDamage = 999;
  p.onGround = true;
  p.stance = "stand";
  p.frozen = false;
  p.recoilPitch = 0;
  p.recoilYaw = 0;
  p.recoilDebt = 0;
}

/** User look configuration (Phase 4 settings); defaults = METRICS baseline. */
export interface LookConfig {
  /** Multiplier on LOOK_SENS (settings sensitivity, 0.2–3). */
  sensMult: number;
  /** Invert vertical look. */
  invertY: boolean;
}

/**
 * Advance the player exactly one 60 Hz tick. `moveMult` scales the movement
 * caps (current weapon × attachments — passed in by World); `look` carries
 * the user's sensitivity/invert settings.
 */
export function stepPlayer(
  p: PlayerState,
  input: InputSnapshot,
  level: Level,
  moveMult = 1,
  look?: LookConfig,
): void {
  // --- Health regen (METRICS.md: 4.5 s delay, 40 hp/s) ---
  p.sinceDamage += TICK_DT;
  if (p.sinceDamage >= REGEN_DELAY && p.hp > 0 && p.hp < MAX_HP) {
    p.hp = Math.min(MAX_HP, p.hp + REGEN_RATE * TICK_DT);
  }

  // --- Look (user sensitivity × invert, Phase 4 settings) ---
  const { dx, dy } = takeMouse(input);
  const sens = LOOK_SENS * (look?.sensMult ?? 1);
  const invert = look?.invertY === true ? -1 : 1;
  p.yaw -= dx * sens;
  p.pitch = clamp(p.pitch - dy * sens * invert, -PITCH_CLAMP, PITCH_CLAMP);

  // Recoil recovery lives in weapon.ts (per-def rate, gated on recent fire);
  // the player owns compensation, not recovery.

  // --- Match countdown freeze (Phase 3): look, nothing else ---
  if (p.frozen) {
    p.vx = 0;
    p.vz = 0;
    p.vy = 0;
    p.onGround = true;
    return;
  }

  // --- Stance (hold-to-crouch) ---
  const wantCrouch = input.flags.has("crouch");
  if (wantCrouch && p.stance === "stand") p.stance = "crouch";
  else if (!wantCrouch && p.stance === "crouch") p.stance = "stand";

  // --- Sprint / ADS gating (resolved in one pass: ADS overrides sprint) ---
  const wantAds = input.flags.has("ads");
  p.sprinting =
    input.flags.has("sprint") && input.flags.has("forward") && p.stance === "stand" && !wantAds;
  p.ads = wantAds && !p.sprinting;

  // --- Friction (ground only) ---
  if (p.onGround) {
    const f = decay(FRICTION_HALF_LIFE);
    p.vx *= f;
    p.vz *= f;
  }

  // --- Acceleration (projected, capped) ---
  const fwd = (input.flags.has("forward") ? 1 : 0) - (input.flags.has("back") ? 1 : 0);
  const side = (input.flags.has("right") ? 1 : 0) - (input.flags.has("left") ? 1 : 0);
  if (fwd !== 0 || side !== 0) {
    const sin = Math.sin(p.yaw);
    const cos = Math.cos(p.yaw);
    // yaw 0 faces −Z (Three.js camera convention).
    const wishX = -sin * fwd + cos * side;
    const wishZ = -cos * fwd - sin * side;
    const cap = speedCap(p) * moveMult;
    const wl = Math.hypot(wishX, wishZ);
    const nx = wishX / wl;
    const nz = wishZ / wl;
    // Quake-style: never accelerate the component of velocity already
    // exceeding the cap along the wish direction.
    const add = Math.min(
      (p.onGround ? GROUND_ACCEL : GROUND_ACCEL * AIR_CONTROL) * TICK_DT,
      Math.max(0, cap - (p.vx * nx + p.vz * nz)),
    );
    p.vx += nx * add;
    p.vz += nz * add;
  }

  // --- Jump / gravity ---
  if (input.flags.has("jump") && p.onGround) {
    p.vy = JUMP_VELOCITY;
    p.onGround = false;
  }
  p.vy -= GRAVITY * TICK_DT;

  // --- Integrate + collide ---
  p.x += p.vx * TICK_DT;
  p.z += p.vz * TICK_DT;
  const resolved = level.collideCircle(p.x, p.z, p.y, PLAYER_RADIUS);
  p.x = resolved.x;
  p.z = resolved.z;
  p.y += p.vy * TICK_DT;

  // --- Vertical resolve: support = ground plane or box top within step range ---
  const support = level.supportHeight(p.x, p.z, p.y, PLAYER_RADIUS);
  if (p.y <= support + 1e-4 && p.vy <= 0) {
    // Landing: this tick ends an airborne fall. fallVy snapshots the last
    // airborne velocity so the view can scale the camera dip; World converts
    // the flag to a `landed` event and clears it (one-tick window).
    p.landed = !p.onGround && p.fallVy < -3;
    if (p.landed) {
      p.landVy = p.fallVy;
      p.fallVy = 0;
    }
    p.y = support;
    p.vy = 0;
    p.onGround = true;
  } else {
    p.fallVy = p.vy;
    p.onGround = false;
  }

  // --- Footstep stride (Phase 5 audio): distance-based cadence, ~2.1 m ---
  if (p.onGround && p.stance !== "crouch") {
    const speed = Math.hypot(p.vx, p.vz);
    if (speed > 0.5) {
      p.strideAccum += speed * TICK_DT;
      if (p.strideAccum >= 2.1) {
        p.strideAccum = 0;
        p.footstep = true; // World consumes → `footstep` event, clears flag
      }
    }
  } else {
    p.strideAccum = 0;
  }
}
