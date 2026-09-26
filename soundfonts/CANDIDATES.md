# SoundFont candidates (research notes)

**Status 2026-09-25: GeneralUser GS was accepted by michel (provenance risk knowingly accepted), added with its
licence text and recorded in `vetted.json`.** The other candidates below remain unvetted. A candidate becomes
usable only when a human accepts the evidence, the file and its licence text are added to this directory, and
`vetted.json` records it (see `README.md`). Researched
2026-09-25 from the sources cited; re-check them before relying on this.

## polyphone.io "sf2" listing (the link suggested)

https://www.polyphone.io/fr/soundfonts/tag/sf2?sort=rating — the page lists uploads such as "Kirby: Nightmare in
Dream Land GBA", "Tintin in Tibet (SNES)" and "Donald Duck (SNES)". Those are **rips of commercial game audio**;
being downloadable for free says nothing about the right to redistribute them. The page has a "commercial use
possible" filter, but each upload states its own terms and the listing itself shows none. Do not use anything
from this listing without reading that file's own licence page **and** tracing where its samples come from.

## GeneralUser GS (S. Christian Collins) — ACCEPTED and bundled

- Home: https://schristiancollins.com/generaluser — repository: https://github.com/mrbumpy409/GeneralUser-GS
  (licence file `documentation/LICENSE.txt`; version checked: v2.0.3).
- Licence, verbatim: "You may use GeneralUser GS without restriction for your own music creation, private or
  commercial. This SoundFont bank is provided to the community free of charge. Please feel free to use it in your
  software projects, and to modify the SoundFont bank or its packaging to suit your needs." and "GeneralUser GS
  inherits the usage rights of the samples contained within, all of which allow full use in music production,
  including the ability to make profit from musical recordings created with GeneralUser GS."
- Reading: redistribution with a software project is explicitly welcomed (open source or commercial); attribution
  is not required by the text (the author asks that people link to his site rather than to the download);
  modification allowed. ScanCode's LicenseDB has an entry for it (`generaluser-gs-2.0`).
- **Open point (needs a human decision):** the licence text itself says the author has "uncertain origins" for some
  of the samples and that no complaint has been received since 2000. The grant is clear, but the provenance of every
  sample is not documented, which is the "proprietary content" risk this repo wants to avoid. Accepting it means
  accepting that residual risk.
- Size: roughly 30 MB (the repository history is larger), so it would also weigh on the repo and on every clone.
  Alternatives to committing it: keep it out of git and let a user drop it into `soundfonts/` (still gated by
  `vetted.json`), or have the converter fetch it at install time.

## Not evaluated

FluidR3 GM, TimGM6mb (GPL: copyleft implications for redistribution), Arachno (personal use only, unsuitable),
and orchestral sets such as Sonatina. None was checked; add them here with their evidence if considered.
