/**
 * RenderView — per-frame presentation of sim state. Interpolates the camera
 * between the previous and current sim tick (fixed 60 Hz sim, variable render
 * rate), drives viewmodel/tracers/dummy visuals, updates the HUD. Reads state
 * and consumes events only — never mutates sim data.
 */
import * as THREE from "three";
import { WebGPURenderer } from "three/webgpu";
import type { World } from "../sim/world";
import { EYE_HEIGHT } from "../sim/level";
import { MAX_HP } from "../sim/player";
import { angleDelta } from "../sim/math";
import { FpsMeter } from "../perf/fpsMeter";
import type { Settings } from "../ui/settings";
import { type SceneBundle } from "./scene";
import { createViewmodel, type Viewmodel } from "./viewmodel";

export interface RenderView {
  /** Swap in the current world + freshly built scene (map rotation). */
  setWorld(world: World, bundle: SceneBundle): void;
  /** Live-apply graphics settings (fov, resolution scale). */
  setSettings(s: Settings): void;
  /** `showScoreboard` renders the leaderboard (Tab held / death / match end). */
  render(nowMs: number, showScoreboard: boolean): void;
  /** Call immediately BEFORE each sim tick to snapshot interpolation source. */
  onSimTick(): void;
  dispose(): void;
  readonly fps: FpsMeter;
  readonly backend: "webgpu" | "webgl2";
}

export async function createRenderView(
  canvas: HTMLCanvasElement,
  camera: THREE.PerspectiveCamera,
  settings: Settings,
  hud: {
    health: HTMLElement;
    healthFill: HTMLElement;
    ammo: HTMLElement;
    accuracy: HTMLElement;
    fps: HTMLElement;
    backend: HTMLElement;
    reload: HTMLElement;
    hitmarker: HTMLElement;
    slots: HTMLElement[];
    vignette: HTMLElement;
    death: HTMLElement;
    deathTimer: HTMLElement;
    scope: HTMLElement;
    crosshair: HTMLElement;
    matchInfo: HTMLElement;
    feed: HTMLElement;
    /** Scoreboard box (opacity toggle). */
    scoreboardBox: HTMLElement;
    /** Scoreboard rows container (innerHTML). */
    scoreboard: HTMLElement;
  },
): Promise<RenderView> {
  const renderer = new WebGPURenderer({ canvas, antialias: true });
  await renderer.init();

  // Match the drawing buffer to the window × resolution scale. `updateStyle`
  // stays false so the CSS keeps the canvas at full window size while the
  // buffer renders at the scaled resolution (perf knob).
  const resize = (): void => {
    const w = window.innerWidth;
    const h = window.innerHeight;
    renderer.setSize(Math.round(w * settings.resolutionScale), Math.round(h * settings.resolutionScale), false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  };
  resize();
  window.addEventListener("resize", resize);
  // `backend` is not in the public type surface; probe defensively (as Phase 0).
  const backend: "webgpu" | "webgl2" = (
    renderer as unknown as { backend?: { isWebGPUBackend?: boolean } }
  ).backend?.isWebGPUBackend
    ? "webgpu"
    : "webgl2";

  // Mutable world/scene pair — swapped by setWorld on map rotation.
  let currentWorld: World | null = null;
  let bundle: SceneBundle | null = null;
  let dummies: SceneBundle["dummies"] = [];
  // Bot interpolation snapshots (prev tick transforms).
  let botPrev: { x: number; y: number; z: number; yaw: number }[] = [];

  const fps = new FpsMeter({ windowMs: 500 });
  let lastNow = -1;
  let bobPhase = 0;
  let flashTimer = 0;
  let hitmarkerTimer = 0;
  let lastKick = 0;
  let damageGlow = 0;
  let dipOffset = 0; // landing camera dip (springs back)
  // Hip FOV from settings (ADS zoom still comes from the weapon def).
  const baseFov = (): number => settings.fov;

  const dummyFlashMats = new Map<number, THREE.MeshStandardMaterial>();
  const botFlashMats = new Map<number, THREE.MeshStandardMaterial>();
  const viewmodel: Viewmodel = createViewmodel(camera);

  // Interpolation snapshots (per-world; re-seeded in setWorld).
  const prevPos = new THREE.Vector3();
  const currPos = new THREE.Vector3();
  let prevYaw = 0;
  let currYaw = 0;
  let prevPitch = 0;
  let currPitch = 0;
  let prevRecoilP = 0;
  let currRecoilP = 0;
  let prevRecoilY = 0;
  let currRecoilY = 0;

  return {
    fps,
    backend,
    setSettings(s) {
      const resChanged = s.resolutionScale !== settings.resolutionScale;
      // Mutate the caller's settings object in place (single source of truth).
      Object.assign(settings, s);
      if (resChanged) resize();
    },
    setWorld(world, nextBundle) {
      currentWorld = world;
      bundle = nextBundle;
      dummies = nextBundle.dummies;
      botPrev = nextBundle.bots.map((v) => ({ x: v.b.x, y: v.b.y, z: v.b.z, yaw: v.b.yaw }));
      // Reset interpolation source to the new world's spawn state.
      const p = world.player;
      prevPos.set(p.x, p.y, p.z);
      currPos.copy(prevPos);
      prevYaw = currYaw = p.yaw;
      prevPitch = currPitch = p.pitch;
      prevRecoilP = currRecoilP = p.recoilPitch;
      prevRecoilY = currRecoilY = p.recoilYaw;
    },
    onSimTick(): void {
      if (!currentWorld) return;
      const p = currentWorld.player;
      prevPos.set(p.x, p.y, p.z);
      prevYaw = p.yaw;
      prevPitch = p.pitch;
      prevRecoilP = p.recoilPitch;
      prevRecoilY = p.recoilYaw;
      for (let i = 0; i < botPrev.length; i++) {
        const b = bundle?.bots[i]?.b;
        const prev = botPrev[i];
        if (!b || !prev) continue;
        prev.x = b.x;
        prev.y = b.y;
        prev.z = b.z;
        prev.yaw = b.yaw;
      }
    },
    render(nowMs: number, showScoreboard: boolean): void {
      const world = currentWorld;
      if (!world || !bundle) return;
      const dt = lastNow < 0 ? 0 : (nowMs - lastNow) / 1000;
      lastNow = nowMs;
      if (dt > 0) fps.update(dt * 1000);

      const p = world.player;

      // --- Consume events ---
      let landKick = 0; // strongest landing this tick (viewmodel dip)
      let camDip = 0; // camera dip severity (strongest this tick)
      for (const e of world.events) {
        if (e.kind === "shot") {
          bundle.spawnTracer(e.shot.ox, e.shot.oy, e.shot.oz, e.shot.dx, e.shot.dy, e.shot.dz, e.shot.levelT);
          if (e.shot.first) {
            // Flash sits ahead of the eye along the bore — at the origin it
            // would straddle the near plane and fill the screen.
            const big = world.weapon.defId === "mule" || world.weapon.defId === "longview";
            bundle.spawnMuzzle(
              e.shot.ox + e.shot.dx * 0.55,
              e.shot.oy + e.shot.dy * 0.55 - 0.1,
              e.shot.oz + e.shot.dz * 0.55,
              big,
            );
            lastKick = 1;
          }
          // Wall spark: the shot's level hit (flesh puffs come from hit
          // events; both may appear when a target stands before a wall).
          if (e.shot.levelT < 300) {
            bundle.spawnImpact(
              e.shot.ox + e.shot.dx * e.shot.levelT,
              e.shot.oy + e.shot.dy * e.shot.levelT,
              e.shot.oz + e.shot.dz * e.shot.levelT,
              -e.shot.dx,
              -e.shot.dy,
              -e.shot.dz,
              "wall",
            );
          }
        } else if (e.kind === "botShot") {
          bundle.spawnTracer(e.shot.ox, e.shot.oy, e.shot.oz, e.shot.dx, e.shot.dy, e.shot.dz, e.shot.levelT);
          bundle.spawnMuzzle(
            e.shot.ox + e.shot.dx * 0.35,
            e.shot.oy + e.shot.dy * 0.35 - 0.05,
            e.shot.oz + e.shot.dz * 0.35,
            e.shot.defId === "mule" || e.shot.defId === "longview",
          );
          if (e.shot.levelT < 300) {
            bundle.spawnImpact(
              e.shot.ox + e.shot.dx * e.shot.levelT,
              e.shot.oy + e.shot.dy * e.shot.levelT,
              e.shot.oz + e.shot.dz * e.shot.levelT,
              -e.shot.dx,
              -e.shot.dy,
              -e.shot.dz,
              "wall",
            );
          }
        } else if (e.kind === "landed") {
          camDip = Math.max(camDip, e.severity);
          landKick = Math.max(landKick, e.severity);
        } else if (e.kind === "hit") {
          bundle.spawnImpact(e.ix, e.iy, e.iz, e.dx, e.dy, e.dz, "flesh");
          flashTimer = 0.09;
          hitmarkerTimer = 0.12;
          if (e.zone === "head") hud.hitmarker.style.borderColor = "#ff6b35";
          else hud.hitmarker.style.borderColor = "#e8edf4";
        } else if (e.kind === "kill") {
          hud.hitmarker.style.borderColor = "#ff3b30";
          hitmarkerTimer = 0.25;
        } else if (e.kind === "killHeadshot") {
          hud.hitmarker.style.borderColor = "#ff3b30";
          hitmarkerTimer = 0.3;
        } else if (e.kind === "reloadStart") {
          hud.reload.style.opacity = "1";
        } else if (e.kind === "switch") {
          viewmodel.setWeapon(e.id);
        } else if (e.kind === "botHit") {
          if (!e.byPlayer) continue;
          bundle.spawnImpact(e.ix, e.iy, e.iz, e.dx, e.dy, e.dz, "flesh");
          hitmarkerTimer = 0.12;
          if (e.zone === "head") hud.hitmarker.style.borderColor = "#ff6b35";
          else hud.hitmarker.style.borderColor = "#e8edf4";
        } else if (e.kind === "botKill") {
          if (!e.byPlayer) continue;
          hud.hitmarker.style.borderColor = "#ff3b30";
          hitmarkerTimer = 0.25;
        } else if (e.kind === "playerHit") {
          damageGlow = Math.min(1, damageGlow + e.damage / 60);
        } else if (e.kind === "playerDied") {
          damageGlow = 1;
        } else if (e.kind === "playerRespawned") {
          damageGlow = 0;
        }
      }

      // --- Dummy visuals ---
      for (const dv of dummies) {
        const alive = dv.d.status === "alive";
        dv.group.visible = alive;
        if (alive && dv.d.hitFlashTicks > 0) {
          let mat = dummyFlashMats.get(dv.d.id);
          if (!mat) {
            mat = new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xffffff, emissiveIntensity: 0.8 });
            dummyFlashMats.set(dv.d.id, mat);
          }
          dv.body.material = mat;
          dv.head.material = mat;
        } else {
          dv.body.material = DUMMY_MAT;
          dv.head.material = DUMMY_HEAD_MAT;
        }
      }

      const a = world.alpha;

      // --- Bot visuals: interpolated transforms, flash, death visibility ---
      for (let i = 0; i < bundle.bots.length; i++) {
        const bv = bundle.bots[i]!;
        const prev = botPrev[i]!;
        const alive = bv.b.mode !== "dead";
        bv.group.visible = alive;
        if (!alive) continue;
        const bx = prev.x + (bv.b.x - prev.x) * a;
        const by = prev.y + (bv.b.y - prev.y) * a;
        const bz = prev.z + (bv.b.z - prev.z) * a;
        bv.group.position.set(bx, by, bz);
        const byaw = prev.yaw + angleDelta(prev.yaw, bv.b.yaw) * a;
        bv.group.rotation.y = byaw;
        if (bv.b.hitFlashTicks > 0) {
          let mat = botFlashMats.get(bv.b.id);
          if (!mat) {
            mat = new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xffffff, emissiveIntensity: 0.8 });
            botFlashMats.set(bv.b.id, mat);
          }
          bv.body.material = mat;
        } else {
          bv.body.material = bv.baseMat;
        }
      }

      // --- Camera: interpolate between prev and curr sim transforms ---
      currPos.set(p.x, p.y, p.z);
      currYaw = p.yaw;
      currPitch = p.pitch;
      currRecoilP = p.recoilPitch;
      currRecoilY = p.recoilYaw;
      const ix = prevPos.x + (currPos.x - prevPos.x) * a;
      const iy = prevPos.y + (currPos.y - prevPos.y) * a;
      const iz = prevPos.z + (currPos.z - prevPos.z) * a;
      const iyaw = prevYaw + (currYaw - prevYaw) * a;
      const ipitch = prevPitch + (currPitch - prevPitch) * a;
      const irecoilP = prevRecoilP + (currRecoilP - prevRecoilP) * a;
      const irecoilY = prevRecoilY + (currRecoilY - prevRecoilY) * a;

      // Crouch lowers the eye smoothly — stance is binary in the sim.
      // Landing adds a severity-scaled dip that springs back (Phase 5).
      dipOffset = Math.max(dipOffset, -0.16 * camDip);
      dipOffset *= Math.exp(-7 * dt);
      const eye = EYE_HEIGHT - (p.stance === "crouch" ? 0.55 : 0);
      camera.position.set(ix, iy + eye + dipOffset, iz);
      camera.rotation.order = "YXZ";
      camera.rotation.set(ipitch + irecoilP, iyaw + irecoilY, 0);

      // --- Viewmodel: pose driven entirely by sim state (Phase 5) ---
      const speed01 = Math.min(1, Math.hypot(p.vx, p.vz) / 6.5);
      bobPhase += dt * speed01 * 11;
      const ads = world.weapon.adsAmount;
      const w = world.weapon;
      const reload01 = w.reloadTimer > 0 ? 1 - w.reloadTimer / w.def.reloadTime : null;
      const switch01 = w.switchTimer > 0 ? 1 - w.switchTimer / 0.4 : 1;
      viewmodel.update({
        dt,
        adsAmount: ads,
        kick: lastKick * 0.05,
        bobPhase,
        speed01,
        switch01,
        reload01,
        landKick,
        sprinting: p.sprinting,
      });
      lastKick = 0;

      // --- FOV zoom + scope overlay (settings fov ↔ weapon ADS zoom) ---
      const targetFov = baseFov() + (world.weapon.def.adsFov - baseFov()) * ads;
      if (Math.abs(camera.fov - targetFov) > 0.01) {
        camera.fov = targetFov;
        camera.updateProjectionMatrix();
      }
      const scoped = world.weapon.defId === "longview" && ads > 0.85;
      hud.scope.style.display = scoped ? "block" : "none";
      viewmodel.group.visible = !scoped;
      hud.crosshair.style.opacity = scoped ? "0" : String(1 - ads * 0.55);

      // --- Tracers fade + VFX advance ---
      bundle.fadeTracers(dt);
      bundle.updateFx(dt);

      // --- Timers/HUD ---
      flashTimer = Math.max(0, flashTimer - dt);
      hitmarkerTimer = Math.max(0, hitmarkerTimer - dt);
      damageGlow = Math.max(0, damageGlow - dt * 0.8);
      hud.hitmarker.style.opacity = hitmarkerTimer > 0 ? "1" : "0";
      hud.reload.style.opacity = world.weapon.reloadTimer > 0 ? "1" : "0";
      const dead = world.playerDead;
      hud.death.style.display = dead ? "flex" : "none";
      if (dead) hud.deathTimer.textContent = String(Math.ceil(world.respawnIn));
      const hp01 = Math.max(0, p.hp) / MAX_HP;
      hud.healthFill.style.width = `${(hp01 * 100).toFixed(1)}%`;
      hud.healthFill.style.background = hp01 > 0.6 ? "#6fd08c" : hp01 > 0.3 ? "#e8c547" : "#ff5a4e";
      hud.vignette.style.opacity = String(Math.min(1, Math.max(damageGlow, hp01 < 0.35 ? 0.5 : 0)));
      hud.health.textContent = `HP ${Math.ceil(p.hp)}`;
      hud.ammo.textContent = `${world.weapon.ammo} / ${world.weapon.def.magSize}`;
      hud.accuracy.textContent = `Acc ${world.shotsFired > 0 ? Math.round((world.shotsHit / world.shotsFired) * 100) : 0}%`;

      // --- Match HUD (Phase 3): header, kill feed, scoreboard ---
      const m = world.match;
      const tLeft = Math.max(0, Math.ceil(m.timer));
      const clock = `${Math.floor(tLeft / 60)}:${String(tLeft % 60).padStart(2, "0")}`;
      const ranked = [...m.scores.values()].sort((x, y) => y.kills - x.kills || x.id - y.id);
      if (m.phase === "countdown") {
        hud.matchInfo.textContent = `${m.def.mode.toUpperCase()} · starting in ${Math.ceil(m.timer)}s`;
      } else if (m.phase === "over") {
        const won = m.winner !== null && (m.winner.kind === "team" ? m.winner.team === 0 : m.winner.id === 0);
        hud.matchInfo.textContent = won ? "VICTORY" : "DEFEAT";
      } else if (m.def.mode === "tdm") {
        let blue = 0;
        let red = 0;
        for (const e of m.scores.values()) {
          if (e.team === 0) blue += e.kills;
          else if (e.team === 1) red += e.kills;
        }
        hud.matchInfo.textContent = `TDM ${clock} · Blue ${blue} — ${red} Red`;
      } else {
        const lead = ranked[0]!;
        hud.matchInfo.textContent = `FFA ${clock} · ${lead.name} ${lead.kills}`;
      }
      let feedHtml = "";
      for (const f of m.feed) {
        const k = m.scores.get(f.killerId)?.name ?? "?";
        const v = m.scores.get(f.victimId)?.name ?? "?";
        feedHtml += `<div>${k} ${f.headshot ? "⌖" : "»"} ${v}</div>`;
      }
      hud.feed.innerHTML = feedHtml;
      let rowsHtml = "";
      for (const r of ranked.slice(0, 6)) {
        rowsHtml += `<div class="sb-row${r.id === 0 ? " me" : ""}"><span>${r.name}</span><span>${r.kills}</span><span>${r.deaths}</span></div>`;
      }
      hud.scoreboard.innerHTML = rowsHtml;
      hud.scoreboardBox.style.opacity =
        showScoreboard || dead || m.phase === "over" ? "1" : "0";
      for (let i = 0; i < hud.slots.length; i++) {
        hud.slots[i]!.classList.toggle("active", i === world.activeSlot);
      }
      hud.fps.textContent = `${fps.liveFps().toFixed(0)} FPS`;
      hud.backend.textContent = backend === "webgpu" ? "WebGPU" : "WebGL2";

      renderer.render(bundle.scene, camera);
    },
    dispose() {
      window.removeEventListener("resize", resize);
      renderer.dispose();
    },
  };
}

const DUMMY_MAT = new THREE.MeshStandardMaterial({ color: 0x8b93a3, roughness: 0.7 });
const DUMMY_HEAD_MAT = new THREE.MeshStandardMaterial({ color: 0xb9c0cc, roughness: 0.55 });
