// Ruby mods extend a method with `alias __x original` + a new `def original` that calls `__x`. Ruby2JS keeps only the last
// definition, leaving the call to `__x` pointing at nothing (and, for `initialize`, a derived constructor that uses `this`
// before `super`). Resolved on the Ruby source instead: the earlier `def original` (same indentation as the alias) becomes
// `def __x`, so the chain is preserved. For `initialize` the renamed original also loses its own `super`, and the last
// `initialize` starts with that original `super(...)`: constructor -> super -> the renamed originals. A setter aliased under a plain name (`alias __shadow_hpeq hp=`, invoked as `__shadow_hpeq(value)`) keeps a plain `def`: Ruby lets an aliased setter body run as an ordinary call, but a transpiled JS setter is not callable.
export function resolveInitializeAliases(source) {
  const aliasPattern = /^([ \t]*)alias(?:_method)?[ \t]+:?(\w+[?!]?),?[ \t]+:?(\w+[?!]?)(=)?(?!\w)[^\n]*$/m;
  const escapeName = name => name.replace(/[?!]/g, char => '\\' + char);
  const methods = new Set();
  const renames = new Map();   // alias -> the method name it was renamed from (for `super` inside the renamed body)
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
    // Reopened RGSS classes often use inconsistent indentation between the
    // engine definition and a plugin override. The unit has already been
    // grouped by class, so match the nearest prior method regardless of its
    // indentation; requiring an identical prefix left a second constructor.
    // `def x` is the reader and `def x=` the setter of one name: the alias targets the one it names.
    const kind = setterOriginal ? '(?==)' : '(?![\\w?!=])';
    const defPattern = new RegExp(`^[ \\t]*def ${escapeName(original)}${kind}[^\\n]*$`, 'gm');
    // Among the prior definitions the one at the alias's own indentation wins: a class nested in the unit has its own
    // `def initialize` (`Player::Pokedex`) that is nearer but is not the method being wrapped.
    // The class the alias is written in decides first (`Battle` vs the `Battle::DebugSetEffects` nested in it), indentation second.
    const aliasContainer = containerPath(source, alias.index);
    let last = null, sameIndent = null, sameContainer = null, found;
    while ((found = defPattern.exec(before))) {
      last = found;
      if (found[0].match(/^[ \t]*/)[0] === indent) sameIndent = found;
      if (containerPath(source, found.index) === aliasContainer) sameContainer = found;
    }
    last = sameContainer || sameIndent || last;
    if (!last) { skipped.add(line); continue; }      // aliasing something inherited or built in: nothing to rename
    // Ruby's `alias new old` only renames `old` to `new` when a REDEFINITION of `old` follows (the shadow-and-override
    // idiom this function exists for): `old` is about to be overwritten, so its prior body must survive under `new`.
    // Without a following redefinition, this is a PLAIN alias (Ruby's ordinary "give this method another name" idiom,
    // e.g. `alias can_remove? has?` with `has?` never touched again): `original` must stay exactly as it is, under its
    // own name, and `name` becomes a thin forwarder to it instead.
    const nextPiece = source.indexOf('\n# ---- ', alias.index + line.length);
    const afterAlias = source.slice(alias.index + line.length, nextPiece < 0 ? source.length : nextPiece);
    const redefines = new RegExp(`^[ \\t]*def ${escapeName(original)}${kind}`, 'm').test(afterAlias);
    if (!redefines) {
      // Ruby's alias snapshots the current method even if a later script
      // reopens the class. Keep the alias for the transpiler to capture as a
      // function reference; a forwarding method would recurse after override.
      skipped.add(line);
      methods.add(name.replace(/[?!]$/, ''));
      continue;
    }
    source = source.slice(0, alias.index) + `${indent}# alias ${name} of ${original}${setterOriginal ? "=" : ""} resolved` + source.slice(alias.index + line.length);
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
    if (original !== 'initialize') renames.set(name.replace(/[?!]$/, ''), original.replace(/[?!]$/, ''));
  }
  if (sawInitialize && rootSuper !== null) {
    const defs = [...source.matchAll(/^([ \t]*)def initialize\b[^\n]*$/gm)];
    const final = defs[defs.length - 1];
    if (final && !/^[ \t]*super\b/m.test(source.slice(final.index + final[0].length, final.index + final[0].length + 400))) {
      const insertAt = final.index + final[0].length;
      source = `${source.slice(0, insertAt)}\n${final[1]}  super(${rootSuper})${source.slice(insertAt)}`;
    }
  }
  return { source, methods, renames };
}

// The `class`/`module` bodies enclosing `offset`, outermost first, found by walking up the lines to ever smaller indentation. A script
// boundary (`# ---- name ----`, put between the pieces of a unit) ends the walk: each piece reopens its class from the top.
function containerPath(source, offset) {
  const names = [];
  let need = Infinity;
  const lineStart = source.lastIndexOf('\n', offset - 1) + 1;
  need = source.slice(lineStart).match(/^[ \t]*/)[0].length;
  let end = lineStart - 1;
  while (end > 0) {
    const start = source.lastIndexOf('\n', end - 1) + 1;
    const line = source.slice(start, end);
    end = start - 1;
    if (/^# ---- /.test(line)) break;
    if (!line.trim() || /^\s*#/.test(line)) continue;
    const indent = line.match(/^[ \t]*/)[0].length;
    if (indent >= need) continue;
    const container = /^[ \t]*(?:class|module)[ \t]+([\w:]+)/.exec(line);
    if (container) names.unshift(container[1]);
    need = indent;
    if (need === 0) break;
  }
  return names.join('/');
}
