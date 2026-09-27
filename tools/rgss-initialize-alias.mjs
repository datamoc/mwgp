// Ruby mods extend a method with `alias __x original` + a new `def original` that calls `__x`. Ruby2JS keeps only the last
// definition, leaving the call to `__x` pointing at nothing (and, for `initialize`, a derived constructor that uses `this`
// before `super`). Resolved on the Ruby source instead: the earlier `def original` (same indentation as the alias) becomes
// `def __x`, so the chain is preserved. For `initialize` the renamed original also loses its own `super`, and the last
// `initialize` starts with that original `super(...)`: constructor -> super -> the renamed originals. A setter aliased under a plain name (`alias __shadow_hpeq hp=`, invoked as `__shadow_hpeq(value)`) keeps a plain `def`: Ruby lets an aliased setter body run as an ordinary call, but a transpiled JS setter is not callable.
export function resolveInitializeAliases(source) {
  const aliasPattern = /^([ \t]*)alias(?:_method)?[ \t]+:?(\w+[?!]?),?[ \t]+:?(\w+[?!]?)(=)?(?!\w)[^\n]*$/m;
  const escapeName = name => name.replace(/[?!]/g, char => '\\' + char);
  const methods = new Set();
  let rootSuper = null;
  let sawInitialize = false;
  const skipped = new Set();
  for (let guard = 0; guard < 400; guard++) {
    // The first alias that has not been given up on.
    let alias = null, from = 0;
    for (let attempt = 0; attempt < 400; attempt++) {
      const found = aliasPattern.exec(source.slice(from));
      if (!found) break;
      const key = found.index + from;
      if (!skipped.has(found[0])) { alias = Object.assign([...found], { index: key }); break; }
      from = key + found[0].length;
    }
    if (!alias) break;
    const [line, indent, name, original, setterOriginal] = alias;
    const before = source.slice(0, alias.index);
    const defPattern = new RegExp(`^${indent}def ${escapeName(original)}(?![\\w?!])[^\\n]*$`, 'gm');
    let last = null, found;
    while ((found = defPattern.exec(before))) last = found;
    if (!last) { skipped.add(line); continue; }      // aliasing something inherited or built in: nothing to rename
    // Ruby's `alias new old` only renames `old` to `new` when a REDEFINITION of `old` follows (the shadow-and-override
    // idiom this function exists for): `old` is about to be overwritten, so its prior body must survive under `new`.
    // Without a following redefinition, this is a PLAIN alias (Ruby's ordinary "give this method another name" idiom,
    // e.g. `alias can_remove? has?` with `has?` never touched again): `original` must stay exactly as it is, under its
    // own name, and `name` becomes a thin forwarder to it instead.
    const afterAlias = source.slice(alias.index + line.length);
    const redefines = new RegExp(`^${indent}def ${escapeName(original)}(?![\\w?!])`, 'm').test(afterAlias);
    if (!redefines) {
      // A forwarder written as Ruby (this rewrite runs before Ruby2JS, on Ruby source): `def new(*a); original(*a); end`.
      // Plain positional forwarding only: Ruby2JS's self-host build lowers a trailing `&block` parameter by popping the
      // last positional argument off the splat, which corrupts an ordinary call with no block.
      source = source.slice(0, alias.index) + `${indent}def ${name}(*__mwgp_a)\n${indent}  ${original}(*__mwgp_a)\n${indent}end` + source.slice(alias.index + line.length);
      methods.add(name.replace(/[?!]$/, ''));
      continue;
    }
    source = source.slice(0, alias.index) + `${indent}# alias ${name} of ${original} resolved` + source.slice(alias.index + line.length);
    // The def's block: up to the next line that is just `end` at the def's indentation (or the def line itself when one-line).
    const rest = source.slice(last.index + last[0].length);
    const oneLiner = /\bend\s*$/.test(last[0]);
    const close = oneLiner ? { index: 0, 0: '' } : new RegExp(`^${indent}end\\b`, 'm').exec(rest);
    if (!close) continue;
    const blockEnd = last.index + last[0].length + close.index + close[0].length;
    let block = source.slice(last.index, blockEnd);
    if (original === 'initialize') {
      sawInitialize = true;
      const params = /def initialize\s*(?:\(([^)]*)\))?/.exec(block)?.[1] ?? '';
      const paramNames = params.split(',').map(part => part.trim().replace(/^[*&]+/, '').split('=')[0].trim()).filter(Boolean);
      const zsuper = /^[ \t]*super[ \t]*$/m, argsuper = /^[ \t]*super\(([^)]*)\)[ \t]*$/m;
      if (rootSuper === null) {
        const withArgs = argsuper.exec(block);
        if (withArgs) rootSuper = withArgs[1];
        else if (zsuper.test(block)) rootSuper = paramNames.join(', ');
      }
      block = block.replace(argsuper, '').replace(zsuper, '');
    }
    block = block.replace(new RegExp(`def ${escapeName(original)}(?![\\w?!])`), `def ${name}`);
    if (setterOriginal) block = block.replace(new RegExp(`def ${escapeName(name)}=`), `def ${name}`);
    source = source.slice(0, last.index) + block + source.slice(blockEnd);
    methods.add(name.replace(/[?!]$/, ''));
  }
  if (sawInitialize && rootSuper !== null) {
    const defs = [...source.matchAll(/^([ \t]*)def initialize\b[^\n]*$/gm)];
    const final = defs[defs.length - 1];
    if (final && !/^[ \t]*super\b/m.test(source.slice(final.index + final[0].length, final.index + final[0].length + 400))) {
      const insertAt = final.index + final[0].length;
      source = `${source.slice(0, insertAt)}\n${final[1]}  super(${rootSuper})${source.slice(insertAt)}`;
    }
  }
  return { source, methods };
}
