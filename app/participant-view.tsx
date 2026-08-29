'use client';

import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { XfyunTranscriber, type MeetingTranscriber, type TranscriberOptions, type TranscriberStatus } from './live-transcriber';
import { getDemoSession } from './demo-session-client';
import type { RoomSnapshot, UtteranceSource } from './room-types';

type ParticipantSession = { token: string; participantId: string; name: string; role: string; nextSeq?: number };
type PendingSpeechEvent = { clientEventId: string; startedAt: number; lastQueuedText: string };
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
    text: string; clientEventId: string; startedAt: number; source: UtteranceSource; isFinal: boolean;
  }) => {
    const text = input.text.trim();
    if (!text || !participantTokenRef.current) return Promise.resolve();
    const item = makeUploadItem(input.clientEventId, input.isFinal, {
      action: 'utterance', code: normalizedCode, text, clientEventId: input.clientEventId,
      seq: nextSequence(), startedAt: Math.max(0, input.startedAt), endedAt: relativeNow(),
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
      currentSpeechEventRef.current = { clientEventId: newEventId(participantIdRef.current), startedAt: relativeNow(), lastQueuedText: '' };
    }
    return currentSpeechEventRef.current;
  }, [relativeNow]);

  const schedulePartialUpload = useCallback((text: string) => {
    partialTextRef.current = text;
    ensureSpeechEvent();
    if (partialTimerRef.current !== null) return;
    partialTimerRef.current = window.setTimeout(() => {
      partialTimerRef.current = null;
      const speechEvent = currentSpeechEventRef.current;
      const latestText = partialTextRef.current.trim();
      if (!speechEvent || !latestText || latestText === speechEvent.lastQueuedText) return;
      speechEvent.lastQueuedText = latestText;
      void enqueueUtterance({ text: latestText, clientEventId: speechEvent.clientEventId, startedAt: speechEvent.startedAt, source: 'iflytek', isFinal: false }).catch(() => undefined);
    }, PARTIAL_UPLOAD_INTERVAL_MS);
  }, [enqueueUtterance, ensureSpeechEvent]);

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
            speechEvent.lastQueuedText = finalText;
            void enqueueUtterance({ text: finalText, clientEventId: speechEvent.clientEventId, startedAt: speechEvent.startedAt, source: 'iflytek', isFinal: true }).catch(() => undefined);
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
  }, [clearPartialTimer, enqueueUtterance, ensureSpeechEvent, schedulePartialUpload, waitForUploads]);

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
        if (speechEvent && text) void enqueueUtterance({ text, clientEventId: speechEvent.clientEventId, startedAt: speechEvent.startedAt, source: 'iflytek', isFinal: true }).catch(() => undefined);
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
    return <main className="join-shell"><section className="join-card" aria-live="polite"><div className="brand"><span className="brand-mark">C²</span><span><strong>催催</strong><small>会议参与端</small></span></div><p className="eyebrow"><span /> 加入码 {normalizedCode}</p><h1>正在恢复会场…</h1><p>正在读取你在本设备上的加入状态。</p></section></main>;
  }

  if (!participantToken) {
    return <main className="join-shell"><section className="join-card">
      <div className="brand"><span className="brand-mark">C²</span><span><strong>催催</strong><small>会议参与端</small></span></div>
      <p className="eyebrow"><span /> 加入码 {normalizedCode}</p><h1>加入这场会议</h1>
      <p>输入姓名后加入，催催会把你的发言记在你的名字下。</p>
      <form onSubmit={(event) => void join(event)}>
        <label className="field"><span>你的姓名</span><input autoFocus required maxLength={30} value={name} onChange={(event) => setName(event.target.value)} placeholder="例如：王工" autoComplete="name" /></label>
        <label className="field"><span>角色</span><input maxLength={40} value={role} onChange={(event) => setRole(event.target.value)} placeholder="例如：后端负责人" /></label>
        {joinError && <div className="service-error" role="alert"><b>无法加入</b><span>{joinError}</span></div>}
        <button className="primary-action" type="submit" disabled={!name.trim() || joining}>{joining ? '正在加入…' : '确认加入会议'}</button>
      </form>
      <button className="text-button" type="button" disabled={exiting} onClick={() => void exit()}>返回首页</button>
    </section></main>;
  }

  const mine = room?.utterances.filter((line) => line.participant_id === participantId) || [];
  const roomStatus = room?.status || 'waiting';
  const statusCopy = roomStatus === 'live' ? '会议进行中' : roomStatus === 'closing' ? '会议正在收尾' : roomStatus === 'ended' ? '会议已结束' : '等待主持人开始';
  const statusHelp = roomStatus === 'live' ? '轮到你发言时开启麦克风，建议佩戴耳机。' : roomStatus === 'closing' ? '正在同步最后的发言，请稍候。' : roomStatus === 'ended' ? '本场会议已结束，你的发言已经保存。' : '主持人开始会议后，你就可以发言。';
  const visibleError = micError || uploadError || syncError;

  return <main className="participant-shell">
    <header className="participant-header">
      <div className="brand"><span className="brand-mark">C²</span><span><strong>催催</strong><small>参与端 · {normalizedCode}</small></span></div>
      <span className={`room-status ${roomStatus}`}><i />{statusCopy}</span>
      <button className="control-chip" type="button" disabled={exiting} onClick={() => void exit()}>{exiting ? '正在退出…' : '退出'}</button>
    </header>
    <section className="participant-main">
      <div className={`room-live-banner ${roomStatus}`} role="status" aria-live="polite"><b>{statusCopy}</b><span>{statusHelp}</span><strong>{normalizedCode}</strong></div>
      <div className="participant-title"><p>{room?.meeting.meetingType}</p><h1>{room?.meeting.title || '正在读取会议信息'}</h1><div>{room?.meeting.agenda.map((item, index) => <span key={`${index}-${item}`}>{index + 1}. {item}</span>)}</div></div>
      <section className="mic-card">
        <div className={`mic-orb ${status === 'listening' ? 'active' : ''}`}><i /><span>{status === 'listening' ? '正在听' : micStarting ? '连接中' : 'MIC'}</span></div>
        <h2>{name}</h2><p>{role} · 轮到你发言时开启麦克风，建议佩戴耳机</p>
        {draft && <div className="participant-draft" aria-live="polite"><span>听写中</span>{draft}</div>}
        {visibleError && <div className="service-error" role="alert"><b>链路提示</b><span>{visibleError}</span></div>}
        <div className="mic-actions">
          {micActive ? <button className="end-button" type="button" onClick={() => void stopMic()}>结束本次发言</button> : <button className="primary-action" type="button" disabled={roomStatus !== 'live' || micStarting} aria-busy={micStarting} onClick={() => void startMic()}>{micStarting ? '正在连接讯飞…' : '开始发言'}</button>}
          <span>{engine === 'iflytek' ? '讯飞实时听写中' : roomStatus === 'live' ? '讯飞听写待命' : statusHelp}</span>
        </div>
      </section>
      <section className="manual-card"><h3>文字补充</h3><p>也可以打字补充观点，催催会以你的名字同步到主持台。</p><textarea rows={3} maxLength={600} value={manualText} onChange={(event) => setManualText(event.target.value)} placeholder="例如：我建议先灰度百分之二十。" /><button type="button" onClick={() => void sendManual()} disabled={!manualText.trim() || manualSending || roomStatus !== 'live'} aria-busy={manualSending}>{manualSending ? '正在同步…' : '发送到主持台'}</button></section>
      <section className="participant-log"><div><p>我的发言</p><b>{mine.length} 段</b></div>{mine.map((line) => <article key={line.id}><time>{Math.round(line.started_at)}s</time><p>{line.text}</p><span>{line.final ? '已同步' : '同步中'}</span></article>)}</section>
    </section>
  </main>;
}
