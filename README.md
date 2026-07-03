# CineColombia Lifecycle Feed

A scheduled Bun/TypeScript scraper that watches the Cinecolombia OCAPI for film
lifecycle changes (added, advance booking opens, now in theaters, removed) and
publishes them as a Spanish-language RSS feed + static HTML page, with optional
Discord notifications on each transition.

See [`PRD.md`](./PRD.md) and [`issues/`](./issues/) for the spec, and
[`CINECO_RESEARCH.md`](./CINECO_RESEARCH.md) for the API reference.

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
docs/                # GitHub Pages: feed.xml + index.html
systemd/             # cineco.service + cineco.timer
```

## Hard rules

- A failed fetch aborts before writing anything — a bad scrape never looks like
  every film vanished.
- `state.json` / `posts.json` are written atomically (temp + rename); reruns are
  idempotent.
- A failed notification is logged to stderr and never aborts the scrape — same
  fail-safe philosophy as TMDB enrichment.

## Notifications (optional, Discord)

When `NOTIFY_WEBHOOK_URL` is set, the scraper posts one rich Discord embed per
lifecycle transition (added, preventa opens, in theaters, removed) after files
are saved but before git push. Each embed shows the poster image, a clickable
title linking to the Cinecolombia page, synopsis, and a facts line (release
date, runtime, rating, genres).

Notifications are **skipped on a cold start** (first run with empty state) so
the initial catalog import doesn't spam your channel — only subsequent
transitions trigger pings.

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
`install` line to update the version the service uses). Git push authenticates
via an SSH deploy key in `~/.ssh` (add the public key as a write deploy key on
the GitHub repo). The scraper only commits when `git diff` shows changes, and
aborts on a non-fast-forward push (next run retries).
