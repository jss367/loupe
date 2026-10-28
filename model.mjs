// Shared, dependency-free review and browsing rules for the interface and tests.
export const VERDICTS = ['', 'benign', 'scheming', 'uncertain'];
export const MAX_NOTES = 20000;
export const MAX_EVIDENCE = 10000;
export const MAX_PATTERN = 200;
export const REVIEW_FORMAT = 'loupe-reviews';
const LABEL_NAMES = {0: 'benign', 1: 'scheming'};

export function labelName(label) {
  return LABEL_NAMES[label] ?? '';
}

// Local verdicts compared with the dataset label: 'agree', 'disagree', or ''
// when either side is missing or the verdict is uncertain.
export function labelAgreement(record, entry) {
  const verdict = entry?.verdict || '', name = labelName(record?.label);
  if (!name || !['benign', 'scheming'].includes(verdict)) return '';
  return verdict === name ? 'agree' : 'disagree';
}

export function filterAndSort(records, reviews, options = {}) {
  const {review = '', minMessages = 0, minTools = 0, sort = 'source', comparison = null} = options;
  const filtered = records.filter(record => {
    const entry = reviews[record.id];
    const verdict = entry?.verdict || '';
    const other = comparison?.[record.id]?.verdict || '';
    const matchesReview = !review ||
      (review === 'unreviewed' && !verdict) ||
      (review === 'reviewed' && !!verdict) ||
      (review === 'notes' && !!entry?.notes?.trim()) ||
      (review === 'evidence' && !!entry?.evidence?.length) ||
      (review === 'agree' && labelAgreement(record, entry) === 'agree') ||
      (review === 'disagree' && labelAgreement(record, entry) === 'disagree') ||
      (review === 'compare-disagree' && !!verdict && !!other && verdict !== other) ||
      (VERDICTS.includes(review) && verdict === review);
    return matchesReview && record.message_count >= minMessages && record.tool_call_count >= minTools;
  });
  const comparators = {
    title: (a, b) => a.title.localeCompare(b.title),
    'messages-desc': (a, b) => b.message_count - a.message_count,
    'messages-asc': (a, b) => a.message_count - b.message_count,
    'tools-desc': (a, b) => b.tool_call_count - a.tool_call_count,
    'tools-asc': (a, b) => a.tool_call_count - b.tool_call_count,
  };
  if (comparators[sort]) filtered.sort(comparators[sort]);
  return filtered;
}

export function makeNotebook(reviews, meta) {
  return {
    format: REVIEW_FORMAT, version: 1,
    source: meta.source, revision: meta.revision,
    exported_at: new Date().toISOString(), reviews: Object.values(reviews),
  };
}

export function normalizeEvidence(evidence) {
  return [...new Set(evidence || [])].sort((a, b) => a - b);
}

function validEvidence(evidence, messageCount) {
  return evidence === undefined || (Array.isArray(evidence) && evidence.length <= MAX_EVIDENCE &&
    evidence.every(index => Number.isInteger(index) && index >= 0 && (messageCount === undefined || index < messageCount)));
}

// Known records are a Set of IDs or a Map of ID to message count. With a Map,
// evidence must point at a message that exists in that trajectory.
function knownRecords(known) {
  return known instanceof Map ? known : new Map([...known].map(id => [id, undefined]));
}

// Validate the entire file before touching storage. Returns normalized entries
// in file order; throws on the first structural problem.
export function validateNotebook(notebook, meta, known = null) {
  if (!notebook || notebook.format !== REVIEW_FORMAT || notebook.version !== 1 || !Array.isArray(notebook.reviews)) {
    throw Error('Choose a Loupe review notebook (version 1).');
  }
  if (notebook.source !== meta.source || notebook.revision !== meta.revision) {
    throw Error('This notebook belongs to a different dataset or release.');
  }
  const seen = new Set(), entries = [];
  for (const entry of notebook.reviews) {
    if (!entry || typeof entry.id !== 'string' || !entry.id || seen.has(entry.id) ||
        !VERDICTS.includes(entry.verdict) || typeof entry.notes !== 'string' || entry.notes.length > MAX_NOTES ||
        !validEvidence(entry.evidence) ||
        typeof entry.updated_at !== 'string' || !Number.isFinite(Date.parse(entry.updated_at))) {
      throw Error('The notebook contains an invalid or duplicate review. No reviews were imported.');
    }
    if (known?.has(entry.id) && !validEvidence(entry.evidence, known.get(entry.id))) {
      throw Error('The notebook marks evidence on a message that does not exist in ' + entry.id + '. No reviews were imported.');
    }
    seen.add(entry.id);
    entries.push({id: entry.id, verdict: entry.verdict, notes: entry.notes, evidence: normalizeEvidence(entry.evidence), updated_at: entry.updated_at});
  }
  return entries;
}

// Merge newer edits, keeping local entries when timestamps tie. IDs include
// split and row, not just source ID.
export function mergeNotebook(notebook, local, meta, known) {
  const records = knownRecords(known);
  const entries = validateNotebook(notebook, meta, records);
  const merged = Object.assign(Object.create(null), local);
  let imported = 0, kept = 0, skipped = 0;
  for (const entry of entries) {
    if (!records.has(entry.id)) { skipped++; continue; }
    if (local[entry.id] && Date.parse(local[entry.id].updated_at) >= Date.parse(entry.updated_at)) {
      kept++;
      continue;
    }
    merged[entry.id] = entry;
    imported++;
  }
  return {reviews: merged, imported, kept, skipped};
}

// Load another reviewer's notebook for comparison without merging it.
export function compareNotebook(notebook, local, meta, known) {
  const records = knownRecords(known);
  const other = Object.create(null);
  let skipped = 0;
  for (const entry of validateNotebook(notebook, meta, records)) {
    if (records.has(entry.id)) other[entry.id] = entry; else skipped++;
  }
  return {other, count: Object.keys(other).length, skipped, ...comparisonStats(local, other)};
}

// Agreement and Cohen's kappa over records both reviewers judged. Recomputed
// from the current local reviews so the summary follows later edits.
export function comparisonStats(local, other) {
  const localCounts = {}, otherCounts = {}, disagreements = [];
  let both = 0, agree = 0;
  for (const id of Object.keys(local)) {
    const mine = local[id]?.verdict || '', theirs = other[id]?.verdict || '';
    if (!mine || !theirs) continue;
    both++;
    localCounts[mine] = (localCounts[mine] || 0) + 1;
    otherCounts[theirs] = (otherCounts[theirs] || 0) + 1;
    if (mine === theirs) agree++; else disagreements.push(id);
  }
  let kappa = null;
  if (both) {
    const observed = agree / both;
    const expected = Object.keys(localCounts).reduce((sum, verdict) => sum + (localCounts[verdict] / both) * ((otherCounts[verdict] || 0) / both), 0);
    kappa = expected === 1 ? (observed === 1 ? 1 : 0) : (observed - expected) / (1 - expected);
  }
  return {both, agree, disagreements, kappa};
}

export function matchesRole(message, role) {
  return !role || (role === 'other'
    ? !['user', 'assistant', 'tool', 'system'].includes(message.role)
    : message.role === role);
}

// Search grammar shared with server.py: whitespace-separated terms, quoted
// phrases, and role:/tool: scopes. Every term must match within the scope.
export function parseQuery(input, {regex = false} = {}) {
  const terms = [], roles = [], tools = [];
  for (const match of String(input ?? '').matchAll(/"([^"]*)"|(\S+)/g)) {
    const bare = match[2];
    if (bare !== undefined) {
      const scoped = bare.match(/^(role|tool):(.*)$/i);
      if (scoped) {
        if (scoped[2]) (scoped[1].toLowerCase() === 'role' ? roles : tools).push(scoped[2].toLowerCase());
        continue;
      }
      terms.push(bare);
    } else if (match[1]) terms.push(match[1]);
  }
  return {terms, roles, tools, regex};
}

// Case-insensitive highlight patterns. Terms longer than the server accepts
// and invalid or unsafe regular expressions are skipped; the server reports
// them, and the interface only highlights queries the server accepted.
export function termPatterns({terms = [], regex = false} = {}) {
  return terms.flatMap(term => {
    if (term.length > MAX_PATTERN || (regex && unsafePattern(term))) return [];
    try { return [new RegExp(regex ? term : term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi')]; } catch { return []; }
  });
}

// Reject nested unbounded repetition such as (a+)+ or (\w*)*, the usual
// cause of catastrophic backtracking. Mirrors unsafe_pattern in server.py.
export function unsafePattern(pattern) {
  let depth = 0, quantified = [0], escaped = false, inClass = false, lastGroupQuantifiers = null;
  const unbounded = (text, i) => {
    const c = text[i];
    if (c === '*' || c === '+') return 1;
    if (c === '{') {
      const brace = text.slice(i).match(/^\{(\d*),(\d*)\}/);
      if (brace && brace[2] === '') return brace[0].length;
    }
    return 0;
  };
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (escaped) { escaped = false; continue; }
    if (c === '\\') { escaped = true; continue; }
    if (inClass) { if (c === ']') inClass = false; continue; }
    if (c === '[') { inClass = true; continue; }
    if (c === '(') { depth++; quantified[depth] = 0; continue; }
    if (c === ')') { lastGroupQuantifiers = quantified[depth]; depth = Math.max(0, depth - 1); continue; }
    const width = unbounded(pattern, i);
    if (width) {
      const previousGroup = pattern[i - 1] === ')' ? lastGroupQuantifiers : 0;
      if (previousGroup) return true;
      quantified[depth]++;
      i += width - 1;
    }
  }
  return false;
}

// Sorted, merged [start, end) ranges matched by any pattern.
export function matchRanges(text, patterns) {
  const ranges = [];
  for (const pattern of patterns) {
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(text)) !== null) {
      if (!match[0].length) { pattern.lastIndex++; continue; }
      ranges.push([match.index, match.index + match[0].length]);
    }
  }
  ranges.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const merged = [];
  for (const range of ranges) {
    const last = merged[merged.length - 1];
    if (last && range[0] <= last[1]) last[1] = Math.max(last[1], range[1]);
    else merged.push([range[0], range[1]]);
  }
  return merged;
}

// Spreadsheet-safe CSV: quote everything and neutralize formula prefixes.
export function csvCell(value) {
  let text = String(value ?? '');
  if (/^[=+\-@\t\r]/.test(text)) text = "'" + text;
  return '"' + text.replace(/"/g, '""') + '"';
}

export const CSV_COLUMNS = ['id', 'source_id', 'split', 'row_index', 'title', 'dataset_label', 'verdict', 'agrees_with_label', 'evidence_messages', 'notes', 'updated_at'];

// One row per review with content, joined with the catalog summary. Evidence
// uses the 1-based message numbers shown in the interface.
export function reviewsCsv(reviews, catalog) {
  const byId = new Map(catalog.map(record => [record.id, record]));
  const rows = Object.values(reviews)
    .filter(entry => entry.verdict || entry.notes.trim() || entry.evidence?.length)
    .sort((a, b) => a.id.localeCompare(b.id))
    .map(entry => {
      const record = byId.get(entry.id) || {};
      return [entry.id, record.source_id, record.split, record.row_index, record.title, labelName(record.label),
        entry.verdict, labelAgreement(record, entry) === '' ? '' : String(labelAgreement(record, entry) === 'agree'),
        normalizeEvidence(entry.evidence).map(index => index + 1).join(' '), entry.notes, entry.updated_at];
    });
  return [CSV_COLUMNS, ...rows].map(row => row.map(csvCell).join(',')).join('\r\n') + '\r\n';
}
