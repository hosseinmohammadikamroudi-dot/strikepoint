/**
 * Humanoid figure — low-poly blocky character for dummies and bots (view-only,
 * no sim impact). Built from boxes under a THREE.Group; limbs are pivoted
 * groups so walking animation can swing them from hips/shoulders.
 *
 * Convention: the character FACES local −Z (matching sim yaw math where
 * forward = (−sin yaw, −cos yaw) and group.rotation.y = yaw). The face, eyes,
 * nose and gun barrel sit on the −Z side; hair curtain on +Z (back of head).
 *
 * Hierarchy (units: meters, feet at y=0):
 *   group
 *   ├── leftLeg/rightLeg  (pivot y=0.90) → thigh + shin + shoe
 *   └── upper             (yaw + bob)
 *       ├── chest / belly / belt / backpack
 *       ├── leftArm/rightArm (pivot at shoulder y=1.40) → shoulder + upper + fore + glove (+ gun)
 *       └── head (pivot y=1.56) → neck, skull, jaw, hair (cap/back/sides),
 *                                  eyes (white + pupil), nose, ears
 *
 * Positive rotation.x on a limb swings its hanging tip FORWARD (−Z):
 * tip (0,−1,0) under rot.x=θ maps to z' = −sinθ.
 */
import * as THREE from "three";
import type { WeaponId } from "../sim/weapons";

export interface Humanoid {
  /** Root group — position at the character's feet. */
  group: THREE.Group;
  /** Torso/head/arms container — yaw rotates here (legs own their swing). */
  upper: THREE.Group;
  leftLeg: THREE.Group;
  rightLeg: THREE.Group;
  leftArm: THREE.Group;
  rightArm: THREE.Group;
  head: THREE.Group;
  /** All meshes incl. gun (hit-flash material swapping). */
  meshes: THREE.Mesh[];
  /** Base material per mesh (parallel to meshes) for flash restore. */
  baseMats: THREE.Material[];
  /** Torso/head meshes only — flash tint applies here. */
  flashMeshes: THREE.Mesh[];
  /** Per-frame walk animation; speed01 0..1, phase in radians. */
  walk(speed01: number, phase: number): void;
  /** Blend arms toward a raised two-hand aim pose (pitch −0.6..0.6 rad). */
  aim(pitch: number, amount: number): void;
  dispose(): void;
}

const box = (w: number, h: number, d: number): THREE.BoxGeometry => new THREE.BoxGeometry(w, h, d);

/** Offset a mesh's geometry so the box hangs downward from its pivot. */
function hangDown(mesh: THREE.Mesh, h: number): THREE.Mesh {
  mesh.geometry.translate(0, -h / 2, 0);
  return mesh;
}

// ---------------------------------------------------------------------------
// Gun — blocky per-weapon prop, barrel along local −Z, grip at the origin.
// ---------------------------------------------------------------------------

interface GunSpec {
  bodyL: number;
  bodyH: number;
  bodyW: number;
  barrelL: number;
  barrelR: number;
  stockL: number;
  scope: boolean;
  drum: boolean;
  accent: number;
}

const GUN_SPECS: Record<WeaponId, GunSpec> = {
  // SMG: compact body, short barrel, straight mag.
  vector7: { bodyL: 0.34, bodyH: 0.09, bodyW: 0.06, barrelL: 0.14, barrelR: 0.016, stockL: 0.1, scope: false, drum: false, accent: 0xff6b35 },
  // PDW: shortest, no real stock.
  hornet: { bodyL: 0.24, bodyH: 0.08, bodyW: 0.055, barrelL: 0.09, barrelR: 0.014, stockL: 0.05, scope: false, drum: false, accent: 0xe8c547 },
  // LMG: long thick body, drum mag, chunky stock.
  mule: { bodyL: 0.42, bodyH: 0.11, bodyW: 0.075, barrelL: 0.16, barrelR: 0.022, stockL: 0.14, scope: false, drum: true, accent: 0x6fd08c },
  // Sniper: longest barrel + scope on top.
  longview: { bodyL: 0.46, bodyH: 0.09, bodyW: 0.06, barrelL: 0.24, barrelR: 0.015, stockL: 0.16, scope: true, drum: false, accent: 0x5a8fd6 },
};

/**
 * Build a gun prop. Origin sits at the pistol grip (where the hand closes
 * around it); barrel points along −Z; mag hangs −Y. Attach under an arm
 * pivot at the glove with rotation.x = −π/2 so the barrel follows the
 * forearm's hang direction (down when idle, forward when aiming).
 */
export function createGunMesh(kind: WeaponId): THREE.Group {
  const s = GUN_SPECS[kind];
  const g = new THREE.Group();
  const metal = new THREE.MeshStandardMaterial({ color: 0x262b33, roughness: 0.55 });
  const dark = new THREE.MeshStandardMaterial({ color: 0x1b1e24, roughness: 0.75 });
  const accent = new THREE.MeshStandardMaterial({ color: s.accent, roughness: 0.5 });

  const add = (geo: THREE.BufferGeometry, mat: THREE.Material, x = 0, y = 0, z = 0): void => {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, y, z);
    g.add(m);
  };

  // Receiver.
  add(box(s.bodyW, s.bodyH, s.bodyL), metal);
  // Barrel along −Z (cylinder axis Y → rotate to Z).
  const barrel = new THREE.CylinderGeometry(s.barrelR, s.barrelR, s.barrelL, 8);
  barrel.rotateX(Math.PI / 2);
  add(barrel, dark, 0, s.bodyH * 0.15, -(s.bodyL / 2 + s.barrelL / 2));
  // Muzzle accent tip.
  add(box(s.barrelR * 2.4, s.barrelR * 2.4, 0.03), accent, 0, s.bodyH * 0.15, -(s.bodyL / 2 + s.barrelL + 0.01));
  // Magazine below, slightly raked forward.
  const mag = box(0.035, 0.13, 0.05);
  add(mag, dark, 0, -(s.bodyH / 2 + 0.05), -0.02);
  g.children[g.children.length - 1]!.rotation.x = 0.12;
  // Pistol grip near the origin (this group's origin = grip top).
  const grip = box(0.032, 0.09, 0.05);
  add(grip, dark, 0, -(s.bodyH / 2 + 0.035), s.bodyL * 0.18);
  g.children[g.children.length - 1]!.rotation.x = 0.3;
  // Stock to the rear.
  add(box(0.045, 0.08, s.stockL), dark, 0, -0.01, s.bodyL / 2 + s.stockL / 2 - 0.015);
  // Accent stripe on both sides of the receiver.
  for (const sx of [-1, 1]) {
    add(box(0.005, 0.03, s.bodyL * 0.55), accent, (sx * s.bodyW) / 2, 0.005, -0.02);
  }
  if (s.scope) {
    const tube = new THREE.CylinderGeometry(0.024, 0.024, 0.13, 8);
    tube.rotateX(Math.PI / 2);
    add(tube, dark, 0, s.bodyH / 2 + 0.032, -0.04);
  }
  if (s.drum) {
    const drum = new THREE.CylinderGeometry(0.05, 0.05, 0.045, 10);
    drum.rotateX(Math.PI / 2);
    add(drum, dark, 0, -(s.bodyH / 2 + 0.05), 0.02);
  }
  return g;
}

export function createHumanoid(opt: {
  skin: number;
  shirt: number;
  pants: number;
  hair: number;
  eye: number;
  shoe?: number;
  /** Weapon prop in the right hand (defaults to none). */
  gun?: WeaponId;
}): Humanoid {
  const shoeCol = opt.shoe ?? 0x23262d;
  const meshes: THREE.Mesh[] = [];
  const baseMats: THREE.Material[] = [];
  const flashMeshes: THREE.Mesh[] = [];
  const disposables: (THREE.BufferGeometry | THREE.Material)[] = [];

  const mkMat = (color: number, rough: number): THREE.MeshStandardMaterial => {
    const m = new THREE.MeshStandardMaterial({ color, roughness: rough });
    disposables.push(m);
    return m;
  };
  const M = {
    skin: mkMat(opt.skin, 0.65),
    shirt: mkMat(opt.shirt, 0.8),
    pants: mkMat(opt.pants, 0.85),
    hair: mkMat(opt.hair, 0.9),
    eyeWhite: mkMat(0xe8edf4, 0.35),
    pupil: mkMat(opt.eye, 0.3),
    shoe: mkMat(shoeCol, 0.9),
    gear: mkMat(0x2e3138, 0.85),
  };

  const track = (mesh: THREE.Mesh, m: THREE.MeshStandardMaterial, flash = false): THREE.Mesh => {
    meshes.push(mesh);
    baseMats.push(m);
    if (flash) flashMeshes.push(mesh);
    disposables.push(mesh.geometry);
    return mesh;
  };

  const group = new THREE.Group();
  const upper = new THREE.Group();
  group.add(upper);

  // ---- Torso ----
  const chest = track(new THREE.Mesh(box(0.44, 0.5, 0.24), M.shirt), M.shirt, true);
  chest.position.set(0, 1.22, 0);
  const belly = track(new THREE.Mesh(box(0.4, 0.18, 0.22), M.shirt), M.shirt, true);
  belly.position.set(0, 0.94, 0);
  const belt = track(new THREE.Mesh(box(0.42, 0.08, 0.24), M.gear), M.gear, true);
  belt.position.set(0, 0.84, 0);
  const pack = track(new THREE.Mesh(box(0.3, 0.32, 0.12), M.pants), M.pants, true);
  pack.position.set(0, 1.22, -0.18);
  upper.add(chest, belly, belt, pack);

  // ---- Head pivot (face on −Z, hair on +Z) ----
  const head = new THREE.Group();
  head.position.set(0, 1.56, 0);
  upper.add(head);

  const neck = track(new THREE.Mesh(box(0.14, 0.08, 0.14), M.skin), M.skin);
  neck.position.set(0, -0.03, 0);
  const skull = track(new THREE.Mesh(box(0.26, 0.28, 0.26), M.skin), M.skin, true);
  skull.position.set(0, 0.14, 0);
  const jaw = track(new THREE.Mesh(box(0.2, 0.1, 0.06), M.skin), M.skin, true);
  jaw.position.set(0, 0.07, -0.13);
  // Hair: cap + back curtain (+Z side) + side locks framing the face.
  const hairCap = track(new THREE.Mesh(box(0.28, 0.1, 0.28), M.hair), M.hair);
  hairCap.position.set(0, 0.27, 0);
  const hairBack = track(new THREE.Mesh(box(0.28, 0.22, 0.06), M.hair), M.hair);
  hairBack.position.set(0, 0.16, 0.13);
  const hairSideL = track(new THREE.Mesh(box(0.05, 0.14, 0.24), M.hair), M.hair);
  hairSideL.position.set(-0.13, 0.18, -0.01);
  const hairSideR = track(new THREE.Mesh(box(0.05, 0.14, 0.24), M.hair), M.hair);
  hairSideR.position.set(0.13, 0.18, -0.01);
  head.add(neck, skull, jaw, hairCap, hairBack, hairSideL, hairSideR);
  // Eyes: white sclera + pupil on the −Z face; pupil sits proud of the white.
  for (const sx of [-0.065, 0.065]) {
    const white = track(new THREE.Mesh(box(0.055, 0.045, 0.02), M.eyeWhite), M.eyeWhite);
    white.position.set(sx, 0.15, -0.128);
    const pupil = track(new THREE.Mesh(box(0.024, 0.024, 0.022), M.pupil), M.pupil);
    pupil.position.set(sx, 0.15, -0.136);
    head.add(white, pupil);
  }
  // Nose + ears.
  const nose = track(new THREE.Mesh(box(0.05, 0.06, 0.05), M.skin), M.skin);
  nose.position.set(0, 0.1, -0.145);
  head.add(nose);
  for (const sx of [-0.145, 0.145]) {
    const ear = track(new THREE.Mesh(box(0.03, 0.07, 0.05), M.skin), M.skin);
    ear.position.set(sx, 0.13, 0);
    head.add(ear);
  }

  // ---- Arms: pivot at the shoulder, segments hang down ----
  const mkArm = (side: -1 | 1): THREE.Group => {
    const pivot = new THREE.Group();
    pivot.position.set(side * 0.28, 1.4, 0);
    const shoulder = track(new THREE.Mesh(box(0.15, 0.17, 0.17), M.shirt), M.shirt, true);
    shoulder.position.y = 0.02;
    const upperArm = hangDown(track(new THREE.Mesh(box(0.11, 0.3, 0.12), M.shirt), M.shirt, true), 0.3);
    upperArm.position.y = -0.12;
    const fore = hangDown(track(new THREE.Mesh(box(0.095, 0.26, 0.1), M.skin), M.skin, true), 0.26);
    fore.position.y = -0.42;
    const glove = hangDown(track(new THREE.Mesh(box(0.1, 0.12, 0.11), M.gear), M.gear, true), 0.12);
    glove.position.y = -0.62;
    pivot.add(shoulder, upperArm, fore, glove);
    upper.add(pivot);
    return pivot;
  };
  const leftArm = mkArm(-1);
  const rightArm = mkArm(1);

  // ---- Gun prop in the right hand ----
  if (opt.gun) {
    const gun = createGunMesh(opt.gun);
    // Origin at the grip → seat it in the glove. Rotated so the barrel runs
    // along the forearm's hang axis (−Y arm-local): down at rest, forward
    // when the arm raises into the aim pose.
    gun.position.set(0, -0.64, 0.02);
    gun.rotation.x = -Math.PI / 2;
    rightArm.add(gun);
    gun.traverse((obj) => {
      const mesh = obj as THREE.Mesh;
      if (mesh.isMesh) {
        const mat = mesh.material as THREE.MeshStandardMaterial;
        meshes.push(mesh);
        baseMats.push(mat);
        disposables.push(mesh.geometry);
        if (!disposables.includes(mat)) disposables.push(mat);
      }
    });
  }

  // ---- Legs: pivot at the hip, thigh + shin + shoe ----
  const mkLeg = (side: -1 | 1): THREE.Group => {
    const pivot = new THREE.Group();
    pivot.position.set(side * 0.11, 0.9, 0);
    const thigh = hangDown(track(new THREE.Mesh(box(0.15, 0.42, 0.16), M.pants), M.pants), 0.42);
    thigh.position.y = -0.02;
    const shin = hangDown(track(new THREE.Mesh(box(0.13, 0.4, 0.14), M.pants), M.pants), 0.4);
    shin.position.y = -0.44;
    const shoe = hangDown(track(new THREE.Mesh(box(0.15, 0.1, 0.24), M.shoe), M.shoe), 0.1);
    shoe.position.set(0, -0.86, 0.045);
    pivot.add(thigh, shin, shoe);
    group.add(pivot);
    return pivot;
  };
  const leftLeg = mkLeg(-1);
  const rightLeg = mkLeg(1);

  // ---- Animation state ----
  let armAim = 0;
  let idlePhase = 0;

  const walk = (speed01: number, phase: number): void => {
    const s = THREE.MathUtils.clamp(speed01, 0, 1);
    if (s < 0.02) {
      // Idle: gentle breathing sway, arms settle at the sides.
      idlePhase += 0.016;
      const idle = Math.sin(idlePhase) * 0.025;
      leftLeg.rotation.x = 0;
      rightLeg.rotation.x = 0;
      leftArm.rotation.x = idle;
      rightArm.rotation.x = idle;
      leftArm.rotation.z = 0.07;
      rightArm.rotation.z = -0.07;
      upper.position.y = Math.sin(idlePhase * 0.8) * 0.008;
      head.rotation.z = Math.sin(idlePhase * 0.6) * 0.02;
      armAim = 0;
      return;
    }
    const swing = 0.55 * s;
    const c = Math.cos(phase);
    const sn = Math.sin(phase);
    leftLeg.rotation.x = c * swing;
    rightLeg.rotation.x = -c * swing;
    leftArm.rotation.x = -c * swing * 0.8;
    rightArm.rotation.x = c * swing * 0.8;
    leftArm.rotation.z = 0.08 + s * 0.04;
    rightArm.rotation.z = -0.08 - s * 0.04;
    upper.position.y = Math.abs(sn) * 0.04 * s;
    head.rotation.z = sn * 0.03 * s;
    armAim = 0;
  };

  const aim = (pitch: number, amount: number): void => {
    armAim = THREE.MathUtils.clamp(amount, 0, 1);
    if (armAim <= 0) return;
    const p = THREE.MathUtils.clamp(pitch, -0.6, 0.6);
    const t = armAim;
    // Positive rot.x raises a hanging arm FORWARD (−Z). Right arm carries the
    // gun along the bore; left arm comes up shorter and angles inward to the
    // foregrip for a two-hand read.
    rightArm.rotation.x = rightArm.rotation.x * (1 - t) + (1.45 + p) * t;
    leftArm.rotation.x = leftArm.rotation.x * (1 - t) + (1.25 + p) * t;
    rightArm.rotation.z = rightArm.rotation.z * (1 - t) + -0.02 * t;
    leftArm.rotation.z = leftArm.rotation.z * (1 - t) + 0.3 * t;
    head.rotation.x = p * 0.4 * t;
  };

  return {
    group,
    upper,
    leftLeg,
    rightLeg,
    leftArm,
    rightArm,
    head,
    meshes,
    baseMats,
    flashMeshes,
    walk,
    aim,
    dispose() {
      for (const d of disposables) d.dispose();
    },
  };
}

/** Palette helper — deterministic per-id variation from a small set. */
export function humanoidPalette(
  id: number,
  teamColors: { shirt: number; pants: number },
): { skin: number; shirt: number; pants: number; hair: number; eye: number } {
  const skins = [0xd9a37e, 0xc98d63, 0xa9714b, 0x8a5a3b, 0xe8b58c];
  const hairs = [0x2b2118, 0x4a3220, 0x1b1b1f, 0x6b4a2a, 0x3d3d45];
  return {
    skin: skins[id % skins.length]!,
    shirt: teamColors.shirt,
    pants: teamColors.pants,
    hair: hairs[(id * 7 + 3) % hairs.length]!,
    eye: 0x2a2e36,
  };
}
