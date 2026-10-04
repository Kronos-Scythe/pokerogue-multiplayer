import { WebSocketServer } from "ws";

/** Characters for room codes; no 0/O/1/I so codes are easy to read out loud. */
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const CODE_LENGTH = 4;

/**
 * Create a relay: two clients join the same room by code and every message one sends is forwarded to the other.
 * The relay never looks inside messages, so it needs no knowledge of the game.
 *
 * Client -> relay:
 *   { type: "host", room?: string }   open a room (a code is made up when none is given)
 *   { type: "join", room?: string }   join a room opened by a host (without a code: the longest-waiting open room)
 * Relay -> client:
 *   { type: "hosted", room }          the room is open
 *   { type: "joined", room }          you are in the room (the host also gets { type: "peer-joined" })
 *   { type: "peer-left" }             the other player left
 *   { type: "error", message }
 * Anything else is forwarded to the other player in the room as is.
 *
 * @param {import("ws").ServerOptions} options Options for the underlying WebSocket server (port, host, ...)
 * @returns {{ wss: import("ws").WebSocketServer, rooms: Map<string, { host: any, guest: any }>, close: () => Promise<void> }}
 */
export function createRelay(options) {
  const wss = new WebSocketServer(options);
  /** @type {Map<string, { host: any, guest: any }>} */
  const rooms = new Map();

  const send = (socket, message) => {
    if (socket && socket.readyState === socket.OPEN) {
      socket.send(JSON.stringify(message));
    }
  };

  const newCode = () => {
    for (;;) {
      let code = "";
      for (let i = 0; i < CODE_LENGTH; i++) {
        code += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
      }
      if (!rooms.has(code)) {
        return code;
      }
    }
  };

  const leave = socket => {
    const room = socket.room;
    if (!room) {
      return;
    }
    const entry = rooms.get(room);
    socket.room = undefined;
    if (!entry) {
      return;
    }
    if (entry.host === socket) {
      send(entry.guest, { type: "peer-left" });
      if (entry.guest) {
        entry.guest.room = undefined;
        entry.guest.close();
      }
      rooms.delete(room);
    } else if (entry.guest === socket) {
      entry.guest = undefined;
      send(entry.host, { type: "peer-left" });
    }
  };

  wss.on("connection", socket => {
    socket.isAlive = true;
    socket.on("pong", () => {
      socket.isAlive = true;
    });

    socket.on("message", raw => {
      let message;
      try {
        message = JSON.parse(raw.toString());
      } catch {
        send(socket, { type: "error", message: "Messages must be JSON." });
        return;
      }

      if (message.type === "host") {
        if (socket.room) {
          send(socket, { type: "error", message: "Already in a room." });
          return;
        }
        const wanted = typeof message.room === "string" ? message.room.toUpperCase().slice(0, 16) : "";
        if (wanted && rooms.has(wanted)) {
          send(socket, { type: "error", message: "That room code is already in use." });
          return;
        }
        const room = wanted || newCode();
        rooms.set(room, { host: socket, guest: undefined });
        socket.room = room;
        send(socket, { type: "hosted", room });
        return;
      }

      if (message.type === "join") {
        // Without a code, take the room that has waited longest for a partner (Maps keep insertion order)
        const openRoom = [...rooms].find(([, candidate]) => !candidate.guest)?.[0];
        const asked = typeof message.room === "string" ? message.room.toUpperCase() : "";
        const room = asked || openRoom || "";
        const entry = rooms.get(room);
        if (socket.room) {
          send(socket, { type: "error", message: "Already in a room." });
        } else if (!entry) {
          send(socket, {
            type: "error",
            message: asked ? "No room with that code." : "Nobody is hosting right now. Ask your partner to host first.",
          });
        } else if (entry.guest) {
          send(socket, { type: "error", message: "That room is full." });
        } else {
          entry.guest = socket;
          socket.room = room;
          send(socket, { type: "joined", room });
          send(entry.host, { type: "peer-joined" });
        }
        return;
      }

      const entry = socket.room ? rooms.get(socket.room) : undefined;
      if (!entry) {
        send(socket, { type: "error", message: "Join a room first." });
        return;
      }
      send(entry.host === socket ? entry.guest : entry.host, message);
    });

    socket.on("close", () => leave(socket));
    socket.on("error", () => leave(socket));
  });

  // Drop clients that stopped answering (e.g. a closed laptop) so rooms do not stay occupied
  const heartbeat = setInterval(() => {
    for (const socket of wss.clients) {
      if (!socket.isAlive) {
        socket.terminate();
        continue;
      }
      socket.isAlive = false;
      socket.ping();
    }
  }, 30_000);
  heartbeat.unref();
  wss.on("close", () => clearInterval(heartbeat));

  return {
    wss,
    rooms,
    close: () =>
      new Promise(resolve => {
        for (const socket of wss.clients) {
          socket.terminate();
        }
        wss.close(() => resolve());
      }),
  };
}
