// Machine-readable progress for tools/convert-auto.js. When MWGP_PROGRESS is set, a converter reports its progress as
// `@@progress {"done":n,"total":100,"label":"..."}` lines on stderr; otherwise every call is a no-op.
// A converter splits 100 points into phases weighted by their usual share of the run (`phase(label, weight, count)`);
// a phase made of `count` items (maps, files, library units) advances by weight/count per `tick()`, so the bar moves
// steadily and never goes backwards. Ticks beyond `count` are ignored; `end()` credits whatever a phase has left.
export const PROGRESS_PREFIX = '@@progress ';

export function createProgress() {
  const enabled = Boolean(process.env.MWGP_PROGRESS);
  let done = 0, label = '', lastSent = 0, lastDone = -1;
  const emit = (force = false) => {
    if (!enabled) return;
    const now = Date.now();
    // At most ~10 lines a second unless something finished: the parent only redraws that often anyway.
    if (!force && now - lastSent < 100 && Math.floor(done) === Math.floor(lastDone)) return;
    lastSent = now; lastDone = done;
    process.stderr.write(`${PROGRESS_PREFIX}${JSON.stringify({ done: Math.round(done * 10) / 10, total: 100, label })}\n`);
  };
  return {
    phase(text, weight, count = 1) {
      const start = done, per = count > 0 ? weight / count : 0;
      let ticks = 0;
      label = text; emit(true);
      return {
        // `amount` weighs an item by its size (bytes of source, say) when count is a total size rather than an item count.
        tick(itemLabel, amount = 1) { if (ticks >= count) return; ticks = Math.min(count, ticks + amount); done = start + per * ticks; if (itemLabel) label = `${text}: ${itemLabel}`; emit(); },
        end() { done = start + weight; emit(true); }
      };
    }
  };
}
