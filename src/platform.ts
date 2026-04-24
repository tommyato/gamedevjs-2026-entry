import achievementCatalog from "../wavedash-achievements.json";

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

export type LobbyUser = {
  userId: string;
  username: string;
};

export type PeerMessage = {
  fromUserId: string;
  payload: Uint8Array;
};

export type LobbySummary = {
  id: string;
  playerCount: number;
};

type WavedashUser = {
  username?: string;
};

interface WavedashLeaderboardResponse {
  success: boolean;
  data: { id: string };
}

type WavedashLeaderboardEntry = {
  username: string;
  score: number;
  rank?: number;
};

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

export type LeaderboardSlug = "high-score" | "highest-climb" | "best-combo" | "daily-score";
export type AchievementProgress = {
  id: string;
  displayName: string;
  description: string;
  unlocked: boolean;
};

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
  leaveLobby?(lobbyId: string): Promise<void>;
  listAvailableLobbies?(): Promise<Array<{ id: string; playerCount: number }>>;
  getLobbyUsers?(lobbyId: string): Array<{ userId: string; username: string }>;
  getNumLobbyUsers?(lobbyId: string): number;
  getLobbyInviteLink?(createIfNone: boolean): Promise<{ success: boolean; data: string }>;
  getLaunchParams?(): { lobby?: string } | null | undefined;
  broadcastP2PMessage?(channel: number, reliable: boolean, data: Uint8Array): void;
  readP2PMessageFromChannel?(channel: number): { fromUserId: string; payload: Uint8Array } | null;
  addEventListener?(event: string, callback: (e: any) => void): void;
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
  var WavedashJS: WavedashSdk | Promise<WavedashSdk> | undefined;
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
const LEADERBOARD_SLUGS: readonly LeaderboardSlug[] = ["high-score", "highest-climb", "best-combo", "daily-score"];
let resolvedWavedashSdk: WavedashSdk | null = null;
const resolvedLeaderboardIds: Record<LeaderboardSlug, string | null> = {
  "high-score": null,
  "highest-climb": null,
  "best-combo": null,
  "daily-score": null,
};

function hasWavedash(): boolean {
  return typeof WavedashJS !== "undefined";
}

function hasYoutubePlayables(): boolean {
  return typeof ytgame !== "undefined";
}

async function resolveWavedashSdk(): Promise<WavedashSdk | null> {
  if (resolvedWavedashSdk) return resolvedWavedashSdk;
  if (!hasWavedash()) return null;

  try {
    // WavedashJS may be a Promise that resolves to the SDK
    const sdk = await WavedashJS;
    if (sdk && typeof sdk.init === "function") {
      resolvedWavedashSdk = sdk;
      return sdk;
    }
  } catch {
    // SDK resolution failed (e.g. config timeout) — continue without it
  }
  return null;
}

function getWavedashSdkSync(): WavedashSdk | null {
  return resolvedWavedashSdk;
}

function getYoutubePlayablesSdk(): YoutubePlayablesSdk | null {
  if (!hasYoutubePlayables()) {
    return null;
  }

  return ytgame ?? null;
}

function getStorage(): Storage | null {
  if (typeof window === "undefined" || typeof window.localStorage === "undefined") {
    return null;
  }

  return window.localStorage;
}

function isLocalAchievementUnlocked(id: string): boolean {
  const storage = getStorage();
  if (!storage) {
    return false;
  }

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

export async function platformInit() {
  const wavedash = await resolveWavedashSdk();
  if (!wavedash) {
    return;
  }

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
        resolvedLeaderboardIds[slug] = lb.data.id;
      }
    } catch {
      // Leaderboard setup failed — scores won't submit but game still works
    }
  }
}

export function getUsername(): string {
  const wavedash = getWavedashSdkSync();
  if (!wavedash) {
    return DEFAULT_USERNAME;
  }

  const user = wavedash.getUser();
  return user?.username ?? DEFAULT_USERNAME;
}

export async function submitScores(
  input: { score: number; height: number; combo: number },
  username?: string,
) {
  const wavedash = getWavedashSdkSync();
  // Only trust wavedash when it has a real user-set name; fall back to the
  // caller-supplied coolname otherwise. Local cache is written first so the
  // next synchronous statement in the caller sees the updated entry — remote
  // upload is fire-and-forget from the local-cache perspective.
  const wavedashName = wavedash ? getUsername() : null;
  const effectiveUsername =
    wavedashName && wavedashName !== DEFAULT_USERNAME
      ? wavedashName
      : (username ?? DEFAULT_USERNAME);
  writeLocalLeaderboardEntry("high-score", { username: effectiveUsername, score: input.score });
  writeLocalLeaderboardEntry("highest-climb", { username: effectiveUsername, score: input.height });
  writeLocalLeaderboardEntry("best-combo", { username: effectiveUsername, score: input.combo });

  await Promise.allSettled([
    uploadLeaderboardValue(wavedash, "high-score", input.score),
    uploadLeaderboardValue(wavedash, "highest-climb", input.height),
    uploadLeaderboardValue(wavedash, "best-combo", input.combo),
  ]);
}

export async function submitDailyScore(score: number, username?: string) {
  const wavedash = getWavedashSdkSync();
  // Same pattern as submitScores: prefer real wavedash name, write local cache
  // before the remote await so the leaderboard panel sees it immediately.
  const wavedashName = wavedash ? getUsername() : null;
  const effectiveUsername =
    wavedashName && wavedashName !== DEFAULT_USERNAME
      ? wavedashName
      : (username ?? DEFAULT_USERNAME);
  writeLocalLeaderboardEntry("daily-score", { username: effectiveUsername, score });

  await uploadLeaderboardValue(wavedash, "daily-score", score);
}

export async function fetchLeaderboardScores(slug: LeaderboardSlug = "high-score"): Promise<WavedashLeaderboardEntry[]> {
  const sdk = getWavedashSdkSync();
  const leaderboardId = resolvedLeaderboardIds[slug];
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

  return readLocalLeaderboardEntries(slug);
}

export async function signalLoadComplete() {
  const wavedash = await resolveWavedashSdk();
  if (!wavedash || typeof wavedash.loadComplete !== "function") {
    return;
  }

  wavedash.loadComplete();
}

export function listAchievementProgress(): AchievementProgress[] {
  const sdk = getWavedashSdkSync();

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

export function signalFirstFrame() {
  const playables = getYoutubePlayablesSdk();
  if (!playables) {
    return;
  }

  playables.game.firstFrameReady();
}

export function signalGameReady() {
  const playables = getYoutubePlayablesSdk();
  if (!playables) {
    return;
  }

  playables.game.gameReady();
}

export function registerPauseHandlers(onPause: () => void, onResume: () => void) {
  const playables = getYoutubePlayablesSdk();
  if (!playables) {
    return;
  }

  playables.system.onPause(onPause);
  playables.system.onResume(onResume);
}

export function isAudioEnabled(): boolean {
  const playables = getYoutubePlayablesSdk();
  if (!playables) {
    return true;
  }

  return playables.system.isAudioEnabled();
}

export function onAudioChange(callback: (enabled: boolean) => void) {
  const playables = getYoutubePlayablesSdk();
  if (!playables) {
    return;
  }

  playables.system.onAudioEnabledChange(callback);
}

export async function loadSaveData(): Promise<string | null> {
  const playables = getYoutubePlayablesSdk();
  if (playables) {
    return playables.game.loadData();
  }

  const storage = getStorage();
  return storage?.getItem(DEFAULT_SAVE_KEY) ?? null;
}

export async function writeSaveData(data: string): Promise<void> {
  const playables = getYoutubePlayablesSdk();
  if (playables) {
    await playables.game.saveData(data);
    return;
  }

  const storage = getStorage();
  storage?.setItem(DEFAULT_SAVE_KEY, data);
}

/** Returns true if this was a *new* unlock (first time). */
export function unlockAchievement(id: string): boolean {
  const sdk = getWavedashSdkSync();
  if (sdk && typeof sdk.setAchievement === "function") {
    try {
      if (!sdk.getAchievement(id)) {
        sdk.setAchievement(id, true);
        return true;
      }
      return false;
    } catch { return false; }
  }
  // No SDK — track locally via localStorage
  const key = `ach_${id}`;
  try {
    if (localStorage.getItem(key)) return false;
    localStorage.setItem(key, "1");
    return true;
  } catch { return false; }
}

export function hasAchievement(id: string): boolean {
  const sdk = getWavedashSdkSync();
  if (sdk && typeof sdk.getAchievement === "function") {
    try {
      return Boolean(sdk.getAchievement(id));
    } catch {
      return false;
    }
  }

  return isLocalAchievementUnlocked(id);
}

export function updateStat(id: string, value: number) {
  const sdk = getWavedashSdkSync();
  if (!sdk || typeof sdk.setStat !== "function") return;
  try { sdk.setStat(id, value, false); } catch {}
}

export function getStat(id: string): number {
  const sdk = getWavedashSdkSync();
  if (!sdk || typeof sdk.getStat !== "function") return 0;
  try {
    const value = sdk.getStat(id);
    return Number.isFinite(value) ? value : 0;
  } catch {
    return 0;
  }
}

export async function requestStats(): Promise<{ success: boolean }> {
  const sdk = getWavedashSdkSync();
  if (!sdk || typeof sdk.requestStats !== "function") return { success: false };
  try { return await sdk.requestStats(); } catch { return { success: false }; }
}

export function storeStats() {
  const sdk = getWavedashSdkSync();
  if (!sdk || typeof sdk.storeStats !== "function") return;
  try { sdk.storeStats(); } catch {}
}

function getStorageEntry<T>(key: string, fallback: T): T {
  const storage = getStorage();
  if (!storage) {
    return fallback;
  }

  try {
    const rawValue = storage.getItem(key);
    if (!rawValue) {
      return fallback;
    }
    return JSON.parse(rawValue) as T;
  } catch {
    return fallback;
  }
}

function setStorageEntry<T>(key: string, value: T) {
  const storage = getStorage();
  if (!storage) {
    return;
  }

  try {
    storage.setItem(key, JSON.stringify(value));
  } catch {
    // ignore storage failures
  }
}

function writeLocalLeaderboardEntry(slug: LeaderboardSlug, entry: WavedashLeaderboardEntry) {
  if (!Number.isFinite(entry.score) || entry.score <= 0) {
    return;
  }

  const store = getStorageEntry<Record<LeaderboardSlug, WavedashLeaderboardEntry[]>>(LOCAL_LEADERBOARD_KEY, {
    "high-score": [],
    "highest-climb": [],
    "best-combo": [],
    "daily-score": [],
  });
  const nextEntries = [...(store[slug] ?? []), entry]
    .sort((left, right) => right.score - left.score)
    .slice(0, LOCAL_LEADERBOARD_LIMIT)
    .map((item, index) => ({ ...item, rank: index + 1 }));
  store[slug] = nextEntries;
  setStorageEntry(LOCAL_LEADERBOARD_KEY, store);
}

function readLocalLeaderboardEntries(slug: LeaderboardSlug): WavedashLeaderboardEntry[] {
  const store = getStorageEntry<Record<LeaderboardSlug, WavedashLeaderboardEntry[]>>(LOCAL_LEADERBOARD_KEY, {
    "high-score": [],
    "highest-climb": [],
    "best-combo": [],
    "daily-score": [],
  });
  return (store[slug] ?? []).slice(0, LOCAL_LEADERBOARD_LIMIT).map((entry, index) => ({
    username: entry.username ?? DEFAULT_USERNAME,
    score: Number.isFinite(entry.score) ? entry.score : 0,
    rank: index + 1,
  }));
}

async function uploadLeaderboardValue(
  sdk: WavedashSdk | null,
  slug: LeaderboardSlug,
  score: number
) {
  const leaderboardId = resolvedLeaderboardIds[slug];
  if (!sdk || !leaderboardId || !Number.isFinite(score)) {
    return;
  }

  await sdk.uploadLeaderboardScore(leaderboardId, Math.max(0, Math.floor(score)), true);
}

function parseLeaderboardEntries(response: WavedashLeaderboardQueryResponse): WavedashLeaderboardEntry[] {
  const candidates = extractLeaderboardArrays(response);
  if (!Array.isArray(candidates)) {
    return [];
  }

  const entries = candidates
    .map((entry, index) => normalizeLeaderboardEntry(entry, index))
    .filter((entry): entry is WavedashLeaderboardEntry => entry !== null);
  return entries.slice(0, LOCAL_LEADERBOARD_LIMIT);
}

function extractLeaderboardArrays(response: WavedashLeaderboardQueryResponse): Array<Record<string, unknown>> | null {
  const outer = typeof response === "object" && response !== null ? response : null;
  if (!outer) {
    return null;
  }

  const maybeData = "data" in outer && typeof outer.data === "object" && outer.data !== null
    ? outer.data
    : outer;

  if ("entries" in maybeData && Array.isArray(maybeData.entries)) {
    return maybeData.entries as Array<Record<string, unknown>>;
  }

  if ("scores" in maybeData && Array.isArray(maybeData.scores)) {
    return maybeData.scores as Array<Record<string, unknown>>;
  }

  return null;
}

function normalizeLeaderboardEntry(entry: Record<string, unknown>, index: number): WavedashLeaderboardEntry | null {
  const username = firstString(entry, ["username", "userName", "name", "displayName", "playerName"]) ?? DEFAULT_USERNAME;
  const score = firstNumber(entry, ["score", "value", "bestScore"]);
  if (!Number.isFinite(score)) {
    return null;
  }

  const rank = firstNumber(entry, ["rank", "position"]);
  return {
    username,
    score: Math.max(0, Math.floor(score)),
    rank: Number.isFinite(rank) ? rank : index + 1,
  };
}

function firstNumber(source: Record<string, unknown>, keys: string[]): number {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
  }
  return Number.NaN;
}

function firstString(source: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value;
    }
  }
  return null;
}

// --------------------------------------------------------------------------
// P2P Multiplayer (Wavedash lobbies + peer-to-peer binary messaging)
// --------------------------------------------------------------------------

export function isMultiplayerAvailable(): boolean {
  const sdk = getWavedashSdkSync();
  return !!(
    sdk &&
    typeof sdk.createLobby === "function" &&
    typeof sdk.joinLobby === "function" &&
    typeof sdk.broadcastP2PMessage === "function" &&
    typeof sdk.readP2PMessageFromChannel === "function"
  );
}

export async function createMultiplayerLobby(): Promise<string | null> {
  const sdk = getWavedashSdkSync();
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

export async function joinMultiplayerLobby(lobbyId: string): Promise<boolean> {
  const sdk = getWavedashSdkSync();
  if (!sdk || typeof sdk.joinLobby !== "function") return false;
  try {
    await sdk.joinLobby(lobbyId);
    return true;
  } catch {
    return false;
  }
}

export async function leaveMultiplayerLobby(lobbyId: string): Promise<void> {
  const sdk = getWavedashSdkSync();
  if (!sdk || typeof sdk.leaveLobby !== "function") return;
  try {
    await sdk.leaveLobby(lobbyId);
  } catch {
    // ignore — lobby may already be gone
  }
}

/** Broadcasts a P2P message on channel 0, reliable or unreliable. */
export function broadcastMessage(reliable: boolean, data: Uint8Array): void {
  const sdk = getWavedashSdkSync();
  if (!sdk || typeof sdk.broadcastP2PMessage !== "function") return;
  try {
    sdk.broadcastP2PMessage(0, reliable, data);
  } catch {
    // drop silently
  }
}

/** @deprecated Use broadcastMessage(false, data) instead. */
export function broadcastPlayerState(data: Uint8Array): void {
  broadcastMessage(false, data);
}

export function readPeerMessages(): PeerMessage[] {
  const sdk = getWavedashSdkSync();
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

export async function getInviteLink(): Promise<string | null> {
  const sdk = getWavedashSdkSync();
  if (!sdk || typeof sdk.getLobbyInviteLink !== "function") return null;
  try {
    const response = await sdk.getLobbyInviteLink(true);
    if (response && response.success && typeof response.data === "string") {
      return response.data;
    }
  } catch {
    // fall through
  }
  return null;
}

export function checkLaunchLobby(): string | null {
  const sdk = getWavedashSdkSync();
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

export function getLobbyUsers(lobbyId: string): LobbyUser[] {
  const sdk = getWavedashSdkSync();
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
export function getLobbyHostId(lobbyId: string): string | null {
  return getLobbyUsers(lobbyId)[0]?.userId ?? null;
}

export function getLobbyUserCount(lobbyId: string): number {
  const sdk = getWavedashSdkSync();
  if (!sdk || typeof sdk.getNumLobbyUsers !== "function") return 0;
  try {
    const count = sdk.getNumLobbyUsers(lobbyId);
    return Number.isFinite(count) ? count : 0;
  } catch {
    return 0;
  }
}

export function addMultiplayerListener(event: string, callback: (e: any) => void): void {
  const sdk = getWavedashSdkSync();
  if (!sdk || typeof sdk.addEventListener !== "function") return;
  try {
    sdk.addEventListener(event, callback);
  } catch {
    // ignore registration errors
  }
}

export function getMultiplayerEvents(): Record<string, string> {
  const sdk = getWavedashSdkSync();
  return sdk?.Events ?? {};
}

export type { WavedashSdk, YoutubePlayablesSdk };
