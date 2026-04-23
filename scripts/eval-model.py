#!/usr/bin/env python3
"""Evaluate a trained ONNX policy over fixed seeds.

Runs the model headlessly through the sim-bridge subprocess and reports
per-episode metrics plus a summary across all seeds.

Requirements:
    pip install onnxruntime numpy

Usage:
    python scripts/eval-model.py model.onnx
    python scripts/eval-model.py model.onnx --seeds 1 42 100 999
    python scripts/eval-model.py model.onnx --episodes 3 --max-steps 8000

Make sure simulation.mjs is built first:
    npm run build:sim     # writes dist/simulation.mjs

The TOMMYATO_SIM_BRIDGE_PATH env var may be set to point at sim-bridge.mjs
if the project is not co-located with the tommyato container repo.
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
from pathlib import Path
from typing import Any

import numpy as np

try:
    import onnxruntime as ort
except ImportError:
    print("onnxruntime not installed — run: pip install onnxruntime", file=sys.stderr)
    sys.exit(1)

# Default seeds give a variety of early RNG paths without being exhaustive.
DEFAULT_SEEDS = [1, 42, 100, 256, 777, 1234, 9999, 31337]

# Obs index 16 = heightNorm, which is player height / 120 (clamped to [0,1]).
HEIGHT_OBS_IDX = 16
HEIGHT_OBS_SCALE = 120.0


# ---------------------------------------------------------------------------
# Minimal bridge wrapper (no reward shaping — just obs + events + terminated)
# ---------------------------------------------------------------------------

class _Bridge:
    def __init__(self, sim_path: str, bridge_path: str, dt: float, seed: int) -> None:
        node_bin = os.environ.get("TOMMYATO_NODE_BIN", "node")
        self._proc = subprocess.Popen(
            [
                node_bin, bridge_path,
                "--sim", sim_path,
                "--dt", str(dt),
                "--seed", str(seed),
                "--class", "ClockworkClimbSimulation",
            ],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            bufsize=1,
        )

    def _send(self, msg: dict) -> dict:
        assert self._proc.stdin and self._proc.stdout
        self._proc.stdin.write(json.dumps(msg) + "\n")
        self._proc.stdin.flush()
        line = self._proc.stdout.readline()
        if not line:
            stderr = self._proc.stderr.read() if self._proc.stderr else ""
            raise RuntimeError(f"sim-bridge EOF — stderr: {stderr[:400]}")
        resp = json.loads(line)
        if "error" in resp:
            raise RuntimeError(f"sim-bridge error: {resp['error']}")
        return resp

    def reset(self) -> np.ndarray:
        resp = self._send({"op": "reset"})
        return _parse_obs(resp["obs"])

    def step(self, action: int) -> tuple[np.ndarray, list[dict], bool]:
        resp = self._send({"op": "step", "action": int(action)})
        obs = _parse_obs(resp["obs"])
        events = resp.get("events", [])
        terminated = bool(resp.get("terminated", False))
        return obs, events, terminated

    def close(self) -> None:
        try:
            if self._proc.stdin and not self._proc.stdin.closed:
                self._proc.stdin.write(json.dumps({"op": "close"}) + "\n")
                self._proc.stdin.flush()
        except (BrokenPipeError, OSError):
            pass
        try:
            self._proc.wait(timeout=3)
        except subprocess.TimeoutExpired:
            self._proc.kill()


def _parse_obs(raw: Any) -> np.ndarray:
    if isinstance(raw, dict):
        return np.array([raw[str(i)] for i in range(len(raw))], dtype=np.float32)
    return np.asarray(raw, dtype=np.float32)


# ---------------------------------------------------------------------------
# Episode runner
# ---------------------------------------------------------------------------

# Events that count as a player-initiated jump.
# - "jump"        : standard ground jump
# - "bounce_jump" : jump from a bouncy gear (ground, but 1.4× height)
# - "double_jump" : explicit mid-air second jump (uses doubleJumpCharges)
# piston_launch is excluded — it's an automatic gear effect, not player input.
_JUMP_EVENTS = frozenset({"jump", "bounce_jump", "double_jump"})
# Jumps that happen while the player is airborne (no ground contact required).
_AIRBORNE_JUMP_EVENTS = frozenset({"double_jump"})


def run_episode(
    session: ort.InferenceSession,
    bridge: _Bridge,
    max_steps: int,
) -> dict[str, Any]:
    obs = bridge.reset()
    max_height = 0.0
    deaths = 0
    gear_landings = 0
    jump_count = 0
    airborne_jumps = 0
    steps = 0
    
    # Track unique gears landed to detect bunny-hop exploit
    unique_gears_landed = set()
    # Track consecutive re-lands on same gear (exploit signature)
    last_gear_id = None
    repeat_land_count = 0

    for _ in range(max_steps):
        # Greedy argmax over logits (same as browser-side OnnxPolicy).
        logits = session.run(None, {"obs": obs.reshape(1, -1)})[0][0]
        action = int(np.argmax(logits))

        obs, events, terminated = bridge.step(action)
        steps += 1

        # Height from obs — heightNorm * 120m.
        height = float(obs[HEIGHT_OBS_IDX]) * HEIGHT_OBS_SCALE
        if height > max_height:
            max_height = height

        for ev in events:
            t = ev.get("type")
            if t == "gear_land":
                gear_landings += 1
                gear_id = ev.get("gearId")
                if gear_id is not None:
                    unique_gears_landed.add(gear_id)
                    # Track consecutive re-lands (exploit detection)
                    if gear_id == last_gear_id:
                        repeat_land_count += 1
                    last_gear_id = gear_id
            elif t in _JUMP_EVENTS:
                jump_count += 1
                if t in _AIRBORNE_JUMP_EVENTS:
                    airborne_jumps += 1
            elif t == "death":
                deaths += 1
                # Reset gear tracking on death
                last_gear_id = None

        if terminated:
            break

    jump_rate = jump_count / max(1, steps)
    airborne_jump_rate = airborne_jumps / max(1, jump_count)
    unique_gear_count = len(unique_gears_landed)
    # Ratio of unique gears to total landings — should be high for real climbing
    # Low ratio (e.g., <0.5) indicates repeated farming of same gear(s)
    gear_diversity = unique_gear_count / max(1, gear_landings)

    return {
        "max_height": max_height,
        "deaths": deaths,
        "gear_landings": gear_landings,
        "jump_count": jump_count,
        "airborne_jumps": airborne_jumps,
        "jump_rate": jump_rate,
        "airborne_jump_rate": airborne_jump_rate,
        "unique_gears_landed": unique_gear_count,
        "gear_diversity": gear_diversity,
        "repeat_land_count": repeat_land_count,
        "steps": steps,
    }


# ---------------------------------------------------------------------------
# Path resolution helpers
# ---------------------------------------------------------------------------

def _find_sim(script_dir: Path) -> Path | None:
    """Return path to simulation.mjs, preferring the built dist/ version."""
    for candidate in [
        script_dir / "dist" / "simulation.mjs",
        script_dir / "simulation.mjs",
    ]:
        if candidate.exists():
            return candidate
    return None


def _find_bridge(script_dir: Path) -> str | None:
    """Return path to sim-bridge.mjs from env var or repo conventions."""
    env_path = os.environ.get("TOMMYATO_SIM_BRIDGE_PATH")
    if env_path and Path(env_path).exists():
        return env_path
    for candidate in [
        # Sibling of eval script (scripts/) — for local dev copies
        Path(__file__).resolve().parent / "sim-bridge.mjs",
        # Project root sibling
        script_dir / "sim-bridge.mjs",
    ]:
        if candidate.exists():
            return str(candidate)
    return None


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main() -> int:
    parser = argparse.ArgumentParser(
        description="Evaluate a trained ONNX policy over fixed seeds.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=(
            "Example:\n"
            "  python scripts/eval-model.py model.onnx\n"
            "  python scripts/eval-model.py model.onnx --seeds 1 42 100 999\n"
            "\nMake sure the sim is built first:\n"
            "  npm run build:sim\n"
        ),
    )
    parser.add_argument("model", help="Path to model.onnx")
    parser.add_argument(
        "--seeds", type=int, nargs="+", default=DEFAULT_SEEDS,
        help=f"Seeds to evaluate (default: {DEFAULT_SEEDS})",
    )
    parser.add_argument(
        "--episodes", type=int, default=1,
        help="Episodes per seed (default: 1)",
    )
    parser.add_argument(
        "--max-steps", type=int, default=8000,
        help="Max steps per episode (default: 8000)",
    )
    parser.add_argument(
        "--dt", type=float, default=1.0 / 60.0,
        help="Simulation timestep (default: 1/60)",
    )
    args = parser.parse_args()

    model_path = Path(args.model).resolve()
    if not model_path.exists():
        print(f"model not found: {model_path}", file=sys.stderr)
        return 1

    script_dir = Path(__file__).resolve().parent.parent  # scripts/ → project root

    sim_path = _find_sim(script_dir)
    if sim_path is None:
        print(
            "simulation.mjs not found. Build it first:\n  npm run build:sim",
            file=sys.stderr,
        )
        return 1

    bridge_path = _find_bridge(script_dir)
    if bridge_path is None:
        print(
            "sim-bridge.mjs not found.\n"
            "Set TOMMYATO_SIM_BRIDGE_PATH to the full path of sim-bridge.mjs.",
            file=sys.stderr,
        )
        return 1

    session = ort.InferenceSession(str(model_path), providers=["CPUExecutionProvider"])

    print(f"Model  : {model_path.name}")
    print(f"Sim    : {sim_path}")
    print(f"Bridge : {bridge_path}")
    print(f"Seeds  : {args.seeds}")
    print(f"Max steps/episode: {args.max_steps}")
    print()

    row_fmt = (
        "seed={seed:8d}  ep={episode}  "
        "height={max_height:7.1f}m  "
        "deaths={deaths}  "
        "gear_lands={gear_landings:4d}  "
        "unique={unique_gears_landed:3d}  "
        "diversity={gear_diversity:.2f}  "
        "jumps={jump_count:4d}  "
        "airborne={airborne_jumps:3d}"
    )

    all_results: list[dict] = []
    for seed in args.seeds:
        for ep in range(args.episodes):
            bridge = _Bridge(str(sim_path), bridge_path, args.dt, seed)
            try:
                result = run_episode(session, bridge, args.max_steps)
            finally:
                bridge.close()
            result["seed"] = seed
            result["episode"] = ep
            all_results.append(result)
            print(row_fmt.format(**result))

    if not all_results:
        return 0

    # Summary
    summary_keys = [
        "max_height", "deaths", "gear_landings", "unique_gears_landed",
        "gear_diversity", "repeat_land_count", "jump_count", "airborne_jumps",
    ]
    print()
    print("=" * 64)
    print(f"SUMMARY  ({len(all_results)} episode(s) across {len(args.seeds)} seed(s))")
    print("=" * 64)
    print(f"  {'metric':<24}  {'mean':>10}  {'max':>10}  {'min':>10}")
    print(f"  {'-'*24}  {'-'*10}  {'-'*10}  {'-'*10}")
    for key in summary_keys:
        vals = [r[key] for r in all_results]
        print(
            f"  {key:<24}  {np.mean(vals):>10.3f}  "
            f"{np.max(vals):>10.3f}  {np.min(vals):>10.3f}"
        )

    return 0


if __name__ == "__main__":
    sys.exit(main())
