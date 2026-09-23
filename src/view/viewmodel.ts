/**
 * Viewmodel — blocky greybox weapon rigged to the camera. Phase 5 animation
 * set, all driven from sim state (no view-side gameplay truth):
 *  - hip ↔ ADS position lerp (sim `adsAmount`)
 *  - per-shot kick: positional + rotational, exponential recovery
 *  - switch: lower-and-raise over the sim's 0.4 s swap window
 *  - reload: tilt-down tilt-up hill across the def's reload time
 *  - landing: camera-coupled dip scaled by impact severity
 *  - sprint: canted ready pose; idle: slow breathing sway when still
 */
import * as THREE from "three";

export interface Viewmodel {
  group: THREE.Group;
  /** Per-frame pose update. `progress01` values come straight from the sim. */
  update(opts: {
    dt: number;
    adsAmount: number;
    kick: number;
    bobPhase: number;
    speed01: number;
    /** Weapon-swap progress, 0 (just swapped) → 1 (ready). */
    switch01: number;
    /** Reload progress 0→1 while reloading, null otherwise. */
    reload01: number | null;
    /** Landing severity 0–1, delivered once per landing then 0. */
    landKick: number;
    sprinting: boolean;
  }): void;
  /** Re-tint the accent parts for the newly equipped weapon. */
  setWeapon(id: string): void;
}

const ACCENT_COLORS: Record<string, number> = {
  vector7: 0xff6b35,
  hornet: 0xffc53d,
  mule: 0xc0563e,
  longview: 0x6a8caf,
};

export function createViewmodel(camera: THREE.PerspectiveCamera): Viewmodel {
  const group = new THREE.Group();
  const dark = new THREE.MeshStandardMaterial({ color: 0x1c2027, roughness: 0.55, metalness: 0.35 });
  const accent = new THREE.MeshStandardMaterial({ color: 0xff6b35, roughness: 0.6 });

  const receiver = new THREE.Mesh(new THREE.BoxGeometry(0.10, 0.11, 0.62), dark);
  receiver.position.set(0, 0, 0);
  const barrel = new THREE.Mesh(new THREE.BoxGeometry(0.045, 0.045, 0.38), dark);
  barrel.position.set(0, 0.02, -0.46);
  const mag = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.16, 0.09), accent);
  mag.position.set(0, -0.12, 0.06);
  const stock = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.10, 0.22), dark);
  stock.position.set(0, -0.01, 0.38);
  group.add(receiver, barrel, mag, stock);
  camera.add(group);

  const hip = new THREE.Vector3(0.28, -0.26, -0.55);
  const ads = new THREE.Vector3(0.0, -0.205, -0.35);
  const pos = hip.clone();

  // Animated sub-poses (eased toward targets each frame).
  let kickZ = 0;
  let rotP = 0; // muzzle-up recoil rotation
  let rotY = 0; // slight yaw jitter
  let rotR = 0; // roll (sprint cant + reload tilt live here)
  let dipY = 0; // landing dip
  let swayT = 0; // idle sway clock

  /** Frame-rate-independent approach: 1 - e^(-k·dt). */
  const ease = (cur: number, target: number, k: number, dt: number): number =>
    cur + (target - cur) * (1 - Math.exp(-k * dt));

  return {
    group,
    update({ dt, adsAmount, kick, bobPhase, speed01, switch01, reload01, landKick, sprinting }) {
      // --- Base position: hip ↔ ADS ---
      pos.lerpVectors(hip, ads, adsAmount);

      // --- Recoil: positional + rotational kick, exponential recovery ---
      kickZ = Math.max(0, kickZ - dt * 2.2) * 0.72 + kick;
      rotP = Math.max(0, rotP - dt * 3.4) * 0.7 + kick * 1.3;
      rotY = Math.max(0, rotY - dt * 3.0) * 0.7 + kick * 0.35;

      // --- Landing dip: sharp drop, springy recovery ---
      if (landKick > 0) dipY = Math.max(dipY, -0.09 * landKick);
      dipY = ease(dipY, 0, 7, dt);

      // --- Switch: lower while switching (ease out over the swap window) ---
      // switch01: 0 right after swap → 1 ready. Lowered = 1 - switch01.
      const lower = Math.pow(1 - switch01, 1.5); // snappy raise, fast lower
      const lowerY = -0.34 * lower;
      const lowerRot = -0.9 * lower; // muzzle dips toward the floor

      // --- Reload: tilt hill across the reload duration ---
      let reloadRot = 0;
      let reloadRoll = 0;
      if (reload01 !== null) {
        // sin hill: 0 → tilt peak mid-reload → 0
        const hill = Math.sin(Math.min(1, reload01) * Math.PI);
        reloadRot = -0.55 * hill; // muzzle down
        reloadRoll = 0.4 * hill; // canted roll — mag-change read
      }

      // --- Sprint pose: canted, tucked; overridden by ADS ---
      const sprintW = sprinting ? (1 - adsAmount) * 0.85 : 0;
      const sprintRotY = -0.45 * sprintW;
      const sprintRoll = -0.28 * sprintW;
      const sprintX = -0.06 * sprintW;

      // --- Idle sway: slow breathing when still (fades out with speed/ADS) ---
      swayT += dt;
      const idleW = Math.max(0, 1 - speed01 * 2.5) * (1 - adsAmount * 0.7);
      const swayX = Math.sin(swayT * 1.1) * 0.0045 * idleW;
      const swayY = Math.sin(swayT * 1.7 + 1.2) * 0.0035 * idleW;

      // --- Bob (movement) ---
      const bobW = (1 - adsAmount * 0.8) * (sprinting ? 1.35 : 1);
      const bobX = Math.sin(bobPhase * 0.9) * 0.008 * speed01 * bobW;
      const bobY = Math.abs(Math.cos(bobPhase)) * 0.010 * speed01 * bobW;

      group.position.set(
        pos.x + bobX + swayX + sprintX,
        pos.y + bobY + swayY + dipY + lowerY,
        pos.z + kickZ,
      );
      group.rotation.set(
        rotP + reloadRot + lowerRot * 0.4,
        rotY + sprintRotY,
        rotR + reloadRoll + sprintRoll + lowerRot * 0.3,
      );
    },
    setWeapon(id) {
      accent.color.setHex(ACCENT_COLORS[id] ?? 0xff6b35);
    },
  };
}
