// App-wide state and reference data.

export const S = {
  api: null,
  user: null,
  memberships: [], // [{ dept, member }]
  dept: null,
  me: null, // my member row in the current department
  online: navigator.onLine,
  rerender: () => {},
};

export const RANKS = ["Firefighter", "Probationary Firefighter", "Engineer/Driver", "Medic", "Lieutenant", "Captain", "Safety Officer", "District Chief", "Deputy Chief", "Chief"];
export const CREWS = ["Alpha", "Bravo", "Charlie", "Delta", "RIT", "Command"];

export const STATUSES = ["Responding", "Staged", "IN", "OUT", "Rehab", "Standby", "MISSING"];
export const STATUS_HELP = {
  Responding: "En route to the scene",
  Staged: "On scene, ready for assignment",
  IN: "Inside the hazard zone",
  OUT: "Out of the hazard zone",
  Rehab: "In rehab",
  Standby: "On scene, holding",
  MISSING: "Unaccounted for. Alerts every device.",
};
export const STATUS_SHORT = { Responding: "Resp", Staged: "Staged", IN: "In", OUT: "Out", Rehab: "Rehab", Standby: "Stby", MISSING: "Missing" };

export const APP_STATUSES = ["Responding", "On Scene", "Staged", "Available", "Out of Service", "Returning"];
export const APP_KINDS = ["Engine", "Pumper", "Tanker", "Ladder", "Rescue", "Squad", "Brush", "Command", "Other"];
export const MA_STATUSES = ["Standby", "Requested", "Responding", "On Scene", "Released"];
export const CALL_TYPES = ["Structure", "Vehicle fire", "Grass / brush", "MVC", "Medical assist", "Alarm", "Hazmat", "Rescue", "Other"];

export const EQUIP_STATUSES = ["Available", "Deployed", "In Service", "Out of Service", "Missing"];
export const EQUIP_CATEGORIES = ["SCBA / Breathing", "Hose / Nozzles", "Rescue Tools", "Thermal Imaging", "Communications", "Medical / EMS", "PPE", "Ladders", "Lighting", "Pumping Equipment", "Foam / Suppression", "Hand Tools", "Vehicle Equipment", "Other"];
export const CONDITIONS = ["Excellent", "Good", "Fair", "Poor", "Needs repair"];
export const TRAINING_TYPES = ["Live Fire", "Pump Operations", "Rope Rescue", "Vehicle Extrication", "First Aid / CPR", "Hazmat", "ICS / Command", "Driver Training", "Equipment Familiarization", "Wildland", "Water / Ice Rescue", "Scene Management", "Other"];
export const BLOOD_TYPES = ["", "A+", "A-", "B+", "B-", "AB+", "AB-", "O+", "O-"];

export const isOfficer = () => ["owner", "officer"].includes(S.me?.role);
export const isOwner = () => S.me?.role === "owner";

/** Mirrors dept_has_access() in the database so the UI can explain locks. */
export function hasAccess(d = S.dept) {
  if (!d) return false;
  if (new Date(d.trial_ends_at) > new Date()) return true;
  if (["active", "trialing"].includes(d.subscription_status)) return true;
  if (d.subscription_status === "past_due") {
    const since = d.past_due_since ? new Date(d.past_due_since).getTime() : Date.now();
    return since + 14 * 86400000 > Date.now();
  }
  return false;
}

export function planLabel(d = S.dept) {
  if (!d) return "";
  const paid = ["active", "trialing"].includes(d.subscription_status);
  const trialLeft = Math.ceil((new Date(d.trial_ends_at) - Date.now()) / 86400000);
  if (d.subscription_status === "active") return "Paid plan";
  if (d.subscription_status === "past_due") return "Payment overdue";
  if (paid && trialLeft > 0) return `Plan set up, billing starts in ${trialLeft} day${trialLeft === 1 ? "" : "s"}`;
  if (trialLeft > 0) return `Free trial, ${trialLeft} day${trialLeft === 1 ? "" : "s"} left`;
  return "Trial ended";
}

export function go(hash) {
  if (location.hash === hash) S.rerender();
  else location.hash = hash;
}
