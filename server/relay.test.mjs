import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { WebSocket } from "ws";
import { createRelay } from "./relay.mjs";

describe("co-op relay", () => {
  let relay;
  let url;

  before(async () => {
    relay = createRelay({ port: 0, host: "127.0.0.1" });
    await new Promise(resolve => relay.wss.on("listening", resolve));
    url = `ws://127.0.0.1:${relay.wss.address().port}`;
  });

  after(() => relay.close());

  /** Open a socket that collects everything it receives */
  async function client() {
    const socket = new WebSocket(url);
    const inbox = [];
    const waiting = [];
    socket.on("message", raw => {
      const message = JSON.parse(raw.toString());
      const waiter = waiting.shift();
      if (waiter) {
        waiter(message);
      } else {
        inbox.push(message);
      }
    });
    await new Promise(resolve => socket.on("open", resolve));
    return {
      socket,
      send: message => socket.send(JSON.stringify(message)),
      next: () => (inbox.length > 0 ? Promise.resolve(inbox.shift()) : new Promise(resolve => waiting.push(resolve))),
    };
  }

  it("pairs a host and a guest by room code and forwards messages both ways", async () => {
    const host = await client();
    const guest = await client();

    host.send({ type: "host" });
    const { room } = await host.next();
    assert.match(room, /^[A-Z2-9]{4}$/);

    guest.send({ type: "join", room: room.toLowerCase() });
    assert.deepEqual(await guest.next(), { type: "joined", room });
    assert.deepEqual(await host.next(), { type: "peer-joined" });

    host.send({ type: "command", n: 1 });
    assert.deepEqual(await guest.next(), { type: "command", n: 1 });
    guest.send({ type: "command", n: 2 });
    assert.deepEqual(await host.next(), { type: "command", n: 2 });
  });

  it("lets a guest without a code join the room that has waited longest", async () => {
    const first = await client();
    const second = await client();
    first.send({ type: "host", room: "FIRSTROOM" });
    await first.next();
    second.send({ type: "host", room: "SECONDROOM" });
    await second.next();

    const guest = await client();
    guest.send({ type: "join" });
    assert.deepEqual(await guest.next(), { type: "joined", room: "FIRSTROOM" });
    assert.deepEqual(await first.next(), { type: "peer-joined" });

    // that room is full now, so the next guest without a code gets the other one
    const another = await client();
    another.send({ type: "join" });
    assert.deepEqual(await another.next(), { type: "joined", room: "SECONDROOM" });
  });

  it("says so when there is nobody to join", async () => {
    const guest = await client();
    guest.send({ type: "join" });
    assert.match((await guest.next()).message, /hosting/);
  });

  it("rejects unknown and full rooms", async () => {
    const host = await client();
    host.send({ type: "host", room: "TESTROOM" });
    assert.equal((await host.next()).room, "TESTROOM");

    const nobody = await client();
    nobody.send({ type: "join", room: "NOPE" });
    assert.equal((await nobody.next()).type, "error");

    const guest = await client();
    guest.send({ type: "join", room: "TESTROOM" });
    assert.equal((await guest.next()).type, "joined");
    await host.next();

    const third = await client();
    third.send({ type: "join", room: "TESTROOM" });
    assert.match((await third.next()).message, /full/);
  });

  it("tells the other player when someone leaves and frees the room when the host does", async () => {
    const host = await client();
    const guest = await client();
    host.send({ type: "host", room: "LEAVERS" });
    await host.next();
    guest.send({ type: "join", room: "LEAVERS" });
    await guest.next();
    await host.next();

    guest.socket.close();
    assert.deepEqual(await host.next(), { type: "peer-left" });

    host.socket.close();
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(relay.rooms.has("LEAVERS"), false);
  });

  it("refuses to forward messages from someone who is not in a room", async () => {
    const stray = await client();
    stray.send({ type: "command" });
    assert.equal((await stray.next()).type, "error");
  });
});
