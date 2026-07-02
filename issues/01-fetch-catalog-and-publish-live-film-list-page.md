---
title: "Fetch catalog and publish live film list page"
labels: ready-for-agent
---

## What to build

A Bun/TypeScript scraper that runs end-to-end against the live Cinecolombia OCAPI and produces the first verifiable output: a stored snapshot of the current film catalog and a responsive HTML page listing all films.

The slice must:
- Obtain a fresh RS256 JWT by calling the Cinecolombia homepage with a Chrome-impersonating TLS client (`curl-impersonate`) and extracting `window.initialData.api.authToken` from the SPA seed.
- Call `GET /ocapi/v1/films` to fetch the catalog and related reference data (genres, censor ratings, cast/crew).
- Call `GET /ocapi/v1/films/availability` to read the current `categories[]` for each film.
- Call `GET https://www.cinecolombia.com/sitemap.xml` with a plain fetch and map each `film.id` to its public web URL by matching the `HO-id` segment.
- Build a per-film record that includes title, short synopsis, release date, runtime, censor rating, genres, director, web URL, and current lifecycle categories.
- Persist the snapshot to a `state.json` file, written atomically via a temporary file and rename.
- Render a static HTML page (`index.html`) in es-CO with minimal inline CSS, responsive layout, and a list of all current films. No RSS or event feed yet.
- Abort cleanly with a non-zero exit on any fetch or parse failure, leaving the previous `state.json` and `index.html` untouched.

## Acceptance criteria

- [ ] A single Bun script can be run and completes the full fetch-and-write path without manual intervention.
- [ ] `state.json` is created and contains every film from the OCAPI response with web URL and current categories.
- [ ] `index.html` is regenerated and renders each film's title, short synopsis, release date, censor rating, genres, and a link to the Cinecolombia film page in Spanish.
- [ ] A failed OCAPI or sitemap fetch aborts before writing any files, and the previous files remain unchanged.
- [ ] A test uses captured OCAPI/sitemap fixtures to verify the generated `state.json` and `index.html` match expected content.

## Blocked by

- None - can start immediately.

## User stories covered

- 1 (partial), 2, 3, 5, 8, 9, 12
