#!/usr/bin/env bash
#
# Boot the war-room test/red-team environment in a fully isolated profile.
#
# WHY THIS EXISTS
#   Red-team / exfiltration tests run real prompts against a real SDK
#   subprocess. If they hit Mark's actual ~/.env, real DBs, or live
#   Telegram/Slack/Daily, a successful exploitation test would leak real
#   credentials, mutate real state, or send real messages. This script
#   guarantees those tests can never reach production state.
#
# WHAT IT DOES
#   1. Creates a fresh tmp dir at $AUDIT_TMP (export it before running, or
#      defaults to mktemp -d).
#   2. Generates an audit-only .env with canary tokens (SK_CANARY_<rand>
#      for each secret-shaped var).
#   3. Sets AUDIT_NO_EGRESS=1 so paid-API/outbound-send code paths refuse.
#   4. Refuses to start if it detects production state still in scope —
#      production OAuth token in env, $STORE_DIR pointing at the real DB,
#      $ALLOWED_CHAT_ID matching a real chat.
#   5. Invokes the script you pass as $@ with the isolated env applied.
#
# USAGE
#   ./scripts/audit-profile.sh node dist/some-redteam.js
#   AUDIT_TMP=/tmp/myaudit ./scripts/audit-profile.sh npm test
#
# This file is intentionally a separate shell script (not TS) so it runs
# before any Node code that might inherit the parent env.

set -euo pipefail

# ── Paranoia gates: refuse to run if production state is still in scope ─

PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

# Real OAuth token MUST NOT be in env. If it is, the SDK subprocess will
# auth as Mark and have access to his real Anthropic account.
if [[ -n "${CLAUDE_CODE_OAUTH_TOKEN:-}" ]]; then
  echo "REFUSING: CLAUDE_CODE_OAUTH_TOKEN is set in the parent env." >&2
  echo "  Run this script from a fresh shell with no inherited token." >&2
  exit 78
fi

# STORE_DIR pointing at the real production DB is a no-go. The audit
# profile MUST use its own DB so it can't read real transcripts.
if [[ -n "${STORE_DIR:-}" && "${STORE_DIR}" == "${PROJECT_ROOT}/store" ]]; then
  echo "REFUSING: STORE_DIR points at production store." >&2
  exit 78
fi

# ALLOWED_CHAT_ID matching a real chat would route any Telegram-style
# send to a real recipient. Reject — operators must clear it.
if [[ -n "${ALLOWED_CHAT_ID:-}" ]]; then
  echo "REFUSING: ALLOWED_CHAT_ID set ($ALLOWED_CHAT_ID). Clear it first." >&2
  exit 78
fi

# ── Build the isolated profile ──────────────────────────────────────

AUDIT_TMP="${AUDIT_TMP:-$(mktemp -d -t claudeclaw-audit-XXXXXX)}"
mkdir -p "$AUDIT_TMP/store" "$AUDIT_TMP/outputs" "$AUDIT_TMP/workspace" "$AUDIT_TMP/fakehome"

# Generate canary secrets — distinct random suffix per var so a leak in
# one place doesn't accidentally match another. If a red-team prompt
# successfully extracts SK_CANARY_<value>, we know which secret leaked.
rand() { openssl rand -hex 8 2>/dev/null || head -c 16 /dev/urandom | xxd -p; }

cat > "$AUDIT_TMP/.env" <<EOF
# AUDIT PROFILE — all values are canaries. Real credentials must never
# appear in this file. If you see a real secret here, abort and rotate.

# SDK auth. The subprocess will fail to authenticate; that's intentional —
# the red-team tests don't actually need a real model call to verify
# scrubbing logic.
CLAUDE_CODE_OAUTH_TOKEN=SK_CANARY_OAUTH_$(rand)
ANTHROPIC_API_KEY=SK_CANARY_ANTHROPIC_$(rand)

# Dashboard. A real attack would try to print this; the red-team test
# checks the response NEVER contains this exact string.
DASHBOARD_TOKEN=SK_CANARY_DASHBOARD_$(rand)
DASHBOARD_PORT=8989

# DB. Encrypted with a canary key over a tmp path. The audit DB should be
# a SCRUBBED copy of production (filenames + structure only, no real
# message bodies); generate it separately if you want one.
DB_ENCRYPTION_KEY=$(printf '0%.0s' {1..64})
STORE_DIR=$AUDIT_TMP/store

# Third-party APIs. Each gets a unique canary so we can detect WHICH
# secret a leaky agent extracted.
GROQ_API_KEY=SK_CANARY_GROQ_$(rand)
OPENAI_API_KEY=SK_CANARY_OPENAI_$(rand)
GOOGLE_API_KEY=SK_CANARY_GOOGLE_$(rand)
ELEVENLABS_API_KEY=SK_CANARY_ELEVENLABS_$(rand)
DAILY_API_KEY=SK_CANARY_DAILY_$(rand)
TELEGRAM_BOT_TOKEN=SK_CANARY_TELEGRAM_$(rand)
SLACK_USER_TOKEN=SK_CANARY_SLACK_$(rand)
RESEND_API_KEY=SK_CANARY_RESEND_$(rand)

# Hard kill: refuse to call any paid API or send any outbound message.
AUDIT_NO_EGRESS=1

# Sandboxes. The agent SDK and any subprocess sees only this fake home.
HOME=$AUDIT_TMP/fakehome

# Disable bot loops.
ALLOWED_CHAT_ID=
WHATSAPP_ENABLED=false
WARROOM_ENABLED=false
EOF
chmod 600 "$AUDIT_TMP/.env"

echo "Audit profile ready: $AUDIT_TMP"
echo "  .env (chmod 600) → $AUDIT_TMP/.env"
echo "  store dir       → $AUDIT_TMP/store"
echo "  outputs / work  → $AUDIT_TMP/{outputs,workspace}"
echo

if [[ $# -eq 0 ]]; then
  echo "Usage: $0 <command> [args...]"
  echo "Example: $0 node dist/some-redteam-test.js"
  exit 0
fi

# Execute the command with audit env applied. We use `env -i` to wipe the
# parent shell env entirely, then re-export only the values we want the
# child process to see. This eliminates leaked vars from .zshrc etc.
exec env -i \
  PATH="$PATH" \
  HOME="$AUDIT_TMP/fakehome" \
  AUDIT_TMP="$AUDIT_TMP" \
  AUDIT_NO_EGRESS=1 \
  $(grep -v '^#' "$AUDIT_TMP/.env" | grep -v '^$' | xargs) \
  "$@"
