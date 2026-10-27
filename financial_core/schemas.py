"""Strict data boundary shared by the callable core and stdio wrapper."""
import hashlib
import json
import re

MAX_INPUT = 2_000_000
MAX_CONTENT = 262_144
ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9_-]{0,63}\Z")
HASH = re.compile(r"[a-f0-9]{64}\Z")


class CoreError(ValueError):
    def __init__(self, code, status="CLARIFICATION_REQUIRED"):
        super().__init__(code)
        self.code, self.status = code, status


def require(value, code="INVALID_SCHEMA", status="CLARIFICATION_REQUIRED"):
    if not value:
        raise CoreError(code, status)


def text(value, maximum=MAX_CONTENT, empty=False):
    require(isinstance(value, str) and (empty or bool(value.strip())) and len(value) <= maximum,
            "INVALID_TEXT")
    require(not any((ord(c) < 32 and c not in "\t\n\r") or ord(c) == 127 or
                    0xD800 <= ord(c) <= 0xDFFF for c in value), "INVALID_TEXT")
    return value


def identifier(value):
    require(isinstance(value, str) and ID.fullmatch(value), "INVALID_ID")
    return value


def fields(value, keys, required=None):
    require(type(value) is dict and set(value) <= set(keys), "UNKNOWN_FIELD")
    require(set(keys if required is None else required) <= set(value), "MISSING_ARGUMENT")


def sha(value):
    return hashlib.sha256(value.encode("utf-8") if isinstance(value, str) else value).hexdigest()


def canonical(value):
    # ASCII escaping, lexicographically sorted keys, no whitespace, no floats in plans.
    return json.dumps(value, ensure_ascii=True, sort_keys=True, separators=(",", ":"), allow_nan=False)


def loads(raw):
    text(raw, MAX_INPUT)
    require(len(raw.encode("utf-8")) <= MAX_INPUT, "INPUT_LIMIT")

    def pairs(items):
        result = {}
        for key, value in items:
            require(key not in result, "DUPLICATE_KEY")
            result[key] = value
        return result

    def constant(_):
        raise CoreError("INVALID_NUMBER")

    try:
        return json.loads(raw, object_pairs_hook=pairs, parse_constant=constant)
    except (ValueError, RecursionError) as exc:
        if isinstance(exc, CoreError):
            raise
        raise CoreError("INVALID_JSON") from None


def document(value):
    fields(value, ["id", "version", "content", "hash", "format", "classification"])
    identifier(value["id"])
    identifier(value["version"])
    text(value["content"])
    require(len(value["content"].encode("utf-8")) <= MAX_CONTENT, "DOCUMENT_LIMIT")
    require(value["format"] in ("txt", "md", "json"), "UNSUPPORTED_FORMAT")
    require(value["classification"] in ("synthetic", "internal"), "INVALID_CLASSIFICATION")
    require(isinstance(value["hash"], str) and HASH.fullmatch(value["hash"]), "INVALID_HASH")
    require(sha(value["content"]) == value["hash"], "CONTENT_CHANGED", "ABORTED")
    return value
