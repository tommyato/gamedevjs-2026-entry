/**
 * Clockwork Climb Multiplayer Wire Protocol v2
 *
 * All messages have a 1-byte type prefix followed by the body.
 * Backward-compat: v1 builds sent raw 23-byte STATE with no prefix;
 * these are detected by exact length and decoded as STATE with legacy=true.
 *
 * Wire sizes:
 *   STATE        24 B  (1 type + 23 body) — unreliable, 10 Hz
 *   MATCH_START   9 B  (1 type + 8 body)  — reliable
 *   DIED         13 B  (1 type + 12 body) — reliable
 *   FINISHED     17 B  (1 type + 16 body) — reliable
 *   NAME_UPDATE   2+n B variable           — reliable
 *   READY_TOGGLE  2 B  (1 type + 1 body)  — reliable
 */

export const PROTOCOL_VERSION = 2;

export const MSG = {
  STATE: 0x01,
  MATCH_START: 0x02,
  DIED: 0x03,
  FINISHED: 0x04,
  NAME_UPDATE: 0x05,
  READY_TOGGLE: 0x06,
} as const;

/** 23-byte STATE body (unchanged from v1). */
const STATE_BODY = 23;

export type MatchState = "lobby" | "countdown" | "in_match" | "ended";

export type MatchResult = {
  userId: string;
  name: string;
  rank: number;
  finished: boolean;
  finishMs?: number;
  score: number;
  height: number;
  isLocal: boolean;
  isDnf: boolean;
};

export type TypedMessage =
  | {
      type: "state";
      x: number;
      y: number;
      z: number;
      height: number;
      score: number;
      combo: number;
      onGround: boolean;
      /** True when decoded from a v1 23-byte payload (no type prefix). */
      legacy: boolean;
    }
  | { type: "match_start"; startMsRel: number; matchId: number }
  | { type: "died"; matchId: number; score: number; height: number }
  | { type: "finished"; matchId: number; finishMs: number; score: number; height: number }
  | { type: "name_update"; name: string }
  | { type: "ready_toggle"; ready: boolean };

// ── Encoders ─────────────────────────────────────────────────────────────────

/** 24 bytes: 1 type + 23 body. Unreliable channel 0. */
export function encodeState(
  x: number,
  y: number,
  z: number,
  height: number,
  score: number,
  combo: number,
  onGround: boolean
): Uint8Array {
  const buf = new ArrayBuffer(1 + STATE_BODY);
  const v = new DataView(buf);
  v.setUint8(0, MSG.STATE);
  v.setFloat32(1, x, true);
  v.setFloat32(5, y, true);
  v.setFloat32(9, z, true);
  v.setFloat32(13, height, true);
  v.setUint32(17, Math.max(0, Math.min(0xffffffff, Math.floor(score))), true);
  v.setUint16(21, Math.max(0, Math.min(0xffff, Math.floor(combo))), true);
  v.setUint8(23, onGround ? 1 : 0);
  return new Uint8Array(buf);
}

/** 9 bytes: 1 type + 4 startMsRel + 4 matchId. Reliable channel 0. */
export function encodeMatchStart(startMsRel: number, matchId: number): Uint8Array {
  const buf = new ArrayBuffer(9);
  const v = new DataView(buf);
  v.setUint8(0, MSG.MATCH_START);
  v.setUint32(1, startMsRel >>> 0, true);
  v.setUint32(5, matchId >>> 0, true);
  return new Uint8Array(buf);
}

/** 13 bytes: 1 type + 4 matchId + 4 score + 4 height×100. Reliable channel 0. */
export function encodeDied(matchId: number, score: number, height: number): Uint8Array {
  const buf = new ArrayBuffer(13);
  const v = new DataView(buf);
  v.setUint8(0, MSG.DIED);
  v.setUint32(1, matchId >>> 0, true);
  v.setUint32(5, Math.max(0, Math.min(0xffffffff, Math.floor(score))), true);
  v.setUint32(9, Math.max(0, Math.min(0xffffffff, Math.round(height * 100))), true);
  return new Uint8Array(buf);
}

/** 17 bytes: 1 type + 4 matchId + 4 finishMs + 4 score + 4 height×100. Reliable channel 0. */
export function encodeFinished(
  matchId: number,
  finishMs: number,
  score: number,
  height: number
): Uint8Array {
  const buf = new ArrayBuffer(17);
  const v = new DataView(buf);
  v.setUint8(0, MSG.FINISHED);
  v.setUint32(1, matchId >>> 0, true);
  v.setUint32(5, finishMs >>> 0, true);
  v.setUint32(9, Math.max(0, Math.min(0xffffffff, Math.floor(score))), true);
  v.setUint32(13, Math.max(0, Math.min(0xffffffff, Math.round(height * 100))), true);
  return new Uint8Array(buf);
}

/** Variable: 1 type + 1 nameLen + utf8 bytes. Reliable channel 0. Max name 255 bytes encoded. */
export function encodeNameUpdate(name: string): Uint8Array {
  const bytes = new TextEncoder().encode(name.slice(0, 255));
  const buf = new ArrayBuffer(2 + bytes.length);
  const v = new DataView(buf);
  v.setUint8(0, MSG.NAME_UPDATE);
  v.setUint8(1, bytes.length);
  new Uint8Array(buf, 2).set(bytes);
  return new Uint8Array(buf);
}

/** 2 bytes: 1 type + 1 ready flag. Reliable channel 0. */
export function encodeReadyToggle(ready: boolean): Uint8Array {
  return new Uint8Array([MSG.READY_TOGGLE, ready ? 1 : 0]);
}

// ── Decoder ──────────────────────────────────────────────────────────────────

/** Decodes a raw P2P payload into a typed message. Returns null on malformed data. */
export function decodeMessage(data: Uint8Array): TypedMessage | null {
  // Backward-compat: v1 builds sent raw 23-byte STATE with no type prefix.
  if (data.length === STATE_BODY) {
    return decodeStateBody(data, 0, true);
  }
  if (data.length < 1) return null;

  const type = data[0];
  const v = new DataView(data.buffer, data.byteOffset, data.byteLength);

  switch (type) {
    case MSG.STATE:
      if (data.length < 1 + STATE_BODY) return null;
      return decodeStateBody(data, 1, false);

    case MSG.MATCH_START:
      if (data.length < 9) return null;
      return { type: "match_start", startMsRel: v.getUint32(1, true), matchId: v.getUint32(5, true) };

    case MSG.DIED:
      if (data.length < 13) return null;
      return {
        type: "died",
        matchId: v.getUint32(1, true),
        score: v.getUint32(5, true),
        height: v.getUint32(9, true) / 100,
      };

    case MSG.FINISHED:
      if (data.length < 17) return null;
      return {
        type: "finished",
        matchId: v.getUint32(1, true),
        finishMs: v.getUint32(5, true),
        score: v.getUint32(9, true),
        height: v.getUint32(13, true) / 100,
      };

    case MSG.NAME_UPDATE: {
      if (data.length < 2) return null;
      const nameLen = v.getUint8(1);
      if (data.length < 2 + nameLen) return null;
      const name = new TextDecoder().decode(data.slice(2, 2 + nameLen));
      return { type: "name_update", name };
    }

    case MSG.READY_TOGGLE:
      if (data.length < 2) return null;
      return { type: "ready_toggle", ready: v.getUint8(1) !== 0 };

    default:
      return null;
  }
}

function decodeStateBody(data: Uint8Array, offset: number, legacy: boolean): TypedMessage | null {
  if (data.length < offset + STATE_BODY) return null;
  const v = new DataView(data.buffer, data.byteOffset + offset, STATE_BODY);
  const x = v.getFloat32(0, true);
  const y = v.getFloat32(4, true);
  const z = v.getFloat32(8, true);
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return null;
  return {
    type: "state",
    x,
    y,
    z,
    height: v.getFloat32(12, true),
    score: v.getUint32(16, true),
    combo: v.getUint16(20, true),
    onGround: (v.getUint8(22) & 0x01) !== 0,
    legacy,
  };
}
