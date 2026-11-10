# CineColombia Lifecycle Feed

A scheduled Bun/TypeScript scraper that watches the Cinecolombia website API for film
lifecycle changes (added, advance booking opens, now in theaters, removed) and
publishes them as a Spanish-language RSS feed and Astro static site, with optional
Discord notifications on each transition.

See [`issues/`](./issues/) for the original issue breakdown.
Domain terms: [`CONTEXT.md`](./CONTEXT.md).

## Run

```bash
bun install
# Node.js 22.12+ is needed for Astro; Node 24 is used in CI.
bun run scrape.ts            # one observation; writes data/ and docs/feed.xml
bun run scrape.ts --hygiene  # repair historical staging without scraping or notifying
bun test                     # lifecycle, API, reliability, and Astro build tests
bun run typecheck            # TypeScript unused-code checks and Astro checks
bun run dev                  # Astro development server
bun run build                # production HTML, RSS, and assets in dist/
bun run check                # all tests, type checks, and production build
```

The national catalog adapter validates website responses with Zod before
constructing domain records. At most six detail requests run concurrently.
No homepage token or sitemap is used. The unfiltered `/films` listing returns
an empty catalog, so the national availability list is the film index.

## Layout

```
scrape.ts            # fetch, persistence, delivery queue, and git publishing
catalog.ts           # validated website adapter, bounded concurrency and deadline
domain.ts            # shared film, event, state, and archive types
lifecycle.ts         # pure catalog transition and abort rules
presentation.ts      # shared event facts, RSS and Discord projections
site-model.ts        # catalog grouping and Bogotá dates
src/pages/           # Astro homepage and static feed.xml route
src/components/      # catalog and historical announcements
src/layouts/         # document layout
src/styles/          # responsive styles
CONTEXT.md           # domain glossary
data/                # committed posts.json + state.json
docs/feed.xml        # scraper RSS snapshot for existing consumers
dist/                # ignored Astro output for hosting
systemd/             # cineco.service + cineco.timer
```

The scraper fetches and validates a national catalog, calls `runLifecycle`, and
saves the archive before state. It writes the RSS snapshot, delivers queued
notifications, and optionally commits and pushes data. It does not build HTML.
Astro reads committed JSON at build time, renders the catalog and history, and
produces `/index.html`, `/feed.xml`, and assets without a server runtime.
Catalog search and category filtering use a small browser script; the catalog
and history remain readable with JavaScript disabled.

Astro is pinned to the 6.x series because the 7.x native bundler crashes on the
production machine's CPU. The lockfile fixes exact dependency versions.

`Deps.fetchCatalog` is the same seam for production and lifecycle integration
tests. `catalog.test.ts` verifies raw response parsing, `reliability.test.ts`
verifies cancellation and notification retries, and `site-build.test.ts` builds
Astro against isolated fixtures to verify escaping, grouping, and RSS history.
The CI workflow runs all tests, TypeScript unused-code checks, Astro checks,
and a production build on pushes and pull requests.

## What the data says

The scraper observes Cinecolombia's website catalog at each successful check. A film's
reported availability comes from national category rows, such as `ComingSoon`,
`AdvanceBooking`, and `NowShowing`. The new API omits site IDs, stored as null; older observations may identify a site. A row does not
contain screening dates or prove that tickets or showtimes exist on a particular
day. The film's `releaseDate` is metadata, not a screening schedule. The current
catalog keeps per-site details in optional `availabilityRows`; older records may
have only merged categories. A future-dated film can already carry `NowShowing`.
The current catalog marks the future release rather than claiming it is playing
now. Its per-site categories are available in expandable details when the scraper
has captured them; site identifiers are not cinema names.

The HTML page combines the latest accepted catalog with a history of announcements.
The catalog is a changing observation, not a guarantee of availability. A missing
film stays visible briefly with an uncertainty warning; a missing category leaves
the current record immediately but needs confirmation before a later return can
trigger a repeat announcement. Event posts in the RSS feed and HTML history
describe what the scraper announced at the time, not what is available today.
Later metadata corrections update the current catalog,
not old announcement snapshots.

## Lifecycle events

| Event | When | Label (es-CO) |
|---|---|---|
| `added` | new `filmId` at ComingSoon (or no higher stage) | Pronto |
| `preventa-opens` | new film already in `AdvanceBooking`, or known film gains it (and is not in theaters) | Preventa abierta |
| `now-in-theaters` | new film already reports `NowShowing`, or known film gains that category | En cartelera |
| `removed` | film absent for `REMOVAL_THRESHOLD` (2) consecutive successful runs | Ya no disponible |

Notes:

- **Cold start (virgin install only):** empty previous films, no `lastRun`, and empty
  `posts.json` → seed the current catalog without archive entries or Discord spam.
  After a real wipe (history present), reappearing films archive at **highest stage**
  (not always `added`).
- **Loss debounce:** the current record reflects category losses immediately.
  `pendingCategoryLosses` delays only the decision to announce a later regain:
  a return after one observed absence is not a new opening; two observed
  absences confirm the loss, so a later gain may produce another event.
  Likewise, an absent film stays soft-kept with `missingRuns[id]` until two
  consecutive successful absences trigger `removed`. A return before that does
  not cause a removal or re-announcement.
- **First announcement is highest stage:** a newly seen film emits one event —
  `now-in-theaters` if it already has `NowShowing`, else `preventa-opens` if it has
  `AdvanceBooking`, else `added` (Pronto). Never spam preventa+now on first sight.
- **Same-run preventa + now:** an existing film that gains both categories in one
  scrape emits only `now-in-theaters` (not two notifications).
- **Preventa while in theaters:** gaining `AdvanceBooking` when the film already
  has (or also gains) `NowShowing` does not emit `preventa-opens`.
- **Empty / bulk bad catalogs:** an empty website film catalog with known films,
  malformed availability, a missing availability row for a previously categorized
  film, or an all-empty category response after a categorized catalog aborts
  before write. A run that would emit more removals than
  `max(10, 30% of previous film count)` (for catalogs ≥ 10) also aborts.
- **Quiet checks:** `lastRun` records the last catalog/state change, not the last
  successful scrape. An unchanged check leaves it alone and writes a success line
  to the service log instead of inventing a fresh public timestamp. The page
  compares release dates with that last-change date, so an unchanged overnight
  check does not silently rewrite the page. Changes to pending loss counters or
  corrected film metadata can advance `lastRun` without creating an announcement.

## Hard rules

- A failed fetch (or empty/bulk-removal abort) exits **before writing anything** —
  a bad scrape never looks like every film vanished.
- `posts.json`, `state.json`, and the scraper RSS snapshot are written atomically
  (temp + rename). Posts are written before state so a crash mid-write prefers
  re-emitting an event over losing it.
- Requests have 30-second timeouts. Catalog fetching has a 90-second deadline;
  the entire scrape has a 140-second deadline. Cancellation stops workers and
  prevents late data from being persisted. Git commands are asynchronous and
  bounded to 15 seconds each. Failure alerts have a separate 30-second timeout.
- New events are queued in `posts.json.pendingNotificationIds` together with their
  archived snapshots when notifications are enabled. Each successful delivery is
  acknowledged atomically. A failed delivery stays queued for the next successful
  scrape, including quiet runs. Disabling the webhook pauses delivery and does
  not queue new events. Historical archives without this field need no migration.
- Delivery is at least once. A crash after Discord accepts an event but before
  its acknowledgement is saved can repeat that event; Discord has no idempotency
  key for these requests. Already acknowledged events are not retried.
- Reruns with identical data are idempotent (no new posts, no git commit).

## Public feed window

`data/posts.json` is the full archive (append-only in normal scrapes). When
lifecycle rules change, run a one-shot offline hygiene pass to restage historical
`added` rows and drop preventa twins:

```bash
bun run scrape.ts --hygiene   # also accepts bare `hygiene`
```

That rewrites `data/posts.json` atomically and regenerates `docs/feed.xml` without scraping, notifying, or using git. Rebuild Astro to update the website. This is a one-off
historical repair, not the normal response to a corrected title, date, poster,
or other film metadata. Normal scrapes append announcements; the current catalog
uses the latest accepted metadata without rewriting old posts. The RSS feed and
HTML history show only the newest **`FEED_LIMIT` (100)** posts; the HTML current
catalog is separate from that window.

## Notifications (optional, Discord)

When `NOTIFY_WEBHOOK_URL` is set, the scraper posts one rich Discord embed per
**archived** lifecycle transition after files are saved but before git push. Each
embed shows the poster image, a clickable title linking to the Cinecolombia page
(https), synopsis, and a facts line (release date, runtime, rating, genres).

Notifications are **skipped on a virgin cold start** (same gate as archiving).

### Create the webhook

1. In Discord: **Server Settings** → **Integrations** → **Webhooks** →
   **New Webhook** (you need *Manage Webhooks* permission; admins have it).
2. Pick the target text channel, name it (e.g. "CineColombia"), optionally
   upload an avatar.
3. Click **Copy Webhook URL** — you'll get
   `https://discord.com/api/webhooks/<id>/<token>`.

The second URL segment is a secret token. Anyone with the full URL can post to
that channel, so keep it in the chmod-600 env file and never commit it.

### Enable it

Add the URL to `/etc/cineco.env`:

```
NOTIFY_WEBHOOK_URL=https://discord.com/api/webhooks/...
```

Restart the timer to pick up the new env var:

```bash
sudo systemctl restart cineco.service
```

To disable: comment out the line and restart. No code changes needed.

Failed runs also send a Discord alert to `NOTIFY_WEBHOOK_URL`, including the
error and time. To route failures to a separate channel, set
`FAILURE_WEBHOOK_URL` in `/etc/cineco.env`. An explicitly empty
`FAILURE_WEBHOOK_URL=` disables failure alerts. Each failed run attempts one
alert, including fetch errors, catalog safety aborts, and git failures. Alert
delivery has a 30-second timeout; if delivery fails, the original run still
fails and journald records the delivery failure. URLs, configured credentials,
and bearer tokens are redacted from the alert.

These alerts cover errors caught by the scraper. A host outage, process kill,
or systemd timeout needs an external monitor because the process cannot send
an alert after it has stopped. Offline `--hygiene` does not send alerts.

## Ops / logs

A successful fetch and save logs its observation time before notification and
optional git push. The summary line follows a successful push; if a push fails,
the observation remains in journald even though `scrape ok` is absent:

```
observedAt=2026-09-25T23:00:32.815Z
scrape ok films=72 events=2 types=added:1,now-in-theaters:1 durationMs=4200
# or, after the observation line on a virgin install:
cold start: 60 films seeded, 0 events archived durationMs=8000
```

When `CINECO_GIT_PUSH=1`, each run does `git pull --rebase` **first** (so a
laptop push does not leave the server unable to push), then after a successful
scrape commits only if `data/` or `docs/` changed, and always tries `git push`
(so an earlier failed push is retried even on a quiet run). Subjects look like:

```
ci: update feed (added:2, removed:1)
ci: update catalog
```

## Deploy (bare-metal Fedora)

### Website hosting on Cloudflare Workers

This machine builds Astro and uploads the completed `dist/` directory with
Wrangler. Cloudflare only serves static assets. There is no Cloudflare build
command and no Git-triggered deployment. GitHub Actions only runs checks.

```bash
bun install --frozen-lockfile
npx wrangler login --device  # authorize this machine once from any browser
bun run deploy              # local Astro build, then Wrangler upload
```

Disconnect the Worker's repository in Cloudflare Settings → Builds before
pushing changes. The OAuth login needs separate Workers CI permissions to
manage that connection through the Builds API.

Set `CINECO_DEPLOY=1` in `/etc/cineco.env` to build and deploy after each
successful scheduled scrape, including quiet observations so failed uploads
are retried. The scheduled runner needs Node 22.12+ in `/usr/local/bin`, plus a Wrangler
login under its own home directory. `CINECO_NODE` can select another Node
executable for manual runs. Install dependencies in the
production checkout after updates. Build and upload each have a 120-second
limit; the service allows 420 seconds for the complete operation.

`FEED_TITLE` and `FEED_URL` control build-time feed metadata. The default RSS self URL is `https://cinecolombia.cpzhmlb.uk/feed.xml`. `CINECO_DATA_DIR` and
`CINECO_DIST_DIR` override inputs and outputs for isolated build verification.
A website build never fetches the live catalog or sends notifications.

```bash
bun run build
npx wrangler deploy --dry-run
```

### Scraper service

```bash
# Install bun system-wide: systemd (Fedora SELinux) cannot exec binaries in
# /home (user_home_t) — it fails with status=203/EXEC "Permission denied".
sudo install -m 0755 -o root -g root ~/.bun/bin/bun /usr/local/bin/bun
sudo restorecon -v /usr/local/bin/bun

sudo cp systemd/cineco.service systemd/cineco.timer /etc/systemd/system/
sudo cp cineco.env.example /etc/cineco.env && sudo chmod 600 /etc/cineco.env
# edit /etc/cineco.env with TMDB_API_KEY, FEED_URL, CINECO_GIT_PUSH=1,
# and optionally NOTIFY_WEBHOOK_URL (see Notifications above)
sudo chown camilo:camilo /etc/cineco.env          # service runs as camilo
sudo chown -R camilo:camilo /srv/cinecolombia-check
sudo systemctl enable --now cineco.timer
```

The service runs as `camilo` and execs `/usr/local/bin/bun` (see the install
step above — `bun upgrade` only refreshes `~/.bun/bin/bun`, so re-run the
`install` line to update the version the service uses). The unit sets
`TimeoutStartSec=420`. Git push authenticates via an SSH deploy key in `~/.ssh`
(add the public key as a write deploy key on the GitHub repo). Flow when
`CINECO_GIT_PUSH=1`:

```
git pull --rebase → scrape → write files → git commit (if dirty) → git push
```

A failed pull aborts before scrape. A failed push leaves local state saved; the
next run pulls again and retries push.
