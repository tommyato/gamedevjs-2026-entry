import { Room, Client } from "colyseus";
import { Schema, MapSchema, type } from "@colyseus/schema";

export class PlayerState extends Schema {
  @type("string") name = "";
  @type("number") height = 0;
  @type("number") score = 0;
  @type("boolean") alive = true;
  @type("boolean") finished = false;
}

export class RoomState extends Schema {
  @type("number") seed = 0;
  @type("number") startedAt = 0; // 0 = not started, ms epoch otherwise
  @type({ map: PlayerState }) players = new MapSchema<PlayerState>();
}

type StatePartial = Partial<{
  name: string;
  height: number;
  score: number;
  alive: boolean;
  finished: boolean;
}>;

type PeerPayload = { reliable: boolean; data: string /* base64 */ };

export class ClimbRaceRoom extends Room<RoomState> {
  maxClients = 4;

  onCreate() {
    this.setState(new RoomState());
    this.state.seed = Math.floor(Math.random() * 0x7fffffff);

    this.onMessage("peer", (client, payload: PeerPayload) => {
      // Transparent envelope: rebroadcast to all OTHER clients in room.
      this.broadcast(
        "peer",
        { from: client.sessionId, ...payload },
        { except: client },
      );
    });

    this.onMessage("state", (client, partial: StatePartial) => {
      const p = this.state.players.get(client.sessionId);
      if (!p) return;
      if (typeof partial.name === "string") p.name = partial.name.slice(0, 32);
      if (typeof partial.height === "number") p.height = partial.height;
      if (typeof partial.score === "number") p.score = partial.score;
      if (typeof partial.alive === "boolean") p.alive = partial.alive;
      if (typeof partial.finished === "boolean") p.finished = partial.finished;
    });

    this.onMessage("start", () => {
      if (this.state.startedAt === 0) this.state.startedAt = Date.now();
    });
  }

  onJoin(client: Client, options: { name?: string } = {}) {
    const p = new PlayerState();
    p.name = (options.name ?? "Climber").slice(0, 32);
    this.state.players.set(client.sessionId, p);
  }

  onLeave(client: Client) {
    this.state.players.delete(client.sessionId);
  }
}
