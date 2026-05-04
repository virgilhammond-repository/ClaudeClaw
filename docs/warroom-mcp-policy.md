# War-room tool & MCP policy

The text war room runs each agent's SDK call with a **default-deny** posture for side-effect tools. If your agent isn't on the per-agent allowlist below, it can only do read-only work (Read, Glob, Grep, WebSearch, WebFetch, TodoWrite). Bash, Write, Edit, Skill, and every MCP server require explicit opt-in.

This is enforced by `src/warroom-tool-policy.ts`, which sets `allowedTools` and `disallowedTools` on every war-room `query()` call in `src/warroom-text-orchestrator.ts`. `permissionMode: 'default'` (NOT bypass) so the SDK's permission machinery still applies.

## Always-allowed (read-only built-ins)

Every agent gets these regardless of opt-in:

- `Read` — read files inside cwd
- `Glob` — file path glob
- `Grep` — search file contents
- `WebSearch` — search the web (returns links + snippets)
- `WebFetch` — fetch a URL and read the response
- `TodoWrite` — UI-only, no side effects

## Always-denied (side-effect built-ins)

Listed in `disallowedTools` for every war-room call unless the agent's opt-in list explicitly grants them:

- `Bash` — shell access
- `Write` — file write
- `Edit` — file edit
- `NotebookEdit` — Jupyter notebook edits
- `ExitPlanMode` — plan-mode escape
- `Skill` — skill invocation (transitive access to anything the skill does)

## Default per-agent opt-ins

These ship in `DEFAULT_AGENT_ALLOWLISTS` (override via `agent.yaml`):

| Agent | Default opt-ins | Why |
|---|---|---|
| `main` | none | Host triages, doesn't usually do work directly |
| `ops` | `Bash`, `Skill` | Calendar (gcal.py), gmail skill |
| `comms` | `Bash`, `Skill` | gmail/slack skills, occasional script |
| `content` | `Skill`, `Write` | linkedin-post skill, drafts to `outputs/` |
| `research` | none | WebSearch (already in safe set) covers normal flow |

`Skill` is on the side-effect list because skills can do anything (browser, files, APIs). When an agent is opted into `Skill`, every skill they invoke is logged to `audit_log` so you can see which skills ran.

## Per-agent override via `agent.yaml`

Set `warroom_tools:` in `agents/<id>/agent.yaml`:

```yaml
warroom_tools:
  - Bash
  - Write
  - Skill
  - mcp:gmail        # opt-in to specific MCP servers, prefix with mcp:
  - mcp:google-calendar
```

Tokens that start with `mcp:` are mapped to MCP server names. Tokens without that prefix are SDK tool names (case-sensitive).

## MCP servers

By default, **no MCP servers** are exposed to war-room agents. To opt an agent into an MCP server, list it in `warroom_tools` with the `mcp:` prefix. The MCP server still has to be configured globally (in user / project Claude Code settings) — `warroom_tools` only allows access; it doesn't create the connection.

## What this closes

This policy was added to address three Codex-flagged compounding bypass paths in the original war-room implementation:

1. `permissionMode: 'bypassPermissions'` + `allowDangerouslySkipPermissions: true` skipped the SDK's permission UI entirely. Now: `permissionMode: 'default'`, no bypass.
2. `loadMcpServers()` was called without an allowlist, loading every user/project MCP into the war-room session. Now: `filterMcpServers()` drops anything not on the per-agent allowlist.
3. No `allowedTools`/`disallowedTools` policy meant Bash, Write, etc. fired freely. Now: read-only built-ins always allowed; side-effect built-ins always denied unless opted-in.

Combined with the per-meeting tool budget (8 calls per turn) and the audit log, an agent can no longer silently drive your browser, write files outside its lane, or fan out unbounded tool work in a single turn.

## Per-turn tool budget

Each war-room agent turn caps at **8 tool calls**. Past that the orchestrator emits a `system_note`, aborts the SDK subprocess, and the agent has to finalize with text. Strip still shows the calls that did fire.

This sits below the per-agent SDK `maxTurns` cap (8 specialist / 10 main) so it kicks in earlier on tool-heavy paths and prevents runaway loops.

## Audit log

Every tool call from a war-room turn writes a row to `audit_log`:

```sql
SELECT datetime(created_at, 'unixepoch', 'localtime'),
       agent_id, action, substr(detail, 1, 80)
FROM audit_log
WHERE action = 'tool_call'
ORDER BY created_at DESC LIMIT 20;
```

Use this for incident reconstruction: "what did Ops actually do during that 2pm war room?"
