/**
 * Performance budget enforcement (METRICS.md, enforced from Phase 2 CI).
 *
 * The render loop must fit 16.6 ms/frame on the target hardware; the sim's
 * share of that budget is what CI can measure deterministically. Everything
 * else (render submission, GPU) is validated by the in-browser HUD instead.
 */
import { describe, expect, it } from "vitest";
import { World } from "../sim/world";
import { createInputSnapshot, press } from "../sim/input";

describe("perf budget (METRICS.md)", () => {
  it("full sim step (player + 4 bots + 6 dummies) averages < 1 ms", () => {
    const w = new World({ seed: 42 });
    const input = createInputSnapshot();
    press(input, "forward"); // keep movement, AI, and weapons all active

    // JIT warmup before measuring.
    for (let i = 0; i < 120; i++) w.step(input);

    // Best-of-3 measurement: the true step cost is ~0.05 ms, so runner noise
    // (GC pause, CI scheduling) is the only realistic way to approach the
    // 1 ms budget. A genuine regression slows ALL samples; noise hits one.
    const TICKS = 600; // 10 s of sim per sample
    let best = Infinity;
    for (let sample = 0; sample < 3; sample++) {
      const t0 = performance.now();
      for (let i = 0; i < TICKS; i++) w.step(input);
      best = Math.min(best, (performance.now() - t0) / TICKS);
    }

    // Budget: 16.6 ms frame on integrated GPU. The sim may consume at most
    // ~1 ms of it (leaves headroom for render submission + compositor).
    expect(best).toBeLessThan(1);
  });
});
