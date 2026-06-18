#!/usr/bin/env python3
"""Convert one local document to Markdown and write only the result to stdout."""

import argparse
import sys
from pathlib import Path

from markitdown import MarkItDown


def main() -> int:
    parser = argparse.ArgumentParser(description="Convert a document to Markdown")
    parser.add_argument("file_path", help="Path to the document to convert")
    args = parser.parse_args()

    source = Path(args.file_path).resolve(strict=True)
    if not source.is_file():
        raise ValueError("Input path is not a file")

    result = MarkItDown().convert(str(source))
    markdown = (result.text_content or "").strip()
    sys.stdout.write(markdown)
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:  # Keep document contents out of error output.
        print(f"MarkItDown conversion failed: {type(error).__name__}", file=sys.stderr)
        raise SystemExit(1)
