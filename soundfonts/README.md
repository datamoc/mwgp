# Shared SoundFonts

MIDI music (RPG Maker XP/VX/Ace) sounds far better with real instrument samples. A game that ships
its own `.sf2` uses it automatically (the converter copies it into the game's local, gitignored
`MWGP_versions/` output). This directory holds an optional **shared** fallback for games that ship none.

**A SoundFont is a copyrighted work with its own licence, independent of any game.** This repo (and the
`mwg` library) may carry one, but only after it has been vetted:

1. Read the licence and check who owns the samples. It must allow redistribution with a software
   project (CC0, MIT/BSD, or CC-BY with attribution kept; "personal use only" and "non-commercial"
   are not enough). Samples derived from a commercial library are a red flag, so trace the
   provenance, not just the label on the download page.
2. Put the `.sf2` and its licence text in this directory (`<name>.LICENSE.txt`).
3. Record it in `vetted.json` (file, licence, licence file, source URL, sha256, who/when, notes).

`npm test` fails if any `.sf2`/`.sf3` in this directory or tracked by git is missing from
`vetted.json`, has a missing field, a missing licence file, or a checksum that no longer matches.
The server (`/soundfont.sf2`) serves only vetted entries, and the player uses it for MIDI when a game ships
no soundfont of its own.

**Vetted now:** GeneralUser GS v2.0.3 by S. Christian Collins (https://schristiancollins.com/generaluser),
free to use in software projects; its licence text is `GeneralUser-GS.LICENSE.txt`. Its author states the
provenance of every sample cannot be guaranteed; that residual risk was accepted on 2026-09-25. Research
notes on other candidates are in `CANDIDATES.md`.
