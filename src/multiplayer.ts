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
  getMyUserId,
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
  onCountdownComplete?: () => void;
  onPeerDied?: (userId: string) => void;
  onPeerFinished?: (userId: string) => void;
  onMatchEnded?: (results: MatchResult[]) => void;
  onLobbyCancelled?: () => void;
  /** Fired when a peer's STATE stream times out and they are removed from the
   *  peers map. Fires for both lobby and in-match departures. The game layer
   *  uses this to refresh the player list and detect host-gone-mid-match. */
  onPeerLeft?: (userId: string) => void;
};

// ── Constants ─────────────────────────────────────────────────────────────────

/** Seconds between STATE broadcasts. Exported so the render-side interpolator
 *  can use the same value as the render-behind delay for pure interpolation. */
export const BROADCAST_INTERVAL_SECONDS = 1 / 20; // 20 Hz
const BROADCAST_INTERVAL = BROADCAST_INTERVAL_SECONDS;
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
  /** Absolute wall-clock ms at which the match starts. Set in enterCountdown(). */
  private localStartAt = 0;

  // End-of-match state — reset by enterCountdown() and resetForNextMatch()
  private localDead = false;
  private localFinishedFlag = false;
  private localFinishMs = 0;
  private localScore = 0;
  private localHeight = 0;
  private localName = "Player";
  /** Absolute ms when the first FINISHED (local or peer) arrived. Drives grace timer. */
  private firstFinisherGraceStart: number | null = null;
  /** Guards fireMatchEnd() from firing more than once per match. */
  private matchEndFired = false;
  /** Peers that disconnected mid-match, in disconnection order. */
  private readonly dnfPeers: Array<{ userId: string; username: string; score: number; height: number }> = [];

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

  /** Returns the absolute wall-clock ms at which the current match started. */
  getLocalStartAt(): number {
    return this.localStartAt;
  }

  /** Sets the display name used for the local player in match results. */
  setLocalName(name: string): void {
    this.localName = name;
  }

  getCurrentMatchId(): number {
    return this.currentMatchId;
  }

  isHost(): boolean {
    return this.hostSelf;
  }

  /**
   * Returns milliseconds until the match starts, clamped to ≥ 0.
   * Returns null when not in 'countdown' state.
   */
  getCountdownMsRemaining(): number | null {
    if (this.matchState !== "countdown") return null;
    return Math.max(0, this.localStartAt - Date.now());
  }

  hasProtocolVersionMismatch(): boolean {
    return this._protocolVersionMismatch;
  }

  // ── Host-only API ──────────────────────────────────────────────────────────

  /**
   * Initiates a match. Host-only — no-op if called on a non-host client or
   * if the match has already left the lobby state (double-click guard).
   * Assigns a fresh matchId, broadcasts MATCH_START (reliable), then calls
   * enterCountdown() which transitions state and fires onMatchStart.
   */
  startMatch(): void {
    if (!this.isActive() || !this.hostSelf) return;
    if (this.matchState !== "lobby") return;
    const now = Date.now();
    // Use lower 32 bits of epoch ms as matchId — monotonically increasing
    // within a ~50-day window, which is sufficient for multiplayer sessions.
    const matchId = now >>> 0;
    this.lastMatchId = matchId;
    broadcastMessage(true, encodeMatchStart(DEFAULT_COUNTDOWN_MS, matchId));
    this.enterCountdown(now + DEFAULT_COUNTDOWN_MS, matchId);
  }

  // ── Shared countdown entry ─────────────────────────────────────────────────

  /**
   * Common path for entering countdown state, called by both the host (from
   * startMatch) and non-host peers (from handleMatchStart). Sets localStartAt,
   * advances the state machine, and fires onMatchStart.
   */
  private enterCountdown(startAtMs: number, matchId: number): void {
    this.currentMatchId = matchId;
    this.localStartAt = startAtMs;
    this.matchState = "countdown";
    // Reset end-of-match state for the new match
    this.localDead = false;
    this.localFinishedFlag = false;
    this.localFinishMs = 0;
    this.firstFinisherGraceStart = null;
    this.matchEndFired = false;
    this.dnfPeers.length = 0;
    this.callbacks.onMatchStart?.(startAtMs, matchId);
  }

  // ── Local event broadcasts ─────────────────────────────────────────────────

  /**
   * Broadcasts DIED (reliable) for the local player. Call from finishGame()
   * when the player dies during a multiplayer match.
   */
  notifyDied(score: number, height: number): void {
    if (!this.isActive()) return;
    this.localDead = true;
    broadcastMessage(true, encodeDied(this.currentMatchId, score, height));
  }

  /**
   * Broadcasts FINISHED (reliable) when the local player reaches the finish
   * height. Call when the player crosses 100 m during a multiplayer match.
   */
  notifyFinished(finishMs: number, score: number, height: number): void {
    if (!this.isActive()) return;
    this.localFinishedFlag = true;
    this.localFinishMs = finishMs;
    // Local player is the first finisher — start grace timer if not already running.
    if (this.firstFinisherGraceStart === null) {
      this.firstFinisherGraceStart = Date.now();
    }
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

    // Keep local snapshot current for end-of-match result building.
    this.localScore = score;
    this.localHeight = height;

    this.broadcastTimer += dt;
    if (this.broadcastTimer >= BROADCAST_INTERVAL) {
      this.broadcastTimer = 0;
      broadcastMessage(false, encodeState(playerX, playerY, playerZ, height, score, combo, onGround));
    }

    this.drainInbound();
    this.tickHostDisconnect(dt);
    this.tickCountdown();
    this.tickMatchEnd();
  }

  /**
   * Drains inbound messages and ticks host-disconnect detection without
   * broadcasting state. Use on title/game-over screens so peer counts stay
   * fresh without emitting a bogus (0,0,0) position.
   * Also ticks the match-end resolver so that even if the local player has
   * died (and is in GameOver state), the match can still end via timer or
   * all-dead paths.
   */
  pollPeers(dt: number): void {
    if (!this.isActive()) return;
    this.clock += dt;
    this.drainInbound();
    this.tickHostDisconnect(dt);
    this.tickMatchEnd();
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

    // Remove stale peers (no STATE received within timeout window).
    // edge: peer disconnects mid-match — marked DNF, race continues.
    // edge: host disconnects mid-match — same prune path; onPeerLeft fires so
    //       the game layer can show a "match continues" toast (see game.ts).
    for (const [userId, peer] of this.peers) {
      if (this.clock - peer.lastUpdate > PEER_TIMEOUT_SECONDS) {
        // During an active match, record as DNF if they hadn't finished/died cleanly.
        if (this.matchState === "in_match" && !peer.matchProgress.dead && !peer.matchProgress.finished) {
          this.dnfPeers.push({
            userId,
            username: peer.username,
            score: peer.score,
            height: peer.height,
          });
        }
        this.peers.delete(userId);
        this.callbacks.onPeerLeft?.(userId);
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
      // edge: same-userId rejoin — if this peer was in dnfPeers (timed out
      // mid-match), remove the stale DNF entry so they don't appear twice in
      // the results table.
      const dnfIdx = this.dnfPeers.findIndex((d) => d.userId === uid);
      if (dnfIdx !== -1) this.dnfPeers.splice(dnfIdx, 1);

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
    // edge: two clients' clocks drift — OK because startMsRel is relative to
    // each peer's own local clock; wall-clock timestamps are never compared.
    this.enterCountdown(Date.now() + msg.startMsRel, msg.matchId);
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
    // First peer FINISHED starts the 5 s grace timer for latecomers.
    if (this.firstFinisherGraceStart === null && this.matchState === "in_match") {
      this.firstFinisherGraceStart = Date.now();
    }
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
    // edge: player edits name — validate on receive path the same way the
    // local input handler does. Strip control chars, trim, clamp, reject empty.
    const peer = this.peers.get(uid);
    if (!peer) return;
    const clean = msg.name.replace(/[\x00-\x1F\x7F]/g, "").trim().slice(0, 20);
    // edge: player tries to change name to "" — silently reject empty result.
    if (clean.length > 0) peer.username = clean;
  }

  // ── Host disconnect detection ──────────────────────────────────────────────

  private tickHostDisconnect(dt: number): void {
    // edge: host disconnects in lobby — if host is absent from lobby+peers for
    // HOST_ABSENT_THRESHOLD seconds, fires onLobbyCancelled so the game layer
    // can show a toast and return clients to title. Only runs in lobby state;
    // mid-match host departure is handled by the drainInbound stale-peer path.
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

  // ── Countdown tick ─────────────────────────────────────────────────────────

  /**
   * Called every update() tick. When the countdown timer elapses, transitions
   * matchState → 'in_match' and fires onCountdownComplete exactly once.
   */
  private tickCountdown(): void {
    if (this.matchState !== "countdown") return;
    if (Date.now() >= this.localStartAt) {
      this.matchState = "in_match";
      this.callbacks.onCountdownComplete?.();
    }
  }

  // ── Match-end resolver ────────────────────────────────────────────────────

  /**
   * Called every update() tick while in 'in_match'. Checks three end paths:
   * 1. All known players (local + active peers; DNFs count as done) are dead/finished.
   * 2. 120 s hard timeout since localStartAt.
   * 3. First-finisher 5 s grace period has expired.
   */
  private tickMatchEnd(): void {
    if (this.matchState !== "in_match" || this.matchEndFired) return;

    const now = Date.now();
    const elapsed = now - this.localStartAt;

    // edge: match end on 120 s timeout — highest score among living players wins.
    if (elapsed >= 120_000) {
      this.fireMatchEnd();
      return;
    }

    // Path 3: first-finisher grace expired
    if (this.firstFinisherGraceStart !== null && (now - this.firstFinisherGraceStart) >= 5_000) {
      this.fireMatchEnd();
      return;
    }

    // Path 1: all known players done (local must be dead or finished first)
    const localDone = this.localDead || this.localFinishedFlag;
    if (localDone) {
      const allActivePeersDone = [...this.peers.values()].every(
        (p) => p.matchProgress.dead !== undefined || p.matchProgress.finished !== undefined
      );
      if (allActivePeersDone) {
        this.fireMatchEnd();
      }
    }
  }

  /** Transitions to 'ended', builds rankings, fires onMatchEnded exactly once. */
  private fireMatchEnd(): void {
    if (this.matchEndFired) return;
    this.matchEndFired = true;
    this.matchState = "ended";
    const results = this.buildResults();
    this.callbacks.onMatchEnded?.(results);
  }

  /**
   * Builds the final sorted MatchResult array.
   * Sort order: finishers (finishMs ASC) → non-finishers (score DESC, height DESC) → DNFs.
   */
  private buildResults(): MatchResult[] {
    type SortEntry = MatchResult & { _group: 0 | 1 | 2 };
    const entries: SortEntry[] = [];

    // Local player
    entries.push({
      userId: "local",
      name: this.localName,
      rank: 0,
      finished: this.localFinishedFlag,
      finishMs: this.localFinishedFlag ? this.localFinishMs : undefined,
      score: this.localScore,
      height: this.localHeight,
      isLocal: true,
      isDnf: false,
      _group: this.localFinishedFlag ? 0 : 1,
    });

    // Active peers
    for (const peer of this.peers.values()) {
      const prog = peer.matchProgress;
      const finished = prog.finished !== undefined;
      const score = prog.finished?.score ?? prog.dead?.score ?? peer.score;
      const height = prog.finished?.height ?? prog.dead?.height ?? peer.height;
      entries.push({
        userId: peer.userId,
        name: peer.username,
        rank: 0,
        finished,
        finishMs: prog.finished?.ms,
        score,
        height,
        isLocal: false,
        isDnf: false,
        _group: finished ? 0 : 1,
      });
    }

    // DNF peers (insertion order = disconnect order)
    for (const dnf of this.dnfPeers) {
      entries.push({
        userId: dnf.userId,
        name: dnf.username,
        rank: 0,
        finished: false,
        score: dnf.score,
        height: dnf.height,
        isLocal: false,
        isDnf: true,
        _group: 2,
      });
    }

    entries.sort((a, b) => {
      if (a._group !== b._group) return a._group - b._group;
      if (a._group === 0) return (a.finishMs ?? 0) - (b.finishMs ?? 0);
      if (a._group === 1) {
        if (b.score !== a.score) return b.score - a.score;
        return b.height - a.height;
      }
      return 0; // DNFs: preserve insertion (disconnect) order
    });

    return entries.map((e, i) => ({
      userId: e.userId,
      name: e.name,
      rank: i + 1,
      finished: e.finished,
      finishMs: e.finishMs,
      score: e.score,
      height: e.height,
      isLocal: e.isLocal,
      isDnf: e.isDnf,
    }));
  }

  /**
   * Resets match-progress state for a fresh match while keeping peers connected.
   * Call before startMatch() when the host starts the next round from the end screen.
   */
  resetForNextMatch(): void {
    for (const peer of this.peers.values()) {
      peer.matchProgress = {};
    }
    this.pendingProgress.clear();
    this.localDead = false;
    this.localFinishedFlag = false;
    this.localFinishMs = 0;
    this.firstFinisherGraceStart = null;
    this.matchEndFired = false;
    this.dnfPeers.length = 0;
    this.matchState = "lobby";
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

  /**
   * Returns the Wavedash lobby roster (userId + username) for every member
   * OTHER than the local user. Source of truth for the lobby player list —
   * peer identity is known to the SDK the moment joinLobby resolves, so we
   * don't need to wait for a P2P STATE broadcast round-trip to display peers.
   *
   * Prefers the custom display name from our peers map (set via NAME_UPDATE)
   * when available, falls back to the SDK-provided username.
   */
  getLobbyRoster(): Array<{ userId: string; username: string }> {
    if (!this.lobbyId) return [];
    const roster = getLobbyUsers(this.lobbyId);
    const myId = getMyUserId();
    const out: Array<{ userId: string; username: string }> = [];
    for (const user of roster) {
      if (myId && user.userId === myId) continue;
      const peer = this.peers.get(user.userId);
      out.push({
        userId: user.userId,
        username: peer?.username ?? user.username,
      });
    }
    return out;
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

  /** Returns the userId of the lobby host, or null if we are the host / unknown. */
  getHostUserId(): string | null {
    return this.hostUserId;
  }

  /**
   * Returns true if the lobby host is still present in the SDK lobby roster.
   *
   * Drives the end-screen "host left — match over" transition for non-host
   * clients. Reuses the same SDK roster signal as the lobby-cancel watchdog,
   * so detection latency matches Wavedash's own member-list refresh (≈ 1 s).
   *
   * - If we ARE the host, trivially true.
   * - If hostUserId or lobbyId is unknown, trivially true (no evidence of departure).
   * - Otherwise, checks the roster for a user whose userId === hostUserId.
   */
  isLobbyHostPresent(): boolean {
    if (this.hostSelf) return true;
    if (!this.hostUserId || !this.lobbyId) return true;
    const users = getLobbyUsers(this.lobbyId);
    return users.some((u) => u.userId === this.hostUserId);
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
