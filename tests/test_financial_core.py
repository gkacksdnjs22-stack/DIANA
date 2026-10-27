"""Pure function tests: synthetic strings only, no document filesystem access."""
import copy
import json
import unittest
from unittest.mock import patch

from financial_core.interface import handle, handle_json
from financial_core.doc_parser import parse_document, normalized_with_offsets
from financial_core.deterministic_tools import deserialize, serialize, validate_patch, render_notice, EvidenceSearcher
from financial_core.schemas import CoreError, canonical, sha
from financial_core.state_planner import validated_patch


def doc(id, content, fmt="txt", classification="synthetic"):
    return {"id": id, "version": "1", "content": content, "hash": sha(content), "format": fmt,
            "classification": classification}


def fixture(action="checklist_review", selected=None, fmt="md"):
    statements = ["Currency exposure and hedge plan are registered", "Key departure suspends investment",
                  "LPAC participation right exists"]
    rules = [{"id": id, "label": alias, "aliases": [alias], "required_terms": terms, "condition": "all",
              "source_ids": ["S9"], "positive_statements": [positive], "negative_statements": [negative]}
             for id, alias, terms, positive, negative in [
                 ("FX9", "Currency exposure", ["exposure", "hedge"], statements[0], "Currency exposure and hedge plan are absent"),
                 ("KM9", "Key departure", ["departure", "investment"], statements[1], "Key departure does not suspend investment"),
                 ("LP9", "LPAC", ["participation"], statements[2], "LPAC participation right does not exist")]]
    guideline = {"id": "G9", "version": "1", "rules": rules}
    return {"schema_version": 1, "request_id": "req9", "request": "",
            "operation": {"action": action, "target_doc": "R9", "item_ids": selected or [], "format": fmt},
            "review_doc": doc("R9", "# Synthetic review\r\n\r\n" + statements[0] + ".\r\n"),
            "source_docs": [doc("S9", "Synthetic material\n\n" + statements[1] + ".")],
            "guideline": doc("G9", canonical(guideline), "json")}


def change_doc(payload, key, content):
    payload[key]["content"] = content
    payload[key]["hash"] = sha(content)


class FinancialCoreTests(unittest.TestCase):
    def test_ellipsis_normalization_cannot_turn_registered_negation_positive(self):
        positive = "LPAC participation right exists."
        for punctuation in ("…", "‥", "...", "．．．", "︙"):
            negative = "LPAC participation right exists" + punctuation + " if manager agrees."
            for wrapper in ("{}", "Unrelated sentence. {}", "{} Additional unrelated sentence."):
                with self.subTest(punctuation=punctuation, wrapper=wrapper):
                    payload = fixture()
                    guide = json.loads(payload["guideline"]["content"])
                    guide["rules"] = [guide["rules"][2]]
                    guide["rules"][0]["positive_statements"] = [positive]
                    guide["rules"][0]["negative_statements"] = [negative]
                    change_doc(payload, "guideline", canonical(guide))
                    content = wrapper.format(negative)
                    change_doc(payload, "review_doc", content)
                    payload["source_docs"] = [doc("S9", "Unrelated material.")]
                    result = handle(payload)
                    self.assertEqual(result["items"][0]["status"], "NEEDS_CONFIRMATION")
                    self.assertFalse(result["review_complete"])
                    self.assertEqual(result["items"][0]["review_references"][0]["quote"], content)
                    change_doc(payload, "review_doc", positive)
                    self.assertTrue(handle(payload)["review_complete"])

    def test_decimal_negative_statement_cannot_match_its_positive_prefix(self):
        for value in ("1.5", "1.50", "1.005", ".5", "-1.5", "１．５", "1.⁵"):
            for suffix in ("", " Additional unrelated sentence."):
                with self.subTest(value=value, suffix=suffix):
                    payload = fixture()
                    positive = "Management fee in percent: 1."
                    negative = "Management fee in percent: " + value + "."
                    guide = json.loads(payload["guideline"]["content"])
                    guide["rules"] = [{"id": "FEE", "label": "Management fee", "aliases": ["Management fee"],
                        "required_terms": ["Management", "fee"], "condition": "all", "source_ids": ["S9"],
                        "positive_statements": [positive], "negative_statements": [negative]}]
                    change_doc(payload, "guideline", canonical(guide))
                    change_doc(payload, "review_doc", negative + suffix)
                    payload["source_docs"] = [doc("S9", "Unrelated material.")]
                    result = handle(payload)
                    self.assertEqual(result["items"][0]["status"], "NEEDS_CONFIRMATION")
                    self.assertFalse(result["review_complete"])
                    self.assertEqual(result["items"][0]["review_references"][0]["quote"], negative + suffix)
                    change_doc(payload, "review_doc", positive)
                    result = handle(payload)
                    self.assertEqual(result["items"][0]["status"], "SATISFIED")
                    self.assertTrue(result["review_complete"])

    def test_review_and_selected_patch(self):
        payload = fixture()
        result = handle(payload)
        self.assertEqual(result["status"], "ACTION_REQUIRED")
        self.assertEqual([i["status"] for i in result["items"]], ["SATISFIED", "MISSING_WITH_EVIDENCE", "MISSING_NO_EVIDENCE"])
        self.assertFalse(result["saved"])
        self.assertFalse(result["review_complete"])
        payload["operation"].update(action="patch", item_ids=["KM9"])
        result = handle(payload)
        self.assertEqual(result["status"], "AWAITING_APPROVAL")
        self.assertTrue(result["expected_body"].startswith(payload["review_doc"]["content"]))
        ref = result["changes"][0]["source"]
        self.assertEqual(ref["quote"], "Key departure suspends investment.")
        self.assertIn(ref["quote"], result["output_content"])
        self.assertEqual(ref["display"], "[S9#p002]")
        self.assertEqual(ref["hash"], payload["source_docs"][0]["hash"])
        self.assertEqual(result["retained_items"], ["FX9"])
        self.assertEqual([i["item_id"] for i in result["unresolved"]], ["LP9"])
        self.assertNotIn("LPAC participation right exists", result["expected_body"])
        self.assertEqual(result["plan_hash"], sha(result["canonical_payload"]))
        self.assertEqual(json.loads(result["canonical_payload"]), result["approval_payload"])
        self.assertEqual(handle(payload), result)

    def test_negation_conditional_unknown_and_conflict(self):
        for statement in ["LPAC participation right does not exist", "LPAC participation right exists if manager agrees",
                          "LPAC participation right exists. LPAC participation right does not exist",
                          "The notes say 'LPAC participation right exists' but it is unconfirmed",
                          "LPAC participation: unknown"]:
            with self.subTest(statement=statement):
                payload = fixture()
                change_doc(payload, "review_doc", statement)
                self.assertEqual(handle(payload)["items"][2]["status"], "NEEDS_CONFIRMATION")
        payload = fixture()
        change_doc(payload, "review_doc", "LPAC participation right exists.")
        payload["source_docs"] = [doc("S9", "LPAC participation right does not exist.")]
        self.assertEqual(handle(payload)["items"][2]["status"], "NEEDS_CONFIRMATION")

    def test_schema_failures_are_not_retried(self):
        for raw, code in [('{"a":1,"a":2}', "DUPLICATE_KEY"), ('{"a":NaN}', "INVALID_NUMBER"),
                          ('{"a":Infinity}', "INVALID_NUMBER"), ('{oops', "INVALID_JSON")]:
            result = handle_json(raw)
            self.assertEqual(result["reason"], code)
            self.assertEqual(result["attempts"], [])
        for mutate in [lambda p: p["operation"].update(action="run_code"),
                       lambda p: p["review_doc"].update(id="R9]#p001\n"),
                       lambda p: p.update(auth={"role": "admin"}),
                       lambda p: p["operation"].update(format="docx"),
                       lambda p: p["operation"].update(item_ids=["UNKNOWN"]),
                       lambda p: p["review_doc"].update(content=123),
                       lambda p: p["source_docs"].extend(p["source_docs"] * 17)]:
            payload = fixture(); mutate(payload)
            result = handle(payload)
            self.assertEqual(result["status"], "CLARIFICATION_REQUIRED")
            self.assertEqual(result["attempts"], [])
        payload = fixture(); guide = json.loads(payload["guideline"]["content"])
        guide["rules"][0]["condition"] = "eval"
        change_doc(payload, "guideline", canonical(guide))
        self.assertEqual(handle(payload)["reason"], "UNSUPPORTED_CONDITION")

    def test_hash_mismatch_and_changed_bindings(self):
        payload = fixture("patch", ["KM9"]); original = handle(payload)
        for key in ["review_doc", "guideline"]:
            modified = copy.deepcopy(payload); modified[key]["content"] += " "
            self.assertEqual(handle(modified)["status"], "ABORTED")
            modified[key]["hash"] = sha(modified[key]["content"])
            self.assertNotEqual(handle(modified)["plan_hash"], original["plan_hash"])
        modified = copy.deepcopy(payload); modified["source_docs"][0]["version"] = "2"
        self.assertNotEqual(handle(modified)["plan_hash"], original["plan_hash"])

    def test_roundtrip_all_formats_preserves_metadata(self):
        result = handle(fixture("patch", ["KM9"]))
        common = result["common_document"]
        for fmt in ("txt", "md", "json"):
            rendered = serialize(common, fmt)
            self.assertEqual(deserialize(rendered, fmt), common)
            payload = fixture("convert", fmt=fmt)
            payload["review_doc"] = doc("R9", rendered, fmt)
            converted = handle(payload)
            self.assertEqual(converted["status"], "AWAITING_APPROVAL")
            self.assertEqual(converted["common_document"]["body"], common["body"])
            self.assertEqual(converted["common_document"]["sources"], common["sources"])
            self.assertTrue(converted["unresolved"])

    def test_paragraph_offsets_and_original_newlines(self):
        raw = "표제\r\n\r\nＡＢＣ\tQuoted 원문\r\n다음 줄\r\n\r\n끝"
        parsed = parse_document(doc("X", raw))
        for para in parsed["paragraphs"]:
            self.assertEqual(raw[para["start"]:para["end"]], para["text"])
            self.assertEqual(sha(para["text"]), para["hash"])
        normalized, offsets = normalized_with_offsets("Ａß")
        self.assertEqual(normalized, "ass")
        self.assertEqual(offsets, [[0, 1], [1, 2], [1, 2]])

    def test_no_evidence_cannot_be_patched_and_scope_matters(self):
        self.assertEqual(handle(fixture("patch", ["LP9"]))["status"], "ACTION_REQUIRED")
        payload = fixture(); payload["source_docs"][0]["id"] = "UNREGISTERED"
        self.assertEqual(handle(payload)["items"][1]["status"], "MISSING_NO_EVIDENCE")
        payload["operation"]["action"] = "export"
        self.assertEqual(handle(payload)["status"], "BLOCKED")

    def test_retries_bounded_and_identical_error_stops(self):
        def invalid(_): raise CoreError("INVALID_OUTPUT", "FAILED")
        result, attempts = validated_patch(lambda *_: {}, invalid)
        self.assertIsNone(result); self.assertEqual(len(attempts), 2)
        reasons = iter(["INVALID_OUTPUT", "INVALID_QUOTE", "INVALID_PATCH", "INVALID_OUTPUT"])
        def changing(_): raise CoreError(next(reasons), "FAILED")
        self.assertEqual(len(validated_patch(lambda *_: {}, changing)[1]), 4)
        def denied(_): raise CoreError("CONTENT_CHANGED", "ABORTED")
        self.assertEqual(len(validated_patch(lambda *_: {}, denied)[1]), 1)
        def repairable(number, previous):
            self.assertEqual(previous, None if number == 1 else "INVALID_OUTPUT")
            return {"valid": number == 2}
        def validate(value):
            if not value["valid"]: raise CoreError("INVALID_OUTPUT", "FAILED")
        self.assertEqual(len(validated_patch(repairable, validate)[1]), 2)

    def test_function_core_no_io_env_network_or_process(self):
        import os, socket, subprocess, builtins
        def denied(*_args, **_kwargs): raise AssertionError("side effect")
        with patch.object(builtins, "open", denied), patch.object(os, "getenv", denied), \
                patch.object(socket, "socket", denied), patch.object(subprocess, "Popen", denied):
            self.assertEqual(handle(fixture("patch", ["KM9"]))["status"], "AWAITING_APPROVAL")
        code = '''
import builtins, os, socket, subprocess, json, hashlib, re, difflib, unicodedata
def denied(*args, **kwargs): raise AssertionError("import side effect")
builtins.open = denied
os.getenv = denied
socket.socket = denied
subprocess.Popen = denied
import financial_core.interface
'''
        subprocess.run([__import__('sys').executable, '-B', '-c', code], check=True, capture_output=True)

    def test_internal_classification_cannot_be_downgraded(self):
        payload = fixture("patch", ["KM9"])
        payload["source_docs"][0]["classification"] = "internal"
        self.assertEqual(handle(payload)["common_document"]["classification"], "internal")

    def test_quote_newlines_and_patch_tampering(self):
        payload = fixture("patch", ["KM9"])
        source = "Heading\r\n\r\nKey departure suspends investment.\r\nUnrelated original line."
        payload["source_docs"] = [doc("S9", source)]
        result = handle(payload)
        quote = "Key departure suspends investment.\r\nUnrelated original line."
        self.assertEqual(result["changes"][0]["source"]["quote"], quote)
        self.assertIn(quote, result["expected_body"])
        from financial_core.doc_parser import parse_document
        parsed = parse_document(payload["review_doc"])
        sources = [parse_document(payload["source_docs"][0])]
        corrupted = copy.deepcopy(result)
        corrupted["changes"][0]["text"] += "Invented financial fact."
        with self.assertRaises(CoreError): validate_patch(parsed, corrupted, "md", sources)
        corrupted = copy.deepcopy(result)
        corrupted["changes"][0]["source"]["version"] = "stale"
        with self.assertRaises(CoreError): validate_patch(parsed, corrupted, "md", sources)
        payload = fixture("patch", ["KM9"])
        change_doc(payload, "review_doc", payload["review_doc"]["content"].rstrip())
        self.assertIn("\\ No newline at end of file", handle(payload)["unified_diff"])

    def test_notice_names_all_unresolved_and_distinguishes_states(self):
        payload = fixture("convert")
        change_doc(payload, "review_doc", "Currency exposure and hedge plan are absent.")
        result = handle(payload)
        self.assertEqual([i["status"] for i in result["unresolved"]],
                         ["NEEDS_CONFIRMATION", "MISSING_WITH_EVIDENCE", "MISSING_NO_EVIDENCE"])
        common = result["common_document"]
        self.assertEqual(common["schema_version"], 2)
        for fmt in ("md", "txt"):
            rendered = serialize(common, fmt)
            self.assertIn("추가 확인 필요 항목", rendered)
            for item in common["unresolved"]:
                self.assertIn(f'{item["label"]} ({item["item_id"]})', rendered)
            self.assertIn("근거는 확인했지만 아직 보완하지 않은 항목", rendered)
            self.assertIn("제공 자료에서 근거를 확인하지 못함", rendered)
            self.assertIn("부정·상충·지원 범위 밖 표현 등으로 추가 확인 필요", rendered)
            self.assertIn("파일 저장 완료와 실사 검토 완료는 별개입니다.", rendered)
            self.assertNotIn("participation right does not exist", rendered)
            self.assertEqual(deserialize(rendered, fmt), common)

    def test_notice_absent_when_resolved_and_never_mixed_into_json_body(self):
        payload = fixture("convert")
        guide = json.loads(payload["guideline"]["content"])
        change_doc(payload, "review_doc", ".\n\n".join(r["positive_statements"][0] for r in guide["rules"]) + ".")
        result = handle(payload)
        self.assertEqual(result["unresolved"], [])
        self.assertTrue(result["review_complete"])
        for fmt in ("md", "txt"):
            self.assertEqual(render_notice(result["common_document"], fmt), "")
            self.assertNotIn("추가 확인 필요 항목", serialize(result["common_document"], fmt))
        common = handle(fixture("patch", ["KM9"]))["common_document"]
        self.assertNotIn("추가 확인 필요 항목", json.loads(serialize(common, "json"))["body"])

    def test_notice_excluded_from_review_and_evidence_through_repeated_conversions(self):
        common = handle(fixture("patch", ["KM9"]))["common_document"]
        original = copy.deepcopy(common)
        for fmt in ("md", "json", "txt", "md", "txt"):
            rendered = serialize(common, fmt)
            parsed = parse_document(doc("R9", rendered, fmt))
            self.assertEqual(parsed["body"], original["body"])
            self.assertFalse(any("DIANA 시스템 상태" in p["text"] for p in parsed["paragraphs"]))
            payload = fixture("convert", fmt=fmt)
            payload["review_doc"] = doc("R9", rendered, fmt)
            result = handle(payload)
            self.assertEqual(result["status"], "AWAITING_APPROVAL")
            self.assertEqual(result["items"][2]["status"], "MISSING_NO_EVIDENCE")
            common = result["common_document"]
            self.assertEqual(common, original)
            if fmt != "json":
                self.assertEqual(result["output_content"].count("추가 확인 필요 항목"), 1)
            guide = json.loads(payload["guideline"]["content"])
            source = parse_document(doc("S9", result["output_content"], fmt))
            self.assertEqual(EvidenceSearcher().search([source], guide["rules"][2]), [])

    def test_v1_read_convert_upgrade_and_unknown_legacy_item_explicit(self):
        common = handle(fixture("patch", ["KM9"]))["common_document"]
        legacy = {**common, "schema_version": 1,
                  "unresolved": [{k: v for k, v in i.items() if k != "label"} for i in common["unresolved"]]}
        for fmt in ("md", "txt", "json"):
            raw = serialize(legacy, fmt)
            self.assertEqual(deserialize(raw, fmt), legacy)
            payload = fixture("convert", fmt=fmt)
            payload["review_doc"] = doc("R9", raw, fmt)
            upgraded = handle(payload)
            self.assertEqual(upgraded["common_document"], common)
            self.assertIn("LPAC", upgraded["unresolved"][0]["label"])
        legacy["unresolved"][0]["item_id"] = "OLD_UNKNOWN"
        payload["review_doc"] = doc("R9", serialize(legacy, "json"), "json")
        self.assertEqual(handle(payload)["reason"], "UNRESOLVED_LABEL_REQUIRED")

    def test_user_heading_and_similar_inline_markers_preserved(self):
        body = '## 추가 확인 필요 항목\r\n\r\n사용자가 쓴 내용\r\n\r\n인라인 <!-- DIANA-COMMON-V1 예시 -->\n설명 [DIANA-STATUS-V1] 및 <!-- DIANA-STATUS-V1 --> 그대로 보존'
        for fmt in ("md", "txt"):
            payload = fixture("convert", fmt=fmt)
            payload["review_doc"] = doc("R9", body, fmt)
            result = handle(payload)
            self.assertEqual(result["status"], "AWAITING_APPROVAL")
            self.assertEqual(result["common_document"]["body"], body)
            self.assertEqual(deserialize(result["output_content"], fmt)["body"], body)
            self.assertEqual(result["output_content"].count("추가 확인 필요 항목"), 2)

    def test_label_escaping_uses_guideline_and_preserves_original_label(self):
        label = '<script>x</script>\n# [평의회] (권리) *강조* `명령` & -->'
        payload = fixture("patch", ["KM9"])
        guide = json.loads(payload["guideline"]["content"]); guide["rules"][2]["label"] = label
        change_doc(payload, "guideline", canonical(guide))
        result = handle(payload)
        common = result["common_document"]
        self.assertEqual(common["unresolved"][0]["label"], label)
        notice = render_notice(common, "md")
        self.assertNotIn("<script>", notice)
        self.assertNotIn("\n# [평의회]", notice)
        self.assertIn("&#60;script&#62;", notice)
        self.assertIn("&#91;평의회&#93;", notice)
        self.assertIn("<script>x</script> # [평의회]", render_notice(common, "txt"))
        self.assertNotIn("<script>", result["output_content"])
        self.assertEqual(result["output_content"].count("-->"), 3)
        self.assertEqual(deserialize(result["output_content"], "md"), common)

    def test_notice_or_metadata_tampering_is_explicit_not_silently_stripped(self):
        common = handle(fixture("patch", ["KM9"]))["common_document"]
        for fmt, marker, ending in (("md", "\n\n<!-- DIANA-COMMON-V2 ", " -->\n"),
                                    ("txt", "\n\n[DIANA-COMMON-V2 ", "]\n")):
            raw = serialize(common, fmt)
            content, meta = raw.rsplit(marker, 1)
            metadata = json.loads(meta[:-len(ending)])
            variants = [raw.replace("제공 자료에서 근거를 확인하지 못함", "확인 완료", 1),
                        content, raw[:-2], raw.replace('"notice_hash":', '"unknown_hash":', 1),
                        raw.replace("Synthetic review", "Altered business", 1),
                        raw.replace("DIANA-COMMON-V2 ", "DIANA-COMMON-V3 ", 1)]
            modified = copy.deepcopy(metadata); modified["unresolved"] = []
            variants.append(content + marker + canonical(modified) + ending)
            modified = copy.deepcopy(metadata); modified["presentation"]["body_length"] += 1
            variants.append(content + marker + canonical(modified) + ending)
            # Even updating the notice digest cannot turn different prose into a valid notice.
            tampered = content.replace("추가 확인 필요 항목", "모든 검토 완료")
            modified = copy.deepcopy(metadata)
            modified["presentation"]["notice_hash"] = sha(tampered[modified["presentation"]["body_length"]:])
            variants.append(tampered + marker + canonical(modified) + ending)
            # A forged downgrade must not reinterpret the new status block as v1 business text.
            downgraded = copy.deepcopy(metadata); downgraded.pop("presentation")
            downgraded["schema_version"] = 1
            downgraded["unresolved"] = [{k: v for k, v in i.items() if k != "label"} for i in downgraded["unresolved"]]
            variants.append(content + marker.replace("V2", "V1") + canonical(downgraded) + ending)
            for invalid in variants:
                payload = fixture("convert", fmt=fmt); payload["review_doc"] = doc("R9", invalid, fmt)
                result = handle(payload)
                self.assertIn(result["status"], ("ACTION_REQUIRED", "CLARIFICATION_REQUIRED"), result)
                self.assertNotIn("output_content", result)
        mismatch = copy.deepcopy(common)
        mismatch["unresolved"][0]["reason"] = "EXPLICIT_SOURCE_STATEMENT"
        with self.assertRaises(CoreError): serialize(mismatch, "md")

    def test_corrected_review_repatch_is_explicit_no_change(self):
        corrected = handle(fixture("patch", ["KM9"]))
        payload = fixture("patch", ["KM9"])
        payload["review_doc"] = doc("R9", corrected["output_content"], "md")
        result = handle(payload)
        self.assertEqual(result["status"], "READY")
        self.assertEqual(result["reason"], "ALREADY_SATISFIED")
        self.assertTrue(result["no_change"])
        self.assertFalse(result["saved"]); self.assertFalse(result["review_complete"])
        self.assertEqual(result["changes"], [])
        self.assertEqual(result["common_document"], corrected["common_document"])
        self.assertEqual([i["status"] for i in result["items"]], ["SATISFIED", "SATISFIED", "MISSING_NO_EVIDENCE"])
        self.assertEqual(result["items"][1]["review_references"][0]["quote"], corrected["changes"][0]["source"]["quote"])

    def test_current_verdict_replaces_stale_unresolved_metadata(self):
        common = handle(fixture("patch", ["KM9"]))["common_document"]
        # Old unresolved must neither force a failure nor hide a new omission.
        solved = copy.deepcopy(common); solved["body"] += "\n\nLPAC participation right exists."
        payload = fixture("convert")
        payload["review_doc"] = doc("R9", serialize(solved, "md"), "md")
        result = handle(payload)
        self.assertTrue(result["review_complete"])
        self.assertEqual(result["unresolved"], [])
        self.assertNotIn("추가 확인 필요 항목", result["output_content"])
        hidden = copy.deepcopy(common); hidden["unresolved"] = []
        payload["review_doc"] = doc("R9", serialize(hidden, "json"), "json")
        result = handle(payload)
        self.assertEqual(result["items"][2]["status"], "MISSING_NO_EVIDENCE")
        self.assertEqual(result["unresolved"][0]["item_id"], "LP9")

    def test_retained_citation_is_not_evidence_and_is_not_added_twice(self):
        original = handle(fixture("patch", ["KM9"]))
        common = copy.deepcopy(original["common_document"])
        quote = common["sources"][0]["quote"]
        common["body"] = common["body"].replace(quote, "")
        payload = fixture("patch", ["KM9"])
        payload["review_doc"] = doc("R9", serialize(common, "json"), "json")
        result = handle(payload)
        self.assertEqual(result["status"], "AWAITING_APPROVAL")
        self.assertEqual(result["items"][1]["status"], "MISSING_WITH_EVIDENCE")
        self.assertEqual(result["items"][1]["review_references"], [])
        self.assertEqual(result["common_document"]["sources"], original["common_document"]["sources"])
        self.assertEqual(result["expected_body"].count(quote), 1)


if __name__ == "__main__":
    unittest.main()
