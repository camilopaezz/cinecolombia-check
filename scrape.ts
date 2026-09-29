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

export interface AvailabilityRow {
  siteId: string | null;
  categories: string[];
  showtimeAttributeIds?: string[];
}

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
  categories: string[]; // raw union of observed site categories; not a lifecycle status
  availabilityRows?: AvailabilityRow[]; // absent on records persisted before this field existed
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
  /** One observed absence per category; the next observed absence confirms the loss. */
  pendingCategoryLosses?: Record<string, Partial<Record<"AdvanceBooking" | "NowShowing", number>>>;
  lastRun?: string; // last meaningful change, not the most recent fetch
}

/** Emit `removed` only after this many consecutive absent runs (debounce flaps). */
export const REMOVAL_THRESHOLD = 2;

/**
 * Cap how many `removed` events a single run may emit when the catalog is large.
 * Empty catalog is aborted separately; this catches partial bad payloads.
 */
export const MAX_REMOVAL_FRACTION = 0.3;

/** Max removals allowed this run given previous film count (small catalogs unrestricted). */
export function maxRemovalsAllowed(prevFilmCount: number): number {
  if (prevFilmCount < 10) return prevFilmCount;
  return Math.max(10, Math.floor(prevFilmCount * MAX_REMOVAL_FRACTION));
}

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

/** Short mono codes + gloss for the HTML bitácora (es-CO). */
const EVENT_CODES: Record<EventType, string> = {
  added: "PRONTO",
  "preventa-opens": "PREVENTA",
  "now-in-theaters": "CARTELERA",
  removed: "FUERA",
};
const EVENT_CODE_GLOSS: Record<EventType, string> = {
  added: "estreno anunciado",
  "preventa-opens": "preventa abierta",
  "now-in-theaters": "cartelera reportada",
  removed: "ya no disponible",
};

// Categories that, when gained, produce an event (ComingSoon produces none).
const GAIN_EVENTS: { category: "AdvanceBooking" | "NowShowing"; type: EventType }[] = [
  { category: "AdvanceBooking", type: "preventa-opens" },
  { category: "NowShowing", type: "now-in-theaters" },
];

/**
 * First public announcement for a newly seen film: highest operational stage only.
 * NowShowing → now-in-theaters; else AdvanceBooking → preventa-opens; else added (Pronto).
 */
export function announcementType(categories: string[]): EventType {
  if (categories.includes("NowShowing")) return "now-in-theaters";
  if (categories.includes("AdvanceBooking")) return "preventa-opens";
  return "added";
}

/**
 * Category gains on a known film → 0–1 event.
 * - Same-run AdvanceBooking + NowShowing → only now-in-theaters
 * - AdvanceBooking while already/now NowShowing → suppress preventa (no value)
 */
export function gainEvents(
  prevCategories: string[],
  curCategories: string[],
): EventType[] {
  const gained = GAIN_EVENTS.filter(
    ({ category }) => curCategories.includes(category) && !prevCategories.includes(category),
  );
  if (gained.length === 0) return [];
  const gainedAdvance = gained.some((g) => g.category === "AdvanceBooking");
  const gainedNow = gained.some((g) => g.category === "NowShowing");
  if (gainedNow) return ["now-in-theaters"];
  if (gainedAdvance) {
    // Preventa is only meaningful before the film is in theaters.
    if (curCategories.includes("NowShowing") || prevCategories.includes("NowShowing")) {
      return [];
    }
    return ["preventa-opens"];
  }
  return [];
}

/**
 * Offline archive hygiene (scrapes only append; invoke via `runArchiveHygiene` / CLI `--hygiene`).
 * - re-stage historical `added` to the highest category on the snapshot (rule A)
 * - drop preventa-opens whose snapshot already includes NowShowing (rule B)
 * - drop same-timestamp preventa twins of now-in-theaters (incl. restaged rows)
 */
export function sanitizeArchivePosts(posts: Event[]): Event[] {
  // Restage first so twin detection sees added→now as a now-in-theaters key.
  const restaged = posts.map((p) => {
    if (p.type !== "added") return p;
    const next = announcementType(p.snapshot.categories);
    if (next === "added") return p;
    return { ...p, type: next };
  });
  const nowKeys = new Set(
    restaged
      .filter((p) => p.type === "now-in-theaters")
      .map((p) => `${p.filmId}|${p.createdAt}`),
  );
  return restaged.filter((p) => {
    if (p.type !== "preventa-opens") return true;
    if (p.snapshot.categories.includes("NowShowing")) return false;
    return !nowKeys.has(`${p.filmId}|${p.createdAt}`);
  });
}

function ensureDir(dir: string): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

function atomicWrite(path: string, contents: string): void {
  if (existsSync(path) && readFileSync(path, "utf8") === contents) return;
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

/** Reject broken availability payloads before a category wipe can reach persistence. */
export function validateAvailabilityResponse(value: unknown, catalogIds: string[]): asserts value is AvailabilityResponse {
  if (!value || typeof value !== "object" || !Array.isArray((value as AvailabilityResponse).filmAvailabilities)) {
    throw new Error("invalid OCAPI availability response: filmAvailabilities must be an array");
  }
  const rows = (value as AvailabilityResponse).filmAvailabilities;
  for (const row of rows) {
    if (!row || typeof row.filmId !== "string" || !row.filmId ||
        !(row.siteId === null || (typeof row.siteId === "string" && row.siteId)) ||
        !Array.isArray(row.categories) || !row.categories.every((c) => typeof c === "string") ||
        (row.showtimeAttributeIds !== undefined &&
          (!Array.isArray(row.showtimeAttributeIds) ||
            !row.showtimeAttributeIds.every((id) => typeof id === "string")))) {
      throw new Error("invalid OCAPI availability response: malformed film availability row");
    }
  }
  if (catalogIds.length > 0 && !rows.some((row) => catalogIds.includes(row.filmId))) {
    throw new Error("empty OCAPI availability for populated catalog — aborting before write");
  }
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
  const rowsByFilm = new Map<string, AvailabilityRow[]>();
  for (const row of availRes.filmAvailabilities) {
    const attrs = sortedUnique(row.showtimeAttributeIds ?? []);
    const normalized: AvailabilityRow = {
      siteId: row.siteId,
      categories: sortedUnique(row.categories),
      ...(attrs.length > 0 ? { showtimeAttributeIds: attrs } : {}),
    };
    const rows = rowsByFilm.get(row.filmId) ?? [];
    rows.push(normalized);
    rowsByFilm.set(row.filmId, rows);
  }
  for (const [filmId, rows] of rowsByFilm) {
    rows.sort((a, b) =>
      (a.siteId ?? "").localeCompare(b.siteId ?? "", "en") ||
      JSON.stringify(a).localeCompare(JSON.stringify(b), "en"),
    );
    rowsByFilm.set(filmId, rows.filter((row, i) => i === 0 || JSON.stringify(row) !== JSON.stringify(rows[i - 1])));
  }

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
      availabilityRows: rowsByFilm.get(f.id) ?? [],
      posterUrl: null,
    };
  });
}

// ─── Lifecycle Run ───────────────────────────────────────────────────────────
// Deep module: catalog transition + abort/cold-start/quiet/archive policy.
// main() only fetches, enriches posters, persists, and notifies.

export type LifecycleAbort =
  | { kind: "empty-catalog"; knownFilms: number }
  | { kind: "bulk-removal"; removed: number; cap: number; prevFilms: number }
  | { kind: "partial-availability"; filmIds: string[] };

export type LifecycleOutcome = {
  coldStart: boolean;
  /** Raw transitions this run (includes cold-start bulk announcements). */
  events: Event[];
  /** What posts.json / notify / git see (empty on virgin cold start). */
  archivedEvents: Event[];
  films: FilmRecord[];
  missingRuns: Record<string, number>;
  pendingCategoryLosses: NonNullable<State["pendingCategoryLosses"]>;
  /** Already resolved quiet-run policy (unchanged when nothing meaningful moved). */
  lastRun: string | undefined;
  meaningfulChange: boolean;
};

export type LifecycleResult =
  | { ok: true; outcome: LifecycleOutcome }
  | { ok: false; abort: LifecycleAbort };

/** Stable error text for aborts — main maps these to thrown Errors (fail before write). */
export function lifecycleAbortMessage(abort: LifecycleAbort): string {
  if (abort.kind === "empty-catalog") {
    return `empty OCAPI catalog with ${abort.knownFilms} known films — aborting before write`;
  }
  if (abort.kind === "partial-availability") {
    return `partial OCAPI availability for categorized films (${abort.filmIds.join(",")}) — aborting before write`;
  }
  return `refusing bulk removal: ${abort.removed} removed > cap ${abort.cap} (prev films=${abort.prevFilms}) — aborting before write`;
}

/**
 * Core transition engine (removal debounce).
 * Soft-missing films stay in `films` until REMOVAL_THRESHOLD consecutive absences.
 * Reappearance under threshold clears the counter and does not emit `added`.
 * Prefer `runLifecycle` for the full policy (aborts, cold start, quiet run).
 */
export function applyLifecycle(
  prev: Pick<State, "films" | "missingRuns" | "pendingCategoryLosses">,
  current: FilmRecord[],
  deps: { now: () => Date; uuid: () => string },
): Pick<LifecycleOutcome, "events" | "films" | "missingRuns" | "pendingCategoryLosses"> {
  const prevMap = filmsToMap(prev.films);
  const curMap = filmsToMap(current);
  const missingRuns: Record<string, number> = { ...(prev.missingRuns ?? {}) };
  const pendingCategoryLosses: NonNullable<State["pendingCategoryLosses"]> = {
    ...(prev.pendingCategoryLosses ?? {}),
  };
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
  // Highest operational stage only — never emit preventa+now on first sighting.
  for (const id of [...curMap.keys()].sort()) {
    if (!prevMap.has(id)) {
      const snap = curMap.get(id)!;
      events.push(mk(announcementType(snap.categories), id, snap));
    }
  }

  // 2. Category gains on films already known (incl. soft-missing reappearance).
  // Same-run preventa+now → only now; preventa while already in theaters → suppress.
  for (const id of [...curMap.keys()].sort()) {
    const cur = curMap.get(id)!;
    const p = prevMap.get(id);
    if (!p) continue;
    if (missingRuns[id]) delete missingRuns[id];
    const pending = { ...(pendingCategoryLosses[id] ?? {}) };
    const regained: string[] = [];
    for (const { category } of GAIN_EVENTS) {
      const wasPresent = p.categories.includes(category);
      const isPresent = cur.categories.includes(category);
      if (isPresent && pending[category]) {
        // A one-observation loss followed by regain was a flap, not a new opening.
        regained.push(category);
        delete pending[category];
      } else if (!isPresent) {
        if (pending[category]) {
          delete pending[category]; // second observed loss
        } else if (wasPresent) {
          pending[category] = 1;
        }
      }
    }
    if (Object.keys(pending).length) {
      pendingCategoryLosses[id] = pending;
    } else {
      delete pendingCategoryLosses[id];
    }
    for (const type of gainEvents([...p.categories, ...regained], cur.categories)) {
      events.push(mk(type, id, cur));
    }
  }

  // 3. Absent films: increment missingRuns; only emit removed at threshold.
  // Empty current catalog with known films is refused by runLifecycle before this.
  const softKept: FilmRecord[] = [];
  for (const id of [...prevMap.keys()].sort()) {
    if (curMap.has(id)) continue;
    const count = (missingRuns[id] ?? 0) + 1;
    if (count >= REMOVAL_THRESHOLD) {
      events.push(mk("removed", id, prevMap.get(id)!));
      delete missingRuns[id];
      delete pendingCategoryLosses[id];
    } else {
      missingRuns[id] = count;
      softKept.push(prevMap.get(id)!);
    }
  }

  // Present films (current snapshot) + soft-missing still under threshold.
  const nextFilms = [...current, ...softKept].sort((a, b) => a.id.localeCompare(b.id));
  return { events, films: nextFilms, missingRuns, pendingCategoryLosses };
}

/**
 * Full Lifecycle Run: empty/bulk guards, transitions, cold start, archive set, quiet lastRun.
 * Pure domain — no fs, no fetch. Interface is the test surface for policy.
 */
export function runLifecycle(
  prev: State,
  current: FilmRecord[],
  archivePostCount: number,
  deps: { now: () => Date; uuid: () => string },
): LifecycleResult {
  // Empty HTTP-200 catalog would burn through removal debounce and wipe state.
  if (current.length === 0 && prev.films.length > 0) {
    return { ok: false, abort: { kind: "empty-catalog", knownFilms: prev.films.length } };
  }

  // A film still in /films with zero availability rows is a truncated payload, not an
  // observed category wipe — including after a pending loss already cleared categories.
  // A returned row with categories [] is not truncated.
  const truncatedIds = prev.films
    .filter((p) => {
      const cur = current.find((c) => c.id === p.id);
      if (cur === undefined || cur.availabilityRows?.length !== 0) return false;
      return (
        p.categories.length > 0 ||
        (p.availabilityRows?.length ?? 0) > 0 ||
        Object.keys(prev.pendingCategoryLosses?.[p.id] ?? {}).length > 0
      );
    })
    .map((p) => p.id)
    .sort((a, b) => a.localeCompare(b));
  if (truncatedIds.length > 0) {
    return { ok: false, abort: { kind: "partial-availability", filmIds: truncatedIds } };
  }

  // prev.films includes soft-missing titles so reappearance is not mis-emitted as added.
  const { events, films, missingRuns, pendingCategoryLosses } = applyLifecycle(prev, current, deps);

  const removalCount = events.filter((e) => e.type === "removed").length;
  const removalCap = maxRemovalsAllowed(prev.films.length);
  if (removalCount > removalCap) {
    return {
      ok: false,
      abort: {
        kind: "bulk-removal",
        removed: removalCount,
        cap: removalCap,
        prevFilms: prev.films.length,
      },
    };
  }

  // Cold start = virgin install only. Empty films after a wipe (lastRun or feed history)
  // must still archive re-adds — never suppress when history already exists.
  const coldStart =
    prev.films.length === 0 && !prev.lastRun && archivePostCount === 0;
  // Cold start seeds state only — do not pollute the public feed with bulk "added" posts.
  const archivedEvents = coldStart ? [] : events;

  // Only bump lastRun when lifecycle/payload actually changed — keeps quiet runs commit-free.
  const prevMissing = prev.missingRuns ?? {};
  const meaningfulChange =
    coldStart ||
    archivedEvents.length > 0 ||
    JSON.stringify(films) !== JSON.stringify(prev.films) ||
    JSON.stringify(missingRuns) !== JSON.stringify(prevMissing) ||
    JSON.stringify(pendingCategoryLosses) !== JSON.stringify(prev.pendingCategoryLosses ?? {});

  return {
    ok: true,
    outcome: {
      coldStart,
      events,
      archivedEvents,
      films,
      missingRuns,
      pendingCategoryLosses,
      lastRun: meaningfulChange ? deps.now().toISOString() : prev.lastRun,
      meaningfulChange,
    },
  };
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

/** Discord embed description hard limit (chars, including ellipsis). */
const SYNOPSIS_CLIP = 350;

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

/** Compact Bogotá timestamp for the HTML when-column (date + time lines). */
function bogotaWhen(iso: string): { date: string; time: string } {
  const d = new Date(iso);
  return {
    date: new Intl.DateTimeFormat("es-CO", {
      timeZone: "America/Bogota",
      day: "numeric",
      month: "short",
      year: "numeric",
    }).format(d),
    time: new Intl.DateTimeFormat("es-CO", {
      timeZone: "America/Bogota",
      hour: "numeric",
      minute: "2-digit",
    }).format(d),
  };
}

// ─── Shared event projection (bitácora surfaces) ─────────────────────────────
// Presentation facts shared by RSS / HTML / Discord; adapters stay thin formatters.

/** Headline used by RSS and Discord: "Pronto: Toy Story 5". */
export function eventTitle(e: Event): string {
  return `${EVENT_LABELS[e.type]}: ${e.snapshot.title}`;
}

/** Compact ficha line: release · runtime · rating · genres (empty bits omitted). */
export function factsLine(snap: FilmRecord): string {
  return [
    snap.releaseDate,
    snap.runtimeInMinutes ? `${snap.runtimeInMinutes} min` : null,
    snap.censorRating || null,
    snap.genres.join(", ") || null,
  ]
    .filter(Boolean)
    .join(" · ");
}

/** Clip synopsis to a hard char limit (Discord description); ellipsis is one char. */
export function clipSynopsis(text: string, maxLen = SYNOPSIS_CLIP): string {
  if (!text) return "";
  if (text.length <= maxLen) return text;
  return `${text.slice(0, maxLen - 1)}…`;
}

/** Newest-first public window; posts.json keeps full history. */
export function windowNewest(posts: Event[], limit = FEED_LIMIT): Event[] {
  return posts
    .slice()
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, limit);
}

export function generateFeed(
  posts: Event[],
  opts: { feedTitle: string; feedUrl: string; language: string },
): string {
  const items = windowNewest(posts)
    .map((p) => {
      const media = p.snapshot.posterUrl
        ? `\n      <media:content url="${escapeXml(p.snapshot.posterUrl)}" medium="image" />`
        : "";
      return `    <item>
      <title>${escapeXml(eventTitle(p))}</title>
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

// Ficha de Proyección — editorial bitácora (es-CO, Bogotá).
const css = `
:root {
  --bg: #f6f4ef;
  --ink: #1a1c1f;
  --muted: #6a6f76;
  --line: #d9d4c8;
  --red: #b42318;
  --panel: #e6e1d6;
}
* { box-sizing: border-box; }
body {
  margin: 0;
  background: var(--bg);
  color: var(--ink);
  font-family: "Newsreader", "Iowan Old Style", Palatino, Georgia, serif;
  line-height: 1.5;
}
.site { max-width: 860px; margin: 0 auto; padding: 1.75rem 1.25rem 3rem; }
.head {
  display: grid;
  grid-template-columns: 1fr auto;
  gap: 1rem;
  align-items: end;
  border-bottom: 1px solid var(--ink);
  padding-bottom: .9rem;
  margin-bottom: 1.1rem;
}
.eyebrow {
  font-family: "IBM Plex Mono", ui-monospace, Menlo, Consolas, monospace;
  font-size: .68rem;
  letter-spacing: .14em;
  text-transform: uppercase;
  color: var(--red);
  margin: 0 0 .35rem;
  font-weight: 500;
}
h1 {
  font-family: "Instrument Serif", "Iowan Old Style", Palatino, Georgia, serif;
  font-size: clamp(1.85rem, 4.5vw, 2.6rem);
  font-weight: 400;
  margin: 0;
  letter-spacing: -.02em;
  line-height: 1.08;
}
.aside {
  text-align: right;
  font-family: "IBM Plex Mono", ui-monospace, Menlo, Consolas, monospace;
  font-size: .72rem;
  color: var(--muted);
  line-height: 1.55;
}
.legend {
  display: flex;
  flex-wrap: wrap;
  gap: .65rem 1.2rem;
  font-family: "IBM Plex Mono", ui-monospace, Menlo, Consolas, monospace;
  font-size: .72rem;
  color: var(--muted);
  margin: 0 0 1rem;
  padding-bottom: .85rem;
  border-bottom: 1px solid var(--line);
}
.legend b { color: var(--ink); font-weight: 600; }
.post {
  display: grid;
  grid-template-columns: 92px 1fr auto;
  gap: 1rem;
  padding: 1rem 0;
  border-bottom: 1px solid var(--line);
  align-items: start;
}
.post img, .ph {
  width: 92px;
  aspect-ratio: 2 / 3;
  object-fit: cover;
  background: var(--panel);
  display: block;
}
.ph {
  display: grid;
  place-items: center;
  font-family: "IBM Plex Mono", ui-monospace, Menlo, Consolas, monospace;
  font-size: .62rem;
  color: var(--muted);
  text-align: center;
  padding: .35rem;
}
.code {
  font-family: "IBM Plex Mono", ui-monospace, Menlo, Consolas, monospace;
  font-size: .68rem;
  letter-spacing: .08em;
  text-transform: uppercase;
  color: var(--red);
  font-weight: 600;
  margin: 0 0 .2rem;
}
.post h2 {
  font-family: "Instrument Serif", "Iowan Old Style", Palatino, Georgia, serif;
  font-size: 1.3rem;
  font-weight: 400;
  margin: 0 0 .3rem;
  line-height: 1.15;
}
.syn {
  margin: 0 0 .4rem;
  color: var(--muted);
  font-size: .95rem;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.facts {
  font-family: "IBM Plex Mono", ui-monospace, Menlo, Consolas, monospace;
  font-size: .72rem;
  color: #555a61;
}
.facts a {
  color: var(--ink);
  text-decoration: none;
  border-bottom: 1px solid var(--ink);
}
.catalog { margin: 1.25rem 0 2.5rem; }
.catalog h2, .history h2 {
  font-family: "Instrument Serif", "Iowan Old Style", Palatino, Georgia, serif;
  font-size: 1.65rem;
  font-weight: 400;
  margin: 0;
}
.catalog-intro { color: var(--muted); font-size: .9rem; margin: .15rem 0 1rem; }
.section-nav { display: flex; gap: 1rem; font-size: .85rem; margin: .25rem 0 1rem; }
.section-nav a { color: var(--ink); text-underline-offset: .2em; }
.catalog-evidence { grid-column: 1 / -1; color: var(--muted); font-size: .78rem; }
.catalog-evidence summary { cursor: pointer; width: fit-content; }
.catalog-detail { display: flex; gap: .8rem; max-width: 45rem; padding: .5rem 0; }
.catalog-detail img { width: 64px; height: 96px; object-fit: cover; flex: none; }
.catalog-detail p { margin: 0 0 .35rem; }
.catalog-evidence ul { margin: .3rem 0 .15rem; padding-left: 1.25rem; }
.catalog-evidence code { overflow-wrap: anywhere; }
.catalog-group { margin: 1rem 0; }
.catalog-group h3 { font-size: 1rem; font-weight: 600; margin: 0 0 .35rem; }
.catalog-list { list-style: none; margin: 0; padding: 0; border-top: 1px solid var(--line); }
.catalog-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(130px, 210px);
  gap: .5rem 1rem;
  padding: .5rem 0;
  border-bottom: 1px solid var(--line);
  align-items: baseline;
}
.catalog-row a { color: var(--ink); text-decoration-color: var(--red); text-underline-offset: .14em; }
.catalog-badge { color: var(--red); font-size: .75rem; margin-left: .5rem; white-space: nowrap; }
.catalog-row small { color: var(--muted); font-size: .78rem; text-align: right; }
.catalog-note { grid-column: 1 / -1; color: var(--muted); font-size: .78rem; }
.history { border-top: 1px solid var(--ink); padding-top: .7rem; }
.history p { color: var(--muted); font-size: .83rem; margin: .2rem 0 .8rem; }
a:focus-visible { outline: 2px solid var(--red); outline-offset: 3px; }
.when {
  font-family: "IBM Plex Mono", ui-monospace, Menlo, Consolas, monospace;
  font-size: .72rem;
  color: var(--muted);
  text-align: right;
  white-space: nowrap;
  padding-top: .15rem;
  line-height: 1.45;
}
@media (max-width: 640px) {
  .head { grid-template-columns: 1fr; }
  .aside { text-align: left; }
  .post { grid-template-columns: 72px 1fr; }
  .post img, .ph { width: 72px; }
  .when { grid-column: 2; text-align: left; padding-top: 0; }
  .catalog-row { grid-template-columns: 1fr; gap: .1rem; }
  .catalog-row small { text-align: left; }
}
`;

export function generateHTML(
  posts: Event[],
  opts: { feedTitle: string; language: string; asOf?: Date },
  state: State = { films: [], tmdbCache: {} },
): string {
  // A change-based page must not silently reclassify films at midnight on a quiet scrape.
  const asOf = opts.asOf ?? (state.lastRun ? new Date(state.lastRun) : new Date(0));
  const today = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Bogota", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(asOf);
  const changed = state.lastRun ? bogotaWhen(state.lastRun) : null;
  const groups: { title: string; films: FilmRecord[] }[] = [
    { title: "Cartelera reportada", films: [] },
    { title: "Preventa", films: [] },
    { title: "Próximos estrenos", films: [] },
    { title: "Disponibilidad sin confirmar", films: [] },
  ];
  for (const film of state.films) {
    const future = !!film.releaseDate && film.releaseDate.slice(0, 10) > today;
    const isNow = film.categories.includes("NowShowing");
    const isAdvance = film.categories.includes("AdvanceBooking");
    const uncertain = (state.missingRuns?.[film.id] ?? 0) > 0 || film.availabilityRows?.length === 0;
    const group = uncertain ? groups[3]! : future && isNow ? groups[2]!
      : isNow ? groups[0]! : isAdvance ? groups[1]!
      : film.categories.includes("ComingSoon") || future ? groups[2]! : groups[3]!;
    group.films.push(film);
  }
  const catalog = groups.filter((g) => g.films.length).map((group) => {
    const entries = group.films.sort((a, b) => a.title.localeCompare(b.title, "es") || a.id.localeCompare(b.id))
      .map((film) => {
        const future = !!film.releaseDate && film.releaseDate.slice(0, 10) > today;
        const date = film.releaseDate ? `Estreno: ${film.releaseDate}` : "Fecha por confirmar";
        const siteEvidence = film.availabilityRows === undefined ? " · sin detalle por sede guardado" : "";
        const title = escapeXml(film.title);
        const name = film.webUrl
          ? `<a href="${escapeXml(film.webUrl)}">${title}</a>` : title;
        const booking = future && film.categories.includes("AdvanceBooking")
          ? `<span class="catalog-badge">Preventa reportada</span>` : "";
        const notes: string[] = [];
        if (future && film.categories.includes("NowShowing")) {
          notes.push("El sitio marcó cartelera con estreno posterior al último cambio del catálogo; no confirma funciones para esa fecha.");
        }
        const misses = state.missingRuns?.[film.id] ?? 0;
        if (misses) notes.push(`No apareció en la última consulta (${misses} ausencia${misses === 1 ? "" : "s"}); disponibilidad sin confirmar.`);
        if (film.availabilityRows?.length === 0) notes.push("Sin filas de disponibilidad en la última consulta; estado sin confirmar.");
        const note = notes.length ? `<span class="catalog-note">${escapeXml(notes.join(" "))}</span>` : "";
        const rows = film.availabilityRows ?? [];
        const poster = film.posterUrl
          ? `<img src="${escapeXml(film.posterUrl)}" alt="" loading="lazy" />` : "";
        const synopsis = film.shortSynopsis ? `<p>${escapeXml(film.shortSynopsis)}</p>` : "";
        const facts = factsLine(film);
        const ficha = facts ? `<p>${escapeXml(facts)}</p>` : "";
        const director = film.director ? `<p>Dirección: ${escapeXml(film.director)}</p>` : "";
        const categories = `<p>${misses ? "Últimas categorías observadas" : "Categorías reportadas"}: <code>${escapeXml(film.categories.join(", ") || "sin categoría")}</code></p>`;
        const sites = rows.length ? `<p>Categorías por sede (${rows.length}):</p><ul>${rows.map((row) =>
          `<li>${escapeXml(row.siteId ?? "Sede no especificada")}: <code>${escapeXml(row.categories.join(", ") || "sin categoría")}</code></li>`,
        ).join("")}</ul>` : "";
        const detail = `<details class="catalog-evidence"><summary>${misses ? "Última ficha observada" : "Ficha actual"}${rows.length ? ` y categorías por sede (${rows.length})` : ""}</summary><div class="catalog-detail">${poster}<div>${synopsis}${ficha}${director}${categories}${sites}</div></div></details>`;
        return `        <li class="catalog-row"><span>${name}${booking}</span><small>${escapeXml(date + siteEvidence)}</small>${note}${detail}</li>`;
      }).join("\n");
    return `    <section class="catalog-group"><h3>${escapeXml(group.title)}</h3><ul class="catalog-list">\n${entries}\n    </ul></section>`;
  }).join("\n");
  const cards = windowNewest(posts)
    .map((p) => {
      const poster = p.snapshot.posterUrl
        ? `<img src="${escapeXml(p.snapshot.posterUrl)}" alt="${escapeXml(p.snapshot.title)}" />`
        : `<div class="ph" aria-hidden="true">sin póster</div>`;
      const link = p.snapshot.webUrl
        ? `<a href="${escapeXml(p.snapshot.webUrl)}">Ver en CineColombia</a>`
        : "";
      const ficha = factsLine(p.snapshot);
      const facts = [ficha, link].filter(Boolean).join(" · ");
      const when = bogotaWhen(p.createdAt);
      const code = `${EVENT_CODES[p.type]} · ${EVENT_CODE_GLOSS[p.type]}`;
      const syn = p.snapshot.shortSynopsis
        ? `<p class="syn">${escapeXml(p.snapshot.shortSynopsis)}</p>`
        : "";
      return `    <article class="post">
      ${poster}
      <div>
        <p class="code">${escapeXml(code)}</p>
        <h2>${escapeXml(p.snapshot.title)}</h2>
        ${syn}
        <div class="facts">${facts}</div>
      </div>
      <div class="when">${escapeXml(when.date)}<br />${escapeXml(when.time)}</div>
    </article>`;
    })
    .join("\n");

  return `<!doctype html>
<html lang="${escapeXml(opts.language)}">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeXml(opts.feedTitle)}</title>
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600&family=Instrument+Serif&family=Newsreader:ital,opsz,wght@0,6..72,400;0,6..72,600;1,6..72,400&display=swap" rel="stylesheet" />
  <style>${css}</style>
</head>
<body>
  <div class="site">
    <header class="head">
      <div>
        <p class="eyebrow">Bogotá · bitácora de cartelera</p>
        <h1>${escapeXml(opts.feedTitle)}</h1>
      </div>
      <div class="aside">
        Bogotá, Colombia<br />
        hora local (COT, UTC−5)<br />
        últimos ${FEED_LIMIT} eventos
      </div>
    </header>
    <nav class="section-nav" aria-label="Secciones"><a href="#catalogo">Catálogo observado</a><a href="#historial">Historial de cambios</a></nav>
    <section class="catalog" id="catalogo" aria-label="Catálogo observado">
      <h2>Películas registradas</h2>
      <p class="catalog-intro">Categorías informadas por CineColombia. La fecha de estreno no confirma funciones para el día del registro. Los datos guardados antes de este cambio no conservan el detalle por sede.${changed ? ` Último cambio del catálogo: <time datetime="${escapeXml(state.lastRun!)}">${escapeXml(changed.date)} ${escapeXml(changed.time)}</time>. No indica la hora de la última consulta.` : ""}</p>
${catalog || "      <p class=\"catalog-intro\">No hay películas registradas.</p>"}
    </section>
    <section class="history" id="historial" aria-label="Historial de cambios">
      <h2>Historial de cambios</h2>
      <p>Los eventos conservan los datos vistos cuando se registraron; no son el estado actual. CARTELERA indica una categoría reportada, no confirma una función en esa fecha.</p>
      <div class="legend" aria-label="Leyenda de eventos">
        <span><b>PRONTO</b> estreno anunciado</span>
        <span><b>PREVENTA</b> boletería abierta</span>
        <span><b>CARTELERA</b> categoría reportada</span>
        <span><b>FUERA</b> ya no disponible</span>
      </div>
${cards}
    </section>
  </div>
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
  const facts = factsLine(snap);
  const embed: Record<string, unknown> = {
    title: eventTitle(e),
    description: clipSynopsis(snap.shortSynopsis),
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

function gitPushEnabled(options: MainOptions): boolean {
  return (options.gitPush ?? process.env.CINECO_GIT_PUSH === "1") === true;
}

/**
 * Rebase onto remote before scrape writes so a later push is fast-forward.
 * Without this, a laptop push makes the server diverge and every feed commit fails non-ff.
 */
function tryGitPullRebase(): void {
  const pull = git(["pull", "--rebase"]);
  if (!pull.ok) {
    console.error("git pull --rebase failed; refusing scrape+push on a diverged remote.");
    throw new Error(`git pull --rebase failed: ${pull.stderr || pull.stdout}`);
  }
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
  if (status) {
    const add = git(["add", "docs", "data"]);
    if (!add.ok) throw new Error(`git add failed: ${add.stderr || add.stdout}`);
    const message = formatCommitMessage(events);
    const commit = git(["commit", "-m", message]);
    if (!commit.ok) {
      const detail = `${commit.stdout}\n${commit.stderr}`.toLowerCase();
      // Nothing staged (or working tree clean) — still try push for leftover commits.
      if (!(detail.includes("nothing to commit") || detail.includes("no changes added"))) {
        throw new Error(`git commit failed: ${commit.stderr || commit.stdout}`);
      }
    }
  }
  // Always push: recovers unpushed commits after a prior non-ff failure even on quiet runs.
  const push = git(["push"]);
  if (!push.ok) {
    console.error("git push failed; state already saved. Next scrape will pull --rebase and retry push.");
    throw new Error("git push failed (non-fast-forward?)");
  }
}

// ─── Offline archive hygiene ─────────────────────────────────────────────────

/**
 * One-shot offline repair for historical posts.json (restage + drop preventa twins).
 * Scrapes stay append-only; call via CLI `--hygiene` / `hygiene` when lifecycle rules change.
 * Rewrites posts atomically and regenerates feed/html so public surfaces match.
 * No scrape, notify, or git.
 */
export function runArchiveHygiene(
  options: Pick<MainOptions, "dataDir" | "docsDir" | "feedUrl" | "feedTitle"> = {},
): { before: number; after: number } {
  const dataDir = options.dataDir ?? "data";
  const docsDir = options.docsDir ?? "docs";
  const postsPath = join(dataDir, "posts.json");
  const statePath = join(dataDir, "state.json");
  const feedPath = join(docsDir, "feed.xml");
  const htmlPath = join(docsDir, "index.html");
  const feedUrl =
    options.feedUrl ?? process.env.FEED_URL ?? "https://example.github.io/cinecolombia-check/feed.xml";
  const feedTitle = options.feedTitle ?? process.env.FEED_TITLE ?? "CineColombia — Cartelera y Preventa";

  const archive = loadPosts(postsPath);
  const state = loadState(statePath);
  const before = archive.posts.length;
  archive.posts = sanitizeArchivePosts(archive.posts);
  const after = archive.posts.length;

  ensureDir(dataDir);
  ensureDir(docsDir);
  savePosts(postsPath, archive);
  atomicWrite(feedPath, generateFeed(archive.posts, { feedTitle, feedUrl, language: "es-CO" }));
  atomicWrite(htmlPath, generateHTML(archive.posts, { feedTitle, language: "es-CO" }, state));

  return { before, after };
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
  const doGitPush = gitPushEnabled(options);

  // Sync with remote before any scrape writes so push stays fast-forward.
  if (doGitPush) tryGitPullRebase();

  // Gather everything before touching any file (hard rule: aborted scrape ≠ every film gone).
  const prev = loadState(statePath);
  const archive = loadPosts(postsPath);
  const token = await deps.fetchToken();
  const filmsRes = (await deps.ocapi(token, "films")) as FilmsResponse;
  if (!Array.isArray(filmsRes?.films)) throw new Error("invalid OCAPI films response: films must be an array");
  const availRes: unknown = await deps.ocapi(token, "films/availability");
  validateAvailabilityResponse(availRes, filmsRes.films.map((f) => f.id));
  const catalogIds = new Set(filmsRes.films.map((f) => f.id));
  if (catalogIds.size > 0 && prev.films.some((f) => f.categories.length > 0) &&
      !availRes.filmAvailabilities.some((row) => catalogIds.has(row.filmId) && row.categories.length > 0)) {
    throw new Error("empty OCAPI availability categories for populated catalog — aborting before write");
  }
  const sitemapXml = await deps.fetchSitemap();
  const sitemap = parseSitemap(sitemapXml);
  const current = buildFilmRecords(filmsRes, availRes, sitemap);
  // Empty current is a free no-op here; runLifecycle still aborts empty-with-known before write.
  await enrichPosters(current, prev.tmdbCache, tmdbApiKey, deps.tmdb);

  const result = runLifecycle(prev, current, archive.posts.length, deps);
  if (!result.ok) {
    throw new Error(lifecycleAbortMessage(result.abort));
  }
  const { coldStart, archivedEvents, films, missingRuns, pendingCategoryLosses, lastRun } = result.outcome;

  if (archivedEvents.length > 0) archive.posts.push(...archivedEvents);
  const newState: State = {
    films,
    tmdbCache: prev.tmdbCache,
    missingRuns,
    pendingCategoryLosses,
    lastRun,
  };
  const feed = generateFeed(archive.posts, { feedTitle, feedUrl, language: "es-CO" });
  const html = generateHTML(archive.posts, { feedTitle, language: "es-CO" }, newState);

  // Everything succeeded — now persist.
  // Posts before state so a crash mid-write prefers re-emitting events over losing them.
  ensureDir(dataDir);
  ensureDir(docsDir);
  savePosts(postsPath, archive);
  saveState(statePath, newState);
  atomicWrite(feedPath, feed);
  atomicWrite(htmlPath, html);
  // Fetch/persist time belongs in the run log, not tracked state on quiet runs.
  console.log(`observedAt=${deps.now().toISOString()}`);

  // Notify on transitions only — never on a cold start (virgin previous state).
  if (archivedEvents.length > 0 && notifyWebhookUrl) {
    try {
      await deps.notify(archivedEvents, notifyWebhookUrl);
    } catch (e) {
      console.error("notify failed (non-fatal):", e);
    }
  }

  if (doGitPush) {
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
  const argv = process.argv.slice(2);
  const hygiene = argv.includes("--hygiene") || argv.includes("hygiene");
  if (hygiene) {
    try {
      const { before, after } = runArchiveHygiene();
      const dropped = before - after;
      console.log(
        `archive hygiene: ${before} -> ${after} posts${dropped > 0 ? ` (dropped ${dropped})` : ""}`,
      );
    } catch (e) {
      console.error(e);
      process.exit(1);
    }
  } else {
    main().catch((e) => {
      console.error(e);
      process.exit(1);
    });
  }
}
