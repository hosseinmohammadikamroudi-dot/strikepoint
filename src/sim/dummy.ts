/**
 * Target dummy — the Phase 1 combat target. Plain data + step/raycast
 * functions, like the rest of the sim. Dummies stand on the ground plane,
 * take hitscan damage, die, and auto-respawn after a fixed delay
 * (METRICS.md Phase 1 additions).
 *
 * Hit zones are a vertical two-band model against the cylinder:
 *   head:  top 0.30 m of the 1.8 m body (≥ 1.50 m above feet)
 *   body:  everything below
 * Limb multiplier (×0.9) arrives with the animated mesh in Phase 2.
 */
import { rayCastCylinder, type CylinderHit } from "./geometry";

export const DUMMY_HP = 100;
export const DUMMY_RADIUS = 0.35;
export const DUMMY_HEIGHT = 1.8;
export const HEAD_BAND = 0.3; // m at the top of the body
export const RESPAWN_DELAY = 3; // s (METRICS.md Phase 1 additions)

export type DummyStatus = "alive" | "dead";

export interface Dummy {
  id: number;
  x: number;
  z: number;
  hp: number;
  status: DummyStatus;
  respawnTimer: number;
  /** Facing yaw (stationary visual; used for future flinch/hit reactions). */
  yaw: number;
  /** Ticks since last damage — drives hit-flash timing in the view layer. */
  hitFlashTicks: number;
}

export function createDummy(id: number, x: number, z: number): Dummy {
  return { id, x, z, hp: DUMMY_HP, status: "alive", respawnTimer: 0, yaw: 0, hitFlashTicks: 0 };
}

/** Classify a hit point (at distance t along the ray, eye at oy) as head or body. */
export function hitZone(t: number, oy: number, dy: number): "head" | "body" {
  const hitY = oy + dy * t;
  return hitY >= DUMMY_HEIGHT - HEAD_BAND ? "head" : "body";
}

/** Apply damage. Returns true if this hit was lethal. */
export function applyDamage(d: Dummy, amount: number): boolean {
  if (d.status !== "alive") return false;
  d.hp -= amount;
  d.hitFlashTicks = 6; // ~100 ms flash
  if (d.hp <= 0) {
    d.hp = 0;
    d.status = "dead";
    d.respawnTimer = RESPAWN_DELAY;
    return true;
  }
  return false;
}

/** Advance one 60 Hz tick. */
export function stepDummy(d: Dummy): void {
  if (d.hitFlashTicks > 0) d.hitFlashTicks -= 1;
  if (d.status === "dead") {
    d.respawnTimer -= 1 / 60;
    if (d.respawnTimer <= 0) {
      d.hp = DUMMY_HP;
      d.status = "alive";
      d.respawnTimer = 0;
    }
  }
}

export interface DummyHit {
  t: number;
  zone: "head" | "body";
}

/**
 * Ray vs. standing dummy (finite vertical cylinder, feet on ground plane).
 * Delegates to the shared geometry module. Pure and deterministic.
 */
export function rayCastDummy(
  d: Dummy,
  ox: number,
  oy: number,
  oz: number,
  dx: number,
  dy: number,
  dz: number,
  maxT: number,
): DummyHit | null {
  if (d.status !== "alive") return null;
  const hit: CylinderHit | null = rayCastCylinder(
    ox, oy, oz, dx, dy, dz,
    d.x, d.z, DUMMY_RADIUS, 0, DUMMY_HEIGHT, HEAD_BAND, maxT,
  );
  return hit;
}
