/* 官网：双语切换、导航、安装复制与发布片播放。 */
(() => {
  const { $, $$ } = WeirTL;
  const grid = $("#grid12");
  if (grid) grid.innerHTML = Array.from({ length: 6 }, (_, i) => `<div class="gc"><span class="mono">${String(i + 1).padStart(2, "0")}</span><b data-i="d${i + 1}t"></b><p data-i="d${i + 1}p"></p></div>`).join("");

  const film = $("#film-v");
  const filmButton = $("#film-play");
  let filmStarted = false;
  const chapters = $$("#chapters button");
  const copyButtons = $$("button[data-copy]");
  const copyStatus = $("#copy-status");
  const copyTimers = new WeakMap();
  const supported = (value) => value === "zh" || value === "en";
  let saved;
  try { saved = localStorage.getItem("weir.lang"); } catch (_) { /* Storage can be unavailable in private or embedded browsing. */ }
  let lang = supported(saved) ? saved : (/^zh/i.test(navigator.language) ? "zh" : "en");
  const queryLang = new URLSearchParams(location.search).get("lang");
  if (supported(queryLang)) lang = queryLang;

  function syncFilm() {
    if (!film) return;
    const playing = filmStarted && !film.paused && !film.ended;
    filmButton?.classList.toggle("gone", playing);
    let current = 0;
    chapters.forEach((button, i) => { if (film.currentTime >= Number(button.dataset.t) - 0.05) current = i; });
    chapters.forEach((button, i) => button.classList.toggle("on", playing && i === current));
  }

  function applyLang(value) {
    if (!supported(value)) return;
    lang = value;
    const dictionary = I18N[lang];
    document.documentElement.lang = lang === "zh" ? "zh-CN" : "en";
    $$("[data-i]").forEach((node) => { const text = dictionary[node.dataset.i]; if (text !== undefined) node.textContent = text; });
    $$("[data-ih]").forEach((node) => { const text = dictionary[node.dataset.ih]; if (text !== undefined) node.innerHTML = text; });
    $$("[data-i-aria]").forEach((node) => { const text = dictionary[node.dataset.iAria]; if (text !== undefined) node.setAttribute("aria-label", text); });
    $$(".lang button").forEach((button) => {
      const active = button.dataset.lang === lang;
      button.classList.toggle("on", active);
      button.setAttribute("aria-pressed", String(active));
    });
    $$("[data-i-demo=eval]").forEach((node) => { if (dictionary["demo.bb.eval"]) node.textContent = dictionary["demo.bb.eval"]; });
    copyButtons.forEach((button) => {
      clearTimeout(copyTimers.get(button));
      button.textContent = dictionary["copy.label"] || (lang === "zh" ? "复制" : "Copy");
    });
    if (copyStatus) copyStatus.textContent = "";
    try { localStorage.setItem("weir.lang", lang); } catch (_) { /* Language switching does not require storage. */ }
    document.title = dictionary["meta.title"] || (lang === "zh" ? "Weir — 多代理协作，有序推进" : "Weir — Multi-agent work, in sync.");
    const description = dictionary["meta.description"] || (lang === "zh"
      ? "Weir 是面向 DeepSeek Harness 的多代理协作预设。并行分工、共享发现，以编辑锁和工作树管理协作。"
      : "Weir is a multi-agent preset for DeepSeek Harness. Coordinate specialist agents with shared knowledge, edit locks, and worktree lanes.");
    document.querySelector('meta[name="description"]')?.setAttribute("content", description);
    document.querySelector('meta[property="og:title"]')?.setAttribute("content", document.title);
    document.querySelector('meta[property="og:description"]')?.setAttribute("content", description);
    if (film) {
      const source = lang === "en" ? "assets/weir-launch-en.mp4" : "assets/weir-launch.mp4";
      film.poster = lang === "en" ? "assets/poster.jpg" : "assets/poster-zh.jpg";
      if (film.getAttribute("src") !== source) {
        filmStarted = false;
        film.pause();
        film.setAttribute("src", source);
        film.load();
        syncFilm();
      }
    }
  }
  $$(".lang button").forEach((button) => button.addEventListener("click", () => applyLang(button.dataset.lang)));
  applyLang(lang);

  /* —— 安装命令 —— */
  copyButtons.forEach((button) => button.addEventListener("click", async () => {
    const command = document.getElementById(button.dataset.copy);
    if (!command) return;
    clearTimeout(copyTimers.get(button));
    button.disabled = true;
    if (copyStatus) copyStatus.textContent = "";
    let copied = false;
    try {
      await navigator.clipboard.writeText(command.textContent.trim());
      copied = true;
    } catch (_) {
      // Keep the command selectable so manual copying works without clipboard permission.
      const selection = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(command);
      selection?.removeAllRanges();
      selection?.addRange(range);
    } finally {
      button.disabled = false;
    }
    const dictionary = I18N[lang];
    const label = dictionary["copy.label"] || (lang === "zh" ? "复制" : "Copy");
    const message = copied
      ? dictionary["copy.done"] || (lang === "zh" ? "已复制" : "Copied")
      : dictionary["copy.failed"] || (lang === "zh" ? "请手动复制已选中的命令。" : "Please copy the selected command manually.");
    button.textContent = copied ? message : label;
    if (copyStatus) copyStatus.textContent = message;
    copyTimers.set(button, setTimeout(() => {
      button.textContent = I18N[lang]["copy.label"] || (lang === "zh" ? "复制" : "Copy");
    }, 2400));
  }));

  /* —— 品牌 —— */
  WeirLogo.mount();
  // The shared renderer also serves exported films; website scheduling lives here.
  (() => {
    const motion = matchMedia("(prefers-reduced-motion: reduce)");
    let reduce = motion.matches, frame = 0, failed = false;
    let visibility, resize;
    const started = performance.now();
    let views = [];
    const fallback = () => {
      failed = true;
      cancelAnimationFrame(frame);
      frame = 0;
      visibility?.disconnect();
      resize?.disconnect();
      $$("[data-fluid]").forEach((element) => {
        $(".fluid-canvas", element)?.remove();
        element.style.background = "linear-gradient(145deg, #182a25 10%, #a9c496 48%, #f1e9c4 65%, #1b292b 90%)";
      });
    };
    const render = (time = 4) => {
      if (failed) return;
      try { WeirFluid.renderAll(time); } catch (_) { fallback(); }
    };
    const schedule = () => {
      const active = !failed && !reduce && !document.hidden && views.some((view) => view.visible);
      if (active && !frame) frame = requestAnimationFrame(loop);
      else if (!active && frame) { cancelAnimationFrame(frame); frame = 0; }
    };
    const loop = (now) => {
      frame = 0;
      if (!reduce && !document.hidden) render(4 + (now - started) / 1000);
      schedule();
    };
    try {
      views = WeirFluid.mount();
      // Paint before visibility observation so reduced-motion always has a first frame.
      render(4);
      if (failed || !views.length) return;
      if ("IntersectionObserver" in window) {
        visibility = new IntersectionObserver((entries) => {
          entries.forEach((entry) => {
            const view = views.find((item) => item.el === entry.target);
            if (view) view.visible = entry.isIntersecting;
          });
          if (reduce && !document.hidden) render(4);
          schedule();
        }, { rootMargin: "160px" });
        views.forEach((view) => { view.visible = false; visibility.observe(view.el); });
      }
      if ("ResizeObserver" in window) {
        resize = new ResizeObserver(() => { if (!document.hidden) render(reduce ? 4 : 4 + (performance.now() - started) / 1000); });
        views.forEach((view) => resize.observe(view.el));
      } else window.addEventListener("resize", () => { if (!document.hidden) render(4); });
      motion.addEventListener("change", (event) => {
        reduce = event.matches;
        if (reduce && !document.hidden) render(4);
        schedule();
      });
      document.addEventListener("visibilitychange", () => {
        if (!document.hidden && reduce) render(4);
        schedule();
      });
      schedule();
    } catch (_) { fallback(); }
  })();

  /* —— 移动导航 —— */
  const bar = $(".bar"), menuToggle = $("#menu-toggle"), nav = $("#site-nav");
  const setMenu = (open) => {
    bar?.classList.toggle("menu-open", open);
    menuToggle?.setAttribute("aria-expanded", String(open));
  };
  menuToggle?.addEventListener("click", () => setMenu(menuToggle.getAttribute("aria-expanded") !== "true"));
  nav?.addEventListener("click", (event) => { if (event.target.closest('a[href^="#"]')) setMenu(false); });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && menuToggle?.getAttribute("aria-expanded") === "true") {
      setMenu(false);
      menuToggle.focus();
    }
  });
  const desktop = matchMedia("(min-width: 781px)");
  desktop.addEventListener("change", (event) => { if (event.matches) setMenu(false); });

  /* —— 导航高亮 —— */
  const links = $$('.bar nav a[href^="#"]');
  const sections = links.map((link) => document.getElementById(link.hash.slice(1))).filter(Boolean);
  if ("IntersectionObserver" in window) {
    const observer = new IntersectionObserver((entries) => entries.forEach((entry) => {
      if (entry.isIntersecting) links.forEach((link) => {
        const active = link.hash === "#" + entry.target.id;
        link.classList.toggle("on", active);
        if (active) link.setAttribute("aria-current", "location");
        else link.removeAttribute("aria-current");
      });
    }), { rootMargin: "-35% 0px -45% 0px" });
    sections.forEach((section) => observer.observe(section));

    const reveal = new IntersectionObserver((entries) => entries.forEach((entry) => {
      if (entry.isIntersecting) { entry.target.classList.add("in"); reveal.unobserve(entry.target); }
    }), { rootMargin: "0px 0px -8% 0px" });
    $$(".sec .head, .lead, .feat, .pipe > div, .gc, .faq details, .install-intro, .install-guide").forEach((node) => {
      node.classList.add("rv");
      reveal.observe(node);
    });
  }

  /* —— 发布片：只有实际开始播放才隐藏封面按钮 —— */
  if (film) {
    const playFilm = async () => {
      try { await film.play(); } catch (_) { filmStarted = false; }
      syncFilm();
    };
    filmButton?.addEventListener("click", playFilm);
    film.addEventListener("playing", () => { filmStarted = true; syncFilm(); });
    ["pause", "ended", "emptied", "error"].forEach((event) => film.addEventListener(event, () => { filmStarted = false; syncFilm(); }));
    film.addEventListener("timeupdate", syncFilm);
    chapters.forEach((button) => button.addEventListener("click", () => {
      film.currentTime = Number(button.dataset.t);
      playFilm();
      $("#film")?.scrollIntoView({ behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth", block: "start" });
    }));
    syncFilm();
  }
})();
