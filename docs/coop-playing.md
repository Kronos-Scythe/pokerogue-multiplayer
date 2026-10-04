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
