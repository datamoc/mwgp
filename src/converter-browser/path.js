// The virtual filesystem uses POSIX paths on every host.
export const sep = '/';
export function resolve(...parts) {
  const stack = [];
  for (const part of parts) {
    if (part.startsWith('/')) stack.length = 0;
    for (const segment of part.split('/')) {
      if (segment === '..') stack.pop();
      else if (segment && segment !== '.') stack.push(segment);
    }
  }
  return '/' + stack.join('/');
}
export const join = (...parts) => resolve(parts.join('/'));
export const dirname = path => resolve(path, '..');
export const basename = path => resolve(path).split('/').pop();
export function extname(path) {
  const name = basename(path), dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot) : '';
}
