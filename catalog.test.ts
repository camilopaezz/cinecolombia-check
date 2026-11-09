import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main, loadState } from "./scrape";
import { describe, it, expect, spyOn } from "bun:test";
import { fetchCatalog, type CatalogRequest } from "./catalog";

const availability = { film_availabilities: [
  { film_id: "HO00000480", categories: ["NowShowing", "AdvanceBooking"], showtime_attribute_ids: ["2d"] },
] };
const detail = { film: {
  id: "HO00000480", title: "English", title_es: "Español", slug: "film",
  release_date: "2026-11-19", runtime_minutes: 158, short_synopsis: "Synopsis",
  poster_url: "https://example.com/poster.jpg", genre_ids: ["action"],
  censor_rating: { classification: "+12 Años" },
  cast_and_crew: [{ member_id: "director", roles: ["Director"] }],
}, related_data: { genres: [{ id: "action", name: "Acción" }],
  cast_and_crew: [{ id: "director", full_name: "Francis Lawrence" }] } };
const request: CatalogRequest = async (path) => path === "films/availability" ? availability : detail;

describe("new website catalog", () => {
  it("uses national IDs and maps snake-case details without changing film identity or categories", async () => {
    const calls: string[] = [];
    const films = await fetchCatalog(async (path) => { calls.push(path); return request(path); });
    expect(calls).toEqual(["films/availability", "films/HO00000480"]);
    expect(films[0]).toEqual({
      id: "HO00000480", title: "Español", shortSynopsis: "Synopsis", releaseDate: "2026-11-19",
      runtimeInMinutes: 158, censorRating: "+12 Años", genres: ["Acción"], director: "Francis Lawrence",
      webUrl: "https://www.cinecolombia.com/peliculas/film", categories: ["AdvanceBooking", "NowShowing"],
      availabilityRows: [{ siteId: null, categories: ["AdvanceBooking", "NowShowing"], showtimeAttributeIds: ["2d"] }],
      posterUrl: "https://example.com/poster.jpg",
    });
  });
  it("fails closed on missing availability or malformed rows", async () => {
    for (const value of [{}, { film_availabilities: [] }, { film_availabilities: [{ film_id: "HO1", categories: null }] }]) {
      await expect(fetchCatalog(async () => value)).rejects.toThrow();
    }
  });
  it("aborts if any detail fails or returns a different film", async () => {
    await expect(fetchCatalog(async (path) => {
      if (path === "films/availability") return availability;
      throw new Error("503");
    })).rejects.toThrow("503");
    await expect(fetchCatalog(async (path) => path === "films/availability" ? availability :
      { ...detail, film: { ...detail.film, id: "HO2" } })).rejects.toThrow("invalid film detail");
  });
});

describe("main with the website API", () => {
  it("persists explicit category losses and preserves every output on failed or empty observations", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cineco-api-main-"));
    let categories = ["NowShowing", "AdvanceBooking"];
    let failDetail = false;
    let emptyAll = false;
    const mockedFetch = spyOn(globalThis, "fetch").mockImplementation((async (url: URL | RequestInfo) => {
      const path = String(url).split("/api/v1/")[1];
      if (path === "films/availability") return Response.json({ film_availabilities: [
        { film_id: "HO00000480", categories: emptyAll ? [] : categories },
        { film_id: "HO00000481", categories: emptyAll ? [] : ["ComingSoon"] },
      ] });
      if (failDetail) return new Response(null, { status: 503 });
      if (path === "films/HO00000480") return Response.json(detail);
      if (path === "films/HO00000481") return Response.json({ ...detail, film: {
        ...detail.film, id: "HO00000481", slug: "second-film",
      } });
      throw new Error(`Unexpected request: ${url}`);
    }) as typeof fetch);
    const options = { dataDir: join(dir, "data"), docsDir: join(dir, "docs"),
      gitPush: false, notifyWebhookUrl: "", failureWebhookUrl: "", tmdbApiKey: "" };
    const paths = [join(options.dataDir, "state.json"), join(options.dataDir, "posts.json"),
      join(options.docsDir, "feed.xml"), join(options.docsDir, "index.html")];
    try {
      await main(options);
      expect(loadState(paths[0]!).films).toHaveLength(2);
      expect(readFileSync(paths[3]!, "utf8")).toContain("/peliculas/film");
      categories = [];
      await main(options);
      const saved = loadState(paths[0]!);
      expect(saved.films.find(f => f.id === "HO00000480")?.categories).toEqual([]);
      expect(saved.pendingCategoryLosses?.HO00000480).toEqual({ AdvanceBooking: 1, NowShowing: 1 });
      const before = paths.map(path => readFileSync(path, "utf8"));
      failDetail = true;
      await expect(main(options)).rejects.toThrow("503");
      expect(paths.map(path => readFileSync(path, "utf8"))).toEqual(before);
      failDetail = false;
      emptyAll = true;
      await expect(main(options)).rejects.toThrow("empty website availability categories");
      expect(paths.map(path => readFileSync(path, "utf8"))).toEqual(before);
    } finally {
      mockedFetch.mockRestore();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
