/**
 * Sim-purity scan (ROADMAP Phase 6, anti-cheat baseline).
 *
 * The post-1.0 multiplayer track works by running THIS EXACT sim headless on
 * a server (deterministic, seeded, input-driven). That only stays possible
 * if `src/sim/` never touches wall clocks, unseeded randomness, or browser
 * globals. This test greps the sim source for forbidden tokens — CI fails
 * the moment any sneaks in, keeping the server-authority migration path open.
 */
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const FORBIDDEN: { token: string; why: string }[] = [
  { token: "Date.now", why: "wall clock (nondeterministic)" },
  { token: "new Date", why: "wall clock (nondeterministic)" },
  { token: "performance.now", why: "wall clock (nondeterministic)" },
  { token: "setTimeout", why: "wall-clock scheduling — use tick timers" },
  { token: "setInterval", why: "wall-clock scheduling — use tick timers" },
  { token: "requestAnimationFrame", why: "render concern — never in sim" },
  { token: "Math.random", why: "unseeded randomness — use Rng" },
  { token: "window.", why: "browser global — sim must run headless" },
  { token: "document.", why: "browser global — sim must run headless" },
  { token: "navigator.", why: "browser global — sim must run headless" },
  { token: "localStorage", why: "browser global — sim must run headless" },
];

function simFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...simFiles(p));
    else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) out.push(p);
  }
  return out;
}

describe("sim purity (anti-cheat baseline)", () => {
  it("src/sim contains no wall clocks, unseeded randomness, or browser globals", () => {
    const files = simFiles("src/sim");
    expect(files.length).toBeGreaterThan(5); // sanity: we actually scanned
    const violations: string[] = [];
    for (const f of files) {
      // Strip block comments first (doc text legitimately names forbidden
      // APIs, e.g. rng.ts's "never Math.random()" contract), then line
      // comments per line. Only executable code is scanned.
      const stripped = readFileSync(f, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
      const lines = stripped.split("\n");
      lines.forEach((line, i) => {
        const code = line.replace(/\/\/.*$/, "");
        for (const { token, why } of FORBIDDEN) {
          if (code.includes(token)) {
            violations.push(`${f}:${i + 1} — ${token} (${why})`);
          }
        }
      });
    }
    expect(violations).toEqual([]);
  });
});
