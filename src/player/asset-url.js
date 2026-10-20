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
  return resources.resolve(url);
}
