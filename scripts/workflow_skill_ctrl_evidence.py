"""Read-only Ctrl checkpoint/effect/Agent-provider join for the live acceptance oracle."""
from __future__ import annotations

import json
import sqlite3
from pathlib import Path
from typing import Any


def read_json(path: Path) -> Any:
    return json.loads(path.read_text())


def ctrl_business_contract(native: dict, provider: dict, db_path: Path | None) -> dict:
    joined = []
    if db_path is None:
        return {"scenario": "ctrl", "satisfied": False, "agentJoins": joined}
    with sqlite3.connect(f"file:{db_path.resolve()}?mode=ro", uri=True) as database:
        for chain in native.get("chains", []):
            root = Path(native["factRoot"])
            checkpoint_path = root / "instances" / chain["instanceId"] / "runs" / chain["runId"] / "checkpoint.json"
            if not checkpoint_path.is_file():
                continue
            checkpoint = read_json(checkpoint_path)
            if checkpoint.get("instanceId") != chain["instanceId"] or checkpoint.get("runId") != chain["runId"]:
                continue
            control = checkpoint.get("control", {})
            ai = control.get("profile", {}).get("ai", {})
            output = chain.get("output")
            if not isinstance(output, dict) or output.get("orderId") != "order-315":
                continue
            pricing = output.get("pricing", {})
            expected_rows = [{"sku": "tea", "quantity": 2, "unitPriceCents": 425, "subtotalCents": 850}]
            if (pricing.get("items") != expected_rows or pricing.get("itemsSubtotalCents") != 850
                    or pricing.get("shippingCents") != 100 or pricing.get("totalCents") != 950):
                continue
            events_path = root / "events" / f"{chain['runId']}.jsonl"
            events = [json.loads(line) for line in events_path.read_text().splitlines()] if events_path.is_file() else []
            for invocation in ai.get("invocationsByKey", {}).values():
                expected_review = {"orderId": "order-315", "totalCents": 950, "approved": True}
                if (invocation.get("status") != "completed" or invocation.get("output") != expected_review
                        or invocation.get("output", {}).get("approved") is not True or output.get("review") != expected_review):
                    continue
                actor_id = invocation.get("instanceId")
                instance = ai.get("instancesById", {}).get(actor_id, {})
                if (instance.get("authority") != "eidolon.actor-runtime/v1"
                        or instance.get("instanceId") != actor_id
                        or instance.get("agentDefinitionRef") != invocation.get("agentDefinitionRef")
                        or output.get("agentInvocation", {}).get("instanceId") != actor_id):
                    continue
                actor = provider.get("actors", {}).get(actor_id)
                if not actor or not actor.get("requestIds"):
                    continue
                effect_id = f"agent:{chain['instanceId']}:{chain['runId']}:{invocation['invocationKey']}"
                completed_effects = [event for event in events if event.get("runId") == chain["runId"]
                    and event.get("nodeId") == invocation.get("nodeId") and event.get("type") == "workflow.effect.completed"
                    and event.get("payload", {}).get("operation") == "ai.agent"
                    and event.get("payload", {}).get("effectId") == effect_id]
                if not any(event["payload"].get("output", {}).get("output") == expected_review
                           and event["payload"]["output"].get("instance") == instance
                           and event["payload"]["output"].get("hostReceipt") == invocation.get("hostReceipt")
                           for event in completed_effects):
                    continue
                request_ids = []
                for request_id, message_json in database.execute(
                    "select m.request_id,m.message_json from provider_request_messages m "
                    "join provider_requests p on p.id=m.request_id where p.actor_id=? and m.role='user'", (actor_id,)):
                    message = json.loads(message_json)
                    try:
                        payload = json.loads(message.get("content", ""))
                    except (TypeError, json.JSONDecodeError):
                        continue
                    if (isinstance(payload, dict) and payload.get("schemaVersion") == "eidolon.agent-execution-input/v1"
                            and payload.get("payload") == invocation.get("input")):
                        request_ids.append(request_id)
                if request_ids:
                    joined.append({"workflowInstanceId": chain["instanceId"], "runId": chain["runId"],
                        "invocationKey": invocation["invocationKey"], "effectId": effect_id,
                        "agentInstanceId": actor_id, "agentDefinitionRef": instance["agentDefinitionRef"],
                        "requestIds": sorted(set(request_ids)), "actualAgentOutput": expected_review,
                        "actualPricing": pricing})
    return {"scenario": "ctrl", "expected": {"orderId": "order-315", "totalCents": 950, "agentApproved": True},
            "agentJoins": joined, "satisfied": bool(joined),
            "reason": None if joined else "no successful checkpoint/effect/Agent-provider join for this Ctrl run"}
