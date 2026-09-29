// Small libretro frontend. The mkxp-z core and Nostalgist are copied into each web build.
(async () => {
  const status = document.querySelector('#status');
  const message = document.querySelector('#message');
  const progress = document.querySelector('#progress');
  const start = document.querySelector('#start');
  const state = { phase: 'loading' };
  globalThis.__MWGP_RGSS__ = state;
  try {
    if (!crossOriginIsolated) throw new Error('Cross-origin isolation is required. Serve this page with COOP and COEP headers.');
    const info = await fetch('mwgp-web.json').then(response => {
      if (!response.ok) throw new Error(`Build metadata: HTTP ${response.status}`);
      return response.json();
    });
    document.title = info.title;
    const opfs = await navigator.storage.getDirectory().catch(() => null);
    const gamePath = `games/${info.archive.sha256}.mkxpz`;
    const persistent = '/mwgp/persistent';
    const saveDir = `${persistent}/saves/mkxp-z/${encodeURIComponent(info.source.projectName)}`;
    const load = async (name, label, destination, expectedBytes, mimeType) => {
      message.textContent = `Downloading ${label}…`;
      if (destination) {
        let folder = opfs;
        const parts = destination.split('/');
        for (const part of parts.slice(0, -1)) folder = await folder.getDirectoryHandle(part, { create: true });
        const handle = await folder.getFileHandle(parts.at(-1), { create: true });
        const cached = await handle.getFile();
        if (cached.size === expectedBytes) return mimeType ? new Blob([cached], { type: mimeType }) : cached;
        const response = await fetch(name);
        if (!response.ok) throw new Error(`${name}: HTTP ${response.status}`);
        const total = Number(response.headers.get('content-length'));
        progress.max = total || 1; progress.value = 0;
        const writer = await handle.createWritable();
        const reader = response.body.getReader();
        let loaded = 0;
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            await writer.write(value); loaded += value.length;
            if (total) progress.value = loaded;
            message.textContent = `Downloading ${label}… ${total ? Math.round(loaded / total * 100) + '%' : Math.round(loaded / 1048576) + ' MB'}`;
          }
          await writer.close();
        } catch (error) { await writer.abort(); throw error; }
        const file = await handle.getFile();
        return mimeType ? new Blob([file], { type: mimeType }) : file;
      }
      const response = await fetch(name);
      if (!response.ok) throw new Error(`${name}: HTTP ${response.status}`);
      const total = Number(response.headers.get('content-length'));
      progress.max = total || 1;
      progress.removeAttribute('value');
      if (!response.body) return response.blob();
      const reader = response.body.getReader();
      const chunks = []; let loaded = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value); loaded += value.length;
        if (total) progress.value = loaded;
        message.textContent = `Downloading ${label}… ${total ? Math.round(loaded / total * 100) + '%' : Math.round(loaded / 1048576) + ' MB'}`;
      }
      return new Blob(chunks, { type: mimeType || response.headers.get('content-type') || 'application/octet-stream' });
    };
    const jsName = 'mkxp-z_libretro.js', wasmName = 'mkxp-z_libretro.wasm';
    const corePath = name => `cores/${info.core.revision}/${info.core.files[name].sha256}-${name}`;
    const coreJs = await load(jsName, 'core JavaScript', opfs ? corePath(jsName) : null, info.core.files[jsName].bytes, 'text/javascript');
    const coreWasm = await load(wasmName, 'core WebAssembly', opfs ? corePath(wasmName) : null, info.core.files[wasmName].bytes, 'application/wasm');
    const game = await load('game.mkxpz', 'game', opfs ? gamePath : null, info.archive.bytes);
    message.textContent = 'Initializing the WebAssembly core…';
    progress.removeAttribute('value');
    // Feed the WASM compile through the Cache Storage API so Chromium's V8 code cache can
    // attach to it: instantiateStreaming from a cache-backed Response lets a later launch
    // skip recompiling the ~40MB core instead of recompiling it (via Nostalgist's plain
    // wasmBinary path) on every start. Falls back to that plain path on any failure.
    const instantiateWasm = async (imports, successCallback) => {
      try {
        const cacheKey = `${wasmName}?core=${info.core.revision}-${info.core.files[wasmName].sha256}`;
        const cache = await caches.open('mwgp-mkxp-z-core');
        let response = await cache.match(cacheKey);
        if (!response) {
          const fresh = await fetch(wasmName);
          if (!fresh.ok) throw new Error(`${wasmName}: HTTP ${fresh.status}`);
          await cache.put(cacheKey, fresh.clone());
          response = fresh;
        }
        const { instance, module } = await WebAssembly.instantiateStreaming(response, imports);
        successCallback(instance, module);
      } catch (error) {
        console.warn('mkxp-z: streaming WASM instantiate failed, falling back to a plain compile', error);
        const { instance, module } = await WebAssembly.instantiate(await coreWasm.arrayBuffer(), imports);
        successCallback(instance, module);
      }
    };
    const emulator = await Nostalgist.prepare({
      core: { name: 'mkxp-z', js: coreJs, wasm: coreWasm },
      rom: opfs ? undefined : { fileName: 'game.mkxpz', fileContent: game },
      element: '#game',
      emscriptenModule: {
        instantiateWasm,
        preRun: [module => { if (opfs) module.ENV.OPFS_MOUNT = persistent; }]
      },
      retroarchConfig: {
        savefile_directory: saveDir,
        savestate_directory: `${saveDir}/states`,
        input_player1_a: 'z', input_player1_b: 'x', input_player1_x: 'shift',
        input_player1_up: 'up', input_player1_down: 'down',
        input_player1_left: 'left', input_player1_right: 'right'
      },
      retroarchCoreConfig: {
        'mkxp-z_syntaxTransform': String(info.rgss.syntaxTransform),
        'mkxp-z_saveStateSize': '256'
      }
    });
    if (opfs) {
      let folder = opfs;
      for (const part of saveDir.slice(persistent.length).split('/').filter(Boolean)) folder = await folder.getDirectoryHandle(part, { create: true });
      await folder.getDirectoryHandle('states', { create: true });
      const args = emulator.getEmscripten().Module.arguments || [];
      args.push(`${persistent}/${gamePath}`);
      emulator.getEmscripten().Module.arguments = args;
    } else {
      const fs = emulator.getEmscriptenFS();
      if (!fs.filesystems?.IDBFS) throw new Error('This browser cannot persist saves (OPFS and IDBFS unavailable).');
      fs.mkdirTree(saveDir);
      fs.mkdirTree(`${saveDir}/states`);
      fs.mount(fs.filesystems.IDBFS, { autoPersist: true }, saveDir);
      await new Promise((resolve, reject) => fs.syncfs(true, error => error ? reject(error) : resolve()));
    }
    const aliases = { Enter: 'z', ' ': 'z', Escape: 'x' };
    const held = new Set();
    for (const [eventName, press] of [['keydown', true], ['keyup', false]]) {
      window.addEventListener(eventName, event => {
        const key = aliases[event.key];
        if (!key) return;
        event.preventDefault();
        if (press && !held.has(event.code)) { held.add(event.code); emulator.pressDown({ button: key === 'z' ? 'a' : 'b' }); }
        if (!press && held.delete(event.code)) emulator.pressUp({ button: key === 'z' ? 'a' : 'b' });
      });
    }
    state.phase = 'ready';
    message.textContent = 'Ready to play';
    progress.hidden = true;
    start.hidden = false;
    await new Promise(resolve => start.addEventListener('click', resolve, { once: true }));
    start.hidden = true;
    message.textContent = 'Starting game… this can take up to a minute the first time (RGSS boot) — please wait.';
    progress.hidden = false;
    progress.removeAttribute('value');
    await emulator.start();
    state.phase = 'running';
    status.hidden = true;
  } catch (error) {
    state.phase = 'error'; state.error = String(error?.message || error);
    message.textContent = state.error;
    progress.hidden = true;
    console.error(error);
  }
})();
