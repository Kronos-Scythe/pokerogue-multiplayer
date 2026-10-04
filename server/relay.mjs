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
 *   { type: "resumable" }             the run has started: from now on a dropped connection is only "away" for a
 *                                     while, and the player can come back with their token
 *   { type: "rejoin", room, token }   take your place in a room again after the connection dropped
 *   { type: "leave" }                 leave for good, right now
 * Relay -> client:
 *   { type: "hosted", room, token }   the room is open (keep the token to rejoin)
 *   { type: "joined", room, token }   you are in the room (the host also gets { type: "peer-joined" })
 *   { type: "rejoined", room }        you are back (the other player gets { type: "peer-back" })
 *   { type: "peer-away" }             the other player's connection dropped; they have a while to come back
 *   { type: "peer-left" }             the other player left for good
 *   { type: "error", message }
 * Anything else is forwarded to the other player in the room as is.
 *
 * @param {import("ws").ServerOptions & { graceMs?: number }} options Options for the underlying WebSocket server
 *   (port, host, ...), and how long a dropped player of a running game keeps their place (`graceMs`, 5 minutes)
 * @returns {{ wss: import("ws").WebSocketServer, rooms: Map<string, { host: any, guest: any }>, close: () => Promise<void> }}
 */
export function createRelay({ graceMs = 5 * 60_000, ...options }) {
  const wss = new WebSocketServer(options);
  /**
   * @typedef {{ host: any, guest: any, hostToken: string, guestToken?: string, resumable: boolean,
   *   away: { host?: ReturnType<typeof setTimeout>, guest?: ReturnType<typeof setTimeout> } }} Room
   * @type {Map<string, Room>}
   */
  const rooms = new Map();

  const newToken = () => Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);

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

  /** Remove a player from their room for good. The room closes when the host goes. */
  const leaveForGood = (room, entry, role) => {
    clearTimeout(entry.away[role]);
    entry.away[role] = undefined;
    const other = role === "host" ? entry.guest : entry.host;
    send(other, { type: "peer-left" });
    if (role === "host") {
      clearTimeout(entry.away.guest);
      if (entry.guest) {
        entry.guest.room = undefined;
        entry.guest.close();
      }
      rooms.delete(room);
    } else {
      entry.guest = undefined;
      entry.guestToken = undefined;
      entry.resumable = false;
    }
  };

  const leave = (socket, forGood = false) => {
    const room = socket.room;
    if (!room) {
      return;
    }
    const entry = rooms.get(room);
    socket.room = undefined;
    if (!entry) {
      return;
    }
    const role = entry.host === socket ? "host" : entry.guest === socket ? "guest" : null;
    if (!role) {
      return;
    }
    if (forGood || !entry.resumable) {
      leaveForGood(room, entry, role);
      return;
    }
    // A running game: keep the player's place for a while, so a dropped connection is not the end of the run
    entry[role] = undefined;
    send(role === "host" ? entry.guest : entry.host, { type: "peer-away" });
    entry.away[role] = setTimeout(() => {
      if (rooms.get(room) === entry && !entry[role]) {
        leaveForGood(room, entry, role);
      }
    }, graceMs);
    entry.away[role].unref?.();
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
        const token = newToken();
        rooms.set(room, { host: socket, guest: undefined, hostToken: token, resumable: false, away: {} });
        socket.room = room;
        send(socket, { type: "hosted", room, token });
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
          entry.guestToken = newToken();
          socket.room = room;
          send(socket, { type: "joined", room, token: entry.guestToken });
          send(entry.host, { type: "peer-joined" });
        }
        return;
      }

      if (message.type === "rejoin") {
        const code = typeof message.room === "string" ? message.room.toUpperCase() : "";
        const entry = rooms.get(code);
        const role =
          entry && message.token && message.token === entry.hostToken
            ? "host"
            : entry && message.token && message.token === entry.guestToken
              ? "guest"
              : null;
        if (!entry || !role || socket.room) {
          send(socket, { type: "error", message: "Could not rejoin that room." });
          return;
        }
        // The old connection may not have been noticed as dead yet
        const old = entry[role];
        if (old && old !== socket) {
          old.room = undefined;
          old.terminate();
        }
        clearTimeout(entry.away[role]);
        entry.away[role] = undefined;
        entry[role] = socket;
        socket.room = code;
        send(socket, { type: "rejoined", room: code });
        send(role === "host" ? entry.guest : entry.host, { type: "peer-back" });
        return;
      }

      const entry = socket.room ? rooms.get(socket.room) : undefined;
      if (!entry) {
        send(socket, { type: "error", message: "Join a room first." });
        return;
      }

      if (message.type === "resumable") {
        entry.resumable = true;
        return;
      }
      if (message.type === "leave") {
        leave(socket, true);
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
        for (const entry of rooms.values()) {
          clearTimeout(entry.away.host);
          clearTimeout(entry.away.guest);
        }
        for (const socket of wss.clients) {
          socket.terminate();
        }
        wss.close(() => resolve());
      }),
  };
}
