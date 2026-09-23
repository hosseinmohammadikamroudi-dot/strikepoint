import { describe, expect, it } from "vitest";
import {
  emptyProfile,
  exportSave,
  importSave,
  loadProfile,
  mergeProfile,
  PROFILE_VERSION,
  saveProfile,
  wipeProfile,
} from "./save";
import { DEFAULT_SETTINGS, loadSettings, memoryStorage, saveSettings } from "./settings";

describe("profile save/load", () => {
  it("fresh storage yields an empty profile at the current version", () => {
    const p = loadProfile(memoryStorage());
    expect(p).toEqual(emptyProfile());
    expect(p.version).toBe(PROFILE_VERSION);
  });

  it("round-trips a full profile", () => {
    const store = memoryStorage();
    const p = emptyProfile();
    p.xp = 5250;
    p.career.matches = 12;
    p.career.wins = 5;
    p.career.kills = 87;
    p.career.deaths = 61;
    p.career.headshots = 14;
    p.career.shotsFired = 3100;
    p.career.shotsHit = 940;
    saveProfile(store, p);
    expect(loadProfile(store)).toEqual(p);
  });

  it("merge tolerates partial, stale, and hostile data", () => {
    const m = mergeProfile({ xp: 300, career: { kills: 7 } }); // partial
    expect(m.xp).toBe(300);
    expect(m.career.kills).toBe(7);
    expect(m.career.matches).toBe(0);
    expect(m.version).toBe(PROFILE_VERSION); // upgraded in place

    const hostile = mergeProfile({ xp: -50, career: { kills: "x", deaths: 1.9 }, junk: true });
    expect(hostile.xp).toBe(0); // negative → 0
    expect(hostile.career.kills).toBe(0); // wrong type → 0
    expect(hostile.career.deaths).toBe(1); // floored
    expect((hostile as unknown as Record<string, unknown>).junk).toBeUndefined();
  });

  it("corrupt JSON falls back to empty; wipe clears", () => {
    const store = memoryStorage();
    store.setItem("strikepoint.profile.v1", "not json at all");
    expect(loadProfile(store)).toEqual(emptyProfile());
    saveProfile(store, { ...emptyProfile(), xp: 42 });
    wipeProfile(store);
    expect(loadProfile(store)).toEqual(emptyProfile());
  });
});

// --- Phase 6: portable save bridge ---
describe("save export/import", () => {
  it("exports a portable blob containing settings and profile", () => {
    const store = memoryStorage();
    saveSettings(store, { ...DEFAULT_SETTINGS, fov: 95, sensitivity: 1.4 });
    saveProfile(store, {
      version: 1,
      xp: 1200,
      career: { matches: 4, wins: 2, kills: 30, deaths: 20, headshots: 5, shotsFired: 500, shotsHit: 200 },
    });
    const blob = exportSave(store);
    const parsed = JSON.parse(blob);
    expect(parsed.app).toBe("strikepoint");
    expect(parsed.settings.fov).toBe(95);
    expect(parsed.profile.xp).toBe(1200);
  });

  it("imports into an empty store and round-trips losslessly", () => {
    const a = memoryStorage();
    saveSettings(a, { ...DEFAULT_SETTINGS, fov: 100 });
    saveProfile(a, {
      version: 1,
      xp: 900,
      career: { matches: 3, wins: 1, kills: 25, deaths: 15, headshots: 3, shotsFired: 400, shotsHit: 160 },
    });
    const blob = exportSave(a);
    const b = memoryStorage();
    expect(importSave(b, blob)).toBe(true);
    const rb = loadProfile(b);
    expect(rb.xp).toBe(900);
    expect(rb.career.kills).toBe(25);
    expect(loadSettings(b).fov).toBe(100);
  });

  it("rejects non-strikepoint JSON and garbage without touching the store", () => {
    const store = memoryStorage();
    expect(importSave(store, "not json {")).toBe(false);
    expect(importSave(store, JSON.stringify({ app: "other-game" }))).toBe(false);
    expect(importSave(store, "42")).toBe(false);
    expect(store.getItem("strikepoint.profile.v1")).toBeNull();
  });

  it("clamps hand-edited values on import (defensive)", () => {
    const store = memoryStorage();
    const ok = importSave(
      store,
      JSON.stringify({
        app: "strikepoint",
        settings: { fov: 9999, sensitivity: -50 },
        profile: { xp: -123, career: { matches: "lots" } },
      }),
    );
    expect(ok).toBe(true);
    const s = loadSettings(store);
    expect(s.fov).toBeLessThanOrEqual(110); // clamped
    expect(s.sensitivity).toBeGreaterThanOrEqual(0.2); // clamped
    const p = loadProfile(store); // corrupt career falls back to defaults
    expect(p.career.matches).toBeGreaterThanOrEqual(0);
  });
});
