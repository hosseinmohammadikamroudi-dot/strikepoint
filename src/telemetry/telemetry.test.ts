import { describe, expect, it } from "vitest";
import { createTelemetry } from "./telemetry";

const rec = (over: Partial<Parameters<ReturnType<typeof createTelemetry>["recordMatch"]>[0]> = {}) => ({
  mode: "tdm",
  map: "ringhold",
  won: false,
  kills: 10,
  deaths: 5,
  headshots: 2,
  shotsFired: 100,
  shotsHit: 40,
  durationS: 600,
  ...over,
});

describe("telemetry", () => {
  it("aggregates win rate, K/D, and accuracy", () => {
    const t = createTelemetry();
    t.recordMatch(rec({ won: true, kills: 12, deaths: 4 }));
    t.recordMatch(rec({ kills: 6, deaths: 8 }));
    const a = t.aggregate();
    expect(a.matches).toBe(2);
    expect(a.wins).toBe(1);
    expect(a.winRate).toBeCloseTo(0.5);
    expect(a.kills).toBe(18);
    expect(a.deaths).toBe(12);
    expect(a.kd).toBeCloseTo(1.5);
    expect(a.acc).toBeCloseTo(0.4);
  });

  it("breaks results down per mode", () => {
    const t = createTelemetry();
    t.recordMatch(rec({ mode: "tdm", won: true }));
    t.recordMatch(rec({ mode: "tdm", won: true }));
    t.recordMatch(rec({ mode: "ffa", won: false }));
    const a = t.aggregate();
    const tdm = a.byMode.find((m) => m.mode === "tdm")!;
    const ffa = a.byMode.find((m) => m.mode === "ffa")!;
    expect(tdm.matches).toBe(2);
    expect(tdm.wins).toBe(2);
    expect(ffa.matches).toBe(1);
    expect(ffa.wins).toBe(0);
  });

  it("ring-buffers matches (cap 20) and fps samples (cap 600)", () => {
    const t = createTelemetry();
    for (let i = 0; i < 25; i++) t.recordMatch(rec());
    expect(t.matches.length).toBe(20);
    // Oldest dropped: sum of a counter that increments per record won't
    // appear — verify by checking aggregate only sees 20 matches.
    expect(t.aggregate().matches).toBe(20);
    for (let i = 0; i < 650; i++) t.sampleFps(60, i);
    expect(t.perf.length).toBe(600);
    expect(t.perf[0]!.atS).toBe(50); // first 50 shifted out
  });

  it("handles the empty session honestly (no NaNs)", () => {
    const a = createTelemetry().aggregate();
    expect(a.matches).toBe(0);
    expect(a.winRate).toBe(0);
    expect(a.kd).toBe(0);
    expect(a.acc).toBe(0);
    expect(a.avgFps).toBe(0);
    expect(a.minFps).toBe(0);
  });

  it("tracks fps averages and minimums", () => {
    const t = createTelemetry();
    t.sampleFps(60, 1);
    t.sampleFps(30, 2);
    t.sampleFps(55, 3);
    const a = t.aggregate();
    expect(a.avgFps).toBeCloseTo(48.333, 1);
    expect(a.minFps).toBe(30);
  });
});
