#!/usr/bin/env node
// Puts one step's phone, tablet and desktop screenshots side by side in one labelled PNG,
// so a step comment carries a single image instead of three.
//   node scripts/viewports.ts <out.png> <phone.png> <tablet.png> <desktop.png>
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const HEIGHT = 900;
const GAP = 32;
const LABEL = 40;
const CHROME = process.env.CHROME ??
  join(homedir(), ".local/share/chrome-for-testing/current/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing");

function size(path: string): { width: number; height: number } {
  const png = readFileSync(path);
  if (png.toString("ascii", 1, 4) !== "PNG") throw new Error(`${path} is not a PNG`);
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}

const [out, ...shots] = process.argv.slice(2);
if (!out || shots.length !== 3) {
  console.error("usage: node scripts/viewports.ts <out.png> <phone.png> <tablet.png> <desktop.png>");
  process.exit(2);
}
const labels = ["Phone · 375", "Tablet · 768", "Desktop · 1440"];
const panels = shots.map((path, i) => {
  const { width, height } = size(path);
  return { src: pathToFileURL(resolve(path)).href, label: labels[i], width: Math.round((width * HEIGHT) / height) };
});
const width = panels.reduce((sum, p) => sum + p.width, 0) + GAP * (panels.length + 1);
const height = HEIGHT + LABEL + GAP * 2;
const html = `<!doctype html><meta charset="utf-8"><style>
body{margin:0;background:#f4f4f5;font:500 18px system-ui,sans-serif;color:#18181b}
main{display:flex;gap:${GAP}px;padding:${GAP}px;align-items:flex-start}
figure{margin:0}figcaption{height:${LABEL}px}
img{display:block;height:${HEIGHT}px;border:1px solid #d4d4d8;border-radius:8px;background:#fff}
</style><main>${panels.map((p) => `<figure><figcaption>${p.label}</figcaption><img src="${p.src}" width="${p.width}"></figure>`).join("")}</main>`;

const dir = mkdtempSync(join(tmpdir(), "viewports-"));
try {
  const page = join(dir, "sheet.html");
  writeFileSync(page, html);
  execFileSync(CHROME, [
    "--headless=new", "--disable-gpu", "--hide-scrollbars", "--force-device-scale-factor=1", "--allow-file-access-from-files",
    `--user-data-dir=${join(dir, "profile")}`, `--window-size=${width},${height}`, `--screenshot=${resolve(out)}`, pathToFileURL(page).href,
  ], { stdio: "ignore", timeout: 60_000 });
  console.log(`${out} ${width}x${height}`);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
