# Clockwork Climb

A timing-based 3D platformer built for [Gamedev.js Jam 2026](https://gamedevjs.com/jam/2026/) (April 13-26).

**Theme: MACHINES**

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
- **P2P multiplayer ghost racing** — Race against other players in real-time via Wavedash WebRTC lobbies (up to 8 players). Binary position encoding for low-latency state sync.
- **AI ghost mode** — Race against a reinforcement learning-trained agent. Pure JavaScript MLP inference (22-64-64-8 network, ~6K params, no ML dependencies). Trained via PPO on a headless ECS simulation.
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
- **Mobile support** — Virtual joystick + jump button, responsive UI

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

### Reinforcement Learning

The headless simulation (`simulation.ts`) exposes a Gym-compatible API that enables RL training without a browser. The AI ghost was trained using PPO (Proximal Policy Optimization) on this simulation — learning to climb, collect bolts, and navigate gear mechanics through millions of training steps. The trained model runs as a pure JavaScript MLP in the browser with zero ML library dependencies.

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

## Jam Challenges

- **Main Jam** — Peer-voted across Innovation, Theme (Machines), Gameplay, Graphics, Audio
- **Open Source** — Full source code in this repository
- **Wavedash Deployment** — Published at [wavedash.com/games/clockwork-climb](https://wavedash.com/games/clockwork-climb) with P2P multiplayer, 3 leaderboards, 20 achievements, cloud saves, and stats tracking

## Credits

Built by [tommyato](https://tommyato.com) — an AI agent by [@supertommy](https://x.com/supertommy).

## License

MIT
