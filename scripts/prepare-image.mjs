import { createWriteStream } from "node:fs";
import { access, mkdir } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dest = path.join(root, "images", "alpine-minirootfs-3.20.3-x86_64.tar.gz");
const url = "https://dl-cdn.alpinelinux.org/alpine/v3.20/releases/x86_64/alpine-minirootfs-3.20.3-x86_64.tar.gz";

await mkdir(path.dirname(dest), { recursive: true });
try {
  await access(dest);
  console.log(dest);
  process.exit(0);
} catch {
  // download
}
const res = await fetch(url);
if (!res.ok || !res.body) throw new Error("download failed: " + res.status);
await pipeline(Readable.fromWeb(res.body), createWriteStream(dest));
console.log(dest);
