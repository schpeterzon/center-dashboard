import { clamp } from "./math.js";

export const MAX_IMPULSES = 8;
const TYPES = Object.freeze({
  "task.created": [1, -0.6],
  "thinking.started": [2, 0.65],
  "tool.started": [3, 0.9],
  "file.changed": [1, 0.6],
  "approval.requested": [4, 0.8],
  "task.completed": [5, 0.85],
  "session.idle": [5, 0.65],
  "task.failed": [6, 0.9],
  "tool.failed": [6, 0.65],
  error: [6, 0.8],
  "fallback.activated": [4, 0.6],
  fallback: [4, 0.6],
  "task.cancelled": [2, -0.5],
});

export function impulseFor(event) {
  if (!event || !Object.hasOwn(TYPES, event.type)) return null;
  // Mirror the bus: unverified completion is never a green success wave.
  if (event.type === "task.completed" && event.payload?.verification !== "passed") return null;
  const [kind, strength] = TYPES[event.type];
  let hash = 2166136261;
  for (const c of `${event.source || ""}:${event.task_id || ""}:${event.seq || ""}`)
    hash = Math.imul(hash ^ c.charCodeAt(0), 16777619);
  const angle = ((hash >>> 0) / 4294967296) * Math.PI * 2;
  const localized = kind === 3;
  return {
    kind,
    strength,
    x: localized ? Math.cos(angle) * 0.55 : 0,
    y: localized ? Math.sin(angle) * 0.55 : 0,
    z: localized ? 0.35 : 0,
  };
}

// Fixed-size uniform storage. Events are deduplicated and stale replay is ignored.
export class ImpulseQueue {
  constructor() {
    this.origins = new Float32Array(MAX_IMPULSES * 4);
    this.parameters = new Float32Array(MAX_IMPULSES * 4);
    this.parameters.fill(0);
    this.cursor = 0;
    this.lastSeq = 0;
  }
  clear() {
    this.parameters.fill(0);
  }
  add(impulse, time) {
    const at = this.cursor * 4;
    this.origins.set([impulse.x || 0, impulse.y || 0, impulse.z || 0, time], at);
    this.parameters.set([impulse.kind, clamp(impulse.strength, -1, 1), 2.4, 0], at);
    this.cursor = (this.cursor + 1) % MAX_IMPULSES;
  }
  emit(event, time, now = Date.now()) {
    if (Number.isFinite(event?.seq)) {
      if (event.seq <= this.lastSeq) return false;
      this.lastSeq = event.seq;
    }
    const timestamp = Date.parse(event?.ts || event?.timestamp || "");
    if (Number.isFinite(timestamp) && (now - timestamp > 3000 || timestamp - now > 5000))
      return false;
    const impulse = impulseFor(event);
    if (!impulse) return false;
    this.add(impulse, time);
    return true;
  }
}
