import { FORM_KEYS } from "./forms.js";

// Each operational phase owns one moveset so the silhouette itself reads as state:
// planning orbits, thinking bristles, working rolls, searching slices, tool turns,
// generating radiates, reviewing crystallizes, success signs off and error shatters.
export const ORB_PROFILES = Object.freeze({
  connecting: {
    speed: 0.0003,
    energy: 0.2,
    turbulence: 0.08,
    swirl: 0.2,
    wave: 0.2,
    color: [92, 222, 238],
  },
  offline: {
    speed: 0.00008,
    energy: 0.04,
    turbulence: 0,
    swirl: 0,
    wave: 0,
    color: [83, 106, 116],
  },
  idle: {
    speed: 0.00058,
    energy: 0.27,
    turbulence: 0.1,
    swirl: 0.32,
    wave: 0.28,
    color: [91, 225, 239],
  },
  listening: {
    speed: 0.0002,
    energy: 0.26,
    turbulence: 0.035,
    swirl: 0.25,
    wave: 0.2,
    focus: 0.22,
    color: [153, 229, 255],
  },
  planning: {
    speed: 0.00036,
    energy: 0.38,
    turbulence: 0.12,
    swirl: 0.62,
    wave: 0.42,
    cluster: 0.3,
    rings: 1,
    color: [184, 140, 255],
  },
  thinking: {
    speed: 0.00062,
    energy: 0.65,
    turbulence: 0.24,
    swirl: 1,
    wave: 0.9,
    cluster: 0.45,
    spike: 1,
    color: [112, 238, 255],
  },
  working: {
    speed: 0.0004,
    energy: 0.44,
    turbulence: 0.09,
    swirl: 0.66,
    wave: 0.35,
    flow: 0.9,
    torus: 1,
    color: [91, 215, 247],
  },
  searching: {
    speed: 0.00052,
    energy: 0.46,
    turbulence: 0.1,
    swirl: 0.85,
    wave: 0.88,
    flow: 0.38,
    slice: 1,
    color: [103, 191, 255],
  },
  tool: {
    speed: 0.00068,
    energy: 0.5,
    turbulence: 0.18,
    swirl: 0.7,
    wave: 0.55,
    focus: 0.8,
    gear: 1,
    color: [107, 226, 255],
  },
  generating: {
    speed: 0.00058,
    energy: 0.56,
    turbulence: 0.14,
    swirl: 0.6,
    wave: 0.7,
    flow: -0.8,
    emit: 1,
    color: [186, 141, 255],
  },
  waiting: {
    speed: 0.00008,
    energy: 0.12,
    turbulence: 0.025,
    swirl: 0.12,
    wave: 0.06,
    color: [101, 139, 152],
  },
  waiting_approval: {
    speed: 0.00011,
    energy: 0.3,
    turbulence: 0.04,
    swirl: 0.24,
    wave: 0.16,
    pulse: 0.75,
    color: [255, 209, 102],
  },
  reviewing: {
    speed: 0.0003,
    energy: 0.32,
    turbulence: 0.08,
    swirl: 0.72,
    wave: 0.55,
    lattice: 1,
    color: [191, 156, 255],
  },
  success: {
    speed: 0.00022,
    energy: 0.36,
    turbulence: 0.04,
    swirl: 0.32,
    wave: 0.3,
    burst: 0.62,
    check: 1,
    color: [89, 246, 191],
  },
  error: {
    speed: 0.0002,
    energy: 0.3,
    turbulence: 0.26,
    swirl: 0.25,
    wave: 0.15,
    fragment: 0.7,
    spike: 1,
    jag: 1,
    color: [255, 107, 141],
  },
  fallback: {
    speed: 0.00032,
    energy: 0.35,
    turbulence: 0.08,
    swirl: 0.44,
    wave: 0.42,
    pulse: 0.5,
    color: [255, 185, 89],
  },
  cancelled: {
    speed: 0.00004,
    energy: 0.06,
    turbulence: 0.02,
    swirl: 0.08,
    wave: 0.04,
    color: [106, 132, 142],
  },
});

const smoothstep = (a, b, n) => {
  const t = Math.max(0, Math.min(1, (n - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

const aliases = { running: "working", succeeded: "success", failed: "error" };
export function normalizeOrbState(state) {
  const normalized = aliases[state] || state;
  return Object.hasOwn(ORB_PROFILES, normalized) ? normalized : "offline";
}

export const PROFILE_KEYS = [
  "speed",
  "energy",
  "turbulence",
  "swirl",
  "wave",
  "flow",
  "focus",
  "pulse",
  "cluster",
  "fragment",
  "burst",
  "scan",
  "jag",
  ...FORM_KEYS,
];
// Shape changes are slower than energy changes so morphs read as deliberate.
const FORM_SET = new Set([...FORM_KEYS, "jag"]);

// One-shot envelopes (age in seconds since the phase began).
export const ONE_SHOTS = Object.freeze({
  fragment: (age) => Math.max(0, 1 - age / 1.8),
  burst: (age) => Math.max(0, 1 - age / 2.4),
  // Error spines lash out and retract; a verified success draws its check, then lets go.
  spike: (age, phase) => (phase === "error" ? Math.max(0, 1 - age / 1.5) ** 1.5 : 1),
  check: (age, phase) =>
    phase === "success" ? smoothstep(0, 0.55, age) * (1 - smoothstep(2.1, 3, age)) : 1,
});
export function profileFor(state, reducedMotion = false, age = 0) {
  const phase = normalizeOrbState(state);
  // A completion wave is one-shot; the authoritative label is kept until the next snapshot.
  const source = ORB_PROFILES[phase === "success" && age > 2.4 ? "idle" : phase];
  const profile = Object.fromEntries(PROFILE_KEYS.map((key) => [key, source[key] || 0]));
  profile.color = [...source.color];
  profile.scan = phase === "searching" ? 1 : phase === "reviewing" ? 0.5 : 0;
  for (const [key, envelope] of Object.entries(ONE_SHOTS)) profile[key] *= envelope(age, phase);
  if (reducedMotion) {
    for (const key of PROFILE_KEYS) if (key !== "energy") profile[key] = 0;
  }
  return profile;
}

export function blendProfile(current, target, dt) {
  const amount = 1 - Math.exp(-Math.max(0, dt) * 4.5);
  const morph = 1 - Math.exp(-Math.max(0, dt) * 2.6);
  for (const key of PROFILE_KEYS)
    current[key] += (target[key] - current[key]) * (FORM_SET.has(key) ? morph : amount);
  for (let i = 0; i < 3; i++) current.color[i] += (target.color[i] - current.color[i]) * amount;
  return current;
}

export const QUALITY = Object.freeze({
  low: { count: 1600, dpr: 1, bloom: false, links: 0 },
  medium: { count: 2400, dpr: 1.5, bloom: false, links: 40 },
  high: { count: 3200, dpr: 1.75, bloom: false, links: 60 },
});
export function selectQuality({ width = 1280, cores = 8, memory = 8, reducedMotion = false } = {}) {
  if (reducedMotion || width < 600 || cores <= 2 || memory <= 2) return "low";
  if (width < 1100 || cores <= 4 || memory <= 4) return "medium";
  return "high";
}
export function lowerQuality(quality) {
  return quality === "high" ? "medium" : "low";
}
export function chooseRenderer(webgl2Available) {
  return webgl2Available ? "webgl2" : "canvas2d";
}
