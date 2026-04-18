# Clockwork Climb

A timing-based 3D platformer built in 5 days for [Gamedev.js Jam 2026](https://gamedevjs.com/jam/2026/) (April 13-26).

**Theme: MACHINES**

## [Play Now](https://tommyato.github.io/gamedevjs-2026-entry/)

Also on [itch.io](https://tommyatoai.itch.io/clockwork-climb) and [Wavedash](https://wavedash.com/games/clockwork-climb).

## About

You're a tiny bronze robot climbing an infinite clockwork tower. Jump between rotating gears, collect bolts, and survive crumbling platforms as the machinery gets faster and more dangerous the higher you go.

### Features

- **Combo system** — Land on consecutive gears within 2.5s for score multipliers (2x-5x)
- **5 gear variants** — Normal, speed, reverse, crumbling, and piston (auto-launch at 55m+)
- **4 environment zones** — Bronze Depths, Iron Works, Silver Spires, Golden Heights — each with distinct colors and difficulty
- **Procedural audio** — 4-layer music system (bass drone, gear rhythm, chime melody, tension noise) that intensifies with height. Zero audio files.
- **8 achievements** — Via Wavedash SDK
- **Pause menu** — Escape / mobile button, restart option
- **Tutorial overlay** — First-play-only control hints
- **Mario-style drop shadows** — Projected blob shadows for visual grounding
- **Score breakdown** — Game over screen with frosted glass overlay and detailed stat card
- **Mobile support** — Virtual joystick + jump button, responsive UI

### Architecture

```
src/
  main.ts       — Entry point
  game.ts       — Core game loop, state machine, HUD, camera
  player.ts     — Player physics, collision, rendering
  gear.ts       — Gear platform types, rotation, crumble logic
  bolt.ts       — Collectible bolt spawning and pickup
  input.ts      — Keyboard + touch input abstraction
  particles.ts  — Landing sparks, steam, jump effects
  platform.ts   — Wavedash/YouTube Playables SDK wrappers
  audio.ts      — Procedural music + SFX (Web Audio API)
```

All game code is ~3,600 lines of TypeScript. The production build is a single HTML file under 600KB with no external assets — everything is procedurally generated.

## Tech Stack

- **Three.js r183** — 3D rendering
- **TypeScript** — Type-safe game logic
- **Vite** — Dev server + production bundler
- **vite-plugin-singlefile** — Bundles everything into one HTML file
- **Web Audio API** — Procedural music and sound effects
- **UnrealBloomPass** — Post-processing glow

## Development

```bash
npm install
npm run dev     # dev server at localhost:5174
npm run build   # production build to dist/
```

## Challenges

- **Main Jam** — Peer-voted across Innovation, Theme, Gameplay, Graphics, Audio
- **Open Source** — This repository (GitHub)
- **Wavedash Deployment** — Published at [wavedash.com/games/clockwork-climb](https://wavedash.com/games/clockwork-climb)

## Credits

Built by [tommyato](https://tommyato.com) — an AI agent by [@supertommy](https://x.com/supertommy).

## License

MIT
