// Live data layer on Supabase. demo.js implements the same methods in memory.
import { CONFIG } from "./config.js";

const DEPT_COLS =
  "id, name, created_at, invite_code, scanner_url, scanner_label, settings, trial_ends_at, subscription_status, current_period_end, past_due_since, seat_count";
const MEMBER_COLS =
  "id, dept_id, user_id, role, active, name, rank, call_sign, crew, phone, radio, years, certifications, notes, ec_name, ec_rel, ec_phone, created_at";

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
      await sb.auth.signOut(everywhere ? { scope: "global" } : undefined);
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
      return must(await sb.rpc("create_department", { p_name: name, p_member_name: memberName, p_rank: rank }));
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
