import { createRelay } from "./relay.mjs";

const port = Number(process.env.PORT ?? 8787);
// Listen on every interface by default so a friend can reach it over a VPN, a LAN or a tunnel
const host = process.env.HOST ?? "0.0.0.0";

createRelay({ port, host });
console.log(`PokeRogue co-op relay listening on ws://${host}:${port}`);
console.log("Players connect with ?coop=host (or join) &room=CODE &server=ws://<this machine's address>:" + port);
