import { fileURLToPath } from "node:url";
import { join } from "node:path";

const projectDir = fileURLToPath(new URL(".", import.meta.url));

/** Build on this machine, then upload the completed static assets. */
export async function deploySite(): Promise<void> {
  const runtime = process.env.CINECO_NODE ?? "node";
  const commands = [
    [runtime, join(projectDir, "node_modules/astro/bin/astro.mjs"), "build"],
    [runtime, join(projectDir, "node_modules/wrangler/bin/wrangler.js"), "deploy"],
  ];
  for (const command of commands) {
    const proc = Bun.spawn(command, {
      cwd: projectDir, stdout: "inherit", stderr: "inherit",
      env: { ...process.env, ASTRO_TELEMETRY_DISABLED: "1", CI: "1" },
      timeout: 120_000,
    });
    if (await proc.exited !== 0) throw new Error(`local ${command[2]} failed`);
  }
}

if (import.meta.main) await deploySite();
