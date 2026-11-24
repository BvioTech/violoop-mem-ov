# Copyright (c) 2026 Beijing Volcano Engine Technology Co., Ltd.
# SPDX-License-Identifier: AGPL-3.0
"""Shared grammar for reserved ``MEMORY_FIELDS`` comments."""

from __future__ import annotations

import json
import re
from typing import Match, Optional

MEMORY_FIELDS_COMMENT_RE = re.compile(r"<!--\s*MEMORY_FIELDS\b(?P<fields>[\s\S]*?)\s*-->")
PRESERVE_BODY_WHITESPACE = "preserve_body_whitespace"


def find_memory_fields_trailer(content: str) -> Optional[Match[str]]:
    """Return the reserved comment when it is the final content element."""
    trailer = None
    for match in MEMORY_FIELDS_COMMENT_RE.finditer(content):
        if not content[match.end() :].strip():
            trailer = match
    return trailer


def strip_memory_fields_trailer(content: str) -> str:
    """Remove all trailing reserved comments and their whitespace separators."""
    visible = content
    while match := find_memory_fields_trailer(visible):
        raw_fields = match.group("fields")
        if PRESERVE_BODY_WHITESPACE in raw_fields:
            try:
                fields = json.loads(raw_fields)
            except ValueError:
                fields = None
            if isinstance(fields, dict) and fields.get(PRESERVE_BODY_WHITESPACE) is True:
                return visible[: match.start()].removesuffix("\n\n")
        visible = visible[: match.start()].rstrip()
    return visible
