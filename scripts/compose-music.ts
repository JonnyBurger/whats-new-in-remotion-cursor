// Original music bed for the video, rendered offline to a WAV file.
// 112.5 BPM so that one beat is exactly 16 frames at 30 fps. Every section
// starts on its own downbeat at the frame where the matching scene starts.
import { writeFileSync } from "node:fs";
import path from "node:path";

const SR = 48000;
const BPM = 112.5;
const BEAT = 60 / BPM;
const FRAMES_PER_BEAT = 16;
const TOTAL_BEATS = 458;
const TAIL_SECONDS = 4;
const N = Math.ceil((TOTAL_BEATS * BEAT + TAIL_SECONDS) * SR);

type Bus = { l: Float32Array; r: Float32Array };
const bus = (): Bus => ({ l: new Float32Array(N), r: new Float32Array(N) });
const pads = bus();
const plucks = bus();
const bass = bus();
const drums = bus();
const fx = bus();
const reverbSend = bus();
const delaySend = bus();

let seed = 1234567;
const random = () => {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return seed / 0x7fffffff;
};
const noise = () => random() * 2 - 1;

const mtof = (m: number) => 440 * Math.pow(2, (m - 69) / 12);
const beatToSample = (b: number) => Math.round(b * BEAT * SR);

const polyBlep = (t: number, dt: number) => {
  if (t < dt) {
    const x = t / dt;
    return x + x - x * x - 1;
  }
  if (t > 1 - dt) {
    const x = (t - 1) / dt;
    return x * x + x + x + 1;
  }
  return 0;
};

// Topology-preserving state variable filter (lowpass / bandpass / highpass).
// Coefficients are only recomputed when the cutoff moves noticeably.
class Svf {
  ic1 = 0;
  ic2 = 0;
  k = 1;
  a1 = 0;
  a2 = 0;
  a3 = 0;
  lastCutoff = -1;
  lastQ = -1;
  lp = 0;
  bp = 0;
  hp = 0;
  process(x: number, cutoff: number, q: number) {
    if (
      Math.abs(cutoff - this.lastCutoff) > this.lastCutoff * 0.004 ||
      q !== this.lastQ
    ) {
      const g = Math.tan((Math.PI * Math.min(cutoff, SR * 0.45)) / SR);
      this.k = 1 / q;
      this.a1 = 1 / (1 + g * (g + this.k));
      this.a2 = g * this.a1;
      this.a3 = g * this.a2;
      this.lastCutoff = cutoff;
      this.lastQ = q;
    }
    const v3 = x - this.ic2;
    const v1 = this.a1 * this.ic1 + this.a2 * v3;
    const v2 = this.ic2 + this.a2 * this.ic1 + this.a3 * v3;
    this.ic1 = 2 * v1 - this.ic1;
    this.ic2 = 2 * v2 - this.ic2;
    this.lp = v2;
    this.bp = v1;
    this.hp = x - this.k * v1 - v2;
    return this;
  }
}

const add = (b: Bus, i: number, l: number, r: number) => {
  if (i >= 0 && i < N) {
    b.l[i] += l;
    b.r[i] += r;
  }
};

// ---------------------------------------------------------------- instruments

const pad = (
  startBeat: number,
  beats: number,
  notes: number[],
  opts: { gain: number; cutoff: number; brightness?: number; attack?: number },
) => {
  const attack = opts.attack ?? 0.35;
  const release = 1.4;
  const start = beatToSample(startBeat);
  const hold = beats * BEAT;
  const length = Math.ceil((hold + release) * SR);
  notes.forEach((note, noteIndex) => {
    const increments = [-9, -3, 4, 10].map(
      (cents) => (mtof(note) * Math.pow(2, cents / 1200)) / SR,
    );
    const phases = increments.map(() => random());
    const filterL = new Svf();
    const filterR = new Svf();
    const pan = ((noteIndex / Math.max(1, notes.length - 1)) * 2 - 1) * 0.45;
    for (let n = 0; n < length; n++) {
      const t = n / SR;
      const env =
        t < attack
          ? Math.sin(((t / attack) * Math.PI) / 2)
          : t < hold
            ? 1
            : Math.exp(-(t - hold) / (release / 4));
      let sl = 0;
      let sr = 0;
      for (let v = 0; v < 4; v++) {
        const dt = increments[v];
        phases[v] += dt;
        if (phases[v] >= 1) {
          phases[v] -= 1;
        }
        const saw = 2 * phases[v] - 1 - polyBlep(phases[v], dt);
        if (v % 2 === 0) {
          sl += saw;
        } else {
          sr += saw;
        }
      }
      const lfo = 1 + 0.18 * Math.sin(2 * Math.PI * 0.11 * (t + startBeat * BEAT));
      const cutoff = opts.cutoff * lfo * (0.55 + 0.45 * env);
      const yl = filterL.process(sl, cutoff, 0.8).lp;
      const yr = filterR.process(sr, cutoff, 0.8).lp;
      const g = (opts.gain * env) / notes.length;
      add(pads, start + n, yl * g * (1 - pan), yr * g * (1 + pan));
      if ((n & 1) === 0) {
        add(reverbSend, start + n, yl * g * 0.5, yr * g * 0.5);
      }
    }
  });
};

const pluck = (
  beat: number,
  note: number,
  opts: { gain: number; decay?: number; pan?: number; cutoff?: number },
) => {
  const start = beatToSample(beat);
  const decay = opts.decay ?? 0.32;
  const length = Math.ceil(decay * 5 * SR);
  const freq = mtof(note);
  const filter = new Svf();
  const pan = opts.pan ?? 0;
  let phase = 0;
  let mod = 0;
  for (let n = 0; n < length; n++) {
    const t = n / SR;
    const env = Math.exp(-t / decay) * Math.min(1, t / 0.002);
    mod += (freq * 2) / SR;
    phase += freq / SR;
    const index = 1.6 * Math.exp(-t / 0.06);
    const s = Math.sin(2 * Math.PI * phase + index * Math.sin(2 * Math.PI * mod));
    const y = filter.process(s, opts.cutoff ?? 3200, 0.7).lp * env * opts.gain;
    add(plucks, start + n, y * (1 - pan), y * (1 + pan));
    add(delaySend, start + n, y * 0.5, y * 0.5);
    add(reverbSend, start + n, y * 0.25, y * 0.25);
  }
};

const bassNote = (beat: number, beats: number, note: number, gain: number) => {
  const start = beatToSample(beat);
  const hold = beats * BEAT * 0.92;
  const length = Math.ceil((hold + 0.12) * SR);
  const freq = mtof(note);
  const filter = new Svf();
  let phase = 0;
  for (let n = 0; n < length; n++) {
    const t = n / SR;
    const env = Math.min(1, t / 0.006) * (t < hold ? 1 : Math.exp(-(t - hold) / 0.03));
    phase += freq / SR;
    const s = Math.sin(2 * Math.PI * phase) + 0.25 * Math.sin(4 * Math.PI * phase);
    const saw = 2 * (phase % 1) - 1;
    const y = (s * 0.8 + filter.process(saw, 420, 0.7).lp * 0.35) * env * gain;
    add(bass, start + n, y, y);
  }
};

const kickTimes: number[] = [];
const kick = (beat: number, gain: number) => {
  const start = beatToSample(beat);
  kickTimes.push(start);
  const length = Math.ceil(0.5 * SR);
  let phase = 0;
  for (let n = 0; n < length; n++) {
    const t = n / SR;
    const freq = 46 + 95 * Math.exp(-t / 0.035);
    phase += freq / SR;
    const env = Math.exp(-t / 0.16);
    const click = t < 0.004 ? noise() * (1 - t / 0.004) * 0.35 : 0;
    const y = (Math.tanh(Math.sin(2 * Math.PI * phase) * 1.6) * env + click) * gain;
    add(drums, start + n, y, y);
  }
};

const hat = (beat: number, gain: number, open = false, pan = 0.25) => {
  const start = beatToSample(beat);
  const decay = open ? 0.14 : 0.035;
  const length = Math.ceil(decay * 6 * SR);
  const filter = new Svf();
  for (let n = 0; n < length; n++) {
    const t = n / SR;
    const y = filter.process(noise(), 8200, 0.9).hp * Math.exp(-t / decay) * gain;
    add(drums, start + n, y * (1 - pan), y * (1 + pan));
  }
};

const shaker = (beat: number, gain: number) => {
  const start = beatToSample(beat);
  const length = Math.ceil(0.12 * SR);
  const filter = new Svf();
  for (let n = 0; n < length; n++) {
    const t = n / SR;
    const env = Math.min(1, t / 0.012) * Math.exp(-t / 0.035);
    const y = filter.process(noise(), 6500, 1.4).bp * env * gain;
    add(drums, start + n, y * 0.7, y * 1.3);
  }
};

const clap = (beat: number, gain: number) => {
  const start = beatToSample(beat);
  const length = Math.ceil(0.4 * SR);
  const filter = new Svf();
  for (let n = 0; n < length; n++) {
    const t = n / SR;
    const bursts = [0, 0.011, 0.022].reduce(
      (acc, o) => acc + (t >= o ? Math.exp(-(t - o) / (o === 0.022 ? 0.12 : 0.008)) : 0),
      0,
    );
    const y = filter.process(noise(), 1500, 1.1).bp * bursts * gain;
    add(drums, start + n, y, y);
    add(reverbSend, start + n, y * 0.6, y * 0.6);
  }
};

// Reverse cymbal swell that lands on `beat`.
const swell = (beat: number, beats: number, gain: number) => {
  const end = beatToSample(beat);
  const length = Math.ceil(beats * BEAT * SR);
  const filter = new Svf();
  for (let n = 0; n < length; n++) {
    const p = n / length;
    const y = filter.process(noise(), 1800 + 7000 * p, 0.8).hp * Math.pow(p, 2.2) * gain;
    add(fx, end - length + n, y * 0.9, y * 1.1);
    add(reverbSend, end - length + n, y * 0.3, y * 0.3);
  }
};

const crash = (beat: number, gain: number) => {
  const start = beatToSample(beat);
  const length = Math.ceil(2.4 * SR);
  const filter = new Svf();
  for (let n = 0; n < length; n++) {
    const t = n / SR;
    const y = filter.process(noise(), 5200, 0.7).hp * Math.exp(-t / 0.55) * gain;
    add(fx, start + n, y * 1.1, y * 0.9);
    add(reverbSend, start + n, y * 0.4, y * 0.4);
  }
};

const riser = (beat: number, beats: number, gain: number) => {
  const start = beatToSample(beat);
  const length = Math.ceil(beats * BEAT * SR);
  const filter = new Svf();
  let phase = 0;
  for (let n = 0; n < length; n++) {
    const p = n / length;
    const freq = 180 * Math.pow(2, p * 2.5);
    phase += freq / SR;
    const tone = (2 * (phase % 1) - 1) * 0.25;
    const y = filter.process(noise() * 0.8 + tone, 300 + 5500 * p * p, 2.2).bp * p * p * gain;
    add(fx, start + n, y, y);
    add(reverbSend, start + n, y * 0.4, y * 0.4);
  }
};

const impact = (beat: number, gain: number) => {
  const start = beatToSample(beat);
  const length = Math.ceil(2.2 * SR);
  let phase = 0;
  const filter = new Svf();
  for (let n = 0; n < length; n++) {
    const t = n / SR;
    const freq = 38 + 70 * Math.exp(-t / 0.08);
    phase += freq / SR;
    const boom = Math.sin(2 * Math.PI * phase) * Math.exp(-t / 0.6);
    const hiss = filter.process(noise(), 2500, 0.7).hp * Math.exp(-t / 0.25) * 0.4;
    const y = (boom + hiss) * gain;
    add(fx, start + n, y, y);
    add(reverbSend, start + n, y * 0.35, y * 0.35);
  }
};

// ---------------------------------------------------------------- harmony

type Chord = { bass: number; pad: number[]; arp: number[] };
const D: Chord = { bass: 38, pad: [54, 57, 61, 64], arp: [69, 74, 76, 78, 81] };
const A: Chord = { bass: 33, pad: [52, 57, 61, 66], arp: [69, 73, 76, 78, 81] };
const Bm: Chord = { bass: 35, pad: [54, 57, 62, 64], arp: [66, 71, 74, 76, 78] };
const G: Chord = { bass: 31, pad: [54, 57, 59, 62], arp: [67, 71, 74, 78, 79] };
const Em: Chord = { bass: 40, pad: [52, 55, 59, 62], arp: [64, 67, 71, 74, 76] };
const Fs: Chord = { bass: 42, pad: [54, 59, 61, 64], arp: [66, 71, 73, 76, 78] };

const progA = [D, A, Bm, G];
const progB = [Bm, G, D, A];
const progDark = [Bm, G, Em, Fs];

type Groove = {
  prog: Chord[];
  padCutoff: number;
  padGain: number;
  pluckGain: number;
  arp: "up" | "wave" | "sixteenths" | "none";
  kick: number;
  shaker: number;
  hats: number;
  clap: number;
  bass: number;
};

const arpPatterns = {
  up: [0, 1, 2, 3, 4, 3, 2, 1],
  wave: [0, 2, 1, 3, 2, 4, 3, 1],
};

const section = (startBeat: number, beats: number, groove: Groove) => {
  for (let b = 0; b < beats; b += 4) {
    const chord = groove.prog[(b / 4) % groove.prog.length];
    const len = Math.min(4, beats - b);
    pad(startBeat + b, len, chord.pad, {
      gain: groove.padGain,
      cutoff: groove.padCutoff,
    });
    for (let k = 0; k < len; k++) {
      const beat = startBeat + b + k;
      if (groove.bass > 0) {
        bassNote(beat, 1, chord.bass, groove.bass * (k === 0 ? 1 : 0.85));
      }
      if (groove.kick > 0) {
        kick(beat, groove.kick);
      }
      if (groove.clap > 0 && k % 2 === 1) {
        clap(beat, groove.clap);
      }
      if (groove.hats > 0) {
        hat(beat + 0.5, groove.hats, (b / 4 + k) % 4 === 3);
      }
      if (groove.shaker > 0) {
        for (let s = 0; s < 4; s++) {
          shaker(beat + s * 0.25, groove.shaker * (s % 2 === 0 ? 0.6 : 1));
        }
      }
    }
    if (groove.arp !== "none") {
      const steps = groove.arp === "sixteenths" ? 16 : 8;
      const pattern = groove.arp === "sixteenths" ? arpPatterns.wave : arpPatterns[groove.arp];
      for (let s = 0; s < steps * (len / 4); s++) {
        const note = chord.arp[pattern[s % pattern.length]];
        pluck(startBeat + b + (s * 4) / steps, note, {
          gain: groove.pluckGain * (s % 4 === 0 ? 1 : 0.7),
          pan: s % 2 === 0 ? -0.35 : 0.35,
          decay: groove.arp === "sixteenths" ? 0.16 : 0.3,
        });
      }
    }
  }
};

const underVoice: Groove = {
  prog: progA,
  padCutoff: 1400,
  padGain: 0.55,
  pluckGain: 0.22,
  arp: "up",
  kick: 0.5,
  shaker: 0.1,
  hats: 0.06,
  clap: 0,
  bass: 0.4,
};

// Scene starts in beats (frame / 16):
// Intro 0, Light leaks 13, Sound effects 58, Vercel 130, Skills 195,
// Client-side 233, Agents 285, Bundling 346, Sneak peek 391, Outro 448.

// Intro: pad swell and a riser into the topic montage at beat 7.
pad(0, 7, D.pad, { gain: 0.5, cutoff: 900, attack: 1.6 });
bassNote(0, 7, D.bass, 0.18);
for (let s = 0; s < 14; s++) {
  pluck(2 + s * 0.5, D.arp[arpPatterns.up[s % 8]], {
    gain: 0.12 + s * 0.01,
    pan: s % 2 === 0 ? -0.3 : 0.3,
    cutoff: 1800 + s * 150,
  });
}
riser(3, 4, 0.5);
impact(7, 0.75);
crash(7, 0.35);

// Topic montage: full groove.
section(7, 6, {
  prog: [D, A, Bm],
  padCutoff: 3200,
  padGain: 0.7,
  pluckGain: 0.32,
  arp: "sixteenths",
  kick: 0.95,
  shaker: 0.18,
  hats: 0.16,
  clap: 0.35,
  bass: 0.7,
});

const chapters: [number, number, Partial<Groove>][] = [
  [13, 45, { prog: progA }],
  [58, 72, { prog: progB, arp: "wave" }],
  [130, 65, { prog: progA, shaker: 0.14 }],
  [195, 38, { prog: progB }],
  [233, 52, { prog: progA, arp: "wave" }],
  [285, 61, { prog: progB, hats: 0.08 }],
  [346, 45, { prog: progA, arp: "sixteenths", hats: 0.1, shaker: 0.14, kick: 0.58 }],
];
for (const [start, beats, overrides] of chapters) {
  swell(start, 2, 0.22);
  crash(start, 0.16);
  section(start, beats, { ...underVoice, ...overrides });
}

// Sneak peek: breakdown, then a lift into the visual mode reveal.
swell(391, 2, 0.25);
impact(391, 0.45);
section(391, 32, {
  prog: progDark,
  padCutoff: 700,
  padGain: 0.75,
  pluckGain: 0,
  arp: "none",
  kick: 0,
  shaker: 0,
  hats: 0,
  clap: 0,
  bass: 0.32,
});
for (let s = 0; s < 32; s += 2) {
  const chord = progDark[Math.floor(s / 4) % 4];
  pluck(391 + s + 1, chord.arp[4] + 12, { gain: 0.08, decay: 0.9, pan: s % 4 === 0 ? -0.4 : 0.4, cutoff: 5000 });
}
riser(419, 4, 0.35);
swell(423, 1, 0.2);
section(423, 25, {
  ...underVoice,
  prog: progA,
  padCutoff: 1800,
  arp: "wave",
  pluckGain: 0.24,
  kick: 0.45,
  shaker: 0.08,
});

// Outro: final chord with a soft hit, left to ring out.
swell(448, 2, 0.25);
impact(448, 0.55);
crash(448, 0.3);
pad(448, 8, [50, 54, 57, 61, 64], { gain: 0.8, cutoff: 2400 });
bassNote(448, 6, D.bass, 0.5);
for (let s = 0; s < 8; s++) {
  pluck(448 + s * 0.5, D.arp[arpPatterns.up[s]], {
    gain: 0.22 * (1 - s / 10),
    pan: s % 2 === 0 ? -0.3 : 0.3,
    decay: 0.5,
  });
}

// ---------------------------------------------------------------- mix

// Sidechain ducking from the kick on pads and bass.
const duck = new Float32Array(N).fill(1);
for (const k of kickTimes) {
  const length = Math.ceil(0.25 * SR);
  for (let n = 0; n < length && k + n < N; n++) {
    const g = 1 - 0.45 * Math.exp(-n / SR / 0.09);
    duck[k + n] = Math.min(duck[k + n], g);
  }
}

// Ping-pong delay (dotted eighth) with damped feedback.
const delayTime = Math.round(BEAT * 0.75 * SR);
const delayed = bus();
{
  const lineL = new Float32Array(N);
  const lineR = new Float32Array(N);
  let lpL = 0;
  let lpR = 0;
  for (let i = 0; i < N; i++) {
    const readL = i >= delayTime ? lineL[i - delayTime] : 0;
    const readR = i >= delayTime ? lineR[i - delayTime] : 0;
    lpL += 0.35 * (readR - lpL);
    lpR += 0.35 * (readL - lpR);
    lineL[i] = (delaySend.l[i] + delaySend.r[i]) * 0.5 + lpL * 0.4;
    lineR[i] = lpR * 0.4;
    delayed.l[i] = readL;
    delayed.r[i] = readR;
  }
}

// Freeverb.
const scale = SR / 44100;
const combTunings = [1116, 1188, 1277, 1356, 1422, 1491, 1557, 1617];
const allpassTunings = [556, 441, 341, 225];
const reverb = (input: Float32Array, spread: number) => {
  const out = new Float32Array(N);
  const combs = combTunings.map((t) => ({
    buffer: new Float32Array(Math.round((t + spread) * scale)),
    index: 0,
    store: 0,
  }));
  const allpasses = allpassTunings.map((t) => ({
    buffer: new Float32Array(Math.round((t + spread) * scale)),
    index: 0,
  }));
  const feedback = 0.86;
  const damp = 0.32;
  for (let i = 0; i < N; i++) {
    const x = input[i] * 0.015;
    let y = 0;
    for (const c of combs) {
      const o = c.buffer[c.index];
      c.store = o * (1 - damp) + c.store * damp;
      c.buffer[c.index] = x + c.store * feedback;
      c.index = (c.index + 1) % c.buffer.length;
      y += o;
    }
    for (const a of allpasses) {
      const b = a.buffer[a.index];
      a.buffer[a.index] = y + b * 0.5;
      a.index = (a.index + 1) % a.buffer.length;
      y = b - y;
    }
    out[i] = y;
  }
  return out;
};
const verbL = reverb(reverbSend.l, 0);
const verbR = reverb(reverbSend.r, 23);

const master = bus();
let peak = 0;
for (let i = 0; i < N; i++) {
  const d = duck[i];
  let l =
    pads.l[i] * 0.55 * d +
    plucks.l[i] * 0.5 +
    bass.l[i] * 0.55 * d +
    drums.l[i] * 0.6 +
    fx.l[i] * 0.5 +
    delayed.l[i] * 0.25 +
    verbL[i] * 0.9;
  let r =
    pads.r[i] * 0.55 * d +
    plucks.r[i] * 0.5 +
    bass.r[i] * 0.55 * d +
    drums.r[i] * 0.6 +
    fx.r[i] * 0.5 +
    delayed.r[i] * 0.25 +
    verbR[i] * 0.9;
  l = Math.tanh(l * 1.1);
  r = Math.tanh(r * 1.1);
  master.l[i] = l;
  master.r[i] = r;
  peak = Math.max(peak, Math.abs(l), Math.abs(r));
}

// Fade out the tail and normalize to -1 dBFS.
const fadeStart = beatToSample(TOTAL_BEATS) + Math.round(1.5 * SR);
const gain = Math.pow(10, -1 / 20) / peak;
const pcm = Buffer.alloc(N * 4);
for (let i = 0; i < N; i++) {
  const fade = i > fadeStart ? Math.max(0, 1 - (i - fadeStart) / (SR * 2.5)) : 1;
  const l = Math.max(-1, Math.min(1, master.l[i] * gain * fade));
  const r = Math.max(-1, Math.min(1, master.r[i] * gain * fade));
  pcm.writeInt16LE(Math.round(l * 32767), i * 4);
  pcm.writeInt16LE(Math.round(r * 32767), i * 4 + 2);
}

const header = Buffer.alloc(44);
header.write("RIFF", 0);
header.writeUInt32LE(36 + pcm.length, 4);
header.write("WAVE", 8);
header.write("fmt ", 12);
header.writeUInt32LE(16, 16);
header.writeUInt16LE(1, 20);
header.writeUInt16LE(2, 22);
header.writeUInt32LE(SR, 24);
header.writeUInt32LE(SR * 4, 28);
header.writeUInt16LE(4, 32);
header.writeUInt16LE(16, 34);
header.write("data", 36);
header.writeUInt32LE(pcm.length, 40);

const out = path.join(process.cwd(), "public", "music", "score.wav");
writeFileSync(out, Buffer.concat([header, pcm]));
console.log(
  `Wrote ${out}: ${(N / SR).toFixed(1)}s, ${TOTAL_BEATS} beats, ${TOTAL_BEATS * FRAMES_PER_BEAT} frames`,
);
