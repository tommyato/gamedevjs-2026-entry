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
  var WavedashJS: WavedashSdk | undefined;
  var ytgame: YoutubePlayablesSdk | undefined;

  interface Window {
    WavedashJS?: WavedashSdk;
    ytgame?: YoutubePlayablesSdk;
  }
}

const DEFAULT_USERNAME = "Player";
const DEFAULT_SAVE_KEY = "gameSave";
const LEADERBOARD_SLUG = "high-score";
let resolvedLeaderboardId: string | null = null;

function hasWavedash(): boolean {
  return typeof WavedashJS !== "undefined";
}

function hasYoutubePlayables(): boolean {
  return typeof ytgame !== "undefined";
}

function getWavedashSdk(): WavedashSdk | null {
  if (!hasWavedash()) {
    return null;
  }

  return WavedashJS ?? null;
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
  const wavedash = getWavedashSdk();
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
  const wavedash = getWavedashSdk();
  if (!wavedash) {
    return DEFAULT_USERNAME;
  }

  const user = wavedash.getUser();
  return user?.username ?? DEFAULT_USERNAME;
}

export async function submitScore(score: number) {
  const wavedash = getWavedashSdk();
  if (!wavedash || !resolvedLeaderboardId) {
    return;
  }

  await wavedash.uploadLeaderboardScore(resolvedLeaderboardId, score, true);
}

export function signalLoadComplete() {
  if (typeof window === "undefined" || typeof window.WavedashJS === "undefined") {
    return;
  }

  window.WavedashJS.loadComplete();
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

export type { WavedashSdk, YoutubePlayablesSdk };
