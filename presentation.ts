import type { Event, EventType, FilmRecord } from "./domain";

const EVENT_LABELS: Record<EventType, string> = {
  added: "Pronto",
  "preventa-opens": "Preventa abierta",
  "now-in-theaters": "En cartelera",
  removed: "Ya no disponible",
};

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
