'use client';

import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { XfyunTranscriber, type MeetingTranscriber, type TranscriberOptions, type TranscriberStatus } from './live-transcriber';
import { getDemoSession } from './demo-session-client';
import { playInterventionChime, primeInterventionChime } from './intervention-chime';
import type { RoomSnapshot, UtteranceSource } from './room-types';
import type { Intervention } from './demo-data';

type ParticipantSession = { token: string; participantId: string; name: string; role: string; nextSeq?: number };
type PendingSpeechEvent = { clientEventId: string; startedAt: number; lastQueuedText: string; lastChangedText: string; lastChangedAt: number };
type UploadItem = {
  clientEventId: string;
  isFinal: boolean;
  payload: Record<string, unknown>;
  promise: Promise<void>;
  resolve: () => void;
  reject: (error: unknown) => void;
};

class RoomRequestError extends Error {
  constructor(message: string, public status: number) { super(message); }
}

class RequestSupersededError extends Error {}

const PARTIAL_UPLOAD_INTERVAL_MS = 800;
const UTTERANCE_REQUEST_TIMEOUT_MS = 2_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 8_000;
const ROOM_POLL_TIMEOUT_MS = 4_000;
const ROOM_CODE_PATTERN = /^[A-HJ-NP-Z2-9]{6}$/;

function delay(milliseconds: number) {
  return new Promise<void>((resolve) => window.setTimeout(resolve, milliseconds));
}

function formatElapsed(seconds: number) {
  const safe = Math.max(0, Math.floor(seconds));
  return `${String(Math.floor(safe / 60)).padStart(2, '0')}:${String(safe % 60).padStart(2, '0')}`;
}

function ParticipantInterventionToast({ events }: { events: Intervention[] }) {
  const seenRef = useRef<Set<string> | null>(null);
  const timerRef = useRef<number | null>(null);
  const [active, setActive] = useState<Intervention | null>(null);
  if (seenRef.current === null) seenRef.current = new Set(events.map((event) => event.id));
  useEffect(() => {
    const seen = seenRef.current!;
    const incoming = events.filter((event) => event.level !== 'L0' && !seen.has(event.id));
    for (const event of events) seen.add(event.id);
    const latest = incoming.at(-1);
    if (!latest) return;
    playInterventionChime(latest.level);
    setActive(latest);
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => {
      setActive((current) => current?.id === latest.id ? null : current);
      timerRef.current = null;
    }, latest.displayMs || (latest.level === 'L2' ? 10000 : 7000));
  }, [events]);
  useEffect(() => () => { if (timerRef.current !== null) window.clearTimeout(timerRef.current); }, []);
  if (!active) return null;
  return <aside className={`participant-intervention-toast ${active.level.toLowerCase()}`} role="status" aria-live="assertive"><div><span>{active.level} 提醒</span><time>{formatElapsed(active.at)}</time></div><b>{active.label}</b><p>{active.suggestion}</p><button type="button" onClick={() => setActive(null)}>知道了</button><i style={{ animationDuration: `${active.displayMs || (active.level === 'L2' ? 10000 : 7000)}ms` }} /></aside>;
}

function isRetryable(error: unknown) {
  if (!(error instanceof RoomRequestError)) return true;
  return error.status === 408 || error.status === 425 || error.status === 429 || error.status >= 500;
}

async function requestRoom(body: Record<string, unknown>, participantToken = '', options: { timeoutMs?: number; signal?: AbortSignal } = {}) {
  const headers = new Headers({ 'Content-Type': 'application/json' });
  if (participantToken) headers.set('Authorization', `Bearer ${participantToken}`);
  const controller = new AbortController();
  let timedOut = false;
  const timeout = window.setTimeout(() => { timedOut = true; controller.abort(); }, options.timeoutMs || DEFAULT_REQUEST_TIMEOUT_MS);
  const cancel = () => controller.abort();
  if (options.signal?.aborted) cancel();
  else options.signal?.addEventListener('abort', cancel, { once: true });
  let response: Response;
  try {
    response = await fetch('/api/room', { method: 'POST', headers, body: JSON.stringify(body), signal: controller.signal });
  } catch (error) {
    if (options.signal?.aborted) throw new RequestSupersededError('该条临时字幕已被更新内容替代');
    if (timedOut) throw new Error('发言同步请求超时');
    throw new Error(error instanceof Error ? error.message : '网络连接失败');
  } finally {
    window.clearTimeout(timeout);
    options.signal?.removeEventListener('abort', cancel);
  }
  const payload = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok) throw new RoomRequestError(String(payload.error || `HTTP ${response.status}`), response.status);
  return payload;
}

async function requestRoomWithRetry(body: Record<string, unknown>, token: string, retries = 3, options: { timeoutMs?: number; signal?: AbortSignal } = {}) {
  let latestError: unknown;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try { return await requestRoom(body, token, options); }
    catch (error) {
      latestError = error;
      if (error instanceof RequestSupersededError) throw error;
      if (!isRetryable(error) || attempt === retries) throw error;
      await delay([250, 650, 1200][Math.min(attempt, 2)]);
    }
  }
  throw latestError;
}

function newEventId(participantId: string) {
  const suffix = typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return `${participantId || 'participant'}-${suffix}`;
}

function makeUploadItem(clientEventId: string, isFinal: boolean, payload: Record<string, unknown>) {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((onResolve, onReject) => { resolve = onResolve; reject = onReject; });
  return { clientEventId, isFinal, payload, promise, resolve, reject } satisfies UploadItem;
}

export default function ParticipantView({ code, onExit }: { code: string; onExit?: () => void }) {
  const normalizedCode = code.trim().toUpperCase();
  const codeIsValid = ROOM_CODE_PATTERN.test(normalizedCode);
  const storageKey = `cuicui-room-${normalizedCode}`;
  const [name, setName] = useState('');
  const [role, setRole] = useState('参会者');
  const [participantToken, setParticipantToken] = useState('');
  const [participantId, setParticipantId] = useState('');
  const [room, setRoom] = useState<RoomSnapshot | null>(null);
  const [status, setStatus] = useState<TranscriberStatus | null>(null);
  const [engine, setEngine] = useState<'iflytek' | null>(null);
  const [draft, setDraft] = useState('');
  const [manualText, setManualText] = useState('');
  const [joinError, setJoinError] = useState<string | null>(() => codeIsValid ? null : '加入码格式不正确');
  const [syncError, setSyncError] = useState<string | null>(null);
  const [micError, setMicError] = useState<string | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [restoring, setRestoring] = useState(codeIsValid);
  const [joining, setJoining] = useState(false);
  const [micStarting, setMicStarting] = useState(false);
  const [micActive, setMicActive] = useState(false);
  const [manualSending, setManualSending] = useState(false);
  const [exiting, setExiting] = useState(false);

  const roomRevisionRef = useRef(0);
  const roomRef = useRef<RoomSnapshot | null>(null);
  const serverClockRef = useRef<{ serverNow: number; receivedAt: number } | null>(null);
  const participantTokenRef = useRef('');
  const participantIdRef = useRef('');
  const transcriberRef = useRef<MeetingTranscriber | null>(null);
  const micStartingRef = useRef(false);
  const stopPromiseRef = useRef<Promise<void> | null>(null);
  const committedCharactersRef = useRef(0);
  const sequenceRef = useRef(0);
  const pendingFinalUploadsRef = useRef<UploadItem[]>([]);
  const pendingPartialUploadsRef = useRef<Map<string, UploadItem>>(new Map());
  const activeUploadRef = useRef<{ item: UploadItem; controller: AbortController } | null>(null);
  const uploadPumpRef = useRef<Promise<void> | null>(null);
  const partialTimerRef = useRef<number | null>(null);
  const partialTextRef = useRef('');
  const currentSpeechEventRef = useRef<PendingSpeechEvent | null>(null);
  const autoMicAttemptedRef = useRef('');
  const sharedTranscriptRef = useRef<HTMLDivElement | null>(null);

  const rememberSequence = useCallback(() => {
    try {
      const saved = JSON.parse(sessionStorage.getItem(storageKey) || 'null') as ParticipantSession | null;
      if (saved?.token !== participantTokenRef.current) return;
      sessionStorage.setItem(storageKey, JSON.stringify({ ...saved, nextSeq: sequenceRef.current }));
    } catch { /* storage is optional */ }
  }, [storageKey]);

  const nextSequence = useCallback(() => {
    sequenceRef.current += 1;
    rememberSequence();
    return sequenceRef.current;
  }, [rememberSequence]);

  const relativeNow = useCallback(() => {
    const startedAt = roomRef.current?.startedAt;
    const clock = serverClockRef.current;
    if (!startedAt || !clock) return 0;
    const estimatedServerNow = clock.serverNow + Math.max(0, performance.now() - clock.receivedAt);
    return Math.max(0, (estimatedServerNow - startedAt) / 1000);
  }, []);

  const dropPendingPartials = useCallback((clientEventId?: string) => {
    for (const [id, item] of pendingPartialUploadsRef.current) {
      if (clientEventId && id !== clientEventId) continue;
      pendingPartialUploadsRef.current.delete(id);
      item.resolve();
    }
    const active = activeUploadRef.current;
    if (active && !active.item.isFinal && (!clientEventId || active.item.clientEventId === clientEventId)) active.controller.abort();
  }, []);

  const runUploadPump = useCallback(async () => {
    while (true) {
      let item = pendingFinalUploadsRef.current.shift();
      if (!item) {
        const firstPartial = pendingPartialUploadsRef.current.entries().next().value as [string, UploadItem] | undefined;
        if (firstPartial) {
          pendingPartialUploadsRef.current.delete(firstPartial[0]);
          item = firstPartial[1];
        }
      }
      if (!item) {
        await delay(0);
        item = pendingFinalUploadsRef.current.shift();
        if (!item) {
          const firstPartial = pendingPartialUploadsRef.current.entries().next().value as [string, UploadItem] | undefined;
          if (firstPartial) {
            pendingPartialUploadsRef.current.delete(firstPartial[0]);
            item = firstPartial[1];
          }
        }
        if (!item) return;
      }

      const controller = new AbortController();
      activeUploadRef.current = { item, controller };
      try {
        await requestRoomWithRetry(item.payload, participantTokenRef.current, item.isFinal ? 2 : 1, {
          timeoutMs: UTTERANCE_REQUEST_TIMEOUT_MS,
          signal: controller.signal,
        });
        setUploadError(null);
        item.resolve();
      } catch (error) {
        if (error instanceof RequestSupersededError) item.resolve();
        else {
          setUploadError(error instanceof Error ? error.message : '发言同步失败');
          item.reject(error);
        }
      } finally {
        if (activeUploadRef.current?.item === item) activeUploadRef.current = null;
      }
    }
  }, []);

  const startUploadPump = useCallback(() => {
    if (uploadPumpRef.current) return uploadPumpRef.current;
    const pump = runUploadPump();
    uploadPumpRef.current = pump;
    void pump.finally(() => { if (uploadPumpRef.current === pump) uploadPumpRef.current = null; });
    return pump;
  }, [runUploadPump]);

  const waitForUploads = useCallback(async () => {
    while (pendingFinalUploadsRef.current.length || pendingPartialUploadsRef.current.size || activeUploadRef.current || uploadPumpRef.current) {
      await startUploadPump();
    }
  }, [startUploadPump]);

  const enqueueUtterance = useCallback((input: {
    text: string; clientEventId: string; startedAt: number; endedAt?: number; source: UtteranceSource; isFinal: boolean;
  }) => {
    const text = input.text.trim();
    if (!text || !participantTokenRef.current) return Promise.resolve();
    const item = makeUploadItem(input.clientEventId, input.isFinal, {
      action: 'utterance', code: normalizedCode, text, clientEventId: input.clientEventId,
      seq: nextSequence(), startedAt: Math.max(0, input.startedAt), endedAt: Math.max(input.startedAt, input.endedAt ?? relativeNow()),
      source: input.source, isFinal: input.isFinal,
    });
    if (input.isFinal) {
      dropPendingPartials(input.clientEventId);
      pendingFinalUploadsRef.current.push(item);
    } else {
      const superseded = pendingPartialUploadsRef.current.get(input.clientEventId);
      if (superseded) superseded.resolve();
      pendingPartialUploadsRef.current.set(input.clientEventId, item);
    }
    void startUploadPump();
    return item.promise;
  }, [dropPendingPartials, nextSequence, normalizedCode, relativeNow, startUploadPump]);

  const clearPartialTimer = useCallback(() => {
    if (partialTimerRef.current !== null) window.clearTimeout(partialTimerRef.current);
    partialTimerRef.current = null;
  }, []);

  const ensureSpeechEvent = useCallback(() => {
    if (!currentSpeechEventRef.current) {
      const startedAt = relativeNow();
      currentSpeechEventRef.current = { clientEventId: newEventId(participantIdRef.current), startedAt, lastQueuedText: '', lastChangedText: '', lastChangedAt: startedAt };
    }
    return currentSpeechEventRef.current;
  }, [relativeNow]);

  const schedulePartialUpload = useCallback((text: string) => {
    partialTextRef.current = text;
    const speechEvent = ensureSpeechEvent();
    const latestText = text.trim();
    if (latestText && latestText !== speechEvent.lastChangedText) {
      speechEvent.lastChangedText = latestText;
      speechEvent.lastChangedAt = relativeNow();
    }
    if (partialTimerRef.current !== null) return;
    partialTimerRef.current = window.setTimeout(() => {
      partialTimerRef.current = null;
      const speechEvent = currentSpeechEventRef.current;
      const latestText = partialTextRef.current.trim();
      if (!speechEvent || !latestText || latestText === speechEvent.lastQueuedText) return;
      speechEvent.lastQueuedText = latestText;
      void enqueueUtterance({ text: latestText, clientEventId: speechEvent.clientEventId, startedAt: speechEvent.startedAt, source: 'iflytek', isFinal: false }).catch(() => undefined);
    }, PARTIAL_UPLOAD_INTERVAL_MS);
  }, [enqueueUtterance, ensureSpeechEvent, relativeNow]);

  const acceptRoom = useCallback((snapshot: RoomSnapshot) => {
    serverClockRef.current = { serverNow: snapshot.serverNow, receivedAt: performance.now() };
    roomRef.current = snapshot;
    roomRevisionRef.current = Math.max(roomRevisionRef.current, snapshot.revision);
    setRoom(snapshot);
  }, []);

  useEffect(() => {
    if (!codeIsValid) return;
    const timer = window.setTimeout(() => {
      try {
        const saved = JSON.parse(sessionStorage.getItem(storageKey) || 'null') as ParticipantSession | null;
        if (saved?.token && saved.participantId) {
          const savedName = String(saved.name || '参会者').slice(0, 30);
          const savedRole = String(saved.role || '参会者').slice(0, 40);
          participantTokenRef.current = saved.token;
          participantIdRef.current = saved.participantId;
          sequenceRef.current = Math.max(0, Number(saved.nextSeq) || 0);
          setParticipantToken(saved.token);
          setParticipantId(saved.participantId);
          setName(savedName);
          setRole(savedRole);
        }
      } catch { /* storage is optional */ }
      setRestoring(false);
    }, 0);
    return () => window.clearTimeout(timer);
  }, [codeIsValid, storageKey]);

  useEffect(() => {
    if (!participantToken) return;
    let cancelled = false;
    let inFlight = false;
    let pollController: AbortController | null = null;
    const poll = async () => {
      if (inFlight) return;
      inFlight = true;
      const controller = new AbortController();
      pollController = controller;
      const timeout = window.setTimeout(() => controller.abort(), ROOM_POLL_TIMEOUT_MS);
      try {
        const response = await fetch(`/api/room?code=${encodeURIComponent(normalizedCode)}`, { cache: 'no-store', headers: { Authorization: `Bearer ${participantToken}` }, signal: controller.signal });
        const payload = await response.json().catch(() => ({})) as { room?: RoomSnapshot; error?: string };
        if (!response.ok) {
          if (response.status === 401 || response.status === 404 || response.status === 410) {
            try { sessionStorage.removeItem(storageKey); } catch { /* optional */ }
            participantTokenRef.current = '';
            participantIdRef.current = '';
            if (!cancelled) {
              setParticipantToken(''); setParticipantId(''); setRoom(null);
              setJoinError(payload.error || '加入状态已失效，请重新加入');
            }
          }
          throw new RoomRequestError(payload.error || `HTTP ${response.status}`, response.status);
        }
        if (!cancelled && payload.room && payload.room.revision >= roomRevisionRef.current) acceptRoom(payload.room);
        if (!cancelled) setSyncError(null);
      } catch (error) {
        if (!cancelled && participantTokenRef.current) setSyncError(controller.signal.aborted ? '会场同步超时，正在自动重试' : error instanceof Error ? error.message : '无法同步会议');
      } finally {
        window.clearTimeout(timeout);
        if (pollController === controller) pollController = null;
        inFlight = false;
      }
    };
    void poll();
    const timer = window.setInterval(() => void poll(), 1000);
    return () => { cancelled = true; pollController?.abort(); window.clearInterval(timer); };
  }, [acceptRoom, normalizedCode, participantToken, storageKey]);

  const join = async (event?: FormEvent<HTMLFormElement>) => {
    event?.preventDefault();
    primeInterventionChime();
    const cleanName = name.trim().slice(0, 30);
    const cleanRole = (role.trim() || '参会者').slice(0, 40);
    if (!cleanName || joining) return;
    setJoining(true); setJoinError(null);
    try {
      const payload = await requestRoom({ action: 'join', code: normalizedCode, name: cleanName, role: cleanRole });
      const token = String(payload.participantToken || '');
      const id = String(payload.participantId || '');
      if (!token || !id || !payload.room) throw new Error('会场返回的加入信息不完整');
      participantTokenRef.current = token; participantIdRef.current = id; sequenceRef.current = 0;
      setParticipantToken(token); setParticipantId(id); setName(cleanName); setRole(cleanRole);
      acceptRoom(payload.room as RoomSnapshot);
      try { sessionStorage.setItem(storageKey, JSON.stringify({ token, participantId: id, name: cleanName, role: cleanRole, nextSeq: 0 } satisfies ParticipantSession)); } catch { /* storage is optional */ }
    } catch (error) { setJoinError(error instanceof Error ? error.message : '加入失败'); }
    finally { setJoining(false); }
  };

  const startMic = useCallback(async () => {
    if (transcriberRef.current || micStartingRef.current || roomRef.current?.status !== 'live') return;
    micStartingRef.current = true; setMicStarting(true); setMicError(null); setUploadError(null);
    committedCharactersRef.current = 0; currentSpeechEventRef.current = null; partialTextRef.current = ''; setDraft('');
    let direct: XfyunTranscriber | null = null;
    try {
      const accessToken = await getDemoSession();
      const callbacks: TranscriberOptions = {
        accessToken,
        onPartial: (text) => {
          const tail = text.slice(committedCharactersRef.current).trimStart();
          setDraft(tail);
          if (tail.trim()) schedulePartialUpload(tail);
        },
        onFinal: (text) => {
          clearPartialTimer();
          const tail = text.slice(committedCharactersRef.current).trim();
          const finalText = tail || partialTextRef.current.trim();
          const speechEvent = currentSpeechEventRef.current || (finalText ? ensureSpeechEvent() : null);
          if (speechEvent && finalText) {
            if (finalText !== speechEvent.lastChangedText) {
              if (!speechEvent.lastChangedText) speechEvent.lastChangedAt = relativeNow();
              speechEvent.lastChangedText = finalText;
            }
            speechEvent.lastQueuedText = finalText;
            void enqueueUtterance({ text: finalText, clientEventId: speechEvent.clientEventId, startedAt: speechEvent.startedAt, endedAt: speechEvent.lastChangedAt, source: 'iflytek', isFinal: true }).catch(() => undefined);
          }
          committedCharactersRef.current = text.length;
          currentSpeechEventRef.current = null; partialTextRef.current = ''; setDraft('');
        },
        onStatus: setStatus,
        onError: (message) => {
          clearPartialTimer();
          if (transcriberRef.current === direct) transcriberRef.current = null;
          micStartingRef.current = false; setMicStarting(false); setMicActive(false); setEngine(null); setStatus('closed'); setMicError(message);
        },
      };
      direct = new XfyunTranscriber(callbacks);
      transcriberRef.current = direct;
      await direct.start();
      if (transcriberRef.current !== direct || roomRef.current?.status !== 'live') {
        await direct.stop().catch(() => undefined); await waitForUploads(); return;
      }
      setMicActive(true); setEngine('iflytek');
    } catch (error) {
      if (direct) await direct.stop().catch(() => undefined);
      if (!direct || transcriberRef.current === direct) transcriberRef.current = null;
      setMicActive(false); setEngine(null); setStatus('closed');
      setMicError(`讯飞实时听写未启动：${error instanceof Error ? error.message : '连接失败'}`);
    } finally { micStartingRef.current = false; setMicStarting(false); }
  }, [clearPartialTimer, enqueueUtterance, ensureSpeechEvent, relativeNow, schedulePartialUpload, waitForUploads]);

  useEffect(() => {
    if (!participantToken || room?.status !== 'live' || !room.startedAt) return;
    const attemptKey = `${participantToken}:${room.startedAt}`;
    if (autoMicAttemptedRef.current === attemptKey) return;
    const timer = window.setTimeout(() => {
      if (autoMicAttemptedRef.current === attemptKey) return;
      autoMicAttemptedRef.current = attemptKey;
      void startMic();
    }, 180);
    return () => window.clearTimeout(timer);
  }, [participantToken, room?.startedAt, room?.status, startMic]);

  const stopMic = useCallback(() => {
    if (stopPromiseRef.current) return stopPromiseRef.current;
    const stopping = (async () => {
      clearPartialTimer();
      const transcriber = transcriberRef.current;
      transcriberRef.current = null; micStartingRef.current = false;
      try { if (transcriber) await transcriber.stop(); }
      catch (error) {
        const speechEvent = currentSpeechEventRef.current;
        const text = partialTextRef.current.trim();
        if (speechEvent && text) void enqueueUtterance({ text, clientEventId: speechEvent.clientEventId, startedAt: speechEvent.startedAt, endedAt: speechEvent.lastChangedAt, source: 'iflytek', isFinal: true }).catch(() => undefined);
        setMicError(error instanceof Error ? error.message : '麦克风收尾失败');
      }
      await waitForUploads();
      currentSpeechEventRef.current = null; partialTextRef.current = ''; setDraft('');
      setMicStarting(false); setMicActive(false); setEngine(null); setStatus('closed');
    })();
    stopPromiseRef.current = stopping.finally(() => { stopPromiseRef.current = null; });
    return stopPromiseRef.current;
  }, [clearPartialTimer, enqueueUtterance, waitForUploads]);

  useEffect(() => {
    if (room?.status === 'closing' || room?.status === 'ended') {
      dropPendingPartials();
      void stopMic();
    }
  }, [dropPendingPartials, room?.status, stopMic]);

  useEffect(() => {
    const list = sharedTranscriptRef.current;
    if (list) list.scrollTo({ top: list.scrollHeight, behavior: 'smooth' });
  }, [draft, room?.revision]);

  useEffect(() => () => {
    clearPartialTimer();
    dropPendingPartials();
    const transcriber = transcriberRef.current;
    transcriberRef.current = null;
    void transcriber?.stop().then(() => waitForUploads()).catch(() => undefined);
  }, [clearPartialTimer, dropPendingPartials, waitForUploads]);

  const sendManual = async () => {
    const text = manualText.trim();
    if (!text || manualSending || roomRef.current?.status !== 'live') return;
    setManualSending(true); setUploadError(null);
    const endedAt = relativeNow();
    try {
      await enqueueUtterance({ text, clientEventId: newEventId(participantIdRef.current), startedAt: Math.max(0, endedAt - Math.min(30, Math.max(1, text.length / 5))), source: 'manual', isFinal: true });
      setManualText('');
    } catch { /* enqueueUtterance exposes the error */ }
    finally { setManualSending(false); }
  };

  const exit = async () => {
    if (exiting) return;
    setExiting(true);
    const token = participantTokenRef.current;
    try {
      await stopMic(); await waitForUploads();
      if (token) await requestRoomWithRetry({ action: 'leave', code: normalizedCode }, token, 2);
    } catch { /* leaving must remain possible while offline */ }
    finally {
      try { sessionStorage.removeItem(storageKey); } catch { /* storage is optional */ }
      participantTokenRef.current = ''; participantIdRef.current = '';
      if (onExit) onExit(); else window.location.assign('/');
    }
  };

  if (restoring) {
    return <main className="join-shell"><section className="join-card" aria-live="polite"><div className="brand"><span className="brand-mark">催</span><span><strong>催催</strong><small>会议参与端</small></span></div><p className="eyebrow"><span /> 加入码 {normalizedCode}</p><h1>正在恢复会场…</h1><p>正在读取你在本设备上的加入状态。</p></section></main>;
  }

  if (!participantToken) {
    return <main className="join-shell"><section className="join-card">
      <div className="brand"><span className="brand-mark">催</span><span><strong>催催</strong><small>会议参与端</small></span></div>
      <p className="eyebrow"><span /> 加入码 {normalizedCode}</p><h1>加入这场会议</h1>
      <p>输入姓名后加入。会议已开始时会立即请求麦克风权限；还在等待时，会在主持人开始后自动尝试一次。</p>
      <form onSubmit={(event) => void join(event)}>
        <label className="field"><span>你的姓名</span><input autoFocus required maxLength={30} value={name} onChange={(event) => setName(event.target.value)} placeholder="例如：王工" autoComplete="name" /></label>
        <label className="field"><span>角色</span><input maxLength={40} value={role} onChange={(event) => setRole(event.target.value)} placeholder="例如：后端负责人" /></label>
        {joinError && <div className="service-error" role="alert"><b>无法加入</b><span>{joinError}</span></div>}
        <button className="primary-action" type="submit" disabled={!name.trim() || joining}>{joining ? '正在加入…' : '加入会议并开启麦克风'}</button>
      </form>
      <button className="text-button" type="button" disabled={exiting} onClick={() => void exit()}>返回首页</button>
    </section></main>;
  }

  const roomStatus = room?.status || 'waiting';
  const elapsed = room?.startedAt ? Math.max(0, ((room.endedAt || room.serverNow) - room.startedAt) / 1000) : 0;
  const duration = Math.max(1, room?.meeting.durationSeconds || 1);
  const progress = Math.min(100, elapsed / duration * 100);
  const remaining = duration - elapsed;
  const agenda = room?.meeting.agenda || [];
  const currentAgendaIndex = agenda.length && roomStatus !== 'waiting'
    ? Math.min(agenda.length - 1, Math.floor(Math.min(.999, elapsed / duration) * agenda.length))
    : 0;
  const activeParticipants = room?.participants.filter((person) => person.left_at === null) || [];
  const interventions = room?.interventions || [];
  const latestIntervention = [...interventions].reverse().find((event) => event.level !== 'L0') || interventions.at(-1);
  const sharedLines = (room?.utterances || [])
    .filter((line) => !(draft && !line.final && line.participant_id === participantId))
    .sort((left, right) => left.started_at - right.started_at || left.ended_at - right.ended_at || left.id.localeCompare(right.id))
    .slice(-120);
  const statusCopy = roomStatus === 'live' ? '会议进行中' : roomStatus === 'closing' ? '会议正在收尾' : roomStatus === 'ended' ? '会议已结束' : '等待主持人开始';
  const statusHelp = roomStatus === 'live'
    ? '已共享全场字幕、参会人和提醒；麦克风只用于转写，不传输通话声音。同处一室时请避免多台设备同时收音。'
    : roomStatus === 'closing' ? '正在同步所有人的最后发言，请稍候。'
      : roomStatus === 'ended' ? '本场会议已结束，全场记录已保存。'
        : '主持人开始后会自动尝试开启你的麦克风。';
  const visibleError = micError || uploadError || syncError;
  const paceCopy = roomStatus === 'waiting'
    ? '尚未计时'
    : remaining >= 0 ? `预计 ${formatElapsed(remaining)} 后结束` : `已超出计划 ${formatElapsed(Math.abs(remaining))}`;

  return <main className="participant-shell">
    <ParticipantInterventionToast events={interventions} />
    <header className="participant-header">
      <div className="brand"><span className="brand-mark">催</span><span><strong>催催</strong><small>参与端 · {normalizedCode}</small></span></div>
      <span className={`room-status ${roomStatus}`}><i />{statusCopy}</span>
      <button className="control-chip" type="button" disabled={exiting} onClick={() => void exit()}>{exiting ? '正在退出…' : '退出'}</button>
    </header>
    <section className="participant-main participant-shared-main">
      <div className={`room-live-banner ${roomStatus}`} role="status" aria-live="polite"><b>{statusCopy}</b><span>{statusHelp}</span><strong>{normalizedCode}</strong></div>
      <div className="participant-title"><p>{room?.meeting.meetingType} · 参会者共享视图</p><h1>{room?.meeting.title || '正在读取会议信息'}</h1><div>{agenda.map((item, index) => <span className={index === currentAgendaIndex && roomStatus === 'live' ? 'active' : ''} key={`${index}-${item}`}>{index + 1}. {item}</span>)}</div></div>
      <section className="participant-command" aria-label="会议进度">
        <div><span>已进行</span><b>{formatElapsed(elapsed)}</b></div>
        <div><span>当前议题</span><b>{agenda[currentAgendaIndex] || '自由讨论'}</b></div>
        <div><span>节奏预测</span><b className={remaining < 0 ? 'overdue' : ''}>{paceCopy}</b></div>
        <div className="participant-progress" aria-label={`会议计划进度 ${Math.round(progress)}%`}><i style={{ width: `${progress}%` }} /></div>
      </section>
      <div className="participant-shared-grid">
        <section className="participant-shared-transcript">
          <header><div><p>全员实时同步</p><h2>会议字幕</h2></div><b>{room?.utterances.filter((line) => line.final).length || 0} 段稳定字幕</b></header>
          <div className="participant-transcript-list" ref={sharedTranscriptRef}>
            {sharedLines.length === 0 && !draft && <div className="participant-empty"><span className="listening-orbit"><i /></span><b>{roomStatus === 'waiting' ? '等待主持人开始会议' : '等待第一位参会者发言'}</b><p>每个人的字幕都会在这里按真实时间出现。</p></div>}
            {sharedLines.map((line) => <article className={`${line.participant_id === participantId ? 'mine' : ''} ${line.final ? '' : 'draft'}`} key={line.id}>
              <time>{formatElapsed(line.started_at)}</time><span className="participant-line-avatar">{line.name.slice(0, 1)}</span><div><p className="participant-speaker"><b>{line.name}</b><span>{line.role}</span>{line.participant_id === participantId && <em>我</em>}{!line.final && <em>听写中</em>}</p><p>{line.text}</p></div>
            </article>)}
            {draft && <article className="mine draft local" aria-live="polite"><time>{formatElapsed(elapsed)}</time><span className="participant-line-avatar">{name.slice(0, 1)}</span><div><p className="participant-speaker"><b>{name}</b><span>{role}</span><em>我</em><em>听写中</em></p><p>{draft}<span className="typing-cursor" /></p></div></article>}
          </div>
        </section>
        <aside className="participant-shared-side">
          <section className={`participant-reminder ${latestIntervention?.severity || 'calm'}`}>
            <header><div><p>催催提醒</p><h2>现场提醒</h2></div><b>{interventions.length} 条</b></header>
            {latestIntervention ? <article><div><span>{latestIntervention.label}</span><time>{formatElapsed(latestIntervention.at)}</time></div><p><b>观察</b>{latestIntervention.observation}</p><p><b>建议</b>{latestIntervention.suggestion}</p><footer><span>判断依据</span><b>{latestIntervention.evidence}</b></footer></article> : <div className="participant-calm"><span>✓</span><div><b>尚无充分介入证据</b><p>催催正根据全场字幕、议题和剩余时间持续判断。</p></div></div>}
            {interventions.length > 0 && <div className="participant-reminder-history">{interventions.slice(-5).reverse().map((event) => <span key={event.id}><time>{formatElapsed(event.at)}</time><i>{event.level}</i>{event.label}</span>)}</div>}
          </section>
          <section className="participant-roster">
            <header><div><p>参会人</p><h2>当前成员</h2></div><b>{activeParticipants.filter((person) => person.online).length} / {activeParticipants.length} 在线</b></header>
            <div>{activeParticipants.map((person) => <article key={person.id} className={person.id === participantId ? 'self' : ''}><span className="participant-avatar">{person.name.slice(0, 1)}</span><div><b>{person.name}</b><p>{person.role}</p></div><em className={person.online ? 'online' : ''}>{person.id === participantId ? '我' : person.role === '主持人' ? '主持人' : person.online ? '在线' : '暂离'}</em></article>)}</div>
          </section>
        </aside>
      </div>
    </section>
    <section className={`participant-mic-dock ${micActive ? 'active' : ''}`} aria-label="我的麦克风">
      <div className="mic-dock-identity"><span className={`mic-dock-orb ${status === 'listening' ? 'active' : ''}`}><i /></span><div><b>{name}</b><span>{role}</span></div></div>
      <div className="mic-dock-state"><b>{micStarting ? '正在连接讯飞…' : micActive ? '麦克风已开启，正在生成你的字幕' : roomStatus === 'live' ? '麦克风未开启' : statusCopy}</b><span>{engine === 'iflytek' ? '讯飞实时听写中 · 声音不会传给其他参会者' : '加入后只自动尝试一次，失败时可在这里重试；同处一室请按需关闭'}</span>{visibleError && <div className="mic-dock-error" role="alert">{visibleError}</div>}</div>
      <div className="mic-dock-actions">{micActive ? <button className="end-button" type="button" onClick={() => void stopMic()}>关闭麦克风</button> : <button className="primary-action" type="button" disabled={roomStatus !== 'live' || micStarting} aria-busy={micStarting} onClick={() => void startMic()}>{micStarting ? '正在开启…' : micError ? '重新开启麦克风' : '开启麦克风'}</button>}
        <details className="participant-manual-details"><summary>文字补充</summary><div><textarea rows={3} maxLength={600} value={manualText} onChange={(event) => setManualText(event.target.value)} placeholder="输入要同步给全场的观点" /><button type="button" onClick={() => void sendManual()} disabled={!manualText.trim() || manualSending || roomStatus !== 'live'} aria-busy={manualSending}>{manualSending ? '正在同步…' : '发送给全场'}</button></div></details>
      </div>
    </section>
  </main>;
}
