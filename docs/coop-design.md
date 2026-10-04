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
- **Both players shop at the same time.** Each client opens its own shop with half of the money (the odd coin goes to seat 0), and the halves are added back together when the shop closes. Purchases and held-item moves only affect your own team and are sent to the partner as they happen. Each player then locks in one reward (or skips) and waits for the partner. Both rewards are handed out in the same order on both clients. If both wanted the same reward, the priority seat (`waveIndex % 2`) gets it and the other player picks again from what is left. Reroll and reroll-lock are off in co-op. Hotseat mode still uses the one-screen, take-turns shop.

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

Everything below is implemented and covered by the tests in `test/tests/system/coop-*.test.ts` and `server/relay.test.mjs`.
None of it has been played in a real browser with two people yet.

- **Seats and ownership, forced doubles, seeded randomness, owner-aware switching and replacement, wipe/spectate.**
- **Per-seat command input.** Each seat's commands are sent as `CoopCommandMessage`s (`src/system/coop-commands.ts`)
  and the other client applies them. Both players pick at the same time.
- **Simultaneous shop** (`SelectModifierPhase`). Either player can reroll: the roller pays from their own wallet, and the
  rewards are re-rolled the same way on both clients (seeded by wave and reroll count, so what else happened in the
  shop does not matter). A lock-in made against rewards that were rerolled since is thrown away. After the shop each
  player is told what the partner bought or took.
- **Run.** The team only flees when every Pokemon on the field was told to run. If only one player picks Run, nothing
  happens and a message says both have to.
- **Catching.** Balls work as in a normal double battle (only when one enemy is left). The player whose Pokemon threw
  the ball decides what to release (their own Pokemon only) or to let the caught Pokemon go; the answer is sent as a
  `CoopChoice` and the other client does the same. The caught Pokemon joins the thrower's team.
- **Move learning.** When a Pokemon with a full move set learns a move (level-up, TM, evolution), only its owner is
  asked what to forget. The answer is sent as a `CoopChoice` and the other client applies it (`LearnMovePhase`).
- **Snapshots and rewinding** (`src/system/coop-snapshot.ts`). Both clients keep a copy of the run from the start of the
  current wave (taken where the game would normally save, which co-op never does). When the games disagree
  (`coopNetwork.onDesync`) the host sends its copy; both clients then go back to the title phase, load it the way
  "continue" does, and carry on from the start of that wave. Messages sent before the rewind are ignored until the
  other client says it has loaded the snapshot (`resync-ready`). The same wave is rewound at most 3 times, so a bug
  that keeps coming back cannot trap the players in a loop.
- **Reconnecting.** Once the run starts the relay keeps a dropped player's place for 5 minutes. The client retries on its
  own, takes its place back with a token, and the host then rewinds both games (messages sent during the gap are lost,
  so continuing from the current state would not be safe). If the other player quits on purpose they are told at once.
  A page reload loses the in-memory snapshot, so reloading the tab still ends the run.
- **Balance knobs and a run log** (`coop-balance.ts`, `coop-telemetry.ts`, see below).

## Balance

Every boss loses one health segment in co-op (never below 2), so two bosses at once, including the two Eternatus, are
less of a spike. Enemy levels are unchanged. These defaults are a guess. To try other values, add them to the page
address (both players must use the same ones): `?coopBossCut=0` (segments each boss loses) and `?coopLevels=2`
(levels every enemy gains, can be negative).

Each wave is recorded (turns, faints, health left, money, whether there was a boss, how it ended). When a run ends the
log is printed to the browser console as a table and kept in local storage (`coop_last_run`). At any time,
`coopRunLog(true)` in the console copies the run as CSV for a spreadsheet. Playtests with the log are what the numbers
should be tuned from.

## Known open items

- A page reload cannot be recovered (the snapshot lives in memory only).
- Mystery encounters with a fixed enemy list (for example Fight or Flight) put two player slots against that fixed
  number of enemies. That is easier for the players and is left as is.
- Level-up and evolution move prompts for a Pokemon wait for its owner, so the other player waits on that screen.
