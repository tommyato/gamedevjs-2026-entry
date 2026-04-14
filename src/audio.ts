/**
 * Procedural audio skeleton — Web Audio API, zero external files.
 * Extend with game-specific sounds once theme is known.
 */

let ctx: AudioContext | null = null;
let masterGain: GainNode | null = null;
let initialized = false;
const DEFAULT_MASTER_VOLUME = 0.5;
let audioEnabled = true;

function applyMasterVolume() {
  if (!masterGain) {
    return;
  }

  masterGain.gain.value = audioEnabled ? DEFAULT_MASTER_VOLUME : 0;
}

function ensureContext(): AudioContext {
  if (!ctx) {
    ctx = new AudioContext();
    masterGain = ctx.createGain();
    applyMasterVolume();
    masterGain.connect(ctx.destination);
  }
  if (ctx.state === "suspended") {
    ctx.resume();
  }
  return ctx;
}

/** Call on first user interaction to unlock audio */
export function initAudio() {
  if (initialized) {
    return;
  }
  ensureContext();
  initialized = true;
}

/** Generic tone — use as building block for game sounds */
export function playTone(
  freq: number,
  duration: number = 0.2,
  type: OscillatorType = "sine",
  volume: number = 0.1
) {
  if (!ctx || !masterGain) {
    return;
  }
  const t = ctx.currentTime;

  const osc = ctx.createOscillator();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t);

  const gain = ctx.createGain();
  gain.gain.setValueAtTime(volume, t);
  gain.gain.exponentialRampToValueAtTime(0.001, t + duration);

  osc.connect(gain);
  gain.connect(masterGain);
  osc.start(t);
  osc.stop(t + duration + 0.01);
}

/** UI click sound */
export function playClick() {
  playTone(800, 0.05, "square", 0.05);
}

export function playJump() {
  if (!ctx || !masterGain) {
    return;
  }

  const t = ctx.currentTime;
  const osc = ctx.createOscillator();
  osc.type = "triangle";
  osc.frequency.setValueAtTime(260, t);
  osc.frequency.exponentialRampToValueAtTime(520, t + 0.12);

  const gain = ctx.createGain();
  gain.gain.setValueAtTime(0.08, t);
  gain.gain.exponentialRampToValueAtTime(0.001, t + 0.14);

  osc.connect(gain);
  gain.connect(masterGain);
  osc.start(t);
  osc.stop(t + 0.15);
}

/** Positive/collect sound */
export function playCollect(pitch: number = 1) {
  if (!ctx || !masterGain) {
    return;
  }
  const t = ctx.currentTime;
  const baseFreq = 600 * pitch;

  const osc = ctx.createOscillator();
  osc.type = "sine";
  osc.frequency.setValueAtTime(baseFreq, t);
  osc.frequency.exponentialRampToValueAtTime(baseFreq * 1.5, t + 0.1);

  const gain = ctx.createGain();
  gain.gain.setValueAtTime(0.12, t);
  gain.gain.exponentialRampToValueAtTime(0.001, t + 0.15);

  osc.connect(gain);
  gain.connect(masterGain);
  osc.start(t);
  osc.stop(t + 0.16);
}

export function playLand(strength: number = 1) {
  if (!ctx || !masterGain) {
    return;
  }

  const normalizedStrength = Math.max(0.35, Math.min(1.4, strength));
  const t = ctx.currentTime;
  const duration = 0.08 + normalizedStrength * 0.08;

  const osc = ctx.createOscillator();
  osc.type = "sine";
  osc.frequency.setValueAtTime(180 + normalizedStrength * 40, t);
  osc.frequency.exponentialRampToValueAtTime(65, t + duration);

  const oscGain = ctx.createGain();
  oscGain.gain.setValueAtTime(0.03 + normalizedStrength * 0.05, t);
  oscGain.gain.exponentialRampToValueAtTime(0.001, t + duration);
  osc.connect(oscGain);
  oscGain.connect(masterGain);
  osc.start(t);
  osc.stop(t + duration + 0.02);

  const click = ctx.createOscillator();
  click.type = "square";
  click.frequency.setValueAtTime(800 - normalizedStrength * 180, t);
  click.frequency.exponentialRampToValueAtTime(220, t + 0.04);

  const clickGain = ctx.createGain();
  clickGain.gain.setValueAtTime(0.015 + normalizedStrength * 0.025, t);
  clickGain.gain.exponentialRampToValueAtTime(0.001, t + 0.05);
  click.connect(clickGain);
  clickGain.connect(masterGain);
  click.start(t);
  click.stop(t + 0.06);
}

export function playMilestone(pitch: number = 1) {
  if (!ctx || !masterGain) {
    return;
  }

  const t = ctx.currentTime;
  const first = ctx.createOscillator();
  first.type = "triangle";
  first.frequency.setValueAtTime(540 * pitch, t);
  first.frequency.exponentialRampToValueAtTime(760 * pitch, t + 0.12);

  const second = ctx.createOscillator();
  second.type = "sine";
  second.frequency.setValueAtTime(760 * pitch, t + 0.08);
  second.frequency.exponentialRampToValueAtTime(980 * pitch, t + 0.22);

  const gain = ctx.createGain();
  gain.gain.setValueAtTime(0.001, t);
  gain.gain.exponentialRampToValueAtTime(0.08, t + 0.03);
  gain.gain.exponentialRampToValueAtTime(0.001, t + 0.28);

  first.connect(gain);
  second.connect(gain);
  gain.connect(masterGain);
  first.start(t);
  first.stop(t + 0.18);
  second.start(t + 0.08);
  second.stop(t + 0.29);
}

/** Negative/hit sound */
export function playHit() {
  if (!ctx || !masterGain) {
    return;
  }
  const t = ctx.currentTime;

  // Noise burst
  const dur = 0.15;
  const buffer = ctx.createBuffer(1, ctx.sampleRate * dur, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < data.length; i++) {
    data[i] = (Math.random() * 2 - 1) * (1 - i / data.length);
  }
  const src = ctx.createBufferSource();
  src.buffer = buffer;

  const gain = ctx.createGain();
  gain.gain.setValueAtTime(0.15, t);
  gain.gain.exponentialRampToValueAtTime(0.001, t + dur);

  src.connect(gain);
  gain.connect(masterGain);
  src.start(t);
  src.stop(t + dur + 0.01);

  // Low thud
  const osc = ctx.createOscillator();
  osc.type = "sine";
  osc.frequency.setValueAtTime(80, t);
  osc.frequency.exponentialRampToValueAtTime(30, t + 0.2);
  const oscGain = ctx.createGain();
  oscGain.gain.setValueAtTime(0.15, t);
  oscGain.gain.exponentialRampToValueAtTime(0.001, t + 0.25);
  osc.connect(oscGain);
  oscGain.connect(masterGain);
  osc.start(t);
  osc.stop(t + 0.26);
}

export function setAudioEnabled(enabled: boolean) {
  audioEnabled = enabled;
  applyMasterVolume();
}

export function stopAudio() {
  if (!ctx) {
    return;
  }
  ctx.close();
  ctx = null;
  masterGain = null;
  initialized = false;
}
