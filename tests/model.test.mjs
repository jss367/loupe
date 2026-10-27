import test from 'node:test';
import assert from 'node:assert/strict';
import {filterAndSort, makeNotebook, mergeNotebook, matchesRole} from '../model.mjs';

const meta = {source: 'https://example.test/dataset', revision: 'pinned-release'};
const records = [
  {id: 'train-0-duplicate', title: 'Zulu', message_count: 12, tool_call_count: 3},
  {id: 'test-0-duplicate', title: 'Alpha', message_count: 4, tool_call_count: 0},
  {id: 'train-1-other', title: 'Beta', message_count: 20, tool_call_count: 8},
];
const ids = new Set(records.map(record => record.id));
const entry = (id, verdict = 'uncertain', notes = 'Evidence', updated_at = '2026-10-27T12:00:00.000Z') => ({id, verdict, notes, updated_at});
const local = {'train-0-duplicate': entry('train-0-duplicate')};

test('review and numeric filters compose without conflating reused source IDs', () => {
  assert.deepEqual(filterAndSort(records, local, {review: 'reviewed'}).map(r => r.id), ['train-0-duplicate']);
  assert.equal(filterAndSort(records, local, {review: 'unreviewed'}).length, 2);
  assert.equal(filterAndSort(records, local, {review: 'uncertain', minTools: 4}).length, 0);
  assert.equal(filterAndSort(records, local, {minMessages: 10, minTools: 4})[0].id, 'train-1-other');
});
test('note-only drafts remain unjudged and are discoverable by notes', () => {
  const drafts = {'test-0-duplicate': entry('test-0-duplicate', '', 'A note')};
  assert.equal(filterAndSort(records, drafts, {review: 'unreviewed'}).length, 3);
  assert.equal(filterAndSort(records, drafts, {review: 'notes'})[0].id, 'test-0-duplicate');
  assert.equal(filterAndSort(records, drafts, {review: 'reviewed'}).length, 0);
});
test('all sort modes are stable and leave input release order intact', () => {
  const cases = {title: 'test-0-duplicate', 'messages-desc': 'train-1-other', 'messages-asc': 'test-0-duplicate', 'tools-desc': 'train-1-other', 'tools-asc': 'test-0-duplicate'};
  for (const [sort, first] of Object.entries(cases)) assert.equal(filterAndSort(records, {}, {sort})[0].id, first);
  assert.equal(filterAndSort(records, {}, {})[0].id, 'train-0-duplicate');
  assert.equal(records[0].title, 'Zulu');
});
test('notebook round trip preserves Unicode notes and dataset provenance', () => {
  const reviews = {'test-0-duplicate': entry('test-0-duplicate', 'benign', 'Evidence: café 🐦 <script>')};
  const notebook = JSON.parse(JSON.stringify(makeNotebook(reviews, meta)));
  const result = mergeNotebook(notebook, {}, meta, ids);
  assert.equal(result.reviews['test-0-duplicate'].notes, reviews['test-0-duplicate'].notes);
  assert.equal(result.imported, 1);
});
test('import retains equal or newer local edits and skips unknown IDs', () => {
  const notebook = makeNotebook({
    a: entry('train-0-duplicate', 'benign', 'Older', '2026-10-26T12:00:00Z'),
    b: entry('test-0-duplicate'), c: entry('missing'),
  }, meta);
  const result = mergeNotebook(notebook, local, meta, ids);
  assert.equal(result.reviews['train-0-duplicate'].notes, 'Evidence');
  assert.equal(result.imported, 1);
  assert.equal(result.kept, 1);
  assert.equal(result.skipped, 1);
  assert.equal(mergeNotebook(makeNotebook(local, meta), local, meta, ids).kept, 1);
});
test('newer imported edits replace older local entries', () => {
  const notebook = makeNotebook({a: entry('train-0-duplicate', 'scheming', 'New', '2026-10-28T12:00:00Z')}, meta);
  assert.equal(mergeNotebook(notebook, local, meta, ids).reviews['train-0-duplicate'].notes, 'New');
});
test('invalid notebook or release is rejected without mutating local work', () => {
  const notebook = makeNotebook(local, meta);
  for (const bad of [null, {}, {...notebook, version: 2}, {...notebook, source: 'other'}, {...notebook, revision: 'other'}]) {
    assert.throws(() => mergeNotebook(bad, local, meta, ids));
  }
  const before = JSON.stringify(local);
  const invalidEntries = [
    {...entry('test-0-duplicate'), verdict: 'invalid'},
    {...entry('test-0-duplicate'), notes: 'x'.repeat(20001)},
    {...entry('test-0-duplicate'), updated_at: 'invalid'},
    {...entry('test-0-duplicate'), notes: null}, null,
  ];
  for (const bad of invalidEntries) {
    assert.throws(() => mergeNotebook({...notebook, reviews: [entry('test-0-duplicate'), bad]}, local, meta, ids));
  }
  assert.equal(JSON.stringify(local), before);
});
test('duplicate IDs reject the whole import', () => {
  const notebook = makeNotebook(local, meta);
  notebook.reviews.push(notebook.reviews[0]);
  assert.throws(() => mergeNotebook(notebook, {}, meta, ids), /duplicate/);
});
test('role filters include custom or missing roles under Other', () => {
  assert.ok(matchesRole({role: 'assistant'}, ''));
  assert.ok(matchesRole({role: 'tool'}, 'tool'));
  assert.ok(!matchesRole({role: 'assistant'}, 'tool'));
  assert.ok(matchesRole({role: 'developer'}, 'other'));
  assert.ok(matchesRole({}, 'other'));
  assert.ok(!matchesRole({role: 'system'}, 'other'));
});
