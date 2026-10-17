/* Weir 流体引擎 —— 着色器与预设逐字取自 fluid-board/fluid.js，去掉了页面扫描副作用，改为可寻址、可逐帧渲染。
   官网：WeirFluid.start()（rAF + 可见性裁剪）。视频：WeirFluid.renderAll(t) 由时间轴逐帧调用，保证确定性。 */
(function (global) {
  const PRESETS = {
    spectral: {
      label: "SPECTRAL 光谱",
      colors: ["#160a4a", "#6a12ff", "#ff1f8e", "#19d39b", "#ffd36e"],
      th: [0.42, 0.5, 0.18, 0.6],
      mode: 0, ink: 0.0, vein: 0, relief: 0.8, sharp: 0.7, warp: 4.6, scale: 3.0, speed: 0.22, lines: 0, sat: 1, bright: 1,
    },
    obsidian: {
      label: "OBSIDIAN LIME 黑曜酸绿",
      colors: ["#030304", "#0d0e10", "#33353b", "#ccff00", "#a4a6a9"],
      th: [0.44, 0.58, 0.6, 0.72],
      mode: 0, ink: 0.1, vein: 1, relief: 1.3, sharp: 0.55, warp: 4.2, scale: 2.0, speed: 0.16, lines: 0, sat: 1, bright: 1,
    },
    oil: {
      label: "OIL SLICK 油膜虹彩",
      colors: ["#030304", "#030304", "#030304", "#030304", "#030304"],
      th: [0.42, 0.5, 0.04, 0.6],
      mode: 1, ink: 0.12, vein: 0, relief: 0.9, sharp: 0.6, warp: 3.6, scale: 1.8, speed: 0.14, lines: 0, sat: 0.9, bright: 1,
    },
    ultraviolet: {
      label: "ULTRAVIOLET 紫外",
      colors: ["#06030e", "#2a0b6e", "#7b2cff", "#ff2e9a", "#ffd9f1"],
      th: [0.4, 0.5, 0.1, 0.66],
      mode: 0, ink: 0.15, vein: 0, relief: 0.8, sharp: 0.65, warp: 4.0, scale: 2.2, speed: 0.18, lines: 0, sat: 1, bright: 1,
    },
    mercury: {
      label: "MERCURY 水银",
      colors: ["#050506", "#26272c", "#6a6d75", "#c4c7ce", "#ffffff"],
      th: [0.4, 0.5, 0.04, 0.6],
      mode: 0, ink: 0.08, vein: 0, relief: 1.2, sharp: 0.45, warp: 3.4, scale: 1.7, speed: 0.12, lines: 0, sat: 1, bright: 1,
    },
    teal: {
      label: "TOXIC TEAL 毒青",
      colors: ["#020c0a", "#073f36", "#14b892", "#ccff00", "#effff4"],
      th: [0.42, 0.52, 0.22, 0.68],
      mode: 0, ink: 0.15, vein: 0.5, relief: 0.8, sharp: 0.65, warp: 4.0, scale: 2.2, speed: 0.18, lines: 0, sat: 1, bright: 1,
    },
  };

  const VERT = `#version 300 es
  in vec2 a;
  void main() { gl_Position = vec4(a, 0., 1.); }`;

  const FRAG = `#version 300 es
  precision highp float;
  uniform vec2 uRes;
  uniform float uTime, uScale, uWarp, uRelief, uInk, uSharp, uSeed, uMode, uSat, uBright, uLines, uVein;
  uniform vec3 uC[5];
  uniform vec4 uTh;
  uniform vec2 uMouse;
  out vec4 o;

  float hash(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
  float noise(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    vec2 u = f * f * (3. - 2. * f);
    return mix(mix(hash(i), hash(i + vec2(1, 0)), u.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), u.x), u.y);
  }
  const mat2 R = mat2(1.6, 1.2, -1.2, 1.6);
  float fbm(vec2 p) {
    float a = .5, s = 0.;
    for (int i = 0; i < 5; i++) { s += a * noise(p); p = R * p; a *= .5; }
    return s;
  }
  float field(vec2 p, float t, out vec2 q, out vec2 r) {
    q = vec2(fbm(p + vec2(0., .12 * t)), fbm(p + vec2(5.2, 1.3) - .1 * t));
    r = vec2(fbm(p + uWarp * q + vec2(1.7, 9.2) + .15 * t), fbm(p + uWarp * q + vec2(8.3, 2.8) - .126 * t));
    return fbm(p + uWarp * r + vec2(0., .05 * t));
  }

  void main() {
    vec2 uv = gl_FragCoord.xy / uRes;
    vec2 p = (gl_FragCoord.xy - .5 * uRes) / uRes.y * uScale + uSeed + uMouse * .25;
    float t = uTime;
    vec2 q, r, q2, r2;
    float f = field(p, t, q, r);
    float px = .006 * uScale;
    float fx = field(p + vec2(px, 0.), t, q2, r2);
    float fy = field(p + vec2(0., px), t, q2, r2);

    float e = mix(.22, .015, uSharp);
    vec3 col;
    if (uMode < .5) {
      col = uC[0];
      col = mix(col, uC[1], smoothstep(uTh.x - e, uTh.x + e, f));
      col = mix(col, uC[2], smoothstep(uTh.y - e, uTh.y + e, r.x));
      col = mix(col, uC[3], smoothstep(uTh.z - e, uTh.z + e, q.x - r.y));
      col = mix(col, uC[4], smoothstep(uTh.w - e, uTh.w + e, f + .2 * (r.y - .5)));
      col *= .7 + .6 * smoothstep(.25, .75, mix(f, r.y, .5));
    } else {
      float v = f * 2.6 + r.x * 1.8 + q.y * .6 + t * .03;
      vec3 film = .5 + .5 * cos(6.2831 * (v + vec3(0., .33, .67)));
      film = pow(film, vec3(1.6)) * 1.25;
      float body = smoothstep(.28, .56, f);
      col = mix(vec3(.012), film, body);
    }

    float g = fbm(p * .5 + r * 1.2 - t * .04 + 3.1);
    col = mix(col, vec3(.012), smoothstep(1. - uInk - .14, 1. - uInk + .14, g + .25) * step(.001, uInk));

    if (uVein > 0.) {
      float vd = abs(r.x - .55) / max(fwidth(r.x), 1e-4);
      float vein = 1. - smoothstep(.3, 1.4, vd);
      float halo = exp(-vd * .45) * .25;
      float sparse = smoothstep(.5, .62, f) * smoothstep(.35, .55, g);
      col = mix(col, uC[3], clamp(vein + halo, 0., 1.) * uVein * sparse);
    }

    vec2 grad = vec2(fx - f, fy - f) / px;
    vec3 n = normalize(vec3(-grad * .02 * uRelief, 1.));
    vec3 L = normalize(vec3(-.45, .55, .7));
    float dif = clamp(dot(n, L), 0., 1.);
    float spec = pow(clamp(dot(reflect(-L, n), vec3(0., 0., 1.)), 0., 1.), 36.);
    float rl = clamp(uRelief, 0., 1.5);
    float lumc = dot(col, vec3(.3, .59, .11));
    col *= mix(1., .5 + .7 * dif, min(rl, 1.));
    col += spec * rl * .3 * mix(.55, 1., smoothstep(.02, .25, lumc));

    if (uLines > 0.) {
      float k = mix(q.x, r.x, .5) * 11.;
      float d = abs(fract(k) - .5) / max(fwidth(k), 1e-4);
      float ln = (1. - smoothstep(.0, 1., d - .15)) * (1. - smoothstep(.12, .35, fwidth(k)));
      col = mix(col * (1. - .45 * uLines), uC[3], ln * uLines * .65);
    }

    float lum = dot(col, vec3(.299, .587, .114));
    col = mix(vec3(lum), col, uSat) * uBright;
    col *= 1. - .3 * pow(length(uv - .5) * 1.25, 2.);
    o = vec4(col, 1.);
  }`;


  const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
  const NUM_KEYS = ["vein", "ink", "relief", "sharp", "warp", "scale", "speed", "lines", "sat", "bright", "seed", "q"];

  const cfg = { glw: 1600, glh: 1000, quality: 0.55, qMul: 1 };
  let gl, glc, prog, U = {};
  function init() {
    if (gl) return;
    glc = document.createElement("canvas");
    glc.width = cfg.glw;
    glc.height = cfg.glh;
    gl = glc.getContext("webgl2", { preserveDrawingBuffer: true, antialias: false });
    if (!gl) throw new Error("WebGL2 unavailable");
    const compile = (type, s) => {
      const sh = gl.createShader(type);
      gl.shaderSource(sh, s);
      gl.compileShader(sh);
      if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(sh));
      return sh;
    };
    prog = gl.createProgram();
    gl.attachShader(prog, compile(gl.VERTEX_SHADER, VERT));
    gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, FRAG));
    gl.linkProgram(prog);
    gl.useProgram(prog);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(prog, "a");
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    ["uRes", "uTime", "uScale", "uWarp", "uRelief", "uInk", "uSharp", "uSeed", "uMode", "uSat", "uBright", "uLines", "uVein", "uC", "uTh", "uMouse"].forEach((n) => (U[n] = gl.getUniformLocation(prog, n)));
  }

  class FluidView {
    constructor(el) {
      this.el = el;
      this.canvas = document.createElement("canvas");
      this.canvas.className = "fluid-canvas";
      el.prepend(this.canvas);
      this.ctx = this.canvas.getContext("2d");
      this.visible = true;
      this.mouse = [0, 0];
      this.mouseTarget = [0, 0];
      this.read();
      if (el.hasAttribute("data-interactive")) {
        el.addEventListener("pointermove", (e) => {
          const b = el.getBoundingClientRect();
          this.mouseTarget = [((e.clientX - b.left) / b.width - 0.5) * 2, -((e.clientY - b.top) / b.height - 0.5) * 2];
        });
        el.addEventListener("pointerleave", () => (this.mouseTarget = [0, 0]));
      }
    }
    read() {
      const d = this.el.dataset, base = PRESETS[d.fluid] || PRESETS.obsidian;
      this.p = { ...base, colors: [...base.colors], th: [...base.th], seed: +(d.seed || 0) };
      NUM_KEYS.forEach((k) => { if (d[k] !== undefined) this.p[k] = +d[k]; });
    }
    set(patch) { Object.assign(this.p, patch); }
    render(time) {
      init();
      const b = this.el.getBoundingClientRect();
      // 取布局尺寸（不受父级 transform 缩放影响），视频里元素会被缩放/平移
      const bw = this.el.offsetWidth || b.width, bh = this.el.offsetHeight || b.height;
      if (bw < 2 || bh < 2) return;
      const q = (this.p.q || cfg.quality) * cfg.qMul;
      let w = Math.round(bw * q), h = Math.round(bh * q);
      const s = Math.min(1, cfg.glw / w, cfg.glh / h);
      w = Math.max(1, Math.floor(w * s));
      h = Math.max(1, Math.floor(h * s));
      if (this.canvas.width !== w || this.canvas.height !== h) { this.canvas.width = w; this.canvas.height = h; }
      this.mouse[0] += (this.mouseTarget[0] - this.mouse[0]) * 0.04;
      this.mouse[1] += (this.mouseTarget[1] - this.mouse[1]) * 0.04;
      const p = this.p;
      gl.viewport(0, 0, w, h);
      gl.uniform2f(U.uRes, w, h);
      gl.uniform1f(U.uTime, time * p.speed * 10 + p.seed * 13.7);
      gl.uniform1f(U.uScale, p.scale);
      gl.uniform1f(U.uWarp, p.warp);
      gl.uniform1f(U.uRelief, p.relief);
      gl.uniform1f(U.uInk, p.ink);
      gl.uniform1f(U.uSharp, p.sharp);
      gl.uniform1f(U.uSeed, p.seed * 3.17);
      gl.uniform1f(U.uMode, p.mode);
      gl.uniform1f(U.uSat, p.sat);
      gl.uniform1f(U.uBright, p.bright);
      gl.uniform1f(U.uLines, p.lines);
      gl.uniform1f(U.uVein, p.vein);
      gl.uniform3fv(U.uC, p.colors.flatMap(hex));
      gl.uniform4fv(U.uTh, p.th);
      gl.uniform2f(U.uMouse, this.mouse[0], this.mouse[1]);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      this.ctx.drawImage(glc, 0, cfg.glh - h, w, h, 0, 0, w, h);
    }
  }

  const views = [];
  function mount(root = document) {
    const found = [];
    root.querySelectorAll("[data-fluid]:not([data-fluid-ready])").forEach((el) => {
      el.dataset.fluidReady = "1";
      const v = new FluidView(el);
      views.push(v);
      found.push(v);
    });
    return found;
  }
  function renderAll(time) { views.forEach((v) => v.visible && v.render(time)); }

  let started = false;
  function start() {
    if (started) return;
    started = true;
    const io = new IntersectionObserver((es) => es.forEach((en) => { const v = views.find((x) => x.el === en.target); if (v) v.visible = en.isIntersecting; }), { rootMargin: "160px" });
    const watch = () => views.forEach((v) => { if (!v._w) { v._w = 1; v.visible = false; io.observe(v.el); } });
    const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
    const t0 = performance.now();
    let last = 0;
    const loop = (now) => {
      watch();
      if (!document.hidden) { if (!reduce || last === 0) renderAll(reduce ? 4 : (now - t0) / 1000); last = now; }
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }
  global.WeirFluid = { PRESETS, FluidView, views, cfg, mount, renderAll, start };
})(window);
