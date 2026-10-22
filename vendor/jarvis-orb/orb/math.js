export const clamp = (n, min, max) => Math.max(min, Math.min(max, n));

export function seededRandom(seed = 0x4a415256) {
  return () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 4294967296;
  };
}

// Antipodal pairs retain a zero centroid at every quality level. A seeded,
// stratified mixture gives the core density without an opaque central object.
export function createOrbPoints(count) {
  const random = seededRandom();
  const points = [];
  for (let i = 0; i < Math.floor(count / 2); i++) {
    const z = random() * 2 - 1;
    const phi = random() * Math.PI * 2;
    const shell =
      i % 3 === 0 ? 0.09 + 0.46 * Math.cbrt(random()) : 0.42 + 0.58 * Math.cbrt(random());
    const planar = Math.sqrt(1 - z * z);
    const x = Math.cos(phi) * planar * shell;
    const y = Math.sin(phi) * planar * shell;
    const seed = random();
    const weight = 0.65 + random() * 0.7;
    const group = i % 4;
    points.push({ x, y, z: z * shell, shell, seed, weight, group });
    points.push({ x: -x, y: -y, z: -z * shell, shell, seed, weight, group });
  }
  if (count % 2) points.push({ x: 0, y: 0, z: 0, shell: 0, seed: 0, weight: 0.8, group: 0 });
  return points;
}

export function packPoints(points) {
  const data = new Float32Array(points.length * 7);
  points.forEach((p, i) => data.set([p.x, p.y, p.z, p.seed, p.shell, p.weight, p.group], i * 7));
  return data;
}

export function createFilaments(points, limit = 280, threshold = 0.19) {
  const edges = [];
  const grid = new Map();
  const key = (x, y, z) => `${x},${y},${z}`;
  // Bounded initialization work; no all-pairs or per-frame neighbor search.
  for (let i = 0; i < Math.min(points.length, 2400) && edges.length < limit; i++) {
    const p = points[i];
    const x = Math.floor(p.x / threshold),
      y = Math.floor(p.y / threshold),
      z = Math.floor(p.z / threshold);
    let found = false;
    for (let dx = -1; dx <= 1 && !found; dx++)
      for (let dy = -1; dy <= 1 && !found; dy++)
        for (let dz = -1; dz <= 1 && !found; dz++) {
          for (const j of grid.get(key(x + dx, y + dy, z + dz)) || []) {
            const q = points[j];
            const distance = Math.hypot(p.x - q.x, p.y - q.y, p.z - q.z);
            if (distance > 0.06 && distance < threshold) {
              edges.push([i, j]);
              found = true;
              break;
            }
          }
        }
    const k = key(x, y, z);
    if (!grid.has(k)) grid.set(k, []);
    grid.get(k).push(i);
  }
  return edges;
}

export function perspective(out, aspect) {
  out.fill(0);
  const f = 1 / Math.tan((42 * Math.PI) / 360);
  out[0] = f / Math.max(0.01, aspect);
  out[5] = f;
  out[10] = -1.01005;
  out[11] = -1;
  out[14] = -0.201005;
  return out;
}

export function camera(out, yaw, pitch) {
  const cy = Math.cos(yaw),
    sy = Math.sin(yaw),
    cx = Math.cos(pitch),
    sx = Math.sin(pitch);
  // Column-major view matrix. Rotation is around the entity, never a globe spin.
  out.set([cy, sx * sy, -cx * sy, 0, 0, cx, sx, 0, sy, -sx * cy, cx * cy, 0, 0, 0, -3.6, 1]);
  return out;
}

export function identity() {
  return new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
}
