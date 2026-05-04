#!/usr/bin/env bash
# Upgrade existing agents' CLAUDE.md to teach the file-send markers.
#
# Why this exists: src/agent-create.ts now appends a "Sending Files via
# Telegram" section to every newly-created agent's CLAUDE.md so they
# know they can use [SEND_FILE:...] and [SEND_PHOTO:...] markers in
# their replies. Existing agents created before that change are missing
# the section — the symptom is the agent saying things like "I don't
# have a tool to send files" or just printing the file path as text.
#
# This script appends the same section to any agent's CLAUDE.md that
# lacks it, in BOTH locations the loader reads from:
#   - $CLAUDECLAW_CONFIG/agents/<id>/CLAUDE.md (preferred, ~/.claudeclaw)
#   - PROJECT_ROOT/agents/<id>/CLAUDE.md (fallback, repo)
#
# Idempotent — safe to run multiple times. Skips files that already
# mention SEND_FILE or SEND_PHOTO.
#
# Usage: bash scripts/upgrade-agent-claude-md.sh

set -euo pipefail

PROJECT_ROOT=$(git rev-parse --show-toplevel)
CONFIG_ROOT="${CLAUDECLAW_CONFIG:-$HOME/.claudeclaw}"

SECTION='
## Sending Files via Telegram

When the user asks you to create a file and send it back (PDF, spreadsheet, image, screenshot, etc.), include a file marker in your response. The bot wrapper parses these markers and sends the files as Telegram attachments — you do NOT call any tool, just include the literal marker text in your reply.

**Syntax:**
- `[SEND_FILE:/absolute/path/to/file.pdf]` — sends as a document attachment
- `[SEND_PHOTO:/absolute/path/to/image.png]` — sends as an inline photo
- `[SEND_FILE:/absolute/path/to/file.pdf|Optional caption]` — with a caption

**Rules:**
- Always use absolute paths (no `~`, no relative paths)
- Create the file first, then include the marker
- Place the marker on its own line
- Multiple markers in one response are fine
- Max file size: 50 MB (Telegram limit)
- The marker text gets stripped from the visible message

**Example:**
```
Here'\''s the report you asked for.
[SEND_FILE:/tmp/q1-report.pdf|Q1 2026 Report]
```

For images you generated, prefer `[SEND_PHOTO:...]` so they preview inline.

### Do NOT try to send files any other way

The marker is the ONLY supported way to send files back to the user. Specifically, **do not**:

- `curl https://api.telegram.org/bot<token>/sendDocument` — your subprocess does not have a valid token in its env, and any token you find by reading `.env` belongs to a DIFFERENT bot (the main bot or another sub-agent), not yours. You will get a 401 and waste a turn diagnosing it.
- Use the `plugin:telegram:telegram` MCP skill (`reply`, `download_attachment`, etc.) to send outgoing files. That skill is wired to a Claude-in-Chrome / @claude.ai session, not your agent'\''s own bot, and its stored token may be stale or unrelated. Use that skill ONLY for incoming attachments the user sent you.
- Read the user-uploaded file with the `Read` tool and paste base64 / hex into chat. The marker handles binary properly.

If a marker doesn'\''t appear to send and the user asks why, say so plainly — DO NOT fall back to one of the above paths.

## Setting Your Profile Picture (the bot'\''s avatar on Telegram)

If the user asks you to "set this as your profile picture" or "make this your avatar," **you cannot do this via any API or skill.** The Telegram Bot API has no `setMyProfilePhoto` method. The avatar Telegram users see for your bot can ONLY be changed by:

1. **The dashboard'\''s per-agent avatar uploader** (Agents tab → click your card → camera icon on the avatar). That sets the avatar shown inside ClaudeClaw — NOT the one on Telegram.
2. **@BotFather → /setuserpic** in Telegram, by the bot owner. This is the only way to change what Telegram shows.

When asked, **respond with that explanation** and mention the file path of the image you generated so the user can re-use it for the @BotFather step. **Do not**:

- Run `curl ... /setProfilePhoto` or any sendMessage to BotFather (you can'\''t act as the user)
- Spawn the `banana-squad` or any image-generation pipeline a second time
- Save the file to a different path hoping the avatar will pick it up
- Suggest "I'\''ve updated my profile picture" — you have not, and the user will see no change

Sample reply when asked:
> I can'\''t set my own Telegram avatar — Telegram'\''s Bot API doesn'\''t expose that and it has to go through @BotFather. The image is saved at `~/.claudeclaw/agents/<id>/profile.png`. To set it on Telegram: open @BotFather, send /setuserpic, pick this bot, and upload that file.
'

# Sentinel that distinguishes this latest "no-curl + no-avatar-loop"
# version from older variants. Re-runs of the script after pulling new
# commits will see the missing sentinel and rewrite the section.
SENTINEL='Setting Your Profile Picture'

patched=0
strengthened=0
skipped=0

patch_one() {
  local target="$1"
  if [ ! -f "$target" ]; then return; fi
  if grep -qF "$SENTINEL" "$target"; then
    echo "  skip $target (already has full file-send + don'\''t-curl section)"
    skipped=$((skipped+1))
    return
  fi
  if grep -q 'SEND_FILE\|SEND_PHOTO' "$target"; then
    # Old version — strip out any existing "Sending Files via Telegram"
    # AND any existing "Setting Your Profile Picture" section, then
    # append the latest combined version. The awk recognises both
    # headings as "in old block" and skips lines until the next
    # unrelated `## ` heading.
    awk '
      /^## Sending Files via Telegram/      { in_old=1; next }
      /^## Setting Your Profile Picture/    { in_old=1; next }
      in_old && /^## / { in_old=0 }
      !in_old { print }
    ' "$target" > "$target.tmp" && mv "$target.tmp" "$target"
    printf '%s\n' "$SECTION" >> "$target"
    echo "  strengthened $target (replaced short/old section with full version)"
    strengthened=$((strengthened+1))
    return
  fi
  printf '%s\n' "$SECTION" >> "$target"
  echo "  patched $target (added full section)"
  patched=$((patched+1))
}

# Walk both candidate roots. Use whichever directories exist.
for root in "$CONFIG_ROOT/agents" "$PROJECT_ROOT/agents"; do
  if [ ! -d "$root" ]; then continue; fi
  for dir in "$root"/*/; do
    id=$(basename "$dir")
    [ "$id" = "_template" ] && continue
    patch_one "$dir/CLAUDE.md"
  done
done

echo
echo "Done. Patched: $patched, strengthened: $strengthened, skipped: $skipped."
echo "Agents pick up the change on their next turn — no restart needed."
