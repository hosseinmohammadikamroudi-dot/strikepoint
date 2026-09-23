/**
 * World — the sim orchestrator. Owns the level (from a MapDef), the player,
 * the 4-weapon loadout, dummies, bots, the master Rng, and (Phase 3) the
 * Match. One public function, `stepWorld`, advances the whole simulation
 * exactly one 60 Hz tick. The view reads state and consumes events; it never
 * mutates sim state.
 *
 * Phase 3: bots fight each other, not just the player; the Match tracks
 * countdown → live → over with FFA/TDM scoring; spawn selection spreads
 * combatants away from enemies; kill attribution goes through the Match.
 */
import { Rng } from "./rng";
import { Level } from "./level";
import { createPlayer, stepPlayer, applyPlayerDamage, respawnPlayer, type LookConfig, type PlayerState } from "./player";
import {
  createWeapon,
  stepWeapon,
  damageAt,
  SWITCH_TIME,
  type ShotEvent,
  type WeaponState,
} from "./weapon";
import { WEAPON_DEFS, WEAPON_MOVE_MULT, DEFAULT_LOADOUT } from "./weapons";
import { applyDamage, createDummy, rayCastDummy, stepDummy, type Dummy } from "./dummy";
import {
  ARCHETYPES,
  applyBotDamage,
  createBot,
  stepBot,
  type Bot,
  type BotArchetype,
  type BotShot,
  type TargetRef,
} from "./bot";
import { rayCastCylinder } from "./geometry";
import type { InputSnapshot } from "./input";
import { DEFAULT_MATCH, createMatch, registerKill, stepMatch, type MatchDef, type MatchState } from "./match";
import type { MapId } from "./maps";

export interface WorldOptions {
  seed: number;
  /** Combat bot roster; false = none (pure firing-range tests). Default: enemy roster. */
  bots?: boolean;
  /** Map layout. Defaults to the Phase 1/2 baseline arena. */
  map?: MapId;
  /** Match rules (mode, limits). Defaults to the 10-minute TDM. */
  match?: MatchDef;
  /** Enemy bot team (player team is 0; -1 disables teams = FFA for bots). */
  botTeam?: number;
  /**
   * Explicit per-bot roster (Phase 3): archetype + spawn + team. Overrides
   * the default enemy roster; TDM lineups put allies on the player's team.
   */
  roster?: readonly { archetype: BotArchetype; spawnIndex: number; team: number }[];
  /** User look settings (Phase 4) — sensitivity multiplier and invert-Y. */
  look?: LookConfig;
}

export type GameEvent =
  | { kind: "shot"; shot: ShotEvent }
  | {
      kind: "hit";
      dummyId: number;
      zone: "head" | "body";
      damage: number;
      /** Hit distance along the ray (for impact FX placement). */
      t: number;
      dx: number;
      dy: number;
      dz: number;
      /** World-space impact point (VFX placement). */
      ix: number;
      iy: number;
      iz: number;
    }
  | { kind: "kill"; dummyId: number }
  | { kind: "killHeadshot"; dummyId: number }
  | { kind: "reloadStart" }
  | { kind: "dryFire" }
  | { kind: "switch"; id: string }
  | { kind: "botShot"; shot: BotShot }
  | {
      kind: "botHit";
      botId: number;
      zone: "head" | "body";
      damage: number;
      t: number;
      dx: number;
      dy: number;
      dz: number;
      /** World-space impact point (VFX placement). */
      ix: number;
      iy: number;
      iz: number;
      /** True when the PLAYER fired this shot (feedback UIs filter on it). */
      byPlayer: boolean;
    }
  | { kind: "botKill"; botId: number; byPlayer: boolean }
  | { kind: "footstep"; x: number; z: number; sprint: boolean }
  | { kind: "landed"; severity: number }
  | { kind: "botDeath"; botId: number; killerId: number; headshot: boolean }
  | { kind: "playerHit"; damage: number; hp: number; fromX: number; fromZ: number }
  | { kind: "playerDied" }
  | { kind: "playerRespawned" }
  | { kind: "matchLive" }
  | { kind: "matchOver" };

export const SHOT_MAX_T = 300;
const PLAYER_RESPAWN_DELAY = 3; // s
const BOT_RESPAWN_DELAY = 6; // s
/**
 * Bot damage dealt to the player, as a fraction of weapon damage. Bots aim
 * near-perfectly (they aim at the chest every tick), so raw weapon damage
 * makes them lethal far beyond human fair-play; 0.5× plus their reaction
 * delay lands them in the METRICS.md "fair" band. Playtest knob.
 */
export const BOT_DAMAGE_SCALE = 0.5;

/**
 * Default TDM lineup (Phase 3): three enemies (team 1) and one ally (team 0)
 * fighting alongside the player. FFA matches strip teams to −1 so every bot
 * fights everyone.
 */
const DEFAULT_TDM_ROSTER: { archetype: BotArchetype; spawnIndex: number; team: number }[] = [
  { archetype: "rusher", spawnIndex: 2, team: 1 },
  { archetype: "cover", spawnIndex: 3, team: 1 },
  { archetype: "sniper", spawnIndex: 6, team: 1 },
  { archetype: "rusher", spawnIndex: 5, team: 0 },
];

export class World {
  readonly level: Level;
  readonly rng: Rng;
  readonly player: PlayerState;
  readonly weapons: readonly WeaponState[];
  readonly dummies: Dummy[] = [];
  readonly bots: Bot[] = [];
  readonly events: GameEvent[] = [];
  readonly match: MatchState;
  /** Render-side interpolation fraction in [0,1] between last two ticks. */
  alpha = 1;
  /** Lifetime practice stats for the HUD (kills on dummies; match kills live in match). */
  kills = 0;
  headshots = 0;
  shotsFired = 0;
  shotsHit = 0;
  /** Deaths this session (HUD). */
  deaths = 0;
  /** Per-weapon accuracy, indexed by slot (match-end screen; Phase 5 telemetry). */
  readonly weaponShotsFired = [0, 0, 0, 0];
  readonly weaponShotsHit = [0, 0, 0, 0];
  /** Index of the currently held weapon. */
  activeSlot = 0;

  private readonly shotScratch: ShotEvent[] = [];
  private readonly botShotScratch: BotShot[] = [];
  private readonly targets: TargetRef[] = [];
  private look: LookConfig;
  private respawnTimer = 0;

  /** Live-update user look settings (Phase 4 settings screen). */
  setLook(look: LookConfig): void {
    this.look = look;
  }

  constructor(opts: WorldOptions) {
    this.level = new Level(opts.map ?? "ringhold");
    this.rng = new Rng(opts.seed);

    // Firing-range worlds (no combatants) skip the countdown entirely.
    const matchDef = { ...(opts.match ?? DEFAULT_MATCH) };
    const rosterSpec =
      opts.bots === false
        ? []
        : opts.roster ?? DEFAULT_TDM_ROSTER.map((r) => ({ ...r, team: opts.botTeam ?? r.team }));
    if (rosterSpec.length === 0) matchDef.countdown = 0;
    // FFA: everyone fights everyone (team −1), regardless of roster teams.
    const botTeams = matchDef.mode === "ffa" ? rosterSpec.map(() => -1) : rosterSpec.map((r) => r.team);

    this.match = createMatch(matchDef, 0, botTeams);

    const spawn = this.level.spawns[0] ?? { x: 18, z: 0, yaw: Math.PI };
    this.player = createPlayer(spawn.x, spawn.z, spawn.yaw);
    this.look = opts.look ?? { sensMult: 1, invertY: false };

    this.weapons = DEFAULT_LOADOUT.slots.map((id) =>
      createWeapon(id, DEFAULT_LOADOUT.attachments[id]),
    );

    for (let i = 0; i < this.level.dummySpots.length; i++) {
      const s = this.level.dummySpots[i]!;
      this.dummies.push(createDummy(i, s.x, s.z));
    }

    if (rosterSpec.length > 0) {
      for (let i = 0; i < rosterSpec.length; i++) {
        const entry = rosterSpec[i]!;
        const s = this.level.spawns[entry.spawnIndex] ?? spawn;
        const bot = createBot(entry.archetype, s.x, s.z, s.yaw, i, botTeams[i] ?? 1);
        bot.ammo = WEAPON_DEFS[bot.defId].magSize;
        this.bots.push(bot);
      }
    }

    this.rebuildTargets();
    // Freeze the player for the countdown phase (skipped for firing-range
    // worlds with no combatants at all).
    this.player.frozen = this.match.phase === "countdown" && rosterSpec.length > 0;
  }

  /** The currently held weapon (HUD + view hot path). */
  get weapon(): WeaponState {
    return this.weapons[this.activeSlot]!;
  }

  /** True while the player is dead (view shows respawn overlay). */
  get playerDead(): boolean {
    return this.player.hp <= 0;
  }

  /** Seconds until player respawn (0 when alive). */
  get respawnIn(): number {
    return Math.max(0, this.respawnTimer);
  }

  /** Advance exactly one 60 Hz tick. Emits events into `this.events`. */
  step(input: InputSnapshot): void {
    this.events.length = 0;

    // --- Match clock ---
    const transitioned = stepMatch(this.match);
    this.player.frozen = this.match.phase === "countdown" && !this.playerDead;
    if (transitioned && this.match.phase === "live") this.events.push({ kind: "matchLive" });
    if (transitioned && this.match.phase === "over") this.events.push({ kind: "matchOver" });

    if (this.playerDead) {
      this.respawnTimer -= 1 / 60;
      if (this.respawnTimer <= 0) this.respawnPlayer();
    } else {
      this.handleSwitch(input);
      const active = this.weapon;
      const moveMult = WEAPON_MOVE_MULT[active.defId] * active.mods.moveSpeedMult;
      stepPlayer(this.player, input, this.level, moveMult, this.look);
      stepWeapon(active, this.player, input, this.rng, this.level, this.shotScratch);
    }

    for (let i = 0; i < this.shotScratch.length; i++) {
      const shot = this.shotScratch[i]!;
      this.events.push({ kind: "shot", shot });
      if (shot.first) {
        this.shotsFired++;
        this.weaponShotsFired[this.activeSlot]!++;
      }
      this.resolvePlayerShot(shot);
    }
    this.shotScratch.length = 0;

    // --- Bots (they fight each other, not just the player) ---
    this.rebuildTargets();
    // Countdown freeze: nobody acts until the match goes live. Dead bots
    // keep ticking their respawn timers.
    const frozen = this.match.phase === "countdown";
    for (let i = 0; i < this.bots.length; i++) {
      const bot = this.bots[i]!;
      if (frozen) {
        if (bot.mode === "dead") {
          bot.respawnTimer -= 1 / 60;
          if (bot.respawnTimer <= 0) this.respawnBot(bot);
        }
        continue;
      }
      const def = WEAPON_DEFS[bot.defId];
      this.botShotScratch.length = 0;
      stepBot(
        bot,
        this.level,
        this.targets,
        def.rpm,
        def.magSize,
        def.reloadTime,
        this.rng,
        this.botShotScratch,
        this.level.patrolPoints,
        bot.defId,
      );
      for (let s = 0; s < this.botShotScratch.length; s++) {
        const shot = this.botShotScratch[s]!;
        this.events.push({ kind: "botShot", shot });
        this.resolveBotShot(bot, shot);
      }
      if (bot.mode === "dead" && bot.respawnTimer <= 0) this.respawnBot(bot);
    }

    for (let i = 0; i < this.dummies.length; i++) stepDummy(this.dummies[i]!);

    // --- Player locomotion events (Phase 5 audio/VFX) ---
    if (!this.playerDead) {
      if (this.player.footstep) {
        this.player.footstep = false;
        this.events.push({
          kind: "footstep",
          x: this.player.x,
          z: this.player.z,
          sprint: this.player.sprinting,
        });
      }
      if (this.player.landed) {
        this.player.landed = false;
        this.events.push({ kind: "landed", severity: Math.min(1, -this.player.landVy / 9) });
      }
    }
  }

  // --- Weapon switching ---
  private handleSwitch(input: InputSnapshot): void {
    let want = -1;
    if (input.flags.has("slot1")) want = 0;
    else if (input.flags.has("slot2")) want = 1;
    else if (input.flags.has("slot3")) want = 2;
    else if (input.flags.has("slot4")) want = 3;
    if (want < 0 || want === this.activeSlot) return;

    const cur = this.weapons[this.activeSlot]!;
    cur.adsAmount = 0;
    cur.triggerHeld = false;
    cur.reloadTimer = 0; // switching cancels reloads
    this.activeSlot = want;
    const next = this.weapons[want]!;
    next.switchTimer = SWITCH_TIME;
    next.triggerHeld = false;
    this.events.push({ kind: "switch", id: next.defId });
  }

  // --- Combatants: combatant id semantics (match scoreboard keys) ---
  /** 0 = player · 1..n = bots (bot.id + 1). `targets` is the position list for stepBot. */
  private rebuildTargets(): void {
    this.targets.length = 0;
    this.targets.push({ id: 0, team: 0, x: this.player.x, y: this.player.y, z: this.player.z });
    for (let i = 0; i < this.bots.length; i++) {
      const b = this.bots[i]!;
      if (b.mode === "dead") continue;
      this.targets.push({ id: b.id + 1, team: b.team, x: b.x, y: b.y, z: b.z });
    }
  }


  /** Hitscan resolution for player shots: level vs dummies vs bots. */
  private resolvePlayerShot(shot: ShotEvent): void {
    let bestT = Math.min(shot.levelT, SHOT_MAX_T);
    let hitDummy: Dummy | null = null;
    let hitBot: Bot | null = null;
    let hitZone: "head" | "body" = "body";

    for (let i = 0; i < this.dummies.length; i++) {
      const d = this.dummies[i]!;
      const hit = rayCastDummy(d, shot.ox, shot.oy, shot.oz, shot.dx, shot.dy, shot.dz, bestT);
      if (hit && hit.t < bestT) {
        bestT = hit.t;
        hitDummy = d;
        hitBot = null;
        hitZone = hit.zone;
      }
    }
    for (let i = 0; i < this.bots.length; i++) {
      const b = this.bots[i]!;
      if (b.mode === "dead") continue;
      const hit = rayCastCylinder(
        shot.ox, shot.oy, shot.oz, shot.dx, shot.dy, shot.dz,
        b.x, b.z, 0.35, b.y, b.y + 1.8, 0.3, bestT,
      );
      if (hit && hit.t < bestT) {
        bestT = hit.t;
        hitBot = b;
        hitDummy = null;
        hitZone = hit.zone;
      }
    }

    if (hitDummy) {
      const dmg = damageAt(this.weapon.def, bestT, hitZone === "head");
      const killed = applyDamage(hitDummy, dmg);
      this.shotsHit++;
      this.weaponShotsHit[this.activeSlot]!++;
      this.events.push({
        kind: "hit", dummyId: hitDummy.id, zone: hitZone, damage: dmg,
        t: bestT, dx: shot.dx, dy: shot.dy, dz: shot.dz,
        ix: shot.ox + shot.dx * bestT,
        iy: shot.oy + shot.dy * bestT,
        iz: shot.oz + shot.dz * bestT,
      });
      if (killed) {
        this.kills++;
        if (hitZone === "head") this.headshots++;
        this.events.push(
          hitZone === "head"
            ? { kind: "killHeadshot", dummyId: hitDummy.id }
            : { kind: "kill", dummyId: hitDummy.id },
        );
      }
      return;
    }

    if (hitBot) {
      const dmg = damageAt(this.weapon.def, bestT, hitZone === "head");
      const killed = applyBotDamage(hitBot, dmg);
      this.shotsHit++;
      this.weaponShotsHit[this.activeSlot]!++;
      this.events.push({
        kind: "botHit", botId: hitBot.id, zone: hitZone, damage: dmg,
        t: bestT, dx: shot.dx, dy: shot.dy, dz: shot.dz, byPlayer: true,
        ix: shot.ox + shot.dx * bestT,
        iy: shot.oy + shot.dy * bestT,
        iz: shot.oz + shot.dz * bestT,
      });
      if (killed) {
        this.kills++;
        if (hitZone === "head") this.headshots++;
        this.events.push({ kind: "botKill", botId: hitBot.id, byPlayer: true });
        this.killBot(hitBot, 0, hitZone === "head");
      }
    }
  }

  /**
   * Kill + respawn bookkeeping for a bot. `killerId` is a combatant id
   * (0 = player, botId + 1 otherwise); the match scores it and the event
   * tells the view (kill feed).
   */
  private killBot(bot: Bot, killerId: number, headshot: boolean): void {
    bot.respawnTimer = BOT_RESPAWN_DELAY;
    registerKill(this.match, killerId, bot.id + 1, headshot);
    this.events.push({ kind: "botDeath", botId: bot.id, killerId, headshot });
  }

  /**
   * Resolve one bot shot against every enemy combatant (bots included) plus
   * the level; attributes damage to whoever the ray actually hit — the
   * shooter's intended target is only a hint. Enemy-fire damage scales by
   * BOT_DAMAGE_SCALE; bot-vs-bot damage is unscaled (full war on the field).
   */
  private resolveBotShot(shooter: Bot, shot: BotShot): void {
    let bestT = Math.min(shot.levelT, SHOT_MAX_T);
    let victimId = -1; // combatant id
    let victimBot: Bot | null = null;
    let victimIsPlayer = false;
    let hitZone: "head" | "body" = "body";

    // Player capsule (id 0) — only when the player is an enemy of the shooter.
    const playerIsEnemy =
      !this.playerDead && shooter.team < 0 || (!this.playerDead && shooter.team !== 0);
    if (playerIsEnemy) {
      const hit = rayCastCylinder(
        shot.ox, shot.oy, shot.oz, shot.dx, shot.dy, shot.dz,
        this.player.x, this.player.z, 0.35, this.player.y, this.player.y + 1.8, 0.3, bestT,
      );
      if (hit && hit.t < bestT) {
        bestT = hit.t;
        victimId = 0;
        victimIsPlayer = true;
        victimBot = null;
        hitZone = hit.zone;
      }
    }

    // Other bots.
    for (let i = 0; i < this.bots.length; i++) {
      const b = this.bots[i]!;
      if (b.mode === "dead" || b.id === shooter.id) continue;
      if (shooter.team >= 0 && b.team === shooter.team) continue;
      const hit = rayCastCylinder(
        shot.ox, shot.oy, shot.oz, shot.dx, shot.dy, shot.dz,
        b.x, b.z, 0.35, b.y, b.y + 1.8, 0.3, bestT,
      );
      if (hit && hit.t < bestT) {
        bestT = hit.t;
        victimId = b.id + 1;
        victimBot = b;
        victimIsPlayer = false;
        hitZone = hit.zone;
      }
    }

    if (victimId < 0) return; // wall or sky
    const def = WEAPON_DEFS[shooter.defId];
    const raw = damageAt(def, bestT, hitZone === "head");
    const dmg = victimIsPlayer ? raw * BOT_DAMAGE_SCALE : raw;

    if (victimIsPlayer) {
      const killed = applyPlayerDamage(this.player, dmg);
      this.events.push({
        kind: "playerHit", damage: dmg, hp: this.player.hp,
        fromX: shooter.x, fromZ: shooter.z,
      });
      if (killed) {
        this.deaths++;
        this.respawnTimer = PLAYER_RESPAWN_DELAY;
        registerKill(this.match, shooter.id + 1, 0, hitZone === "head");
        this.events.push({ kind: "playerDied" });
      }
      return;
    }

    const killed = applyBotDamage(victimBot!, dmg);
    this.events.push({
      kind: "botHit", botId: victimBot!.id, zone: hitZone, damage: dmg,
      t: bestT, dx: shot.dx, dy: shot.dy, dz: shot.dz, byPlayer: false,
      ix: shot.ox + shot.dx * bestT,
      iy: shot.oy + shot.dy * bestT,
      iz: shot.oz + shot.dz * bestT,
    });
    if (killed) {
      this.events.push({ kind: "botKill", botId: victimBot!.id, byPlayer: false });
      this.killBot(victimBot!, shooter.id + 1, hitZone === "head");
    }
  }

  // --- Spawn selection ---

  /**
   * Best spawn for a combatant of `team`: farthest from living enemies,
   * closest to teammates (firestick together), deterministic argmax of
   * minEnemyDist − 0.4 × minTeammateDist.
   */
  private bestSpawn(team: number, excludeId: number): { x: number; z: number; yaw: number } {
    let best = this.level.spawns[0]!;
    let bestScore = -Infinity;
    for (const s of this.level.spawns) {
      let minEnemy = Infinity;
      let minMate = Infinity;
      // Player as enemy/mate (combatant 0, team 0, alive only).
      if (!this.playerDead && excludeId !== 0) {
        const d = Math.hypot(s.x - this.player.x, s.z - this.player.z);
        if (team !== 0) minEnemy = Math.min(minEnemy, d);
        else minMate = Math.min(minMate, d);
      }
      for (const b of this.bots) {
        if (b.mode === "dead" || b.id === excludeId) continue;
        const d = Math.hypot(s.x - b.x, s.z - b.z);
        if (team >= 0 && b.team === team) minMate = Math.min(minMate, d);
        else minEnemy = Math.min(minEnemy, d);
      }
      if (minEnemy === Infinity) minEnemy = 40; // no enemies alive
      if (minMate === Infinity) minMate = 20;
      const score = minEnemy - 0.4 * minMate;
      if (score > bestScore) {
        bestScore = score;
        best = s;
      }
    }
    return best;
  }

  private respawnPlayer(): void {
    const best = this.bestSpawn(0, 0);
    respawnPlayer(this.player, best.x, best.z, best.yaw);
    for (const w of this.weapons) {
      w.ammo = w.def.magSize;
      w.reloadTimer = 0;
      w.adsAmount = 0;
      w.switchTimer = 0;
    }
    this.player.frozen = this.match.phase === "countdown";
    this.events.push({ kind: "playerRespawned" });
  }

  private respawnBot(bot: Bot): void {
    const def = ARCHETYPES[bot.archetype];
    const best = this.bestSpawn(bot.team, bot.id);
    bot.x = best.x;
    bot.z = best.z;
    bot.y = 0;
    bot.vx = 0;
    bot.vy = 0;
    bot.vz = 0;
    bot.yaw = best.yaw;
    bot.hp = def.hp;
    bot.ammo = WEAPON_DEFS[bot.defId].magSize;
    bot.mode = "patrol";
    bot.seesTarget = false;
    bot.memoryTimer = 0;
    bot.reactionTimer = 0;
    bot.hitFlashTicks = 0;
    bot.targetId = -1;
    bot.stuckTimer = 0;
  }
}
