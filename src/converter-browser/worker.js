import { Zip, ZipDeflate, ZipPassThrough } from 'fflate';
import { existsSync, initializeFiles, outputEntries, outputRoot } from './fs.js';
import { join } from './path.js';
import { standaloneOutput } from './standalone.js';

const send = (type, value) => postMessage({ type, ...value });
const describe = value => typeof value === 'string' ? value : String(value?.message || value);

async function zipOutput(entries, name) {
  // fflate emits classic ZIP, not ZIP64. Fail before packaging, with a usable
  // alternative, rather than silently producing a corrupt large archive.
  const bytes = entries.reduce((sum, [path, entry]) => sum + entry.size + path.length * 6 + 256, 0);
  if (entries.length >= 65535 || bytes >= 0xffffffff) {
    throw new Error('Le résultat dépasse les limites du ZIP (4 Go ou 65 535 fichiers). Utilisez la sortie vers un dossier.');
  }
  const chunks = [];
  let zipError = null;
  const zip = new Zip((error, chunk) => {
    if (error) zipError = error;
    else chunks.push(new Blob([chunk]));
  });
  let done = 0, lastProgress = 0;
  for (const [path, entry] of entries) {
    const relative = path.slice(outputRoot.length + 1);
    const file = /\.(json|js|txt|css|xml|ini)$/i.test(relative)
      ? new ZipDeflate(relative, { level: 1 }) : new ZipPassThrough(relative);
    zip.add(file);
    for (let offset = 0; offset < entry.blob.size; offset += 1024 * 1024) {
      const end = Math.min(entry.blob.size, offset + 1024 * 1024);
      file.push(new Uint8Array(await entry.blob.slice(offset, end).arrayBuffer()), end === entry.blob.size);
      if (zipError) throw zipError;
    }
    if (!entry.blob.size) file.push(new Uint8Array(), true);
    done++;
    if (Date.now() - lastProgress > 100 || done === entries.length) {
      send('progress', { done, total: entries.length, label: `Création du ZIP : ${relative}`, packaging: true });
      lastProgress = Date.now();
    }
  }
  zip.end();
  if (zipError) throw zipError;
  return { blob: new Blob(chunks, { type: 'application/zip' }), name: `${name}.zip` };
}

self.onmessage = async ({ data }) => {
  try {
    // Compatibility with the CLI's progress/environment only. No Node runtime
    // or process execution is shipped in the page.
    globalThis.process = {
      argv: ['browser'], env: { MWGP_PROGRESS: '1' }, on() {},
      stderr: { write(line) {
        if (line.startsWith('@@progress ')) send('progress', JSON.parse(line.slice(11)));
      } },
    };
    for (const level of ['log', 'warn', 'error']) console[level] = (...args) => send('log', { level, message: args.map(describe).join(' ') });
    initializeFiles(data.entries, data.destination);
    const root = join('/input', data.project);
    const webRoot = existsSync(join(root, 'www', 'index.html')) ? join(root, 'www') : root;
    let manifest;
    if (existsSync(join(webRoot, 'index.html')) && existsSync(join(webRoot, 'data', 'System.json'))) {
      send('log', { level: 'log', message: 'Projet MV/MZ détecté.' });
      const { convertMv } = await import('../../tools/convert-mv.js');
      manifest = await convertMv(root, outputRoot, ['--copy-assets']);
    } else if (['rxdata', 'rvdata', 'rvdata2'].some(ext => existsSync(join(root, 'Data', `System.${ext}`))) ||
        ['Game.rgssa', 'Game.rgssad', 'Game.rgss2a', 'Game.rgss3a'].some(name => existsSync(join(root, name)))) {
      send('log', { level: 'log', message: 'Projet XP/VX/Ace détecté. Chargement du transpileur Ruby…' });
      const { convertRgss } = await import('../../tools/convert-rgss.js');
      manifest = await convertRgss(root, outputRoot);
    } else throw new Error('Projet non reconnu. Sélectionnez le dossier contenant www/, data/System.json ou Game.ini et les données RGSS.');
    const entries = outputEntries();
    const summary = { title: manifest.display.title, engine: manifest.source.engine, maps: manifest.maps.length,
      files: entries.filter(([, entry]) => !entry.directory).length };
    let archive = null;
    if (!data.destination) {
      archive = data.output === 'html'
        ? await standaloneOutput(entries, data.outputName, data.project, manifest.source.engine, value => send('progress', value))
        : await zipOutput(entries, data.outputName);
    }
    send('complete', { summary, archive });
  } catch (error) {
    send('failure', { message: describe(error), stack: error?.stack || '' });
  }
};
