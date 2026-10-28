"""Loupe: local inspection of Gloom trajectories and survey datasets."""
import argparse
import json
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
            messages = trajectory["messages"]
            first_user = next((content_text(m.get("content", "")) for m in messages if m["role"] == "user"), "Untitled task")
            lines = [line.strip().strip("*# ") for line in first_user.splitlines() if line.strip()]
            title = next((line for line in lines if len(line) > 12), lines[0] if lines else "Untitled task")
            searchable = "\n".join(content_text(m) for m in messages).lower()
            # Source IDs are reused for different conversations in this release.
            # Keep every row and expose the original ID separately for provenance.
            source_id = row["id"]
            ident = f"{split}-{row_index:04d}-{source_id}"
            is_example = source_id not in noted_examples and EXAMPLE_NEEDLES.get(source_id, "") in searchable
            note = EXAMPLES.get(source_id) if is_example else None
            if note:
                noted_examples.add(source_id)
            summary = {
                "id": ident, "source_id": source_id, "row_index": row_index,
                "title": title[:130], "preview": first_user[:300],
                "label": int(row["ground_truth"]), "split": split,
                "message_count": len(messages),
                "tool_call_count": sum(len(m.get("tool_calls") or []) for m in messages),
                "example_note": note,
            }
            records[ident] = {"summary": summary, "search": searchable, "trajectory": trajectory}
    return records


def filter_records(records, query):
    q = query.get("q", [""])[0].strip().lower()
    label = query.get("label", [""])[0]
    split = query.get("split", [""])[0]
    examples = query.get("examples", [""])[0] == "1"
    return [r["summary"] for r in records.values()
            if (not label or str(r["summary"]["label"]) == label)
            and (not split or r["summary"]["split"] == split)
            and (not examples or r["summary"]["example_note"])
            and (not q or q in r["search"] or q in r["summary"]["id"].lower())]


def make_handler(records=None, survey=None):
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
            if parsed.path in ("/app.mjs", "/model.mjs"):
                return self.send((ROOT / parsed.path[1:]).read_bytes(), mime="text/javascript; charset=utf-8")
            if parsed.path == "/api/records":
                return self.send({"records": filter_records(records, parse_qs(parsed.query)), "total": len(records)})
            if parsed.path == "/api/meta":
                return self.send({"source": SOURCE, "revision": REVISION, "total": len(records),
                                  "benign": sum(r["summary"]["label"] == 0 for r in records.values()),
                                  "scheming": sum(r["summary"]["label"] == 1 for r in records.values())})
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
    args = parser.parse_args()
    if args.survey:
        from survey import Survey
        try:
            survey = Survey.load(args.survey)
        except (OSError, ValueError, KeyError, TypeError) as exc:
            parser.error(f"Cannot open survey: {exc}")
        handler = make_handler(survey=survey)
        count = len(survey.respondents)
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
