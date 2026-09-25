// Plate behaviours for the field guide. Every motion is one-shot and starts from input.
(() => {
  "use strict";
  const { make, assign, xterm, reduced } = window.Vex;
  const $ = (id) => document.getElementById(id);
  const h = (tag, cls, text, parent) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    if (parent) parent.appendChild(n);
    return n;
  };
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const later = (ms, fn) => setTimeout(fn, reduced() ? 0 : ms);
  const say = (text) => { $("sr-status").textContent = text; };

  const ACCOUNTS = ["personal", "work", "client", "acme"];
  const DEMO = assign(ACCOUNTS);
  const hex = (name) => xterm(DEMO.get(name));
  const REST = window.Vex.rest;
  // Deep field color for the cover; Vex matches it exactly to hide.
  const deep = (name) => {
    const c = hex(name), k = 0.42;
    return `rgb(${[1, 3, 5].map((i) => Math.round(parseInt(c.slice(i, i + 2), 16) * k)).join(",")})`;
  };

  // A failing plate logs and leaves the rest of the page working.
  const plate = (name, fn) => { try { fn(); } catch (err) { console.error(`plate ${name}:`, err); } };

  plate("copy", () => {
    document.addEventListener("click", (e) => {
      const btn = e.target.closest("[data-copy]");
      if (btn) copy(btn.dataset.copy, btn);
    });
  });
  function copy(text, btn) {
    if (!navigator.clipboard) { say("Copy is unavailable here. Select the text instead."); return; }
    navigator.clipboard.writeText(text).then(() => {
      btn.dataset.label ??= btn.textContent;
      btn.textContent = "copied";
      say("Copied " + text);
      setTimeout(() => { btn.textContent = btn.dataset.label; }, 1400);
    }, () => say("The browser blocked the copy. Select the text instead."));
  }

  plate("cover", () => {
    const stage = $("top"), holder = $("camo-vex"), ghostHolder = $("camo-ghost"), cap = $("camo-cap");
    const fields = [...stage.querySelectorAll(".field")];
    const head = stage.querySelector(".cover-ui > div"), foot = stage.querySelector(".cover-foot");
    const vex = make({ into: holder.querySelector("svg"), cls: "camo", label: "Vex, camouflaged" });
    const ghost = make({ cls: "ghost" });
    ghostHolder.appendChild(ghost.svg);
    stage.tabIndex = 0;
    stage.setAttribute("role", "application");
    stage.setAttribute("aria-roledescription", "camouflage plate");
    stage.setAttribute("aria-label", "Find Vex. Move the lens with the pointer or arrow keys, then click or press Enter to look.");

    let at = -1, found = false, t0 = 0, lens = null;

    const setLens = (x, y) => {
      lens = { x, y };
      stage.style.setProperty("--mx", x + "px");
      stage.style.setProperty("--my", y + "px");
      if (!found) { const r = stage.getBoundingClientRect(); ghost.lookAt(r.left + x, r.top + y); }
    };
    // Vertical room inside field i that the title and install line leave free.
    const room = (i) => {
      const sr = stage.getBoundingClientRect(), fr = fields[i].getBoundingClientRect();
      const hgt = holder.offsetWidth * 160 / 240;
      const lo = Math.max(head.getBoundingClientRect().bottom - sr.top + 8, fr.top - sr.top + 8);
      const hi = Math.min(foot.getBoundingClientRect().top - sr.top - hgt - 8, fr.bottom - sr.top - hgt - 8);
      return { lo, hi, fr, sr };
    };
    const place = (i) => {
      at = i;
      const { lo, hi, fr, sr } = room(i), w = holder.offsetWidth;
      const y = hi > lo ? lo + Math.random() * (hi - lo) : fr.top - sr.top + (fr.height - w * 160 / 240) / 2;
      const x = clamp(fr.left - sr.left + (fr.width - w) / 2 + (Math.random() * 30 - 15), fr.left - sr.left, fr.right - sr.left - w);
      holder.style.transform = ghostHolder.style.transform = `translate(${Math.round(x)}px,${Math.round(y)}px)`;
    };
    const hideBtn = $("camo-hide");
    const hide = (first) => {
      found = false;
      hideBtn.hidden = true;
      const others = fields.map((_, i) => i).filter((i) => i !== at);
      const roomy = others.filter((i) => { const r = room(i); return r.hi > r.lo; });
      const pool = roomy.length ? roomy : others;
      const i = pool[Math.floor(Math.random() * pool.length)];
      if (first) {
        holder.style.transition = ghostHolder.style.transition = "none";
        place(i);
        void holder.offsetWidth;
        holder.style.transition = ghostHolder.style.transition = "";
      } else place(i);
      vex.svg.classList.add("camo");
      vex.setMood("happy");
      vex.lookDir(-1, 0);
      if (first) vex.setColor(deep(ACCOUNTS[i]), false);
      else later(520, () => vex.setColor(deep(ACCOUNTS[i])));
      t0 = performance.now();
      cap.textContent = first ? "Can you spot her? She hides on one of four accounts." : "Hidden again. Different field, same trick.";
    };
    const look = (x, y) => {
      if (found) return;
      const r = holder.getBoundingClientRect(), sr = stage.getBoundingClientRect();
      const cx = sr.left + x, cy = sr.top + y;
      const hit = cx > r.left + r.width * 0.05 && cx < r.right && cy > r.top + r.height * 0.22 && cy < r.bottom - r.height * 0.06;
      if (!hit) { cap.textContent = "Not there. She's better at this than you'd think."; return; }
      found = true;
      const secs = ((performance.now() - t0) / 1000).toFixed(1);
      vex.svg.classList.remove("camo");
      vex.setMood("alarm");
      vex.lookAt(cx, cy);
      later(450, () => {
        vex.setMood("wink");
        vex.setColor(hex(ACCOUNTS[at]));
        hideBtn.hidden = false;
        cap.textContent = `Found her in ${secs} s, on ${ACCOUNTS[at]}. That's the point: when cvx works, you don't see it.`;
      });
    };
    const local = (e) => { const r = stage.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };

    stage.addEventListener("pointermove", (e) => setLens(...local(e)));
    // Touch has no hover: a tap moves the lens there first.
    stage.addEventListener("pointerdown", (e) => setLens(...local(e)));
    stage.addEventListener("pointerleave", (e) => {
      if (e.pointerType === "mouse") { lens = null; stage.style.setProperty("--mx", "-999px"); }
    });
    stage.addEventListener("click", (e) => {
      if (e.target.closest("button, a, code")) return;
      look(...local(e));
    });
    stage.addEventListener("focus", () => {
      if (!lens) setLens(stage.clientWidth / 2, stage.clientHeight / 2);
    });
    stage.addEventListener("keydown", (e) => {
      if (e.target !== stage) return;
      const d = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[e.key];
      const p = lens || { x: stage.clientWidth / 2, y: stage.clientHeight / 2 };
      if (d) {
        e.preventDefault();
        setLens(clamp(p.x + d[0] * 36, 0, stage.clientWidth), clamp(p.y + d[1] * 36, 0, stage.clientHeight));
      } else if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        look(p.x, p.y);
      }
    });
    hideBtn.addEventListener("click", () => { hide(false); stage.focus(); });
    addEventListener("resize", () => { if (at >= 0) place(at); });
    hide(true);
    stage.classList.add("ready");
  });

  plate("specimen", () => {
    const spec = $("spec");
    const vex = make({ into: $("spec-rig"), color: hex("personal"), branch: true });
    const notes = [...$("notes").children];
    const leads = spec.querySelectorAll(".lead"), pins = spec.querySelectorAll(".pin-dot");
    const EYE = [396, 193];
    // Where each note sits in figure space, so her eye turns toward the one being read.
    const AT = [[130, 40], [130, 140], [130, 242], [130, 338], [835, 60], [875, 282]];
    const mark = (i) => {
      notes.forEach((li, j) => {
        const on = i === j;
        li.classList.toggle("on", on);
        leads[j].classList.toggle("on", on);
        pins[j].classList.toggle("on", on);
      });
    };
    const on = (i) => {
      spec.classList.add("focus");
      mark(i);
      vex.lookDir(AT[i][0] - EYE[0], AT[i][1] - EYE[1]);
      if (i === 4) vex.setColor(vex.color() === hex("personal") ? hex("work") : hex("personal"));
    };
    const off = () => { spec.classList.remove("focus"); mark(-1); vex.lookDir(0, 0); };
    notes.forEach((li, i) => {
      li.tabIndex = 0;
      li.addEventListener("pointerenter", () => on(i));
      li.addEventListener("focus", () => on(i));
      li.addEventListener("pointerleave", off);
      li.addEventListener("blur", off);
    });
  });

  plate("habitat", () => {
    const hab = $("hab"), fig = hab.querySelector("svg"), walker = $("walker");
    const cap = $("hab-cap"), pick = $("hab-pick"), hint = $("hab-hint");
    const twigs = [...$("twigs").children];
    const SC = 150 / 240, OFF = 135 * SC, VY = 66.25;
    const folders = [
      { x: 112.5, path: "~/code/web", acc: "personal" },
      { x: 337.5, path: "~/code/billing", acc: "work" },
      { x: 562.5, path: "~/clients/atlas", acc: "client" },
      { x: 787.5, path: "~/scratch", acc: null },
    ];
    const vex = make({ into: $("hab-rig"), color: hex("personal") });
    let cur = 0, x = folders[0].x - OFF, drag = null, tweenId = 0, afterDrag = false;

    hab.tabIndex = 0;
    hab.setAttribute("role", "slider");
    hab.setAttribute("aria-label", "Vex on the branch. Left and right arrows move her between folders.");
    hab.setAttribute("aria-valuemin", "0");
    hab.setAttribute("aria-valuemax", String(folders.length - 1));

    const describe = (f) => `${f.path}, ${f.acc ? "linked to " + f.acc : "not linked"}`;
    const setX = (v) => { x = clamp(v, -20, 900 - 150 + 20); walker.setAttribute("transform", `translate(${x.toFixed(1)},0)`); };
    const toSvg = (e) => { const m = fig.getScreenCTM().inverse(); return e.clientX * m.a + e.clientY * m.c + m.e; };
    const nearest = (sx) => folders.reduce((b, f, i) => (Math.abs(f.x - sx) < Math.abs(folders[b].x - sx) ? i : b), 0);
    const dismissHint = () => hint.classList.add("gone");

    const tween = (to, done) => {
      const id = ++tweenId;
      if (reduced()) { setX(to); done(); return; }
      const from = x, start = performance.now(), dur = 260;
      const step = (now) => {
        if (id !== tweenId) return;
        const t = Math.min(1, (now - start) / dur);
        setX(from + (to - from) * (1 - Math.pow(1 - t, 3)));
        if (t < 1) requestAnimationFrame(step); else done();
      };
      requestAnimationFrame(step);
    };
    const paintTwig = (i) => {
      const f = folders[i], a = twigs[i].querySelector(".a");
      a.textContent = f.acc || "not linked";
      a.className = f.acc ? "a" : "a none";
      a.style.color = f.acc ? hex(f.acc) : "";
    };
    const link = (i, acc) => {
      const f = folders[i], hadFocus = pick.contains(document.activeElement);
      pick.replaceChildren();
      if (hadFocus) hab.focus();
      // Tongue lands on the folder label under her.
      vex.flick((f.x - 40 - x) / SC, (180 - VY) / SC).then(() => {
        f.acc = acc;
        paintTwig(i);
        vex.setMood("happy");
        vex.setColor(hex(acc));
        vex.lookDir(0, 40);
        hab.setAttribute("aria-valuetext", describe(f));
        cap.textContent = `cvx link ${acc}  ✓  ${f.path} is ${acc} from now on.`;
      });
    };
    const arrive = (i) => {
      cur = i;
      const f = folders[i];
      pick.replaceChildren();
      hab.setAttribute("aria-valuenow", String(i));
      hab.setAttribute("aria-valuetext", describe(f));
      if (f.acc) {
        vex.setMood("happy");
        vex.setColor(hex(f.acc));
        cap.textContent = `cd ${f.path} → ${f.acc}. This terminal now exports its own token.`;
      } else {
        vex.setMood("curious");
        vex.setColor(REST);
        cap.textContent = `cd ${f.path} → not linked. She waits in her resting green. Link it to:`;
        for (const acc of ACCOUNTS) {
          const b = h("button", "chip", acc, pick);
          b.type = "button";
          b.style.setProperty("--c", hex(acc));
          b.addEventListener("click", () => link(i, acc));
        }
      }
      vex.lookDir(0, 40);
    };
    const go = (i) => { if (i !== cur || drag) tween(folders[i].x - OFF, () => arrive(i)); };

    walker.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      afterDrag = false;
      drag = { dx: toSvg(e) - x, moved: false };
      fig.setPointerCapture(e.pointerId);
      hab.classList.add("dragging");
    });
    fig.addEventListener("pointermove", (e) => {
      if (!drag) return;
      drag.moved = true;
      setX(toSvg(e) - drag.dx);
    });
    const drop = () => {
      if (!drag) return;
      const moved = drag.moved;
      hab.classList.remove("dragging");
      if (moved) { dismissHint(); afterDrag = true; }
      const i = nearest(x + OFF);
      go(i);
      drag = null;
    };
    fig.addEventListener("pointerup", drop);
    fig.addEventListener("pointercancel", drop);
    fig.addEventListener("click", (e) => {
      if (afterDrag) { afterDrag = false; return; }
      if (walker.contains(e.target)) return;
      go(nearest(toSvg(e)));
    });
    // The labels are bigger targets than Vex on a phone.
    twigs.forEach((li, i) => li.addEventListener("click", () => go(i)));
    hab.addEventListener("keydown", (e) => {
      const next = { ArrowLeft: cur - 1, ArrowRight: cur + 1, Home: 0, End: folders.length - 1 }[e.key];
      if (next == null) return;
      e.preventDefault();
      dismissHint();
      go(clamp(next, 0, folders.length - 1));
    });
    arrive(0);
  });

  plate("colony", () => {
    const glass = $("glass"), cap = $("col-cap"), bWith = $("col-with"), bWithout = $("col-without");
    const rigs = [...glass.children].map((li, i) => ({
      acc: ACCOUNTS[i],
      v: make({ into: li.querySelector("svg"), color: hex(ACCOUNTS[i]), branch: true }),
      st: li.querySelector("p span"),
    }));
    const mode = (withCvx) => {
      bWith.setAttribute("aria-pressed", String(withCvx));
      bWithout.setAttribute("aria-pressed", String(!withCvx));
      rigs.forEach((r, i) => {
        const ok = withCvx || r.acc === "work";
        later(i * 90, () => { r.v.setColor(hex(withCvx ? r.acc : "work")); r.v.setMood(ok ? "happy" : "alarm"); });
        r.st.textContent = ok ? `${r.acc} ✓` : `wants ${r.acc}, runs as work ▲`;
        r.st.classList.toggle("bad", !ok);
      });
      cap.textContent = withCvx
        ? "With cvx: every terminal holds its own account, at the same time. Each tail is its own session token."
        : "Without cvx: one global login in ~/.convex/config.json, so every terminal runs as work. Only one of them wanted to.";
    };
    bWith.addEventListener("click", () => mode(true));
    bWithout.addEventListener("click", () => mode(false));
    glass.addEventListener("click", (e) => {
      rigs.forEach((r, i) => later(i * 60, () => { r.v.lookAt(e.clientX, e.clientY); r.v.hop(); }));
    });
  });

  plate("adopt", () => {
    const input = $("adopt-in"), grid = $("adopt-grid"), cmds = $("adopt-cmds"), cap = $("adopt-cap");
    // Same rule as the CLI's validAccountName.
    const valid = (n) => /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(n);
    const render = () => {
      const raw = input.value.split(",").map((s) => s.trim()).filter(Boolean);
      const bad = raw.filter((n) => !valid(n));
      const names = [...new Set(raw.filter(valid))].slice(0, 12);
      const colors = assign(names), seen = new Map();
      grid.replaceChildren(...names.map((n) => {
        const code = colors.get(n), c = xterm(code), li = h("li");
        li.appendChild(make({ color: c, branch: true, label: "Vex for " + n }).svg);
        h("b", null, n, li).style.color = c;
        h("i", null, "C. convexus var. " + n, li);
        h("span", null, `ansi ${code} · ${c}`, li);
        if (seen.has(code)) h("span", "clash", "same color as " + seen.get(code), li);
        else seen.set(code, n);
        return li;
      }));
      cmds.textContent = names.map((n) => "cvx login " + n).join("\n");
      cap.textContent = bad.length ? "Skipped, not a valid account name: " + bad.join(", ")
        : names.length ? "" : "Type a name to meet her.";
    };
    input.addEventListener("input", render);
    $("adopt-copy").addEventListener("click", (e) => copy(cmds.textContent, e.currentTarget));
  });

  plate("install", () => {
    const tabs = [...document.querySelectorAll('[role="tab"]')];
    const select = (t, focus) => {
      for (const x of tabs) {
        const on = x === t;
        x.setAttribute("aria-selected", String(on));
        x.tabIndex = on ? 0 : -1;
        $(x.getAttribute("aria-controls")).hidden = !on;
      }
      if (focus) t.focus();
    };
    tabs.forEach((t, i) => {
      t.addEventListener("click", () => select(t));
      t.addEventListener("keydown", (e) => {
        const n = tabs.length;
        const j = { ArrowRight: i + 1, ArrowLeft: i - 1 + n, Home: 0, End: n - 1 }[e.key];
        if (j == null) return;
        e.preventDefault();
        select(tabs[j % n], true);
      });
    });
    select(tabs[0]);
  });

  plate("version", () => {
    fetch("https://registry.npmjs.org/@rafay99/cvx/latest")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (d && typeof d.version === "string") $("ver").textContent = "v" + d.version; })
      .catch(() => {});
  });
})();
