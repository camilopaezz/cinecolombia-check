import type { FilmRecord, State } from "./domain";

/** Prefer populated TMDB data. MovieXchange's protected CDN cannot be hotlinked. */
export function resolvePoster(film: FilmRecord, cache: State["tmdbCache"] = {}): string | null {
  const path = cache[film.id]?.posterPath ?? film.tmdb?.posterPath;
  if (path) return `https://image.tmdb.org/t/p/w500${path}`;
  if (film.posterUrl?.startsWith("https://film-cdn.moviexchange.com/")) return null;
  return film.posterUrl;
}
