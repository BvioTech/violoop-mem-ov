"""Readable legacy migration sources; no model calls or archive/file writes."""
import json
import re

_HIDDEN_KEY = re.compile(r"^(id|.*_id|.*Id|key|curated|decay|embedding|vector)$")


def _text(value):
    return value if isinstance(value, str) else ""


def _readable(value):
    if value is None or value == "":
        return ""
    if isinstance(value, list):
        return "；".join(filter(None, (_readable(v) for v in value)))
    if isinstance(value, dict):
        return "\n".join(f"{k}：{body}" for k, v in value.items()
                         if not _HIDDEN_KEY.fullmatch(k) and (body := _readable(v)))
    if isinstance(value, bool):
        return "是" if value else "否"
    return str(value)


def _records(message):
    source_ids = getattr(message, "source_message_ids", None)
    if not source_ids or not all(str(i).startswith("violoop-legacy-migration:") for i in source_ids):
        raise ValueError("Expected a verified legacy migration source")
    body = "\n".join(p.text for p in message.parts if getattr(p, "type", None) == "text")
    start = body.find("\n{")
    if start < 0:
        raise ValueError("Migration source has no structured record")
    payload = json.loads(body[start + 1:])
    records = []

    def add(kind, title, content, date=""):
        records.append((kind, _text(title), content, _text(date)))

    def entity(e):
        observations = "\n\n".join(filter(None, (_readable(o) for o in e.get("observations", []))))
        facts = "\n\n".join(filter(None, [observations, _readable(e.get("properties"))]))
        add("实体", e.get("name"), facts)

    def relation(r):
        title = " → ".join(filter(None, [_text(r.get("source", {}).get("name")),
                                        _text(r.get("relationType")), _text(r.get("target", {}).get("name"))]))
        facts = [_readable(r.get("properties"))]
        if r.get("confidence") is not None:
            facts.append(f"置信度：{r['confidence']}")
        if r.get("validUntil"):
            facts.append(f"有效期：{r['validUntil']}")
        add("关系", title, "\n\n".join(filter(None, facts)))

    if isinstance(payload.get("entry"), dict):
        entry = payload["entry"]
        add("旧记忆", entry.get("title"), _text(entry.get("content")), entry.get("updatedAt"))
        for e in payload.get("entities", []):
            entity(e)
        for r in payload.get("relations", []):
            relation(r)
    elif "source" in payload and "target" in payload:
        relation(payload)
    elif "name" in payload:
        entity(payload)
    else:
        raise ValueError("Unsupported legacy migration record")
    return records


def render_migration_sources(messages, message_ids):
    """Render full referenced records, deduplicated, in source-message order."""
    by_id = {m.id: m for m in messages}
    sections, seen = [], set()
    for mid in dict.fromkeys(message_ids):
        if mid not in by_id:
            raise ValueError("Referenced original migration message is missing")
        for kind, title, content, date in _records(by_id[mid]):
            record = (kind, title, content, date)
            if record in seen:
                continue
            seen.add(record)
            # Titles are data, not Markdown instructions. Keep them on one line.
            title = re.sub(r"[\r\n]+", " ", title)
            title = re.sub(r"([\\`*_{}\[\]<>])", r"\\\1", title)
            section = f"## {kind}：{title}"
            if date:
                section += f"\n\n记录时间：{date}"
            if content:
                section += "\n\n" + content
            sections.append(section)
    return "\n\n".join(sections)
