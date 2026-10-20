const MIME = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', bmp: 'image/bmp',
  webp: 'image/webp', svg: 'image/svg+xml', ogg: 'audio/ogg', m4a: 'audio/mp4', mp3: 'audio/mpeg',
  wav: 'audio/wav', mid: 'audio/midi', midi: 'audio/midi', webm: 'video/webm', mp4: 'video/mp4',
  woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf', otf: 'font/otf',
  js: 'application/javascript', json: 'application/json', txt: 'text/plain',
};

// A local host for the normal player's API and MWG compiled-resource map.
// MWG/Pixi's compiled texture loader expects typed data URLs; other resources
// use Blob URLs. The original bytes remain available to the local fetch host.
export async function createStandaloneHost(files, metadata) {
  const nativeFetch = globalThis.fetch.bind(globalThis);
  const lookup = new Map([...files].map(([name, blob]) => [name.toLowerCase(), blob]));
  const urls = new Map();
  for (const [name, blob] of lookup) {
    const type = MIME[name.split('.').pop()];
    if (!type?.startsWith('image/')) continue;
    const uri = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(new Blob([blob], { type }));
    });
    urls.set(name, uri);
  }
  const id = metadata.id, apiRoot = `/api/mwgp/${id}`;
  const manifest = JSON.parse(await files.get('mwgp.json').text());
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
    const key = name.toLowerCase(), blob = lookup.get(key);
    if (!blob) return undefined;
    if (!urls.has(key)) {
      const extension = name.split('.').pop().toLowerCase();
      const typed = new Blob([blob], { type: MIME[extension] || 'application/octet-stream' });
      urls.set(key, URL.createObjectURL(typed));
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
    const name = fileName(url), blob = name && lookup.get(name.toLowerCase());
    if (blob) return new Response(method === 'HEAD' ? null : blob, { headers: { 'Content-Type': MIME[name.split('.').pop().toLowerCase()] || 'application/octet-stream' } });
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
