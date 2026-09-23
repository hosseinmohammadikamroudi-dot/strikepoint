/**
 * DOM input bridge. Translates keyboard/mouse/pointer-lock into the sim's
 * InputSnapshot. The bridge never touches sim state directly — it only fills
 * the snapshot the sim consumes at tick boundaries.
 *
 * Bindings (Phase 1, rebindable settings arrive in Phase 4):
 *   WASD move · Shift sprint · Ctrl/C crouch · Space jump ·
 *   Mouse1 fire · Mouse2 ADS · R reload · Esc release mouse
 */

import { addMouse, press, release, type ActionFlag, type InputSnapshot } from "../sim/input";

// Physical key codes (layout-independent — works on AZERTY etc.).
const KEY_MAP: Record<string, ActionFlag> = {
  KeyW: "forward",
  KeyA: "left",
  KeyS: "back",
  KeyD: "right",
  ShiftLeft: "sprint",
  ShiftRight: "sprint",
  ControlLeft: "crouch",
  KeyC: "crouch",
  Space: "jump",
  KeyR: "reload",
  Digit1: "slot1",
  Digit2: "slot2",
  Digit3: "slot3",
  Digit4: "slot4",
};

export interface InputBridge {
  /** Call each frame before ticking the sim (keeps held flags fresh). */
  refresh(): void;
  /** Request pointer lock (call from a user gesture, e.g. overlay click). */
  requestLock(): void;
  /**
   * Pointer lock can be unavailable (sandboxed iframes, some webviews, or a
   * browser policy). In that case the game runs in a fallback mode: the
   * canvas follows the OS cursor directly and the view is not dragged along
   * when the cursor leaves the window. Click-to-play still works because
   * lock is never *required*.
   */
  setFallbackLook(enabled: boolean): void;
  /**
   * Gate for keyboard/mouse→sim input. Only live while a match is actually
   * running (no menu/settings/match-end screen up, match not over) — menus
   * must never leak keys into the sim.
   */
  setActive(live: boolean): void;
  /** Notified when Esc drops an acquired lock (→ pause screen). */
  onUnlocked(cb: () => void): void;
  /** Notified when a lock *request* fails (→ enable fallback + toast). */
  onLockError(cb: (reason: string) => void): void;
  dispose(): void;
  /** True when the browser has granted pointer lock. */
  readonly locked: boolean;
}

// Actions that fire once per physical press: they are pressed on keydown but
// never added to `held`, so refresh() cannot re-trigger them while held
// (holding R no longer spam-restarts reload; digits don't re-switch).
const NO_HOLD: ReadonlySet<ActionFlag> = new Set<ActionFlag>([
  "reload",
  "slot1",
  "slot2",
  "slot3",
  "slot4",
]);

export function attachInput(canvas: HTMLCanvasElement, snapshot: InputSnapshot): InputBridge {
  const held = new Set<ActionFlag>();

  // Editing an input while pointer-locked is rare, but typing in the save
  // blob with fallback look active would drag the camera on every caret
  // move — gate mouse input on the active element instead.
  const editingText = (): boolean => {
    const el = document.activeElement;
    return (
      !!el &&
      (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || (el as HTMLElement).isContentEditable)
    );
  };

  const onKey = (e: KeyboardEvent, down: boolean): void => {
    const action = KEY_MAP[e.code];
    if (!action) return;
    if (!active) return; // menu/settings/match-end: input never reaches the sim
    e.preventDefault();
    if (down) {
      press(snapshot, action); // jump stays held too → holding Space bunny-hops
      if (!NO_HOLD.has(action)) held.add(action);
    } else if (held.delete(action)) {
      release(snapshot, action);
    }
  };

  const kd = (e: KeyboardEvent): void => onKey(e, true);
  const ku = (e: KeyboardEvent): void => onKey(e, false);

  const md = (e: MouseEvent): void => {
    if (!active || (!locked && !fallbackLook)) return;
    if (editingText()) return;
    if (e.button === 0) {
      held.add("fire");
      press(snapshot, "fire");
    }
    if (e.button === 2) held.add("ads");
  };
  const mu = (e: MouseEvent): void => {
    if (e.button === 0) {
      held.delete("fire");
      release(snapshot, "fire");
    }
    if (e.button === 2) {
      held.delete("ads");
      release(snapshot, "ads");
    }
  };
  const mm = (e: MouseEvent): void => {
    if (editingText()) return;
    if (locked) {
      addMouse(snapshot, e.movementX, e.movementY);
    } else if (fallbackLook) {
      // Fallback (no pointer lock): aim follows the OS cursor, but only
      // while it actually roams the canvas — moving over HUD/menus is inert.
      const r = canvas.getBoundingClientRect();
      const inside =
        e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
      if (inside && lastX !== null && lastY !== null) {
        addMouse(snapshot, e.clientX - lastX, e.clientY - lastY);
      }
      lastX = e.clientX;
      lastY = e.clientY;
    }
  };
  const ctx = (e: Event): void => e.preventDefault();

  let locked = false;
  let fallbackLook = false;
  let active = false; // gates sim-facing input (menus must not leak keys)
  // Null until the first fallback event baselines the cursor — a numeric
  // default (0) would inject a huge phantom delta on the first movement.
  let lastX: number | null = null;
  let lastY: number | null = null;
  let unlockedCb: (() => void) | null = null;
  let lockErrorCb: ((reason: string) => void) | null = null;
  const plc = (): void => {
    const was = locked;
    locked = document.pointerLockElement === canvas;
    if (was && !locked) unlockedCb?.();
  };
  const ple = (): void => {
    // Chrome ≥ 111 exposes `pointerLockError` (a Promise rejection, not the
    // legacy event) — handle both so the fallback engages everywhere.
    lockErrorCb?.("pointer-lock request failed");
  };

  const requestLock = (): void => {
    if (locked) return;
    try {
      const r = canvas.requestPointerLock() as unknown;
      if (r instanceof Promise) {
        r.catch(() => lockErrorCb?.("pointer-lock rejected"));
      }
    } catch {
      lockErrorCb?.("pointer-lock unavailable");
    }
  };

  document.addEventListener("keydown", kd);
  document.addEventListener("keyup", ku);
  canvas.addEventListener("mousedown", md);
  document.addEventListener("mouseup", mu);
  document.addEventListener("mousemove", mm);
  document.addEventListener("contextmenu", ctx);
  document.addEventListener("pointerlockchange", plc);
  document.addEventListener("pointerlockerror", ple);

  return {
    refresh() {
      // Re-assert held flags; the sim clears edge-triggered ones each tick.
      for (const f of held) press(snapshot, f);
    },
    requestLock,
    setFallbackLook(enabled: boolean): void {
      if (enabled && locked) return; // real lock always wins
      if (enabled && !fallbackLook) {
        lastX = null;
        lastY = null; // baseline on the first real event (no phantom delta)
      }
      fallbackLook = enabled;
    },
    setActive(live: boolean): void {
      active = live;
      if (!live) {
        // Drop everything so a held W/fire can't stick through a menu.
        held.clear();
        snapshot.flags.clear();
      }
    },
    onUnlocked(cb: () => void): void {
      unlockedCb = cb;
    },
    onLockError(cb: (reason: string) => void): void {
      lockErrorCb = cb;
    },
    dispose() {
      document.removeEventListener("keydown", kd);
      document.removeEventListener("keyup", ku);
      canvas.removeEventListener("mousedown", md);
      document.removeEventListener("mouseup", mu);
      document.removeEventListener("mousemove", mm);
      document.removeEventListener("contextmenu", ctx);
      document.removeEventListener("pointerlockchange", plc);
      document.removeEventListener("pointerlockerror", ple);
    },
    get locked() {
      return locked;
    },
  };
}
