// Guided demo: a real call in about a minute. It points at the real buttons on the real screens
// (nothing is faked) and waits for the person to tap them. Anywhere else on screen is blocked
// while a step waits for a tap, so they can't wander off mid-story. Skip any time.

const STYLE = `
.tour-block { position: fixed; z-index: 260; background: rgba(4, 6, 9, .74); pointer-events: auto; transition: all .25s ease; }
.tour-ring { position: fixed; z-index: 261; border-radius: 14px; pointer-events: none; box-shadow: 0 0 0 3px var(--hivis), 0 0 24px 4px rgba(212, 245, 58, .45); transition: all .25s ease; }
.tour-ring.tap::after { content: ""; position: absolute; inset: -3px; border-radius: inherit; border: 3px solid var(--hivis); animation: tour-pulse 1.4s ease-out infinite; }
@keyframes tour-pulse { 0% { opacity: .9; transform: scale(1); } 100% { opacity: 0; transform: scale(1.12); } }
.tour-tip { position: fixed; z-index: 262; left: 16px; right: 16px; max-width: 420px; margin: 0 auto; background: #15171b; color: var(--text);
  border: 1px solid #3a3b40; border-top: 4px solid var(--hivis); border-radius: 14px; padding: 16px 18px 14px; box-shadow: 0 18px 50px rgba(0,0,0,.6);
  transition: top .25s ease, bottom .25s ease, opacity .2s ease; }
.tour-tip .tour-step { font: 700 12px/1 "Barlow Condensed", sans-serif; letter-spacing: .12em; text-transform: uppercase; color: var(--hivis); margin-bottom: 8px; }
.tour-tip .tour-title { font: 800 24px/1.05 "Barlow Condensed", sans-serif; text-transform: uppercase; letter-spacing: .01em; margin-bottom: 6px; }
.tour-tip .tour-text { font: 500 16px/1.4 "Barlow", sans-serif; color: #d9d6cf; }
.tour-tip .tour-do { display: flex; align-items: center; gap: 8px; margin-top: 10px; font: 700 15px/1.2 "Barlow Condensed", sans-serif; letter-spacing: .06em; text-transform: uppercase; color: var(--hivis); }
.tour-tip .tour-do::before { content: ""; width: 9px; height: 9px; border-radius: 50%; background: var(--hivis); box-shadow: 0 0 0 0 rgba(212,245,58,.6); animation: tour-dot 1.4s infinite; }
@keyframes tour-dot { 0% { box-shadow: 0 0 0 0 rgba(212,245,58,.6); } 100% { box-shadow: 0 0 0 10px rgba(212,245,58,0); } }
.tour-tip .tour-foot { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-top: 14px; }
.tour-tip .tour-skip { background: none; border: 0; color: #8d8a83; font: 500 14px "Barlow", sans-serif; padding: 6px 0; cursor: pointer; }
.tour-tip .tour-next { min-width: 120px; }
.tour-tip.center { top: 50% !important; transform: translateY(-50%); bottom: auto !important; }
.tour-tip.center .tour-title { font-size: 30px; }
.tour-tip .tour-cta { display: grid; gap: 10px; margin-top: 16px; }
.tour-tip .tour-fine { margin-top: 10px; font: 500 13px/1.4 "Barlow", sans-serif; color: #8d8a83; text-align: center; }
@media (prefers-reduced-motion: reduce) { .tour-block, .tour-ring, .tour-tip { transition: none; } .tour-ring.tap::after, .tour-tip .tour-do::before { animation: none; } }
`;

/** Finds the element a step points at. A selector, or a function for things like "Sam's tag". */
const find = (target) => (typeof target === "function" ? target() : target ? document.querySelector(target) : null);
const byText = (sel, text) => () => [...document.querySelectorAll(sel)].find((el) => el.textContent.includes(text)) || null;

export function startTour({ onFinish, onEvent } = {}) {
  if (document.querySelector(".tour-tip")) return;
  const style = document.createElement("style");
  style.textContent = STYLE;
  document.head.appendChild(style);

  const blocks = [0, 1, 2, 3].map(() => {
    const d = document.createElement("div");
    d.className = "tour-block";
    document.body.appendChild(d);
    return d;
  });
  const ring = document.createElement("div");
  ring.className = "tour-ring";
  document.body.appendChild(ring);
  const tip = document.createElement("div");
  tip.className = "tour-tip";
  tip.setAttribute("role", "dialog");
  tip.setAttribute("aria-live", "polite");
  document.body.appendChild(tip);

  const sam = byText('[data-act="person"]', "Sam Riopelle");
  const steps = [
    { center: true, title: "A real call, in 60 seconds",
      text: "You're the incident commander on a structure fire. Two firefighters are inside. Here's how Fire Ground Board keeps track of every one of them.",
      next: "Start", skip: "Skip, I'll look around" },
    { target: "a.active-card", title: "The call came in from dispatch",
      text: "The page opened this incident and alerted the crew automatically.", tap: "Tap the call to open the board",
      done: () => /#\/incident\//.test(location.hash), scroll: true },
    { target: ".tally", wide: true, title: "Everyone, on every phone",
      text: "Who's responding, staged, inside, out and in rehab. Every member sees the same board, live.", next: "Next", settle: 600 },
    { target: '[data-act="start-par"]', title: "Tess and Sam are inside",
      text: "Time for a personnel accountability check.", tap: "Tap Call PAR", done: () => !!document.querySelector(".overlay .sheet"), scroll: true },
    { target: '.overlay .sheet button[type="submit"]', title: "One tap reaches the whole crew",
      text: "Every phone on this incident gets the PAR banner at the same moment.", tap: "Tap Call PAR to send it",
      done: () => !!document.querySelector(".par") && !document.querySelector(".overlay") },
    { target: ".par", wide: true, title: "Confirmations come in live",
      text: "Each firefighter taps \"I'm accounted for\" on their own phone. Watch the count.", watch: true,
      done: () => document.querySelectorAll(".par-ok").length >= 4, timeout: 14000 },
    { target: sam, title: "Sam hasn't answered",
      text: "He's inside, and nothing on the radio. His tag is still waiting.", tap: "Tap Sam", done: () => !!document.querySelector('.overlay [data-status="MISSING"]'), scroll: true },
    { target: '.overlay [data-status="MISSING"]', title: "Don't wait",
      text: "Mark him missing.", tap: "Tap Missing", done: () => /missing/i.test(document.querySelector(".overlay .sheet .h3")?.textContent || "") },
    { target: '.overlay .sheet button[type="submit"]', title: "Sound the alarm",
      text: "Every device on the incident will alarm.", tap: "Tap Mark missing", done: () => !!document.querySelector(".alarm") && !document.querySelector(".overlay") },
    { target: ".alarm", wide: true, top: true, title: "Every phone is alarming",
      text: "Command, crew and mutual aid all know at once, and the board shows exactly who's missing and when they were last seen.", next: "Next", settle: 900 },
    { center: true, final: true, title: "That's Fire Ground Board",
      text: "Set it up for your department in a few minutes. Your crew downloads the free app and joins with one code." },
  ];

  let i = -1, raf = 0, timer = 0, ended = false, stepAt = 0;
  const total = steps.length - 2;

  const place = () => {
    raf = requestAnimationFrame(place);
    const s = steps[i];
    if (!s) return;
    const el = s.center ? null : find(s.target);
    const vw = window.innerWidth, vh = window.innerHeight;
    if (!el) {
      // Full dim while the screen changes, or for the centred cards.
      blocks[0].style.cssText = `left:0;top:0;width:${vw}px;height:${vh}px`;
      blocks.slice(1).forEach((b) => (b.style.cssText = "width:0;height:0"));
      ring.style.opacity = "0";
      tip.classList.toggle("center", !!s.center);
      if (!s.center) tip.style.opacity = "0";
      return;
    }
    tip.style.opacity = "1";
    tip.classList.remove("center");
    let r = el.getBoundingClientRect();
    if (s.wide) r = { left: 8, right: vw - 8, top: r.top, bottom: r.bottom, width: vw - 16, height: r.height };
    const pad = 6;
    const L = Math.max(0, r.left - pad), T = Math.max(0, r.top - pad), R = Math.min(vw, r.right + pad), B = Math.min(vh, r.bottom + pad);
    blocks[0].style.cssText = `left:0;top:0;width:${vw}px;height:${T}px`;
    blocks[1].style.cssText = `left:0;top:${B}px;width:${vw}px;height:${Math.max(0, vh - B)}px`;
    blocks[2].style.cssText = `left:0;top:${T}px;width:${L}px;height:${B - T}px`;
    blocks[3].style.cssText = `left:${R}px;top:${T}px;width:${Math.max(0, vw - R)}px;height:${B - T}px`;
    // While a step only wants "Next", the highlighted part is for looking at, not tapping.
    const tapThrough = !!s.tap;
    ring.style.cssText = `left:${L}px;top:${T}px;width:${R - L}px;height:${B - T}px;opacity:1;pointer-events:none`;
    ring.classList.toggle("tap", tapThrough);
    holeBlocker.style.cssText = tapThrough ? "display:none" : `position:fixed;z-index:260;left:${L}px;top:${T}px;width:${R - L}px;height:${B - T}px`;
    const th = tip.offsetHeight;
    const below = vh - B, above = T;
    if (below >= th + 24 || below >= above) { tip.style.top = `${Math.min(B + 14, vh - th - 12)}px`; tip.style.bottom = "auto"; }
    else { tip.style.top = `${Math.max(12, T - th - 14)}px`; tip.style.bottom = "auto"; }
  };
  const holeBlocker = document.createElement("div");
  document.body.appendChild(holeBlocker);

  const render = () => {
    const s = steps[i];
    const n = i;
    const stepLabel = s.center ? "" : `<div class="tour-step">Step ${n} of ${total}</div>`;
    if (s.final) {
      tip.innerHTML = `<div class="tour-title">${s.title}</div><div class="tour-text">${s.text}</div>
        <div class="tour-cta"><button class="btn primary block" data-tour="trial">Start my free trial</button>
        <button class="btn block" data-tour="stay">Keep exploring the demo</button></div>
        <div class="tour-fine">Free for 30 days. No card needed.</div>`;
    } else {
      tip.innerHTML = `${stepLabel}<div class="tour-title">${s.title}</div><div class="tour-text">${s.text}</div>
        ${s.tap ? `<div class="tour-do">${s.tap}</div>` : ""}
        <div class="tour-foot"><button class="tour-skip" data-tour="skip">${s.skip || "Skip the tour"}</button>
        ${s.next ? `<button class="btn primary tour-next" data-tour="next">${s.next}</button>` : ""}</div>`;
    }
  };

  const go = (to) => {
    clearTimeout(timer);
    i = to;
    stepAt = Date.now();
    if (i >= steps.length) return end("done");
    const s = steps[i];
    onEvent?.(`tour_${i}`);
    render();
    if (s.top) window.scrollTo({ top: 0, behavior: "smooth" });
    if (s.scroll) {
      const el = find(s.target);
      el?.scrollIntoView?.({ block: "center", behavior: "smooth" });
    }
    if (s.timeout) timer = setTimeout(() => { if (steps[i] === s) go(i + 1); }, s.timeout);
  };

  // Steps that wait for something to happen on screen move on by themselves.
  const poll = setInterval(() => {
    const s = steps[i];
    if (!s || !s.done) return;
    if (Date.now() - stepAt < (s.watch ? 3500 : 250)) return;
    if (s.done()) go(i + 1);
  }, 200);

  tip.addEventListener("click", (e) => {
    const a = e.target.closest("[data-tour]")?.dataset.tour;
    if (!a) return;
    if (a === "next") go(i + 1);
    if (a === "skip") end("skipped");
    if (a === "stay") end("done");
    if (a === "trial") end("trial");
  });
  const onKey = (e) => { if (e.key === "Escape") end("skipped"); };
  document.addEventListener("keydown", onKey);

  function end(how) {
    if (ended) return;
    ended = true;
    cancelAnimationFrame(raf);
    clearInterval(poll);
    clearTimeout(timer);
    document.removeEventListener("keydown", onKey);
    [...blocks, ring, tip, holeBlocker, style].forEach((n) => n.remove());
    onEvent?.(`tour_${how}`);
    onFinish?.(how);
  }

  go(0);
  place();
  return { end };
}
