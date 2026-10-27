"""Plan generation has no authority to read files, grant access or declare saving."""
from .doc_parser import parse_document, parse_guideline
from .deterministic_tools import ChecklistVerifier, DiffPatcher, validate_patch
from .schemas import CoreError, canonical, document, fields, identifier, require, sha, text, MAX_INPUT

STATUSES = ("READY", "CLARIFICATION_REQUIRED", "ACTION_REQUIRED", "AWAITING_APPROVAL", "BLOCKED",
            "ABORTED", "CANCELLED", "FAILED", "UNCERTAIN", "COMPLETED")


def binding(doc):
    return {key: doc[key] for key in ("id", "version", "hash", "classification", "format")}


def validated_patch(build, validate):
    """Only repairable internal formatting errors retry; identical errors stop early."""
    attempts, previous = [], None
    for number in range(1, 5):
        try:
            patch = build(number, previous)
            validate(patch)
            attempts.append({"attempt": number, "reason": "VALIDATED"})
            return patch, attempts
        except CoreError as exc:
            attempts.append({"attempt": number, "reason": exc.code})
            if exc.code not in ("INVALID_OUTPUT", "INVALID_QUOTE", "INVALID_PATCH") or exc.code == previous or number == 4:
                return None, attempts
            previous = exc.code
    return None, attempts


def plan(payload):
    fields(payload, ["schema_version", "request_id", "request", "operation", "review_doc", "source_docs", "guideline"])
    require(type(payload["schema_version"]) is int and payload["schema_version"] == 1, "INVALID_SCHEMA")
    identifier(payload["request_id"])
    text(payload["request"], 2000, empty=True)
    require(len(canonical(payload).encode("utf-8")) <= MAX_INPUT * 6, "INPUT_LIMIT")
    op = payload["operation"]
    fields(op, ["action", "target_doc", "item_ids", "format"])
    require(op["action"] in ("checklist_review", "patch", "convert", "export"), "UNKNOWN_OPERATION")
    if op["action"] == "export":
        raise CoreError("EXTERNAL_EXPORT_DENIED", "BLOCKED")
    require(op["format"] in ("md", "txt", "json"), "UNSUPPORTED_FORMAT")
    identifier(op["target_doc"])
    require(type(op["item_ids"]) is list and len(op["item_ids"]) <= 32, "INVALID_ITEMS")
    for item in op["item_ids"]:
        identifier(item)
    require(len(set(op["item_ids"])) == len(op["item_ids"]), "INVALID_ITEMS")
    require(type(payload["source_docs"]) is list and len(payload["source_docs"]) <= 16, "DOCUMENT_LIMIT")
    docs = [payload["review_doc"], *payload["source_docs"], payload["guideline"]]
    for doc in docs:
        document(doc)
    require(sum(len(d["content"].encode("utf-8")) for d in docs) <= MAX_INPUT, "INPUT_LIMIT")
    require(len({d["id"] for d in docs}) == len(docs), "DUPLICATE_DOCUMENT")
    require(op["target_doc"] == payload["review_doc"]["id"], "TARGET_MISMATCH")
    guideline = parse_guideline(payload["guideline"])
    rules = guideline["rules"]
    require(set(op["item_ids"]) <= {r["id"] for r in rules}, "UNKNOWN_ITEM")
    review = parse_document(payload["review_doc"])
    sources = [parse_document(d) for d in payload["source_docs"]]
    if review["common_document"]:
        require({i["item_id"] for i in review["common_document"]["unresolved"]} <= {r["id"] for r in rules},
                "UNRESOLVED_LABEL_REQUIRED", "ACTION_REQUIRED")
    results = [ChecklistVerifier().verify(review, sources, rule) for rule in rules]
    selected = op["item_ids"] if op["action"] == "patch" else []
    already_satisfied = False
    if op["action"] == "patch":
        require(bool(selected), "MISSING_ARGUMENT")
        requested = [item for item in results if item["item_id"] in selected]
        already_satisfied = all(item["status"] == "SATISFIED" for item in requested)
        require(already_satisfied or all(item["status"] == "MISSING_WITH_EVIDENCE" for item in requested),
                "SELECT_EVIDENCED_MISSING_ITEMS", "ACTION_REQUIRED")
    def build_patch(*_):
        patch = DiffPatcher().prepare(review, results, selected, op["format"])
        if any(d["classification"] == "internal" for d in docs):
            from .deterministic_tools import serialize
            patch["common_document"]["classification"] = "internal"
            patch["output_content"] = serialize(patch["common_document"], op["format"])
        return patch

    patch, attempts = validated_patch(build_patch, lambda p: validate_patch(review, p, op["format"], sources))
    if patch is None:
        return {"schema_version": 1, "status": "FAILED", "reason": "PATCH_VALIDATION_FAILED", "attempts": attempts,
                "saved": False, "review_complete": False}
    if already_satisfied:
        status = "READY"
    elif op["action"] == "checklist_review":
        status = "READY" if all(i["status"] == "SATISFIED" for i in results) else "ACTION_REQUIRED"
    else:
        status = "AWAITING_APPROVAL"
    bound = {"review": binding(payload["review_doc"]), "sources": [binding(d) for d in payload["source_docs"]],
             "guideline": binding(payload["guideline"])}
    approval = {"schema_version": 1, "request_id": payload["request_id"], "operation": op,
                "bindings": bound, "items": results, **patch}
    approval["output_hash"] = sha(patch["output_content"])
    canonical_payload = canonical(approval)
    plan_hash = sha(canonical_payload)
    return {"schema_version": 1, "request_id": payload["request_id"], "plan_id": "plan-" + plan_hash,
            "plan_hash": plan_hash, "canonical_payload": canonical_payload, "approval_payload": approval,
            "status": status, "reason": "ALREADY_SATISFIED" if already_satisfied else
            "REVIEW_RESULT" if op["action"] == "checklist_review" else "VALIDATED_PROPOSAL",
            "items": results, **patch, "attempts": attempts, "saved": False,
            "no_change": already_satisfied,
            "review_complete": all(i["status"] == "SATISFIED" for i in results),
            "all_items_addressed": not patch["unresolved"], "inference_mode": "explicit",
            "transitions": ["READY", status]}
