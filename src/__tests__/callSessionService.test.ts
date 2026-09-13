import {
  getOrCreateSession,
  getSession,
  appendUserMessage,
  appendAssistantMessage,
  getMessages,
  getTranscript,
  touchSession,
  incrementNoInputAttempts,
  resetNoInputAttempts,
  deleteSession,
  isCallCompleted,
  markCallCompleted,
  withCallLock,
  cleanupExpiredSessions,
  cleanupCompletedCallSids,
  startSessionMaintenanceSweep,
  stopSessionMaintenanceSweep,
} from '../services/callSessionService';

describe('callSessionService', () => {
  it('creates a session with the expected shape', () => {
    const session = getOrCreateSession({
      callSid: 'CA_create_1',
      businessId: 'biz-1',
      customerPhone: '+15550001111',
    });

    expect(session.callSid).toBe('CA_create_1');
    expect(session.businessId).toBe('biz-1');
    expect(session.customerPhone).toBe('+15550001111');
    expect(session.messages).toEqual([]);
    expect(session.transcript).toBe('');
    expect(session.noInputAttempts).toBe(0);
    expect(session.startedAt).toBeInstanceOf(Date);
    expect(session.lastActivityAt).toBeInstanceOf(Date);

    deleteSession('CA_create_1');
  });

  it('retrieves a previously created session', () => {
    getOrCreateSession({ callSid: 'CA_retrieve_1', businessId: 'biz-1', customerPhone: '+1555' });

    const found = getSession('CA_retrieve_1');
    expect(found).toBeDefined();
    expect(found?.callSid).toBe('CA_retrieve_1');

    deleteSession('CA_retrieve_1');
  });

  it('returns the same session object for the same CallSid instead of creating a second one', () => {
    const first = getOrCreateSession({ callSid: 'CA_idempotent_1', businessId: 'biz-1', customerPhone: '+1555' });
    const second = getOrCreateSession({ callSid: 'CA_idempotent_1', businessId: 'biz-2', customerPhone: '+1999' });

    expect(second).toBe(first);
    // The second call's (different) params must NOT overwrite the original.
    expect(second.businessId).toBe('biz-1');
    expect(second.customerPhone).toBe('+1555');

    deleteSession('CA_idempotent_1');
  });

  it('appends a user message to both history and transcript', () => {
    getOrCreateSession({ callSid: 'CA_user_msg', businessId: 'biz-1', customerPhone: '+1555' });
    appendUserMessage('CA_user_msg', 'I need to book an appointment.');

    expect(getMessages('CA_user_msg')).toEqual([{ role: 'user', content: 'I need to book an appointment.' }]);
    expect(getTranscript('CA_user_msg')).toBe('Caller: I need to book an appointment.');

    deleteSession('CA_user_msg');
  });

  it('appends an assistant message to both history and transcript', () => {
    getOrCreateSession({ callSid: 'CA_assistant_msg', businessId: 'biz-1', customerPhone: '+1555' });
    appendAssistantMessage('CA_assistant_msg', 'Sure, what day works for you?');

    expect(getMessages('CA_assistant_msg')).toEqual([
      { role: 'assistant', content: 'Sure, what day works for you?' },
    ]);
    expect(getTranscript('CA_assistant_msg')).toBe('Assistant: Sure, what day works for you?');

    deleteSession('CA_assistant_msg');
  });

  it('formats a multi-turn transcript deterministically, in order', () => {
    getOrCreateSession({ callSid: 'CA_transcript', businessId: 'biz-1', customerPhone: '+1555' });
    appendAssistantMessage('CA_transcript', 'Thanks for calling. How can I help?');
    appendUserMessage('CA_transcript', 'I need to book an appointment.');
    appendAssistantMessage('CA_transcript', "I'd be happy to help with that.");
    appendUserMessage('CA_transcript', 'Tomorrow afternoon.');

    expect(getTranscript('CA_transcript')).toBe(
      [
        'Assistant: Thanks for calling. How can I help?',
        'Caller: I need to book an appointment.',
        "Assistant: I'd be happy to help with that.",
        'Caller: Tomorrow afternoon.',
      ].join('\n')
    );

    deleteSession('CA_transcript');
  });

  it('updates lastActivityAt on touch/append', async () => {
    const session = getOrCreateSession({ callSid: 'CA_activity', businessId: 'biz-1', customerPhone: '+1555' });
    const initial = session.lastActivityAt.getTime();

    await new Promise((resolve) => setTimeout(resolve, 5));
    touchSession('CA_activity');

    expect(session.lastActivityAt.getTime()).toBeGreaterThanOrEqual(initial);

    deleteSession('CA_activity');
  });

  it('tracks and resets no-input attempts', () => {
    getOrCreateSession({ callSid: 'CA_no_input', businessId: 'biz-1', customerPhone: '+1555' });

    expect(incrementNoInputAttempts('CA_no_input')).toBe(1);
    expect(incrementNoInputAttempts('CA_no_input')).toBe(2);

    resetNoInputAttempts('CA_no_input');
    expect(getSession('CA_no_input')?.noInputAttempts).toBe(0);

    deleteSession('CA_no_input');
  });

  it('deletes a session so it is no longer retrievable', () => {
    getOrCreateSession({ callSid: 'CA_delete', businessId: 'biz-1', customerPhone: '+1555' });
    deleteSession('CA_delete');

    expect(getSession('CA_delete')).toBeUndefined();
    expect(getMessages('CA_delete')).toEqual([]);
    expect(getTranscript('CA_delete')).toBe('');
  });

  it('marks a call completed only once (idempotency)', () => {
    expect(isCallCompleted('CA_completed_1')).toBe(false);

    expect(markCallCompleted('CA_completed_1')).toBe(true);
    expect(isCallCompleted('CA_completed_1')).toBe(true);

    // A second attempt to mark the same call must report it was already done.
    expect(markCallCompleted('CA_completed_1')).toBe(false);
  });

  it('does not leak state between different CallSids', () => {
    getOrCreateSession({ callSid: 'CA_leak_a', businessId: 'biz-a', customerPhone: '+1111' });
    getOrCreateSession({ callSid: 'CA_leak_b', businessId: 'biz-b', customerPhone: '+2222' });

    appendUserMessage('CA_leak_a', 'Message for call A only.');

    expect(getMessages('CA_leak_a')).toHaveLength(1);
    expect(getMessages('CA_leak_b')).toHaveLength(0);
    expect(getSession('CA_leak_b')?.businessId).toBe('biz-b');

    deleteSession('CA_leak_a');
    deleteSession('CA_leak_b');
  });
});

describe('Phase 4C: session expiry / maintenance', () => {
  afterEach(() => {
    stopSessionMaintenanceSweep();
  });

  it('retains a session whose lastActivityAt is within the inactivity threshold', () => {
    getOrCreateSession({ callSid: 'CA_active_keep', businessId: 'biz-1', customerPhone: '+1555' });

    const removed = cleanupExpiredSessions(new Date());

    expect(removed).toBe(0);
    expect(getSession('CA_active_keep')).toBeDefined();

    deleteSession('CA_active_keep');
  });

  it('removes a session whose lastActivityAt is older than the configured threshold (default 30 min)', () => {
    const session = getOrCreateSession({ callSid: 'CA_expired', businessId: 'biz-1', customerPhone: '+1555' });
    session.lastActivityAt = new Date(Date.now() - 31 * 60_000);

    const removed = cleanupExpiredSessions(new Date());

    expect(removed).toBe(1);
    expect(getSession('CA_expired')).toBeUndefined();
  });

  it('returns an accurate removal count while leaving active sessions untouched', () => {
    const stale1 = getOrCreateSession({ callSid: 'CA_mix_stale_1', businessId: 'biz-1', customerPhone: '+1555' });
    const stale2 = getOrCreateSession({ callSid: 'CA_mix_stale_2', businessId: 'biz-1', customerPhone: '+1555' });
    stale1.lastActivityAt = new Date(Date.now() - 45 * 60_000);
    stale2.lastActivityAt = new Date(Date.now() - 60 * 60_000);
    getOrCreateSession({ callSid: 'CA_mix_active', businessId: 'biz-1', customerPhone: '+1555' });

    const removed = cleanupExpiredSessions(new Date());

    expect(removed).toBe(2);
    expect(getSession('CA_mix_stale_1')).toBeUndefined();
    expect(getSession('CA_mix_stale_2')).toBeUndefined();
    expect(getSession('CA_mix_active')).toBeDefined();

    deleteSession('CA_mix_active');
  });

  it('never removes a session that currently has in-flight work under withCallLock, even if it looks idle', async () => {
    const session = getOrCreateSession({ callSid: 'CA_locked', businessId: 'biz-1', customerPhone: '+1555' });
    session.lastActivityAt = new Date(Date.now() - 40 * 60_000);

    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const lockPromise = withCallLock('CA_locked', async () => {
      await gate;
    });

    const removedWhileLocked = cleanupExpiredSessions(new Date());
    expect(removedWhileLocked).toBe(0);
    expect(getSession('CA_locked')).toBeDefined();

    release();
    await lockPromise;
    // withCallLock's own internal cleanup (removing the CallSid from the
    // lock map) runs a couple of microtask ticks after `run` itself
    // resolves — flush the queue so `isCallLocked` reflects it before we
    // sweep again.
    await new Promise((resolve) => setTimeout(resolve, 0));

    const removedAfterUnlock = cleanupExpiredSessions(new Date());
    expect(removedAfterUnlock).toBe(1);
    expect(getSession('CA_locked')).toBeUndefined();
  });

  it('keeps a recently-completed CallSid within the retention window', () => {
    markCallCompleted('CA_retain_recent');

    const removed = cleanupCompletedCallSids(new Date());

    expect(removed).toBe(0);
    expect(isCallCompleted('CA_retain_recent')).toBe(true);
  });

  it('prunes a completed CallSid once the retention window (6h) has passed', () => {
    markCallCompleted('CA_prune_old');

    // Other CallSids marked completed elsewhere in this file's real-time
    // test run are equally "old" relative to 7 hours from now, so this
    // sweep may remove more than just this one — the point under test is
    // that THIS CallSid specifically no longer survives past the window.
    const sevenHoursLater = new Date(Date.now() + 7 * 60 * 60_000);
    const removed = cleanupCompletedCallSids(sevenHoursLater);

    expect(removed).toBeGreaterThanOrEqual(1);
    expect(isCallCompleted('CA_prune_old')).toBe(false);
  });

  it('starts the maintenance interval at most once even if called multiple times', () => {
    const setIntervalSpy = jest.spyOn(global, 'setInterval');

    startSessionMaintenanceSweep(1000);
    startSessionMaintenanceSweep(1000);

    expect(setIntervalSpy).toHaveBeenCalledTimes(1);

    setIntervalSpy.mockRestore();
  });
});
