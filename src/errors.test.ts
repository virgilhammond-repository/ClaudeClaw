import { describe, it, expect } from 'vitest';
import { classifyError, AgentError, isAuthErrorText, authError } from './errors.js';

describe('classifyError', () => {
  // ── Category detection ──────────────────────────────────────────────

  it('classifies rate limit errors', () => {
    const err = new Error('Request failed: 429 Too Many Requests');
    const classified = classifyError(err);
    expect(classified).toBeInstanceOf(AgentError);
    expect(classified.category).toBe('rate_limit');
    expect(classified.recovery.shouldRetry).toBe(true);
    expect(classified.recovery.retryAfterMs).toBeGreaterThan(0);
  });

  it('classifies rate limit from "rate limit" text', () => {
    const classified = classifyError(new Error('rate limit exceeded'));
    expect(classified.category).toBe('rate_limit');
  });

  it('classifies rate limit from "throttled" text', () => {
    const classified = classifyError(new Error('request throttled'));
    expect(classified.category).toBe('rate_limit');
  });

  it('classifies authentication errors', () => {
    const err = new Error('unauthorized: invalid api key');
    const classified = classifyError(err);
    expect(classified.category).toBe('auth');
    expect(classified.recovery.shouldRetry).toBe(false);
    expect(classified.recovery.userMessage).toContain('claude login');
  });

  it('classifies OAuth token expired as auth', () => {
    const classified = classifyError(new Error('OAuth token expired'));
    expect(classified.category).toBe('auth');
  });

  it('classifies an unauthenticated code-1 exit as auth, not a retryable crash (#48)', () => {
    // The Claude CLI exits with code 1 and an auth phrase when it has no
    // credentials (headless deploy). This must NOT be a retryable subprocess
    // crash, or ClaudeClaw retries forever with no actionable message.
    const classified = classifyError(new Error('Command failed: claude exited with code 1\nNo credentials found, please run claude login'));
    expect(classified.category).toBe('auth');
    expect(classified.recovery.shouldRetry).toBe(false);
    expect(classified.recovery.userMessage).toContain('CLAUDE_CODE_OAUTH_TOKEN');
  });

  it('isAuthErrorText detects the unauthenticated CLI result text (#48)', () => {
    // Verified: an unauthenticated `claude` returns is_error result text
    // "Not logged in · Please run /login". The SDK adapter uses this to raise
    // an auth error at the source instead of surfacing it as a normal reply.
    expect(isAuthErrorText('Not logged in · Please run /login')).toBe(true);
    expect(isAuthErrorText('Here is your answer.')).toBe(false);
  });

  it('authError() is a non-retryable auth error with deploy guidance (#48)', () => {
    const e = authError();
    expect(e.category).toBe('auth');
    expect(e.recovery.shouldRetry).toBe(false);
    expect(e.recovery.userMessage).toContain('CLAUDE_CODE_OAUTH_TOKEN');
  });

  it('classifies billing errors', () => {
    const err = new Error('402 Payment Required: insufficient credits');
    const classified = classifyError(err);
    expect(classified.category).toBe('billing');
    expect(classified.recovery.shouldRetry).toBe(false);
    expect(classified.recovery.shouldSwitchModel).toBe(true);
  });

  it('classifies overloaded errors', () => {
    const err = new Error('529 overloaded');
    const classified = classifyError(err);
    expect(classified.category).toBe('overloaded');
    expect(classified.recovery.shouldRetry).toBe(true);
    expect(classified.recovery.shouldSwitchModel).toBe(true);
  });

  it('classifies 503 service unavailable as overloaded', () => {
    const classified = classifyError(new Error('503 Service Unavailable'));
    expect(classified.category).toBe('overloaded');
  });

  it('classifies network errors', () => {
    const err = new Error('getaddrinfo ENOTFOUND api.anthropic.com');
    const classified = classifyError(err);
    expect(classified.category).toBe('network');
    expect(classified.recovery.shouldRetry).toBe(true);
  });

  it('classifies ECONNREFUSED as network', () => {
    const classified = classifyError(new Error('connect ECONNREFUSED 127.0.0.1:443'));
    expect(classified.category).toBe('network');
  });

  it('classifies timeout errors', () => {
    const err = new Error('Request timed out after 30000ms');
    const classified = classifyError(err);
    expect(classified.category).toBe('timeout');
    expect(classified.recovery.shouldRetry).toBe(true);
  });

  it('classifies context length errors', () => {
    const err = new Error('maximum context length exceeded');
    const classified = classifyError(err);
    expect(classified.category).toBe('context_exhausted');
    expect(classified.recovery.shouldNewChat).toBe(true);
    expect(classified.recovery.shouldRetry).toBe(false);
  });

  // ── Context exhaustion via exit code ────────────────────────────────

  it('classifies exit code 1 with context tokens as context_exhausted', () => {
    const err = new Error('Process exited with code 1');
    const classified = classifyError(err, 950000);
    expect(classified.category).toBe('context_exhausted');
    expect(classified.recovery.shouldNewChat).toBe(true);
    expect(classified.recovery.userMessage).toContain('950k');
  });

  it('classifies exit code 1 without context tokens as subprocess_crash', () => {
    const err = new Error('Process exited with code 1');
    const classified = classifyError(err);
    expect(classified.category).toBe('subprocess_crash');
    expect(classified.recovery.shouldRetry).toBe(true);
  });

  it('classifies other exit codes as subprocess_crash', () => {
    const err = new Error('Process exited with code 137');
    const classified = classifyError(err);
    expect(classified.category).toBe('subprocess_crash');
    expect(classified.recovery.shouldRetry).toBe(true);
  });

  it('classifies Codex ACP missing command with Codex-specific guidance', () => {
    const err = new Error('Failed to start ACP provider command "codex-acp": spawn codex-acp ENOENT.');
    const classified = classifyError(err);
    expect(classified.category).toBe('subprocess_crash');
    expect(classified.recovery.shouldRetry).toBe(false);
    expect(classified.recovery.userMessage).toContain('Codex ACP');
    expect(classified.recovery.userMessage).toContain('signed-in Codex CLI');
  });

  it('classifies custom ACP missing command without blaming OpenCode', () => {
    const err = new Error('Failed to start ACP provider command "my-agent": spawn my-agent ENOENT.');
    const classified = classifyError(err);
    expect(classified.category).toBe('subprocess_crash');
    expect(classified.recovery.userMessage).toContain('my-agent');
    expect(classified.recovery.userMessage).not.toContain('OpenCode');
  });

  // ── Unknown errors ──────────────────────────────────────────────────

  it('classifies unknown errors as unknown', () => {
    const err = new Error('something completely unexpected');
    const classified = classifyError(err);
    expect(classified.category).toBe('unknown');
    expect(classified.recovery.shouldRetry).toBe(false);
  });

  it('handles non-Error inputs', () => {
    const classified = classifyError('string error');
    expect(classified).toBeInstanceOf(AgentError);
    expect(classified.category).toBe('unknown');
  });

  it('handles null/undefined inputs', () => {
    const classified = classifyError(undefined);
    expect(classified).toBeInstanceOf(AgentError);
  });

  // ── Recovery properties ─────────────────────────────────────────────

  it('rate_limit has positive retryAfterMs', () => {
    const classified = classifyError(new Error('rate limit'));
    expect(classified.recovery.retryAfterMs).toBeGreaterThan(0);
  });

  it('auth never suggests retry', () => {
    const classified = classifyError(new Error('unauthorized'));
    expect(classified.recovery.shouldRetry).toBe(false);
    expect(classified.recovery.shouldSwitchModel).toBe(false);
  });

  it('billing suggests switching model', () => {
    const classified = classifyError(new Error('insufficient credits'));
    expect(classified.recovery.shouldSwitchModel).toBe(true);
  });

  it('userMessage never contains stack traces', () => {
    const err = new Error('rate limit exceeded');
    err.stack = 'Error: rate limit exceeded\n    at Object.<anonymous> (/foo/bar.js:1:1)';
    const classified = classifyError(err);
    expect(classified.recovery.userMessage).not.toContain('/foo/bar.js');
    expect(classified.recovery.userMessage).not.toContain('at Object');
  });

  it('userMessage is always populated', () => {
    const categories = [
      new Error('rate limit'),
      new Error('unauthorized'),
      new Error('insufficient credits'),
      new Error('overloaded'),
      new Error('ENOTFOUND'),
      new Error('timed out'),
      new Error('context length'),
      new Error('exited with code 1'),
      new Error('total mystery'),
    ];
    for (const err of categories) {
      const classified = classifyError(err);
      expect(classified.recovery.userMessage.length).toBeGreaterThan(0);
    }
  });

  // ── originalError preserved ─────────────────────────────────────────

  it('preserves the original error', () => {
    const original = new Error('rate limit exceeded');
    const classified = classifyError(original);
    expect(classified.originalError).toBe(original);
  });

  // ── Case insensitivity ──────────────────────────────────────────────

  it('matches patterns case-insensitively', () => {
    expect(classifyError(new Error('RATE LIMIT EXCEEDED')).category).toBe('rate_limit');
    expect(classifyError(new Error('Unauthorized')).category).toBe('auth');
    expect(classifyError(new Error('OVERLOADED')).category).toBe('overloaded');
  });
});
