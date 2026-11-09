"""Explicit fixed-template drafting, with no target document or model inference.

This pure planner grants no filesystem/approval authority. User text is never
passed to the evidence verifier. Missing/conflicting evidence stays unresolved.
"""
from .schemas import fields, require, text, identifier, document, canonical, sha, MAX_INPUT
from .doc_parser import parse_document, parse_guideline
from .deterministic_tools import ChecklistVerifier, serialize, deserialize, reference, display_label

TEMPLATE = "review-draft-v1"


def user_display(value):
    # A single labeled paragraph; retain ordinary punctuation, escape Markdown/HTML control.
    return "".join(f"&#{ord(c)};" if c in "&<>\"'\\`*_{}[]()#+|~" else c for c in " ".join(value.split()))


def plan_draft(payload):
    fields(payload, ["schema_version", "request_id", "operation", "user_input", "source_docs", "guideline"])
    require(type(payload["schema_version"]) is int and payload["schema_version"] == 1, "INVALID_SCHEMA")
    identifier(payload["request_id"])
    op = payload["operation"]
    fields(op, ["action", "format", "template_version"])
    require(op == {"action": "draft_review", "format": "md", "template_version": TEMPLATE}, "INVALID_DRAFT_OPERATION")
    user = payload["user_input"]
    fields(user, ["title", "investment", "memo"])
    text(user["title"], 120); text(user["investment"], 300); text(user["memo"], 2000, empty=True)
    require("\n" not in user["title"] and "\r" not in user["title"], "INVALID_TITLE")
    require(type(payload["source_docs"]) is list and len(payload["source_docs"]) <= 16, "DOCUMENT_LIMIT")
    docs = [payload["guideline"], *payload["source_docs"]]
    for doc in docs:
        document(doc)
    require(len({d["id"] for d in docs}) == len(docs), "DUPLICATE_DOCUMENT")
    require(len(canonical(payload).encode()) <= MAX_INPUT, "INPUT_LIMIT")
    guideline = parse_guideline(payload["guideline"])
    sources = [parse_document(d) for d in payload["source_docs"]]
    # A paragraph-free memory view, not a fake existing file or model candidate.
    items = [ChecklistVerifier().verify({"paragraphs": []}, sources, r) for r in guideline["rules"]]
    lines = ["# " + user_display(user["title"]), "", "## 사용자 기본 정보 · 원문 검증 근거 아님", "",
             "투자 대상: " + user_display(user["investment"]), "",
             "사용자 메모: " + user_display(user["memo"] or "없음"), "",
             "## 지침 항목별 검토 초안", ""]
    refs, unresolved = [], []
    for item in items:
        lines += ["### " + item["item_id"] + " · " + display_label(item["label"], "md"), ""]
        if item["status"] == "MISSING_WITH_EVIDENCE":
            ref = item["evidence"][0]
            require(any(ref == reference(s, p) for s in sources for p in s["paragraphs"]), "INVALID_QUOTE")
            lines += ["등록된 근거 원문 인용 · 금융적 적합성의 포괄적 판단 아님", "", ref["quote"], "",
                      "출처: " + ref["display"] + " · 버전 " + ref["version"], ""]
            if ref not in refs:
                refs.append(ref)
        else:
            unresolved.append({k: item[k] for k in ("item_id", "label", "status", "reason")})
            lines += ["추가 확인 필요 · " + ("부정·상충·조건 또는 지원 밖 표현" if item["status"] == "NEEDS_CONFIRMATION" else "제공 자료에 확인된 근거 없음"), ""]
    lines += ["작성 양식: " + TEMPLATE, "지침: " + payload["guideline"]["id"] + " · 버전 " + payload["guideline"]["version"],
              "정해진 양식의 초안입니다. 투자 의견·법적 판단·자유 요약을 생성하지 않았습니다."]
    common = {"schema_version": 2, "body": "\n".join(lines) + "\n", "sources": refs, "unresolved": unresolved,
              "classification": "internal" if any(d["classification"] == "internal" for d in docs) else "synthetic"}
    output = serialize(common, "md")
    require(deserialize(output, "md") == common, "INVALID_OUTPUT")
    approval = {"schema_version": 1, "request_id": payload["request_id"], "operation": op, "user_input": user,
                "bindings": {"guideline": {k: payload["guideline"][k] for k in ("id", "version", "hash", "classification", "format")},
                             "sources": [{k: d[k] for k in ("id", "version", "hash", "classification", "format")} for d in payload["source_docs"]]},
                "items": items, "common_document": common, "output_content": output, "output_hash": sha(output)}
    raw = canonical(approval); digest = sha(raw)
    return {"schema_version": 1, "request_id": payload["request_id"], "plan_id": "plan-" + digest, "plan_hash": digest,
            "canonical_payload": raw, "approval_payload": approval, "status": "AWAITING_APPROVAL", "reason": "VALIDATED_DRAFT",
            "items": items, "common_document": common, "expected_body": common["body"], "output_content": output,
            "unresolved": unresolved, "saved": False, "review_complete": False, "all_items_addressed": not unresolved,
            "inference_mode": "explicit_draft", "template_version": TEMPLATE}
