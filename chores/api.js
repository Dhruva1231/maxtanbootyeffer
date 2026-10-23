// Calls to the separate "chores" InsForge project (config.reports). The key
// is the project's public anon key: it can read the board and call the
// rule-checking functions, nothing else (see chores-backend/migrations).
// Every write needs the acting roommate's PIN.

export function createApi({ url, anonKey }) {
  const headers = { Authorization: `Bearer ${anonKey}`, "Content-Type": "application/json" };

  async function request(path, options = {}) {
    const response = await fetch(`${url}${path}`, { ...options, headers, cache: "no-store" });
    const body = await response.json().catch(() => null);
    if (!response.ok) throw new Error(body?.message || `Request failed (${response.status})`);
    return body;
  }

  // PIN functions answer {"error": ...} (not an HTTP error) so the database
  // keeps its failed-attempt count; turn that into a thrown error here.
  async function rpc(name, args) {
    const body = await request(`/api/database/rpc/${name}`, { method: "POST", body: JSON.stringify(args) });
    if (body && typeof body === "object" && !Array.isArray(body) && body.error) throw new Error(body.error);
    return body;
  }

  return {
    /** Reports missed on or after `fromISO`, and their votes. */
    async load(fromISO) {
      const reports = await request(`/api/database/records/chore_reports?missed_on=gte.${fromISO}&order=created_at.desc`);
      const ids = reports.map((r) => r.id);
      const votes = ids.length ? await request(`/api/database/records/chore_votes?report_id=in.(${ids.join(",")})`) : [];
      return { reports, votes };
    },
    /** [{ name, pair_id, has_pin }] */
    people: () => rpc("chore_people_status", {}),
    setPin: (name, pin) => rpc("chore_set_pin", { p_name: name, p_pin: pin }),
    login: (name, pin) => rpc("chore_login", { p_name: name, p_pin: pin }),
    /** Report `pairId` for missing a chore today (LA time, set by the server). */
    report: (reporter, pin, pairId, note) => rpc("chore_report", { p_reporter: reporter, p_pin: pin, p_pair_id: pairId, p_note: note || null }),
    vote: (reportId, voter, pin, kind) => rpc("chore_vote", { p_report_id: reportId, p_voter: voter, p_pin: pin, p_kind: kind }),
    withdraw: (reportId, reporter, pin) => rpc("chore_withdraw", { p_report_id: reportId, p_reporter: reporter, p_pin: pin }),
  };
}
