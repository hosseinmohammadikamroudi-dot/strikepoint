/**
 * Shared combat geometry — raycasts against the vertical two-band cylinder
 * used by every character capsule (dummies, bots, player). Extracted from
 * dummy.ts in Phase 2 so bot-vs-player combat reuses the exact same hit
 * model as player-vs-dummy. Pure, allocation-free, deterministic.
 */

export interface CylinderHit {
  t: number;
  zone: "head" | "body";
}

/**
 * Ray vs. standing vertical cylinder at (cx, cz), feet at y0, top at y1.
 * The top `headBand` meters are the head zone; everything below is body.
 * Returns the nearest entry hit within maxT, or null.
 */
export function rayCastCylinder(
  ox: number,
  oy: number,
  oz: number,
  dx: number,
  dy: number,
  dz: number,
  cx: number,
  cz: number,
  radius: number,
  y0: number,
  y1: number,
  headBand: number,
  maxT: number,
): CylinderHit | null {
  // Solve ray-vs-circle in the XZ plane: |o.xz + t·d.xz − c.xz|² = r².
  const ex = ox - cx;
  const ez = oz - cz;
  const a = dx * dx + dz * dz;
  if (a < 1e-12) return null; // vertical ray: miss
  const b = 2 * (ex * dx + ez * dz);
  const c = ex * ex + ez * ez - radius * radius;

  const disc = b * b - 4 * a * c;
  if (disc < 0) return null;
  const sq = Math.sqrt(disc);

  const t1 = (-b - sq) / (2 * a);
  const t2 = (-b + sq) / (2 * a);
  const headStart = y1 - headBand;

  for (let i = 0; i < 2; i++) {
    const t = i === 0 ? t1 : t2;
    if (t < 1e-4 || t > maxT) continue;
    const y = oy + dy * t;
    if (y >= y0 && y <= y1) {
      return { t, zone: y >= headStart ? "head" : "body" };
    }
  }
  return null;
}
