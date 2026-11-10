import { it, expect } from "bun:test";
import { resolvePoster } from "./posters";
import { enrichPosters } from "./scrape";
import { generateFeed } from "./presentation";
import type { FilmRecord } from "./domain";
const protectedFilm = (): FilmRecord => ({ id: "HO1", title: "Film", shortSynopsis: "", releaseDate: null,
  runtimeInMinutes: null, censorRating: "", genres: [], director: "", webUrl: "", categories: [],
  posterUrl: "https://film-cdn.moviexchange.com/api/cdn/release/example/media/Poster?width=200" });
it("uses populated TMDB posters without an API key or changing historical snapshots", async () => {
  const film = protectedFilm();
  const snapshot = structuredClone(film);
  const cache = { HO1: { tmdbId: 1, posterPath: "/poster.jpg" } };
  const url = "https://image.tmdb.org/t/p/w500/poster.jpg";
  expect(resolvePoster(snapshot, cache)).toBe(url);
  await enrichPosters([film], cache, undefined, async () => { throw new Error("must not fetch"); });
  expect(film.posterUrl).toBe(url);
  expect(snapshot).toEqual(protectedFilm());
  const rss = generateFeed([{ guid: "g1", filmId: snapshot.id, type: "added", createdAt: "2026-11-10T00:00:00Z", snapshot }],
    { feedTitle: "Feed", feedUrl: "https://example.com/feed.xml", language: "es-CO", tmdbCache: cache });
  expect(rss).toContain(url);
  expect(rss).not.toContain("moviexchange");
});
it("looks up TMDB even when the website provides a protected MovieXchange URL", async () => {
  const film = protectedFilm();
  let lookups = 0;
  await enrichPosters([film], {}, "key", async () => { lookups++; return { tmdbId: 2, posterPath: "/found.jpg" }; });
  expect(lookups).toBe(1);
  expect(film.posterUrl).toBe("https://image.tmdb.org/t/p/w500/found.jpg");
});
it("keeps usable external links and hides protected URLs when no match is available", async () => {
  expect(resolvePoster(protectedFilm())).toBeNull();
  const film = protectedFilm();
  await enrichPosters([film], {}, undefined, async () => { throw new Error("must not fetch"); });
  expect(film.posterUrl).toBeNull();
  expect(resolvePoster({ ...film, posterUrl: "https://example.com/image.jpg" })).toBe("https://example.com/image.jpg");
});
