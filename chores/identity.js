// "I am" picker with personal PINs for /chores. Picking your name asks for
// your PIN (or to set one, the first time). Once accepted, the name and PIN
// are remembered on this device so you aren't asked again. Picking
// "Everyone" signs out. Without a backend it's a plain name picker.
import { $, h } from "./dom.js";

const NAME_KEY = "chores-me";
const PIN_KEY = "chores-pin";

function read(key) {
  try {
    return localStorage.getItem(key) ?? "";
  } catch {
    return "";
  }
}

function write(key, value) {
  try {
    if (value) localStorage.setItem(key, value);
    else localStorage.removeItem(key);
  } catch {
    // Private mode or blocked storage: you'll be asked again next time.
  }
}

export function setupIdentity({ config, api, onChange }) {
  const select = $("chores-me");
  const panel = $("chores-auth");
  const names = config.pairs.flatMap((p) => p.members).sort((a, b) => a.localeCompare(b));
  select.append(...names.map((name) => h("option", { value: name }, name)));

  let me = "";
  let pin = "";
  let pending = null; // { name, mode: "enter" | "set", error, busy }

  function signIn(name, newPin) {
    me = name;
    pin = newPin;
    write(NAME_KEY, name);
    write(PIN_KEY, newPin);
    pending = null;
    select.value = name;
    render();
    onChange();
  }

  function signOut() {
    me = "";
    pin = "";
    write(NAME_KEY, "");
    write(PIN_KEY, "");
    pending = null;
    select.value = "";
    render();
    onChange();
  }

  async function ask(name, error = null) {
    pending = { name, mode: null, error, busy: false };
    render();
    try {
      const people = await api.people();
      if (pending?.name !== name) return;
      pending.mode = people.find((p) => p.name === name)?.has_pin ? "enter" : "set";
    } catch (e) {
      if (pending?.name !== name) return;
      pending.error = `Couldn't check your name (${e.message}).`;
      pending.mode = "enter";
    }
    render();
    panel.querySelector("input")?.focus();
  }

  async function submit(event) {
    event.preventDefault();
    const value = (pending.pin ?? "").trim();
    if (!/^\d{4,6}$/.test(value)) {
      pending.error = "Use 4 to 6 digits.";
      return render();
    }
    if (pending.mode === "set" && value !== (pending.confirm ?? "").trim()) {
      pending.error = "Those PINs don't match.";
      return render();
    }
    const { name, mode } = pending;
    pending.busy = true;
    pending.error = null;
    render();
    try {
      if (mode === "set") await api.setPin(name, value);
      else await api.login(name, value);
      signIn(name, value);
    } catch (e) {
      if (pending?.name !== name) return;
      pending.busy = false;
      pending.error = e.message;
      // Someone set this name's PIN in the meantime: switch to entering it.
      if (/already has a PIN/.test(e.message)) pending.mode = "enter";
      render();
      panel.querySelector("input")?.focus();
    }
  }

  function render() {
    panel.hidden = !pending;
    if (!pending) return panel.replaceChildren();
    const { name, mode, error, busy } = pending;
    const pinInput = (id, label) =>
      h(
        "label",
        { class: "chores-pin-field" },
        h("span", {}, label),
        h("input", {
          name: id,
          type: "password",
          inputmode: "numeric",
          autocomplete: mode === "set" ? "new-password" : "current-password",
          maxlength: "6",
          pattern: "[0-9]*",
          required: true,
          value: pending[id] ?? "", // keep what was typed when the form re-renders
          oninput: (e) => (pending[id] = e.target.value),
        }),
      );
    panel.replaceChildren(
      mode === null
        ? h("p", { class: "chores-muted" }, "Checking…")
        : h(
            "form",
            { class: "chores-auth-form", onsubmit: submit },
            h("p", {}, h("b", {}, mode === "set" ? `Set a PIN for ${name}` : `Enter ${name}'s PIN`)),
            mode === "set" ? h("p", { class: "chores-muted" }, "4 to 6 digits. You'll need it to report or dispute. This phone will remember it.") : null,
            pinInput("pin", "PIN"),
            mode === "set" ? pinInput("confirm", "PIN again") : null,
            error ? h("p", { class: "chores-error", role: "alert" }, error) : null,
            h(
              "div",
              { class: "chores-actions" },
              h("button", { type: "submit", disabled: busy }, busy ? "Checking…" : mode === "set" ? "Set PIN" : "Sign in"),
              h("button", { type: "button", class: "chores-quiet", onclick: () => ((pending = null), (select.value = me), render()) }, "Cancel"),
            ),
            mode === "enter" ? h("p", { class: "chores-muted" }, "Forgot it? Ask Dhruva to reset it.") : null,
          ),
    );
  }

  select.addEventListener("change", () => {
    const name = select.value;
    if (!name) return signOut();
    if (name === me) return ((pending = null), render());
    if (!api) return signIn(name, "");
    ask(name);
  });

  // Restore the remembered person. A name saved before PINs existed (no PIN)
  // asks for the PIN once.
  const savedName = read(NAME_KEY);
  const savedPin = read(PIN_KEY);
  if (names.includes(savedName)) {
    if (!api || savedPin) {
      me = savedName;
      pin = savedPin;
      select.value = savedName;
    } else {
      select.value = savedName;
      ask(savedName);
    }
  }

  return {
    getMe: () => me,
    getPin: () => pin,
    /** The server refused the remembered PIN (e.g. it was reset): ask again. */
    forget(message) {
      const name = me;
      me = "";
      pin = "";
      write(PIN_KEY, "");
      onChange();
      if (name) ask(name, message);
    },
  };
}
