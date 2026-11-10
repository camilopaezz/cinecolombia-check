/** National catalog adapter. Raw website responses never escape this module. */
import { abortable } from "./deadline";
import { z } from "zod";
import type { FilmRecord } from "./domain";

export type CatalogRequest = (path: string, signal?: AbortSignal) => Promise<unknown>;
const strings = z.array(z.string());
const nullableText = z.string().nullish();
const httpUrl = z.url().refine(v => /^https?:\/\//.test(v), "expected HTTP URL");
const releaseDate = z.iso.date().nullish();
const availabilitySchema = z.object({ film_availabilities: z.array(z.object({
  film_id: z.string().regex(/^HO\w+$/), categories: strings,
  showtime_attribute_ids: strings.optional(),
})).min(1) });
const detailSchema = z.object({
  film: z.object({
    id: z.string(), title: z.string().min(1), title_es: nullableText,
    slug: z.string().regex(/^[\w-]+$/), synopsis: nullableText, short_synopsis: nullableText,
    release_date: releaseDate, runtime_minutes: z.number().int().nonnegative().nullish(),
    classification: nullableText,
    censor_rating: z.object({ classification: z.string() }).nullish(),
    genre_ids: strings.optional(), poster_url: httpUrl.nullish(),
    cast_and_crew: z.array(z.object({ member_id: z.string(), roles: strings })).optional(),
  }),
  related_data: z.object({
    genres: z.array(z.object({ id: z.string(), name: z.string() })),
    cast_and_crew: z.array(z.object({ id: z.string(), full_name: z.string() })),
  }),
});

export async function requestCatalog(path: string, signal?: AbortSignal): Promise<unknown> {
  const res = await fetch(`https://www.cinecolombia.com/api/v1/${path}`, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.any([AbortSignal.timeout(30_000), ...(signal ? [signal] : [])]),
  });
  if (!res.ok) throw new Error(`Cine Colombia API ${path} -> ${res.status}`);
  return res.json();
}

/** Availability is national; /films without a city returns an empty list. */
export async function fetchCatalog(
  request: CatalogRequest = requestCatalog,
  options: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<FilmRecord[]> {
  const controller = new AbortController();
  const signal = AbortSignal.any([controller.signal, ...(options.signal ? [options.signal] : [])]);
  const timer = setTimeout(() => controller.abort(new Error("catalog deadline exceeded")), options.timeoutMs ?? 90_000);
  const get = (path: string) => abortable(request(path, signal), signal);
  try {
    const parsed = availabilitySchema.safeParse(await get("films/availability"));
    if (!parsed.success) throw new Error("invalid or malformed national film availability");
    const rows = parsed.data.film_availabilities;
    if (new Set(rows.map(r => r.film_id)).size !== rows.length) throw new Error("malformed duplicate film IDs");
    const films: FilmRecord[] = new Array(rows.length);
    let cursor = 0;
    await Promise.all(Array.from({ length: Math.min(6, rows.length) }, async () => {
      while (cursor < rows.length) {
        signal.throwIfAborted();
        const index = cursor++;
        const row = rows[index]!;
        const parsed = detailSchema.safeParse(await get(`films/${encodeURIComponent(row.film_id)}`));
        if (!parsed.success || parsed.data.film.id !== row.film_id) {
          throw new Error(`invalid film detail for ${row.film_id}`);
        }
        const { film: f, related_data: related } = parsed.data;
        const categories = [...new Set(row.categories)].sort();
        const attrs = [...new Set(row.showtime_attribute_ids ?? [])].sort();
        const directorId = f.cast_and_crew?.find(c => c.roles.includes("Director"))?.member_id;
        films[index] = {
          id: f.id, title: f.title_es?.trim() || f.title,
          shortSynopsis: f.short_synopsis || f.synopsis || "", releaseDate: f.release_date ?? null,
          runtimeInMinutes: f.runtime_minutes ?? null,
          censorRating: f.censor_rating?.classification ?? f.classification ?? "",
          genres: [...new Set((f.genre_ids ?? []).map(id => related.genres.find(g => g.id === id)?.name)
            .filter((name): name is string => !!name))].sort(),
          director: related.cast_and_crew.find(c => c.id === directorId)?.full_name ?? "",
          webUrl: `https://www.cinecolombia.com/peliculas/${f.slug}`,
          categories, availabilityRows: [{ siteId: null, categories, ...(attrs.length ? { showtimeAttributeIds: attrs } : {}) }],
          posterUrl: f.poster_url ?? null,
        };
      }
    }));
    return films.sort((a, b) => a.id.localeCompare(b.id));
  } catch (error) {
    controller.abort(error);
    throw error;
  } finally { clearTimeout(timer); }
}
