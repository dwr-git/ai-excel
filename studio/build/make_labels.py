#!/usr/bin/env python3
"""Russian names for the assistant's command search.

Reads the Russian interface catalog AI-Excel is built with (crates/ui-egui/src/i18n/ru.rs: match arms
`"English" => "Русский",`) and writes studio/ru-labels.json:

    {"text": {"Sort A to Z": "Сортировка от А до Я", ...}}

The assistant panel uses it to show and search commands (their labels and ribbon-path segments) in
Russian. Run by studio/build/package.sh.
"""

import json
import re
import sys
from pathlib import Path

# `"English" => "Русский",` on one line, or rustfmt's block form for long arms:
# `"English" => {` / `"Русский"` / `}`.
ARM = re.compile(r'^\s*"((?:[^"\\]|\\.)*)"\s*=>\s*"((?:[^"\\]|\\.)*)",\s*$')
OPEN = re.compile(r'^\s*"((?:[^"\\]|\\.)*)"\s*=>\s*\{\s*$')
VALUE = re.compile(r'^\s*"((?:[^"\\]|\\.)*)"\s*$')


def unescape(s: str) -> str:
    return s.encode("utf-8").decode("unicode_escape").encode("latin-1").decode("utf-8") if "\\" in s else s


def main() -> int:
    root = Path(__file__).resolve().parents[2]
    src = root / "crates" / "ui-egui" / "src" / "i18n" / "ru.rs"
    dst = Path(sys.argv[1]) if len(sys.argv) > 1 else Path("ru-labels.json")
    text: dict[str, str] = {}
    if not src.is_file():
        print(f"warning: {src} not found; command names stay English", file=sys.stderr)
    else:
        lines = src.read_text(encoding="utf-8").splitlines()
        for i, line in enumerate(lines):
            m = ARM.match(line)
            pair = (m.group(1), m.group(2)) if m else None
            if not pair:
                o = OPEN.match(line)
                v = VALUE.match(lines[i + 1]) if o and i + 1 < len(lines) else None
                pair = (o.group(1), v.group(1)) if o and v else None
            if not pair:
                continue
            try:
                text[unescape(pair[0])] = unescape(pair[1])
            except UnicodeError:
                continue
    dst.parent.mkdir(parents=True, exist_ok=True)
    dst.write_text(json.dumps({"text": text}, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"{dst}: {len(text)} labels")
    return 0


if __name__ == "__main__":
    sys.exit(main())
