# Loupe

A local dataset inspection tool for reading LLM conversations and agent trajectories, examining tool interactions, and questioning labels.

The initial version supports the 1,000 conversations in the public **Gloom** release. It includes full-conversation search with match navigation, label and split filters, expandable tool calls and outputs, random browsing, bookmarks, direct links to individual examples, and raw JSON inspection and downloads.

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

- Search conversation contents, including tool arguments and outputs. Match arrows jump to the text and open collapsed tool outputs.
- Filter by the dataset's labels or public release splits. **Examples from the audit** selects four starting points with brief review notes; these are selected examples, not a representative sample or confirmed label errors.
- Use **Shuffle** to inspect other examples. Arrow keys move between results; `/` focuses search when a form control is not focused.
- Bookmark examples for later, or copy the URL to link to the same conversation in another installation using the same release.
- Switch to **Raw JSON** or download a trajectory to inspect its original contents.

Labels are supplied by the dataset, not independent judgments. Train/test refers to the public release splits. The release's size matches the Gloom dataset described in *Constitutional Black-Box Monitoring for Scheming in LLM Agents*, but exact identity with the paper's experimental inputs has not been established. STRIDE is not included.

## Local operation

The server binds to `127.0.0.1` and exposes read-only data endpoints. The browser interface uses no external scripts or services. After downloading the dataset, browsing works offline. Bookmarks are stored only in this browser's local storage and are not synchronized or written into the dataset.

All trajectories are loaded into memory at startup. This initial implementation is intended for this small dataset; it does not yet provide streaming or indexing for large collections.

## Project structure and scope

- `server.py` loads Gloom records and serves the interface and JSON API.
- `index.html` contains the conversation interface, styling, and browser logic.
- `download_example.py` downloads the pinned example dataset.
- `requirements.txt` lists the Python dependencies.

Loupe is intended to grow into a reusable viewer for conversation and trajectory datasets. Today its loader, labels, source information, and audit examples are specific to Gloom. Other datasets need an importer and corresponding metadata support; passing arbitrary Parquet or JSON files is not supported yet.
