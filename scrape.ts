#!/usr/bin/env bun
// Cinecolombia lifecycle feed — scraper.
// Bun/TypeScript observation runner. See issues/ for the original requirements.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { resolvePoster } from "./posters";
import { deploySite } from "./deploy";
import { abortable } from "./deadline";
import { fetchCatalog, requestCatalog } from "./catalog";
import type { Event, EventType, FilmRecord, State, PostArchive } from "./domain";
import { runLifecycle, lifecycleAbortMessage, sanitizeArchivePosts } from "./lifecycle";
import { generateFeed, buildDiscordEmbed } from "./presentation";

// node:crypto not imported — `crypto` is a global in Bun.

// ─── Types ───────────────────────────────────────────────────────────────────

export interface Deps {
  fetchCatalog: (signal?: AbortSignal) => Promise<FilmRecord[]>;
  notifyFailure: (message: string, webhookUrl: string) => Promise<void>;
  tmdb: (
    apiKey: string,
    query: string,
    year: string | null,
    signal?: AbortSignal,
  ) => Promise<{ tmdbId: number; posterPath: string | null } | null>;
  now: () => Date;
  uuid: () => string;
  notify: (events: Event[], webhookUrl: string, signal?: AbortSignal) => Promise<void>;
}

export interface MainOptions {
  timeoutMs?: number;
  dataDir?: string;
  docsDir?: string;
  tmdbApiKey?: string;
  feedUrl?: string;
  feedTitle?: string;
  gitPush?: boolean;
  notifyWebhookUrl?: string;
  failureWebhookUrl?: string;
  deps?: Partial<Deps>;
}

// ─── Small helpers ───────────────────────────────────────────────────────────

function ensureDir(dir: string): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

function atomicWrite(path: string, contents: string): void {
  if (existsSync(path) && readFileSync(path, "utf8") === contents) return;
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, contents);
  renameSync(tmp, path);
}

// ─── TMDB ────────────────────────────────────────────────────────────────────

export async function enrichPosters(
  films: FilmRecord[],
  cache: Record<string, { tmdbId: number; posterPath: string | null }>,
  apiKey: string | undefined,
  tmdb: Deps["tmdb"],
  signal?: AbortSignal,
): Promise<void> {
  for (const film of films) {
    signal?.throwIfAborted();
    film.posterUrl = resolvePoster(film, cache);
    const cached = cache[film.id];
    if (cached) {
      film.tmdb = cached;
      film.posterUrl = resolvePoster(film, cache);
      continue;
    }
    if (film.posterUrl || !apiKey) continue;
    const year = film.releaseDate ? film.releaseDate.slice(0, 4) : null;
    // Poster lookup failures do not invalidate the catalog.
    let result: { tmdbId: number; posterPath: string | null } | null;
    try {
      result = await tmdb(apiKey, film.title, year, signal);
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

const FETCH_TIMEOUT_MS = 30_000;

export const liveDeps: Deps = {
  fetchCatalog: (signal) => fetchCatalog(requestCatalog, { signal }),
  async tmdb(apiKey, query, year, signal) {
    const url = new URL("https://api.themoviedb.org/3/search/movie");
    url.searchParams.set("api_key", apiKey);
    url.searchParams.set("query", query);
    url.searchParams.set("language", "es-CO");
    if (year) url.searchParams.set("year", year);
    const res = await fetch(url, { signal: AbortSignal.any([AbortSignal.timeout(FETCH_TIMEOUT_MS), ...(signal ? [signal] : [])]) });
    if (!res.ok) throw new Error(`tmdb -> ${res.status}`);
    const data = (await res.json()) as { results?: { id: number; poster_path: string | null }[] };
    const top = data.results?.[0];
    return top ? { tmdbId: top.id, posterPath: top.poster_path } : null;
  },
  now: () => new Date(),
  uuid: () => crypto.randomUUID(),
  async notifyFailure(message, webhookUrl) {
    const res = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        allowed_mentions: { parse: [] },
        embeds: [{
          title: "CineColombia: fallo del scraper",
          description: message,
          color: 0xe74c3c,
          timestamp: new Date().toISOString(),
        }],
      }),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`failure webhook -> ${res.status}`);
  },
  async notify(events, webhookUrl, signal) {
    for (const e of events) {
      signal?.throwIfAborted();
      const body = JSON.stringify({ embeds: [buildDiscordEmbed(e)] });
      let res = await fetch(webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
        signal: AbortSignal.any([AbortSignal.timeout(FETCH_TIMEOUT_MS), ...(signal ? [signal] : [])]),
      });
      if (res.status === 429) {
        const retryAfter = ((await res.json()) as { retry_after?: number })?.retry_after ?? 1;
        const wait = Bun.sleep(Math.min(Math.max(retryAfter, 0), 30) * 1000);
        await (signal ? abortable(wait, signal) : wait);
        res = await fetch(webhookUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body,
          signal: AbortSignal.any([AbortSignal.timeout(FETCH_TIMEOUT_MS), ...(signal ? [signal] : [])]),
        });
      }
      if (!res.ok) throw new Error(`discord -> ${res.status}`);
    }
  },
};

// ─── Deployment ──────────────────────────────────────────────────────────────

async function git(args: string[], signal?: AbortSignal): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  signal?.throwIfAborted();
  const proc = Bun.spawn(["git", ...args], {
    cwd: process.cwd(), stdout: "pipe", stderr: "pipe",
    signal: AbortSignal.any([AbortSignal.timeout(15_000), ...(signal ? [signal] : [])]),
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text(),
  ]);
  signal?.throwIfAborted();
  return { ok: exitCode === 0, stdout, stderr };
}

function gitPushEnabled(options: MainOptions): boolean {
  return (options.gitPush ?? process.env.CINECO_GIT_PUSH === "1") === true;
}

/**
 * Rebase onto remote before scrape writes so a later push is fast-forward.
 * Without this, a laptop push makes the server diverge and every feed commit fails non-ff.
 */
async function tryGitPullRebase(signal: AbortSignal): Promise<void> {
  const pull = await git(["pull", "--rebase"], signal);
  if (!pull.ok) {
    console.error("git pull --rebase failed; refusing scrape+push on a diverged remote.");
    throw new Error(`git pull --rebase failed: ${pull.stderr || pull.stdout}`);
  }
}

/** Commit subject from this run's lifecycle events, e.g. "ci: update feed (added:2, removed:1)". */
export function formatCommitMessage(events: Event[]): string {
  if (events.length === 0) return "ci: update catalog";
  const typeCounts = new Map<EventType, number>();
  for (const e of events) typeCounts.set(e.type, (typeCounts.get(e.type) ?? 0) + 1);
  const parts = [...typeCounts.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([t, n]) => `${t}:${n}`);
  return `ci: update feed (${parts.join(", ")})`;
}

async function tryGitPush(events: Event[], signal: AbortSignal): Promise<void> {
  const status = (await git(["status", "--porcelain", "docs", "data"], signal)).stdout.trim();
  if (status) {
    const add = await git(["add", "docs", "data"], signal);
    if (!add.ok) throw new Error(`git add failed: ${add.stderr || add.stdout}`);
    const message = formatCommitMessage(events);
    const commit = await git(["commit", "-m", message], signal);
    if (!commit.ok) {
      const detail = `${commit.stdout}\n${commit.stderr}`.toLowerCase();
      // Nothing staged (or working tree clean) — still try push for leftover commits.
      if (!(detail.includes("nothing to commit") || detail.includes("no changes added"))) {
        throw new Error(`git commit failed: ${commit.stderr || commit.stdout}`);
      }
    }
  }
  // Always push: recovers unpushed commits after a prior non-ff failure even on quiet runs.
  const push = await git(["push"], signal);
  if (!push.ok) {
    console.error("git push failed; state already saved. Next scrape will pull --rebase and retry push.");
    throw new Error("git push failed (non-fast-forward?)");
  }
}

// ─── Offline archive hygiene ─────────────────────────────────────────────────

/**
 * One-shot offline repair for historical posts.json (restage + drop preventa twins).
 * Scrapes stay append-only; call via CLI `--hygiene` / `hygiene` when lifecycle rules change.
 * Rewrites posts atomically and regenerates RSS so public surfaces match.
 * No scrape, notify, or git.
 */
export function runArchiveHygiene(
  options: Pick<MainOptions, "dataDir" | "docsDir" | "feedUrl" | "feedTitle"> = {},
): { before: number; after: number } {
  const dataDir = options.dataDir ?? "data";
  const docsDir = options.docsDir ?? "docs";
  const postsPath = join(dataDir, "posts.json");
  const feedPath = join(docsDir, "feed.xml");
  const feedUrl =
    options.feedUrl ?? process.env.FEED_URL ?? "https://cinecolombia.cpzhmlb.uk/feed.xml";
  const feedTitle = options.feedTitle ?? process.env.FEED_TITLE ?? "CineColombia — Cartelera y Preventa";

  const archive = loadPosts(postsPath);
  const tmdbCache = loadState(join(dataDir, "state.json")).tmdbCache;
  const before = archive.posts.length;
  archive.posts = sanitizeArchivePosts(archive.posts);
  if (archive.pendingNotificationIds) {
    const retained = new Set(archive.posts.map(p => p.guid));
    archive.pendingNotificationIds = archive.pendingNotificationIds.filter(id => retained.has(id));
    if (!archive.pendingNotificationIds.length) delete archive.pendingNotificationIds;
  }
  const after = archive.posts.length;

  ensureDir(dataDir);
  ensureDir(docsDir);
  savePosts(postsPath, archive);
  atomicWrite(feedPath, generateFeed(archive.posts, { feedTitle, feedUrl, language: "es-CO", tmdbCache }));

  return { before, after };
}

// ─── Main ────────────────────────────────────────────────────────────────────

export async function main(options: MainOptions = {}): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("scrape deadline exceeded")), options.timeoutMs ?? 140_000);
  try {
    await abortable(runMain(options, controller.signal), controller.signal);
  } catch (error) {
    const webhookUrl = options.failureWebhookUrl ?? process.env.FAILURE_WEBHOOK_URL ??
      options.notifyWebhookUrl ?? process.env.NOTIFY_WEBHOOK_URL;
    if (webhookUrl) {
      let message = error instanceof Error ? error.message : String(error);
      for (const secret of [
        webhookUrl, options.notifyWebhookUrl, process.env.NOTIFY_WEBHOOK_URL,
        options.tmdbApiKey, process.env.TMDB_API_KEY,
      ]) {
        if (secret) message = message.replaceAll(secret, "<REDACTED>");
      }
      message = message.replace(/https?:\/\/[^\s]+/gi, "<REDACTED URL>")
        .replace(/Bearer\s+[^\s]+/gi, "Bearer <REDACTED>").slice(0, 3500);
      try {
        await (options.deps?.notifyFailure ?? liveDeps.notifyFailure)(message, webhookUrl);
      } catch {
        // Delivery errors can contain the webhook URL. Keep credentials out of logs.
        console.error("failure alert delivery failed; see original scraper error");
      }
    }
    throw error;
  } finally { clearTimeout(timer); }
}

async function runMain(options: MainOptions, signal: AbortSignal): Promise<void> {
  const startedAt = Date.now();
  const dataDir = options.dataDir ?? "data";
  const docsDir = options.docsDir ?? "docs";
  const statePath = join(dataDir, "state.json");
  const postsPath = join(dataDir, "posts.json");
  const feedPath = join(docsDir, "feed.xml");
  const feedUrl =
    options.feedUrl ?? process.env.FEED_URL ?? "https://cinecolombia.cpzhmlb.uk/feed.xml";
  const feedTitle = options.feedTitle ?? process.env.FEED_TITLE ?? "CineColombia — Cartelera y Preventa";
  const tmdbApiKey = options.tmdbApiKey ?? process.env.TMDB_API_KEY;
  const notifyWebhookUrl = options.notifyWebhookUrl ?? process.env.NOTIFY_WEBHOOK_URL;
  const deps: Deps = { ...liveDeps, ...options.deps };
  const doGitPush = gitPushEnabled(options);

  // Sync with remote before any scrape writes so push stays fast-forward.
  if (doGitPush) await tryGitPullRebase(signal);

  // Gather everything before touching any file (hard rule: aborted scrape ≠ every film gone).
  const prev = loadState(statePath);
  const archive = loadPosts(postsPath);
  const current = await abortable(deps.fetchCatalog(signal), signal);
  if (prev.films.some((f) => f.categories.length > 0) &&
      current.length > 0 && !current.some((f) => f.categories.length > 0)) {
    throw new Error("empty website availability categories for populated catalog — aborting before write");
  }
  // runLifecycle rejects an empty observation when previous films are known.
  await abortable(enrichPosters(current, prev.tmdbCache, tmdbApiKey, deps.tmdb, signal), signal);
  signal.throwIfAborted();

  const result = runLifecycle(prev, current, archive.posts.length, deps);
  if (!result.ok) {
    throw new Error(lifecycleAbortMessage(result.abort));
  }
  const { coldStart, archivedEvents, films, missingRuns, pendingCategoryLosses, lastRun } = result.outcome;

  if (archivedEvents.length > 0) archive.posts.push(...archivedEvents);
  if (notifyWebhookUrl && archivedEvents.length) {
    archive.pendingNotificationIds = [...new Set([
      ...(archive.pendingNotificationIds ?? []), ...archivedEvents.map(e => e.guid),
    ])];
  }
  const newState: State = {
    films,
    tmdbCache: prev.tmdbCache,
    missingRuns,
    pendingCategoryLosses,
    lastRun,
  };
  const feed = generateFeed(archive.posts, { feedTitle, feedUrl, language: "es-CO", tmdbCache: prev.tmdbCache });

  // Everything succeeded — now persist.
  // Posts before state so a crash mid-write prefers re-emitting events over losing them.
  signal.throwIfAborted();
  ensureDir(dataDir);
  ensureDir(docsDir);
  savePosts(postsPath, archive);
  saveState(statePath, newState);
  atomicWrite(feedPath, feed);
  // Fetch/persist time belongs in the run log, not tracked state on quiet runs.
  console.log(`observedAt=${deps.now().toISOString()}`);

  // Acknowledge each delivery separately. A later failure must not repeat earlier successes.
  if (notifyWebhookUrl) {
    for (const guid of [...(archive.pendingNotificationIds ?? [])]) {
      signal.throwIfAborted();
      const event = archive.posts.find(p => p.guid === guid);
      if (!event) throw new Error(`pending notification has no archived event: ${guid}`);
      try {
        await abortable(deps.notify([event], notifyWebhookUrl, signal), signal);
        signal.throwIfAborted();
        archive.pendingNotificationIds = archive.pendingNotificationIds!.filter(id => id !== guid);
        if (!archive.pendingNotificationIds.length) delete archive.pendingNotificationIds;
        savePosts(postsPath, archive);
      } catch {
        signal.throwIfAborted();
        console.error("notification delivery failed; queued for next run");
        break;
      }
    }
  }

  signal.throwIfAborted();
  if (doGitPush) {
    await tryGitPush(archivedEvents, signal);
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
    main().then(async () => {
      if (process.env.CINECO_DEPLOY === "1") await deploySite();
    }).catch((e) => {
      console.error(e);
      process.exit(1);
    });
  }
}
