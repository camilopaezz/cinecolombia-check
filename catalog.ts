/** Adapter for Cine Colombia's public website API introduced in November 2026. */
import type { FilmRecord } from "./scrape";

export type CatalogRequest = (path: string) => Promise<any>;

export async function requestCatalog(path: string): Promise<any> {
  const res = await fetch(`https://www.cinecolombia.com/api/v1/${path}`, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`Cine Colombia API ${path} -> ${res.status}`);
  return res.json();
}

/** Availability is national; /films without a city returns an empty list. */
export async function fetchCatalog(request: CatalogRequest = requestCatalog): Promise<FilmRecord[]> {
  const data = await request("films/availability");
  if (!Array.isArray(data?.film_availabilities) || !data.film_availabilities.length) {
    throw new Error("invalid or empty national film availability");
  }
  const rows = data.film_availabilities;
  const ids = new Set<string>();
  for (const row of rows) {
    if (typeof row?.film_id !== "string" || !/^HO\w+$/.test(row.film_id) ||
        ids.has(row.film_id) || !Array.isArray(row.categories) ||
        !row.categories.every((c: unknown) => typeof c === "string") ||
        (row.showtime_attribute_ids !== undefined && (!Array.isArray(row.showtime_attribute_ids) ||
          !row.showtime_attribute_ids.every((v: unknown) => typeof v === "string")))) {
      throw new Error("malformed national film availability row");
    }
    ids.add(row.film_id);
  }
  const films: FilmRecord[] = new Array(rows.length);
  let cursor = 0;
  // Bound requests; any failed detail aborts the observation before persistence.
  await Promise.all(Array.from({ length: Math.min(6, rows.length) }, async () => {
    while (cursor < rows.length) {
      const index = cursor++;
      const row = rows[index];
      const detail = await request(`films/${encodeURIComponent(row.film_id)}`);
      const f = detail?.film;
      const related = detail?.related_data;
      if (f?.id !== row.film_id || typeof f.title !== "string" ||
          typeof f.slug !== "string" || !f.slug || !related ||
          !Array.isArray(related.genres) || !Array.isArray(related.cast_and_crew)) {
        throw new Error(`invalid film detail for ${row.film_id}`);
      }
      const categories = [...new Set<string>(row.categories)].sort();
      const attrs = [...new Set<string>(row.showtime_attribute_ids ?? [])].sort();
      const directorId = f.cast_and_crew?.find((c: any) => c.roles?.includes("Director"))?.member_id;
      films[index] = {
        id: f.id,
        title: f.title_es?.trim() || f.title,
        shortSynopsis: f.short_synopsis || f.synopsis || "",
        releaseDate: f.release_date ?? null,
        runtimeInMinutes: f.runtime_minutes ?? null,
        censorRating: f.censor_rating?.classification ?? f.classification ?? "",
        genres: [...new Set<string>((f.genre_ids ?? []).map((id: string) =>
          related.genres.find((g: any) => g.id === id)?.name).filter(Boolean))].sort(),
        director: related.cast_and_crew.find((c: any) => c.id === directorId)?.full_name ?? "",
        webUrl: `https://www.cinecolombia.com/peliculas/${encodeURIComponent(f.slug)}`,
        categories,
        availabilityRows: [{ siteId: null, categories, ...(attrs.length ? { showtimeAttributeIds: attrs } : {}) }],
        posterUrl: f.poster_url ?? null,
      };
    }
  }));
  return films.sort((a, b) => a.id.localeCompare(b.id));
}
