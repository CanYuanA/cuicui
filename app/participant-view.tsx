'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { HttpChunkTranscriber, XfyunTranscriber, type MeetingTranscriber, type TranscriberOptions, type TranscriberStatus } from './live-transcriber';
import { getDemoSession } from './demo-session-client';

type RoomSnapshot = {
  code: string;
  meeting: { title: string; durationSeconds: number; meetingType: string; agenda: string[] };
  status: 'waiting' | 'live' | 'ended';
  revision: number;
  createdAt: number;
  startedAt: number | null;
  participants: Array<{ id: string; name: string; role: string; last_seen: number }>;
  utterances: Array<{ id: string; participant_id: string; name: string; role: string; text: string; started_at: number; ended_at: number }>;
};

async function postRoom(body: Record<string, unknown>) {
  const response = await fetch('/api/room', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const payload = await response.json() as Record<string, unknown>;
  if (!response.ok) throw new Error(String(payload.error || `HTTP ${response.status}`));
  return payload;
}

export default function ParticipantView({ code, onExit }: { code: string; onExit: () => void }) {
  const [name, setName] = useState('');
  const [role, setRole] = useState('参会者');
  const [participantToken, setParticipantToken] = useState('');
  const [participantId, setParticipantId] = useState('');
  const [room, setRoom] = useState<RoomSnapshot | null>(null);
  const [status, setStatus] = useState<TranscriberStatus | null>(null);
  const [engine, setEngine] = useState<'iflytek' | 'http' | null>(null);
  const [draft, setDraft] = useState('');
  const [manualText, setManualText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [joining, setJoining] = useState(false);
  const [micActive, setMicActive] = useState(false);
  const roomRevisionRef = useRef(0);
  const transcriberRef = useRef<MeetingTranscriber | null>(null);
  const committedCharacters = useRef(0);

  useEffect(() => {
    const timer = window.setTimeout(() => { try {
      const saved = JSON.parse(sessionStorage.getItem(`cuicui-room-${code}`) || 'null') as { token?: string; participantId?: string; name?: string; role?: string } | null;
      if (saved?.token && saved.participantId) { setParticipantToken(saved.token); setParticipantId(saved.participantId); setName(saved.name || '参会者'); setRole(saved.role || '参会者'); }
    } catch { /* session recovery is optional */ } }, 0);
    return () => window.clearTimeout(timer);
  }, [code]);

  const sendUtterance = useCallback(async (text: string) => {
    const clean = text.trim();
    if (!clean || !participantToken) return;
    await postRoom({ action: 'utterance', code, participantToken, text: clean });
  }, [code, participantToken]);

  useEffect(() => {
    if (!participantToken) return;
    let cancelled = false;
    const poll = async () => {
      try {
        const response = await fetch(`/api/room?code=${encodeURIComponent(code)}`, { cache: 'no-store', headers: { Authorization: `Bearer ${participantToken}` } });
        const payload = await response.json() as { room?: RoomSnapshot; error?: string };
        if (!response.ok) { if (response.status === 401) { sessionStorage.removeItem(`cuicui-room-${code}`); setParticipantToken(''); } throw new Error(payload.error || `HTTP ${response.status}`); }
        if (!cancelled && payload.room && payload.room.revision >= roomRevisionRef.current) { roomRevisionRef.current = payload.room.revision; setRoom(payload.room); }
      } catch (reason) {
        if (!cancelled) setError(reason instanceof Error ? reason.message : '无法同步会议');
      }
    };
    void poll();
    const timer = window.setInterval(() => void poll(), 700);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [code, participantToken]);

  useEffect(() => () => { void transcriberRef.current?.stop(); }, []);
  useEffect(() => { if (room?.status === 'ended' && transcriberRef.current) { void transcriberRef.current.stop(); transcriberRef.current = null; setMicActive(false); setEngine(null); } }, [room?.status]);

  const join = async () => {
    if (!name.trim()) return;
    setJoining(true); setError(null);
    try {
      const payload = await postRoom({ action: 'join', code, name, role });
      const token = String(payload.participantToken || '');
      setParticipantToken(token);
      setParticipantId(String(payload.participantId || ''));
      setRoom(payload.room as RoomSnapshot);
      try { sessionStorage.setItem(`cuicui-room-${code}`, JSON.stringify({ token, participantId: payload.participantId, name, role })); } catch { /* optional */ }
    } catch (reason) { setError(reason instanceof Error ? reason.message : '加入失败'); }
    finally { setJoining(false); }
  };

  const startMic = async () => {
    if (transcriberRef.current) return;
    setError(null); committedCharacters.current = 0; setDraft('');
    let accessToken: string;
    try { accessToken = await getDemoSession(); } catch (reason) { setError(reason instanceof Error ? reason.message : '无法创建受控体验会话'); return; }
    const callbacks: TranscriberOptions = {
      accessToken,
      onPartial: (text) => setDraft(text.slice(committedCharacters.current).trimStart()),
      onFinal: (text) => {
        const tail = text.slice(committedCharacters.current).trim();
        if (tail) void sendUtterance(tail).catch((reason) => setError(reason instanceof Error ? reason.message : '发送转写失败'));
        committedCharacters.current = text.length;
        setDraft('');
      },
      onStatus: setStatus,
      onError: (message) => setError(message),
    };
    const direct = new XfyunTranscriber(callbacks);
    transcriberRef.current = direct;
    try {
      await direct.start();
      setMicActive(true);
      setEngine('iflytek');
    } catch (directError) {
      await direct.stop().catch(() => undefined);
      const fallback = new HttpChunkTranscriber(callbacks);
      transcriberRef.current = fallback;
      try {
        await fallback.start();
        setMicActive(true);
        setEngine('http');
        setError(`讯飞直连未建立，已自动切换同源 HTTP 转写：${directError instanceof Error ? directError.message : '网络限制'}`);
      } catch (fallbackError) {
        transcriberRef.current = null;
        setStatus('closed');
        setError(`两条转写链路均未启动：${fallbackError instanceof Error ? fallbackError.message : '未知错误'}`);
      }
    }
  };

  const stopMic = async () => {
    const transcriber = transcriberRef.current;
    transcriberRef.current = null;
    if (transcriber) await transcriber.stop();
    setMicActive(false);
    setEngine(null);
  };

  const sendManual = async () => {
    const text = manualText.trim();
    if (!text) return;
    try { await sendUtterance(text); setManualText(''); } catch (reason) { setError(reason instanceof Error ? reason.message : '发送失败'); }
  };

  const exit = async () => { await stopMic().catch(() => undefined); onExit(); };

  if (!participantToken) {
    return <main className="join-shell">
      <section className="join-card">
        <div className="brand"><span className="brand-mark">C²</span><span><strong>催催</strong><small>会议参与端</small></span></div>
        <p className="eyebrow"><span /> 加入码 {code}</p>
        <h1>加入这场会议</h1>
        <p>每个参与端独立采集音频，因此说话人来自真实成员身份，而不是猜声纹。</p>
        <label className="field"><span>你的姓名</span><input autoFocus value={name} onChange={(event) => setName(event.target.value)} placeholder="例如：王工" /></label>
        <label className="field"><span>角色</span><input value={role} onChange={(event) => setRole(event.target.value)} placeholder="例如：后端负责人" /></label>
        {error && <div className="service-error"><b>无法加入</b><span>{error}</span></div>}
        <button className="primary-action" type="button" disabled={!name.trim() || joining} onClick={() => void join()}>{joining ? '正在加入…' : '确认加入会议'}</button>
        <button className="text-button" type="button" onClick={() => void exit()}>返回首页</button>
      </section>
    </main>;
  }

  const mine = room?.utterances.filter((line) => line.participant_id === participantId) || [];
  return <main className="participant-shell">
    <header className="participant-header">
      <div className="brand"><span className="brand-mark">C²</span><span><strong>催催</strong><small>参与端 · {code}</small></span></div>
      <span className={`room-status ${room?.status || 'waiting'}`}><i />{room?.status === 'live' ? '会议进行中' : room?.status === 'ended' ? '会议已结束' : '等待主持人开始'}</span>
      <button className="control-chip" type="button" onClick={() => void exit()}>退出</button>
    </header>
    <section className="participant-main">
      <div className="participant-title"><p>{room?.meeting.meetingType}</p><h1>{room?.meeting.title || '正在读取会议信息'}</h1><div>{room?.meeting.agenda.map((item, index) => <span key={item}>{index + 1}. {item}</span>)}</div></div>
      <section className="mic-card">
        <div className={`mic-orb ${status === 'listening' ? 'active' : ''}`}><i /><span>{status === 'listening' ? '正在听' : 'MIC'}</span></div>
        <h2>{name}</h2><p>{role} · 身份已绑定到当前音轨</p>
        {draft && <div className="participant-draft"><span>听写中</span>{draft}</div>}
        {error && <div className="service-error"><b>链路提示</b><span>{error}</span></div>}
        <div className="mic-actions">
          {micActive ? <button className="end-button" type="button" onClick={() => void stopMic()}>停止麦克风</button> : <button className="primary-action" type="button" disabled={room?.status !== 'live'} onClick={() => void startMic()}>开启麦克风</button>}
          <span>{engine === 'iflytek' ? '讯飞 40ms 实时流' : engine === 'http' ? 'HTTP 云端转写兜底' : '双链路待命'}</span>
        </div>
      </section>
      <section className="manual-card"><h3>无麦克风也能验收身份链路</h3><p>输入一句话会以你的已验证成员身份发送到主持台。</p><textarea rows={3} value={manualText} onChange={(event) => setManualText(event.target.value)} placeholder="例如：我建议先灰度百分之二十。" /><button type="button" onClick={() => void sendManual()} disabled={!manualText.trim() || room?.status !== 'live'}>发送到主持台</button></section>
      <section className="participant-log"><div><p>我的发言</p><b>{mine.length} 段</b></div>{mine.map((line) => <article key={line.id}><time>{Math.round(line.started_at)}s</time><p>{line.text}</p><span>已同步</span></article>)}</section>
    </section>
  </main>;
}
