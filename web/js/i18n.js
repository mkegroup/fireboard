// Languages. The app is written in English. Everything on screen is
// translated as it appears: every text node and the placeholder, aria-label
// and title of every element, using the dictionaries in i18n/.
//   * Exact phrases:  "Start incident" -> "Démarrer une intervention"
//   * Patterns:       "{n} days left in your free trial." with {n} kept as is
//   * Lists:          "Captain, Command" -> each part translated
// Anything the user typed (names, addresses, chat) is left alone unless it
// happens to match a phrase exactly. Mark containers with data-notr to skip them.
import FR from "./i18n/fr.js";
import ES from "./i18n/es.js";

export const LANGS = [
  ["en", "English"],
  ["fr", "Français"],
  ["es", "Español"],
];
const DICTS = { fr: FR, es: ES };
const LOCALES = { en: "en-CA", fr: "fr-CA", es: "es" };

function detect() {
  try {
    const saved = localStorage.getItem("fgb_lang");
    if (saved && LOCALES[saved]) return saved;
  } catch { /* private mode */ }
  const nav = (navigator.languages?.[0] || navigator.language || "en").slice(0, 2).toLowerCase();
  return LOCALES[nav] ? nav : "en";
}

let lang = typeof navigator === "undefined" ? "en" : detect();
export const getLang = () => lang;
export const getLocale = () => LOCALES[lang];

/** Saves the choice and reloads, so every screen redraws in the new language. */
export function setLang(l) {
  if (!LOCALES[l]) return;
  try { localStorage.setItem("fgb_lang", l); } catch { /* private mode */ }
  lang = l;
  location.reload();
}

// ---------------- lookup ----------------
// {n} {a} {b} {h} only ever stand for numbers, so "2 of 7" matches but "Bay of Quinte" doesn't.
const NUMERIC = new Set(["n", "a", "b", "h"]);
let exact = new Map();
let templates = new Map();
let patterns = [];

function build() {
  exact = new Map();
  templates = new Map();
  patterns = [];
  const d = DICTS[lang];
  if (!d) return;
  for (const [key, v] of Object.entries(d)) {
    const codeOnly = key.startsWith("@");
    const k = codeOnly ? key.slice(1) : key;
    if (k.includes("{")) {
      templates.set(k, v);
      if (codeOnly) continue;
      const names = [];
      const src = k.replace(/[.*+?^$()|[\]\\]/g, "\\$&").replace(/\{(\w+)\}/g, (_, n) => { names.push(n); return NUMERIC.has(n) ? "(\\d[\\d.,]*)" : "(.+?)"; });
      patterns.push({ re: new RegExp(`^${src}$`), names, out: v });
    } else {
      exact.set(k, v);
    }
  }
}
build();

/** Translates one English string, or a template like t("Join {dept}", { dept }). */
export function t(s, vars) {
  if (lang === "en" || !s) return vars ? fill(s, vars) : s;
  let out = templates.get(s) ?? exact.get(s);
  if (out === undefined) out = matchPattern(s);
  if (out === undefined) out = s;
  return vars ? fill(out, vars) : out;
}
const fill = (s, vars) => s.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? vars[k] : m));

function matchPattern(s) {
  for (const p of patterns) {
    const m = s.match(p.re);
    if (!m) continue;
    let out = p.out;
    p.names.forEach((n, i) => {
      const v = m[i + 1];
      out = out.replace(`{${n}}`, exact.get(v) ?? v);
    });
    return out;
  }
  return undefined;
}

/** Text the way it appears on screen: exact, pattern, then a comma list of known words. */
function translateText(s) {
  let out = exact.get(s);
  if (out !== undefined) return out;
  out = matchPattern(s);
  if (out !== undefined) return out;
  // "." on the end of a known phrase
  const end = s.match(/^(.+?)([.:!?])$/);
  if (end && exact.has(end[1])) return exact.get(end[1]) + end[2];
  // "Firefighter, Alpha, no app": translate each part that is known, keep the rest.
  if (s.includes(", ")) {
    // Parts left as is must look like names or codes ("Engine 1", "142 Mill St"), not English
    // words ("two vehicles"), or the line comes out half translated.
    let changed = false;
    let plainWords = false;
    const parts = s.split(", ").map((p) => {
      const o = exact.get(p) ?? matchPattern(p);
      if (o !== undefined) { changed = true; return o; }
      if (/(^|\s)[a-z]{3,}(\s|$)/.test(p)) plainWords = true;
      return p;
    });
    if (changed && !plainWords) return parts.join(", ");
  }
  return undefined;
}

// ---------------- live translation of the page ----------------
const ATTRS = ["placeholder", "aria-label", "title"];
const SKIP = new Set(["SCRIPT", "STYLE", "TEXTAREA", "CODE"]);
const done = new WeakSet();
export const missed = new Set(); // filled while collecting, for finding untranslated text
if (typeof window !== "undefined") window.__fgbMissed = missed;

function skip(el) {
  for (let e = el; e && e !== document.body; e = e.parentElement) {
    if (SKIP.has(e.tagName) || e.hasAttribute?.("data-notr") || e.classList?.contains("mono")) return true;
  }
  return false;
}

function doText(node) {
  if (done.has(node)) return;
  const raw = node.nodeValue;
  const s = raw.trim();
  if (!s || !/\p{L}/u.test(s) || skip(node.parentElement)) return;
  const out = translateText(s);
  if (out === undefined) { if (window.__fgbCollect) missed.add(s); return; }
  done.add(node);
  if (out !== s) node.nodeValue = raw.replace(s, out);
}

function doEl(el) {
  if (skip(el)) return;
  for (const a of ATTRS) {
    const v = el.getAttribute?.(a);
    if (!v || !/\p{L}/u.test(v)) continue;
    const out = translateText(v.trim());
    if (out !== undefined && out !== v) el.setAttribute(a, out);
    else if (out === undefined && window.__fgbCollect) missed.add(v.trim());
  }
}

function walk(root) {
  if (root.nodeType === 3) return doText(root);
  if (root.nodeType !== 1) return;
  doEl(root);
  const w = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
  let n;
  while ((n = w.nextNode())) n.nodeType === 3 ? doText(n) : doEl(n);
}

/** Starts translating everything that appears on the page. */
export function startTranslating() {
  document.documentElement.lang = lang;
  if (lang === "en" && !window.__fgbCollect) return;
  walk(document.body);
  new MutationObserver((list) => {
    for (const m of list) {
      if (m.type === "characterData") { done.delete(m.target); doText(m.target); }
      else if (m.type === "attributes") doEl(m.target);
      else m.addedNodes.forEach(walk);
    }
  }).observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ATTRS });
}

/** For collecting: switch translation off/on without reloading (tests only). */
export function _setLangForTests(l) { lang = l; build(); }
