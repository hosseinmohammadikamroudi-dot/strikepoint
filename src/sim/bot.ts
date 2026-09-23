/**
 * Bot AI — the three ROADMAP Phase 2 archetypes: rusher, cover-shooter,
 * sniper. Plain-data FSM on the same 60 Hz tick contract as the rest of the
 * sim; all randomness flows from the World's Rng (determinism rule).
 *
 * Perception each tick: FOV cone + range + LOS raycast through the Level.
 * An acquired target needs `reactionTime` of continuous LOS before the bot
 * may fire (fairness per the Phase 2 gate); after LOS drops it chases
 * `lastSeen` for `memoryTime`, then returns to patrol.
 *
 * Movement is a simple steering model: wish direction → same projected
 * acceleration + friction as the player (reusing the constants), capsule
 * collision via Level, step-up handled by the support query. Bots never
 * jump in Phase 2.
 */
import { TICK_DT, clamp, angleDelta } from "./math";
import { GRAVITY } from "./math";
import { PLAYER_RADIUS, type Level } from "./level";
import { WALK_SPEED, SPRINT_SPEED, GROUND_ACCEL, FRICTION_HALF_LIFE } from "./player";
import type { Rng } from "./rng";
import type { WeaponId } from "./weapons";

// --- Archetype definitions (Phase 2 tuning; playtest will adjust) ---

export type BotArchetype = "rusher" | "cover" | "sniper";

export interface BotArchetypeDef {
  name: string;
  weapon: WeaponId;
  hp: number;
  /** Degrees — half-angle of the vision cone. */
  fovDeg: number;
  /** Meters — acquisition range. */
  viewRange: number;
  /** Seconds of continuous LOS before first shot (fairness). */
  reactionTime: number;
  /** Seconds of lastSeen memory after LOS drops. */
  memoryTime: number;
  /** Accuracy: cone half-angle applied to aim (rad, per-shot jitter scale). */
  aimError: number;
  /** Movement speed multiplier on the player caps. */
  speedMult: number;
  /** Preferred engagement band (m). */
  preferredMin: number;
  preferredMax: number;
}

export const ARCHETYPES: Record<BotArchetype, BotArchetypeDef> = {
  rusher: {
    name: "Rusher",
    weapon: "hornet",
    hp: 100,
    fovDeg: 110,
    viewRange: 30,
    reactionTime: 0.4,
    memoryTime: 3,
    aimError: 2.2 * (Math.PI / 180),
    speedMult: 1,
    preferredMin: 4,
    preferredMax: 12,
  },
  cover: {
    name: "Cover",
    weapon: "vector7",
    hp: 100,
    fovDeg: 100,
    viewRange: 40,
    reactionTime: 0.55,
    memoryTime: 4,
    aimError: 1.6 * (Math.PI / 180),
    speedMult: 0.92,
    preferredMin: 10,
    preferredMax: 25,
  },
  sniper: {
    name: "Sniper",
    weapon: "longview",
    hp: 80,
    fovDeg: 70,
    viewRange: 70,
    reactionTime: 0.9,
    memoryTime: 5,
    aimError: 0.5 * (Math.PI / 180),
    speedMult: 0.85,
    preferredMin: 25,
    preferredMax: 60,
  },
};

// --- State ---

export type BotMode = "patrol" | "chase" | "combat" | "dead";

export interface Bot {
  readonly id: number;
  readonly archetype: BotArchetype;
  readonly defId: WeaponId;
  /** Team index; -1 in FFA. Bots only engage combatants on other teams. */
  team: number;
  hp: number;
  x: number;
  y: number; // feet
  z: number;
  vx: number;
  vy: number;
  vz: number;
  yaw: number;
  /** 0..1 ADS-ish aiming stance (drives view pose later). */
  adsAmount: number;
  mode: BotMode;
  /** Weapon state mirror — stepped by World via the shared weapon module. */
  ammo: number;
  cooldown: number;
  sinceShot: number;
  reloadTimer: number;
  triggerHeld: boolean;
  switchTimer: number;
  /** Perception */
  seesTarget: boolean;
  reactionTimer: number;
  memoryTimer: number;
  lastSeenX: number;
  lastSeenZ: number;
  /** Currently engaged target's combatant id (-1 = none). */
  targetId: number;
  /** Deterministic behavior phase in [0,1) — strafe flips, stuck escapes. */
  jitterPhase: number;
  /** Previous-tick position (stuck detection). */
  lastX: number;
  lastZ: number;
  /** Patrol waypoint index (into Level.patrolPoints). */
  waypoint: number;
  /** Ticks until next patrol repick (stuck fallback). */
  stuckTimer: number;
  /** Ticks of hit-flash remaining (view hook). */
  hitFlashTicks: number;
  respawnTimer: number;
}

// Bot ids are assigned by the World (roster index) — module-level counters
// would leak across World instances and break cross-instance determinism.
export function createBot(
  archetype: BotArchetype,
  x: number,
  z: number,
  yaw: number,
  id: number,
  team = -1,
): Bot {
  const def = ARCHETYPES[archetype];
  return {
    id,
    archetype,
    defId: def.weapon,
    team,
    hp: def.hp,
    x,
    y: 0,
    z,
    vx: 0,
    vy: 0,
    vz: 0,
    yaw,
    adsAmount: 0,
    mode: "patrol",
    ammo: 999, // placeholder; World re-arms via createWeapon semantics
    cooldown: 0,
    sinceShot: 999,
    reloadTimer: 0,
    triggerHeld: false,
    switchTimer: 0,
    seesTarget: false,
    reactionTimer: 0,
    memoryTimer: 0,
    lastSeenX: x,
    lastSeenZ: z,
    targetId: -1,
    jitterPhase: (0.6180339887 * id) % 1, // golden-ratio spread, deterministic
    lastX: x,
    lastZ: z,
    waypoint: 0,
    stuckTimer: 0,
    hitFlashTicks: 0,
    respawnTimer: 0,
  };
}

/** Apply damage. Returns true if this hit was lethal. */
export function applyBotDamage(b: Bot, amount: number): boolean {
  if (b.mode === "dead") return false;
  b.hp -= amount;
  b.hitFlashTicks = 6;
  if (b.hp <= 0) {
    b.hp = 0;
    b.mode = "dead";
    b.respawnTimer = 5; // World may override
    return true;
  }
  return false;
}

// --- Perception (pure) ---

/**
 * Can the bot see a target cylinder? FOV cone (horizontal) + range + LOS ray.
 * Returns the distance when visible, else -1. Pure and allocation-free.
 */
export function botSees(
  b: Bot,
  tx: number,
  ty: number,
  tz: number,
  level: Level,
  eyeY: number,
): number {
  const def = ARCHETYPES[b.archetype];
  const dx = tx - b.x;
  const dz = tz - b.z;
  const dist = Math.hypot(dx, dz);
  if (dist > def.viewRange || dist < 1e-4) return -1;

  // Horizontal FOV: angle between facing and target direction.
  const tdirX = dx / dist;
  const tdirZ = dz / dist;
  const fx = -Math.sin(b.yaw);
  const fz = -Math.cos(b.yaw);
  const cosA = fx * tdirX + fz * tdirZ;
  const halfFov = (def.fovDeg * Math.PI) / 180;
  if (cosA < Math.cos(halfFov)) return -1;

  // LOS from bot eye to target eye.
  const by = b.y + eyeY;
  const ex = tx - b.x;
  const ey = ty - by;
  const ez = tz - b.z;
  const len = Math.hypot(ex, ey, ez);
  if (len < 1e-4) return dist;
  const inv = 1 / len;
  if (level.rayCast(b.x, by, b.z, ex * inv, ey * inv, ez * inv, len) < len - 1e-3) return -1;
  return dist;
}

/**
 * Scan every enemy target and return the index of the nearest visible one
 * (-1 when none). Enemies are combatants on other teams; in FFA (team -1)
 * every other combatant is an enemy. O(targets × boxes) per bot per tick —
 * fine at our entity counts. Pure and allocation-free.
 */
export function scanTargets(
  b: Bot,
  targets: readonly TargetRef[],
  level: Level,
  eyeY: number,
): number {
  let bestIdx = -1;
  let bestDist = Infinity;
  // NOTE: Bot.id is the roster index; a bot's COMBATANT id (scoreboard key)
  // is id + 1 because combatant 0 is the player. Skip only our own entry.
  const selfId = b.id + 1;
  for (let i = 0; i < targets.length; i++) {
    const t = targets[i]!;
    if (t.id === selfId) continue;
    if (b.team >= 0 && t.team === b.team) continue;
    const d = botSees(b, t.x, t.y + eyeY * 0.5, t.z, level, eyeY);
    if (d > 0 && d < bestDist) {
      bestDist = d;
      bestIdx = i;
    }
  }
  return bestIdx;
}

/** A potential target in the world: a combatant capsule by id and team. */
export interface TargetRef {
  /** World combatant id (player = 0, bots = bot id + 1). */
  id: number;
  /** Team index; -1 in FFA. */
  team: number;
  x: number;
  /** Feet height. */
  y: number;
  z: number;
}

// --- Tick ---

/**
 * Advance one bot one tick. The World passes: level, player position/eye,
 * whether the player is alive, the bot's weapon def (rpm/mag for pacing),
 * an events sink for shots this bot fires, and the Rng.
 * Bot shots reuse ShotEvent shape via a plain object push (kept local to
 * avoid a circular import with weapon.ts).
 */
export interface BotShot {
  ox: number;
  oy: number;
  oz: number;
  dx: number;
  dy: number;
  dz: number;
  levelT: number;
  /** Intended victim's combatant id (attribution hint; ray decides truth). */
  targetId: number;
  /** Shooter's weapon id — the audio view picks the positional voice from it. */
  defId: WeaponId;
}

/**
 * Advance one bot one tick. The World passes: level, the full combatant
 * target list (player + bots, any team), the bot's weapon pacing values,
 * an events sink for shots this bot fires, and the Rng. Bots acquire and
 * engage ANY valid target — bot-vs-bot combat is what keeps a match live
 * without humans (ROADMAP Phase 3).
 */
export function stepBot(
  b: Bot,
  level: Level,
  targets: readonly TargetRef[],
  rpm: number,
  magSize: number,
  reloadTime: number,
  rng: Rng,
  out: BotShot[],
  patrolPoints: readonly { x: number; z: number }[],
  defId: WeaponId,
): void {
  if (b.mode === "dead") {
    b.respawnTimer -= TICK_DT;
    return;
  }

  const def = ARCHETYPES[b.archetype];
  const eyeY = 1.62;

  // --- Perception: best visible enemy among ALL combatants ---
  const bestIdx = scanTargets(b, targets, level, eyeY);
  const tgt = bestIdx >= 0 ? targets[bestIdx]! : null;
  const dist = tgt ? Math.hypot(tgt.x - b.x, tgt.z - b.z) : -1;
  const wasSeeing = b.seesTarget;
  b.seesTarget = dist >= 0;
  if (b.seesTarget) {
    b.lastSeenX = tgt!.x;
    b.lastSeenZ = tgt!.z;
    b.targetId = tgt!.id;
    b.memoryTimer = def.memoryTime;
    if (!wasSeeing) b.reactionTimer = def.reactionTime; // fresh acquisition
    b.reactionTimer = Math.max(0, b.reactionTimer - TICK_DT);
  } else if (b.memoryTimer > 0) {
    b.memoryTimer -= TICK_DT;
    b.reactionTimer = def.reactionTime; // re-acquisition delay each regain
  }

  // --- Mode transitions ---
  if (b.seesTarget) {
    b.mode = "combat";
  } else if (b.memoryTimer > 0) {
    if (b.mode === "combat") b.mode = "chase";
  } else if (b.mode !== "patrol") {
    b.mode = "patrol";
    b.stuckTimer = 0;
    b.jitterPhase = (b.jitterPhase + 0.6180339887) % 1; // fresh behavior seed
  }

  // --- Desired move direction ---
  let wishX = 0;
  let wishZ = 0;
  let sprint = false;
  let faceX = 0;
  let faceZ = 0;

  if (b.mode === "combat" && tgt) {
    faceX = tgt.x - b.x;
    faceZ = tgt.z - b.z;
    const fl = Math.hypot(faceX, faceZ) || 1;
    faceX /= fl;
    faceZ /= fl;
    // Band-keeping: rusher closes in, sniper backs off, cover holds band.
    if (dist >= 0) {
      if (dist > def.preferredMax) {
        wishX = faceX;
        wishZ = faceZ;
      } else if (dist < def.preferredMin) {
        wishX = -faceX;
        wishZ = -faceZ;
      } else {
        // Strafe: perpendicular to the target, sign per-bot, with periodic
        // flips and slight aim-axis jitter so mirror standoffs break up.
        const flip = Math.sin(b.jitterPhase * Math.PI * 2) >= 0 ? 1 : -1;
        const s = (b.id % 2 === 0 ? 1 : -1) * flip;
        const j = Math.sin(b.jitterPhase * Math.PI * 8) * 0.45;
        wishX = (-faceZ + faceX * j) * s;
        wishZ = (faceX + faceZ * j) * s;
      }
      sprint = b.archetype === "rusher" && dist > def.preferredMin * 1.5;
    }
    b.adsAmount = Math.min(1, b.adsAmount + TICK_DT / 0.25);
  } else if (b.mode === "chase") {
    faceX = b.lastSeenX - b.x;
    faceZ = b.lastSeenZ - b.z;
    const fl = Math.hypot(faceX, faceZ) || 1;
    wishX = faceX / fl;
    wishZ = faceZ / fl;
    sprint = true;
    b.adsAmount = Math.max(0, b.adsAmount - TICK_DT / 0.3);
  } else {
    // Patrol: walk waypoints.
    const wp = patrolPoints[b.waypoint % patrolPoints.length];
    if (wp) {
      faceX = wp.x - b.x;
      faceZ = wp.z - b.z;
      const fl = Math.hypot(faceX, faceZ);
      if (fl < 1.2) {
        b.waypoint = (b.waypoint + 1) % patrolPoints.length;
        b.stuckTimer = 0;
      } else {
        wishX = faceX / fl;
        wishZ = faceZ / fl;
      }
    }
    b.adsAmount = Math.max(0, b.adsAmount - TICK_DT / 0.3);
  }

  // Face movement target (turn-rate limited 720°/s).
  if (faceX !== 0 || faceZ !== 0) {
    const wantYaw = Math.atan2(-faceX, -faceZ);
    const d = angleDelta(b.yaw, wantYaw);
    const maxTurn = (720 * (Math.PI / 180)) * TICK_DT;
    b.yaw += clamp(d, -maxTurn, maxTurn);
  }

  // --- Stuck fallback (Phase 3): scrub along cover, not into it ---
  if (wishX !== 0 || wishZ !== 0) {
    const moved = Math.hypot(b.x - b.lastX, b.z - b.lastZ);
    if (moved < 0.005) {
      b.stuckTimer += 1;
      if (b.stuckTimer === 30) {
        // ~0.5 s pinned: rotate the wish vector ~75° and slide along the
        // obstruction instead of pushing into it.
        const a0 = Math.atan2(wishZ, wishX);
        const a1 = a0 + (b.id % 2 === 0 ? 1.3 : -1.3) + Math.sin(b.jitterPhase * Math.PI * 2) * 0.3;
        const wl = Math.hypot(wishX, wishZ);
        wishX = Math.cos(a1) * wl;
        wishZ = Math.sin(a1) * wl;
      } else if (b.stuckTimer > 60) {
        b.stuckTimer = 0;
        b.jitterPhase = (b.jitterPhase + 0.6180339887) % 1;
        if (b.mode === "patrol") b.waypoint = (b.waypoint + 1) % patrolPoints.length;
      }
    } else {
      b.stuckTimer = 0;
    }
    b.lastX = b.x;
    b.lastZ = b.z;
  }

  // --- Movement (player-style: friction → projected accel → gravity) ---
  const cap = (b.mode === "combat" ? WALK_SPEED : sprint ? SPRINT_SPEED : WALK_SPEED) * def.speedMult;
  if (b.y <= 1e-6) {
    const f = Math.pow(0.5, TICK_DT / FRICTION_HALF_LIFE);
    b.vx *= f;
    b.vz *= f;
  }
  const wl = Math.hypot(wishX, wishZ);
  if (wl > 1e-6) {
    const nx = wishX / wl;
    const nz = wishZ / wl;
    const add = Math.min(GROUND_ACCEL * TICK_DT, Math.max(0, cap - (b.vx * nx + b.vz * nz)));
    b.vx += nx * add;
    b.vz += nz * add;
  }
  b.vy -= GRAVITY * TICK_DT;
  b.x += b.vx * TICK_DT;
  b.z += b.vz * TICK_DT;
  const resolved = level.collideCircle(b.x, b.z, b.y, PLAYER_RADIUS);
  b.x = resolved.x;
  b.z = resolved.z;
  b.y += b.vy * TICK_DT;
  const support = level.supportHeight(b.x, b.z, b.y, PLAYER_RADIUS);
  if (b.y <= support + 1e-4 && b.vy <= 0) {
    b.y = support;
    b.vy = 0;
  }

  // --- Weapon pacing (mirrors weapon.ts trigger rules, simplified) ---
  b.cooldown = Math.max(0, b.cooldown - TICK_DT);
  b.sinceShot += TICK_DT;
  if (b.reloadTimer > 0) {
    b.reloadTimer -= TICK_DT;
    if (b.reloadTimer <= 0) {
      b.reloadTimer = 0;
      b.ammo = magSize;
    }
  }

  // --- Fire decision: LOS + reacted + roughly facing ---
  if (b.mode === "combat" && b.seesTarget && b.reactionTimer === 0 && b.reloadTimer === 0 && tgt) {
    const aimYaw = Math.atan2(-(tgt.x - b.x), -(tgt.z - b.z));
    const facing = Math.abs(angleDelta(b.yaw, aimYaw)) < 4 * (Math.PI / 180);
    if (facing || dist < 3) {
      if (b.cooldown === 0) {
        if (b.ammo <= 0) {
          b.reloadTimer = reloadTime;
        } else {
          b.ammo -= 1;
          b.cooldown = 60 / rpm;
          b.sinceShot = 0;
          const oy = b.y + eyeY;
          const yawS = aimYaw + def.aimError * rng.gauss();
          const ty = tgt.y + eyeY * 0.5; // chest
          const dist3 = Math.max(0.5, Math.hypot(tgt.x - b.x, tgt.z - b.z));
          const pitchS = clamp(
            Math.atan2(ty - oy, dist3) + def.aimError * rng.gauss(),
            -1.2,
            1.2,
          );
          const cp = Math.cos(pitchS);
          const dx = -Math.sin(yawS) * cp;
          const dy = Math.sin(pitchS);
          const dz = -Math.cos(yawS) * cp;
          const levelT = level.rayCast(b.x, oy, b.z, dx, dy, dz, 300);
          out.push({ ox: b.x, oy, oz: b.z, dx, dy, dz, levelT, targetId: tgt.id, defId });
        }
      }
    }
  }
}
