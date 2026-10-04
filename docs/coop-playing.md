# Playing co-op

## Quick start

```sh
pnpm coop
```

This starts the relay and the game page together (Ctrl+C stops both). The host opens the page and picks
**Co-op: host a game**. The friend opens the host's address (the host's VPN or LAN IP, same port as the page) and
picks **Co-op: join a game**. No room code is needed: a guest who gives none joins whoever is hosting.

The rest of this page covers running the two parts separately and the address options.

## 1. Run the relay

The relay pairs the two players by room code. Run it on any machine both players can reach (yours over a VPN such
as Tailscale or ZeroTier, your LAN, or a tunnel):

```sh
cd server
npm install
npm start            # listens on ws://0.0.0.0:8787 (PORT and HOST can be changed)
```

## 2. Open the game

Both players open the game page (for example `pnpm start` for the dev server) with the co-op settings in the address:

- Host: `http://<game address>/?coop=host&server=ws://<relay address>:8787`
- Guest: `http://<game address>/?coop=join&room=<ROOM CODE>&server=ws://<relay address>:8787`

The host's screen shows the room code once connected. If `server` is left out, the relay is assumed to be on the
same machine as the page, on port 8787. A page served over `https` can only use a `wss://` relay.

Pick **Co-op** in the title menu on both sides. Each player then picks 3 starters; the run starts once both have
confirmed. The host is seat 0 and the guest is seat 1.

## Things to know

- Co-op runs are never saved, and earn no unlocks.
- Ball and Run are disabled.
- If the two games ever disagree, a warning is shown (check the browser console for the wave and turn).
