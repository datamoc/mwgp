import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { auditMvAssetUsage } from './asset-usage.mjs';
import { summarizeDiagnostics, WARNING_PREFIX } from './conversion-diagnostics.mjs';

const gameRoot = mkdtempSync(join(tmpdir(), 'mwgp-asset-usage-'));
const page = (name, list = []) => ({ image: { characterName: name }, list });
const map = (id, name, pages, extra = {}) => ({ id, info: { name }, data: { events: [{ id: 1, pages }], ...extra } });
const call = id => ({ code: 117, parameters: [id] });
function audit(maps, extra = {}) {
  return auditMvAssetUsage({ gameRoot, maps, system: { startMapId: 1 }, database: {}, ...extra });
}

try {
  mkdirSync(join(gameRoot, 'img/characters'), { recursive: true });
  writeFileSync(join(gameRoot, 'img/characters/Present.rpgmvp'), 'encrypted bytes');
  assert.equal(audit([map(1, 'Start', [page('Present')])]).missing.length, 0);

  let report = audit([map(2, 'Test map 2', [page('$BigMonster1')])]);
  assert.equal(report.errors, 0);
  assert.equal(report.warnings, 1);
  assert.equal(report.missing[0].reason, 'test-only');
  assert.match(report.missing[0].references[0].location, /Map002.json.*event 1 page 1/);

  report = audit([map(2, 'Test map 2', [page('Missing')]), map(3, 'Town', [page('Missing')])]);
  assert.equal(report.errors, 1, 'gameplay reference wins over a test-only reference');
  assert.equal(report.missing[0].references.length, 2);
  assert.equal(audit([map(1, 'Test start', [page('Missing')])]).errors, 1, 'a test-named start map is gameplay');
  assert.equal(audit([map(2, 'Contest hall', [page('Missing')])]).errors, 1, 'test must be a label, not part of contest');

  report = audit([map(1, 'Start', [], { bgm: { name: 'Disabled' }, autoplayBgm: false })]);
  assert.equal(report.missing[0].reason, 'unused');
  assert.equal(report.errors, 0);
  assert.equal(audit([map(1, 'Start', [], { bgm: { name: 'Disabled' }, autoplayBgm: true })]).errors, 1);

  const commonEvents = [null,
    { id: 1, name: 'Shared', trigger: 0, list: [call(2)] },
    { id: 2, name: 'Nested', trigger: 0, list: [call(1), { code: 231, parameters: [1, 'MissingPicture'] }] }
  ];
  report = audit([map(2, 'TEST', [page('', [call(1)])])], { commonEvents });
  assert.equal(report.warnings, 1, 'nested and cyclic common events inherit test use');
  assert.equal(report.errors, 0);
  report = audit([map(2, 'TEST', [page('', [call(1)])]), map(1, 'Start', [page('', [call(1)])])], { commonEvents });
  assert.equal(report.errors, 1, 'a gameplay caller upgrades the common event');
  assert.equal(audit([], { commonEvents }).errors, 1, 'uncalled common events can be called dynamically');

  const diagnostic = `${WARNING_PREFIX}missing asset img/characters/$BigMonster1 [test-only]`;
  assert.equal(summarizeDiagnostics(diagnostic).status, 'converted with warnings');
  assert.equal(summarizeDiagnostics(`${diagnostic}\nMWGP convert: broken command`).errors, 1);
  assert.equal(summarizeDiagnostics('').status, 'converted');

  // Exercise the actual CLI pipeline: stderr severity must survive batching,
  // and the report must be present in a validated manifest.
  const root = fileURLToPath(new URL('../', import.meta.url));
  const sources = join(gameRoot, 'sources');
  const source = join(sources, 'Fixture');
  const output = join(gameRoot, 'output');
  mkdirSync(join(source, 'data'), { recursive: true });
  for (const dir of ['img/tilesets', 'img/characters', 'img/faces', 'img/pictures', 'audio']) mkdirSync(join(source, dir), { recursive: true });
  writeFileSync(join(source, 'index.html'), '');
  const write = (name, value) => writeFileSync(join(source, 'data', name), JSON.stringify(value));
  write('System.json', { startMapId: 1, startX: 0, startY: 0, partyMembers: [] });
  write('MapInfos.json', [null, { name: 'Start' }, { name: 'Test map' }]);
  write('Tilesets.json', [null, { id: 1, tilesetNames: [], flags: [] }]);
  const mapData = { width: 1, height: 1, tilesetId: 1, data: [0, 0, 0, 0, 0, 0], events: [] };
  write('Map001.json', mapData);
  write('Map002.json', { ...mapData, events: [null, { id: 1, x: 0, y: 0, pages: [{ ...page('$BigMonster1'), conditions: {} }] }] });
  function convert() {
    const run = spawnSync(process.execPath, ['tools/convert-auto.js', sources, output, '--jobs', '1'], { cwd: root, encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
    return JSON.parse(run.stdout);
  }
  let summary = convert();
  assert.equal(summary.withWarnings, 1);
  assert.equal(summary.withErrors, 0);
  assert.match(summary.results[0].log, /\$BigMonster1.*test-only/);
  const manifestPath = join(output, 'Fixture', 'mwgp.json');
  assert.equal(JSON.parse(readFileSync(manifestPath)).compatibility.assets.missing[0].severity, 'warning');
  const validation = spawnSync(process.execPath, ['tools/validate-mwgp.js', manifestPath], { cwd: root, encoding: 'utf8' });
  assert.equal(validation.status, 0, validation.stdout + validation.stderr);
  write('MapInfos.json', [null, { name: 'Start' }, { name: 'Town' }]);
  summary = convert();
  assert.equal(summary.withErrors, 1);
  assert.equal(summary.withWarnings, 0);
  console.log('Asset usage: encrypted files, test-only/unused warnings, gameplay errors, common events and batch severity passed');
} finally {
  rmSync(gameRoot, { recursive: true, force: true });
}
