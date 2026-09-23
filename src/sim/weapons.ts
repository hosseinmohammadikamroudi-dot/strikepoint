/**
 * Weapon definitions — data-driven, straight from METRICS.md (v0.1 values).
 * The weapon *system* is def-driven: `weapon.ts` implements one mechanics
 * engine parameterized by these defs, so adding a weapon is adding data.
 *
 * All times in seconds, angles in radians (converted from the metric-sheet
 * degrees at module load), damage in hit points.
 */

export type WeaponId = "vector7" | "hornet" | "mule" | "longview";

export type FireMode = "auto" | "semi" | "pump" | "bolt";

export type AttachmentSlot = "sight" | "barrel" | "underbarrel";

export interface Attachment {
  id: string;
  slot: AttachmentSlot;
  name: string;
  /** All modifiers optional; applied additively to the def (clamped in weapon.ts). */
  adsTimeMult?: number;
  adsSpreadMult?: number; // multiplies the ADS spread multiplier (lower = tighter)
  bloomPerShotAdd?: number; // radians
  recoilPitchMult?: number;
  recoilYawMult?: number;
  moveSpeedMult?: number;
}

export const ATTACHMENTS: Attachment[] = [
  { id: "holo", slot: "sight", name: "Holo sight", adsTimeMult: 1.1, adsSpreadMult: 0.9 },
  { id: "scope4x", slot: "sight", name: "4x scope", adsTimeMult: 1.35, adsSpreadMult: 0.75 },
  { id: "comp", slot: "barrel", name: "Compensator", recoilPitchMult: 0.8, recoilYawMult: 0.85 },
  { id: "suppr", slot: "barrel", name: "Suppressor", recoilPitchMult: 1.05, adsSpreadMult: 1.1 },
  { id: "grip", slot: "underbarrel", name: "Vertical grip", bloomPerShotAdd: -0.06 * (Math.PI / 180), moveSpeedMult: 0.98 },
  { id: "laser", slot: "underbarrel", name: "Laser", adsSpreadMult: 0.8 },
];

export interface WeaponDef {
  id: WeaponId;
  name: string;
  fireMode: FireMode;
  rpm: number;
  bodyDamage: number;
  headDamage: number;
  /** Pellets per shot (shotgun > 1); each rolls its own spread ray. */
  pellets: number;
  falloffStart: number; // m
  falloffFloor: number; // damage multiplier at 20 m past start
  adsTime: number; // s to reach full ADS
  hipBloomPerShot: number; // rad
  hipBloomMax: number; // rad
  adsSpreadMult: number; // ADS spread = bloom * this
  recoilKickPitch: number; // rad per shot
  recoilKickYaw: number; // rad per shot
  recoilRecoveryRate: number; // rad/s (per-weapon, METRICS.md)
  reloadTime: number; // s (full mag)
  /** Shotgun shell reload: per-shell time; 0 = magazine reload. */
  shellReloadTime: number;
  magSize: number;
  /** Zoomed FOV while fully in ADS (degrees, vertical). */
  adsFov: number;
  /** Allowed attachment ids per slot (empty array = no attachment support). */
  allowedAttachments: Partial<Record<AttachmentSlot, string[]>>;
}

const deg = (d: number): number => (d * Math.PI) / 180;

// METRICS.md: Weapons (v0.1 starting values, all hitscan)
export const WEAPON_DEFS: Record<WeaponId, WeaponDef> = {
  vector7: {
    id: "vector7",
    name: "Vector-7",
    fireMode: "auto",
    rpm: 750,
    bodyDamage: 25,
    headDamage: 40,
    pellets: 1,
    falloffStart: 30,
    falloffFloor: 0.65,
    adsTime: 0.22,
    hipBloomPerShot: deg(0.35),
    hipBloomMax: deg(3.0),
    adsSpreadMult: 0.35,
    recoilKickPitch: deg(0.5),
    recoilKickYaw: deg(0.22),
    recoilRecoveryRate: deg(8),
    reloadTime: 2.1,
    shellReloadTime: 0,
    magSize: 30,
    adsFov: 55,
    allowedAttachments: { sight: ["holo", "scope4x"], barrel: ["comp", "suppr"], underbarrel: ["grip", "laser"] },
  },
  hornet: {
    id: "hornet",
    name: "Hornet",
    fireMode: "auto",
    rpm: 900,
    bodyDamage: 20,
    headDamage: 32,
    pellets: 1,
    falloffStart: 18,
    falloffFloor: 0.5,
    adsTime: 0.18,
    hipBloomPerShot: deg(0.3),
    hipBloomMax: deg(3.5),
    adsSpreadMult: 0.45,
    recoilKickPitch: deg(0.4),
    recoilKickYaw: deg(0.3),
    recoilRecoveryRate: deg(9),
    reloadTime: 1.8,
    shellReloadTime: 0,
    magSize: 32,
    adsFov: 60,
    allowedAttachments: { sight: ["holo"], barrel: ["comp", "suppr"], underbarrel: ["grip", "laser"] },
  },
  mule: {
    id: "mule",
    name: "Mule",
    fireMode: "pump",
    rpm: 90,
    bodyDamage: 8, // per pellet × 8 pellets
    headDamage: 12, // per pellet × 8 pellets
    pellets: 8,
    falloffStart: 10,
    falloffFloor: 0.2,
    adsTime: 0.2,
    hipBloomPerShot: deg(2.5),
    hipBloomMax: deg(2.5),
    adsSpreadMult: 0.8,
    recoilKickPitch: deg(4),
    recoilKickYaw: deg(0.8),
    recoilRecoveryRate: deg(6),
    reloadTime: 2.8,
    shellReloadTime: 0.6,
    magSize: 6,
    adsFov: 62,
    allowedAttachments: {},
  },
  longview: {
    id: "longview",
    name: "Longview",
    fireMode: "bolt",
    rpm: 45,
    bodyDamage: 100,
    headDamage: 160,
    pellets: 1,
    falloffStart: 1000, // none
    falloffFloor: 1,
    adsTime: 0.35,
    hipBloomPerShot: deg(3),
    hipBloomMax: deg(3),
    adsSpreadMult: 0.02,
    recoilKickPitch: deg(3.5),
    recoilKickYaw: deg(0.5),
    recoilRecoveryRate: deg(5),
    reloadTime: 3.0,
    shellReloadTime: 0,
    magSize: 5,
    adsFov: 20,
    allowedAttachments: { barrel: ["suppr"] },
  },
};

/**
 * Per-weapon mobility factor (applied on top of stance caps). Heavier
 * weapons slow the player; layered with attachment moveSpeedMult.
 */
export const WEAPON_MOVE_MULT: Record<WeaponId, number> = {
  vector7: 0.95,
  hornet: 0.98,
  mule: 0.9,
  longview: 0.82,
};

/** Player loadout: one weapon per slot, plus chosen attachments. */
export interface Loadout {
  slots: [WeaponId, WeaponId, WeaponId, WeaponId];
  attachments: Partial<Record<WeaponId, string[]>>;
}

export const DEFAULT_LOADOUT: Loadout = {
  slots: ["vector7", "hornet", "mule", "longview"],
  attachments: {},
};

/** Resolve a weapon's active attachment modifiers (unknown ids ignored). */
export function attachmentMods(id: WeaponId, attachmentIds: readonly string[] | undefined): Required<Pick<Attachment, "adsTimeMult" | "adsSpreadMult" | "bloomPerShotAdd" | "recoilPitchMult" | "recoilYawMult" | "moveSpeedMult">> {
  const mods = {
    adsTimeMult: 1,
    adsSpreadMult: 1,
    bloomPerShotAdd: 0,
    recoilPitchMult: 1,
    recoilYawMult: 1,
    moveSpeedMult: 1,
  };
  if (!attachmentIds) return mods;
  const allowed = WEAPON_DEFS[id].allowedAttachments;
  for (const attId of attachmentIds) {
    const att = ATTACHMENTS.find((a) => a.id === attId);
    if (!att) continue;
    const slotOk = (allowed[att.slot] ?? []).includes(att.id);
    if (!slotOk) continue;
    if (att.adsTimeMult !== undefined) mods.adsTimeMult *= att.adsTimeMult;
    if (att.adsSpreadMult !== undefined) mods.adsSpreadMult *= att.adsSpreadMult;
    if (att.bloomPerShotAdd !== undefined) mods.bloomPerShotAdd += att.bloomPerShotAdd;
    if (att.recoilPitchMult !== undefined) mods.recoilPitchMult *= att.recoilPitchMult;
    if (att.recoilYawMult !== undefined) mods.recoilYawMult *= att.recoilYawMult;
    if (att.moveSpeedMult !== undefined) mods.moveSpeedMult *= att.moveSpeedMult;
  }
  return mods;
}
