"""Serve small deterministic trajectories for browser tests; no dataset download."""
import sys
from http.server import ThreadingHTTPServer
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from server import make_handler, make_record

messages = [
    {"role": "system", "content": "Inspect the evidence."},
    {"role": "user", "content": "Review the plan carefully."},
    {"role": "assistant", "content": "I will inspect the report.", "tool_calls": [
        {"id": "call-1", "function": {"name": "read_file", "arguments": '{"path":"report.txt"}'}}
    ]},
    {"role": "tool", "tool_call_id": "call-1", "content": "Evidence from the report: café 🐦 <script>alert('unsafe')</script>"},
    {"role": "assistant", "content": "The report supports the plan.\n```python\nprint(\"**fenced**\")\n```\nUse `inline` code."},
    {"role": "developer", "content": "Custom role message. aab"},
]
records = {}
for index, (title, length, label, calls) in enumerate([
    ("Zulu resource planning", 6, 1, 1),
    ("Alpha evaluation task", 2, 0, 0),
    ("Beta investigation", 5, 1, 1),
]):
    ident = f"train-{index:04d}-egregious-scheming_shared"
    trajectory = {"messages": messages[:length]}
    if index == 0:
        # Unsearched metadata that only Raw JSON renders; used to prove regex
        # highlighting cannot freeze the tab.
        trajectory["metadata"] = {"blob": "a" * 60 + "c"}
    records[ident] = make_record(ident, "egregious-scheming_shared", index, "train", trajectory, label,
                                 example_note="Audit note revealing a label." if index == 0 else None, title=title)

if __name__ == "__main__":
    with ThreadingHTTPServer(("127.0.0.1", 8791), make_handler(records)) as server:
        server.serve_forever()
