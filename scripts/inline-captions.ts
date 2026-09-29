// Inlines the aligned captions from edit-plan.json into scene files, so the
// Studio's caption editor can write edits back to the array literal.
// Looks for `// @captions <clip> <offsetInFrames>` right after `captions={[`
// and replaces everything up to the closing `]}`.
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";

type Caption = {
  text: string;
  startMs: number;
  endMs: number;
  timestampMs: number | null;
  confidence: number | null;
  pageBreakAfter?: boolean;
};

const root = process.cwd();
const plan = JSON.parse(
  readFileSync(path.join(root, "scripts", "edit-plan.json"), "utf8"),
) as Record<string, { captions: Caption[] }>;

const scenesDir = path.join(root, "src", "scenes");
const marker = /^([ \t]*)\/\/ @captions (\w+)(?: (\d+))?[^\n]*[\s\S]*?(\n[ \t]*\]\})/gm;

for (const file of readdirSync(scenesDir)) {
  const full = path.join(scenesDir, file);
  const source = readFileSync(full, "utf8");
  const next = source.replace(
    marker,
    (_match, indent: string, clip: string, offset: string | undefined, end: string) => {
      const offsetMs = Math.round(((Number(offset ?? 0)) / 30) * 1000);
      const entries = plan[clip].captions.map((c) => {
        const startMs = c.startMs + offsetMs;
        const endMs = c.endMs + offsetMs;
        const pageBreak = c.pageBreakAfter ? ", pageBreakAfter: true" : "";
        return `${indent}{ text: ${JSON.stringify(c.text)}, startMs: ${startMs}, endMs: ${endMs}, timestampMs: ${Math.round((startMs + endMs) / 2)}, confidence: null${pageBreak} },`;
      });
      const header = `${indent}// @captions ${clip}${offset ? ` ${offset}` : ""}`;
      return `${header}\n${entries.join("\n")}${end}`;
    },
  );
  if (next !== source) {
    writeFileSync(full, next);
    console.log(`Inlined captions in ${file}`);
  }
}
