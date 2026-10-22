import {
  ORB_PROFILES,
  ONE_SHOTS,
  normalizeOrbState,
  profileFor,
  blendProfile,
} from "./profiles.js";
import { clamp, seededRandom } from "./math.js";
import { ImpulseQueue } from "./impulses.js";
import { FORM_KEYS, createFrames, updateFrames, heartbeat, normalizeForms } from "./forms.js";

const CHARGE_TIME = 1.15;
const IDLE_BLOOM = Object.freeze({ amount: 0.5, duration: 4.6, quiet: 8, gap: [18, 32] });

// Only setState changes backend truth. Posture, attention and gestures are independent.
export class OrbController {
  constructor() {
    this.state = "connecting";
    this.connections = {};
    this.time = this.phase = this.stateSince = 0;
    this.reducedMotion = false;
    this.profile = profileFor(this.state);
    this.target = profileFor(this.state);
    this.impulses = new ImpulseQueue();
    this.attention = new Float32Array([0, 0, 0.6, 0]);
    this.attentionTarget = new Float32Array([0, 0, 0.6, 0]);
    this.pointerTracking = false;
    this.focused = false;
    this.typingAt = -Infinity;
    this.posture = this.yaw = this.pitch = 0;
    this.motion = 1;
    // Final per-frame form weights (state profile + user gestures), normalized.
    this.forms = Object.fromEntries(FORM_KEYS.map((key) => [key, 0]));
    this.formFrames = updateFrames(createFrames(), 0, 0);
    this.beat = this.jag = this.spikeSpin = 0;
    this.random = seededRandom(0x4f524221);
    this.gesture = {
      pokeAt: -Infinity,
      poke: 0,
      charging: false,
      charge: 0,
      releasedAt: -Infinity,
      released: 0,
      bloomAt: -Infinity,
      nextBloom: 14,
      interactedAt: 0,
    };
  }
  get gesturesAllowed() {
    return !this.reducedMotion && this.state !== "offline";
  }
  setState(value) {
    const state = normalizeOrbState(value);
    if (state === this.state) return false;
    this.state = state;
    this.stateSince = this.time;
    this.settled = false;
    this.target = profileFor(state, this.reducedMotion);
    if (state === "offline") {
      this.impulses.clear();
      this.cancelGestures();
      // Never interpolate through lingering green when disconnected.
      this.profile.color = [...this.target.color];
    }
    return true;
  }
  setConnections(connections) {
    this.connections = { ...connections };
  }
  setInteraction({ focused = this.focused, typing = false } = {}) {
    this.focused = Boolean(focused);
    this.typingAt = typing ? this.time : -Infinity;
    if (this.focused || typing) this.gesture.interactedAt = this.time;
  }
  setAttention(value) {
    if (typeof value === "boolean") {
      this.setInteraction({ focused: value });
      return;
    }
    const { x = 0, y = 0, active = false } = value || {};
    this.pointerTracking = Boolean(active);
    if (active) this.gesture.interactedAt = this.time;
    this.attentionTarget.set([clamp(x, -1, 1), clamp(y, -1, 1), 0.6, active ? 1 : 0]);
  }
  setReducedMotion(reduced) {
    this.reducedMotion = Boolean(reduced);
    this.target = profileFor(this.state, this.reducedMotion, this.time - this.stateSince);
    if (reduced) {
      this.profile = profileFor(this.state, true);
      this.impulses.clear();
      this.cancelGestures();
    }
  }
  emit(event, now = Date.now()) {
    if (this.reducedMotion || this.state === "offline") return false;
    return this.impulses.emit(event, this.time, now);
  }
  ripple(x = 0, y = 0, strength = 0.65) {
    if (!this.reducedMotion) this.impulses.add({ kind: 1, strength, x, y, z: 0.35 }, this.time);
  }
  // A tap makes the body bristle briefly. Gestures never touch operational state.
  poke(amount = 0.5) {
    if (!this.gesturesAllowed) return false;
    this.gesture.pokeAt = this.time;
    this.gesture.poke = clamp(amount, 0, 1);
    this.gesture.interactedAt = this.time;
    return true;
  }
  // Press-and-hold: spines grow and spin up; release fires a shockwave and snaps back.
  beginCharge() {
    if (!this.gesturesAllowed) return false;
    this.gesture.charging = true;
    this.gesture.interactedAt = this.time;
    return true;
  }
  endCharge() {
    const g = this.gesture;
    if (!g.charging) return 0;
    g.charging = false;
    const level = g.charge;
    g.charge = 0;
    g.released = level;
    g.releasedAt = this.time;
    g.interactedAt = this.time;
    if (level > 0.2) this.ripple(0, 0, 0.35 + level * 0.55);
    return level;
  }
  cancelGestures() {
    const g = this.gesture;
    g.charging = false;
    g.charge = g.poke = g.released = 0;
    g.pokeAt = g.releasedAt = g.bloomAt = -Infinity;
  }
  gestureForms(dt) {
    const g = this.gesture,
      t = this.time;
    let spike = 0,
      bloom = 0;
    if (g.charging) {
      g.charge = Math.min(1, g.charge + dt / CHARGE_TIME);
      // Eased so a short press barely stirs and a full hold becomes a spiked ball.
      spike += g.charge * g.charge * (3 - 2 * g.charge);
    }
    const released = t - g.releasedAt;
    if (released >= 0 && released < 1.6)
      spike += g.released * Math.exp(-released * 3.6) * Math.abs(Math.cos(released * 7.5));
    const poked = t - g.pokeAt;
    if (poked >= 0 && poked < 1.4)
      spike += g.poke * (poked < 0.08 ? poked / 0.08 : Math.exp(-(poked - 0.08) * 4.2));
    // Idle is never frozen: after a quiet spell the body slowly blooms, like a breath.
    if (this.state === "idle" && t - this.stateSince > 6) {
      if (t >= g.nextBloom && t - g.interactedAt > IDLE_BLOOM.quiet) {
        const [min, max] = IDLE_BLOOM.gap;
        g.bloomAt = t;
        g.nextBloom = t + min + this.random() * (max - min);
      }
    } else g.nextBloom = Math.max(g.nextBloom, t + IDLE_BLOOM.quiet);
    const bloomed = t - g.bloomAt;
    if (bloomed >= 0 && bloomed < IDLE_BLOOM.duration)
      bloom += IDLE_BLOOM.amount * Math.sin((Math.PI * bloomed) / IDLE_BLOOM.duration) ** 2;
    return { spike, bloom };
  }
  tick(dt) {
    this.time += dt;
    const age = this.time - this.stateSince;
    if (this.state === "success" && age > 2.4 && !this.settled) {
      this.target = profileFor("idle", this.reducedMotion);
      this.settled = true;
    }
    if (!this.reducedMotion)
      for (const [key, envelope] of Object.entries(ONE_SHOTS))
        this.target[key] = (ORB_PROFILES[this.state][key] || 0) * envelope(age, this.state);
    blendProfile(this.profile, this.target, dt);
    this.phase += dt * this.profile.speed * 1000;
    const smoothing = 1 - Math.exp(-dt * 5);
    // When nothing is happening, let the orb quietly survey its surroundings.
    // Pointer input replaces this motion; leaving the stage returns to the scan.
    if (!this.pointerTracking && !this.focused) {
      const gazeX = Math.sin(this.time * 0.23) * 0.3 + Math.sin(this.time * 0.071) * 0.12;
      const gazeY = Math.sin(this.time * 0.16 + 1.3) * 0.18;
      this.attentionTarget.set([gazeX, gazeY, 0.6, 0.34]);
    } else if (this.focused && !this.pointerTracking) {
      this.attentionTarget.set([0, 0.08, 0.6, 0.48]);
    }
    for (let i = 0; i < 4; i++)
      this.attention[i] += (this.attentionTarget[i] - this.attention[i]) * smoothing;
    const posture = this.focused || this.time - this.typingAt < 0.7 ? 1 : 0;
    this.posture += (posture - this.posture) * smoothing;
    // Offline remains quiet and gray, but still has a small visible organic drift.
    this.motion = this.reducedMotion ? 0 : this.state === "offline" ? 0.24 : 1;
    this.yaw =
      (this.attention[0] * this.attention[3] * 0.098 + Math.sin(this.time * 0.12) * 0.014) *
      this.motion;
    this.pitch =
      (this.attention[1] * this.attention[3] * 0.07 + Math.cos(this.time * 0.1) * 0.011) *
      this.motion;
    this.updateForms(dt);
  }
  updateForms(dt) {
    const forms = this.forms;
    if (!this.gesturesAllowed) {
      for (const key of FORM_KEYS) forms[key] = 0;
      this.beat = this.jag = 0;
      return;
    }
    for (const key of FORM_KEYS) forms[key] = this.profile[key];
    // Approval and fallback bristle on each heartbeat, asking for attention.
    this.beat = heartbeat(this.time);
    forms.spike += this.profile.pulse * this.beat * 0.55;
    const gesture = this.gestureForms(dt);
    forms.spike += gesture.spike;
    forms.bloom += gesture.bloom;
    normalizeForms(forms);
    this.jag = clamp(this.profile.jag, 0, 1);
    this.spikeSpin += dt * (0.16 + this.gesture.charge * 1.5 + forms.spike * 0.12);
    updateFrames(this.formFrames, this.time, this.spikeSpin);
  }
  // The strongest form, for diagnostics and styling hooks ("sphere" when none).
  get dominantForm() {
    let best = "sphere",
      weight = 0.2;
    for (const key of FORM_KEYS)
      if (this.forms[key] > weight) {
        best = key;
        weight = this.forms[key];
      }
    return best;
  }
}
