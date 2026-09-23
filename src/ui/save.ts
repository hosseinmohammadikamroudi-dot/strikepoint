/**
 * Player profile save/load (ROADMAP Phase 4: save/load systems). Versioned
 * schema with forward-safe merging — an old or partial save loads to valid
 * state instead of throwing. The profile owns career stats and progression;
 * settings live in their own storage key (settings.ts).
 *
 * Save timing: once at match end (the sim is authoritative mid-match; a
 * mid-match crash costs one match of XP, never the profile).
 */
import type { KVStore } from "./settings";

export const PROFILE_VERSION = 1;

export interface Profile {
  version: number;
  /** Cumulative XP (drives level via progression.ts). */
  xp: number;
  /** Career totals across all matches played. */
  career: {
    matches: number;
    wins: number;
    kills: number;
    deaths: number;
    headshots: number;
    shotsFired: number;
    shotsHit: number;
  };
}

export function emptyProfile(): Profile {
  return {
    version: PROFILE_VERSION,
    xp: 0,
    career: {
      matches: 0,
      wins: 0,
      kills: 0,
      deaths: 0,
      headshots: 0,
      shotsFired: 0,
      shotsHit: 0,
    },
  };
}

/** Merge an unknown stored value into a valid Profile (version-tolerant). */
export function mergeProfile(raw: unknown): Profile {
  const base = emptyProfile();
  if (typeof raw !== "object" || raw === null) return base;
  const r = raw as Record<string, unknown>;
  const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0);
  const c = (typeof r.career === "object" && r.career !== null ? r.career : {}) as Record<string, unknown>;
  return {
    version: PROFILE_VERSION,
    xp: num(r.xp),
    career: {
      matches: num(c.matches),
      wins: num(c.wins),
      kills: num(c.kills),
      deaths: num(c.deaths),
      headshots: num(c.headshots),
      shotsFired: num(c.shotsFired),
      shotsHit: num(c.shotsHit),
    },
  };
}

const KEY = "strikepoint.profile.v1";

export function loadProfile(store: KVStore): Profile {
  try {
    const raw = store.getItem(KEY);
    if (raw === null) return emptyProfile();
    return mergeProfile(JSON.parse(raw));
  } catch {
    return emptyProfile();
  }
}

export function saveProfile(store: KVStore, p: Profile): void {
  try {
    store.setItem(KEY, JSON.stringify({ ...p, version: PROFILE_VERSION }));
  } catch {
    // Quota/privacy mode: career progress stays session-only.
  }
}

export function wipeProfile(store: KVStore): void {
  try {
    store.removeItem(KEY);
  } catch {
    // ignore
  }
}

// --- Manual cloud-save bridge (Phase 6) ---
// Accounts/cloud sync are post-1.0 (see docs/SERVER_AUTHORITY.md); until then
// the portable save is a single JSON blob the player can copy out and paste
// back — enough to move a career between browsers/machines safely.

/** Serialize settings + profile into one portable JSON string. */
export function exportSave(store: KVStore): string {
  const out = {
    app: "strikepoint",
    saveVersion: 1,
    settings: (() => {
      try {
        return JSON.parse(store.getItem("strikepoint.settings.v1") ?? "null");
      } catch {
        return null;
      }
    })(),
    profile: (() => {
      try {
        return JSON.parse(store.getItem("strikepoint.profile.v1") ?? "null");
      } catch {
        return null;
      }
    })(),
  };
  return JSON.stringify(out, null, 2);
}

/**
 * Apply a portable save. Every field re-validates through the same merge /
 * clamp pipeline as a live load, so a hand-edited or truncated blob can at
 * worst produce defaults — never a crash or out-of-range state.
 * Returns false when the blob is not a Strikepoint save at all.
 */
export function importSave(store: KVStore, json: string): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return false;
  }
  if (typeof parsed !== "object" || parsed === null) return false;
  const r = parsed as Record<string, unknown>;
  if (r.app !== "strikepoint") return false;
  try {
    if (r.settings !== null && r.settings !== undefined) {
      store.setItem("strikepoint.settings.v1", JSON.stringify(r.settings));
    }
    if (r.profile !== null && r.profile !== undefined) {
      store.setItem("strikepoint.profile.v1", JSON.stringify(r.profile));
    }
  } catch {
    return false; // quota / privacy mode
  }
  return true;
}
