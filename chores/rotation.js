// Chore rotation for /chores. Pure functions with no DOM, storage or network,
// so the page and the Vitest suite (src/chores/rotation.test.ts) share them.
//
// Weeks run Monday 00:00 to Sunday 23:59 in config.timeZone. Week 0 is the
// anchor week (config.anchor) with a fixed assignment. From week 1 on, weeks
// are grouped into cycles of N weeks (N = number of bundles = number of pairs).
// Each cycle is a Latin square: every pair gets every bundle exactly once and
// every week gives each bundle to exactly one pair. The order is drawn with a
// mulberry32 PRNG seeded by the cycle number, so every browser computes the
// same rotation. No pair repeats a bundle in consecutive weeks, including
// across cycle boundaries and from the anchor week into cycle 0.

export const WEEKDAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
const DAY_MS = 86400000;

/** mulberry32: a small, fast, seedable PRNG returning floats in [0, 1). */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Days since 1970-01-01 of a calendar date given as "YYYY-MM-DD". */
export function dayNumberFromISO(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  return Math.round(Date.UTC(y, m - 1, d) / DAY_MS);
}

/**
 * Days since 1970-01-01 of the calendar date that `date` falls on in
 * `timeZone`. Working in whole calendar days keeps week maths free of DST:
 * a 23- or 25-hour day is still one day.
 */
export function localDayNumber(date, timeZone) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const get = (type) => Number(parts.find((p) => p.type === type).value);
  return Math.round(Date.UTC(get("year"), get("month") - 1, get("day")) / DAY_MS);
}

/** 0 = Monday … 6 = Sunday. 1970-01-01 was a Thursday. */
export function weekdayOf(dayNumber) {
  return (((dayNumber + 3) % 7) + 7) % 7;
}

/** "Mon Oct 26" style label for a day number. */
export function formatDay(dayNumber, options = { weekday: "short", month: "short", day: "numeric" }) {
  return new Date(dayNumber * DAY_MS).toLocaleDateString("en-US", { ...options, timeZone: "UTC" });
}

function anchorDay(config) {
  const day = dayNumberFromISO(config.anchor.weekOf);
  if (weekdayOf(day) !== 0) throw new Error(`anchor.weekOf ${config.anchor.weekOf} is not a Monday`);
  return day;
}

/** Monday's day number for week `week` (0 = anchor week). */
export function weekStartDay(week, config) {
  return anchorDay(config) + week * 7;
}

/** Which week (0 = anchor week, negative = before it) a day number falls in. */
export function weekOfDay(dayNumber, config) {
  return Math.floor((dayNumber - anchorDay(config)) / 7);
}

/** Week number and weekday for an instant, in config.timeZone. */
export function locate(date, config) {
  const day = localDayNumber(date, config.timeZone);
  return { day, week: weekOfDay(day, config), weekday: weekdayOf(day) };
}

function validate(config) {
  const pairIds = config.pairs.map((p) => p.id);
  const bundleIds = config.bundles.map((b) => b.id);
  if (pairIds.length !== bundleIds.length) {
    throw new Error(`need as many pairs as bundles (${pairIds.length} pairs, ${bundleIds.length} bundles)`);
  }
  const used = pairIds.map((id) => config.anchor.assignment[id]);
  if (used.some((b) => !bundleIds.includes(b)) || new Set(used).size !== bundleIds.length) {
    throw new Error("anchor.assignment must give every pair a different bundle");
  }
  return { pairIds, bundleIds };
}

function shuffled(items, rng) {
  const out = items.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/**
 * One cycle: an array of N weekly assignments ({ pairId: bundleId }) forming a
 * Latin square, whose first week shares no pair→bundle with `previousWeek`.
 * Filled cell by cell with seeded random candidate order and backtracking, so
 * the result is random-looking, always valid and the same everywhere.
 */
export function generateCycle(cycle, previousWeek, pairIds, bundleIds) {
  const n = pairIds.length;
  const rng = mulberry32((Math.imul(cycle + 1, 0x9e3779b1) ^ 0x5eed) >>> 0);
  const grid = Array.from({ length: n }, () => new Array(n).fill(null)); // grid[week][pair]

  function fill(cell) {
    if (cell === n * n) return true;
    const week = Math.floor(cell / n);
    const pair = cell % n;
    for (const bundle of shuffled(bundleIds, rng)) {
      if (grid[week].includes(bundle)) continue; // bundle already taken this week
      if (grid.some((row) => row[pair] === bundle)) continue; // pair already had it this cycle
      if (week === 0 && previousWeek[pairIds[pair]] === bundle) continue; // no repeat across the boundary
      grid[week][pair] = bundle;
      if (fill(cell + 1)) return true;
      grid[week][pair] = null;
    }
    return false;
  }

  if (!fill(0)) throw new Error(`no valid rotation for cycle ${cycle}`);
  return grid.map((row) => Object.fromEntries(pairIds.map((id, i) => [id, row[i]])));
}

const cycleCache = new WeakMap();

/**
 * { pairId: bundleId } for a week. Week 0 (and any earlier week) uses the
 * anchor assignment; week w >= 1 is week (w - 1) % N of cycle floor((w - 1) / N).
 */
export function assignmentForWeek(week, config) {
  const { pairIds, bundleIds } = validate(config);
  if (week <= 0) return { ...config.anchor.assignment };
  const n = bundleIds.length;
  const cycle = Math.floor((week - 1) / n);
  let cycles = cycleCache.get(config);
  if (!cycles) cycleCache.set(config, (cycles = []));
  for (let c = cycles.length; c <= cycle; c++) {
    const previous = c === 0 ? config.anchor.assignment : cycles[c - 1][n - 1];
    cycles.push(generateCycle(c, previous, pairIds, bundleIds));
  }
  return { ...cycles[cycle][(week - 1) % n] };
}

/** The deadlines of a task as an array ("noon", "midnight"). */
export function deadlinesOf(task) {
  return Array.isArray(task.deadline) ? task.deadline : [task.deadline];
}

/** Whether a task applies on a weekday (0 = Monday … 6 = Sunday). */
export function taskOnDay(task, weekday) {
  return task.days === "daily" || task.days.includes(WEEKDAYS[weekday]);
}

/**
 * Everything due on one day, grouped by deadline:
 * { noon: [{ pair, bundle, task }], midnight: [...] }.
 */
export function dueOn(dayNumber, config) {
  const week = weekOfDay(dayNumber, config);
  const weekday = weekdayOf(dayNumber);
  const assignment = assignmentForWeek(week, config);
  const groups = { noon: [], midnight: [] };
  for (const pair of config.pairs) {
    const bundle = config.bundles.find((b) => b.id === assignment[pair.id]);
    for (const task of bundle.tasks) {
      if (!taskOnDay(task, weekday)) continue;
      for (const deadline of deadlinesOf(task)) groups[deadline].push({ pair, bundle, task });
    }
  }
  return groups;
}
