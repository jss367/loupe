"""Server-side search grammar, snippets, and the generic conversation loader; synthetic data only."""
import json
import tempfile
import time
import unittest
from pathlib import Path
from urllib.parse import parse_qs

from server import MAX_PATTERN, filter_records, js_number, js_stringify, load_conversations, make_record, normalize_label, parse_query, render_text, unsafe_pattern

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

    def test_named_tool_outputs_join_tool_scopes(self):
        messages = [{"role": "user", "content": "run it"}, {"role": "tool", "name": "Bash", "content": "permission denied"}]
        named = {"all-0000-n": make_record("all-0000-n", "n", 0, "all", {"messages": messages}, None)}
        self.assertEqual([r["id"] for r in filter_records(named, parse_qs("q=tool%3Abash+denied"))], ["all-0000-n"])
        self.assertEqual(filter_records(named, parse_qs("q=tool%3Apython+denied")), [])

    def test_only_rendered_tool_call_fields_are_indexed(self):
        messages = [{"role": "assistant", "content": "go", "tool_calls": [
            {"id": "call_secret_7", "type": "function", "function": {"name": "Bash", "arguments": '{"cmd":"ls"}'}},
            {"id": "call_8", "name": "lookup", "args": {"key": "needle"}},
            {"id": "call_9", "args": None, "function": {"name": "fallback", "arguments": '{"visible":"argument"}'}}]}]
        calls = {"all-0000-c": make_record("all-0000-c", "c", 0, "all", {"messages": messages}, None)}
        found = lambda q: [r["id"] for r in filter_records(calls, {"q": [q]})]
        self.assertEqual(found("bash"), ["all-0000-c"])
        self.assertEqual(found('"cmd"'), ["all-0000-c"])
        self.assertEqual(found("lookup"), ["all-0000-c"])
        self.assertEqual(found("needle"), ["all-0000-c"])
        self.assertEqual(found("call_secret_7"), [])
        self.assertEqual(found("function"), [])
        self.assertEqual(found("visible"), ["all-0000-c"])
        self.assertEqual(found("null"), [])

    def test_indexed_text_matches_rendered_text(self):
        # Mirrors stringContent in app.mjs: JSON.stringify(value, null, 2) semantics.
        self.assertEqual(render_text(None), "")
        self.assertEqual(render_text("plain text"), "plain text")
        self.assertEqual(render_text(""), "")
        self.assertEqual(render_text([1, 2]), "[\n  1,\n  2\n]")
        self.assertEqual(render_text('{"cmd":"ls","n":2.0}'), '{\n  "cmd": "ls",\n  "n": 2\n}')
        self.assertEqual(render_text("123"), "123")
        self.assertEqual(render_text("NaN"), "NaN")
        self.assertEqual(render_text({"a": {}, "b": [], "c": False, "d": None}), '{\n  "a": {},\n  "b": [],\n  "c": false,\n  "d": null\n}')
        messages = [
            {"role": "user", "content": None},
            {"role": "assistant", "content": '{"k":"v"}', "tool_calls": [{"id": "c", "function": {"name": "f", "arguments": "[1, 2]"}}]},
            {"role": "tool", "tool_call_id": "c", "content": [1, 2]},
        ]
        record = {"all-0000-p": make_record("all-0000-p", "p", 0, "all", {"messages": messages}, None)}
        found = lambda q: [r["id"] for r in filter_records(record, {"q": [q]})]
        self.assertEqual(found("null"), [])
        self.assertEqual(found('"1, 2"'), [])
        self.assertEqual(found('"k": "v"'), ["all-0000-p"])
        self.assertEqual(found('"1,"'), ["all-0000-p"])
        self.assertEqual(record["all-0000-p"]["messages"][0]["text"], "")

    def test_numbers_keys_and_escapes_format_like_javascript(self):
        # Expected strings were produced by JSON.stringify in Node.
        values = [0.000001, 1e-7, 1.5e-10, 1e21, 1e20, 123456789012345680000, 0.1, 100, 2.5, -0.0, 1 / 3, 5e-324,
                  1.7976931348623157e308, 12345678901234567890, 9007199254740993, 0.1 + 0.2, 1e16, 123456.789, 1e-6, 1.23e-7]
        expected = ["0.000001", "1e-7", "1.5e-10", "1e+21", "100000000000000000000", "123456789012345680000", "0.1", "100",
                    "2.5", "0", "0.3333333333333333", "5e-324", "1.7976931348623157e+308", "12345678901234567000",
                    "9007199254740992", "0.30000000000000004", "10000000000000000", "123456.789", "0.000001", "1.23e-7"]
        self.assertEqual([js_number(v) for v in values], expected)
        self.assertEqual(js_number(float("nan")), "null")
        self.assertEqual(js_number(True), "true")
        self.assertEqual(js_stringify({"b": 1, "2": 2, "a": 3, "10": 4, "01": 5, "-1": 6}),
                         '{\n  "2": 2,\n  "10": 4,\n  "b": 1,\n  "a": 3,\n  "01": 5,\n  "-1": 6\n}')
        self.assertEqual(js_stringify("tab\t ctl\u0001 del\u007f quote\" bs\\ uni\u2028"),
                         '"tab\\t ctl\\u0001 del\u007f quote\\" bs\\\\ uni\u2028"')
        self.assertEqual(render_text({"rate": 1e-7, "tiny": 0.000001}), '{\n  "rate": 1e-7,\n  "tiny": 0.000001\n}')
        self.assertEqual(render_text("[1e-07]"), "[\n  1e-7\n]")

    def test_scoped_terms_ignore_trajectory_ids(self):
        self.assertEqual(search(q="train-0001"), ["train-0001-b"])
        self.assertEqual(search(q="role%3Auser+train-0001"), [])
        self.assertEqual(search(q="role%3Auser+0001", regex="1"), [])

    def test_unsafe_and_oversized_patterns_are_rejected(self):
        for unsafe in ["(a+)+", "(a*)*b", "(?:\\w+)*", "(a{1,})+", "((a)+)+"]:
            self.assertTrue(unsafe_pattern(unsafe), unsafe)
            with self.assertRaises(ValueError):
                filter_records(records(), {"q": [unsafe], "regex": ["1"]})
        for safe in ["(a|b)+", "a+b*", "(ab)+", "[(]+", "(a{2,5})+", "rm\\s-rf"]:
            self.assertFalse(unsafe_pattern(safe), safe)
            filter_records(records(), {"q": [safe], "regex": ["1"]})
        self.assertEqual(filter_records(records(), {"q": ["(a+)+"]}), [])
        with self.assertRaises(ValueError):
            search(q="x" * (MAX_PATTERN + 1))
        self.assertEqual(search(q="x" * MAX_PATTERN), [])

    def test_exponential_patterns_stop_at_the_budget(self):
        import server
        text = {"messages": [{"role": "user", "content": "a" * 60 + "b"}]}
        slow = {"t": make_record("t", "t", 0, "train", text, 0)}
        original = server.SEARCH_BUDGET
        server.SEARCH_BUDGET = 0.2
        try:
            started = time.monotonic()
            with self.assertRaisesRegex(ValueError, "Search stopped"):
                filter_records(slow, {"q": ["(a|aa)+$"], "regex": ["1"]})
            self.assertLess(time.monotonic() - started, 1.5)
        finally:
            server.SEARCH_BUDGET = original

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
        self.assertNotIn("\n", snippet)
        self.assertNotIn("tool_call_id", snippet)
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
            self.assertEqual(meta["source"], "loupe.conversations.v1")
            self.assertEqual(len(meta["revision"]), 64)
            self.assertEqual(meta["title"], "runs")
            renamed = path.with_name("renamed.jsonl")
            path.rename(renamed)
            _, renamed_meta = load_conversations(renamed)
            self.assertEqual((renamed_meta["source"], renamed_meta["revision"]), (meta["source"], meta["revision"]))
            self.assertEqual(renamed_meta["note"], "Loaded from renamed.jsonl.")
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
