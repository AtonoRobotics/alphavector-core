import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/**
 * Linux deep-link, same class as ZCode desktop `createLinuxDeepLinkDesktopEntry`.
 * Official hop ends at zcode://oauth/callback. Habitat must see that URI.
 * Tests skip this; they mock GET /architect/glm-callback with the official hop.
 */
export async function registerHabitatZcodeCallback(callbackUrl: string): Promise<void> {
  if (process.env.VITEST || process.platform !== "linux") return;
  const home = process.env.HOME?.trim() || os.homedir();
  if (!home) return;
  const apps = path.join(home, ".local/share/applications");
  try {
    await mkdir(apps, { recursive: true });
    const desktopPath = path.join(apps, "pyrallon-habitat-zcode.desktop");
    const exec = `sh -c 'curl -fsS -G --data-urlencode "hop=$1" "${callbackUrl}" >/dev/null' _ %u`;
    await writeFile(
      desktopPath,
      [
        "[Desktop Entry]",
        "Type=Application",
        "Name=Pyrallon Habitat ZCode callback",
        `Exec=${exec}`,
        "NoDisplay=true",
        "MimeType=x-scheme-handler/zcode;",
        "",
      ].join("\n"),
      "utf8",
    );
    spawn("xdg-mime", ["default", "pyrallon-habitat-zcode.desktop", "x-scheme-handler/zcode"], {
      stdio: "ignore",
    }).unref();
  } catch {
    // Best-effort live OS hook. HTTP glm-callback remains the Habitat receive path.
  }
}
