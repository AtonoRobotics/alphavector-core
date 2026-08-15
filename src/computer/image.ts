import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createWriteStream } from "node:fs";
import { mkdir, readFile, writeFile, access, cp, rm } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";

const execFileAsync = promisify(execFile);

export const DEFAULT_ALPINE_URL =
  "https://dl-cdn.alpinelinux.org/alpine/v3.20/releases/x86_64/alpine-minirootfs-3.20.3-x86_64.tar.gz";

export const DEFAULT_IMAGE_ID = "alpine-3.20.3-av-computer";

export async function ensureAlpineTarball(cacheDir: string, url = DEFAULT_ALPINE_URL): Promise<string> {
  await mkdir(cacheDir, { recursive: true });
  const dest = path.join(cacheDir, "alpine-minirootfs-3.20.3-x86_64.tar.gz");
  try {
    await access(dest);
    return dest;
  } catch {
    const res = await fetch(url);
    if (!res.ok || !res.body) {
      throw new Error(`Failed to download computer image: ${res.status}`);
    }
    await pipeline(Readable.fromWeb(res.body as never), createWriteStream(dest));
    return dest;
  }
}

export async function extractRootfs(tarball: string, dest: string): Promise<void> {
  await rm(dest, { recursive: true, force: true });
  await mkdir(dest, { recursive: true });
  await execFileAsync("tar", ["-xzf", tarball, "-C", dest]);
}

export async function stampImage(rootfs: string, imageId: string): Promise<void> {
  await writeFile(path.join(rootfs, "etc", "av-image-id"), `${imageId}\n`, "utf8");
  await writeFile(
    path.join(rootfs, "etc", "av-computer"),
    "alphavector-core tenant computer\n",
    "utf8",
  );
}

export async function readImageId(rootfs: string): Promise<string> {
  try {
    return (await readFile(path.join(rootfs, "etc", "av-image-id"), "utf8")).trim();
  } catch {
    return "unknown";
  }
}

export function hashFileSyncLike(contents: string): string {
  return createHash("sha256").update(contents).digest("hex").slice(0, 16);
}

export async function cloneRootfs(src: string, dest: string): Promise<void> {
  await rm(dest, { recursive: true, force: true });
  await cp(src, dest, { recursive: true });
}
