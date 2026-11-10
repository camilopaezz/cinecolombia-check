import { generateFeed } from "../../presentation";
import { archive, feedTitle, feedUrl } from "../../site-data";
export function GET() {
  return new Response(generateFeed(archive.posts, { feedTitle, feedUrl, language: "es-CO" }), {
    headers: { "Content-Type": "application/rss+xml; charset=utf-8" },
  });
}
