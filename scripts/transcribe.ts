import { registerMediabunnyServer } from "@mediabunny/server";
import {
  WHISPER_WEBGPU_SAMPLE_RATE,
  canUseWhisperWebGpu,
  downloadWhisperModel,
  loadWhisperModel,
  toCaptions,
  transcribe,
  type WhisperWebGpuModel,
} from "@remotion/whisper-webgpu";
import {
  ALL_FORMATS,
  Conversion,
  FilePathSource,
  Input,
  NullTarget,
  Output,
  WavOutputFormat,
} from "mediabunny";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

registerMediabunnyServer();

const model = (process.argv[2] ?? "medium.en") as WhisperWebGpuModel;
const files = process.argv.slice(3);
const outDir = path.join(process.cwd(), "scripts", "captions");

const support = await canUseWhisperWebGpu();
if (!support.supported) {
  throw new Error(support.detailedReason);
}

type WaveformChunk = {
  startFrame: number;
  waveform: Float32Array;
};

const decodeToWaveform = async (file: string): Promise<Float32Array> => {
  const chunks: WaveformChunk[] = [];

  using input = new Input({
    formats: ALL_FORMATS,
    source: new FilePathSource(file),
  });
  const audioTrack = await input.getPrimaryAudioTrack();
  if (audioTrack === null) {
    throw new Error(`${file} does not contain an audio track.`);
  }

  const conversion = await Conversion.init({
    input,
    output: new Output({
      format: new WavOutputFormat(),
      target: new NullTarget(),
    }),
    video: { discard: true },
    audio: (track) => {
      if (track.id !== audioTrack.id) {
        return { discard: true };
      }

      return {
        codec: "pcm-f32",
        forceTranscode: true,
        numberOfChannels: 1,
        sampleFormat: "f32",
        sampleRate: WHISPER_WEBGPU_SAMPLE_RATE,
        process: (sample) => {
          const waveform = new Float32Array(
            sample.allocationSize({ format: "f32", planeIndex: 0 }) /
              Float32Array.BYTES_PER_ELEMENT,
          );
          sample.copyTo(waveform, { format: "f32", planeIndex: 0 });
          chunks.push({
            startFrame: Math.round(
              sample.timestamp * WHISPER_WEBGPU_SAMPLE_RATE,
            ),
            waveform,
          });
          return sample;
        },
      };
    },
  });

  if (!conversion.isValid) {
    throw new Error(`The audio track of ${file} cannot be decoded.`);
  }

  await conversion.execute();

  const waveformLength = chunks.reduce(
    (max, chunk) => Math.max(max, chunk.startFrame + chunk.waveform.length),
    0,
  );
  const channelWaveform = new Float32Array(waveformLength);
  for (const chunk of chunks) {
    const destinationStart = Math.max(0, chunk.startFrame);
    const sourceStart = Math.max(0, -chunk.startFrame);
    const availableLength = Math.min(
      chunk.waveform.length - sourceStart,
      channelWaveform.length - destinationStart,
    );

    if (availableLength > 0) {
      channelWaveform.set(
        chunk.waveform.subarray(sourceStart, sourceStart + availableLength),
        destinationStart,
      );
    }
  }

  return channelWaveform;
};

await mkdir(outDir, { recursive: true });
console.log(`Downloading model ${model}...`);
await downloadWhisperModel({ model });
await using modelHandle = await loadWhisperModel({ model });
void modelHandle;

for (const file of files) {
  const started = Date.now();
  const channelWaveform = await decodeToWaveform(file);
  const transcription = await transcribe({ channelWaveform, model });
  const { captions } = toCaptions({ whisperWebGpuOutput: transcription });
  const name = path.basename(file, path.extname(file));
  await writeFile(
    path.join(outDir, `${name}.json`),
    JSON.stringify(captions, null, 2),
  );
  console.log(
    `[${name}] ${((Date.now() - started) / 1000).toFixed(1)}s: ${transcription.text.trim()}`,
  );
}
