# Context — domain glossary & seam map

AI-navigability notes for the single-file scraper (`scrape.ts`). Product story lives in `README.md`; issue history in `issues/`.

## Layout (seams)

| Path / symbol | Role |
|---|---|
| `scrape.ts` | Entire app: fetch → lifecycle → persist → project → notify/git |
| `scrape.test.ts` | Policy + projection + main integration tests |
| `data/state.json` | **State**: current `films`, `missingRuns`, `tmdbCache`, `lastRun` |
| `data/posts.json` | **Archive** (`PostArchive`): append-only lifecycle events |
| `docs/feed.xml`, `docs/index.html` | Public surfaces (newest `FEED_LIMIT` = 100) |
| `Deps` / `liveDeps` / `MainOptions.deps` | Injectable I/O (token, OCAPI, sitemap, TMDB, now, uuid, notify) for tests |
| `applyLifecycle` | Core transition engine (new / gains / soft-missing removals) |
| `runLifecycle` | Full policy wrap: empty/bulk guards, cold start, archive set, quiet `lastRun` |
| Event projection | `eventTitle`, `factsLine`, `clipSynopsis`, `windowNewest` → RSS / HTML bitácora / Discord |
| `sanitizeArchivePosts` | Pure offline archive repair (restage + drop preventa twins); not on scrape path |
| `runArchiveHygiene` | CLI home for hygiene: load/sanitize/save `posts.json` + regen feed/html; `--hygiene` / `hygiene` |

`main()` optionally `git pull --rebase` first (when `CINECO_GIT_PUSH`), then fetches + enriches posters, calls `runLifecycle`, writes posts → state → feed/html, notifies, optional git commit/push. Prefer `runLifecycle` over calling `applyLifecycle` alone when testing policy.

## Glossary

| Term | Meaning |
|---|---|
| **EventType** | `added` · `preventa-opens` · `now-in-theaters` · `removed` (labels es-CO: Pronto / Preventa abierta / En cartelera / Ya no disponible) |
| **Highest stage / first sight** | New `filmId` emits one event via `announcementType`: NowShowing → `now-in-theaters`, else AdvanceBooking → `preventa-opens`, else `added` |
| **Soft-missing** | Absent film still kept in `state.films` with `missingRuns[id]` under threshold; reappearance clears counter, no `added` |
| **REMOVAL_THRESHOLD** | `2` consecutive successful absences before `removed` (debounce one-run catalog blips) |
| **Cold start** | Virgin install only: empty `prev.films`, no `lastRun`, empty archive → seed state, **no** archive/notify. Wipe with history still archives re-adds at highest stage |
| **Quiet run** | No meaningful change → `lastRun` unchanged → no dirty git on identical catalogs |
| **Bulk guard** | Abort before write if empty OCAPI catalog with known films, or removals > `max(10, 30% of prev)` when prev ≥ 10 (`maxRemovalsAllowed` / `MAX_REMOVAL_FRACTION`) |
| **Archive** | `posts.json` full history; public feed/HTML window via `windowNewest` |
| **Bitácora** | Editorial HTML page (es-CO, Bogotá) — ficha cards, mono event codes |
| **sanitizeArchivePosts** | Pure one-shot repair: restage historical `added` to highest stage from snapshot; drop same-timestamp preventa twins / preventa while NowShowing |
| **runArchiveHygiene / `--hygiene`** | Offline entry (not scheduled): sanitize `data/posts.json`, rewrite feed/html; no scrape/notify/git |
| **Deps** | Pure domain stays free of fs/network; adapters injected for tests and live curl/fetch |

## Decisions (short)

- Stay **single-file** unless a real second adapter appears.
- Removal debounce **= 2**; fail-before-write on bad/empty/bulk catalogs.
- Posts written **before** state (prefer re-emit over lost events).
- Notify only on **archived** transitions (not virgin cold start). Git: pull --rebase before scrape; commit when dirty; push always when enabled.
- Projection helpers shared; formatters (RSS/HTML/Discord) stay thin.
