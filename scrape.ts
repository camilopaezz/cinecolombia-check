#!/usr/bin/env bun
// Cinecolombia lifecycle feed — single-file scraper.
// See PRD.md / issues/*.md. Bun + TypeScript, stdlib + git CLI only.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// node:crypto not imported — `crypto` is a global in Bun.

// ─── Types ───────────────────────────────────────────────────────────────────

interface Localized {
  text: string;
  translations?: { languageTag: string; text: string }[];
}

interface ApiFilm {
  id: string;
  hopk: string;
  hoCode?: string;
  eventId?: string | null;
  title: Localized;
  synopsis?: Localized;
  shortSynopsis?: Localized;
  releaseDate?: string | null;
  runtimeInMinutes?: number | null;
  censorRatingId?: string | null;
  genreIds?: string[];
  castAndCrew?: { castAndCrewMemberId: string; roles: string[] }[];
  actors?: { castAndCrewMemberId: string }[];
  directors?: { castAndCrewMemberId: string }[];
  producers?: { castAndCrewMemberId: string }[];
  trailers?: { provider: string; uri: string }[];
  displayPriority?: number;
}

export interface FilmsResponse {
  films: ApiFilm[];
  relatedData: {
    castAndCrew: { id: string; name: { givenName?: string; familyName?: string; middleName?: string } }[];
    genres: { id: string; name: Localized; description?: string }[];
    censorRatings: {
      id: string;
      classification: Localized;
      classificationDescription?: Localized;
      ageRestriction?: { minimumAge: number };
    }[];
    events: unknown[];
  };
}

export interface AvailabilityResponse {
  filmAvailabilities: {
    filmId: string;
    siteId: string | null;
    categories: string[];
    showtimeAttributeIds?: string[];
  }[];
}

export type EventType = "added" | "preventa-opens" | "now-in-theaters" | "removed";

export interface FilmRecord {
  id: string;
  title: string;
  shortSynopsis: string;
  releaseDate: string | null;
  runtimeInMinutes: number | null;
  censorRating: string;
  genres: string[];
  director: string;
  webUrl: string;
  categories: string[];
  posterUrl: string | null;
  tmdb?: { tmdbId: number; posterPath: string | null };
}

export interface Event {
  guid: string;
  type: EventType;
  filmId: string;
  createdAt: string; // ISO-8601 UTC
  snapshot: FilmRecord;
}

export interface State {
  films: FilmRecord[];
  tmdbCache: Record<string, { tmdbId: number; posterPath: string | null }>;
  /** Consecutive runs a film was absent while still soft-kept in `films`. */
  missingRuns?: Record<string, number>;
  lastRun?: string;
}

/** Emit `removed` only after this many consecutive absent runs (debounce flaps). */
export const REMOVAL_THRESHOLD = 2;

export interface PostArchive {
  posts: Event[];
}

export interface Deps {
  fetchToken: () => Promise<string>;
  ocapi: (token: string, path: string) => Promise<unknown>;
  fetchSitemap: () => Promise<string>;
  tmdb: (
    apiKey: string,
    query: string,
    year: string | null,
  ) => Promise<{ tmdbId: number; posterPath: string | null } | null>;
  now: () => Date;
  uuid: () => string;
  notify: (events: Event[], webhookUrl: string) => Promise<void>;
}

export interface MainOptions {
  dataDir?: string;
  docsDir?: string;
  tmdbApiKey?: string;
  feedUrl?: string;
  feedTitle?: string;
  gitPush?: boolean;
  notifyWebhookUrl?: string;
  deps?: Partial<Deps>;
}

// ─── Small helpers ───────────────────────────────────────────────────────────

const txt = (v?: Localized): string => v?.text ?? "";

const personName = (n?: { givenName?: string; familyName?: string; middleName?: string }): string =>
  [n?.givenName, n?.middleName, n?.familyName].filter(Boolean).join(" ").trim();

const EVENT_LABELS: Record<EventType, string> = {
  added: "Pronto",
  "preventa-opens": "Preventa abierta",
  "now-in-theaters": "En cartelera",
  removed: "Ya no disponible",
};

// Categories that, when gained, produce an event (ComingSoon produces none).
const GAIN_EVENTS: { category: string; type: EventType }[] = [
  { category: "AdvanceBooking", type: "preventa-opens" },
  { category: "NowShowing", type: "now-in-theaters" },
];

function ensureDir(dir: string): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

function atomicWrite(path: string, contents: string): void {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, contents);
  renameSync(tmp, path);
}

const filmsToMap = (films: FilmRecord[]): Map<string, FilmRecord> =>
  new Map(films.map((f) => [f.id, f]));

// ─── Parsing ─────────────────────────────────────────────────────────────────

export function extractAuthToken(html: string): string {
  const key = "window.initialData";
  const idx = html.indexOf(key);
  if (idx < 0) throw new Error("window.initialData not found in homepage");
  let i = idx + key.length;
  while (i < html.length && (html[i] === " " || html[i] === "=" || html[i] === "(")) i++;
  if (html[i] !== "{") throw new Error("initialData is not an object literal");
  const start = i;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (; i < html.length; i++) {
    const c = html[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
    } else if (c === '"') {
      inStr = true;
    } else if (c === "{") {
      depth++;
    } else if (c === "}") {
      depth--;
      if (depth === 0) {
        i++;
        break;
      }
    }
  }
  const data = JSON.parse(html.slice(start, i)) as { api?: { authToken?: string } };
  if (!data.api?.authToken) throw new Error("authToken missing from initialData.api");
  return data.api.authToken;
}

export function parseSitemap(xml: string): Record<string, string> {
  const map: Record<string, string> = {};
  for (const m of xml.matchAll(/<loc>([^<]+)<\/loc>/g)) {
    let url = m[1].trim();
    if (url.startsWith("http://")) url = `https://${url.slice("http://".length)}`;
    const ho = url.match(/\/films\/[^/]+\/(HO\w+)\//);
    if (ho) map[ho[1]] = url;
  }
  return map;
}

function sortedUnique(values: string[]): string[] {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b, "en"));
}

/** Union availability categories across all site rows for each filmId. */
export function mergeAvailabilityCategories(
  rows: AvailabilityResponse["filmAvailabilities"],
): Map<string, string[]> {
  const avail = new Map<string, string[]>();
  for (const row of rows) {
    const prev = avail.get(row.filmId) ?? [];
    avail.set(row.filmId, sortedUnique([...prev, ...row.categories]));
  }
  return avail;
}

export function buildFilmRecords(
  filmsRes: FilmsResponse,
  availRes: AvailabilityResponse,
  sitemap: Record<string, string>,
): FilmRecord[] {
  const cast = new Map(filmsRes.relatedData.castAndCrew.map((c) => [c.id, c.name]));
  const genres = new Map(filmsRes.relatedData.genres.map((g) => [g.id, txt(g.name)]));
  const censor = new Map(filmsRes.relatedData.censorRatings.map((c) => [c.id, txt(c.classification)]));
  const avail = mergeAvailabilityCategories(availRes.filmAvailabilities);

  return filmsRes.films.map((f): FilmRecord => {
    const directorId = f.directors?.[0]?.castAndCrewMemberId;
    const director = directorId ? personName(cast.get(directorId)) : "";
    return {
      id: f.id,
      title: txt(f.title),
      shortSynopsis: txt(f.shortSynopsis) || txt(f.synopsis),
      releaseDate: f.releaseDate ?? null,
      runtimeInMinutes: f.runtimeInMinutes ?? null,
      censorRating: f.censorRatingId ? censor.get(f.censorRatingId) ?? "" : "",
      genres: sortedUnique((f.genreIds ?? []).map((id) => genres.get(id) ?? "").filter(Boolean)),
      director,
      webUrl: sitemap[f.id] ?? "",
      categories: avail.get(f.id) ?? [],
      posterUrl: null,
    };
  });
}

// ─── Diff / lifecycle ────────────────────────────────────────────────────────

export function diff(
  prev: Map<string, FilmRecord>,
  current: Map<string, FilmRecord>,
  deps: { now: () => Date; uuid: () => string },
): Event[] {
  // Immediate add/gain/remove (no debounce). Prefer applyLifecycle in production.
  const events: Event[] = [];
  const createdAt = deps.now().toISOString();
  const mk = (type: EventType, filmId: string, snapshot: FilmRecord): Event => ({
    guid: deps.uuid(),
    type,
    filmId,
    createdAt,
    snapshot,
  });

  // 1. New films -> a single "added" announcement (no duplicate preventa/now posts).
  for (const id of [...current.keys()].sort()) {
    if (!prev.has(id)) events.push(mk("added", id, current.get(id)!));
  }
  // 2. Existing films that gain a lifecycle category.
  for (const id of [...current.keys()].sort()) {
    const cur = current.get(id)!;
    const p = prev.get(id);
    if (!p) continue;
    for (const { category, type } of GAIN_EVENTS) {
      if (cur.categories.includes(category) && !p.categories.includes(category)) {
        events.push(mk(type, id, cur));
      }
    }
  }
  // 3. Films that left the catalog (immediate — tests / legacy).
  for (const id of [...prev.keys()].sort()) {
    if (!current.has(id)) events.push(mk("removed", id, prev.get(id)!));
  }
  return events;
}

/**
 * Lifecycle with removal debounce.
 * Soft-missing films stay in `films` until REMOVAL_THRESHOLD consecutive absences.
 * Reappearance under threshold clears the counter and does not emit `added`.
 */
export function applyLifecycle(
  prev: { films: FilmRecord[]; missingRuns?: Record<string, number> },
  current: FilmRecord[],
  deps: { now: () => Date; uuid: () => string },
): { events: Event[]; films: FilmRecord[]; missingRuns: Record<string, number> } {
  const prevMap = filmsToMap(prev.films);
  const curMap = filmsToMap(current);
  const missingRuns: Record<string, number> = { ...(prev.missingRuns ?? {}) };
  const events: Event[] = [];
  const createdAt = deps.now().toISOString();
  const mk = (type: EventType, filmId: string, snapshot: FilmRecord): Event => ({
    guid: deps.uuid(),
    type,
    filmId,
    createdAt,
    snapshot,
  });

  // 1. Truly new films (not in prev.films, which includes soft-missing).
  for (const id of [...curMap.keys()].sort()) {
    if (!prevMap.has(id)) events.push(mk("added", id, curMap.get(id)!));
  }

  // 2. Category gains on films already known (incl. soft-missing reappearance).
  // Same-run AdvanceBooking + NowShowing → only now-in-theaters (prefer operational "in theaters").
  for (const id of [...curMap.keys()].sort()) {
    const cur = curMap.get(id)!;
    const p = prevMap.get(id);
    if (!p) continue;
    if (missingRuns[id]) delete missingRuns[id];
    const gained = GAIN_EVENTS.filter(
      ({ category }) => cur.categories.includes(category) && !p.categories.includes(category),
    );
    const collapseToNow =
      gained.some((g) => g.category === "AdvanceBooking") &&
      gained.some((g) => g.category === "NowShowing");
    for (const { category, type } of gained) {
      if (collapseToNow && category === "AdvanceBooking") continue;
      events.push(mk(type, id, cur));
    }
  }

  // 3. Absent films: increment missingRuns; only emit removed at threshold.
  // Empty current catalog is refused by main() before we get here.
  const softKept: FilmRecord[] = [];
  for (const id of [...prevMap.keys()].sort()) {
    if (curMap.has(id)) continue;
    const count = (missingRuns[id] ?? 0) + 1;
    if (count >= REMOVAL_THRESHOLD) {
      events.push(mk("removed", id, prevMap.get(id)!));
      delete missingRuns[id];
    } else {
      missingRuns[id] = count;
      softKept.push(prevMap.get(id)!);
    }
  }

  // Present films (current snapshot) + soft-missing still under threshold.
  const nextFilms = [...current, ...softKept].sort((a, b) => a.id.localeCompare(b.id));
  return { events, films: nextFilms, missingRuns };
}

// ─── TMDB ────────────────────────────────────────────────────────────────────

export async function enrichPosters(
  films: FilmRecord[],
  cache: Record<string, { tmdbId: number; posterPath: string | null }>,
  apiKey: string | undefined,
  tmdb: Deps["tmdb"],
): Promise<void> {
  if (!apiKey) return;
  for (const film of films) {
    const cached = cache[film.id];
    if (cached) {
      film.tmdb = cached;
      film.posterUrl = cached.posterPath ? `https://image.tmdb.org/t/p/w500${cached.posterPath}` : null;
      continue;
    }
    const year = film.releaseDate ? film.releaseDate.slice(0, 4) : null;
    // ponytail: TMDB is image-only and auxiliary — never let it abort the scrape.
    let result: { tmdbId: number; posterPath: string | null } | null;
    try {
      result = await tmdb(apiKey, film.title, year);
    } catch {
      result = null;
    }
    if (result) {
      cache[film.id] = result;
      film.tmdb = result;
      film.posterUrl = result.posterPath ? `https://image.tmdb.org/t/p/w500${result.posterPath}` : null;
    }
  }
}

// ─── Output generation ───────────────────────────────────────────────────────

/** Newest N posts rendered in public feed/HTML; posts.json keeps full history. */
export const FEED_LIMIT = 100;

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function rfc822(iso: string): string {
  return new Date(iso).toUTCString();
}

function bogotaDate(iso: string): string {
  return new Intl.DateTimeFormat("es-CO", {
    timeZone: "America/Bogota",
    dateStyle: "long",
    timeStyle: "short",
  }).format(new Date(iso));
}

export function generateFeed(
  posts: Event[],
  opts: { feedTitle: string; feedUrl: string; language: string },
): string {
  const items = posts
    .slice()
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, FEED_LIMIT)
    .map((p) => {
      const title = `${EVENT_LABELS[p.type]}: ${p.snapshot.title}`;
      const media = p.snapshot.posterUrl
        ? `\n      <media:content url="${escapeXml(p.snapshot.posterUrl)}" medium="image" />`
        : "";
      return `    <item>
      <title>${escapeXml(title)}</title>
      <link>${escapeXml(p.snapshot.webUrl)}</link>
      <guid isPermaLink="false">${escapeXml(p.guid)}</guid>
      <pubDate>${rfc822(p.createdAt)}</pubDate>
      <description>${escapeXml(p.snapshot.shortSynopsis)}</description>${media}
    </item>`;
    })
    .join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:media="http://search.yahoo.com/mrss/" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>${escapeXml(opts.feedTitle)}</title>
    <link>${escapeXml(opts.feedUrl)}</link>
    <language>${escapeXml(opts.language)}</language>
    <description>Cartelera y preventa de CineColombia</description>
    <atom:link href="${escapeXml(opts.feedUrl)}" rel="self" type="application/rss+xml" />
${items}
  </channel>
</rss>
`;
}

const css = `
* { font-family: system-ui, sans-serif; }
body { max-width: 720px; margin: 0 auto; padding: 1rem; }
.post { border-bottom: 1px solid #eee; padding: 1rem 0; }
.post img { max-width: 140px; border-radius: 4px; }
.label { color: #c0392b; font-weight: 600; }
.meta { color: #666; font-size: 0.9rem; }
@media (max-width: 480px) { .post img { max-width: 100%; } }
`;

export function generateHTML(
  posts: Event[],
  opts: { feedTitle: string; language: string },
): string {
  const cards = posts
    .slice()
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, FEED_LIMIT)
    .map((p) => {
      const title = `${EVENT_LABELS[p.type]}: ${p.snapshot.title}`;
      const poster = p.snapshot.posterUrl
        ? `<img src="${escapeXml(p.snapshot.posterUrl)}" alt="${escapeXml(p.snapshot.title)}" />`
        : "";
      const facts = [
        p.snapshot.releaseDate,
        p.snapshot.runtimeInMinutes ? `${p.snapshot.runtimeInMinutes} min` : null,
        p.snapshot.censorRating,
        p.snapshot.genres.join(", "),
      ]
        .filter(Boolean)
        .join(" · ");
      const link = p.snapshot.webUrl
        ? `<a href="${escapeXml(p.snapshot.webUrl)}">Ver en CineColombia</a>`
        : "";
      return `    <article class="post">
      <h2><span class="label">${escapeXml(EVENT_LABELS[p.type])}</span> ${escapeXml(p.snapshot.title)}</h2>
      ${poster}
      <p>${escapeXml(p.snapshot.shortSynopsis)}</p>
      <p class="meta">${escapeXml(facts)}</p>
      <p class="meta">${escapeXml(bogotaDate(p.createdAt))}</p>
      ${link}
    </article>`;
    })
    .join("\n");

  return `<!doctype html>
<html lang="${escapeXml(opts.language)}">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeXml(opts.feedTitle)}</title>
  <style>${css}</style>
</head>
<body>
  <h1>${escapeXml(opts.feedTitle)}</h1>
${cards}
</body>
</html>
`;
}

const EVENT_COLORS: Record<EventType, number> = {
  added: 0x2ecc71,
  "preventa-opens": 0x3498db,
  "now-in-theaters": 0xf1c40f,
  removed: 0xe74c3c,
};

export function buildDiscordEmbed(e: Event): Record<string, unknown> {
  const snap = e.snapshot;
  const facts = [
    snap.releaseDate,
    snap.runtimeInMinutes ? `${snap.runtimeInMinutes} min` : null,
    snap.censorRating,
    snap.genres.join(", "),
  ].filter(Boolean).join(" · ");

  const description = snap.shortSynopsis
    ? snap.shortSynopsis.length > 350
      ? `${snap.shortSynopsis.slice(0, 349)}\u2026`
      : snap.shortSynopsis
    : "";

  const embed: Record<string, unknown> = {
    title: `${EVENT_LABELS[e.type]}: ${snap.title}`,
    description,
    color: EVENT_COLORS[e.type],
    timestamp: e.createdAt,
    footer: { text: bogotaDate(e.createdAt) },
  };
  if (snap.webUrl) embed.url = snap.webUrl;
  if (snap.posterUrl) embed.image = { url: snap.posterUrl };
  if (facts) embed.fields = [{ name: "Ficha", value: facts, inline: true }];
  return embed;
}

// ─── Persistence ─────────────────────────────────────────────────────────────

export function loadState(path: string): State {
  if (!existsSync(path)) return { films: [], tmdbCache: {} };
  return JSON.parse(readFileSync(path, "utf8")) as State;
}

export function saveState(path: string, state: State): void {
  atomicWrite(path, JSON.stringify(state, null, 2) + "\n");
}

export function loadPosts(path: string): PostArchive {
  if (!existsSync(path)) return { posts: [] };
  return JSON.parse(readFileSync(path, "utf8")) as PostArchive;
}

export function savePosts(path: string, archive: PostArchive): void {
  atomicWrite(path, JSON.stringify(archive, null, 2) + "\n");
}

// ─── Live deps ───────────────────────────────────────────────────────────────

const OCAPI_BASE = "https://digital-api.cinecolombia.com/";

const FETCH_TIMEOUT_MS = 30_000;
const CURL_TIMEOUT_MS = 60_000;

function runCapture(cmd: string, args: string[], timeoutMs = CURL_TIMEOUT_MS): Promise<string> {
  const proc = Bun.spawn([cmd, ...args], { stdout: "pipe", stderr: "pipe" });
  const stdout = Bun.readableStreamToText(proc.stdout);
  const stderr = Bun.readableStreamToText(proc.stderr);
  const done = proc.exited.then(async (code) => {
    const out = await stdout;
    if (code !== 0) throw new Error(`${cmd} exited ${code}: ${await stderr}`);
    return out;
  });
  // Swallow late rejection if the race already settled on timeout.
  void done.catch(() => {});
  const timedOut = new Promise<never>((_, reject) => {
    const t = setTimeout(() => {
      try {
        proc.kill();
      } catch {
        /* already exited */
      }
      reject(new Error(`${cmd} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    done.finally(() => clearTimeout(t));
  });
  return Promise.race([done, timedOut]);
}

export const liveDeps: Deps = {
  async fetchToken() {
    const html = await runCapture("curl_chrome136", ["-fsSL", "https://www.cinecolombia.com/"]);
    return extractAuthToken(html);
  },
  async ocapi(token, path) {
    const res = await fetch(`${OCAPI_BASE}ocapi/v1/${path}`, {
      headers: { Accept: "application/json", Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`OCAPI ${path} -> ${res.status}`);
    return res.json();
  },
  async fetchSitemap() {
    const res = await fetch("https://www.cinecolombia.com/sitemap.xml", {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`sitemap -> ${res.status}`);
    return res.text();
  },
  async tmdb(apiKey, query, year) {
    const url = new URL("https://api.themoviedb.org/3/search/movie");
    url.searchParams.set("api_key", apiKey);
    url.searchParams.set("query", query);
    url.searchParams.set("language", "es-CO");
    if (year) url.searchParams.set("year", year);
    const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!res.ok) throw new Error(`tmdb -> ${res.status}`);
    const data = (await res.json()) as { results?: { id: number; poster_path: string | null }[] };
    const top = data.results?.[0];
    return top ? { tmdbId: top.id, posterPath: top.poster_path } : null;
  },
  now: () => new Date(),
  uuid: () => crypto.randomUUID(),
  async notify(events, webhookUrl) {
    for (const e of events) {
      const body = JSON.stringify({ embeds: [buildDiscordEmbed(e)] });
      let res = await fetch(webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (res.status === 429) {
        const retryAfter = ((await res.json()) as { retry_after?: number })?.retry_after ?? 1;
        await Bun.sleep(retryAfter * 1000);
        res = await fetch(webhookUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body,
          signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        });
      }
      if (!res.ok) throw new Error(`discord -> ${res.status}`);
    }
  },
};

// ─── Deployment ──────────────────────────────────────────────────────────────

function git(args: string[]): { ok: boolean; stdout: string; stderr: string } {
  const r = Bun.spawnSync(["git", ...args], { cwd: process.cwd() });
  return {
    ok: r.exitCode === 0,
    stdout: r.stdout?.toString() ?? "",
    stderr: r.stderr?.toString() ?? "",
  };
}

/** Commit subject from this run's lifecycle events, e.g. "ci: update feed (added:2, removed:1)". */
export function formatCommitMessage(events: Event[]): string {
  if (events.length === 0) return "ci: update feed (no events)";
  const typeCounts = new Map<EventType, number>();
  for (const e of events) typeCounts.set(e.type, (typeCounts.get(e.type) ?? 0) + 1);
  const parts = [...typeCounts.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([t, n]) => `${t}:${n}`);
  return `ci: update feed (${parts.join(", ")})`;
}

async function tryGitPush(events: Event[]): Promise<void> {
  const status = git(["status", "--porcelain", "docs", "data"]).stdout.trim();
  if (!status) return;
  const add = git(["add", "docs", "data"]);
  if (!add.ok) throw new Error(`git add failed: ${add.stderr || add.stdout}`);
  const message = formatCommitMessage(events);
  const commit = git(["commit", "-m", message]);
  if (!commit.ok) {
    const detail = `${commit.stdout}\n${commit.stderr}`.toLowerCase();
    // Nothing staged (or working tree clean) — skip push; state already saved.
    if (detail.includes("nothing to commit") || detail.includes("no changes added")) return;
    throw new Error(`git commit failed: ${commit.stderr || commit.stdout}`);
  }
  const push = git(["push"]);
  if (!push.ok) {
    console.error("git push failed; state already saved. Next dirty scrape will retry push.");
    throw new Error("git push failed (non-fast-forward?)");
  }
}

// ─── Main ────────────────────────────────────────────────────────────────────

export async function main(options: MainOptions = {}): Promise<void> {
  const startedAt = Date.now();
  const dataDir = options.dataDir ?? "data";
  const docsDir = options.docsDir ?? "docs";
  const statePath = join(dataDir, "state.json");
  const postsPath = join(dataDir, "posts.json");
  const feedPath = join(docsDir, "feed.xml");
  const htmlPath = join(docsDir, "index.html");
  const feedUrl =
    options.feedUrl ?? process.env.FEED_URL ?? "https://example.github.io/cinecolombia-check/feed.xml";
  const feedTitle = options.feedTitle ?? process.env.FEED_TITLE ?? "CineColombia — Cartelera y Preventa";
  const tmdbApiKey = options.tmdbApiKey ?? process.env.TMDB_API_KEY;
  const notifyWebhookUrl = options.notifyWebhookUrl ?? process.env.NOTIFY_WEBHOOK_URL;
  const deps: Deps = { ...liveDeps, ...options.deps };

  // Gather everything before touching any file (hard rule: aborted scrape ≠ every film gone).
  const prev = loadState(statePath);
  const token = await deps.fetchToken();
  const filmsRes = (await deps.ocapi(token, "films")) as FilmsResponse;
  const availRes = (await deps.ocapi(token, "films/availability")) as AvailabilityResponse;
  const sitemapXml = await deps.fetchSitemap();
  const sitemap = parseSitemap(sitemapXml);
  const current = buildFilmRecords(filmsRes, availRes, sitemap);
  // Empty HTTP-200 catalog would burn through removal debounce and wipe state.
  if (current.length === 0 && prev.films.length > 0) {
    throw new Error(
      `empty OCAPI catalog with ${prev.films.length} known films — aborting before write`,
    );
  }
  await enrichPosters(current, prev.tmdbCache, tmdbApiKey, deps.tmdb);
  // prev.films includes soft-missing titles so reappearance is not mis-emitted as added.
  const { events, films, missingRuns } = applyLifecycle(prev, current, deps);
  const archive = loadPosts(postsPath);
  // Cold start = virgin install only. Empty films after a wipe (lastRun or feed history present)
  // must still archive re-adds — never suppress when history already exists.
  const coldStart =
    prev.films.length === 0 && !prev.lastRun && archive.posts.length === 0;
  // Cold start seeds state only — do not pollute the public feed with bulk "added" posts.
  const archivedEvents = coldStart ? [] : events;
  if (archivedEvents.length > 0) archive.posts.push(...archivedEvents);
  // Only bump lastRun when lifecycle/payload actually changed — keeps quiet runs commit-free.
  const prevMissing = prev.missingRuns ?? {};
  const meaningfulChange =
    coldStart ||
    archivedEvents.length > 0 ||
    JSON.stringify(films) !== JSON.stringify(prev.films) ||
    JSON.stringify(missingRuns) !== JSON.stringify(prevMissing);
  const newState: State = {
    films,
    tmdbCache: prev.tmdbCache,
    missingRuns,
    lastRun: meaningfulChange ? deps.now().toISOString() : prev.lastRun,
  };
  const feed = generateFeed(archive.posts, { feedTitle, feedUrl, language: "es-CO" });
  const html = generateHTML(archive.posts, { feedTitle, language: "es-CO" });

  // Everything succeeded — now persist.
  // Posts before state so a crash mid-write prefers re-emitting events over losing them.
  ensureDir(dataDir);
  ensureDir(docsDir);
  savePosts(postsPath, archive);
  saveState(statePath, newState);
  atomicWrite(feedPath, feed);
  atomicWrite(htmlPath, html);

  // Notify on transitions only — never on a cold start (virgin previous state).
  if (archivedEvents.length > 0 && notifyWebhookUrl) {
    try {
      await deps.notify(archivedEvents, notifyWebhookUrl);
    } catch (e) {
      console.error("notify failed (non-fatal):", e);
    }
  }

  if ((options.gitPush ?? process.env.CINECO_GIT_PUSH === "1") === true) {
    await tryGitPush(archivedEvents);
  }

  if (coldStart) {
    console.log(
      `cold start: ${films.length} films seeded, 0 events archived durationMs=${Date.now() - startedAt}`,
    );
  } else {
    const typeCounts = new Map<EventType, number>();
    for (const e of archivedEvents) typeCounts.set(e.type, (typeCounts.get(e.type) ?? 0) + 1);
    const types =
      [...typeCounts.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([t, n]) => `${t}:${n}`)
        .join(",") || "-";
    console.log(
      `scrape ok films=${films.length} events=${archivedEvents.length} types=${types} durationMs=${Date.now() - startedAt}`,
    );
  }
}

if (import.meta.main) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
