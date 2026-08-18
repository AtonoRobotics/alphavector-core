import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { architectViewerHtml } from "../src/computer/desktop.js";
import { architectHabitatPageHtml } from "../src/http/architect-habitat-page.js";
import { GLASS, PRODUCT } from "../src/identity.js";
import { ALPHAVECTOR_RE_PIN_SHA, REPO_ROOT } from "./helpers.js";

const RE_PIN = "5091328a2a5d4a9429ec65fef6da5683ede1cac9";
const ALLOWED = new Set(["#F4F1EA", "#0B0B0C", "#2A2A2D", "#C4A574"]);
const HEX = /#(?:[0-9a-fA-F]{3,8})\b/g;
const LOCKUP =
  /VEYRA|Agent OS|AgentOS|powerful|high-tech|high tech|realtor cream|\bpurple\b|\bviolet\b/i;
const BANNED_SERVED = /Alpha Vector LLC|AV Dev|VEYRA/;
const IOS_PLIST = path.join(REPO_ROOT, "clients/field-ios/Field/Info.plist");
const IOS_PBX = path.join(REPO_ROOT, "clients/field-ios/Field.xcodeproj/project.pbxproj");
const DISPLAY_FACE = /Georgia|Times New Roman|Playfair|ui-serif|Cormorant|Bodoni|Didot/i;
const GLOW = /linear-gradient|radial-gradient|conic-gradient|box-shadow|text-shadow|drop-shadow|glow/i;

const FIELD_LINUX = path.join(REPO_ROOT, "clients/field-linux/index.html");
const DESKTOP = path.join(REPO_ROOT, "src/computer/desktop.ts");
const HOME_VIEW = path.join(REPO_ROOT, "clients/field-ios/Field/HomeView.swift");
const FIELD_APP = path.join(REPO_ROOT, "clients/field-ios/Field/FieldApp.swift");
const IOS_ASSETS = path.join(REPO_ROOT, "clients/field-ios/Field/Assets.xcassets");

function read(relOrAbs: string): string {
  return readFileSync(relOrAbs, "utf8");
}

function expandHex(raw: string): string {
  const h = raw.slice(1);
  if (h.length === 3 || h.length === 4) {
    return `#${[...h].map((c) => c + c).join("").slice(0, 6)}`.toUpperCase();
  }
  return `#${h.slice(0, 6)}`.toUpperCase();
}

function hexes(src: string): string[] {
  return [...src.matchAll(HEX)].map((m) => expandHex(m[0]));
}

function assertOnlyBoardHues(src: string, label: string): void {
  const found = hexes(src);
  const extra = [...new Set(found)].filter((h) => !ALLOWED.has(h));
  expect(extra, `${label} invented hues: ${extra.join(", ")}`).toEqual([]);
}

function parseComp(value: string): number {
  const v = value.trim();
  if (/^0x/i.test(v)) return Number.parseInt(v, 16);
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`bad color component ${value}`);
  return n <= 1 ? Math.round(n * 255) : Math.round(n);
}

function colorsetHexes(json: string): string[] {
  const parsed = JSON.parse(json) as {
    colors?: Array<{ color?: { components?: { red: string; green: string; blue: string } } }>;
  };
  const out: string[] = [];
  for (const row of parsed.colors ?? []) {
    const comp = row.color?.components;
    if (!comp) continue;
    const r = parseComp(comp.red).toString(16).padStart(2, "0");
    const g = parseComp(comp.green).toString(16).padStart(2, "0");
    const b = parseComp(comp.blue).toString(16).padStart(2, "0");
    out.push(`#${r}${g}${b}`.toUpperCase());
  }
  return out;
}

function listColorsets(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && e.name.endsWith(".colorset"))
    .map((e) => path.join(dir, e.name, "Contents.json"));
}

describe("glass brand boards", () => {
  it("keeps the RE fixture pin at 5091328", () => {
    expect(ALPHAVECTOR_RE_PIN_SHA).toBe(RE_PIN);
  });

  it("locks the four Website hues and Pyrallon display", () => {
    expect(PRODUCT.appDisplay).toBe("Pyrallon");
    expect(GLASS.bone).toBe("#F4F1EA");
    expect(GLASS.nearBlack).toBe("#0B0B0C");
    expect(GLASS.hairline).toBe("#2A2A2D");
    expect(GLASS.holdAmber).toBe("#C4A574");
  });

  it("fails if Alpha Vector LLC, AV Dev, or VEYRA reappear in served HTML or identity chrome", () => {
    const field = read(FIELD_LINUX);
    const habitat = architectHabitatPageHtml();
    const desktop = architectViewerHtml({
      tenantId: "t1",
      agentId: "writer",
      display: 12,
      vncPort: 5912,
    });
    const habitatSrc = read(path.join(REPO_ROOT, "src/http/architect-habitat-page.ts"));
    const desktopSrc = read(DESKTOP);
    const home = read(HOME_VIEW);
    const app = read(FIELD_APP);
    const plist = read(IOS_PLIST);
    const pbx = read(IOS_PBX);
    const served: Array<[string, string]> = [
      ["field-linux", field],
      ["habitat html", habitat],
      ["desktop html", desktop],
      ["habitat page source", habitatSrc],
      ["desktop source", desktopSrc],
      ["HomeView.swift", home],
      ["FieldApp.swift", app],
      ["Info.plist", plist],
      ["project.pbxproj", pbx],
    ];
    for (const [label, src] of served) {
      expect(src, label).not.toMatch(BANNED_SERVED);
    }
    expect(PRODUCT.appDisplay).not.toMatch(BANNED_SERVED);
    expect(field).toContain("Pyrallon Field");
    expect(habitat).toContain("Pyrallon habitat");
    expect(habitat).toContain("<footer>Pyrallon</footer>");
    expect(desktop).toContain("<title>Architect Desktop · writer</title>");
    expect(desktop).toContain("<footer>Pyrallon</footer>");
    expect(home).toContain('navigationTitle("Pyrallon Field")');
    expect(home).toContain('Text("Pyrallon")');
    expect(plist).toContain("<string>Pyrallon</string>");
    expect(pbx).toMatch(/INFOPLIST_KEY_CFBundleDisplayName = "Pyrallon"/);
  });

  it("field-linux glass uses only board hues, one grotesque, and amber only on a held step", () => {
    const html = read(FIELD_LINUX);
    assertOnlyBoardHues(html, "field-linux");
    expect(html).toMatch(/<title>Pyrallon Field<\/title>/);
    expect(html).toMatch(/<h1>Pyrallon Field<\/h1>/);
    expect(html).toMatch(/<footer>Pyrallon<\/footer>/);
    expect(html).toMatch(/Architect is not on this surface/);
    expect(html).toMatch(/aria-label="Live"/);
    expect(html).toMatch(/aria-label="Tape"/);
    expect(html).toMatch(/aria-label="Held"/);
    expect(html).toMatch(/aria-label="Artifact"/);
    expect(html).toMatch(/aria-label="Form"/);
    expect(html).toMatch(/id="ask-text"/);
    expect(html).toMatch(/id="ask-class"/);
    expect(html).toMatch(/function escapeHtml\(/);
    expect(html).toMatch(/el\.innerHTML = rows\.length \? rows\.map\(html\)\.join\(""\)/);
    expect(html).not.toMatch(LOCKUP);
    expect(html).not.toMatch(DISPLAY_FACE);
    expect(html).not.toMatch(GLOW);
    expect(html).not.toMatch(/\bT0\b|\bT1\b|\bT2\b|\bT3\b/);
    expect(html).not.toMatch(/Desk|Shape|Director|Play|Plant|HIL|Thor|Mission Control/);
    expect(html).not.toMatch(/<svg|monogram|lockup|bird/i);
    expect(html).not.toMatch(/chat-log|message-list|conversation thread/i);
    expect(html).not.toMatch(/architectControls|pick a model|edit prompt|inspect temporal|configure tool/i);

    const families = [...html.matchAll(/font-family:\s*([^;]+);/g)].map((m) => m[1].trim());
    expect(new Set(families).size).toBe(1);
    expect(families[0]).toBe("ui-sans-serif, system-ui, sans-serif");
    const weights = [...html.matchAll(/font-weight:\s*([^;]+);/g)].map((m) => m[1].trim());
    expect(weights.every((w) => w === "400" || w === "500" || w === "inherit")).toBe(true);

    expect(html).toMatch(/--hold:\s*#C4A574/);
    expect(html).toMatch(/\.held\s*\{[^}]*var\(--hold\)/);
    expect(html).toMatch(/\.held strong\s*\{[^}]*var\(--hold\)/);
    expect(html).toMatch(/renderList\("cards", home\.inbox,[\s\S]*class="held"/);
    const holdUses = [...html.matchAll(/var\(--hold\)/g)];
    expect(holdUses.length).toBe(2);
    expect(html).not.toMatch(/button[^}]*var\(--hold\)/);
    expect(html).not.toMatch(/h1[^}]*var\(--hold\)/);
    expect(html).not.toMatch(/#status[^}]*var\(--hold\)/);
    expect(html).not.toMatch(/header[^}]*var\(--hold\)/);
    const withoutCards = html.replace(/renderList\("cards"[\s\S]*?\);/, "");
    expect(withoutCards).not.toMatch(/class="held"/);
  });

  it("architectViewerHtml is the same four-token system without a hue factory", () => {
    const src = read(DESKTOP);
    expect(src).not.toMatch(/colorForDisplay/);
    expect(src).not.toMatch(/input\.color/);
    expect(src).toMatch(/xsetroot", \["-solid", GLASS\.nearBlack\]/);
    expect(src).toMatch(/export function architectViewerHtml/);
    expect(src).toMatch(/function escapeHtml/);
    expect(src).not.toMatch(LOCKUP);
    expect(src).not.toMatch(DISPLAY_FACE);
    expect(src).not.toMatch(GLOW);
    expect(src).not.toMatch(/\bT0\b|\bT1\b|\bT2\b|\bT3\b/);
    assertOnlyBoardHues(src, "desktop.ts");

    const html = architectViewerHtml({
      tenantId: "t1",
      agentId: "writer",
      display: 12,
      vncPort: 5912,
    });
    assertOnlyBoardHues(html, "architectViewerHtml");
    expect(hexes(html).sort()).toEqual(["#0B0B0C", "#2A2A2D", "#F4F1EA"].sort());
    expect(html).toContain("Architect Desktop");
    expect(html).toContain("Architect attach");
    expect(html).toContain("<footer>Pyrallon</footer>");
    expect(html).toContain("border: 1px solid var(--hairline)");
    expect(html).not.toContain("#C4A574");
    expect(html).not.toMatch(/--hold/);
    expect(html).not.toMatch(LOCKUP);
    expect(html).not.toMatch(GLOW);
    expect(html).not.toMatch(/<svg|monogram|lockup|bird/i);
    expect(html).not.toMatch(/chat-log|settings lab|pick a model/i);
    const families = [...html.matchAll(/font-family:\s*([^;]+);/g)].map((m) => m[1].trim());
    expect(new Set(families).size).toBe(1);
    expect(families[0]).toBe("ui-sans-serif, system-ui, sans-serif");
    const weights = [...html.matchAll(/font-weight:\s*([^;]+);/g)].map((m) => m[1].trim());
    expect(weights.every((w) => w === "400" || w === "500")).toBe(true);
    expect(html).toContain("writer");
    expect(html).not.toContain("&amp;");
    expect(architectViewerHtml({ tenantId: "a&b", agentId: "<x>", display: 1, vncPort: 2 })).toContain(
      "&lt;x&gt;",
    );
  });

  it("habitat wizard glass uses board hues and is not a named desktop", () => {
    const src = read(path.join(REPO_ROOT, "src/http/architect-habitat-page.ts"));
    expect(src).toMatch(/export function architectHabitatPageHtml/);
    expect(src).not.toMatch(LOCKUP);
    expect(src).not.toMatch(DISPLAY_FACE);
    expect(src).not.toMatch(GLOW);
    expect(src).not.toMatch(/\bT0\b|\bT1\b|\bT2\b|\bT3\b/);
    expect(src).not.toMatch(/Architect Desktop|Architect IDE|Architect Studio|Architect App/i);
    expect(src).not.toMatch(/api\.openai\.com|api\.anthropic\.com|gpt-|claude-|OPENAI_API_KEY|AV_NO_VENDOR/);
    assertOnlyBoardHues(src, "architect-habitat-page.ts");

    const html = architectHabitatPageHtml();
    assertOnlyBoardHues(html, "architectHabitatPageHtml");
    expect(hexes(html).sort()).toEqual(["#0B0B0C", "#2A2A2D", "#C4A574", "#F4F1EA"].sort());
    expect(html).toContain("<title>Pyrallon habitat</title>");
    expect(html).toContain("<h1>Pyrallon habitat</h1>");
    expect(html).toContain("Architect sits in the habitat.");
    expect(html).toContain("<footer>Pyrallon</footer>");
    expect(html).toMatch(/id="model-id"/);
    expect(html).toMatch(/id="vendor-base-url"/);
    expect(html).toMatch(/id="api-key"/);
    expect(html).toMatch(/id="connector-id"/);
    expect(html).toMatch(/\/architect\/bind-adapter/);
    expect(html).toMatch(/\/architect\/set-adapter-credentials/);
    expect(html).toMatch(/\/architect\/bind-connector/);
    expect(html).toMatch(/\/architect\/set-connector-credentials/);
    expect(html).toContain("#C4A574");
    expect(html).toMatch(/\.step\[data-held="true"\][^}]*#C4A574/);
    expect(html).not.toMatch(/h1[^}]*#C4A574|button[^}]*#C4A574/);
    expect(html).not.toMatch(LOCKUP);
    expect(html).not.toMatch(GLOW);
    expect(html).not.toMatch(/<svg|monogram|lockup|bird/i);
    expect(html).not.toMatch(/Architect Desktop|pick a model|edit prompt|inspect temporal|configure tool/i);
    const families = [...html.matchAll(/font-family:\s*([^;]+);/g)].map((m) => m[1].trim());
    expect(new Set(families).size).toBe(1);
    expect(families[0]).toBe("ui-sans-serif, system-ui, sans-serif");
    const weights = [...html.matchAll(/font-weight:\s*([^;]+);/g)].map((m) => m[1].trim());
    expect(weights.every((w) => w === "400" || w === "500")).toBe(true);
  });

  it("field-ios color sources lock the same four tokens and hold amber only on Cards", () => {
    const home = read(HOME_VIEW);
    const app = read(FIELD_APP);
    expect(home).toMatch(/navigationTitle\("Pyrallon Field"\)/);
    expect(home).toMatch(/Text\("Pyrallon"\)/);
    expect(read(IOS_PLIST)).toContain("<string>Pyrallon</string>");
    expect(read(IOS_PBX)).toMatch(/INFOPLIST_KEY_CFBundleDisplayName = "Pyrallon"/);
    expect(read(IOS_PBX)).toMatch(/PRODUCT_BUNDLE_IDENTIFIER = llc\.alphavector\.dev/);
    expect(home).toMatch(/static let holdAmber = Color\("HoldAmber"\)/);
    expect(home).toMatch(/Section\("Cards"\)[\s\S]*FieldGlass\.holdAmber/);
    const usage = home.replace(/private enum FieldGlass \{[\s\S]*?\n\}/, "");
    const withoutCards = usage.replace(/Section\("Cards"\)[\s\S]*?(?=Section\()/, "");
    expect(withoutCards).not.toMatch(/holdAmber/);
    expect(home).not.toMatch(/role:\s*\.destructive/);
    expect(home).not.toMatch(/\.foregroundStyle\(\.secondary\)/);
    expect(home).not.toMatch(/Color\(red:|\.purple|\.red|\.orange|\.mint|\.indigo|\.pink/);
    expect(home).not.toMatch(LOCKUP);
    expect(home).not.toMatch(/\bT0\b|\bT1\b|\bT2\b|\bT3\b/);
    expect(app).not.toMatch(LOCKUP);
    assertOnlyBoardHues(home, "HomeView.swift");
    assertOnlyBoardHues(app, "FieldApp.swift");

    const colorsets = listColorsets(IOS_ASSETS);
    const names = colorsets.map((p) => path.basename(path.dirname(p)).replace(/\.colorset$/, ""));
    expect(names.sort()).toEqual(["AccentColor", "Bone", "Hairline", "HoldAmber", "NearBlack"].sort());
    const byName = new Map<string, string[]>();
    for (const file of colorsets) {
      const hues = colorsetHexes(read(file));
      const extra = hues.filter((h) => !ALLOWED.has(h));
      expect(extra, `${file} invented hues`).toEqual([]);
      byName.set(path.basename(path.dirname(file)).replace(/\.colorset$/, ""), hues);
    }
    expect(byName.get("Bone")).toEqual(["#F4F1EA"]);
    expect(byName.get("AccentColor")).toEqual(["#F4F1EA"]);
    expect(byName.get("NearBlack")).toEqual(["#0B0B0C"]);
    expect(byName.get("Hairline")).toEqual(["#2A2A2D"]);
    expect(byName.get("HoldAmber")).toEqual(["#C4A574"]);
    expect(byName.get("AccentColor")).not.toEqual(["#C4A574"]);
  });
});
