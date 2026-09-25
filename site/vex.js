// Vex, the cvx chameleon. One SVG rig shared by every plate.
// Her body lives in index.html as <g id="vx"> so rigs render with JS off;
// this script adds the face, the color wave and the one-shot motions.
// Exposes window.Vex.
(() => {
  "use strict";

  // xterm-256 codes, kept equal to the CLI palette by a test.
  const PALETTE = [45, 141, 214, 213, 111, 180, 116, 176];
  const RESTING = 114;

  const NS = "http://www.w3.org/2000/svg";
  const motion = matchMedia("(prefers-reduced-motion: reduce)");
  const reduced = () => motion.matches;

  const xterm = (n) => {
    const L = [0, 95, 135, 175, 215, 255], i = n - 16;
    return "#" + [L[Math.floor(i / 36)], L[Math.floor(i / 6) % 6], L[i % 6]]
      .map((v) => v.toString(16).padStart(2, "0")).join("");
  };
  const djb2 = (s) => {
    let h = 5381;
    for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
    return h;
  };
  // Colors are handed out in account order: first free palette slot.
  // Past eight accounts they repeat, picked by name hash.
  const assign = (names) => new Map(names.map((n, i) =>
    [n, i < PALETTE.length ? PALETTE[i] : PALETTE[djb2(n) % PALETTE.length]]));

  const el = (tag, attrs, parent) => {
    const n = document.createElementNS(NS, tag);
    for (const k in attrs) n.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(n);
    return n;
  };

  // Rig space is 240x160, snout at the left. Face parts sit outside #vx so moods can swap them.
  const EYE = { x: 50, y: 80 };
  const SNOUT = { x: 18, y: 97 };
  const MOUTH = {
    happy: "M18,97 C32,104 48,106 64,100",
    open: "M18,97 C26,110 44,112 60,102",
    sad: "M18,101 C32,95 48,95 64,101",
    flat: "M18,98 C32,100 48,102 64,101",
  };
  const LID = { closed: "M39,81 C44,78 56,78 61,81", wink: "M39,78 C44,85 56,85 61,78" };
  const BRANCH = "M-6,135 C60,131 150,139 246,132";
  const MOODS = {
    happy: { mouth: "happy" },
    wink: { mouth: "happy", lid: "wink" },
    curious: { mouth: "flat", mark: "?", pupil: 3 },
    alarm: { mouth: "open", mark: "!", pupil: 1.8 },
    sleepy: { mouth: "flat", lid: "closed", mark: "z" },
    sad: { mouth: "sad", look: [0, 40] },
  };

  // Build a rig. `into` reuses an existing <svg> (e.g. a static JS-off rig) and replaces its content.
  function make({ into, color = xterm(RESTING), mood = "happy", cls = "", label, branch = false } = {}) {
    const svg = into || el("svg", {});
    svg.replaceChildren();
    svg.setAttribute("viewBox", "0 0 240 160");
    svg.setAttribute("class", ("vex-rig " + cls).trim());
    if (label) { svg.setAttribute("role", "img"); svg.setAttribute("aria-label", label); }
    else svg.setAttribute("aria-hidden", "true");
    if (branch) el("path", { d: BRANCH, class: "twig" }, svg);

    const skin = (c) => {
      const g = el("g", { class: "skin" }, svg);
      g.style.setProperty("--c", c);
      el("use", { href: "#vx" }, g);
      return g;
    };
    const base = skin(color);
    const wave = skin(color);
    wave.style.clipPath = "inset(0 100% 0 0)";
    const mouth = el("path", { class: "mouth" }, svg);
    const pupil = el("g", { class: "pupil" }, svg);
    const dot = el("circle", { cx: EYE.x, cy: EYE.y, r: 4, class: "pupil-dot" }, pupil);
    el("circle", { cx: EYE.x + 1.6, cy: EYE.y - 1.6, r: 1.4, class: "glint" }, pupil);
    const lid = el("path", { class: "lid" }, svg);
    const mark = el("text", { x: 84, y: 34, class: "mark" }, svg);
    const tongue = el("path", { class: "tongue" }, svg);

    let current = color, anim = null, mood_ = "";

    const api = {
      svg,
      color: () => current,
      mood: () => mood_,
      // Color spreads snout to tail in one sweep, like a real chameleon.
      setColor(next, animate = true) {
        if (next === current) return;
        if (anim) { anim.cancel(); anim = null; base.style.setProperty("--c", current); }
        current = next;
        if (!animate || reduced() || !wave.animate) { base.style.setProperty("--c", next); return; }
        wave.style.setProperty("--c", next);
        anim = wave.animate(
          [{ clipPath: "inset(0 100% 0 0)" }, { clipPath: "inset(0 0% 0 0)" }],
          { duration: 520, easing: "cubic-bezier(.3,.6,.25,1)" });
        anim.onfinish = () => { base.style.setProperty("--c", next); anim = null; };
      },
      setMood(m) {
        const spec = MOODS[m] || MOODS.happy;
        if (mood_) svg.classList.remove("m-" + mood_);
        mood_ = m;
        svg.classList.add("m-" + m);
        mouth.setAttribute("d", MOUTH[spec.mouth]);
        lid.setAttribute("d", LID[spec.lid || "closed"]);
        dot.setAttribute("r", spec.pupil || 4);
        mark.textContent = spec.mark || "";
        api.lookDir(...(spec.look || [0, 0]));
      },
      // Pupil offset toward a direction, capped inside the turret.
      lookDir(dx, dy) {
        const len = Math.hypot(dx, dy) || 1, k = Math.min(1, len / 40) * 4.6;
        pupil.setAttribute("transform", `translate(${(dx / len * k).toFixed(2)},${(dy / len * k).toFixed(2)})`);
      },
      lookAt(clientX, clientY) {
        const m = svg.getScreenCTM();
        if (!m) return;
        api.lookDir(clientX - (m.a * EYE.x + m.c * EYE.y + m.e), clientY - (m.b * EYE.x + m.d * EYE.y + m.f));
      },
      // One tongue flick to a point in rig space. Resolves when done.
      flick(tx, ty) {
        tongue.setAttribute("d", `M${SNOUT.x},${SNOUT.y} L${tx},${ty}`);
        const L = Math.hypot(tx - SNOUT.x, ty - SNOUT.y);
        tongue.style.strokeDasharray = L;
        if (reduced() || !tongue.animate) return Promise.resolve();
        const a = tongue.animate(
          [{ strokeDashoffset: L, opacity: 1 }, { strokeDashoffset: 0, opacity: 1, offset: 0.45 }, { strokeDashoffset: L, opacity: 1 }],
          { duration: 380, easing: "ease-out" });
        return a.finished.catch(() => {});
      },
      hop(target = svg) {
        if (reduced() || !target.animate) return;
        target.animate([{ transform: "translateY(0)" }, { transform: "translateY(-8px)" }, { transform: "translateY(0)" }],
          { duration: 300, easing: "ease-out" });
      },
    };
    api.setMood(mood);
    return api;
  }

  window.Vex = { make, assign, xterm, reduced, PALETTE, RESTING, rest: xterm(RESTING) };
})();
