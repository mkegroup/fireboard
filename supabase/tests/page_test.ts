// deno test supabase/tests/page_test.ts
function assertEquals(got: unknown, want: unknown) {
  if (JSON.stringify(got) !== JSON.stringify(want)) throw new Error(`got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
}
import { parsePage, unitMatches, cleanSubject } from "../functions/_shared/page.ts";

Deno.test("CAD style, all on one line", () => {
  const p = parsePage("CALL: STRUCTURE FIRE ADDR: 142 MILL ST CITY: COMBERMERE UNITS: E1,T2 Incident #: 26-001234");
  assertEquals(p.callType, "Structure");
  assertEquals(p.name, "Structure Fire");
  assertEquals(p.address, "142 Mill St, Combermere");
  assertEquals(p.units, ["E1", "T2"]);
});

Deno.test("Labelled lines with cross street and notes", () => {
  const p = parsePage(`Nature: MVC with entrapment
Location: Hwy 62 at Old Barry's Bay Rd
Cross Streets: Siberia Rd
Units: Rescue 3, Engine 1
Comments: 2 vehicles, one on its roof.
Caller reports driver trapped.`);
  assertEquals(p.callType, "MVC");
  assertEquals(p.name, "MVC with entrapment");
  assertEquals(p.address, "Hwy 62 at Old Barry's Bay Rd (at Siberia Rd)");
  assertEquals(p.units, ["RESCUE3", "ENGINE1"]);
  assertEquals(p.notes.startsWith("2 vehicles, one on its roof."), true);
});

Deno.test("Plain sentence page", () => {
  const p = parsePage("Grass fire behind 88 Lake Road, spreading toward the tree line. Brush 4 respond.");
  assertEquals(p.callType, "Grass / brush");
  assertEquals(p.address, "88 Lake Road");
});

Deno.test("Forwarded Gmail page uses the inner subject", () => {
  const raw = `---------- Forwarded message ---------
From: County Dispatch <dispatch@county.on.ca>
Date: Tue, Nov 10, 2026 at 2:01 PM
Subject: Alarm - 12 Main St
To: chief@gmail.com

FIRE ALARM SOUNDING
12 Main St, Barry's Bay
Keyholder en route

Sent from my iPhone`;
  const p = parsePage(raw, "Fwd: Alarm - 12 Main St");
  assertEquals(p.callType, "Alarm");
  assertEquals(p.name, "Alarm - 12 Main St");
  assertEquals(p.address, "12 Main St");
  assertEquals(p.notes.includes("Sent from my iPhone"), false);
  assertEquals(p.notes.includes("chief@gmail.com"), false);
});

Deno.test("HTML email and coordinates", () => {
  const p = parsePage("<html><body><p><b>Type:</b> Medical - VSA</p><p><b>Address:</b> 5 Opeongo Line</p><p>45.4889, -77.6810</p></body></html>");
  assertEquals(p.callType, "Medical assist");
  assertEquals(p.address, "5 Opeongo Line");
  assertEquals(p.lat, 45.4889);
  assertEquals(p.lng, -77.681);
});

Deno.test("French page", () => {
  const p = parsePage("Type: Incendie de bâtiment\nAdresse: 210 rue Principale\nVille: Gatineau");
  assertEquals(p.callType, "Structure");
  assertEquals(p.address, "210 rue Principale, Gatineau");
});

Deno.test("Empty and junk input never throws", () => {
  assertEquals(parsePage("").name, "Dispatched call");
  assertEquals(parsePage("   \n\n ").address, null);
  parsePage("<<<>>> : : : CALL: ADDR: UNITS:");
});

Deno.test("Unit codes match trucks", () => {
  assertEquals(unitMatches("E1", "Engine 1"), true);
  assertEquals(unitMatches("ENG1", "Engine 1"), true);
  assertEquals(unitMatches("T2", "Tanker 2"), true);
  assertEquals(unitMatches("RESCUE3", "Rescue 3"), true);
  assertEquals(unitMatches("E2", "Engine 1"), false);
  assertEquals(unitMatches("T1", "Engine 1"), false);
});

Deno.test("Subject cleanup", () => {
  assertEquals(cleanSubject("Fwd: RE: FW: Structure fire"), "Structure fire");
});
