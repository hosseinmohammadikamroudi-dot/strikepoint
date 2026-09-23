/**
 * Level — collision/query engine over a data-driven MapDef (maps.ts).
 * The level is a set of static AABBs on an infinite ground plane at y = 0 —
 * deliberately engine-agnostic: the Three.js view builds meshes from the same
 * box list the sim collides against, so there is one source of truth.
 *
 * Phase 3: the Level no longer hardcodes a layout — it consumes any MapDef
 * (3-lane arena, dense interior, sniper yard) and generates the shared
 * 8-spawn / 8-waypoint / 6-dummy structure from the def's radii. Adding a
 * map is adding data, not code.
 */

import { MAP_DEFS, type MapDef, type MapId } from "./maps";

export interface Box {
  minX: number;
  minY: number;
  minZ: number;
  maxX: number;
  maxY: number;
  maxZ: number;
}

export interface SpawnPoint {
  x: number;
  z: number;
  /** Facing yaw in radians, toward map center. */
  yaw: number;
}

export const PLAYER_RADIUS = 0.35;
export const PLAYER_HEIGHT = 1.8;
export const EYE_HEIGHT = 1.62;
/** Ledge step the player can walk over without jumping. */
export const STEP_HEIGHT = 0.3;

export class Level {
  readonly def: MapDef;
  readonly boxes: Box[] = [];
  readonly spawns: SpawnPoint[] = [];
  /** Dummy pedestal spots (x, z) — dummies are placed by World. */
  readonly dummySpots: { x: number; z: number }[] = [];
  /** Bot patrol waypoints (Phase 2). */
  readonly patrolPoints: { x: number; z: number }[] = [];

  constructor(mapId: MapId = "ringhold") {
    const def = MAP_DEFS[mapId];
    this.def = def;
    const T = 0.6; // wall thickness

    const box = (cx: number, cz: number, w: number, h: number, d: number, y0 = 0): void => {
      this.boxes.push({
        minX: cx - w / 2,
        maxX: cx + w / 2,
        minY: y0,
        maxY: y0 + h,
        minZ: cz - d / 2,
        maxZ: cz + d / 2,
      });
    };

    const RING = def.ring;
    // Outer walls.
    box(0, -RING, 2 * RING + T, def.wallHeight, T);
    box(0, RING, 2 * RING + T, def.wallHeight, T);
    box(-RING, 0, T, def.wallHeight, 2 * RING + T);
    box(RING, 0, T, def.wallHeight, 2 * RING + T);

    // Interior geometry from the def.
    for (const [cx, cz, w, h, d] of def.boxes) box(cx, cz, w, h, d);

    // Eight spawn points around the ring, facing center.
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2 + Math.PI / 8;
      this.spawns.push({ x: Math.cos(a) * def.spawnRadius, z: Math.sin(a) * def.spawnRadius, yaw: a + Math.PI });
    }

    // Eight patrol waypoints: alternating radii so bots weave between the
    // center structure and the covers.
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2 + Math.PI / 4;
      const r = i % 2 === 0 ? def.patrolRadii[0] : def.patrolRadii[1];
      this.patrolPoints.push({ x: Math.cos(a) * r, z: Math.sin(a) * r });
    }

    // Six dummy spots (firing-range tests / practice targets) alternating
    // between the two def radii.
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2 + Math.PI / 3;
      const r = i % 2 === 0 ? def.dummyRadii[0] : def.dummyRadii[1];
      this.dummySpots.push({ x: Math.cos(a) * r, z: Math.sin(a) * r });
    }
  }

  /**
   * Highest walkable surface at (x, z) at or below `feetY + STEP_HEIGHT`:
   * the ground plane (0) or the top of a box whose footprint (expanded by the
   * player radius) contains (x, z). Enables step-up onto low ledges.
   */
  supportHeight(x: number, z: number, feetY: number, r: number): number {
    let support = 0;
    const limit = feetY + STEP_HEIGHT;
    for (let i = 0; i < this.boxes.length; i++) {
      const b = this.boxes[i]!;
      if (b.maxY > limit) continue;
      if (
        x >= b.minX - r &&
        x <= b.maxX + r &&
        z >= b.minZ - r &&
        z <= b.maxZ + r &&
        b.maxY > support
      ) {
        support = b.maxY;
      }
    }
    return support;
  }

  /**
   * Resolve a circle (player) against all boxes that overlap its vertical
   * span, pushing it out along the minimal axis. Mutates and returns nothing.
   */
  collideCircle(px: number, pz: number, feetY: number, r: number): { x: number; z: number } {
    const headY = feetY + PLAYER_HEIGHT;
    for (let i = 0; i < this.boxes.length; i++) {
      const b = this.boxes[i]!;
      // Ignore boxes entirely below step height relative to feet (walkable ledge)
      // or entirely above the head.
      if (b.maxY <= feetY + STEP_HEIGHT || b.minY >= headY) continue;

      const closestX = Math.max(b.minX, Math.min(px, b.maxX));
      const closestZ = Math.max(b.minZ, Math.min(pz, b.maxZ));
      const dx = px - closestX;
      const dz = pz - closestZ;
      const d2 = dx * dx + dz * dz;

      if (d2 > r * r) continue;

      if (d2 > 1e-9) {
        // Push out along the circle-to-box normal.
        const d = Math.sqrt(d2);
        const push = r - d;
        px += (dx / d) * push;
        pz += (dz / d) * push;
      } else {
        // Center inside the box footprint: push along the shallowest axis.
        const left = px - b.minX;
        const right = b.maxX - px;
        const near = pz - b.minZ;
        const far = b.maxZ - pz;
        const m = Math.min(left, right, near, far);
        if (m === left) px = b.minX - r;
        else if (m === right) px = b.maxX + r;
        else if (m === near) pz = b.minZ - r;
        else pz = b.maxZ + r;
      }
    }
    return { x: px, z: pz };
  }

  /**
   * Nearest hit distance of a ray against the level (boxes only; ground is
   * handled by callers). Returns Infinity when nothing is hit within maxT.
   * Standard slab test, allocation-free.
   */
  rayCast(
    ox: number,
    oy: number,
    oz: number,
    dx: number,
    dy: number,
    dz: number,
    maxT: number,
  ): number {
    let best = maxT;
    for (let i = 0; i < this.boxes.length; i++) {
      const b = this.boxes[i]!;
      let tmin = 0;
      let tmax = best;

      // X slab
      if (Math.abs(dx) < 1e-9) {
        if (ox < b.minX || ox > b.maxX) continue;
      } else {
        let t1 = (b.minX - ox) / dx;
        let t2 = (b.maxX - ox) / dx;
        if (t1 > t2) [t1, t2] = [t2, t1];
        tmin = Math.max(tmin, t1);
        tmax = Math.min(tmax, t2);
        if (tmin > tmax) continue;
      }
      // Y slab
      if (Math.abs(dy) < 1e-9) {
        if (oy < b.minY || oy > b.maxY) continue;
      } else {
        let t1 = (b.minY - oy) / dy;
        let t2 = (b.maxY - oy) / dy;
        if (t1 > t2) [t1, t2] = [t2, t1];
        tmin = Math.max(tmin, t1);
        tmax = Math.min(tmax, t2);
        if (tmin > tmax) continue;
      }
      // Z slab
      if (Math.abs(dz) < 1e-9) {
        if (oz < b.minZ || oz > b.maxZ) continue;
      } else {
        let t1 = (b.minZ - oz) / dz;
        let t2 = (b.maxZ - oz) / dz;
        if (t1 > t2) [t1, t2] = [t2, t1];
        tmin = Math.max(tmin, t1);
        tmax = Math.min(tmax, t2);
        if (tmin > tmax) continue;
      }

      if (tmin < best && tmin > 1e-6) best = tmin;
    }
    return best;
  }
}
