# RL Plumbing — What Was Fixed

This document describes the reinforcement-learning pipeline fixes applied on
2026-04-22. The goal was to make the training/ghost infrastructure _truthful_
before any reward redesign or retraining.

---

## What was fixed

### 1 — Ghost seed sync (`src/ai-ghost.ts`, `src/game.ts`)

**Problem:** `AIGhost.reset()` hardcoded `seed: 42`, so the AI ghost always
climbed a different layout than the player.

**Fix:**
- `AIGhost.reset(seed: number)` now accepts the run seed.
- `game.ts` `resetAIGhost()` computes the correct seed:
  - Normal runs → `this.regularSeed` (the session-rolled random value)
  - Daily challenges → `dailySeed(this.dailyChallengeDate)` (calendar hash)
- The `isDailyChallenge` guard that previously disabled the ghost for daily
  runs is removed; daily runs now reset the ghost on the daily seed so the
  player races on an equal layout.

### 2 — Bridge state passthrough + termination (`scripts/training/sim-bridge.mjs`)

**Problem:**
1. The bridge returned `terminated: state.gameOver === true || state.alive === false`.
   Clockwork Climb sets `gameState === "gameover"` as its primary terminal
   signal; while `flushBridge()` mirrors this into `gameOver`/`alive` shims,
   relying on those shims alone is fragile for future sims.
2. The bridge response omitted `state`, so Python's `compute_reward` could
   never inspect the current sim state.

**Fix:**
- `terminated` now checks all three:
  `state.gameState === 'gameover' || state.gameOver === true || state.alive === false`
- Both the `reset` and `step` responses now include the full `state` object.

### 3 — Reward hook gets real state (`train.py`)

**Problem:** `GameEnv.step()` called `compute_reward(events, {}, obs)` — the
`state` argument was always an empty dict, so any reward logic that inspected
sim state had no data.

**Fix:**
```python
state = resp.get("state", {})
reward = float(compute_reward(events, state, obs))
```
The existing reward function behaviour is unchanged; it only uses `events` and
`obs` indices. `state` is now available if a future reward pass needs it
(e.g. `state["comboMultiplier"]`, `state["inChallengeZone"]`).

---

## Ghost seeding — how it works now

```
Player starts a run
  └─ regularSeed (Math.random on page load) OR dailySeed (date hash)
       └─ ClockworkClimbSimulation({ seed })  ← player sim
       └─ AIGhost.reset(seed)
            └─ ClockworkClimbSimulation({ seed })  ← ghost sim
```

Both sims call `mulberry32(seed)` to initialize their RNG, so they produce an
identical gear layout from the first frame. The ghost steps at ~10Hz (every
6 render frames) independently of the player.

---

## Evaluation harness

`scripts/eval-model.py` runs a trained ONNX model over a set of fixed seeds
and prints per-episode metrics plus a summary.

### Prerequisites

```bash
# Build the headless sim
npm run build:sim               # writes dist/simulation.mjs

# Python deps (onnxruntime + numpy)
pip install onnxruntime numpy

# sim-bridge.mjs — either set the env var or place alongside the project
export TOMMYATO_SIM_BRIDGE_PATH=/path/to/tommyato/scripts/training/sim-bridge.mjs
```

### Running

```bash
# Evaluate the current model.onnx over the 8 default seeds
python scripts/eval-model.py dist/model.onnx

# Custom seeds, 3 episodes each
python scripts/eval-model.py dist/model.onnx --seeds 1 42 100 999 --episodes 3

# Longer episodes (default max is 8000 steps ≈ 133s at 60fps)
python scripts/eval-model.py dist/model.onnx --max-steps 20000
```

### Metrics reported

| Metric | Description |
|---|---|
| `max_height` | Highest point reached this episode (metres) |
| `deaths` | Number of `death` events (falls below camera - 12m) |
| `gear_landings` | Number of successful gear landings (`gear_land` events) |
| `jump_count` | Intentional jumps: `jump` + `bounce_jump` + `double_jump` |
| `airborne_jumps` | `double_jump` events only — jumps made while airborne |
| `jump_rate` | `jump_count / steps` — action frequency proxy |

---

## Still-open observation-space limitations

1. **Height saturates at 120m** — `heightNorm` (obs index 16) is clamped to
   `[0, 1]` by `player.height / 120`. Above 120m the agent sees no new height
   signal, which limits value-function quality at high altitude. A log or
   piece-wise normalization would extend the useful signal range.

2. **No gear-variant encoding** — The observation includes the active gear's
   *position* but not its *type* (crumbling, wind, piston, magnetic…). The
   agent cannot anticipate gear effects before landing, so it must learn
   reactive strategies. Adding a one-hot or categorical gear-type feature
   would let it plan ahead.

3. **Single active-gear slot** — Only the nearest gear above the player
   (`activeGearId`) is represented. A wider lookahead window (e.g. top-3
   reachable gears) would help with multi-step planning.

4. **No velocity on the active gear** — The gear's rotational momentum is
   indirectly visible through `momentumX`/`momentumZ` once the player lands,
   but the agent cannot predict the drift before touching down.
