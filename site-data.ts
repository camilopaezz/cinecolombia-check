import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { PostArchive, State } from "./domain";

// This build-time module reads committed observations; a website build never scrapes.
const dataDir = process.env.CINECO_DATA_DIR ?? "data";
export const state = JSON.parse(readFileSync(resolve(dataDir, "state.json"), "utf8")) as State;
export const archive = JSON.parse(readFileSync(resolve(dataDir, "posts.json"), "utf8")) as PostArchive;
export const feedTitle = process.env.FEED_TITLE ?? "CineColombia — Cartelera y Preventa";
export const feedUrl = process.env.FEED_URL ?? "https://cinecolombia.cpzhmlb.uk/feed.xml";
