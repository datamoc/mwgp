// The call filter compiles a paren-less zero-argument `x.name` into a call when the game defines a method `name`, which
// turns `sprite.x += 4` into `sprite.x() += 4` and `count++` into `count()++`: an assignment to a call. V8 accepts it and
// throws when it runs; a real parser (and the converter's lowering pass) rejects it. The target is a property.
export function repairCallAssignments(js) {
  return js
    .replace(/\.([A-Za-z_$][\w$]*)\(\)(\s*(?:\+|-|\*|\/|%|\*\*|\|\||&&|\?\?|<<|>>|&|\||\^)=)/g, '.$1$2')
    .replace(/\.([A-Za-z_$][\w$]*)\(\)(\+\+|--)/g, '.$1$2')
    .replace(/(\+\+|--)([A-Za-z_$][\w$.]*)\(\)/g, '$1$2');
}
