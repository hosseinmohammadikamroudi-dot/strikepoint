/**
 * Procedural audio (ROADMAP Phases 4–5). Everything is synthesized — noise
 * buffers + oscillator envelopes — so the game ships with zero audio assets.
 * Pure view-side: driven by sim events, never touches sim state.
 *
 * Phase 5: two playback paths.
 *  - `play`  — stereo bus, for the player's own sounds (full gain).
 *  - `play3d`— HRTF panner + hand-rolled distance attenuation + distance
 *              lowpass, for world sounds (bot fire, footsteps). Beyond
 *              AUDIBLE_RANGE the voice is skipped entirely (free perf).
 * An ambience bed (filtered noise + detuned low pair) fades in on unlock.
 *
 * The AudioContext is created/resumed lazily from a user gesture (menu click)
 * per browser autoplay policy; every method is a safe no-op before unlock.
 */
import type { WeaponId } from "../sim/weapons";
import type { Settings } from "../ui/settings";

/** Per-weapon voice character: [noise length s, body freq Hz, thump gain]. */
const GUN_VOICES: Record<WeaponId, { noise: number; body: number; thump: number }> = {
  vector7: { noise: 0.14, body: 190, thump: 0.5 },
  hornet: { noise: 0.09, body: 240, thump: 0.35 },
  mule: { noise: 0.3, body: 95, thump: 0.9 },
  longview: { noise: 0.34, body: 70, thump: 1.0 },
};

/** World voices past this distance are skipped (they'd be inaudible anyway). */
const AUDIBLE_RANGE = 70;

export interface AudioView {
  /** Create/resume the context from a user gesture. Idempotent. */
  unlock(): void;
  setVolumes(master: number, sfx: number): void;
  /** Apply audio-related settings (volumes only, today). */
  applySettings(s: Settings): void;
  /** Per-frame listener pose from the render camera (position + forward). */
  updateListener(px: number, py: number, pz: number, fx: number, fy: number, fz: number): void;
  /** The player's own weapon — non-positional, full presence. */
  shot(defId: WeaponId): void;
  /** A bot's weapon — positional: panned, attenuated, muffled by distance. */
  shotAt(defId: WeaponId, x: number, y: number, z: number): void;
  /** Footstep at a world position; own steps (≤1.2 m) play quieter center. */
  footstepAt(x: number, z: number, sprint: boolean): void;
  /** Player landing thump, severity 0–1 from impact speed. */
  landed(severity: number): void;
  /** Magazine-out click (trigger pulled on an empty mag). */
  dryFire(): void;
  /** Weapon swap: two-stage mechanical slide. */
  weaponSwitch(): void;
  hitmarker(kill: boolean): void;
  hurt(): void;
  death(): void;
  respawn(): void;
  reload(): void;
  uiClick(): void;
  matchStart(): void;
  matchEnd(won: boolean): void;
  dispose(): void;
}

export function createAudioView(): AudioView {
  let ctx: AudioContext | null = null;
  let master: GainNode | null = null;
  let sfx: GainNode | null = null;
  let noiseBuf: AudioBuffer | null = null;
  let ambGain: GainNode | null = null;
  let volMaster = 0.8;
  let volSfx = 0.9;
  // Listener pose (play3d reads it for attenuation + culling).
  let lx = 0;
  let ly = 1.6;
  let lz = 0;

  const ensure = (): void => {
    if (!ctx) return;
    if (ctx.state === "suspended") void ctx.resume();
  };

  /** Route a node through the sfx bus with a gain envelope. */
  const play = (
    make: (destination: AudioNode, when: number) => void,
    dur: number,
  ): void => {
    if (!ctx || !sfx) return;
    ensure();
    const when = ctx.currentTime + 0.001;
    const g = ctx.createGain();
    g.gain.setValueAtTime(volSfx, when);
    g.gain.exponentialRampToValueAtTime(0.0001, when + dur);
    g.connect(sfx);
    make(g, when);
  };

  /**
   * Positional voice: make() renders into a distance lowpass → atten gain →
   * HRTF panner (rolloff disabled — attenuation is hand-rolled below).
   */
  const play3d = (
    make: (destination: AudioNode, when: number) => void,
    dur: number,
    x: number,
    y: number,
    z: number,
    base: number,
  ): void => {
    if (!ctx || !sfx) return;
    const dist = Math.hypot(x - lx, y - ly, z - lz);
    if (dist > AUDIBLE_RANGE) return;
    ensure();
    const when = ctx.currentTime + 0.001;
    // Hand-rolled inverse-square-ish falloff; ref ~9 m, soft knee.
    const atten = Math.min(1, base / (1 + Math.pow(dist / 9, 1.7)));
    if (atten < 0.003) return;
    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.value = Math.max(700, 12000 - dist * 150);
    const g = ctx.createGain();
    g.gain.setValueAtTime(atten, when);
    g.gain.exponentialRampToValueAtTime(0.0001, when + dur);
    const pan = ctx.createPanner();
    pan.panningModel = "HRTF";
    pan.distanceModel = "linear";
    pan.refDistance = 1;
    pan.maxDistance = 10000;
    pan.rolloffFactor = 0; // attenuation handled above
    if (pan.positionX) {
      pan.positionX.value = x;
      pan.positionY.value = y;
      pan.positionZ.value = z;
    } else {
      (pan as unknown as { setPosition(x: number, y: number, z: number): void }).setPosition(x, y, z);
    }
    make(lp, when);
    lp.connect(g).connect(pan).connect(sfx);
  };

  const noise = (dest: AudioNode, when: number, len: number, freq: number, q: number, gain: number): void => {
    if (!ctx || !noiseBuf) return;
    const src = ctx.createBufferSource();
    src.buffer = noiseBuf;
    const filt = ctx.createBiquadFilter();
    filt.type = "bandpass";
    filt.frequency.value = freq;
    filt.Q.value = q;
    const g = ctx.createGain();
    g.gain.setValueAtTime(gain, when);
    src.connect(filt).connect(g).connect(dest);
    src.start(when);
    src.stop(when + len + 0.02);
  };

  const tone = (
    dest: AudioNode,
    when: number,
    type: OscillatorType,
    f0: number,
    f1: number,
    gain: number,
    dur: number,
    delay = 0,
  ): void => {
    if (!ctx) return;
    const osc = ctx.createOscillator();
    osc.type = type;
    osc.frequency.setValueAtTime(f0, when + delay);
    osc.frequency.exponentialRampToValueAtTime(Math.max(1, f1), when + delay + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, when + delay);
    g.gain.exponentialRampToValueAtTime(gain, when + delay + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, when + delay + dur);
    osc.connect(g).connect(dest);
    osc.start(when + delay);
    osc.stop(when + delay + dur + 0.02);
  };

  /** Start the ambience bed: wind noise + slowly beating low pair. */
  const startAmbience = (): void => {
    if (!ctx || !master || ambGain) return;
    ambGain = ctx.createGain();
    ambGain.gain.value = 0;
    ambGain.connect(master);
    // Wind: looping noise through a slow-breathing lowpass.
    if (noiseBuf) {
      const src = ctx.createBufferSource();
      src.buffer = noiseBuf;
      src.loop = true;
      const filt = ctx.createBiquadFilter();
      filt.type = "lowpass";
      filt.frequency.value = 240;
      filt.Q.value = 0.4;
      const g = ctx.createGain();
      g.gain.value = 0.045;
      // Slow 11 s LFO on the filter for a "breathing" wind.
      const lfo = ctx.createOscillator();
      lfo.frequency.value = 1 / 11;
      const lfoGain = ctx.createGain();
      lfoGain.gain.value = 90;
      lfo.connect(lfoGain).connect(filt.frequency);
      lfo.start();
      src.connect(filt).connect(g).connect(ambGain);
      src.start();
    }
    // Detuned low pair: 55 + 55.7 Hz → 0.7 Hz beating room hum.
    for (const [f, g0] of [[55, 0.02], [55.7, 0.018]] as const) {
      const osc = ctx.createOscillator();
      osc.type = "sine";
      osc.frequency.value = f;
      const g = ctx.createGain();
      g.gain.value = g0;
      osc.connect(g).connect(ambGain);
      osc.start();
    }
    // Fade in over 2.5 s.
    ambGain.gain.setValueAtTime(0, ctx.currentTime);
    ambGain.gain.linearRampToValueAtTime(1, ctx.currentTime + 2.5);
  };

  return {
    unlock() {
      if (!ctx) {
        const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
        if (!AC) return;
        ctx = new AC();
        master = ctx.createGain();
        master.gain.value = volMaster;
        master.connect(ctx.destination);
        sfx = ctx.createGain();
        sfx.connect(master);
        // One shared white-noise buffer for all gun voices + ambience.
        noiseBuf = ctx.createBuffer(1, ctx.sampleRate * 0.5, ctx.sampleRate);
        const data = noiseBuf.getChannelData(0);
        for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
        startAmbience();
      }
      ensure();
    },
    setVolumes(m, s) {
      volMaster = m;
      volSfx = s;
      if (master) master.gain.value = m;
      // Per-sound gains multiply volSfx at play time; bus gain stays 1.
    },
    applySettings(s) {
      volMaster = s.masterVolume;
      volSfx = s.sfxVolume;
      if (master) master.gain.value = s.masterVolume;
    },
    updateListener(px, py, pz, fx, fy, fz) {
      lx = px;
      ly = py;
      lz = pz;
      if (!ctx) return;
      const l = ctx.listener;
      if (l.positionX) {
        l.positionX.value = px;
        l.positionY.value = py;
        l.positionZ.value = pz;
        l.forwardX.value = fx;
        l.forwardY.value = fy;
        l.forwardZ.value = fz;
        l.upX.value = 0;
        l.upY.value = 1;
        l.upZ.value = 0;
      } else {
        const legacy = l as unknown as {
          setPosition(x: number, y: number, z: number): void;
          setOrientation(fx: number, fy: number, fz: number, ux: number, uy: number, uz: number): void;
        };
        legacy.setPosition(px, py, pz);
        legacy.setOrientation(fx, fy, fz, 0, 1, 0);
      }
    },
    shot(defId) {
      const v = GUN_VOICES[defId];
      play((dest, when) => {
        // Crack: bright transient. Body: mid bandpass. Thump: sub tail.
        noise(dest, when, v.noise * 0.45, 5200, 0.6, 0.75);
        noise(dest, when, v.noise, v.body * 6, 0.8, 0.85);
        tone(dest, when, "sine", v.body, v.body * 0.4, v.thump, v.noise * 0.9);
        // Mechanical action tick, 30 ms after the report.
        tone(dest, when, "square", 2600, 2000, 0.05, 0.02, 0.03);
      }, v.noise + 0.08);
    },
    shotAt(defId, x, y, z) {
      const v = GUN_VOICES[defId];
      play3d((dest, when) => {
        noise(dest, when, v.noise, v.body * 6, 0.8, 0.9);
        tone(dest, when, "sine", v.body, v.body * 0.4, v.thump, v.noise * 0.9);
      }, v.noise + 0.05, x, y, z, 0.85);
    },
    footstepAt(x, z, sprint) {
      const dist = Math.hypot(x - lx, z - lz);
      const gain = sprint ? 0.26 : 0.17;
      const step = (dest: AudioNode, when: number): void => {
        // Heel scuff: mid bandpass + a soft low knock. ±18% pitch jitter.
        const jitter = 0.82 + Math.random() * 0.36;
        noise(dest, when, 0.05, 850 * jitter, 1.4, 1);
        tone(dest, when, "sine", 130 * jitter, 70, 0.35, 0.045);
      };
      if (dist <= 1.2) {
        play(step, 0.07); // own feet — audible, centered, understated
      } else {
        play3d(step, 0.07, x, 0.05, z, gain);
      }
    },
    landed(severity) {
      play((dest, when) => {
        tone(dest, when, "sine", 110, 48, 0.4 * severity + 0.1, 0.12);
        noise(dest, when, 0.07, 500, 1, 0.3 * severity + 0.05);
      }, 0.14);
    },
    dryFire() {
      play((dest, when) => tone(dest, when, "square", 1800, 1400, 0.08, 0.025), 0.03);
    },
    weaponSwitch() {
      play((dest, when) => {
        tone(dest, when, "square", 1400, 900, 0.06, 0.025);
        noise(dest, when, 0.04, 4200, 2, 0.12);
        tone(dest, when, "square", 900, 650, 0.07, 0.03, 0.09);
      }, 0.14);
    },
    hitmarker(kill) {
      play((dest, when) => {
        tone(dest, when, "square", kill ? 1500 : 2200, kill ? 1500 : 2200, 0.18, 0.04);
        if (kill) tone(dest, when, "square", 2000, 2600, 0.16, 0.09, 0.05);
      }, kill ? 0.16 : 0.05);
    },
    hurt() {
      play((dest, when) => tone(dest, when, "sine", 140, 70, 0.5, 0.12), 0.13);
    },
    death() {
      play((dest, when) => tone(dest, when, "sawtooth", 220, 55, 0.35, 0.5), 0.52);
    },
    respawn() {
      play((dest, when) => {
        tone(dest, when, "triangle", 440, 440, 0.2, 0.09);
        tone(dest, when, "triangle", 660, 660, 0.2, 0.12, 0.08);
      }, 0.22);
    },
    reload() {
      play((dest, when) => {
        noise(dest, when, 0.05, 3000, 2, 0.25);
        noise(dest, when, 0.06, 1900, 2, 0.22);
        tone(dest, when, "square", 800, 500, 0.05, 0.02, 0.11);
      }, 0.18);
    },
    uiClick() {
      play((dest, when) => tone(dest, when, "square", 900, 700, 0.12, 0.03), 0.04);
    },
    matchStart() {
      play((dest, when) => {
        tone(dest, when, "triangle", 330, 330, 0.25, 0.12);
        tone(dest, when, "triangle", 440, 440, 0.25, 0.12, 0.12);
        tone(dest, when, "triangle", 550, 550, 0.3, 0.2, 0.24);
      }, 0.5);
    },
    matchEnd(won) {
      play((dest, when) => {
        if (won) {
          tone(dest, when, "triangle", 523, 523, 0.28, 0.14);
          tone(dest, when, "triangle", 659, 659, 0.28, 0.14, 0.14);
          tone(dest, when, "triangle", 784, 784, 0.3, 0.3, 0.28);
        } else {
          tone(dest, when, "triangle", 392, 392, 0.26, 0.16);
          tone(dest, when, "triangle", 311, 311, 0.26, 0.16, 0.16);
          tone(dest, when, "triangle", 233, 233, 0.28, 0.34, 0.32);
        }
      }, 0.7);
    },
    dispose() {
      if (ctx) void ctx.close();
      ctx = null;
      master = null;
      sfx = null;
      ambGain = null;
    },
  };
}
