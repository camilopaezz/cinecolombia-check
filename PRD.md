# PRD — CineColombia Lifecycle Feed

## Problem Statement

CineColombia publishes dozens of films and lifecycle transitions (nuevos estrenos, preventas, films saliendo de cartelera) on its website, but there is no channel to subscribe to those changes. Moviegoers must visit the site repeatedly to catch new announcements, advance-booking windows, or removals. The project therefore needs a small, reliable scraper that turns those lifecycle changes into a stable Spanish-language RSS feed and a companion HTML page.

## Solution

A single scheduled Bun/TypeScript scraper polls the CineColombia OCAPI every 6 hours, diffs the live film catalog and availability state against a stored snapshot, and emits an append-only event archive. Four lifecycle events are surfaced: a new film appearing, a film opening advance booking, a film entering "now showing", and a film leaving the catalog. Each event is stored as a self-contained snapshot with a stable GUID, and the archive is rendered into an RSS 2.0 feed and a static HTML page. The scraper pushes regenerated output to GitHub Pages via an SSH deploy key, only when something has changed.

## User Stories

1. As a moviegoer, I want to subscribe to an RSS feed of CineColombia lifecycle changes, so that I can be notified when new films are announced, advance booking opens, or films leave theaters.
2. As a Spanish-speaking moviegoer, I want the feed and page to be in es-CO, so that the language matches the CineColombia site.
3. As a moviegoer, I want each post to include the film title and a short synopsis, so that I can decide whether to investigate further.
4. As a moviegoer, I want each post to include a poster image when available, so that I can visually identify the film.
5. As a moviegoer, I want each post to link to the official CineColombia film page, so that I can go straight to tickets or details.
6. As a feed subscriber, I want stable post GUIDs, so that my feed reader does not re-alert me every time the feed regenerates.
7. As a feed subscriber, I want posts ordered newest-first, so that the latest changes are immediately visible.
8. As a website visitor, I want a clean HTML page listing all events, so that I can browse without installing an RSS reader.
9. As a mobile visitor, I want the page to be readable on a small screen, so that I can check it from any device.
10. As a moviegoer, I want a post when a film is removed from the catalog, so that I know it is no longer available.
11. As a maintainer, I want the scraper to run automatically on a schedule, so that I do not have to trigger it manually.
12. As a maintainer, I want any failed scrape to abort cleanly, so that a network or Cloudflare problem does not cause every film to appear as removed.
13. As a maintainer, I want the scraper to be idempotent, so that rerunning it does not duplicate posts or mutate state.
14. As a maintainer, I want each event to store the film snapshot at detection time, so that removed posts still render correctly even after the film is gone from the API.
15. As a maintainer, I want to cache TMDB poster lookups per film, so that I do not repeatedly hit the TMDB API for the same title.
16. As a maintainer, I want deployment to use a non-expiring SSH deploy key, so that I do not have to rotate OAuth tokens on the server.
17. As a maintainer, I want the scraper to commit and push only when there is a real change, so that the repository history is not polluted with empty commits.

## Implementation Decisions

- The scraper will be a single TypeScript script executed with Bun, using the standard library and the system `git` CLI only. No web frameworks or HTTP libraries are added.
- Authentication will be obtained by calling the Cinecolombia homepage with a Chrome-impersonating TLS client (`curl-impersonate`), extracting `window.initialData.api.authToken` from the SPA seed, and using that RS256 JWT as the `Authorization: Bearer` token for OCAPI calls. The token is extracted fresh on every run and not cached long-term.
- The scraper will call `GET /ocapi/v1/films` for the catalog and related reference data (cast, genres, censor ratings) and `GET /ocapi/v1/films/availability` for the per-film `categories[]` state signal. `GET /ocapi/v1/sites` is intentionally omitted in v1 because per-cinema scoping is not needed.
- The scraper will call `GET https://www.cinecolombia.com/sitemap.xml` with a plain fetch, requiring no auth or impersonation, to map each `film.id` (the `HO-id` segment) to its canonical public URL.
- Diff logic will load the previous `state.json` file, build a current `filmId → categories[]` map, and emit the four supported events: `added`, `preventa opens`, `now in theaters`, and `removed`. A film transitioning to an empty category list stays in state with no event; category loss that is not a full removal is ignored. A removed film that reappears later produces a new `added` event.
- Two data files are stored in the repo: `posts.json` is an append-only archive of all events with a self-contained snapshot and a stable GUID; `state.json` holds the current per-film categories, display snapshots, and TMDB cache. Both are written atomically via temporary files followed by a rename.
- Poster images will be fetched from TMDB by searching with the film title and release year, taking the first result, and forming a `w500` poster URL. The mapping `filmId → {tmdbId, posterPath}` is cached in `state.json` so each film is looked up once. If there is no match, no poster is rendered and the post remains functional.
- Output generation reads the entire `posts.json` archive and regenerates both the RSS feed and the HTML page. The RSS 2.0 feed uses `media:content` for posters, `language=es-CO`, stable GUIDs, and a self link to the Pages URL. The HTML page uses minimal inline CSS and a reverse-chronological card list.
- Deployment is performed by the scraper itself after a successful scrape: it checks `git diff`, commits and pushes only if the generated files or data changed, and pushes via the SSH deploy key already installed on the server. If push fails because of a non-fast-forward update, the scraper logs the error and aborts; the next run retries with the updated state.
- Scheduling is a `systemd` timer running every 6 hours with `Persistent=true` so missed runs are caught after downtime or reboot.
- The system stores timestamps in UTC with an offset and displays them in `America/Bogota`.

## Testing Decisions

- Good tests verify external behavior, not internal implementation. A test should exercise a complete scrape or a complete feed/page generation from a known archive, and assert the resulting files and state, rather than checking the structure of private functions.
- The primary test seam is the scraper run: provide captured OCAPI fixtures and a previous `state.json`, run the scraper, and assert the new `state.json`, `posts.json`, `feed.xml`, and `index.html` match the expected events. This is the highest seam because it covers authentication, fetching, diffing, archiving, and output generation together.
- A secondary seam is the output generator: given a fixture `posts.json`, assert that the generated `feed.xml` is valid RSS 2.0 with stable GUIDs and correct `media:content` tags, and that the generated `index.html` contains the expected posts in reverse-chronological order.
- A lower-level seam is the diff engine: feed a previous categories map and a current categories map, and assert the exact list of emitted events. This should only be used if regressions in the primary seam are hard to diagnose.
- There is no prior art in this repo; tests will be written alongside the first implementation.

## Out of Scope

- Per-cinema availability, showtimes, sessions, and ticket purchase flows.
- Integration of the `GET /ocapi/v1/sites` endpoint or any cinema-specific scoping.
- Multi-language support beyond es-CO.
- Email, push, or webhook notifications; only RSS and the static HTML page are supported.
- Analytics, dashboards, or an admin UI.
- Retry logic, partial updates, or advanced error recovery beyond the hard rule of aborting on any fetch failure.
- Using Cinecolombia-hosted poster art; TMDB is the only image source in v1.
- Pagination handling in OCAPI endpoints; the current design assumes full-set responses as observed in the 2026-07-01 capture.

## Further Notes

- The Cinecolombia homepage sits behind Cloudflare, so a Chrome-impersonating TLS client is required to obtain the token. The OCAPI host itself is not challenged.
- The JWT has an observed lifetime of roughly 12 hours. The 6-hour timer gives two attempts per token and allows a fresh extraction before the previous one expires.
- All localized text fields in OCAPI use the shape `{ "text": string, "translations": [...] }`. The implementation should read the `text` field for the es-CO value.
- Reference data counts (genres, censor ratings, attributes, sites) and enum values reflect the 2026-07-01 capture and should be treated as dynamic data, not constants.
- The sitemap contains canonical film URLs and is not behind Cloudflare, so it can be fetched with a normal HTTP client.
- `added` events will fire for every new film in the catalog, including bare `ComingSoon` stubs without booking open yet.
