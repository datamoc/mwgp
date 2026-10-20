// Only the operations used by the shared converters. Files stay as Blobs until
// requested; FileReaderSync is confined to the conversion Worker.
import { Buffer } from 'buffer';
import { basename, dirname, join, resolve } from './path.js';

const files = new Map(), directories = new Map();
const canonicalPaths = new Map();
const outputHandles = new Map();
let outputDirectory = null, tempCounter = 0;
export const outputRoot = '/output';
const missing = path => Object.assign(new Error(`File not found: ${path}`), { code: 'ENOENT' });
const canonical = path => canonicalPaths.get(resolve(path).toLowerCase()) || resolve(path);

function directory(path) {
  path = canonical(path);
  if (directories.has(path)) return path;
  const parent = path === '/' ? null : directory(dirname(path));
  if (parent) path = join(parent, basename(path));
  directories.set(path, new Map());
  canonicalPaths.set(path.toLowerCase(), path);
  if (parent) directories.get(parent).set(basename(path), true);
  return path;
}
export function registerFile(path, entry) {
  path = canonical(path);
  const parent = directory(dirname(path));
  path = join(parent, basename(path));
  directories.get(parent).set(basename(path), false);
  files.set(path, entry);
  canonicalPaths.set(path.toLowerCase(), path);
}
export function initializeFiles(entries, destination = null) {
  files.clear(); directories.clear(); canonicalPaths.clear(); directory('/');
  outputHandles.clear();
  outputDirectory = destination;
  if (destination) outputHandles.set(outputRoot, destination);
  for (const { path, file } of entries) {
    if (!path || path.startsWith('/') || path.includes('\\') || path.includes('\0') || path.includes(':') || path.split('/').some(part => !part || part === '..' || part === '.')) {
      throw new Error(`Invalid project path: ${path}`);
    }
    const absolute = join('/input', path);
    if (files.has(canonical(absolute))) throw new Error(`Duplicate project path: ${path}`);
    registerFile(absolute, { blob: file, size: file.size });
  }
  directory(outputRoot);
}
export const existsSync = path => files.has(canonical(path)) || directories.has(canonical(path));
export function readdirSync(path, options = {}) {
  const entries = directories.get(canonical(path));
  if (!entries) throw missing(path);
  return [...entries].map(([name, isDirectory]) => options.withFileTypes ? {
    name, isDirectory: () => isDirectory, isFile: () => !isDirectory, isSymbolicLink: () => false,
  } : name);
}
export const readdir = async (path, options) => readdirSync(path, options);
export async function mkdir(path) {
  path = resolve(path);
  directory(path);
  if (outputDirectory && (path === outputRoot || path.startsWith(outputRoot + '/'))) await writableDirectory(path);
}
export function statSync(path) {
  const key = canonical(path), entry = files.get(key), isDirectory = directories.has(key);
  if (!entry && !isDirectory) throw missing(path);
  return { size: entry?.size || 0, isDirectory: () => isDirectory, isFile: () => !isDirectory };
}
export const mkdtempSync = prefix => {
  const path = `${prefix}${++tempCounter}`; directory(path); return path;
};
export function rmSync(path) {
  const root = canonical(path);
  for (const key of files.keys()) if (key === root || key.startsWith(root + '/')) files.delete(key);
  for (const key of directories.keys()) if (key === root || key.startsWith(root + '/')) directories.delete(key);
  for (const [key, value] of canonicalPaths) if (value === root || value.startsWith(root + '/')) canonicalPaths.delete(key);
  directories.get(dirname(root))?.delete(basename(root));
}
export function cpSync(from, to) {
  from = canonical(from); to = resolve(to);
  if (files.has(from)) { registerFile(to, files.get(from)); return; }
  if (!directories.has(from)) throw missing(from);
  directory(to);
  for (const entry of readdirSync(from)) cpSync(join(from, entry), join(to, entry));
}
function entryAt(path) {
  const entry = files.get(canonical(path));
  if (!entry) throw missing(path);
  return entry;
}
function bytesOf(entry, raw) {
  const bytes = Buffer.from(raw);
  entry.decrypt?.(bytes);
  return bytes;
}
export function readFileSync(path, encoding) {
  const entry = entryAt(path);
  if (!entry.blob) throw new Error(`Synchronous output read is not supported: ${path}`);
  const bytes = bytesOf(entry, new FileReaderSync().readAsArrayBuffer(entry.blob));
  return encoding ? bytes.toString(encoding) : bytes;
}
export async function readFile(path, encoding) {
  const entry = entryAt(path);
  const blob = entry.blob || await entry.handle.getFile();
  const bytes = bytesOf(entry, await blob.arrayBuffer());
  return encoding ? bytes.toString(encoding) : bytes;
}
async function writableDirectory(path) {
  if (!outputHandles.has(path)) {
    const parent = await writableDirectory(dirname(path));
    outputHandles.set(path, await parent.getDirectoryHandle(basename(path), { create: true }));
  }
  return outputHandles.get(path);
}
export async function writeFile(path, data) {
  path = resolve(path);
  if (!path.startsWith(outputRoot + '/')) throw new Error(`Write outside output folder: ${path}`);
  const blob = new Blob([data]);
  if (outputDirectory) {
    const parent = await writableDirectory(dirname(path));
    const handle = await parent.getFileHandle(basename(path), { create: true });
    const writable = await handle.createWritable();
    try { await writable.write(blob); await writable.close(); }
    catch (error) { await writable.abort().catch(() => {}); throw error; }
    registerFile(path, { handle, size: blob.size });
  } else registerFile(path, { blob, size: blob.size });
}
export async function open(path, mode) {
  if (mode !== 'r') throw new Error(`Unsupported file mode: ${mode}`);
  const entry = entryAt(path);
  return {
    stat: async () => ({ size: entry.size }),
    async read(buffer, offset, length, position) {
      const bytes = new Uint8Array(await entry.blob.slice(position, position + length).arrayBuffer());
      buffer.set(bytes, offset);
      return { bytesRead: bytes.length, buffer };
    },
    close: async () => {},
  };
}
export const sourceEntry = entryAt;
export function outputEntries() {
  const entries = [...files].filter(([path]) => path.startsWith(outputRoot + '/'));
  // File pickers omit empty source directories. Preserve empty output
  // directories so extracted ZIPs satisfy the manifest's resource contract.
  for (const [path, children] of directories) {
    if (path.startsWith(outputRoot + '/') && !children.size) {
      entries.push([path + '/', { directory: true, size: 0, blob: new Blob([]) }]);
    }
  }
  return entries;
}
