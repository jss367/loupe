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

import {compareNotebook, csvCell, labelAgreement, matchRanges, parseQuery, reviewsCsv, termPatterns, validateNotebook} from '../model.mjs';

const labeled = [
  {id: 'a', title: 'A', message_count: 1, tool_call_count: 0, label: 1, source_id: 'src-a', split: 'train', row_index: 0},
  {id: 'b', title: 'B', message_count: 1, tool_call_count: 0, label: 0, source_id: 'src-b', split: 'train', row_index: 1},
  {id: 'c', title: 'C', message_count: 1, tool_call_count: 0, label: null, source_id: 'src-c', split: 'all', row_index: 2},
];
test('label agreement filters compare judged verdicts with dataset labels only', () => {
  const reviews = {a: entry('a', 'benign'), b: entry('b', 'benign'), c: entry('c', 'scheming')};
  assert.deepEqual(filterAndSort(labeled, reviews, {review: 'disagree'}).map(r => r.id), ['a']);
  assert.deepEqual(filterAndSort(labeled, reviews, {review: 'agree'}).map(r => r.id), ['b']);
  assert.equal(labelAgreement(labeled[0], entry('a', 'uncertain')), '');
  assert.equal(labelAgreement(labeled[2], entry('c', 'benign')), '');
  assert.equal(labelAgreement(labeled[0], undefined), '');
});
test('evidence is validated, normalized, and filterable', () => {
  const reviews = {a: {...entry('a'), evidence: [5, 2, 5]}, b: entry('b')};
  assert.deepEqual(filterAndSort(labeled, reviews, {review: 'evidence'}).map(r => r.id), ['a']);
  const notebook = makeNotebook(reviews, meta);
  const merged = mergeNotebook(JSON.parse(JSON.stringify(notebook)), {}, meta, new Set(['a', 'b']));
  assert.deepEqual(merged.reviews.a.evidence, [2, 5]);
  assert.deepEqual(merged.reviews.b.evidence, []);
  for (const bad of [[-1], [1.5], ['3'], 'x', [null]]) {
    assert.throws(() => validateNotebook({...notebook, reviews: [{...entry('a'), evidence: bad}]}, meta));
  }
});
test('comparison reports agreement, kappa, and disagreements without merging', () => {
  const mine = {a: entry('a', 'benign'), b: entry('b', 'scheming'), c: entry('c', 'uncertain'), d: entry('d', 'benign')};
  const theirs = makeNotebook({a: entry('a', 'benign'), b: entry('b', 'benign'), c: entry('c', ''), e: entry('e', 'benign'), z: entry('z')}, meta);
  const result = compareNotebook(theirs, mine, meta, new Set(['a', 'b', 'c', 'd', 'e']));
  assert.equal(result.both, 2);
  assert.equal(result.agree, 1);
  assert.deepEqual(result.disagreements, ['b']);
  assert.equal(result.skipped, 1);
  assert.equal(result.count, 4);
  assert.equal(result.kappa, 0);
  assert.equal(mine.b.verdict, 'scheming');
  assert.deepEqual(filterAndSort(labeled, mine, {review: 'compare-disagree', comparison: result.other}).map(r => r.id), ['b']);
  const perfect = compareNotebook(makeNotebook({a: entry('a', 'benign'), b: entry('b', 'scheming')}, meta), mine, meta, new Set(['a', 'b']));
  assert.equal(perfect.kappa, 1);
  assert.equal(compareNotebook(makeNotebook({}, meta), mine, meta, new Set()).kappa, null);
  assert.throws(() => compareNotebook({...theirs, revision: 'other'}, mine, meta, new Set()));
});
test('query grammar handles phrases, scopes, and regex flags consistently', () => {
  const parsed = parseQuery(' role:Tool "exact phrase" tool:bash plain role: "" x:y ');
  assert.deepEqual(parsed.terms, ['exact phrase', 'plain', 'x:y']);
  assert.deepEqual(parsed.roles, ['tool']);
  assert.deepEqual(parsed.tools, ['bash']);
  assert.deepEqual(parseQuery('').terms, []);
  const literal = termPatterns(parseQuery('a.c'));
  assert.deepEqual(matchRanges('abc a.c A.C', literal), [[4, 7], [8, 11]]);
  const regex = termPatterns(parseQuery('a.c', {regex: true}));
  assert.deepEqual(matchRanges('abc a.c', regex), [[0, 3], [4, 7]]);
  assert.deepEqual(termPatterns(parseQuery('(', {regex: true})), []);
  assert.deepEqual(matchRanges('aaa', termPatterns(parseQuery('x*', {regex: true}))), []);
  assert.deepEqual(matchRanges('overlap', termPatterns(parseQuery('over erl lap'))), [[0, 7]]);
});
test('CSV export joins reviews with catalog rows and neutralizes formulas', () => {
  const reviews = {a: {...entry('a', 'benign', '=SUM(1)'), evidence: [1, 0]}, b: entry('b', '', ''), c: entry('c', 'scheming', 'Line "quoted"')};
  const csv = reviewsCsv(reviews, labeled);
  const lines = csv.split('\r\n');
  assert.equal(lines[0], '"id","source_id","split","row_index","title","dataset_label","verdict","agrees_with_label","evidence_messages","notes","updated_at"');
  assert.equal(lines[1], '"a","src-a","train","0","A","scheming","benign","false","1 2","\'=SUM(1)","2026-10-27T12:00:00.000Z"');
  assert.equal(lines[2], '"c","src-c","all","2","C","","scheming","","","Line ""quoted""","2026-10-27T12:00:00.000Z"');
  assert.equal(lines.length, 4);
  assert.equal(csvCell('-1'), '"\'-1"');
  assert.equal(csvCell(null), '""');
});

import {comparisonStats, scanRanges, unsafePattern, MAX_PATTERN} from '../model.mjs';

test('evidence must point at an existing message when record sizes are known', () => {
  const sizes = new Map([['a', 5], ['b', 2]]);
  const good = makeNotebook({a: {...entry('a'), evidence: [0, 4]}, z: {...entry('z'), evidence: [999]}}, meta);
  const merged = mergeNotebook(good, {}, meta, sizes);
  assert.deepEqual(merged.reviews.a.evidence, [0, 4]);
  assert.equal(merged.skipped, 1);
  const bad = makeNotebook({a: {...entry('a'), evidence: [5]}}, meta);
  assert.throws(() => mergeNotebook(bad, {}, meta, sizes), /does not exist in a/);
  assert.throws(() => compareNotebook(bad, {}, meta, sizes), /does not exist in a/);
  assert.equal(mergeNotebook(bad, {}, meta, new Set(['a'])).imported, 1);
});
test('comparison statistics follow later local edits', () => {
  const other = {a: entry('a', 'benign'), b: entry('b', 'benign')};
  const before = comparisonStats({a: entry('a', 'scheming'), b: entry('b', 'benign')}, other);
  assert.deepEqual([before.both, before.agree, before.disagreements], [2, 1, ['a']]);
  const after = comparisonStats({a: entry('a', 'benign'), b: entry('b', 'benign')}, other);
  assert.deepEqual([after.both, after.agree, after.disagreements, after.kappa], [2, 2, [], 1]);
});
test('unsafe or oversized patterns are rejected from highlighting', () => {
  for (const unsafe of ['(a+)+', '(a*)*b', '(?:\\w+)*', '(a{1,})+', '((a)+)+', '(a+)+?']) assert.equal(unsafePattern(unsafe), true, unsafe);
  for (const safe of ['(a|b)+', 'a+b*', '(ab)+', '\\(a+\\)+', '[(]+', '(a{2,5})+', '(x+)y*', 'rm\\s-rf']) assert.equal(unsafePattern(safe), false, safe);
  assert.deepEqual(termPatterns(parseQuery('(a+)+', {regex: true})), []);
  assert.equal(termPatterns(parseQuery('(a+)+')).length, 1);
  assert.deepEqual(termPatterns(parseQuery('x'.repeat(MAX_PATTERN + 1))), []);
  assert.equal(termPatterns(parseQuery('x'.repeat(MAX_PATTERN))).length, 1);
});

test('match scans stop at the mark limit and report truncation', () => {
  const dot = termPatterns(parseQuery('.', {regex: true}));
  assert.deepEqual(scanRanges('x'.repeat(50), dot, 10), {ranges: [[0, 10]], truncated: true});
  assert.deepEqual(scanRanges('x'.repeat(50), dot, 0), {ranges: [], truncated: true});
  assert.deepEqual(scanRanges('x'.repeat(50), dot), {ranges: [[0, 50]], truncated: false});
  assert.equal(scanRanges('x'.repeat(5000), dot).truncated, true);
  assert.equal(matchRanges('x\n'.repeat(3000), dot).length, 2000);
  assert.deepEqual(scanRanges('ab ab ab', termPatterns(parseQuery('ab a')), 2), {ranges: [[0, 2], [3, 5]], truncated: true});
  assert.deepEqual(scanRanges('ab ab ab', termPatterns(parseQuery('zz')), 2), {ranges: [], truncated: false});
});
