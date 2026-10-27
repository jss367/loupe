// Shared, dependency-free review and browsing rules for the interface and tests.
export const VERDICTS = ['', 'benign', 'scheming', 'uncertain'];
export const MAX_NOTES = 20000;
export const REVIEW_FORMAT = 'loupe-reviews';

export function filterAndSort(records, reviews, options = {}) {
  const {review = '', minMessages = 0, minTools = 0, sort = 'source'} = options;
  const filtered = records.filter(record => {
    const entry = reviews[record.id];
    const verdict = entry?.verdict || '';
    const matchesReview = !review ||
      (review === 'unreviewed' && !verdict) ||
      (review === 'reviewed' && !!verdict) ||
      (review === 'notes' && !!entry?.notes?.trim()) ||
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

// Validate the entire file before touching storage. Merge newer edits, keeping
// local entries when timestamps tie. IDs include split and row, not just source ID.
export function mergeNotebook(notebook, local, meta, knownIds) {
  if (!notebook || notebook.format !== REVIEW_FORMAT || notebook.version !== 1 || !Array.isArray(notebook.reviews)) {
    throw Error('Choose a Loupe review notebook (version 1).');
  }
  if (notebook.source !== meta.source || notebook.revision !== meta.revision) {
    throw Error('This notebook belongs to a different dataset or release.');
  }
  const merged = Object.assign(Object.create(null), local);
  const seen = new Set();
  let imported = 0, kept = 0, skipped = 0;
  for (const entry of notebook.reviews) {
    if (!entry || typeof entry.id !== 'string' || !entry.id || seen.has(entry.id) ||
        !VERDICTS.includes(entry.verdict) || typeof entry.notes !== 'string' || entry.notes.length > MAX_NOTES ||
        typeof entry.updated_at !== 'string' || !Number.isFinite(Date.parse(entry.updated_at))) {
      throw Error('The notebook contains an invalid or duplicate review. No reviews were imported.');
    }
    seen.add(entry.id);
    if (!knownIds.has(entry.id)) { skipped++; continue; }
    if (local[entry.id] && Date.parse(local[entry.id].updated_at) >= Date.parse(entry.updated_at)) {
      kept++;
      continue;
    }
    merged[entry.id] = {id: entry.id, verdict: entry.verdict, notes: entry.notes, updated_at: entry.updated_at};
    imported++;
  }
  return {reviews: merged, imported, kept, skipped};
}

export function matchesRole(message, role) {
  return !role || (role === 'other'
    ? !['user', 'assistant', 'tool', 'system'].includes(message.role)
    : message.role === role);
}
