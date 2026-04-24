import { Server } from "colyseus";
import express from "express";
import http from "http";
import { ClimbRaceRoom } from "./ClimbRaceRoom";

const PORT = Number(process.env.PORT ?? 2567);

const app = express();
app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

const server = http.createServer(app);
const gameServer = new Server({ server });
gameServer.define("climb-race", ClimbRaceRoom);
gameServer.listen(PORT);

console.log(`cc-mp listening on :${PORT}`);
