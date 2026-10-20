// Resource editing is independent of the map/command inspector.
import { t } from './i18n.js';
export function setupAssetEditor({ projectId, notify, onSaved }) {
  const dialog = document.querySelector('#asset-dialog');
  const selector = document.querySelector('#asset-select');
  const referenceVersion = document.querySelector('#asset-reference-version');
  let prefix = '', selected = null, entries = [];
  const endpoint = `/api/studio/assets/${encodeURIComponent(projectId)}`;
  const urlFor = (path, version) => `${endpoint}?${new URLSearchParams({ path, version })}`;

  async function list(directory) {
    const response = await fetch(`${endpoint}?${new URLSearchParams({ prefix: directory })}`);
    const data = await response.json();
    if (!response.ok) throw new Error(data.error);
    prefix = directory;
    entries = data.entries;
    selected = null;
    document.querySelector('#asset-prefix').textContent = `assets/${prefix}`;
    document.querySelector('#asset-up').disabled = !prefix;
    document.querySelector('#asset-detail').hidden = true;
    selector.replaceChildren(new Option(t('asset_select'), ''));
    for (const entry of entries) selector.add(new Option(`${entry.directory ? '📁 ' : ''}${entry.name}${entry.protected ? ` · ${t('modified')}` : ''}`, entry.path));
    document.querySelector('#asset-status').textContent = entries.length ? '' : t('asset_none');
  }

  async function renderPreview(host, response, url, editable, entry) {
    if (entry !== selected) return;
    host.replaceChildren();
    if (!response.ok) { host.textContent = t('asset_absent'); return; }
    const bytes = await response.blob();
    if (entry !== selected) return;
    if (entry.text && bytes.size <= 2 * 1024 * 1024) {
      const text = document.createElement('textarea');
      text.value = await bytes.text();
      if (entry !== selected) return;
      text.readOnly = !editable;
      text.spellcheck = false;
      text.rows = 15;
      text.style.cssText = 'width:100%;font-family:Consolas,monospace;';
      text.setAttribute('aria-label', editable ? t('asset_edited_label') : t('asset_ref_label'));
      host.append(text);
      return;
    }
    const extension = entry.path.split('.').pop().toLowerCase();
    let preview;
    if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg'].includes(extension)) preview = document.createElement('img');
    else if (['ogg', 'mp3', 'wav', 'm4a'].includes(extension)) { preview = document.createElement('audio'); preview.controls = true; }
    else if (['webm', 'mp4'].includes(extension)) { preview = document.createElement('video'); preview.controls = true; }
    if (preview) { preview.src = url; preview.style.maxWidth = '100%'; preview.style.maxHeight = '45vh'; host.append(preview); }
    const download = document.createElement('a');
    download.href = url;
    download.download = entry.name;
    download.textContent = t('asset_download', { size: bytes.size });
    host.append(download);
  }

  async function showFile(refreshEdited = true) {
    if (!selected) return;
    const entry = selected, version = referenceVersion.value;
    const editedUrl = urlFor(selected.path, 'edited'), referenceUrl = urlFor(selected.path, referenceVersion.value);
    const reference = await fetch(referenceUrl);
    if (entry !== selected || version !== referenceVersion.value) return;
    await renderPreview(document.querySelector('#asset-reference'), reference, referenceUrl, false, entry);
    if (refreshEdited) await renderPreview(document.querySelector('#asset-edited'), await fetch(editedUrl), editedUrl, true, entry);
    if (entry !== selected) return;
    document.querySelector('#asset-detail').hidden = false;
    document.querySelector('#asset-save-text').disabled = !document.querySelector('#asset-edited textarea');
    document.querySelector('#asset-status').textContent = selected.protected
      ? t('asset_protected_status', {
        state: selected.divergent ? t('asset_divergent') : t('asset_same'), base: selected.baseHash,
        edited: selected.editedHash, fresh: selected.freshHash ?? t('asset_fresh_absent'),
      })
      : t('asset_unprotected');
  }

  async function save(bytes) {
    const response = await fetch(urlFor(selected.path, 'edited'), { method: 'POST', body: bytes });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error);
    onSaved(data);
    const path = selected.path;
    await list(prefix);
    selected = entries.find(entry => entry.path === path);
    selector.value = path;
    await showFile();
    notify(t('asset_saved'));
  }
  const reportError = error => { document.querySelector('#asset-status').textContent = error.message; notify(error.message, true); };
  document.querySelector('#btn-assets').onclick = async () => { dialog.showModal(); try { await list(''); } catch (error) { reportError(error); } };
  document.querySelector('#asset-close').onclick = () => dialog.close();
  document.querySelector('#asset-up').onclick = () => list(prefix.split('/').slice(0, -1).join('/')).catch(reportError);
  selector.onchange = async () => {
    document.querySelector('#asset-detail').hidden = true;
    selected = entries.find(entry => entry.path === selector.value);
    if (!selected) return;
    try { if (selected.directory) await list(selected.path); else await showFile(); }
    catch (error) { reportError(error); }
  };
  referenceVersion.onchange = () => showFile(false).catch(reportError);
  document.querySelector('#asset-save-text').onclick = () => save(document.querySelector('#asset-edited textarea').value).catch(reportError);
  document.querySelector('#asset-replacement').onchange = async event => {
    const file = event.target.files[0];
    if (!file || !selected) return;
    try {
      // Decode replacement images before publishing them to the game.
      if (/\.(png|jpe?g|gif|webp|bmp)$/i.test(selected.path)) {
        const bitmap = await createImageBitmap(file);
        bitmap.close();
      }
      await save(file);
    } catch (error) { reportError(error); }
    finally { event.target.value = ''; }
  };
}
