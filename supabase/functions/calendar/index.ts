// Training calendar feed. Google Calendar, Outlook and Apple Calendar can
// subscribe to it and keep the department's training nights up to date.
// GET https://<project>.supabase.co/functions/v1/calendar?token=<calendar token>
import { adminClient } from "../_shared/util.ts";

const esc = (s: string) => s.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");

/** Lines longer than 75 bytes must be folded. */
function fold(line: string): string {
  const out: string[] = [];
  let cur = "";
  for (const ch of line) {
    if (new TextEncoder().encode(cur + ch).length > 74) { out.push(cur); cur = " " + ch; } else cur += ch;
  }
  out.push(cur);
  return out.join("\r\n");
}

const ymd = (d: string) => d.replace(/-/g, "").slice(0, 8);
const nextDay = (d: string) => { const t = new Date(`${d}T00:00:00Z`); t.setUTCDate(t.getUTCDate() + 1); return t.toISOString().slice(0, 10); };
const stamp = (d: Date) => d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");

Deno.serve(async (req) => {
  const token = new URL(req.url).searchParams.get("token") ?? "";
  if (!/^[a-f0-9]{64}$/.test(token)) return new Response("Not found", { status: 404 });
  const admin = adminClient();
  const { data: row } = await admin.from("dept_integrations").select("dept_id").eq("calendar_token", token).maybeSingle();
  if (!row) return new Response("Not found", { status: 404 });
  const { data: dept } = await admin.from("departments").select("name").eq("id", row.dept_id).maybeSingle();
  const since = new Date(Date.now() - 180 * 86400000).toISOString().slice(0, 10);
  const { data: sessions } = await admin.from("training_sessions")
    .select("id, title, session_date, location, kind, hours, instructor, notes, updated_at")
    .eq("dept_id", row.dept_id).gte("session_date", since).order("session_date").limit(500);

  const name = `${dept?.name ?? "Fire department"} training`;
  const lines = [
    "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//MKE Group Inc.//Fire Ground Board//EN", "CALSCALE:GREGORIAN", "METHOD:PUBLISH",
    `X-WR-CALNAME:${esc(name)}`, "X-PUBLISHED-TTL:PT1H", "REFRESH-INTERVAL;VALUE=DURATION:PT1H",
  ];
  for (const s of sessions ?? []) {
    const details = [s.kind, s.instructor ? `Instructor: ${s.instructor}` : "", s.hours ? `${s.hours} h` : "", s.notes ?? ""].filter(Boolean).join("\n");
    lines.push(
      "BEGIN:VEVENT",
      `UID:${s.id}@fire.mkegroup.ca`,
      `DTSTAMP:${stamp(new Date(s.updated_at ?? Date.now()))}`,
      `DTSTART;VALUE=DATE:${ymd(s.session_date)}`,
      `DTEND;VALUE=DATE:${ymd(nextDay(s.session_date))}`,
      `SUMMARY:${esc(s.title)}`,
      ...(s.location ? [`LOCATION:${esc(s.location)}`] : []),
      ...(details ? [`DESCRIPTION:${esc(details)}`] : []),
      "END:VEVENT",
    );
  }
  lines.push("END:VCALENDAR");
  return new Response(lines.map(fold).join("\r\n") + "\r\n", {
    headers: {
      "content-type": "text/calendar; charset=utf-8",
      "content-disposition": `inline; filename="training.ics"`,
      "cache-control": "max-age=900",
    },
  });
});
