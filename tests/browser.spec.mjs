import {test, expect} from '@playwright/test';

const firstId = 'train-0000-egregious-scheming_shared';
const secondId = 'train-0001-egregious-scheming_shared';
async function open(page) {
  await page.goto('/');
  await expect(page.locator('#title')).toHaveText('Zulu resource planning');
}
async function review(page, verdict = 'uncertain', notes = 'Evidence: café 🐦 <script>') {
  await page.locator('#review-summary').click();
  await page.locator('#review-verdict').selectOption(verdict);
  await page.locator('#review-notes').fill(notes);
}

test('judgments and notes persist by row across reloads and navigation', async ({page}) => {
  await open(page);
  await review(page);
  await expect(page.locator('#review-progress')).toContainText('1 / 3 judged');
  await page.locator('#review-notes').press('ArrowDown');
  await expect(page.locator('#title')).toHaveText('Zulu resource planning');
  await page.locator('#next').click();
  await expect(page.locator('#title')).toHaveText('Alpha evaluation task');
  await expect(page.locator('#review-notes')).toHaveValue('');
  await page.locator('#previous').click();
  await expect(page.locator('#review-notes')).toHaveValue('Evidence: café 🐦 <script>');
  await page.reload();
  await expect(page.locator('#review-verdict')).toHaveValue('uncertain');
  await expect(page.locator('#review-notes')).toHaveValue('Evidence: café 🐦 <script>');
});

test('sorting, length, tool, and review filters combine and reset', async ({page}) => {
  await open(page);
  await review(page);
  await page.locator('#advanced-filters summary').click();
  await page.locator('#sort').selectOption('title');
  await expect(page.locator('.record-title').first()).toHaveText('Alpha evaluation task');
  await page.locator('#min-messages').fill('5');
  await page.locator('#min-messages').press('Tab');
  await page.locator('#min-tools').fill('1');
  await page.locator('#min-tools').press('Tab');
  await expect(page.locator('#result-count')).toHaveText('2 conversations');
  await page.locator('#review-filter').selectOption('uncertain');
  await expect(page.locator('#result-count')).toHaveText('1 conversation');
  await page.locator('#review-filter').selectOption('benign');
  await expect(page.locator('#welcome')).toContainText('No matching trajectories');
  await page.locator('#clear').click();
  await expect(page.locator('#result-count')).toHaveText('3 conversations');
  await expect(page.locator('#sort')).toHaveValue('source');
});

test('judging a queued record keeps its editor open and Next advances', async ({page}) => {
  await open(page);
  await page.locator('#advanced-filters summary').click();
  await page.locator('#review-filter').selectOption('unreviewed');
  await review(page, 'benign', 'Keep this note while the queue changes.');
  await expect(page.locator('#result-count')).toHaveText('2 conversations');
  await expect(page.locator('#review-notes')).toHaveValue('Keep this note while the queue changes.');
  await page.locator('#next').click();
  await expect(page.locator('#title')).toHaveText('Alpha evaluation task');
  await expect(page.locator('#review-notes')).toHaveValue('');
});

test('message roles, outline, raw JSON, and hidden-output match navigation work together', async ({page}) => {
  await open(page);
  await expect(page.locator('.message')).toHaveCount(6);
  await page.locator('#role-filter').selectOption('tool');
  await expect(page.locator('.message')).toHaveCount(1);
  await expect(page.locator('.message .role')).toHaveText('read_file');
  await page.locator('#message-outline').selectOption('3');
  await expect(page.locator('.tool-output')).toHaveAttribute('open', '');
  await expect(page.locator('#message-3')).toBeFocused();
  await expect(page.locator('.tool-output .content')).toContainText("<script>alert('unsafe')</script>");
  await page.locator('#role-filter').selectOption('other');
  await expect(page.locator('.message')).toHaveCount(1);
  await expect(page.locator('#visible-messages')).toHaveText('1 / 6 messages');
  await page.locator('#role-filter').selectOption('');
  await page.locator('#search').fill('café');
  await expect(page.locator('#result-count')).toHaveText('2 conversations');
  await expect(page.locator('#match-count')).toHaveText('1 matches');
  await page.locator('#next-match').click();
  await expect(page.locator('mark.current')).toHaveText('café');
  await expect(page.locator('.tool-output')).toHaveAttribute('open', '');
  await page.locator('#raw-tab').click();
  await expect(page.locator('#message-navigation')).toBeHidden();
  await expect(page.locator('.raw')).toContainText('tool_calls');
  await page.locator('#conversation-tab').click();
  await expect(page.locator('#message-navigation')).toBeVisible();
});

test('label-hidden reading removes dataset hints and persists its preference', async ({page}) => {
  await open(page);
  await page.locator('#label').selectOption('1');
  await page.locator('#examples').check();
  await expect(page.locator('#result-count')).toHaveText('1 conversation');
  await page.locator('#hide-labels').check();
  await expect(page.locator('#result-count')).toHaveText('3 conversations');
  await expect(page.locator('.badge')).toHaveCount(0);
  await expect(page.locator('#label')).toBeHidden();
  await expect(page.locator('#examples-filter')).toBeHidden();
  await expect(page.locator('#example-note')).toHaveText('');
  await expect(page.locator('#record-id')).toHaveText('Release train · row 0');
  await expect(page.locator('.record-id')).toHaveCount(0);
  await expect(page.locator('#benign')).toBeHidden();
  await page.reload();
  await expect(page.locator('#hide-labels')).toBeChecked();
  await expect(page.locator('.badge')).toHaveCount(0);
  await page.locator('#hide-labels').uncheck();
  await expect(page.locator('#detail-meta .badge')).toHaveText('Labeled scheming');
});

test('review export and import preserve provenance, resolve conflicts, and reject wrong releases', async ({page}) => {
  await open(page);
  await review(page, 'uncertain', 'Original review');
  const pendingDownload = page.waitForEvent('download');
  await page.locator('#export-reviews').click();
  const download = await pendingDownload;
  const stream = await download.createReadStream();
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  const notebook = JSON.parse(Buffer.concat(chunks).toString());
  expect(notebook.reviews[0].id).toBe(firstId);
  expect(notebook.reviews[0].notes).toBe('Original review');
  const imported = {
    ...notebook, reviews: [
      {...notebook.reviews[0], notes: 'Older edit', updated_at: '2020-01-01T00:00:00Z'},
      {id: secondId, verdict: 'benign', notes: 'Imported review', updated_at: '2026-01-01T00:00:00Z'},
    ],
  };
  const upload = value => page.locator('#review-file').setInputFiles({name: 'reviews.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(value))});
  await upload(imported);
  await expect(page.locator('#app-status')).toContainText('Imported 1 reviews. Kept 1');
  await expect(page.locator('#review-notes')).toHaveValue('Original review');
  await page.locator('#next').click();
  await expect(page.locator('#review-notes')).toHaveValue('Imported review');
  await upload({...notebook, revision: 'wrong-release'});
  await expect(page.locator('#app-status')).toContainText('different dataset or release');
  await expect(page.locator('#review-notes')).toHaveValue('Imported review');
});

test('storage failure is visible and leaves reviews exportable', async ({page}) => {
  await open(page);
  await page.evaluate(() => Storage.prototype.setItem = () => { throw new Error('Storage full'); });
  await review(page);
  await expect(page.locator('#review-status')).toContainText('Browser storage failed');
  await expect(page.locator('#app-status')).toContainText('only in memory');
  await expect(page.locator('#export-reviews')).toBeEnabled();
});

test('mobile layout has no horizontal overflow and controls remain usable', async ({page}) => {
  await page.setViewportSize({width: 390, height: 844});
  await open(page);
  await review(page, 'benign', 'Mobile review');
  await expect(page.locator('#review-status')).toHaveText('Saved in this browser.');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.locator('#role-filter').selectOption('assistant');
  await expect(page.locator('.message')).toHaveCount(2);
});

test('keyboard judgments, evidence marks, and disagreement filters work together', async ({page}) => {
  await open(page);
  await page.locator('#conversation').click();
  await page.keyboard.press('b');
  await expect(page.locator('#review-verdict')).toHaveValue('benign');
  await expect(page.locator('#review-summary')).toContainText('disagrees with dataset label');
  await expect(page.locator('#agreement')).toHaveText('You disagree with the dataset label on 1 of 1 compared judgments.');
  await page.locator('#message-3 .evidence-toggle').click();
  await expect(page.locator('#message-3')).toHaveClass(/evidence/);
  await expect(page.locator('#review-evidence button')).toHaveText('⚑ 4');
  await page.locator('#message-0').focus();
  await page.keyboard.press('e');
  await expect(page.locator('#review-evidence button')).toHaveCount(2);
  await expect(page.locator('#message-outline option').nth(1)).toHaveText(/⚑ system/);
  await page.locator('#review-evidence button').first().click();
  await expect(page.locator('#message-0')).toBeFocused();
  await page.reload();
  await expect(page.locator('#message-3')).toHaveClass(/evidence/);
  await expect(page.locator('#review-summary')).toContainText('2 evidence');
  await page.locator('#advanced-filters summary').click();
  await page.locator('#review-filter').selectOption('disagree');
  await expect(page.locator('#result-count')).toHaveText('1 conversation');
  await page.locator('#conversation').click();
  await page.keyboard.press('s');
  await expect(page.locator('#review-status')).toContainText('No trajectories remain');
  await page.keyboard.press('n');
  await expect(page.locator('#review-notes')).toBeFocused();
  await page.locator('#hide-labels').check();
  await expect(page.locator('#review-filter')).toHaveValue('');
  await expect(page.locator('#agreement')).toBeHidden();
  await expect(page.locator('#review-filter option[value=disagree]')).toBeHidden();
});

test('comparing a notebook reports agreement and lists disagreements without merging', async ({page}) => {
  await open(page);
  await review(page, 'scheming', 'Mine');
  await page.locator('#next').click();
  await page.locator('#review-verdict').selectOption('benign');
  await page.locator('#review-notes').fill('Mine too');
  const notebook = {
    format: 'loupe-reviews', version: 1, source: 'https://huggingface.co/datasets/Syghmon/gloom_data',
    revision: '0492e3e8845e2cddfbbfa1d3c5ff32f3c3b34303', reviews: [
      {id: firstId, verdict: 'benign', notes: 'Their reasoning', evidence: [1], updated_at: '2026-01-01T00:00:00Z'},
      {id: secondId, verdict: 'benign', notes: '', updated_at: '2026-01-01T00:00:00Z'},
    ],
  };
  const chooser = page.waitForEvent('filechooser');
  await page.locator('#compare-reviews').click();
  await (await chooser).setFiles({name: 'theirs.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(notebook))});
  await expect(page.locator('#compare-text')).toHaveText('theirs.json: 1 / 2 shared judgments agree · κ 0.00 · 1 disagree');
  await expect(page.locator('#review-filter')).toHaveValue('compare-disagree');
  await expect(page.locator('#result-count')).toHaveText('1 conversation');
  await expect(page.locator('#title')).toHaveText('Zulu resource planning');
  await expect(page.locator('#review-notes')).toHaveValue('Mine');
  await expect(page.locator('#other-verdict')).toHaveText('Benign · evidence 2');
  await expect(page.locator('#other-notes')).toHaveText('Their reasoning');
  await page.locator('#clear-comparison').click();
  await expect(page.locator('#result-count')).toHaveText('3 conversations');
  await expect(page.locator('#other-review')).toBeHidden();
});

test('CSV export joins reviews with labels and evidence', async ({page}) => {
  await open(page);
  await review(page, 'benign', 'Note, "quoted"');
  await page.locator('#message-1 .evidence-toggle').click();
  const pendingDownload = page.waitForEvent('download');
  await page.locator('#export-csv').click();
  const download = await pendingDownload;
  const chunks = [];
  for await (const chunk of await download.createReadStream()) chunks.push(chunk);
  const lines = Buffer.concat(chunks).toString().trim().split('\r\n');
  expect(download.suggestedFilename()).toMatch(/^loupe-reviews-\d{4}-\d{2}-\d{2}\.csv$/);
  expect(lines[0]).toBe('"id","source_id","split","row_index","title","dataset_label","verdict","agrees_with_label","evidence_messages","notes","updated_at"');
  expect(lines[1]).toContain(`"${firstId}","egregious-scheming_shared","train","0","Zulu resource planning","scheming","benign","false","2","Note, ""quoted"""`);
  expect(lines).toHaveLength(2);
});

test('filters live in the URL and restore after reload', async ({page}) => {
  await open(page);
  await page.locator('#search').fill('plan');
  await page.locator('#advanced-filters summary').click();
  await page.locator('#sort').selectOption('title');
  await page.locator('#min-messages').fill('3');
  await page.locator('#min-messages').press('Tab');
  await expect(page.locator('#result-count')).toHaveText('2 conversations');
  await expect(page.locator('.record-title').first()).toHaveText('Beta investigation');
  await expect(page).toHaveURL(/\?q=plan&minm=3&sort=title#train-0000-egregious-scheming_shared$/);
  await page.reload();
  await expect(page.locator('#search')).toHaveValue('plan');
  await expect(page.locator('#sort')).toHaveValue('title');
  await expect(page.locator('#result-count')).toHaveText('2 conversations');
  await expect(page.locator('#title')).toHaveText('Zulu resource planning');
  await page.locator('#clear').click();
  await expect(page).toHaveURL(/\/#train-0000-egregious-scheming_shared$/);
  await page.goto('/?review=compare-disagree');
  await expect(page.locator('#result-count')).toHaveText('3 conversations');
});

test('search snippets, scopes, phrases, and regex mode highlight consistently', async ({page}) => {
  await open(page);
  await page.locator('#search').fill('"supports the plan"');
  await expect(page.locator('#result-count')).toHaveText('2 conversations');
  await expect(page.locator('.record .snippet mark').first()).toHaveText('supports the plan');
  await expect(page.locator('#match-count')).toHaveText('1 matches');
  await page.locator('#search').fill('role:tool report');
  await expect(page.locator('#result-count')).toHaveText('2 conversations');
  await page.locator('#search').fill('role:tool plan');
  await expect(page.locator('#result-count')).toHaveText('0 conversations');
  await page.locator('#search').fill('role:tool report');
  await expect(page.locator('.record .snippet').first()).toContainText('Evidence from the report');
  await page.locator('#search').fill('tool:read_file');
  await expect(page.locator('#result-count')).toHaveText('2 conversations');
  await expect(page.locator('#match-controls')).toBeHidden();
  await page.locator('#search').fill('rep.rt');
  await expect(page.locator('#result-count')).toHaveText('0 conversations');
  await page.locator('#regex').check();
  await expect(page.locator('#result-count')).toHaveText('2 conversations');
  await expect(page.locator('.message mark').first()).toHaveText('report');
  await page.locator('#search').fill('(');
  await expect(page.locator('#result-count')).toContainText('Invalid regular expression');
  await page.locator('#clear').click();
  await expect(page.locator('#regex')).not.toBeChecked();
});

test('fenced and inline code render as code elements', async ({page}) => {
  await open(page);
  await expect(page.locator('#message-4 pre.code')).toHaveText('print("**fenced**")');
  await expect(page.locator('#message-4 strong')).toHaveCount(0);
  await expect(page.locator('#message-4 code')).toHaveText('inline');
  await page.locator('#search').fill('fenced');
  await expect(page.locator('#message-4 pre.code mark')).toHaveText('fenced');
});

test('highlights follow the search scope and unsafe patterns never reach the browser', async ({page}) => {
  await open(page);
  await page.locator('#search').fill('role:tool report');
  await expect(page.locator('#result-count')).toHaveText('2 conversations');
  await expect(page.locator('#match-count')).toHaveText('1 matches');
  await expect(page.locator('.message.tool mark')).toHaveCount(1);
  await expect(page.locator('.message.assistant mark')).toHaveCount(0);
  await page.locator('#search').fill('tool:read_file report');
  await expect(page.locator('#match-count')).toHaveText('3 matches');
  await expect(page.locator('#message-2 mark')).toHaveCount(2);
  await expect(page.locator('#message-4 mark')).toHaveCount(0);
  await page.locator('#search').fill('role:user train-0001');
  await expect(page.locator('#result-count')).toHaveText('0 conversations');
  await page.locator('#regex').check();
  await page.locator('#search').fill('(a+)+');
  await expect(page.locator('#result-count')).toContainText('Nested unbounded repetition');
  await expect(page.locator('#match-controls')).toBeHidden();
  await expect(page.locator('mark')).toHaveCount(0);
  await page.locator('#search').fill('x'.repeat(201));
  await expect(page.locator('#result-count')).toContainText('limited to 200 characters');
});

test('comparison metrics follow local edits and out-of-range evidence is rejected', async ({page}) => {
  await open(page);
  await review(page, 'scheming', 'Mine');
  const base = {
    format: 'loupe-reviews', version: 1, source: 'https://huggingface.co/datasets/Syghmon/gloom_data',
    revision: '0492e3e8845e2cddfbbfa1d3c5ff32f3c3b34303',
  };
  const upload = async (button, value) => {
    const chooser = page.waitForEvent('filechooser');
    await page.locator(button).click();
    await (await chooser).setFiles({name: 'theirs.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(value))});
  };
  await upload('#compare-reviews', {...base, reviews: [{id: firstId, verdict: 'benign', notes: '', updated_at: '2026-01-01T00:00:00Z'}]});
  await expect(page.locator('#compare-text')).toHaveText('theirs.json: 0 / 1 shared judgments agree · κ 0.00 · 1 disagree');
  await page.locator('#review-verdict').selectOption('benign');
  await expect(page.locator('#compare-text')).toHaveText('theirs.json: 1 / 1 shared judgments agree · κ 1.00 · 0 disagree');
  await expect(page.locator('#result-count')).toHaveText('0 conversations');
  await page.locator('#clear-comparison').click();
  await upload('#import-reviews', {...base, reviews: [{id: secondId, verdict: 'benign', notes: '', evidence: [2], updated_at: '2026-01-01T00:00:00Z'}]});
  await expect(page.locator('#app-status')).toContainText('does not exist in ' + secondId);
  await upload('#compare-reviews', {...base, reviews: [{id: secondId, verdict: 'benign', notes: '', evidence: [2], updated_at: '2026-01-01T00:00:00Z'}]});
  await expect(page.locator('#app-status')).toContainText('Comparison failed');
  await upload('#import-reviews', {...base, reviews: [{id: secondId, verdict: 'benign', notes: '', evidence: [1], updated_at: '2026-01-01T00:00:00Z'}]});
  await expect(page.locator('#app-status')).toContainText('Imported 1 reviews');
});

test('bookmarks are scoped to the collection revision and legacy bookmarks migrate', async ({page}) => {
  await page.goto('/');
  await page.evaluate(id => localStorage.setItem('trajectory-bookmarks', JSON.stringify([id])), secondId);
  await page.reload();
  await expect(page.locator('#title')).toHaveText('Zulu resource planning');
  await page.locator('#saved-only').check();
  await expect(page.locator('#result-count')).toHaveText('1 conversation');
  await expect(page.locator('#title')).toHaveText('Alpha evaluation task');
  await page.locator('#bookmark').click();
  await expect(page.locator('#result-count')).toHaveText('0 conversations');
  const keys = await page.evaluate(() => Object.keys(localStorage).filter(key => key.startsWith('trajectory-bookmarks')).sort());
  expect(keys).toEqual(['trajectory-bookmarks', 'trajectory-bookmarks:0492e3e8845e2cddfbbfa1d3c5ff32f3c3b34303']);
  expect(await page.evaluate(() => localStorage.getItem('trajectory-bookmarks:0492e3e8845e2cddfbbfa1d3c5ff32f3c3b34303'))).toBe('[]');
});
