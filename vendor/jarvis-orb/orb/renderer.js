import {
  createOrbPoints,
  packPoints,
  createFilaments,
  perspective,
  camera,
  identity,
} from "./math.js";
import { atmosphereColor } from "../atmosphere.js";
import { QUALITY } from "./profiles.js";
import { FORM_KEYS } from "./forms.js";
import {
  PARTICLE_VERTEX,
  PARTICLE_FRAGMENT,
  LINE_VERTEX,
  LINE_FRAGMENT,
  QUAD_VERTEX,
  BRIGHT_FRAGMENT,
  BLUR_FRAGMENT,
  COMPOSITE_FRAGMENT,
} from "./shaders.js";

const BINDINGS = [
  "Energy",
  "Turbulence",
  "Swirl",
  "Wave",
  "Flow",
  "Focus",
  "Pulse",
  "Cluster",
  "Fragment",
  "Burst",
  "Scan",
].map((name) => ["u" + name, name.toLowerCase()]);
const capital = (key) => key[0].toUpperCase() + key.slice(1);
const FORM_UNIFORMS = FORM_KEYS.map((key) => ["u" + capital(key), key]);
const FRAME_UNIFORMS = [
  ["uSpikeFrame", "spike"],
  ["uRingFrames", "rings"],
  ["uTorusFrame", "torus"],
  ["uLatticeFrame", "lattice"],
  ["uGearFrame", "gear"],
  ["uBloomFrame", "bloom"],
  ["uCheckFrame", "check"],
];

export class WebGLOrbRenderer {
  constructor(canvas, gl) {
    this.canvas = canvas;
    this.gl = gl;
    this.programs = [];
    this.buffers = [];
    this.vaos = [];
    this.targets = [];
    this.model = identity();
    this.view = identity();
    this.projection = identity();
    this.color = new Float32Array(3);
    this.width = this.height = 0;
    try {
      this.particles = this.program(PARTICLE_VERTEX, PARTICLE_FRAGMENT);
      this.lines = this.program(LINE_VERTEX, LINE_FRAGMENT);
      this.bright = this.program(QUAD_VERTEX, BRIGHT_FRAGMENT);
      this.blur = this.program(QUAD_VERTEX, BLUR_FRAGMENT);
      this.composite = this.program(QUAD_VERTEX, COMPOSITE_FRAGMENT);
      this.quad = gl.createVertexArray();
      this.vaos.push(this.quad);
      const points = createOrbPoints(QUALITY.high.count);
      // Keep a true particle volume, with a more legible outer ASCII membrane.
      for (const point of points) {
        if (point.shell > 0.55) {
          const scale = 0.98 / point.shell;
          point.x *= scale;
          point.y *= scale;
          point.z *= scale;
          point.shell = 0.98;
        }
      }
      this.pointVao = this.buffer(packPoints(points), 7, false);
      const edges = createFilaments(points, QUALITY.high.links);
      const packed = packPoints(points);
      const links = new Float32Array(edges.length * 2 * 14);
      edges.forEach(([a, b], i) => {
        links.set(packed.subarray(a * 7, a * 7 + 7), i * 28);
        links.set(packed.subarray(b * 7, b * 7 + 7), i * 28 + 7);
        links.set(packed.subarray(b * 7, b * 7 + 7), i * 28 + 14);
        links.set(packed.subarray(a * 7, a * 7 + 7), i * 28 + 21);
      });
      this.lineVao = this.buffer(links, 14, true);
      this.linkCount = edges.length;
      gl.disable(gl.DEPTH_TEST);
      gl.clearColor(0, 0, 0, 0);
    } catch (error) {
      this.destroy();
      throw error;
    }
  }

  program(vertex, fragment) {
    const gl = this.gl;
    const shaders = [];
    const program = gl.createProgram();
    try {
      for (const [type, source] of [
        [gl.VERTEX_SHADER, vertex],
        [gl.FRAGMENT_SHADER, fragment],
      ]) {
        const shader = gl.createShader(type);
        shaders.push(shader);
        gl.shaderSource(shader, source);
        gl.compileShader(shader);
        if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS))
          throw Error(gl.getShaderInfoLog(shader) || "Orb shader failed");
        gl.attachShader(program, shader);
      }
      gl.linkProgram(program);
      if (!gl.getProgramParameter(program, gl.LINK_STATUS))
        throw Error(gl.getProgramInfoLog(program) || "Orb shader link failed");
      const uniforms = {};
      for (let i = 0; i < gl.getProgramParameter(program, gl.ACTIVE_UNIFORMS); i++) {
        const name = gl.getActiveUniform(program, i).name;
        uniforms[name.replace("[0]", "")] = gl.getUniformLocation(program, name);
      }
      this.programs.push(program);
      return { program, uniforms };
    } catch (error) {
      gl.deleteProgram(program);
      throw error;
    } finally {
      for (const shader of shaders) gl.deleteShader(shader);
    }
  }

  buffer(data, stride, neighbors) {
    const gl = this.gl;
    const vao = gl.createVertexArray(),
      buffer = gl.createBuffer();
    this.vaos.push(vao);
    this.buffers.push(buffer);
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
    for (const [index, size, offset] of neighbors
      ? [
          [0, 3, 0],
          [1, 4, 3],
          [2, 3, 7],
          [3, 4, 10],
        ]
      : [
          [0, 3, 0],
          [1, 4, 3],
        ]) {
      gl.enableVertexAttribArray(index);
      gl.vertexAttribPointer(index, size, gl.FLOAT, false, stride * 4, offset * 4);
    }
    gl.bindVertexArray(null);
    return vao;
  }

  target(width, height) {
    const gl = this.gl;
    const texture = gl.createTexture(),
      framebuffer = gl.createFramebuffer();
    const target = { texture, framebuffer, width, height };
    this.targets.push(target);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    // RGBA8 works on baseline WebGL2; no float-color-buffer extension required.
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE)
      throw Error("Orb framebuffer unavailable");
    return target;
  }

  releaseTargets() {
    for (const target of this.targets) {
      this.gl.deleteTexture(target.texture);
      this.gl.deleteFramebuffer(target.framebuffer);
    }
    this.targets.length = 0;
  }

  resize(width, height, quality, deviceDpr = 1) {
    const gl = this.gl;
    this.quality = QUALITY[quality];
    this.dpr = Math.min(deviceDpr, this.quality.dpr);
    // Point sizes are tuned for an orb about 180 CSS pixels wide; smaller orbs scale them down.
    this.fit = Math.min(1, Math.max(0.3, Math.min(width, height) / 180));
    const w = Math.max(1, Math.round(width * this.dpr)),
      h = Math.max(1, Math.round(height * this.dpr));
    if (w === this.width && h === this.height && this.bloomEnabled === this.quality.bloom) return;
    this.width = this.canvas.width = w;
    this.height = this.canvas.height = h;
    this.bloomEnabled = this.quality.bloom;
    perspective(this.projection, w / h);
    this.releaseTargets();
    // Low quality draws directly, avoiding post-processing fill cost entirely.
    if (this.bloomEnabled) {
      this.scene = this.target(w, h);
      this.glowA = this.target(Math.max(1, Math.ceil(w / 4)), Math.max(1, Math.ceil(h / 4)));
      this.glowB = this.target(this.glowA.width, this.glowA.height);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  uniforms(program, state, lines) {
    const gl = this.gl,
      u = program.uniforms,
      p = state.profile;
    gl.useProgram(program.program);
    camera(this.view, state.yaw, state.pitch);
    gl.uniformMatrix4fv(u.uModel, false, this.model);
    gl.uniformMatrix4fv(u.uView, false, this.view);
    gl.uniformMatrix4fv(u.uProjection, false, this.projection);
    gl.uniform1f(u.uTime, state.reducedMotion ? 0 : state.time);
    gl.uniform1f(u.uPhase, state.phase);
    gl.uniform1f(u.uDpr, this.dpr);
    gl.uniform1f(u.uFit, this.fit ?? 1);
    gl.uniform1f(u.uDensity, Math.sqrt(3200 / this.quality.count));
    gl.uniform1f(u.uMotion, state.motion);
    gl.uniform1f(u.uPosture, state.posture);
    gl.uniform4fv(u.uAttention, state.attention);
    gl.uniform4fv(u.uOrigins, state.impulses.origins);
    gl.uniform4fv(u.uImpulses, state.impulses.parameters);
    for (const [uniform, key] of BINDINGS) gl.uniform1f(u[uniform], p[key]);
    for (const [uniform, key] of FORM_UNIFORMS) gl.uniform1f(u[uniform], state.forms[key]);
    for (const [uniform, key] of FRAME_UNIFORMS)
      gl.uniformMatrix3fv(u[uniform], false, state.formFrames[key]);
    gl.uniform3fv(u.uJet, state.formFrames.jet);
    gl.uniform1f(u.uBeat, state.beat);
    gl.uniform1f(u.uJag, state.jag);
    const color = atmosphereColor(state.atmosphere, state.state);
    for (let i = 0; i < 3; i++) this.color[i] = color[i] / 255;
    gl.uniform3fv(u.uColor, this.color);
    gl.uniform1i(u.uLines, lines ? 1 : 0);
  }

  pass(program, source, target) {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, target?.framebuffer || null);
    gl.viewport(0, 0, target?.width || this.width, target?.height || this.height);
    gl.useProgram(program.program);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, source.texture);
    gl.uniform1i(program.uniforms.uSource, 0);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  draw(state) {
    const gl = this.gl;
    if (!this.width || gl.isContextLost()) return;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.bloomEnabled ? this.scene.framebuffer : null);
    gl.viewport(0, 0, this.width, this.height);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    this.uniforms(this.particles, state, false);
    gl.bindVertexArray(this.pointVao);
    gl.drawArrays(gl.POINTS, 0, this.quality.count);
    if (this.quality.links && state.motion) {
      this.uniforms(this.lines, state, true);
      gl.bindVertexArray(this.lineVao);
      gl.drawArrays(gl.LINES, 0, Math.min(this.linkCount, this.quality.links) * 2);
    }
    if (this.bloomEnabled) {
      gl.disable(gl.BLEND);
      gl.bindVertexArray(this.quad);
      this.pass(this.bright, this.scene, this.glowA);
      gl.useProgram(this.blur.program);
      gl.uniform2f(this.blur.uniforms.uStep, 1 / this.glowA.width, 0);
      this.pass(this.blur, this.glowA, this.glowB);
      gl.uniform2f(this.blur.uniforms.uStep, 0, 1 / this.glowA.height);
      this.pass(this.blur, this.glowB, this.glowA);
      gl.useProgram(this.composite.program);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, this.glowA.texture);
      gl.uniform1i(this.composite.uniforms.uBloom, 1);
      gl.uniform1f(this.composite.uniforms.uBloomStrength, 0.3);
      this.pass(this.composite, this.scene, null);
    }
    gl.bindVertexArray(null);
  }

  destroy() {
    this.releaseTargets();
    for (const buffer of this.buffers) this.gl.deleteBuffer(buffer);
    for (const vao of this.vaos) this.gl.deleteVertexArray(vao);
    for (const program of this.programs) this.gl.deleteProgram(program);
    this.buffers.length = this.vaos.length = this.programs.length = 0;
  }
}
