// Tests for the /chores rotation (public/chores/rotation.js + chores.config.json).
import { describe, expect, it } from "vitest";
import config from "../../chores/chores.config.json";
import {
  assignmentForWeek,
  dayNumberFromISO,
  dueOn,
  locate,
  weekStartDay,
  formatDay,
} from "../../chores/rotation.js";

const WEEKS = 104;
const pairIds = config.pairs.map((p) => p.id);
const bundleIds = config.bundles.map((b) => b.id);
const n = bundleIds.length;

const at = (iso: string) => locate(new Date(iso), config);
const names = (items: { pair: { members: string[] }; task: { text: string } }[]) =>
  items.map((i) => `${i.pair.members[0]}: ${i.task.text}`);

describe("chore rotation", () => {
  it("uses the known assignment for the anchor week", () => {
    expect(assignmentForWeek(0, config)).toEqual({
      "josh-darren": "D",
      "dhruva-ashish": "C",
      "ethan-nimal": "B",
      "matt-dylan": "A",
    });
    expect(formatDay(weekStartDay(0, config))).toBe("Mon, Oct 19");
    expect(formatDay(weekStartDay(1, config))).toBe("Mon, Oct 26");
  });

  it("gives every pair a different bundle each week", () => {
    for (let w = 0; w <= WEEKS; w++) {
      const a = assignmentForWeek(w, config);
      expect(Object.keys(a).sort()).toEqual([...pairIds].sort());
      expect(new Set(Object.values(a)).size).toBe(n);
    }
  });

  it("gives every pair every bundle exactly once per 4-week cycle", () => {
    for (let start = 1; start + n - 1 <= WEEKS; start += n) {
      for (const pair of pairIds) {
        const got = Array.from({ length: n }, (_, i) => assignmentForWeek(start + i, config)[pair]);
        expect(got.sort()).toEqual([...bundleIds].sort());
      }
    }
  });

  it("never gives a pair the same bundle two weeks running, across cycles and from the anchor week", () => {
    for (let w = 1; w <= WEEKS; w++) {
      const prev = assignmentForWeek(w - 1, config);
      const cur = assignmentForWeek(w, config);
      for (const pair of pairIds) expect(cur[pair], `week ${w}, ${pair}`).not.toBe(prev[pair]);
    }
  });

  it("is deterministic and varies between cycles", () => {
    const fresh = structuredClone(config); // a separate object skips the cycle cache
    const orders = new Set<string>();
    for (let w = 1; w <= WEEKS; w++) {
      expect(assignmentForWeek(w, fresh)).toEqual(assignmentForWeek(w, config));
      if ((w - 1) % n === 0) {
        orders.add(JSON.stringify(Array.from({ length: n }, (_, i) => assignmentForWeek(w + i, config))));
      }
    }
    expect(orders.size).toBeGreaterThan(10); // 26 cycles, not one repeated order
  });

  it("starts and ends weeks at midnight Los Angeles time, through DST changes", () => {
    // Rotation starts Mon Oct 26 2026 00:00 PDT (07:00 UTC).
    expect(at("2026-10-26T06:59:00Z").week).toBe(0);
    expect(at("2026-10-26T07:00:00Z").week).toBe(1);
    // DST ends Sun Nov 1 2026: Sunday 23:59 PST is 07:59 UTC on Monday.
    expect(at("2026-11-02T07:59:00Z")).toMatchObject({ week: 1, weekday: 6 });
    expect(at("2026-11-02T08:00:00Z")).toMatchObject({ week: 2, weekday: 0 });
    // DST starts Sun Mar 14 2027: Monday Mar 15 00:00 PDT is 07:00 UTC.
    const before = at("2027-03-15T06:59:00Z");
    const after = at("2027-03-15T07:00:00Z");
    expect(before.weekday).toBe(6);
    expect(after).toMatchObject({ week: before.week + 1, weekday: 0 });
  });

  it("shows weekend-only tasks only on their days", () => {
    // Week 0: Ethan + Nimal have B (vacuum + mop once, Saturday or Sunday).
    const all = (iso: string) => {
      const g = dueOn(dayNumberFromISO(iso), config);
      return names([...g.noon, ...g.midnight]);
    };
    expect(all("2026-10-23")).not.toContain("Ethan: Vacuum + mop");
    expect(all("2026-10-24")).toContain("Ethan: Vacuum + mop");
    expect(all("2026-10-25")).toContain("Ethan: Vacuum + mop");
  });

  it("keeps the missed-chore penalty out of the rotation", () => {
    const texts = config.bundles.flatMap((b) => b.tasks.map((t) => t.text));
    for (const penalty of config.penalty.tasks) expect(texts).not.toContain(penalty);
    expect(config.penalty.tasks).toEqual(["Do everyone's dishes", "Buy eggs (24) and bananas (2 bundles)"]);
  });

  it("groups today's tasks by noon and midnight deadlines", () => {
    const monday = dueOn(dayNumberFromISO("2026-10-19"), config);
    expect(names(monday.noon).sort()).toEqual(
      ["Dhruva: Put away DRY dishes", "Dhruva: Take out trash", "Josh: Clean table + countertop"].sort(),
    );
    expect(names(monday.midnight).sort()).toEqual(
      ["Ethan: Take out trash", "Josh: Clean table + countertop", "Matt: Put away DRY dishes"].sort(),
    );
  });
});
