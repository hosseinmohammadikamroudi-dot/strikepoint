/**
 * Entry point — app shell + fixed-timestep simulation (60 Hz) with a
 * decoupled, interpolated render loop. Spiral-of-death guard: if the frame
 * budget collapses (tab switch), drop time instead of piling up ticks.
 *
 * Phase 4: menu ↔ match state machine. The world only steps while a match
 * is live (menu/settings/match-end screens pause it); matches start from
 * the UI, end into the XP screen, and the career profile persists to
 * localStorage. Map rotation still advances within a match chain.
 */
import * as THREE from "three";
import { TICK_RATE } from "./sim/math";
import { World } from "./sim/world";
import { createInputSnapshot, endTick, addMouse, press, release } from "./sim/input";
import { DEFAULT_MATCH, type MatchDef } from "./sim/match";
import { attachInput } from "./view/inputBridge";
import { createRenderView } from "./view/renderView";
import { buildScene, disposeScene, type SceneBundle } from "./view/scene";
import { createAudioView, type AudioView } from "./view/audio";
import { loadSettings, saveSettings, memoryStorage, QUALITY_SCALE, type KVStore, type Settings } from "./ui/settings";
import { loadProfile, type Profile } from "./ui/save";
import { createTelemetry } from "./telemetry/telemetry";
import { Ui } from "./ui/menus";

const canvas = document.querySelector<HTMLCanvasElement>("#app")!;
const hud = {
  health: document.querySelector<HTMLElement>("#hud-health")!,
  healthFill: document.querySelector<HTMLElement>("#hud-healthfill")!,
  ammo: document.querySelector<HTMLElement>("#hud-ammo")!,
  accuracy: document.querySelector<HTMLElement>("#hud-accuracy")!,
  fps: document.querySelector<HTMLElement>("#hud-fps")!,
  backend: document.querySelector<HTMLElement>("#hud-backend")!,
  reload: document.querySelector<HTMLElement>("#hud-reload")!,
  hitmarker: document.querySelector<HTMLElement>("#hitmarker")!,
  slots: [
    document.querySelector<HTMLElement>("#slot-0")!,
    document.querySelector<HTMLElement>("#slot-1")!,
    document.querySelector<HTMLElement>("#slot-2")!,
    document.querySelector<HTMLElement>("#slot-3")!,
  ],
  vignette: document.querySelector<HTMLElement>("#vignette")!,
  death: document.querySelector<HTMLElement>("#death")!,
  deathTimer: document.querySelector<HTMLElement>("#death-timer")!,
  scope: document.querySelector<HTMLElement>("#scope")!,
  crosshair: document.querySelector<HTMLElement>("#crosshair")!,
  matchInfo: document.querySelector<HTMLElement>("#hud-match")!,
  feed: document.querySelector<HTMLElement>("#killfeed")!,
  scoreboardBox: document.querySelector<HTMLElement>("#scoreboard")!,
  scoreboard: document.querySelector<HTMLElement>("#scoreboard-rows")!,
};

/** Map rotation pool: mode × map combinations (ROADMAP Phase 3). */
const MAP_POOL: MatchDef[] = [
  { ...DEFAULT_MATCH, map: "ringhold", mode: "tdm" },
  { ...DEFAULT_MATCH, map: "foundry", mode: "ffa" },
  { ...DEFAULT_MATCH, map: "longyard", mode: "tdm" },
];

// Hold Tab (or a death / match end) to show the scoreboard.
let showScoreboard = false;
window.addEventListener("keydown", (e) => {
  if (e.code === "Tab") {
    e.preventDefault();
    showScoreboard = true;
  }
});
window.addEventListener("keyup", (e) => {
  if (e.code === "Tab") showScoreboard = false;
});

async function boot(): Promise<void> {
  // --- Persistence (Phase 4): real localStorage, memory fallback ---
  const store: KVStore = (() => {
    try {
      const probe = "__sp_probe__";
      window.localStorage.setItem(probe, "1");
      window.localStorage.removeItem(probe);
      return window.localStorage;
    } catch {
      return memoryStorage();
    }
  })();
  const settings: Settings = loadSettings(store);
  saveSettings(store, settings);
  const profile: Profile = loadProfile(store);

  const audio: AudioView = createAudioView();
  audio.applySettings(settings);

  // --- Session telemetry (Phase 6) + perf watchdog ---
  const telemetry = createTelemetry();
  let matchStartMs = performance.now();
  let lastFpsSample = 0;
  let lowFpsTicks = 0; // consecutive seconds below the floor
  let autoDowngraded = false; // only ever auto-downgrade once per session

  const input = createInputSnapshot();
  const bridge = attachInput(canvas, input);
  const camera = new THREE.PerspectiveCamera(settings.fov, 1, 0.05, 200);
  const view = await createRenderView(canvas, camera, settings, hud);

  // --- World/scene pair (rebuilt per match) ---
  let matchIdx = 0;
  let world = new World({ seed: 1, bots: false });
  let bundle: SceneBundle = buildScene(world, camera);
  view.setWorld(world, bundle);
  const releaseWorld = (): void => {
    disposeScene(bundle);
  };

  // --- Dev-only debug handles (stripped from prod builds) ---
  if (import.meta.env.DEV) {
    const w = window as unknown as { __world?: World; __debug?: object };
    w.__world = world;
    w.__debug = { world, input, addMouse, press, release, matchPool: MAP_POOL };
  }

  const ui = new Ui({
    store,
    audio,
    settings,
    profile,
    telemetry,
    startMatch() {
      audio.unlock();
      const def = MAP_POOL[matchIdx]!;
      matchStartMs = performance.now();
      world = new World({
        seed: ((Date.now() & 0x7fffffff) | 1) + matchIdx,
        match: def,
        look: { sensMult: settings.sensitivity, invertY: settings.invertY },
      });
      const nextBundle = buildScene(world, camera);
      view.setWorld(world, nextBundle); // render the NEW scene…
      disposeScene(bundle); // …then free the old one (order matters!)
      bundle = nextBundle;
      if (import.meta.env.DEV) {
        (window as unknown as { __world?: World }).__world = world;
      }
      matchEnded = false;
      inMatch = true;
      ui.showScreen("none");
      resumeLock(); // real lock if possible, cursor-follow fallback otherwise
      audio.matchStart();
    },
    quitToMenu() {
      audio.uiClick();
      if (document.pointerLockElement) document.exitPointerLock();
      releaseWorld();
      world = new World({ seed: 2, bots: false });
      view.setWorld(world, buildScene(world, camera));
      if (import.meta.env.DEV) {
        (window as unknown as { __world?: World }).__world = world;
      }
      matchEnded = false;
      inMatch = false;
      ui.showScreen("menu");
      ui.renderCareer();
    },
    applySettings(s) {
      saveSettings(store, s);
      view.setSettings(s);
      audio.setVolumes(s.masterVolume, s.sfxVolume);
      // Look config applies to the live match too, not just the next one.
      world.setLook({ sensMult: s.sensitivity, invertY: s.invertY });
    },
  });

  // In-match vs paused — the overlay doubles as the pause screen.
  let inMatch = false;

  // --- Pointer-lock strategy (fixes the "stuck on a black overlay" bug) ---
  // Prefer a real lock; if a request fails (sandboxed iframes, some
  // webviews, user gesture rules), fall back to cursor-follow look instead
  // of trapping the player on a dead click-to-play screen.
  let lockSupported = true; // flips off permanently after a failed request
  bridge.onLockError(() => {
    lockSupported = false;
    bridge.setFallbackLook(true);
    if (ui.current === "pause") ui.showScreen("none"); // don't pause-trap
    ui.toast("Pointer lock unavailable — aim follows the mouse cursor. Esc pauses.");
  });
  /** (Re)enter live input: real lock when supported, cursor-follow otherwise. */
  const resumeLock = (): void => {
    if (lockSupported) bridge.requestLock();
    else bridge.setFallbackLook(true);
  };
  // Losing an acquired lock (Esc / focus loss) mid-match pauses.
  bridge.onUnlocked(() => {
    if (inMatch && ui.current === "none" && !matchEnded) ui.showScreen("pause");
  });
  // Esc explicitly pauses even without a lock (fallback mode).
  document.addEventListener("keydown", (e) => {
    if (e.code === "Escape" && inMatch && !matchEnded && ui.current === "none") {
      ui.showScreen("pause");
    }
  });
  // Click on the pause overlay resumes: retry the lock (real-lock mode) or
  // just drop the overlay (fallback mode). Clicks while playing are game
  // input — the overlay no longer exists then, so no dead click-to-play.
  document.querySelector<HTMLElement>("#overlay")!.addEventListener("click", () => {
    if (ui.current === "pause") {
      if (lockSupported) bridge.requestLock();
      else ui.showScreen("none");
    }
  });

  // --- Match-end → XP flow ---
  // Stage 1 (detect, per tick): match goes "over" → start an 8 s victory lap
  // (the sim keeps running; the scoreboard shows via the over-phase HUD).
  // Stage 2 (real time): lap ends → exit lock, show the XP screen.
  let matchEnded = false;
  let endShown = false;
  let endAtMs = 0;

  const showEndScreen = (): void => {
    if (endShown) return;
    endShown = true;
    if (document.pointerLockElement) document.exitPointerLock();
    const m = world.match;
    const me = m.scores.get(0)!;
    let won: boolean;
    let summary: string;
    if (m.def.mode === "tdm") {
      let blue = 0;
      let red = 0;
      for (const e of m.scores.values()) {
        if (e.team === 0) blue += e.kills;
        else if (e.team === 1) red += e.kills;
      }
      won = blue > red;
      summary = `Blue ${blue} — ${red} Red`;
    } else {
      let topScore = 0;
      let topId = 0;
      for (const e of m.scores.values()) {
        if (e.kills > topScore) {
          topScore = e.kills;
          topId = e.id;
        }
      }
      won = topId === 0;
      summary = `top ${topScore} kills (${m.scores.get(topId)?.name ?? "?"})`;
    }
    ui.showMatchEnd({
      won,
      mode: m.def.mode,
      map: m.def.map,
      kills: me.kills,
      deaths: me.deaths,
      headshots: me.headshots,
      shotsFired: world.shotsFired,
      shotsHit: world.shotsHit,
      weaponAcc: world.weapons.map((wp, i) => ({
        id: wp.defId,
        fired: world.weaponShotsFired[i]!,
        hit: world.weaponShotsHit[i]!,
      })),
      summary,
    });
    // Telemetry: archive the match record for the session dashboard.
    telemetry.recordMatch({
      mode: m.def.mode,
      map: m.def.map,
      won,
      kills: me.kills,
      deaths: me.deaths,
      headshots: me.headshots,
      shotsFired: world.shotsFired,
      shotsHit: world.shotsHit,
      durationS: (performance.now() - matchStartMs) / 1000,
    });
    matchIdx = (matchIdx + 1) % MAP_POOL.length;
    const next = MAP_POOL[matchIdx]!;
    document.querySelector<HTMLButtonElement>("#btn-again")!.textContent =
      `NEXT — ${next.mode.toUpperCase()} · ${next.map.toUpperCase()}`;
    document.querySelector<HTMLButtonElement>("#btn-play")!.textContent =
      `PLAY — ${next.mode.toUpperCase()} · ${next.map.toUpperCase()}`;
  };

  const STEP = 1 / TICK_RATE;
  const MAX_CATCHUP_TICKS = 5;
  let acc = 0;
  let last = performance.now();
  const listenerFwd = new THREE.Vector3(); // reused; no per-frame alloc

  // --- Sim-event → audio routing (view consumes events; never mutates sim) ---
  const lastWeaponId = (): Parameters<AudioView["shot"]>[0] => world.weapon.defId;
  const routeAudio = (): void => {
    for (const e of world.events) {
      if (e.kind === "shot") {
        if (e.shot.first) audio.shot(lastWeaponId()); // once per trigger pull
      } else if (e.kind === "botShot") {
        // Positional enemy fire: panned, attenuated, muffled by distance.
        // (Bots never fire pellets — one BotShot is one trigger pull.)
        audio.shotAt(e.shot.defId, e.shot.ox, e.shot.oy, e.shot.oz);
      } else if (e.kind === "footstep") {
        audio.footstepAt(e.x, e.z, e.sprint);
      } else if (e.kind === "landed") {
        audio.landed(e.severity);
      } else if (e.kind === "hit" || (e.kind === "botHit" && e.byPlayer)) {
        audio.hitmarker(false);
      } else if (e.kind === "kill" || e.kind === "killHeadshot" || (e.kind === "botKill" && e.byPlayer)) {
        audio.hitmarker(true);
      } else if (e.kind === "playerHit") {
        audio.hurt();
      } else if (e.kind === "playerDied") {
        audio.death();
      } else if (e.kind === "playerRespawned") {
        audio.respawn();
      } else if (e.kind === "reloadStart") {
        audio.reload();
      } else if (e.kind === "dryFire") {
        audio.dryFire();
      } else if (e.kind === "switch") {
        audio.weaponSwitch();
      }
    }
  };

  const frame = (now: number): void => {
    requestAnimationFrame(frame);
    const screenUp = ui.blocksMatch;
    // Keyboard/fire input is gated on being live: menus, settings and the
    // match-end screen never leak keys into the sim (fallback look mode
    // otherwise keeps the canvas listening behind them).
    bridge.setActive(!screenUp && inMatch && !matchEnded);
    let frameTime = (now - last) / 1000;
    last = now;
    if (frameTime > 0.25) frameTime = 0.25; // tab-switch clamp

    // Pause the sim behind any full-screen UI (menu / settings / match end).
    if (screenUp) {
      world.alpha = 1;
      view.render(now, false);
      return;
    }
    acc += frameTime;

    let ticks = 0;
    while (acc >= STEP && ticks < MAX_CATCHUP_TICKS) {
      view.onSimTick(); // snapshot interpolation source
      bridge.refresh(); // re-assert held actions
      world.step(input); // one deterministic 60 Hz tick
      endTick(input); // clear edge-triggered actions
      routeAudio(); // sim events → synthesized SFX
      acc -= STEP;
      ticks++;

      // --- Match end: stage 1 (victory-lap timer; screen shows later) ---
      if (world.match.phase === "over" && !matchEnded) {
        matchEnded = true;
        endShown = false;
        endAtMs = performance.now() + 8000;
      }
    }
    if (ticks === MAX_CATCHUP_TICKS) acc = 0; // spiral guard

    // --- Match end: stage 2 (real-time lap expiry → XP screen) ---
    if (matchEnded && !endShown && performance.now() >= endAtMs) showEndScreen();

    world.alpha = acc / STEP;
    view.render(now, showScoreboard);

    // Audio listener follows the render camera (post-render pose).
    camera.getWorldDirection(listenerFwd);
    audio.updateListener(
      camera.position.x,
      camera.position.y,
      camera.position.z,
      listenerFwd.x,
      listenerFwd.y,
      listenerFwd.z,
    );

    // --- Telemetry sampling (1 Hz) + auto-quality watchdog (Phase 6) ---
    const atS = now / 1000;
    if (atS - lastFpsSample >= 1) {
      lastFpsSample = atS;
      const fps = view.fps.liveFps();
      telemetry.sampleFps(fps, atS);
      // Sustained sub-45 fps while actually playing → drop one quality tier,
      // once per session (never yo-yos; the player can re-raise it manually).
      if (
        !autoDowngraded &&
        !screenUp &&
        atS > 20 && // ignore boot warmup
        fps > 0 &&
        fps < 45
      ) {
        lowFpsTicks++;
        if (lowFpsTicks >= 8) {
          autoDowngraded = true;
          const nextQuality: Settings["quality"] =
            settings.quality === "high" ? "medium" : "low";
          settings.quality = nextQuality;
          settings.resolutionScale = QUALITY_SCALE[nextQuality];
          view.setSettings(settings);
          ui.syncSettings();
        }
      } else {
        lowFpsTicks = 0;
      }
    }
  };
  requestAnimationFrame(frame);
}

void boot();
