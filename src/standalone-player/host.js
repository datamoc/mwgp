const MIME = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', bmp: 'image/bmp',
  webp: 'image/webp', svg: 'image/svg+xml', ogg: 'audio/ogg', m4a: 'audio/mp4', mp3: 'audio/mpeg',
  wav: 'audio/wav', mid: 'audio/midi', midi: 'audio/midi', webm: 'video/webm', mp4: 'video/mp4',
  woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf', otf: 'font/otf',
  js: 'application/javascript', json: 'application/json', txt: 'text/plain',
};

// Base64 data URL of a file's byte parts, built when mwg first asks for it.
// Pixi picks an image's parser from the data URL's type, which a blob: URL
// does not carry. Building these up front held the whole image set as text
// (about a gigabyte for a large game) and the browser refused the reads.
function dataUrl(parts, type) {
  let text = '';
  for (const part of parts) for (let offset = 0; offset < part.length; offset += 0x8000) text += String.fromCharCode(...part.subarray(offset, offset + 0x8000));
  return `data:${type};base64,${btoa(text)}`;
}

// A local host for the normal player's API and MWG compiled-resource map.
// The files are the byte parts the page unpacked; images become data URLs and
// other files typed Blob URLs, each made on first use. The original bytes
// remain available to the local fetch host.
export async function createStandaloneHost(files, metadata) {
  const nativeFetch = globalThis.fetch.bind(globalThis);
  const lookup = new Map([...files].map(([name, parts]) => [name.toLowerCase(), parts]));
  const urls = new Map();
  const blobOf = (parts, type) => new Blob(parts, type ? { type } : {});
  const id = metadata.id, apiRoot = `/api/mwgp/${id}`;
  const manifest = JSON.parse(await blobOf(files.get('mwgp.json')).text());
  // Keep saves stable across re-export, and separate from other games and the
  // server player (RGSS's normal output directory may be called just "output").
  manifest.source.projectName = id;
  document.title = manifest.display?.title || 'MWGP Player';

  // A root-relative URL under file:///C:/ resolves to /C:/api/..., whereas
  // the same request over HTTPS resolves to /api/.... Both name our local API.
  const pathname = url => new URL(String(url), location.href).pathname.replace(/^\/[a-z]:/i, '');

  function fileName(url) {
    try {
      const path = decodeURIComponent(pathname(url));
      const prefix = apiRoot + '/assets/';
      return path.startsWith(prefix) ? 'assets/' + path.slice(prefix.length) : null;
    } catch { return null; }
  }
  function fileUrl(name) {
    const key = name.toLowerCase(), parts = lookup.get(key);
    if (!parts) return undefined;
    if (!urls.has(key)) {
      const type = MIME[name.split('.').pop().toLowerCase()] || 'application/octet-stream';
      urls.set(key, type.startsWith('image/') ? dataUrl(parts, type) : URL.createObjectURL(blobOf(parts, type)));
    }
    return urls.get(key);
  }
  const assetMap = new Proxy(Object.create(null), {
    get: (_, key) => typeof key === 'string' ? fileUrl(fileName(key) || '') : undefined,
    has: (_, key) => typeof key === 'string' && lookup.has((fileName(key) || '').toLowerCase()),
  });

  globalThis.fetch = async (input, options = {}) => {
    const url = typeof input === 'string' || input instanceof URL ? String(input) : input.url;
    if (/^(?:blob|data):/.test(url)) return nativeFetch(input, options);
    const method = options.method || input.method || 'GET';
    if (method !== 'GET' && method !== 'HEAD') return new Response(null, { status: 405 });
    const path = pathname(url);
    if (path === apiRoot + '/index') {
      return Response.json({ ...manifest, maps: manifest.maps.map(({ id, info }) => ({ id, info })) });
    }
    if (path.startsWith(apiRoot + '/maps/')) {
      const map = manifest.maps.find(map => Number(map.id) === Number(path.split('/').pop()));
      return map ? Response.json(map) : new Response(null, { status: 404 });
    }
    const name = fileName(url), parts = name && lookup.get(name.toLowerCase());
    if (parts) return new Response(method === 'HEAD' ? null : blobOf(parts), { headers: { 'Content-Type': MIME[name.split('.').pop().toLowerCase()] || 'application/octet-stream' } });
    // Missing optional files (including the server's shared SoundFont) are
    // answered locally. A standalone game never contacts a remote server.
    return new Response(null, { status: 404, statusText: 'Not in standalone game' });
  };
  return {
    id, runtimeUrl: fileUrl('.runtime/mwg.js'),
    installAssets: () => globalThis.mwg.Resources.setAssetMap(assetMap),
    loadPlayer: () => import('../player/player-core.js'),
    loadRgssRuntime: () => import('../player/rgss-script.js'),
  };
}
