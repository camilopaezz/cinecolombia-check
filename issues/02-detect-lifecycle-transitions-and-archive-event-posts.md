---
title: "Detect lifecycle transitions and archive event posts"
labels: ready-for-agent
---

## What to build

Extend the scraper to remember the previous state, detect lifecycle changes in the current run, and archive each detected event as an append-only post with a stable GUID and a self-contained snapshot.

The slice must:
- Load the previous `state.json` before fetching the current state.
- Build a current `filmId → categories[]` map from the live `/films` and `/films/availability` responses.
- Emit exactly four event types:
  - `added`: a `filmId` appears in the current catalog but was absent in the previous state.
  - `preventa opens`: a film gains the `AdvanceBooking` category since the previous state.
  - `now in theaters`: a film gains the `NowShowing` category since the previous state.
  - `removed`: a `filmId` was present in the previous state but is absent from the current catalog.
- Ignore category losses that are not full removals (e.g. dropping `AdvanceBooking` while still `NowShowing`) and treat a transition to `[]` as a non-event.
- Append each detected event to `posts.json` with a stable, randomly generated GUID stored once, a timestamp in `America/Bogota`, and a snapshot of the film at detection time (title, short synopsis, release date, runtime, censor rating, genres, director, web URL, poster URL placeholder).
- Regenerate `state.json` atomically with the new current categories and snapshots.
- Render the `index.html` page from the archive of `posts.json` as a reverse-chronological list of event posts in Spanish.
- Generate a valid RSS 2.0 `feed.xml` from the same archive, with `language=es-CO`, stable GUIDs, and a self link to the Pages URL.
- Be idempotent: re-running with the same input must not add new posts or change stable GUIDs.
- Continue to abort cleanly on any fetch failure without mutating `state.json` or `posts.json`.

## Acceptance criteria

- [ ] Fixtures representing a previous state and a current state produce the expected event list (added, preventa opens, now in theaters, removed).
- [ ] Each event is written to `posts.json` with a stable GUID and a complete film snapshot.
- [ ] Re-running the scraper against the same fixtures produces no new `posts.json` entries.
- [ ] `feed.xml` validates as RSS 2.0 and includes every post with the correct title, link, and timestamp.
- [ ] `index.html` lists posts newest-first and uses the Spanish-language film snapshot.
- [ ] A removed film still has a rendered post because the snapshot is preserved in the archive.
- [ ] A failed fetch aborts without touching `state.json` or `posts.json`.

## Blocked by

- #1 — Fetch catalog and publish live film list page

## User stories covered

- 1, 6, 7, 10, 13, 14
