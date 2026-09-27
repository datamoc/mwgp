// Resume support for the browser maps sweep (tools/test-browser.mjs).
// Pure functions over the progress-log text, so the skip/prune rules are
// unit-testable without launching a browser.
export function parseResumeSkips(logText, projectName) {
  const done = new Set();
  for (const line of String(logText).split('\n')) {
    const match = line.match(/^\S+ (.+): map (\d+) ok$/);
    if (match && match[1] === projectName) done.add(Number(match[2]));
  }
  return done;
}

export function filterResumedMaps(maps, done) {
  const kept = maps.filter(map => !done.has(Number(map.id)));
  return { maps: kept, skipped: maps.length - kept.length };
}

// Drop a previous run's lines for one project, so a later resume cannot
// trust oks from an older run of it. PROBLEM lines go too: they are retried.
export function pruneProjectLines(logText, projectName) {
  return String(logText).split('\n')
    .filter(line => line && !line.includes(` ${projectName}: map `) && !line.includes(` ${projectName}: sweep start`))
    .map(line => line + '\n').join('');
}
