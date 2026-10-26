import { OrbController } from "./orb/controller.js";
import { WebGLOrbRenderer } from "./orb/renderer.js";
import { CanvasOrbFallback } from "./orb/fallback.js";
import { clamp } from "./orb/math.js";
import { QUALITY, selectQuality, lowerQuality } from "./orb/profiles.js";
export { ORB_PROFILES, normalizeOrbState } from "./orb/profiles.js";
export { createOrbPoints } from "./orb/math.js";
export { OrbController } from "./orb/controller.js";

export class JarvisOrb extends OrbController {
  // options.renderer: "canvas2d" skips WebGL entirely (the board's light mode and crash guard).
  constructor(canvas, stage, options = {}) {
    super();
    this.options = options;
    this.canvas = canvas;
    this.stage = stage;
    this.listeners = [];
    this.frameId = null;
    this.destroyed = false;
    this.frames = this.sampleTime = this.lastDraw = this.lastStats = 0;
    this.lastQualityChange = -10;
    this.performanceQuality = "high";
    this.motionPaused = false;
    this.motionQuery = matchMedia("(prefers-reduced-motion: reduce)");
    this.setReducedMotion(this.motionQuery.matches);
    this.quality = this.selectQuality();
    this.frameCallback = (now) => this.frame(now);
    this.initRenderer();
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(stage);
    this.listen(document, "visibilitychange", () =>
      document.hidden ? this.pause() : this.resume(),
    );
    this.listen(this.motionQuery, "change", (event) => {
      this.setReducedMotion(event.matches || this.motionPaused);
      this.resize();
    });
    this.listen(stage, "pointermove", (event) => {
      const rect = stage.getBoundingClientRect();
      this.setAttention({
        x: ((event.clientX - rect.left) / rect.width - 0.5) * 2,
        y: (0.5 - (event.clientY - rect.top) / rect.height) * 2,
        active: true,
      });
    });
    this.listen(stage, "pointerleave", () => this.setAttention({ active: false }));
    // Press and hold to charge the body into a spiked ball; release to discharge.
    this.swallowClickUntil = 0;
    this.listen(stage, "pointerdown", (event) => {
      this.swallowClickUntil = 0;
      if (event.button !== 0 || !this.beginCharge()) return;
      stage.setPointerCapture?.(event.pointerId);
    });
    this.listen(stage, "pointerup", () => {
      // A real discharge is its own gesture, so the click that follows it must not
      // also focus the composer. The window is short so a lost click cannot linger.
      if (this.endCharge() > 0.2) this.swallowClickUntil = performance.now() + 400;
    });
    this.listen(stage, "pointercancel", () => {
      this.endCharge();
      this.swallowClickUntil = 0;
    });
    this.listen(stage, "contextmenu", (event) => {
      if (this.gesture.charging) event.preventDefault();
    });
    const clickGuard = (event) => {
      // Keyboard activation (detail 0) is never part of a pointer charge.
      if (event.detail === 0 || performance.now() > this.swallowClickUntil) return;
      this.swallowClickUntil = 0;
      event.preventDefault();
      event.stopImmediatePropagation();
    };
    stage.addEventListener("click", clickGuard, true);
    this.listeners.push(() => stage.removeEventListener("click", clickGuard, true));
    this.listen(stage, "focus", () => this.setInteraction({ focused: true }));
    this.listen(stage, "blur", () => this.setInteraction({ focused: false }));
    this.resize();
    this.updateLabel();
    this.resume();
  }

  listen(target, type, listener) {
    target.addEventListener(type, listener);
    this.listeners.push(() => target.removeEventListener(type, listener));
  }
  selectQuality() {
    const selected = selectQuality({
      width: window.innerWidth,
      cores: navigator.hardwareConcurrency,
      memory: navigator.deviceMemory,
      reducedMotion: this.reducedMotion,
    });
    return QUALITY[selected].count < QUALITY[this.performanceQuality].count
      ? selected
      : this.performanceQuality;
  }
  initRenderer() {
    const canvas = this.canvas;
    if (this.options.renderer === "canvas2d") {
      this.fallback("2D chosen");
      return;
    }
    try {
      const gl = canvas.getContext("webgl2", {
        // A GPU the browser itself distrusts (blocklisted driver, software rendering) gets the 2D orb.
        failIfMajorPerformanceCaveat: true,
        alpha: true,
        antialias: false,
        premultipliedAlpha: true,
        powerPreference: "low-power",
      });
      if (!gl) {
        this.fallback("WebGL2 unavailable");
        return;
      }
      this.renderer = new WebGLOrbRenderer(canvas, gl);
      this.stage.dataset.renderer = "webgl2";
      this.listen(canvas, "webglcontextlost", (event) => {
        event.preventDefault();
        this.lostCanvas = canvas;
        this.fallback("WebGL context lost");
        this.resize();
      });
      this.listen(canvas, "webglcontextrestored", () => {
        if (this.destroyed || this.lostCanvas !== canvas) return;
        this.renderer?.destroy();
        this.canvas.replaceWith(canvas);
        this.canvas = canvas;
        this.lostCanvas = null;
        try {
          this.renderer = new WebGLOrbRenderer(canvas, gl);
          this.stage.dataset.renderer = "webgl2";
          this.resize();
        } catch (error) {
          this.fallback(error.message);
          this.resize();
        }
      });
    } catch (error) {
      this.fallback(error.message);
    }
  }
  fallback(reason) {
    this.renderer?.destroy();
    // A canvas that obtained WebGL cannot later obtain a 2D context.
    const replacement = this.canvas.cloneNode(false);
    this.canvas.replaceWith(replacement);
    this.canvas = replacement;
    this.renderer = new CanvasOrbFallback(replacement);
    this.stage.dataset.renderer = "canvas2d";
    this.fallbackReason = reason;
  }
  resize() {
    if (this.destroyed) return;
    // Layout size, not getBoundingClientRect: a CSS scale while the stage moves must not
    // change the canvas resolution.
    const box = this.stage.getBoundingClientRect();
    const rect = { width: this.stage.offsetWidth || box.width, height: this.stage.offsetHeight || box.height };
    this.width = rect.width;
    this.height = rect.height;
    this.quality = this.selectQuality();
    try {
      this.renderer.resize(rect.width, rect.height, this.quality, devicePixelRatio || 1);
    } catch (error) {
      this.fallback(error.message);
      this.renderer.resize(rect.width, rect.height, "low", 1);
    }
    this.stage.dataset.quality = this.quality;
    this.stage.dataset.particles = String(
      this.stage.dataset.renderer === "webgl2" ? QUALITY[this.quality].count : 1000,
    );
    // Setting the canvas size clears it. ResizeObserver runs before paint, so drawing now
    // means no blank frame ever reaches the screen.
    if (this.frameId !== null) {
      try {
        this.renderer.draw(this);
      } catch {
        /* the next frame draws */
      }
    }
  }
  setMotionPaused(paused) {
    this.motionPaused = Boolean(paused);
    this.setReducedMotion(this.motionPaused || this.motionQuery.matches);
    this.resize();
  }
  updateLabel() {
    this.stage.dataset.state = this.state;
    this.stage.setAttribute(
      "aria-label",
      `JARVIS is ${this.state.replaceAll("_", " ")}. Activate to focus the command composer.`,
    );
  }
  setState(value) {
    const changed = super.setState(value);
    if (changed) this.updateLabel();
    return changed;
  }
  // User gestures only: no backend events, state transitions or success colors.
  impulse(amount = 0.3) {
    this.ripple(0, 0, Math.min(0.4, amount));
  }
  pulseAt(x, y) {
    this.poke(0.5);
    const rect = this.stage.getBoundingClientRect();
    this.ripple(
      x == null ? 0 : clamp((x - rect.left - rect.width / 2) / (rect.width * 0.36), -1, 1),
      y == null ? 0 : clamp((rect.top + rect.height / 2 - y) / (rect.height * 0.36), -1, 1),
    );
  }
  pause() {
    if (this.frameId !== null) cancelAnimationFrame(this.frameId);
    this.frameId = null;
    this.impulses.clear();
    this.cancelGestures();
  }
  resume() {
    if (this.destroyed || document.hidden || this.frameId !== null) return;
    this.lastFrame = performance.now();
    this.frames = this.sampleTime = 0;
    this.frameId = requestAnimationFrame(this.frameCallback);
  }
  frame(now) {
    this.frameId = null;
    if (this.destroyed || document.hidden) return;
    const elapsed = (now - this.lastFrame) / 1000;
    this.lastFrame = now;
    this.tick(Math.min(0.05, Math.max(0, elapsed)));
    if (!this.reducedMotion || now - this.lastDraw >= 100) {
      this.renderer.draw(this);
      this.lastDraw = now;
    }
    if (!this.reducedMotion && elapsed > 0 && elapsed < 0.2 && this.time > 2) {
      this.frames++;
      this.sampleTime += elapsed;
      if (this.frames >= 120) {
        this.fps = this.frames / this.sampleTime;
        if (this.fps < 42 && this.time - this.lastQualityChange > 10 && this.quality !== "low") {
          this.performanceQuality = lowerQuality(this.quality);
          this.lastQualityChange = this.time;
          this.resize();
        }
        this.frames = this.sampleTime = 0;
      }
    }
    if (now - this.lastStats > 1000) {
      this.stage.dataset.fps = this.fps ? this.fps.toFixed(1) : "unmeasured";
      this.stage.dataset.motion = this.reducedMotion ? "reduced" : "full";
      this.stage.dataset.posture = this.posture > 0.2 ? "attentive" : "resting";
      this.stage.dataset.form = this.dominantForm;
      this.lastStats = now;
    }
    this.frameId = requestAnimationFrame(this.frameCallback);
  }
  destroy() {
    this.destroyed = true;
    this.pause();
    this.resizeObserver.disconnect();
    for (const remove of this.listeners) remove();
    this.listeners.length = 0;
    this.renderer.destroy();
  }
}
