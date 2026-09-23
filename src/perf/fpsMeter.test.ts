import { describe, expect, it } from "vitest";
import { FpsMeter } from "./fpsMeter";

describe("FpsMeter", () => {
  it("ignores invalid deltas", () => {
    const meter = new FpsMeter({ windowMs: 100 });
    meter.update(0);
    meter.update(-5);
    meter.update(Number.NaN);
    meter.update(Number.POSITIVE_INFINITY);
    expect(meter.stats().windows).toBe(0);
    expect(meter.stats().maxEverFrameMs).toBe(0);
  });

  it("completes a window and computes average FPS", () => {
    const meter = new FpsMeter({ windowMs: 100 });
    // 10 frames of exactly 10ms -> 100ms -> window completes at the 10th.
    for (let i = 0; i < 10; i++) meter.update(10);
    const stats = meter.stats();
    expect(stats.windows).toBe(1);
    expect(stats.avgFps).toBeCloseTo(100, 5);
    expect(stats.worstFrameMs).toBeCloseTo(10, 5);
  });

  it("tracks worst frame within a window and max ever across windows", () => {
    const meter = new FpsMeter({ windowMs: 100 });
    meter.update(5);
    meter.update(30); // window worst
    meter.update(5);
    meter.update(60); // completes window 1 (100ms)
    for (let i = 0; i < 15; i++) meter.update(7); // 105ms -> completes window 2
    const stats = meter.stats();
    expect(stats.windows).toBe(2);
    expect(stats.maxEverFrameMs).toBeCloseTo(60, 5);
  });

  it("partial window shows live estimate and resets cleanly", () => {
    const meter = new FpsMeter({ windowMs: 1000 });
    for (let i = 0; i < 10; i++) meter.update(10); // 100ms elapsed, no window done
    expect(meter.stats().windows).toBe(0);
    expect(meter.liveFps()).toBeCloseTo(100, 5);

    meter.reset();
    expect(meter.liveFps()).toBe(0);
    expect(meter.stats().maxEverFrameMs).toBe(0);
  });
});
