import { CallState, TERMINAL_CALL_STATES } from './call.types';

/**
 * The only place that decides which CallState transitions are legal. Pure
 * and dependency-free on purpose so it's trivially unit-testable and so
 * call.service.ts can never accidentally skip validation.
 */
const ALLOWED_TRANSITIONS: Record<CallState, CallState[]> = {
  CREATED: ['CONNECTING', 'CANCELLED', 'FAILED'],
  CONNECTING: ['CONNECTED', 'FAILED', 'CANCELLED'],
  CONNECTED: ['ACTIVE', 'ENDING', 'FAILED'],
  ACTIVE: ['ENDING', 'FAILED'],
  ENDING: ['ENDED', 'FAILED'],
  ENDED: [],
  FAILED: [],
  CANCELLED: [],
};

export function isTerminalState(state: CallState): boolean {
  return TERMINAL_CALL_STATES.has(state);
}

export function canTransition(from: CallState, to: CallState): boolean {
  if (from === to) return false;
  return ALLOWED_TRANSITIONS[from]?.includes(to) ?? false;
}

export function assertTransition(from: CallState, to: CallState): void {
  if (!canTransition(from, to)) {
    throw new Error(`Invalid call state transition: ${from} -> ${to}`);
  }
}
