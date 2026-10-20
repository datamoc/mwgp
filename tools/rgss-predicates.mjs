// Ruby tells `ready?` (a predicate) from `ready` (an action) by the `?`; Ruby2JS drops the `?`, so a class that defines both ends up with
// one JS method, the last definition. A game that does (`def self.skip_battle` next to `def self.skip_battle?`) then runs the action
// where it asked a question, and a battle is skipped because its answer is a Promise. Every such name is rewritten in the Ruby source, in
// definitions and calls alike, to `name__q`, before anything is transpiled (library scripts and event snippets).
//
// Only a real clash is renamed: both forms defined in the same class or module body (by indentation), and never a name the Ruby core or
// this runtime already answers as a predicate, since renaming that would also rename the calls that reach the built-in.
const BUILT_IN_PREDICATES = new Set(['empty', 'visible', 'disposed', 'nil', 'zero', 'first', 'last', 'include', 'key', 'any', 'all', 'none', 'one', 'even', 'odd',
  'frozen', 'exist', 'exists', 'integer', 'finite', 'nan', 'between', 'blank', 'present', 'closed', 'alive', 'tainted', 'equal', 'eql', 'instance_of', 'kind_of', 'is_a']);
let renamed = new Set();

export function collidingPredicates(sources) {
  const clashing = new Set();
  for (const source of sources) {
    const stack = [];                 // [{ indent, name }]
    const members = new Map();        // container -> { predicates, plain }
    for (const line of String(source).split(/\r?\n/)) {
      if (!line.trim() || /^\s*#/.test(line)) continue;
      const indent = line.match(/^[ \t]*/)[0].length;
      while (stack.length && stack.at(-1).indent >= indent) stack.pop();
      const container = /^[ \t]*(class|module)[ \t]+([\w:]+)/.exec(line);
      if (container) { stack.push({ indent, name: container[2] }); continue; }
      const method = /^[ \t]*def[ \t]+(self\.)?([A-Za-z_]\w*)([?!=])?/.exec(line);
      if (!method || method[3] === '!' || method[3] === '=') continue;
      const key = `${stack.map(entry => entry.name).join('::')}${method[1] ? '.self' : ''}`;
      const entry = members.get(key) || { predicates: new Set(), plain: new Set() };
      (method[3] === '?' ? entry.predicates : entry.plain).add(method[2]);
      members.set(key, entry);
    }
    for (const { predicates, plain } of members.values()) for (const name of predicates) if (plain.has(name) && !BUILT_IN_PREDICATES.has(name)) clashing.add(name);
  }
  return clashing;
}

export function setPredicateRenames(names) { renamed = new Set(names); }
export const predicateRenames = () => renamed;

export function renamePredicates(source) {
  if (!renamed.size || typeof source !== 'string') return source;
  return source.replace(new RegExp(String.raw`\b(${[...renamed].join('|')})\?`, 'g'), '$1__q');
}
