# Manual play checklist

Per-game browser verification for converted projects. Serve with `npm start`
(`http://127.0.0.1:4173`, or `$RPGM_PORT`), open the launcher, pick a game,
and work through its rows. Record pass/fail plus the observed behavior; a fail
goes back to `roadmap.md` as a bug, not into this file as a note.

## Common steps (every game)

- [ ] Move: walk in all four directions; walls block, floors pass, no
  tile-glitch rendering (wrong autotile shapes, offset tiles).
- [ ] Dialogue: talk to an NPC (action key); text shows fully, advances cleanly.
- [ ] Choice: trigger a Show Choices event; every branch runs, cancel (where
  allowed) takes the cancel branch.
- [ ] Transfer: walk through a door/edge transfer; the next map loads with the
  player at the right position and state (switches/variables/gold) intact.
- [ ] Save/load: `F5` saves slot 1, `F9` loads it; position and progress survive
  a page reload.
- [ ] Banner review: note the compatibility warning shown at launch; every
  `unsupported`/`partial` entry must match the manifest's
  `compatibility.commands` report for that game.

## Per-game rows

### Karryn's Prison (MV)

- [ ] Opening map renders without the tile glitch.
- [ ] Common steps above.

### Way of Corruption 0.33 A (MV)

- [ ] Opening map renders; music plays (BGM path resolves).
- [ ] Common steps above.

### Pokemon Void 0.1.4 (XP)

- [ ] Opening map renders (XP autotiles via the `isXp` path); passages block
  walls (spot-check against the shipped `Game_Map#passable?` rule: set bit =
  blocked).
- [ ] Trainer NPC dialogue runs; self-switch pages flip after events.
- [ ] Common steps above.

### Pokemon Void 0.1.5 (encryptionfix) (XP)

- [ ] Same as 0.1.4; note any differences versus 0.1.4 in the result.

## Result log

| Date | Game | Pass/fail | Notes |
| --- | --- | --- | --- |
| 2026-09-19 | Karryn's Prison | partial | Banner OK; movement OK; FAIL tiles/sprites misaligned (head at feet, general across tiles) |
| | | | |
