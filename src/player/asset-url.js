// MWG's compiled resource map also serves DOM consumers (images, CSS, fonts,
// movies). Ordinary server builds keep their original URLs.
export function assetUrl(url) {
  const resources = globalThis.mwg?.Resources;
  if (!resources?.isCompiled?.() || /^(?:blob|data):/.test(url)) return url;
  if (resources.has && !resources.has(url)) {
    console.warn(`MWGP embedded resource is missing: ${url}`);
    // Let the DOM loader fire its normal error callback, without trying a
    // nonexistent server/file URL or aborting the title screen synchronously.
    return 'data:application/octet-stream,';
  }
  try {
    return resources.resolve(url);
  } catch (error) {
    // A typed image value answers only after load() has read it (see loadAssetUrl).
    console.warn(`MWGP embedded resource is not loaded: ${url}`, error);
    return 'data:application/octet-stream,';
  }
}

// Images in a compiled build may be typed values, which mwg reads only in
// load(). Await this before a DOM consumer asks for an image URL. Fonts, movies
// and audio stay plain URLs and keep using assetUrl().
export async function loadAssetUrl(url) {
  const resources = globalThis.mwg?.Resources;
  const needsLoad = resources?.isCompiled?.() && !/^(?:blob|data):/.test(url) &&
    (!resources.has || resources.has(url)) && !resources.isLoaded(url);
  if (needsLoad) {
    try {
      await resources.load([url]);
    } catch (error) {
      console.warn(`MWGP embedded image could not be loaded: ${url}`, error);
    }
  }
  return assetUrl(url);
}
