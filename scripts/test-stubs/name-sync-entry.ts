/**
 * Test entry bundled by scripts/verify-name-sync.mjs. Re-exports both the
 * real MultiplayerManager and the platform stub's harness controls through
 * the same module graph so the test driver and the manager share one
 * instance of the stub's in-memory state.
 */
export { MultiplayerManager } from "../../src/multiplayer";
export {
  __resetHarness,
  __setCurrentUser,
  __fireP2PConnected,
  __asUser,
} from "./platform-stub";
