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
