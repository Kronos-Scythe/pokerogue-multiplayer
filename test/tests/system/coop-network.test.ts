import { type CoopSocket, type CoopStarter, coopNetwork } from "#system/coop-network";
import { coopSession } from "#system/coop-session";
import { hashText } from "#system/coop-sync";
import { parseCoopUrl } from "#system/coop-url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

/** A stand-in for the relay server: the same room rules, no sockets */
class FakeRelay {
  rooms = new Map<string, { host: FakeSocket; guest?: FakeSocket }>();

  connect(): FakeSocket {
    const socket = new FakeSocket(this);
    // the socket "opens" a moment after being created, like a real one
    setTimeout(() => {
      socket.readyState = 1;
      socket.onopen?.();
    }, 0);
    return socket;
  }

  handle(from: FakeSocket, text: string) {
    const message = JSON.parse(text);
    if (message.type === "host") {
      const room = message.room ?? "ABCD";
      this.rooms.set(room, { host: from });
      from.room = room;
      from.receive({ type: "hosted", room });
    } else if (message.type === "join") {
      const entry = this.rooms.get(message.room);
      if (!entry) {
        from.receive({ type: "error", message: "No room with that code." });
        return;
      }
      entry.guest = from;
      from.room = message.room;
      from.receive({ type: "joined", room: message.room });
      entry.host.receive({ type: "peer-joined" });
    } else {
      const entry = this.rooms.get(from.room!);
      (entry?.host === from ? entry.guest : entry?.host)?.receive(message);
    }
  }
}

class FakeSocket implements CoopSocket {
  readyState = 0;
  room?: string;
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

  it("needs a room code to join, and uses wss on https pages", () => {
    expect(parseCoopUrl("?coop=join", page)).toBeNull();
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
});
