import { describe, it, expect } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main, loadPosts } from "./scrape";
import type { FilmRecord } from "./domain";
import { fetchCatalog } from "./catalog";

const film: FilmRecord = { id: "HO1", title: "Film", shortSynopsis: "", releaseDate: null,
  runtimeInMinutes: null, censorRating: "", genres: [], director: "", webUrl: "", posterUrl: null,
  categories: ["ComingSoon"], availabilityRows: [{ siteId: null, categories: ["ComingSoon"] }] };

describe("scrape reliability", () => {
  it("retains failed notifications, retries on a quiet run, and does not repeat acknowledged events", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cineco-outbox-"));
    let films = [film];
    const delivered: string[] = [];
    let failSecond = true;
    let uuid = 0;
    const options = { dataDir: join(dir, "data"), docsDir: join(dir, "docs"), gitPush: false,
      tmdbApiKey: "", failureWebhookUrl: "", notifyWebhookUrl: "https://example.com/webhook",
      deps: { fetchCatalog: async () => films, uuid: () => `event-${++uuid}`,
        notify: async (events: import("./domain").Event[]) => {
          if (failSecond && delivered.length === 1) throw new Error("503");
          delivered.push(...events.map(e => e.guid));
        } } };
    try {
      await main(options);
      films = [...films, { ...film, id: "HO2" }, { ...film, id: "HO3" }];
      await main(options);
      const path = join(options.dataDir, "posts.json");
      expect(delivered).toHaveLength(1);
      expect(loadPosts(path).pendingNotificationIds).toHaveLength(1);
      await main({ ...options, notifyWebhookUrl: "" });
      expect(delivered).toHaveLength(1);
      expect(loadPosts(path).pendingNotificationIds).toHaveLength(1);
      failSecond = false;
      await main(options);
      expect(delivered).toHaveLength(2);
      expect(new Set(delivered).size).toBe(2);
      expect(loadPosts(path).pendingNotificationIds).toBeUndefined();
      await main(options);
      expect(delivered).toHaveLength(2);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("aborts a hung catalog and prevents late writes from an uncooperative dependency", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cineco-deadline-"));
    const options = { dataDir: join(dir, "data"), docsDir: join(dir, "docs"), gitPush: false,
      failureWebhookUrl: "", notifyWebhookUrl: "", tmdbApiKey: "", deps: { fetchCatalog: async () => [film] } };
    try {
      await main(options);
      const path = join(options.dataDir, "state.json");
      const before = readFileSync(path, "utf8");
      let release!: (films: FilmRecord[]) => void;
      await expect(main({ ...options, timeoutMs: 10, deps: { fetchCatalog: () => new Promise(resolve => { release = resolve; }) } }))
        .rejects.toThrow("scrape deadline exceeded");
      release([{ ...film, title: "Late data" }]);
      await Bun.sleep(5);
      expect(readFileSync(path, "utf8")).toBe(before);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it("cancels remaining catalog requests on deadline", async () => {
    let requestSignal: AbortSignal | undefined;
    await expect(fetchCatalog(async (_path, signal) => {
      requestSignal = signal;
      return new Promise(() => {});
    }, { timeoutMs: 10 })).rejects.toThrow("catalog deadline exceeded");
    expect(requestSignal?.aborted).toBe(true);
  });
});
