import { describe, it, expect, beforeEach } from 'vitest';
import {
  _initTestDatabase,
  saveWarRoomConversationTurn,
  saveStructuredMemory,
  searchMemories,
  createTextMeeting,
  addWarRoomTranscript,
  endWarRoomMeeting,
  pruneWarRoomMeetings,
  getTextMeeting,
  _testBackdateMeetingEnd,
} from './db.js';

describe('saveWarRoomConversationTurn', () => {
  beforeEach(() => {
    _initTestDatabase();
  });

  it('reports userInserted=true and assistantInserted=true on first call', () => {
    const r = saveWarRoomConversationTurn({
      chatId: 'chat1',
      agentId: 'main',
      originalUserText: 'hi',
      agentReply: 'hey',
      meetingId: 'm1',
      turnId: 't1',
    });
    expect(r.userInserted).toBe(true);
    expect(r.assistantInserted).toBe(true);
  });

  it('idempotent retry: second call with same turnId reports no-op', () => {
    const args = {
      chatId: 'chat1', agentId: 'main',
      originalUserText: 'hi', agentReply: 'hey',
      meetingId: 'm1', turnId: 't1',
    };
    const first = saveWarRoomConversationTurn(args);
    const second = saveWarRoomConversationTurn(args);
    expect(first.userInserted).toBe(true);
    expect(first.assistantInserted).toBe(true);
    expect(second.userInserted).toBe(false);
    expect(second.assistantInserted).toBe(false);
  });

  it('multi-agent (e.g. /discuss): one user row, multiple assistant rows', () => {
    // /discuss triggers 5 agents. The partial unique index allows one user
    // row per turn but separate assistant rows per (turn, agent).
    const sharedTurn = { chatId: 'chat1', meetingId: 'm1', turnId: 't1', originalUserText: 'discuss this' };
    const agents = ['main', 'research', 'comms', 'content', 'ops'];

    const results = agents.map((aid) =>
      saveWarRoomConversationTurn({
        ...sharedTurn,
        agentId: aid,
        agentReply: `${aid} reply`,
      })
    );

    // First caller wins the user row, the rest see no-op on user.
    expect(results[0].userInserted).toBe(true);
    for (let i = 1; i < results.length; i++) {
      expect(results[i].userInserted).toBe(false);
    }
    // Every agent gets a fresh assistant row.
    for (const r of results) expect(r.assistantInserted).toBe(true);
  });

  it('throws when meetingId or turnId is missing', () => {
    expect(() => saveWarRoomConversationTurn({
      chatId: 'c', agentId: 'main', originalUserText: '', agentReply: '',
      meetingId: '', turnId: 't1',
    })).toThrow();
    expect(() => saveWarRoomConversationTurn({
      chatId: 'c', agentId: 'main', originalUserText: '', agentReply: '',
      meetingId: 'm1', turnId: '',
    })).toThrow();
  });
});

describe('memory strict-agent isolation', () => {
  beforeEach(() => {
    _initTestDatabase();
  });

  it('searchMemories with agentId only returns memories tagged for that agent', () => {
    saveStructuredMemory(
      'chat1', 'agent A learned X', 'fact A',
      ['agentA'], ['topicX'],
      0.5, 'conversation', 'agentA',
    );
    saveStructuredMemory(
      'chat1', 'agent B learned Y', 'fact B',
      ['agentB'], ['topicY'],
      0.5, 'conversation', 'agentB',
    );

    const aResults = searchMemories('chat1', 'fact', 10, undefined, 'agentA');
    const bResults = searchMemories('chat1', 'fact', 10, undefined, 'agentB');

    expect(aResults.some((m) => m.summary === 'fact A')).toBe(true);
    expect(aResults.some((m) => m.summary === 'fact B')).toBe(false);
    expect(bResults.some((m) => m.summary === 'fact B')).toBe(true);
    expect(bResults.some((m) => m.summary === 'fact A')).toBe(false);
  });

  it('searchMemories without agentId sees both (legacy/broad path)', () => {
    saveStructuredMemory(
      'chat1', 'a', 'a-summary',
      [], [],
      0.5, 'conversation', 'agentA',
    );
    saveStructuredMemory(
      'chat1', 'b', 'b-summary',
      [], [],
      0.5, 'conversation', 'agentB',
    );
    const both = searchMemories('chat1', 'summary', 10);
    expect(both.length).toBeGreaterThanOrEqual(2);
  });
});

describe('warroom_transcript ordering', () => {
  beforeEach(() => {
    _initTestDatabase();
  });

  it('addWarRoomTranscript returns monotonically increasing ids', () => {
    createTextMeeting('m1', 'chat1');
    const a = addWarRoomTranscript('m1', 'user', 'hi');
    const b = addWarRoomTranscript('m1', 'user', 'hello');
    const c = addWarRoomTranscript('m1', 'user', 'yo');
    expect(b.id).toBeGreaterThan(a.id);
    expect(c.id).toBeGreaterThan(b.id);
  });
});

describe('pruneWarRoomMeetings', () => {
  beforeEach(() => {
    _initTestDatabase();
  });

  it('does not touch active (un-ended) meetings', () => {
    createTextMeeting('m_active', 'chat1');
    const result = pruneWarRoomMeetings(0); // even with 0-day retention
    expect(result.meetings).toBe(0);
    expect(getTextMeeting('m_active')).toBeTruthy();
  });

  it('drops meetings ended past the retention window + their transcripts', () => {
    createTextMeeting('m_old', 'chat1');
    createTextMeeting('m_recent', 'chat1');
    addWarRoomTranscript('m_old', 'user', 'old transcript');
    addWarRoomTranscript('m_recent', 'user', 'recent transcript');
    saveWarRoomConversationTurn({
      chatId: 'chat1', agentId: 'main',
      originalUserText: 'q', agentReply: 'a',
      meetingId: 'm_old', turnId: 't1',
    });

    // End both meetings; backdate m_old to before the retention window.
    endWarRoomMeeting('m_old', 1);
    endWarRoomMeeting('m_recent', 1);
    const oneHundredDaysAgo = Math.floor(Date.now() / 1000) - 100 * 86400;
    _testBackdateMeetingEnd('m_old', oneHundredDaysAgo);

    const result = pruneWarRoomMeetings(90);
    expect(result.meetings).toBe(1);
    expect(result.convLog).toBeGreaterThanOrEqual(1);
    expect(getTextMeeting('m_old')).toBeFalsy();
    expect(getTextMeeting('m_recent')).toBeTruthy();
  });
});
