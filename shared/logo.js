/* Weir 标志几何 —— 取自 brand-board/brand.js（160 单位网格；字标 100 单位字高）。
   这里只导出构造函数与遮罩，并提供 WeirLogo.mount(root) 把 [data-svg] / [data-mask] 渲染出来。 */
(function (global) {
  const G = {
    plate: "16,48 30,48 56,126 80,56 104,126 130,48 144,48 144,144 16,144",
    notch: "30,48 56,126 80,56 104,126 130,48",
    crest: { x: 16, y: 24, w: 128, h: 10 },
    iconPlate: "0,56 26,56 55,136 80,66 105,136 134,56 160,56 160,160 0,160",
    iconNotch: "0,0 160,0 160,56 134,56 105,136 80,66 55,136 26,56 0,56",
  };
  const WORD = `
<polygon points="0,0 24,0 38,53.8 52,0 76,0 90,53.8 104,0 128,0 102,100 78,100 64,46.2 50,100 26,100"/>
<rect x="146" y="0" width="23" height="100"/><rect x="146" y="0" width="66" height="20"/><rect x="146" y="40" width="58" height="20"/><rect x="146" y="80" width="66" height="20"/>
<rect x="230" y="0" width="23" height="100"/>
<rect x="271" y="0" width="23" height="100"/><rect x="271" y="0" width="40" height="20"/><rect x="271" y="44" width="40" height="20"/>
<path d="M311 0A32 32 0 0 1 311 64V44A12 12 0 0 0 311 20Z"/>
<polygon points="303,58 327,58 347,100 323,100"/>`;
  const ICON_T = "translate(80 80) scale(.72) translate(-80 -84)";
  const crestRect = (fill) => `<rect class="crest" x="${G.crest.x}" y="${G.crest.y}" width="${G.crest.w}" height="${G.crest.h}" fill="${fill}"/>`;

  const SVG = {
    symbol: (o = {}) =>
      `<svg viewBox="8 16 144 136" xmlns="http://www.w3.org/2000/svg"><polygon class="plate" points="${G.plate}" fill="${o.plate || "currentColor"}"/>${o.notch ? `<polygon points="${G.notch}" fill="${o.notch}"/>` : ""}${o.crest === "none" ? "" : crestRect(o.crest || "var(--acid)")}</svg>`,
    wordmark: (o = {}) => `<svg viewBox="-4 -4 355 108" xmlns="http://www.w3.org/2000/svg"><g fill="${o.fill || "currentColor"}">${WORD}</g></svg>`,
    lockup: (o = {}) =>
      `<svg viewBox="8 16 517 136" xmlns="http://www.w3.org/2000/svg"><polygon points="${G.plate}" fill="${o.plate || "currentColor"}"/>${o.notch ? `<polygon points="${G.notch}" fill="${o.notch}"/>` : ""}${crestRect(o.crest || "var(--acid)")}<g fill="${o.word || "currentColor"}" transform="translate(184 48) scale(.96)">${WORD}</g>${o.line ? `<rect x="184" y="${G.crest.y + 4}" width="333" height="2" fill="${o.crest || "var(--acid)"}"/>` : ""}</svg>`,
    stacked: (o = {}) =>
      `<svg viewBox="-20 16 387 260" xmlns="http://www.w3.org/2000/svg"><g transform="translate(93.5 0)"><polygon points="${G.plate}" fill="currentColor"/>${crestRect(o.crest || "var(--acid)")}</g><g fill="currentColor" transform="translate(0 176)">${WORD}</g></svg>`,
    icon: (o = {}) =>
      `<svg viewBox="0 0 160 160" xmlns="http://www.w3.org/2000/svg"><rect width="160" height="160" fill="${o.bg || "#0a0a0b"}"/><g transform="${ICON_T}"><polygon points="${G.plate}" fill="${o.plate || "var(--bone)"}"/>${o.notch ? `<polygon points="${G.notch}" fill="${o.notch}"/>` : ""}${crestRect(o.crest || "var(--acid)")}</g></svg>`,
    bleed: (o = {}) =>
      `<svg viewBox="0 0 160 160" xmlns="http://www.w3.org/2000/svg"><rect width="160" height="160" fill="${o.bg || "#0a0a0b"}"/><polygon points="${G.iconNotch}" fill="${o.fluid || "var(--acid)"}"/><polygon points="${G.iconPlate}" fill="${o.plate || "#0a0a0b"}"/></svg>`,
  };
  const MASK = {
    notch: `<svg viewBox="8 16 144 136" xmlns="http://www.w3.org/2000/svg"><polygon points="${G.notch}" fill="#fff"/></svg>`,
    icon: `<svg viewBox="0 0 160 160" xmlns="http://www.w3.org/2000/svg"><polygon transform="${ICON_T}" points="${G.notch}" fill="#fff"/></svg>`,
    bleed: `<svg viewBox="0 0 160 160" xmlns="http://www.w3.org/2000/svg"><polygon points="${G.iconNotch}" fill="#fff"/></svg>`,
    word: `<svg viewBox="-4 -4 355 108" xmlns="http://www.w3.org/2000/svg"><g fill="#fff">${WORD}</g></svg>`,
    plate: `<svg viewBox="8 16 144 136" xmlns="http://www.w3.org/2000/svg"><polygon points="${G.plate}" fill="#fff"/></svg>`,
  };
  const parseOpts = (s) => (s ? Object.fromEntries(s.split(";").map((kv) => kv.split("=").map((x) => x.trim()))) : {});

  function mount(root = document) {
    root.querySelectorAll("[data-svg]:not([data-mounted])").forEach((el) => {
      el.dataset.mounted = "1";
      el.insertAdjacentHTML("afterbegin", SVG[el.dataset.svg](parseOpts(el.dataset.opts)));
    });
    root.querySelectorAll("[data-mask]:not([data-masked])").forEach((el) => {
      el.dataset.masked = "1";
      const url = `url("data:image/svg+xml,${encodeURIComponent(MASK[el.dataset.mask])}")`;
      el.style.maskImage = el.style.webkitMaskImage = url;
    });
  }
  global.WeirLogo = { G, SVG, MASK, mount };
})(window);
