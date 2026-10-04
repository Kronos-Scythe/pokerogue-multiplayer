# Co-op mode design notes

This fork adds a two-player co-op mode to PokeRogue. These notes record the rules that have been decided and how the
implementation maps onto the engine, so they survive outside of any one conversation.

## Rules

- **Two seats, two teams.** Each seat brings its own team of 3 Pokemon. Seat 0 controls field slot 0 and seat 1
  controls field slot 1.
- **Every fight is a double battle.** This includes the classic final boss (two Eternatus), endless bosses, mystery
  encounter fights and trainer fights. Trainers that have no double variant still send out two Pokemon, as they already
  do in normal waves.
- **A wiped seat spectates.** If a seat's whole team faints, that seat's slot stays empty and the other seat keeps
  fighting. The wiped seat still takes part in the next shop, so it can buy a revive. The run only ends when *both*
  teams are wiped.
- **Shop picks take turns.** The two seats alternate picking rewards.

## How it maps onto the engine

- The engine keeps its single 6-slot party. Each `PlayerPokemon` carries an `owner` seat (`0` or `1`), serialized in
  `PokemonData`. Old saves without an owner default to seat 0.
- `getPlayerField()` is still "the first two party slots". A field slot belongs to the team of the Pokemon sitting in
  it, not to its index, and a slot is only ever refilled from the same team (`sameSeat`). `normalizeCoopParty()` puts
  each team's first healthy Pokemon in slots 0 and 1 at the start of every wave. A wiped team keeps a fainted Pokemon
  in its slot, which is what makes it spectate until a revive.
- `coopSession` (`src/system/coop-session.ts`) holds whether a run is co-op, which seat this client plays, and a
  `hotseat` flag that lets one client control both seats for local testing.
- Battles are seeded per wave, so both clients simulate the full game and only exchange player inputs (lockstep).
  In co-op runs the few places that rolled unseeded randomness use the seeded generator instead.

## Status

Done: seats and ownership, forced doubles everywhere, seeded randomness in co-op, owner-aware switching and faint
replacement (party menu, forced switches, wave start), the wipe/spectate flow with revive at the shop.

Not done yet: per-seat command input, turn-taking in the shop, and the network layer (relay server and room codes, designed to work over a VPN, LAN or tunnel).

## Known open items

- Two Eternatus at level 200 is a large difficulty spike for a 3+3 team. Balance still needs a pass.
- Mystery encounters with a fixed enemy list (for example Fight or Flight) put two player slots against that fixed
  number of enemies.
