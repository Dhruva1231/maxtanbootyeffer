# Chores page

The apartment chore rotation at <https://maxtanbootyeffer.com/chores/>.
It's a self-contained static page in `chores/`, served by GitHub Pages with
the rest of this site. This `_chores/` folder (tests, database migrations,
these notes) is kept in the repo but not published: Jekyll skips folders
that start with `_`.

It's not linked from the rest of the site, and `<meta name="robots"
content="noindex, nofollow">` keeps it out of search results. (GitHub Pages
can't send an `X-Robots-Tag` header, so the meta tag does the job. Don't block
`/chores` in a `robots.txt`: search engines would then never see the noindex.)

## Files

| File | What it is |
|---|---|
| `chores/chores.config.json` | Pairs, chore bundles, tasks, the punishment and the anchor week. **Edit this one.** |
| `chores/rotation.js` | The rotation logic (pure functions, no DOM). |
| `chores/board.js` | Report rules for display (pure functions). |
| `chores/api.js`, `identity.js`, `reports-ui.js`, `dom.js`, `app.js` | Backend calls, PIN sign-in, reports on the pair cards, and the page. |
| `chores/index.html`, `chores.css` | The page and its styles (scoped under `.chores-page`). |
| `_chores/tests/` | Vitest tests for the rotation and report rules. |
| `_chores/backend/migrations/` | Schema for the "chores" InsForge project that stores reports and PINs. |

## Editing names and chores

Everything is in `chores/chores.config.json`:

- **pairs**: `id` (a stable key) and `members` (first names). Changing a name
  is safe; changing an `id` also requires updating `anchor.assignment`. If
  roommates change, also update the `chore_people` table in the database (see
  below).
- **bundles**: `id` (the letter) and `tasks`. Each task has:
  - `text`
  - `deadline`: `"noon"`, `"midnight"`, or both, e.g. `["noon", "midnight"]`
  - `days`: `"daily"` or a list such as `["sat"]` (`mon` … `sun`)
  - `once: true` for a task done once on any of its days (e.g. vacuum on Saturday *or* Sunday)
- **penalty**: what a reported pair does (`tasks`, plus `due`, e.g.
  `"by Saturday midnight"`).
- **reports**: the database URL and its public anon key.

There must be as many pairs as bundles. Editing tasks never changes who has
which letter. Adding or removing pairs or bundles changes the whole rotation.

## How the rotation works

- Weeks run Monday 00:00 to Sunday 23:59, America/Los_Angeles time. Week maths
  works on calendar days in that time zone, so DST changes don't shift weeks.
- **Anchor week** (Mon Oct 19 2026): the fixed assignment in `anchor`.
- **From Mon Oct 26 2026**: weeks are grouped into 4-week cycles. Within a cycle
  every pair gets every bundle exactly once (a Latin square). The order is
  drawn with a mulberry32 random generator seeded by the cycle number, so it
  looks random but every phone shows the same thing, with no server.
- No pair gets the same bundle two weeks in a row, including from the anchor
  week into the first cycle and across cycle boundaries.
- Add `?date=2026-10-31` to the URL to see the page as of another day.

## Missed-chore reports

The only part of the page that uses a server: a separate InsForge project
named **chores** (`fabf22b4-caa1-4573-98cc-6ff809c7dc60`, host
`7djmb6xj.us-west.insforge.app`) on Dhruva's Berkeley account.

- **Personal PINs:** picking your name at the top asks for your PIN, or to set
  a 4-6 digit PIN the first time. The phone remembers it until you pick
  "Everyone (signed out)". The database stores PINs hashed and checks the PIN
  on every report, dispute, side vote and withdrawal. Five wrong PINs lock a
  name for 15 minutes.
- **Reporting:** once signed in, tap another pair's card and confirm (with an
  optional note). A report means "this pair missed a chore today"; which chore
  doesn't matter. Each pair can be reported once per day, and not by itself.
- **Disputes:** a report counts unless someone in the reported pair disputes
  it **and** a third roommate (not the reporter, not in the pair) sides with
  them. The reporter can withdraw their own report.
- **Deadline:** a counted report means the pair does the punishment by that
  Saturday midnight. Reports made on Saturday or Sunday are due the next
  Saturday. Reports drop off each Monday, except last weekend's, which stay
  until the Saturday they're due.

The public anon key in the config can only read reports and call the
rule-checking functions; it can't read PINs or change tables directly.

### Changing the database

From `_chores/backend/`, signed in to the InsForge CLI as the owning account:

```
npx -y @insforge/cli link --project-id fabf22b4-caa1-4573-98cc-6ff809c7dc60
npx -y @insforge/cli db migrations new <name>     # then write the SQL
npx -y @insforge/cli db migrations up --all
```

The `.insforge/` folder that `link` creates holds a key and is gitignored.

**Resetting a forgotten PIN** (or unlocking a name):

```
npx -y @insforge/cli db query -- "UPDATE chore_people SET pin_hash = NULL, failed_attempts = 0, locked_until = NULL WHERE name = 'Josh'"
```

Then that person picks their name on the page and sets a new PIN.

## Tests

```
cd _chores && npm install && npm test
```

They check the anchor week, the Latin-square and no-repeat rules over two
years, determinism, week boundaries across both DST changes, weekend-only
tasks, noon/midnight grouping, and the report rules (due dates, disputes,
who can do what).

## Previewing and deploying

Preview locally from the repo root:

```
python3 -m http.server 8000
```

then open <http://localhost:8000/chores/>. (Local previews use the real
reports database.)

Deploying is just pushing to `main`: GitHub Pages rebuilds the site.
`/chores` redirects to `/chores/` on its own.
