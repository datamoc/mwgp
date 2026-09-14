import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const file = process.argv[2];
if (!file) {
  console.error('Usage: node tools/validate-mwgp.js <mwgp.json>');
  process.exit(1);
}

const project = JSON.parse(await readFile(resolve(file), 'utf8'));
const errors = [];
const check = (condition, message) => { if (!condition) errors.push(message); };
check(project.format === 'MWGP', 'format must be MWGP');
check(Number.isInteger(project.version) && project.version >= 1, 'version must be a positive integer');
check(Array.isArray(project.maps) && project.maps.length > 0, 'maps must be a non-empty array');
check(project.initialMapId == null || project.maps.some(map => map.id === project.initialMapId), 'initialMapId must refer to a map');

const allowed = new Set(['say', 'ask', 'wait', 'setSwitch', 'setVariable', 'addVariable', 'if', 'move', 'transfer', 'picture', 'erasePicture', 'sound', 'turn']);
let eventCount = 0, commandCount = 0;
for (const map of project.maps || []) {
  const data = map.data;
  check(Number.isInteger(data?.width) && Number.isInteger(data?.height), `map ${map.id} has invalid dimensions`);
  check(Array.isArray(data?.data) && data.data.length === data.width * data.height * 6, `map ${map.id} must contain six MV layers`);
  for (const event of map.mwgEvents || []) {
    eventCount++;
    check(Array.isArray(event.pages), `event ${event.id} on map ${map.id} has no pages`);
    for (const page of event.pages || []) validateCommands(page.commands || [], event.id, map.id);
  }
}

function validateCommands(commands, eventId, mapId) {
  for (const command of commands) {
    commandCount++;
    check(Object.keys(command).some(key => allowed.has(key)), `unsupported command in event ${eventId} on map ${mapId}`);
    if (command.if) {
      check(command.if.switch || command.if.variable, `if command in event ${eventId} on map ${mapId} has no supported condition`);
      validateCommands(command.then || [], eventId, mapId);
      validateCommands(command.else || [], eventId, mapId);
    }
  }
}

if (errors.length) {
  console.error(errors.map(error => `- ${error}`).join('\n'));
  process.exit(1);
}
console.log(JSON.stringify({ valid: true, maps: project.maps.length, events: eventCount, commands: commandCount }));
