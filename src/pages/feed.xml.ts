import { generateFeed } from "../../presentation";
import { archive, state, feedTitle, feedUrl } from "../../site-data";
export function GET() {
  return new Response(generateFeed(archive.posts, { feedTitle, feedUrl, language: "es-CO", tmdbCache: state.tmdbCache }), {
    headers: { "Content-Type": "application/rss+xml; charset=utf-8" },
  });
}
