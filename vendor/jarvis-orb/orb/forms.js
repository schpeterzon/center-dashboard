// Orb movesets: bounded, antipodally balanced morph targets for the particle body.
// The GLSL in shaders.js is generated from these constants, and morphPoint mirrors it
// for the Canvas2D fallback and tests. Every form stays inside FORM_EXTENT so the
// entity never clips its stage, and every form keeps a zero centroid.

export const FORM_KEYS = Object.freeze([
  "spike",
  "rings",
  "torus",
  "lattice",
  "gear",
  "slice",
  "emit",
  "bloom",
  "check",
]);

// Largest object-space radius any form may reach. The stage shows ~1.38 units at z=0.
export const FORM_EXTENT = 1.24;
// Everything drawn (forms, ripples, attention) is softly limited to this radius.
export const STAGE_LIMIT = Object.freeze({ knee: 1.16, max: 1.3 });
// Share of the organic flow field that survives inside a fully formed shape.
export const FORM_DRIFT = 0.28;

const PHI = (1 + Math.sqrt(5)) / 2;
// Dodecahedron vertices: 20 evenly spread spines. Entry i and i+10 are antipodes,
// so paired lengths keep the urchin balanced even while its spines swell and jitter.
const HALF = [
  [1, 1, 1],
  [1, 1, -1],
  [1, -1, 1],
  [1, -1, -1],
  [0, 1 / PHI, PHI],
  [0, 1 / PHI, -PHI],
  [1 / PHI, PHI, 0],
  [1 / PHI, -PHI, 0],
  [PHI, 0, 1 / PHI],
  [-PHI, 0, 1 / PHI],
].map(([x, y, z]) => {
  const length = Math.hypot(x, y, z);
  return [x / length, y / length, z / length];
});
export const SPIKE_AXES = Object.freeze([...HALF, ...HALF.map(([x, y, z]) => [-x, -y, -z])]);
export const SPIKE = Object.freeze({ width: 0.3, length: 0.98, core: 0.62, pinch: 0.95 });
export const RING = Object.freeze({ radius: 1.0, share: 0.62, nucleus: 0.44, tilt: 1.2 });
export const TORUS = Object.freeze({ radius: 0.74, tube: 0.3 });
export const LATTICE = Object.freeze({ half: 0.64, edge: 0.6 });
export const GEAR = Object.freeze({
  teeth: 8,
  depth: 0.24,
  inner: 0.6,
  outer: 0.84,
  hub: 0.3,
  flatten: 0.18,
});
export const SLICE = Object.freeze({ bands: 3.5, core: 0.55 });
export const EMIT = Object.freeze({ reach: 1.2, speed: 0.34, shell: 0.7, lean: 0.35 });
// Twelve soft lobes on the icosahedron's axes: a slow, rounded bloom.
const ICOSA = [
  [0, 1, PHI],
  [0, 1, -PHI],
  [1, PHI, 0],
  [1, -PHI, 0],
  [PHI, 0, 1],
  [-PHI, 0, 1],
].map(([x, y, z]) => {
  const length = Math.hypot(x, y, z);
  return [x / length, y / length, z / length];
});
export const BLOOM_AXES = Object.freeze(ICOSA);
export const BLOOM = Object.freeze({ floor: 0.795, base: 0.9, swell: 0.14 });
// Verified completion draws a check mark: two strokes, recentred on their centroid.
export const CHECK = (() => {
  const points = [
    [-0.72, 0.02],
    [-0.23, -0.49],
    [0.76, 0.58],
  ];
  const first = Math.hypot(points[1][0] - points[0][0], points[1][1] - points[0][1]);
  const second = Math.hypot(points[2][0] - points[1][0], points[2][1] - points[1][1]);
  const cx =
    (((points[0][0] + points[1][0]) / 2) * first + ((points[1][0] + points[2][0]) / 2) * second) /
    (first + second);
  const cy =
    (((points[0][1] + points[1][1]) / 2) * first + ((points[1][1] + points[2][1]) / 2) * second) /
    (first + second);
  return Object.freeze({
    points: points.map(([x, y]) => [x - cx, y - cy]),
    first,
    second,
    tube: 0.06,
    glow: 0.11,
  });
})();

const fract = (n) => n - Math.floor(n);
const smoothstep = (a, b, n) => {
  const t = Math.max(0, Math.min(1, (n - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
// GLSL-style hash; the argument stays small so precision is stable on mobile GPUs.
export const hash = (n) => fract(Math.sin(n) * 43758.5453);

// Approval "lub-dub": two beats per 1.5 s, peak ~1.
export function heartbeat(time) {
  const t = fract(time / 1.5);
  return Math.exp(-(((t - 0.07) / 0.05) ** 2)) + 0.6 * Math.exp(-(((t - 0.25) / 0.06) ** 2));
}

// Column-major world->form matrices; the rows are the form's axes in world space.
function store(out, a, b, c, offset = 0) {
  for (let i = 0; i < 3; i++) {
    out[offset + i * 3] = a[i];
    out[offset + i * 3 + 1] = b[i];
    out[offset + i * 3 + 2] = c[i];
  }
  return out;
}
const cross = (a, b) => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
// Object orientation: spin about the form's own vertical, then tilt toward the viewer.
function oriented(out, spin, tilt, roll = 0) {
  const cs = Math.cos(spin),
    ss = Math.sin(spin),
    ct = Math.cos(tilt),
    st = Math.sin(tilt),
    cr = Math.cos(roll),
    sr = Math.sin(roll);
  // Local axes in world space: Rz(roll) * Rx(tilt) * Ry(spin) applied to unit axes.
  const axis = (x, y, z) => {
    const x1 = cs * x + ss * z,
      z1 = -ss * x + cs * z;
    const y2 = ct * y - st * z1,
      z2 = st * y + ct * z1;
    return [cr * x1 - sr * y2, sr * x1 + cr * y2, z2];
  };
  return store(out, axis(1, 0, 0), axis(0, 1, 0), axis(0, 0, 1));
}
function axisAngle(out, axis, angle) {
  const [x, y, z] = axis,
    c = Math.cos(angle),
    s = Math.sin(angle),
    t = 1 - c;
  return store(
    out,
    [t * x * x + c, t * x * y - s * z, t * x * z + s * y],
    [t * x * y + s * z, t * y * y + c, t * y * z - s * x],
    [t * x * z - s * y, t * y * z + s * x, t * z * z + c],
  );
}
const SPIN_AXIS = (() => {
  const v = [0.32, 0.9, 0.29];
  const l = Math.hypot(...v);
  return v.map((n) => n / l);
})();

export function createFrames() {
  return {
    spike: new Float32Array(9),
    rings: new Float32Array(27),
    torus: new Float32Array(9),
    lattice: new Float32Array(9),
    gear: new Float32Array(9),
    bloom: new Float32Array(9),
    check: new Float32Array(9),
    jet: new Float32Array(3),
  };
}

// Frames depend only on the controller clock and the integrated spine spin.
export function updateFrames(frames, time, spikeSpin = 0) {
  axisAngle(frames.spike, SPIN_AXIS, spikeSpin);
  // Three orbits 120° apart, each steeply inclined: the classic atom mark, slowly precessing.
  for (let k = 0; k < 3; k++) {
    const theta = time * 0.11 + (k * 2 * Math.PI) / 3;
    const sin = Math.sin(RING.tilt);
    const normal = [sin * Math.cos(theta), sin * Math.sin(theta), Math.cos(RING.tilt)];
    const tangent = [-Math.sin(theta), Math.cos(theta), 0];
    store(frames.rings, tangent, cross(normal, tangent), normal, k * 9);
  }
  const wobble = Math.sin(time * 0.31) * 0.16;
  const up = [0, Math.cos(1.02), Math.sin(1.02)],
    side = [1, 0, 0];
  const rz = (v) => [
    Math.cos(wobble) * v[0] - Math.sin(wobble) * v[1],
    Math.sin(wobble) * v[0] + Math.cos(wobble) * v[1],
    v[2],
  ];
  store(frames.torus, rz(side), rz(up), rz(cross(side, up)));
  oriented(frames.lattice, time * 0.24, 0.5, 0.2);
  oriented(frames.gear, time * 0.55, 0.95, 0.12);
  oriented(frames.bloom, time * 0.21, 0.62, 0.3);
  // The check turns gently so it reads as an object in space, not a flat icon.
  oriented(frames.check, Math.sin(time * 0.9) * 0.28, 0.08);
  // Bipolar jets turn in the screen plane like a lighthouse beam, so they stay legible.
  const sweep = time * 0.3 + 0.6;
  const norm = Math.hypot(1, EMIT.lean);
  frames.jet[0] = Math.sin(sweep) / norm;
  frames.jet[1] = Math.cos(sweep) / norm;
  frames.jet[2] = EMIT.lean / norm;
  return frames;
}

const mul = (m, x, y, z, o = 0) => [
  m[o] * x + m[o + 3] * y + m[o + 6] * z,
  m[o + 1] * x + m[o + 4] * y + m[o + 7] * z,
  m[o + 2] * x + m[o + 5] * y + m[o + 8] * z,
];
const mulT = (m, x, y, z, o = 0) => [
  m[o] * x + m[o + 1] * y + m[o + 2] * z,
  m[o + 3] * x + m[o + 4] * y + m[o + 5] * z,
  m[o + 6] * x + m[o + 7] * y + m[o + 8] * z,
];

// Weights never extrapolate: each stays in [0, 1] and their sum is capped at 1, so a
// blended body is always a convex mix of bounded forms.
export function normalizeForms(forms) {
  let sum = 0;
  for (const key of FORM_KEYS) {
    forms[key] = Math.max(0, Math.min(1, forms[key] || 0));
    sum += forms[key];
  }
  if (sum > 1) for (const key of FORM_KEYS) forms[key] /= sum;
  return forms;
}

// JS mirror of applyForms() in shaders.js for a point on the resting body.
// Returns [x, y, z, glow, fade].
export function morphPoint(point, forms, frames, time, jag = 0) {
  const { x, y, z, seed = 0, shell = 1, group = 0 } = point;
  const r = Math.hypot(x, y, z);
  const s = Math.max(r, 1e-4);
  const nx = x / s,
    ny = y / s,
    nz = z / s;
  let ox = x,
    oy = y,
    oz = z,
    glow = 0,
    fade = 1;
  const blend = (weight, target) => {
    ox += (target[0] - x) * weight;
    oy += (target[1] - y) * weight;
    oz += (target[2] - z) * weight;
  };

  if (forms.spike > 0.001) {
    const q = mul(frames.spike, nx, ny, nz);
    let best = -2,
      id = 0;
    for (let i = 0; i < SPIKE_AXES.length; i++) {
      const a = SPIKE_AXES[i];
      const dot = q[0] * a[0] + q[1] * a[1] + q[2] * a[2];
      if (dot > best) {
        best = dot;
        id = i;
      }
    }
    const axis = SPIKE_AXES[id];
    const u = Math.min(1, Math.acos(Math.max(-1, Math.min(1, best))) / SPIKE.width);
    const w = 1 - u * u;
    const k = axis[0] * 0.52 + axis[1] * 0.76 - axis[2] * 0.39;
    const swell = 0.5 + 0.5 * Math.sin(time * 1.7 - k * k * 6);
    const glitch = hash((id % 10) * 1.7 + (Math.floor(time * 9) % 97) * 0.37);
    const length = SPIKE.length * (0.7 + 0.3 * swell) * (1 + (0.35 + 0.65 * glitch - 1) * jag);
    // Pinch grows toward the tip, so each spine is a needle with a flared root.
    const pinch = SPIKE.pinch * Math.sqrt(w);
    const dx = q[0] + (axis[0] - q[0]) * pinch,
      dy = q[1] + (axis[1] - q[1]) * pinch,
      dz = q[2] + (axis[2] - q[2]) * pinch;
    const scale = (r * SPIKE.core * (1 + length * w)) / (Math.hypot(dx, dy, dz) || 1);
    blend(forms.spike, mulT(frames.spike, dx * scale, dy * scale, dz * scale));
    glow = Math.max(glow, w * 0.7 * forms.spike);
  }

  if (forms.rings > 0.001) {
    if (group < 0.5 || shell < 0.9 || fract(seed * 3.7) >= RING.share)
      blend(forms.rings, [x * RING.nucleus, y * RING.nucleus, z * RING.nucleus]);
    else {
      const k = Math.round(group) - 1,
        o = k * 9;
      const q = mul(frames.rings, x, y, z, o);
      const angle = Math.atan2(q[1], q[0]) + time * 0.55 * (k === 1 ? -1 : 1) * (1 + 0.12 * k);
      const radius = RING.radius + (fract(seed * 9.1) - 0.5) * 0.024;
      blend(
        forms.rings,
        mulT(frames.rings, Math.cos(angle) * radius, Math.sin(angle) * radius, q[2] * 0.03, o),
      );
      glow = Math.max(glow, 0.55 * forms.rings);
    }
  }

  if (forms.torus > 0.001) {
    const q = mul(frames.torus, nx, ny, nz);
    const phi = Math.atan2(q[2], q[0]) + time * 0.32;
    const theta = Math.PI * q[1] + time * 1.25;
    const tube = TORUS.tube * Math.min(1, r / 0.98);
    const ring = TORUS.radius + tube * Math.cos(theta);
    blend(
      forms.torus,
      mulT(frames.torus, ring * Math.cos(phi), tube * Math.sin(theta), ring * Math.sin(phi)),
    );
  }

  if (forms.lattice > 0.001) {
    const q = mul(frames.lattice, nx, ny, nz);
    const a = q.map(Math.abs);
    const max = Math.max(...a),
      min = Math.min(...a);
    const mid = a[0] + a[1] + a[2] - max - min;
    // Project onto the unit cube, then draw membrane points toward the nearest edge
    // so the crystal reads as a wireframe rather than a fuzzy box.
    const pull = shell >= 0.9 ? LATTICE.edge : 0;
    const u = q.map((n, i) => {
      const unit = n / Math.max(max, 1e-4);
      const middle = a[i] > min + 1e-6 && a[i] < max - 1e-6;
      return middle ? unit + Math.sign(unit) * (1 - Math.abs(unit)) * pull : unit;
    });
    const scale = LATTICE.half * r;
    blend(forms.lattice, mulT(frames.lattice, u[0] * scale, u[1] * scale, u[2] * scale));
    glow = Math.max(glow, smoothstep(0.82, 1, mid / Math.max(max, 1e-4)) * 0.8 * forms.lattice);
  }

  if (forms.gear > 0.001) {
    const q = mul(frames.gear, nx, ny, nz);
    const rho = Math.hypot(q[0], q[2]);
    const angle = Math.atan2(q[2], q[0]);
    const tooth = smoothstep(-0.18, 0.18, Math.sin(angle * GEAR.teeth));
    const rim = smoothstep(0.8, 0.97, rho);
    // The membrane becomes a toothed ring; the interior becomes a separate hub.
    const radius =
      shell < 0.9
        ? GEAR.hub * Math.min(1, r / 0.55)
        : GEAR.inner + (GEAR.outer - GEAR.inner) * rho * rho + GEAR.depth * tooth * rim;
    blend(
      forms.gear,
      mulT(
        frames.gear,
        Math.cos(angle) * radius,
        q[1] * GEAR.flatten * r,
        Math.sin(angle) * radius,
      ),
    );
    glow = Math.max(glow, tooth * rim * 0.6 * forms.gear);
  }

  if (forms.slice > 0.001) {
    if (shell < 0.9) blend(forms.slice, [x * SLICE.core, y * SLICE.core, z * SLICE.core]);
    else {
      const band = Math.floor(y * SLICE.bands + 0.5);
      const level = band / SLICE.bands;
      const planar = Math.sqrt(Math.max(r * r - level * level, 0));
      const h = Math.max(Math.hypot(x, z), 1e-4);
      // Alternate bands counter-rotate like the dials of a scanner.
      const spin = time * 0.5 * (fract(band / 2) > 0.25 ? 1 : -1);
      const px = (x / h) * planar,
        pz = (z / h) * planar;
      const c = Math.cos(spin),
        sn = Math.sin(spin);
      blend(forms.slice, [c * px - sn * pz, level, sn * px + c * pz]);
      glow = Math.max(glow, 0.35 * forms.slice);
    }
  }

  if (forms.emit > 0.001) {
    if (shell >= 0.9) blend(forms.emit, [x * EMIT.shell, y * EMIT.shell, z * EMIT.shell]);
    else {
      const jet = frames.jet;
      const along = nx * jet[0] + ny * jet[1] + nz * jet[2];
      const side = along >= 0 ? 1 : -1;
      const t = fract(seed * 5.31 + time * EMIT.speed);
      const reach = side * (0.24 + (EMIT.reach - 0.24) * t);
      const spread = 0.03 + 0.08 * t;
      blend(forms.emit, [
        jet[0] * reach + (nx - jet[0] * along) * spread,
        jet[1] * reach + (ny - jet[1] * along) * spread,
        jet[2] * reach + (nz - jet[2] * along) * spread,
      ]);
      const life = smoothstep(0, 0.12, t) * (1 - smoothstep(0.72, 1, t));
      fade = 1 + (life - 1) * forms.emit;
      glow = Math.max(glow, 0.5 * forms.emit);
    }
  }

  if (forms.bloom > 0.001) {
    const q = mul(frames.bloom, nx, ny, nz);
    let peak = 0;
    for (const a of BLOOM_AXES)
      peak = Math.max(peak, Math.abs(q[0] * a[0] + q[1] * a[1] + q[2] * a[2]));
    const lobe = Math.max(0, (peak - BLOOM.floor) / (1 - BLOOM.floor));
    const scale = BLOOM.base + BLOOM.swell * lobe * lobe;
    blend(forms.bloom, [x * scale, y * scale, z * scale]);
  }

  if (forms.check > 0.001) {
    const [a, b, c] = CHECK.points;
    const along = fract(seed * 9) * (CHECK.first + CHECK.second);
    const stroke =
      along < CHECK.first
        ? [a, b, along / CHECK.first]
        : [b, c, (along - CHECK.first) / CHECK.second];
    const [from, to, t] = stroke;
    const tube = shell < 0.9 ? CHECK.glow : CHECK.tube;
    blend(
      forms.check,
      mulT(
        frames.check,
        from[0] + (to[0] - from[0]) * t + nx * tube,
        from[1] + (to[1] - from[1]) * t + ny * tube,
        nz * tube,
      ),
    );
    glow = Math.max(glow, (shell < 0.9 ? 0.2 : 0.7) * forms.check);
  }

  return [ox, oy, oz, glow, fade];
}
