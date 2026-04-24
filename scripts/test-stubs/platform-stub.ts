/**
 * Test-time stub for src/platform.ts. Exports the same surface multiplayer.ts
 * imports, but routes everything through a small in-memory harness so a unit
 * test can drive two MultiplayerManager instances without a browser or the
 * Wavedash SDK.
 *
 * Mounted via an esbuild resolve plugin in scripts/verify-name-sync.mjs; the
 * real src/platform.ts is never loaded in test runs.
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

// ── Platform surface (mirrors src/platform.ts exports used by multiplayer.ts) ──

export function isMultiplayerAvailable(): boolean {
  return true;
}

export async function createMultiplayerLobby(): Promise<string | null> {
  return "test-lobby";
}

export async function joinMultiplayerLobby(_lobbyId: string): Promise<boolean> {
  return true;
}

export async function leaveMultiplayerLobby(_lobbyId: string): Promise<void> {}

export function broadcastMessage(_reliable: boolean, data: Uint8Array): void {
  const sender = harness.currentUserId;
  if (!sender) return;
  for (const [uid, queue] of harness.inbox) {
    if (uid === sender) continue;
    // Copy the payload so receivers can't accidentally share a buffer with
    // the sender's encoder reuse.
    queue.push({ fromUserId: sender, payload: new Uint8Array(data) });
  }
}

export function broadcastPlayerState(data: Uint8Array): void {
  broadcastMessage(false, data);
}

export function readPeerMessages(): PeerMessage[] {
  const uid = harness.currentUserId;
  if (!uid) return [];
  const queue = harness.inbox.get(uid);
  if (!queue || queue.length === 0) return [];
  const out = queue.slice();
  queue.length = 0;
  return out;
}

export async function getInviteLink(): Promise<string | null> {
  return null;
}

export function checkLaunchLobby(): string | null {
  return null;
}

export function getMyUserId(): string | null {
  return harness.currentUserId;
}

export function getLobbyUsers(_lobbyId: string): LobbyUser[] {
  const out: LobbyUser[] = [];
  for (const uid of harness.lobbyUserIds) {
    out.push({ userId: uid, username: harness.sdkNames.get(uid) ?? uid });
  }
  return out;
}

export function getLobbyHostId(lobbyId: string): string | null {
  return getLobbyUsers(lobbyId)[0]?.userId ?? null;
}

export function getLobbyUserCount(_lobbyId: string): number {
  return harness.lobbyUserIds.size;
}

export function addMultiplayerListener(event: string, callback: (e: unknown) => void): void {
  const uid = harness.currentUserId;
  if (!uid) return;
  const key = `${uid}|${event}`;
  const arr = harness.listeners.get(key) ?? [];
  arr.push(callback);
  harness.listeners.set(key, arr);
}

export function getMultiplayerEvents(): Record<string, string> {
  return { P2P_CONNECTION_ESTABLISHED: "p2p_connection_established" };
}
