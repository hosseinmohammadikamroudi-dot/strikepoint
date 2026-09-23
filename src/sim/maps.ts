/**
 * Map definitions — data-driven layouts (ROADMAP Phase 3: three greybox
 * maps). `Level` is the query/collision engine over any MapDef; adding a
 * map is adding data here, not code.
 *
 * Box tuples are [cx, cz, width, height, depth] with y0 = 0 (greybox).
 * Spawn/patrol/dummy rings are generated from per-map radii so every map
 * shares the same 8-spawn / 8-waypoint / 6-dummy structure (METRICS.md).
 */

export type MapId = "ringhold" | "foundry" | "longyard";

export interface MapDef {
  id: MapId;
  name: string;
  /** Outer wall ring half-extent (m). */
  ring: number;
  wallHeight: number;
  /** Interior geometry: [cx, cz, w, h, d]. */
  boxes: readonly (readonly [number, number, number, number, number])[];
  /** Spawn ring radius (8 spawns, facing center). */
  spawnRadius: number;
  /** Patrol waypoint radii, alternating (8 points). */
  patrolRadii: [number, number];
  /** Legacy dummy-spot radii, alternating (6 points; firing-range tests only). */
  dummyRadii: [number, number];
}

const HALF_COVER = 1.0; // METRICS.md: half cover height
const FULL = 3; // full cover / wall height

/** Phase 1/2 layout, unchanged — the baseline arena. */
const RINGHOLD: MapDef = {
  id: "ringhold",
  name: "Ringhold",
  ring: 22,
  wallHeight: FULL,
  spawnRadius: 18,
  patrolRadii: [8, 14],
  dummyRadii: [12, 16],
  boxes: [
    // Center cross: hard cover, splits the map into quadrants.
    [0, 0, 6, FULL, 1.2],
    [0, 0, 1.2, FULL, 6],
    // Four corner buildings (enterable from one side each).
    [-13, -13, 8, FULL, 1.0],
    [-13, -9, 1.0, FULL, 8],
    [-9.5, -13, 1.0, FULL, 6],
    [13, 13, 8, FULL, 1.0],
    [13, 9, 1.0, FULL, 8],
    [9.5, 13, 1.0, FULL, 6],
    [13, -13, 8, FULL, 1.0],
    [13, -9, 1.0, FULL, 8],
    [9.5, -13, 1.0, FULL, 6],
    [-13, 13, 8, FULL, 1.0],
    [-13, 9, 1.0, FULL, 8],
    [-9.5, 13, 1.0, FULL, 6],
    // Half-cover blocks on the lanes.
    [-6, -14, 3, HALF_COVER, 1.2],
    [6, 14, 3, HALF_COVER, 1.2],
    [-14, 6, 1.2, HALF_COVER, 3],
    [14, -6, 1.2, HALF_COVER, 3],
    [0, -11, 4, HALF_COVER, 1.2],
    [0, 11, 4, HALF_COVER, 1.2],
    [-11, 0, 1.2, HALF_COVER, 4],
    [11, 0, 1.2, HALF_COVER, 4],
  ],
};

/** Dense interior fight: furnace heart, four L-walls, tight lanes. */
const FOUNDRY: MapDef = {
  id: "foundry",
  name: "Foundry",
  ring: 20,
  wallHeight: FULL,
  spawnRadius: 16,
  patrolRadii: [7, 13],
  dummyRadii: [11, 14],
  boxes: [
    // Central furnace block.
    [0, 0, 4, FULL, 4],
    // Four L-walls around it (corner rooms, open toward the lanes).
    [9, 9, 6, FULL, 1],
    [9, 9, 1, FULL, 6],
    [-9, -9, 6, FULL, 1],
    [-9, -9, 1, FULL, 6],
    [-9, 9, 6, FULL, 1],
    [-9, 9, 1, FULL, 6],
    [9, -9, 6, FULL, 1],
    [9, -9, 1, FULL, 6],
    // Lane half-covers on the four approaches + two diagonals.
    [0, -10, 4, HALF_COVER, 1.2],
    [0, 10, 4, HALF_COVER, 1.2],
    [-10, 0, 1.2, HALF_COVER, 4],
    [10, 0, 1.2, HALF_COVER, 4],
    [-6, 6, 1.2, HALF_COVER, 4],
    [6, -6, 1.2, HALF_COVER, 4],
  ],
};

/** Open sniper yard: long N-S canyon through the middle, sparse cover. */
const LONGYARD: MapDef = {
  id: "longyard",
  name: "Longyard",
  ring: 24,
  wallHeight: FULL,
  spawnRadius: 20,
  patrolRadii: [8, 16],
  dummyRadii: [13, 18],
  boxes: [
    // Canyon walls: the 10 m central corridor runs the full N–S sightline.
    [-5, 0, 1, FULL, 14],
    [5, 0, 1, FULL, 14],
    // Low cross-walls break the E–W lanes without blocking the canyon.
    [0, -12, 10, HALF_COVER, 1.2],
    [0, 12, 10, HALF_COVER, 1.2],
    [-12, 0, 1.2, HALF_COVER, 6],
    [12, 0, 1.2, HALF_COVER, 6],
    [-14, 8, 1.2, HALF_COVER, 4],
    [14, -8, 1.2, HALF_COVER, 4],
  ],
};

export const MAP_DEFS: Record<MapId, MapDef> = {
  ringhold: RINGHOLD,
  foundry: FOUNDRY,
  longyard: LONGYARD,
};
