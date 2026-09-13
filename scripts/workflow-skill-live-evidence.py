#!/usr/bin/env python3
"""Read-only evidence oracle for a workflow-skill live-run directory.

It never starts a provider request.  Provider request bodies and assistant/user
messages are inspected only to derive the structural facts emitted below; they
are never written to stdout or an evidence file.
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import json
import re
import sqlite3
import subprocess
import sys
from urllib.parse import unquote, urlparse
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any, Iterable

from workflow_skill_ctrl_evidence import ctrl_business_contract


SENSITIVE = re.compile(r"(?:api[_-]?key|authorization|credential|password|secret|token)", re.I)
RESOURCE_TAG = re.compile(r"<context-resource\b(?P<attributes>[^>]*)>", re.I)
ATTRIBUTE = re.compile(r"([\w:-]+)\s*=\s*([\"'])(.*?)\2", re.S)
ID_KEY = re.compile(r"(?:^|[_-])(publication|instance|run|resource)(?:[_-]?id|[_-]?ref)?$", re.I)
OUTPUT_KEY = re.compile(r"^(?:output|workflowOutput|executionOutput|result|variables)$", re.I)
STATE_KEY = re.compile(r"(?:status|state|terminalState|terminal_status)$", re.I)


def json_value(value: str) -> Any | None:
    try:
        return json.loads(value)
    except (TypeError, json.JSONDecodeError):
        return None


def scrub(value: Any, *, depth: int = 0) -> Any:
    """Preserve an actual execution value while removing likely credentials."""
    if depth > 12:
        return "<depth-limited>"
    if isinstance(value, dict):
        return {str(key): "<redacted>" if SENSITIVE.search(str(key)) else scrub(item, depth=depth + 1)
                for key, item in value.items()}
    if isinstance(value, list):
        return [scrub(item, depth=depth + 1) for item in value[:100]]
    if isinstance(value, str) and len(value) > 16_384:
        return value[:16_384] + "<truncated>"
    return value


def sha256_text(value: str) -> str:
    return "sha256:" + hashlib.sha256(value.encode()).hexdigest()


def sqlite_readonly(path: Path) -> sqlite3.Connection:
    return sqlite3.connect(f"file:{path.resolve()}?mode=ro", uri=True)


def trace_actor_ids(run_dir: Path, scenario: str | None) -> set[str]:
    traces = [run_dir / f"{scenario}-trace.jsonl"] if scenario else []
    traces += list(run_dir.glob("*-trace.jsonl"))
    actors: set[str] = set()
    for trace in traces:
        if not trace.is_file(): continue
        for line in trace.read_text(errors="replace").splitlines():
            value = json_value(line)
            actor = value.get("agentActorId") if isinstance(value, dict) else None
            if isinstance(actor, str): actors.add(actor)
    return actors


def sole_provider_database(run_dir: Path, workspace: Path, scenario: str | None) -> Path | None:
    candidates = sorted(workspace.glob(".eidolon/sessions/*/observability/provider-requests.sqlite"))
    if len(candidates) == 1:
        return candidates[0]
    if not candidates:
        return None
    traced = trace_actor_ids(run_dir, scenario)
    matches = []
    for candidate in candidates:
        try:
            conn = sqlite_readonly(candidate)
            actor_ids = {str(row[0]) for row in conn.execute("select distinct actor_id from provider_requests")}
            conn.close()
            if traced & actor_ids: matches.append(candidate)
        except sqlite3.Error:
            continue
    if len(matches) == 1: return matches[0]
    raise ValueError("multiple provider request databases do not resolve uniquely from this run's trace actors")


def rendered_skill_identities(run_dir: Path) -> dict[str, dict[str, str]]:
    """Ask the production SkillRegistry renderer for installed root-skill identities."""
    helper = Path(__file__).with_name("workflow-skill-rendered-identities.ts")
    global_root = run_dir / "global"
    if not helper.is_file() or not global_root.is_dir():
        return {}
    result = subprocess.run(["bun", str(helper), str(global_root)], cwd=helper.parent.parent,
                            capture_output=True, text=True, timeout=30, check=False)
    value = json_value(result.stdout)
    if result.returncode or not isinstance(value, dict):
        return {}
    return {key: item for key, item in value.items() if isinstance(key, str) and isinstance(item, dict)
            and isinstance(item.get("sourceDigest"), str) and isinstance(item.get("renderedDigest"), str)}


def resource_identity(resource_id: str, run_dir: Path,
                      rendered_identities: dict[str, dict[str, str]]) -> tuple[str | None, str | None]:
    """Hash the immutable installed file named by a provider-visible file URI."""
    parsed = urlparse(resource_id)
    if parsed.scheme != "file":
        return None, None
    try:
        candidate = Path(unquote(parsed.path)).resolve()
        candidate.relative_to((run_dir / "global/skills").resolve())
    except ValueError:
        return None, None
    if not candidate.is_file():
        return None, None
    source_digest = bytes_digest(candidate)
    identity = rendered_identities.get(resource_id) if parsed.fragment == "instruction-document" else None
    if identity is not None and identity.get("sourceDigest") == source_digest:
        # The helper only emits an identity after readInstalledSystemSkillResource succeeds.
        return identity["sourceDigest"], identity["renderedDigest"]
    if parsed.fragment == "instruction-document": return source_digest, None
    return source_digest, source_digest


def resource_records(content: str, request_id: int, run_dir: Path,
                     rendered_identities: dict[str, dict[str, str]]) -> list[dict[str, Any]]:
    records: list[dict[str, Any]] = []
    for match in RESOURCE_TAG.finditer(content):
        attrs = {key.lower(): value for key, _, value in ATTRIBUTE.findall(match.group("attributes"))}
        if attrs.get("status") != "loaded":
            continue
        resource_id = attrs.get("resource-id") or attrs.get("resourceid") or attrs.get("id")
        if not resource_id:
            continue
        digest = attrs.get("digest") or attrs.get("hash") or attrs.get("content-digest")
        delivered_revision = attrs.get("revision")
        source_sha256, content_sha256 = resource_identity(resource_id, run_dir, rendered_identities)
        revision_matches = (content_sha256 is not None and delivered_revision is not None
                            and content_sha256.removeprefix("sha256:") == delivered_revision.removeprefix("sha256:"))
        records.append({"resourceId": resource_id, "providerDigest": digest,
                        "deliveredRevision": delivered_revision, "sourceSha256": source_sha256,
                        "contentSha256": content_sha256 if revision_matches else None,
                        "hashValidation": "matched_delivered_revision" if revision_matches else "unverified",
                        "requestId": request_id})
    return records


def provider_evidence(db_path: Path | None, run_dir: Path,
                      rendered_identities: dict[str, dict[str, str]]) -> tuple[dict[str, Any], list[str]]:
    if db_path is None:
        return {}, ["provider request SQLite is not present yet"]
    conn = sqlite_readonly(db_path)
    try:
        request_rows = conn.execute(
            "select id, actor_id, request_model, model, provider_id from provider_requests order by id"
        ).fetchall()
        by_request = {row[0]: row for row in request_rows}
        actors: dict[str, dict[str, Any]] = {}
        for request_id, actor_id, request_model, model, provider_id in request_rows:
            actor = actors.setdefault(actor_id, {
                "requestIds": [], "requestModels": set(), "models": set(), "providerIds": set(),
                "providerVisibleSkillResources": {}, "toolResultCounts": Counter(),
                "providerLoadedStages": set(),
            })
            actor["requestIds"].append(request_id)
            actor["requestModels"].add(request_model)
            actor["models"].add(model)
            actor["providerIds"].add(provider_id)
        for request_id, role, raw in conn.execute(
            "select request_id, role, message_json from provider_request_messages order by request_id, message_ordinal"
        ):
            row = by_request.get(request_id)
            if row is None or role != "tool":
                continue
            message = json_value(raw)
            if not isinstance(message, dict):
                continue
            name = message.get("name")
            actor = actors[row[1]]
            if isinstance(name, str):
                actor["toolResultCounts"][name] += 1
            if name == "WorkflowLoadStageContext" and isinstance(message.get("content"), str):
                value = json_value(message["content"])
                stage = value.get("stage") if isinstance(value, dict) else None
                if isinstance(stage, str): actor["providerLoadedStages"].add(stage)
            if name == "Skill" and isinstance(message.get("content"), str):
                for record in resource_records(message["content"], request_id, run_dir, rendered_identities):
                    key = (record["resourceId"], record["providerDigest"], record["deliveredRevision"])
                    previous = actor["providerVisibleSkillResources"].setdefault(key, {
                        "resourceId": record["resourceId"], "providerDigest": record["providerDigest"],
                        "deliveredRevision": record["deliveredRevision"], "sourceSha256": record["sourceSha256"], "contentSha256": record["contentSha256"],
                        "hashValidation": record["hashValidation"], "requestIds": []
                    })
                    previous["requestIds"].append(request_id)
        outcomes = defaultdict(list)
        for request_id, terminal_state, completeness in conn.execute(
            "select request_id, terminal_state, completeness_status from provider_request_outcomes order by request_id"
        ):
            row = by_request.get(request_id)
            if row:
                outcomes[row[1]].append({"requestId": request_id, "terminalState": terminal_state,
                                          "completenessStatus": completeness})
        rendered: dict[str, Any] = {}
        for actor_id, actor in actors.items():
            rendered[actor_id] = {
                "requestIds": actor["requestIds"],
                "requestModels": sorted(actor["requestModels"]),
                "models": sorted(actor["models"]),
                "providerIds": sorted(actor["providerIds"]),
                "toolResultCounts": dict(sorted(actor["toolResultCounts"].items())),
                "providerLoadedStages": sorted(actor["providerLoadedStages"]),
                "providerVisibleSkillResources": sorted(actor["providerVisibleSkillResources"].values(),
                                                        key=lambda item: (item["resourceId"], item["contentSha256"] or "")),
                "outcomes": outcomes[actor_id],
            }
        return {"database": str(db_path), "actors": rendered}, []
    finally:
        conn.close()


def installed_skills(run_dir: Path) -> list[dict[str, str]]:
    manifest = run_dir / "global/skills/.system-skills.xnl"
    if not manifest.is_file():
        return []
    found: list[dict[str, str]] = []
    for body in re.findall(r"<SystemSkill\s*\{([^}]*)\}", manifest.read_text(errors="replace"), re.S):
        attrs = {key: value for key, _, value in ATTRIBUTE.findall(body)}
        if attrs.get("name"):
            found.append({key: attrs[key] for key in ("name", "version", "digest", "closureDigest") if key in attrs})
    return found


def trace_skill_reads(run_dir: Path) -> dict[str, list[str]]:
    """Skill calls from the CLI trace are read evidence, separate from provider visibility."""
    reads: dict[str, set[str]] = defaultdict(set)
    for trace in run_dir.glob("*-trace.jsonl"):
        for line in trace.read_text(errors="replace").splitlines():
            event = json_value(line)
            if not isinstance(event, dict) or event.get("stream") != "tool_call_start":
                continue
            summary = event.get("summary")
            if not isinstance(summary, dict) or summary.get("toolName") != "Skill":
                continue
            arguments = json_value(summary.get("argumentsText", ""))
            skill = arguments.get("skill") if isinstance(arguments, dict) else None
            if isinstance(skill, str):
                reads[str(event.get("agentActorId", "unknown"))].add(skill)
    return {actor: sorted(skills) for actor, skills in sorted(reads.items())}


def extract_cli_stdout_claims(run_dir: Path) -> dict[str, Any]:
    """Selected CLI stdout claims, explicitly not native runtime authority evidence."""
    ids: dict[str, set[str]] = defaultdict(set)
    states: set[str] = set()
    outputs: list[Any] = []
    parsed_files: list[str] = []

    def visit(value: Any, key: str | None = None, *, include_execution: bool = False, source: str = "") -> None:
        if isinstance(value, dict):
            for item_key, item_value in value.items():
                name = str(item_key)
                if ID_KEY.search(name) and isinstance(item_value, (str, int)):
                    ids[name].add(str(item_value))
                if include_execution and STATE_KEY.search(name) and isinstance(item_value, str):
                    states.add(item_value)
                if include_execution and OUTPUT_KEY.fullmatch(name) and item_value not in (None, ""):
                    outputs.append({"artifact": source, "value": scrub(item_value)})
                visit(item_value, name, include_execution=include_execution, source=source)
        elif isinstance(value, list):
            for item in value:
                visit(item, key, include_execution=include_execution, source=source)

    for path in run_dir.glob("*-exec.json"):
        raw = path.read_text(errors="replace")
        value = json_value(raw)
        if value is None:
            continue
        parsed_files.append(str(path.relative_to(run_dir)))
        visit(value, include_execution=True, source=str(path.relative_to(run_dir)))
    return {
        "identifiers": {key: sorted(values) for key, values in sorted(ids.items())},
        "states": sorted(states),
        "trueOutputs": outputs,
        "parsedArtifacts": sorted(parsed_files),
    }


def cli_status(run_dir: Path, scenario: str | None) -> dict[str, Any]:
    manifest_path = run_dir / "manifest.json"
    manifest = json_value(manifest_path.read_text(errors="replace")) if manifest_path.is_file() else None
    manifest_status = manifest.get("status") if isinstance(manifest, dict) else None
    manifest_exit = (manifest.get("exitCode", manifest.get("exit_code")) if isinstance(manifest, dict) else None)
    last_message = run_dir / f"{scenario}-last-message.txt" if scenario else None
    final_message_present = bool(last_message and last_message.is_file() and last_message.stat().st_size > 0)
    candidates = [run_dir / f"{scenario}-exec.json"] if scenario else []
    candidates += sorted(run_dir.glob("*-exec.json"))
    for path in candidates:
        if not path.is_file():
            continue
        value = json_value(path.read_text(errors="replace"))
        if isinstance(value, dict):
            return {"artifact": str(path.relative_to(run_dir)), "parsed": True,
                    "exitCode": value.get("exitCode", value.get("exit_code", manifest_exit)),
                    "status": value.get("status", value.get("state", manifest_status)),
                    "manifestStatus": manifest_status, "finalMessagePresent": final_message_present}
        return {"artifact": str(path.relative_to(run_dir)), "parsed": False,
                "exitCode": manifest_exit, "manifestStatus": manifest_status,
                "finalMessagePresent": final_message_present,
                "reason": "CLI stdout artifact is still incomplete or not JSON"}
    return {"parsed": False, "exitCode": manifest_exit, "manifestStatus": manifest_status,
            "finalMessagePresent": final_message_present,
            "reason": "CLI execution artifact is not present"}


def completed_state(states: Iterable[str]) -> bool:
    return any(str(state).lower() in {"completed", "complete", "succeeded", "success"} for state in states)


def descendants(value: Any) -> Iterable[dict[str, Any]]:
    if isinstance(value, dict):
        yield value
        for child in value.values():
            yield from descendants(child)
    elif isinstance(value, list):
        for child in value:
            yield from descendants(child)


def data_output_matches(value: Any, *, order_id: str, expected_rows: set[tuple[Any, ...]],
                        expected_subtotal: int, expected_total: int, discount: int | None) -> bool:
    """Check one output object as a whole; values from separate runs never combine."""
    for item in descendants(value):
        items = item.get("items")
        if item.get("orderId") != order_id or not isinstance(items, list):
            continue
        rows = {(row.get("sku"), row.get("quantity"), row.get("unitPriceCents"), row.get("subtotalCents"))
                for row in items if isinstance(row, dict)}
        if (rows == expected_rows and item.get("itemsSubtotalCents") == expected_subtotal
                and item.get("totalCents") == expected_total
                and (discount is None or item.get("discountCents") == discount)):
            return True
    return False


def business_contract(scenario: str | None, native: dict[str, Any], baseline: dict[str, Any] | None = None) -> dict[str, Any]:
    outputs = [entry["output"] for entry in native["chains"] if entry.get("output") is not None]
    if scenario == "data":
        return {"scenario": "data", "expected": {"orderId": "order-314", "subtotals": [1275, 2398],
                "itemsSubtotalCents": 3673, "totalCents": 3948},
                "satisfiedByOneOutput": any(data_output_matches(value, order_id="order-314",
                  expected_rows={("tea", 3, 425, 1275), ("cup", 2, 1199, 2398)}, expected_subtotal=3673,
                  expected_total=3948, discount=None) for value in outputs)}
    if scenario == "ctrl":
        return {"scenario": "ctrl", "expected": {"totalCents": 950, "agentApproved": True},
                "satisfied": False, "reason": "waiting for the real Ctrl checkpoint/profile.ai receipt schema"}
    if scenario == "edit":
        shape = {("tea", 3, 425, 1275), ("cup", 2, 1199, 2398)}
        edited = [chain for chain in native["chains"] if data_output_matches(chain.get("output"), order_id="order-314",
          expected_rows=shape, expected_subtotal=3673, expected_total=3898, discount=50)]
        prior = [chain for chain in (baseline or {}).get("chains", []) if data_output_matches(chain.get("output"), order_id="order-314",
          expected_rows=shape, expected_subtotal=3673, expected_total=3948, discount=None)]
        pairs = [(new, old) for new in edited for old in prior if new.get("workflowRef") == old.get("workflowRef")
                 and new.get("definitionRevision") != old.get("definitionRevision")]
        return {"scenario": "edit", "expected": {"baselineTotalCents": 3948, "v2TotalCents": 3898,
                "discountCents": 50, "itemsSubtotalCents": 3673}, "newV2Output": bool(edited),
                "baselineFrozenOutput": bool(prior), "sameWorkflowDistinctFrozenRevision": bool(pairs),
                "satisfied": bool(pairs)}
    return {"scenario": scenario, "satisfied": False, "reason": "scenario is not data or ctrl"}


def json_files(directory: Path) -> Iterable[dict[str, Any]]:
    if not directory.is_dir():
        return []
    values: list[dict[str, Any]] = []
    for path in directory.glob("*.json"):
        value = json_value(path.read_text(errors="replace"))
        if isinstance(value, dict): values.append(value)
    return values


def return_node_output(graph: dict[str, Any]) -> Any | None:
    nodes = graph.get("nodes")
    if not isinstance(nodes, dict): return None
    for node in nodes.values():
        if not isinstance(node, dict): continue
        if node.get("tag") not in ("ReturnNode", "Return"): continue
        result = node.get("result")
        if isinstance(result, dict) and "output" in result: return scrub(result["output"])
    return None


def checkpoint_output(root: Path, instance_id: str, run_id: str) -> Any | None:
    path = root / "instances" / str(instance_id) / "runs" / str(run_id) / "checkpoint.json"
    value = json_value(path.read_text(errors="replace")) if path.is_file() else None
    control = value.get("control") if isinstance(value, dict) else None
    checkpoint = control.get("checkpoint") if isinstance(control, dict) else None
    if isinstance(checkpoint, dict):
        direct = checkpoint.get("output")
        if direct is not None: return scrub(direct)
        state = checkpoint.get("state")
        execution_state = state.get("__flow_execution__") if isinstance(state, dict) else None
        if isinstance(execution_state, dict) and execution_state.get("returned") is True and execution_state.get("output") is not None:
            return scrub(execution_state["output"])
        execution = checkpoint.get("__flow_execution__")
        if isinstance(execution, dict) and execution.get("output") is not None: return scrub(execution["output"])
    return None


def effective_publications(workspace: Path) -> list[dict[str, Any]]:
    path = workspace / ".eidolon/projects/.effective-vfs/authority.sqlite"
    if not path.is_file(): return []
    try:
        conn = sqlite_readonly(path)
        rows = []
        for key, raw in conn.execute("select publication_key, record from vfs_publications"):
            record = json_value(raw)
            receipt = record.get("receipt") if isinstance(record, dict) else None
            association = record.get("association") if isinstance(record, dict) else None
            if isinstance(receipt, dict) and receipt.get("status") in ("published", "admitted") and isinstance(association, dict):
                rows.append({"publicationKey": key, "receiptId": receipt.get("receiptId"),
                             "publishedRevision": receipt.get("publishedRevision"), "association": association})
        conn.close(); return rows
    except (sqlite3.Error, OSError): return []


def authoring_attempts(workspace: Path) -> list[dict[str, Any]]:
    attempts = []
    for path in workspace.glob(".eidolon/workflows/.authoring/effective-publications/*.json"):
        value = json_value(path.read_text(errors="replace"))
        if not isinstance(value, dict) or value.get("schemaVersion") != "workflow.effective-publication-attempt/v1": continue
        if isinstance(value.get("receipt"), dict) and isinstance(value.get("association"), dict): attempts.append(value)
    return attempts


def native_runtime_authority(workspace: Path, db_path: Path | None) -> dict[str, Any]:
    """Join immutable FactStore records; no CLI/model text participates in this chain."""
    if db_path is None: return {"chains": [], "reason": "no selected session database"}
    session_dir = db_path.parent.parent
    root = session_dir / "workflow-runtime"
    instances = {str(x.get("instanceId")): x for x in json_files(root / "instances") if x.get("instanceId")}
    descriptors = {str(x.get("runId")): x for x in json_files(root / "runs") if x.get("runId")}
    receipts = {str(x.get("runId")): x for x in json_files(root / "run-receipts") if x.get("runId")}
    definitions = {str(x.get("revision")): x for x in json_files(root / "definition-revisions") if x.get("revision")}
    publications = effective_publications(workspace); attempts = authoring_attempts(workspace)
    chains = []
    for run_id, descriptor in descriptors.items():
        instance = instances.get(str(descriptor.get("instanceId"))); receipt = receipts.get(run_id)
        revision = str(descriptor.get("definitionRevision", "")); definition = definitions.get(revision)
        if not instance or not receipt or not definition: continue
        if (receipt.get("instanceId") != instance.get("instanceId") or receipt.get("definitionRevision") != revision
            or instance.get("definitionRevision") != revision or descriptor.get("workflowRef") != instance.get("workflowRef")
            or definition.get("workflowRef") != instance.get("workflowRef") or instance.get("status") != "Completed"):
            continue
        resource_receipt = definition.get("resourceReceipt")
        composition = resource_receipt.get("compositionRevision") if isinstance(resource_receipt, dict) else None
        attempt = next((item for item in attempts if item["receipt"].get("compositionRevision") == composition
                       and instance.get("workflowRef") in item["receipt"].get("workflowRefs", [])), None)
        if not attempt: continue
        receipt_bytes = json.dumps(attempt["receipt"], ensure_ascii=False, separators=(",", ":")).encode()
        receipt_digest = "sha256:" + hashlib.sha256(receipt_bytes).hexdigest()
        publication = next((item for item in publications if item["association"] == attempt["association"]
                           and item["association"].get("receiptDigest") == receipt_digest
                           and item.get("publishedRevision") == attempt["receipt"].get("effectiveVfsRevision")), None)
        if not publication: continue
        graph = json_value((root / "data-graphs" / f"{run_id}.json").read_text(errors="replace")) if (root / "data-graphs" / f"{run_id}.json").is_file() else None
        output = return_node_output(graph) if isinstance(graph, dict) else checkpoint_output(root, instance.get("instanceId"), run_id)
        chains.append({"publicationKey": publication.get("publicationKey") if publication else None,
                       "publicationReceiptId": publication.get("receiptId") if publication else None,
                       "workflowRef": instance.get("workflowRef"), "definitionRevision": revision,
                       "instanceId": instance.get("instanceId"), "runId": run_id, "status": instance.get("status"),
                       "form": descriptor.get("form"),
                       "output": output})
    return {"sessionDirectory": str(session_dir), "factRoot": str(root), "publicationReceipts": publications,
            "chains": chains, "reason": None if chains else "no fully joined native publication/instance/run chain"}


def bytes_digest(path: Path) -> str:
    return "sha256:" + hashlib.sha256(path.read_bytes()).hexdigest()


def runtime_head_record(deployment: Path) -> tuple[dict[str, Any] | None, str | None]:
    """Read exactly the production runtime head; historical records never prove current state."""
    head_path = deployment / "runtime/head.json"
    head = json_value(head_path.read_text(errors="replace")) if head_path.is_file() else None
    if not isinstance(head, dict) or head.get("schemaVersion") != "eidolon.holon-deployment-runtime-head/v1":
        return None, "deployment runtime head is missing or invalid"
    digest = head.get("stateRecordDigest")
    if not isinstance(digest, str) or not re.fullmatch(r"sha256:[a-f0-9]{64}", digest):
        return None, "deployment head has no canonical state record digest"
    record_path = deployment / "runtime/records" / f"{digest.removeprefix('sha256:')}.json"
    record = json_value(record_path.read_text(errors="replace")) if record_path.is_file() else None
    if not isinstance(record, dict) or bytes_digest(record_path) != digest:
        return None, "deployment head record is absent or digest-mismatched"
    if record.get("deploymentId") != head.get("deploymentId") or record.get("revision") != head.get("revision"):
        return None, "deployment head and record identities disagree"
    for key, directory, schema in (("treeDigest", "trees", "eidolon.holon-deployment-runtime-tree/v1"),
                                   ("receiptDigest", "receipts", "eidolon.holon-deployment-runtime-receipt/v1")):
        linked = head.get(key)
        linked_path = deployment / "runtime" / directory / f"{str(linked).removeprefix('sha256:')}.json"
        linked_value = json_value(linked_path.read_text(errors="replace")) if linked_path.is_file() else None
        if not isinstance(linked, str) or not isinstance(linked_value, dict) or bytes_digest(linked_path) != linked \
                or linked_value.get("schemaVersion") != schema or linked_value.get("deploymentId") != head.get("deploymentId") \
                or linked_value.get("revision") != head.get("revision") or linked_value.get("stateRecordDigest") != digest:
            return None, f"deployment {key} is absent or does not bind the current record"
    tree = json_value((deployment / "runtime/trees" / f"{str(head['treeDigest']).removeprefix('sha256:')}.json").read_text(errors="replace"))
    receipt = json_value((deployment / "runtime/receipts" / f"{str(head['receiptDigest']).removeprefix('sha256:')}.json").read_text(errors="replace"))
    if not isinstance(tree, dict) or not isinstance(receipt, dict) or receipt.get("treeDigest") != head.get("treeDigest") \
            or tree.get("stateRecordDigest") != digest:
        return None, "deployment tree/receipt chain disagrees with current head"
    return record, None


def task_space_head_record(space: Path, task_space_id: str) -> tuple[dict[str, Any] | None, str | None]:
    head_path = space / "head.json"
    head = json_value(head_path.read_text(errors="replace")) if head_path.is_file() else None
    if not isinstance(head, dict) or head.get("kind") != "task-space-head" or head.get("taskSpaceId") != task_space_id:
        return None, "TaskSpace head is missing or invalid"
    digest = head.get("recordDigest")
    if not isinstance(digest, str) or not re.fullmatch(r"sha256:[a-f0-9]{64}", digest):
        return None, "TaskSpace head has no canonical record digest"
    record_path = space / "records" / f"{digest}.json"
    record = json_value(record_path.read_text(errors="replace")) if record_path.is_file() else None
    if not isinstance(record, dict) or bytes_digest(record_path) != digest:
        return None, "TaskSpace head record is absent or digest-mismatched"
    if record.get("taskSpaceId") != task_space_id or record.get("revision") != head.get("revision"):
        return None, "TaskSpace head and record identities disagree"
    tree_digest = head.get("treeDigest")
    tree_path = space / "trees" / f"{tree_digest}.json"
    tree = json_value(tree_path.read_text(errors="replace")) if tree_path.is_file() else None
    if not isinstance(tree_digest, str) or not isinstance(tree, dict) or bytes_digest(tree_path) != tree_digest \
            or tree.get("kind") != "task-space-definition" or tree.get("taskSpaceId") != task_space_id:
        return None, "TaskSpace tree is absent or does not bind the current head"
    return record, None


def public_assignment_receipts(run_dir: Path) -> list[dict[str, Any]]:
    """Only tool-result receipts from this run's assignment trace are candidates."""
    trace = run_dir / "assignments-trace.jsonl"
    if not trace.is_file(): return []
    starts: dict[str, str] = {}
    receipts: list[dict[str, Any]] = []
    for line in trace.read_text(errors="replace").splitlines():
        event = json_value(line); summary = event.get("summary") if isinstance(event, dict) else None
        if not isinstance(summary, dict): continue
        surface = summary.get("toolName")
        if event.get("stream") == "tool_call_start" and surface in ("HolonAssign", "MemberAssign") and isinstance(summary.get("toolCallId"), str):
            starts[summary["toolCallId"]] = str(event.get("ts", ""))
            continue
        if event.get("stream") != "tool_call_result": continue
        if surface not in ("HolonAssign", "MemberAssign") or summary.get("isError") is not False: continue
        receipt = json_value(summary.get("resultText", ""))
        if not isinstance(receipt, dict): continue
        receipts.append({"surface": surface, "actorId": event.get("agentActorId"), "toolCallId": summary.get("toolCallId"),
                         "startedAt": starts.get(summary.get("toolCallId")), "settledAt": event.get("ts"), "receipt": receipt})
    return receipts


def provider_actor_keys(session: Path) -> dict[str, str]:
    index = json_value((session / "conversation/session.index.json").read_text(errors="replace"))
    bindings = index.get("session", index).get("actorBindings", {}) if isinstance(index, dict) else {}
    return {str(value.get("actorId")): str(value.get("actorKey")) for value in bindings.values()
            if isinstance(value, dict) and isinstance(value.get("actorId"), str) and isinstance(value.get("actorKey"), str)}


def current_skill_hashes(run_dir: Path, rendered_identities: dict[str, dict[str, str]]) -> set[str]:
    hashes: set[str] = set()
    root = run_dir / "global/skills"
    if root.is_dir():
        for path in root.rglob("*"):
            if path.is_file():
                hashes.add(bytes_digest(path))
                if path.name == "SKILL.md":
                    identity = rendered_identities.get(path.as_uri() + "#instruction-document")
                    # A rendered identity is usable only when its source digest still
                    # belongs to the immutable installed global file set.
                    if identity is not None and identity["sourceDigest"] == bytes_digest(path):
                        hashes.add(identity["renderedDigest"])
    return hashes


def task_output_matches(space: Path, task: dict[str, Any]) -> bool:
    """Verify the exact settled TaskSpace artifact, never the facade's projected result."""
    for ref in task.get("outputArtifacts", []):
        digest = ref.get("digest") if isinstance(ref, dict) else None
        artifact_path = space / "artifacts" / f"{digest}.json"
        artifact = json_value(artifact_path.read_text(errors="replace")) if isinstance(digest, str) and artifact_path.is_file() else None
        if not isinstance(artifact, dict) or artifact.get("kind") != "task-artifact-body" or artifact.get("digest") != digest \
                or artifact.get("encoding") != "base64": continue
        try:
            raw = base64.b64decode(artifact["data"], validate=True)
            if "sha256:" + hashlib.sha256(raw).hexdigest() != digest: continue
            value: Any = raw.decode("utf-8")
            for _ in range(2):
                decoded = json_value(value) if isinstance(value, str) else None
                if decoded is None: break
                value = decoded
            rendered = json.dumps(value, ensure_ascii=False) if not isinstance(value, str) else value
        except (KeyError, TypeError, ValueError, UnicodeDecodeError):
            continue
        if all(token in rendered for token in ("order-314", "1275", "2398", "3948")):
            return True
    return False


def exact_worker_actors(public: dict[str, Any], session: Path, provider: dict[str, Any], task_input: Any) -> list[str]:
    """Bind a task attempt to its provider actor by the public call's bounded lifecycle interval."""
    if task_input is None: return []
    started, settled = public.get("startedAt"), public.get("settledAt")
    if not isinstance(started, str) or not isinstance(settled, str): return []
    index = json_value((session / "conversation/session.index.json").read_text(errors="replace"))
    bindings = index.get("session", index).get("actorBindings", {}) if isinstance(index, dict) else {}
    candidates = [str(value["actorId"]) for value in bindings.values() if isinstance(value, dict)
            and isinstance(value.get("actorId"), str) and value["actorId"] in provider.get("actors", {})
            and isinstance(value.get("actorKey"), str) and "resource://eidolon.product.Worker" in value["actorKey"]
            and isinstance(value.get("boundAt"), str) and started <= value["boundAt"] <= settled]
    # There is no persisted Member-session → provider-actor field. Require a
    # unique actor in this serialized public call and verify its actual input.
    if len(candidates) != 1: return []
    with sqlite_readonly(Path(provider["database"])) as connection:
        for (raw,) in connection.execute(
            "select m.message_json from provider_request_messages m join provider_requests p "
            "on p.id=m.request_id where p.actor_id=? and m.role='user'", (candidates[0],)):
            message = json_value(raw)
            content = json_value(message.get("content", "")) if isinstance(message, dict) else None
            if content == task_input or (isinstance(content, dict)
                    and content.get("schemaVersion") == "eidolon.agent-execution-input/v1"
                    and content.get("payload") == task_input):
                return candidates
    return []


def assignment_authority(run_dir: Path, db_path: Path | None, provider: dict[str, Any],
                         rendered_identities: dict[str, dict[str, str]]) -> dict[str, Any]:
    if db_path is None: return {"assignments": [], "complete": False, "reason": "no selected session"}
    session = db_path.parent.parent
    runtime_root = session / "holon-task-runtime"
    installed_hashes = current_skill_hashes(run_dir, rendered_identities)
    deployments: list[tuple[dict[str, Any], Path]] = []
    for deployment in runtime_root.glob("holon-deployments/*"):
        record, error = runtime_head_record(deployment)
        if record is not None: deployments.append((record, deployment))
    joined: list[dict[str, Any]] = []
    for public in public_assignment_receipts(run_dir):
        surface, receipt = public["surface"], public["receipt"]
        outcome: dict[str, Any] = {"surface": surface, "toolCallId": public.get("toolCallId"), "acceptedReceipt": False,
                                   "canonicalSettlement": False, "memberProviderSkillHash": False}
        expected_type = "holon" if surface == "HolonAssign" else "member"
        if not (receipt.get("ok") is True and receipt.get("accepted") is True and receipt.get("reply_mode") == "final"
                and receipt.get("target_type") == expected_type and receipt.get("completion_status") == "settled"
                and receipt.get("terminal_status") == "Succeeded"):
            outcome["reason"] = "public final receipt is not an accepted successful settlement"
            joined.append(outcome); continue
        required = ("task_space_id", "task_id", "command_id", "settlement_receipt_id")
        if not all(isinstance(receipt.get(key), str) and receipt[key] for key in required):
            outcome["reason"] = "public receipt lacks canonical task identity"
            joined.append(outcome); continue
        outcome["acceptedReceipt"] = True
        task_space_id, task_id = receipt["task_space_id"], receipt["task_id"]
        space = runtime_root / "task-spaces/spaces" / f"space-{task_space_id}"
        state, error = task_space_head_record(space, task_space_id)
        task = next((item for item in state.get("tasks", []) if isinstance(item, dict) and item.get("taskId") == task_id), None) if state else None
        # Receipt files are immutable, but only the current TaskSpace head can make one current.
        settlements = [json_value(path.read_text(errors="replace")) for path in (space / "receipts").glob("*.json") if path.is_file()]
        settlement = next((item for item in settlements if isinstance(item, dict)
                           and item.get("kind") == "task-settlement-receipt" and item.get("commandId") == receipt["settlement_receipt_id"]), None)
        claims = [item for item in settlements if isinstance(item, dict) and item.get("kind") == "task-claim-receipt"
                  and item.get("taskId") == task_id]
        subscriptions = [json_value(path.read_text(errors="replace")) for path in (runtime_root / "holon-task-pump/subscriptions").glob("*.json") if path.is_file()]
        subscription = next((item for item in subscriptions if isinstance(item, dict) and item.get("taskSpaceId") == task_space_id
                             and item.get("taskId") == task_id and item.get("origin", {}).get("surface") == surface
                             and item.get("origin", {}).get("requestRef") == public.get("toolCallId")), None)
        if not state or not isinstance(task, dict) or task.get("status") != "Succeeded" or task.get("activeClaim") is not None \
                or not task.get("outputArtifacts") or not task_output_matches(space, task) or not isinstance(subscription, dict) \
                or not isinstance(settlement, dict) or settlement.get("status") != "Succeeded" \
                or settlement.get("taskId") != task_id or settlement.get("taskSpaceId") != task_space_id:
            outcome["reason"] = error or "current TaskSpace head lacks this successful settlement, exact public subscription, or order output artifact"
            joined.append(outcome); continue
        claim = next((item for item in claims if isinstance(item.get("claim"), dict) and item["claim"].get("claimId") == settlement.get("claimId")), None)
        assignee = claim.get("claim", {}).get("assigneeRef") if isinstance(claim, dict) else None
        profile = task.get("profile", {}).get("facts", {}) if isinstance(task.get("profile"), dict) else {}
        admission = profile.get("admission", {}) if isinstance(profile, dict) else {}
        target_member = admission.get("executionTarget", {}).get("memberRef") if isinstance(admission, dict) and isinstance(admission.get("executionTarget"), dict) else None
        deployment_matches = [(record, root) for record, root in deployments if any(isinstance(s, dict) and s.get("taskSpaceId") == task_space_id for s in record.get("subscriptions", []))]
        member = next((entry for record, _ in deployment_matches for entry in record.get("members", [])
                       if isinstance(entry, dict) and entry.get("runtimeRef") == assignee and entry.get("memberRef") == target_member), None)
        member_session = next((item for item in member.get("sessions", []) if isinstance(item, dict)
                               and item.get("mode") == "task-attempt" and item.get("taskSpaceId") == task_space_id
                               and item.get("taskId") == task_id and item.get("claimId") == settlement.get("claimId")) if isinstance(member, dict) else None)
        if not isinstance(member, dict) or not isinstance(member_session, dict) or not isinstance(member_session.get("sessionRef"), str):
            outcome["reason"] = "TaskSpace claim has no current deployment MemberRuntime join"
            joined.append(outcome); continue
        outcome["canonicalSettlement"] = True
        # The pump subscription owns execution input; TaskRecord owns task state.
        # Its origin/requestRef above binds this input to the exact public call.
        worker_actors = exact_worker_actors(public, session, provider, subscription.get("input"))
        loaded = [resource for actor_id in worker_actors for resource in provider["actors"][actor_id].get("providerVisibleSkillResources", [])
                  if resource.get("hashValidation") == "matched_delivered_revision" and resource.get("contentSha256") in installed_hashes]
        outcome.update({"taskSpaceId": task_space_id, "taskId": task_id, "memberRuntimeRef": assignee,
                        "memberRef": target_member, "memberSessionRef": member_session["sessionRef"], "providerActorIds": worker_actors,
                        "matchedSkillHashes": sorted({item["contentSha256"] for item in loaded})})
        outcome["memberProviderSkillHash"] = bool(loaded)
        if not outcome["memberProviderSkillHash"]: outcome["reason"] = "this task's exact Worker provider actor has no Skill load matching this run global hash"
        joined.append(outcome)
    by_surface = {surface: [item for item in joined if item["surface"] == surface] for surface in ("HolonAssign", "MemberAssign")}
    complete = all(any(item["acceptedReceipt"] and item["canonicalSettlement"] and item["memberProviderSkillHash"] for item in by_surface[surface]) for surface in by_surface)
    return {"sessionDirectory": str(session), "installedGlobalSkillHashCount": len(installed_hashes), "assignments": joined,
            "complete": complete, "reason": None if complete else "each public final route requires a current canonical successful settlement and Worker Skill hash"}


def acceptance(provider: dict[str, Any], native: dict[str, Any], cli: dict[str, Any], expected_model: str,
               scenario: str | None, baseline: dict[str, Any] | None = None,
               main_actor_ids: set[str] | None = None, assignments: dict[str, Any] | None = None,
               ctrl_report: dict[str, Any] | None = None) -> dict[str, Any]:
    if scenario == "assignments":
        actual_models = sorted({model for actor in provider.get("actors", {}).values() for model in actor["requestModels"]})
        checks = {"providerRequestsObserved": bool(provider.get("actors")),
                  "actualModelIsExpected": bool(actual_models) and actual_models == [expected_model],
                  "assignmentNativeAuthority": bool(assignments and assignments.get("complete")),
                  "cliExitOrCompleted": bool(cli.get("parsed") is True and cli.get("exitCode") in (0, "0")
                                         and completed_state([cli.get("status", "")]) and cli.get("finalMessagePresent") is True)}
        return {"expectedModel": expected_model, "actualModels": actual_models,
                "checks": checks, "complete": all(checks.values()), "mode": "assignment_native_authority",
                "reason": assignments.get("reason") if assignments else "assignment authority unavailable"}
    actors = provider.get("actors", {})
    actual_models = sorted({model for actor in actors.values() for model in actor["requestModels"]})
    model_ok = bool(actual_models) and actual_models == [expected_model]
    visible = sum(len(actor["providerVisibleSkillResources"]) for actor in actors.values())
    main_actor_ids = main_actor_ids or set()
    specialized = [actor for actor_id, actor in actors.items() if actor_id not in main_actor_ids]
    required_stages = {"coding", "testing", "releasing", "deploying", "operating"}
    specialized_stages = {stage for actor in specialized for stage in actor["providerLoadedStages"]}
    gateway = any(actor["toolResultCounts"].get("WorkflowFulfill", 0) > 0 for actor in actors.values())
    chains = native["chains"]
    has_publication = bool(chains)
    has_instance = bool(chains)
    has_run = bool(chains)
    workflow_complete = any(chain.get("status") == "Completed" for chain in chains)
    has_output = any(chain.get("output") is not None for chain in chains)
    cli_completed = (cli.get("parsed") is True and cli.get("exitCode") in (0, "0")
                     and completed_state([cli.get("status", "")]) and cli.get("finalMessagePresent") is True)
    checks = {
        "providerRequestsObserved": bool(actors),
        "actualModelIsExpected": model_ok,
        "providerVisibleSkillResourceObserved": visible > 0,
        "workflowFulfillGatewayObserved": gateway,
        "specializedStageCoverage": required_stages <= specialized_stages,
        "publicationIdentifierObserved": has_publication,
        "instanceIdentifierObserved": has_instance,
        "runIdentifierObserved": has_run,
        "workflowCompleted": workflow_complete,
        "trueOutputObserved": has_output,
        "cliExitOrCompleted": bool(cli_completed),
    }
    checks["nativeAuthorityJoin"] = bool(chains)
    business = ctrl_report if scenario == "ctrl" and ctrl_report is not None else business_contract(scenario, native, baseline)
    checks["businessContract"] = business.get("satisfied", business.get("satisfiedByOneOutput", False))
    return {"expectedModel": expected_model, "actualModels": actual_models, "checks": checks,
            "complete": all(checks.values()), "mode": "native_authority" if chains else "evidence_only",
            "reason": native.get("reason")}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("run_dir", type=Path, help="live harness report directory")
    parser.add_argument("--scenario", choices=("data", "ctrl", "edit", "assignments"), help="selected scenario; defaults from manifest or directory")
    parser.add_argument("--baseline-run", type=Path, help="immutable prior run required by the edit oracle")
    parser.add_argument("--expected-model", default="deepseek-v4-pro")
    parser.add_argument("--output", type=Path, help="write the scrubbed JSON report instead of stdout")
    args = parser.parse_args()
    run_dir = args.run_dir.resolve()
    if not run_dir.is_dir():
        parser.error(f"not a run directory: {run_dir}")
    manifest = json_value((run_dir / "manifest.json").read_text(errors="replace")) if (run_dir / "manifest.json").is_file() else {}
    scenario = args.scenario or (manifest.get("scenario") if isinstance(manifest, dict) else None)
    workspace_value = manifest.get("workspace") if isinstance(manifest, dict) else None
    workspace = Path(workspace_value).resolve() if isinstance(workspace_value, str) else run_dir / "workspace"
    rendered_identities = rendered_skill_identities(run_dir)
    try:
        db_path = sole_provider_database(run_dir, workspace, scenario)
        provider, warnings = provider_evidence(db_path, run_dir, rendered_identities)
    except (OSError, sqlite3.Error, ValueError) as error:
        provider, warnings, db_path = {}, [f"provider evidence unavailable: {type(error).__name__}: {error}"], None
    cli_claims = extract_cli_stdout_claims(run_dir)
    native = native_runtime_authority(workspace, db_path)
    assignments = assignment_authority(run_dir, db_path, provider, rendered_identities) if scenario == "assignments" else None
    ctrl_report = ctrl_business_contract(native, provider, db_path) if scenario == "ctrl" else None
    baseline_native = None
    if args.baseline_run:
        baseline_root = args.baseline_run.resolve()
        baseline_manifest = json_value((baseline_root / "manifest.json").read_text(errors="replace"))
        baseline_workspace = Path(baseline_manifest["workspace"]).resolve() if isinstance(baseline_manifest, dict) and isinstance(baseline_manifest.get("workspace"), str) else baseline_root / "workspace"
        baseline_scenario = baseline_manifest.get("scenario") if isinstance(baseline_manifest, dict) else None
        try:
            baseline_native = native_runtime_authority(baseline_workspace, sole_provider_database(baseline_root, baseline_workspace, baseline_scenario))
        except (OSError, sqlite3.Error, ValueError) as error:
            baseline_native = {"chains": [], "reason": f"baseline unavailable: {type(error).__name__}"}
    cli = cli_status(run_dir, scenario)
    report = {
        "schemaVersion": "workflow-skill-live-evidence/v1",
        "runDirectory": str(run_dir),
        "workspace": str(workspace),
        "scenario": scenario,
        "readOnly": True,
        "installedSkillResources": installed_skills(run_dir),
        "traceOnlySkillReadsByActor": trace_skill_reads(run_dir),
        "provider": provider,
        "cliStdoutClaims": cli_claims,
        "nativeAuthority": native,
        "assignmentAuthority": assignments,
        "baselineNativeAuthority": baseline_native,
        "businessContract": ({"satisfied": assignments["complete"],
                              "mode": "settled_artifact_tokens_and_worker_skill",
                              "limitation": "Freeform value arithmetic is independently reviewed; token presence alone is not a semantic arithmetic proof."}
                             if assignments is not None else ctrl_report if ctrl_report is not None
                             else business_contract(scenario, native, baseline_native)),
        "cli": cli,
        "warnings": warnings,
    }
    report["acceptance"] = acceptance(provider, native, cli, args.expected_model, scenario, baseline_native,
                                        trace_actor_ids(run_dir, scenario), assignments, ctrl_report)
    report["status"] = "complete" if report["acceptance"]["complete"] else "evidence_only"
    encoded = json.dumps(report, ensure_ascii=False, indent=2, sort_keys=True) + "\n"
    if args.output:
        args.output.write_text(encoded)
    else:
        sys.stdout.write(encoded)
    return 0 if report["status"] == "complete" else 2


if __name__ == "__main__":
    raise SystemExit(main())
