import { describe, expect, it } from "vitest";
import { levelForXp, levelProgress, matchXp, rankName, xpForLevel } from "./progression";

describe("progression", () => {
  it("level 1 starts at 0 XP; thresholds are strictly increasing", () => {
    expect(xpForLevel(1)).toBe(0);
    expect(xpForLevel(2)).toBe(1000);
    let prev = 0;
    for (let l = 2; l <= 40; l++) {
      const v = xpForLevel(l);
      expect(v).toBeGreaterThan(prev);
      prev = v;
    }
  });

  it("levelForXp inverts the curve and clamps", () => {
    expect(levelForXp(0)).toBe(1);
    expect(levelForXp(999)).toBe(1);
    expect(levelForXp(1000)).toBe(2);
    expect(levelForXp(2249)).toBe(2); // 1000 + 1249 (level-3 gain = 1250)
    expect(levelForXp(2250)).toBe(3);
    expect(levelForXp(10_000_000)).toBeLessThan(200);
  });

  it("levelProgress lands inside the current level span", () => {
    const p = levelProgress(1500); // level 2, 1000..2250
    expect(p.into).toBe(500);
    expect(p.span).toBe(1250);
  });

  it("matchXp: 10 kills, 5 deaths, win → 20/kill + 150 + 50 net", () => {
    const a = matchXp({ kills: 10, deaths: 5, won: true });
    expect(a.kills).toBe(200);
    expect(a.win).toBe(150);
    expect(a.net).toBe(50);
    expect(a.total).toBe(400);
  });

  it("matchXp: negative net floors at 0; losses get no win bonus", () => {
    const a = matchXp({ kills: 2, deaths: 8, won: false });
    expect(a.net).toBe(0);
    expect(a.win).toBe(0);
    expect(a.total).toBe(40);
  });

  it("rank names ascend with level", () => {
    expect(rankName(1)).toBe("Recruit");
    expect(rankName(5)).toBe("Operator");
    expect(rankName(10)).toBe("Enforcer");
    expect(rankName(20)).toBe("Veteran");
  });
});
