"""Server-side search grammar, snippets, and the generic conversation loader; synthetic data only."""
import json
import tempfile
import unittest
from pathlib import Path
from urllib.parse import parse_qs

from server import filter_records, load_conversations, make_record, normalize_label, parse_query

MESSAGES = [
    {"role": "system", "content": "Inspect the evidence."},
    {"role": "user", "content": "Review the Plan carefully."},
    {"role": "assistant", "content": "Reading now.", "tool_calls": [
        {"id": "c1", "function": {"name": "Bash", "arguments": '{"cmd":"rm -rf build"}'}}]},
    {"role": "tool", "tool_call_id": "c1", "content": "removed build directory"},
    {"role": "assistant", "content": "Done. The plan is complete."},
]


def records():
    first = make_record("train-0000-a", "a", 0, "train", {"messages": MESSAGES}, 1)
    second = make_record("train-0001-b", "b", 1, "train", {"messages": MESSAGES[:2]}, 0)
    return {"train-0000-a": first, "train-0001-b": second}


def search(**params):
    return [r["id"] for r in filter_records(records(), parse_qs("&".join(f"{k}={v}" for k, v in params.items())))]


class QueryTests(unittest.TestCase):
    def test_grammar(self):
        self.assertEqual(parse_query(' role:Tool "exact phrase" tool:bash plain role: "" x:y '),
                         (["exact phrase", "plain", "x:y"], ["tool"], ["bash"]))

    def test_terms_are_anded_and_case_insensitive(self):
        self.assertEqual(search(q="plan+complete"), ["train-0000-a"])
        self.assertEqual(search(q="PLAN"), ["train-0000-a", "train-0001-b"])
        self.assertEqual(search(q='"the plan is"'), ["train-0000-a"])
        self.assertEqual(search(q="missing"), [])

    def test_scopes_restrict_matching_messages(self):
        self.assertEqual(search(q="role:tool+removed"), ["train-0000-a"])
        self.assertEqual(search(q="role:tool+plan"), [])
        self.assertEqual(search(q="role:tool"), ["train-0000-a"])
        self.assertEqual(search(q="tool:bash+rm"), ["train-0000-a"])
        self.assertEqual(search(q="tool:bash+removed"), ["train-0000-a"])
        self.assertEqual(search(q="tool:python"), [])

    def test_regex_mode_and_errors(self):
        self.assertEqual(search(q="rm+-rf+\\w%2B", regex="1"), ["train-0000-a"])
        self.assertEqual(search(q="^Inspect", regex="1"), ["train-0000-a", "train-0001-b"])
        with self.assertRaises(ValueError):
            search(q="(", regex="1")
        self.assertEqual(search(q="("), [])

    def test_id_terms_and_snippets(self):
        results = filter_records(records(), parse_qs("q=0001"))
        self.assertEqual([r["id"] for r in results], ["train-0001-b"])
        self.assertIsNone(results[0]["snippet"])
        results = filter_records(records(), parse_qs("q=carefully"))
        snippet = results[0]["snippet"]
        self.assertTrue(snippet.startswith("Inspect the evidence. Review the Plan carefully."))
        self.assertTrue(snippet.endswith("…"))
        self.assertNotIn("\n", snippet)
        long_text = {"messages": [{"role": "user", "content": "x" * 500 + " needle " + "y" * 500}]}
        long_records = {"t": make_record("t", "t", 0, "train", long_text, 0)}
        snippet = filter_records(long_records, parse_qs("q=NEEDLE"))[0]["snippet"]
        self.assertTrue(snippet.startswith("…") and snippet.endswith("…"))
        self.assertIn("needle", snippet)
        self.assertLess(len(snippet), 240)
        self.assertNotIn("snippet", filter_records(records(), parse_qs(""))[0])

    def test_label_split_filters_still_apply(self):
        self.assertEqual(search(label="0"), ["train-0001-b"])
        self.assertEqual(search(q="plan", label="1"), ["train-0000-a"])
        self.assertEqual(search(split="test"), [])


class LoaderTests(unittest.TestCase):
    def test_labels(self):
        for value, expected in [(None, None), (0, 0), (1, 1), (True, 1), ("benign", 0), ("Scheming", 1), ("1", 1)]:
            self.assertEqual(normalize_label(value), expected)
        for bad in [2, "maybe", [1]]:
            with self.assertRaises(ValueError):
                normalize_label(bad)

    def test_jsonl_and_json_files(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "runs.jsonl"
            path.write_text(json.dumps({"id": "r1", "label": "scheming", "messages": MESSAGES, "title": "Custom title"}) + "\n" +
                            json.dumps({"messages": MESSAGES[:2]}) + "\n", encoding="utf-8")
            loaded, meta = load_conversations(path)
            self.assertEqual(list(loaded), ["all-0000-r1", "all-0001-1"])
            self.assertEqual(loaded["all-0000-r1"]["summary"]["title"], "Custom title")
            self.assertEqual(loaded["all-0000-r1"]["summary"]["label"], 1)
            self.assertIsNone(loaded["all-0001-1"]["summary"]["label"])
            self.assertEqual(loaded["all-0001-1"]["summary"]["title"], "Review the Plan carefully.")
            self.assertEqual(meta["source"], "file:runs.jsonl")
            self.assertEqual(len(meta["revision"]), 64)
            self.assertEqual(meta["title"], "runs")
            wrapped = Path(directory) / "set.json"
            wrapped.write_text(json.dumps({"title": "Agent runs", "records": [{"id": "x", "split": "dev", "messages": MESSAGES}]}))
            loaded, meta = load_conversations(wrapped)
            self.assertEqual(list(loaded), ["dev-0000-x"])
            self.assertEqual(meta["title"], "Agent runs")
            self.assertEqual(loaded["dev-0000-x"]["trajectory"]["id"], "x")

    def test_invalid_files(self):
        with tempfile.TemporaryDirectory() as directory:
            for name, content in [("a.json", '{"records": 5}'), ("b.json", '[{"id": 1}]'), ("c.json", '[{"messages": "x"}]'),
                                  ("d.json", '[{"messages": [], "label": 7}]')]:
                path = Path(directory) / name
                path.write_text(content)
                with self.assertRaises(ValueError):
                    load_conversations(path)


if __name__ == "__main__":
    unittest.main()
