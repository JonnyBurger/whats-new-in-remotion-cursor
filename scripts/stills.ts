// Renders review stills from an existing bundle with a single browser.
// Usage: node scripts/stills.ts <compositionId>:<frame>,<frame> ...
import {
  openBrowser,
  renderStill,
  selectComposition,
} from "@remotion/renderer";
import { mkdirSync } from "node:fs";
import path from "node:path";

const serveUrl = path.join(process.cwd(), "build");
const outDir = path.join(process.cwd(), "out", "stills");
mkdirSync(outDir, { recursive: true });

const browser = await openBrowser("chrome", {
  chromiumOptions: { gl: "angle" },
});

for (const arg of process.argv.slice(2)) {
  const [id, frameList] = arg.split(":");
  const composition = await selectComposition({
    serveUrl,
    id,
    puppeteerInstance: browser,
    chromiumOptions: { gl: "angle" },
  });
  for (const frame of frameList.split(",").map(Number)) {
    const output = path.join(outDir, `${id}-${frame}.jpg`);
    await renderStill({
      composition,
      serveUrl,
      frame,
      output,
      imageFormat: "jpeg",
      jpegQuality: 82,
      scale: 0.5,
      puppeteerInstance: browser,
      chromiumOptions: { gl: "angle" },
      logLevel: "error",
    });
    console.log(output);
  }
}

await browser.close({ silent: true });
