// Shared UI pieces: icons, modal sheets, toasts, confirm.
import { esc } from "./util.js";

const PATHS = {
  back: '<path d="M15 18l-6-6 6-6"/>',
  chev: '<path d="M9 18l6-6-6-6"/>',
  close: '<path d="M18 6L6 18M6 6l12 12"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  flame: '<path d="M12 22c4 0 7-3 7-7 0-4-3-6-4-10-2 2-3 4-3 6-1-1-2-2-2-4-3 3-5 5-5 8 0 4 3 7 7 7z"/>',
  book: '<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20V3H6.5A2.5 2.5 0 0 0 4 5.5v14z"/><path d="M20 17v4H6.5A2.5 2.5 0 0 1 4 19.5"/>',
  shield: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 4-6 8-6s8 2 8 6"/>',
  chat: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
  share: '<circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><path d="M8.6 13.5l6.8 4M15.4 6.5l-6.8 4"/>',
  more: '<circle cx="12" cy="5" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="12" cy="19" r="1.5"/>',
  pin: '<path d="M12 22s7-7 7-12a7 7 0 0 0-14 0c0 5 7 12 7 12z"/><circle cx="12" cy="10" r="2.5"/>',
  radio: '<rect x="4" y="8" width="16" height="13" rx="2"/><path d="M8 8l8-5"/><circle cx="15" cy="14.5" r="2.5"/><path d="M7 13h3M7 16h3"/>',
  download: '<path d="M12 3v12M7 10l5 5 5-5M5 21h14"/>',
  copy: '<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/>',
  play: '<path d="M7 4l13 8-13 8z"/>',
  stop: '<rect x="6" y="6" width="12" height="12" rx="1"/>',
  check: '<path d="M5 12l5 5L20 7"/>',
  alert: '<path d="M12 3l10 18H2z"/><path d="M12 10v4M12 17.5v.5"/>',
  truck: '<path d="M1 7h12v9H1zM13 10h5l3 3v3h-8z"/><circle cx="5.5" cy="18" r="2"/><circle cx="17.5" cy="18" r="2"/>',
  log: '<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>',
  print: '<path d="M6 9V2h12v7M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><rect x="6" y="14" width="12" height="8"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  moon: '<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/>',
  wrench: '<path d="M14.7 6.3a4 4 0 0 0 5 5L21 13l-8 8-3-3 8-8z"/><path d="M14.7 6.3L3 18l3 3"/>',
};

export function icon(name, cls = "") {
  return `<svg class="icon ${cls}" viewBox="0 0 24 24" aria-hidden="true">${PATHS[name] || ""}</svg>`;
}

// ---------------- toast ----------------
let toastTimer;
export function toast(msg, bad = false) {
  document.querySelector(".toast")?.remove();
  const t = document.createElement("div");
  t.className = `toast${bad ? " bad" : ""}`;
  t.setAttribute("role", "status");
  t.textContent = msg;
  document.body.appendChild(t);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.remove(), bad ? 4500 : 2600);
}

// ---------------- modal sheet ----------------
// openSheet({ title, body, submit, submitLabel, danger, onSubmit(form), onOpen(el), wide })
// onSubmit may return false to keep the sheet open. Errors thrown are shown inline.
let openCount = 0;
export function openSheet(opts) {
  const overlay = document.createElement("div");
  overlay.className = "overlay";
  overlay.setAttribute("role", "dialog");
  overlay.setAttribute("aria-modal", "true");
  overlay.setAttribute("aria-label", opts.title || "Dialog");
  const hasForm = !!opts.onSubmit;
  overlay.innerHTML = `
    <${hasForm ? "form" : "div"} class="sheet" novalidate>
      <div class="sheet-head">
        <div class="h3">${esc(opts.title || "")}</div>
        <button type="button" class="iconbtn ghost" data-close aria-label="Close">${icon("close")}</button>
      </div>
      <div class="sheet-body">${opts.body || ""}<div class="error-text" data-err hidden></div></div>
      ${hasForm ? `<div class="sheet-foot">
        ${opts.secondary ? `<button type="button" class="btn ${opts.secondaryClass || ""}" data-secondary>${esc(opts.secondary)}</button>` : ""}
        <button type="submit" class="btn ${opts.danger ? "danger" : "primary"}">${esc(opts.submitLabel || "Save")}</button>
      </div>` : ""}
    </${hasForm ? "form" : "div"}>`;
  document.body.appendChild(overlay);
  openCount++;
  document.body.style.overflow = "hidden";

  const sheet = overlay.querySelector(".sheet");
  const errEl = overlay.querySelector("[data-err]");
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    overlay.remove();
    openCount = Math.max(0, openCount - 1);
    if (!openCount) document.body.style.overflow = "";
    document.removeEventListener("keydown", onKey);
    opts.onClose?.();
  };
  const onKey = (e) => { if (e.key === "Escape") close(); };
  document.addEventListener("keydown", onKey);
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay || e.target.closest("[data-close]")) close();
  });
  overlay.querySelector("[data-secondary]")?.addEventListener("click", () => opts.onSecondary?.(close));

  if (hasForm) {
    sheet.addEventListener("submit", async (e) => {
      e.preventDefault();
      const btn = sheet.querySelector('button[type="submit"]');
      errEl.hidden = true;
      btn.disabled = true;
      try {
        const keep = await opts.onSubmit(sheet, close);
        if (keep !== false) close();
      } catch (err) {
        errEl.textContent = opts.errorText ? opts.errorText(err) : (err?.message || "Something went wrong");
        errEl.hidden = false;
      } finally {
        btn.disabled = false;
      }
    });
  }
  opts.onOpen?.(sheet, close);
  const first = sheet.querySelector("input:not([type=hidden]):not([type=checkbox]), textarea");
  if (first && opts.autofocus !== false && window.matchMedia("(pointer: fine)").matches) first.focus();
  return { el: sheet, close };
}

export function confirmSheet({ title, message, confirmLabel = "Confirm", danger = false }) {
  return new Promise((resolve) => {
    let answered = false;
    openSheet({
      title,
      body: `<p>${esc(message)}</p>`,
      submitLabel: confirmLabel,
      danger,
      secondary: "Cancel",
      onSecondary: (close) => close(),
      onSubmit: () => { answered = true; resolve(true); },
      onClose: () => { if (!answered) resolve(false); },
    });
  });
}

export function field(label, inner, hint = "") {
  return `<label class="field"><span class="label">${esc(label)}</span>${inner}${hint ? `<span class="hint">${esc(hint)}</span>` : ""}</label>`;
}

export function input(name, value = "", attrs = "") {
  // A class="..." in attrs replaces the default instead of making a second class attribute.
  const cls = /\bclass="/.test(attrs) ? "" : 'class="input" ';
  return `<input ${cls}name="${name}" value="${esc(value)}" ${attrs}>`;
}

export function select(name, options, value, attrs = "") {
  return `<select class="select" name="${name}" ${attrs}>${options.map((o) => {
    const [v, l] = Array.isArray(o) ? o : [o, o];
    return `<option value="${esc(v)}"${String(v) === String(value ?? "") ? " selected" : ""}>${esc(l)}</option>`;
  }).join("")}</select>`;
}

export function textarea(name, value = "", attrs = "") {
  return `<textarea class="textarea" name="${name}" ${attrs}>${esc(value)}</textarea>`;
}
