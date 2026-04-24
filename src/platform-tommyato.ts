/**
 * Tommyato (own-droplet) implementation of `IPlatformServices`.
 *
 *   - localStorage saves / achievements / stats (with a one-shot username prompt)
 *   - HTTP leaderboards against api.tommyato.com (SQLite-backed)
 *   - Colyseus client → IMultiplayerTransport shim that emits PeerMessage callbacks
 *
 * Selected at build time when `VITE_PLATFORM=tommyato`. The dynamic-import
 * factory in `platform-services.ts` ensures this module (and `colyseus.js`)
 * are dead code in the wavedash bundle and tree-shake out.
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
import { Client, type Room } from "colyseus.js";

// ──────────────────────────────────────────────────────────────────────────────
// Constants
// ──────────────────────────────────────────────────────────────────────────────

const API_BASE_URL = "https://api.tommyato.com";
const MP_ENDPOINT = "wss://mp.tommyato.com";
// Server registers the room under "climb-race" (see server/cc-mp/index.ts).
// The Phase-3 task description called it "climb_race" — documentation drift;
// the deployed/frozen server is the source of truth, so we match it here.
const ROOM_NAME = "climb-race";
const LEADERBOARD_LIMIT = 100;
const HTTP_TIMEOUT_MS = 5000;

const STORAGE_KEYS = {
  username: "cc.tommyato.username",
  userId: "cc.tommyato.userId",
  save: "cc.tommyato.save",
  stats: "cc.tommyato.stats",
} as const;

const DEFAULT_USERNAME = "Climber";

const EVENT_NAMES: Record<string, string> = {
  P2P_CONNECTION_ESTABLISHED: "p2p_connection_established",
  P2P_CONNECTION_LOST: "p2p_connection_lost",
};

// ──────────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────────

function getStorage(): Storage | null {
  try {
    if (typeof window === "undefined" || typeof window.localStorage === "undefined") {
      return null;
    }
    return window.localStorage;
  } catch {
    return null;
  }
}

function readStats(): Record<string, number> {
  const storage = getStorage();
  if (!storage) return {};
  try {
    const raw = storage.getItem(STORAGE_KEYS.stats);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const out: Record<string, number> = {};
      for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
        if (typeof v === "number" && Number.isFinite(v)) out[k] = v;
      }
      return out;
    }
    return {};
  } catch {
    return {};
  }
}

function writeStats(stats: Record<string, number>): void {
  const storage = getStorage();
  if (!storage) return;
  try {
    storage.setItem(STORAGE_KEYS.stats, JSON.stringify(stats));
  } catch {
    // ignore quota / serialization failures
  }
}

function bytesToBase64(bytes: Uint8Array): string {
  // Avoid String.fromCharCode(...big) RangeError by chunking.
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

async function postJson(path: string, body: unknown): Promise<unknown | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
  try {
    const response = await fetch(`${API_BASE_URL}${path}`, {
      method: "POST",
      mode: "cors",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!response.ok) return null;
    return await response.json().catch(() => null);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function getJson(path: string): Promise<unknown | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
  try {
    const response = await fetch(`${API_BASE_URL}${path}`, {
      method: "GET",
      mode: "cors",
      signal: controller.signal,
    });
    if (!response.ok) return null;
    return await response.json().catch(() => null);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// TommyatoPlatform
// ──────────────────────────────────────────────────────────────────────────────

export class TommyatoPlatform implements IPlatformServices {
  readonly multiplayer: IMultiplayerTransport;
  private cachedUsername: string | null = null;

  constructor() {
    this.multiplayer = new TommyatoMultiplayerTransport(() => this.getUsername());
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  async init(): Promise<void> {
    // Ensure we have a stable userId; lazy-prompt for username on first
    // getUsername() call so init() doesn't block on a modal.
    const storage = getStorage();
    if (storage && !storage.getItem(STORAGE_KEYS.userId)) {
      try {
        const id =
          typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
            ? crypto.randomUUID()
            : `anon-${Date.now()}-${Math.random().toString(36).slice(2)}`;
        storage.setItem(STORAGE_KEYS.userId, id);
      } catch {
        // ignore
      }
    }
  }

  async signalLoadComplete(): Promise<void> {
    // No host SDK; nothing to signal.
  }

  signalFirstFrame(): void {
    // No host SDK; nothing to signal.
  }

  signalGameReady(): void {
    // No host SDK; nothing to signal.
  }

  // ── Identity ──────────────────────────────────────────────────────────────

  /** Player can edit their name locally — prompt logic implemented by Phase 3 worker. */
  readonly canEditUsername = true;

  getUsername(): string {
    if (this.cachedUsername !== null) return this.cachedUsername;
    const storage = getStorage();
    if (!storage) {
      this.cachedUsername = DEFAULT_USERNAME;
      return DEFAULT_USERNAME;
    }

    const existing = storage.getItem(STORAGE_KEYS.username);
    if (existing && existing.trim().length > 0) {
      this.cachedUsername = existing;
      return existing;
    }

    // First run — prompt once. If dismissed/empty, fall back to default and
    // persist it so we don't re-prompt on every call.
    let chosen = DEFAULT_USERNAME;
    try {
      if (typeof window !== "undefined" && typeof window.prompt === "function") {
        const answer = window.prompt("Pick a display name:", "Climber");
        if (answer && answer.trim().length > 0) {
          chosen = answer.trim().slice(0, 32);
        }
      }
    } catch {
      // prompt blocked / unavailable — use default
    }

    try {
      storage.setItem(STORAGE_KEYS.username, chosen);
    } catch {
      // ignore
    }
    this.cachedUsername = chosen;
    return chosen;
  }

  // ── Saves ─────────────────────────────────────────────────────────────────

  async loadSaveData(): Promise<string | null> {
    const storage = getStorage();
    if (!storage) return null;
    try {
      return storage.getItem(STORAGE_KEYS.save);
    } catch {
      return null;
    }
  }

  async writeSaveData(data: string): Promise<void> {
    const storage = getStorage();
    if (!storage) return;
    try {
      storage.setItem(STORAGE_KEYS.save, data);
    } catch {
      // ignore quota failures
    }
  }

  // ── Leaderboards ──────────────────────────────────────────────────────────

  async submitScores(input: RunScores, username?: string): Promise<void> {
    const name = (username ?? this.getUsername()) || DEFAULT_USERNAME;
    await Promise.allSettled([
      postJson(`/games/clockwork-climb/leaderboards/high-score`, { username: name, score: input.score }),
      postJson(`/games/clockwork-climb/leaderboards/highest-climb`, { username: name, score: input.height }),
      postJson(`/games/clockwork-climb/leaderboards/best-combo`, { username: name, score: input.combo }),
    ]);
  }

  async submitDailyScore(score: number, username?: string): Promise<void> {
    const name = (username ?? this.getUsername()) || DEFAULT_USERNAME;
    await postJson(`/games/clockwork-climb/leaderboards/daily-score`, { username: name, score });
  }

  async fetchLeaderboardScores(slug: LeaderboardSlug = "high-score"): Promise<LeaderboardEntry[]> {
    const response = await getJson(
      `/games/clockwork-climb/leaderboards/${slug}?limit=${LEADERBOARD_LIMIT}`
    );
    if (!Array.isArray(response)) return [];
    const entries: LeaderboardEntry[] = [];
    for (let i = 0; i < response.length; i++) {
      const raw = response[i] as Record<string, unknown> | null | undefined;
      if (!raw || typeof raw !== "object") continue;
      const username = typeof raw.username === "string" && raw.username.length > 0
        ? raw.username
        : DEFAULT_USERNAME;
      const score = typeof raw.score === "number" && Number.isFinite(raw.score) ? raw.score : Number.NaN;
      if (!Number.isFinite(score)) continue;
      entries.push({
        username,
        score: Math.max(0, Math.floor(score)),
        rank: i + 1,
      });
    }
    return entries;
  }

  // ── Achievements ──────────────────────────────────────────────────────────

  unlockAchievement(id: string): boolean {
    const storage = getStorage();
    if (!storage) return false;
    const key = `ach_${id}`;
    try {
      if (storage.getItem(key)) return false;
      storage.setItem(key, "1");
      return true;
    } catch {
      return false;
    }
  }

  hasAchievement(id: string): boolean {
    const storage = getStorage();
    if (!storage) return false;
    try {
      if (storage.getItem(`ach_${id}`) === "1") return true;
      if (storage.getItem(`ach_${id.toUpperCase()}`) === "1") return true;
      if (storage.getItem(`ach_${id.toLowerCase()}`) === "1") return true;
      return false;
    } catch {
      return false;
    }
  }

  listAchievementProgress(): AchievementProgress[] {
    return achievementCatalog.achievements.map((entry) => ({
      id: entry.identifier,
      displayName: entry.display_name,
      description: entry.description,
      unlocked: this.hasAchievement(entry.identifier),
    }));
  }

  // ── Stats ─────────────────────────────────────────────────────────────────

  updateStat(id: string, value: number): void {
    if (!Number.isFinite(value)) return;
    const stats = readStats();
    stats[id] = value;
    writeStats(stats);
  }

  getStat(id: string): number {
    const stats = readStats();
    const value = stats[id];
    return typeof value === "number" && Number.isFinite(value) ? value : 0;
  }

  async requestStats(): Promise<{ success: boolean }> {
    // Yield a microtask so callers awaiting this don't get a synchronous resolve.
    await Promise.resolve();
    return { success: true };
  }

  storeStats(): void {
    // Stats are written through on every updateStat — nothing to flush.
  }

  // ── Pause / audio ─────────────────────────────────────────────────────────

  registerPauseHandlers(onPause: () => void, onResume: () => void): void {
    if (typeof document === "undefined") return;
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) onPause();
      else onResume();
    });
  }

  isAudioEnabled(): boolean {
    return true;
  }

  onAudioChange(_callback: (enabled: boolean) => void): void {
    // No host audio integration.
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// TommyatoMultiplayerTransport
// ──────────────────────────────────────────────────────────────────────────────

type IncomingPeer = { from: string; reliable: boolean; data: string };

class TommyatoMultiplayerTransport implements IMultiplayerTransport {
  private client: Client | null = null;
  private room: Room | null = null;
  private inbound: PeerMessage[] = [];
  private listeners: Map<string, Array<(e: unknown) => void>> = new Map();
  private peerSessionIds: Set<string> = new Set();

  constructor(private readonly nameProvider: () => string) {}

  isAvailable(): boolean {
    return true;
  }

  // ── Internal ──────────────────────────────────────────────────────────────

  private ensureClient(): Client {
    if (!this.client) {
      this.client = new Client(MP_ENDPOINT);
    }
    return this.client;
  }

  private fireListeners(event: string, payload: unknown): void {
    const arr = this.listeners.get(event);
    if (!arr) return;
    for (const cb of arr) {
      try {
        cb(payload);
      } catch {
        // listener errors must not break our event loop
      }
    }
  }

  private async waitForFirstState(room: Room): Promise<void> {
    // Race the first onStateChange against a short timeout — if state already
    // arrived by the time we attach, the schema decoder fires synchronously
    // on the next tick anyway.
    if (room.state && (room.state as { players?: { size: number } }).players?.size) {
      return;
    }
    await new Promise<void>((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        resolve();
      };
      try {
        room.onStateChange.once(() => finish());
      } catch {
        finish();
        return;
      }
      setTimeout(finish, 1500);
    });
  }

  private bindRoom(room: Room): void {
    this.room = room;
    this.inbound = [];
    this.peerSessionIds.clear();

    room.onMessage("peer", (payload: IncomingPeer) => {
      if (!payload || typeof payload.data !== "string") return;
      try {
        const bytes = base64ToBytes(payload.data);
        this.inbound.push({ fromUserId: payload.from, payload: bytes });
      } catch {
        // malformed payload — drop
      }
    });

    const players = (room.state as { players?: ColyseusMapLike }).players;
    if (players && typeof players.onAdd === "function") {
      // Skip self on initial trigger so we only synthesize connect events for
      // *peers*. Existing peers still fire onAdd because triggerAll defaults
      // to true on attach — which is exactly what we want for late joiners.
      players.onAdd((_player, sessionId: string) => {
        if (sessionId === room.sessionId) return;
        if (this.peerSessionIds.has(sessionId)) return;
        this.peerSessionIds.add(sessionId);
        this.fireListeners(EVENT_NAMES.P2P_CONNECTION_ESTABLISHED, { userId: sessionId });
      });
    }
    if (players && typeof players.onRemove === "function") {
      players.onRemove((_player, sessionId: string) => {
        this.peerSessionIds.delete(sessionId);
        this.fireListeners(EVENT_NAMES.P2P_CONNECTION_LOST, { userId: sessionId });
      });
    }

    room.onLeave(() => {
      if (this.room === room) {
        this.room = null;
        this.inbound = [];
        this.peerSessionIds.clear();
      }
    });
  }

  // ── Lobby lifecycle ───────────────────────────────────────────────────────

  async createLobby(): Promise<string | null> {
    try {
      const room = await this.ensureClient().create(ROOM_NAME, { name: this.nameProvider() });
      this.bindRoom(room);
      await this.waitForFirstState(room);
      return room.roomId;
    } catch {
      return null;
    }
  }

  async joinLobby(lobbyId: string): Promise<boolean> {
    try {
      const room = await this.ensureClient().joinById(lobbyId, { name: this.nameProvider() });
      this.bindRoom(room);
      await this.waitForFirstState(room);
      return true;
    } catch {
      return false;
    }
  }

  async leaveLobby(_lobbyId: string): Promise<void> {
    const room = this.room;
    this.room = null;
    this.inbound = [];
    this.peerSessionIds.clear();
    if (!room) return;
    try {
      await room.leave();
    } catch {
      // already gone
    }
  }

  // ── Messaging ─────────────────────────────────────────────────────────────

  broadcast(reliable: boolean, data: Uint8Array): void {
    const room = this.room;
    if (!room) return;
    try {
      room.send("peer", { reliable, data: bytesToBase64(data) });
    } catch {
      // drop silently
    }
  }

  readPeerMessages(): PeerMessage[] {
    if (this.inbound.length === 0) return [];
    const drained = this.inbound;
    this.inbound = [];
    return drained;
  }

  // ── Invites / launch ──────────────────────────────────────────────────────

  async getInviteLink(): Promise<string | null> {
    const room = this.room;
    if (!room || typeof location === "undefined") return null;
    return `${location.origin}${location.pathname}?room=${encodeURIComponent(room.roomId)}`;
  }

  checkLaunchLobby(): string | null {
    if (typeof location === "undefined") return null;
    try {
      const params = new URLSearchParams(location.search);
      const id = params.get("room");
      return id && id.length > 0 ? id : null;
    } catch {
      return null;
    }
  }

  // ── Identity / roster ─────────────────────────────────────────────────────

  getMyUserId(): string | null {
    return this.room?.sessionId ?? null;
  }

  getLobbyUsers(_lobbyId: string): LobbyUser[] {
    const room = this.room;
    if (!room) return [];
    const players = (room.state as { players?: ColyseusMapLike }).players;
    if (!players || typeof players.forEach !== "function") return [];
    const out: LobbyUser[] = [];
    players.forEach((player, sessionId) => {
      const name =
        player && typeof (player as { name?: unknown }).name === "string"
          ? ((player as { name: string }).name)
          : DEFAULT_USERNAME;
      out.push({ userId: sessionId, username: name || DEFAULT_USERNAME });
    });
    return out;
  }

  getLobbyHostId(lobbyId: string): string | null {
    const users = this.getLobbyUsers(lobbyId);
    return users[0]?.userId ?? null;
  }

  getLobbyUserCount(_lobbyId: string): number {
    const room = this.room;
    if (!room) return 0;
    const players = (room.state as { players?: { size?: number } }).players;
    return typeof players?.size === "number" ? players.size : 0;
  }

  // ── Event listeners ───────────────────────────────────────────────────────

  addEventListener(event: string, callback: (e: unknown) => void): void {
    const list = this.listeners.get(event) ?? [];
    list.push(callback);
    this.listeners.set(event, list);
  }

  getEvents(): Record<string, string> {
    return { ...EVENT_NAMES };
  }
}

// Minimal structural type for the bits we touch on Colyseus' MapSchema. Avoids
// importing @colyseus/schema directly (it isn't a runtime dep of the client
// module surface, and pulling its types in adds bundle weight).
interface ColyseusMapLike {
  size: number;
  onAdd?: (cb: (item: unknown, key: string) => void, triggerAll?: boolean) => unknown;
  onRemove?: (cb: (item: unknown, key: string) => void) => unknown;
  forEach: (cb: (value: unknown, key: string) => void) => void;
}
