import {filterAndSort, makeNotebook, mergeNotebook, matchesRole} from './model.mjs';

const $ = id => document.getElementById(id);
const state = {
  records: [], candidates: [], catalog: [], id: null, record: null, meta: null,
  page: 0, pageSize: 50, raw: false, expanded: false, request: 0,
  detailRequest: 0, match: -1, marks: [], reviews: Object.create(null), hideLabels: false,
};
let saved = new Set();
try {
  const bookmarks = JSON.parse(localStorage.getItem('trajectory-bookmarks') || '[]');
  if (Array.isArray(bookmarks)) saved = new Set(bookmarks.filter(id => typeof id === 'string'));
  state.hideLabels = localStorage.getItem('loupe-hide-labels') === 'true';
} catch { notify('Browser storage is unavailable. Export your reviews before leaving.', true); }

const esc = text => String(text ?? '').replace(/[&<>"']/g, c => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[c]));
const reviewKey = () => 'loupe-reviews:' + state.meta.revision;
const judgment = verdict => ({benign: 'Benign', scheming: 'Scheming', uncertain: 'Uncertain'}[verdict] || 'No judgment');
function notify(message, error = false) {
  $('app-status').textContent = message;
  $('app-status').classList.remove('hidden');
  $('app-status').classList.toggle('error', error);
}
function highlight(text) {
  const source = String(text ?? ''), q = $('search').value.trim();
  if (!q) return esc(source);
  let out = '', start = 0, index;
  const lower = source.toLowerCase();
  while ((index = lower.indexOf(q.toLowerCase(), start)) !== -1) {
    out += esc(source.slice(start, index)) + '<mark>' + esc(source.slice(index, index + q.length)) + '</mark>';
    start = index + q.length;
  }
  return out + esc(source.slice(start));
}
function rich(text) {
  return highlight(text).split('\n').map(line => {
    const heading = line.match(/^#{1,4}\s+(.*)$/);
    if (heading) return '<h4>' + heading[1].replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>') + '</h4>';
    return line.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  }).join('\n');
}
function stringContent(value) {
  if (typeof value !== 'string') return JSON.stringify(value, null, 2);
  try { return JSON.stringify(JSON.parse(value), null, 2); } catch { return value; }
}
async function api(path) {
  const response = await fetch(path);
  if (!response.ok) throw Error('Unable to load data (' + response.status + ').');
  return response.json();
}
function badge(label) {
  if (state.hideLabels) return '';
  return '<span class="badge ' + (label ? 'positive' : '') + '">Labeled ' + (label ? 'scheming' : 'benign') + '</span>';
}
function browseOptions() {
  return {
    review: $('review-filter').value,
    minMessages: Math.max(0, Number($('min-messages').value) || 0),
    minTools: Math.max(0, Number($('min-tools').value) || 0),
    sort: $('sort').value,
  };
}
async function refresh() {
  const token = ++state.request;
  $('result-count').textContent = 'Searching…';
  const params = new URLSearchParams({
    q: $('search').value, label: state.hideLabels ? '' : $('label').value,
    split: $('split').value, examples: !state.hideLabels && $('examples').checked ? '1' : '',
  });
  try {
    const data = await api('/api/records?' + params);
    if (token !== state.request) return;
    state.candidates = data.records;
    await applyFilters();
  } catch (error) { if (token === state.request) $('result-count').textContent = error.message; }
}
async function applyFilters({autoSelect = true} = {}) {
  const candidates = state.candidates.filter(record => !$('saved-only').checked || saved.has(record.id));
  state.records = filterAndSort(candidates, state.reviews, browseOptions());
  state.page = 0;
  const index = state.records.findIndex(record => record.id === state.id);
  if (index >= 0) state.page = Math.floor(index / state.pageSize);
  renderList();
  if (!autoSelect) return;
  if (!state.records.length) {
    state.id = null;
    state.record = null;
    state.detailRequest++;
    showEmpty('No matching trajectories', 'Try a different search or clear the filters.');
    history.replaceState(null, '', location.pathname);
  } else if (index < 0 || state.record?.id !== state.id) {
    await selectRecord(state.records[0].id);
  } else { renderConversation(); }
}
function renderList() {
  const list = $('records');
  list.replaceChildren();
  $('result-count').textContent = state.records.length.toLocaleString() + (state.records.length === 1 ? ' conversation' : ' conversations');
  const pages = Math.max(1, Math.ceil(state.records.length / state.pageSize));
  state.page = Math.max(0, Math.min(state.page, pages - 1));
  for (const record of state.records.slice(state.page * state.pageSize, (state.page + 1) * state.pageSize)) {
    const button = document.createElement('button');
    button.className = 'record' + (record.id === state.id ? ' active' : '');
    button.setAttribute('aria-pressed', String(record.id === state.id));
    const review = state.reviews[record.id];
    button.innerHTML = '<div class="row-meta">' + badge(record.label) + '<span>' + esc(record.split) + '</span>' +
      '<span style="margin-left:auto">' + (saved.has(record.id) ? '★' : '') + (!state.hideLabels && record.example_note ? ' ◇' : '') + '</span></div>' +
      '<div class="record-title">' + esc(record.title) + '</div>' +
      '<div class="row-meta">' + record.message_count + ' messages <span>·</span> ' + record.tool_call_count + ' calls</div>' +
      (review ? '<div class="review-chip">Your review: ' + judgment(review.verdict) + (review.notes.trim() ? ' · notes' : '') + '</div>' : '') +
      (state.hideLabels ? '' : '<div class="record-id" style="margin-top:7px">' + esc(record.source_id) + '</div>');
    button.onclick = () => selectRecord(record.id);
    list.append(button);
  }
  if (!state.records.length) list.innerHTML = '<div class="empty">No conversations match.</div>';
  $('page-count').textContent = (state.page + 1) + ' / ' + pages;
  $('prev-page').disabled = state.page === 0;
  $('next-page').disabled = state.page >= pages - 1;
  updateNavigation();
}
function showEmpty(title, description) {
  $('welcome').classList.remove('hidden');
  $('welcome').innerHTML = '<b>' + esc(title) + '</b>' + esc(description);
  ['detail-head', 'toolbar', 'conversation', 'message-navigation'].forEach(id => $(id).classList.add('hidden'));
}
async function selectRecord(id) {
  state.id = id;
  const token = ++state.detailRequest;
  const index = state.records.findIndex(record => record.id === id);
  if (index >= 0) state.page = Math.floor(index / state.pageSize);
  renderList();
  // Do not allow edits or downloads of the preceding trajectory while loading.
  state.record = null;
  showEmpty('Loading trajectory', 'Reading the conversation.');
  try {
    const record = await api('/api/records/' + encodeURIComponent(id));
    if (token !== state.detailRequest) return;
    state.record = record;
    $('welcome').classList.add('hidden');
    ['detail-head', 'toolbar', 'conversation'].forEach(id => $(id).classList.remove('hidden'));
    renderHeader();
    renderReview();
    renderConversation();
    $('conversation').scrollTop = 0;
    history.replaceState(null, '', '#' + encodeURIComponent(id));
  } catch (error) { if (token === state.detailRequest) showEmpty('Could not open trajectory', error.message); }
}
function renderHeader() {
  const record = state.record;
  if (!record) return;
  $('title').textContent = record.title;
  $('record-id').textContent = state.hideLabels ? 'Release ' + record.split + ' · row ' + record.row_index : record.source_id + ' · ' + record.split + ' row ' + record.row_index;
  $('detail-meta').innerHTML = badge(record.label) + '<span>Release ' + esc(record.split) + '</span><span>·</span><span>' + record.message_count + ' messages</span><span>·</span><span>' + record.tool_call_count + ' tool calls</span>';
  $('example-note').classList.toggle('hidden', state.hideLabels || !record.example_note);
  $('example-note').textContent = !state.hideLabels && record.example_note ? 'Audit note: ' + record.example_note : '';
  $('blind-note').classList.toggle('hidden', !state.hideLabels);
  updateBookmark();
}
function renderConversation() {
  if (!state.record) return;
  const container = $('conversation');
  container.replaceChildren();
  const inner = document.createElement('div');
  inner.className = 'conversation-inner';
  container.append(inner);
  $('conversation-tab').classList.toggle('selected', !state.raw);
  $('raw-tab').classList.toggle('selected', state.raw);
  $('expand-tools').classList.toggle('hidden', state.raw);
  $('expand-tools').textContent = state.expanded ? 'Collapse tools' : 'Expand tools';
  $('message-navigation').classList.toggle('hidden', state.raw);
  if (state.raw) {
    const pre = document.createElement('pre');
    pre.className = 'raw';
    pre.innerHTML = highlight(JSON.stringify(state.record.trajectory, null, 2));
    inner.append(pre);
  } else {
    const messages = state.record.trajectory.messages;
    const tools = new Map();
    for (const message of messages) {
      for (const call of message.tool_calls || []) tools.set(call.id, call.name || call.function?.name || 'Tool');
    }
    const outline = $('message-outline');
    outline.replaceChildren(new Option('Choose a message…', ''));
    messages.forEach((message, index) => {
      if (!matchesRole(message, $('role-filter').value)) return;
      const role = message.role || 'unknown', node = document.createElement('article');
      // Dataset-controlled roles never become HTML or CSS class attributes.
      node.className = 'message';
      if (['user', 'assistant', 'tool', 'system'].includes(role)) node.classList.add(role);
      node.id = 'message-' + index;
      node.tabIndex = -1;
      const name = role === 'tool' ? (tools.get(message.tool_call_id) || message.name || 'Tool output') : role === 'user' ? 'User request' : role;
      node.innerHTML = '<div class="message-head"><span class="role">' + esc(name) + '</span><span class="message-number">' + String(index + 1).padStart(2, '0') + ' / ' + messages.length + '</span></div>';
      const text = stringContent(message.content ?? '');
      const preview = text.replace(/\s+/g, ' ').slice(0, 80) || (message.tool_calls || []).map(call => call.name || call.function?.name || 'Tool call').join(', ') || 'Empty message';
      outline.append(new Option((index + 1) + ' · ' + name + ' · ' + preview, String(index)));
      if (role === 'tool') {
        const details = document.createElement('details');
        details.className = 'tool-output';
        details.open = state.expanded;
        const summary = document.createElement('summary');
        summary.textContent = text.replace(/\s+/g, ' ').slice(0, 145) || 'Empty output';
        const content = document.createElement('div');
        content.className = 'content';
        content.innerHTML = highlight(text);
        details.append(summary, content);
        node.append(details);
      } else if (text) {
        const content = document.createElement('div');
        content.className = 'content';
        content.innerHTML = rich(text);
        node.append(content);
      }
      if (message.tool_calls?.length) {
        const calls = document.createElement('div');
        calls.className = 'calls';
        for (const call of message.tool_calls) {
          const details = document.createElement('details');
          details.className = 'call';
          details.open = state.expanded;
          const summary = document.createElement('summary');
          summary.innerHTML = '↳ ' + highlight(call.name || call.function?.name || 'Tool call');
          const pre = document.createElement('pre');
          pre.innerHTML = highlight(stringContent(call.args ?? call.function?.arguments ?? {}));
          details.append(summary, pre);
          calls.append(details);
        }
        node.append(calls);
      }
      inner.append(node);
    });
    const count = outline.options.length - 1;
    $('visible-messages').textContent = count + ' / ' + messages.length + ' messages';
    outline.disabled = !count;
    if (!count) inner.innerHTML = '<div class="empty">No messages with this role. Choose another role above.</div>';
  }
  state.marks = [...inner.querySelectorAll('mark')];
  state.match = -1;
  $('match-controls').classList.toggle('hidden', !$('search').value.trim());
  $('match-count').textContent = state.marks.length + ' matches';
  $('prev-match').disabled = $('next-match').disabled = !state.marks.length;
  updateNavigation();
}
function updateNavigation() {
  const index = state.records.findIndex(record => record.id === state.id);
  $('previous').disabled = index <= 0;
  // A newly judged record can remain in the editor after leaving the review
  // queue. Next then opens the first remaining record in that queue.
  $('next').disabled = !state.records.length || index >= state.records.length - 1;
  $('random').disabled = state.records.length < 2;
}
function move(delta) {
  const index = state.records.findIndex(record => record.id === state.id);
  const next = state.records[index + delta];
  if (next) selectRecord(next.id);
}
function updateBookmark() {
  const active = saved.has(state.id);
  $('bookmark').textContent = active ? '★ Bookmarked' : '☆ Bookmark';
  $('bookmark').classList.toggle('active', active);
  $('bookmark').setAttribute('aria-pressed', String(active));
}
function jumpMatch(delta) {
  if (!state.marks.length) return;
  state.marks[state.match]?.classList.remove('current');
  state.match = state.match === -1 ? (delta > 0 ? 0 : state.marks.length - 1) : (state.match + delta + state.marks.length) % state.marks.length;
  const mark = state.marks[state.match];
  for (let parent = mark.parentElement; parent; parent = parent.parentElement) if (parent.tagName === 'DETAILS') parent.open = true;
  mark.classList.add('current');
  mark.scrollIntoView({block: 'center', behavior: 'smooth'});
  $('match-count').textContent = (state.match + 1) + ' / ' + state.marks.length + ' matches';
}
function renderReview() {
  const entry = state.reviews[state.record.id];
  $('review-verdict').value = entry?.verdict || '';
  $('review-notes').value = entry?.notes || '';
  updateReviewSummary();
  $('review-status').textContent = entry ? 'Saved in this browser. Edits save as you type.' : 'Saved in this browser as you type.';
  $('review-status').classList.remove('error');
}
function updateReviewSummary() {
  const entry = state.reviews[state.record.id];
  $('review-summary').textContent = 'Your review · ' + judgment(entry?.verdict) + (entry?.notes.trim() ? ' · notes' : '');
}
function updateProgress() {
  const count = Object.values(state.reviews).filter(entry => entry.verdict).length;
  $('review-progress').textContent = count + ' / ' + state.catalog.length + ' judged · saved in this browser';
  $('export-reviews').disabled = !Object.keys(state.reviews).length;
}
function saveReview() {
  if (!state.record) return;
  state.reviews[state.record.id] = {
    id: state.record.id, verdict: $('review-verdict').value,
    notes: $('review-notes').value, updated_at: new Date().toISOString(),
  };
  try {
    localStorage.setItem(reviewKey(), JSON.stringify(makeNotebook(state.reviews, state.meta)));
    $('review-status').textContent = 'Saved in this browser.';
    $('review-status').classList.remove('error');
  } catch {
    $('review-status').textContent = 'Browser storage failed. Export reviews to keep these edits.';
    $('review-status').classList.add('error');
    notify('Reviews are only in memory because browser storage failed. Export them before leaving.', true);
  }
  updateReviewSummary();
  updateProgress();
  // Keep the current editor open if its judgment changes queue membership.
  // Navigation uses the updated queue; leaving the editor applies normal selection.
  applyFilters({autoSelect: false});
  if (!state.records.some(record => record.id === state.id) && !$('review-status').classList.contains('error')) {
    $('review-status').textContent = state.records.length
      ? 'Saved. This trajectory no longer matches your filters. Next opens the remaining queue.'
      : 'Saved. No trajectories remain in this queue. Reset filters to continue browsing.';
  }
}
function downloadJson(value, filename) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], {type: 'application/json'}));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function applyLabelVisibility() {
  $('hide-labels').checked = state.hideLabels;
  $('benign').closest('.stat').classList.toggle('hidden', state.hideLabels);
  $('scheming').closest('.stat').classList.toggle('hidden', state.hideLabels);
  $('label').classList.toggle('hidden', state.hideLabels);
  $('examples-filter').classList.toggle('hidden', state.hideLabels);
  if (state.hideLabels) { $('label').value = ''; $('examples').checked = false; }
  renderHeader();
  renderList();
}

let timer;
$('search').oninput = () => { clearTimeout(timer); timer = setTimeout(refresh, 200); };
['label', 'split', 'examples'].forEach(id => $(id).onchange = refresh);
['saved-only', 'review-filter', 'sort', 'min-messages', 'min-tools'].forEach(id => $(id).onchange = () => applyFilters());
$('clear').onclick = () => {
  clearTimeout(timer);
  ['search', 'label', 'split', 'review-filter'].forEach(id => $(id).value = '');
  $('sort').value = 'source';
  $('min-messages').value = $('min-tools').value = '0';
  $('examples').checked = $('saved-only').checked = false;
  refresh();
};
$('prev-page').onclick = () => { state.page--; renderList(); $('records').scrollTop = 0; };
$('next-page').onclick = () => { state.page++; renderList(); $('records').scrollTop = 0; };
$('previous').onclick = () => move(-1);
$('next').onclick = () => move(1);
$('random').onclick = () => {
  const choices = state.records.filter(record => record.id !== state.id);
  if (choices.length) selectRecord(choices[Math.floor(Math.random() * choices.length)].id);
};
$('conversation-tab').onclick = () => { state.raw = false; renderConversation(); };
$('raw-tab').onclick = () => { state.raw = true; renderConversation(); };
$('expand-tools').onclick = () => { state.expanded = !state.expanded; renderConversation(); };
$('bookmark').onclick = () => {
  if (saved.has(state.id)) saved.delete(state.id); else saved.add(state.id);
  try { localStorage.setItem('trajectory-bookmarks', JSON.stringify([...saved])); }
  catch { notify('Could not save bookmarks in browser storage.', true); }
  updateBookmark();
  if ($('saved-only').checked) applyFilters(); else renderList();
};
$('download').onclick = () => { if (state.record) downloadJson(state.record.trajectory, state.id + '.json'); };
$('prev-match').onclick = () => jumpMatch(-1);
$('next-match').onclick = () => jumpMatch(1);
$('role-filter').onchange = () => { renderConversation(); $('conversation').scrollTop = 0; };
$('message-outline').onchange = () => {
  if ($('message-outline').value === '') return;
  const node = $('message-' + $('message-outline').value);
  node.querySelectorAll('details').forEach(details => details.open = true);
  node.focus({preventScroll: true});
  node.scrollIntoView({block: 'start', behavior: 'smooth'});
};
$('review-verdict').onchange = saveReview;
$('review-notes').oninput = saveReview;
$('export-reviews').onclick = () => downloadJson(makeNotebook(state.reviews, state.meta), 'loupe-reviews-' + new Date().toISOString().slice(0, 10) + '.json');
$('import-reviews').onclick = () => $('review-file').click();
$('review-file').onchange = async () => {
  const file = $('review-file').files[0];
  if (!file) return;
  try {
    if (file.size > 5 * 1024 * 1024) throw Error('Review notebooks must be smaller than 5 MB.');
    const notebook = JSON.parse(await file.text());
    const result = mergeNotebook(notebook, state.reviews, state.meta, new Set(state.catalog.map(record => record.id)));
    // Persist before replacing in-memory work, so a failed import never loses edits.
    localStorage.setItem(reviewKey(), JSON.stringify(makeNotebook(result.reviews, state.meta)));
    state.reviews = result.reviews;
    updateProgress();
    if (state.record) renderReview();
    await applyFilters();
    notify('Imported ' + result.imported + ' reviews. Kept ' + result.kept + ' local reviews with equal or newer edits. Skipped ' + result.skipped + ' unknown records.');
  } catch (error) { notify('Import failed: ' + error.message, true); }
  finally { $('review-file').value = ''; }
};
$('hide-labels').onchange = () => {
  state.hideLabels = $('hide-labels').checked;
  try { localStorage.setItem('loupe-hide-labels', String(state.hideLabels)); } catch { /* Session preference still works. */ }
  applyLabelVisibility();
  refresh();
};
document.addEventListener('keydown', event => {
  if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey ||
      ['INPUT', 'TEXTAREA', 'SELECT', 'BUTTON', 'SUMMARY'].includes(document.activeElement.tagName) || document.activeElement.isContentEditable) return;
  if (event.key === '/') { event.preventDefault(); $('search').focus(); }
  if (event.key === 'ArrowDown') { event.preventDefault(); move(1); }
  if (event.key === 'ArrowUp') { event.preventDefault(); move(-1); }
});
(async () => {
  try {
    const [meta, data] = await Promise.all([api('/api/meta'), api('/api/records')]);
    state.meta = meta;
    state.catalog = data.records;
    state.candidates = data.records;
    $('total').textContent = meta.total.toLocaleString();
    $('benign').textContent = meta.benign;
    $('scheming').textContent = meta.scheming;
    try {
      const stored = localStorage.getItem(reviewKey());
      if (stored) state.reviews = mergeNotebook(JSON.parse(stored), {}, meta, new Set(data.records.map(record => record.id))).reviews;
    } catch { notify('Saved reviews could not be loaded. Browser storage may be unavailable or contain an invalid notebook.', true); }
    updateProgress();
    $('import-reviews').disabled = false;
    applyLabelVisibility();
    try { state.id = decodeURIComponent(location.hash.slice(1)) || null; } catch { state.id = null; }
    const linked = state.id;
    if (linked && state.catalog.some(record => record.id === linked)) await selectRecord(linked);
    await applyFilters();
  } catch (error) { showEmpty('Unable to load collection', error.message); }
})();
