import { createOrbPoints } from "./math.js";
import { morphPoint } from "./forms.js";
import { atmosphereColor } from "../atmosphere.js";

// Local perspective ASCII fallback when WebGL2 is unavailable or its context is lost.
// It shares the WebGL movesets through morphPoint, at a lighter particle count.
export class CanvasOrbFallback {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    // Same legible outer membrane as the WebGL body.
    this.points = createOrbPoints(1000).map((point) => {
      const scale = point.shell > 0.55 ? 0.98 / point.shell : 1;
      return {
        ...point,
        x: point.x * scale,
        y: point.y * scale,
        z: point.z * scale,
        shell: point.shell > 0.55 ? 0.98 : point.shell,
      };
    });
  }
  resize(width, height, _quality, dpr = 1) {
    this.dpr = Math.min(dpr, 1.5);
    this.width = width;
    this.height = height;
    this.canvas.width = Math.max(1, Math.round(width * this.dpr));
    this.canvas.height = Math.max(1, Math.round(height * this.dpr));
  }
  draw(state) {
    const ctx = this.ctx;
    if (!ctx) return;
    const time = state.reducedMotion ? 0 : state.time;
    const p = state.profile,
      radius = Math.min(this.width, this.height) * 0.35;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, this.width, this.height);
    ctx.fillStyle = `rgb(${atmosphereColor(state.atmosphere, state.state).join(",")})`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.font = "9px monospace";
    const angle = state.reducedMotion ? 0 : state.phase * 0.15 + state.yaw;
    const c = Math.cos(angle),
      s = Math.sin(angle);
    const breath = 1 + Math.sin(time * 0.8) * 0.018 * state.motion;
    for (const point of this.points) {
      const [mx, my, mz, glow, fade] = morphPoint(
        point,
        state.forms,
        state.formFrames,
        time,
        state.jag,
      );
      const x = mx * c + mz * s;
      const z = -mx * s + mz * c;
      const perspective = 3.6 / (3.6 - z);
      const flow = Math.sin(state.phase + point.y * 4) * p.turbulence * 0.1;
      let ripple = 0;
      for (let i = 0; i < state.impulses.parameters.length; i += 4) {
        const age = time - state.impulses.origins[i + 3];
        if (age < 0 || age > 2.4 || state.reducedMotion) continue;
        const d = Math.hypot(x - state.impulses.origins[i], my - state.impulses.origins[i + 1]);
        ripple +=
          Math.exp(-(((d - age * 0.9) * 9) ** 2)) *
          (1 - age / 2.4) ** 2 *
          state.impulses.parameters[i + 1] *
          0.12;
      }
      ctx.globalAlpha = Math.min(
        0.85,
        (0.16 + (z + 1) * 0.25) * (0.7 + p.energy) * (1 + glow * 0.6) * fade,
      );
      ctx.fillText(
        ".:+*#"[Math.min(4, Math.floor(point.seed * 5))],
        this.width / 2 + (x + flow + state.yaw) * radius * perspective * (breath + ripple),
        this.height / 2 + (my + state.pitch) * radius * perspective * (breath + ripple),
      );
    }
    ctx.globalAlpha = 1;
  }
  destroy() {
    this.points.length = 0;
  }
}
