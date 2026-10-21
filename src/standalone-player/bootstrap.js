// Small, uncompressed loader. Everything else, including the player and MWG,
// lives in the embedded gzip stream. No service worker or local server needed.
// The archive is read by mwgpArchive (gate.js, loaded earlier in the body), so the format is read in one place.
async function openStandaloneGame() {
  const status = document.querySelector('#unpacking');
  // The payload is split over several elements (a single script's text cannot
  // exceed the engine's string limit). Each is read, decoded and removed in turn.
  const elements = [...document.querySelectorAll('script[data-mwgp-payload], script#mwgp-payload')];
  if (!elements.length) throw new Error('The game content is missing.');
  const { metadata, files } = await mwgpArchive.readArchive(() => {
    const element = elements.shift();
    if (!element) return null;
    const text = element.textContent;
    element.remove();
    return text;
  }, (done, total) => { status.textContent = `Opening the game… ${done}/${total}`; });
  await mwgpArchive.start(files, metadata);
}
openStandaloneGame().catch(error => {
  const status = document.querySelector('#unpacking');
  if (status) { status.textContent = `Could not open the game: ${error.message}`; status.setAttribute('role', 'alert'); }
  console.error('MWGP standalone bootstrap failed', error);
});
