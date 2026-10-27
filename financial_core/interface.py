"""handle(dict) is pure. Only the explicit __main__ transport accesses stdio."""
from .schemas import CoreError, MAX_INPUT, canonical, loads
from .state_planner import plan


def handle(payload):
    try:
        return plan(payload)
    except CoreError as exc:
        return {"schema_version": 1, "status": exc.status, "reason": exc.code,
                "saved": False, "review_complete": False, "attempts": [], "transitions": [exc.status]}
    except (TypeError, KeyError, ValueError, RecursionError, OverflowError):
        return {"schema_version": 1, "status": "CLARIFICATION_REQUIRED", "reason": "INVALID_SCHEMA",
                "saved": False, "review_complete": False, "attempts": []}


def handle_json(raw):
    try:
        return handle(loads(raw))
    except CoreError as exc:
        return {"schema_version": 1, "status": exc.status, "reason": exc.code,
                "saved": False, "review_complete": False, "attempts": []}


if __name__ == "__main__":
    import sys
    try:
        raw = sys.stdin.buffer.read(MAX_INPUT + 1)
        if len(raw) > MAX_INPUT:
            raise CoreError("INPUT_LIMIT")
        response = handle_json(raw.decode("utf-8", errors="strict"))
    except (UnicodeError, CoreError):
        response = {"schema_version": 1, "status": "CLARIFICATION_REQUIRED", "reason": "INVALID_INPUT",
                    "saved": False, "review_complete": False, "attempts": []}
    sys.stdout.buffer.write(canonical(response).encode("utf-8") + b"\n")
