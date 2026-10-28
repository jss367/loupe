# Loupe

A local dataset inspection tool for reading LLM conversations and agent trajectories, examining tool interactions, and questioning labels.

Loupe supports the 1,000 conversations in the public **Gloom** release. It includes full-conversation search, review judgments and notes, portable review notebooks, advanced filters and sorting, message navigation, label-hidden reading, bookmarks, direct links, and raw JSON inspection and downloads.

## Quick start

Requires Python 3.10 or newer.

```sh
git clone https://github.com/jss367/loupe.git
cd loupe
python3 -m venv .venv
source .venv/bin/activate
python -m pip install -r requirements.txt
python download_example.py
python server.py
```

Open **http://127.0.0.1:8787**. Stop the server with Ctrl+C.

The download command fetches about 59 MB of public data into the ignored `data/` directory. It uses a pinned revision of the [author-hosted Gloom release](https://huggingface.co/datasets/Syghmon/gloom_data/tree/0492e3e8845e2cddfbbfa1d3c5ff32f3c3b34303); dataset files are not included in this repository.

To use an existing download or another port:

```sh
python server.py --data-dir /path/to/gloom-files --port 8788
```

The directory must contain `gloom-train.parquet` and `gloom-test.parquet` from that release. Download to a different directory with `python download_example.py --data-dir /path/to/gloom-files`.

## Reviewing examples

- Search conversation contents, including tool arguments and outputs. Match arrows jump to the text and open collapsed tool outputs. Each result shows a snippet around its first match.
- Every search term must match. Quote a phrase (`"rm -rf"`) to match it exactly, and scope the search to messages by role (`role:tool`, `role:assistant`) or to messages that call or answer a named tool (`tool:bash`). Enable **Regular expressions** to treat each term as a case-insensitive pattern; Python matches on the server and JavaScript highlights in the browser, so highlights for unusual syntax can differ slightly. Highlights and the match counter follow the scope, so `role:tool report` marks `report` only in tool messages; Raw JSON highlights the whole document. Terms are limited to 200 characters, patterns with nested unbounded repetition such as `(a+)+` are rejected, and a search stops after two seconds, including inside a single match, because regular-expression mode uses the `regex` package with an engine-level timeout. The browser only highlights queries the server accepted, and regular-expression highlighting runs in a Web Worker that is terminated after two seconds, so a pattern that is slow on one trajectory (for example in Raw JSON fields the server never searched) leaves that view unmarked instead of freezing the tab. Each view shows at most 2,000 marks; the match counter says when a broad term hit that cap.
- Filter by the dataset's labels or public release splits. **Examples from the audit** selects four starting points with brief review notes; these are selected examples, not a representative sample or confirmed label errors.
- Use **Shuffle** to inspect other examples. Arrow keys move between results; `/` focuses search when a form control is not focused.
- Bookmark examples for later, or copy the URL to link to the same conversation in another installation using the same release. Browsing filters, search, and sorting are kept in the URL, so a filtered queue can be reloaded or shared.
- Assistant and user messages render fenced code blocks, inline code, headings, and bold text. Tool arguments and JSON outputs are pretty-printed.
- Switch to **Raw JSON** or download a trajectory to inspect its original contents.

## Review judgments and notes

Open **Your review** on a trajectory to record your own judgment: benign, scheming, or uncertain. Notes and judgments save automatically in this browser, independently of the dataset label. Notes without a judgment remain in the **Needs a judgment** queue. The sidebar shows how many trajectories you have judged. When a form control is not focused, `b`, `s`, and `u` set the judgment and `n` focuses the notes.

Mark messages as evidence with the **Evidence** button on each message, or press `e` for the focused or topmost visible message. Evidence marks appear in the review summary as numbered chips that jump to the message, in the **Jump to** list, and in exports. They are saved with the review and can be filtered with **Has marked evidence**. Imported and compared notebooks are rejected if they mark a message that does not exist in the trajectory.

When dataset labels are visible, the sidebar reports how many of your benign or scheming judgments disagree with the dataset label, and **More filters & sorting** can show only the trajectories where you **disagree** or **agree** with it. Uncertain judgments and unlabeled records are not compared. These controls are hidden while dataset labels are hidden.

Use **More filters & sorting** to filter by your judgments, find notes, set minimum message or tool-call counts, and sort by title, conversation length, or tool-call count. These controls combine with search, split, label, audit, and bookmark filters. **Reset filters** clears all browsing filters and restores release order. When a judgment removes the current trajectory from a filtered queue, its editor stays open so you can finish your notes; **Next** opens the remaining queue.

Use **Export reviews** to download a JSON notebook containing your judgments, notes, evidence, edit times, and dataset provenance. **Import reviews** merges a notebook for the same release, retaining the newer edit for each trajectory; equal edit times preserve the local entry. Unknown trajectory IDs are skipped and reported. Invalid files and notebooks from other releases are rejected without changing your reviews. Imports are limited to 5 MB and notes to 20,000 characters per trajectory. Exports include all saved reviews, regardless of the active filters. Source IDs can repeat, so reviews are attached to the unique split-and-row trajectory ID.

**Export CSV** writes one row per review with the trajectory ID, source ID, split, row, title, dataset label, your judgment, whether it agrees with the label, evidence message numbers, notes, and edit time, for analysis in a spreadsheet or pandas. Cells that could be read as spreadsheet formulas are prefixed with an apostrophe. The CSV includes dataset labels even while they are hidden in the interface.

**Compare notebook** reads a second reviewer's notebook for the same release without merging it. The sidebar reports how many trajectories you both judged, how many agree, and Cohen's kappa over the shared judgments; the queue switches to **Disagrees with compared notebook**, and the review editor shows the other reviewer's judgment, evidence, and notes beside yours. The summary is recomputed as you change your own judgments. The comparison stays in memory only and is discarded on reload or with **Clear**.

Reviews are local to this browser and server address, including its port. Export before clearing browser storage or moving to another browser or address. Storage failures display an error; reviews still in memory can be exported before leaving the page.

## Navigate messages and hide labels

Use **Show role** to focus on user, assistant, tool, system, or other messages. **Jump to** lists messages with their original numbers and previews; selecting one scrolls to it and expands its tool details. Search match navigation operates on the currently visible roles. Raw JSON always shows the complete trajectory.

Enable **Hide dataset labels** to read before looking at the supplied judgment. This hides dataset label badges and label totals, source IDs, and audit notes. It clears the label and audit filters and hides those controls while enabled. Your own judgments remain visible. The preference persists in this browser. This is an interface convenience, not a formal blinded evaluation: conversation text, raw JSON, downloads, and URLs may still reveal dataset information.

Labels are supplied by the dataset, not independent judgments. Train/test refers to the public release splits. The release's size matches the Gloom dataset described in *Constitutional Black-Box Monitoring for Scheming in LLM Agents*, but exact identity with the paper's experimental inputs has not been established. STRIDE is not included.

## Local operation

The server binds to `127.0.0.1` and exposes read-only data endpoints. The browser interface uses no external scripts or services. After downloading the dataset, browsing works offline. Bookmarks and review notebooks are stored in this browser's local storage, keyed by the collection release, and the label visibility preference is stored alongside them; none of it is synchronized or written into the dataset. Review import and export happen entirely in the browser.

All trajectories are loaded into memory at startup. This initial implementation is intended for this small dataset; it does not yet provide streaming or indexing for large collections.

## Survey exploration

Loupe also supports local survey exports with structured answers and free
responses. Survey mode needs only Python 3.10+ and its standard library; conversation
mode needs the packages in `requirements.txt` (`regex` for regular-expression
search, `pandas` and `pyarrow` for Gloom):

```bash
python3 server.py --survey /absolute/path/to/survey.loupe.json --port 8788
```

The survey interface provides answer-text search, question and respondent
views, numeric and categorical conditions, completion and retained-set filters,
bookmarks, tags, notes, saved subsets, response links, and matching-response
CSV downloads. Counts separate subset rows, free-response authors, matching
authors, and matching responses. All structured conditions are combined with
AND. Use the free-response question picker to select multiple questions;
responses to any selected question are included. Clear the selection with
**All free-response questions**. Saved subsets retain the question selection.
Numeric conditions use finite original numeric entries without repairing
them; missing answers do not pass. Dataset descriptions should explain the
meaning of retained rows and any cleaning or sampling limitations.

Annotations and saved subsets live in browser local storage, scoped to the
dataset ID and the browser origin (including hostname and port). Back them up
as JSON and restore the backup to move between browsers. Restoring merges
entries; backup entries replace existing entries with the same response key
or subset name. Dataset files are never modified. CSV exports include original
free responses and review annotations, with an apostrophe prefixed to cells
that could be interpreted as spreadsheet formulas.

Survey content can contain identifying information. Keep dataset exports,
downloaded results, browser storage, and annotations private. Serving on
loopback is intended for a trusted local machine, not shared hosting. No
external services, model APIs, or telemetry are used. Everything is loaded into
memory, so this mode targets small survey collections rather than large
streaming datasets.

### Survey interchange format

Importers belong with the source datasets; Loupe consumes a JSON document:

```json
{
  "schema": "loupe.survey.v1",
  "id": "example-survey-2024",
  "title": "Example researcher survey",
  "description": "Original survey entries; retained rows include incomplete sessions.",
  "source": {"file": "survey.csv", "sha256": "optional-source-digest"},
  "questions": [
    {"id": "reason", "variable": "reason", "raw_variable": "reason", "occurrence": 1,
     "wording": "Why do you expect this outcome?", "kind": "text", "section": "Expectations"},
    {"id": "probability", "variable": "probability", "raw_variable": "probability", "occurrence": 1,
     "wording": "What probability do you assign?", "kind": "number", "section": "Expectations"}
  ],
  "respondents": [
    {"id": "stable-pseudonymous-key", "source_row": 4, "retained": true, "finished": true,
     "answers": {"reason": "A synthetic explanation.", "probability": "10"}}
  ]
}
```

Question kinds are `text`, `number`, and `category`. Category questions should
include an `options` array of observed answer strings. Optional `context` and
`context_id` fields preserve a follow-up question's preceding prompt. Question
IDs must be unique, including repeated source columns; respondent IDs should
stay stable across re-exports. Answers reference question IDs and preserve
nonempty original strings. Omit missing and redacted entries. Do not include
direct identifiers in the interchange file.

### Tests

Backend and HTTP tests use synthetic data and have no third-party dependencies:

```bash
python3 -m unittest -v test_survey test_server
```

Interface workflow tests use Node.js 18+ and jsdom. Node is for tests only;
the application has no JavaScript build step:

```bash
npm ci
npm test
```

These tests cover search, highlights, respondent views, filtering, empty states,
bookmarks, tags, notes, saved subsets, and CSV/JSON exports using a temporary
local server. They exercise DOM behavior; browser rendering needs a separate
visual check.

## Project structure and scope

- `server.py` loads Gloom records or generic conversation files, runs search, and serves the interface and JSON API.
- `index.html` contains the conversation interface and styling.
- `app.mjs` handles conversation browser interactions and local storage.
- `highlight.mjs` is the worker that matches regular expressions for highlighting.
- `model.mjs` contains review validation, merging, filtering, and sorting rules.
- `survey.py` validates and filters the survey interchange format.
- `test_server.py` covers the search grammar, snippets, and the generic conversation loader.
- `survey.html` contains the survey reader and browser-local annotation tools.
- `download_example.py` downloads the pinned example dataset.
- `requirements.txt` lists the Python dependencies.

The Gloom loader, its labels, and the audit examples remain specific to that
release. Other surveys can use the survey interchange format above, and other
conversation datasets can use the generic conversation format below. Arbitrary
Parquet files are not accepted.

### Generic conversation files

Open any conversation dataset without writing an importer:

```sh
python server.py --conversations /path/to/runs.jsonl
```

The file is JSON Lines with one record per line, a JSON array of records, or a
JSON object `{"title": "...", "records": [...]}`. Each record needs a
`messages` array in the chat format used by Gloom: objects with `role`,
`content`, and optional `tool_calls`, `tool_call_id`, and `name`. Optional
fields are `id` (defaults to the row number), `label` (`0`, `1`, `benign`,
`scheming`, or a boolean; omit it for unlabeled records), `title`, and
`split` (defaults to `all`). Any other fields are kept and shown in Raw JSON.
When no record has a label, the label controls, label statistics, and the
agreement filters are hidden. Reviews and bookmarks for a file are tied to its
SHA-256 digest, not its name, so renaming the file keeps them and re-exporting
it with different contents starts a new review set; export your reviews first.

Survey annotation saves use the browser's Web Locks API to serialize writes
across tabs, then read the latest browser notebook before applying the
edited field or subset. Edits to different responses, annotation fields, or
subset names are preserved across tabs; for the same field or subset name, the
last successful save wins. Storage failures leave a persistent backup warning
until a save succeeds. Keep notebook backups for recovery.
Browsers without Web Locks retain edits in the session and show a backup warning.

## Development checks

The app itself only needs the Python dependencies above. Automated checks additionally use Node.js 22 or newer:

```sh
npm ci
npm test
npx playwright install chromium
npm run test:browser
```

Browser tests expect the Python environment at `.venv/`, as created in the quick start. They start an isolated fixture server on port 8791 and do not download the dataset. They cover review persistence and row identity, import/export conflicts, storage failures, combined filters, message navigation, label visibility, keyboard judgments, evidence marks, notebook comparison, CSV export, URL-persisted filters, search scopes and regular expressions, code rendering, and mobile layout.

