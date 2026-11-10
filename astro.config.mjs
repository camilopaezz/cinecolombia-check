import { defineConfig } from "astro/config";
export default defineConfig({ output: "static", outDir: process.env.CINECO_DIST_DIR ?? "./dist", publicDir: "./public" });
