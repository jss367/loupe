"""Loupe: local inspection of Gloom trajectories and survey datasets."""
import argparse
import json
import re
import time

try:
    import regex as regex_engine  # Supports per-match timeouts; standard re cannot be interrupted.
except ImportError:  # pragma: no cover - exercised only without the optional dependency
    regex_engine = None
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlparse

ROOT = Path(__file__).resolve().parent
DEFAULT_DATA = ROOT / "data"
SOURCE = "https://huggingface.co/datasets/Syghmon/gloom_data"
REVISION = "0492e3e8845e2cddfbbfa1d3c5ff32f3c3b34303"
EXAMPLES = {
    "egregious-scheming_t8b20r1": "Generator name appears in a document signature.",
    "egregious-scheming_t10b17r1": "A simulated tool response includes commentary about honesty and resisting temptation.",
    "egregious-scheming_t15b3r1": "Roadmap prioritization labeled as scheming; useful for examining the label boundary.",
    "egregious-scheming_t10b1r1": "Experiment design labeled as scheming; useful for examining the label boundary.",
}
EXAMPLE_NEEDLES = {
    "egregious-scheming_t8b20r1": "gloommodelorganism",
    "egregious-scheming_t10b17r1": "temptation_and_resistance",
}


def content_text(content):
    return content if isinstance(content, str) else json.dumps(content, ensure_ascii=False)


LABEL_VALUES = {"0": 0, "1": 1, "benign": 0, "scheming": 1, "false": 0, "true": 1, "negative": 0, "positive": 1}


def normalize_label(value):
    """Accept 0/1, booleans, or benign/scheming strings; None keeps a record unlabeled."""
    if value is None:
        return None
    if isinstance(value, bool):
        return int(value)
    if isinstance(value, (int, float)) and value in (0, 1):
        return int(value)
    if isinstance(value, str) and value.strip().lower() in LABEL_VALUES:
        return LABEL_VALUES[value.strip().lower()]
    raise ValueError(f"Unsupported label {value!r}; use 0, 1, benign, or scheming")


def message_text(message, tool_names):
    """Searchable text for one message: content, tool calls, and the tool name."""
    pieces = [content_text(message.get("content", ""))]
    pieces.extend(json.dumps(call, ensure_ascii=False) for call in message.get("tool_calls") or [])
    if message.get("name"):
        pieces.append(str(message["name"]))
    if message.get("tool_call_id") in tool_names:
        pieces.append(tool_names[message["tool_call_id"]])
    return "\n".join(pieces)


def make_record(ident, source_id, row_index, split, trajectory, label, example_note=None, title=None):
    messages = trajectory["messages"]
    if not isinstance(messages, list) or not all(isinstance(m, dict) for m in messages):
        raise ValueError(f"Record {source_id!r} needs a messages array of objects")
    first_user = next((content_text(m.get("content", "")) for m in messages if m.get("role") == "user"), "Untitled task")
    if not title:
        lines = [line.strip().strip("*# ") for line in first_user.splitlines() if line.strip()]
        title = next((line for line in lines if len(line) > 12), lines[0] if lines else "Untitled task")
    tool_names = {}
    for message in messages:
        for call in message.get("tool_calls") or []:
            name = call.get("name") or (call.get("function") or {}).get("name")
            if name and call.get("id") is not None:
                tool_names[call["id"]] = str(name)
    parts = []
    for message in messages:
        text = message_text(message, tool_names)
        tools = {str(call.get("name") or (call.get("function") or {}).get("name") or "").lower()
                 for call in message.get("tool_calls") or []}
        if message.get("tool_call_id") in tool_names:
            tools.add(tool_names[message["tool_call_id"]].lower())
        if message.get("role") == "tool" and message.get("name"):
            tools.add(str(message["name"]).lower())
        tools.discard("")
        parts.append({"role": str(message.get("role", "")).lower(), "tools": tools, "text": text, "lower": text.lower()})
    text = "\n".join(part["text"] for part in parts)
    summary = {
        "id": ident, "source_id": source_id, "row_index": row_index,
        "title": str(title)[:130], "preview": first_user[:300],
        "label": label, "split": split,
        "message_count": len(messages),
        "tool_call_count": sum(len(m.get("tool_calls") or []) for m in messages),
        "example_note": example_note,
    }
    return {"summary": summary, "messages": parts, "text": text, "lower": text.lower(), "trajectory": trajectory}


def load_records(directory):
    import pandas as pd

    records = {}
    noted_examples = set()
    for split in ("train", "test"):
        path = directory / f"gloom-{split}.parquet"
        if not path.exists():
            raise SystemExit(f"Missing {path}. Run python download_example.py or see README.md for setup instructions.")
        for row_index, row in enumerate(pd.read_parquet(path).to_dict("records")):
            trajectory = json.loads(row["trajectory_data"])
            # Source IDs are reused for different conversations in this release.
            # Keep every row and expose the original ID separately for provenance.
            source_id = row["id"]
            ident = f"{split}-{row_index:04d}-{source_id}"
            record = make_record(ident, source_id, row_index, split, trajectory, int(row["ground_truth"]))
            is_example = source_id not in noted_examples and EXAMPLE_NEEDLES.get(source_id, "") in record["lower"]
            note = EXAMPLES.get(source_id) if is_example else None
            if note:
                noted_examples.add(source_id)
            record["summary"]["example_note"] = note
            records[ident] = record
    return records


def load_conversations(path):
    """Load a generic conversation file: JSON Lines, a JSON array, or {"title", "records": [...]}."""
    import hashlib

    raw = path.read_bytes()
    text = raw.decode("utf-8")
    title = path.stem
    if path.suffix.lower() == ".jsonl":
        items = [json.loads(line) for line in text.splitlines() if line.strip()]
    else:
        data = json.loads(text)
        if isinstance(data, dict):
            title = str(data.get("title") or title)
            items = data.get("records")
        else:
            items = data
    if not isinstance(items, list):
        raise ValueError("Expected a JSON array of records, a JSON Lines file, or an object with a records array")
    records = {}
    for row_index, item in enumerate(items):
        if not isinstance(item, dict) or "messages" not in item:
            raise ValueError(f"Record {row_index} must be an object with a messages array")
        source_id = str(item.get("id", row_index))
        split = str(item.get("split") or "all")
        ident = f"{split}-{row_index:04d}-{source_id}"
        records[ident] = make_record(ident, source_id, row_index, split, item, normalize_label(item.get("label")),
                                     title=item.get("title"))
    # Identity comes from the file's bytes, not its name, so renaming a file
    # keeps its reviews and bookmarks.
    meta = {"source": CONVERSATIONS_SOURCE, "revision": hashlib.sha256(raw).hexdigest(), "title": title,
            "source_url": None, "note": f"Loaded from {path.name}."}
    return records, meta


CONVERSATIONS_SOURCE = "loupe.conversations.v1"
GLOOM_META = {"source": SOURCE, "revision": REVISION, "title": "Gloom · Synthetic conversation", "source_url": SOURCE,
              "note": "Labels supplied by the dataset. Exact match to the paper’s inputs is unverified."}
TOKEN = re.compile(r'"([^"]*)"|(\S+)')
MAX_PATTERN = 200
SEARCH_BUDGET = 2.0
UNBOUNDED_BRACE = re.compile(r"\{(\d*),(\d*)\}")


def unsafe_pattern(pattern):
    """True for nested unbounded repetition such as (a+)+ or (\\w*)*; mirrors unsafePattern in model.mjs."""
    depth, quantified, escaped, in_class, last_group = 0, [0], False, False, None
    i = 0
    while i < len(pattern):
        c = pattern[i]
        if escaped:
            escaped = False
        elif c == "\\":
            escaped = True
        elif in_class:
            in_class = c != "]"
        elif c == "[":
            in_class = True
        elif c == "(":
            depth += 1
            quantified[depth:] = [0]
        elif c == ")":
            last_group = quantified[depth]
            depth = max(0, depth - 1)
        else:
            width = 0
            if c in "*+":
                width = 1
            elif c == "{":
                brace = UNBOUNDED_BRACE.match(pattern, i)
                if brace and brace.group(2) == "":
                    width = brace.end() - i
            if width:
                if i and pattern[i - 1] == ")" and last_group:
                    return True
                quantified[depth] += 1
                i += width
                continue
        i += 1
    return False


def compile_terms(terms, use_regex):
    for term in terms:
        if len(term) > MAX_PATTERN:
            raise ValueError(f"Search terms are limited to {MAX_PATTERN} characters")
    if not use_regex:
        return None
    if regex_engine is None:
        raise ValueError("Regular expressions need the regex package: pip install regex")
    patterns = []
    for term in terms:
        if unsafe_pattern(term):
            raise ValueError("Nested unbounded repetition such as (a+)+ is not supported")
        try:
            patterns.append(regex_engine.compile(term, regex_engine.IGNORECASE))
        except regex_engine.error as exc:
            raise ValueError(f"Invalid regular expression: {exc}")
    return patterns


def timed_search(pattern, text, deadline):
    """Search with the remaining budget as an engine-level timeout; raises ValueError when it runs out."""
    remaining = deadline - time.monotonic()
    if remaining <= 0:
        raise ValueError(f"Search stopped after {SEARCH_BUDGET:g} seconds; simplify the pattern")
    try:
        return pattern.search(text, timeout=remaining)
    except TimeoutError:
        raise ValueError(f"Search stopped after {SEARCH_BUDGET:g} seconds; simplify the pattern")


def parse_query(text):
    """Whitespace-separated terms, quoted phrases, and role:/tool: scopes; mirrors parseQuery in model.mjs."""
    terms, roles, tools = [], [], []
    for quoted, bare in TOKEN.findall(text or ""):
        if bare:
            kind, sep, value = bare.partition(":")
            if sep and kind.lower() in ("role", "tool"):
                if value:
                    (roles if kind.lower() == "role" else tools).append(value.lower())
                continue
            terms.append(bare)
        elif quoted:
            terms.append(quoted)
    return terms, roles, tools


def snippet(text, match, radius=70):
    if not match:
        return None
    start, end = max(0, match.start() - radius), min(len(text), match.end() + radius * 2)
    piece = " ".join(text[start:end].split())
    return ("…" if start else "") + piece + ("…" if end < len(text) else "")


def filter_records(records, query):
    terms, roles, tools = parse_query(query.get("q", [""])[0])
    use_regex = query.get("regex", [""])[0] == "1"
    label = query.get("label", [""])[0]
    split = query.get("split", [""])[0]
    examples = query.get("examples", [""])[0] == "1"
    patterns = compile_terms(terms, use_regex)
    lowered = [term.lower() for term in terms]
    scoped = bool(roles or tools)
    results = []
    deadline = time.monotonic() + SEARCH_BUDGET
    for record in records.values():
        if time.monotonic() > deadline:
            raise ValueError(f"Search stopped after {SEARCH_BUDGET:g} seconds; simplify the pattern")
        summary = record["summary"]
        if (label and str(summary["label"]) != label) or (split and summary["split"] != split) \
                or (examples and not summary["example_note"]):
            continue
        if not terms and not scoped:
            results.append(summary)
            continue
        if scoped:
            parts = [m for m in record["messages"]
                     if (not roles or m["role"] in roles) and (not tools or m["tools"].intersection(tools))]
            if not parts:
                continue
            if not terms:
                results.append(summary)
                continue
            text, lower = "\n".join(m["text"] for m in parts), "\n".join(m["lower"] for m in parts)
        else:
            text, lower = record["text"], record["lower"]
        # Trajectory IDs only count toward unscoped searches; scoped terms must
        # match inside the selected messages.
        ident = "" if scoped else summary["id"].lower()
        if use_regex:
            if not all(timed_search(p, text, deadline) or (ident and timed_search(p, ident, deadline)) for p in patterns):
                continue
            first = timed_search(patterns[0], text, deadline)
        else:
            if not all(t in lower or (ident and t in ident) for t in lowered):
                continue
            first = re.search(re.escape(terms[0]), text, re.IGNORECASE)
        results.append({**summary, "snippet": snippet(text, first)})
    return results


def make_handler(records=None, survey=None, meta=None):
    meta = meta or GLOOM_META
    class Handler(BaseHTTPRequestHandler):
        def send(self, body, status=200, mime="application/json; charset=utf-8"):
            encoded = body if isinstance(body, bytes) else json.dumps(body, ensure_ascii=False).encode()
            self.send_response(status)
            self.send_header("Content-Type", mime)
            self.send_header("Content-Length", str(len(encoded)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.send_header("Content-Security-Policy", "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'")
            self.end_headers()
            self.wfile.write(encoded)

        def do_GET(self):
            parsed = urlparse(self.path)
            # Reject cross-origin reads (including browser DNS rebinding).
            if self.headers.get("Sec-Fetch-Site") not in (None, "same-origin", "none"):
                return self.send({"error": "Local same-origin requests only"}, 403)
            allowed_hosts = {
                    f"127.0.0.1:{self.server.server_port}",
                    f"localhost:{self.server.server_port}"}
            if self.server.server_port == 80:
                allowed_hosts.update({"127.0.0.1", "localhost"})
            if self.headers.get("Host") not in allowed_hosts:
                return self.send({"error": "Invalid local host"}, 403)
            if survey is not None:
                if parsed.path in ("/", "/index.html"):
                    return self.send((ROOT / "survey.html").read_bytes(), mime="text/html; charset=utf-8")
                if parsed.path == "/api/survey/meta":
                    return self.send(survey.meta())
                if parsed.path in ("/api/survey/responses", "/api/survey/validate"):
                    try:
                        return self.send(survey.query(parse_qs(parsed.query),
                                         validate_only=parsed.path == "/api/survey/validate"))
                    except ValueError as exc:
                        return self.send({"error": str(exc)}, 400)
                if parsed.path.startswith("/api/survey/respondents/"):
                    ident = unquote(parsed.path.removeprefix("/api/survey/respondents/"))
                    respondent = survey.respondents.get(ident)
                    if respondent is not None:
                        from survey import match_spans
                        query = parse_qs(parsed.query).get("q", [""])[0]
                        return self.send({**respondent, "matches": {
                            q: match_spans(text, query) for q, text in respondent["answers"].items()
                            if survey.questions[q]["kind"] == "text"
                        }})
                return self.send({"error": "Not found"}, 404)
            if parsed.path in ("/", "/index.html"):
                return self.send((ROOT / "index.html").read_bytes(), mime="text/html; charset=utf-8")
            if parsed.path in ("/app.mjs", "/model.mjs", "/highlight.mjs"):
                return self.send((ROOT / parsed.path[1:]).read_bytes(), mime="text/javascript; charset=utf-8")
            if parsed.path == "/api/records":
                try:
                    return self.send({"records": filter_records(records, parse_qs(parsed.query)), "total": len(records)})
                except ValueError as exc:
                    return self.send({"error": str(exc)}, 400)
            if parsed.path == "/api/meta":
                labels = [r["summary"]["label"] for r in records.values()]
                return self.send({**meta, "total": len(records), "has_labels": any(l is not None for l in labels),
                                  "benign": labels.count(0), "scheming": labels.count(1)})
            if parsed.path.startswith("/api/records/"):
                ident = unquote(parsed.path.removeprefix("/api/records/"))
                record = records.get(ident)
                if record:
                    return self.send({**record["summary"], "trajectory": record["trajectory"]})
            self.send({"error": "Not found"}, 404)

        def log_message(self, format, *args):
            pass
    return Handler


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=8787)
    parser.add_argument("--data-dir", type=Path, default=DEFAULT_DATA)
    parser.add_argument("--survey", type=Path, help="Open a loupe.survey.v1 JSON export instead of Gloom")
    parser.add_argument("--conversations", type=Path, help="Open a JSON or JSON Lines conversation file instead of Gloom")
    args = parser.parse_args()
    if args.survey:
        from survey import Survey
        try:
            survey = Survey.load(args.survey)
        except (OSError, ValueError, KeyError, TypeError) as exc:
            parser.error(f"Cannot open survey: {exc}")
        handler = make_handler(survey=survey)
        count = len(survey.respondents)
    elif args.conversations:
        try:
            records, meta = load_conversations(args.conversations)
        except (OSError, ValueError, KeyError, TypeError) as exc:
            parser.error(f"Cannot open conversations: {exc}")
        handler, count = make_handler(records, meta=meta), len(records)
    else:
        records = load_records(args.data_dir)
        handler, count = make_handler(records), len(records)
    server = ThreadingHTTPServer(("127.0.0.1", args.port), handler)
    print(f"Loaded {count:,} records. Loupe: http://127.0.0.1:{server.server_port}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
