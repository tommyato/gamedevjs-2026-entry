/**
 * Test-time multiplayer transport stub for `MultiplayerManager`.
 *
 * Implements the `IMultiplayerTransport` shape from `src/platform-services.ts`,
 * routing every call through a small in-memory harness so two managers can
 * exchange messages without a browser, the Wavedash SDK, or a Colyseus server.
 *
 * Mounted by the verify scripts (`verify-name-sync.mjs`,
 * `verify-last-survivor.mjs`); the real WavedashPlatform is never loaded in
 * test runs. Driver code uses `__asUser("uid", () => mgr.foo())` to flip the
 * harness's current-user pointer so the stub knows whose mailbox a broadcast
 * came out of.
 */

export type LobbyUser = { userId: string; username: string };
export type PeerMessage = { fromUserId: string; payload: Uint8Array };

type InboundQueue = Array<{ fromUserId: string; payload: Uint8Array }>;

type Harness = {
  /** Active userId for the CURRENT MultiplayerManager. Must be set before the
   *  manager's methods run so its broadcasts flow to the correct peers. */
  currentUserId: string | null;
  /** userId → pending inbound messages for that peer. */
  inbox: Map<string, InboundQueue>;
  /** userId → SDK-supplied coolname, used by getLobbyUsers(). */
  sdkNames: Map<string, string>;
  /** All userIds currently "in the lobby". */
  lobbyUserIds: Set<string>;
  /** Event listeners keyed by (userId, event). */
  listeners: Map<string, Array<(e: unknown) => void>>;
};

const harness: Harness = {
  currentUserId: null,
  inbox: new Map(),
  sdkNames: new Map(),
  lobbyUserIds: new Set(),
  listeners: new Map(),
};

export function __resetHarness(): void {
  harness.currentUserId = null;
  harness.inbox.clear();
  harness.sdkNames.clear();
  harness.lobbyUserIds.clear();
  harness.listeners.clear();
}

export function __setCurrentUser(userId: string, sdkName: string): void {
  harness.currentUserId = userId;
  harness.sdkNames.set(userId, sdkName);
  harness.lobbyUserIds.add(userId);
  if (!harness.inbox.has(userId)) harness.inbox.set(userId, []);
}

export function __fireP2PConnected(forUserId: string): void {
  const prev = harness.currentUserId;
  harness.currentUserId = forUserId;
  try {
    const key = `${forUserId}|p2p_connection_established`;
    for (const cb of harness.listeners.get(key) ?? []) cb({});
  } finally {
    harness.currentUserId = prev;
  }
}

/** Runs `fn` with `currentUserId` pinned to `userId`, then restores. */
export function __asUser<T>(userId: string, fn: () => T): T {
  const prev = harness.currentUserId;
  harness.currentUserId = userId;
  try {
    return fn();
  } finally {
    harness.currentUserId = prev;
  }
}

// ── IMultiplayerTransport implementation ────────────────────────────────────

export const stubTransport = {
  isAvailable(): boolean {
    return true;
  },

  async createLobby(): Promise<string | null> {
    return "test-lobby";
  },

  async joinLobby(_lobbyId: string): Promise<boolean> {
    return true;
  },

  async leaveLobby(_lobbyId: string): Promise<void> {},

  broadcast(_reliable: boolean, data: Uint8Array): void {
    const sender = harness.currentUserId;
    if (!sender) return;
    for (const [uid, queue] of harness.inbox) {
      if (uid === sender) continue;
      // Copy the payload so receivers can't accidentally share a buffer with
      // the sender's encoder reuse.
      queue.push({ fromUserId: sender, payload: new Uint8Array(data) });
    }
  },

  readPeerMessages(): PeerMessage[] {
    const uid = harness.currentUserId;
    if (!uid) return [];
    const queue = harness.inbox.get(uid);
    if (!queue || queue.length === 0) return [];
    const out = queue.slice();
    queue.length = 0;
    return out;
  },

  async getInviteLink(): Promise<string | null> {
    return null;
  },

  checkLaunchLobby(): string | null {
    return null;
  },

  getMyUserId(): string | null {
    return harness.currentUserId;
  },

  getLobbyUsers(_lobbyId: string): LobbyUser[] {
    const out: LobbyUser[] = [];
    for (const uid of harness.lobbyUserIds) {
      out.push({ userId: uid, username: harness.sdkNames.get(uid) ?? uid });
    }
    return out;
  },

  getLobbyHostId(lobbyId: string): string | null {
    return this.getLobbyUsers(lobbyId)[0]?.userId ?? null;
  },

  getLobbyUserCount(_lobbyId: string): number {
    return harness.lobbyUserIds.size;
  },

  addEventListener(event: string, callback: (e: unknown) => void): void {
    const uid = harness.currentUserId;
    if (!uid) return;
    const key = `${uid}|${event}`;
    const arr = harness.listeners.get(key) ?? [];
    arr.push(callback);
    harness.listeners.set(key, arr);
  },

  getEvents(): Record<string, string> {
    return { P2P_CONNECTION_ESTABLISHED: "p2p_connection_established" };
  },
};
