/**
 * AI Ghost — pure-JS neural network inference + headless simulation.
 *
 * Runs a pre-trained PPO policy (22→64→64→8 MLP with Tanh) alongside
 * the player's game. The AI's position is exposed as a ghost for the
 * renderer to display. No external ML libraries — just matrix math.
 *
 * Activate with ?_ai=1 URL parameter.
 */

import { ClockworkClimbSimulation } from "./simulation";

// ---------------------------------------------------------------------------
// Tiny MLP inference (22 → 64 tanh → 64 tanh → 8 logits)
// ---------------------------------------------------------------------------

type LayerWeights = {
  weight: Float32Array; // [outFeatures * inFeatures] row-major
  bias: Float32Array; // [outFeatures]
  outFeatures: number;
  inFeatures: number;
};

function gemm(
  input: Float32Array,
  layer: LayerWeights,
  output: Float32Array
): void {
  const { weight, bias, outFeatures, inFeatures } = layer;
  for (let o = 0; o < outFeatures; o++) {
    let sum = bias[o];
    const rowOffset = o * inFeatures;
    for (let i = 0; i < inFeatures; i++) {
      sum += weight[rowOffset + i] * input[i];
    }
    output[o] = sum;
  }
}

function tanhInPlace(arr: Float32Array): void {
  for (let i = 0; i < arr.length; i++) {
    arr[i] = Math.tanh(arr[i]);
  }
}

function argmax(arr: Float32Array): number {
  let best = 0;
  let bestVal = arr[0];
  for (let i = 1; i < arr.length; i++) {
    if (arr[i] > bestVal) {
      bestVal = arr[i];
      best = i;
    }
  }
  return best;
}

class TinyMLP {
  private layers: LayerWeights[];
  private buffers: Float32Array[];

  constructor(layers: LayerWeights[]) {
    this.layers = layers;
    // Pre-allocate intermediate buffers
    this.buffers = layers.map((l) => new Float32Array(l.outFeatures));
  }

  forward(input: Float32Array): number {
    let current = input;
    for (let i = 0; i < this.layers.length; i++) {
      gemm(current, this.layers[i], this.buffers[i]);
      // Tanh after all layers except the last (logits)
      if (i < this.layers.length - 1) {
        tanhInPlace(this.buffers[i]);
      }
      current = this.buffers[i];
    }
    return argmax(current);
  }
}

// ---------------------------------------------------------------------------
// Weight loading from base64-encoded JSON
// ---------------------------------------------------------------------------

type RawLayer = {
  name: string;
  shape: number[];
  data: string; // base64
};

function decodeBase64(b64: string): Float32Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new Float32Array(bytes.buffer);
}

function loadWeights(raw: RawLayer[]): LayerWeights[] {
  const layers: LayerWeights[] = [];
  // Weights come in pairs: [weight, bias, weight, bias, ...]
  for (let i = 0; i < raw.length; i += 2) {
    const w = raw[i];
    const b = raw[i + 1];
    layers.push({
      weight: decodeBase64(w.data),
      bias: decodeBase64(b.data),
      outFeatures: w.shape[0],
      inFeatures: w.shape[1],
    });
  }
  return layers;
}

// ---------------------------------------------------------------------------
// AI Ghost manager
// ---------------------------------------------------------------------------

export type AIGhostState = {
  x: number;
  y: number;
  z: number;
  height: number;
  score: number;
  combo: number;
  onGround: boolean;
  alive: boolean;
};

export class AIGhost {
  private sim: ClockworkClimbSimulation | null = null;
  private mlp: TinyMLP | null = null;
  private weightsUrl: string;
  private loaded = false;
  private loading = false;
  private stepAccumulator = 0;
  private readonly stepsPerInference = 6; // ~10Hz inference at 60fps
  private frameCount = 0;
  private lastAction = 0;

  constructor(weightsUrl: string) {
    this.weightsUrl = weightsUrl;
  }

  async load(): Promise<boolean> {
    if (this.loaded) return true;
    if (this.loading) return false;
    this.loading = true;

    try {
      const response = await fetch(this.weightsUrl);
      if (!response.ok) {
        console.warn("[ai-ghost] Failed to load weights:", response.status);
        return false;
      }
      const raw: RawLayer[] = await response.json();
      const layers = loadWeights(raw);
      this.mlp = new TinyMLP(layers);
      this.loaded = true;
      console.log("[ai-ghost] Model loaded successfully");
      return true;
    } catch (err) {
      console.warn("[ai-ghost] Error loading model:", err);
      return false;
    } finally {
      this.loading = false;
    }
  }

  /** Inline load from pre-embedded weight data (avoids fetch). */
  loadFromData(raw: RawLayer[]): void {
    const layers = loadWeights(raw);
    this.mlp = new TinyMLP(layers);
    this.loaded = true;
  }

  isReady(): boolean {
    return this.loaded && this.mlp !== null;
  }

  /** Reset the AI simulation for a new game. */
  reset(): void {
    this.sim = new ClockworkClimbSimulation({ seed: 42 });
    this.sim.reset();
    // Transition from title to playing
    this.sim.step({ moveX: 0, moveY: 0, jump: true });
    this.stepAccumulator = 0;
    this.frameCount = 0;
    this.lastAction = 0;
  }

  /** Step the AI simulation forward one frame. Call every frame during gameplay. */
  update(dt: number): void {
    if (!this.sim || !this.mlp) return;

    const state = this.sim.getState();
    if (state.gameState === "gameover") return;

    this.frameCount++;

    // Run inference every N frames (~10Hz)
    if (this.frameCount % this.stepsPerInference === 0) {
      const obs = this.sim.getObservation();
      const obsF32 = new Float32Array(obs.length);
      for (let i = 0; i < obs.length; i++) {
        obsF32[i] = obs[i];
      }
      this.lastAction = this.mlp.forward(obsF32);
    }

    // Step simulation with last chosen action
    this.sim.step(this.lastAction);
  }

  /** Get current AI ghost state for rendering. */
  getGhostState(): AIGhostState | null {
    if (!this.sim) return null;
    const state = this.sim.getState();
    return {
      x: state.player.x,
      y: state.player.y,
      z: state.player.z,
      height: state.heightMaxReached,
      score: state.score,
      combo: state.comboMultiplier,
      onGround: state.player.onGround,
      alive: state.gameState !== "gameover",
    };
  }

  isAlive(): boolean {
    if (!this.sim) return false;
    return this.sim.getState().gameState !== "gameover";
  }
}

/** Check if AI ghost mode is enabled via URL parameter. */
export function isAIGhostEnabled(): boolean {
  try {
    const params = new URLSearchParams(window.location.search);
    return params.get("_ai") === "1" || params.get("_ai") === "onnx";
  } catch {
    return false;
  }
}
