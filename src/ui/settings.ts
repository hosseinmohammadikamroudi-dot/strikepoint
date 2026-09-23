/**
 * Player settings (ROADMAP Phase 4: settings screen). Plain data + pure
 * merge/clamp functions; persistence is delegated to an injectable storage
 * adapter so tests run without a browser. The game never reads settings
 * from the DOM — the UI writes here, systems read here.
 */

export interface Settings {
  // Graphics
  /** Render resolution scale: 0.5 = half res (perf), 1 = native. */
  resolutionScale: number;
  fov: number; // 60–110, vertical degrees at hip
  showFps: boolean;
  // Audio
  masterVolume: number; // 0–1
  sfxVolume: number; // 0–1
  // Controls
  /** Mouse sensitivity multiplier on the 0.0022 rad/count base. */
  sensitivity: number; // 0.2–3
  /** Invert vertical mouse look. */
  invertY: boolean;
  /** Perf profile (Phase 6): "high" native res, "medium" 0.75, "low" 0.55.
   * Manual selection; also the landing spot for auto-downgrade. */
  quality: "high" | "medium" | "low";
}

export const DEFAULT_SETTINGS: Settings = {
  resolutionScale: 1,
  fov: 75,
  showFps: true,
  masterVolume: 0.8,
  sfxVolume: 0.9,
  sensitivity: 1,
  invertY: false,
  quality: "high",
};

/** Resolution scale per perf profile (Phase 6). Manual override wins. */
export const QUALITY_SCALE: Record<Settings["quality"], number> = {
  high: 1,
  medium: 0.75,
  low: 0.55,
};

export const SETTINGS_BOUNDS = {
  resolutionScale: [0.5, 1] as const,
  fov: [60, 110] as const,
  sensitivity: [0.2, 3] as const,
  masterVolume: [0, 1] as const,
  sfxVolume: [0, 1] as const,
};

/** Storage adapter — the DOM layer supplies localStorage; tests supply maps. */
export interface KVStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

const clamp01 = (v: number, lo: number, hi: number, fallback: number): number =>
  Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : fallback;

/**
 * Merge a (possibly stale or partial) stored object onto the defaults.
 * Unknown keys are dropped, out-of-range values clamped, wrong types fall
 * back — forward- and backward-safe across versions.
 */
export function mergeSettings(raw: unknown): Settings {
  const d = DEFAULT_SETTINGS;
  if (typeof raw !== "object" || raw === null) return { ...d };
  const r = raw as Record<string, unknown>;
  return {
    resolutionScale: clamp01(Number(r.resolutionScale), ...SETTINGS_BOUNDS.resolutionScale, d.resolutionScale),
    fov: clamp01(Number(r.fov), ...SETTINGS_BOUNDS.fov, d.fov),
    showFps: typeof r.showFps === "boolean" ? r.showFps : d.showFps,
    masterVolume: clamp01(Number(r.masterVolume), ...SETTINGS_BOUNDS.masterVolume, d.masterVolume),
    sfxVolume: clamp01(Number(r.sfxVolume), ...SETTINGS_BOUNDS.sfxVolume, d.sfxVolume),
    sensitivity: clamp01(Number(r.sensitivity), ...SETTINGS_BOUNDS.sensitivity, d.sensitivity),
    invertY: typeof r.invertY === "boolean" ? r.invertY : d.invertY,
    quality:
      r.quality === "high" || r.quality === "medium" || r.quality === "low" ? r.quality : d.quality,
  };
}

const KEY = "strikepoint.settings.v1";

export function loadSettings(store: KVStore): Settings {
  try {
    const raw = store.getItem(KEY);
    if (raw === null) return { ...DEFAULT_SETTINGS };
    return mergeSettings(JSON.parse(raw));
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(store: KVStore, s: Settings): void {
  try {
    store.setItem(KEY, JSON.stringify(s));
  } catch {
    // Quota/privacy mode: settings stay session-only; not an error path.
  }
}

/** In-memory storage for tests and the fresh-player default. */
export function memoryStorage(): KVStore {
  const m = new Map<string, string>();
  return {
    getItem: (k) => m.get(k) ?? null,
    setItem: (k, v) => void m.set(k, v),
    removeItem: (k) => void m.delete(k),
  };
}
