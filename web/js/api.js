// Live data layer on Supabase. demo.js implements the same methods in memory.
import { CONFIG } from "./config.js";

const DEPT_COLS =
  "id, name, created_at, invite_code, scanner_url, scanner_label, settings, trial_ends_at, subscription_status, current_period_end, past_due_since, seat_count, plan_interval, plan_invoice, plan_cancel_at, plan_amount, plan_custom, seats_paid, seats_billed, join_approval";
const MEMBER_COLS =
  "id, dept_id, user_id, role, active, name, rank, call_sign, crew, phone, radio, years, certifications, notes, ec_name, ec_rel, ec_phone, chat_alerts, created_at";

function must({ data, error }) {
  if (error) throw error;
  return data;
}

/** For updates/deletes: RLS hides rows you can't touch, so 0 rows means "not allowed". */
function mustRows(res, msg = "You don't have permission to change that.") {
  const rows = must(res);
  if (Array.isArray(rows) && !rows.length) throw new Error(msg);
  return rows;
}

export function createApi() {
  const sb = window.supabase.createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_ANON_KEY, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, flowType: "pkce" },
    realtime: { params: { eventsPerSecond: 20 } },
  });

  let beforeSignOut = null;
  const api = {
    isDemo: false,
    client: sb,

    // ---------------- auth ----------------
    async getSession() {
      const { data } = await sb.auth.getSession();
      return data.session;
    },
    onAuth(cb) {
      return sb.auth.onAuthStateChange((event, session) => cb(event, session));
    },
    /** Passwordless sign-in: emails a one-time code. New emails get an account automatically. */
    async sendCode(email) {
      return must(await sb.auth.signInWithOtp({ email, options: { shouldCreateUser: true, emailRedirectTo: CONFIG.APP_URL } }));
    },
    async verifyCode(email, token) {
      return must(await sb.auth.verifyOtp({ email, token, type: "email" }));
    },
    /** Password sign-in, kept for App Store review and test accounts. */
    async signIn(email, password) {
      return must(await sb.auth.signInWithPassword({ email, password }));
    },
    async signUp(email, password) {
      return must(await sb.auth.signUp({ email, password, options: { emailRedirectTo: CONFIG.APP_URL } }));
    },
    async updatePassword(password) {
      return must(await sb.auth.updateUser({ password }));
    },
    async signOut(everywhere = false) {
      try { await beforeSignOut?.(); } catch { /* sign out anyway */ }
      await sb.auth.signOut(everywhere ? { scope: "global" } : undefined);
    },
    /** Runs right before signing out, while still signed in (used to stop push alerts). */
    setBeforeSignOut(fn) { beforeSignOut = fn; },
    // iPhone alerts: the phone's Apple token, saved for the signed-in person.
    async registerPushDevice(token) {
      must(await sb.rpc("register_push_device", { p_token: token }));
    },
    async unregisterPushDevice(token) {
      await sb.rpc("unregister_push_device", { p_token: token });
    },
    /** Call alerts in this browser (Android, computers). sub is PushSubscription.toJSON(). */
    async registerWebPush(sub) {
      const device = (navigator.userAgentData?.platform || navigator.platform || "").slice(0, 60);
      must(await sb.rpc("register_web_push", { p_endpoint: sub.endpoint, p_p256dh: sub.keys?.p256dh, p_auth: sub.keys?.auth, p_device: device || null }));
    },
    async unregisterWebPush(endpoint) {
      await sb.rpc("unregister_web_push", { p_endpoint: endpoint });
    },
    async deleteAccount() {
      const { data, error } = await sb.functions.invoke("delete-account", { body: {} });
      if (error) throw new Error(await fnError(error));
      return data;
    },

    // ---------------- departments ----------------
    async myDepartments(userId) {
      const rows = must(await sb.from("members")
        .select(`${MEMBER_COLS}, departments(${DEPT_COLS})`)
        .eq("user_id", userId).eq("active", true));
      return rows.map((r) => {
        const { departments, ...member } = r;
        return { dept: departments, member };
      }).filter((x) => x.dept);
    },
    async getDepartment(id) {
      return must(await sb.from("departments").select(DEPT_COLS).eq("id", id).single());
    },
    async createDepartment(name, memberName, rank) {
      const id = must(await sb.rpc("create_department", { p_name: name, p_member_name: memberName, p_rank: rank }));
      api.sweepAlerts(); // sends the welcome email to the new owner
      return id;
    },
    async invitePreview(code) {
      return must(await sb.rpc("invite_preview", { p_code: code }));
    },
    async joinDepartment(code, memberName, rank, crew) {
      const id = must(await sb.rpc("join_department", { p_code: code, p_member_name: memberName, p_rank: rank || "Firefighter", p_crew: crew || null }));
      if (!id) throw new Error("invalid invite code");
      api.syncSeats(id).catch(() => {});
      return id;
    },
    // ---------------- join approval ----------------
    async setJoinApproval(deptId, on) { must(await sb.rpc("set_join_approval", { p_dept: deptId, p_on: !!on })); },
    async listJoinRequests(deptId) { return must(await sb.rpc("list_join_requests", { p_dept: deptId })) || []; },
    async approveJoin(memberId, deptId) {
      must(await sb.rpc("approve_join", { p_member: memberId }));
      api.billing("sync-seats", deptId, { member_id: memberId }).catch(() => {});
    },
    async declineJoin(memberId) { must(await sb.rpc("decline_join", { p_member: memberId })); },
    async myJoinRequests() { return must(await sb.rpc("my_join_requests")) || []; },
    async cancelJoinRequest(deptId) { must(await sb.rpc("cancel_join_request", { p_dept: deptId })); },
    async leaveDepartment(deptId) {
      must(await sb.rpc("leave_department", { p_dept: deptId }));
      api.syncSeats(deptId).catch(() => {});
    },
    async updateDepartment(id, patch) {
      mustRows(await sb.from("departments").update(patch).eq("id", id).select("id"));
    },
    async regenerateInvite(deptId) {
      return must(await sb.rpc("regenerate_invite_code", { p_dept: deptId }));
    },
    async getDispatchToken(deptId) {
      return must(await sb.rpc("get_dispatch_token", { p_dept: deptId }));
    },
    async regenerateDispatchToken(deptId) {
      return must(await sb.rpc("regenerate_dispatch_token", { p_dept: deptId }));
    },
    // ---------------- connections (owner only) ----------------
    async getIntegrations(deptId) {
      return must(await sb.rpc("get_integrations", { p_dept: deptId }));
    },
    async setIntegrations(deptId, { chat_webhook_url, chat_events, inbox_allow_from }) {
      must(await sb.rpc("set_integrations", { p_dept: deptId, p_chat_webhook_url: chat_webhook_url || null, p_chat_events: chat_events || null, p_inbox_allow_from: inbox_allow_from || null }));
    },
    async regenerateIntegration(deptId, what) {
      return must(await sb.rpc("regenerate_integration", { p_dept: deptId, p_what: what }));
    },
    async listDispatchInbox(deptId) {
      return must(await sb.from("dispatch_inbox").select("*").eq("dept_id", deptId).order("at", { ascending: false }).limit(20));
    },
    async testChat(deptId) {
      const { data, error } = await sb.functions.invoke("notify", { body: { kind: "test-chat", dept_id: deptId } });
      if (error) throw new Error(await fnError(error));
      if (!data?.chat) throw new Error("The chat didn't accept the message. Check the link and try again.");
      return data;
    },
    calendarUrl(token) {
      return `${CONFIG.SUPABASE_URL.replace(/\/$/, "")}/functions/v1/calendar?token=${token}`;
    },
    /** Saves the language this person reads the app in, so push alerts match. */
    async setLanguage(userId, lang) {
      await sb.from("members").update({ lang }).eq("user_id", userId);
    },
    /** Chat alerts on this person's iPhone, for one department. */
    async setChatAlerts(memberId, on) {
      mustRows(await sb.from("members").update({ chat_alerts: !!on }).eq("id", memberId).select("id"));
    },

    // ---------------- owner's console (MKE Group only) ----------------
    async isPlatformAdmin() {
      const { data, error } = await sb.rpc("is_platform_admin");
      return !error && data === true;
    },
    async adminOverview() { return must(await sb.rpc("admin_overview")); },
    async adminDepartments(search) { return must(await sb.rpc("admin_departments", { p_search: search || null })); },
    async adminDepartment(id) { return must(await sb.rpc("admin_department", { p_id: id })); },
    async adminEvents(before, kind) { return must(await sb.rpc("admin_events", { p_before: before || null, p_kind: kind || null })); },
    async adminUsers(search) { return must(await sb.rpc("admin_users", { p_search: search || null })); },
    async adminExtendTrial(deptId, days) { return must(await sb.rpc("admin_extend_trial", { p_dept: deptId, p_days: days })); },
    async adminSettings() { return must(await sb.rpc("admin_settings")); },
    async adminSetAlerts(alerts) { must(await sb.rpc("admin_set_alerts", { p_alerts: alerts })); },
    async adminTestAlert() { must(await sb.rpc("admin_test_alert")); await api.sweepAlerts(); },
    /** Sends any waiting owner's-console alerts. Never throws. */
    sweepAlerts() {
      return sb.functions.invoke("notify", { body: { kind: "sweep" } }).then((r) => r.data).catch(() => null);
    },
    async requestQuote(deptId, details) {
      must(await sb.rpc("request_quote", { p_dept: deptId, p_details: details }));
      api.sweepAlerts();
    },

    // ---------------- chat ----------------
    // Station chat has no incident. Each incident has its own chat.
    async listChat(deptId, incidentId) {
      let q = sb.from("incident_messages").select("*").eq("dept_id", deptId);
      q = incidentId ? q.eq("incident_id", incidentId) : q.is("incident_id", null);
      const msgs = must(await q.order("created_at", { ascending: false }).limit(250)).reverse();
      const ids = msgs.map((m) => m.id);
      const thread = incidentId || "station";
      const [reactions, reads] = await Promise.all([
        ids.length ? sb.from("chat_reactions").select("message_id, user_id, emoji, name").in("message_id", ids.slice(-250)) : { data: [] },
        sb.from("chat_reads").select("user_id, name, read_at").eq("dept_id", deptId).eq("thread", thread),
      ]);
      return { messages: msgs, reactions: must(reactions), reads: must(reads) };
    },
    async sendChat(deptId, incidentId, msg) {
      const { data: s } = await sb.auth.getSession();
      const row = { dept_id: deptId, incident_id: incidentId || null, user_id: s.session?.user.id, kind: msg.kind || "text", body: msg.body || "",
        media_path: msg.media_path || null, media_seconds: msg.media_seconds ?? null, media_w: msg.media_w ?? null, media_h: msg.media_h ?? null,
        lat: msg.lat ?? null, lng: msg.lng ?? null, reply_to: msg.reply_to || null, mentions: msg.mentions || [] };
      const saved = must(await sb.from("incident_messages").insert(row).select("*").single());
      sb.functions.invoke("notify", { body: { kind: "chat", message_id: saved.id } }).catch(() => {});
      return saved;
    },
    /** Uploads a photo or voice note. Returns its storage path. */
    async uploadChatFile(deptId, blob, ext) {
      const { data: s } = await sb.auth.getSession();
      const path = `${deptId}/${s.session?.user.id}/${crypto.randomUUID()}.${ext}`;
      must(await sb.storage.from("chat").upload(path, blob, { contentType: blob.type || undefined, cacheControl: "31536000", upsert: false }));
      return path;
    },
    /** Short-lived links to open photos and voice notes. */
    async chatFileUrls(paths) {
      if (!paths.length) return {};
      const { data, error } = await sb.storage.from("chat").createSignedUrls(paths, 3600 * 6);
      if (error) throw error;
      const out = {};
      for (const r of data || []) if (r.signedUrl) out[r.path] = r.signedUrl;
      return out;
    },
    async editChat(id, body) { must(await sb.rpc("edit_chat_message", { p_id: id, p_body: body })); },
    async deleteChat(id) {
      const path = must(await sb.rpc("delete_chat_message", { p_id: id }));
      if (path) await sb.storage.from("chat").remove([path]).catch(() => {});
    },
    async pinChat(id, on) { must(await sb.rpc("pin_chat_message", { p_id: id, p_on: !!on })); },
    async react(messageId, emoji, on) {
      if (on) {
        const { error } = await sb.from("chat_reactions").insert({ message_id: messageId, emoji, dept_id: null });
        if (error && error.code !== "23505") throw error;
      } else {
        const { data: s } = await sb.auth.getSession();
        must(await sb.from("chat_reactions").delete().eq("message_id", messageId).eq("emoji", emoji).eq("user_id", s.session?.user.id));
      }
    },
    async markChatRead(deptId, incidentId) {
      await sb.rpc("mark_chat_read", { p_dept: deptId, p_thread: incidentId || "station" });
    },
    /** Live chat updates plus "typing" signals. Returns { off(), typing(name) }. */
    subscribeChat(deptId, incidentId, cb) {
      const ch = sb.channel(`chat-${deptId}-${incidentId || "station"}`, { config: { broadcast: { self: false } } });
      ch.on("postgres_changes", { event: "*", schema: "public", table: "incident_messages", filter: incidentId ? `incident_id=eq.${incidentId}` : `dept_id=eq.${deptId}` },
        (p) => { const r = p.new?.id ? p.new : p.old; if (incidentId || !r || r.incident_id == null) cb("message", p); });
      ch.on("postgres_changes", { event: "*", schema: "public", table: "chat_reactions", filter: `dept_id=eq.${deptId}` }, (p) => cb("reaction", p));
      ch.on("postgres_changes", { event: "*", schema: "public", table: "chat_reads", filter: `dept_id=eq.${deptId}` }, (p) => cb("read", p));
      ch.on("broadcast", { event: "typing" }, ({ payload }) => cb("typing", payload));
      ch.subscribe((status) => cb("_status", status));
      return {
        off: () => sb.removeChannel(ch),
        typing: (who) => ch.send({ type: "broadcast", event: "typing", payload: who }).catch(() => {}),
      };
    },
    /** Station chat messages for the unread dot on the Chat tab. */
    subscribeStation(deptId, cb) {
      const ch = sb.channel(`station-${deptId}-${Math.random().toString(36).slice(2)}`);
      ch.on("postgres_changes", { event: "INSERT", schema: "public", table: "incident_messages", filter: `dept_id=eq.${deptId}` }, (p) => { if (p.new?.incident_id == null) cb(p.new); });
      ch.subscribe();
      return () => sb.removeChannel(ch);
    },
    async lastStationMessage(deptId) {
      const { data } = await sb.from("incident_messages").select("created_at, user_id").eq("dept_id", deptId).is("incident_id", null)
        .order("created_at", { ascending: false }).limit(1);
      return data?.[0] || null;
    },
    dispatchUrl() {
      return `${CONFIG.SUPABASE_URL.replace(/\/$/, "")}/functions/v1/dispatch`;
    },

    // ---------------- members / roster ----------------
    async listMembers(deptId) {
      return must(await sb.from("members").select(MEMBER_COLS)
        .eq("dept_id", deptId).eq("active", true).order("name"));
    },
    async addRosterEntry(deptId, data) {
      return must(await sb.from("members").insert({ ...data, dept_id: deptId, role: "member" }).select(MEMBER_COLS).single());
    },
    async updateMember(id, patch) {
      mustRows(await sb.from("members").update(patch).eq("id", id).select("id"));
    },
    async importRoster(deptId, people) {
      return must(await sb.rpc("import_roster", { p_dept: deptId, p_people: people }));
    },
    async importTraining(deptId, sessions) {
      return must(await sb.rpc("import_training", { p_dept: deptId, p_sessions: sessions }));
    },
    async importEquipment(deptId, items) {
      return must(await sb.rpc("import_equipment", { p_dept: deptId, p_items: items }));
    },
    async deleteRosterEntry(id) {
      mustRows(await sb.from("members").delete().eq("id", id).select("id"));
    },
    async listRemoved(deptId) {
      return must(await sb.from("members").select("id, name, rank, removed_at")
        .eq("dept_id", deptId).eq("active", false).not("removed_at", "is", null).order("removed_at", { ascending: false }).limit(50));
    },
    async allowBack(memberId) {
      must(await sb.rpc("allow_member_back", { p_member: memberId }));
    },
    async setRole(memberId, role) {
      must(await sb.rpc("set_member_role", { p_member: memberId, p_role: role }));
    },
    async removeMember(memberId, deptId) {
      must(await sb.rpc("remove_member", { p_member: memberId }));
      api.syncSeats(deptId).catch(() => {});
    },
    async getMedical(memberId) {
      return must(await sb.from("member_medical").select("*").eq("member_id", memberId).maybeSingle());
    },
    async saveMedical(memberId, deptId, data) {
      must(await sb.from("member_medical").upsert({ ...data, member_id: memberId, dept_id: deptId }).select("member_id"));
    },

    // ---------------- incidents ----------------
    async listIncidents(deptId, { status, limit = 50 } = {}) {
      let q = sb.from("incidents").select("*").eq("dept_id", deptId).order("started_at", { ascending: false }).limit(limit);
      if (status) q = q.eq("status", status);
      return must(await q);
    },
    async startIncident(deptId, { name, address, call_type }) {
      return must(await sb.rpc("start_incident", { p_dept: deptId, p_name: name, p_address: address || null, p_call_type: call_type || null, p_join: true }));
    },
    async closeIncident(id) {
      must(await sb.rpc("close_incident", { p_incident: id }));
    },
    async updateIncident(id, patch) {
      mustRows(await sb.from("incidents").update(patch).eq("id", id).select("id"));
    },
    async incidentState(id) {
      const [inc, pers, app, ma, ev, msg, loc] = await Promise.all([
        sb.from("incidents").select("*").eq("id", id).single(),
        sb.from("incident_personnel").select("*").eq("incident_id", id).order("created_at"),
        sb.from("incident_apparatus").select("*").eq("incident_id", id).order("created_at"),
        sb.from("incident_mutual_aid").select("*").eq("incident_id", id).order("created_at"),
        sb.from("incident_events").select("*").eq("incident_id", id).order("at", { ascending: false }).limit(500),
        sb.from("incident_messages").select("*").eq("incident_id", id).order("created_at").limit(300),
        sb.from("incident_locations").select("*").eq("incident_id", id),
      ]);
      return {
        incident: must(inc),
        personnel: must(pers),
        apparatus: must(app),
        mutualAid: must(ma),
        events: must(ev),
        messages: must(msg),
        locations: must(loc),
      };
    },
    async joinIncident(id) {
      return must(await sb.rpc("join_incident", { p_incident: id }));
    },
    async addPersonnel(incidentId, { member_id, name, rank, crew, status, no_radio, mutual_aid_id }) {
      return must(await sb.rpc("add_personnel", {
        p_incident: incidentId, p_member: member_id || null, p_name: name || null, p_rank: rank || null,
        p_crew: crew || null, p_status: status || "Responding", p_no_radio: !!no_radio, p_mutual_aid: mutual_aid_id || null,
      }));
    },
    async updatePersonnel(id, patch) {
      mustRows(await sb.from("incident_personnel").update(patch).eq("id", id).select("id"), "You can only change your own status.");
    },
    async removePersonnel(id) {
      mustRows(await sb.from("incident_personnel").delete().eq("id", id).select("id"));
    },
    async startPar(id) { must(await sb.rpc("start_par", { p_incident: id })); },
    async endPar(id) { must(await sb.rpc("end_par", { p_incident: id })); },
    async ackPar(personnelId) { must(await sb.rpc("ack_par", { p_personnel: personnelId })); },

    async addApparatus(incidentId, { name, kind, status }) {
      must(await sb.from("incident_apparatus").insert({ incident_id: incidentId, dept_id: null, name, kind: kind || null, status: status || "Responding" }).select("id"));
    },
    async updateApparatus(id, patch) {
      mustRows(await sb.from("incident_apparatus").update(patch).eq("id", id).select("id"));
    },
    async removeApparatus(id) {
      mustRows(await sb.from("incident_apparatus").delete().eq("id", id).select("id"));
    },
    async addMutualAid(incidentId, { name, status, notes }) {
      must(await sb.from("incident_mutual_aid").insert({ incident_id: incidentId, dept_id: null, name, status: status || "Requested", notes: notes || null }).select("id"));
    },
    async updateMutualAid(id, patch) {
      mustRows(await sb.from("incident_mutual_aid").update(patch).eq("id", id).select("id"));
    },
    async removeMutualAid(id) {
      mustRows(await sb.from("incident_mutual_aid").delete().eq("id", id).select("id"));
    },
    async logNote(incidentId, message) {
      must(await sb.from("incident_events").insert({ incident_id: incidentId, dept_id: null, kind: "note", message }));
    },
    async sendMessage(incidentId, body) {
      const { data: s } = await sb.auth.getSession();
      must(await sb.from("incident_messages").insert({ incident_id: incidentId, dept_id: null, body, user_id: s.session?.user.id }));
    },
    async shareLocation(incidentId, { lat, lng, accuracy }) {
      const { data: s } = await sb.auth.getSession();
      must(await sb.from("incident_locations").upsert({
        incident_id: incidentId, user_id: s.session?.user.id, dept_id: null, lat, lng, accuracy,
      }));
    },
    async stopLocation(incidentId, userId) {
      must(await sb.from("incident_locations").delete().eq("incident_id", incidentId).eq("user_id", userId));
    },

    /** Calls cb() whenever anything on this incident changes. Returns an unsubscribe fn. */
    subscribeIncident(id, cb) {
      const ch = sb.channel(`incident-${id}-${Math.random().toString(36).slice(2)}`);
      const filter = `incident_id=eq.${id}`;
      for (const table of ["incident_personnel", "incident_apparatus", "incident_mutual_aid", "incident_events", "incident_messages", "incident_locations"]) {
        ch.on("postgres_changes", { event: "*", schema: "public", table, filter }, (p) => cb(table, p));
      }
      ch.on("postgres_changes", { event: "*", schema: "public", table: "incidents", filter: `id=eq.${id}` }, (p) => cb("incidents", p));
      ch.subscribe((status) => cb("_status", status));
      return () => sb.removeChannel(ch);
    },
    /** Incident list + training changes for a department. */
    subscribeDepartment(deptId, cb) {
      const ch = sb.channel(`dept-${deptId}-${Math.random().toString(36).slice(2)}`);
      for (const table of ["incidents", "training_sessions", "training_attendance"]) {
        ch.on("postgres_changes", { event: "*", schema: "public", table, filter: `dept_id=eq.${deptId}` }, (p) => cb(table, p));
      }
      ch.subscribe();
      return () => sb.removeChannel(ch);
    },

    // ---------------- training ----------------
    async listTraining(deptId) {
      return must(await sb.from("training_sessions").select("*").eq("dept_id", deptId).order("session_date", { ascending: false }));
    },
    async listAttendance(deptId) {
      return must(await sb.from("training_attendance").select("*").eq("dept_id", deptId));
    },
    async saveTraining(deptId, data, id) {
      const row = { ...data, dept_id: deptId };
      if (id) return mustRows(await sb.from("training_sessions").update(data).eq("id", id).select("*"))[0];
      return must(await sb.from("training_sessions").insert(row).select("*").single());
    },
    async deleteTraining(id) {
      mustRows(await sb.from("training_sessions").delete().eq("id", id).select("id"));
    },
    async setAttendance(sessionId, memberId, present) {
      if (present) {
        must(await sb.from("training_attendance").upsert({ session_id: sessionId, member_id: memberId, dept_id: null }, { ignoreDuplicates: true }));
      } else {
        must(await sb.from("training_attendance").delete().eq("session_id", sessionId).eq("member_id", memberId));
      }
    },
    async selfMarkAttendance(sessionId) {
      must(await sb.rpc("self_mark_attendance", { p_session: sessionId }));
    },

    // ---------------- equipment ----------------
    async listEquipment(deptId) {
      return must(await sb.from("equipment").select("*").eq("dept_id", deptId).order("name"));
    },
    async saveEquipment(deptId, data, id) {
      if (id) return mustRows(await sb.from("equipment").update(data).eq("id", id).select("*"))[0];
      return must(await sb.from("equipment").insert({ ...data, dept_id: deptId }).select("*").single());
    },
    async deleteEquipment(id) {
      mustRows(await sb.from("equipment").delete().eq("id", id).select("id"));
    },

    // ---------------- billing ----------------
    async billing(action, deptId, extra = {}) {
      if (navigator.onLine === false) throw new Error("No connection");
      const { data, error } = await sb.functions.invoke("billing", { body: { ...extra, action, dept_id: deptId } });
      if (error) throw new Error(await fnError(error));
      if (data?.error) throw new Error(data.error);
      return data;
    },
    /** Asks the server to send a push alert. Never throws: alerts are best effort. */
    notify(kind, incidentId, personnelId) {
      return sb.functions.invoke("notify", { body: { kind, incident_id: incidentId, personnel_id: personnelId || null } })
        .catch(() => {});
    },
    syncSeats(deptId) {
      return api.billing("sync-seats", deptId);
    },
  };
  return api;
}

async function fnError(error) {
  try {
    const body = await error.context?.json?.();
    if (body?.error) return body.error;
  } catch { /* ignore */ }
  return error.message || "Request failed";
}
