#!/usr/bin/env python3
"""Raise Kong functions-v1 connect/write/read timeouts if below WANT_MS."""
from __future__ import annotations

import os
import re
import sys
from pathlib import Path

want = int(os.environ.get("TRANSLATE_VPS_KONG_TIMEOUT_MS", "300000"))
path = Path(os.environ.get("TRANSLATE_VPS_KONG_YML", "/root/supabase-translate/volumes/api/kong.yml"))
text = path.read_text()
changed = False

for key in ("connect_timeout", "write_timeout", "read_timeout"):
    pattern = re.compile(rf"(?m)^(\s*{key}:\s*)(\d+)\s*$")

    def repl(m: re.Match[str]) -> str:
        global changed
        cur = int(m.group(2))
        if cur < want:
            changed = True
            return f"{m.group(1)}{want}"
        return m.group(0)

    text, _ = pattern.subn(repl, text)

if changed:
    path.write_text(text)
    print(f"updated {path} timeouts to >= {want}ms")
else:
    print(f"{path} timeouts already >= {want}ms")
sys.exit(0)
