import { WASI } from '@bjorn3/browser_wasi_shim';
import { parsePrism } from '../../transpilers/ruby2js-master/demo/selfhost/node_modules/@ruby/prism/src/parsePrism.js';
import wasmBytes from '../../transpilers/ruby2js-master/demo/selfhost/node_modules/@ruby/prism/src/prism.wasm';
export * from '../../transpilers/ruby2js-master/demo/selfhost/node_modules/@ruby/prism/src/nodes.js';
export * from '../../transpilers/ruby2js-master/demo/selfhost/node_modules/@ruby/prism/src/visitor.js';

export async function loadPrism() {
  const wasi = new WASI([], [], []);
  const { instance } = await WebAssembly.instantiate(wasmBytes, { wasi_snapshot_preview1: wasi.wasiImport });
  wasi.initialize(instance);
  return (source, options = {}) => parsePrism(instance.exports, source, options);
}
