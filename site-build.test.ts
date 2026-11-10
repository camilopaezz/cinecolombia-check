import { it, expect } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { FilmRecord, Event } from "./domain";

it("builds Astro HTML and RSS from stored data, escapes content, and limits history", async () => {
  mkdirSync(join(import.meta.dir, ".astro"), { recursive: true });
  const dir = mkdtempSync(join(import.meta.dir, ".astro", "test-"));
  const film: FilmRecord = { id: "HO1", title: "<script>alert('x')</script>", shortSynopsis: "Safe & sound",
    releaseDate: "2026-07-02", runtimeInMinutes: 90, censorRating: "Todos", genres: ["Drama"], director: "Director",
    webUrl: "https://www.cinecolombia.com/peliculas/film", posterUrl: null,
    categories: ["NowShowing", "AdvanceBooking"], availabilityRows: [{ siteId: null, categories: ["NowShowing"] }] };
  const posts: Event[] = Array.from({ length: 101 }, (_, i) => ({ guid: `g-${i}`, type: "added", filmId: film.id,
    snapshot: { ...film, title: `Historical ${i}` }, createdAt: new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString() }));
  writeFileSync(join(dir, "state.json"), JSON.stringify({ films: [film], tmdbCache: {}, lastRun: "2026-07-01T18:00:00Z" }));
  writeFileSync(join(dir, "posts.json"), JSON.stringify({ posts }));
  try {
    const child = Bun.spawn(["node", "node_modules/astro/bin/astro.mjs", "build"], {
      cwd: import.meta.dir, env: { ...process.env, ASTRO_TELEMETRY_DISABLED: "1", CINECO_DATA_DIR: dir, CINECO_DIST_DIR: join(dir, "dist"), FEED_TITLE: "Test Feed", FEED_URL: "https://example.com/feed.xml" },
      stdout: "pipe", stderr: "pipe",
    });
    const stdout = Bun.readableStreamToText(child.stdout);
    const stderr = Bun.readableStreamToText(child.stderr);
    expect(await child.exited, (await stdout) + (await stderr)).toBe(0);
    const html = readFileSync(join(dir, "dist/index.html"), "utf8");
    expect(html).toContain("Próximos estrenos");
    expect(html).toContain("Preventa");
    expect(html).not.toContain("No indica la hora");
    expect(html).not.toContain("NowShowing");
    expect(html).toContain('datetime="2026-07-01T18:00:00Z"');
    expect(html).not.toContain("><script>alert");
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain('<article class="post"');
    expect(html).toContain('href="/historial"');
    const history = readFileSync(join(dir, "dist/historial/index.html"), "utf8");
    expect(history.match(/<article class="post"/g)).toHaveLength(100);
    expect(history).toContain("Historical 100");
    expect(history).not.toContain("Historical 0<");
    expect(history).toContain('href="/"');
    expect(history).toContain('href="#contenido"');
    expect(history).not.toContain('id="catalogo"');
    expect(html).toContain("film-search");
    expect(html).toContain('href="/feed.xml"');
    expect(html).toContain('href="/_astro/');
    const rss = readFileSync(join(dir, "dist/feed.xml"), "utf8");
    expect(rss.match(/<item>/g)).toHaveLength(100);
    expect(rss).toContain("https://example.com/feed.xml");
    expect(rss).toContain("Safe &amp; sound");
  } finally { rmSync(dir, { recursive: true, force: true }); }
}, 60_000);
