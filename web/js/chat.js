// Chat: station chat for the whole department, and the chat on each incident.
// Text, photos, voice notes, shared locations, replies, reactions, @mentions,
// edits, unsend, pinned messages, read receipts and "typing".
//
// mountChat(el, { deptId, incidentId }) draws the chat into `el` and keeps it live.
// It returns { destroy() }.
import { S, isOfficer, hasAccess } from "./state.js";
import { esc, initials, colorFor, clock, dateLabel, copyText, friendlyError } from "./util.js";
import { icon, toast, openSheet, confirmSheet } from "./ui.js";
import { t } from "./i18n.js";

export const REACTIONS = ["👍", "❤️", "😂", "😮", "🔥", "✅"];
const MAX_VOICE = 120; // seconds
const GROUP_GAP = 5 * 60 * 1000;
const urlCache = new Map(); // storage path -> signed link

/** Where the "last seen" time for this chat is kept on this phone (also used for unread dots). */
export const seenKey = (deptId, incidentId) => (incidentId ? `fgb_chat_seen_${incidentId}` : `fgb_chat_seen_station_${deptId}`);
export function lastSeen(deptId, incidentId) {
  try { return Number(localStorage.getItem(seenKey(deptId, incidentId)) || 0); } catch { return 0; }
}
function setSeen(deptId, incidentId, ms) {
  try { if (ms > lastSeen(deptId, incidentId)) localStorage.setItem(seenKey(deptId, incidentId), String(ms)); } catch { /* private mode */ }
}

const mmss = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
const isApple = () => /iphone|ipad|ipod|macintosh/i.test(navigator.userAgent);
const mapsLink = (lat, lng) => (isApple() ? `https://maps.apple.com/?q=${lat},${lng}` : `https://www.google.com/maps/search/?api=1&query=${lat},${lng}`);

/** Shrinks a photo to at most 1600px on the long side, as a JPEG. */
async function shrinkPhoto(file) {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error("That photo couldn't be opened.")); i.src = url; });
    const scale = Math.min(1, 1600 / Math.max(img.naturalWidth, img.naturalHeight));
    const w = Math.max(1, Math.round(img.naturalWidth * scale));
    const h = Math.max(1, Math.round(img.naturalHeight * scale));
    const c = document.createElement("canvas");
    c.width = w; c.height = h;
    c.getContext("2d").drawImage(img, 0, 0, w, h);
    const blob = await new Promise((res) => c.toBlob(res, "image/jpeg", 0.82));
    if (!blob) throw new Error("That photo couldn't be opened.");
    return { blob, w, h };
  } finally { URL.revokeObjectURL(url); }
}

function recorderType() {
  if (typeof MediaRecorder === "undefined") return null;
  for (const m of ["audio/mp4", "audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus"]) {
    if (MediaRecorder.isTypeSupported?.(m)) return m;
  }
  return "";
}

export function mountChat(el, { deptId, incidentId = null }) {
  const thread = incidentId || "station";
  let msgs = [];
  let reactions = new Map(); // message id -> [{ emoji, user_id, name }]
  let reads = [];
  let members = [];
  let alive = true;
  let replyTo = null;
  let editing = null;
  let mentionPick = []; // [{ user_id, name }]
  let pending = []; // messages being sent, shown right away
  let typers = new Map(); // user_id -> { name, until }
  let newBelow = 0;
  let sub = null;
  let rec = null;
  let lastTypingSent = 0;
  let readTimer = null;
  const me = () => S.user?.id;
  const canWrite = () => hasAccess();

  el.innerHTML = `
    <div class="chat">
      <button class="chat-pin" type="button" hidden></button>
      <div class="chat-list" role="log" aria-label="Messages"><div class="spinner"></div></div>
      <button class="chat-jump" type="button" hidden>${icon("chev", "sm")}<span></span></button>
      <div class="chat-typing" aria-live="polite"></div>
      ${canWrite() ? `
      <div class="chat-compose">
        <div class="chat-reply" hidden></div>
        <ul class="chat-mention" role="listbox" hidden></ul>
        <div class="chat-attach" hidden>
          <button type="button" data-attach="photo">${icon("image")}<span>Photo</span></button>
          <button type="button" data-attach="camera">${icon("camera")}<span>Camera</span></button>
          <button type="button" data-attach="location">${icon("pin")}<span>Location</span></button>
        </div>
        <div class="chat-rec" hidden>
          <span class="rec-dot" aria-hidden="true"></span><span class="rec-time">0:00</span>
          <span class="rec-hint">Recording</span>
          <button type="button" class="btn sm quiet" data-rec="cancel">Cancel</button>
          <button type="button" class="btn sm primary" data-rec="send">${icon("send", "sm")} Send</button>
        </div>
        <form class="chat-bar" autocomplete="off">
          <button type="button" class="chat-btn" data-act-chat="attach" aria-label="Add a photo or location" aria-expanded="false">${icon("plus")}</button>
          <textarea name="body" rows="1" maxlength="2000" placeholder="Message" enterkeyhint="send" aria-label="Message"></textarea>
          <button type="button" class="chat-btn mic" data-act-chat="mic" aria-label="Record a voice note">${icon("mic")}</button>
          <button type="submit" class="chat-btn send" aria-label="Send" hidden>${icon("send")}</button>
        </form>
        <input type="file" accept="image/*" data-file hidden multiple>
        <input type="file" accept="image/*" capture="environment" data-cam hidden>
      </div>` : `<div class="chat-readonly">Chat is read only while the department's plan is paused.</div>`}
    </div>`;

  const list = el.querySelector(".chat-list");
  const form = el.querySelector(".chat-bar");
  const box = form?.querySelector("textarea");
  const sendBtn = form?.querySelector(".send");
  const micBtn = form?.querySelector(".mic");
  const replyBar = el.querySelector(".chat-reply");
  const mentionBox = el.querySelector(".chat-mention");
  const attachBox = el.querySelector(".chat-attach");
  const recBar = el.querySelector(".chat-rec");
  const jump = el.querySelector(".chat-jump");
  const pinBar = el.querySelector(".chat-pin");
  const typingEl = el.querySelector(".chat-typing");

  // ---------------- data ----------------
  const load = async () => {
    const r = await S.api.listChat(deptId, incidentId);
    if (!alive) return;
    msgs = r.messages;
    reactions = new Map();
    for (const x of r.reactions) (reactions.get(x.message_id) || reactions.set(x.message_id, []).get(x.message_id)).push(x);
    reads = r.reads;
    paint(true);
  };

  const upsertMsg = (m) => {
    const i = msgs.findIndex((x) => x.id === m.id);
    if (i >= 0) msgs[i] = { ...msgs[i], ...m };
    else { msgs.push(m); msgs.sort((a, b) => a.created_at.localeCompare(b.created_at)); }
  };

  const onLive = (kind, p) => {
    if (!alive) return;
    if (kind === "message") {
      if (p.eventType === "DELETE") msgs = msgs.filter((m) => m.id !== p.old?.id);
      else if (p.new) {
        const fresh = !msgs.some((m) => m.id === p.new.id);
        upsertMsg(p.new);
        pending = pending.filter((x) => x.saved_id !== p.new.id);
        typers.delete(p.new.user_id);
        if (fresh && p.new.user_id !== me() && !nearBottom()) newBelow++;
      }
      paint();
    } else if (kind === "reaction") {
      const r = p.new?.message_id ? p.new : p.old;
      if (!r?.message_id) return;
      const arr = (reactions.get(r.message_id) || []).filter((x) => !(x.user_id === r.user_id && x.emoji === r.emoji));
      if (p.eventType !== "DELETE") arr.push(p.new);
      reactions.set(r.message_id, arr);
      paint();
    } else if (kind === "read") {
      const r = p.new;
      if (!r || r.thread !== thread) return;
      reads = reads.filter((x) => x.user_id !== r.user_id).concat([r]);
      paintReceipt();
    } else if (kind === "typing") {
      if (!p?.user_id || p.user_id === me() || p.thread !== thread) return;
      typers.set(p.user_id, { name: p.name, until: Date.now() + 4500 });
      paintTyping();
    } else if (kind === "_status" && p === "SUBSCRIBED") {
      // Catch anything sent while the connection was down.
      load().catch(() => {});
    }
  };

  // ---------------- drawing ----------------
  const nearBottom = () => list.scrollHeight - list.scrollTop - list.clientHeight < 90;
  const memberName = (uid) => members.find((m) => m.user_id === uid)?.name;
  const firstName = (n) => String(n || "").split(/\s+/)[0];

  const linkify = (text) => {
    let h = esc(text).replace(/https?:\/\/[^\s<]+[^\s<.,;:!?)\]'"]/g, (u) => `<a href="${u}" target="_blank" rel="noopener noreferrer">${u}</a>`);
    const names = members.map((m) => m.name).filter(Boolean).sort((a, b) => b.length - a.length);
    if (names.length) {
      const re = new RegExp(`@(${names.map((n) => esc(n).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})`, "g");
      h = h.replace(re, (m0, n) => `<b class="mention${n === esc(S.me?.name) ? " me" : ""}">@${n}</b>`);
    }
    return h.replace(/\n/g, "<br>");
  };

  const quoteOf = (id) => {
    const q = msgs.find((m) => m.id === id);
    if (!q) return `<div class="quote-msg faint">${t("Original message not loaded")}</div>`;
    const what = q.deleted_at ? t("Message removed") : q.kind === "photo" ? `${t("Photo")}${q.body ? `: ${q.body}` : ""}` : q.kind === "voice" ? t("Voice note") : q.kind === "location" ? t("Location") : q.body;
    return `<button type="button" class="quote-msg" data-goto="${q.id}"><b>${esc(q.sender)}</b><span data-notr>${esc(what).slice(0, 140)}</span></button>`;
  };

  const reactRow = (m) => {
    const arr = reactions.get(m.id) || [];
    if (!arr.length) return "";
    const by = new Map();
    for (const r of arr) {
      const g = by.get(r.emoji) || { n: 0, mine: false, names: [] };
      g.n++; g.names.push(r.name || memberName(r.user_id) || ""); if (r.user_id === me()) g.mine = true;
      by.set(r.emoji, g);
    }
    return `<div class="reacts">${[...by.entries()].map(([e, g]) => `<button type="button" class="react ${g.mine ? "mine" : ""}" data-react="${esc(e)}" data-id="${m.id}" title="${esc(g.names.join(", "))}" aria-pressed="${g.mine}" aria-label="${esc(e)} ${g.n}">${esc(e)}<b>${g.n}</b></button>`).join("")}</div>`;
  };

  const content = (m) => {
    if (m.deleted_at) return `<div class="removed">${t("Message removed")}</div>`;
    let h = "";
    if (m.reply_to) h += quoteOf(m.reply_to);
    if (m.kind === "photo") {
      const ratio = m.media_w && m.media_h ? `aspect-ratio:${m.media_w}/${m.media_h}` : "aspect-ratio:4/3";
      const src = m._local || urlCache.get(m.media_path) || "";
      h += `<button type="button" class="chat-photo" data-view="${m.id}" style="${ratio}" aria-label="Open photo">${src ? `<img src="${esc(src)}" alt="">` : `<img data-path="${esc(m.media_path)}" alt="">`}</button>`;
    } else if (m.kind === "voice") {
      h += `<div class="chat-voice" data-path="${esc(m.media_path || "")}" data-id="${m.id}">
        <button type="button" class="vplay" data-play="${m.id}" aria-label="Play voice note">${icon("play", "sm")}</button>
        <div class="vbar"><i></i></div><span class="vlen">${mmss(Number(m.media_seconds) || 0)}</span></div>`;
    } else if (m.kind === "location") {
      h += `<a class="chat-loc" href="${mapsLink(m.lat, m.lng)}" target="_blank" rel="noopener noreferrer">${icon("pin")}<span><b>${t("Location")}</b><small>${Number(m.lat).toFixed(5)}, ${Number(m.lng).toFixed(5)}</small></span></a>`;
    }
    if (m.body) h += `<div class="text" data-notr>${linkify(m.body)}</div>`;
    return h;
  };

  const bubble = (m, prev) => {
    const mine = m.user_id === me();
    const grouped = prev && prev.user_id === m.user_id && !prev.deleted_at && new Date(m.created_at) - new Date(prev.created_at) < GROUP_GAP
      && new Date(m.created_at).toDateString() === new Date(prev.created_at).toDateString();
    const name = m.sender || memberName(m.user_id) || "";
    const meta = `${m.edited_at && !m.deleted_at ? `<span>${t("edited")}</span>` : ""}${m.pinned_at ? `<span class="pinned">${icon("pinned", "sm")}</span>` : ""}<time>${m._pending ? t(m._failed ? "Not sent" : "Sending") : clock(m.created_at)}</time>`;
    return `<div class="msg ${mine ? "mine" : ""} ${grouped ? "grouped" : ""} ${m._pending ? "pending" : ""} ${m._failed ? "failed" : ""}" data-id="${m.id}">
      ${mine ? "" : `<span class="msg-av" style="background:${colorFor(name)}" aria-hidden="true">${grouped ? "" : esc(initials(name))}</span>`}
      <div class="msg-col">
        ${mine || grouped ? "" : `<div class="msg-from">${esc(name)}</div>`}
        <div class="bubble ${m.kind !== "text" && !m.deleted_at ? `k-${m.kind}` : ""}">${content(m)}<div class="msg-meta">${meta}</div></div>
        ${reactRow(m)}
        ${m._failed ? `<button type="button" class="btn sm quiet" data-retry="${m.id}">${t("Tap to try again")}</button>` : ""}
      </div>
      ${m._pending || m.deleted_at ? "" : `<button type="button" class="msg-more" data-more="${m.id}" aria-label="Message options">${icon("more", "sm")}</button>`}
    </div>`;
  };

  const dayLabel = (ts) => {
    const d = new Date(ts);
    const today = new Date();
    const y = new Date(Date.now() - 86400000);
    if (d.toDateString() === today.toDateString()) return t("Today");
    if (d.toDateString() === y.toDateString()) return t("Yesterday");
    return dateLabel(ts);
  };

  function paint(toBottom = false) {
    const stick = toBottom || nearBottom();
    const all = msgs.concat(pending);
    if (!all.length) {
      list.innerHTML = `<div class="empty chat-empty">${icon("chat")}<p>${incidentId ? t("No messages yet. Use chat for things that don't need to go over the radio.") : t("Station chat for everyone in the department. Truck checks, training, call-outs, photos.")}</p></div>`;
    } else {
      let html = "";
      let prev = null;
      for (const m of all) {
        if (!prev || new Date(prev.created_at).toDateString() !== new Date(m.created_at).toDateString()) {
          html += `<div class="chat-day"><span>${dayLabel(m.created_at)}</span></div>`;
          prev = null;
        }
        html += bubble(m, prev);
        prev = m;
      }
      list.innerHTML = html + '<div class="chat-receipt" aria-live="polite"></div>';
    }
    paintReceipt();
    paintPin();
    fillMedia();
    if (stick) { list.scrollTop = list.scrollHeight; newBelow = 0; }
    if (playing) { const r = list.querySelector(`.chat-voice[data-id="${playing}"]`); if (r) { r.classList.add("on"); r.querySelector(".vplay").innerHTML = icon("pause", "sm"); } }
    paintJump();
    markRead();
  }

  function paintReceipt() {
    const slot = list.querySelector(".chat-receipt");
    if (!slot) return;
    const mineLast = [...msgs].reverse().find((m) => !m.deleted_at);
    if (!mineLast || mineLast.user_id !== me()) { slot.innerHTML = ""; return; }
    const seen = reads.filter((r) => r.user_id !== me() && r.read_at >= mineLast.created_at);
    if (!seen.length) { slot.innerHTML = ""; return; }
    const names = seen.map((r) => firstName(r.name));
    const label = names.length <= 3 ? t("Seen by {names}", { names: names.join(", ") }) : t("Seen by {n} people", { n: names.length });
    slot.innerHTML = `<button type="button" data-seen>${icon("check", "sm")}<span>${esc(label)}</span></button>`;
  }

  function paintPin() {
    const p = msgs.filter((m) => m.pinned_at && !m.deleted_at).sort((a, b) => b.pinned_at.localeCompare(a.pinned_at))[0];
    if (!p) { pinBar.hidden = true; return; }
    pinBar.hidden = false;
    pinBar.dataset.goto = p.id;
    const what = p.kind === "photo" ? t("Photo") : p.kind === "voice" ? t("Voice note") : p.kind === "location" ? t("Location") : p.body;
    pinBar.innerHTML = `${icon("pinned", "sm")}<span class="grow"><b>${t("Pinned")}</b><span data-notr>${esc(what).slice(0, 120)}</span></span>`;
  }

  function paintJump() {
    if (!jump) return;
    jump.hidden = nearBottom();
    jump.querySelector("span").textContent = newBelow ? t(newBelow === 1 ? "1 new message" : "{n} new messages", { n: newBelow }) : t("Latest");
  }

  function paintTyping() {
    const now = Date.now();
    for (const [k, v] of typers) if (v.until < now) typers.delete(k);
    const names = [...typers.values()].map((v) => firstName(v.name));
    typingEl.textContent = !names.length ? "" : names.length === 1 ? t("{name} is typing", { name: names[0] }) : t("{n} people are typing", { n: names.length });
  }
  const typingTimer = setInterval(paintTyping, 1500);

  async function fillMedia() {
    const imgs = [...list.querySelectorAll("img[data-path]")];
    const voices = [...list.querySelectorAll(".chat-voice[data-path]")];
    const need = [...new Set([...imgs.map((i) => i.dataset.path), ...voices.map((v) => v.dataset.path)])].filter((p) => p && !p.startsWith("blob:") && !urlCache.has(p));
    if (need.length) {
      try { const got = await S.api.chatFileUrls(need); for (const [k, v] of Object.entries(got)) urlCache.set(k, v); }
      catch (e) { console.warn("chat files", e); }
    }
    for (const i of imgs) {
      const u = i.dataset.path.startsWith("blob:") ? i.dataset.path : urlCache.get(i.dataset.path);
      if (u && i.isConnected) { i.src = u; i.removeAttribute("data-path"); }
    }
  }

  const markRead = () => {
    clearTimeout(readTimer);
    readTimer = setTimeout(() => {
      if (!alive || document.hidden || !nearBottom() || !el.isConnected) return;
      const last = msgs[msgs.length - 1];
      if (!last) return;
      const ms = new Date(last.created_at).getTime();
      const was = lastSeen(deptId, incidentId);
      setSeen(deptId, incidentId, ms);
      window.dispatchEvent(new CustomEvent("fgb:chat-seen", { detail: { thread } }));
      const mineRead = reads.find((r) => r.user_id === me());
      if (ms > was || !mineRead || mineRead.read_at < last.created_at) S.api.markChatRead(deptId, incidentId).catch(() => {});
    }, 900);
  };

  // ---------------- sending ----------------
  const tempId = () => `tmp-${Math.random().toString(36).slice(2)}`;
  const mentionsIn = (body) => [...new Set(mentionPick.filter((p) => body.includes(`@${p.name}`)).map((p) => p.user_id))];

  async function send(msg, file) {
    const temp = { id: tempId(), user_id: me(), sender: S.me?.name, created_at: new Date().toISOString(), kind: msg.kind || "text", body: msg.body || "", _pending: true, reply_to: msg.reply_to || null, ...msg };
    pending.push(temp);
    paint(true);
    try {
      if (file) {
        temp.media_path = await S.api.uploadChatFile(deptId, file.blob, file.ext);
      }
      const saved = await S.api.sendChat(deptId, incidentId, { ...msg, media_path: temp.media_path });
      temp.saved_id = saved.id;
      upsertMsg(saved);
      if (temp._local && saved.media_path) urlCache.set(saved.media_path, temp._local);
      pending = pending.filter((x) => x !== temp);
      paint(true);
    } catch (e) {
      temp._failed = true;
      temp._retry = () => { pending = pending.filter((x) => x !== temp); send(msg, file); };
      paint();
      toast(friendlyError(e), true);
    }
  }

  const setReply = (m) => {
    replyTo = m;
    editing = null;
    if (!replyBar) return;
    if (!m) { replyBar.hidden = true; replyBar.innerHTML = ""; return; }
    const what = m.kind === "photo" ? t("Photo") : m.kind === "voice" ? t("Voice note") : m.kind === "location" ? t("Location") : m.body;
    replyBar.hidden = false;
    replyBar.innerHTML = `${icon("reply", "sm")}<span class="grow"><b>${t("Replying to {name}", { name: esc(m.sender || "") })}</b><span data-notr>${esc(what).slice(0, 100)}</span></span><button type="button" class="iconbtn ghost" data-cancel-reply aria-label="Cancel reply">${icon("close", "sm")}</button>`;
    box?.focus();
  };

  const setEditing = (m) => {
    editing = m;
    replyTo = null;
    if (!replyBar) return;
    replyBar.hidden = false;
    replyBar.innerHTML = `${icon("edit", "sm")}<span class="grow"><b>${t("Editing message")}</b></span><button type="button" class="iconbtn ghost" data-cancel-reply aria-label="Cancel editing">${icon("close", "sm")}</button>`;
    box.value = m.body;
    grow();
    box.focus();
  };

  const grow = () => {
    if (!box) return;
    box.style.height = "auto";
    box.style.height = `${Math.min(box.scrollHeight, 140)}px`;
    const has = !!box.value.trim();
    sendBtn.hidden = !has && !editing;
    micBtn.hidden = has || !!editing;
  };

  async function submit() {
    const body = box.value.trim();
    if (!body) return;
    if (editing) {
      const m = editing;
      box.value = ""; setReply(null); grow();
      try { await S.api.editChat(m.id, body); upsertMsg({ ...m, body, edited_at: new Date().toISOString() }); paint(); }
      catch (e) { toast(friendlyError(e), true); }
      return;
    }
    const reply = replyTo?.id || null;
    const mentions = mentionsIn(body);
    box.value = ""; setReply(null); grow(); closeMention();
    mentionPick = [];
    send({ kind: "text", body, reply_to: reply, mentions });
  }

  // ---------------- @mentions ----------------
  let mentionList = [];
  let mentionAt = -1;
  const closeMention = () => { if (mentionBox) { mentionBox.hidden = true; mentionBox.innerHTML = ""; } mentionList = []; };
  const checkMention = () => {
    const upto = box.value.slice(0, box.selectionStart);
    const m = upto.match(/(^|\s)@([\p{L}\p{N}'-]*)$/u);
    if (!m) return closeMention();
    mentionAt = upto.length - m[2].length - 1;
    const q = m[2].toLowerCase();
    mentionList = members.filter((x) => x.user_id && x.user_id !== me() && x.name.toLowerCase().split(/\s+/).some((w) => w.startsWith(q))).slice(0, 6);
    if (!mentionList.length) return closeMention();
    mentionBox.hidden = false;
    mentionBox.innerHTML = mentionList.map((x, i) => `<li role="option" data-mi="${i}"><span class="msg-av" style="background:${colorFor(x.name)}">${esc(initials(x.name))}</span><b>${esc(x.name)}</b><small>${esc(x.rank || "")}</small></li>`).join("");
  };
  const pickMention = (i) => {
    const x = mentionList[i];
    if (!x) return;
    const caret = box.selectionStart;
    box.value = `${box.value.slice(0, mentionAt)}@${x.name} ${box.value.slice(caret)}`;
    const pos = mentionAt + x.name.length + 2;
    box.setSelectionRange(pos, pos);
    mentionPick.push({ user_id: x.user_id, name: x.name });
    closeMention();
    grow();
    box.focus();
  };

  // ---------------- photos, location, voice ----------------
  async function sendPhotos(files) {
    for (const f of [...files].slice(0, 6)) {
      if (!/^image\//.test(f.type)) { toast(t("Only photos can be sent."), true); continue; }
      try {
        const { blob, w, h } = await shrinkPhoto(f);
        const local = URL.createObjectURL(blob);
        const reply = replyTo?.id || null;
        setReply(null);
        send({ kind: "photo", body: "", media_w: w, media_h: h, reply_to: reply, _local: local }, { blob, ext: "jpg" });
      } catch (e) { toast(friendlyError(e), true); }
    }
  }

  function shareLocation() {
    if (!navigator.geolocation) return toast(t("Location isn't available on this device."), true);
    toast(t("Finding your location..."));
    navigator.geolocation.getCurrentPosition(
      (p) => send({ kind: "location", lat: Math.round(p.coords.latitude * 1e6) / 1e6, lng: Math.round(p.coords.longitude * 1e6) / 1e6, reply_to: replyTo?.id || null }),
      (e) => toast(e.code === 1 ? t("Location permission is off. Turn it on in your phone's settings.") : t("Couldn't get your location."), true),
      { enableHighAccuracy: true, maximumAge: 15000, timeout: 20000 },
    );
    setReply(null);
  }

  async function startRecording() {
    const type = recorderType();
    if (type === null || !navigator.mediaDevices?.getUserMedia) return toast(t("Voice notes need a newer browser."), true);
    let stream;
    try { stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } }); }
    catch { return toast(t("Microphone permission is off. Turn it on in your phone's settings."), true); }
    const mr = type ? new MediaRecorder(stream, { mimeType: type, audioBitsPerSecond: 48000 }) : new MediaRecorder(stream);
    const chunks = [];
    const started = Date.now();
    rec = { mr, stream, started, cancel: false, timer: null };
    mr.ondataavailable = (e) => { if (e.data?.size) chunks.push(e.data); };
    mr.onstop = () => {
      stream.getTracks().forEach((tr) => tr.stop());
      clearInterval(rec?.timer);
      const r = rec;
      rec = null;
      recBar.hidden = true;
      form.hidden = false;
      if (!r || r.cancel) return;
      const secs = Math.min(MAX_VOICE, (Date.now() - started) / 1000);
      if (secs < 0.8) return toast(t("Hold on a little longer to record."), true);
      const base = (mr.mimeType || type || "audio/mp4").split(";")[0];
      const blob = new Blob(chunks, { type: base });
      const ext = base.includes("webm") ? "webm" : base.includes("ogg") ? "ogg" : "m4a";
      const local = URL.createObjectURL(blob);
      const reply = replyTo?.id || null;
      setReply(null);
      send({ kind: "voice", media_seconds: Math.round(secs * 10) / 10, reply_to: reply, _local: local }, { blob, ext });
    };
    mr.start(250);
    form.hidden = true;
    recBar.hidden = false;
    const timeEl = recBar.querySelector(".rec-time");
    rec.timer = setInterval(() => {
      const s = (Date.now() - started) / 1000;
      timeEl.textContent = mmss(s);
      if (s >= MAX_VOICE) stopRecording(false);
    }, 250);
  }
  function stopRecording(cancel) {
    if (!rec) return;
    rec.cancel = cancel;
    try { rec.mr.stop(); } catch { /* already stopped */ }
  }

  // ---------------- voice playback ----------------
  let player = null;
  let playing = null;
  async function togglePlay(id) {
    const m = msgs.concat(pending).find((x) => x.id === id);
    if (!m) return;
    if (playing === id && player) { player.pause(); return; }
    player?.pause();
    let src = m._local || urlCache.get(m.media_path);
    if (!src && m.media_path) {
      try { const got = await S.api.chatFileUrls([m.media_path]); src = got[m.media_path]; if (src) urlCache.set(m.media_path, src); }
      catch (e) { return toast(friendlyError(e), true); }
    }
    if (!src) return toast(t("That voice note couldn't be loaded."), true);
    player = new Audio(src);
    playing = id;
    const row = () => list.querySelector(`.chat-voice[data-id="${id}"]`);
    const setUi = (on) => { const r = row(); if (!r) return; r.classList.toggle("on", on); r.querySelector(".vplay").innerHTML = icon(on ? "pause" : "play", "sm"); };
    player.ontimeupdate = () => {
      const r = row();
      const d = Number(m.media_seconds) || player.duration || 1;
      if (r) { r.querySelector(".vbar i").style.width = `${Math.min(100, (player.currentTime / d) * 100)}%`; r.querySelector(".vlen").textContent = mmss(player.currentTime); }
    };
    player.onpause = () => setUi(false);
    player.onplay = () => setUi(true);
    player.onended = () => { setUi(false); const r = row(); if (r) { r.querySelector(".vbar i").style.width = "0"; r.querySelector(".vlen").textContent = mmss(Number(m.media_seconds) || 0); } playing = null; };
    player.play().catch(() => toast(t("That voice note couldn't be played."), true));
  }

  // ---------------- message options ----------------
  function optionsFor(m) {
    const mine = m.user_id === me();
    const officer = isOfficer();
    const items = [];
    if (canWrite()) items.push(["reply", "reply", "Reply"]);
    if (m.body) items.push(["copy", "copy", "Copy text"]);
    if (mine && m.kind === "text" && canWrite()) items.push(["edit", "edit", "Edit"]);
    if (m.kind === "photo") items.push(["open", "image", "Open photo"]);
    if (officer && canWrite()) items.push(["pin", "pinned", m.pinned_at ? "Unpin" : "Pin for everyone"]);
    if (mine || officer) items.push(["delete", "trash", mine ? "Unsend" : "Remove message"]);
    const mineReacts = new Set((reactions.get(m.id) || []).filter((r) => r.user_id === me()).map((r) => r.emoji));
    const { el: sheet, close } = openSheet({
      title: t("Message"),
      body: `${canWrite() ? `<div class="react-pick" role="group" aria-label="React">${REACTIONS.map((e) => `<button type="button" class="${mineReacts.has(e) ? "on" : ""}" data-pick="${e}" aria-pressed="${mineReacts.has(e)}">${e}</button>`).join("")}</div>` : ""}
        <div class="list">${items.map(([k, ic, label]) => `<button type="button" class="row ${k === "delete" ? "c-bad" : ""}" data-opt="${k}">${icon(ic)}<span class="grow title" style="font-size:17px">${t(label)}</span></button>`).join("")}</div>
        ${m.created_at ? `<p class="faint small" style="margin-top:12px">${esc(m.sender || "")}, ${dateLabel(m.created_at)} ${clock(m.created_at)}${m.edited_at ? `, ${t("edited")}` : ""}${m.pinned_by ? `. ${t("Pinned by {name}", { name: esc(m.pinned_by) })}` : ""}</p>` : ""}`,
    });
    sheet.addEventListener("click", async (e) => {
      const pick = e.target.closest("[data-pick]");
      if (pick) { close(); return toggleReact(m.id, pick.dataset.pick); }
      const o = e.target.closest("[data-opt]")?.dataset.opt;
      if (!o) return;
      close();
      if (o === "reply") setReply(m);
      else if (o === "copy") { if (await copyText(m.body)) toast(t("Copied.")); }
      else if (o === "edit") setEditing(m);
      else if (o === "open") viewPhoto(m);
      else if (o === "pin") {
        try { await S.api.pinChat(m.id, !m.pinned_at); upsertMsg({ ...m, pinned_at: m.pinned_at ? null : new Date().toISOString(), pinned_by: m.pinned_at ? null : S.me?.name }); paint(); toast(t(m.pinned_at ? "Unpinned." : "Pinned for everyone.")); }
        catch (ex) { toast(friendlyError(ex), true); }
      } else if (o === "delete") {
        const ok = await confirmSheet({ title: t(mine ? "Unsend this message?" : "Remove this message?"), message: t("It's removed for everyone in this chat."), confirmLabel: t(mine ? "Unsend" : "Remove"), danger: true });
        if (!ok) return;
        try { await S.api.deleteChat(m.id); upsertMsg({ ...m, deleted_at: new Date().toISOString(), body: "", media_path: null }); reactions.delete(m.id); paint(); }
        catch (ex) { toast(friendlyError(ex), true); }
      }
    });
  }

  async function toggleReact(id, emoji) {
    if (!canWrite()) return;
    const arr = reactions.get(id) || [];
    const on = !arr.some((r) => r.user_id === me() && r.emoji === emoji);
    // Show it right away, undo if it fails.
    const before = arr.slice();
    reactions.set(id, on ? arr.concat([{ message_id: id, user_id: me(), emoji, name: S.me?.name }]) : arr.filter((r) => !(r.user_id === me() && r.emoji === emoji)));
    paint();
    try { await S.api.react(id, emoji, on); }
    catch (e) { reactions.set(id, before); paint(); toast(friendlyError(e), true); }
  }

  function viewPhoto(m) {
    const src = m._local || urlCache.get(m.media_path);
    if (!src) return;
    const v = document.createElement("div");
    v.className = "photo-view";
    v.setAttribute("role", "dialog");
    v.setAttribute("aria-label", t("Photo"));
    v.innerHTML = `<img src="${esc(src)}" alt=""><div class="photo-view-bar"><span>${esc(m.sender || "")}, ${clock(m.created_at)}</span><a class="btn sm" href="${esc(src)}" target="_blank" rel="noopener">${t("Open")}</a><button type="button" class="iconbtn" aria-label="Close">${icon("close")}</button></div>`;
    const close = () => { v.remove(); document.removeEventListener("keydown", onKey); };
    const onKey = (e) => { if (e.key === "Escape") close(); };
    v.addEventListener("click", (e) => { if (!e.target.closest("a")) close(); });
    document.addEventListener("keydown", onKey);
    document.body.appendChild(v);
  }

  function showSeen() {
    const mineLast = [...msgs].reverse().find((m) => !m.deleted_at);
    const seen = reads.filter((r) => r.user_id !== me() && mineLast && r.read_at >= mineLast.created_at);
    openSheet({ title: t("Seen by"), body: `<div class="list">${seen.map((r) => `<div class="row"><span class="msg-av" style="background:${colorFor(r.name)}">${esc(initials(r.name))}</span><span class="grow title" style="font-size:17px">${esc(r.name)}</span><span class="faint small">${clock(r.read_at)}</span></div>`).join("")}</div>` });
  }

  function goTo(id) {
    const n = list.querySelector(`.msg[data-id="${id}"]`);
    if (!n) return;
    n.scrollIntoView({ block: "center", behavior: "smooth" });
    n.classList.add("flash");
    setTimeout(() => n.classList.remove("flash"), 1600);
  }

  // ---------------- events ----------------
  let pressTimer = null;
  let pressed = false;
  list.addEventListener("pointerdown", (e) => {
    const n = e.target.closest(".msg[data-id]");
    if (!n || e.pointerType === "mouse" || e.target.closest("a, .vplay, .react, .quote-msg")) return;
    pressed = false;
    pressTimer = setTimeout(() => {
      const m = msgs.find((x) => x.id === n.dataset.id);
      if (m && !m.deleted_at) { pressed = true; navigator.vibrate?.(15); optionsFor(m); }
    }, 450);
  });
  const cancelPress = () => clearTimeout(pressTimer);
  list.addEventListener("pointerup", cancelPress);
  list.addEventListener("pointercancel", cancelPress);
  list.addEventListener("pointermove", (e) => { if (Math.abs(e.movementY) > 4 || Math.abs(e.movementX) > 4) cancelPress(); });
  list.addEventListener("contextmenu", (e) => {
    const n = e.target.closest(".msg[data-id]");
    if (!n || e.target.closest("a")) return;
    const m = msgs.find((x) => x.id === n.dataset.id);
    if (!m || m.deleted_at) return;
    e.preventDefault();
    optionsFor(m);
  });
  list.addEventListener("click", (e) => {
    if (pressed) { pressed = false; e.preventDefault(); return; }
    const more = e.target.closest("[data-more]");
    if (more) { const m = msgs.find((x) => x.id === more.dataset.more); if (m) optionsFor(m); return; }
    const r = e.target.closest("[data-react]");
    if (r) return toggleReact(r.dataset.id, r.dataset.react);
    const p = e.target.closest("[data-play]");
    if (p) return togglePlay(p.dataset.play);
    const v = e.target.closest("[data-view]");
    if (v) { const m = msgs.concat(pending).find((x) => x.id === v.dataset.view); if (m) viewPhoto(m); return; }
    const g = e.target.closest("[data-goto]");
    if (g) return goTo(g.dataset.goto);
    const rt = e.target.closest("[data-retry]");
    if (rt) { pending.find((x) => x.id === rt.dataset.retry)?._retry?.(); return; }
    if (e.target.closest("[data-seen]")) showSeen();
  });
  list.addEventListener("dblclick", (e) => {
    const n = e.target.closest(".msg[data-id]");
    if (n && !e.target.closest("a, button") && !n.classList.contains("pending")) toggleReact(n.dataset.id, "👍");
  });
  list.addEventListener("scroll", () => { if (nearBottom()) { newBelow = 0; markRead(); } paintJump(); }, { passive: true });
  jump?.addEventListener("click", () => { list.scrollTo({ top: list.scrollHeight, behavior: "smooth" }); newBelow = 0; });
  pinBar.addEventListener("click", () => goTo(pinBar.dataset.goto));
  const onVis = () => { if (!document.hidden) markRead(); };
  document.addEventListener("visibilitychange", onVis);

  if (form) {
    form.addEventListener("submit", (e) => { e.preventDefault(); submit(); });
    box.addEventListener("input", () => {
      grow();
      checkMention();
      if (Date.now() - lastTypingSent > 2500 && box.value.trim()) {
        lastTypingSent = Date.now();
        sub?.typing({ user_id: me(), name: S.me?.name, thread });
      }
    });
    box.addEventListener("keydown", (e) => {
      if (!mentionBox.hidden && (e.key === "Enter" || e.key === "Tab") && mentionList.length) { e.preventDefault(); return pickMention(0); }
      if (e.key === "Escape") { closeMention(); if (replyTo || editing) { setReply(null); box.value = editing ? "" : box.value; grow(); } }
      // Enter sends on a keyboard. On a phone the return key adds a line.
      if (e.key === "Enter" && !e.shiftKey && window.matchMedia("(pointer: fine)").matches) { e.preventDefault(); submit(); }
    });
    box.addEventListener("click", checkMention);
    mentionBox.addEventListener("mousedown", (e) => { const li = e.target.closest("[data-mi]"); if (li) { e.preventDefault(); pickMention(Number(li.dataset.mi)); } });
    replyBar.addEventListener("click", (e) => { if (e.target.closest("[data-cancel-reply]")) { const wasEdit = !!editing; setReply(null); if (wasEdit) { box.value = ""; } grow(); } });
    const attachBtn = form.querySelector('[data-act-chat="attach"]');
    attachBtn.addEventListener("click", () => {
      attachBox.hidden = !attachBox.hidden;
      attachBtn.setAttribute("aria-expanded", String(!attachBox.hidden));
      attachBtn.classList.toggle("on", !attachBox.hidden);
    });
    attachBox.addEventListener("click", (e) => {
      const a = e.target.closest("[data-attach]")?.dataset.attach;
      if (!a) return;
      attachBox.hidden = true;
      attachBtn.classList.remove("on");
      attachBtn.setAttribute("aria-expanded", "false");
      if (a === "photo") el.querySelector("[data-file]").click();
      else if (a === "camera") el.querySelector("[data-cam]").click();
      else shareLocation();
    });
    for (const inp of el.querySelectorAll("[data-file], [data-cam]")) {
      inp.addEventListener("change", () => { if (inp.files?.length) sendPhotos(inp.files); inp.value = ""; });
    }
    micBtn.addEventListener("click", startRecording);
    recBar.addEventListener("click", (e) => {
      const r = e.target.closest("[data-rec]")?.dataset.rec;
      if (r) stopRecording(r === "cancel");
    });
    // Paste a photo straight in.
    box.addEventListener("paste", (e) => {
      const files = [...(e.clipboardData?.files || [])].filter((f) => /^image\//.test(f.type));
      if (files.length) { e.preventDefault(); sendPhotos(files); }
    });
    grow();
  }

  // ---------------- start ----------------
  S.api.listMembers(deptId).then((m) => { members = m; if (msgs.length) paint(); }).catch(() => {});
  load().catch((e) => { list.innerHTML = `<div class="empty"><p>${esc(friendlyError(e))}</p></div>`; });
  sub = S.api.subscribeChat(deptId, incidentId, onLive);

  return {
    destroy() {
      alive = false;
      clearInterval(typingTimer);
      clearTimeout(readTimer);
      document.removeEventListener("visibilitychange", onVis);
      stopRecording(true);
      player?.pause();
      sub?.off();
      el.innerHTML = "";
    },
    focus() { box?.focus(); },
  };
}
