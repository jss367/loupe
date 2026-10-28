"""Dataset-independent survey inspection, with no third-party dependencies."""

import json
from decimal import Decimal, InvalidOperation
from pathlib import Path


def number(value):
    """Parse an original numeric entry, without silently repairing its value."""
    try:
        result = Decimal(str(value).strip())
        return result if result.is_finite() else None
    except (InvalidOperation, TypeError, ValueError):
        return None


def match_spans(text, query):
    """Case-folded matches as original-text UTF-16 offsets for the browser."""
    needle = query.strip().casefold()
    if not needle:
        return []
    folded, starts, ends = [], [], []
    offset = 0
    for char in text:
        part = char.casefold()
        end = offset + (2 if ord(char) > 0xFFFF else 1)
        folded.append(part)
        starts.extend([offset] * len(part))
        ends.extend([end] * len(part))
        offset = end
    folded = "".join(folded)
    matches, position = [], 0
    while (position := folded.find(needle, position)) >= 0:
        start, end = starts[position], ends[position + len(needle) - 1]
        if matches and start < matches[-1][1]:
            matches[-1][1] = max(matches[-1][1], end)
        else:
            matches.append([start, end])
        position += len(needle)
    return matches


class Survey:
    def __init__(self, dataset):
        if not isinstance(dataset, dict):
            raise ValueError("Expected a survey JSON object")
        if dataset.get("schema") != "loupe.survey.v1":
            raise ValueError("Expected a loupe.survey.v1 dataset")
        if not isinstance(dataset.get("id"), str) or not dataset["id"]:
            raise ValueError("Dataset needs a stable ID")
        self.dataset = dataset
        self.questions = {}
        self.respondents = {}
        for q in dataset["questions"]:
            ident = q["id"]
            if not isinstance(ident, str) or not ident or ident in self.questions:
                raise ValueError("Question IDs must be unique nonempty strings")
            if q["kind"] not in {"text", "number", "category"} or not isinstance(q["wording"], str):
                raise ValueError("Invalid question definition")
            if q["kind"] == "category" and (
                    not isinstance(q.get("options"), list) or
                    any(not isinstance(option, str) for option in q["options"])):
                raise ValueError("Category options must be an array of strings")
            if any(not isinstance(q.get(k), str) for k in ("section", "variable", "raw_variable")):
                raise ValueError("Questions need section and variable provenance")
            if type(q.get("occurrence")) is not int or q["occurrence"] < 1:
                raise ValueError("Question occurrences must be positive integers")
            self.questions[ident] = q
        category_options = {q["id"]: set(q["options"]) for q in self.questions.values()
                            if q["kind"] == "category"}
        for r in dataset["respondents"]:
            ident = r["id"]
            if not isinstance(ident, str) or not ident or ident in self.respondents:
                raise ValueError("Respondent IDs must be unique nonempty strings")
            if type(r.get("source_row")) is not int or r["source_row"] < 1:
                raise ValueError("Respondents need a positive integer source_row")
            if not isinstance(r["retained"], bool) or not isinstance(r["finished"], bool):
                raise ValueError("Sample membership and completion must be boolean")
            if not isinstance(r["answers"], dict) or any(
                    q not in self.questions or not isinstance(v, str) or not v.strip()
                    for q, v in r["answers"].items()):
                raise ValueError("Answers must be nonempty strings referencing known questions")
            if any(q in category_options and value not in category_options[q]
                   for q, value in r["answers"].items()):
                raise ValueError("Category options must cover every observed category answer")
            self.respondents[ident] = r

    @classmethod
    def load(cls, path):
        return cls(json.loads(Path(path).read_text(encoding="utf-8")))

    def meta(self):
        return {**{k: self.dataset.get(k) for k in ("id", "title", "description", "source", "schema")},
                "questions": list(self.questions.values()),
                "total": len(self.respondents),
                "retained": sum(r["retained"] for r in self.respondents.values())}

    def query(self, params, validate_only=False):
        def get(key, default=""):
            return params.get(key, [default])[0]

        sample, completion = get("sample", "retained"), get("completion", "any")
        if sample not in {"all", "retained", "excluded"} or completion not in {"any", "finished", "incomplete"}:
            raise ValueError("Invalid sample or completion filter")
        questions, search = set(params.get("question", [])) - {""}, get("q").strip().casefold()
        if any(q not in self.questions or self.questions[q]["kind"] != "text" for q in questions):
            raise ValueError("Select free-response questions")
        try:
            filters = json.loads(get("filters", "[]"))
        except (ValueError, TypeError) as exc:
            raise ValueError("Invalid structured filters") from exc
        if not isinstance(filters, list) or len(filters) > 20:
            raise ValueError("Expected at most 20 structured filters")
        for f in filters:
            if not isinstance(f, dict) or f.get("question") not in self.questions:
                raise ValueError("Unknown structured question")
            kind, op = self.questions[f["question"]]["kind"], f.get("op")
            if kind == "text" or op not in {"eq", "gte", "lte", "present", "missing"}:
                raise ValueError("Invalid structured filter operation")
            if (op in {"gte", "lte"} or (op == "eq" and kind == "number")) and (
                    kind != "number" or number(f.get("value")) is None):
                raise ValueError("Numeric filters require a finite numerical value")
            if op == "eq" and not isinstance(f.get("value"), str):
                raise ValueError("Equality filters require a string value")

        if validate_only:
            return {"valid": True}

        def matches(r):
            if sample != "all" and r["retained"] != (sample == "retained"):
                return False
            if completion != "any" and r["finished"] != (completion == "finished"):
                return False
            for f in filters:
                value, op = r["answers"].get(f["question"]), f["op"]
                if op == "missing":
                    if value is not None:
                        return False
                elif value is None:
                    return False
                elif op in {"gte", "lte"} or (op == "eq" and self.questions[f["question"]]["kind"] == "number"):
                    parsed, bound = number(value), number(f["value"])
                    if parsed is None or (op == "gte" and parsed < bound) or (op == "lte" and parsed > bound) or (op == "eq" and parsed != bound):
                        return False
                elif op == "eq" and value != f["value"]:
                    return False
            return True

        cohort = [r for r in self.respondents.values() if matches(r)]
        records, authors = [], set()
        for r in cohort:
            for q, text in r["answers"].items():
                if self.questions[q]["kind"] != "text" or (questions and q not in questions):
                    continue
                authors.add(r["id"])
                if search and search not in text.casefold():
                    continue
                records.append({"id": json.dumps([r["id"], q], ensure_ascii=False, separators=(",", ":")),
                                "respondent_id": r["id"], "question_id": q,
                                "text": text, "matches": match_spans(text, search),
                                "retained": r["retained"], "finished": r["finished"]})
        return {"records": records, "cohort_respondents": len(cohort),
                "text_respondents": len(authors),
                "matched_respondents": len({r["respondent_id"] for r in records})}
