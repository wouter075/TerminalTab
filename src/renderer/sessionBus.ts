import type { EndReason, SessionInfo, SessionStatus } from '../shared/types';
import { api } from './util';

type Event =
  | { kind: 'data'; data: Uint8Array }
  | { kind: 'status'; status: SessionStatus; message?: string; reason?: EndReason }
  | { kind: 'info'; info: SessionInfo };
type Listener = (e: Event) => void;

/**
 * Routes session events to the terminal pane that owns the session. Events that arrive
 * before the pane knows its session id (e.g. the first "connecting" status) are buffered.
 */
const listeners = new Map<string, Listener>();
const buffered = new Map<string, Event[]>();

function dispatch(sessionId: string, e: Event) {
  const l = listeners.get(sessionId);
  if (l) l(e);
  else if (e.kind !== 'info') {
    const q = buffered.get(sessionId) ?? [];
    q.push(e);
    buffered.set(sessionId, q);
  }
}

api.onSessionData((sid, data) => dispatch(sid, { kind: 'data', data }));
api.onSessionStatus((sid, status, message, reason) => dispatch(sid, { kind: 'status', status, message, reason }));
api.onSessionInfo((sid, info) => dispatch(sid, { kind: 'info', info }));

export function subscribe(sessionId: string, l: Listener): () => void {
  listeners.set(sessionId, l);
  const q = buffered.get(sessionId);
  buffered.delete(sessionId);
  q?.forEach(l);
  return () => {
    listeners.delete(sessionId);
    buffered.delete(sessionId);
  };
}

export type SessionEvent = Event;
