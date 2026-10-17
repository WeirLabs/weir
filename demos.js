/* 官网内的四个"活"演示：同一套品牌界面语言，按时间循环，可见时才运行。 */
(() => {
  const { seg, EZ, fx, html, $, $$, keys } = WeirTL;
  const motion = matchMedia("(prefers-reduced-motion: reduce)");
  let reduce = motion.matches;
  let frame = 0;
  const live = [];

  // Keep SVG paths, fixed positions, and type on the same coordinate system.
  function fitStage(host) {
    const stage = $(".dm-stage", host);
    if (!stage) return;
    Object.assign(host.style, { position: "relative", overflow: "hidden" });
    Object.assign(stage.style, { position: "absolute", inset: "0 auto auto 0", width: "800px", height: "520px", maxWidth: "none", boxSizing: "border-box", transformOrigin: "top left" });
    const fit = () => {
      const scale = host.clientWidth / 800;
      host.style.height = `${520 * scale}px`;
      stage.style.transform = `scale(${scale})`;
    };
    fit();
    if ("ResizeObserver" in window) new ResizeObserver(fit).observe(host);
    else window.addEventListener("resize", fit);
  }

  function schedule() {
    const active = !reduce && !document.hidden && live.some((d) => d.visible);
    if (active && !frame) frame = requestAnimationFrame(loop);
    else if (!active && frame) { cancelAnimationFrame(frame); frame = 0; }
  }
  function demo(host, D, build, update, still = 0.8) {
    if (!host) return;
    const api = build(host);
    fitStage(host);
    const d = { host, D, api, update, t0: performance.now(), visible: false, still };
    live.push(d);
    update(api, reduce ? D * still : 0);
    if ("IntersectionObserver" in window) {
      new IntersectionObserver((entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting && !d.visible) d.t0 = performance.now();
          d.visible = entry.isIntersecting;
        });
        schedule();
      }, { rootMargin: "80px" }).observe(host);
    } else { d.visible = true; schedule(); }
  }
  function loop(now) {
    frame = 0;
    if (!reduce && !document.hidden) live.forEach((d) => { if (d.visible) d.update(d.api, ((now - d.t0) / 1000) % d.D); });
    schedule();
  }
  motion.addEventListener("change", (event) => {
    reduce = event.matches;
    live.forEach((d) => {
      d.t0 = performance.now();
      if (reduce) d.update(d.api, d.D * d.still);
      $$(".demo-state", d.host).forEach((label) => { label.textContent = reduce ? "DEMO · STILL" : "DEMO · LOOP"; });
    });
    schedule();
  });
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) live.forEach((d) => { d.t0 = performance.now(); });
    schedule();
  });

  const bar = (title, right = "") => `<div class="win-bar"><i></i><i></i><i></i><span class="t">${title}</span><span class="r">${right}</span></div>`;
  const live_ = `<span class="pill lime demo-state">${reduce ? "DEMO · STILL" : "DEMO · LOOP"}</span>`;

  /* ---------- 01 黑板 ---------- */
  demo($("#demo-bb"), 15, (host) => {
    host.innerHTML = `<div class="win ui dm" style="font-size:17px">${bar("Blackboard · session", live_)}
      <div class="bb-head"><h4>Blackboard</h4><span class="pill cnt">0 entries</span><span class="btn eval" data-i-demo="eval">Evaluate for promotion</span></div>
      <div class="bb-chips">${["all", "map", "contract", "deadend", "wiring", "recipe", "why"].map((x, i) => `<span class="pill ${i === 0 ? "on" : ""}">${x}</span>`).join("")}</div>
      <div class="bb-rows"></div>
      <div class="dm-toast mono"></div></div>`;
    const E = [
      { k: "auth-layout", ty: "map", sm: "auth/ owns tokens; the middleware lives in packages/api/src/mw", at: 0.4, dest: "docs/spikes.md" },
      { k: "jwt-in-edge-runtime", ty: "deadend", sm: "The edge runtime has no node crypto — verify() cannot run there", at: 6.4, dest: "AGENTS.md" },
      { k: "session-sid-opaque", ty: "contract", sm: "The sid must stay opaque: clients never parse or depend on it", at: 8.0, dest: "keep on the board" },
    ];
    const rows = E.map((e, i) => { const r = html(`<div class="bb-row"><span class="ty ${e.ty}">${e.ty}</span><span class="k">${e.k}</span><span class="rd"><b>0</b> reads</span><span class="sm">${e.sm}</span><span class="sug mono">→ ${e.dest}</span></div>`); $(".bb-rows", host).append(r); return r; });
    return { host, E, rows, cnt: $(".cnt", host), toast: $(".dm-toast", host), ev: $(".eval", host) };
  }, (a, t) => {
    const reads = [[[7.0, 7.8, 8.6, 9.4]], [[8.2, 9.0]], [[]]];
    let n = 0;
    a.rows.forEach((r, i) => {
      const e = a.E[i], k = seg(t, e.at, e.at + 0.5, EZ.back), born = t >= e.at && t < 14.6;
      if (born) n++;
      fx(r, { o: born ? Math.min(1, k) : 0, y: (1 - k) * -18 });
      const rd = reads[i][0].filter((x) => t >= x).length; $(".rd b", r).textContent = rd;
      let cls = "bb-row";
      if (i === 0 && t > 0.4 && t < 1.8) cls += " hold";
      if (i === 0 && t > 3.2 && t < 5.0) cls += " lock";
      r.className = cls;
      const promoted = i === 0 && t > 12.6;
      const ty = $(".ty", r); ty.className = "ty " + (promoted ? "promoted" : e.ty); ty.textContent = promoted ? "promoted" : e.ty;
      fx($(".sug", r), { o: seg(t, 10.8, 11.3) * (t < 14.4 ? 1 : 0) });
    });
    a.cnt.textContent = `${n} ${n === 1 ? "entry" : "entries"}`;
    const T = [[0.4, "agent-01 ▸ blackboard_apply(\"auth-layout\") → <b class=ok>✓ write token · ttl 60m</b>"], [1.8, "agent-01 ▸ blackboard_write(map) → <b class=ok>✓ entry created</b>"], [3.2, "agent-02 ▸ blackboard_apply(\"auth-layout\") → <b class=no>✕ held by agent-01 · queued · subscribed</b>"], [5.0, "agent-01 released → <b class=ok>◂ agent-02 notified</b>"], [7.0, "agent-03 ▸ blackboard_read(auth-layout) → <b class=ok>no re-exploration</b>"], [10.6, "you ▸ <b class=ok>Evaluate for promotion</b> — ranked by reads, you rule on each"], [12.6, "<b class=ok>✓ 1 promoted → docs/spikes.md</b> · agents never saw the word “promotion”"]];
    const cur = T.filter((x) => t >= x[0]).pop();
    a.toast.innerHTML = cur && t < 14.6 ? cur[1] : "";
    a.ev.classList.toggle("primary", t > 10.5 && t < 11.2);
  });

  /* ---------- 02 编辑锁 ---------- */
  demo($("#demo-lk"), 16, (host) => {
    host.innerHTML = `<div class="dm-stage ui" style="font-size:16px"><svg class="dm-wires" viewBox="0 0 800 520"><g></g></svg>
      ${["a", "b", "c"].map((k, i) => `<div class="dm-agent" data-a="${k}" style="left:0;top:${20 + i * 130}px"><b>agent-${k}</b><i>session ${i + 1}</i><em></em></div>`).join("")}
      <div class="dm-file"><div class="fh mono"><span class="dot"></span><span class="fs">FREE</span><span class="fo"></span></div><div class="fn mono">src/auth/session.ts</div><div class="fm mono"></div><div class="hatch"></div></div>
      <div class="dm-steps mono">${["ACQUIRE", "TRY_STEAL", "RELEASE · HOLD", "CRASH-HEAL"].map((s, i) => `<div><b>0${i + 1}</b> ${s}</div>`).join("")}</div></div>`;
    const g = $("svg g", host), ns = "http://www.w3.org/2000/svg";
    const mk = (cls, d) => { const p = document.createElementNS(ns, "path"); p.setAttribute("pathLength", 1); p.setAttribute("class", cls); p.setAttribute("d", d); g.append(p); return p; };
    const ys = { a: 56, b: 186, c: 316 };
    const wire = { a: mk("w", `M232 ${ys.a} C340 ${ys.a}, 370 258, 480 258`), b: mk("w", `M232 ${ys.b} C340 ${ys.b}, 370 258, 480 258`), c: mk("w", `M232 ${ys.c} C340 ${ys.c}, 370 258, 480 258`), steal: mk("w steal", `M100 ${ys.b - 36} C40 ${ys.b - 76}, 40 ${ys.a + 76}, 100 ${ys.a + 40}`) };
    return { host, wire, ag: Object.fromEntries($$(".dm-agent", host).map((x) => [x.dataset.a, x])), file: $(".dm-file", host), steps: $$(".dm-steps > div", host) };
  }, (a, t) => {
    const S = [0, 4, 8, 12];
    const s = S.findIndex((x, i) => t >= x && t < (S[i + 1] ?? 16));
    a.steps.forEach((d, i) => d.classList.toggle("on", i === s));
    let owner = null, status = "FREE", dot = "", meta = "", msgs = { a: "", b: "", c: "" }, w = { a: 0, b: 0, c: 0, steal: 0 }, hatch = 0, crash = false;
    if (t >= 0.3) { owner = "a"; status = "OWNED"; dot = "lime"; meta = "agent-a · epoch 3 · gen 12"; w.a = seg(t, 0.3, 0.8, EZ.out3); }
    if (t >= 1.2) { const k = seg(t, 1.2, 1.7, EZ.io2), bk = seg(t, 1.7, 2.2, EZ.in2); w.b = 0.5 * k * (1 - bk); w.c = 0.5 * seg(t, 1.4, 1.9, EZ.io2) * (1 - seg(t, 1.9, 2.4, EZ.in2)); }
    if (t >= 1.8) msgs.b = "✕ LOCKED"; if (t >= 2.0) msgs.c = "✕ LOCKED";
    if (t >= S[1]) {
      msgs.b = ""; w.b = 0; w.c = 0; w.steal = seg(t, S[1] + 0.3, S[1] + 0.9, EZ.io2);
      if (t >= S[1] + 0.5) msgs.b = "edit_lock_try_steal";
      if (t >= S[1] + 1.3) msgs.a = "reply: release";
      if (t >= S[1] + 1.9) { owner = "b"; meta = "agent-b · epoch 4 · gen 13"; msgs.a = ""; msgs.b = "transferred ✓"; w.a = 1 - seg(t, S[1] + 1.7, S[1] + 2.1); w.b = seg(t, S[1] + 1.9, S[1] + 2.4, EZ.out3); w.steal = 0; } else w.a = 1;
    }
    if (t >= S[2]) {
      w.a = 0; w.steal = 0; msgs = { a: "", b: "", c: "" }; owner = "b"; w.b = 1; meta = "agent-b · turn ending";
      if (t >= S[2] + 0.5) msgs.b = "turn/end → release or hold?";
      if (t >= S[2] + 1.4) { status = "HOLDING"; dot = "amber"; meta = "agent-b · hold ≤ 30 min · timer 29:59"; msgs.b = "edit_lock_hold ✓"; }
      if (t >= S[2] + 2.8) { owner = null; status = "FREE"; dot = ""; meta = "released · generation tombstone kept"; w.b = 1 - seg(t, S[2] + 2.8, S[2] + 3.2); msgs.b = "edit_lock_release ✓"; }
    }
    if (t >= S[3]) {
      owner = "b"; w.b = 1; meta = "agent-b · publishing…";
      if (t >= S[3] + 0.5) { crash = true; status = "UNKNOWN"; dot = "pink"; meta = "publish in flight · process SIGKILL"; hatch = 1; msgs.b = "✕ SIGKILL"; }
      if (t >= S[3] + 1.4) meta = "pid proven dead · lease expired · same host";
      if (t >= S[3] + 2.4) { crash = false; status = "RECOVERED"; dot = "lime"; hatch = 0; meta = "unknown → settled in one commit · history kept"; msgs.b = ""; w.b = 1 - seg(t, S[3] + 2.4, S[3] + 2.9); owner = null; }
    }
    ["a", "b", "c"].forEach((k) => { a.wire[k].style.strokeDashoffset = 1 - w[k]; a.wire[k].style.opacity = w[k] > 0.001 ? 1 : 0; a.wire[k].classList.toggle("bad", (k === "c" || (k === "b" && t < S[1])) && w[k] > 0 && w[k] < 0.7); });
    a.wire.steal.style.strokeDashoffset = 1 - w.steal; a.wire.steal.style.opacity = w.steal > 0.001 ? 1 : 0;
    ["a", "b", "c"].forEach((k) => { const el = a.ag[k]; $("em", el).textContent = msgs[k]; el.classList.toggle("own", owner === k); el.classList.toggle("bad", msgs[k].startsWith("✕")); });
    const f = a.file;
    $(".fs", f).textContent = status; $(".fo", f).textContent = owner ? "OWNER · agent-" + owner : ""; $(".dot", f).className = "dot " + dot; $(".fm", f).textContent = meta;
    f.style.borderColor = status === "OWNED" || status === "RECOVERED" ? "rgba(204,255,0,.8)" : status === "HOLDING" ? "#ffb020" : status === "UNKNOWN" ? "var(--pink)" : "";
    $(".hatch", f).style.opacity = hatch; f.style.transform = crash ? `translateX(${Math.sin(t * 60) * 3}px)` : "none";
  });

  /* ---------- 03 车道 ---------- */
  demo($("#demo-ln"), 16, (host) => {
    host.innerHTML = `<div class="dm-stage ui" style="font-size:16px"><svg class="dm-graph" viewBox="0 0 800 270"><g></g></svg><div class="dm-lchips"></div>
      <div class="win dm-card">${bar("Approval · worktree_land", '<span class="pill lime dm-cs">awaiting you</span>')}<div class="dm-cb"></div></div>
      <svg class="dm-cur" width="26" height="26" viewBox="0 0 24 24"><path d="M3 2l7 19 3-8 8-3z" fill="#ecece6" stroke="#0a0a0b" stroke-width="1.4" stroke-linejoin="round"/></svg></div>`;
    const g = $("svg g", host), ns = "http://www.w3.org/2000/svg";
    const el = (tag, attrs) => { const n = document.createElementNS(ns, tag); Object.entries(attrs).forEach(([k, v]) => n.setAttribute(k, v)); g.append(n); return n; };
    const MAIN = 40, LN = [["refactor-auth", 110, [250, 340, 430]], ["tests", 160, [280, 370]], ["docs", 210, [260, 350, 440]]], FX = 150;
    const main = el("path", { d: `M20 ${MAIN} H780`, class: "main", pathLength: 1 }); const mt = el("text", { x: 20, y: MAIN - 12, class: "gt" }); mt.textContent = "main";
    const lanes = LN.map(([n, y, xs]) => { const p = el("path", { d: `M${FX} ${MAIN} C${FX + 24} ${MAIN}, ${FX} ${y}, ${FX + 44} ${y} H${xs[xs.length - 1] + 30}`, class: "lane", pathLength: 1 }); const t = el("text", { x: FX + 50, y: y - 12, class: "gt" }); t.textContent = "weir/" + n; const nodes = xs.map((x) => el("circle", { cx: x, cy: y, r: 6, class: "nd" })); return { p, t, nodes, xs, y }; });
    const merge = el("path", { d: `M470 110 C560 110, 580 ${MAIN}, 640 ${MAIN}`, class: "merge", pathLength: 1 }); const mnode = el("circle", { cx: 640, cy: MAIN, r: 9, class: "nd mg" });
    const chips = $(".dm-lchips", host); chips.innerHTML = LN.map(([n, y]) => `<span class="lcp mono" style="top:${(y / 270) * 50}%"></span>`).join("");
    return { host, main, mt, lanes, merge, mnode, chips: $$(".lcp", chips), cb: $(".dm-cb", host), card: $(".dm-card", host), cs: $(".dm-cs", host), cur: $(".dm-cur", host) };
  }, (a, t) => {
    a.main.style.strokeDashoffset = 1 - seg(t, 0, 0.8, EZ.out3);
    a.lanes.forEach((lp, i) => {
      const s = 0.4 + i * 0.4;
      lp.p.style.strokeDashoffset = 1 - seg(t, s, s + 0.8, EZ.out3);
      lp.nodes.forEach((n, k) => { n.style.opacity = seg(t, s + 0.8 + k * 0.4, s + 1.0 + k * 0.4); });
      const st = t >= 5.2 + i * 0.3 ? "landable" : t >= 3.4 + i * 0.3 ? "checking" : t >= 1.6 + i * 0.3 ? "working" : "preparing";
      const c = a.chips[i]; c.textContent = st.toUpperCase(); c.className = "lcp mono " + st; c.style.left = `${((lp.xs[lp.xs.length - 1] + 50) / 800) * 100}%`; c.style.opacity = seg(t, s + 1.2, s + 1.6);
    });
    const ck = seg(t, 6.4, 6.9, EZ.out5), merged = t >= 10.8;
    a.card.style.opacity = ck * (t < 15.2 ? 1 : 0); a.card.style.transform = `translateY(${(1 - ck) * 30}px)`;
    a.cb.innerHTML = !merged
      ? `<div class="ct">Merge lane <b>refactor-auth</b> into <b>main</b></div><div class="cm mono"><span>3 commits</span><span class="g">+142</span><span class="r">−37</span><span>5 files</span></div><div class="cc mono"><div>git merge-tree · pre-check <b class="ok">✓ no conflicts</b></div><div>verify · check commands <b class="ok">✓ passed</b></div></div><div class="cbtn"><span class="btn ${t > 10.2 ? "primary" : ""}">Merge into main (--no-ff)</span><span class="btn ghost">Not now</span></div>`
      : `<div class="ct">Merged. <em>What about the lane?</em></div><div class="co mono"><div>A · Keep the worktree</div><div class="${t > 12.6 ? "pk" : ""}">B · Clean worktree · keep branch</div><div>C · Clean worktree and branch</div></div>`;
    a.cs.textContent = merged ? "merged" : "awaiting you";
    const co = keys(t, [[8.2, 0], [8.5, 1], [11.2, 1], [11.6, 0]], EZ.lin);
    a.cur.style.opacity = co; a.cur.style.left = `${keys(t, [[8.2, 86], [10.2, 22]], EZ.io2)}%`; a.cur.style.top = `${keys(t, [[8.2, 96], [10.2, 79]], EZ.io2)}%`;
    const mk = seg(t, 10.8, 11.6, EZ.io2); a.merge.style.strokeDashoffset = 1 - mk; a.mnode.style.opacity = seg(t, 11.4, 11.7);
    a.main.style.stroke = mk > 0.99 ? "var(--acid)" : ""; a.lanes[0].p.style.stroke = merged ? "var(--acid)" : "";
  });

  /* ---------- 04 受监督组 ---------- */
  demo($("#demo-sg"), 14, (host) => {
    const C = [["agent-01", "finder", 1, "Map the auth module layout"], ["agent-02", "deep", 0, "Extract the middleware"], ["agent-03", "quick", 0, "Port session tests"], ["agent-04", "writing", 0, "Update the docs"]];
    host.innerHTML = `<div class="dm-stage ui" style="font-size:16px"><div class="dm-grp mono"><span class="lab">SUPERVISED GROUP</span><b>refactor-auth</b><span class="gs">0 / 4 settled</span></div>
      <div class="dm-cards">${C.map(([id, cat, ro, t]) => `<div class="ag ${ro ? "ro" : ""}"><div class="ag-h"><span>${id}</span><span class="cat">${cat}</span></div><div class="ag-t">${t}</div><div class="ag-bar"><b></b></div><div class="ag-s"><span class="s1">RUNNING</span><span class="s2">${ro ? "read-only guard" : "terminal contract"}</span></div><div class="stamp">STATUS: completed</div></div>`).join("")}</div>
      <div class="dm-sig mono"></div></div>`;
    return { host, cards: $$(".ag", host), gs: $(".gs", host), sig: $(".dm-sig", host) };
  }, (a, t) => {
    const DONE = [3.6, 8.8, 5.0, 6.4];
    let settled = 0;
    a.cards.forEach((c, i) => {
      const k = seg(t, i * 0.12, i * 0.12 + 0.45, EZ.back);
      c.style.opacity = Math.min(1, k) * (t < 13.4 ? 1 : 0); c.style.transform = `translateY(${(1 - k) * 20}px)`;
      const blocked = i === 1 && t >= 4.2 && t < 7.0, done = t >= DONE[i];
      const prog = i === 1 ? (t < 4.2 ? seg(t, 0.5, 4.2, EZ.lin) * 0.55 : t < 7.0 ? 0.55 : 0.55 + 0.45 * seg(t, 7.0, 8.8, EZ.io2)) : seg(t, 0.5, DONE[i], EZ.io2);
      $(".ag-bar b", c).style.width = prog * 100 + "%"; $(".ag-bar b", c).style.background = blocked ? "var(--pink)" : "";
      if (done) settled++;
      const st = $(".stamp", c); st.textContent = blocked ? "STATUS: blocked" : "STATUS: completed"; st.style.opacity = blocked || done ? 1 : 0; st.style.color = blocked ? "var(--pink)" : ""; st.style.borderColor = blocked ? "var(--pink)" : "";
      $(".s1", c).textContent = blocked ? "BLOCKED · awaiting ruling" : done ? "COMPLETED" : i === 1 && t >= 7.0 ? "RESUMED" : "RUNNING";
      c.style.borderColor = done ? "rgba(204,255,0,.55)" : blocked ? "rgba(255,46,154,.55)" : "";
    });
    a.gs.textContent = `${settled} / 4 settled`;
    a.sig.innerHTML = t >= 9.6 && t < 13.4 ? '<span class="ok">GROUP SETTLED</span> · exactly one signal · members’ reports already delivered' : t >= 7.0 && t < 8.8 ? '<span class="ok">resume_agent(agent-02)</span> · the conductor ruled: continue' : t >= 4.2 && t < 7.0 ? '<span class="no">agent-02 reports blocked</span> · the conductor decides — the member cannot' : "";
  });
})();
