/**
 * Scene builder — greybox meshes from sim level data, dummy meshes, tracer
 * pool. Single source of truth: geometry comes from `world.level`.
 */
import * as THREE from "three";
import type { World } from "../sim/world";
import type { Dummy } from "../sim/dummy";
import type { Bot, BotArchetype } from "../sim/bot";
import { createHumanoid, humanoidPalette, type Humanoid } from "./humanoid";

export const COL_BG = 0x15181e;

export interface DummyVisual {
  humanoid: Humanoid;
  d: Dummy;
}

export interface BotVisual {
  humanoid: Humanoid;
  b: Bot;
  /** Base shirt color (team/archetype read) for flash restore. */
  shirt: number;
}

export interface SceneBundle {
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  dummies: DummyVisual[];
  bots: BotVisual[];
  spawnTracer(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, t: number): void;
  fadeTracers(dt: number): void;
  /** Muzzle flash quad + shared flash light at a shot origin. */
  spawnMuzzle(x: number, y: number, z: number, big: boolean): void;
  /** Impact flash: wall spark / flesh puff / death dust by palette. */
  spawnImpact(x: number, y: number, z: number, dx: number, dy: number, dz: number, kind: "wall" | "flesh" | "dust"): void;
  /** Advance VFX (quads billboard to the camera; lights decay). */
  updateFx(dt: number): void;
}

/**
 * Free the GPU resources of a scene tree (geometries + materials). Called on
 * match rotation so swapping maps doesn't leak; the shared renderer is owned
 * by the caller.
 */
export function disposeScene(bundle: SceneBundle): void {
  bundle.scene.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if (mesh.geometry) mesh.geometry.dispose();
    const mat = (mesh as unknown as { material?: THREE.Material | THREE.Material[] }).material;
    if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
    else if (mat) mat.dispose();
  });
  bundle.scene.clear();
}

export function buildScene(world: World, camera: THREE.PerspectiveCamera): SceneBundle {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(COL_BG);
  scene.fog = new THREE.Fog(COL_BG, 45, 95);
  // The caller-owned camera joins the scene graph so its children (the
  // viewmodel) render. scene.clear() on rotation detaches it; re-added here.
  scene.add(camera);

  const sun = new THREE.DirectionalLight(0xfff4e0, 2.0);
  sun.position.set(12, 24, 8);
  scene.add(sun, new THREE.AmbientLight(0x3a4250, 1.5));

  const floor = new THREE.Mesh(
    new THREE.BoxGeometry(52, 0.5, 52),
    new THREE.MeshStandardMaterial({ color: 0x242933, roughness: 0.95 }),
  );
  floor.position.y = -0.25;
  scene.add(floor);

  const wallMat = new THREE.MeshStandardMaterial({ color: 0x2e3542, roughness: 0.85 });
  const accentMat = new THREE.MeshStandardMaterial({ color: 0xff6b35, roughness: 0.6 });
  for (const b of world.level.boxes) {
    const half = b.maxY <= 1.05 && b.minY === 0;
    const m = new THREE.Mesh(
      new THREE.BoxGeometry(b.maxX - b.minX, b.maxY - b.minY, b.maxZ - b.minZ),
      half ? accentMat : wallMat,
    );
    m.position.set((b.minX + b.maxX) / 2, (b.minY + b.maxY) / 2, (b.minZ + b.maxZ) / 2);
    scene.add(m);
  }

  // --- Dummies: full humanoid figures (legs, arms, head, eyes, hair) ---
  const dummies: DummyVisual[] = [];
  for (const d of world.dummies) {
    const humanoid = createHumanoid(
      humanoidPalette(d.id, { shirt: 0x8b93a3, pants: 0x6e7686 }),
    );
    humanoid.group.position.set(d.x, 0, d.z);
    humanoid.group.rotation.y = d.yaw;
    scene.add(humanoid.group);
    dummies.push({ humanoid, d });
  }

  // --- Bots (Phase 2): humanoid figures, tinted per team/archetype ---
  const ARCHETYPE_COLORS: Record<BotArchetype, number> = {
    rusher: 0xd64545,
    cover: 0xd69a45,
    sniper: 0x5a8fd6,
  };
  const bots: BotVisual[] = [];
  for (const b of world.bots) {
    // Team read first (Phase 3): allies blue, enemies keep archetype tints.
    const shirt = b.team === 0 ? 0x3f7fbf : ARCHETYPE_COLORS[b.archetype];
    const humanoid = createHumanoid({
      ...humanoidPalette(b.id, { shirt, pants: 0x3d4452 }),
      gun: b.defId, // weapon prop matches the bot's actual loadout
    });
    humanoid.group.position.set(b.x, b.y, b.z);
    humanoid.group.rotation.y = b.yaw;
    scene.add(humanoid.group);
    bots.push({ humanoid, b, shirt });
  }

  // Tracer pool: recycled short bright segments.
  const TRACER_COUNT = 24;
  const tracers: { mesh: THREE.Mesh; life: number }[] = [];
  const tracerMat = new THREE.MeshBasicMaterial({
    color: 0xffd9a0,
    transparent: true,
    opacity: 0.85,
  });
  const up = new THREE.Vector3(0, 1, 0);
  const dir = new THREE.Vector3();
  for (let i = 0; i < TRACER_COUNT; i++) {
    const mesh = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, 1, 6), tracerMat);
    mesh.visible = false;
    scene.add(mesh);
    tracers.push({ mesh, life: 0 });
  }
  let tracerIdx = 0;

  // --- Impact pool (Phase 5): billboards for sparks / puffs / dust ---
  const IMPACT_COUNT = 32;
  const IMPACT_LIFE = 0.28;
  const impactGeo = new THREE.PlaneGeometry(1, 1);
  const impactMats = {
    wall: new THREE.MeshBasicMaterial({
      color: 0xffd9a0,
      transparent: true,
      opacity: 0.95,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    }),
    flesh: new THREE.MeshBasicMaterial({
      color: 0xc2413a,
      transparent: true,
      opacity: 0.75,
      depthWrite: false,
    }),
    dust: new THREE.MeshBasicMaterial({
      color: 0xb9c0cc,
      transparent: true,
      opacity: 0.7,
      depthWrite: false,
    }),
  };
  const impacts: { mesh: THREE.Mesh; life: number; kind: keyof typeof impactMats; spin: number }[] = [];
  let impactIdx = 0;
  for (let i = 0; i < IMPACT_COUNT; i++) {
    const mesh = new THREE.Mesh(impactGeo, impactMats.wall);
    mesh.visible = false;
    scene.add(mesh);
    impacts.push({ mesh, life: 0, kind: "wall", spin: 0 });
  }

  // --- Muzzle flash pool (Phase 5): additive quads + one shared light ---
  const MUZZLE_COUNT = 6;
  const MUZZLE_LIFE = 0.055;
  const muzzleGeo = new THREE.PlaneGeometry(1, 1);
  const muzzleMat = new THREE.MeshBasicMaterial({
    color: 0xffc36b,
    transparent: true,
    opacity: 1,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
  });
  const muzzleLights: { mesh: THREE.Mesh; life: number }[] = [];
  let muzzleIdx = 0;
  for (let i = 0; i < MUZZLE_COUNT; i++) {
    const mesh = new THREE.Mesh(muzzleGeo, muzzleMat);
    mesh.visible = false;
    scene.add(mesh);
    muzzleLights.push({ mesh, life: 0 });
  }
  const flashLight = new THREE.PointLight(0xffb35c, 0, 11, 2);
  scene.add(flashLight);
  let flashIntensity = 0;

  return {
    scene,
    camera,
    dummies,
    bots,
    spawnMuzzle(x, y, z, big) {
      const entry = muzzleLights[muzzleIdx]!;
      muzzleIdx = (muzzleIdx + 1) % MUZZLE_COUNT;
      entry.mesh.position.set(x, y, z);
      const s = big ? 0.55 : 0.34;
      entry.mesh.scale.set(s, s, s);
      entry.mesh.rotation.z = Math.random() * Math.PI * 2;
      entry.mesh.visible = true;
      entry.life = MUZZLE_LIFE;
      flashLight.position.set(x, y, z);
      flashIntensity = big ? 14 : 8;
    },
    spawnImpact(x, y, z, dx, dy, dz, kind) {
      const entry = impacts[impactIdx]!;
      impactIdx = (impactIdx + 1) % IMPACT_COUNT;
      entry.mesh.material = impactMats[kind];
      entry.mesh.position.set(x, y, z);
      // Billboard size: sparks small, puffs bigger, death dust biggest.
      const s = kind === "wall" ? 0.22 : kind === "flesh" ? 0.4 : 1.3;
      entry.mesh.scale.set(s, s, s);
      // Offset slightly along the surface normal so quads don't z-fight.
      entry.mesh.position.x += dx * 0.04;
      entry.mesh.position.y += dy * 0.04;
      entry.mesh.position.z += dz * 0.04;
      entry.mesh.rotation.z = Math.random() * Math.PI * 2;
      entry.spin = (Math.random() - 0.5) * 6;
      entry.mesh.visible = true;
      entry.life = IMPACT_LIFE;
    },
    updateFx(dt) {
      // Muzzle quads: very short life, slight growth, face the camera.
      for (const m of muzzleLights) {
        if (m.life <= 0) continue;
        m.life -= dt;
        if (m.life <= 0) {
          m.mesh.visible = false;
        } else {
          m.mesh.quaternion.copy(camera.quaternion);
          const k = m.life / MUZZLE_LIFE;
          (m.mesh.material as THREE.MeshBasicMaterial).opacity = k;
        }
      }
      // Shared light: fast exponential decay.
      flashIntensity = Math.max(0, flashIntensity - dt * 260);
      flashLight.intensity = flashIntensity;
      // Impacts: fade + spin + rise (puff-like), still camera-facing.
      for (const it of impacts) {
        if (it.life <= 0) continue;
        it.life -= dt;
        if (it.life <= 0) {
          it.mesh.visible = false;
        } else {
          const k = it.life / IMPACT_LIFE;
          const mat = it.mesh.material as THREE.MeshBasicMaterial;
          mat.opacity = (it.kind === "wall" ? 0.95 : it.kind === "flesh" ? 0.75 : 0.7) * k;
          it.mesh.rotation.z += it.spin * dt;
          const base = it.kind === "wall" ? 0.22 : it.kind === "flesh" ? 0.4 : 1.3;
          const s = base * (1 + (1 - k) * (it.kind === "dust" ? 0.8 : 0.35));
          it.mesh.scale.set(s, s, s);
          it.mesh.position.y += dt * (it.kind === "wall" ? 0.05 : 0.35);
          it.mesh.quaternion.copy(camera.quaternion);
        }
      }
    },
    spawnTracer(ox, oy, oz, dx, dy, dz, t) {
      const entry = tracers[tracerIdx]!;
      tracerIdx = (tracerIdx + 1) % TRACER_COUNT;
      const end = Math.min(t === Infinity ? 120 : t, 120);
      const len = Math.min(end, 4);
      const mx = ox + dx * (end - len / 2);
      const my = oy + dy * (end - len / 2);
      const mz = oz + dz * (end - len / 2);
      entry.mesh.position.set(mx, my, mz);
      dir.set(dx, dy, dz);
      entry.mesh.quaternion.setFromUnitVectors(up, dir);
      entry.mesh.scale.set(1, len, 1);
      entry.mesh.visible = true;
      entry.life = 1;
    },
    fadeTracers(dt) {
      for (const tr of tracers) {
        if (tr.life <= 0) continue;
        tr.life -= dt * 8;
        if (tr.life <= 0) {
          tr.mesh.visible = false;
        } else {
          (tr.mesh.material as THREE.MeshBasicMaterial).opacity = 0.85 * tr.life;
        }
      }
    },
  };
}
