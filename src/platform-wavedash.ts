/**
 * Wavedash implementation of `IPlatformServices`.
 *
 * Wraps the Wavedash JS SDK (lobbies, P2P, leaderboards, achievements, stats)
 * and the YouTube Playables host SDK (saves, pause, audio) behind the
 * platform-services surface. This is a literal port of the previous
 * `src/platform.ts` module — same behavior, repackaged as a class so a
 * second implementation (`TommyatoPlatform`) can coexist behind the same
 * interface.
 */

import achievementCatalog from "../wavedash-achievements.json";
import type {
  AchievementProgress,
  IMultiplayerTransport,
  IPlatformServices,
  LeaderboardEntry,
  LeaderboardSlug,
  LobbyUser,
  PeerMessage,
  RunScores,
} from "./platform-services";

type WavedashP2POptions = {
  maxPeers?: number;
  messageSize?: number;
  maxIncomingMessages?: number;
};

type WavedashInitOptions = {
  debug: boolean;
  deferEvents: boolean;
  p2p?: WavedashP2POptions;
};

type WavedashUser = {
  username?: string;
};

interface WavedashLeaderboardResponse {
  success: boolean;
  data: { id: string };
}

type WavedashLeaderboardData =
  | {
      totalEntries?: number;
      entries?: Array<Record<string, unknown>>;
      scores?: Array<Record<string, unknown>>;
    }
  | Record<string, unknown>;

type WavedashLeaderboardQueryResponse =
  | {
      success?: boolean;
      data?: WavedashLeaderboardData;
      totalEntries?: number;
      entries?: Array<Record<string, unknown>>;
      scores?: Array<Record<string, unknown>>;
    }
  | WavedashLeaderboardData;

interface WavedashSdk {
  init(options: WavedashInitOptions): void;
  readyForEvents(): void;
  getUser(): WavedashUser | null | undefined;
  getOrCreateLeaderboard(
    id: string,
    sortOrder: number,
    displayType: number
  ): Promise<WavedashLeaderboardResponse>;
  uploadLeaderboardScore(
    leaderboardId: string,
    score: number,
    keepBest: boolean
  ): Promise<void>;
  getLeaderboard?(leaderboardId: string): Promise<WavedashLeaderboardQueryResponse>;
  loadComplete(): void;
  setAchievement(achievementId: string, storeNow?: boolean): void;
  getAchievement(achievementId: string): boolean;
  setStat(statId: string, value: number, storeNow?: boolean): void;
  getStat(statId: string): number;
  requestStats(): Promise<{ success: boolean }>;
  storeStats(): void;
  createLobby?(type: number, maxPlayers: number): Promise<{ success: boolean; data: string }>;
  joinLobby?(lobbyId: string): Promise<void>;
  getUserId?(): string | null;
  leaveLobby?(lobbyId: string): Promise<void>;
  listAvailableLobbies?(): Promise<Array<{ id: string; playerCount: number }>>;
  getLobbyUsers?(lobbyId: string): Array<{ userId: string; username: string }>;
  getNumLobbyUsers?(lobbyId: string): number;
  getLobbyInviteLink?(createIfNone: boolean): Promise<{ success: boolean; data: string }>;
  getLaunchParams?(): { lobby?: string } | null | undefined;
  broadcastP2PMessage?(channel: number, reliable: boolean, data: Uint8Array): void;
  readP2PMessageFromChannel?(channel: number): { fromUserId: string; payload: Uint8Array } | null;
  addEventListener?(event: string, callback: (e: unknown) => void): void;
  Events?: Record<string, string>;
}

interface YoutubePlayablesGame {
  firstFrameReady(): void;
  gameReady(): void;
  loadData(): Promise<string | null>;
  saveData(data: string): Promise<void>;
}

interface YoutubePlayablesSystem {
  onPause(callback: () => void): void;
  onResume(callback: () => void): void;
  isAudioEnabled(): boolean;
  onAudioEnabledChange(callback: (enabled: boolean) => void): void;
}

interface YoutubePlayablesSdk {
  game: YoutubePlayablesGame;
  system: YoutubePlayablesSystem;
}

declare global {
  // eslint-disable-next-line no-var
  var WavedashJS: WavedashSdk | Promise<WavedashSdk> | undefined;
  // eslint-disable-next-line no-var
  var ytgame: YoutubePlayablesSdk | undefined;

  interface Window {
    WavedashJS?: WavedashSdk | Promise<WavedashSdk>;
    ytgame?: YoutubePlayablesSdk;
  }
}

const DEFAULT_USERNAME = "Player";
const DEFAULT_SAVE_KEY = "gameSave";
const LOCAL_LEADERBOARD_KEY = "clockwork-climb-local-leaderboards";
const LOCAL_LEADERBOARD_LIMIT = 10;
const LEADERBOARD_SLUGS: readonly LeaderboardSlug[] = [
  "high-score",
  "highest-climb",
  "best-combo",
  "daily-score",
];

function hasWavedash(): boolean {
  return typeof WavedashJS !== "undefined";
}

function hasYoutubePlayables(): boolean {
  return typeof ytgame !== "undefined";
}

function getStorage(): Storage | null {
  if (typeof window === "undefined" || typeof window.localStorage === "undefined") {
    return null;
  }
  return window.localStorage;
}

function getStorageEntry<T>(key: string, fallback: T): T {
  const storage = getStorage();
  if (!storage) return fallback;
  try {
    const rawValue = storage.getItem(key);
    if (!rawValue) return fallback;
    return JSON.parse(rawValue) as T;
  } catch {
    return fallback;
  }
}

function setStorageEntry<T>(key: string, value: T) {
  const storage = getStorage();
  if (!storage) return;
  try {
    storage.setItem(key, JSON.stringify(value));
  } catch {
    // ignore storage failures
  }
}

function isLocalAchievementUnlocked(id: string): boolean {
  const storage = getStorage();
  if (!storage) return false;

  // In-game achievement calls historically used UPPERCASE ids (e.g.
  // `unlockAchievement("FIRST_CLIMB")`), while the wavedash manifest uses
  // lowercase identifiers (`first_climb`). Check both so the achievements
  // panel doesn't report a locally-unlocked achievement as locked.
  try {
    if (storage.getItem(`ach_${id}`) === "1") return true;
    if (storage.getItem(`ach_${id.toUpperCase()}`) === "1") return true;
    if (storage.getItem(`ach_${id.toLowerCase()}`) === "1") return true;
    return false;
  } catch {
    return false;
  }
}

function firstNumber(source: Record<string, unknown>, keys: string[]): number {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return Number.NaN;
}

function firstString(source: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "string" && value.trim().length > 0) return value;
  }
  return null;
}

function extractLeaderboardArrays(
  response: WavedashLeaderboardQueryResponse
): Array<Record<string, unknown>> | null {
  const outer = typeof response === "object" && response !== null ? response : null;
  if (!outer) return null;

  const maybeData =
    "data" in outer && typeof outer.data === "object" && outer.data !== null ? outer.data : outer;

  if ("entries" in maybeData && Array.isArray(maybeData.entries)) {
    return maybeData.entries as Array<Record<string, unknown>>;
  }
  if ("scores" in maybeData && Array.isArray(maybeData.scores)) {
    return maybeData.scores as Array<Record<string, unknown>>;
  }
  return null;
}

function normalizeLeaderboardEntry(
  entry: Record<string, unknown>,
  index: number
): LeaderboardEntry | null {
  const username =
    firstString(entry, ["username", "userName", "name", "displayName", "playerName"]) ??
    DEFAULT_USERNAME;
  const score = firstNumber(entry, ["score", "value", "bestScore"]);
  if (!Number.isFinite(score)) return null;

  const rank = firstNumber(entry, ["rank", "position"]);
  return {
    username,
    score: Math.max(0, Math.floor(score)),
    rank: Number.isFinite(rank) ? rank : index + 1,
  };
}

function parseLeaderboardEntries(response: WavedashLeaderboardQueryResponse): LeaderboardEntry[] {
  const candidates = extractLeaderboardArrays(response);
  if (!Array.isArray(candidates)) return [];

  const entries = candidates
    .map((entry, index) => normalizeLeaderboardEntry(entry, index))
    .filter((entry): entry is LeaderboardEntry => entry !== null);
  return entries.slice(0, LOCAL_LEADERBOARD_LIMIT);
}

// ──────────────────────────────────────────────────────────────────────────────
// WavedashPlatform
// ──────────────────────────────────────────────────────────────────────────────

export class WavedashPlatform implements IPlatformServices {
  private resolvedSdk: WavedashSdk | null = null;
  private readonly resolvedLeaderboardIds: Record<LeaderboardSlug, string | null> = {
    "high-score": null,
    "highest-climb": null,
    "best-combo": null,
    "daily-score": null,
  };
  /** Eagerly created so consumers can hold a stable reference; it returns
   *  no-ops/defaults when the underlying SDK never resolves. */
  readonly multiplayer: IMultiplayerTransport;

  constructor() {
    this.multiplayer = new WavedashMultiplayerTransport(() => this.resolvedSdk);
  }

  // ── SDK probe ────────────────────────────────────────────────────────────

  private async resolveSdk(): Promise<WavedashSdk | null> {
    if (this.resolvedSdk) return this.resolvedSdk;
    if (!hasWavedash()) return null;

    try {
      // WavedashJS may be a Promise that resolves to the SDK
      const sdk = await WavedashJS;
      if (sdk && typeof sdk.init === "function") {
        this.resolvedSdk = sdk;
        return sdk;
      }
    } catch {
      // SDK resolution failed (e.g. config timeout) — continue without it
    }
    return null;
  }

  private getSdkSync(): WavedashSdk | null {
    return this.resolvedSdk;
  }

  private getPlayablesSync(): YoutubePlayablesSdk | null {
    if (!hasYoutubePlayables()) return null;
    return ytgame ?? null;
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  async init(): Promise<void> {
    const wavedash = await this.resolveSdk();
    if (!wavedash) return;

    wavedash.init({
      debug: false,
      deferEvents: true,
      p2p: { maxPeers: 4, messageSize: 4096, maxIncomingMessages: 512 },
    });
    wavedash.readyForEvents();

    for (const slug of LEADERBOARD_SLUGS) {
      try {
        const lb = await wavedash.getOrCreateLeaderboard(slug, 1, 0);
        if (lb.success) {
          this.resolvedLeaderboardIds[slug] = lb.data.id;
        }
      } catch {
        // Leaderboard setup failed — scores won't submit but game still works
      }
    }
  }

  async signalLoadComplete(): Promise<void> {
    const wavedash = await this.resolveSdk();
    if (!wavedash || typeof wavedash.loadComplete !== "function") return;
    wavedash.loadComplete();
  }

  signalFirstFrame(): void {
    const playables = this.getPlayablesSync();
    if (!playables) return;
    playables.game.firstFrameReady();
  }

  signalGameReady(): void {
    const playables = this.getPlayablesSync();
    if (!playables) return;
    playables.game.gameReady();
  }

  // ── Identity ──────────────────────────────────────────────────────────────

  /** Wavedash profile name is owned by the platform — editing inside the game is not supported. */
  readonly canEditUsername = false;

  getUsername(): string {
    const wavedash = this.getSdkSync();
    if (!wavedash) return DEFAULT_USERNAME;
    const user = wavedash.getUser();
    return user?.username ?? DEFAULT_USERNAME;
  }

  // ── Saves ─────────────────────────────────────────────────────────────────

  async loadSaveData(): Promise<string | null> {
    const playables = this.getPlayablesSync();
    if (playables) return playables.game.loadData();
    const storage = getStorage();
    return storage?.getItem(DEFAULT_SAVE_KEY) ?? null;
  }

  async writeSaveData(data: string): Promise<void> {
    const playables = this.getPlayablesSync();
    if (playables) {
      await playables.game.saveData(data);
      return;
    }
    const storage = getStorage();
    storage?.setItem(DEFAULT_SAVE_KEY, data);
  }

  // ── Leaderboards ──────────────────────────────────────────────────────────

  async submitScores(input: RunScores, username?: string): Promise<void> {
    const wavedash = this.getSdkSync();
    // Only trust wavedash when it has a real user-set name; fall back to the
    // caller-supplied coolname otherwise. Local cache is written first so the
    // next synchronous statement in the caller sees the updated entry — remote
    // upload is fire-and-forget from the local-cache perspective.
    const wavedashName = wavedash ? this.getUsername() : null;
    const effectiveUsername =
      wavedashName && wavedashName !== DEFAULT_USERNAME
        ? wavedashName
        : username ?? DEFAULT_USERNAME;
    this.writeLocalLeaderboardEntry("high-score", { username: effectiveUsername, score: input.score });
    this.writeLocalLeaderboardEntry("highest-climb", {
      username: effectiveUsername,
      score: input.height,
    });
    this.writeLocalLeaderboardEntry("best-combo", { username: effectiveUsername, score: input.combo });

    await Promise.allSettled([
      this.uploadLeaderboardValue(wavedash, "high-score", input.score),
      this.uploadLeaderboardValue(wavedash, "highest-climb", input.height),
      this.uploadLeaderboardValue(wavedash, "best-combo", input.combo),
    ]);
  }

  async submitDailyScore(score: number, username?: string): Promise<void> {
    const wavedash = this.getSdkSync();
    // Same pattern as submitScores: prefer real wavedash name, write local cache
    // before the remote await so the leaderboard panel sees it immediately.
    const wavedashName = wavedash ? this.getUsername() : null;
    const effectiveUsername =
      wavedashName && wavedashName !== DEFAULT_USERNAME
        ? wavedashName
        : username ?? DEFAULT_USERNAME;
    this.writeLocalLeaderboardEntry("daily-score", { username: effectiveUsername, score });

    await this.uploadLeaderboardValue(wavedash, "daily-score", score);
  }

  async fetchLeaderboardScores(slug: LeaderboardSlug = "high-score"): Promise<LeaderboardEntry[]> {
    const sdk = this.getSdkSync();
    const leaderboardId = this.resolvedLeaderboardIds[slug];
    if (sdk && leaderboardId && typeof sdk.getLeaderboard === "function") {
      try {
        const response = await sdk.getLeaderboard(leaderboardId);
        const entries = parseLeaderboardEntries(response);
        if (entries.length > 0) {
          return entries.slice(0, LOCAL_LEADERBOARD_LIMIT);
        }
      } catch {
        // fall back to local cache below
      }
    }

    return this.readLocalLeaderboardEntries(slug);
  }

  private writeLocalLeaderboardEntry(slug: LeaderboardSlug, entry: LeaderboardEntry) {
    if (!Number.isFinite(entry.score) || entry.score <= 0) return;

    const store = getStorageEntry<Record<LeaderboardSlug, LeaderboardEntry[]>>(
      LOCAL_LEADERBOARD_KEY,
      {
        "high-score": [],
        "highest-climb": [],
        "best-combo": [],
        "daily-score": [],
      }
    );
    const nextEntries = [...(store[slug] ?? []), entry]
      .sort((left, right) => right.score - left.score)
      .slice(0, LOCAL_LEADERBOARD_LIMIT)
      .map((item, index) => ({ ...item, rank: index + 1 }));
    store[slug] = nextEntries;
    setStorageEntry(LOCAL_LEADERBOARD_KEY, store);
  }

  private readLocalLeaderboardEntries(slug: LeaderboardSlug): LeaderboardEntry[] {
    const store = getStorageEntry<Record<LeaderboardSlug, LeaderboardEntry[]>>(
      LOCAL_LEADERBOARD_KEY,
      {
        "high-score": [],
        "highest-climb": [],
        "best-combo": [],
        "daily-score": [],
      }
    );
    return (store[slug] ?? []).slice(0, LOCAL_LEADERBOARD_LIMIT).map((entry, index) => ({
      username: entry.username ?? DEFAULT_USERNAME,
      score: Number.isFinite(entry.score) ? entry.score : 0,
      rank: index + 1,
    }));
  }

  private async uploadLeaderboardValue(
    sdk: WavedashSdk | null,
    slug: LeaderboardSlug,
    score: number
  ): Promise<void> {
    const leaderboardId = this.resolvedLeaderboardIds[slug];
    if (!sdk || !leaderboardId || !Number.isFinite(score)) return;
    await sdk.uploadLeaderboardScore(leaderboardId, Math.max(0, Math.floor(score)), true);
  }

  // ── Achievements ──────────────────────────────────────────────────────────

  /** Returns true if this was a *new* unlock (first time). */
  unlockAchievement(id: string): boolean {
    const sdk = this.getSdkSync();
    if (sdk && typeof sdk.setAchievement === "function") {
      try {
        if (!sdk.getAchievement(id)) {
          sdk.setAchievement(id, true);
          return true;
        }
        return false;
      } catch {
        return false;
      }
    }
    // No SDK — track locally via localStorage
    const key = `ach_${id}`;
    try {
      if (localStorage.getItem(key)) return false;
      localStorage.setItem(key, "1");
      return true;
    } catch {
      return false;
    }
  }

  hasAchievement(id: string): boolean {
    const sdk = this.getSdkSync();
    if (sdk && typeof sdk.getAchievement === "function") {
      try {
        return Boolean(sdk.getAchievement(id));
      } catch {
        return false;
      }
    }
    return isLocalAchievementUnlocked(id);
  }

  listAchievementProgress(): AchievementProgress[] {
    const sdk = this.getSdkSync();

    return achievementCatalog.achievements.map((entry) => {
      const unlocked = (() => {
        if (sdk && typeof sdk.getAchievement === "function") {
          try {
            return sdk.getAchievement(entry.identifier);
          } catch {
            return false;
          }
        }
        return isLocalAchievementUnlocked(entry.identifier);
      })();

      return {
        id: entry.identifier,
        displayName: entry.display_name,
        description: entry.description,
        unlocked,
      };
    });
  }

  // ── Stats ─────────────────────────────────────────────────────────────────

  updateStat(id: string, value: number): void {
    const sdk = this.getSdkSync();
    if (!sdk || typeof sdk.setStat !== "function") return;
    try {
      sdk.setStat(id, value, false);
    } catch {
      // ignore
    }
  }

  getStat(id: string): number {
    const sdk = this.getSdkSync();
    if (!sdk || typeof sdk.getStat !== "function") return 0;
    try {
      const value = sdk.getStat(id);
      return Number.isFinite(value) ? value : 0;
    } catch {
      return 0;
    }
  }

  async requestStats(): Promise<{ success: boolean }> {
    const sdk = this.getSdkSync();
    if (!sdk || typeof sdk.requestStats !== "function") return { success: false };
    try {
      return await sdk.requestStats();
    } catch {
      return { success: false };
    }
  }

  storeStats(): void {
    const sdk = this.getSdkSync();
    if (!sdk || typeof sdk.storeStats !== "function") return;
    try {
      sdk.storeStats();
    } catch {
      // ignore
    }
  }

  // ── Pause / audio ─────────────────────────────────────────────────────────

  registerPauseHandlers(onPause: () => void, onResume: () => void): void {
    const playables = this.getPlayablesSync();
    if (!playables) return;
    playables.system.onPause(onPause);
    playables.system.onResume(onResume);
  }

  isAudioEnabled(): boolean {
    const playables = this.getPlayablesSync();
    if (!playables) return true;
    return playables.system.isAudioEnabled();
  }

  onAudioChange(callback: (enabled: boolean) => void): void {
    const playables = this.getPlayablesSync();
    if (!playables) return;
    playables.system.onAudioEnabledChange(callback);
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// WavedashMultiplayerTransport
// ──────────────────────────────────────────────────────────────────────────────

class WavedashMultiplayerTransport implements IMultiplayerTransport {
  constructor(private readonly sdkRef: () => WavedashSdk | null) {}

  isAvailable(): boolean {
    const sdk = this.sdkRef();
    return !!(
      sdk &&
      typeof sdk.createLobby === "function" &&
      typeof sdk.joinLobby === "function" &&
      typeof sdk.broadcastP2PMessage === "function" &&
      typeof sdk.readP2PMessageFromChannel === "function"
    );
  }

  async createLobby(): Promise<string | null> {
    const sdk = this.sdkRef();
    if (!sdk || typeof sdk.createLobby !== "function") return null;
    try {
      const response = await sdk.createLobby(0, 4);
      if (response && response.success && typeof response.data === "string") {
        return response.data;
      }
    } catch {
      // lobby creation failed — return null so caller can fall back
    }
    return null;
  }

  async joinLobby(lobbyId: string): Promise<boolean> {
    const sdk = this.sdkRef();
    if (!sdk || typeof sdk.joinLobby !== "function") return false;
    try {
      await sdk.joinLobby(lobbyId);
      return true;
    } catch {
      return false;
    }
  }

  async leaveLobby(lobbyId: string): Promise<void> {
    const sdk = this.sdkRef();
    if (!sdk || typeof sdk.leaveLobby !== "function") return;
    try {
      await sdk.leaveLobby(lobbyId);
    } catch {
      // ignore — lobby may already be gone
    }
  }

  /** Broadcasts a P2P message on channel 0, reliable or unreliable. */
  broadcast(reliable: boolean, data: Uint8Array): void {
    const sdk = this.sdkRef();
    if (!sdk || typeof sdk.broadcastP2PMessage !== "function") return;
    try {
      sdk.broadcastP2PMessage(0, reliable, data);
    } catch {
      // drop silently
    }
  }

  readPeerMessages(): PeerMessage[] {
    const sdk = this.sdkRef();
    if (!sdk || typeof sdk.readP2PMessageFromChannel !== "function") return [];
    const messages: PeerMessage[] = [];
    try {
      // Drain channel 0 until empty; cap iterations to avoid runaway loops.
      for (let i = 0; i < 256; i++) {
        const msg = sdk.readP2PMessageFromChannel(0);
        if (!msg) break;
        messages.push({ fromUserId: msg.fromUserId, payload: msg.payload });
      }
    } catch {
      // ignore read errors
    }
    return messages;
  }

  async getInviteLink(): Promise<string | null> {
    const sdk = this.sdkRef();
    if (!sdk || typeof sdk.getLobbyInviteLink !== "function") return null;
    try {
      const response = await sdk.getLobbyInviteLink(false);
      if (response && response.success && typeof response.data === "string") {
        return response.data;
      }
    } catch {
      // fall through
    }
    return null;
  }

  checkLaunchLobby(): string | null {
    const sdk = this.sdkRef();
    if (!sdk || typeof sdk.getLaunchParams !== "function") return null;
    try {
      const params = sdk.getLaunchParams();
      if (params && typeof params.lobby === "string" && params.lobby.length > 0) {
        return params.lobby;
      }
    } catch {
      // ignore
    }
    return null;
  }

  /**
   * Returns the current logged-in Wavedash user's userId, or null if unavailable.
   * Used to identify "self" in the lobby roster so we don't render ourselves twice.
   */
  getMyUserId(): string | null {
    const sdk = this.sdkRef();
    if (!sdk || typeof sdk.getUserId !== "function") return null;
    try {
      const id = sdk.getUserId();
      return typeof id === "string" && id.length > 0 ? id : null;
    } catch {
      return null;
    }
  }

  getLobbyUsers(lobbyId: string): LobbyUser[] {
    const sdk = this.sdkRef();
    if (!sdk || typeof sdk.getLobbyUsers !== "function") return [];
    try {
      const users = sdk.getLobbyUsers(lobbyId);
      if (Array.isArray(users)) {
        return users.map((user) => ({
          userId: String(user.userId ?? ""),
          username: String(user.username ?? DEFAULT_USERNAME),
        }));
      }
    } catch {
      // ignore
    }
    return [];
  }

  /**
   * Returns the userId of the lobby host (first user in the list, by convention
   * the lobby creator). Returns null when the SDK is unavailable or the list is empty.
   */
  getLobbyHostId(lobbyId: string): string | null {
    return this.getLobbyUsers(lobbyId)[0]?.userId ?? null;
  }

  getLobbyUserCount(lobbyId: string): number {
    const sdk = this.sdkRef();
    if (!sdk || typeof sdk.getNumLobbyUsers !== "function") return 0;
    try {
      const count = sdk.getNumLobbyUsers(lobbyId);
      return Number.isFinite(count) ? count : 0;
    } catch {
      return 0;
    }
  }

  addEventListener(event: string, callback: (e: unknown) => void): void {
    const sdk = this.sdkRef();
    if (!sdk || typeof sdk.addEventListener !== "function") return;
    try {
      sdk.addEventListener(event, callback);
    } catch {
      // ignore registration errors
    }
  }

  getEvents(): Record<string, string> {
    const sdk = this.sdkRef();
    return sdk?.Events ?? {};
  }
}
