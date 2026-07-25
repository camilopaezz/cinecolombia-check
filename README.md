# CineColombia Lifecycle Feed

A scheduled Bun/TypeScript scraper that watches the Cinecolombia OCAPI for film
lifecycle changes (added, advance booking opens, now in theaters, removed) and
publishes them as a Spanish-language RSS feed + static HTML page, with optional
Discord notifications on each transition.

See [`issues/`](./issues/) for the original issue breakdown.

## Run

```bash
bun install
bun run scrape.ts   # one-shot scrape; writes data/ and docs/
bun test            # tests
bun run typecheck   # tsc --noEmit
```

The scraper reads `TMDB_API_KEY`, `FEED_URL`, `CINECO_GIT_PUSH`, and
`NOTIFY_WEBHOOK_URL` from the environment (see `cineco.env.example`). It shells
out to `curl_chrome136` to pass Cloudflare on the Cinecolombia homepage and
fetch a fresh OCAPI token each run.

## Layout

```
scrape.ts            # the scraper (single file)
data/                # committed: posts.json (archive) + state.json (current)
docs/                # GitHub Pages: feed.xml + index.html (newest 100 posts)
systemd/             # cineco.service + cineco.timer
```

## Lifecycle events

| Event | When | Label (es-CO) |
|---|---|---|
| `added` | new `filmId` appears | Pronto |
| `preventa-opens` | film gains `AdvanceBooking` | Preventa abierta |
| `now-in-theaters` | film gains `NowShowing` | En cartelera |
| `removed` | film absent for `REMOVAL_THRESHOLD` (2) consecutive successful runs | Ya no disponible |

Notes:

- **Cold start (virgin install only):** empty previous films, no `lastRun`, and empty
  `posts.json` → seed `state.json` only. No archive entries, no Discord spam.
  After a real wipe (history present), reappearing films *do* archive as `added`.
- **Removal debounce:** a one-run catalog blip does not emit `removed`. The film
  stays soft-kept in `state.films` with `missingRuns[id]`. At threshold 2 it is
  removed. If it returns under threshold, no `removed` and no `added`.
- **Same-run preventa + now:** an existing film that gains both categories in one
  scrape emits only `now-in-theaters` (not two notifications).
- **Empty / bulk bad catalogs:** empty OCAPI catalog with known films aborts
  before write. A run that would emit more removals than
  `max(10, 30% of previous film count)` (for catalogs ≥ 10) also aborts.
- **Quiet runs:** `lastRun` is only updated when films / missingRuns / posts
  actually change, so git is not dirtied every 6 hours.

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

`data/posts.json` is the full append-only archive. `docs/feed.xml` and
`docs/index.html` render only the newest **`FEED_LIMIT` (100)** posts so the
GitHub Pages surface stays small.

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

Each successful run prints one line to stdout (captured by journald):

```
scrape ok films=72 events=2 types=added:1,now-in-theaters:1 durationMs=4200
# or
cold start: 60 films seeded, 0 events archived durationMs=8000
```

Git commits (when `CINECO_GIT_PUSH=1`) only happen if `data/` or `docs/` changed,
with subjects like:

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
(add the public key as a write deploy key on the GitHub repo). The scraper only
commits when `docs/` or `data/` changed, and aborts on a non-fast-forward push
(local state is already saved; the next dirty run retries push).
