import {
  MAX_MARKS, compareNotebook, comparisonStats, filterAndSort, labelAgreement, makeNotebook, matchesRole,
  mergeNotebook, normalizeEvidence, parseQuery, reviewsCsv, scanRanges, termPatterns,
} from './model.mjs';

const $ = id => document.getElementById(id);
const state = {
  records: [], candidates: [], catalog: [], id: null, record: null, meta: null,
  page: 0, pageSize: 50, raw: false, expanded: false, request: 0,
  detailRequest: 0, match: -1, marks: [], reviews: Object.create(null), hideLabels: false,
  patterns: [], scope: {roles: [], tools: [], regex: false}, query: null, comparison: null, comparisonName: '', fileMode: 'import',
  segments: new Map(), segmentId: 0, highlightJobs: {list: null, conversation: null},
  view: 'conversation', markBudget: MAX_MARKS, truncated: {list: false, conversation: false},
};
const HIGHLIGHT_BUDGET = 2000;
let saved = new Set();
try {
  state.hideLabels = localStorage.getItem('loupe-hide-labels') === 'true';
} catch { notify('Browser storage is unavailable. Export your reviews before leaving.', true); }
// Bookmarks are scoped to the collection revision so row IDs shared between
// generic files do not share bookmarks. Gloom bookmarks saved under the
// original unscoped key are migrated on first load.
const LEGACY_BOOKMARKS = 'trajectory-bookmarks';
const bookmarkKey = () => 'trajectory-bookmarks:' + state.meta.revision;
function loadBookmarks() {
  try {
    const stored = localStorage.getItem(bookmarkKey()) ?? (state.meta.source === 'https://huggingface.co/datasets/Syghmon/gloom_data' ? localStorage.getItem(LEGACY_BOOKMARKS) : null);
    const bookmarks = JSON.parse(stored || '[]');
    if (Array.isArray(bookmarks)) saved = new Set(bookmarks.filter(id => typeof id === 'string'));
  } catch { notify('Browser storage is unavailable. Export your reviews before leaving.', true); }
}

const esc = text => String(text ?? '').replace(/[&<>"']/g, c => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[c]));
const reviewKey = () => 'loupe-reviews:' + state.meta.revision;
const judgment = verdict => ({benign: 'Benign', scheming: 'Scheming', uncertain: 'Uncertain'}[verdict] || 'No judgment');
// Dataset labels are shown unless the reader hides them or the file has none.
const labelsShown = () => !state.hideLabels && state.meta?.has_labels !== false;
function notify(message, error = false) {
  $('app-status').textContent = message;
  $('app-status').classList.remove('hidden');
  $('app-status').classList.toggle('error', error);
}
// Highlight patterns are set only after the server accepted the same query,
// so the browser never runs a pattern the server rejected as unsafe.
function setPatterns(query, regex) {
  const parsed = parseQuery(query, {regex});
  state.patterns = termPatterns(parsed);
  state.scope = {roles: parsed.roles, tools: parsed.tools, regex};
  state.query = {terms: parsed.terms, regex};
}
// Does a message fall inside the role:/tool: scope of the current search?
function inScope(message, toolNames) {
  const {roles, tools} = state.scope;
  if (roles.length && !roles.includes(String(message.role ?? '').toLowerCase())) return false;
  if (!tools.length) return true;
  const names = (message.tool_calls || []).map(call => String(call.name || call.function?.name || '').toLowerCase());
  if (toolNames.has(message.tool_call_id)) names.push(toolNames.get(message.tool_call_id).toLowerCase());
  if (message.role === 'tool' && message.name) names.push(String(message.name).toLowerCase());
  return names.some(name => tools.includes(name));
}
// Escape text and wrap the given [start, end) ranges in <mark>. This is the
// only place marks are emitted, so the per-view budget is enforced here: a
// single range that rich() splits across lines still counts one mark per line.
function highlight(text, ranges) {
  const source = String(text ?? '');
  if (!ranges.length) return esc(source);
  let out = '', start = 0;
  for (const [from, to] of ranges) {
    if (state.markBudget <= 0) { state.truncated[state.view] = true; break; }
    state.markBudget--;
    out += esc(source.slice(start, from)) + '<mark>' + esc(source.slice(from, to)) + '</mark>';
    start = to;
  }
  return out + esc(source.slice(start));
}
// Ranges over the whole text clipped and shifted to a [from, to) slice.
function sliceRanges(ranges, from, to) {
  const out = [];
  for (const [start, end] of ranges) {
    if (end <= from) continue;
    if (start >= to) break;
    out.push([Math.max(start, from) - from, Math.min(end, to) - from]);
  }
  return out;
}
// Literal terms are marked synchronously: matching is linear. Regular
// expressions are matched in a worker with a time limit (flushHighlights), so
// a pattern that is slow on this text cannot freeze the tab. Until the worker
// answers, the text renders without marks. Each view marks at most MAX_MARKS
// ranges so a broad term cannot flood the page with elements.
function marked(text, mode, patterns = state.patterns) {
  const source = String(text ?? '');
  const render = ranges => mode === 'rich' ? rich(source, ranges) : highlight(source, ranges);
  if (!patterns.length) return render([]);
  if (!state.scope.regex) {
    const scan = state.markBudget > 0 ? scanRanges(source, patterns, state.markBudget) : {ranges: [], truncated: true};
    if (scan.truncated) state.truncated[state.view] = true;
    return render(scan.ranges);
  }
  const id = ++state.segmentId;
  state.segments.set(id, {text: source, mode});
  return '<span data-hl="' + id + '">' + render([]) + '</span>';
}
// Each view (record list, conversation) owns at most one highlight job with
// its own worker and watchdog. Re-rendering a view terminates its previous
// job first, so a slow pattern on an abandoned view cannot delay or cancel
// the view that replaced it. Every job ends with terminate(), whether it
// completed, timed out, or was cancelled, so workers never accumulate.
function beginView(view) {
  state.view = view;
  state.markBudget = MAX_MARKS;
  state.truncated[view] = false;
}
function endJob(view, job) {
  clearTimeout(job.timer);
  job.worker.terminate();
  if (state.highlightJobs[view] === job) state.highlightJobs[view] = null;
}
function cancelHighlight(view) {
  if (state.highlightJobs[view]) endJob(view, state.highlightJobs[view]);
}
function flushHighlights(view) {
  cancelHighlight(view);
  if (!state.segments.size) return;
  const pending = state.segments;
  state.segments = new Map();
  const job = {worker: new Worker('/highlight.mjs', {type: 'module'}), pending, budget: state.markBudget, timer: null};
  job.worker.onmessage = ({data}) => {
    if (state.highlightJobs[view] !== job) return;
    endJob(view, job);
    state.view = view;
    state.markBudget = job.budget;
    if (data.truncated) state.truncated[view] = true;
    for (const [id, ranges] of data.results) {
      const node = document.querySelector('[data-hl="' + id + '"]'), segment = pending.get(id);
      if (!node || !segment || !ranges.length) continue;
      node.innerHTML = segment.mode === 'rich' ? rich(segment.text, ranges) : highlight(segment.text, ranges);
    }
    if (view === 'conversation') collectMarks();
  };
  job.timer = setTimeout(() => {
    if (state.highlightJobs[view] !== job) return;
    endJob(view, job);
    notify('Highlighting stopped after 2 seconds because this pattern is slow on this text. Search results are unaffected.', true);
    if (view === 'conversation') collectMarks();
  }, HIGHLIGHT_BUDGET);
  state.highlightJobs[view] = job;
  job.worker.postMessage({query: state.query, segments: [...pending].map(([id, segment]) => ({id, text: segment.text})), limit: job.budget});
  if (view === 'conversation') $('match-count').textContent = 'Highlighting…';
}
function collectMarks() {
  state.marks = [...$('conversation').querySelectorAll('mark')];
  state.match = -1;
  $('match-controls').classList.toggle('hidden', !state.patterns.length);
  $('match-count').textContent = state.highlightJobs.conversation ? 'Highlighting…'
    : state.truncated.conversation ? 'First ' + state.marks.length.toLocaleString() + ' matches shown' : state.marks.length + ' matches';
  $('prev-match').disabled = $('next-match').disabled = !state.marks.length;
}
function inline(line) {
  return line.replace(/`([^`\n]+)`/g, '<code>$1</code>').replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
}
// Light markdown: fenced code, inline code, headings, and bold. Fences are
// detected on the raw text so search marks never break the block structure.
function rich(text, ranges) {
  const source = String(text ?? ''), out = [];
  let fence = null, offset = 0;
  const part = (from, to) => highlight(source.slice(from, to), sliceRanges(ranges, from, to));
  const closeFence = end => { out.push('<pre class="code">' + part(fence, end) + '</pre>'); fence = null; };
  for (const line of source.split('\n')) {
    const end = offset + line.length;
    if (fence === null && /^\s*```/.test(line)) fence = end + 1;
    else if (fence !== null) { if (/^\s*```\s*$/.test(line)) closeFence(Math.max(fence, offset - 1)); }
    else {
      const heading = line.match(/^(#{1,4}\s+)(.*)$/);
      out.push(heading ? '<h4>' + inline(part(offset + heading[1].length, end)) + '</h4>' : inline(part(offset, end)));
    }
    offset = end + 1;
  }
  if (fence !== null) closeFence(Math.max(fence, source.length));
  return out.join('\n');
}
function stringContent(value) {
  if (typeof value !== 'string') return JSON.stringify(value, null, 2);
  try { return JSON.stringify(JSON.parse(value), null, 2); } catch { return value; }
}
async function api(path) {
  const response = await fetch(path);
  if (!response.ok) {
    let detail = '';
    try { detail = (await response.json()).error || ''; } catch { /* Non-JSON error body. */ }
    throw Error(detail || 'Unable to load data (' + response.status + ').');
  }
  return response.json();
}
function badge(label) {
  if (!labelsShown() || label !== 0 && label !== 1) return '';
  return '<span class="badge ' + (label ? 'positive' : '') + '">Labeled ' + (label ? 'scheming' : 'benign') + '</span>';
}
function browseOptions() {
  return {
    review: $('review-filter').value,
    minMessages: Math.max(0, Number($('min-messages').value) || 0),
    minTools: Math.max(0, Number($('min-tools').value) || 0),
    sort: $('sort').value,
    comparison: state.comparison,
  };
}
// Browsing filters live in the query string and the open trajectory in the
// hash, so a filtered queue survives reloads and can be shared as a link.
const URL_FIELDS = {q: 'search', regex: 'regex', label: 'label', split: 'split', examples: 'examples', saved: 'saved-only', review: 'review-filter', minm: 'min-messages', mint: 'min-tools', sort: 'sort'};
const URL_DEFAULTS = {sort: 'source', minm: '0', mint: '0'};
function syncUrl() {
  const params = new URLSearchParams();
  for (const [key, id] of Object.entries(URL_FIELDS)) {
    const control = $(id);
    const value = control.type === 'checkbox' ? (control.checked ? '1' : '') : control.value;
    if (value && value !== (URL_DEFAULTS[key] ?? '')) params.set(key, value);
  }
  const query = params.size ? '?' + params : '';
  history.replaceState(null, '', location.pathname + query + (state.id ? '#' + encodeURIComponent(state.id) : ''));
}
function restoreUrl() {
  const params = new URLSearchParams(location.search);
  let serverSide = false;
  for (const [key, id] of Object.entries(URL_FIELDS)) {
    if (!params.has(key)) continue;
    const control = $(id), value = params.get(key);
    if (control.type === 'checkbox') control.checked = value === '1';
    else if (control.tagName === 'SELECT') {
      if (![...control.options].some(option => option.value === value && !option.hidden)) continue;
      control.value = value;
    } else control.value = value;
    if (['q', 'regex', 'label', 'split', 'examples'].includes(key)) serverSide = true;
  }
  return serverSide;
}
async function refresh() {
  const token = ++state.request;
  $('result-count').textContent = 'Searching…';
  const query = $('search').value, regex = $('regex').checked;
  const params = new URLSearchParams({
    q: $('search').value, regex: $('regex').checked ? '1' : '', label: labelsShown() ? $('label').value : '',
    split: $('split').value, examples: labelsShown() && $('examples').checked ? '1' : '',
  });
  try {
    const data = await api('/api/records?' + params);
    if (token !== state.request) return;
    setPatterns(query, regex);
    state.candidates = data.records;
    await applyFilters();
  } catch (error) {
    if (token !== state.request) return;
    setPatterns('', false);
    renderList();
    $('result-count').textContent = error.message;
    if (state.record) renderConversation();
  }
}
async function applyFilters({autoSelect = true} = {}) {
  const candidates = state.candidates.filter(record => !$('saved-only').checked || saved.has(record.id));
  state.records = filterAndSort(candidates, state.reviews, browseOptions());
  state.page = 0;
  const index = state.records.findIndex(record => record.id === state.id);
  if (index >= 0) state.page = Math.floor(index / state.pageSize);
  renderList();
  if (!autoSelect) { syncUrl(); return; }
  if (!state.records.length) {
    state.id = null;
    state.record = null;
    state.detailRequest++;
    showEmpty('No matching trajectories', 'Try a different search or clear the filters.');
    syncUrl();
  } else if (index < 0 || state.record?.id !== state.id) {
    await selectRecord(state.records[0].id);
  } else { renderConversation(); syncUrl(); }
}
function renderList() {
  const list = $('records');
  beginView('list');
  list.replaceChildren();
  $('result-count').textContent = state.records.length.toLocaleString() + (state.records.length === 1 ? ' conversation' : ' conversations');
  const pages = Math.max(1, Math.ceil(state.records.length / state.pageSize));
  state.page = Math.max(0, Math.min(state.page, pages - 1));
  for (const record of state.records.slice(state.page * state.pageSize, (state.page + 1) * state.pageSize)) {
    const button = document.createElement('button');
    button.className = 'record' + (record.id === state.id ? ' active' : '');
    button.setAttribute('aria-pressed', String(record.id === state.id));
    const review = state.reviews[record.id];
    const agreement = labelsShown() ? labelAgreement(record, review) : '';
    button.innerHTML = '<div class="row-meta">' + badge(record.label) + '<span>' + esc(record.split) + '</span>' +
      '<span style="margin-left:auto">' + (saved.has(record.id) ? '★' : '') + (!state.hideLabels && record.example_note ? ' ◇' : '') + '</span></div>' +
      '<div class="record-title">' + esc(record.title) + '</div>' +
      (record.snippet && state.patterns.length ? '<div class="snippet">' + marked(record.snippet, 'plain') + '</div>' : '') +
      '<div class="row-meta">' + record.message_count + ' messages <span>·</span> ' + record.tool_call_count + ' calls</div>' +
      (review ? '<div class="review-chip">Your review: ' + judgment(review.verdict) + (review.notes.trim() ? ' · notes' : '') +
        (review.evidence?.length ? ' · ' + review.evidence.length + ' evidence' : '') +
        (agreement === 'disagree' ? ' · <span class="badge positive">disagrees with label</span>' : '') + '</div>' : '') +
      (state.hideLabels ? '' : '<div class="record-id" style="margin-top:7px">' + esc(record.source_id) + '</div>');
    button.onclick = () => selectRecord(record.id);
    list.append(button);
  }
  if (!state.records.length) list.innerHTML = '<div class="empty">No conversations match.</div>';
  flushHighlights('list');
  $('page-count').textContent = (state.page + 1) + ' / ' + pages;
  $('prev-page').disabled = state.page === 0;
  $('next-page').disabled = state.page >= pages - 1;
  updateNavigation();
}
function showEmpty(title, description) {
  $('welcome').classList.remove('hidden');
  $('welcome').innerHTML = '<b>' + esc(title) + '</b>' + esc(description);
  ['detail-head', 'toolbar', 'conversation', 'message-navigation'].forEach(id => $(id).classList.add('hidden'));
  $('conversation').replaceChildren();
  cancelHighlight('conversation');
  state.marks = [];
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
  syncUrl();
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
function renderDatasetInfo() {
  const meta = state.meta;
  $('dataset-eyebrow').textContent = meta.title || 'Conversation';
  $('source-note').innerHTML = esc(meta.note || '') + (meta.source_url
    ? ' <a href="' + esc(meta.source_url) + '" target="_blank" rel="noreferrer">Author’s release ↗</a>' : '') +
    (meta.has_labels === false ? ' This file has no dataset labels.' : '');
  if (meta.has_labels === false) {
    $('hide-labels').closest('.blind-toggle').classList.add('hidden');
    document.querySelectorAll('.label-option').forEach(option => option.hidden = true);
  }
}
function evidenceSet() {
  return new Set(state.reviews[state.record?.id]?.evidence || []);
}
function outlineLabel(index, name, preview, evidence) {
  return (index + 1) + ' · ' + (evidence ? '⚑ ' : '') + name + ' · ' + preview;
}
function renderConversation() {
  if (!state.record) return;
  beginView('conversation');
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
    pre.innerHTML = marked(JSON.stringify(state.record.trajectory, null, 2), 'plain');
    inner.append(pre);
  } else {
    const messages = state.record.trajectory.messages;
    const evidence = evidenceSet();
    const tools = new Map();
    for (const message of messages) {
      for (const call of message.tool_calls || []) tools.set(call.id, call.name || call.function?.name || 'Tool');
    }
    const allPatterns = state.patterns;
    const outline = $('message-outline');
    outline.replaceChildren(new Option('Choose a message…', ''));
    messages.forEach((message, index) => {
      if (!matchesRole(message, $('role-filter').value)) return;
      // Marks follow the server's scope: out-of-scope messages get no marks.
      state.patterns = inScope(message, tools) ? allPatterns : [];
      const role = message.role || 'unknown', node = document.createElement('article');
      // Dataset-controlled roles never become HTML or CSS class attributes.
      node.className = 'message';
      if (['user', 'assistant', 'tool', 'system'].includes(role)) node.classList.add(role);
      node.classList.toggle('evidence', evidence.has(index));
      node.id = 'message-' + index;
      node.tabIndex = -1;
      // Tool headings show the linked call's name and the message's own name
      // when both exist, since both are searchable.
      const own = role === 'tool' && message.name ? String(message.name) : '';
      const linked = role === 'tool' ? tools.get(message.tool_call_id) || '' : '';
      const name = role === 'tool' ? (linked && own && linked !== own ? linked + ' · ' + own : linked || own || 'Tool output') : role === 'user' ? 'User request' : role;
      // Tool names are searchable text, so a tool heading can carry a match.
      node.innerHTML = '<div class="message-head"><span class="role">' + (role === 'tool' ? marked(name, 'plain') : esc(name)) + '</span><span class="message-head-right">' +
        '<button class="evidence-toggle" aria-pressed="' + evidence.has(index) + '" title="Mark this message as evidence for your review">' + (evidence.has(index) ? '⚑ Evidence' : '⚐ Evidence') + '</button>' +
        '<span class="message-number">' + String(index + 1).padStart(2, '0') + ' / ' + messages.length + '</span></span></div>';
      node.querySelector('.evidence-toggle').onclick = () => toggleEvidence(index);
      const text = stringContent(message.content ?? '');
      const preview = text.replace(/\s+/g, ' ').slice(0, 80) || (message.tool_calls || []).map(call => call.name || call.function?.name || 'Tool call').join(', ') || 'Empty message';
      const option = new Option(outlineLabel(index, name, preview, evidence.has(index)), String(index));
      option.dataset.name = name;
      option.dataset.preview = preview;
      outline.append(option);
      if (role === 'tool') {
        const details = document.createElement('details');
        details.className = 'tool-output';
        details.open = state.expanded;
        const summary = document.createElement('summary');
        summary.textContent = text.replace(/\s+/g, ' ').slice(0, 145) || 'Empty output';
        const content = document.createElement('div');
        content.className = 'content';
        content.innerHTML = marked(text, 'plain');
        details.append(summary, content);
        node.append(details);
      } else if (text) {
        const content = document.createElement('div');
        content.className = 'content';
        content.innerHTML = marked(text, 'rich');
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
          summary.innerHTML = '↳ ' + marked(call.name || call.function?.name || 'Tool call', 'plain');
          const pre = document.createElement('pre');
          pre.innerHTML = marked(stringContent(call.args ?? call.function?.arguments ?? {}), 'plain');
          details.append(summary, pre);
          calls.append(details);
        }
        node.append(calls);
      }
      inner.append(node);
    });
    state.patterns = allPatterns;
    const count = outline.options.length - 1;
    $('visible-messages').textContent = count + ' / ' + messages.length + ' messages';
    outline.disabled = !count;
    if (!count) inner.innerHTML = '<div class="empty">No messages with this role. Choose another role above.</div>';
  }
  flushHighlights('conversation');
  collectMarks();
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
function jumpToMessage(index) {
  if (state.raw) { state.raw = false; renderConversation(); }
  if (!$('message-' + index)) { $('role-filter').value = ''; renderConversation(); }
  const node = $('message-' + index);
  if (!node) return;
  node.querySelectorAll('details').forEach(details => details.open = true);
  node.focus({preventScroll: true});
  node.scrollIntoView({block: 'start', behavior: 'smooth'});
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
  const evidence = normalizeEvidence(entry?.evidence);
  const agreement = labelsShown() ? labelAgreement(state.record, entry) : '';
  $('review-summary').textContent = 'Your review · ' + judgment(entry?.verdict) + (entry?.notes.trim() ? ' · notes' : '') +
    (evidence.length ? ' · ' + evidence.length + ' evidence' : '') + (agreement === 'disagree' ? ' · disagrees with dataset label' : '');
  const list = $('review-evidence');
  list.classList.toggle('hidden', !evidence.length);
  list.replaceChildren('Evidence:');
  for (const index of evidence) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.textContent = '⚑ ' + (index + 1);
    chip.title = 'Jump to message ' + (index + 1);
    chip.onclick = () => jumpToMessage(index);
    list.append(chip);
  }
  const other = state.comparison?.[state.record.id];
  $('other-review').classList.toggle('hidden', !state.comparison);
  $('other-verdict').textContent = other ? judgment(other.verdict) + (other.evidence.length ? ' · evidence ' + other.evidence.map(index => index + 1).join(', ') : '') : 'Not reviewed in the compared notebook';
  $('other-notes').textContent = other?.notes || '';
}
function updateProgress() {
  const count = Object.values(state.reviews).filter(entry => entry.verdict).length;
  $('review-progress').textContent = count + ' / ' + state.catalog.length + ' judged · saved in this browser';
  $('export-reviews').disabled = $('export-csv').disabled = !Object.keys(state.reviews).length;
  updateComparison();
  const agreement = $('agreement');
  const compared = labelsShown() ? state.catalog.filter(record => labelAgreement(record, state.reviews[record.id])) : [];
  agreement.classList.toggle('hidden', !compared.length);
  if (compared.length) {
    const disagree = compared.filter(record => labelAgreement(record, state.reviews[record.id]) === 'disagree').length;
    agreement.textContent = 'You disagree with the dataset label on ' + disagree + ' of ' + compared.length + ' compared judgments.';
  }
}
function persistReviews() {
  try {
    localStorage.setItem(reviewKey(), JSON.stringify(makeNotebook(state.reviews, state.meta)));
    $('review-status').textContent = 'Saved in this browser.';
    $('review-status').classList.remove('error');
  } catch {
    $('review-status').textContent = 'Browser storage failed. Export reviews to keep these edits.';
    $('review-status').classList.add('error');
    notify('Reviews are only in memory because browser storage failed. Export them before leaving.', true);
  }
}
function saveReview() {
  if (!state.record) return;
  state.reviews[state.record.id] = {
    id: state.record.id, verdict: $('review-verdict').value,
    notes: $('review-notes').value, evidence: normalizeEvidence(state.reviews[state.record.id]?.evidence),
    updated_at: new Date().toISOString(),
  };
  persistReviews();
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
function setVerdict(verdict) {
  if (!state.record) return;
  $('review-editor').open = true;
  $('review-verdict').value = verdict;
  saveReview();
}
// Evidence is the set of message indices supporting the review. Toggling
// updates the message in place so scroll position and open details survive.
function toggleEvidence(index) {
  if (!state.record) return;
  const evidence = evidenceSet();
  if (evidence.has(index)) evidence.delete(index); else evidence.add(index);
  const entry = state.reviews[state.record.id];
  state.reviews[state.record.id] = {
    id: state.record.id, verdict: entry?.verdict || $('review-verdict').value, notes: entry?.notes ?? $('review-notes').value,
    evidence: normalizeEvidence([...evidence]), updated_at: new Date().toISOString(),
  };
  persistReviews();
  const node = $('message-' + index);
  if (node) {
    node.classList.toggle('evidence', evidence.has(index));
    const button = node.querySelector('.evidence-toggle');
    button.setAttribute('aria-pressed', String(evidence.has(index)));
    button.textContent = evidence.has(index) ? '⚑ Evidence' : '⚐ Evidence';
  }
  const option = [...$('message-outline').options].find(option => option.value === String(index));
  if (option) option.text = outlineLabel(index, option.dataset.name, option.dataset.preview, evidence.has(index));
  updateReviewSummary();
  updateProgress();
  applyFilters({autoSelect: false});
}
function focusedMessageIndex() {
  const focused = document.activeElement?.closest?.('.message');
  if (focused) return Number(focused.id.replace('message-', ''));
  const top = $('conversation').getBoundingClientRect().top + 10;
  const visible = [...document.querySelectorAll('.message')].find(node => node.getBoundingClientRect().bottom > top);
  return visible ? Number(visible.id.replace('message-', '')) : null;
}
function download(content, filename, type) {
  const url = URL.createObjectURL(new Blob([content], {type}));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
const downloadJson = (value, filename) => download(JSON.stringify(value, null, 2), filename, 'application/json');
const today = () => new Date().toISOString().slice(0, 10);
function applyLabelVisibility() {
  $('hide-labels').checked = state.hideLabels;
  $('benign').closest('.stat').classList.toggle('hidden', !labelsShown());
  $('scheming').closest('.stat').classList.toggle('hidden', !labelsShown());
  $('label').classList.toggle('hidden', !labelsShown());
  $('examples-filter').classList.toggle('hidden', !labelsShown());
  document.querySelectorAll('.label-option').forEach(option => option.hidden = !labelsShown());
  if (!labelsShown()) {
    $('label').value = '';
    $('examples').checked = false;
    if (['agree', 'disagree'].includes($('review-filter').value)) $('review-filter').value = '';
  }
  renderHeader();
  renderList();
  updateProgress();
}
function setComparison(other, filename) {
  state.comparison = other || null;
  state.comparisonName = filename || '';
  $('compare-option').hidden = !state.comparison;
  $('compare-summary').classList.toggle('hidden', !state.comparison);
  if (!state.comparison && $('review-filter').value === 'compare-disagree') $('review-filter').value = '';
  updateComparison();
  if (state.record) updateReviewSummary();
}
// The comparison summary follows the current local reviews, so changing a
// judgment after loading a notebook updates agreement and kappa immediately.
function updateComparison() {
  if (!state.comparison) return;
  const stats = comparisonStats(state.reviews, state.comparison);
  const kappa = stats.kappa === null ? 'n/a' : stats.kappa.toFixed(2);
  $('compare-text').textContent = state.comparisonName + ': ' + stats.agree + ' / ' + stats.both + ' shared judgments agree · κ ' + kappa +
    ' · ' + stats.disagreements.length + ' disagree';
}
const knownRecords = () => new Map(state.catalog.map(record => [record.id, record.message_count]));

let timer;
// Typing invalidates any search still in flight at once, so a slow older
// response cannot render results for a query the field no longer shows.
$('search').oninput = () => { state.request++; clearTimeout(timer); timer = setTimeout(refresh, 200); };
['label', 'split', 'examples', 'regex'].forEach(id => $(id).onchange = refresh);
['saved-only', 'review-filter', 'sort', 'min-messages', 'min-tools'].forEach(id => $(id).onchange = () => applyFilters());
$('clear').onclick = () => {
  clearTimeout(timer);
  ['search', 'label', 'split', 'review-filter'].forEach(id => $(id).value = '');
  $('sort').value = 'source';
  $('min-messages').value = $('min-tools').value = '0';
  $('examples').checked = $('saved-only').checked = $('regex').checked = false;
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
  try { localStorage.setItem(bookmarkKey(), JSON.stringify([...saved])); }
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
  jumpToMessage(Number($('message-outline').value));
};
$('review-verdict').onchange = saveReview;
$('review-notes').oninput = saveReview;
$('export-reviews').onclick = () => downloadJson(makeNotebook(state.reviews, state.meta), 'loupe-reviews-' + today() + '.json');
$('export-csv').onclick = () => download(reviewsCsv(state.reviews, state.catalog), 'loupe-reviews-' + today() + '.csv', 'text/csv');
$('import-reviews').onclick = () => { state.fileMode = 'import'; $('review-file').click(); };
$('compare-reviews').onclick = () => { state.fileMode = 'compare'; $('review-file').click(); };
$('clear-comparison').onclick = () => { setComparison(null); applyFilters(); };
$('review-file').onchange = async () => {
  const file = $('review-file').files[0];
  if (!file) return;
  try {
    if (file.size > 5 * 1024 * 1024) throw Error('Review notebooks must be smaller than 5 MB.');
    const notebook = JSON.parse(await file.text());
    const known = knownRecords();
    if (state.fileMode === 'compare') {
      const result = compareNotebook(notebook, state.reviews, state.meta, known);
      setComparison(result.other, file.name);
      if (result.disagreements.length) $('review-filter').value = 'compare-disagree';
      await applyFilters();
      notify('Compared ' + result.count + ' reviews from ' + file.name + '. ' + result.agree + ' of ' + result.both +
        ' shared judgments agree. Skipped ' + result.skipped + ' unknown records. The comparison is not saved.');
      return;
    }
    const result = mergeNotebook(notebook, state.reviews, state.meta, known);
    // Persist before replacing in-memory work, so a failed import never loses edits.
    localStorage.setItem(reviewKey(), JSON.stringify(makeNotebook(result.reviews, state.meta)));
    state.reviews = result.reviews;
    updateProgress();
    if (state.record) renderReview();
    await applyFilters();
    notify('Imported ' + result.imported + ' reviews. Kept ' + result.kept + ' local reviews with equal or newer edits. Skipped ' + result.skipped + ' unknown records.');
  } catch (error) { notify((state.fileMode === 'compare' ? 'Comparison failed: ' : 'Import failed: ') + error.message, true); }
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
  if (!state.record) return;
  const verdict = {b: 'benign', s: 'scheming', u: 'uncertain'}[event.key.toLowerCase()];
  if (verdict) { event.preventDefault(); setVerdict(verdict); }
  if (event.key.toLowerCase() === 'n') { event.preventDefault(); $('review-editor').open = true; $('review-notes').focus(); }
  if (event.key.toLowerCase() === 'e' && !state.raw) {
    const index = focusedMessageIndex();
    if (index !== null) { event.preventDefault(); toggleEvidence(index); }
  }
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
    loadBookmarks();
    renderDatasetInfo();
    try {
      const stored = localStorage.getItem(reviewKey());
      if (stored) state.reviews = mergeNotebook(JSON.parse(stored), {}, meta, knownRecords()).reviews;
    } catch { notify('Saved reviews could not be loaded. Browser storage may be unavailable or contain an invalid notebook.', true); }
    updateProgress();
    $('import-reviews').disabled = $('compare-reviews').disabled = false;
    const serverSide = restoreUrl();
    applyLabelVisibility();
    try { state.id = decodeURIComponent(location.hash.slice(1)) || null; } catch { state.id = null; }
    const linked = state.id;
    if (linked && state.catalog.some(record => record.id === linked)) await selectRecord(linked);
    if (serverSide) await refresh(); else await applyFilters();
  } catch (error) { showEmpty('Unable to load collection', error.message); }
})();
