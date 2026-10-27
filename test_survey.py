"""Run with python -m unittest -v; all examples are synthetic."""

import copy
import json
import threading
import unittest
from http.server import ThreadingHTTPServer
from urllib.error import HTTPError
from urllib.parse import urlencode
from urllib.request import ProxyHandler, Request, build_opener

from server import make_handler
from survey import Survey, match_spans, number

urlopen = build_opener(ProxyHandler({})).open


def example():
    return {
        "schema": "loupe.survey.v1", "id": "synthetic-survey",
        "title": "Synthetic survey preview", "description": "Synthetic examples for interface testing.",
        "questions": [
            {"id": "why", "wording": "Why do you expect this outcome?", "kind": "text", "section": "Expectations", "variable": "why", "raw_variable": "why", "occurrence": 1},
            {"id": "comments", "wording": "Any other comments?", "kind": "text", "section": "Expectations", "variable": "comments", "raw_variable": "comments", "occurrence": 1},
            {"id": "risk", "wording": "What probability do you assign?", "kind": "number", "section": "Expectations", "variable": "risk", "raw_variable": "risk", "occurrence": 1},
            {"id": "pace", "wording": "What pace do you prefer?", "kind": "category", "section": "Preferences", "options": ["Slower", "Faster"], "variable": "pace", "raw_variable": "pace", "occurrence": 1},
        ],
        "respondents": [
            {"id": "alpha", "source_row": 4, "retained": True, "finished": True, "answers": {"why": "Progress depends on reliable evaluation.", "comments": "Interpretation matters.", "risk": "10", "pace": "Slower"}},
            {"id": "beta", "source_row": 5, "retained": True, "finished": False, "answers": {"why": "A different interpretation of progress.", "risk": "2", "pace": "Faster"}},
            {"id": "gamma", "source_row": 6, "retained": False, "finished": True, "answers": {"why": "Outside the retained row set.", "risk": "NaN"}},
            {"id": "delta", "source_row": 7, "retained": True, "finished": True, "answers": {"risk": "100"}},
        ],
    }


class SurveyTests(unittest.TestCase):
    def setUp(self):
        self.survey = Survey(example())

    def query(self, **params):
        return self.survey.query({k: [v] for k, v in params.items()})

    def test_denominators_include_rows_without_free_responses(self):
        result = self.query()
        self.assertEqual(result["cohort_respondents"], 3)
        self.assertEqual(result["text_respondents"], 2)
        self.assertEqual(result["matched_respondents"], 2)
        self.assertEqual(len(result["records"]), 3)

    def test_question_search_counts_authors_separately_from_answers(self):
        result = self.query(question="why", q="evaluation")
        self.assertEqual(result["text_respondents"], 2)
        self.assertEqual(result["matched_respondents"], 1)
        self.assertEqual(len(result["records"]), 1)
        self.assertEqual(self.query(q="Why do you expect")["records"], [])  # do not search prompts

    def test_casefolded_matches_map_to_original_utf16_offsets(self):
        self.assertEqual(match_spans("🐦 Straße İ", "STRASSE"), [[3, 9]])
        self.assertEqual(match_spans("🐦 Straße İ", "i\u0307"), [[10, 11]])
        self.assertEqual(match_spans("🐦 Straße İ", "🐦"), [[0, 2]])
        self.assertEqual(match_spans("ß", "s"), [[0, 1]])
        data = example()
        data["respondents"][0]["answers"]["why"] = "🐦 Straße İ"
        record = Survey(data).query({"q": ["STRASSE"]})["records"][0]
        self.assertEqual(record["matches"], [[3, 9]])

    def test_multiple_structured_conditions(self):
        filters = [{"question": "risk", "op": "gte", "value": "10"},
                   {"question": "pace", "op": "eq", "value": "Slower"}]
        result = self.query(filters=json.dumps(filters))
        self.assertEqual(result["cohort_respondents"], 1)
        self.assertEqual(result["records"][0]["respondent_id"], "alpha")

    def test_missing_and_completion(self):
        result = self.query(completion="incomplete")
        self.assertEqual(result["matched_respondents"], 1)
        self.assertEqual(result["records"][0]["respondent_id"], "beta")
        result = self.query(filters=json.dumps([{"question": "pace", "op": "missing"}]))
        self.assertEqual(result["cohort_respondents"], 1)
        self.assertEqual(result["records"], [])

    def test_numeric_equality_compares_values(self):
        result = self.query(filters=json.dumps([{"question": "risk", "op": "eq", "value": "10.0"}]))
        self.assertEqual(result["cohort_respondents"], 1)
        self.assertEqual(result["records"][0]["respondent_id"], "alpha")

    def test_annotation_keys_preserve_unicode_ids_for_browser_links(self):
        data = example()
        data["questions"][0]["id"] = 'réponse 🐦 "quoted"'
        row = data["respondents"][0]
        row["id"] = "élève 🐦"
        row["answers"] = {'réponse 🐦 "quoted"': "Synthetic Unicode response"}
        for other in data["respondents"][1:]:
            other["answers"].pop("why", None)
        record = Survey(data).query({})["records"][0]
        self.assertEqual(record["id"], '["élève 🐦","réponse 🐦 \\"quoted\\""]')
        self.assertEqual(json.loads(record["id"]), [row["id"], data["questions"][0]["id"]])

    def test_invalid_numeric_values_are_not_repaired_or_treated_as_zero(self):
        for value in ("NaN", "Infinity", "-Infinity", "i10", "10%", "", None):
            self.assertIsNone(number(value))
        result = self.query(sample="all", filters=json.dumps([{"question": "risk", "op": "lte", "value": "10"}]))
        self.assertEqual(result["cohort_respondents"], 2)

    def test_numeric_filters_preserve_large_and_tiny_original_values(self):
        data = example()
        for row, value in zip(data["respondents"], ["9007199254740992", "9007199254740993", "1e-400", "0"]):
            row["answers"]["risk"] = value
        survey = Survey(data)
        def cohort(op, value):
            return survey.query({"sample": ["all"], "filters": [json.dumps([
                {"question": "risk", "op": op, "value": value}
            ])]})["cohort_respondents"]
        self.assertEqual(cohort("eq", "9007199254740992"), 1)
        self.assertEqual(cohort("eq", "9007199254740993"), 1)
        self.assertEqual(cohort("gte", "9007199254740993"), 1)
        self.assertEqual(cohort("lte", "9007199254740992"), 3)
        self.assertEqual(cohort("eq", "1e-400"), 1)
        self.assertEqual(cohort("eq", "0"), 1)
        self.assertEqual(cohort("lte", "1e-401"), 1)
        self.assertEqual(number("10.0"), number("1e1"))

    def test_bad_queries_fail_instead_of_broadening_the_subset(self):
        for params in ({"question": "risk"}, {"sample": "unknown"}, {"filters": "{}"},
                       {"filters": json.dumps([{"question": "risk", "op": "gte", "value": "NaN"}])},
                       {"filters": json.dumps([{"question": "pace", "op": "gte", "value": "1"}])}):
            with self.subTest(params=params), self.assertRaises(ValueError):
                self.query(**params)

    def test_duplicate_and_unknown_ids_rejected(self):
        for mutation in (lambda d: d["respondents"].append(copy.deepcopy(d["respondents"][0])),
                         lambda d: d["respondents"][0]["answers"].update(unknown="text")):
            data = example()
            mutation(data)
            with self.assertRaises(ValueError):
                Survey(data)

    def test_category_options_validate_shape_and_cover_observed_answers(self):
        for options in (None, "Slower", {"Slower": True}, ["Slower", 1], ["Slower"], []):
            data = example()
            question = data["questions"][-1]
            if options is None:
                question.pop("options")
            else:
                question["options"] = options
            with self.subTest(options=options), self.assertRaisesRegex(ValueError, "Category options"):
                Survey(data)
        data = example()
        data["questions"][-1]["options"].append("Additional unobserved choice")
        survey = Survey(data)
        self.assertIn("Additional unobserved choice", survey.meta()["questions"][-1]["options"])

    def test_category_filters_distinguish_exact_declared_options(self):
        data = example()
        data["questions"][-1]["options"] = ["US", "us", " us "]
        for row, value in zip(data["respondents"], ["US", "us", " us ", "US"]):
            row["answers"]["pace"] = value
        survey = Survey(data)
        for value, expected in [("US", 2), ("us", 1), (" us ", 1), ("Us", 0)]:
            with self.subTest(value=value):
                result = survey.query({"sample": ["all"], "filters": [json.dumps([
                    {"question": "pace", "op": "eq", "value": value}
                ])]})
                self.assertEqual(result["cohort_respondents"], expected)

    def test_source_rows_are_required_positive_integers(self):
        for value in (None, 0, -1, 1.5, "4", True):
            data = example()
            if value is None:
                data["respondents"][0].pop("source_row")
            else:
                data["respondents"][0]["source_row"] = value
            with self.subTest(value=value), self.assertRaisesRegex(ValueError, "source_row"):
                Survey(data)


class ServerTests(unittest.TestCase):
    def setUp(self):
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), make_handler(survey=Survey(example())))
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.url = f"http://127.0.0.1:{self.server.server_port}"

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()

    def test_local_endpoints_and_bad_filter(self):
        with urlopen(self.url + "/api/survey/meta") as r:
            self.assertEqual(json.load(r)["total"], 4)
            self.assertEqual(r.headers["Cache-Control"], "no-store")
        with urlopen(self.url + "/api/survey/respondents/alpha") as r:
            self.assertIn("answers", json.load(r))
        with urlopen(self.url + "/api/survey/respondents/alpha?q=evaluation") as r:
            self.assertEqual(json.load(r)["matches"]["why"], [[29, 39]])
        with self.assertRaises(HTTPError) as raised:
            urlopen(self.url + "/api/survey/responses?" + urlencode({"filters": "bad json"}))
        self.assertEqual(raised.exception.code, 400)
        with self.assertRaises(HTTPError) as raised:
            urlopen(self.url + "/api/survey/respondents/unknown")
        self.assertEqual(raised.exception.code, 404)
        with urlopen(self.url + "/api/survey/validate") as r:
            self.assertEqual(json.load(r), {"valid": True})
        invalid = [{"question": "pace", "op": "gte", "value": "10"}]
        with self.assertRaises(HTTPError) as raised:
            urlopen(self.url + "/api/survey/validate?" + urlencode({"filters": json.dumps(invalid)}))
        self.assertEqual(raised.exception.code, 400)

    def test_browser_cross_origin_and_rebound_host_are_rejected(self):
        for headers in ({"Sec-Fetch-Site": "cross-site"}, {"Host": "attacker.example"}):
            with self.subTest(headers=headers), self.assertRaises(HTTPError) as raised:
                urlopen(Request(self.url + "/api/survey/meta", headers=headers))
            self.assertEqual(raised.exception.code, 403)

    def test_default_http_port_accepts_portless_loopback_authorities(self):
        # Advertise port 80 without requiring a privileged or unoccupied socket.
        self.server.server_port = 80
        for host in ("127.0.0.1", "localhost", "127.0.0.1:80", "localhost:80"):
            with self.subTest(host=host), urlopen(Request(self.url + "/api/survey/meta", headers={"Host": host})) as r:
                self.assertEqual(r.status, 200)
        for host in ("attacker.example", "localhost:81", "127.0.0.1.attacker.example"):
            with self.subTest(host=host), self.assertRaises(HTTPError) as raised:
                urlopen(Request(self.url + "/api/survey/meta", headers={"Host": host}))
            self.assertEqual(raised.exception.code, 403)

    def test_nondefault_port_requires_matching_explicit_port(self):
        for host in ("127.0.0.1", "localhost", "localhost:80"):
            with self.subTest(host=host), self.assertRaises(HTTPError) as raised:
                urlopen(Request(self.url + "/api/survey/meta", headers={"Host": host}))
            self.assertEqual(raised.exception.code, 403)

    def test_existing_trajectory_mode(self):
        server = ThreadingHTTPServer(("127.0.0.1", 0), make_handler({}))
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            with urlopen(f"http://127.0.0.1:{server.server_port}/api/records") as r:
                self.assertEqual(json.load(r), {"records": [], "total": 0})
        finally:
            server.shutdown()
            server.server_close()
            thread.join()


if __name__ == "__main__":
    unittest.main()
