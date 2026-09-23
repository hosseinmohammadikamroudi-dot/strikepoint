export interface FpsStats {
  /** Rolling average FPS over the current window. */
  avgFps: number;
  /** Highest single-frame time in the current window, milliseconds. */
  worstFrameMs: number;
  /** Longest frame time seen since start, milliseconds (spike detector). */
  maxEverFrameMs: number;
  /** Number of completed averaging windows. */
  windows: number;
}

export interface FpsMeterOptions {
  /** Averaging window length in milliseconds. Default 500. */
  windowMs?: number;
  /** Called once per completed averaging window. */
  onWindow?: (stats: FpsStats) => void;
}

/**
 * Rolling frame-time meter for the boot HUD and the future CI perf harness.
 *
 * Deliberately DOM-free: pass a canvas-style callback loop's raw deltas in,
 * read stats out. Pure TS so it runs in Vitest and headless harnesses.
 */
export class FpsMeter {
  private readonly windowMs: number;
  private readonly onWindow?: (stats: FpsStats) => void;

  private accMs = 0;
  private frames = 0;
  private worstMs = 0;
  private maxEverMs = 0;
  private windowsCompleted = 0;
  private lastAvgFps = 0;
  private lastWorstMs = 0;

  constructor(options: FpsMeterOptions = {}) {
    this.windowMs = options.windowMs ?? 500;
    this.onWindow = options.onWindow;
  }

  /** Feed one frame's delta in milliseconds. Must be > 0; non-finite values are ignored. */
  update(dtMs: number): void {
    if (!Number.isFinite(dtMs) || dtMs <= 0) return;

    this.accMs += dtMs;
    this.frames += 1;
    this.maxEverMs = Math.max(this.maxEverMs, dtMs);
    this.worstMs = Math.max(this.worstMs, dtMs);

    if (this.accMs >= this.windowMs) {
      this.lastAvgFps = (this.frames * 1000) / this.accMs;
      this.lastWorstMs = this.worstMs;
      this.windowsCompleted += 1;
      this.onWindow?.(this.stats());

      // Reset per-window accumulators; maxEver survives across windows.
      this.accMs = 0;
      this.frames = 0;
      this.worstMs = 0;
    }
  }

  /** Current snapshot. Between windows, avg/worst reflect the last completed window. */
  stats(): FpsStats {
    return {
      avgFps: this.lastAvgFps,
      worstFrameMs: this.lastWorstMs,
      maxEverFrameMs: this.maxEverMs,
      windows: this.windowsCompleted,
    };
  }

  /** Live (mid-window) estimate for HUDs that want fresher numbers. */
  liveFps(): number {
    if (this.accMs <= 0 || this.frames === 0) return this.lastAvgFps;
    return (this.frames * 1000) / this.accMs;
  }

  reset(): void {
    this.accMs = 0;
    this.frames = 0;
    this.worstMs = 0;
    this.maxEverMs = 0;
    this.windowsCompleted = 0;
    this.lastAvgFps = 0;
    this.lastWorstMs = 0;
  }
}
