import {
  addMultiplayerListener,
  broadcastPlayerState,
  checkLaunchLobby,
  createMultiplayerLobby,
  getInviteLink,
  getLobbyUserCount,
  getLobbyUsers,
  getMultiplayerEvents,
  isMultiplayerAvailable,
  joinMultiplayerLobby,
  leaveMultiplayerLobby,
  readPeerMessages,
} from "./platform";

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
};

const STATE_BYTES = 23;
const BROADCAST_INTERVAL = 1 / 10; // 10Hz
const PEER_TIMEOUT_SECONDS = 5;

export class MultiplayerManager {
  private lobbyId: string | null = null;
  private peers: Map<string, PeerGhost> = new Map();
  private broadcastTimer = 0;
  private clock = 0;
  private connectedListenerBound = false;

  // 23-byte binary encoding:
  //   0..3  Float32 x
  //   4..7  Float32 y
  //   8..11 Float32 z
  //   12..15 Float32 height
  //   16..19 Uint32 score
  //   20..21 Uint16 combo
  //   22     Uint8 flags (bit0 = onGround)
  encodeState(
    x: number,
    y: number,
    z: number,
    height: number,
    score: number,
    combo: number,
    onGround: boolean
  ): Uint8Array {
    const buffer = new ArrayBuffer(STATE_BYTES);
    const view = new DataView(buffer);
    view.setFloat32(0, x, true);
    view.setFloat32(4, y, true);
    view.setFloat32(8, z, true);
    view.setFloat32(12, height, true);
    view.setUint32(16, Math.max(0, Math.min(0xffffffff, Math.floor(score))), true);
    view.setUint16(20, Math.max(0, Math.min(0xffff, Math.floor(combo))), true);
    view.setUint8(22, onGround ? 1 : 0);
    return new Uint8Array(buffer);
  }

  decodeState(data: Uint8Array): {
    x: number;
    y: number;
    z: number;
    height: number;
    score: number;
    combo: number;
    onGround: boolean;
  } | null {
    if (data.length < STATE_BYTES) return null;
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const x = view.getFloat32(0, true);
    const y = view.getFloat32(4, true);
    const z = view.getFloat32(8, true);
    const height = view.getFloat32(12, true);
    const score = view.getUint32(16, true);
    const combo = view.getUint16(20, true);
    const flags = view.getUint8(22);
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
      return null;
    }
    return {
      x,
      y,
      z,
      height,
      score,
      combo,
      onGround: (flags & 0x01) !== 0,
    };
  }

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
      const payload = this.encodeState(playerX, playerY, playerZ, height, score, combo, onGround);
      broadcastPlayerState(payload);
    }

    this.drainInbound();
  }

  // Drain the peer message channel without broadcasting — useful while idling
  // on the title/game-over screen so peer counts stay fresh but we don't spam
  // peers with a bogus "(0,0,0)" player position.
  pollPeers(dt: number): void {
    if (!this.isActive()) return;
    this.clock += dt;
    this.drainInbound();
  }

  private drainInbound(): void {
    const messages = readPeerMessages();
    for (const message of messages) {
      const decoded = this.decodeState(message.payload);
      if (!decoded) continue;
      const existing = this.peers.get(message.fromUserId);
      if (existing) {
        existing.prevX = existing.x;
        existing.prevY = existing.y;
        existing.prevZ = existing.z;
        existing.prevUpdate = existing.lastUpdate;
        existing.x = decoded.x;
        existing.y = decoded.y;
        existing.z = decoded.z;
        existing.height = decoded.height;
        existing.score = decoded.score;
        existing.combo = decoded.combo;
        existing.onGround = decoded.onGround;
        existing.lastUpdate = this.clock;
      } else {
        const username = this.resolveUsername(message.fromUserId);
        this.peers.set(message.fromUserId, {
          userId: message.fromUserId,
          username,
          x: decoded.x,
          y: decoded.y,
          z: decoded.z,
          height: decoded.height,
          score: decoded.score,
          combo: decoded.combo,
          onGround: decoded.onGround,
          lastUpdate: this.clock,
          prevX: decoded.x,
          prevY: decoded.y,
          prevZ: decoded.z,
          prevUpdate: this.clock,
        });
      }
    }

    // Remove stale peers
    for (const [userId, peer] of this.peers) {
      if (this.clock - peer.lastUpdate > PEER_TIMEOUT_SECONDS) {
        this.peers.delete(userId);
      }
    }
  }

  private resolveUsername(userId: string): string {
    if (!this.lobbyId) return userId;
    const users = getLobbyUsers(this.lobbyId);
    const match = users.find((user) => user.userId === userId);
    return match?.username ?? userId;
  }

  getPeers(): PeerGhost[] {
    return Array.from(this.peers.values());
  }

  getClock(): number {
    return this.clock;
  }

  async createLobby(): Promise<string | null> {
    if (!isMultiplayerAvailable()) return null;
    this.ensureListeners();
    const id = await createMultiplayerLobby();
    if (id) {
      this.lobbyId = id;
      this.peers.clear();
      this.broadcastTimer = 0;
    }
    return id;
  }

  async joinLobby(lobbyId: string): Promise<boolean> {
    if (!isMultiplayerAvailable()) return false;
    this.ensureListeners();
    const ok = await joinMultiplayerLobby(lobbyId);
    if (ok) {
      this.lobbyId = lobbyId;
      this.peers.clear();
      this.broadcastTimer = 0;
    }
    return ok;
  }

  async leaveLobby(): Promise<void> {
    if (!this.lobbyId) return;
    const id = this.lobbyId;
    this.lobbyId = null;
    this.peers.clear();
    this.broadcastTimer = 0;
    await leaveMultiplayerLobby(id);
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

  getPeerCount(): number {
    return this.peers.size;
  }

  isAvailable(): boolean {
    return isMultiplayerAvailable();
  }

  private ensureListeners(): void {
    if (this.connectedListenerBound) return;
    const events = getMultiplayerEvents();
    const connectedEvent = events.P2P_CONNECTION_ESTABLISHED ?? "p2p_connection_established";
    addMultiplayerListener(connectedEvent, (_event: unknown) => {
      // When a new peer connects, immediately push our broadcast so they see us
      // without waiting for the next 100ms tick.
      this.broadcastTimer = BROADCAST_INTERVAL;
    });
    this.connectedListenerBound = true;
  }
}
