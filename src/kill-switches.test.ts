import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as ks from './kill-switches.js';

const SAVE_KEYS = [
  'WARROOM_TEXT_ENABLED',
  'WARROOM_VOICE_ENABLED',
  'LLM_SPAWN_ENABLED',
  'DASHBOARD_MUTATIONS_ENABLED',
  'MISSION_AUTO_ASSIGN_ENABLED',
  'SCHEDULER_ENABLED',
] as const;

describe('kill-switches', () => {
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    saved = {};
    for (const k of SAVE_KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
    ks._reset();
  });

  afterEach(() => {
    for (const k of SAVE_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    ks._reset();
  });

  it('defaults to enabled when unset', () => {
    expect(ks.isEnabled('WARROOM_TEXT_ENABLED')).toBe(true);
    expect(ks.isEnabled('LLM_SPAWN_ENABLED')).toBe(true);
  });

  it('treats "false" / "0" / "no" / "off" / "disabled" as off', () => {
    process.env.WARROOM_TEXT_ENABLED = 'false';
    ks._reset();
    expect(ks.isEnabled('WARROOM_TEXT_ENABLED')).toBe(false);

    for (const v of ['0', 'no', 'off', 'disabled', 'FALSE', 'No']) {
      process.env.WARROOM_TEXT_ENABLED = v;
      ks._reset();
      expect(ks.isEnabled('WARROOM_TEXT_ENABLED')).toBe(false);
    }
  });

  it('treats other values as enabled', () => {
    for (const v of ['true', '1', 'yes', 'on', 'enabled', 'whatever']) {
      process.env.WARROOM_TEXT_ENABLED = v;
      ks._reset();
      expect(ks.isEnabled('WARROOM_TEXT_ENABLED')).toBe(true);
    }
  });

  it('snapshot returns all switches', () => {
    const snap = ks.snapshot();
    for (const k of SAVE_KEYS) {
      expect(snap).toHaveProperty(k);
      expect(typeof snap[k]).toBe('boolean');
    }
  });

  it('isolated flags do not affect each other', () => {
    process.env.WARROOM_VOICE_ENABLED = 'false';
    ks._reset();
    expect(ks.isEnabled('WARROOM_VOICE_ENABLED')).toBe(false);
    expect(ks.isEnabled('WARROOM_TEXT_ENABLED')).toBe(true);
    expect(ks.isEnabled('LLM_SPAWN_ENABLED')).toBe(true);
  });

  describe('requireEnabled', () => {
    it('does not throw when the switch is on', () => {
      ks._reset();
      expect(() => ks.requireEnabled('LLM_SPAWN_ENABLED')).not.toThrow();
    });

    it('throws KillSwitchDisabledError when the switch is off', () => {
      process.env.LLM_SPAWN_ENABLED = 'false';
      ks._reset();
      expect(() => ks.requireEnabled('LLM_SPAWN_ENABLED')).toThrow(ks.KillSwitchDisabledError);
    });

    it('error carries the switch name for callers to surface', () => {
      process.env.WARROOM_TEXT_ENABLED = 'false';
      ks._reset();
      try {
        ks.requireEnabled('WARROOM_TEXT_ENABLED');
        expect.fail('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(ks.KillSwitchDisabledError);
        expect((err as ks.KillSwitchDisabledError).switchName).toBe('WARROOM_TEXT_ENABLED');
      }
    });

    it('refusalCounts increments on each refusal', () => {
      process.env.LLM_SPAWN_ENABLED = 'false';
      ks._reset();
      const before = ks.refusalCounts()['LLM_SPAWN_ENABLED'] || 0;
      try { ks.requireEnabled('LLM_SPAWN_ENABLED'); } catch {}
      try { ks.requireEnabled('LLM_SPAWN_ENABLED'); } catch {}
      const after = ks.refusalCounts()['LLM_SPAWN_ENABLED'] || 0;
      expect(after - before).toBe(2);
    });
  });
});
