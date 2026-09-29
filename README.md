# CineColombia Lifecycle Feed

A scheduled Bun/TypeScript scraper that watches the Cinecolombia OCAPI for film
lifecycle changes (added, advance booking opens, now in theaters, removed) and
publishes them as a Spanish-language RSS feed + static HTML page, with optional
Discord notifications on each transition.

See [`issues/`](./issues/) for the original issue breakdown.
Domain terms: [`CONTEXT.md`](./CONTEXT.md).

## Run

```bash
bun install
bun run scrape.ts            # one-shot scrape; writes data/ and docs/
bun run scrape.ts --hygiene  # offline archive repair (restage + drop twins); no scrape/notify
bun test                     # tests
bun run typecheck            # tsc --noEmit
```

The scraper reads `TMDB_API_KEY`, `FEED_URL`, `CINECO_GIT_PUSH`, and
`NOTIFY_WEBHOOK_URL` from the environment (see `cineco.env.example`). It shells
out to `curl_chrome136` to pass Cloudflare on the Cinecolombia homepage and
fetch a fresh OCAPI token each run.

## Layout

```
scrape.ts            # the scraper (single file)
CONTEXT.md           # domain glossary
data/                # committed: posts.json (announcements) + state.json (current catalog)
docs/                # GitHub Pages: feed.xml (newest 100 posts) + index.html (catalog and history)
systemd/             # cineco.service + cineco.timer
```

The main path in `scrape.ts` fetches and enriches the catalog, calls
`runLifecycle`, saves posts before state, then renders RSS and HTML before
optional notification and git push. `applyLifecycle` handles transitions;
`runLifecycle` also applies abort guards, cold-start policy, and change tracking.
`generateFeed` projects posts; `generateHTML` projects posts plus current state.
The `Deps` adapter supplies network, clock, UUID, and notification operations to
tests and the live run. `sanitizeArchivePosts` and `runArchiveHygiene` belong to
the offline repair path, not scheduled scrapes. Policy, projection, and main-path
tests live in `scrape.test.ts`.

## What the data says

The scraper observes Cinecolombia's OCAPI catalog at each successful check. A film's
reported availability comes from its per-site category rows, such as `ComingSoon`,
`AdvanceBooking`, and `NowShowing`. A row may identify a site, but it does not
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
- **Empty / bulk bad catalogs:** an empty OCAPI film catalog with known films,
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
- `posts.json`, `state.json`, `feed.xml`, and `index.html` are written atomically
  (temp + rename). Posts are written before state so a crash mid-write prefers
  re-emitting an event over losing it.
- Network calls use timeouts (fetch 30s, curl-impersonate 60s).
- A failed notification is logged to stderr and never aborts the scrape — same
  fail-safe philosophy as TMDB enrichment.
- Reruns with identical data are idempotent (no new posts, no git commit).

## Public feed window

`data/posts.json` is the full archive (append-only in normal scrapes). When
lifecycle rules change, run a one-shot offline hygiene pass to restage historical
`added` rows and drop preventa twins:

```bash
bun run scrape.ts --hygiene   # also accepts bare `hygiene`
```

That rewrites `data/posts.json` atomically and regenerates `docs/feed.xml` +
`docs/index.html` without scraping, notifying, or using git. This is a one-off
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
ci: update feed (no events)
```

## Deploy (bare-metal Fedora)

```bash
# Install bun system-wide: systemd (Fedora SELinux) cannot exec binaries in
# /home (user_home_t) — it fails with status=203/EXEC "Permission denied".
sudo install -m 0755 -o root -g root ~/.bun/bin/bun /usr/local/bin/bun
sudo restorecon -v /usr/local/bin/bun

# Install curl-impersonate (provides curl_chrome136, used to bypass Cloudflare
# on the Cinecolombia homepage). Not bundled, not an npm dep — system binary.
# Asset: curl-impersonate-v1.5.6.x86_64-linux-gnu.tar.gz from
# https://github.com/lexiforest/curl-impersonate/releases
sudo mkdir -p /usr/local/curl-impersonate
sudo tar -xzf curl-impersonate-v1.5.6.x86_64-linux-gnu.tar.gz \
    -C /usr/local/curl-impersonate
sudo restorecon -Rv /usr/local/curl-impersonate
/usr/local/curl-impersonate/curl_chrome136 --version   # smoke test
# The service unit adds /usr/local/curl-impersonate to PATH so scrape.ts can
# invoke curl_chrome136 by bare name. Fedora ships ca-certificates already.

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
`TimeoutStartSec=180`. Git push authenticates via an SSH deploy key in `~/.ssh`
(add the public key as a write deploy key on the GitHub repo). Flow when
`CINECO_GIT_PUSH=1`:

```
git pull --rebase → scrape → write files → git commit (if dirty) → git push
```

A failed pull aborts before scrape. A failed push leaves local state saved; the
next run pulls again and retries push.
