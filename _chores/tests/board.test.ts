// Tests for the /chores missed-chore board logic (public/chores/board.js).
import { describe, expect, it } from "vitest";
import { actionsFor, buildBoard, dueSaturday, owed, reportStatus, windowStart } from "../../chores/board.js";
import { dayNumberFromISO, formatDay } from "../../chores/rotation.js";

const d = dayNumberFromISO;
const day = (n: number) => formatDay(n);
const pairOf = (name: string) =>
  ({ Josh: "josh-darren", Darren: "josh-darren", Dhruva: "dhruva-ashish", Ashish: "dhruva-ashish", Matt: "matt-dylan" })[name] ?? null;

const report = (id: string, pair_id: string, missed_on: string, extra = {}) => ({
  id,
  pair_id,
  missed_on,
  task: "Take out trash",
  reporter: "Dhruva",
  note: null,
  created_at: `${missed_on}T20:00:00Z`,
  withdrawn_at: null,
  ...extra,
});

describe("missed-chore board", () => {
  it("makes weekday misses due that Saturday and weekend misses the next one", () => {
    expect(day(dueSaturday(d("2026-10-26")))).toBe("Sat, Oct 31"); // Monday
    expect(day(dueSaturday(d("2026-10-30")))).toBe("Sat, Oct 31"); // Friday
    expect(day(dueSaturday(d("2026-10-31")))).toBe("Sat, Nov 7"); // Saturday
    expect(day(dueSaturday(d("2026-11-01")))).toBe("Sat, Nov 7"); // Sunday
  });

  it("opens reporting from the Saturday before this week's Monday", () => {
    expect(day(windowStart(d("2026-10-28")))).toBe("Sat, Oct 24");
    expect(day(windowStart(d("2026-10-26")))).toBe("Sat, Oct 24");
    expect(day(windowStart(d("2026-11-01")))).toBe("Sat, Oct 24");
    expect(day(windowStart(d("2026-11-02")))).toBe("Sat, Oct 31");
  });

  it("counts a report unless it was disputed and someone sided with the pair", () => {
    const r = report("r1", "josh-darren", "2026-10-27");
    expect(reportStatus(r, [])).toBe("counts");
    const dispute = { report_id: "r1", kind: "dispute", voter: "Josh" };
    expect(reportStatus(r, [dispute])).toBe("disputed");
    expect(reportStatus(r, [dispute, { report_id: "r1", kind: "side", voter: "Matt" }])).toBe("overturned");
    expect(reportStatus({ ...r, withdrawn_at: "2026-10-27T21:00:00Z" }, [])).toBe("withdrawn");
  });

  it("lists who owes the punishment and clears old weeks on Monday", () => {
    const reports = [
      report("r1", "josh-darren", "2026-10-27"),
      report("r2", "josh-darren", "2026-10-28"),
      report("r3", "matt-dylan", "2026-10-29"),
      report("r4", "dhruva-ashish", "2026-10-31", { reporter: "Matt" }), // Saturday: due Nov 7
      report("r5", "matt-dylan", "2026-10-20"), // last week: off the board
    ];
    const votes = [
      { report_id: "r3", kind: "dispute", voter: "Matt" },
      { report_id: "r3", kind: "side", voter: "Josh" },
    ];
    const board = buildBoard(reports, votes, d("2026-10-31"));
    expect(board.map((i) => i.report.id)).toEqual(["r4", "r3", "r2", "r1"]);
    expect(owed(board).map((o) => [o.pairId, day(o.due), o.items.length])).toEqual([
      ["josh-darren", "Sat, Oct 31", 2],
      ["dhruva-ashish", "Sat, Nov 7", 1],
    ]);
    // Next Monday: only the weekend miss is still open.
    expect(buildBoard(reports, votes, d("2026-11-02")).map((i) => i.report.id)).toEqual(["r4"]);
  });

  it("offers dispute to the pair, siding to outsiders, withdraw to the reporter", () => {
    const [item] = buildBoard([report("r1", "josh-darren", "2026-10-27")], [], d("2026-10-27"));
    expect(actionsFor(item, "Josh", pairOf)).toEqual({ dispute: true, side: false, withdraw: false });
    expect(actionsFor(item, "Matt", pairOf)).toEqual({ dispute: false, side: false, withdraw: false });
    expect(actionsFor(item, "Dhruva", pairOf)).toEqual({ dispute: false, side: false, withdraw: true });

    const dispute = { report_id: "r1", kind: "dispute", voter: "Josh" };
    const [disputed] = buildBoard([report("r1", "josh-darren", "2026-10-27")], [dispute], d("2026-10-27"));
    expect(actionsFor(disputed, "Matt", pairOf).side).toBe(true);
    expect(actionsFor(disputed, "Ashish", pairOf).side).toBe(true);
    expect(actionsFor(disputed, "Dhruva", pairOf).side).toBe(false); // the reporter
    expect(actionsFor(disputed, "Darren", pairOf).side).toBe(false); // the pair itself
    expect(actionsFor(disputed, "", pairOf)).toEqual({ dispute: false, side: false, withdraw: false });
  });
});
