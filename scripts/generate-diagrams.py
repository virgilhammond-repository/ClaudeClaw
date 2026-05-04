"""Generate ClaudeClaw README diagrams via Nano Banana Pro (gemini-3-pro-image-preview).

Driven by a JSON manifest:
    [
      { "name": "hive-3d-brain.png",
        "prompt": "...",
        "aspect": "16:9" }   # 16:9 default; "9:16" or "1:1" supported
    ]

Style preamble is appended to every prompt so the whole set stays visually
coherent with the existing assets/voice-pipeline.jpeg + setup-flow.jpeg
aesthetic (dark mode terminal/schematic, monospace fonts, thin colored
borders, soft glow, subtle circuit-trace background).

Usage:
    python3 scripts/generate-diagrams.py manifest.json
        # writes each entry's PNG to assets/<name>

Requires GOOGLE_API_KEY in ~/.env or env. No retries on failure — re-run
the script with a manifest containing only the failed entries.
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
ASSETS_DIR = REPO_ROOT / "assets"
ENV_HOME = Path.home() / ".env"

STYLE_PREAMBLE = """
Render this as a technical schematic flowchart diagram. Pure black background (#070a13),
with a faint dark-blue circuit-trace texture barely visible in the corners — never
intrusive. Every label is in a sharp monospace font (JetBrains Mono / Fira Code style),
crisp anti-aliased, never blurry. Boxes are thin 1px rounded rectangles with colored
borders. Soft 4px outer glow on every border, matching the border color. Arrows are
thin 1px lines with small triangular arrowheads, color-matching the destination box.

Border palette (use sparingly, one color per logical group):
- Cyan #4FC3F7 — primary path / default
- Amber #FFB74D — branch / decision / emphasis
- Mint #81C784 — success / output
- Blue #64B5F6 — input / source
- Pink #F48FB1 — alternative variant
- Lavender #B39DDB — internal helper

Inside each box, the title is bold mono in the border color, with subtle dim grey body
text below for the description. Section headers are bold uppercase mono with a small
accent bar to the left in the section's color. No drop shadows. No bevels. No 3D. No
photorealism. No emoji unless explicitly requested. The whole composition feels like
an annotated chip-architecture diagram drawn by a meticulous engineer at 2am.

Do not put any text outside the diagram boxes except a small "ClaudeClaw" footer in
dim grey at the bottom-left and a small subtitle at the bottom-right.
""".strip()


def load_api_key() -> str:
    if "GOOGLE_API_KEY" in os.environ and os.environ["GOOGLE_API_KEY"]:
        return os.environ["GOOGLE_API_KEY"]
    if ENV_HOME.exists():
        for line in ENV_HOME.read_text().splitlines():
            if line.startswith("GOOGLE_API_KEY="):
                return line.split("=", 1)[1].strip().strip("\"'")
    raise SystemExit("GOOGLE_API_KEY not found in env or ~/.env")


def generate(prompt: str, out_path: Path, aspect: str = "16:9") -> None:
    from google import genai
    from google.genai import types

    client = genai.Client(api_key=load_api_key())
    full_prompt = f"{STYLE_PREAMBLE}\n\n{prompt}"

    print(f"-> {out_path.name} ({aspect})", flush=True)
    res = client.models.generate_content(
        model="gemini-3-pro-image-preview",
        contents=full_prompt,
        config=types.GenerateContentConfig(
            response_modalities=["IMAGE"],
            image_config=types.ImageConfig(aspect_ratio=aspect),
        ),
    )
    for part in res.candidates[0].content.parts:
        if getattr(part, "inline_data", None) and part.inline_data.data:
            out_path.parent.mkdir(parents=True, exist_ok=True)
            out_path.write_bytes(part.inline_data.data)
            print(f"   wrote {out_path}", flush=True)
            return
    raise RuntimeError(f"no image bytes returned for {out_path.name}")


def main(argv: list[str]) -> int:
    if len(argv) != 2:
        print("usage: generate-diagrams.py <manifest.json>", file=sys.stderr)
        return 2
    manifest = json.loads(Path(argv[1]).read_text())
    for entry in manifest:
        name = entry["name"]
        prompt = entry["prompt"]
        aspect = entry.get("aspect", "16:9")
        out = ASSETS_DIR / name
        if out.exists() and not entry.get("force"):
            print(f"skip (exists) {name}")
            continue
        try:
            generate(prompt, out, aspect)
        except Exception as e:
            print(f"FAILED {name}: {e}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
