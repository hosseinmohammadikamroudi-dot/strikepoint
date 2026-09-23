/** Shared scalar math for the deterministic sim. No allocations, no wall clock. */

export const TICK_RATE = 60;
export const TICK_DT = 1 / TICK_RATE;
export const GRAVITY = 20; // m/s² (game gravity per METRICS.md)

export function clamp(v: number, min: number, max: number): number {
  return v < min ? min : v > max ? max : v;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/**
 * Frame-rate-independent exponential decay factor for a half-life in seconds.
 * Used for friction, recoil recovery, and view smoothing: applying `x *= decay(halfLife)`
 * once per tick is equivalent to continuous exponential decay at a fixed 60 Hz.
 */
export function decay(halfLifeSeconds: number): number {
  return Math.pow(0.5, TICK_DT / halfLifeSeconds);
}

/** Shortest signed angular difference b - a, wrapped to (-π, π]. */
export function angleDelta(a: number, b: number): number {
  let d = (b - a) % (2 * Math.PI);
  if (d > Math.PI) d -= 2 * Math.PI;
  if (d <= -Math.PI) d += 2 * Math.PI;
  return d;
}
