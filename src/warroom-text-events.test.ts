import { describe, it, expect, beforeEach } from 'vitest';
import { MeetingChannel, _resetChannels } from './warroom-text-events.js';

describe('MeetingChannel', () => {
  beforeEach(() => {
    _resetChannels();
  });

  describe('emit / since / replay', () => {
    it('assigns monotonically increasing seqs', () => {
      const ch = new MeetingChannel();
      const a = ch.emit({ type: 'ping' });
      const b = ch.emit({ type: 'ping' });
      const c = ch.emit({ type: 'ping' });
      expect(b).toBe(a + 1);
      expect(c).toBe(b + 1);
    });

    it('since() returns events newer than the cursor', () => {
      const ch = new MeetingChannel();
      ch.emit({ type: 'ping' });
      const cursor = ch.latestSeq();
      ch.emit({ type: 'system_note', text: 'a', tone: 'info', dismissable: true });
      ch.emit({ type: 'system_note', text: 'b', tone: 'info', dismissable: true });
      const replay = ch.since(cursor);
      expect(replay).toHaveLength(2);
      expect((replay[0].event as any).text).toBe('a');
      expect((replay[1].event as any).text).toBe('b');
    });

    it('ring buffer drops old entries past maxBuffer', () => {
      const ch = new MeetingChannel(3);
      ch.emit({ type: 'ping' });
      ch.emit({ type: 'ping' });
      ch.emit({ type: 'ping' });
      ch.emit({ type: 'ping' });
      // Buffer should hold 3 most-recent events; oldest seq should be 2.
      expect(ch.oldestSeq()).toBe(2);
      expect(ch.latestSeq()).toBe(4);
    });
  });

  describe('finalizedTurns guard', () => {
    it('drops late chunks for a finalized turn (returns -1, no fanout)', () => {
      const ch = new MeetingChannel();
      const turnId = 't1';
      const seenSeqs: number[] = [];
      ch.subscribe((entry) => seenSeqs.push(entry.seq));

      const beforeFinalize = ch.emit({
        type: 'agent_chunk', turnId, agentId: 'main', role: 'primary', delta: 'hi',
      });
      expect(beforeFinalize).toBeGreaterThan(0);
      expect(seenSeqs).toHaveLength(1);

      ch.markTurnFinalized(turnId);

      const afterFinalize = ch.emit({
        type: 'agent_chunk', turnId, agentId: 'main', role: 'primary', delta: 'late',
      });
      expect(afterFinalize).toBe(-1);
      expect(seenSeqs).toHaveLength(1); // late chunk did NOT fan out
    });

    it('still delivers events for unrelated turns after finalizing one', () => {
      const ch = new MeetingChannel();
      ch.markTurnFinalized('finalized-turn');
      const ok = ch.emit({
        type: 'agent_chunk', turnId: 'live-turn', agentId: 'main', role: 'primary', delta: 'hi',
      });
      expect(ok).toBeGreaterThan(0);
    });

    it('finalizing a turn is idempotent', () => {
      const ch = new MeetingChannel();
      ch.markTurnFinalized('t1');
      ch.markTurnFinalized('t1');
      expect(ch.isTurnFinalized('t1')).toBe(true);
    });

    it('caps the finalized set so memory does not grow unbounded', () => {
      const ch = new MeetingChannel();
      // Finalize 64 distinct turns — past the 32 cap, oldest should evict.
      for (let i = 0; i < 64; i++) ch.markTurnFinalized(`t${i}`);
      expect(ch.isTurnFinalized('t0')).toBe(false); // evicted
      expect(ch.isTurnFinalized('t63')).toBe(true);
    });
  });
});
