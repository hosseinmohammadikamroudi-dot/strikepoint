/**
 * Deterministic seeded RNG (SplitMix32). The sim draws ALL gameplay randomness
 * from instances of this class — never Math.random() — so a fixed seed plus a
 * fixed input trace reproduces a match bit-for-bit (enforced by a test).
 *
 * SplitMix32: ~5 ops per u32, good statistical quality for its cost, and the
 * 32-bit state is trivially serializable for future netcode snapshots.
 */
export class Rng {
  private state: number;

  constructor(seed: number) {
    this.state = seed >>> 0;
  }

  /** Next raw u32 as an unsigned integer. */
  nextU32(): number {
    this.state = (this.state + 0x9e3779b9) >>> 0;
    let z = this.state;
    z = Math.imul(z ^ (z >>> 16), 0x21f0aaad) >>> 0;
    z = Math.imul(z ^ (z >>> 15), 0x735a2d97) >>> 0;
    return (z ^ (z >>> 15)) >>> 0;
  }

  /** Uniform float in [0, 1). */
  nextFloat(): number {
    return this.nextU32() / 4294967296;
  }

  /** Uniform float in [min, max). */
  range(min: number, max: number): number {
    return min + (max - min) * this.nextFloat();
  }

  /** Normal-ish (Irwin–Hall) value, mean 0, ~unit variance; fine for recoil/bloom jitter. */
  gauss(): number {
    return (this.nextFloat() + this.nextFloat() + this.nextFloat() - 1.5) * 2;
  }
}
