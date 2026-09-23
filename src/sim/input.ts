/**
 * Input state as plain data + a pure reducer. The DOM keyboard/mouse layer
 * (view side) produces events; the sim consumes this snapshot at tick boundaries.
 * Keeping transitions in pure functions makes the sim input reproducible from
 * a recorded event trace (needed for the determinism test and future netcode).
 *
 * Accumulated `mouseDX/DY` are consumed exactly once per tick via `takeMouse()`.
 */

export type ActionFlag =
  | "forward"
  | "back"
  | "left"
  | "right"
  | "sprint"
  | "crouch"
  | "jump"
  | "reload"
  | "ads"
  | "fire"
  | "slot1"
  | "slot2"
  | "slot3"
  | "slot4";

export interface InputSnapshot {
  /** Action held/pressed this tick. */
  flags: Set<ActionFlag>;
  /** Accumulated mouse movement since last tick (counts). */
  mouseDX: number;
  mouseDY: number;
}

export function createInputSnapshot(): InputSnapshot {
  return { flags: new Set<ActionFlag>(), mouseDX: 0, mouseDY: 0 };
}

export function press(s: InputSnapshot, f: ActionFlag): void {
  s.flags.add(f);
}

export function release(s: InputSnapshot, f: ActionFlag): void {
  s.flags.delete(f);
}

export function addMouse(s: InputSnapshot, dx: number, dy: number): void {
  s.mouseDX += dx;
  s.mouseDY += dy;
}

/** Read-and-clear accumulated mouse movement (consume-once semantics). */
export function takeMouse(s: InputSnapshot): { dx: number; dy: number } {
  const dx = s.mouseDX;
  const dy = s.mouseDY;
  s.mouseDX = 0;
  s.mouseDY = 0;
  return { dx, dy };
}

/** Frames/actions that are edge-triggered are cleared after each tick. */
export function endTick(s: InputSnapshot): void {
  s.flags.delete("reload");
  s.flags.delete("slot1");
  s.flags.delete("slot2");
  s.flags.delete("slot3");
  s.flags.delete("slot4");
}
