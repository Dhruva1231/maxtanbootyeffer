// Missed-chore reports on /chores, shown on the "This week" pair cards: tap
// another pair's card to report that they missed a chore today. Each card
// lists its open reports with dispute / side / withdraw buttons and says when
// the pair owes the punishment. Rules live in board.js (display) and the
// chores backend (enforcement).
import { actionsFor, buildBoard, owed, windowStart } from "./board.js";
import { $, h } from "./dom.js";
import { formatDay, locate } from "./rotation.js";

const iso = (day) => new Date(day * 86400000).toISOString().slice(0, 10);
const short = (day) => formatDay(day).replace(",", "");

export function setupReports(config, api, identity) {
  const hint = $("chores-report-hint");
  if (!api) return { refresh() {}, rerender() {} };
  const getMe = identity.getMe;
  const pin = identity.getPin;
  const pairs = new Map(config.pairs.map((p) => [p.id, p]));
  const pairOf = (name) => config.pairs.find((p) => p.members.includes(name))?.id ?? null;
  const pairName = (id) => pairs.get(id)?.members.join(" + ") ?? id;
  const today = () => locate(new Date(), config).day;

  let data = null; // { reports, votes }
  let loadError = null;
  let busy = false;
  let openPair = null; // the card whose report box is open
  let note = "";
  let message = null; // { pairId, text, error }

  async function refresh() {
    try {
      data = await api.load(iso(windowStart(today())));
      loadError = null;
    } catch (error) {
      loadError = error.message;
    }
    rerender();
  }

  async function act(pairId, run, success) {
    busy = true;
    message = null;
    rerender();
    try {
      await run();
      message = { pairId, text: success, error: false };
      openPair = null;
      note = "";
      await refresh();
    } catch (error) {
      message = { pairId, text: error.message, error: true };
      // The remembered PIN no longer works (wrong, reset or locked): sign in again.
      if (/Wrong PIN|Set your PIN|Too many/.test(error.message)) identity.forget(error.message);
    } finally {
      busy = false;
      rerender();
    }
  }

  function dayLabel(day) {
    const now = today();
    return day === now ? "today" : day === now - 1 ? "yesterday" : short(day);
  }

  function statusText(item) {
    if (item.status === "overturned") return `Overturned: ${item.dispute.voter} disputed, ${item.side.voter} sided with them`;
    if (item.status === "disputed") return `Disputed by ${item.dispute.voter}. Still counts unless someone outside the pair sides with them`;
    return "Counts";
  }

  function reportItem(item, me) {
    const can = actionsFor(item, me, pairOf);
    const pairId = item.report.pair_id;
    const pair = pairName(pairId);
    return h(
      "li",
      { class: `chores-report is-${item.status}` },
      h("span", {}, `Reported by ${item.report.reporter} ${dayLabel(item.missedDay)}${item.report.note ? `: “${item.report.note}”` : ""}`),
      h("span", { class: "chores-status-pill" }, statusText(item)),
      can.dispute || can.side || can.withdraw
        ? h(
            "div",
            { class: "chores-actions" },
            can.dispute &&
              h("button", { type: "button", disabled: busy, onclick: () => act(pairId, () => api.vote(item.report.id, me, pin(), "dispute"), "Disputed. Someone outside your pair can now side with you.") }, "Dispute"),
            can.side &&
              h(
                "button",
                { type: "button", disabled: busy, onclick: () => confirm(`Side with ${pair}? The report won't count.`) && act(pairId, () => api.vote(item.report.id, me, pin(), "side"), "Done. That report no longer counts.") },
                `Side with ${pair}`,
              ),
            can.withdraw &&
              h("button", { type: "button", class: "chores-quiet", disabled: busy, onclick: () => confirm("Withdraw your report?") && act(pairId, () => api.withdraw(item.report.id, me, pin()), "Report withdrawn.") }, "Withdraw"),
          )
        : null,
    );
  }

  function reportBox(pairId, me) {
    if (!me) return h("p", { class: "chores-error" }, "Pick your name at the top and sign in with your PIN first.");
    return h(
      "form",
      {
        class: "chores-report-box",
        onsubmit: (event) => {
          event.preventDefault();
          act(pairId, () => api.report(me, pin(), pairId, note), `Reported ${pairName(pairId)}.`);
        },
      },
      h("p", {}, h("b", {}, `Report ${pairName(pairId)} for missing a chore today?`)),
      h("input", { type: "text", maxlength: "280", value: note, placeholder: "Note (optional), e.g. trash still full at 1am", "aria-label": "Note (optional)", oninput: (e) => (note = e.target.value) }),
      h(
        "div",
        { class: "chores-actions" },
        h("button", { type: "submit", disabled: busy }, busy ? "Reporting…" : `Report as ${me}`),
        h("button", { type: "button", class: "chores-quiet", onclick: () => ((openPair = null), (note = ""), rerender()) }, "Cancel"),
      ),
    );
  }

  function rerender() {
    const me = getMe();
    const board = data ? buildBoard(data.reports, data.votes, today()) : [];
    const debts = owed(board);
    const typing = document.activeElement?.matches?.(".chores-report-box input");
    if (hint) {
      hint.hidden = false;
      hint.textContent = loadError ? `Couldn't load reports (${loadError}).` : "Tap another pair's card to report that they missed a chore.";
      hint.classList.toggle("chores-error", Boolean(loadError));
    }

    for (const card of document.querySelectorAll(".chores-card[data-pair]")) {
      const pairId = card.dataset.pair;
      const reportable = pairOf(me) !== pairId;
      card.classList.toggle("is-reportable", reportable);
      card.tabIndex = reportable ? 0 : -1;
      card.setAttribute("aria-expanded", String(openPair === pairId));
      if (reportable) card.setAttribute("role", "button");
      else card.removeAttribute("role");
      if (!reportable && openPair === pairId) openPair = null;

      const items = board.filter((item) => item.report.pair_id === pairId);
      const dues = debts.filter((d) => d.pairId === pairId);
      card.querySelector(".chores-card-reports").replaceChildren(
        ...[
          ...dues.map((d) => h("p", { class: "chores-owes" }, `Owes the punishment by ${short(d.due)} midnight`)),
          items.length ? h("ul", { class: "chores-report-list" }, items.map((item) => reportItem(item, me))) : null,
          message?.pairId === pairId ? h("p", { class: message.error ? "chores-error" : "chores-ok", role: "status" }, message.text) : null,
          openPair === pairId ? reportBox(pairId, me) : null,
        ].filter(Boolean),
      );
    }
    if (typing) document.querySelector(".chores-report-box input")?.focus();
  }

  // One listener for all cards; cards are re-created when the week changes.
  const container = $("chores-this-week");
  const open = (event) => {
    const card = event.target.closest(".chores-card.is-reportable");
    if (!card || event.target.closest("button, input, select, a, form")) return;
    if (event.type === "keydown" && event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    openPair = openPair === card.dataset.pair ? null : card.dataset.pair;
    message = null;
    rerender();
    container.querySelector(".chores-report-box input")?.focus();
  };
  container.addEventListener("click", open);
  container.addEventListener("keydown", open);

  rerender();
  refresh();
  document.addEventListener("visibilitychange", () => document.visibilityState === "visible" && refresh());
  return { refresh, rerender };
}
