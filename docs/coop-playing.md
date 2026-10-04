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

## If the page stays purple and the console says "Cannot create WebGL context"

The network is fine; the friend's browser cannot start graphics (the game needs WebGL). Fixes, in order:

1. Turn on hardware acceleration: Firefox > Settings > General > Performance (untick "Use recommended performance settings", tick "Use hardware acceleration when available"); Chrome/Edge > Settings > System > "Use graphics acceleration when available". Restart the browser.
2. Try another browser (Chrome or Edge usually works when Firefox does not).
3. Update the graphics driver. Check `about:support` (Firefox) or `chrome://gpu` for what is blocked.

## If the page loads forever for your friend

**First try `pnpm coop:fast`.** It builds the game once (about a minute) and serves the built copy, which is a handful of
files instead of the thousands the dev server sends. Over a VPN such as Radmin the dev server can take minutes or
never finish (the tab shows only the page's purple background). Use `pnpm coop:fast --skip-build` to reuse the last build
(rebuild after changing the code).

If it is still stuck, the cause may be the host's firewall dropping the connection (a browser waits on a connection that never answers).
The host needs both the game page (port 8000) and the relay (port 8787) reachable:

1. Start with `pnpm coop` (it makes the page reachable from other computers). `pnpm start:dev` alone only serves
   `localhost`.
2. In PowerShell **as Administrator**, allow both ports on every network profile (Radmin and similar VPN adapters are
   often treated as "Public" networks, which Windows blocks by default):
   `New-NetFirewallRule -DisplayName "PokeRogue co-op" -Direction Inbound -Protocol TCP -LocalPort 8000,8787 -Action Allow -Profile Any`
3. From the friend's computer check the ports: `Test-NetConnection <host's VPN address> -Port 8000` (and `-Port 8787`)
   should say `TcpTestSucceeded : True`. If it does not, it is the firewall or the wrong address.
4. The friend must use the host's address on the VPN (for Radmin it starts with `26.`), not `localhost`.

The first load over a VPN is slow (the dev server sends many small files), so give it a minute before deciding it hangs.

## Things to know

- Co-op runs are never saved to a slot, and earn no unlocks.
- Both players choose their attacks at the same time. The one who picks first sees "Waiting for your partner...".
- In the shop each player has half of the money, can buy and move items for their own team only, and locks in one
  reward. If both want the same reward the player with priority (it alternates by wave) gets it and the other picks
  again. Either player can pay to reroll the rewards.
- **Run** only works when both players pick it on the same turn. **Poké Balls** work when one enemy is left, as in any
  double battle; the player who threw the ball chooses which of their own Pokemon to release (or lets the new one go).
- If the two games ever drift apart, the host's game resends the start of the wave and both go back to it
  (you lose the progress of that wave, not the run).
- If your connection drops, the game tries to reconnect by itself for up to 5 minutes. When it is back, both games go
  back to the start of the wave. Reloading the page ends the run.

## Balance testing

When a run ends, the wave-by-wave log is printed to the browser console (and `coopRunLog(true)` copies it as CSV any time).
Try other difficulty settings with `?coopBossCut=0&coopLevels=2` on the page address (both players must use the same).

## Profiles

Without an account, the game keeps its saves, Pokedex and unlocks in the browser, under a profile name. The default is
`Guest`. Add `?profile=Nickname` to the page address to play as another profile (for example
`http://localhost:8000/?profile=Matheus`), or use **Profile: Name** in the in-game menu (from the title screen; the page
reloads into the new profile). The browser remembers the choice, so later visits keep using it. Each
profile is separate, and the title screen shows "Logged in as: Nickname". Saves belong to the browser and the page
address (`localhost` and an IP address are different), so a friend on another computer has his own profile and
Pokedex. Co-op runs are never saved.

## Leaving a run

**Leave co-op run** in the menu ends the run and goes back to the title screen (nothing is saved). If either player
uses **Leave co-op run**, the other player sees "Your partner left the game" and is taken back to the title screen too.
A connection that simply drops is waited for (see above).
