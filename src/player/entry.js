// In-game text/number entry (RPG Maker's Scene_Name and the number-input
// window): the player picks digits and letters from lists the game itself
// draws, instead of a browser prompt() that leaves the game. Both run over
// the same dialogue seam as battles and menus (`present({ text, choices })`,
// paged by createPicker), so they are deterministic and testable.
//
// Cancelling at the first step keeps the current value, as the engine's
// cancel does; cancelling later steps back one digit / returns to editing.
import { createPicker } from './battle.js';

export const NAME_LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789 ';

// Scene_NumberInput: one digit at a time, most significant first.
export async function runNumberInput({ present, digits = 1, current = 0, terms } = {}) {
  const pick = createPicker(present, terms);
  const count = Math.max(1, Math.min(9, Math.trunc(Number(digits)) || 1));
  const chosen = [];
  const rows = Array.from({ length: 10 }, (_, digit) => ({ label: String(digit), digit }));
  while (chosen.length < count) {
    const shown = chosen.join('').padEnd(count, '_');
    const entry = await pick(`Number: ${shown}`, rows);
    if (!entry) {
      if (!chosen.length) return Math.max(0, Math.trunc(Number(current)) || 0);
      chosen.pop();
      continue;
    }
    chosen.push(entry.digit);
  }
  return Number(chosen.join('')) || 0;
}

// Scene_Name: build the name letter by letter (Add / Delete / Done).
export async function runNameInput({ present, maxLength = 12, current = '', terms } = {}) {
  const pick = createPicker(present, terms);
  const limit = Math.max(1, Math.min(32, Math.trunc(Number(maxLength)) || 12));
  let name = String(current || '').slice(0, limit);
  const letterRows = [...NAME_LETTERS].map(ch => ({ label: ch === ' ' ? '(space)' : ch, ch }));
  for (;;) {
    const entry = await pick(`Name: ${name}_`, [
      { label: 'Add letter', action: 'add' },
      { label: 'Delete', action: 'delete' },
      { label: 'Done', action: 'done' },
    ]);
    if (!entry) return String(current || '');
    if (entry.action === 'done') return name;
    if (entry.action === 'delete') { name = name.slice(0, -1); continue; }
    if (name.length >= limit) continue;
    const letter = await pick(`Name: ${name}_`, letterRows);
    if (letter) name = (name + letter.ch).slice(0, limit);
  }
}
