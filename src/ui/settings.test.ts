import { describe, expect, it } from "vitest";
import {
  DEFAULT_SETTINGS,
  SETTINGS_BOUNDS,
  loadSettings,
  memoryStorage,
  mergeSettings,
  saveSettings,
} from "./settings";

describe("settings", () => {
  it("fresh storage yields defaults", () => {
    expect(loadSettings(memoryStorage())).toEqual(DEFAULT_SETTINGS);
  });

  it("merge drops unknown keys and clamps out-of-range values", () => {
    const merged = mergeSettings({
      fov: 500, // out of bounds → clamped
      sensitivity: -3, // out of bounds → clamped
      resolutionScale: 0.75,
      showFps: false,
      hackerKey: "drop me", // unknown → dropped
      masterVolume: 0.5,
      sfxVolume: "not a number", // wrong type → default
    });
    expect(merged.fov).toBe(SETTINGS_BOUNDS.fov[1]);
    expect(merged.sensitivity).toBe(SETTINGS_BOUNDS.sensitivity[0]);
    expect(merged.resolutionScale).toBe(0.75);
    expect(merged.showFps).toBe(false);
    expect(merged.masterVolume).toBe(0.5);
    expect(merged.sfxVolume).toBe(DEFAULT_SETTINGS.sfxVolume);
    expect((merged as unknown as Record<string, unknown>).hackerKey).toBeUndefined();
    // Round-trip integrity: merged object always has the full shape.
    expect(Object.keys(merged).sort()).toEqual(Object.keys(DEFAULT_SETTINGS).sort());
  });

  it("merge of garbage (null/number/string) yields defaults", () => {
    expect(mergeSettings(null)).toEqual(DEFAULT_SETTINGS);
    expect(mergeSettings(42)).toEqual(DEFAULT_SETTINGS);
    expect(mergeSettings("x")).toEqual(DEFAULT_SETTINGS);
  });

  it("saves and loads a round trip", () => {
    const store = memoryStorage();
    const s = { ...DEFAULT_SETTINGS, sensitivity: 1.8, invertY: true, fov: 95 };
    saveSettings(store, s);
    expect(loadSettings(store)).toEqual(s);
  });

  it("corrupt JSON falls back to defaults", () => {
    const store = memoryStorage();
    store.setItem("strikepoint.settings.v1", "{not json");
    expect(loadSettings(store)).toEqual(DEFAULT_SETTINGS);
  });
});
