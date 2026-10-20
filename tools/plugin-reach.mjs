// What a plugin's own command code reaches, for the compatibility report: the engine
// layers the player runs for real (Game_* state, data managers, audio) versus the
// display layer it never runs (windows, scenes and sprites are inert stubs in the
// plugin sandbox, src/player/rgss-script.js). The compatibility report uses it so a
// plugin command whose dispatch stays in game state is rated supported - it runs here
// - while one that opens a scene or builds a sprite still lands its effect on an
// object nobody draws and stays partial.
// Detection by capability: it names engine classes, never a game or a plugin.
//
//   dispatchReach(source) -> [{ word, reaches }] | null (unparsable source)
//
// An MV project has one entry per `Game_Interpreter.prototype.pluginCommand` override
// with `word: null` (it answers every word the plugin handles); an MZ project has one
// per `PluginManager.registerCommand('<word>', ...)` with that word. `reaches` is the
// sorted list of display class names the dispatch and the plugin-local functions it
// calls reference.
import * as acorn from 'acorn';
import * as walk from 'acorn-walk';

// The display classes the player never runs: a constructor call, a prototype read or a
// static call on one of these is what "reaches the display layer" means here.
const DISPLAY = /^(?:Window_|Scene_|Sprite_|Spriteset_|Sprite$|Bitmap$|Tilemap$|TilingSprite$|Weather$|ScreenSprite$|Stage$|ColorTone$|SceneManager$)/;
const FUNCTION = new Set(['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression']);
// Bounded work per plugin: a command dispatch never legitimately pulls in a whole
// script corpus, and a pathological call graph must not stall a conversion.
const MAX_FUNCTIONS = 400;

// `Game_Interpreter.prototype.pluginCommand` -> ['Game_Interpreter', 'prototype', 'pluginCommand'].
const memberPath = node => {
  if (!node) return null;
  if (node.type === 'Identifier') return [node.name];
  if (node.type === 'ThisExpression') return ['this'];
  if (node.type !== 'MemberExpression' || node.computed) return null;
  const object = memberPath(node.object);
  return object && !node.computed && node.property.type === 'Identifier' ? [...object, node.property.name] : null;
};

// Aliases are the MV idiom (`var _GI = Game_Interpreter.prototype; _GI.pluginCommand = ...`):
// resolve the dotted path a name stands for, so an aliased definition and the calls that
// reach it share one key.
const resolvePath = (path, aliases) => {
  for (let round = 0; round < 2; round++) {
    const alias = aliases.get(path[0]);
    if (!alias) break;
    path = [...alias, ...path.slice(1)];
  }
  return path;
};
const keyOf = (path, aliases) => resolvePath(path, aliases).join('.');
// The class a member belongs to, for `this.member()` inside a dispatch.
const receiverOf = (path, aliases) => {
  const resolved = resolvePath(path, aliases);
  return resolved[1] === 'prototype' ? resolved[0] : null;
};

function indexFunctions(ast) {
  const functions = new Map(), aliases = new Map(), declared = new Set();
  const add = (key, node, receiver) => { if (key && !functions.has(key)) functions.set(key, { node, receiver }); };
  walk.full(ast, node => {
    if (node.type === 'VariableDeclarator' && node.id.type === 'Identifier') {
      declared.add(node.id.name);
      const init = memberPath(node.init);
      if (init && init[0] !== 'this') aliases.set(node.id.name, resolvePath(init, aliases));
    }
    if (node.type === 'FunctionDeclaration' && node.id) { declared.add(node.id.name); add(node.id.name, node, null); }
    if (node.type === 'ClassDeclaration' && node.id) declared.add(node.id.name);
    if (node.type === 'VariableDeclarator' && node.init && FUNCTION.has(node.init.type) && node.id.type === 'Identifier') add(node.id.name, node.init, null);
    if (node.type === 'AssignmentExpression' && node.right && FUNCTION.has(node.right.type) && node.left.type === 'MemberExpression') {
      const path = memberPath(node.left);
      if (path) add(keyOf(path, aliases), node.right, receiverOf(path, aliases));
    }
  });
  return { functions, aliases, declared };
}

// Display class names a function body references. A name the plugin declares itself
// (its own `Sprite_*` helper class, say) is not the engine's display layer.
function displayHits(node, declared) {
  const hits = new Set();
  walk.ancestor(node, {
    Identifier(id, ancestors) {
      if (!DISPLAY.test(id.name) || declared.has(id.name)) return;
      const parent = ancestors[ancestors.length - 2];
      if (!parent) return;
      if (parent.type === 'MemberExpression' && parent.property === id && !parent.computed) return;  // obj.Scene_Map
      if (parent.type === 'Property' && parent.key === id && !parent.computed) return;               // { Scene_Map: ... }
      if ((parent.type === 'VariableDeclarator' && parent.id === id) || (parent.type === 'FunctionDeclaration' && parent.id === id)) return;
      hits.add(id.name);
    }
  });
  return hits;
}

// The dispatch body plus every plugin-local function it calls (a bounded walk over the
// plugin's own definitions: commands route their work through helpers).
function scanReach(entry, functions, aliases, declared) {
  const hits = new Set(), seen = new Set();
  const queue = [{ node: entry.node, receiver: entry.receiver }];
  for (let visited = 0; queue.length && visited < MAX_FUNCTIONS;) {
    const current = queue.shift();
    visited++;
    for (const hit of displayHits(current.node, declared)) hits.add(hit);
    walk.simple(current.node, {
      CallExpression(call) {
        const callee = call.callee;
        if (callee.type !== 'MemberExpression' || callee.computed) return;
        const path = memberPath(callee);
        if (!path) return;
        // `this.helper()` inside a dispatch belongs to the class the dispatch hangs on.
        if (path[0] === 'this' && current.receiver) path[0] = current.receiver;
        for (const key of [keyOf(path, aliases), keyOf([path[0], 'prototype', ...path.slice(1)], aliases)]) {
          const target = functions.get(key);
          if (!target || seen.has(key)) continue;
          seen.add(key);
          queue.push({ node: target.node, receiver: target.receiver || current.receiver });
          break;
        }
      }
    });
  }
  return [...hits].sort();
}

export function dispatchReach(source) {
  let ast;
  try { ast = acorn.parse(source, { ecmaVersion: 'latest' }); } catch { return null; }
  const { functions, aliases, declared } = indexFunctions(ast);
  const entries = [];
  walk.full(ast, node => {
    if (node.type === 'AssignmentExpression' && node.right && FUNCTION.has(node.right.type) && node.left.type === 'MemberExpression') {
      const path = memberPath(node.left);
      if (path && path[path.length - 1] === 'pluginCommand') entries.push({ word: null, node: node.right, receiver: receiverOf(path, aliases) });
    }
    if (node.type === 'CallExpression' && node.callee.type === 'MemberExpression' && !node.callee.computed
      && node.callee.object?.type === 'Identifier' && node.callee.object.name === 'PluginManager' && node.callee.property.name === 'registerCommand'
      && node.arguments[1] && FUNCTION.has(node.arguments[1].type)
      && node.arguments[0]?.type === 'Literal' && typeof node.arguments[0].value === 'string') {
      entries.push({ word: node.arguments[0].value, node: node.arguments[1], receiver: null });
    }
  });
  return entries.map(entry => ({ word: entry.word, reaches: scanReach(entry, functions, aliases, declared) }));
}
