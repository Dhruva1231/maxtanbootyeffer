// Missed-chore report logic for /chores: pure functions over the rows the
// chores backend returns (see chores-backend/migrations). No DOM or network.
// A report says a pair missed a chore on a day; which chore doesn't matter.
//
// A report counts unless the reported pair disputed it AND a third roommate
// sided with them. Mon-Fri misses are due that Saturday; Sat/Sun misses are
// due the following Saturday. Withdrawn reports are ignored.

import { dayNumberFromISO, weekdayOf } from "./rotation.js";

/** Day number of the Saturday a miss on `missedDay` must be made up by. */
export function dueSaturday(missedDay) {
  const weekday = weekdayOf(missedDay); // 0 = Monday … 6 = Sunday
  return weekday <= 4 ? missedDay + (5 - weekday) : missedDay + (12 - weekday);
}

/** First day still on the board: the Saturday before this week's Monday. */
export function windowStart(today) {
  return today - weekdayOf(today) - 2;
}

/** "counts" | "disputed" (still counts) | "overturned" | "withdrawn". */
export function reportStatus(report, votes) {
  if (report.withdrawn_at) return "withdrawn";
  const mine = votes.filter((v) => v.report_id === report.id);
  const disputed = mine.some((v) => v.kind === "dispute");
  const sided = mine.some((v) => v.kind === "side");
  if (disputed && sided) return "overturned";
  return disputed ? "disputed" : "counts";
}

export function counts(status) {
  return status === "counts" || status === "disputed";
}

/**
 * The live board for `today`: reports still open (missed on or after the
 * window start), newest first, each with its status, votes and due Saturday.
 */
export function buildBoard(reports, votes, today) {
  const start = windowStart(today);
  return reports
    .map((report) => {
      const missedDay = dayNumberFromISO(report.missed_on);
      return {
        report,
        missedDay,
        due: dueSaturday(missedDay),
        status: reportStatus(report, votes),
        dispute: votes.find((v) => v.report_id === report.id && v.kind === "dispute") ?? null,
        side: votes.find((v) => v.report_id === report.id && v.kind === "side") ?? null,
      };
    })
    .filter((item) => item.missedDay >= start && item.status !== "withdrawn")
    .sort((a, b) => b.missedDay - a.missedDay || String(b.report.created_at).localeCompare(String(a.report.created_at)));
}

/** [{ pairId, due, items }] for pairs that owe the punishment, soonest first. */
export function owed(board) {
  const groups = new Map();
  for (const item of board) {
    if (!counts(item.status)) continue;
    const key = `${item.report.pair_id}|${item.due}`;
    if (!groups.has(key)) groups.set(key, { pairId: item.report.pair_id, due: item.due, items: [] });
    groups.get(key).items.push(item);
  }
  return [...groups.values()].sort((a, b) => a.due - b.due || a.pairId.localeCompare(b.pairId));
}

/** What `me` may do with a board item: { dispute, side, withdraw } booleans. */
export function actionsFor(item, me, pairOf) {
  if (!me) return { dispute: false, side: false, withdraw: false };
  const reported = item.report.pair_id;
  return {
    dispute: !item.dispute && pairOf(me) === reported,
    side: Boolean(item.dispute) && !item.side && pairOf(me) !== reported && me !== item.report.reporter,
    withdraw: me === item.report.reporter,
  };
}
