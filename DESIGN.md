# CineColombia feed — Design

A static site + RSS feed that posts whenever a film changes lifecycle state on
CineColombia. A scheduled scraper runs on a bare-metal Fedora Server, diffs
the live CineColombia OCAPI data against stored state, and pushes the
regenerated output to GitHub Pages.

API reference: [`CINECO_RESEARCH.md`](./CINECO_RESEARCH.md) (captured
2026-07-01).

## Product

- **Webpage** (`/docs/index.html`): reverse-chrono list of event posts as HTML
  cards — poster, event label + film title, synopsis, key facts, link to the
  film's CineColombia page.
- **Feed** (`/docs/feed.xml`): RSS 2.0, same posts, es-CO.
- **Audience/language**: Spanish (es-CO), matching CineColombia's data.

## The 4 events

Each lifecycle transition produces one post.

| Event | Triggered when | Label (es-CO) |
|---|---|---|
| added | new `filmId` appears in `/films` | `Pronto: <title>` |
| preventa opens | film gains `AdvanceBooking` category | `Preventa abierta: <title>` |
| now in theaters | film gains `NowShowing` category | `En cartelera: <title>` |
| removed | `filmId` leaves `/films` entirely | `Ya no disponible: <title>` |

- `added` fires for **every** new film, including bare ComingSoon stubs.
- A film going to `[]` categories stays in state — no event.
- Category losses that are not a full removal do **not** post (e.g. a film
  dropping `AdvanceBooking` while still `NowShowing`).
- A film that is removed then later re-added produces a new `added` post.

## Data sources (per run)

1. `curl-impersonate` (Chrome fingerprint) `GET https://www.cinecolombia.com/`
   → extract `window.initialData.api.authToken` from the SPA seed. Token is
   re-extracted fresh each run (~12 h life, never cached long-term).
2. Plain `fetch` against OCAPI with `Authorization: Bearer <token>`:
   - `GET /ocapi/v1/films` — catalog + `relatedData` (cast, genres, censor).
   - `GET /ocapi/v1/films/availability` — `categories[]` per film (the state
     signal).
   - `GET /ocapi/v1/sites` — **skipped in v1** (no per-cinema scoping; YAGNI).
3. `GET https://www.cinecolombia.com/sitemap.xml` (no auth, no impersonation)
   → map `filmId` (`HO-id` segment) → public web URL for post links.

## Diff logic

- Load previous `/data/state.json`: per-film `categories[]` + cached display
  snapshot + TMDB cache.
- Build current map: `filmId → categories[]` from `/films` + `/availability`.
- Detect the 4 events (see table).
- Append new posts to `/data/posts.json`.
- Save new `/data/state.json`.

## Posts

- `/data/posts.json` — append-only, **full history, no trimming** (volume is a
  few events/week, ~200/year).
- Each post stores a **self-contained film snapshot at event time**: title,
  shortSynopsis, releaseDate, runtimeInMinutes, censor rating, genres,
  director, web URL, poster URL. This makes feed regen independent of the live
  API, and lets `removed` posts render from the cached snapshot even though the
  film is gone from the API.
- Each post has a **stable GUID generated once at detection and stored** — feed
  readers never re-alert on regeneration.
- Timestamps: ISO-8601 with offset, stored UTC, displayed in `America/Bogota`.

## TMDB posters

- For each new film: `GET https://api.themoviedb.org/3/search/movie?query=<title>&year=<releaseDate year>&language=es-CO`,
  take top result, poster = `https://image.tmdb.org/t/p/w500<poster_path>`.
- Cache `filmId → { tmdbId, posterPath }` in `state.json` so we look up **once
  per film ever** (not per event).
- No match (or no year to disambiguate) → no poster, graceful fallback.
- TMDB is **image-only**; CineColombia stays the source of truth for all text
  and state. Requires `TMDB_API_KEY`.

## Feed + page output

- `/docs/feed.xml` — RSS 2.0, `<media:content>` for posters, `language=es-CO`,
  feed title `CineColombia — Cartelera y Preventa`, self link to the Pages URL.
- `/docs/index.html` — same posts, reverse-chrono HTML cards.
- Minimal inline CSS, no framework, responsive.

## Cadence + scheduler

- systemd timer, `OnCalendar=*-*-* 00/6:00` (every 6 h), `Persistent=true`
  (catches up missed runs after downtime/reboot).
- Bare-metal Fedora Server, always-on.
- Scraper is idempotent, so a missed/delayed run just delays detection (we
  cannot know the exact moment CineColombia flipped a film's state).

## Repo layout

```
/                     # scraper source: scrape.ts, package.json, README, …
/docs/                # GitHub Pages serves this on main
  feed.xml
  index.html
/data/                # committed for persistence, NOT served
  posts.json          # append-only event archive
  state.json          # current film states + TMDB cache
```

## Deploy + auth

- Scraper writes `/docs` + `/data`, then commits **only if** `git diff` shows
  changes, and pushes `main`.
- No empty commits, no force-push. If push fails (non-fast-forward): log and
  abort; state is already saved, next run retries.
- Git push authenticates via an **SSH deploy key** on the GitHub repo (no
  expiry, no token rotation).

## Secrets

- `TMDB_API_KEY` — read from env var via the systemd unit
  `EnvironmentFile=/etc/cineco.env` (chmod 600, gitignored).
- Git push — SSH key on the server, public key added as a write deploy key on
  the GitHub repo.

## Hard rules

- **Fetch failure aborts cleanly.** Any failure (Cloudflare block, 401,
  network) → exit non-zero, **no state change, no posts**. A failed scrape must
  never look like every film vanished.
- **Idempotent detection.** A transition already recorded in `posts.json` is
  not re-emitted; `state.json` + `posts.json` are written atomically (temp
  files + rename) so a crashed-then-rerun scrape doesn't duplicate posts.

## Prerequisites to build / deploy

- [ ] TMDB API key (free, register + request).
- [ ] `curl-impersonate` binary on the Fedora server.
- [ ] Bun on the Fedora server.
- [ ] GitHub repo with Pages enabled on `/docs` / `main`.
- [ ] SSH deploy key (write) added to the repo.
- [ ] `/etc/cineco.env` with `TMDB_API_KEY=…`, chmod 600.

## Scraper stack

- **Bun + TypeScript**, single file. Stdlib + git CLI only, no frameworks.
- Shell out to `curl-impersonate` for the Cloudflare-protected token; plain
  `fetch` for OCAPI and sitemap; `fetch` for TMDB.
- Dev on WSL2/Arch; production on bare-metal Fedora Server.

## Assumed defaults (override if needed)

- `/sites` skipped in v1 (no per-cinema scoping).
- Feed title: `CineColombia — Cartelera y Preventa`; `language=es-CO`.
- Post timestamps displayed in `America/Bogota`.
- Minimal inline CSS, no CSS/JS framework.
