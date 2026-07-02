import { beforeAll, describe, expect, it, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type {
  AvailabilityResponse,
  Deps,
  FilmRecord,
  FilmsResponse,
} from "./scrape.ts";
import {
  buildFilmRecords,
  diff,
  enrichPosters,
  extractAuthToken,
  generateFeed,
  generateHTML,
  loadPosts,
  loadState,
  main,
  parseSitemap,
} from "./scrape.ts";

// ─── Fixtures ────────────────────────────────────────────────────────────────

const film = (id: string, title: string): FilmsResponse["films"][number] => ({
  id,
  hopk: id,
  title: { text: title },
  shortSynopsis: { text: `Sinopsis de ${title}` },
  releaseDate: "2026-06-18",
  runtimeInMinutes: 102,
  censorRatingId: "HO00000001",
  genreIds: ["0000000005"],
  directors: [{ castAndCrewMemberId: "0000003505" }],
});

const filmsResponse = (): FilmsResponse => ({
  films: [film("HO00000471", "Toy Story 5"), film("HO00000386", "F9")],
  relatedData: {
    castAndCrew: [{ id: "0000003505", name: { givenName: "Pixar", familyName: "Director" } }],
    genres: [{ id: "0000000005", name: { text: "Animación" } }],
    censorRatings: [{ id: "HO00000001", classification: { text: "Todos" } }],
    events: [],
  },
});

const availability = (map: Record<string, string[]>): AvailabilityResponse => ({
  filmAvailabilities: Object.entries(map).map(([filmId, categories]) => ({
    filmId,
    siteId: null,
    categories,
  })),
});

const sitemap = `<?xml version="1.0"?>
<urlset><url><loc>https://www.cinecolombia.com/films/toy-story-5/HO00000471/</loc></url></urlset>`;

const fixedNow = () => new Date("2026-07-01T18:00:00Z");
let counter = 0;
const fakeUuid = () => `guid-${++counter}`;

const deps = (): Deps => ({
  async fetchToken() {
    return "tok";
  },
  async ocapi(_t, path) {
    if (path === "films") return filmsResponse();
    if (path === "films/availability")
      return availability({ HO00000471: ["ComingSoon"], HO00000386: ["NowShowing"] });
    throw new Error(`unexpected path ${path}`);
  },
  async fetchSitemap() {
    return sitemap;
  },
  async tmdb() {
    return { tmdbId: 1, posterPath: "/abc.jpg" };
  },
  now: fixedNow,
  uuid: fakeUuid,
});

// ─── Pure functions ──────────────────────────────────────────────────────────

describe("extractAuthToken", () => {
  it("pulls the JWT out of the SPA seed", () => {
    const html = `<script>window.initialData = ({"api":{"authToken":"eyJabc"},"pages":[]});</script>`;
    expect(extractAuthToken(html)).toBe("eyJabc");
  });

  it("throws when initialData is missing", () => {
    expect(() => extractAuthToken("<html></html>")).toThrow("window.initialData");
  });
});

describe("parseSitemap", () => {
  it("maps HO-id to the film URL", () => {
    expect(parseSitemap(sitemap)).toEqual({
      HO00000471: "https://www.cinecolombia.com/films/toy-story-5/HO00000471/",
    });
  });
});

describe("buildFilmRecords", () => {
  it("joins films, reference data, availability and sitemap", () => {
    const recs = buildFilmRecords(
      filmsResponse(),
      availability({ HO00000471: ["ComingSoon"], HO00000386: ["NowShowing"] }),
      parseSitemap(sitemap),
    );
    const ts = recs.find((r) => r.id === "HO00000471")!;
    expect(ts.title).toBe("Toy Story 5");
    expect(ts.genres).toEqual(["Animación"]);
    expect(ts.censorRating).toBe("Todos");
    expect(ts.director).toBe("Pixar Director");
    expect(ts.webUrl).toBe("https://www.cinecolombia.com/films/toy-story-5/HO00000471/");
    expect(ts.categories).toEqual(["ComingSoon"]);
    expect(ts.posterUrl).toBeNull();
  });
});

describe("diff", () => {
  const rec = (id: string, categories: string[], title = id): FilmRecord => ({
    id,
    title,
    shortSynopsis: "",
    releaseDate: null,
    runtimeInMinutes: null,
    censorRating: "",
    genres: [],
    director: "",
    webUrl: "",
    categories,
    posterUrl: null,
  });
  const D = { now: fixedNow, uuid: fakeUuid };

  it("emits added for new films, gains for existing films, ignores ComingSoon and partial losses", () => {
    const prev = new Map([["A", rec("A", ["NowShowing"])]]);
    const cur = new Map([
      ["A", rec("A", ["NowShowing", "AdvanceBooking"])], // gains AdvanceBooking -> preventa
      ["B", rec("B", ["AdvanceBooking", "NowShowing"])], // new -> added only
      ["C", rec("C", ["ComingSoon"])], // new -> added only
    ]);
    const events = diff(prev, cur, D).map((e) => `${e.type}:${e.filmId}`);
    expect(events).toEqual(["added:B", "added:C", "preventa-opens:A"]);
  });

  it("emits removed for films that leave the catalog", () => {
    const prev = new Map([["A", rec("A", ["NowShowing"])]]);
    const cur = new Map<string, ReturnType<typeof rec>>();
    const events = diff(prev, cur, D).map((e) => `${e.type}:${e.filmId}`);
    expect(events).toEqual(["removed:A"]);
  });

  it("is idempotent: same input yields no events", () => {
    const prev = new Map([["A", rec("A", ["NowShowing"])]]);
    const cur = new Map([["A", rec("A", ["NowShowing"])]]);
    expect(diff(prev, cur, D)).toHaveLength(0);
  });
});

// ─── Output generation ───────────────────────────────────────────────────────

describe("generateFeed", () => {
  it("produces valid-enough RSS with stable guids and media:content", () => {
    const posts = [
      {
        guid: "g1",
        type: "added" as const,
        filmId: "HO1",
        createdAt: "2026-07-01T18:00:00Z",
        snapshot: {
          id: "HO1",
          title: "Toy Story 5",
          shortSynopsis: "Sinopsis",
          releaseDate: "2026-06-18",
          runtimeInMinutes: 102,
          censorRating: "Todos",
          genres: ["Animación"],
          director: "Pixar Director",
          webUrl: "https://www.cinecolombia.com/films/toy-story-5/HO00000471/",
          categories: ["ComingSoon"],
          posterUrl: "https://image.tmdb.org/t/p/w500/abc.jpg",
        },
      },
    ];
    const xml = generateFeed(posts, {
      feedTitle: "CineColombia — Cartelera y Preventa",
      feedUrl: "https://x/feed.xml",
      language: "es-CO",
    });
    expect(xml).toContain("<rss version=\"2.0\"");
    expect(xml).toContain("<language>es-CO</language>");
    expect(xml).toContain('rel="self"');
    expect(xml).toContain("<guid isPermaLink=\"false\">g1</guid>");
    expect(xml).toContain("<media:content url=\"https://image.tmdb.org/t/p/w500/abc.jpg\"");
    expect(xml).toContain("Pronto: Toy Story 5");
  });
});

describe("generateHTML", () => {
  it("renders reverse-chrono cards with Spanish label", () => {
    const posts = [
      {
        guid: "g1",
        type: "now-in-theaters" as const,
        filmId: "HO1",
        createdAt: "2026-07-01T18:00:00Z",
        snapshot: {
          id: "HO1",
          title: "F9",
          shortSynopsis: "Sinopsis",
          releaseDate: "2026-06-18",
          runtimeInMinutes: 102,
          censorRating: "",
          genres: [],
          director: "",
          webUrl: "https://www.cinecolombia.com/x/",
          categories: ["NowShowing"],
          posterUrl: null,
        },
      },
    ];
    const html = generateHTML(posts, { feedTitle: "Feed", language: "es-CO" });
    expect(html).toContain("<html lang=\"es-CO\">");
    expect(html).toContain("En cartelera");
    expect(html).toContain("F9");
    expect(html).toContain('href="https://www.cinecolombia.com/x/"');
  });
});

// ─── End-to-end scraper run (primary seam) ───────────────────────────────────

describe("main (full scraper run)", () => {
  let dir: string;

  beforeAll(() => {
    counter = 0;
    dir = mkdtempSync(join(tmpdir(), "cineco-"));
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("writes state, posts, feed and html; detects a transition on the next run; idempotent on rerun", async () => {
    const dataDir = join(dir, "data");
    const docsDir = join(dir, "docs");

    // Availability is mutable across runs to exercise a transition.
    let avail: Record<string, string[]> = {
      HO00000471: ["ComingSoon"],
      HO00000386: ["NowShowing"],
    };
    const runDeps = (): Deps => ({
      ...deps(),
      async ocapi(_t, path) {
        if (path === "films") return filmsResponse();
        if (path === "films/availability") return availability(avail);
        throw new Error(`unexpected path ${path}`);
      },
    });

    // Run 1: empty previous state -> both films added.
    await main({
      dataDir,
      docsDir,
      feedUrl: "https://x/feed.xml",
      tmdbApiKey: "k",
      gitPush: false,
      deps: runDeps(),
    });

    const state = loadState(join(dataDir, "state.json"));
    expect(state.films).toHaveLength(2);
    expect(state.tmdbCache["HO00000471"]).toEqual({ tmdbId: 1, posterPath: "/abc.jpg" });

    const after1 = loadPosts(join(dataDir, "posts.json"));
    expect(after1.posts.map((p) => p.type)).toEqual(["added", "added"]);

    const feed = await Bun.file(join(docsDir, "feed.xml")).text();
    expect(feed).toContain("Pronto: Toy Story 5");
    expect(feed).toContain("Pronto: F9");

    const html = await Bun.file(join(docsDir, "index.html")).text();
    expect(html).toContain("Toy Story 5");

    // Run 2: HO00000471 gains AdvanceBooking -> preventa opens.
    avail = { HO00000471: ["ComingSoon", "AdvanceBooking"], HO00000386: ["NowShowing"] };
    await main({ dataDir, docsDir, feedUrl: "https://x/feed.xml", tmdbApiKey: "k", gitPush: false, deps: runDeps() });
    const after2 = loadPosts(join(dataDir, "posts.json"));
    expect(after2.posts.map((p) => p.type)).toEqual(["added", "added", "preventa-opens"]);
    const feed2 = await Bun.file(join(docsDir, "feed.xml")).text();
    expect(feed2).toContain("Preventa abierta: Toy Story 5");

    // Run 3: identical data -> idempotent.
    await main({ dataDir, docsDir, feedUrl: "https://x/feed.xml", tmdbApiKey: "k", gitPush: false, deps: runDeps() });
    const after3 = loadPosts(join(dataDir, "posts.json"));
    expect(after3.posts).toHaveLength(after2.posts.length);
  });

  it("aborts on fetch failure without touching existing files", async () => {
    const dataDir = join(dir, "data-bad");
    const docsDir = join(dir, "docs-bad");
    // Seed a state file so we can prove it is left untouched.
    const statePath = join(dataDir, "state.json");
    await Bun.write(statePath, JSON.stringify({ films: [], tmdbCache: {} }));
    const badDeps = { ...deps(), async fetchToken() {
      throw new Error("cloudflare");
    } };
    await expect(
      main({ dataDir, docsDir, gitPush: false, deps: badDeps }),
    ).rejects.toThrow("cloudflare");
    // The pre-existing state.json is unchanged and no posts were written.
    expect(loadState(statePath).films).toEqual([]);
    expect(loadPosts(join(dataDir, "posts.json")).posts).toEqual([]);
  });
});

describe("enrichPosters", () => {
  it("caches TMDB lookups per film and reuses them", async () => {
    const cache: Record<string, { tmdbId: number; posterPath: string | null }> = {};
    let calls = 0;
    const tmdb: Deps["tmdb"] = async () => {
      calls++;
      return { tmdbId: 7, posterPath: "/p.jpg" };
    };
    const films: FilmRecord[] = [
      { id: "A", title: "A", shortSynopsis: "", releaseDate: null, runtimeInMinutes: null, censorRating: "", genres: [], director: "", webUrl: "", categories: [], posterUrl: null },
      { id: "A", title: "A", shortSynopsis: "", releaseDate: null, runtimeInMinutes: null, censorRating: "", genres: [], director: "", webUrl: "", categories: [], posterUrl: null },
    ];
    await enrichPosters(films, cache, "k", tmdb);
    expect(calls).toBe(1);
    expect(films[0].posterUrl).toBe("https://image.tmdb.org/t/p/w500/p.jpg");
    expect(cache["A"]).toEqual({ tmdbId: 7, posterPath: "/p.jpg" });
  });

  it("skips lookups when no api key is set", async () => {
    let calls = 0;
    const tmdb: Deps["tmdb"] = async () => {
      calls++;
      return null;
    };
    const films: FilmRecord[] = [{ id: "A", title: "A", shortSynopsis: "", releaseDate: null, runtimeInMinutes: null, censorRating: "", genres: [], director: "", webUrl: "", categories: [], posterUrl: null }];
    await enrichPosters(films, {}, undefined, tmdb);
    expect(calls).toBe(0);
    expect(films[0].posterUrl).toBeNull();
  });

  it("degrades gracefully when TMDB throws (never aborts the scrape)", async () => {
    const tmdb: Deps["tmdb"] = async () => {
      throw new Error("tmdb 500");
    };
    const films: FilmRecord[] = [{ id: "A", title: "A", shortSynopsis: "", releaseDate: null, runtimeInMinutes: null, censorRating: "", genres: [], director: "", webUrl: "", categories: [], posterUrl: null }];
    await expect(enrichPosters(films, {}, "k", tmdb)).resolves.toBeUndefined();
    expect(films[0].posterUrl).toBeNull();
  });
});
