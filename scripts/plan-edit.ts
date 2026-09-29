// Builds the edit decision list: tightens pauses using silence detection and
// remaps the word-level captions onto the edited timeline.
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

type Caption = {
  text: string;
  startMs: number;
  endMs: number;
  timestampMs: number | null;
  confidence: number | null;
  pageBreakAfter?: boolean;
};

const FPS = 30;
const LEAD_IN = 0.15;
const TAIL = 0.45;
// A pause is cut when it is longer than the threshold for its boundary type.
const MIN_PAUSE_AFTER_SENTENCE = 0.35;
const MIN_PAUSE_AFTER_CLAUSE = 0.42;
const MIN_PAUSE_MID_SENTENCE = 0.5;
const KEEP_AFTER_SPEECH = 0.1;
const KEEP_BEFORE_SPEECH = 0.08;
const KEEP_AFTER_SENTENCE = 0.16;

// Scene lengths are snapped to the 112.5 BPM music grid (16 frames per beat)
// by adjusting the tail of each clip's last segment.
const targetFrames: Record<string, number> = {
  whats1: 112,
  whats2: 720,
  whats3: 1152,
  whats4: 1040,
  whats5: 608,
  whats6: 832,
  whats7: 976,
  whats8: 720,
  whats9: 484,
  whats10: 428,
};

const root = process.cwd();
const silenceDir = "/tmp/edit-work/silence";

const fixes: Record<string, [RegExp, string][]> = {
  whats4: [
    [/ Remotion Vercel/, " @remotion/vercel"],
    [/ sandbox/, " Sandbox"],
  ],
  whats5: [[/ 11 labs,/, " ElevenLabs,"]],
  whats7: [
    [/ remotion/g, " Remotion"],
    [/ studio/, " Studio"],
    [/ cloth code/, " Claude Code"],
    [/ log file/, " lockfile"],
    [/ SOD 4\./, " Zod 4."],
  ],
  whats8: [[/ RSPack/, " Rspack"]],
};

// Re-tokenizes after a text fix, merging tokens whose words were joined.
const applyFixes = (clip: string, captions: Caption[]): Caption[] => {
  let result = captions.map((c) => ({ ...c }));
  const queue = [...(fixes[clip] ?? [])];
  let matchedOnce = false;
  while (queue.length > 0) {
    const [pattern, replacement] = queue[0];
    const joined = result.map((c) => c.text).join("");
    pattern.lastIndex = 0;
    const match = pattern.exec(joined);
    if (!match) {
      if (!matchedOnce) {
        throw new Error(`${clip}: fix ${pattern} did not match`);
      }
      queue.shift();
      matchedOnce = false;
      continue;
    }
    matchedOnce = true;
    if (!pattern.global) {
      queue.shift();
      matchedOnce = false;
    }
    const start = match.index;
    const end = start + match[0].length;
    let pos = 0;
    const firstIdx = result.findIndex((c) => {
      const inside = pos + c.text.length > start;
      pos += c.text.length;
      return inside;
    });
    pos = 0;
    let lastIdx = -1;
    result.forEach((c, i) => {
      if (pos < end) {
        lastIdx = i;
      }
      pos += c.text.length;
    });
    const merged: Caption = {
      text: result
        .slice(firstIdx, lastIdx + 1)
        .map((c) => c.text)
        .join("")
        .replace(match[0].trimStart(), replacement.trimStart()),
      startMs: result[firstIdx].startMs,
      endMs: result[lastIdx].endMs,
      timestampMs: Math.round(
        (result[firstIdx].startMs + result[lastIdx].endMs) / 2,
      ),
      confidence: null,
    };
    result = [
      ...result.slice(0, firstIdx),
      merged,
      ...result.slice(lastIdx + 1),
    ];
  }
  return result;
};

const clips = Array.from({ length: 10 }, (_, i) => `whats${i + 1}`);
const plan: Record<string, unknown> = {};

for (const clip of clips) {
  const numbers = readFileSync(path.join(silenceDir, `${clip}.txt`), "utf8")
    .trim()
    .split(/\s+/)
    .map(Number);
  const silences: [number, number][] = [];
  for (let i = 0; i < numbers.length; i += 2) {
    silences.push([numbers[i], numbers[i + 1]]);
  }
  // Merge silences separated by tiny blips.
  const merged: [number, number][] = [];
  for (const s of silences) {
    const last = merged[merged.length - 1];
    if (last && s[0] - last[1] < 0.12) {
      last[1] = s[1];
    } else {
      merged.push([...s]);
    }
  }

  // Whisper splits hyphenated words ("first", "-class"); glue them back
  // together so captions don't render a gap before the hyphen.
  const whisperCaptions = applyFixes(
    clip,
    JSON.parse(
      readFileSync(path.join(root, "scripts", "captions", `${clip}.json`), "utf8"),
    ),
  ).reduce<Caption[]>((acc, c, i) => {
    const prev = acc[acc.length - 1];
    if (i > 0 && prev && !c.text.startsWith(" ")) {
      acc[acc.length - 1] = {
        ...prev,
        text: prev.text + c.text,
        endMs: c.endMs,
        timestampMs: Math.round((prev.startMs + c.endMs) / 2),
      };
    } else {
      acc.push({ ...c });
    }
    return acc;
  }, []);

  const leading = merged[0];
  const trailing = merged[merged.length - 1];
  const speechStart = leading[0] === 0 ? leading[1] : 0;
  const speechEnd = trailing[1] >= numbers[numbers.length - 1] - 0.01 ? trailing[0] : Infinity;
  const inner = merged.filter((s) => s !== leading && s !== trailing);

  // Whisper's word timings drift near pauses. Speech islands between detected
  // silences are exact, so each island's words are rescaled to fit it.
  // Words are assigned by their start because Whisper stretches the end of a
  // word that precedes a pause across the silence.
  const islands: [number, number][] = [];
  let islandStart = speechStart;
  for (const [s, e] of inner) {
    islands.push([islandStart, s]);
    islandStart = e;
  }
  islands.push([islandStart, speechEnd]);
  const wordsByIsland = islands.map(() => [] as number[]);
  whisperCaptions.forEach((c, i) => {
    const mid = c.startMs / 1000;
    let best = 0;
    let bestDistance = Infinity;
    islands.forEach(([a, b], k) => {
      const distance = mid < a ? a - mid : mid > b ? mid - b : 0;
      if (distance < bestDistance) {
        bestDistance = distance;
        best = k;
      }
    });
    wordsByIsland[best].push(i);
  });
  const captions: Caption[] = whisperCaptions.map((c) => ({ ...c }));
  wordsByIsland.forEach((indices, k) => {
    if (indices.length === 0) {
      return;
    }
    const [a, b] = islands[k];
    const first = whisperCaptions[indices[0]].startMs / 1000;
    const last = whisperCaptions[indices[indices.length - 1]].endMs / 1000;
    const span = Math.max(0.05, last - first);
    for (const i of indices) {
      const w = whisperCaptions[i];
      const map = (t: number) => a + ((t - first) / span) * (b - a);
      captions[i].startMs = Math.round(map(w.startMs / 1000) * 1000);
      captions[i].endMs = Math.round(map(w.endMs / 1000) * 1000);
    }
  });

  const boundaryBefore = (t: number): "sentence" | "clause" | "none" => {
    const before = captions.filter((c) => c.startMs / 1000 < t);
    const word = before[before.length - 1]?.text.trim() ?? "";
    if (/[.?!]$/.test(word)) {
      return "sentence";
    }
    return /[,;:]$/.test(word) ? "clause" : "none";
  };

  const keep: [number, number][] = [];
  let cursor = Math.max(0, speechStart - LEAD_IN);
  for (const [s, e] of inner) {
    const boundary = boundaryBefore((s + e) / 2);
    const threshold =
      boundary === "sentence"
        ? MIN_PAUSE_AFTER_SENTENCE
        : boundary === "clause"
          ? MIN_PAUSE_AFTER_CLAUSE
          : MIN_PAUSE_MID_SENTENCE;
    if (e - s < threshold) {
      continue;
    }
    const after = boundary === "sentence" ? KEEP_AFTER_SENTENCE : KEEP_AFTER_SPEECH;
    keep.push([cursor, s + after]);
    cursor = e - KEEP_BEFORE_SPEECH;
  }
  keep.push([cursor, speechEnd + TAIL]);

  let outFrame = 0;
  const segments = keep.map(([a, b]) => {
    const trimBefore = Math.round(a * FPS);
    const durationInFrames = Math.round(b * FPS) - trimBefore;
    const seg = { trimBefore, durationInFrames, outStart: outFrame };
    outFrame += durationInFrames;
    return seg;
  });
  const delta = targetFrames[clip] - outFrame;
  if (Math.abs(delta) > 8) {
    throw new Error(`${clip}: tail adjustment of ${delta} frames is too large`);
  }
  segments[segments.length - 1].durationInFrames += delta;
  outFrame += delta;

  const remap = (ms: number) => {
    const f = (ms / 1000) * FPS;
    let seg = segments.find(
      (s) => f >= s.trimBefore && f < s.trimBefore + s.durationInFrames,
    );
    if (!seg) {
      seg =
        [...segments].reverse().find((s) => s.trimBefore <= f) ?? segments[0];
      const clamped = Math.min(
        Math.max(f, seg.trimBefore),
        seg.trimBefore + seg.durationInFrames - 1,
      );
      return Math.round(((seg.outStart + clamped - seg.trimBefore) / FPS) * 1000);
    }
    return Math.round(((seg.outStart + f - seg.trimBefore) / FPS) * 1000);
  };

  const remapped: Caption[] = captions.map((c, i) => {
    const startMs = remap(c.startMs);
    const next = captions[i + 1];
    let endMs = remap(c.endMs);
    if (next) {
      endMs = Math.min(endMs, remap(next.startMs));
    } else {
      endMs = Math.min(endMs, Math.round((outFrame / FPS) * 1000));
    }
    endMs = Math.max(endMs, startMs + 60);
    const text = i === 0 ? c.text.trimStart() : c.text;
    return {
      text,
      startMs,
      endMs,
      timestampMs: Math.round((startMs + endMs) / 2),
      confidence: null,
      ...(/[.?!,]$/.test(text.trim()) ? { pageBreakAfter: true } : {}),
    };
  });

  plan[clip] = {
    sourceSpeech: [speechStart, speechEnd],
    durationInFrames: outFrame,
    segments: segments.map((s) => ({
      trimBefore: s.trimBefore,
      durationInFrames: s.durationInFrames,
      outStart: s.outStart,
      text: remapped
        .filter(
          (c) =>
            c.startMs >= (s.outStart / FPS) * 1000 &&
            c.startMs < ((s.outStart + s.durationInFrames) / FPS) * 1000,
        )
        .map((c) => c.text)
        .join("")
        .trim(),
    })),
    captions: remapped,
  };
}

writeFileSync(
  path.join(root, "scripts", "edit-plan.json"),
  JSON.stringify(plan, null, 2),
);

let total = 0;
for (const clip of clips) {
  const p = plan[clip] as {
    durationInFrames: number;
    segments: { trimBefore: number; durationInFrames: number; outStart: number; text: string }[];
  };
  total += p.durationInFrames;
  console.log(`\n${clip}: ${p.durationInFrames}f (${(p.durationInFrames / FPS).toFixed(2)}s)`);
  for (const s of p.segments) {
    console.log(
      `  out ${String(s.outStart).padStart(4)} | trimBefore ${String(s.trimBefore).padStart(4)} dur ${String(s.durationInFrames).padStart(4)} | ${s.text}`,
    );
  }
}
console.log(`\nTOTAL A-roll: ${total}f = ${(total / FPS).toFixed(2)}s`);
