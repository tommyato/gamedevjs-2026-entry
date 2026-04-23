/**
 * AI Ghost — headless simulation + policy inference.
 *
 * Policy selection by URL parameter:
 *   ?_ai=1    → ScriptedPolicy (default, no model fetch)
 *   ?_ai=onnx → OnnxPolicy (ONNX Runtime, fetches model.onnx)
 *   ?_ai=mlp  → TinyMLP (bundled JSON weights, fetches model-weights.json)
 *
 * The AIGhost class's public interface is stable — game.ts and preview.html
 * require no edits when switching policy modes.
 */

import { ClockworkClimbSimulation } from "./simulation";
import { ScriptedPolicy } from "./ai-ghost-scripted";

// ---------------------------------------------------------------------------
// Tiny MLP inference (22 → 64 tanh → 64 tanh → 8 logits)
// ---------------------------------------------------------------------------

type LayerWeights = {
  weight: Float32Array; // [outFeatures * inFeatures] row-major
  bias: Float32Array; // [outFeatures]
  outFeatures: number;
  inFeatures: number;
};

type OrtTensor = {
  data: ArrayLike<number>;
};

type OrtSession = {
  run(feeds: Record<string, OrtTensor>): Promise<Record<string, OrtTensor>>;
};

type OrtModule = {
  env: {
    wasm: {
      wasmPaths: string;
      numThreads: number;
    };
  };
  Tensor: new (type: "float32", data: Float32Array, dims: number[]) => OrtTensor;
  InferenceSession: {
    create(modelPath: string): Promise<OrtSession>;
  };
};

const OBSERVATION_SIZE = 22;
const ORT_URL = "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.24.3/dist/ort.min.mjs";
const ORT_WASM_URL = "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.24.3/dist/";

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

class OnnxPolicy {
  private session: OrtSession | null = null;
  private loadPromise: Promise<boolean> | null = null;
  private runtimePromise: Promise<OrtModule> | null = null;
  private inflight = false;
  private failed = false;
  private lastAction = 0;
  private generation = 0;

  constructor(private readonly modelUrl: string) {}

  async load(): Promise<boolean> {
    if (this.session) return true;
    if (this.failed) return false;
    if (!this.loadPromise) {
      this.loadPromise = (async () => {
        try {
          const ort = await this.getRuntime();
          ort.env.wasm.wasmPaths = ORT_WASM_URL;
          ort.env.wasm.numThreads = 1;
          this.session = await ort.InferenceSession.create(this.modelUrl);
          console.log("[ai-ghost] ONNX model loaded successfully");
          return true;
        } catch (err) {
          this.failed = true;
          console.warn("[ai-ghost] Error loading ONNX model:", err);
          return false;
        } finally {
          this.loadPromise = null;
        }
      })();
    }
    return this.loadPromise;
  }

  reset(): void {
    this.generation++;
    this.inflight = false;
    this.lastAction = 0;
  }

  forwardAsync(input: Float32Array): number {
    if (!this.session || this.inflight || this.failed) {
      return this.lastAction;
    }

    const session = this.session;
    const generation = this.generation;
    const observation = new Float32Array(input);
    this.inflight = true;

    void (async () => {
      try {
        const ort = await this.getRuntime();
        const tensor = new ort.Tensor("float32", observation, [1, OBSERVATION_SIZE]);
        const outputs = await session.run({ obs: tensor });
        if (generation !== this.generation) return;

        const logits = outputs.logits ?? Object.values(outputs)[0];
        if (!logits) {
          this.failed = true;
          return;
        }
        this.lastAction = argmax(logits.data as Float32Array);
      } catch (err) {
        this.failed = true;
        console.warn("[ai-ghost] ONNX inference failed:", err);
      } finally {
        if (generation === this.generation) {
          this.inflight = false;
        }
      }
    })();

    return this.lastAction;
  }

  private async getRuntime(): Promise<OrtModule> {
    if (!this.runtimePromise) {
      this.runtimePromise = import(/* @vite-ignore */ ORT_URL).then((mod) => mod as unknown as OrtModule);
    }
    return this.runtimePromise;
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
  private onnx: OnnxPolicy | null = null;
  private scripted: ScriptedPolicy | null = null;
  private weightsUrl: string;
  private loaded = false;
  private loading = false;
  private stepAccumulator = 0;
  private readonly stepsPerInference = 6; // ~10Hz inference at 60fps (MLP/ONNX only)
  private frameCount = 0;
  private lastAction = 0;

  constructor(weightsUrl: string) {
    this.weightsUrl = weightsUrl;
  }

  /**
   * True when the weights URL resolves to the scripted policy (not ONNX or MLP).
   * Scripted mode requires no network fetch and is the default for ?_ai=1.
   * Safe to call from Node.js (no window.location available there).
   */
  private isScriptedMode(): boolean {
    if (this.weightsUrl.endsWith(".onnx")) return false;
    try {
      const ai = new URLSearchParams(window.location.search).get("_ai");
      return ai !== "mlp";
    } catch {
      // Non-browser environment (e.g. Node.js verification) → default to scripted.
      return true;
    }
  }

  async load(): Promise<boolean> {
    if (this.loaded) return true;
    if (this.loading) return false;
    this.loading = true;

    try {
      // Scripted policy: immediate no-op — no model to fetch.
      if (this.isScriptedMode()) {
        this.scripted = new ScriptedPolicy();
        this.loaded = true;
        console.log("[ai-ghost] Scripted policy ready");
        return true;
      }

      if (this.weightsUrl.endsWith(".onnx")) {
        this.onnx = new OnnxPolicy(this.weightsUrl);
        this.loaded = await this.onnx.load();
        return this.loaded;
      }

      const response = await fetch(this.weightsUrl);
      if (!response.ok) {
        console.warn("[ai-ghost] Failed to load weights:", response.status);
        return false;
      }
      const raw: RawLayer[] = await response.json();
      const layers = loadWeights(raw);
      this.mlp = new TinyMLP(layers);
      this.loaded = true;
      console.log("[ai-ghost] MLP model loaded successfully");
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
    return this.loaded && (this.mlp !== null || this.onnx !== null || this.scripted !== null);
  }

  /** Reset the AI simulation for a new game using the given seed.
   *
   * Pass the same seed as the player's current run so the ghost races
   * an identical layout. Normal runs use the run's randomly-rolled seed;
   * daily challenges use the calendar-derived daily seed.
   */
  reset(seed: number): void {
    this.sim = new ClockworkClimbSimulation({ seed });
    this.sim.reset();
    // One initial step to get the ghost off the starting platform.
    this.sim.step({ moveX: 0, moveY: 0, jump: true });
    this.stepAccumulator = 0;
    this.frameCount = 0;
    this.lastAction = 0;
    this.onnx?.reset();
    this.scripted?.reset();
  }

  /** Step the AI simulation forward one frame. Call every frame during gameplay. */
  update(dt: number): void {
    if (!this.sim || (!this.mlp && !this.onnx && !this.scripted)) return;

    const state = this.sim.getState();
    if (state.gameState === "gameover") return;

    if (this.scripted) {
      // Scripted policy: run the planner every frame (cheap — no inference cost).
      const action = this.scripted.decide(state, dt);
      this.sim.step(action);
      return;
    }

    // MLP / ONNX: compute action every N frames (~10Hz) to amortize inference cost.
    this.frameCount++;
    if (this.frameCount % this.stepsPerInference === 0) {
      const obs = this.sim.getObservation();
      const obsF32 = new Float32Array(obs.length);
      for (let i = 0; i < obs.length; i++) {
        obsF32[i] = obs[i];
      }
      this.lastAction = this.onnx
        ? this.onnx.forwardAsync(obsF32)
        : this.mlp?.forward(obsF32) ?? this.lastAction;
    }

    // Step simulation with last chosen action.
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
    const ai = params.get("_ai");
    return ai === "1" || ai === "onnx" || ai === "mlp";
  } catch {
    return false;
  }
}

export function isAIGhostOnnxEnabled(): boolean {
  try {
    const params = new URLSearchParams(window.location.search);
    return params.get("_ai") === "onnx";
  } catch {
    return false;
  }
}

export function getAIGhostModelUrl(): string {
  return isAIGhostOnnxEnabled() ? "model.onnx" : "model-weights.json";
}
