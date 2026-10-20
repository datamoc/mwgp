import { createStandaloneHost } from './host.js';

const { files, metadata } = globalThis.mwgpStandalone;
document.documentElement.dataset.mwgpPlayerVersion = metadata.playerVersion;
globalThis.mwgpPlayerHost = await createStandaloneHost(files, metadata);
document.querySelector('#unpacking')?.remove();
await import('../../public/player.js');
