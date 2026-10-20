import { join } from './path.js';
import { mkdir, writeFile } from './fs.js';

// Browser conversion always creates a fresh output. Existing Studio projects
// must use the Node reconverter, which owns merge/lock/protected-resource state.
export async function createConversionOutput(folder) { await mkdir(folder); return folder; }
export async function publishConvertedAssets() { return 0; }
export async function writeConvertedManifest(folder, manifest) {
  // A directory upload does not expose empty folders. Materialize resource
  // directories promised by the manifest even if no file was selected in them.
  for (const [flag, path] of Object.entries({ tilesets: 'img/tilesets', characters: 'img/characters',
    faces: 'img/faces', pictures: 'img/pictures', audio: 'audio', autotiles: 'graphics/Autotiles' })) {
    if (manifest.assets?.[flag]) await mkdir(join(folder, 'assets', path));
  }
  const json = JSON.stringify(manifest);
  await writeFile(join(folder, '.mwgp-conversion.json'), json);
  await writeFile(join(folder, '.mwgp-merge-report.json'), '{"preserved":[],"conflicts":[]}');
  await writeFile(join(folder, 'mwgp.json'), json);
}
