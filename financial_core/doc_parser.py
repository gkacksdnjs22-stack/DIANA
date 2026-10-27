"""Paragraph offsets always index the unchanged original Unicode string."""
import re
import unicodedata
from .schemas import document, fields, identifier, loads, require, sha, text


def normalized_with_offsets(raw):
    # Per-codepoint NFKC/casefold: expansion offsets map back to original spans.
    result, offsets = [], []
    for index, char in enumerate(raw):
        part = unicodedata.normalize("NFKC", char).casefold()
        result.extend(part)
        offsets.extend([[index, index + 1]] * len(part))
    return "".join(result), offsets


def normalize(raw):
    return " ".join(normalized_with_offsets(raw)[0].split())


def parse_document(value):
    document(value)
    body = value["content"]
    from .deterministic_tools import deserialize
    obj = deserialize(body, value["format"], optional=True)
    if obj is not None:
        require(obj["classification"] == value["classification"], "CLASSIFICATION_MISMATCH")
        body = obj["body"]
    paragraphs, start = [], 0
    boundaries = list(re.finditer(r"(?:\r?\n)[ \t]*(?:\r?\n)+", body))
    for end, following in [(m.start(), m.end()) for m in boundaries] + [(len(body), len(body))]:
        raw = body[start:end]
        if raw.strip():
            normalized, offsets = normalized_with_offsets(raw)
            paragraphs.append({"para_id": f"p{len(paragraphs)+1:03d}", "start": start, "end": end,
                               "text": raw, "hash": sha(raw), "normalized": normalized,
                               "offsets": offsets})
        start = following
    require(len(paragraphs) <= 1000, "PARAGRAPH_LIMIT")
    return {"document": value, "body": body, "paragraphs": paragraphs, "common_document": obj}


def validate_common(obj):
    fields(obj, ["schema_version", "body", "sources", "unresolved", "classification"])
    require(type(obj["schema_version"]) is int and obj["schema_version"] in (1, 2), "INVALID_SCHEMA")
    text(obj["body"])
    require(type(obj["sources"]) is list and len(obj["sources"]) <= 100, "INVALID_SOURCES")
    for source in obj["sources"]:
        fields(source, ["doc_id", "version", "hash", "para_id", "quote", "display"])
        for key in ("doc_id", "version", "para_id"):
            identifier(source[key])
        require(re.fullmatch(r"p[0-9]{3,4}", source["para_id"]), "INVALID_PARAGRAPH_ID")
        from .schemas import HASH
        require(isinstance(source["hash"], str) and HASH.fullmatch(source["hash"]), "INVALID_HASH")
        text(source["quote"])
        require(source["display"] == f'[{source["doc_id"]}#{source["para_id"]}]', "INVALID_CITATION")
    require(type(obj["unresolved"]) is list and len(obj["unresolved"]) <= 32, "INVALID_UNRESOLVED")
    seen = set()
    for item in obj["unresolved"]:
        fields(item, ["item_id", "status", "reason"] + (["label"] if obj["schema_version"] == 2 else []))
        identifier(item["item_id"])
        require(item["item_id"] not in seen, "DUPLICATE_ITEM")
        seen.add(item["item_id"])
        if obj["schema_version"] == 2:
            text(item["label"], 120)
        require(item["status"] in ("MISSING_NO_EVIDENCE", "NEEDS_CONFIRMATION", "MISSING_WITH_EVIDENCE"), "INVALID_STATUS")
        identifier(item["reason"])
        if obj["schema_version"] == 2:
            expected = {"EXPLICIT_SOURCE_STATEMENT": "MISSING_WITH_EVIDENCE",
                        "REQUEST_SOURCE_OR_MANAGER_CONFIRMATION": "MISSING_NO_EVIDENCE",
                        "CONFLICT_OR_UNSUPPORTED_EXPRESSION": "NEEDS_CONFIRMATION"}
            require(expected.get(item["reason"], item["status"]) == item["status"], "UNRESOLVED_REASON_MISMATCH")
    require(obj["classification"] in ("synthetic", "internal"), "INVALID_CLASSIFICATION")


def parse_guideline(value):
    document(value)
    require(value["format"] == "json", "GUIDELINE_FORMAT")
    obj = loads(value["content"])
    fields(obj, ["id", "version", "rules"])
    require(obj["id"] == value["id"] and obj["version"] == value["version"], "GUIDELINE_ID_MISMATCH")
    rules = obj["rules"]
    require(type(rules) is list and 1 <= len(rules) <= 32, "INVALID_RULES")
    seen = set()
    for rule in rules:
        fields(rule, ["id", "label", "aliases", "required_terms", "condition", "source_ids",
                      "positive_statements", "negative_statements"])
        identifier(rule["id"])
        require(rule["id"] not in seen, "DUPLICATE_ITEM")
        seen.add(rule["id"])
        text(rule["label"], 120)
        require(rule["condition"] in ("all", "any"), "UNSUPPORTED_CONDITION")
        for key in ("aliases", "required_terms", "source_ids", "positive_statements", "negative_statements"):
            require(type(rule[key]) is list and len(rule[key]) <= 24 and
                    (key == "negative_statements" or len(rule[key]) > 0), "INVALID_RULE")
            for term in rule[key]:
                identifier(term) if key == "source_ids" else text(term, 500)
        positives = {normalize(s) for s in rule["positive_statements"]}
        negatives = {normalize(s) for s in rule["negative_statements"]}
        require(not positives & negatives, "CONFLICTING_RULE")
        # A positive expression must itself carry the registered terms. Matching a
        # random affirmative word can never satisfy a rule.
        for statement in positives:
            checks = [normalize(term) in statement for term in rule["required_terms"]]
            require(all(checks) if rule["condition"] == "all" else any(checks), "INVALID_POSITIVE_STATEMENT")
    return obj
