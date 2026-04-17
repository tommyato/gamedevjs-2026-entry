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
const LEADERBOARD_SLUG = "high-score";
let resolvedLeaderboardId: string | null = null;
let resolvedWavedashSdk: WavedashSdk | null = null;

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

  // Create or fetch leaderboard (descending = highest score wins, numeric display)
  try {
    const lb = await wavedash.getOrCreateLeaderboard(LEADERBOARD_SLUG, 1, 0);
    if (lb.success) {
      resolvedLeaderboardId = lb.data.id;
    }
  } catch {
    // Leaderboard setup failed — scores won't submit but game still works
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

export async function submitScore(score: number) {
  const wavedash = getWavedashSdkSync();
  if (!wavedash || !resolvedLeaderboardId) {
    return;
  }

  await wavedash.uploadLeaderboardScore(resolvedLeaderboardId, score, true);
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

export type { WavedashSdk, YoutubePlayablesSdk };
