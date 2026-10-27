"""Literal registered statements only; search scores are never a verdict."""
import difflib
import re
from .doc_parser import normalize, validate_common
from .schemas import CoreError, canonical, fields, require, sha, HASH


def reference(parsed, para):
    doc = parsed["document"]
    return {"doc_id": doc["id"], "version": doc["version"], "hash": doc["hash"],
            "para_id": para["para_id"], "quote": para["text"],
            "display": f'[{doc["id"]}#{para["para_id"]}]'}


def relevant(raw, rule):
    normalized = normalize(raw)
    return any(normalize(term) in normalized for term in rule["aliases"] + [rule["label"]]) or \
        any(normalize(term) in normalized for term in rule["required_terms"])


class EvidenceSearcher:
    def search(self, documents, rule):
        candidates = []
        for parsed in documents:
            if parsed["document"]["id"] not in rule["source_ids"]:
                continue
            for para in parsed["paragraphs"]:
                if relevant(para["text"], rule):
                    score = sum(normalize(t) in normalize(para["text"]) for t in rule["required_terms"])
                    candidates.append({"reference": reference(parsed, para), "score": score})
        return sorted(candidates, key=lambda p: (-p["score"], p["reference"]["doc_id"], p["reference"]["para_id"]))


def statement_states(raw, rule):
    positive = {normalize(s).rstrip(".!?。") for s in rule["positive_statements"]}
    negative = {normalize(s).rstrip(".!?。") for s in rule["negative_statements"]}
    states = []
    # Fixed separators, no rule-controlled regex or eval. Whole sentences only.
    for sentence in re.split(r"[.!?。\r\n]+", raw):
        if not sentence.strip() or not relevant(sentence, rule):
            continue
        normalized = normalize(sentence)
        states.append("positive" if normalized in positive else "negative" if normalized in negative else "unknown")
    return states or ["unknown"]


class ChecklistVerifier:
    def verify(self, review, sources, rule):
        review_refs = [reference(review, para) for para in review["paragraphs"] if relevant(para["text"], rule)]
        candidates = EvidenceSearcher().search(sources, rule)
        source_refs = [item["reference"] for item in candidates]
        states = [state for ref in review_refs + source_refs for state in statement_states(ref["quote"], rule)]
        if "negative" in states or "unknown" in states:
            status, reason = "NEEDS_CONFIRMATION", "CONFLICT_OR_UNSUPPORTED_EXPRESSION"
        elif review_refs:
            status, reason = "SATISFIED", "EXPLICIT_REVIEW_STATEMENT"
        elif source_refs:
            status, reason = "MISSING_WITH_EVIDENCE", "EXPLICIT_SOURCE_STATEMENT"
        else:
            status, reason = "MISSING_NO_EVIDENCE", "REQUEST_SOURCE_OR_MANAGER_CONFIRMATION"
        return {"item_id": rule["id"], "label": rule["label"], "status": status, "reason": reason,
                "review_references": review_refs, "evidence": source_refs, "candidates": candidates}


NOTICE_START = {"md": "<!-- DIANA-STATUS-V1 -->", "txt": "[DIANA-STATUS-V1]"}
NOTICE_END = {"md": "<!-- /DIANA-STATUS-V1 -->", "txt": "[/DIANA-STATUS-V1]"}
STATUS_TEXT = {
    "MISSING_WITH_EVIDENCE": ("근거는 확인했지만 아직 보완하지 않은 항목", "근거와 수정안을 검토한 뒤 별도 보완·승인 필요"),
    "MISSING_NO_EVIDENCE": ("제공 자료에서 근거를 확인하지 못함", "추가 자료 확보 또는 운용사 확인 필요"),
    "NEEDS_CONFIRMATION": ("부정·상충·지원 범위 밖 표현 등으로 추가 확인 필요", "관련 원문·상충 내용 및 적용 조건의 추가 확인 필요"),
}
REASON_TEXT = {
    "EXPLICIT_SOURCE_STATEMENT": "제공 근거에서 등록된 명시적 문장을 확인함",
    "REQUEST_SOURCE_OR_MANAGER_CONFIRMATION": "제공 자료 범위에서 등록된 근거 문장을 찾지 못함",
    "CONFLICT_OR_UNSUPPORTED_EXPRESSION": "부정·상충 또는 지원 범위 밖 표현이 포함됨",
}


def contains_notice_boundary(content, fmt):
    return any(re.search(r"(?:\A|\n)" + re.escape(marker) + r"(?:\n|\Z)", content)
               for marker in (NOTICE_START[fmt], NOTICE_END[fmt]))


def display_label(label, fmt):
    # Preserve the actual guideline label in metadata; the view is a single line.
    label = " ".join(label.split())
    if fmt == "md":
        return "".join(f"&#{ord(c)};" if c in "&<>\"'\\`*_{}[]()#+-.!|~" else c for c in label)
    return label


def render_notice(common, fmt):
    """A deterministic view of unresolved, never part of common.body/evidence."""
    if common["schema_version"] == 1 or not common["unresolved"] or fmt == "json":
        return ""
    lines = [NOTICE_START[fmt], "", "## 추가 확인 필요 항목" if fmt == "md" else "추가 확인 필요 항목", "",
             "DIANA 시스템 상태 표시입니다. 업무 원문이나 실사 근거가 아닙니다.", ""]
    for item in common["unresolved"]:
        status, action = STATUS_TEXT[item["status"]]
        reason = REASON_TEXT.get(item["reason"], f'사유 코드: {item["reason"]}')
        lines.extend([f'- {display_label(item["label"], fmt)} ({item["item_id"]})',
                      f"  - 상태: {status}", f"  - 사유: {reason}", f"  - 다음 조치: {action}", ""])
    lines.extend(["파일 저장 완료와 실사 검토 완료는 별개입니다.", "", NOTICE_END[fmt]])
    return "\n\n" + "\n".join(lines)


def serialize(common, fmt):
    validate_common(common)
    require(fmt in ("md", "txt", "json"), "UNSUPPORTED_FORMAT")
    if fmt == "json":
        return canonical(common) + "\n"
    version = common["schema_version"]
    marker = f"\n\n<!-- DIANA-COMMON-V{version} " if fmt == "md" else f"\n\n[DIANA-COMMON-V{version} "
    ending = " -->\n" if fmt == "md" else "]\n"
    metadata = {key: value for key, value in common.items() if key != "body"}
    notice = render_notice(common, fmt)
    if version == 2:
        metadata["presentation"] = {"version": 1, "body_length": len(common["body"]),
                                    "body_hash": sha(common["body"]), "notice_hash": sha(notice)}
    encoded_metadata = canonical(metadata)
    if version == 2 and fmt == "md":
        # Labels/quotes inside an HTML comment must not close that comment.
        encoded_metadata = encoded_metadata.replace("<", "\\u003c").replace(">", "\\u003e").replace("&", "\\u0026")
    return common["body"] + notice + marker + encoded_metadata + ending


def deserialize(content, fmt, optional=False):
    from .schemas import loads
    if fmt == "json":
        result = loads(content)
    else:
        require(fmt in ("md", "txt"), "UNSUPPORTED_FORMAT")
        prefix = "\n\n<!-- DIANA-COMMON-V" if fmt == "md" else "\n\n[DIANA-COMMON-V"
        ending = " -->\n" if fmt == "md" else "]\n"
        # Incidental mentions, similar markers and user-authored headings are
        # ordinary body text. Exact reserved envelope declarations fail closed.
        matches = list(re.finditer(re.escape(prefix) + r"([0-9]+) ", content))
        if not matches:
            require(not contains_notice_boundary(content, fmt), "NOTICE_METADATA_REQUIRED", "ACTION_REQUIRED")
            if optional:
                return None
            raise CoreError("INVALID_OUTPUT", "FAILED")
        match = matches[-1]
        version = int(match.group(1))
        require(version in (1, 2) and content.endswith(ending), "INVALID_DOCUMENT_ENVELOPE")
        result = loads(content[match.end():-len(ending)])
        require(type(result) is dict and "body" not in result and result.get("schema_version") == version,
                "INVALID_DOCUMENT_ENVELOPE")
        prefix_content = content[:match.start()]
        if version == 1:
            require(not contains_notice_boundary(prefix_content, fmt), "NOTICE_METADATA_MISMATCH", "ACTION_REQUIRED")
            result["body"] = prefix_content
        else:
            presentation = result.pop("presentation", None)
            fields(presentation, ["version", "body_length", "body_hash", "notice_hash"])
            length = presentation["body_length"]
            require(type(presentation["version"]) is int and presentation["version"] == 1 and
                    type(length) is int and 0 <= length <= len(prefix_content) and
                    all(isinstance(presentation[k], str) and HASH.fullmatch(presentation[k])
                        for k in ("body_hash", "notice_hash")), "INVALID_DOCUMENT_ENVELOPE")
            result["body"] = prefix_content[:length]
            validate_common(result)
            notice = prefix_content[length:]
            # Markers alone never authorize removing text. Only this exact,
            # metadata-bound deterministic suffix is excluded from business body.
            require(sha(result["body"]) == presentation["body_hash"] and
                    sha(notice) == presentation["notice_hash"] and notice == render_notice(result, fmt),
                    "NOTICE_METADATA_MISMATCH", "ACTION_REQUIRED")
    validate_common(result)
    return result


def unified_diff(before, after):
    lines = difflib.unified_diff(before.splitlines(keepends=True), after.splitlines(keepends=True),
                                fromfile="base", tofile="proposed")
    return "".join(line if line.endswith("\n") else line + "\n\\ No newline at end of file\n" for line in lines)


class DiffPatcher:
    def prepare(self, review, results, selected, fmt):
        source_common = review["common_document"]
        body = source_common["body"] if source_common else review["body"]
        changes, sources = [], list(source_common["sources"]) if source_common else []
        for item in results:
            if item["item_id"] not in selected or item["status"] != "MISSING_WITH_EVIDENCE":
                continue
            ref = item["evidence"][0]
            # Quotes stay byte-for-byte within the appended section. No blockquote
            # prefixes/newline normalization are inserted into source paragraphs.
            addition = f'\n\n## 보완 {item["item_id"]}\n\n{ref["quote"]}\n\n출처: {ref["display"]}\n'
            changes.append({"kind": "append", "item_id": item["item_id"], "offset": len(body),
                            "base_hash": review["document"]["hash"], "text": addition, "source": ref})
            body += addition
            if ref not in sources:
                sources.append(ref)
        unresolved = [{key: item[key] for key in ("item_id", "label", "status", "reason")} for item in results
                      if item["status"] not in ("SATISFIED",) and
                      not (item["item_id"] in selected and item["status"] == "MISSING_WITH_EVIDENCE")]
        # Stored status is historical data, not the answer to this review.
        # Recompute from current business paragraphs, allowed evidence and rules.
        labels = {item["item_id"]: item["label"] for item in results}
        for item in unresolved:
            require(item["item_id"] in labels, "UNRESOLVED_LABEL_REQUIRED", "ACTION_REQUIRED")
        unresolved = [{**item, "label": labels[item["item_id"]]} for item in unresolved]
        common = {"schema_version": 2, "body": body, "sources": sources, "unresolved": unresolved,
                  "classification": review["document"]["classification"]}
        output = serialize(common, fmt)
        return {"changes": changes, "common_document": common, "output_content": output,
                "expected_body": body, "unified_diff": unified_diff(source_common["body"] if source_common else review["body"], body),
                "retained_items": [i["item_id"] for i in results if i["status"] == "SATISFIED"],
                "unresolved": unresolved}


def validate_patch(review, patch, fmt, sources=()):
    require(sha(review["document"]["content"]) == review["document"]["hash"], "CONTENT_CHANGED", "ABORTED")
    body = patch["expected_body"]
    original = review["body"]
    for change in patch["changes"]:
        require(change["offset"] == len(original) and change["base_hash"] == review["document"]["hash"], "INVALID_PATCH", "FAILED")
        ref = change["source"]
        require(change["text"] == f'\n\n## 보완 {change["item_id"]}\n\n{ref["quote"]}\n\n출처: {ref["display"]}\n', "INVALID_QUOTE", "FAILED")
        require(any(ref == reference(doc, para) for doc in sources for para in doc["paragraphs"]), "INVALID_QUOTE", "FAILED")
        original += change["text"]
    require(original == body, "INVALID_PATCH", "FAILED")
    require(patch["common_document"]["body"] == body, "INVALID_PATCH", "FAILED")
    require(deserialize(patch["output_content"], fmt) == patch["common_document"], "INVALID_OUTPUT", "FAILED")
