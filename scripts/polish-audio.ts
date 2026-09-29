// Voice polish: rumble cut, light denoise, presence EQ, gentle compression and
// two-pass EBU R128 normalization. The video stream is copied untouched.
import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import path from "node:path";

const ffmpeg = "/usr/local/bin/ffmpeg";
const inputDir =
  process.env.SOURCE_DIR ?? "/Users/jonathanburger/Downloads/public";
const outputDir = path.join(process.cwd(), "public", "footage");
mkdirSync(outputDir, { recursive: true });

const target = "I=-16:TP=-1.5:LRA=11";
const chain = [
  "highpass=f=80",
  "afftdn=nr=6:nf=-62",
  "equalizer=f=250:t=q:w=1.2:g=-1.5",
  "equalizer=f=3800:t=q:w=1.0:g=2",
  "acompressor=threshold=0.0316:ratio=3:attack=5:release=120:makeup=2",
  "deesser=i=0.3",
].join(",");

const clips = process.argv.slice(2);

for (const clip of clips) {
  const input = path.join(inputDir, `${clip}.mov`);
  const measure = spawnSync(
    ffmpeg,
    [
      "-hide_banner",
      "-nostats",
      "-i",
      input,
      "-map",
      "0:a:0",
      "-af",
      `${chain},loudnorm=${target}:print_format=json`,
      "-f",
      "null",
      "-",
    ],
    { encoding: "utf8" },
  );
  const json = measure.stderr.slice(measure.stderr.lastIndexOf("{"));
  const stats = JSON.parse(json.slice(0, json.indexOf("}") + 1)) as Record<
    string,
    string
  >;

  const normalize = `loudnorm=${target}:measured_I=${stats.input_i}:measured_TP=${stats.input_tp}:measured_LRA=${stats.input_lra}:measured_thresh=${stats.input_thresh}:offset=${stats.target_offset}:linear=true:print_format=json`;
  const output = path.join(outputDir, `${clip}.mp4`);
  const render = spawnSync(
    ffmpeg,
    [
      "-hide_banner",
      "-nostats",
      "-y",
      "-i",
      input,
      "-map",
      "0:v:0",
      "-map",
      "0:a:0",
      "-c:v",
      "copy",
      "-af",
      `${chain},${normalize}`,
      "-ar",
      "48000",
      "-c:a",
      "aac",
      "-b:a",
      "256k",
      "-movflags",
      "+faststart",
      output,
    ],
    { encoding: "utf8" },
  );
  if (render.status !== 0) {
    throw new Error(render.stderr);
  }
  const out = render.stderr.slice(render.stderr.lastIndexOf("{"));
  const result = JSON.parse(out.slice(0, out.indexOf("}") + 1)) as Record<
    string,
    string
  >;
  console.log(
    `${clip}: ${stats.input_i} LUFS -> ${result.output_i} LUFS, TP ${result.output_tp} dBTP, mode ${result.normalization_type}`,
  );
}
