# Clockwork Climb

A timing-based 3D platformer. Climb a massive clockwork tower as a tiny bronze robot.

![Title Screen](screenshots/title.png)

## [Play Now](https://tommyato.github.io/gamedevjs-2026-entry/)

Also on [itch.io](https://tommyatoai.itch.io/clockwork-climb) | [Wavedash](https://wavedash.com/games/clockwork-climb) | [tommyato.com](https://tommyato.com/games/clockwork-climb/)

## About

You're a tiny bronze robot climbing an infinite clockwork tower. Jump between rotating gears, collect bolts, and survive crumbling platforms as the machinery gets faster and more dangerous the higher you go.

![Gameplay](screenshots/gameplay.png)

### Features

- **Infinite procedural generation** — The tower never ends. Gears stream in dynamically with a 40m buffer, cleaned up behind you as you climb. No ceiling on gameplay.
- **8 gear types** — Normal, speed (cyan boost), wind (blue lateral push), magnetic (purple center pull), bouncy (green 1.4x jump), crumbling (red glow + shake), piston (auto-launch), and golden milestone gears at zone boundaries
- **Power-up system** — Bolt magnet (8s attraction radius), slow-mo (3s time dilation), and shield pickups as octahedron collectibles
- **Combo system** — Land on consecutive gears within 2.5s for score multipliers (2x-5x) with fireworks celebration
- **Challenge zones** — Every 100m: 8-12 dense gears, guaranteed bolt drops, 2x score multiplier
- **5 environment zones** — Bronze Depths, Iron Works, Silver Spires, Golden Heights, and Chrome Abyss (100m+) — each with distinct colors and difficulty scaling
- **VERSUS multiplayer (1–4 players)** — Real-time race to 100m via Wavedash P2P WebRTC lobbies. Shared deterministic seed derived from the lobby id (FNV-1a 32-bit) so every player climbs the exact same tower. Ties broken by score; 120 s hard cap; last survivor wins immediately if everyone else falls. Binary position encoding for low-latency state sync.
- **Async ghost replay** — "Play a Ghost" pulls a recorded run from the shared remote pool (`api.tommyato.com/games/clockwork-climb/ghosts`) and replays it as a translucent companion on the same seed, so you can chase someone else's best line solo.
- **20 achievements** — Via Wavedash SDK, from beginner milestones to expert challenges
- **3 leaderboards** — High score, highest climb, and best combo with local fallback
- **Cloud saves** — Full progression persistence via Wavedash SDK
- **Procedural audio** — 4-layer music system (bass drone, gear rhythm, D-minor chime melody, tension noise) that intensifies with height. Zero audio files — everything synthesized via Web Audio API.
- **Orbit camera** — Camera tracks player angular position via `atan2()`, spiraling ~90 degrees per 40m of climbing. Freezes during jumps to prevent disorientation.
- **Visual polish** — Combo fireworks, speed gear trails, near-miss slow-mo, metallic title typography, Mario-style drop shadows
- **Score breakdown** — Game over screen with frosted glass overlay and detailed stat card
- **Share on X** — One-tap score sharing
- **Pause menu** — Escape key / mobile button, restart option
- **Tutorial overlay** — First-play-only control hints (desktop and mobile variants)
- **Gamepad support (preferred)** — Standard Gamepad API, full d-pad / stick + face-button mapping. Plays best on a controller — the spiral camera and jump-timing read most cleanly with analog input. Keyboard (WASD/Arrows + Space) and touch (virtual joystick + jump button) also fully supported.

![Game Over](screenshots/gameover.png)

### Architecture

The game uses an **ECS-inspired architecture** with a clean separation between headless simulation and rendering:

```
src/
  simulation.ts — Headless ECS simulation (1,442 lines). Zero Three.js dependencies.
                  Gym-style API: reset(), step(action), getObservation().
                  Deterministic RNG, event-driven output. Used for both gameplay
                  and reinforcement learning training.
  sim-types.ts  — Type definitions for the simulation layer (SimGear, SimBolt, SimPlayer)
  game.ts       — Render/controller layer (2,989 lines). Steps simulation, syncs
                  Three.js visuals, handles camera, HUD, state machine, UI overlays.
  multiplayer.ts— P2P ghost racing via Wavedash SDK WebRTC lobbies. Binary
                  position encoding for real-time state sync.
  ai-ghost.ts   — Pure JavaScript MLP inference for the RL-trained AI ghost.
                  No external ML dependencies.
  player.ts     — Player rendering (bronze cylinder), visual effects
  gear.ts       — 8 gear platform types with distinct visuals and mechanics
  bolt.ts       — Collectible bolt spawning, pickup detection, floating animation
  input.ts      — Keyboard + touch input abstraction, virtual joystick for mobile
  particles.ts  — Landing sparks, steam puffs, jump trails, bolt pickup effects
  platform.ts   — Wavedash SDK wrapper (leaderboards, achievements, cloud saves,
                  stats, P2P lobbies, lifecycle hooks)
  audio.ts      — Procedural music engine (4 layers) + SFX (Web Audio API)
```

~7,800 lines of TypeScript. The production build is a single HTML file (~670KB) with no external assets — everything is procedurally generated at runtime.

### Reinforcement Learning (training infrastructure)

The headless simulation (`simulation.ts`) exposes a Gym-compatible API that enables RL training without a browser — `reset()` / `step(action)` / `getObservation()` are all callable from Python via a JS-bridge. We use this to train PPO agents (CleanRL on Apple Silicon) that explore the gear-mechanics design space and surface balance issues. Pure JavaScript MLP inference (22-64-64-8 network, ~6K params, no ML dependencies) keeps trained policies runnable in-browser when needed. Player-facing "Play a Ghost" pulls human runs from the shared pool — the RL infra here is dev-side tooling, not a shipped game mode.

### How the procedural generation works

The tower generates infinitely using a streaming approach:

1. **Buffer zone** — Maintains a 40m window of gears ahead of the player
2. **Batch generation** — Creates 10 gears at a time, capped at 5 batches per frame to avoid stuttering
3. **Dynamic cleanup** — Gears, bolts, shadows, and decorations below the player (40m buffer) are removed from the scene and disposed
4. **Height-based difficulty** — Gear spacing, rotation speed, and variant probability scale with altitude
5. **Zone transitions** — Every 25m triggers a new environment zone with distinct colors and decorative elements

## Tech Stack

- **[Three.js](https://threejs.org/) r183** — 3D rendering, bloom post-processing
- **[Wavedash SDK](https://wavedash.com)** — P2P multiplayer (WebRTC), leaderboards, achievements, cloud saves, stats
- **TypeScript** — Type-safe game logic
- **Vite** — Dev server + production bundler
- **vite-plugin-singlefile** — Bundles everything into one HTML file
- **Web Audio API** — Procedural music and sound effects
- **UnrealBloomPass** — Post-processing glow effect
- **PPO (CleanRL)** — Reinforcement learning for the AI ghost agent

## Development

```bash
npm install
npm run dev     # dev server at localhost:5174
npm run build   # production build to dist/
```

## Open Source

- **Open Source** — Full source code in this repository
- **Wavedash Deployment** — Published at [wavedash.com/games/clockwork-climb](https://wavedash.com/games/clockwork-climb) with P2P multiplayer, 3 leaderboards, 20 achievements, cloud saves, and stats tracking

## Credits

Built by [tommyato](https://tommyato.com) — an AI agent by [@supertommy](https://x.com/supertommy).

## Deploy Checklist

**Visual verification before declaring done**: for any layout, camera, or particle change, open the preview URL in a real browser and screenshot it. Math that builds cleanly can still be geometrically or visually wrong. Inline-script JS parse-check + tsc exit code are necessary but not sufficient.

## UI verification

All UI changes must pass `npm run verify-ui` before shipping. The harness
(`scripts/verify-ui.mjs`) loads `dist/index.html` inside an iframe sized to
real Wavedash embed dimensions (`1280×720`, `890×500`, `540×960`) and asserts
that no HUD/overlay element overflows the iframe rect on any fixture. Baseline
screenshots land under `screenshots/ui-harness/<fixture>/<screen>.png`.

See `playbook/ui-screen-verification.md` in the tommyato knowledge base for
the full rationale — short version: screenshotting at an arbitrary desktop
viewport hides embed-specific bugs (media-query breakpoints, `window.innerWidth`
gates) and ships regressions.

## License

MIT
