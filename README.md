# CineColombia Lifecycle Feed

A scheduled Bun/TypeScript scraper that watches the Cinecolombia OCAPI for film
lifecycle changes (added, advance booking opens, now in theaters, removed) and
publishes them as a Spanish-language RSS feed + static HTML page on GitHub Pages.

See [`PRD.md`](./PRD.md) and [`issues/`](./issues/) for the spec, and
[`CINECO_RESEARCH.md`](./CINECO_RESEARCH.md) for the API reference.

## Run

```bash
bun install
bun run scrape.ts   # one-shot scrape; writes data/ and docs/
bun test            # tests
bun run typecheck   # tsc --noEmit
```

The scraper reads `TMDB_API_KEY`, `FEED_URL`, and `CINECO_GIT_PUSH` from the
environment (see `cineco.env.example`). It shells out to `curl_chrome136` to
pass Cloudflare on the Cinecolombia homepage and fetch a fresh OCAPI token each
run.

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
# edit /etc/cineco.env with TMDB_API_KEY, FEED_URL, CINECO_GIT_PUSH=1
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
