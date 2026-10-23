// /chores page: renders this week, today and next week from chores.config.json
// using ./rotation.js; the rotation is computed in the browser from the date.
// Missed-chore reports on the pair cards (./reports-ui.js) are the only part
// that talks to a server: the separate "chores" InsForge project.
// Add ?date=YYYY-MM-DD to the URL to see the page as of another day.
import {
  WEEKDAYS,
  assignmentForWeek,
  deadlinesOf,
  dueOn,
  formatDay,
  dayNumberFromISO,
  locate,
  weekOfDay,
  weekStartDay,
  weekdayOf,
} from "./rotation.js";
import { $, h } from "./dom.js";
import { createApi } from "./api.js";
import { setupIdentity } from "./identity.js";
import { setupReports } from "./reports-ui.js";

const DAY_NAMES = { mon: "Monday", tue: "Tuesday", wed: "Wednesday", thu: "Thursday", fri: "Friday", sat: "Saturday", sun: "Sunday" };
const DEADLINE_LABEL = { noon: "By noon", midnight: "By midnight" };

function overrideDay() {
  const value = new URLSearchParams(location.search).get("date");
  return value && /^\d{4}-\d{2}-\d{2}$/.test(value) ? dayNumberFromISO(value) : null;
}

function weekLabel(week, config) {
  const start = weekStartDay(week, config);
  const short = (day) => formatDay(day).replace(",", ""); // "Mon Oct 26"
  return `${short(start)} – ${short(start + 6)}`;
}

function pairName(pair) {
  return pair.members.join(" + ");
}

function schedule(task) {
  const deadlines = deadlinesOf(task).join(" and ");
  if (task.days === "daily") return `Daily by ${deadlines}`;
  const days = task.days.map((d) => DAY_NAMES[d]);
  if (task.once) return `Once, ${days.join(" or ")} (by ${deadlines})`;
  return `${days.join(" and ")} by ${deadlines}`;
}

function isMine(pair, me) {
  return Boolean(me) && pair.members.includes(me);
}

function renderToday(day, config, me) {
  const groups = dueOn(day, config);
  const weekday = WEEKDAYS[weekdayOf(day)];
  const box = $("chores-today");
  box.replaceChildren(h("p", { class: "chores-date" }, formatDay(day, { weekday: "long", month: "long", day: "numeric" })));
  for (const deadline of ["noon", "midnight"]) {
    const items = groups[deadline];
    if (!items.length) continue;
    box.append(
      h("h3", {}, DEADLINE_LABEL[deadline]),
      h(
        "ul",
        { class: "chores-due" },
        items.map(({ pair, bundle, task }) =>
          h(
            "li",
            { class: isMine(pair, me) ? "is-me" : null },
            h("span", { class: "chores-task" }, task.text, task.once ? h("small", {}, ` · once this weekend${weekday === "sun" ? " (last day)" : ""}`) : null),
            h("span", { class: "chores-who" }, pairName(pair), " ", h("b", { class: "chores-letter-sm" }, bundle.id)),
          ),
        ),
      ),
    );
  }
}

function renderThisWeek(week, config, me) {
  const assignment = assignmentForWeek(week, config);
  const pairs = [...config.pairs].sort((a, b) => Number(isMine(b, me)) - Number(isMine(a, me)));
  $("chores-this-week").replaceChildren(
    ...pairs.map((pair) => {
      const bundle = config.bundles.find((b) => b.id === assignment[pair.id]);
      return h(
        "article",
        { class: isMine(pair, me) ? "chores-card is-me" : "chores-card", "data-pair": pair.id },
        h(
          "header",
          {},
          h("span", { class: "chores-letter", "aria-label": `Bundle ${bundle.id}` }, bundle.id),
          h("span", { class: "chores-pair" }, pairName(pair), isMine(pair, me) ? h("small", {}, " · you") : null),
        ),
        h(
          "ul",
          {},
          bundle.tasks.map((task) =>
            h("li", {}, h("span", {}, task.text), h("small", {}, schedule(task))),
          ),
        ),
        h("div", { class: "chores-card-reports" }),
      );
    }),
  );
}

function renderNextWeek(week, config, me) {
  const assignment = assignmentForWeek(week + 1, config);
  $("chores-next-week-title").textContent = `Next week (${weekLabel(week + 1, config)})`;
  $("chores-next-week").replaceChildren(
    ...config.pairs.map((pair) =>
      h("li", { class: isMine(pair, me) ? "is-me" : null }, h("span", {}, pairName(pair)), h("b", { class: "chores-letter-sm" }, assignment[pair.id])),
    ),
  );
}

function renderPenalty(config) {
  const penalty = config.penalty;
  const section = $("chores-penalty").closest("section");
  section.hidden = !penalty?.tasks?.length;
  if (section.hidden) return;
  $("chores-penalty").replaceChildren(
    h("p", {}, `If your pair gets reported for a missed chore, you do all of this ${penalty.due}:`),
    h("ul", {}, penalty.tasks.map((text) => h("li", {}, text))),
  );
}

function render(config, me) {
  const forced = overrideDay();
  const day = forced ?? locate(new Date(), config).day;
  const week = weekOfDay(day, config);

  $("chores-status").hidden = true;
  $("chores-this-week-title").textContent = `This week (${weekLabel(week, config)})`;
  const override = $("chores-override");
  override.hidden = forced === null;
  override.replaceChildren(
    ...(forced === null ? [] : [`Showing the page as of ${formatDay(forced)}. Remove `, h("code", {}, "?date="), " from the address to see today."]),
  );

  renderToday(day, config, me);
  renderThisWeek(week, config, me);
  renderNextWeek(week, config, me);
  renderPenalty(config);
  return day;
}

async function start() {
  let config;
  try {
    const response = await fetch("/chores/chores.config.json", { cache: "no-cache" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    config = await response.json();
  } catch (error) {
    $("chores-status").textContent = `Couldn't load the chore list (${error.message}). Try reloading.`;
    return;
  }

  const api = config.reports?.url && config.reports?.anonKey ? createApi(config.reports) : null;
  let shownDay;
  let reports = null;
  const identity = setupIdentity({
    config,
    api,
    onChange: () => {
      shownDay = render(config, identity.getMe());
      reports?.rerender();
    },
  });
  shownDay = render(config, identity.getMe());
  reports = setupReports(config, api, identity);
  // Keep an open tab current when the day (or week) rolls over, and pick up
  // other people's reports.
  setInterval(() => {
    if (overrideDay() === null && locate(new Date(), config).day !== shownDay) shownDay = render(config, identity.getMe());
    reports.refresh();
  }, 60000);
}

start();
