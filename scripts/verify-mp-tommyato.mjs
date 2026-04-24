/**
 * End-to-end smoke test of the Tommyato Colyseus multiplayer endpoint.
 *
 * Two clients connect to wss://mp.tommyato.com:
 *   - "host" creates a `climb_race` room.
 *   - "guest" joins it by id.
 *   - host sends a `peer` message with arbitrary base64 bytes.
 *   - guest must receive it (with the host's sessionId in `from`) and echoes back.
 *   - host must receive the echo.
 *   - both leave cleanly.
 *
 * Prints "OK" on success and exits 0; non-zero on any failure.
 *
 * Acts as a permanent gate that the deployed droplet still speaks the protocol
 * `TommyatoMultiplayerTransport` was written against — if the server changes
 * shape, this fails before bad bundles ship.
 */

import { Client } from "colyseus.js";

const ENDPOINT = "wss://mp.tommyato.com";
// Must match server/cc-mp/index.ts — currently "climb-race".
const ROOM_NAME = "climb-race";
const TEST_TIMEOUT_MS = 15_000;

const TEST_PAYLOAD_HOST = "aGVsbG8tZ3Vlc3Q="; // base64("hello-guest")
const TEST_PAYLOAD_GUEST = "aGVsbG8taG9zdA==";  // base64("hello-host")

let host = null;
let guest = null;

function fail(msg, err) {
  console.error(`FAIL: ${msg}${err ? ` — ${err?.message ?? err}` : ""}`);
  cleanup().finally(() => process.exit(1));
}

async function cleanup() {
  await Promise.allSettled([
    host?.leave?.().catch(() => {}),
    guest?.leave?.().catch(() => {}),
  ]);
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timeout: ${label}`)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

(async () => {
  const overall = setTimeout(() => fail("overall timeout"), TEST_TIMEOUT_MS);

  try {
    const hostClient = new Client(ENDPOINT);
    const guestClient = new Client(ENDPOINT);

    host = await withTimeout(
      hostClient.create(ROOM_NAME, { name: "verify-host" }),
      5000,
      "host.create"
    );
    if (typeof host.roomId !== "string" || host.roomId.length === 0) {
      throw new Error(`host.roomId missing — got ${JSON.stringify(host.roomId)}`);
    }
    console.log(`host roomId=${host.roomId} sessionId=${host.sessionId}`);

    // Wait one tick to give the server time to advertise the room before joinById.
    await new Promise((r) => setTimeout(r, 100));

    guest = await withTimeout(
      guestClient.joinById(host.roomId, { name: "verify-guest" }),
      5000,
      "guest.joinById"
    );
    console.log(`guest sessionId=${guest.sessionId}`);

    // Both sides expect to receive the other's `peer` message.
    const guestGotHost = deferred();
    const hostGotGuestEcho = deferred();

    guest.onMessage("peer", (payload) => {
      if (payload?.from === host.sessionId && payload?.data === TEST_PAYLOAD_HOST) {
        guestGotHost.resolve();
        // Echo back so host sees a roundtrip
        guest.send("peer", { reliable: true, data: TEST_PAYLOAD_GUEST });
      }
    });

    host.onMessage("peer", (payload) => {
      if (payload?.from === guest.sessionId && payload?.data === TEST_PAYLOAD_GUEST) {
        hostGotGuestEcho.resolve();
      }
    });

    // Host fires first
    host.send("peer", { reliable: true, data: TEST_PAYLOAD_HOST });

    await withTimeout(guestGotHost.promise, 5000, "guest receive host peer");
    await withTimeout(hostGotGuestEcho.promise, 5000, "host receive guest echo");

    await Promise.allSettled([host.leave(), guest.leave()]);
    host = null;
    guest = null;

    clearTimeout(overall);
    console.log("OK");
    process.exit(0);
  } catch (err) {
    clearTimeout(overall);
    fail("smoke test failed", err);
  }
})();
