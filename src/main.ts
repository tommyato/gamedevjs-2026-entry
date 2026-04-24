/**
 * Clockwork Climb — Entry Point
 *
 * Starter template with:
 * - Three.js scene + bloom post-processing
 * - Input system (keyboard + mouse + touch)
 * - Procedural audio skeleton
 * - Game state machine
 * - Responsive resize
 */

import { Game } from "./game";
import { mountCharacterSandbox } from "./character-sandbox";

// Check for scene parameter
const params = new URLSearchParams(window.location.search);
const scene = params.get("scene");

if (scene === "character") {
  // Mount character sandbox instead of main game
  mountCharacterSandbox(document.body);
} else {
  // Normal game bootstrap
  const game = new Game();
  game.start();
  // Test-only hook — verify-ui harness (scripts/verify-ui.mjs) sets
  // `?verify-ui=1` to get handle on the Game instance for scripted screens
  // (force gameover, drive input deterministically). No effect in prod.
  if (params.get("verify-ui") === "1") {
    (window as unknown as { __ccGame?: Game }).__ccGame = game;
  }
}
