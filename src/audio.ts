/**
 * Procedural audio skeleton — Web Audio API, zero external files.
 * Extend with game-specific sounds once theme is known.
 */

let ctx: AudioContext | null = null;
let masterGain: GainNode | null = null;
let initialized = false;
const DEFAULT_MASTER_VOLUME = 0.5;
let audioEnabled = true;
let userMuted = false;

// Read user mute preference from localStorage
try {
  userMuted = localStorage.getItem("audioMuted") === "1";
} catch {
  // localStorage unavailable
}

function applyMasterVolume() {
  if (!masterGain) {
    return;
  }

  masterGain.gain.value = (audioEnabled && !userMuted) ? DEFAULT_MASTER_VOLUME : 0;
}

/** Toggle user mute preference, persist to localStorage, return new "unmuted" state */
export function toggleAudio(): boolean {
  userMuted = !userMuted;
  try {
    if (userMuted) {
      localStorage.setItem("audioMuted", "1");
    } else {
      localStorage.removeItem("audioMuted");
    }
  } catch {
    // localStorage unavailable
  }
  applyMasterVolume();
  return !userMuted;
}

export function getAudioEnabled(): boolean {
  return !userMuted;
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

export function playGearTick(distance: number, speed: number) {
  if (!ctx || !masterGain) {
    return;
  }

  const distanceFactor = Math.max(0, 1 - Math.min(distance, 15) / 15);
  if (distanceFactor <= 0) {
    return;
  }

  const t = ctx.currentTime;
  const speedFactor = Math.max(0.3, Math.min(1.9, Math.abs(speed) * 0.75 + 0.25));
  const volume = 0.0025 + distanceFactor * 0.012 * speedFactor;

  const click = ctx.createOscillator();
  click.type = "square";
  click.frequency.setValueAtTime(760 + speedFactor * 190, t);
  click.frequency.exponentialRampToValueAtTime(420 + speedFactor * 70, t + 0.024);

  const body = ctx.createOscillator();
  body.type = "triangle";
  body.frequency.setValueAtTime(160 + speedFactor * 36, t);
  body.frequency.exponentialRampToValueAtTime(92, t + 0.05);

  const filter = ctx.createBiquadFilter();
  filter.type = "bandpass";
  filter.frequency.setValueAtTime(1350 + speedFactor * 260, t);
  filter.Q.setValueAtTime(8, t);

  const gain = ctx.createGain();
  gain.gain.setValueAtTime(0.001, t);
  gain.gain.exponentialRampToValueAtTime(volume, t + 0.01);
  gain.gain.exponentialRampToValueAtTime(0.001, t + 0.055);

  click.connect(filter);
  body.connect(filter);
  filter.connect(gain);
  gain.connect(masterGain);
  click.start(t);
  body.start(t);
  click.stop(t + 0.03);
  body.stop(t + 0.06);
}

export function playSteamHiss(distance: number = 0) {
  if (!ctx || !masterGain) {
    return;
  }

  const distanceFactor = Math.max(0, 1 - Math.min(distance, 18) / 18);
  if (distanceFactor <= 0) {
    return;
  }

  const t = ctx.currentTime;
  const dur = 0.22;
  const buffer = ctx.createBuffer(1, Math.ceil(ctx.sampleRate * dur), ctx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let index = 0; index < data.length; index += 1) {
    const falloff = 1 - index / data.length;
    data[index] = (Math.random() * 2 - 1) * falloff;
  }

  const src = ctx.createBufferSource();
  src.buffer = buffer;

  const filter = ctx.createBiquadFilter();
  filter.type = "bandpass";
  filter.frequency.setValueAtTime(900, t);
  filter.Q.setValueAtTime(0.8, t);

  const gain = ctx.createGain();
  gain.gain.setValueAtTime(0.001, t);
  gain.gain.exponentialRampToValueAtTime(0.01 * distanceFactor, t + 0.03);
  gain.gain.exponentialRampToValueAtTime(0.001, t + dur);

  src.connect(filter);
  filter.connect(gain);
  gain.connect(masterGain);
  src.start(t);
  src.stop(t + dur + 0.01);
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

/** Escalating pitch combo sound — call with combo multiplier (1..5). */
export function playComboLand(comboMultiplier: number) {
  if (!ctx || !masterGain) {
    return;
  }
  const t = ctx.currentTime;
  const level = Math.max(1, Math.min(5, comboMultiplier));
  const baseFreq = 420 + (level - 1) * 140;

  const osc = ctx.createOscillator();
  osc.type = "triangle";
  osc.frequency.setValueAtTime(baseFreq, t);
  osc.frequency.exponentialRampToValueAtTime(baseFreq * 1.7, t + 0.14);

  const harmonic = ctx.createOscillator();
  harmonic.type = "sine";
  harmonic.frequency.setValueAtTime(baseFreq * 1.5, t);
  harmonic.frequency.exponentialRampToValueAtTime(baseFreq * 2.2, t + 0.14);

  const gain = ctx.createGain();
  gain.gain.setValueAtTime(0.001, t);
  gain.gain.exponentialRampToValueAtTime(0.09, t + 0.015);
  gain.gain.exponentialRampToValueAtTime(0.001, t + 0.2);

  osc.connect(gain);
  harmonic.connect(gain);
  gain.connect(masterGain);
  osc.start(t);
  harmonic.start(t);
  osc.stop(t + 0.22);
  harmonic.stop(t + 0.22);
}

/** Hydraulic piston release — noise burst then rising tone */
export function playPistonLaunch() {
  if (!ctx || !masterGain) {
    return;
  }
  const t = ctx.currentTime;

  // Compressed-air hiss (short noise burst)
  const hissDur = 0.09;
  const buffer = ctx.createBuffer(1, Math.ceil(ctx.sampleRate * hissDur), ctx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let index = 0; index < data.length; index += 1) {
    const falloff = 1 - index / data.length;
    data[index] = (Math.random() * 2 - 1) * falloff;
  }
  const src = ctx.createBufferSource();
  src.buffer = buffer;
  const hissFilter = ctx.createBiquadFilter();
  hissFilter.type = "bandpass";
  hissFilter.frequency.setValueAtTime(2200, t);
  hissFilter.Q.setValueAtTime(1.4, t);
  const hissGain = ctx.createGain();
  hissGain.gain.setValueAtTime(0.18, t);
  hissGain.gain.exponentialRampToValueAtTime(0.001, t + hissDur);
  src.connect(hissFilter);
  hissFilter.connect(hissGain);
  hissGain.connect(masterGain);
  src.start(t);
  src.stop(t + hissDur + 0.01);

  // Rising tone (the launch)
  const osc = ctx.createOscillator();
  osc.type = "sawtooth";
  osc.frequency.setValueAtTime(180, t + 0.02);
  osc.frequency.exponentialRampToValueAtTime(720, t + 0.32);

  const toneFilter = ctx.createBiquadFilter();
  toneFilter.type = "lowpass";
  toneFilter.frequency.setValueAtTime(1600, t);
  toneFilter.Q.setValueAtTime(4, t);

  const oscGain = ctx.createGain();
  oscGain.gain.setValueAtTime(0.001, t + 0.02);
  oscGain.gain.exponentialRampToValueAtTime(0.14, t + 0.05);
  oscGain.gain.exponentialRampToValueAtTime(0.001, t + 0.36);

  osc.connect(toneFilter);
  toneFilter.connect(oscGain);
  oscGain.connect(masterGain);
  osc.start(t + 0.02);
  osc.stop(t + 0.38);

  // Low thump for body
  const thump = ctx.createOscillator();
  thump.type = "sine";
  thump.frequency.setValueAtTime(110, t);
  thump.frequency.exponentialRampToValueAtTime(50, t + 0.18);
  const thumpGain = ctx.createGain();
  thumpGain.gain.setValueAtTime(0.16, t);
  thumpGain.gain.exponentialRampToValueAtTime(0.001, t + 0.22);
  thump.connect(thumpGain);
  thumpGain.connect(masterGain);
  thump.start(t);
  thump.stop(t + 0.24);
}

export function setAudioEnabled(enabled: boolean) {
  audioEnabled = enabled;
  applyMasterVolume();
}

// ── Ambient clockwork tick ──────────────────────────────────────────────────

let tickGeneration = 0;
let nextTickTime = 0;
let currentTickIntervalMs = 500;

export function startAmbientTick() {
  const c = ensureContext();
  tickGeneration++;
  const gen = tickGeneration;
  nextTickTime = c.currentTime + 0.05;
  scheduleTicks(gen);
}

export function stopAmbientTick() {
  tickGeneration++;
}

/** Call each frame with current height; adjusts tick speed. */
export function setTickRate(height: number) {
  const t = Math.min(height / 100, 1);
  // 500ms at height 0 → 333ms at height 100 (~3 ticks/s max)
  currentTickIntervalMs = 500 - t * 167;
}

function scheduleTicks(gen: number) {
  if (gen !== tickGeneration || !ctx || !masterGain) {
    return;
  }
  const now = ctx.currentTime;
  while (nextTickTime < now + 0.2) {
    scheduleOneTick(nextTickTime);
    nextTickTime += currentTickIntervalMs / 1000;
  }
  setTimeout(() => scheduleTicks(gen), 50);
}

function scheduleOneTick(time: number) {
  if (!ctx || !masterGain) {
    return;
  }
  const osc = ctx.createOscillator();
  osc.type = "square";
  osc.frequency.setValueAtTime(400, time);

  const gain = ctx.createGain();
  gain.gain.setValueAtTime(0.015, time);
  gain.gain.exponentialRampToValueAtTime(0.001, time + 0.02);

  osc.connect(gain);
  gain.connect(masterGain);
  osc.start(time);
  osc.stop(time + 0.025);
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

// ── Background music system ─────────────────────────────────────────────────

let musicGeneration = 0;
let musicBus: GainNode | null = null;
let bassDroneOsc: OscillatorNode | null = null;
let bassDroneGain: GainNode | null = null;
let tensionSource: AudioBufferSourceNode | null = null;
let tensionGain: GainNode | null = null;
let nextGearPingTime = 0;
let nextChimeTime = 0;
let currentMusicHeight = 0;

// D minor pentatonic — two registers for height progression
const CHIME_LOW = [293.7, 349.2, 440.0, 523.3];   // D4, F4, A4, C5
const CHIME_HIGH = [587.3, 698.5, 880.0, 1046.5]; // D5, F5, A5, C6

export function startMusic() {
  const c = ensureContext();
  if (!masterGain) {
    return;
  }
  musicGeneration++;
  const gen = musicGeneration;
  currentMusicHeight = 0;

  // All music flows through this bus into masterGain — keeps music below SFX level
  musicBus = c.createGain();
  musicBus.gain.setValueAtTime(0.4, c.currentTime);
  musicBus.connect(masterGain);

  startBassDrone(c);
  startTensionLayer(c);

  nextGearPingTime = c.currentTime + 0.5;
  nextChimeTime = c.currentTime + 2.5;
  scheduleMusicLoop(gen);
}

export function stopMusic() {
  musicGeneration++;
  if (!ctx) {
    return;
  }
  const now = ctx.currentTime;

  // Save refs before nulling so we can schedule the stop
  const droneOsc = bassDroneOsc;
  const droneGain = bassDroneGain;
  bassDroneOsc = null;
  bassDroneGain = null;
  if (droneGain && droneOsc) {
    droneGain.gain.setTargetAtTime(0, now, 0.3);
    droneOsc.stop(now + 1.8);
  }

  const noiseSrc = tensionSource;
  const noiseGain = tensionGain;
  tensionSource = null;
  tensionGain = null;
  if (noiseGain && noiseSrc) {
    noiseGain.gain.setTargetAtTime(0, now, 0.3);
    noiseSrc.stop(now + 1.8);
  }

  // Null the bus — short scheduled notes (pings, chimes) will still complete through
  // the old bus node, which remains connected until it's GC'd
  musicBus = null;
}

/** Call each frame with the player's height score to drive music intensity. */
export function setMusicIntensity(height: number) {
  currentMusicHeight = height;
  if (!tensionGain || !ctx) {
    return;
  }
  // Tension layer fades in above 50 m, reaches full strength at 100 m+
  const t = Math.max(0, (height - 50) / 50);
  tensionGain.gain.setTargetAtTime(t * 0.06, ctx.currentTime, 0.8);
}

function startBassDrone(c: AudioContext) {
  if (!musicBus) {
    return;
  }
  const osc = c.createOscillator();
  osc.type = "sine";
  osc.frequency.setValueAtTime(55, c.currentTime); // A1 — felt more than heard

  const gain = c.createGain();
  gain.gain.setValueAtTime(0, c.currentTime);
  gain.gain.linearRampToValueAtTime(0.10, c.currentTime + 3.0); // slow fade-in

  osc.connect(gain);
  gain.connect(musicBus);
  osc.start(c.currentTime);

  bassDroneOsc = osc;
  bassDroneGain = gain;
}

function startTensionLayer(c: AudioContext) {
  if (!musicBus) {
    return;
  }
  // ~2s noise buffer (odd length discourages obvious loop artifacts)
  const bufLen = Math.ceil(c.sampleRate * 1.97);
  const buffer = c.createBuffer(1, bufLen, c.sampleRate);
  const data = buffer.getChannelData(0);
  for (let index = 0; index < bufLen; index++) {
    data[index] = Math.random() * 2 - 1;
  }

  const src = c.createBufferSource();
  src.buffer = buffer;
  src.loop = true;

  const filter = c.createBiquadFilter();
  filter.type = "lowpass";
  filter.frequency.setValueAtTime(300, c.currentTime);
  filter.Q.setValueAtTime(0.7, c.currentTime);

  const gain = c.createGain();
  gain.gain.setValueAtTime(0, c.currentTime); // starts silent; setMusicIntensity raises it

  src.connect(filter);
  filter.connect(gain);
  gain.connect(musicBus);
  src.start(c.currentTime);

  tensionSource = src;
  tensionGain = gain;
}

function scheduleMusicLoop(gen: number) {
  if (gen !== musicGeneration || !ctx || !musicBus) {
    return;
  }
  const now = ctx.currentTime;

  // Gear ping rhythm — interval shrinks from 1.15 s at ground to 0.65 s at 100 m
  const pingInterval = 1.15 - Math.min(currentMusicHeight / 100, 1) * 0.5;
  while (nextGearPingTime < now + 0.25) {
    scheduleGearPing(nextGearPingTime);
    nextGearPingTime += pingInterval;
  }

  // Chime phrase — sparse melodic fragment every 5–9 s
  if (nextChimeTime < now + 0.25) {
    scheduleChimePhrase(nextChimeTime);
    nextChimeTime += 5.5 + Math.random() * 3.5;
  }

  // Slowly drift bass drone pitch for organic movement
  if (bassDroneOsc) {
    const target = 55 + (Math.random() * 6 - 3);
    bassDroneOsc.frequency.setTargetAtTime(target, now, 2.5);
  }

  setTimeout(() => scheduleMusicLoop(gen), 50);
}

function scheduleGearPing(time: number) {
  if (!ctx || !musicBus) {
    return;
  }
  const dur = 0.4;
  const base = 1108.7; // C#6 — bright metallic

  const osc = ctx.createOscillator();
  osc.type = "sine";
  osc.frequency.setValueAtTime(base, time);
  osc.frequency.exponentialRampToValueAtTime(base * 0.88, time + dur);

  // Inharmonic partial for bell/gear character
  const osc2 = ctx.createOscillator();
  osc2.type = "sine";
  osc2.frequency.setValueAtTime(base * 2.756, time);
  osc2.frequency.exponentialRampToValueAtTime(base * 2.3, time + dur * 0.6);

  const gain = ctx.createGain();
  gain.gain.setValueAtTime(0, time);
  gain.gain.linearRampToValueAtTime(0.055, time + 0.006);
  gain.gain.exponentialRampToValueAtTime(0.001, time + dur);

  osc.connect(gain);
  osc2.connect(gain);
  gain.connect(musicBus);
  osc.start(time);
  osc2.start(time);
  osc.stop(time + dur + 0.02);
  osc2.stop(time + dur + 0.02);
}

function scheduleChimePhrase(startTime: number) {
  if (!ctx || !musicBus) {
    return;
  }
  const scale = currentMusicHeight >= 50 ? CHIME_HIGH : CHIME_LOW;
  const noteCount = Math.random() < 0.4 ? 4 : 3;
  const spacing = 0.30;
  const noteDur = 0.55;

  for (let i = 0; i < noteCount; i++) {
    const t = startTime + i * spacing;
    const freq = scale[i % scale.length];

    const osc = ctx.createOscillator();
    osc.type = "triangle";
    osc.frequency.setValueAtTime(freq, t);

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0, t);
    gain.gain.linearRampToValueAtTime(0.065, t + 0.018);
    gain.gain.exponentialRampToValueAtTime(0.001, t + noteDur);

    osc.connect(gain);
    gain.connect(musicBus);
    osc.start(t);
    osc.stop(t + noteDur + 0.02);
  }
}
