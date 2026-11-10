import type { Event, EventType, FilmRecord, State } from "./domain";

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

const filmsToMap = (films: FilmRecord[]): Map<string, FilmRecord> =>
  new Map(films.map((f) => [f.id, f]));

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
    return `empty website catalog with ${abort.knownFilms} known films — aborting before write`;
  }
  if (abort.kind === "partial-availability") {
    return `partial website availability for categorized films (${abort.filmIds.join(",")}) — aborting before write`;
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

  // A film still in the catalog with zero availability rows is a truncated payload, not an
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

