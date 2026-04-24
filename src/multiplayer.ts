import {
  addMultiplayerListener,
  broadcastMessage,
  checkLaunchLobby,
  createMultiplayerLobby,
  getLobbyHostId,
  getInviteLink,
  getLobbyUserCount,
  getLobbyUsers,
  getMultiplayerEvents,
  isMultiplayerAvailable,
  joinMultiplayerLobby,
  leaveMultiplayerLobby,
  readPeerMessages,
} from "./platform";

import {
  type MatchResult,
  type MatchState,
  type TypedMessage,
  decodeMessage,
  encodeDied,
  encodeFinished,
  encodeMatchStart,
  encodeNameUpdate,
  encodeState,
} from "./protocol";

export type { MatchResult, MatchState };

// ── Peer ghost ────────────────────────────────────────────────────────────────

export type PeerMatchProgress = {
  dead?: { score: number; height: number };
  finished?: { ms: number; score: number; height: number };
};

export type PeerGhost = {
  userId: string;
  username: string;
  x: number;
  y: number;
  z: number;
  height: number;
  score: number;
  combo: number;
  onGround: boolean;
  lastUpdate: number;
  prevX: number;
  prevY: number;
  prevZ: number;
  prevUpdate: number;
  matchProgress: PeerMatchProgress;
};

// ── Callbacks ─────────────────────────────────────────────────────────────────

type MultiplayerCallbacks = {
  onMatchStart?: (startAtMs: number, matchId: number) => void;
  onPeerDied?: (userId: string) => void;
  onPeerFinished?: (userId: string) => void;
  onMatchEnded?: (results: MatchResult[]) => void;
  onLobbyCancelled?: () => void;
};

// ── Constants ─────────────────────────────────────────────────────────────────

const BROADCAST_INTERVAL = 1 / 10; // 10 Hz
const PEER_TIMEOUT_SECONDS = 5;
/** Countdown duration sent with MATCH_START. Session 4 will make this configurable. */
const DEFAULT_COUNTDOWN_MS = 3500;
/** Seconds host must be absent from lobby + peers before firing onLobbyCancelled. */
const HOST_ABSENT_THRESHOLD = 5;

// ── Manager ───────────────────────────────────────────────────────────────────

export class MultiplayerManager {
  private lobbyId: string | null = null;
  private peers: Map<string, PeerGhost> = new Map();
  /** Pending match-progress updates for peers not yet seen via STATE. */
  private pendingProgress: Map<string, PeerMatchProgress> = new Map();
  private broadcastTimer = 0;
  private clock = 0;
  private connectedListenerBound = false;

  // Match state machine
  private matchState: MatchState = "lobby";
  private currentMatchId = 0;
  private lastMatchId = 0;

  // Host tracking
  private hostSelf = false;
  private hostUserId: string | null = null;
  private hostAbsentTimer = 0;

  /** Set when peer sends a message with a different protocol version. */
  private _protocolVersionMismatch = false;

  private callbacks: MultiplayerCallbacks = {};

  // ── Callback registration ──────────────────────────────────────────────────

  setCallbacks(cbs: MultiplayerCallbacks): void {
    this.callbacks = { ...this.callbacks, ...cbs };
  }

  // ── Match state getters ────────────────────────────────────────────────────

  getMatchState(): MatchState {
    return this.matchState;
  }

  getCurrentMatchId(): number {
    return this.currentMatchId;
  }

  isHost(): boolean {
    return this.hostSelf;
  }

  hasProtocolVersionMismatch(): boolean {
    return this._protocolVersionMismatch;
  }

  // ── Host-only API ──────────────────────────────────────────────────────────

  /**
   * Initiates a match. Host-only — no-op if called on a non-host client.
   * Assigns a fresh matchId, broadcasts MATCH_START (reliable), transitions
   * local state to "countdown", and fires onMatchStart on the host side.
   *
   * Countdown duration is DEFAULT_COUNTDOWN_MS; Session 4 will expose it.
   */
  startMatch(): void {
    if (!this.isActive() || !this.hostSelf) return;
    const now = Date.now();
    // Use lower 32 bits of epoch ms as matchId — monotonically increasing
    // within a ~50-day window, which is sufficient for multiplayer sessions.
    this.currentMatchId = now >>> 0;
    broadcastMessage(true, encodeMatchStart(DEFAULT_COUNTDOWN_MS, this.currentMatchId));
    this.matchState = "countdown";
    this.callbacks.onMatchStart?.(now + DEFAULT_COUNTDOWN_MS, this.currentMatchId);
  }

  // ── Local event broadcasts ─────────────────────────────────────────────────

  /**
   * Broadcasts DIED (reliable) for the local player. Call from finishGame()
   * when the player dies during a multiplayer match.
   */
  notifyDied(score: number, height: number): void {
    if (!this.isActive()) return;
    broadcastMessage(true, encodeDied(this.currentMatchId, score, height));
  }

  /**
   * Broadcasts FINISHED (reliable) when the local player reaches the finish
   * height. Call when the player crosses 100 m during a multiplayer match.
   */
  notifyFinished(finishMs: number, score: number, height: number): void {
    if (!this.isActive()) return;
    broadcastMessage(true, encodeFinished(this.currentMatchId, finishMs, score, height));
  }

  /** Broadcasts NAME_UPDATE (reliable) when the local display name changes. */
  sendNameUpdate(name: string): void {
    if (!this.isActive()) return;
    broadcastMessage(true, encodeNameUpdate(name));
  }

  // ── Per-tick update ────────────────────────────────────────────────────────

  update(
    dt: number,
    playerX: number,
    playerY: number,
    playerZ: number,
    height: number,
    score: number,
    combo: number,
    onGround: boolean
  ): void {
    if (!this.isActive()) return;
    this.clock += dt;

    this.broadcastTimer += dt;
    if (this.broadcastTimer >= BROADCAST_INTERVAL) {
      this.broadcastTimer = 0;
      broadcastMessage(false, encodeState(playerX, playerY, playerZ, height, score, combo, onGround));
    }

    this.drainInbound();
    this.tickHostDisconnect(dt);
  }

  /**
   * Drains inbound messages and ticks host-disconnect detection without
   * broadcasting state. Use on title/game-over screens so peer counts stay
   * fresh without emitting a bogus (0,0,0) position.
   */
  pollPeers(dt: number): void {
    if (!this.isActive()) return;
    this.clock += dt;
    this.drainInbound();
    this.tickHostDisconnect(dt);
  }

  // ── Inbound message handling ───────────────────────────────────────────────

  private drainInbound(): void {
    for (const message of readPeerMessages()) {
      const msg = decodeMessage(message.payload);
      if (!msg) continue;
      const uid = message.fromUserId;

      if (msg.type === "state") {
        this.handleState(uid, msg);
      } else if (msg.type === "match_start") {
        this.handleMatchStart(uid, msg);
      } else if (msg.type === "died") {
        this.handleDied(uid, msg);
      } else if (msg.type === "finished") {
        this.handleFinished(uid, msg);
      } else if (msg.type === "name_update") {
        this.handleNameUpdate(uid, msg);
      }
      // ready_toggle: Session 3 will consume
    }

    // Remove stale peers (no STATE received within timeout window)
    for (const [userId, peer] of this.peers) {
      if (this.clock - peer.lastUpdate > PEER_TIMEOUT_SECONDS) {
        this.peers.delete(userId);
      }
    }
  }

  private handleState(
    uid: string,
    msg: TypedMessage & { type: "state" }
  ): void {
    const existing = this.peers.get(uid);
    if (existing) {
      existing.prevX = existing.x;
      existing.prevY = existing.y;
      existing.prevZ = existing.z;
      existing.prevUpdate = existing.lastUpdate;
      existing.x = msg.x;
      existing.y = msg.y;
      existing.z = msg.z;
      existing.height = msg.height;
      existing.score = msg.score;
      existing.combo = msg.combo;
      existing.onGround = msg.onGround;
      existing.lastUpdate = this.clock;
    } else {
      const username = this.resolveUsername(uid);
      const pending = this.pendingProgress.get(uid);
      this.peers.set(uid, {
        userId: uid,
        username,
        x: msg.x,
        y: msg.y,
        z: msg.z,
        height: msg.height,
        score: msg.score,
        combo: msg.combo,
        onGround: msg.onGround,
        lastUpdate: this.clock,
        prevX: msg.x,
        prevY: msg.y,
        prevZ: msg.z,
        prevUpdate: this.clock,
        matchProgress: pending ?? {},
      });
      if (pending) this.pendingProgress.delete(uid);
    }
  }

  private handleMatchStart(
    uid: string,
    msg: TypedMessage & { type: "match_start" }
  ): void {
    // Reject from unexpected senders when host is known
    if (this.hostUserId && uid !== this.hostUserId) return;
    // Monotonic guard: reject duplicate/stale match ids
    if (this.lastMatchId > 0 && msg.matchId <= this.lastMatchId) return;
    this.lastMatchId = msg.matchId;
    this.currentMatchId = msg.matchId;
    this.matchState = "countdown";
    this.callbacks.onMatchStart?.(Date.now() + msg.startMsRel, msg.matchId);
  }

  private handleDied(
    uid: string,
    msg: TypedMessage & { type: "died" }
  ): void {
    if (msg.matchId !== this.currentMatchId) return;
    const peer = this.peers.get(uid);
    if (peer) {
      if (!peer.matchProgress.dead) {
        peer.matchProgress.dead = { score: msg.score, height: msg.height };
      }
    } else {
      const prog = this.pendingProgress.get(uid) ?? {};
      prog.dead = prog.dead ?? { score: msg.score, height: msg.height };
      this.pendingProgress.set(uid, prog);
    }
    this.callbacks.onPeerDied?.(uid);
  }

  private handleFinished(
    uid: string,
    msg: TypedMessage & { type: "finished" }
  ): void {
    if (msg.matchId !== this.currentMatchId) return;
    const peer = this.peers.get(uid);
    if (peer) {
      if (!peer.matchProgress.finished) {
        peer.matchProgress.finished = { ms: msg.finishMs, score: msg.score, height: msg.height };
      }
    } else {
      const prog = this.pendingProgress.get(uid) ?? {};
      prog.finished = prog.finished ?? { ms: msg.finishMs, score: msg.score, height: msg.height };
      this.pendingProgress.set(uid, prog);
    }
    this.callbacks.onPeerFinished?.(uid);
  }

  private handleNameUpdate(
    uid: string,
    msg: TypedMessage & { type: "name_update" }
  ): void {
    const peer = this.peers.get(uid);
    if (peer) peer.username = msg.name;
  }

  // ── Host disconnect detection ──────────────────────────────────────────────

  private tickHostDisconnect(dt: number): void {
    // Only run on non-host clients in lobby state with a known host
    if (this.hostSelf || this.matchState !== "lobby" || !this.lobbyId || !this.hostUserId) return;

    const users = getLobbyUsers(this.lobbyId);
    const hostPresent =
      users.some((u) => u.userId === this.hostUserId) ||
      this.peers.has(this.hostUserId!);

    if (!hostPresent) {
      this.hostAbsentTimer += dt;
      if (this.hostAbsentTimer >= HOST_ABSENT_THRESHOLD) {
        // Clear to prevent re-firing
        this.hostUserId = null;
        this.hostAbsentTimer = 0;
        this.callbacks.onLobbyCancelled?.();
      }
    } else {
      this.hostAbsentTimer = 0;
    }
  }

  // ── Lobby lifecycle ────────────────────────────────────────────────────────

  async createLobby(): Promise<string | null> {
    if (!isMultiplayerAvailable()) return null;
    this.ensureListeners();
    const id = await createMultiplayerLobby();
    if (id) {
      this.lobbyId = id;
      this.hostSelf = true;
      this.hostUserId = null; // SDK doesn't expose our own userId
      this.peers.clear();
      this.pendingProgress.clear();
      this.broadcastTimer = 0;
      this.matchState = "lobby";
    }
    return id;
  }

  async joinLobby(lobbyId: string): Promise<boolean> {
    if (!isMultiplayerAvailable()) return false;
    this.ensureListeners();
    const ok = await joinMultiplayerLobby(lobbyId);
    if (ok) {
      this.lobbyId = lobbyId;
      this.hostSelf = false;
      this.hostUserId = getLobbyHostId(lobbyId);
      this.peers.clear();
      this.pendingProgress.clear();
      this.broadcastTimer = 0;
      this.matchState = "lobby";
    }
    return ok;
  }

  async leaveLobby(): Promise<void> {
    if (!this.lobbyId) return;
    const id = this.lobbyId;
    this.lobbyId = null;
    this.peers.clear();
    this.pendingProgress.clear();
    this.broadcastTimer = 0;
    this.matchState = "lobby";
    this.hostSelf = false;
    this.hostUserId = null;
    this.currentMatchId = 0;
    this.lastMatchId = 0;
    this.hostAbsentTimer = 0;
    this._protocolVersionMismatch = false;
    await leaveMultiplayerLobby(id);
  }

  // ── Accessors ──────────────────────────────────────────────────────────────

  getPeers(): PeerGhost[] {
    return Array.from(this.peers.values());
  }

  getClock(): number {
    return this.clock;
  }

  async getInviteLink(): Promise<string | null> {
    if (!this.lobbyId) return null;
    return getInviteLink();
  }

  checkLaunchLobby(): string | null {
    if (!isMultiplayerAvailable()) return null;
    return checkLaunchLobby();
  }

  getLobbyId(): string | null {
    return this.lobbyId;
  }

  getLobbyMemberCount(): number {
    if (!this.lobbyId) return 0;
    const count = getLobbyUserCount(this.lobbyId);
    return count > 0 ? count : 1;
  }

  isActive(): boolean {
    return this.lobbyId !== null;
  }

  isAvailable(): boolean {
    return isMultiplayerAvailable();
  }

  getPeerCount(): number {
    return this.peers.size;
  }

  /**
   * Returns a deterministic 32-bit unsigned integer seed derived from the
   * current lobby id. Every peer in the same lobby hashes the same lobby id
   * to the same value, so the tower layout is synchronized without a
   * seed-broadcast round-trip. Returns null when no lobby is active.
   *
   * Uses FNV-1a 32-bit — pure, deterministic, dependency-free.
   */
  getSyncedSeed(): number | null {
    if (!this.lobbyId) return null;
    let hash = 0x811c9dc5;
    for (let i = 0; i < this.lobbyId.length; i++) {
      hash ^= this.lobbyId.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193);
    }
    return hash >>> 0;
  }

  // ── Internal ───────────────────────────────────────────────────────────────

  private resolveUsername(userId: string): string {
    if (!this.lobbyId) return userId;
    const users = getLobbyUsers(this.lobbyId);
    const match = users.find((user) => user.userId === userId);
    return match?.username ?? userId;
  }

  private ensureListeners(): void {
    if (this.connectedListenerBound) return;
    const events = getMultiplayerEvents();
    const connectedEvent = events.P2P_CONNECTION_ESTABLISHED ?? "p2p_connection_established";
    addMultiplayerListener(connectedEvent, (_event: unknown) => {
      // When a new peer connects, immediately push our broadcast so they see us
      // without waiting for the next 100 ms tick.
      this.broadcastTimer = BROADCAST_INTERVAL;
    });
    this.connectedListenerBound = true;
  }
}
