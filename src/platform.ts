type WavedashInitOptions = {
  debug: boolean;
  deferEvents: boolean;
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

export type LeaderboardSlug = "high-score" | "highest-climb" | "best-combo";

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
const LEADERBOARD_SLUGS: readonly LeaderboardSlug[] = ["high-score", "highest-climb", "best-combo"];
let resolvedWavedashSdk: WavedashSdk | null = null;
const resolvedLeaderboardIds: Record<LeaderboardSlug, string | null> = {
  "high-score": null,
  "highest-climb": null,
  "best-combo": null,
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

export async function platformInit() {
  const wavedash = await resolveWavedashSdk();
  if (!wavedash) {
    return;
  }

  wavedash.init({ debug: false, deferEvents: true });
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

export async function submitScores(input: { score: number; height: number; combo: number }) {
  const wavedash = getWavedashSdkSync();
  await Promise.allSettled([
    uploadLeaderboardValue(wavedash, "high-score", input.score),
    uploadLeaderboardValue(wavedash, "highest-climb", input.height),
    uploadLeaderboardValue(wavedash, "best-combo", input.combo),
  ]);

  const username = getUsername();
  writeLocalLeaderboardEntry("high-score", { username, score: input.score });
  writeLocalLeaderboardEntry("highest-climb", { username, score: input.height });
  writeLocalLeaderboardEntry("best-combo", { username, score: input.combo });
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

export function unlockAchievement(id: string) {
  const sdk = getWavedashSdkSync();
  if (!sdk || typeof sdk.setAchievement !== "function") return;
  try {
    if (!sdk.getAchievement(id)) {
      sdk.setAchievement(id, true);
    }
  } catch { /* fail silently */ }
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

export type { WavedashSdk, YoutubePlayablesSdk };
