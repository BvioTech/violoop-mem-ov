"""Build retrieval-only queries from VioLoop's structured migration messages.

Never change the messages used for extraction. Unknown input formats return
None so the caller can use its original conversation query builder.
"""
from __future__ import annotations

import json
from typing import Any


def _text(value: Any) -> str:
    return " ".join(str(value).split()) if value is not None else ""


def _values(value: Any) -> list[str]:
    values = value if isinstance(value, list) else [value]
    return list(dict.fromkeys(text for item in values if (text := _text(item))))


def _properties(value: Any) -> list[str]:
    if not isinstance(value, dict):
        return []
    # These are user knowledge attributes, not the record's transport metadata.
    # Keep their names: e.g. a property's 'status' or 'date' changes its meaning.
    return [
        f"{_text(key)}: {_text(item) if not isinstance(item, (dict, list)) else json.dumps(item, ensure_ascii=False)}"
        for key, item in value.items() if item is not None and item != ""
    ]


def _identity(entity: dict) -> str:
    return " / ".join(dict.fromkeys([
        *_values(entity.get("name")), *_values(entity.get("type")),
        *_values(entity.get("aliases")),
    ]))


def _entity(entity: dict) -> list[str]:
    return [
        _identity(entity), *_values(entity.get("observations")),
        *_properties(entity.get("properties")), *_values(entity.get("domains")),
    ]


def _relation(relation: dict) -> list[str]:
    source, target = relation.get("source"), relation.get("target")
    if not isinstance(source, dict) or not isinstance(target, dict):
        raise ValueError("Unrecognized relation endpoints")
    source_name, target_name = _identity(source), _identity(target)
    kind = _text(relation.get("relationType"))
    if not source_name or not target_name or not kind:
        raise ValueError("Incomplete relation identity")
    result = [f"{source_name} — {kind} → {target_name}", *_properties(relation.get("properties"))]
    if relation.get("validUntil"):
        result.append(f"有效期至 {_text(relation['validUntil'])}")
    return result


def _groups(payload: dict) -> list[list[str]]:
    if "entry" in payload:
        entry = payload["entry"]
        entities, relations = payload.get("entities", []), payload.get("relations", [])
        if not isinstance(entry, dict) or not isinstance(entities, list) or not isinstance(relations, list):
            raise ValueError("Unrecognized entry group")
        return [[
            " / ".join(dict.fromkeys([
                *_values(entry.get("title")), *_values(entry.get("tags")), *_values(entry.get("type")),
            ])),
            _text(entry.get("content")),
        ], *[_entity(entity) for entity in entities], *[_relation(relation) for relation in relations]]
    if "relationType" in payload:
        return [_relation(payload)]
    if "name" in payload:
        return [_entity(payload)]
    raise ValueError("Unrecognized migration unit")


def _budgets(lengths: list[int], limit: int, separator: str) -> list[int]:
    """Share space evenly, returning unused space from shorter items."""
    remaining = max(0, limit - len(separator) * (len(lengths) - 1))
    budgets = [0] * len(lengths)
    active = list(range(len(lengths)))
    while active and remaining:
        share, extra = divmod(remaining, len(active))
        for position, index in enumerate(active):
            take = min(lengths[index] - budgets[index], share + (position < extra))
            budgets[index] += take
            remaining -= take
        active = [index for index in active if budgets[index] < lengths[index]]
    return budgets


def _clip(text: str, limit: int) -> str:
    if len(text) <= limit:
        return text
    return text[:limit - 1].rstrip() + "…" if limit > 1 else text[:limit]


def build_legacy_migration_query(messages: list, max_chars: int) -> str | None:
    """Keep every unit eligible for the shared character budget.

    Exact duplicate cards/relations are omitted across units, but a different
    fact about the same entity retains its identity. IDs, record timestamps,
    confidence, decay and migration instructions are never selected.
    """
    units: list[list[str]] = []
    seen: set[tuple[str, ...]] = set()
    for message in messages:
        if getattr(message, "role", "") != "user":
            return None
        parts = getattr(message, "parts", [])
        if not parts:
            return None
        unit = []
        for part in parts:
            raw = getattr(part, "text", None)
            if not isinstance(raw, str):
                return None
            # The planner emits one compact JSON object after this header.
            # Parse the payload instead of treating wrapper text as keywords.
            _, marker, tail = raw.partition("\n记录时间：")
            _, newline, body = tail.partition("\n")
            if not marker or not newline:
                return None
            try:
                payload = json.loads(body)
                if not isinstance(payload, dict):
                    return None
                groups = _groups(payload)
            except (ValueError, TypeError, AttributeError):
                return None
            for group in groups:
                fragments = tuple(dict.fromkeys(text for item in group if (text := _text(item))))
                if fragments and fragments not in seen:
                    seen.add(fragments)
                    unit.append("\n".join(fragments))
        if unit:
            units.append(unit)
    if not units:
        return None

    # First share across migration units, then across their entry/entity/edge
    # cards. A large early note or hub must not crowd out later units or edges.
    sizes = [sum(map(len, unit)) + len(unit) - 1 for unit in units]
    budgets = _budgets(sizes, max_chars, "\n\n")
    rendered = []
    for unit, budget in zip(units, budgets):
        card_budgets = _budgets(list(map(len, unit)), budget, "\n")
        rendered.append("\n".join(_clip(card, size) for card, size in zip(unit, card_budgets) if size))
    return "\n\n".join(text for text in rendered if text)[:max_chars]
