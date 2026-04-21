#!/usr/bin/env python3
"""Reference training script — copy into each game's directory and tune.

Architecture:

  [this script (Python)]
      ├─ Gym wrapper (GameEnv)
      │     └─ subprocess: node sim-bridge.mjs --sim <game-dir>/simulation.mjs
      │           └─ exposes the browser-authored simulation over stdin/stdout JSON
      ├─ CleanRL-style single-file PPO loop
      ├─ TensorBoard writer → <output-dir>/tb/
      └─ ONNX export on exit (partial → fsync → atomic rename)

Relay contract:
  The training-relay invokes this as
    venv/bin/python <game-dir>/train.py \
      --config <path-to-config.json> \
      --output-dir <job-dir> \
      --job-id <id> \
      --script-dir <game-dir>
  The script is responsible for:
    1. Writing <output-dir>/model.onnx atomically (partial → fsync → rename).
    2. Writing <output-dir>/summary.json with final metrics.
    3. Registering an atexit handler that writes <output-dir>/exit-code
       with the exit status as a single integer (drives the relay's
       reattach-on-boot recovery path when the in-memory exit handler is
       lost during a relay restart).
    4. Handling SIGTERM gracefully (save a checkpoint, exit 143).

Per-game customization: redefine `compute_reward(events, state)` at the top
of your game's copy; everything else is generic.
"""

from __future__ import annotations

import argparse
import atexit
import collections
import copy
import json
import os
import signal
import subprocess
import sys
import time
from pathlib import Path
from typing import Any

import gymnasium as gym
import numpy as np
import onnx

# NOTE: If MPS memory pressure is still an issue after this script's
# preallocation + periodic empty_cache, the next lever is
# PYTORCH_MPS_HIGH_WATERMARK_RATIO=0.7 in the relay's subprocess env
# (scripts/training-relay.ts, where TOMMYATO_SIM_BRIDGE_PATH is set
# around line 760 — inject via childEnv there). Must be set BEFORE
# `import torch` — the MPS allocator reads it at first allocation, so
# setting it inside main() has no effect.
import torch
import torch.nn as nn
import torch.optim as optim
from gymnasium.spaces import Box, Discrete
from torch.distributions.categorical import Categorical
from torch.utils.tensorboard import SummaryWriter

# ---------------------------------------------------------------------------
# Defensive SIGPIPE — Python's default BrokenPipeError would crash the loop
# if any downstream pipe breaks (sim-bridge dying, tensorboard writer flush,
# etc.). SIG_DFL silently drops the process instead — cleaner for
# long-running training. See plan's "SIGPIPE in Python" pitfall + the
# bun-event-loop-self-callback-deadlock skill's adjacent guidance.
# ---------------------------------------------------------------------------
if hasattr(signal, "SIGPIPE"):
    signal.signal(signal.SIGPIPE, signal.SIG_DFL)


# ---------------------------------------------------------------------------
# Per-game overridable reward shaping. Bridge passes events through untouched;
# reward is computed in Python.
# ---------------------------------------------------------------------------

def compute_reward(events: list[dict], state: dict, obs: np.ndarray | None = None) -> float:
    """Clockwork Climb reward shaping.

    Events: gear_land, bolt_collect, combo_up, combo_break, milestone,
    piston_launch, death, death_start, bounce_jump, powerup_collect, etc.

    Obs layout (22 values):
      [0]  playerX / 8         (-1 to 1)
      [1]  playerY / 120       (0 to 1)
      [2]  playerZ / 8         (-1 to 1)
      [3]  playerVx / 12       (-1 to 1)
      [4]  playerVy / 20       (-1 to 1)
      [5]  playerVz / 12       (-1 to 1)
      [6]  onGround            (0 or 1)
      [7]  speedBoostTimer     (0 to 1)
      [8]  activeGear relX / 8 (-1 to 1)
      [9]  activeGear relY     (0 to 1, clamped (top-y - player.y + 4) / 8)
      [10] activeGear relZ / 8 (-1 to 1)
      [11] nearestBolt relX    (-1 to 1)
      [12] nearestBolt relY    (0 to 1)
      [13] nearestBolt relZ    (-1 to 1)
      [14] comboMultiplier / 5 (0 to 1)
      [15] boltCount / 25      (0 to 1)
      [16] heightNorm          (0 to 1, heightMaxReached / 120)
      [17] orbitAngle          (-1 to 1)
      [18] boltMagnetTimer     (0 to 1)
      [19] slowMoTimer         (0 to 1)
      [20] shieldActive        (0 or 1)
      [21] inChallengeZone     (0 or 1)
    """
    reward = 0.0

    for ev in events:
        t = ev.get("type")
        if t == "gear_land":
            reward += 0.3    # primary objective: land on gears
        elif t == "bolt_collect":
            reward += 0.1    # secondary: collect bolts
        elif t == "combo_up":
            reward += 0.2    # encourage combos
        elif t == "milestone":
            reward += 0.5    # height milestones
        elif t == "piston_launch":
            reward += 0.15   # piston launches = height gain
        elif t == "bounce_jump":
            reward += 0.1    # bouncy gear utilization
        elif t == "powerup_collect":
            reward += 0.1    # power-ups
        elif t == "death" or t == "death_start":
            reward -= 1.0    # death penalty

    # Per-step height reward (dense signal for climbing)
    if obs is not None:
        height_norm = float(obs[16])  # index 16 = heightNorm
        reward += 0.005 * height_norm  # small ongoing reward for being high

        # Reward for being below a gear (can jump to it)
        active_gear_dy = float(obs[9])  # active gear relative y
        if active_gear_dy > 0:
            reward += 0.002  # reward being below a gear

    return reward


# ---------------------------------------------------------------------------
# Bounded episode-return tracker — see Sprint 3 of
# plans/rl-training-memory-hygiene-plan.md. Caps memory (deque bounded
# at maxlen entries) while preserving the TRUE episode count via an
# independent counter. Consumers of summary.json read num_episodes_total,
# NOT len(tracker) — the deque is a sliding window for mean_last(n).
# ---------------------------------------------------------------------------


class EpisodeTracker:
    """Bounded episode-return buffer with an independent total counter.

    The deque caps memory; the counter preserves the true count. Don't
    use len(tracker) as a "total episodes" proxy — that's the deque
    size.
    """

    def __init__(self, maxlen: int = 200):
        self._returns: collections.deque[float] = collections.deque(maxlen=maxlen)
        self.num_episodes_total: int = 0

    def record(self, ret: float) -> None:
        self._returns.append(ret)
        self.num_episodes_total += 1

    def mean_last(self, n: int = 100) -> float:
        if not self._returns:
            return float("nan")
        recent = list(self._returns)[-n:]
        return float(np.mean(recent))

    def __len__(self) -> int:
        return len(self._returns)


# ---------------------------------------------------------------------------
# Gym env wrapping the sim-bridge subprocess
# ---------------------------------------------------------------------------

def _parse_obs(raw) -> np.ndarray:
    """Convert bridge obs to ndarray, handling Float64Array dict serialization.

    When sim-bridge sends obs through JSON.stringify without Array.from(),
    Float64Array serializes as {"0": val, "1": val, ...} instead of [...].
    This handles both formats so training works regardless of bridge version.
    """
    if isinstance(raw, dict):
        return np.array([raw[str(i)] for i in range(len(raw))], dtype=np.float32)
    return np.asarray(raw, dtype=np.float32)


class GameEnv(gym.Env):
    """Drives a Node sim-bridge subprocess over stdin/stdout JSON.

    The browser sim returns `{state, events}` per step; this wrapper calls
    `compute_reward(events, state, obs)` to convert events + obs into scalar
    rewards. Observations come from `sim.getObservation()` (shape pinned at
    construction time from the first reset response).
    """

    metadata = {"render_modes": []}

    def __init__(
        self,
        sim_path: str,
        dt: float,
        seed: int,
        sim_bridge_path: str,
        class_name: str | None = None,
        max_steps: int = 5_000,
        obs_low: float = -10.0,
        obs_high: float = 10.0,
    ):
        super().__init__()
        # Node lookup: prefer TOMMYATO_NODE_BIN (the relay discovers and
        # injects this), then PATH. Launchd's default PATH doesn't include
        # nvm/volta, so the env var is the robust path.
        node_bin = os.environ.get("TOMMYATO_NODE_BIN", "node")
        bridge_cmd = [
            node_bin,
            sim_bridge_path,
            "--sim",
            sim_path,
            "--dt",
            str(dt),
            "--seed",
            str(seed),
        ]
        if class_name:
            bridge_cmd.extend(["--class", class_name])
        self._proc = subprocess.Popen(
            bridge_cmd,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            bufsize=1,
            start_new_session=False,
        )
        self._max_steps = max_steps
        self._steps = 0

        # Discover obs shape via a reset.
        resp = self._send({"op": "reset"})
        obs = _parse_obs(resp["obs"])
        self.observation_space = Box(low=obs_low, high=obs_high, shape=obs.shape, dtype=np.float32)
        self.action_space = Discrete(8)  # 8 discrete actions
        self._initial_obs = obs

    def _send(self, msg: dict) -> dict:
        if self._proc.stdin is None or self._proc.stdout is None:
            raise RuntimeError("sim-bridge subprocess stdio closed")
        self._proc.stdin.write(json.dumps(msg) + "\n")
        self._proc.stdin.flush()
        line = self._proc.stdout.readline()
        if not line:
            stderr = self._proc.stderr.read() if self._proc.stderr else ""
            raise RuntimeError(f"sim-bridge EOF — stderr: {stderr}")
        resp = json.loads(line)
        if "error" in resp:
            raise RuntimeError(f"sim-bridge error: {resp['error']}")
        return resp

    def reset(self, seed: int | None = None, options: dict | None = None):
        resp = self._send({"op": "reset"})
        self._steps = 0
        obs = _parse_obs(resp["obs"])
        return obs, {}

    def step(self, action: int):
        resp = self._send({"op": "step", "action": int(action)})
        obs = _parse_obs(resp["obs"])
        events = resp.get("events", [])
        reward = float(compute_reward(events, {}, obs))
        terminated = bool(resp.get("terminated", False))
        self._steps += 1
        truncated = self._steps >= self._max_steps
        return obs, reward, terminated, truncated, {"events": events}

    def close(self):
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


# ---------------------------------------------------------------------------
# CleanRL-style Actor-Critic + PPO loop
# ---------------------------------------------------------------------------

def layer_init(layer: nn.Linear, std: float = np.sqrt(2), bias: float = 0.0) -> nn.Linear:
    nn.init.orthogonal_(layer.weight, std)
    nn.init.constant_(layer.bias, bias)
    return layer


class ActorCritic(nn.Module):
    def __init__(self, obs_dim: int, n_actions: int, hidden: int = 64):
        super().__init__()
        self.trunk = nn.Sequential(
            layer_init(nn.Linear(obs_dim, hidden)),
            nn.Tanh(),
            layer_init(nn.Linear(hidden, hidden)),
            nn.Tanh(),
        )
        self.actor = layer_init(nn.Linear(hidden, n_actions), std=0.01)
        self.critic = layer_init(nn.Linear(hidden, 1), std=1.0)

    def get_value(self, x: torch.Tensor) -> torch.Tensor:
        return self.critic(self.trunk(x)).squeeze(-1)

    def get_action_and_value(
        self, x: torch.Tensor, action: torch.Tensor | None = None
    ) -> tuple[torch.Tensor, torch.Tensor, torch.Tensor, torch.Tensor]:
        features = self.trunk(x)
        logits = self.actor(features)
        value = self.critic(features).squeeze(-1)
        dist = Categorical(logits=logits)
        if action is None:
            action = dist.sample()
        return action, dist.log_prob(action), dist.entropy(), value


def export_onnx(model: ActorCritic, obs_dim: int, output_dir: Path) -> None:
    """Atomic rename: partial → fsync → rename. The relay polls for
    model.onnx after status flips to complete; model.onnx.partial must
    never be visible as a "finished" artifact.
    """
    model.eval()
    # Export a tiny inference wrapper — takes obs, returns action logits.
    # Browser-side onnxruntime-web picks the argmax.
    class Policy(nn.Module):
        def __init__(self, trunk, actor):
            super().__init__()
            self.trunk = trunk
            self.actor = actor

        def forward(self, obs):
            return self.actor(self.trunk(obs))

    # Deep-copy the subtrees BEFORE moving to CPU — Policy holds references,
    # so .cpu() would mutate the live model's parameters in place and break
    # the next rollout step when called mid-training (Sprint 4 periodic
    # export). The deepcopy preserves model device state.
    policy = Policy(copy.deepcopy(model.trunk), copy.deepcopy(model.actor)).cpu().eval()
    partial = output_dir / "model.onnx.partial"
    final = output_dir / "model.onnx"
    dummy = torch.zeros(1, obs_dim, dtype=torch.float32)
    # dynamo=False forces the legacy tracer, which inlines tensor weights
    # for small models. The dynamo exporter's default is external-data
    # format which writes a sibling `<name>.data` file — that sibling does
    # NOT ride along with our atomic rename, so browser onnxruntime-web
    # (and the relay's GET /artifacts/model.onnx) would load a weightless
    # model. For the MLP sizes we use here, inlining is fine.
    torch.onnx.export(
        policy,
        dummy,
        str(partial),
        input_names=["obs"],
        output_names=["logits"],
        dynamic_axes={"obs": {0: "batch"}, "logits": {0: "batch"}},
        opset_version=17,
        dynamo=False,
    )
    # fsync the file so the bytes are on disk before the rename.
    with open(partial, "rb+") as fh:
        fh.flush()
        os.fsync(fh.fileno())
    os.rename(partial, final)
    # Validate the written model — fail loud if ONNX rejected it.
    onnx.checker.check_model(str(final))


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main() -> int:
    parser = argparse.ArgumentParser(allow_abbrev=False)
    parser.add_argument("--config", required=True)
    parser.add_argument("--output-dir", required=True)
    parser.add_argument("--job-id", required=True)
    parser.add_argument("--script-dir", required=True)
    args, _unknown = parser.parse_known_args()

    output_dir = Path(args.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)

    # -----------------------------------------------------------------------
    # Exit-code marker (atexit). Registered BEFORE anything else so a crash
    # during setup still leaves the marker behind for the relay's reattach
    # path. Written last because the marker is the "terminal state" truth
    # for the relay when its in-memory proc.exited handler is lost.
    # -----------------------------------------------------------------------
    exit_status = {"code": 1}  # default to 1 — gets overwritten on clean exit
    _exit_code_path = output_dir / "exit-code"

    def _write_exit_code():
        try:
            _exit_code_path.write_text(str(exit_status["code"]))
        except Exception:
            pass

    atexit.register(_write_exit_code)

    # SIGTERM handler — save a final checkpoint (if we have a model), exit 143.
    model_ref: dict[str, Any] = {"model": None, "obs_dim": None}

    def _sigterm(_signum, _frame):
        exit_status["code"] = 143
        try:
            if model_ref["model"] is not None:
                ckpt = output_dir / "ckpt-sigterm.pt"
                torch.save(model_ref["model"].state_dict(), ckpt)
                # ONNX export on SIGTERM — see Sprint 4 of
                # plans/rl-training-memory-hygiene-plan.md. If the graceful
                # drain arrives mid-training, leave a loadable model.onnx
                # so the relay/browser can use the interrupted run.
                # ckpt-sigterm.pt is the fallback artifact.
                if model_ref.get("obs_dim") is not None:
                    try:
                        export_onnx(model_ref["model"], model_ref["obs_dim"], output_dir)
                    except Exception:
                        pass
        finally:
            sys.exit(143)

    signal.signal(signal.SIGTERM, _sigterm)

    # -----------------------------------------------------------------------
    # Config
    # -----------------------------------------------------------------------
    with open(args.config, "r", encoding="utf-8") as fh:
        config = json.load(fh)

    total_timesteps = int(config.get("total_timesteps", 100_000))
    num_steps = int(config.get("num_steps", 256))
    num_minibatches = int(config.get("num_minibatches", 4))
    update_epochs = int(config.get("update_epochs", 4))
    learning_rate = float(config.get("learning_rate", 3e-4))
    gamma = float(config.get("gamma", 0.99))
    gae_lambda = float(config.get("gae_lambda", 0.95))
    clip_coef = float(config.get("clip_coef", 0.2))
    ent_coef = float(config.get("ent_coef", 0.01))
    vf_coef = float(config.get("vf_coef", 0.5))
    max_grad_norm = float(config.get("max_grad_norm", 0.5))
    dt = float(config.get("dt", 1.0 / 60.0))
    seed = int(config.get("seed", 42))
    checkpoint_interval_steps = int(config.get("checkpoint_interval_steps", 50_000))
    max_episode_steps = int(config.get("max_episode_steps", 5_000))
    class_name = config.get("class_name")  # e.g. "ClockworkClimbSimulation"

    torch.manual_seed(seed)
    np.random.seed(seed)

    # -----------------------------------------------------------------------
    # Device selection — MPS on Apple Silicon, CPU fallback.
    # NEVER `"cuda"` — MPS and CUDA both exist as distinct backends and
    # hardcoding cuda would silently fall back to CPU with no error.
    # -----------------------------------------------------------------------
    if torch.backends.mps.is_available():
        device = torch.device("mps")
    else:
        device = torch.device("cpu")
    print(f"[clockwork-climb] device={device}", flush=True)
    print(f"[clockwork-climb] torch={torch.__version__}", flush=True)
    print(f"[clockwork-climb] job_id={args.job_id}", flush=True)

    # -----------------------------------------------------------------------
    # Env
    # -----------------------------------------------------------------------
    # Clockwork Climb builds to dist/; check dist first, then root.
    sim_path = os.path.join(args.script_dir, "dist", "simulation.mjs")
    if not os.path.exists(sim_path):
        sim_path_root = os.path.join(args.script_dir, "simulation.mjs")
        if os.path.exists(sim_path_root):
            sim_path = sim_path_root
        else:
            # Auto-build simulation.mjs from TypeScript source
            print("[clockwork-climb] simulation.mjs not found, building from TypeScript...")
            build_cmd = [
                "npx", "esbuild",
                os.path.join(args.script_dir, "src", "simulation.ts"),
                "--bundle", "--format=esm",
                f"--outfile={sim_path}",
                "--platform=node",
            ]
            build_result = subprocess.run(build_cmd, cwd=args.script_dir, capture_output=True, text=True)
            if build_result.returncode != 0 or not os.path.exists(sim_path):
                raise RuntimeError(f"Failed to build simulation.mjs: {build_result.stderr}")
            print(f"[clockwork-climb] Built {sim_path}")
    # sim-bridge.mjs is a shared utility in the tommyato repo. When the
    # relay invokes this script it injects TOMMYATO_SIM_BRIDGE_PATH; when
    # running standalone fall back to sibling lookup (works for the
    # reference copy in scripts/training/ but not for per-game copies
    # placed alongside simulation.mjs).
    sim_bridge_path = os.environ.get("TOMMYATO_SIM_BRIDGE_PATH") or str(
        Path(__file__).resolve().parent / "sim-bridge.mjs"
    )
    env = GameEnv(
        sim_path=sim_path,
        dt=dt,
        seed=seed,
        sim_bridge_path=sim_bridge_path,
        class_name=class_name,
        max_steps=max_episode_steps,
        obs_low=-1.0,
        obs_high=1.0,
    )
    obs_dim = int(np.prod(env.observation_space.shape))
    n_actions = int(env.action_space.n)

    # -----------------------------------------------------------------------
    # Model + optimizer + TB
    # -----------------------------------------------------------------------
    model = ActorCritic(obs_dim, n_actions).to(device)
    model_ref["model"] = model
    model_ref["obs_dim"] = obs_dim
    optimizer = optim.Adam(model.parameters(), lr=learning_rate, eps=1e-5)
    tb_dir = output_dir / "tb"
    tb_dir.mkdir(parents=True, exist_ok=True)
    writer = SummaryWriter(str(tb_dir))

    # -----------------------------------------------------------------------
    # Rollout buffers (single-env, no vectorization — MPS memory is
    # unified with the model so there's no copy-out bottleneck; the sim
    # is the step-rate ceiling, not the GPU).
    # -----------------------------------------------------------------------
    obs_buf = torch.zeros((num_steps, obs_dim), device=device)
    act_buf = torch.zeros(num_steps, device=device, dtype=torch.long)
    logp_buf = torch.zeros(num_steps, device=device)
    rew_buf = torch.zeros(num_steps, device=device)
    done_buf = torch.zeros(num_steps, device=device)
    val_buf = torch.zeros(num_steps, device=device)

    obs_np, _ = env.reset()
    # Future-proofing guard — _parse_obs always returns float32, but if that
    # pipeline ever drifts, silent float64→float32 casting through .copy_()
    # into the preallocated MPS buffer below would be undetectable.
    assert obs_np.dtype == np.float32, (
        f"obs_np dtype must be float32 (preallocated MPS buffer would "
        f"silently cast); got {obs_np.dtype}"
    )
    next_obs = torch.zeros(obs_dim, device=device, dtype=torch.float32)
    next_obs.copy_(torch.from_numpy(obs_np))
    next_done = torch.zeros(1, device=device)

    global_step = 0
    start_time = time.time()
    num_updates = max(1, total_timesteps // num_steps)
    tracker = EpisodeTracker()
    current_episode_return = 0.0
    last_checkpoint_step = 0

    # Preallocated scratch buffers — see Sprint 1 of
    # plans/rl-training-memory-hygiene-plan.md.
    advantages = torch.zeros(num_steps, device=device)
    assert num_steps % num_minibatches == 0, (
        "num_steps must divide evenly by num_minibatches; ragged final "
        "minibatch not supported by mb_idx_buf preallocation"
    )
    minibatch_size = max(1, num_steps // num_minibatches)
    mb_idx_buf = torch.empty(minibatch_size, dtype=torch.long, device=device)

    # MPS allocator hygiene — clear the caching allocator every N updates.
    MPS_CACHE_CLEAR_INTERVAL = 100  # updates

    # -----------------------------------------------------------------------
    # PPO training loop
    # -----------------------------------------------------------------------
    for update in range(1, num_updates + 1):
        # -- LR annealing (linear decay to 0) --
        frac = 1.0 - (update - 1) / num_updates
        lr_now = learning_rate * frac
        for param_group in optimizer.param_groups:
            param_group["lr"] = lr_now

        # -- Rollout --
        for step in range(num_steps):
            global_step += 1
            obs_buf[step] = next_obs
            done_buf[step] = next_done

            with torch.no_grad():
                action, logprob, _, value = model.get_action_and_value(next_obs.unsqueeze(0))

            act_buf[step] = action.squeeze(0)
            logp_buf[step] = logprob.squeeze(0)
            val_buf[step] = value.squeeze(0)

            obs_np, reward, terminated, truncated, _info = env.step(int(action.item()))
            rew_buf[step] = float(reward)
            current_episode_return += float(reward)
            next_obs.copy_(torch.from_numpy(obs_np))
            done_flag = bool(terminated or truncated)
            next_done.fill_(1.0 if done_flag else 0.0)

            if done_flag:
                tracker.record(current_episode_return)
                writer.add_scalar("episode/return", current_episode_return, global_step)
                current_episode_return = 0.0
                obs_np, _ = env.reset()
                next_obs.copy_(torch.from_numpy(obs_np))
                next_done.zero_()

        # -- GAE --
        with torch.no_grad():
            next_value = model.get_value(next_obs.unsqueeze(0)).squeeze(0)
            advantages.zero_()
            lastgaelam = 0.0
            for t in reversed(range(num_steps)):
                if t == num_steps - 1:
                    nextnonterminal = 1.0 - next_done.item()
                    nextvalue = next_value
                else:
                    nextnonterminal = 1.0 - done_buf[t + 1].item()
                    nextvalue = val_buf[t + 1]
                delta = rew_buf[t] + gamma * nextvalue * nextnonterminal - val_buf[t]
                advantages[t] = lastgaelam = delta + gamma * gae_lambda * nextnonterminal * lastgaelam
            returns = advantages + val_buf

        # -- PPO update --
        b_obs = obs_buf
        b_acts = act_buf
        b_logp = logp_buf
        b_adv = advantages
        b_ret = returns
        b_val = val_buf

        idx = np.arange(num_steps)
        policy_loss_acc = 0.0
        value_loss_acc = 0.0
        entropy_acc = 0.0
        for _ in range(update_epochs):
            np.random.shuffle(idx)
            for start in range(0, num_steps, minibatch_size):
                mb = idx[start : start + minibatch_size]
                mb_idx_buf.copy_(torch.from_numpy(mb))
                _, new_logp, entropy, new_value = model.get_action_and_value(
                    b_obs.index_select(0, mb_idx_buf), b_acts.index_select(0, mb_idx_buf)
                )
                logratio = new_logp - b_logp.index_select(0, mb_idx_buf)
                ratio = logratio.exp()
                adv_mb = b_adv.index_select(0, mb_idx_buf)
                adv_mb = (adv_mb - adv_mb.mean()) / (adv_mb.std() + 1e-8)

                pg_loss1 = -adv_mb * ratio
                pg_loss2 = -adv_mb * torch.clamp(ratio, 1 - clip_coef, 1 + clip_coef)
                pg_loss = torch.max(pg_loss1, pg_loss2).mean()

                v_loss = 0.5 * ((new_value - b_ret.index_select(0, mb_idx_buf)) ** 2).mean()
                ent_loss = entropy.mean()

                loss = pg_loss - ent_coef * ent_loss + vf_coef * v_loss

                optimizer.zero_grad()
                loss.backward()
                nn.utils.clip_grad_norm_(model.parameters(), max_grad_norm)
                optimizer.step()

                policy_loss_acc += float(pg_loss.item())
                value_loss_acc += float(v_loss.item())
                entropy_acc += float(ent_loss.item())

        # MPS allocator cache hygiene — see Sprint 2 of
        # plans/rl-training-memory-hygiene-plan.md.
        if update % MPS_CACHE_CLEAR_INTERVAL == 0 and hasattr(torch, "mps") and torch.backends.mps.is_available():
            torch.mps.empty_cache()

        writer.add_scalar("loss/policy", policy_loss_acc, global_step)
        writer.add_scalar("loss/value", value_loss_acc, global_step)
        writer.add_scalar("loss/entropy", entropy_acc, global_step)
        if len(tracker) > 0:
            writer.add_scalar("episode/return_mean_100", tracker.mean_last(100), global_step)
        steps_per_sec = global_step / max(1e-9, time.time() - start_time)
        writer.add_scalar("perf/steps_per_sec", steps_per_sec, global_step)

        if global_step - last_checkpoint_step >= checkpoint_interval_steps:
            ckpt_path = output_dir / f"ckpt-{global_step}.pt"
            torch.save(model.state_dict(), ckpt_path)
            # Periodic ONNX export — see Sprint 4 of
            # plans/rl-training-memory-hygiene-plan.md.
            export_onnx(model, obs_dim, output_dir)
            last_checkpoint_step = global_step
            print(f"[clockwork-climb] checkpoint step={global_step} path={ckpt_path.name}", flush=True)

        if update % 10 == 0 or update == 1 or update == num_updates:
            mean_ret = tracker.mean_last(100)
            print(
                f"[clockwork-climb] update={update}/{num_updates} step={global_step} "
                f"mean_ret(100)={mean_ret:.3f} sps={steps_per_sec:.0f}",
                flush=True,
            )

    writer.flush()
    writer.close()

    # -----------------------------------------------------------------------
    # ONNX export (atomic rename) + summary
    # -----------------------------------------------------------------------
    print("[clockwork-climb] exporting ONNX", flush=True)
    export_onnx(model, obs_dim, output_dir)

    final_return = tracker.mean_last(100)
    summary = {
        "job_id": args.job_id,
        "game_dir": args.script_dir,
        "dt": dt,
        "seed": seed,
        "total_timesteps": total_timesteps,
        "global_step": global_step,
        "wall_time_sec": time.time() - start_time,
        "final_return_mean_100": final_return,
        "num_episodes": tracker.num_episodes_total,
        "device": str(device),
        "hyperparams": {
            "learning_rate": learning_rate,
            "gamma": gamma,
            "gae_lambda": gae_lambda,
            "clip_coef": clip_coef,
            "ent_coef": ent_coef,
            "vf_coef": vf_coef,
            "num_steps": num_steps,
            "num_minibatches": num_minibatches,
            "update_epochs": update_epochs,
            "max_episode_steps": max_episode_steps,
        },
    }
    with open(output_dir / "summary.json", "w", encoding="utf-8") as fh:
        json.dump(summary, fh, indent=2)

    env.close()
    print("[clockwork-climb] done", flush=True)
    exit_status["code"] = 0
    return 0


if __name__ == "__main__":
    sys.exit(main())
