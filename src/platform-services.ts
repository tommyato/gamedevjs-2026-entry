/**
 * Platform service abstraction for Clockwork Climb.
 *
 * Two backends live behind one interface:
 *  - WavedashPlatform — wraps the Wavedash JS SDK (current default).
 *  - TommyatoPlatform — wraps our own droplet (Colyseus + SQLite); Phase 3 work.
 *
 * Selection happens at build time via the `VITE_PLATFORM` env var. `game.ts`
 * and `multiplayer.ts` should only import this file, never a concrete impl.
 */

export type LobbyUser = {
  userId: string;
  username: string;
};

export type PeerMessage = {
  fromUserId: string;
  payload: Uint8Array;
};

export type LeaderboardSlug = "high-score" | "highest-climb" | "best-combo" | "daily-score";

export type LeaderboardEntry = {
  username: string;
  score: number;
  rank?: number;
};

export type AchievementProgress = {
  id: string;
  displayName: string;
  description: string;
  unlocked: boolean;
};

/**
 * Score bundle submitted at end-of-run. Implementations decide how to fan this
 * out (Wavedash uploads to three named leaderboards; Tommyato POSTs to the
 * SQLite-backed HTTP endpoint). `username` is provided as a fallback when the
 * platform doesn't have a real user-set name (e.g. anonymous portal builds).
 */
export type RunScores = {
  score: number;
  height: number;
  combo: number;
};

export interface IPlatformServices {
  init(): Promise<void>;
  getUsername(): string;

  /** True when the player can change their displayed name from inside the game.
   *  Wavedash owns the profile externally → false. Tommyato persists locally → true. */
  readonly canEditUsername: boolean;

  // Lifecycle / host signals
  signalLoadComplete(): Promise<void>;
  signalFirstFrame(): void;
  signalGameReady(): void;

  // Saves
  loadSaveData(): Promise<string | null>;
  writeSaveData(data: string): Promise<void>;

  // Leaderboards
  submitScores(input: RunScores, username?: string): Promise<void>;
  submitDailyScore(score: number, username?: string): Promise<void>;
  fetchLeaderboardScores(slug?: LeaderboardSlug): Promise<LeaderboardEntry[]>;

  // Achievements
  unlockAchievement(id: string): boolean;
  hasAchievement(id: string): boolean;
  listAchievementProgress(): AchievementProgress[];

  // Stats
  updateStat(id: string, value: number): void;
  getStat(id: string): number;
  requestStats(): Promise<{ success: boolean }>;
  storeStats(): void;

  // Pause / audio (host integrations like YouTube Playables)
  registerPauseHandlers(onPause: () => void, onResume: () => void): void;
  isAudioEnabled(): boolean;
  onAudioChange(cb: (enabled: boolean) => void): void;

  // Multiplayer transport — null when the platform has no MP backend available.
  multiplayer: IMultiplayerTransport | null;
}

/**
 * Multiplayer transport surface used by `MultiplayerManager`. Designed to be
 * thin enough that a Wavedash P2P implementation and a Colyseus client can
 * both fit; the manager treats payloads as opaque `Uint8Array`s.
 */
export interface IMultiplayerTransport {
  isAvailable(): boolean;

  createLobby(): Promise<string | null>;
  joinLobby(lobbyId: string): Promise<boolean>;
  leaveLobby(lobbyId: string): Promise<void>;

  broadcast(reliable: boolean, data: Uint8Array): void;
  readPeerMessages(): PeerMessage[];

  getInviteLink(): Promise<string | null>;
  checkLaunchLobby(): string | null;

  getMyUserId(): string | null;
  getLobbyUsers(lobbyId: string): LobbyUser[];
  getLobbyHostId(lobbyId: string): string | null;
  getLobbyUserCount(lobbyId: string): number;

  /** Wavedash exposes connection/disconnection events; Colyseus will synthesize. */
  addEventListener(event: string, callback: (e: unknown) => void): void;
  getEvents(): Record<string, string>;
}

/**
 * Build-time selector. Vite inlines `import.meta.env.VITE_PLATFORM`, so the
 * unused branch tree-shakes out of the bundle.
 */
export async function createPlatformServices(): Promise<IPlatformServices> {
  const target = import.meta.env.VITE_PLATFORM ?? "wavedash";
  if (target === "tommyato") {
    const { TommyatoPlatform } = await import("./platform-tommyato");
    const platform = new TommyatoPlatform();
    document.body.classList.add("platform-tommyato");
    return platform;
  }
  const { WavedashPlatform } = await import("./platform-wavedash");
  const platform = new WavedashPlatform();
  document.body.classList.add("platform-wavedash");
  return platform;
}
