---
title: "Add TMDB poster images to posts and feed"
labels: ready-for-agent
---

## What to build

Enrich each new film with a poster image by querying TMDB, caching the result per film, and including the poster in both the RSS feed and the HTML page.

The slice must:
- For each film that has not yet been looked up, call `GET https://api.themoviedb.org/3/search/movie?query=<title>&year=<releaseDate year>&language=es-CO` with a `TMDB_API_KEY` supplied via environment variable.
- Take the first result and form a poster URL: `https://image.tmdb.org/t/p/w500<poster_path>`.
- Cache the mapping `filmId → { tmdbId, posterPath }` in `state.json` so each film is looked up once across the lifetime of the project.
- Store the poster URL in the film snapshot at the time of the event so that removed films render with their original poster.
- Include a `<media:content>` element in `feed.xml` for each post that has a poster URL.
- Display the poster image in the `index.html` event card when available; gracefully omit the image block when there is no match.
- Continue to function when the TMDB API is unavailable or returns no match: new films simply get no poster, and the scrape still succeeds.
- Keep TMDB image-only; Cinecolombia remains the source of truth for all text and lifecycle state.

## Acceptance criteria

- [ ] A new film with a TMDB match ends up with a cached `posterPath` in `state.json` and a rendered poster in `index.html` and `feed.xml`.
- [ ] A film already in the TMDB cache does not trigger a second search.
- [ ] A film with no TMDB result is still archived and rendered without a poster.
- [ ] A missing or invalid `TMDB_API_KEY` does not abort the scrape or corrupt `state.json` / `posts.json`; it simply yields no posters.
- [ ] Tests use a stub TMDB response to verify the cache, the generated poster URL, and the `media:content` tag.

## Blocked by

- #2 — Detect lifecycle transitions and archive event posts

## User stories covered

- 4, 15
