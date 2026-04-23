# RL Plumbing — What Was Fixed

This document describes the reinforcement-learning pipeline fixes applied on
2026-04-22. The goal was to make the training/ghost infrastructure _truthful_
before any reward redesign or retraining.

**2026-04-22 (evening) — Reward redesign to eliminate bunny-hop exploit:**
The initial reward function gave +0.3 per `gear_land` regardless of progress,
allowing agents to farm rewards by repeatedly jumping on the same low gear.
Eval showed mean height of 3.0m with 121 landings but only 1-3 unique gears.
See "Reward Structure (2026-04-22 v2)" below for the new design.

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
| `unique_gears_landed` | **NEW (v2)** — Count of distinct gears landed on (exploit detection) |
| `gear_diversity` | **NEW (v2)** — `unique / total_landings`. Low values (<0.5) indicate repeated farming |
| `repeat_land_count` | **NEW (v2)** — Consecutive re-lands on same gear (direct exploit signature) |
| `jump_count` | Intentional jumps: `jump` + `bounce_jump` + `double_jump` |
| `airborne_jumps` | `double_jump` events only — jumps made while airborne |

---

## Reward Structure (2026-04-22 v2) — Anti-Exploit

The original reward function (`train.py` lines 83-144) gave **+0.3 per gear_land**
with no tracking of progress or gear identity. Agents exploited this by bunny-
hopping on the same low gear:
- Baseline eval: 3.0m mean height, 121 landings, ~1-3 unique gears per episode
- 211 jumps at 1m height = obvious degenerate loop

**New design (2026-04-22 evening):**

### Primary objective: height gain
- **+1.0 per meter of `heightMaxReached` gain** (tracked step-to-step via closure)
- Small dense reward: +0.01 × `heightNorm` per step (value-function stability)

### Anti-exploit mechanisms
1. **Gear landing reward reduced**: +0.05 (was +0.3) — just a "skill signal", not primary
2. **Unique gear bonus**: +0.1 for first landing on a new `gearId`
3. **Repeat-land penalty**: **-0.2** for re-landing same gear (kills bunny-hop loop)
4. **Jump cost**: -0.01 per jump (small pressure against spam)

### Death penalty
- **-5.0** (was -1.0) — must be much larger than local farming rewards

### Secondary rewards (unchanged scale)
- Bolt collect: +0.15
- Combo up: +0.2
- Milestone: +1.0 (was +0.5)
- Piston launch: +0.1
- Power-up: +0.1

### Tracking state
`compute_reward` now maintains step-to-step context via function attributes
(`_prev_height`, `_landed_gears`). This is single-env safe; vectorized training
would need per-env state dicts.

### Why this works
1. Agent must gain height to get positive reward (no reward for staying at 1m)
2. Re-landing same gear is net-negative: +0.05 - 0.2 = **-0.15**
3. Death wipes out 50+ steps of small local rewards
4. Milestone events (+1.0 every 10-20m) reinforce the height objective

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
