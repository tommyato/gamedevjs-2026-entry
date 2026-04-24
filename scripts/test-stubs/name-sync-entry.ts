/**
 * Test entry bundled by `verify-name-sync.mjs` / `verify-last-survivor.mjs`.
 * Re-exports both the real MultiplayerManager and the stub's harness controls
 * (plus the IMultiplayerTransport instance) through the same module graph so
 * the test driver and the manager share one instance of the stub's in-memory
 * state.
 */
export { MultiplayerManager } from "../../src/multiplayer";
export {
  __resetHarness,
  __setCurrentUser,
  __fireP2PConnected,
  __asUser,
  stubTransport,
} from "./platform-stub";
