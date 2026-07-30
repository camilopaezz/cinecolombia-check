import { beforeAll, describe, expect, it, afterAll } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type {
  AvailabilityResponse,
  Deps,
  Event,
  FilmRecord,
  FilmsResponse,
} from "./scrape.ts";
import {
  announcementType,
  applyLifecycle,
  buildFilmRecords,
  buildDiscordEmbed,
  clipSynopsis,
  enrichPosters,
  eventTitle,
  extractAuthToken,
  factsLine,
  FEED_LIMIT,
  formatCommitMessage,
  gainEvents,
  generateFeed,
  generateHTML,
  lifecycleAbortMessage,
  loadPosts,
  loadState,
  main,
  maxRemovalsAllowed,
  parseSitemap,
  REMOVAL_THRESHOLD,
  runArchiveHygiene,
  runLifecycle,
  sanitizeArchivePosts,
  windowNewest,
  type State,
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

const DEFAULT_AVAIL: Record<string, string[]> = {
  HO00000471: ["ComingSoon"],
  HO00000386: ["NowShowing"],
};

/** Base test Deps bag; pass Partial overrides instead of rebuilding all 7 keys. */
const deps = (overrides: Partial<Deps> = {}): Deps => ({
  async fetchToken() {
    return "tok";
  },
  async ocapi(_t, path) {
    if (path === "films") return filmsResponse();
    if (path === "films/availability") return availability(DEFAULT_AVAIL);
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
  async notify() {},
  ...overrides,
});

type CatalogOpts = {
  /** Static map or getter (getter when availability mutates across runs). */
  availability?: Record<string, string[]> | (() => Record<string, string[]>);
  /** Full films response or getter. Defaults to filmsResponse(). */
  films?: FilmsResponse | (() => FilmsResponse);
  /** Filter films to these ids (static or getter). Applied after films. */
  filmIds?: string[] | (() => string[]);
} & Partial<Omit<Deps, "ocapi">>;

const resolve = <T>(v: T | (() => T)): T =>
  typeof v === "function" ? (v as () => T)() : v;

/**
 * Catalog-shaped Deps: shared ocapi for films + availability, with optional
 * overrides for notify/now/fetchToken/etc. Shrinks main() test boilerplate.
 */
const catalogDeps = (opts: CatalogOpts = {}): Deps => {
  const { availability: availOpt, films: filmsOpt, filmIds: filmIdsOpt, ...rest } = opts;
  return deps({
    async ocapi(_t, path) {
      if (path === "films") {
        const full = filmsOpt !== undefined ? resolve(filmsOpt) : filmsResponse();
        if (filmIdsOpt === undefined) return full;
        const ids = new Set(resolve(filmIdsOpt));
        return { ...full, films: full.films.filter((f) => ids.has(f.id)) };
      }
      if (path === "films/availability") {
        return availability(availOpt !== undefined ? resolve(availOpt) : DEFAULT_AVAIL);
      }
      throw new Error(`unexpected path ${path}`);
    },
    ...rest,
  });
};

/** Captures notify() calls so main() tests can assert without re-wiring the bag. */
const recordingNotifier = () => {
  const events: Event[] = [];
  return {
    events,
    notify: async (evs: Event[]) => {
      events.push(...evs);
    },
  };
};

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

  it("upgrades http film URLs to https", () => {
    const httpSitemap = `<?xml version="1.0"?>
<urlset><url><loc>http://www.cinecolombia.com/films/toy-story-5/HO00000471/</loc></url></urlset>`;
    expect(parseSitemap(httpSitemap)).toEqual({
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

  it("normalizes categories and genres to sorted unique arrays", () => {
    const res: FilmsResponse = {
      films: [
        {
          ...film("HO00000471", "Toy Story 5"),
          genreIds: ["0000000002", "0000000005", "0000000002"],
        },
      ],
      relatedData: {
        castAndCrew: [{ id: "0000003505", name: { givenName: "Pixar", familyName: "Director" } }],
        genres: [
          { id: "0000000005", name: { text: "Animación" } },
          { id: "0000000002", name: { text: "Comedia" } },
        ],
        censorRatings: [{ id: "HO00000001", classification: { text: "Todos" } }],
        events: [],
      },
    };
    const recs = buildFilmRecords(
      res,
      availability({ HO00000471: ["NowShowing", "ComingSoon", "NowShowing"] }),
      parseSitemap(sitemap),
    );
    expect(recs[0].categories).toEqual(["ComingSoon", "NowShowing"]);
    expect(recs[0].genres).toEqual(["Animación", "Comedia"]);
  });

  it("unions availability categories across multiple site rows for one film", () => {
    const multiSite: AvailabilityResponse = {
      filmAvailabilities: [
        { filmId: "HO00000471", siteId: "site-a", categories: ["AdvanceBooking"] },
        { filmId: "HO00000471", siteId: "site-b", categories: ["NowShowing"] },
        { filmId: "HO00000386", siteId: "site-a", categories: ["NowShowing"] },
      ],
    };
    const recs = buildFilmRecords(filmsResponse(), multiSite, parseSitemap(sitemap));
    const ts = recs.find((r) => r.id === "HO00000471")!;
    expect(ts.categories).toEqual(["AdvanceBooking", "NowShowing"]);
  });
});

const filmRec = (id: string, categories: string[], title = id): FilmRecord => ({
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

describe("applyLifecycle (removal debounce)", () => {
  const D = { now: fixedNow, uuid: fakeUuid };

  it("missing once: no removed, film stays soft-missing, missingRuns=1", () => {
    counter = 0;
    const prev = { films: [filmRec("A", ["NowShowing"])], missingRuns: {} };
    const result = applyLifecycle(prev, [], D);
    expect(result.events).toHaveLength(0);
    expect(result.films.map((f) => f.id)).toEqual(["A"]);
    expect(result.missingRuns).toEqual({ A: 1 });
  });

  it("missing twice (REMOVAL_THRESHOLD): emits removed and drops film", () => {
    counter = 0;
    expect(REMOVAL_THRESHOLD).toBe(2);
    const prev = {
      films: [filmRec("A", ["NowShowing"], "Gone Film")],
      missingRuns: { A: 1 },
    };
    const result = applyLifecycle(prev, [], D);
    expect(result.events.map((e) => `${e.type}:${e.filmId}`)).toEqual(["removed:A"]);
    expect(result.events[0]!.snapshot.title).toBe("Gone Film");
    expect(result.films).toHaveLength(0);
    expect(result.missingRuns).toEqual({});
  });

  it("missing once then returns: no removed, no added, missingRuns cleared", () => {
    counter = 0;
    const soft = {
      films: [filmRec("A", ["NowShowing"], "Old Title")],
      missingRuns: { A: 1 },
    };
    const returned = [filmRec("A", ["NowShowing"], "Updated Title")];
    const result = applyLifecycle(soft, returned, D);
    expect(result.events).toHaveLength(0);
    expect(result.films).toHaveLength(1);
    expect(result.films[0]!.title).toBe("Updated Title");
    expect(result.missingRuns).toEqual({});
  });

  it("truly new film announces at highest stage; gains still emit", () => {
    counter = 0;
    const prev = { films: [filmRec("A", ["ComingSoon"])] };
    const cur = [
      filmRec("A", ["ComingSoon", "AdvanceBooking"]),
      filmRec("B", ["NowShowing"]),
    ];
    const result = applyLifecycle(prev, cur, D);
    expect(result.events.map((e) => `${e.type}:${e.filmId}`)).toEqual([
      "now-in-theaters:B",
      "preventa-opens:A",
    ]);
    expect(result.missingRuns).toEqual({});
  });

  it("same-run preventa + now collapses to only now-in-theaters for existing film", () => {
    counter = 0;
    const prev = { films: [filmRec("A", ["ComingSoon"])] };
    const cur = [filmRec("A", ["ComingSoon", "AdvanceBooking", "NowShowing"])];
    const result = applyLifecycle(prev, cur, D);
    expect(result.events.map((e) => `${e.type}:${e.filmId}`)).toEqual(["now-in-theaters:A"]);
  });

  it("separate runs still emit preventa then now independently", () => {
    counter = 0;
    const afterPreventa = applyLifecycle(
      { films: [filmRec("A", ["ComingSoon"])] },
      [filmRec("A", ["ComingSoon", "AdvanceBooking"])],
      D,
    );
    expect(afterPreventa.events.map((e) => `${e.type}:${e.filmId}`)).toEqual(["preventa-opens:A"]);
    const afterNow = applyLifecycle(
      { films: afterPreventa.films, missingRuns: afterPreventa.missingRuns },
      [filmRec("A", ["ComingSoon", "AdvanceBooking", "NowShowing"])],
      D,
    );
    expect(afterNow.events.map((e) => `${e.type}:${e.filmId}`)).toEqual(["now-in-theaters:A"]);
  });

  it("suppresses preventa-opens when film is already NowShowing", () => {
    counter = 0;
    const result = applyLifecycle(
      { films: [filmRec("A", ["NowShowing"])] },
      [filmRec("A", ["NowShowing", "AdvanceBooking"])],
      D,
    );
    expect(result.events).toHaveLength(0);
  });

  it("new film with only AdvanceBooking announces preventa-opens", () => {
    counter = 0;
    const result = applyLifecycle({ films: [] }, [filmRec("A", ["AdvanceBooking"])], D);
    expect(result.events.map((e) => `${e.type}:${e.filmId}`)).toEqual(["preventa-opens:A"]);
  });

  it("announces new films at highest stage; suppresses preventa while in theaters", () => {
    counter = 0;
    const prev = { films: [filmRec("A", ["NowShowing"])] };
    const cur = [
      filmRec("A", ["NowShowing", "AdvanceBooking"]),
      filmRec("B", ["AdvanceBooking", "NowShowing"]),
      filmRec("C", ["ComingSoon"]),
      filmRec("D", ["AdvanceBooking"]),
    ];
    const events = applyLifecycle(prev, cur, D).events.map((e) => `${e.type}:${e.filmId}`);
    expect(events).toEqual(["now-in-theaters:B", "added:C", "preventa-opens:D"]);
  });

  it("is idempotent: same input yields no events", () => {
    counter = 0;
    const films = [filmRec("A", ["NowShowing"])];
    expect(applyLifecycle({ films }, films, D).events).toHaveLength(0);
  });
});

describe("runLifecycle (full policy)", () => {
  const D = { now: fixedNow, uuid: fakeUuid };
  const emptyState = (): State => ({ films: [], tmdbCache: {} });

  it("aborts empty catalog when previous films exist", () => {
    const prev: State = { films: [filmRec("A", ["NowShowing"])], tmdbCache: {} };
    const result = runLifecycle(prev, [], 0, D);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected abort");
    expect(result.abort).toEqual({ kind: "empty-catalog", knownFilms: 1 });
    expect(lifecycleAbortMessage(result.abort)).toContain("empty OCAPI catalog");
  });

  it("virgin cold start seeds films but archives nothing", () => {
    counter = 0;
    const cur = [filmRec("A", ["ComingSoon"]), filmRec("B", ["NowShowing"])];
    const result = runLifecycle(emptyState(), cur, 0, D);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected outcome");
    expect(result.outcome.coldStart).toBe(true);
    expect(result.outcome.events).toHaveLength(2);
    expect(result.outcome.archivedEvents).toHaveLength(0);
    expect(result.outcome.films).toHaveLength(2);
    expect(result.outcome.meaningfulChange).toBe(true);
    expect(result.outcome.lastRun).toBe(fixedNow().toISOString());
  });

  it("wipe with lastRun set archives re-adds (not cold start)", () => {
    counter = 0;
    const prev: State = {
      films: [],
      tmdbCache: {},
      lastRun: "2026-01-01T00:00:00.000Z",
    };
    const result = runLifecycle(prev, [filmRec("A", ["NowShowing"])], 0, D);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected outcome");
    expect(result.outcome.coldStart).toBe(false);
    expect(result.outcome.archivedEvents.map((e) => e.type)).toEqual(["now-in-theaters"]);
  });

  it("quiet identical catalog keeps lastRun", () => {
    counter = 0;
    const films = [filmRec("A", ["NowShowing"])];
    const prev: State = {
      films,
      tmdbCache: {},
      missingRuns: {},
      lastRun: "2026-01-01T00:00:00.000Z",
    };
    const result = runLifecycle(prev, films, 3, D);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected outcome");
    expect(result.outcome.meaningfulChange).toBe(false);
    expect(result.outcome.lastRun).toBe("2026-01-01T00:00:00.000Z");
    expect(result.outcome.archivedEvents).toHaveLength(0);
  });

  it("aborts bulk removal above cap", () => {
    counter = 0;
    // 12 known films, all past soft-missing threshold → 12 removals; cap = max(10, floor(12*0.3))=10
    const films = Array.from({ length: 12 }, (_, i) =>
      filmRec(`F${String(i).padStart(2, "0")}`, ["NowShowing"]),
    );
    const missingRuns = Object.fromEntries(films.map((f) => [f.id, 1]));
    const prev: State = { films, tmdbCache: {}, missingRuns, lastRun: "2026-01-01T00:00:00.000Z" };
    // Keep 1 film so we don't hit empty-catalog abort; 11 removals > cap 10
    const result = runLifecycle(prev, [films[0]!], 0, D);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected abort");
    expect(result.abort.kind).toBe("bulk-removal");
    if (result.abort.kind !== "bulk-removal") throw new Error("expected bulk-removal");
    expect(result.abort.removed).toBe(11);
    expect(result.abort.cap).toBe(10);
    expect(lifecycleAbortMessage(result.abort)).toContain("refusing bulk removal");
  });

  it("gain on known film archives the event", () => {
    counter = 0;
    const prev: State = {
      films: [filmRec("A", ["ComingSoon"])],
      tmdbCache: {},
      lastRun: "2026-01-01T00:00:00.000Z",
    };
    const result = runLifecycle(prev, [filmRec("A", ["ComingSoon", "AdvanceBooking"])], 1, D);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected outcome");
    expect(result.outcome.coldStart).toBe(false);
    expect(result.outcome.archivedEvents.map((e) => e.type)).toEqual(["preventa-opens"]);
    expect(result.outcome.meaningfulChange).toBe(true);
  });
});

describe("announcementType / gainEvents / sanitizeArchivePosts", () => {
  it("announcementType picks highest operational stage", () => {
    expect(announcementType(["ComingSoon"])).toBe("added");
    expect(announcementType(["AdvanceBooking"])).toBe("preventa-opens");
    expect(announcementType(["NowShowing", "AdvanceBooking"])).toBe("now-in-theaters");
    expect(announcementType([])).toBe("added");
  });

  it("gainEvents collapses same-run and suppresses preventa-in-theaters", () => {
    expect(gainEvents(["ComingSoon"], ["ComingSoon", "AdvanceBooking", "NowShowing"])).toEqual([
      "now-in-theaters",
    ]);
    expect(gainEvents(["NowShowing"], ["NowShowing", "AdvanceBooking"])).toEqual([]);
    expect(gainEvents(["ComingSoon"], ["ComingSoon", "AdvanceBooking"])).toEqual([
      "preventa-opens",
    ]);
    expect(gainEvents(["ComingSoon", "AdvanceBooking"], ["ComingSoon", "AdvanceBooking", "NowShowing"])).toEqual([
      "now-in-theaters",
    ]);
  });

  it("sanitizeArchivePosts drops same-timestamp preventa twins and restages added", () => {
    const snap = (cats: string[]): FilmRecord => ({
      id: "HO1",
      title: "X",
      shortSynopsis: "",
      releaseDate: null,
      runtimeInMinutes: null,
      censorRating: "",
      genres: [],
      director: "",
      webUrl: "",
      categories: cats,
      posterUrl: null,
    });
    const posts: Event[] = [
      {
        guid: "1",
        type: "added",
        filmId: "HO1",
        createdAt: "2026-07-01T00:00:00.000Z",
        snapshot: snap(["NowShowing"]),
      },
      {
        guid: "2",
        type: "preventa-opens",
        filmId: "HO2",
        createdAt: "2026-07-02T00:00:00.000Z",
        snapshot: snap(["NowShowing", "AdvanceBooking"]),
      },
      {
        guid: "3",
        type: "now-in-theaters",
        filmId: "HO2",
        createdAt: "2026-07-02T00:00:00.000Z",
        snapshot: snap(["NowShowing", "AdvanceBooking"]),
      },
      {
        guid: "4",
        type: "preventa-opens",
        filmId: "HO3",
        createdAt: "2026-07-03T00:00:00.000Z",
        snapshot: snap(["AdvanceBooking"]),
      },
      {
        guid: "5",
        type: "added",
        filmId: "HO4",
        createdAt: "2026-07-04T00:00:00.000Z",
        snapshot: snap(["ComingSoon"]),
      },
    ];
    const cleaned = sanitizeArchivePosts(posts);
    expect(cleaned.map((p) => `${p.guid}:${p.type}`)).toEqual([
      "1:now-in-theaters",
      "3:now-in-theaters",
      "4:preventa-opens",
      "5:added",
    ]);
  });

  it("sanitizeArchivePosts drops preventa when snapshot already has NowShowing", () => {
    const snap = (cats: string[]): FilmRecord => ({
      id: "HO9",
      title: "Y",
      shortSynopsis: "",
      releaseDate: null,
      runtimeInMinutes: null,
      censorRating: "",
      genres: [],
      director: "",
      webUrl: "",
      categories: cats,
      posterUrl: null,
    });
    const posts: Event[] = [
      {
        guid: "n",
        type: "now-in-theaters",
        filmId: "HO9",
        createdAt: "2026-07-01T00:00:00.000Z",
        snapshot: snap(["NowShowing"]),
      },
      {
        guid: "p",
        type: "preventa-opens",
        filmId: "HO9",
        createdAt: "2026-07-02T00:00:00.000Z",
        snapshot: snap(["NowShowing", "AdvanceBooking"]),
      },
    ];
    expect(sanitizeArchivePosts(posts).map((p) => p.guid)).toEqual(["n"]);
  });

  it("sanitizeArchivePosts drops preventa twin of restaged added→now", () => {
    const snap = (id: string, cats: string[]): FilmRecord => ({
      id,
      title: id,
      shortSynopsis: "",
      releaseDate: null,
      runtimeInMinutes: null,
      censorRating: "",
      genres: [],
      director: "",
      webUrl: "",
      categories: cats,
      posterUrl: null,
    });
    // Restaged now key must kill same-ts preventa even if preventa snap lacks NowShowing.
    const posts: Event[] = [
      {
        guid: "a",
        type: "added",
        filmId: "H1",
        createdAt: "T1",
        snapshot: snap("H1", ["NowShowing"]),
      },
      {
        guid: "p",
        type: "preventa-opens",
        filmId: "H1",
        createdAt: "T1",
        snapshot: snap("H1", ["AdvanceBooking"]),
      },
    ];
    expect(sanitizeArchivePosts(posts).map((p) => `${p.guid}:${p.type}`)).toEqual([
      "a:now-in-theaters",
    ]);
  });

  it("runArchiveHygiene rewrites posts.json and regenerates public surfaces", () => {
    const root = mkdtempSync(join(tmpdir(), "cineco-hygiene-"));
    try {
      const dataDir = join(root, "data");
      const docsDir = join(root, "docs");
      const snap = (cats: string[]): FilmRecord => ({
        id: "HO1",
        title: "X",
        shortSynopsis: "sinopsis",
        releaseDate: null,
        runtimeInMinutes: null,
        censorRating: "",
        genres: [],
        director: "",
        webUrl: "https://example.com/x",
        categories: cats,
        posterUrl: null,
      });
      // Dirty archive: restage-worthy added + same-ts preventa twin of now.
      const dirty: Event[] = [
        {
          guid: "1",
          type: "added",
          filmId: "HO1",
          createdAt: "2026-07-01T00:00:00.000Z",
          snapshot: snap(["NowShowing"]),
        },
        {
          guid: "2",
          type: "preventa-opens",
          filmId: "HO2",
          createdAt: "2026-07-02T00:00:00.000Z",
          snapshot: snap(["NowShowing", "AdvanceBooking"]),
        },
        {
          guid: "3",
          type: "now-in-theaters",
          filmId: "HO2",
          createdAt: "2026-07-02T00:00:00.000Z",
          snapshot: snap(["NowShowing", "AdvanceBooking"]),
        },
      ];
      const postsPath = join(dataDir, "posts.json");
      mkdirSync(dataDir, { recursive: true });
      writeFileSync(postsPath, JSON.stringify({ posts: dirty }, null, 2) + "\n");

      const result = runArchiveHygiene({
        dataDir,
        docsDir,
        feedUrl: "https://x/feed.xml",
        feedTitle: "Test Feed",
      });
      expect(result).toEqual({ before: 3, after: 2 });

      const cleaned = loadPosts(postsPath).posts;
      expect(cleaned.map((p) => `${p.guid}:${p.type}`)).toEqual([
        "1:now-in-theaters",
        "3:now-in-theaters",
      ]);
      // Feed/html regenerated from cleaned archive (no twin, restaged type in title path).
      const feed = Bun.file(join(docsDir, "feed.xml"));
      const html = Bun.file(join(docsDir, "index.html"));
      expect(feed.size).toBeGreaterThan(0);
      expect(html.size).toBeGreaterThan(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("soft-missing return with upgraded categories emits gain only (no added)", () => {
    counter = 0;
    const soft = {
      films: [
        {
          id: "A",
          title: "A",
          shortSynopsis: "",
          releaseDate: null,
          runtimeInMinutes: null,
          censorRating: "",
          genres: [],
          director: "",
          webUrl: "",
          categories: ["ComingSoon"],
          posterUrl: null,
        },
      ],
      missingRuns: { A: 1 },
    };
    const returned = [
      {
        id: "A",
        title: "A",
        shortSynopsis: "",
        releaseDate: null,
        runtimeInMinutes: null,
        censorRating: "",
        genres: [],
        director: "",
        webUrl: "",
        categories: ["ComingSoon", "NowShowing"],
        posterUrl: null,
      },
    ];
    const result = applyLifecycle(soft, returned, {
      now: fixedNow,
      uuid: fakeUuid,
    });
    expect(result.events.map((e) => `${e.type}:${e.filmId}`)).toEqual(["now-in-theaters:A"]);
    expect(result.missingRuns).toEqual({});
  });
});

// ─── Output generation ───────────────────────────────────────────────────────

describe("event projection helpers", () => {
  const snap: FilmRecord = {
    id: "HO1",
    title: "Toy Story 5",
    shortSynopsis: "Sinopsis de Toy Story 5",
    releaseDate: "2026-06-18",
    runtimeInMinutes: 102,
    censorRating: "Todos",
    genres: ["Animación"],
    director: "Pixar Director",
    webUrl: "https://www.cinecolombia.com/films/toy-story-5/HO00000471/",
    categories: ["ComingSoon"],
    posterUrl: "https://image.tmdb.org/t/p/w500/abc.jpg",
  };

  const ev = (type: Event["type"], overrides: Partial<Event> = {}): Event => ({
    guid: "g1",
    type,
    filmId: "HO1",
    createdAt: "2026-07-01T18:00:00Z",
    snapshot: snap,
    ...overrides,
  });

  it("eventTitle prefixes the Spanish label", () => {
    expect(eventTitle(ev("added"))).toBe("Pronto: Toy Story 5");
    expect(eventTitle(ev("now-in-theaters"))).toBe("En cartelera: Toy Story 5");
  });

  it("factsLine joins non-empty ficha bits", () => {
    expect(factsLine(snap)).toBe("2026-06-18 · 102 min · Todos · Animación");
    expect(factsLine({ ...snap, releaseDate: null, runtimeInMinutes: null, censorRating: "", genres: [] })).toBe("");
  });

  it("clipSynopsis respects the hard limit and ellipsis", () => {
    expect(clipSynopsis("short")).toBe("short");
    expect(clipSynopsis("")).toBe("");
    const long = "A".repeat(500);
    const clipped = clipSynopsis(long);
    expect(clipped.length).toBe(350);
    expect(clipped.endsWith("…")).toBe(true);
  });

  it("windowNewest sorts reverse-chrono and slices to limit", () => {
    const posts: Event[] = [
      ev("added", { guid: "old", createdAt: "2026-01-01T00:00:00Z", filmId: "A" }),
      ev("added", { guid: "new", createdAt: "2026-06-01T00:00:00Z", filmId: "B" }),
      ev("added", { guid: "mid", createdAt: "2026-03-01T00:00:00Z", filmId: "C" }),
    ];
    const window = windowNewest(posts, 2);
    expect(window.map((p) => p.guid)).toEqual(["new", "mid"]);
    // does not mutate input order
    expect(posts.map((p) => p.guid)).toEqual(["old", "new", "mid"]);
  });
});

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
    expect(html).toContain("Bogotá");
    expect(html).toContain("CARTELERA");
    expect(html).toContain("en cartelera");
    expect(html).toContain("F9");
    expect(html).toContain('href="https://www.cinecolombia.com/x/"');
    expect(html).toContain("Ver en CineColombia");
    expect(html).toContain("sin póster");
  });
});

describe("FEED_LIMIT window", () => {
  const snapshot = (title: string): FilmRecord => ({
    id: "HO1",
    title,
    shortSynopsis: "Sinopsis",
    releaseDate: null,
    runtimeInMinutes: null,
    censorRating: "",
    genres: [],
    director: "",
    webUrl: "https://www.cinecolombia.com/x/",
    categories: ["ComingSoon"],
    posterUrl: null,
  });

  const manyPosts = (): Event[] =>
    Array.from({ length: FEED_LIMIT + 5 }, (_, i) => ({
      guid: `guid-${i}`,
      type: "added" as const,
      filmId: `HO${i}`,
      createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(),
      snapshot: snapshot(`Film ${i}`),
    }));

  it("renders only the newest FEED_LIMIT posts in feed and HTML", () => {
    const posts = manyPosts();
    const newest = posts[posts.length - 1]!;
    const oldest = posts[0]!;

    const xml = generateFeed(posts, {
      feedTitle: "Feed",
      feedUrl: "https://x/feed.xml",
      language: "es-CO",
    });
    const itemCount = (xml.match(/<item>/g) ?? []).length;
    expect(itemCount).toBe(FEED_LIMIT);
    expect(xml).toContain(newest.guid);
    expect(xml).toContain(`Pronto: ${newest.snapshot.title}`);
    expect(xml).not.toContain(oldest.guid);
    expect(xml).not.toContain(`Pronto: ${oldest.snapshot.title}`);

    const html = generateHTML(posts, { feedTitle: "Feed", language: "es-CO" });
    const articleCount = (html.match(/<article class="post">/g) ?? []).length;
    expect(articleCount).toBe(FEED_LIMIT);
    expect(html).toContain(newest.snapshot.title);
    expect(html).not.toContain(oldest.snapshot.title);
  });
});

// ─── Git commit message ──────────────────────────────────────────────────────

describe("formatCommitMessage", () => {
  const ev = (type: Event["type"], filmId: string): Event => ({
    guid: `g-${filmId}-${type}`,
    type,
    filmId,
    createdAt: "2026-07-01T18:00:00Z",
    snapshot: {
      id: filmId,
      title: filmId,
      shortSynopsis: "",
      releaseDate: null,
      runtimeInMinutes: null,
      censorRating: "",
      genres: [],
      director: "",
      webUrl: "",
      categories: [],
      posterUrl: null,
    },
  });

  it("summarizes event counts sorted by type", () => {
    expect(
      formatCommitMessage([
        ev("removed", "A"),
        ev("added", "B"),
        ev("added", "C"),
        ev("preventa-opens", "D"),
      ]),
    ).toBe("ci: update feed (added:2, preventa-opens:1, removed:1)");
  });

  it("uses (no events) when the list is empty", () => {
    expect(formatCommitMessage([])).toBe("ci: update feed (no events)");
  });
});

// ─── Discord embed ───────────────────────────────────────────────────────────

describe("buildDiscordEmbed", () => {
  const snapshot: FilmRecord = {
    id: "HO1",
    title: "Toy Story 5",
    shortSynopsis: "Sinopsis de Toy Story 5",
    releaseDate: "2026-06-18",
    runtimeInMinutes: 102,
    censorRating: "Todos",
    genres: ["Animación"],
    director: "Pixar Director",
    webUrl: "https://www.cinecolombia.com/films/toy-story-5/HO00000471/",
    categories: ["ComingSoon"],
    posterUrl: "https://image.tmdb.org/t/p/w500/abc.jpg",
  };

  it("builds a rich embed with title, url, poster, facts, and Bogotá footer", () => {
    const e: Event = {
      guid: "g1",
      type: "added",
      filmId: "HO1",
      createdAt: "2026-07-01T18:00:00Z",
      snapshot,
    };
    const embed = buildDiscordEmbed(e) as Record<string, unknown>;
    expect(embed.title).toBe("Pronto: Toy Story 5");
    expect(embed.url).toBe("https://www.cinecolombia.com/films/toy-story-5/HO00000471/");
    expect(embed.color).toBe(0x2ecc71);
    expect(embed.timestamp).toBe("2026-07-01T18:00:00Z");
    expect((embed.image as { url: string }).url).toBe("https://image.tmdb.org/t/p/w500/abc.jpg");
    expect((embed.fields as { value: string }[])[0].value).toBe("2026-06-18 · 102 min · Todos · Animación");
    expect((embed.footer as { text: string }).text).toContain("2026");
  });

  it("omits image and url when snapshot lacks them", () => {
    const e: Event = {
      guid: "g2",
      type: "removed",
      filmId: "HO2",
      createdAt: "2026-07-01T18:00:00Z",
      snapshot: { ...snapshot, posterUrl: null, webUrl: "" },
    };
    const embed = buildDiscordEmbed(e) as Record<string, unknown>;
    expect(embed.color).toBe(0xe74c3c);
    expect(embed.image).toBeUndefined();
    expect(embed.url).toBeUndefined();
  });

  it("truncates long synopses to 350 chars", () => {
    const long = "A".repeat(500);
    const e: Event = {
      guid: "g3",
      type: "added",
      filmId: "HO3",
      createdAt: "2026-07-01T18:00:00Z",
      snapshot: { ...snapshot, shortSynopsis: long },
    };
    const embed = buildDiscordEmbed(e) as { description: string };
    expect(embed.description.length).toBeLessThanOrEqual(350);
    expect(embed.description.endsWith("\u2026")).toBe(true);
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
    const runDeps = () => catalogDeps({ availability: () => avail });

    // Run 1: empty previous state (cold start) -> seed state, archive no events.
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
    // Films sorted by id ascending (OCAPI order is unstable).
    expect(state.films.map((f) => f.id)).toEqual(["HO00000386", "HO00000471"]);
    expect(state.tmdbCache["HO00000471"]).toEqual({ tmdbId: 1, posterPath: "/abc.jpg" });
    expect(state.lastRun).toBe(fixedNow().toISOString());

    const after1 = loadPosts(join(dataDir, "posts.json"));
    expect(after1.posts).toHaveLength(0);

    const feed = await Bun.file(join(docsDir, "feed.xml")).text();
    expect(feed).not.toContain("Pronto: Toy Story 5");
    expect(feed).not.toContain("Pronto: F9");

    const html = await Bun.file(join(docsDir, "index.html")).text();
    expect(html).not.toContain("Toy Story 5");

    // Run 2: HO00000471 gains AdvanceBooking -> preventa opens (archived).
    avail = { HO00000471: ["ComingSoon", "AdvanceBooking"], HO00000386: ["NowShowing"] };
    await main({ dataDir, docsDir, feedUrl: "https://x/feed.xml", tmdbApiKey: "k", gitPush: false, deps: runDeps() });
    const after2 = loadPosts(join(dataDir, "posts.json"));
    expect(after2.posts.map((p) => p.type)).toEqual(["preventa-opens"]);
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
    const badDeps = deps({
      async fetchToken() {
        throw new Error("cloudflare");
      },
    });
    await expect(
      main({ dataDir, docsDir, gitPush: false, deps: badDeps }),
    ).rejects.toThrow("cloudflare");
    // The pre-existing state.json is unchanged and no posts were written.
    expect(loadState(statePath).films).toEqual([]);
    expect(loadPosts(join(dataDir, "posts.json")).posts).toEqual([]);
  });

  it("notifies on a lifecycle transition (run 2), not on cold start (run 1)", async () => {
    const dataDir = join(dir, "data-notify");
    const docsDir = join(dir, "docs-notify");
    let avail: Record<string, string[]> = {
      HO00000471: ["ComingSoon"],
      HO00000386: ["NowShowing"],
    };
    const rec = recordingNotifier();
    const notifyDeps = () =>
      catalogDeps({ availability: () => avail, notify: rec.notify });

    // Run 1: cold start -> no archive, no notification.
    await main({
      dataDir,
      docsDir,
      feedUrl: "https://x/feed.xml",
      tmdbApiKey: "k",
      gitPush: false,
      notifyWebhookUrl: "https://discord.example/webhook",
      deps: notifyDeps(),
    });
    expect(rec.events).toEqual([]);
    expect(loadPosts(join(dataDir, "posts.json")).posts).toHaveLength(0);

    // Run 2: transition -> notification fired with the preventa event.
    avail = { HO00000471: ["ComingSoon", "AdvanceBooking"], HO00000386: ["NowShowing"] };
    await main({
      dataDir,
      docsDir,
      feedUrl: "https://x/feed.xml",
      tmdbApiKey: "k",
      gitPush: false,
      notifyWebhookUrl: "https://discord.example/webhook",
      deps: notifyDeps(),
    });
    expect(rec.events.map((e) => e.type)).toEqual(["preventa-opens"]);
  });

  it("skips notification when no webhook URL is configured", async () => {
    const dataDir = join(dir, "data-no-webhook");
    const docsDir = join(dir, "docs-no-webhook");
    let notifyCalled = false;
    // Seed non-cold state so a real transition would notify if the URL guard broke.
    await Bun.write(
      join(dataDir, "state.json"),
      JSON.stringify({
        films: [
          {
            id: "HO00000471",
            title: "Toy Story 5",
            shortSynopsis: "",
            releaseDate: null,
            runtimeInMinutes: null,
            censorRating: "",
            genres: [],
            director: "",
            webUrl: "",
            categories: ["ComingSoon"],
            posterUrl: null,
          },
        ],
        tmdbCache: {},
        lastRun: "2026-06-01T00:00:00.000Z",
      }),
    );

    // Transition with no webhook URL — archive still written, notify must not run.
    await main({
      dataDir,
      docsDir,
      feedUrl: "https://x/feed.xml",
      tmdbApiKey: "k",
      gitPush: false,
      deps: catalogDeps({
        availability: {
          HO00000471: ["ComingSoon", "AdvanceBooking"],
          HO00000386: ["NowShowing"],
        },
        async notify() {
          notifyCalled = true;
        },
      }),
    });
    expect(loadPosts(join(dataDir, "posts.json")).posts.map((p) => p.type)).toContain(
      "preventa-opens",
    );
    expect(notifyCalled).toBe(false);
  });

  it("does not abort the scrape when notify throws", async () => {
    const dataDir = join(dir, "data-notify-fail");
    const docsDir = join(dir, "docs-notify-fail");
    // Seed state so run 1 is not a cold start (prev.films.length > 0).
    await Bun.write(
      join(dataDir, "state.json"),
      JSON.stringify({
        films: [
          {
            id: "HO00000471",
            title: "Toy Story 5",
            shortSynopsis: "",
            releaseDate: null,
            runtimeInMinutes: null,
            censorRating: "",
            genres: [],
            director: "",
            webUrl: "",
            categories: ["ComingSoon"],
            posterUrl: null,
          },
        ],
        tmdbCache: {},
        lastRun: "2026-06-01T00:00:00.000Z",
      }),
    );

    // Should complete successfully despite notify throwing.
    await expect(
      main({
        dataDir,
        docsDir,
        feedUrl: "https://x/feed.xml",
        tmdbApiKey: "k",
        gitPush: false,
        notifyWebhookUrl: "https://discord.example/webhook",
        deps: catalogDeps({
          // Gains AdvanceBooking -> preventa-opens event -> triggers notify.
          availability: {
            HO00000471: ["ComingSoon", "AdvanceBooking"],
            HO00000386: ["NowShowing"],
          },
          async notify() {
            throw new Error("discord 500");
          },
        }),
      }),
    ).resolves.toBeUndefined();

    // Files were still written despite the notification failure.
    const posts = loadPosts(join(dataDir, "posts.json"));
    expect(posts.posts.map((p) => p.type)).toContain("preventa-opens");
  });

  it("soft-keeps a missing film once, removes at threshold, re-adds after full remove", async () => {
    const dataDir = join(dir, "data-debounce");
    const docsDir = join(dir, "docs-debounce");
    const rec = {
      id: "HO00000471",
      title: "Toy Story 5",
      shortSynopsis: "Sinopsis de Toy Story 5",
      releaseDate: "2026-06-18",
      runtimeInMinutes: 102,
      censorRating: "Todos",
      genres: ["Animación"],
      director: "Pixar Director",
      webUrl: "https://www.cinecolombia.com/films/toy-story-5/HO00000471/",
      categories: ["ComingSoon"],
      posterUrl: "https://image.tmdb.org/t/p/w500/abc.jpg",
      tmdb: { tmdbId: 1, posterPath: "/abc.jpg" },
    };
    const recB = {
      ...rec,
      id: "HO00000386",
      title: "F9",
      shortSynopsis: "Sinopsis de F9",
      categories: ["NowShowing"],
      webUrl: "",
    };
    await Bun.write(
      join(dataDir, "state.json"),
      JSON.stringify({
        films: [recB, rec],
        tmdbCache: {
          HO00000471: { tmdbId: 1, posterPath: "/abc.jpg" },
          HO00000386: { tmdbId: 1, posterPath: "/abc.jpg" },
        },
        missingRuns: {},
        lastRun: "2026-06-01T00:00:00.000Z",
      }) + "\n",
    );
    await Bun.write(join(dataDir, "posts.json"), JSON.stringify({ posts: [] }) + "\n");

    let filmIds = ["HO00000386"]; // A absent once
    const runDeps = () => catalogDeps({ filmIds: () => filmIds });

    await main({
      dataDir,
      docsDir,
      feedUrl: "https://x/feed.xml",
      tmdbApiKey: "k",
      gitPush: false,
      deps: runDeps(),
    });
    let state = loadState(join(dataDir, "state.json"));
    expect(state.films.map((f) => f.id).sort()).toEqual(["HO00000386", "HO00000471"]);
    expect(state.missingRuns).toEqual({ HO00000471: 1 });
    expect(loadPosts(join(dataDir, "posts.json")).posts).toHaveLength(0);

    // Second absence → removed
    await main({
      dataDir,
      docsDir,
      feedUrl: "https://x/feed.xml",
      tmdbApiKey: "k",
      gitPush: false,
      deps: runDeps(),
    });
    state = loadState(join(dataDir, "state.json"));
    expect(state.films.map((f) => f.id)).toEqual(["HO00000386"]);
    expect(state.missingRuns).toEqual({});
    expect(loadPosts(join(dataDir, "posts.json")).posts.map((p) => `${p.type}:${p.filmId}`)).toEqual([
      "removed:HO00000471",
    ]);

    // Re-add A (true new after full remove), then soft-miss once and return → no second added/removed.
    filmIds = ["HO00000386", "HO00000471"];
    await main({
      dataDir,
      docsDir,
      feedUrl: "https://x/feed.xml",
      tmdbApiKey: "k",
      gitPush: false,
      deps: runDeps(),
    });
    expect(
      loadPosts(join(dataDir, "posts.json")).posts.map((p) => `${p.type}:${p.filmId}`),
    ).toEqual(["removed:HO00000471", "added:HO00000471"]);

    filmIds = ["HO00000386"];
    await main({
      dataDir,
      docsDir,
      feedUrl: "https://x/feed.xml",
      tmdbApiKey: "k",
      gitPush: false,
      deps: runDeps(),
    });
    expect(loadState(join(dataDir, "state.json")).missingRuns).toEqual({ HO00000471: 1 });
    filmIds = ["HO00000386", "HO00000471"];
    const postsBeforeReturn = loadPosts(join(dataDir, "posts.json")).posts.length;
    await main({
      dataDir,
      docsDir,
      feedUrl: "https://x/feed.xml",
      tmdbApiKey: "k",
      gitPush: false,
      deps: runDeps(),
    });
    expect(loadPosts(join(dataDir, "posts.json")).posts).toHaveLength(postsBeforeReturn);
    expect(loadState(join(dataDir, "state.json")).missingRuns).toEqual({});
  });

  it("archives re-adds after emptied catalog (not cold start when lastRun set)", async () => {
    const dataDir = join(dir, "data-wipe-recovery");
    const docsDir = join(dir, "docs-wipe-recovery");
    await Bun.write(
      join(dataDir, "state.json"),
      JSON.stringify({
        films: [],
        tmdbCache: { HO00000471: { tmdbId: 1, posterPath: "/abc.jpg" } },
        missingRuns: {},
        lastRun: "2026-06-01T00:00:00.000Z",
      }) + "\n",
    );
    await Bun.write(
      join(dataDir, "posts.json"),
      JSON.stringify({
        posts: [
          {
            guid: "old-removed",
            type: "removed",
            filmId: "HO00000471",
            createdAt: "2026-06-01T00:00:00.000Z",
            snapshot: {
              id: "HO00000471",
              title: "Toy Story 5",
              shortSynopsis: "",
              releaseDate: null,
              runtimeInMinutes: null,
              censorRating: "",
              genres: [],
              director: "",
              webUrl: "",
              categories: ["ComingSoon"],
              posterUrl: null,
            },
          },
        ],
      }) + "\n",
    );
    const rec = recordingNotifier();
    await main({
      dataDir,
      docsDir,
      feedUrl: "https://x/feed.xml",
      tmdbApiKey: "k",
      gitPush: false,
      notifyWebhookUrl: "https://discord.example/webhook",
      deps: deps({ notify: rec.notify }),
    });
    const posts = loadPosts(join(dataDir, "posts.json")).posts.map((p) => `${p.type}:${p.filmId}`);
    // HO00000471 is ComingSoon → added; HO00000386 is NowShowing → highest-stage now-in-theaters
    expect(posts).toContain("added:HO00000471");
    expect(posts).toContain("now-in-theaters:HO00000386");
    expect(rec.events.map((e) => `${e.type}:${e.filmId}`)).toEqual(
      expect.arrayContaining(["added:HO00000471", "now-in-theaters:HO00000386"]),
    );
  });

  it("aborts empty catalog without writing when previous films exist", async () => {
    const dataDir = join(dir, "data-empty-catalog");
    const docsDir = join(dir, "docs-empty-catalog");
    const seeded = {
      films: [
        {
          id: "HO00000471",
          title: "Toy Story 5",
          shortSynopsis: "",
          releaseDate: null,
          runtimeInMinutes: null,
          censorRating: "",
          genres: [],
          director: "",
          webUrl: "",
          categories: ["ComingSoon"],
          posterUrl: null,
        },
      ],
      tmdbCache: {},
      lastRun: "2026-06-01T00:00:00.000Z",
    };
    await Bun.write(join(dataDir, "state.json"), JSON.stringify(seeded) + "\n");
    await Bun.write(join(dataDir, "posts.json"), JSON.stringify({ posts: [] }) + "\n");
    await expect(
      main({
        dataDir,
        docsDir,
        feedUrl: "https://x/feed.xml",
        gitPush: false,
        deps: catalogDeps({
          films: { ...filmsResponse(), films: [] },
          availability: {},
        }),
      }),
    ).rejects.toThrow("empty OCAPI catalog");
    expect(loadState(join(dataDir, "state.json")).films).toHaveLength(1);
    expect(loadPosts(join(dataDir, "posts.json")).posts).toHaveLength(0);
  });

  it("does not bump lastRun on a quiet identical rerun", async () => {
    const dataDir = join(dir, "data-quiet-lastrun");
    const docsDir = join(dir, "docs-quiet-lastrun");
    let tick = 0;
    const advancingNow = () => new Date(Date.UTC(2026, 6, 1, 18, tick++, 0));
    const runDeps = () => catalogDeps({ now: advancingNow });
    await main({
      dataDir,
      docsDir,
      feedUrl: "https://x/feed.xml",
      tmdbApiKey: "k",
      gitPush: false,
      deps: runDeps(),
    });
    const last1 = loadState(join(dataDir, "state.json")).lastRun;
    expect(last1).toBeTruthy();
    const stateJson1 = await Bun.file(join(dataDir, "state.json")).text();
    const postsJson1 = await Bun.file(join(dataDir, "posts.json")).text();
    await main({
      dataDir,
      docsDir,
      feedUrl: "https://x/feed.xml",
      tmdbApiKey: "k",
      gitPush: false,
      deps: runDeps(),
    });
    const last2 = loadState(join(dataDir, "state.json")).lastRun;
    expect(last2).toBe(last1);
    expect(await Bun.file(join(dataDir, "state.json")).text()).toBe(stateJson1);
    expect(await Bun.file(join(dataDir, "posts.json")).text()).toBe(postsJson1);
  });

  it("aborts bulk removal above cap without writing", async () => {
    expect(maxRemovalsAllowed(20)).toBe(10);
    expect(maxRemovalsAllowed(5)).toBe(5);

    const dataDir = join(dir, "data-bulk-remove");
    const docsDir = join(dir, "docs-bulk-remove");
    // 20 known films already at missingRuns=1 → next absence emits 20 removed (> cap 10).
    const many = Array.from({ length: 20 }, (_, i) => {
      const id = `HO${String(i).padStart(8, "0")}`;
      return {
        id,
        title: id,
        shortSynopsis: "",
        releaseDate: null,
        runtimeInMinutes: null,
        censorRating: "",
        genres: [] as string[],
        director: "",
        webUrl: "",
        categories: ["NowShowing"],
        posterUrl: null,
      };
    });
    const missingRuns: Record<string, number> = {};
    for (const f of many) missingRuns[f.id] = 1;
    await Bun.write(
      join(dataDir, "state.json"),
      JSON.stringify({
        films: many,
        tmdbCache: {},
        missingRuns,
        lastRun: "2026-06-01T00:00:00.000Z",
      }) + "\n",
    );
    await Bun.write(join(dataDir, "posts.json"), JSON.stringify({ posts: [] }) + "\n");

    // Current catalog is a single survivor — 19 removals would fire at threshold.
    const survivor = many[0]!;
    await expect(
      main({
        dataDir,
        docsDir,
        feedUrl: "https://x/feed.xml",
        gitPush: false,
        deps: catalogDeps({
          films: {
            films: [
              {
                id: survivor.id,
                hopk: survivor.id,
                title: { text: survivor.title },
                shortSynopsis: { text: "" },
              },
            ],
            relatedData: {
              castAndCrew: [],
              genres: [],
              censorRatings: [],
              events: [],
            },
          },
          availability: { [survivor.id]: ["NowShowing"] },
        }),
      }),
    ).rejects.toThrow("refusing bulk removal");

    expect(loadState(join(dataDir, "state.json")).films).toHaveLength(20);
    expect(loadPosts(join(dataDir, "posts.json")).posts).toHaveLength(0);
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
