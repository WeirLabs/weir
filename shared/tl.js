/* 时间轴小工具：缓动、区间进度、脉冲、关键帧插值、确定性随机、样式写入。视频引擎与官网演示共用。 */
(function (global) {
  const clamp = (x, a = 0, b = 1) => Math.min(b, Math.max(a, x));
  const lerp = (a, b, k) => a + (b - a) * k;
  const EZ = {
    lin: (t) => t,
    in2: (t) => t * t, in3: (t) => t * t * t,
    out2: (t) => 1 - (1 - t) ** 2, out3: (t) => 1 - (1 - t) ** 3, out5: (t) => 1 - (1 - t) ** 5,
    io2: (t) => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2),
    io3: (t) => (t < 0.5 ? 4 * t ** 3 : 1 - (-2 * t + 2) ** 3 / 2),
    expo: (t) => (t >= 1 ? 1 : 1 - 2 ** (-10 * t)),
    back: (t) => { const c = 1.70158; return 1 + (c + 1) * (t - 1) ** 3 + c * (t - 1) ** 2; },
    step: (t) => (t >= 1 ? 1 : 0),
  };
  /** 区间进度：t 在 [a,b] 内 0→1，经缓动 */
  const seg = (t, a, b, e = EZ.out3) => e(clamp((t - a) / Math.max(1e-6, b - a)));
  /** 脉冲：在 a 处瞬间到 1，随后以 decay 秒指数衰减回 0 */
  const pulse = (t, a, decay = 0.25) => (t < a ? 0 : Math.exp(-(t - a) / decay));
  /** 分段插值：keys=[[t,v],...] */
  const keys = (t, ks, e = EZ.io2) => {
    if (t <= ks[0][0]) return ks[0][1];
    for (let i = 1; i < ks.length; i++) if (t <= ks[i][0]) return lerp(ks[i - 1][1], ks[i][1], e(clamp((t - ks[i - 1][0]) / (ks[i][0] - ks[i - 1][0]))));
    return ks[ks.length - 1][1];
  };
  function rng(seed) { let a = seed >>> 0; return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
  /** 一次性写入 transform / opacity / filter / clip：o,x,y,s,sx,sy,r,skx,blur,bright,clip=[上,右,下,左]% */
  function fx(el, p) {
    if (!el) return;
    const st = el.style;
    if (p.o !== undefined) { st.opacity = p.o; st.visibility = p.o <= 0.001 ? "hidden" : "visible"; }
    if (p.x !== undefined || p.y !== undefined || p.s !== undefined || p.sx !== undefined || p.sy !== undefined || p.r !== undefined || p.skx !== undefined) {
      const sx = (p.sx ?? p.s ?? 1), sy = (p.sy ?? p.s ?? 1);
      st.transform = `translate(${p.x ?? 0}px, ${p.y ?? 0}px) rotate(${p.r ?? 0}deg) skewX(${p.skx ?? 0}deg) scale(${sx}, ${sy})`;
    }
    if (p.blur !== undefined || p.bright !== undefined) st.filter = `${p.blur > 0.05 ? `blur(${p.blur.toFixed(2)}px)` : ""} ${p.bright !== undefined ? `brightness(${p.bright})` : ""}`.trim() || "none";
    if (p.clip) st.clipPath = `inset(${p.clip.map((v) => v + "%").join(" ")})`;
  }
  const html = (s) => { const d = document.createElement("div"); d.innerHTML = s.trim(); return d.firstElementChild; };
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  /** 打字机：返回 text 的前 n 个字符；cps 为每秒字数 */
  const typed = (text, t, a, cps = 28) => text.slice(0, Math.max(0, Math.floor((t - a) * cps)));
  global.WeirTL = { clamp, lerp, EZ, seg, pulse, keys, rng, fx, html, $, $$, typed };
})(window);
