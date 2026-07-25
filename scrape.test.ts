import { beforeAll, describe, expect, it, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
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
  applyLifecycle,
  buildFilmRecords,
  buildDiscordEmbed,
  diff,
  enrichPosters,
  extractAuthToken,
  FEED_LIMIT,
  formatCommitMessage,
  generateFeed,
  generateHTML,
  loadPosts,
  loadState,
  main,
  maxRemovalsAllowed,
  parseSitemap,
  REMOVAL_THRESHOLD,
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
  async notify() {},
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

describe("applyLifecycle (removal debounce)", () => {
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

  it("missing once: no removed, film stays soft-missing, missingRuns=1", () => {
    counter = 0;
    const prev = { films: [rec("A", ["NowShowing"])], missingRuns: {} };
    const result = applyLifecycle(prev, [], D);
    expect(result.events).toHaveLength(0);
    expect(result.films.map((f) => f.id)).toEqual(["A"]);
    expect(result.missingRuns).toEqual({ A: 1 });
  });

  it("missing twice (REMOVAL_THRESHOLD): emits removed and drops film", () => {
    counter = 0;
    expect(REMOVAL_THRESHOLD).toBe(2);
    const prev = {
      films: [rec("A", ["NowShowing"], "Gone Film")],
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
      films: [rec("A", ["NowShowing"], "Old Title")],
      missingRuns: { A: 1 },
    };
    const returned = [rec("A", ["NowShowing"], "Updated Title")];
    const result = applyLifecycle(soft, returned, D);
    expect(result.events).toHaveLength(0);
    expect(result.films).toHaveLength(1);
    expect(result.films[0]!.title).toBe("Updated Title");
    expect(result.missingRuns).toEqual({});
  });

  it("truly new film still emits added; gains still emit", () => {
    counter = 0;
    const prev = { films: [rec("A", ["ComingSoon"])] };
    const cur = [
      rec("A", ["ComingSoon", "AdvanceBooking"]),
      rec("B", ["NowShowing"]),
    ];
    const result = applyLifecycle(prev, cur, D);
    expect(result.events.map((e) => `${e.type}:${e.filmId}`)).toEqual([
      "added:B",
      "preventa-opens:A",
    ]);
    expect(result.missingRuns).toEqual({});
  });

  it("same-run preventa + now collapses to only now-in-theaters for existing film", () => {
    counter = 0;
    const prev = { films: [rec("A", ["ComingSoon"])] };
    const cur = [rec("A", ["ComingSoon", "AdvanceBooking", "NowShowing"])];
    const result = applyLifecycle(prev, cur, D);
    expect(result.events.map((e) => `${e.type}:${e.filmId}`)).toEqual(["now-in-theaters:A"]);
  });

  it("separate runs still emit preventa then now independently", () => {
    counter = 0;
    const afterPreventa = applyLifecycle(
      { films: [rec("A", ["ComingSoon"])] },
      [rec("A", ["ComingSoon", "AdvanceBooking"])],
      D,
    );
    expect(afterPreventa.events.map((e) => `${e.type}:${e.filmId}`)).toEqual(["preventa-opens:A"]);
    const afterNow = applyLifecycle(
      { films: afterPreventa.films, missingRuns: afterPreventa.missingRuns },
      [rec("A", ["ComingSoon", "AdvanceBooking", "NowShowing"])],
      D,
    );
    expect(afterNow.events.map((e) => `${e.type}:${e.filmId}`)).toEqual(["now-in-theaters:A"]);
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
    const runDeps = (): Deps => ({
      ...deps(),
      async ocapi(_t, path) {
        if (path === "films") return filmsResponse();
        if (path === "films/availability") return availability(avail);
        throw new Error(`unexpected path ${path}`);
      },
    });

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

  it("notifies on a lifecycle transition (run 2), not on cold start (run 1)", async () => {
    const dataDir = join(dir, "data-notify");
    const docsDir = join(dir, "docs-notify");
    let avail: Record<string, string[]> = {
      HO00000471: ["ComingSoon"],
      HO00000386: ["NowShowing"],
    };
    const notified: string[] = [];
    const notifyDeps = (): Deps => ({
      ...deps(),
      async ocapi(_t, path) {
        if (path === "films") return filmsResponse();
        if (path === "films/availability") return availability(avail);
        throw new Error(`unexpected path ${path}`);
      },
      async notify(events) {
        notified.push(...events.map((e) => e.type));
      },
    });

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
    expect(notified).toEqual([]);
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
    expect(notified).toEqual(["preventa-opens"]);
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
    const notifyDeps = (): Deps => ({
      ...deps(),
      async ocapi(_t, path) {
        if (path === "films") return filmsResponse();
        if (path === "films/availability")
          return availability({
            HO00000471: ["ComingSoon", "AdvanceBooking"],
            HO00000386: ["NowShowing"],
          });
        throw new Error(`unexpected path ${path}`);
      },
      async notify() {
        notifyCalled = true;
      },
    });

    // Transition with no webhook URL — archive still written, notify must not run.
    await main({
      dataDir,
      docsDir,
      feedUrl: "https://x/feed.xml",
      tmdbApiKey: "k",
      gitPush: false,
      deps: notifyDeps(),
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
    const failDeps = (): Deps => ({
      ...deps(),
      async ocapi(_t, path) {
        if (path === "films") return filmsResponse();
        if (path === "films/availability")
          // Gains AdvanceBooking -> preventa-opens event -> triggers notify.
          return availability({ HO00000471: ["ComingSoon", "AdvanceBooking"], HO00000386: ["NowShowing"] });
        throw new Error(`unexpected path ${path}`);
      },
      async notify() {
        throw new Error("discord 500");
      },
    });

    // Should complete successfully despite notify throwing.
    await expect(
      main({
        dataDir,
        docsDir,
        feedUrl: "https://x/feed.xml",
        tmdbApiKey: "k",
        gitPush: false,
        notifyWebhookUrl: "https://discord.example/webhook",
        deps: failDeps(),
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
    const runDeps = (): Deps => ({
      ...deps(),
      async ocapi(_t, path) {
        if (path === "films") {
          const full = filmsResponse();
          return { ...full, films: full.films.filter((f) => filmIds.includes(f.id)) };
        }
        if (path === "films/availability")
          return availability({ HO00000471: ["ComingSoon"], HO00000386: ["NowShowing"] });
        throw new Error(`unexpected path ${path}`);
      },
    });

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
    const notified: string[] = [];
    await main({
      dataDir,
      docsDir,
      feedUrl: "https://x/feed.xml",
      tmdbApiKey: "k",
      gitPush: false,
      notifyWebhookUrl: "https://discord.example/webhook",
      deps: {
        ...deps(),
        async notify(events) {
          notified.push(...events.map((e) => `${e.type}:${e.filmId}`));
        },
      },
    });
    const posts = loadPosts(join(dataDir, "posts.json")).posts.map((p) => `${p.type}:${p.filmId}`);
    expect(posts).toContain("added:HO00000471");
    expect(posts).toContain("added:HO00000386");
    expect(notified).toEqual(expect.arrayContaining(["added:HO00000471", "added:HO00000386"]));
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
        deps: {
          ...deps(),
          async ocapi(_t, path) {
            if (path === "films") return { ...filmsResponse(), films: [] };
            if (path === "films/availability") return availability({});
            throw new Error(`unexpected path ${path}`);
          },
        },
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
    const base = deps();
    const runDeps = (): Deps => ({
      ...base,
      now: advancingNow,
      async ocapi(_t, path) {
        if (path === "films") return filmsResponse();
        if (path === "films/availability")
          return availability({ HO00000471: ["ComingSoon"], HO00000386: ["NowShowing"] });
        throw new Error(`unexpected path ${path}`);
      },
    });
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
        deps: {
          ...deps(),
          async ocapi(_t, path) {
            if (path === "films") {
              return {
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
              } satisfies FilmsResponse;
            }
            if (path === "films/availability")
              return availability({ [survivor.id]: ["NowShowing"] });
            throw new Error(`unexpected path ${path}`);
          },
        },
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
