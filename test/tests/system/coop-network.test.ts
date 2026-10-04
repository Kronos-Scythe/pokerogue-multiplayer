import { type CoopSocket, type CoopStarter, coopNetwork } from "#system/coop-network";
import { coopSession } from "#system/coop-session";
import { coopSnapshot } from "#system/coop-snapshot";
import { hashText } from "#system/coop-sync";
import { getCoopTitleConfigs, parseCoopUrl } from "#system/coop-url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** A stand-in for the relay server: the same room rules, no sockets */
class FakeRelay {
  rooms = new Map<string, { host?: FakeSocket | undefined; guest?: FakeSocket | undefined; resumable: boolean }>();

  connect(): FakeSocket {
    const socket = new FakeSocket(this);
    // the socket "opens" a moment after being created, like a real one
    setTimeout(() => {
      socket.readyState = 1;
      socket.onopen?.();
    }, 0);
    return socket;
  }

  /** The connection of one player breaks without them saying goodbye */
  drop(socket: FakeSocket) {
    socket.readyState = 3;
    const entry = this.rooms.get(socket.room!);
    if (entry?.resumable) {
      const role = entry.host === socket ? "host" : "guest";
      entry[role] = undefined;
      (role === "host" ? entry.guest : entry.host)?.receive({ type: "peer-away" });
      socket.room = undefined;
    } else {
      this.leave(socket);
    }
    socket.onclose?.();
  }

  /** Like the real relay: when one player goes, the other is told */
  leave(socket: FakeSocket) {
    for (const entry of this.rooms.values()) {
      if (entry.host === socket) {
        entry.guest?.receive({ type: "peer-left" });
      } else if (entry.guest === socket) {
        entry.host?.receive({ type: "peer-left" });
      }
    }
  }

  handle(from: FakeSocket, text: string) {
    const message = JSON.parse(text);
    if (message.type === "host") {
      const room = message.room ?? "ABCD";
      this.rooms.set(room, { host: from, resumable: false });
      from.room = room;
      from.receive({ type: "hosted", room, token: `host-${room}` });
    } else if (message.type === "join") {
      const entry = this.rooms.get(message.room);
      if (!entry) {
        from.receive({ type: "error", message: "No room with that code." });
        return;
      }
      entry.guest = from;
      from.room = message.room;
      from.receive({ type: "joined", room: message.room, token: `guest-${message.room}` });
      entry.host?.receive({ type: "peer-joined" });
    } else if (message.type === "resumable") {
      this.rooms.get(from.room!)!.resumable = true;
    } else if (message.type === "rejoin") {
      const entry = this.rooms.get(message.room);
      const role =
        message.token === `host-${message.room}` ? "host" : message.token === `guest-${message.room}` ? "guest" : null;
      if (!entry || !role) {
        from.receive({ type: "error", message: "Could not rejoin that room." });
        return;
      }
      entry[role] = from;
      from.room = message.room;
      from.receive({ type: "rejoined", room: message.room });
      (role === "host" ? entry.guest : entry.host)?.receive({ type: "peer-back" });
    } else if (message.type === "leave") {
      this.leave(from);
      from.room = undefined;
    } else {
      const entry = this.rooms.get(from.room!);
      (entry?.host === from ? entry.guest : entry?.host)?.receive(message);
    }
  }
}

class FakeSocket implements CoopSocket {
  readyState = 0;
  room?: string | undefined;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(private readonly relay: FakeRelay) {}
  send(data: string) {
    this.relay.handle(this, data);
  }
  close() {
    this.readyState = 3;
    if (this.room) {
      this.relay.leave(this);
    }
  }
  receive(message: object) {
    setTimeout(() => this.onmessage?.({ data: JSON.stringify(message) }), 0);
  }
}

const starter = (speciesId: number, luck: number): CoopStarter => ({
  speciesId,
  shiny: false,
  variant: 0,
  formIndex: 0,
  abilityIndex: 0,
  passive: false,
  nature: 0,
  pokerus: false,
  ivs: [31, 31, 31, 31, 31, 31],
  luck,
});

describe("getCoopTitleConfigs", () => {
  const page = { protocol: "http:", hostname: "10.0.0.5" };

  it("offers both roles on a plain address, pointing at the relay next to the page", () => {
    expect(getCoopTitleConfigs("", page).map(c => [c.role, c.server])).toEqual([
      ["host", "ws://10.0.0.5:8787"],
      ["join", "ws://10.0.0.5:8787"],
    ]);
  });

  it("offers only the asked-for role, and keeps a custom relay", () => {
    expect(getCoopTitleConfigs("?coop=join&room=ab&server=ws://x:1", page)).toEqual([
      { role: "join", room: "AB", server: "ws://x:1" },
    ]);
    expect(getCoopTitleConfigs("?server=ws://x:1", page).map(c => c.server)).toEqual(["ws://x:1", "ws://x:1"]);
  });
});

describe("parseCoopUrl", () => {
  const page = { protocol: "http:", hostname: "192.168.0.5" };

  it("ignores addresses that do not ask for co-op", () => {
    expect(parseCoopUrl("", page)).toBeNull();
    expect(parseCoopUrl("?coop=maybe", page)).toBeNull();
  });

  it("reads host and join settings and guesses the relay from the page address", () => {
    expect(parseCoopUrl("?coop=host", page)).toEqual({
      role: "host",
      room: undefined,
      server: "ws://192.168.0.5:8787",
    });
    expect(parseCoopUrl("?coop=join&room=abcd&server=ws://10.0.0.2:9000", page)).toEqual({
      role: "join",
      room: "ABCD",
      server: "ws://10.0.0.2:9000",
    });
  });

  it("joins without a room code, and uses wss on https pages", () => {
    expect(parseCoopUrl("?coop=join", page)).toEqual({
      role: "join",
      room: undefined,
      server: "ws://192.168.0.5:8787",
    });
    expect(parseCoopUrl("?coop=host", { protocol: "https:", hostname: "play.example.com" })?.server).toBe(
      "wss://play.example.com:8787",
    );
  });
});

describe("hashText", () => {
  it("is stable and tells different texts apart", () => {
    expect(hashText("wave 1")).toBe(hashText("wave 1"));
    expect(hashText("wave 1")).not.toBe(hashText("wave 2"));
  });
});

describe("co-op connection", () => {
  const relay = new FakeRelay();
  const host = new (coopNetwork.constructor as new () => typeof coopNetwork)();
  const guest = new (coopNetwork.constructor as new () => typeof coopNetwork)();

  beforeEach(() => {
    relay.rooms.clear();
    host.socketFactory = () => relay.connect();
    guest.socketFactory = () => relay.connect();
  });

  afterEach(() => {
    host.disconnect();
    guest.disconnect();
    coopSession.reset();
  });

  it("connects a host and a guest, then swaps starters and agrees on a seed", async () => {
    const statuses: string[] = [];
    host.onStatus = text => statuses.push(text);
    const hosting = host.connect({ server: "ws://relay", role: "host", room: "ROOM" });
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(statuses[0]).toContain("ROOM");
    const joining = guest.connect({ server: "ws://relay", role: "join", room: "ROOM" });
    await Promise.all([hosting, joining]);
    expect(host.connected && guest.connected).toBe(true);

    const [hostSetup, guestSetup] = await Promise.all([
      host.exchangeStarters([starter(1, 0), starter(4, 1)]),
      guest.exchangeStarters([starter(7, 2)]),
    ]);

    expect(hostSetup.seed).toHaveLength(24);
    expect(guestSetup.seed).toBe(hostSetup.seed);
    // host's Pokemon first on both sides, with their owners
    expect(hostSetup.starters.map(s => s.speciesId)).toEqual([1, 4, 7]);
    expect(guestSetup.starters.map(s => s.speciesId)).toEqual([1, 4, 7]);
    expect(guestSetup.owners).toEqual([0, 0, 1]);
    // luck travels with each starter
    expect(guestSetup.starters.map(s => s.luck)).toEqual([0, 1, 2]);
  });

  it("tells the other player when their partner quits in the middle of a run", async () => {
    const hosting = host.connect({ server: "ws://relay", role: "host", room: "QUIT" });
    await new Promise(resolve => setTimeout(resolve, 20));
    await Promise.all([hosting, guest.connect({ server: "ws://relay", role: "join", room: "QUIT" })]);

    let left = 0;
    host.onPartnerLeft = () => left++;
    guest.disconnect();
    await new Promise(resolve => setTimeout(resolve, 20));

    expect(left).toBe(1);
    expect(host.connected).toBe(false);
  });

  it("reports a missing room", async () => {
    await expect(guest.connect({ server: "ws://relay", role: "join", room: "NOPE" })).rejects.toThrow(/No room/);
    expect(guest.connected).toBe(false);
  });

  it("flags a desync only when the two states differ", async () => {
    const hosting = host.connect({ server: "ws://relay", role: "host", room: "SYNC" });
    await new Promise(resolve => setTimeout(resolve, 20));
    await Promise.all([hosting, guest.connect({ server: "ws://relay", role: "join", room: "SYNC" })]);

    const problems: string[] = [];
    host.onDesync = (wave, turn, what) => problems.push(`${wave}:${turn}:${what}`);

    host.reportState(3, 1, "aaaa", "r1");
    guest.reportState(3, 1, "aaaa", "r1");
    host.reportState(3, 2, "aaaa", "r1");
    guest.reportState(3, 2, "bbbb", "r1");
    host.reportState(3, 3, "aaaa", "r1");
    guest.reportState(3, 3, "aaaa", "r2");
    await new Promise(resolve => setTimeout(resolve, 20));

    expect(problems).toEqual(["3:2:battle state", "3:3:random numbers"]);
  });

  describe("a run under way", () => {
    const wait = (ms = 30) => new Promise(resolve => setTimeout(resolve, ms));

    async function startRun(room: string) {
      const hosting = host.connect({ server: "ws://relay", role: "host", room });
      await wait(20);
      await Promise.all([hosting, guest.connect({ server: "ws://relay", role: "join", room })]);
      host.markRunStarted();
      guest.markRunStarted();
      coopSnapshot.latest = "the wave start";
      coopSnapshot.wave = 4;
      host.reconnectDelayMs = 5;
      guest.reconnectDelayMs = 5;
    }

    afterEach(() => {
      vi.restoreAllMocks();
      host.onResync = null;
      guest.onResync = null;
    });

    it("gets a dropped connection back, then the host sends the start of the wave to both games", async () => {
      await startRun("DROP");
      const events: string[] = [];
      const resyncs: string[] = [];
      guest.onReconnecting = () => events.push("guest reconnecting");
      guest.onReconnected = () => events.push("guest reconnected");
      host.onPartnerAway = () => events.push("host sees partner away");
      host.onPartnerBack = () => events.push("host sees partner back");
      host.onPartnerLeft = () => events.push("host lost partner for good");
      host.onResync = session => resyncs.push(`host:${session}`);
      guest.onResync = session => resyncs.push(`guest:${session}`);

      relay.drop((guest as any).socket);
      await wait(100);

      expect(events).toEqual([
        "guest reconnecting",
        "host sees partner away",
        "guest reconnected",
        "host sees partner back",
      ]);
      expect(resyncs.sort()).toEqual(["guest:the wave start", "host:the wave start"]);
      expect(guest.connected).toBe(true);
    });

    it("ends the run when the room is gone, and when a player was never in a started run", async () => {
      await startRun("GONE");
      let left = 0;
      guest.onPartnerLeft = () => left++;
      relay.rooms.clear();
      relay.drop((guest as any).socket);
      await wait(100);
      expect(left).toBe(1);
    });

    it("ignores what the other game sent before it went back to the snapshot", async () => {
      await startRun("STALE");
      const received = vi.spyOn(coopSession, "receive");
      host.onResync = () => {};
      guest.onResync = () => {};
      expect(host.requestResync()).toBe(true);
      await wait();
      // the guest is still catching up: a command from before the rewind is stale
      (guest as any).handle(
        { type: "command", message: { wave: 4, turn: 3, seat: 0, command: 1, cursor: 0 } },
        () => {},
        () => {},
        "join",
      );
      expect(received).not.toHaveBeenCalled();

      host.finishResync();
      await wait();
      (guest as any).handle(
        { type: "command", message: { wave: 4, turn: 1, seat: 0, command: 1, cursor: 0 } },
        () => {},
        () => {},
        "join",
      );
      expect(received).toHaveBeenCalledTimes(1);
    });

    it("rewinds the same wave only a few times, so a problem that keeps coming back cannot loop forever", async () => {
      await startRun("LOOP");
      host.onResync = () => {};
      guest.onResync = () => {};
      const results: boolean[] = [];
      for (let i = 0; i < 5; i++) {
        results.push(host.requestResync());
        host.finishResync();
        guest.finishResync();
        await wait();
      }
      expect(results).toEqual([true, true, true, false, false]);
    });
  });
});
