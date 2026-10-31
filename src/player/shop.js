// The shop (RPG Maker's Scene_Shop): Buy / Sell / Leave over the project's own
// database, driven through the same dialogue seam as battles and menus
// (`present({ text, choices })`, paged five entries at a time), so it is
// deterministic and testable. Buying asks a quantity (limited by gold and the
// engine's 99-per-item cap); selling pays half the database price, rounded
// down, for anything in the inventory with a price.
//
//   runShop({ database, state, items, weapons, armors, goods, present })
//
// `state` is `{ gold }`, mutated in place; the inventories are `{ id: count }`
// maps, also mutated in place. `goods` is the converter's shop list:
// `{ kind: 0 item | 1 weapon | 2 armor, id, priceType, price }` where
// priceType 1 overrides the database price for buying (selling always uses
// the database price, as in the engine).
import { createPicker, battleText } from './battle.js';

const MAX_ITEM = 99;
const STORES = ['items', 'weapons', 'armors'];
const TABLES = ['items', 'weapons', 'armors'];

export function sellPrice(item) {
  return Math.floor(Math.max(0, Number(item?.price || 0)) / 2);
}

export async function runShop({ database, state, items, weapons, armors, goods = [], present }) {
  const { terms } = battleText(database);
  const pick = createPicker(present, terms);
  const currency = database.system?.currencyUnit || 'G';
  const inventories = { items, weapons, armors };
  const header = () => `${state.gold}${currency}`;
  const say = async text => { await present({ text }); };

  const buyEntries = (goods || []).filter(entry => Number(entry?.id) > 0).map(entry => {
    const store = STORES[Number(entry.kind)] || 'items';
    const item = database[TABLES[Number(entry.kind)] || 'items']?.[Number(entry.id)];
    const price = Number(entry.priceType) === 1 ? Math.max(0, Number(entry.price || 0)) : Math.max(0, Number(item?.price || 0));
    return { store, id: Number(entry.id), item, price };
  }).filter(entry => entry.item);

  const ownedEntries = () => STORES.flatMap(store => Object.entries(inventories[store] || {})
    .filter(([, count]) => count > 0)
    .map(([id, count]) => ({ store, id: Number(id), count, item: database[store]?.[Number(id)] }))
    .filter(entry => entry.item && sellPrice(entry.item) > 0));

  const chooseQuantity = async (max, label) => {
    if (max < 1) return 0;
    const rows = Array.from({ length: max }, (_, i) => ({ label: `${i + 1}`, amount: i + 1 }));
    const chosen = await pick(label, rows);
    return chosen ? chosen.amount : 0;
  };

  const buy = async () => {
    for (;;) {
      const entry = await pick(header(), buyEntries.map(candidate => ({
        ...candidate,
        label: `${candidate.item.name} - ${candidate.price}${currency} (${(inventories[candidate.store][candidate.id] || 0)})`,
      })));
      if (!entry) return;
      const owned = inventories[entry.store][entry.id] || 0;
      const max = Math.min(MAX_ITEM - owned, entry.price > 0 ? Math.floor(state.gold / entry.price) : MAX_ITEM - owned);
      if (max < 1) { await say(owned >= MAX_ITEM ? 'You cannot carry more.' : 'Not enough gold.'); continue; }
      const amount = await chooseQuantity(max, `${entry.item.name} - ${entry.price}${currency}`);
      if (!amount) continue;
      state.gold -= entry.price * amount;
      inventories[entry.store][entry.id] = owned + amount;
    }
  };

  const sell = async () => {
    for (;;) {
      const owned = ownedEntries();
      if (!owned.length) { await say('Nothing to sell.'); return; }
      const entry = await pick(header(), owned.map(candidate => ({
        ...candidate,
        label: `${candidate.item.name} - ${sellPrice(candidate.item)}${currency} (${candidate.count})`,
      })));
      if (!entry) return;
      const amount = await chooseQuantity(entry.count, `${entry.item.name} - ${sellPrice(entry.item)}${currency}`);
      if (!amount) continue;
      state.gold += sellPrice(entry.item) * amount;
      inventories[entry.store][entry.id] -= amount;
      if (inventories[entry.store][entry.id] <= 0) delete inventories[entry.store][entry.id];
    }
  };

  if (!buyEntries.length && !ownedEntries().length) { await say('This shop has nothing available.'); return; }
  for (;;) {
    const chosen = await pick(header(), [
      { label: terms.messages?.buy || 'Buy', run: buy },
      { label: terms.messages?.sell || 'Sell', run: sell },
      { label: terms.messages?.cancel || 'Leave', run: null },
    ], { back: false });
    if (!chosen?.run) return;
    await chosen.run();
  }
}
