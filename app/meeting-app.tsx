'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import {
  DEFAULT_CONFIG,
  EMPTY_REPORT,
  TOPIC_SEGMENTS,
  formatClock,
  getSpeaker,
  type Intervention,
  type MeetingConfig,
  type MeetingReport,
  type Speaker,
  type TranscriptLine,
  type VerifiedRun,
} from './demo-data';
import { XfyunTranscriber, type MeetingTranscriber, type TranscriberOptions, type TranscriberStatus } from './live-transcriber';
import { getDemoSession } from './demo-session-client';
import type { RoomSession, RoomSnapshot } from './room-types';

type Screen = 'setup' | 'meeting' | 'report';
type Mode = 'verified' | 'live' | 'room';
type ServiceHealth = { openrouter: boolean; iflytek: boolean; speech: boolean };
type ActionState = Record<string, 'adopted' | 'parked' | 'ignored'>;
type RoomDraft = {
  hostName: string;
  title: string;
  durationSeconds: number;
  meetingType: string;
  agenda: string[];
};
type PulseSegment = { start: number; end: number; label: string; tone: string };
type RoomUpload = { clientEventId: string; text: string; final: boolean; startedAt: number; endedAt: number };
type ErrorSource = 'room-sync' | 'room-upload' | 'room-control' | 'analysis' | 'microphone' | 'general';

const palette = ['#59e1ff', '#ffc857', '#a8f05a', '#a994ff', '#ff8297', '#ff9f68', '#77e0bc'];
const cloneConfig = () => ({ ...DEFAULT_CONFIG, agenda: [...DEFAULT_CONFIG.agenda], attendees: DEFAULT_CONFIG.attendees.map((person) => ({ ...person })) });
const ROOM_HOST_STORAGE_KEY = 'cuicui-host-room';
const ROOM_ONLINE_WINDOW_MS = 20_000;

function roomJoinUrl(code: string) {
  return `${window.location.origin}/join?code=${encodeURIComponent(code)}`;
}

function roomTranscript(room: RoomSnapshot | null, final: boolean) {
  return (room?.utterances || [])
    .filter((line) => line.final === final)
    .map((line) => ({
      id: line.id,
      at: line.started_at,
      end: line.ended_at,
      speakerId: line.participant_id,
      speaker: line.name,
      text: line.text,
      topic: '多人实时讨论',
      workRelated: true,
      asrSource: line.source === 'iflytek' ? '讯飞实时' : '文字补充',
    } satisfies TranscriptLine));
}

function roomOnlineParticipants(room: RoomSnapshot | null) {
  const now = Date.now();
  return (room?.participants || []).filter((person) => person.online !== false && !person.left_at && now - person.last_seen <= ROOM_ONLINE_WINDOW_MS);
}

function serviceLabel(health: ServiceHealth | null) {
  if (!health) return '正在检查服务';
  const ready = Number(health.openrouter) + Number(health.iflytek) + Number(health.speech);
  return ready === 3 ? '实时服务已就绪' : `${ready}/3 服务就绪`;
}

async function postRoom(body: Record<string, unknown>, bearer?: string, timeoutMs = 10_000) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (bearer) headers.Authorization = `Bearer ${bearer}`;
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch('/api/room', { method: 'POST', headers, body: JSON.stringify(body), signal: controller.signal });
    const payload = await response.json() as Record<string, unknown>;
    if (!response.ok) throw new Error(String(payload.error || `HTTP ${response.status}`));
    return payload;
  } catch (reason) {
    if (controller.signal.aborted) throw new Error('会场请求超时，请检查网络后重试。');
    throw reason;
  } finally {
    window.clearTimeout(timer);
  }
}

function roomSpeakers(room: RoomSnapshot | null): Speaker[] {
  return (room?.participants || []).map((person, index) => ({
    id: person.id,
    name: person.name,
    short: person.name.slice(0, 1) || '?',
    role: person.role,
    color: palette[index % palette.length],
    isPriority: person.role.includes('拍板') || person.role.includes('决策人'),
  }));
}

function ConfigDialog({ config, onSave, onClose }: { config: MeetingConfig; onSave: (value: MeetingConfig) => void; onClose: () => void }) {
  const [draft, setDraft] = useState(() => ({ ...config, agenda: [...config.agenda], attendees: config.attendees.map((person) => ({ ...person })) }));
  const save = () => {
    const title = draft.title.trim();
    const agenda = draft.agenda.map((item) => item.trim()).filter(Boolean);
    if (!title || agenda.length === 0) return;
    onSave({ ...draft, title, agenda, durationSeconds: Math.max(30, Number(draft.durationSeconds) || 115) });
  };
  return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
    <section className="config-dialog" role="dialog" aria-modal="true" aria-labelledby="config-title">
      <div className="dialog-heading"><div><p>会议基准</p><h2 id="config-title">告诉催催，这场会要完成什么</h2></div><button className="icon-button" type="button" onClick={onClose} aria-label="关闭配置">×</button></div>
      <div className="form-grid">
        <label className="field field-wide"><span>会议主题 *</span><input value={draft.title} onChange={(event) => setDraft({ ...draft, title: event.target.value })} /></label>
        <label className="field"><span>计划时长（秒）*</span><input type="number" min="30" max="7200" value={draft.durationSeconds} onChange={(event) => setDraft({ ...draft, durationSeconds: Number(event.target.value) })} /></label>
        <label className="field"><span>会议类型</span><select value={draft.meetingType} onChange={(event) => setDraft({ ...draft, meetingType: event.target.value })}><option>方案决策会</option><option>研发周会</option><option>脑暴会</option><option>汇报会</option><option>评审会</option></select></label>
        <label className="field field-wide"><span>议题列表 *（每行一项）</span><textarea rows={4} value={draft.agenda.join('\n')} onChange={(event) => setDraft({ ...draft, agenda: event.target.value.split('\n') })} /></label>
        <label className="field field-wide"><span>关联资料（可选）</span><input type="url" placeholder="https://…" value={draft.contextUrl || ''} onChange={(event) => setDraft({ ...draft, contextUrl: event.target.value })} /></label>
        <div className="field field-wide"><span>预设参会人员</span><div className="people-editor">{draft.attendees.map((person, index) => <label key={person.id} className={draft.prioritySpeakerId === person.id ? 'person-edit priority' : 'person-edit'}><span className="mini-avatar" style={{ background: person.color }}>{person.short}</span><input aria-label={`第 ${index + 1} 位参会者`} value={person.name} onChange={(event) => { const attendees = draft.attendees.map((item) => item.id === person.id ? { ...item, name: event.target.value, short: event.target.value.slice(0, 1) || item.short } : item); setDraft({ ...draft, attendees }); }} /><input type="radio" name="priority" checked={draft.prioritySpeakerId === person.id} onChange={() => setDraft({ ...draft, prioritySpeakerId: person.id })} /></label>)}</div></div>
      </div>
      <div className="dialog-note"><b>催催会结合议题、计划时长和发言内容判断是否需要介入。</b>没有充分证据时不会打断会议。</div>
      <div className="dialog-actions"><button className="text-button" type="button" onClick={onClose}>取消</button><button className="compact-primary" type="button" onClick={save}>保存会议基准</button></div>
    </section>
  </div>;
}

function RoomDialog({ config, onCreate, onClose }: {
  config: MeetingConfig;
  onCreate: (value: RoomDraft) => Promise<void>;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState<RoomDraft>(() => ({
    hostName: config.attendees[0]?.name || '主持人',
    title: config.title,
    durationSeconds: Math.max(30, config.durationSeconds),
    meetingType: config.meetingType,
    agenda: [...config.agenda],
  }));
  const [joinCode, setJoinCode] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [dialogError, setDialogError] = useState<string | null>(null);

  const create = async () => {
    const value = {
      ...draft,
      hostName: draft.hostName.trim(),
      title: draft.title.trim(),
      durationSeconds: Math.max(30, Math.min(7200, Number(draft.durationSeconds) || 1800)),
      agenda: draft.agenda.map((item) => item.trim()).filter(Boolean),
    };
    if (!value.hostName || !value.title || value.agenda.length === 0) {
      setDialogError('请填写主持姓名、会议主题和至少一项议程。');
      return;
    }
    setSubmitting(true);
    setDialogError(null);
    try {
      await onCreate(value);
      onClose();
    } catch (reason) {
      setDialogError(reason instanceof Error ? reason.message : '创建会场失败，请稍后重试。');
    } finally {
      setSubmitting(false);
    }
  };

  const join = () => {
    const code = joinCode.trim().toUpperCase();
    if (!/^[A-Z2-9]{6}$/.test(code)) {
      setDialogError('请输入完整的 6 位加入码。');
      return;
    }
    window.location.assign(`/join?code=${encodeURIComponent(code)}`);
  };

  return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
    <section className="config-dialog" role="dialog" aria-modal="true" aria-labelledby="room-dialog-title">
      <div className="dialog-heading"><div><p>多人协作</p><h2 id="room-dialog-title">创建或加入多人会议</h2></div><button className="icon-button" type="button" onClick={onClose} aria-label="关闭多人会议对话框">×</button></div>
      <div className="form-grid">
        <label className="field"><span>主持人姓名 *</span><input value={draft.hostName} onChange={(event) => setDraft({ ...draft, hostName: event.target.value })} /></label>
        <label className="field"><span>计划时长（分钟）*</span><input type="number" min="1" max="120" value={Math.max(1, Math.round(draft.durationSeconds / 60))} onChange={(event) => setDraft({ ...draft, durationSeconds: Math.max(1, Number(event.target.value) || 1) * 60 })} /></label>
        <label className="field field-wide"><span>会议主题 *</span><input value={draft.title} onChange={(event) => setDraft({ ...draft, title: event.target.value })} /></label>
        <label className="field"><span>会议类型</span><select value={draft.meetingType} onChange={(event) => setDraft({ ...draft, meetingType: event.target.value })}><option>方案决策会</option><option>研发周会</option><option>脑暴会</option><option>汇报会</option><option>评审会</option></select></label>
        <label className="field field-wide"><span>议程 *（每行一项）</span><textarea rows={4} value={draft.agenda.join('\n')} onChange={(event) => setDraft({ ...draft, agenda: event.target.value.split('\n') })} /></label>
      </div>
      <div className="dialog-actions"><button className="text-button" type="button" onClick={onClose}>取消</button><button className="compact-primary" type="button" disabled={submitting} onClick={() => void create()}>{submitting ? '正在创建…' : '创建会场'}</button></div>
      <div className="room-divider"><span>已有加入码</span></div>
      <div className="form-grid">
        <label className="field field-wide"><span>6 位加入码</span><input value={joinCode} maxLength={6} inputMode="text" autoCapitalize="characters" placeholder="例如 ABC234" onChange={(event) => setJoinCode(event.target.value.toUpperCase().replace(/[^A-Z2-9]/g, '').slice(0, 6))} onKeyDown={(event) => { if (event.key === 'Enter') join(); }} /></label>
      </div>
      <div className="dialog-actions"><button className="compact-primary" type="button" disabled={joinCode.length !== 6} onClick={join}>加入会议</button></div>
      {dialogError && <p className="fixture-error" role="alert">{dialogError}</p>}
    </section>
  </div>;
}

function SetupView({
  config, health, verifiedRun, verifiedError, roomSession, roomSnapshot, roomLoading, roomCopied,
  onConfigure, onStart, onOpenRoom, onCopyRoom, onStartRoom,
}: {
  config: MeetingConfig; health: ServiceHealth | null; verifiedRun: VerifiedRun | null; verifiedError: string | null;
  roomSession: RoomSession | null; roomSnapshot: RoomSnapshot | null; roomLoading: boolean; roomCopied: boolean;
  onConfigure: () => void; onStart: (mode: Mode) => void; onOpenRoom: () => void; onCopyRoom: () => void; onStartRoom: () => void;
}) {
  const online = roomOnlineParticipants(roomSnapshot);
  const roomActionLabel = roomSnapshot?.status === 'live' ? '返回主持台' : roomSnapshot?.status === 'closing' ? '会议收尾中' : roomSnapshot?.status === 'ended' ? '创建新会议' : '开始会议';
  return <main className="preflight-shell">
    <header className="site-header">
      <div className="brand"><span className="brand-mark">C²</span><span><strong>催催</strong><small>会议效率助手</small></span></div>
      <nav className="stage-track"><span className="stage active"><i>1</i> 会前</span><span className="stage-line" /><span className="stage"><i>2</i> 会中</span><span className="stage-line" /><span className="stage"><i>3</i> 会后</span></nav>
      <div className="health-pill"><span className="health-dot" />{serviceLabel(health)}</div>
    </header>
    <section className="hero-grid evidence-first">
      <div className="hero-copy">
        <p className="eyebrow"><span /> 会中干预型会议助手</p>
        <h1>让每一场会，<br /><em>在跑偏之前回到正题。</em></h1>
        <p className="hero-lead">催催持续理解正在发生的讨论，在闲聊、重复、分歧和超时风险真正出现时提醒，并把结论接成下一步行动。</p>
        <div className="evidence-ladder">
          <article><span>01</span><div><b>听懂正在发生什么</b><p>把每段发言逐句整理成会议记录</p></div></article>
          <article><span>02</span><div><b>该提醒时才提醒</b><p>从讨论证据判断闲聊、分歧与预计超时</p></div></article>
          <article><span>03</span><div><b>让会议结果直接落地</b><p>会后自动整理决策、行动项与负责人</p></div></article>
        </div>
        <div className="principle-note"><span className="wave-dot"><i /><i /><i /><i /></span><p><strong>演示从一场会议开始。</strong>你会看到字幕、提醒和报告随着讨论自然发生。</p></div>
      </div>
      <aside className="mission-card proof-mission">
        <div className="card-topline"><span className="mode-badge">推荐演示</span><button className="edit-config" type="button" onClick={onConfigure}>编辑会议 ↗</button></div>
        <p className="card-kicker">催催方案评审会</p><h2>{verifiedRun?.meeting.title || config.title}</h2>
        <div className="proof-status-grid"><div><b>{verifiedRun ? formatClock(verifiedRun.meeting.durationSeconds) : '—'}</b><span>会议时长</span></div><div><b>{verifiedRun?.meeting.attendees.length || '—'}</b><span>参会角色</span></div><div><b>{verifiedRun?.events.length || '—'}</b><span>关键提醒</span></div></div>
        {verifiedRun ? <div className="verified-strip"><span>闲聊偏题</span><span>观点分歧</span><span>预计超时</span></div> : <p className="fixture-error">{verifiedError || '正在准备演示会议…'}</p>}
        <button className="primary-action" type="button" disabled={!verifiedRun} onClick={() => onStart('verified')}><span className="play-mark" />开始演示会议<kbd>Space</kbd></button>
        <div className="room-divider"><span>更多体验方式</span></div>
        {!roomSession ? <button className="room-create-button" type="button" disabled={roomLoading} onClick={onOpenRoom}>{roomLoading ? '正在创建会场…' : '创建或加入多人会议'}<span>多人协作 →</span></button> : <div className="room-ready-card">
          <div><span>{online.length} 人在线</span><strong>{roomSession.code}</strong></div>
          <p>{roomSession.joinUrl}</p>
          <p>{online.length ? `在线成员：${online.map((person) => `${person.name}（${person.role}）`).join('、')}` : '正在等待成员加入'}</p>
          <div><button type="button" onClick={onCopyRoom}>{roomCopied ? '链接已复制' : '复制分享链接'}</button><button type="button" disabled={roomLoading || roomSnapshot?.status === 'closing'} onClick={onStartRoom}>{roomLoading ? '正在进入…' : roomActionLabel}</button></div>
        </div>}
        <button className="secondary-action" type="button" onClick={() => onStart('live')}>使用麦克风实时体验<span>讯飞实时听写 →</span></button>
      </aside>
    </section>
    <footer className="preflight-footer"><span><i className={health?.iflytek ? 'status-ok' : 'status-warn'} /> 讯飞实时听写</span><span><i className={health?.openrouter ? 'status-ok' : 'status-warn'} /> 会中语义分析</span><span><i className={verifiedRun ? 'status-ok' : 'status-warn'} /> 动态会议报告</span><p>Agent 面前，老板也会被平等地催一下。</p></footer>
  </main>;
}

function PulseTimeline({ elapsed, duration, events, compact = false, segments = TOPIC_SEGMENTS, labels }: { elapsed: number; duration: number; events: Intervention[]; compact?: boolean; segments?: readonly PulseSegment[]; labels?: string[] }) {
  const progress = Math.max(0, Math.min(100, elapsed / Math.max(1, duration) * 100));
  const displayLabels = labels?.length ? labels.slice(0, 4) : ['开场', '问题', '方案', '收敛'];
  return <div className={compact ? 'pulse-widget compact' : 'pulse-widget'}><div className="pulse-widget-head"><span>会议脉冲带</span><b>{Math.round(progress)}%</b></div><div className="topic-pulse">{segments.map((segment) => { const visibleEnd = Math.min(segment.end, progress); return visibleEnd > segment.start ? <span key={`${segment.start}-${segment.label}`} className={`topic-segment ${segment.tone}`} style={{ left: `${segment.start}%`, width: `${visibleEnd - segment.start}%` }} title={segment.label} /> : null; })}{events.map((event) => <i key={event.id} className={`pulse-event ${event.severity}`} style={{ left: `${Math.min(100, event.at / Math.max(1, duration) * 100)}%` }} title={`${formatClock(event.at)} ${event.label}`} />)}<span className="pulse-progress" style={{ width: `${progress}%` }} /><span className="pulse-cursor" style={{ left: `${progress}%` }} /></div>{!compact && <div className="pulse-label-row">{displayLabels.map((label) => <span key={label}>{label}</span>)}</div>}</div>;
}

function MeetingView({
  config, mode, roomCode, roomCount, engine, elapsed, running, speed, soundOn, liveStatus, selectedSpeakerId,
  transcript, partialTranscript, liveDraft, events, actionState, parkingItems, error, verifiedRun, roomClosing, roomEndInFlight, hostMicActive,
  onPause, onSpeed, onSound, onSkip, onEnd, onReset, onSpeaker, onCommitDraft, onAction, onHostMic,
}: {
  config: MeetingConfig; mode: Mode; roomCode?: string; roomCount?: number; engine: 'iflytek' | null;
  elapsed: number; running: boolean; speed: number; soundOn: boolean; liveStatus: TranscriberStatus | null; selectedSpeakerId: string;
  transcript: TranscriptLine[]; partialTranscript: TranscriptLine[]; liveDraft: string; events: Intervention[]; actionState: ActionState; parkingItems: string[]; error: string | null;
  verifiedRun: VerifiedRun | null; roomClosing: boolean; roomEndInFlight: boolean; hostMicActive: boolean;
  onPause: () => void; onSpeed: () => void; onSound: () => void; onSkip: () => void; onEnd: () => void; onReset: () => void;
  onSpeaker: (id: string) => void; onCommitDraft: () => void; onAction: (event: Intervention, action: 'adopt' | 'park' | 'ignore') => void; onHostMic: () => void;
}) {
  const listRef = useRef<HTMLDivElement>(null);
  const duration = config.durationSeconds;
  const progress = Math.max(0, Math.min(100, elapsed / duration * 100));
  const latestEvent = events.at(-1) || null;
  const hasTimeRisk = events.some((event) => event.type === 'time');
  const remaining = Math.max(0, duration - elapsed);
  const agendaIndex = mode === 'verified' ? (progress < 58 ? 0 : 1) : Math.min(Math.max(0, config.agenda.length - 1), Math.floor(progress / Math.max(1, 100 / Math.max(1, config.agenda.length))));
  const visibleAgenda = config.agenda[agendaIndex] || config.agenda[0];
  const liveSegments = useMemo<readonly PulseSegment[]>(() => {
    if (mode === 'verified') return TOPIC_SEGMENTS;
    const count = Math.max(1, config.agenda.length);
    return config.agenda.map((label, index) => ({ start: index / count * 100, end: (index + 1) / count * 100, label, tone: 'focus' }));
  }, [mode, config.agenda]);
  const speakerSeconds = useMemo(() => {
    const result = new Map<string, number>();
    for (const line of transcript) result.set(line.speakerId, (result.get(line.speakerId) || 0) + Math.max(1, Math.min(line.end, elapsed) - line.at));
    return result;
  }, [transcript, elapsed]);
  const totalSpeech = Math.max(1, [...speakerSeconds.values()].reduce((sum, value) => sum + value, 0));
  const modeCopy = mode === 'verified' ? '演示会议 · 提醒随讨论出现' : mode === 'room' ? `多人会场 ${roomCode} · ${roomCount || 1} 人在线` : `单人麦克风 · ${engine === 'iflytek' ? '讯飞实时听写' : liveStatus || '准备中'}`;
  const partialTranscriptKey = partialTranscript.map((line) => `${line.id}:${line.text}`).join('|');
  useEffect(() => { listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: 'smooth' }); }, [transcript.length, liveDraft, partialTranscriptKey]);
  return <main className={mode === 'verified' ? 'meeting-shell has-audio-proof' : mode === 'room' ? 'meeting-shell mode-room' : 'meeting-shell'}>
    <header className="meeting-header"><button className="brand brand-button" type="button" disabled={mode === 'room' && roomEndInFlight} onClick={mode === 'room' ? onEnd : onReset}><span className="brand-mark">C²</span><span><strong>催催</strong><small>会议效率助手</small></span></button><div className="meeting-title"><span className={mode === 'verified' ? 'live-dot demo' : 'live-dot'} /><div><b>{config.title}</b><small>{modeCopy}</small></div></div><div className="meeting-controls">{mode === 'room' ? <button type="button" className={hostMicActive ? 'control-chip room-mic-control active' : 'control-chip room-mic-control'} disabled={roomClosing || roomEndInFlight} onClick={onHostMic}>{hostMicActive ? '关闭主持麦克风' : '开启主持麦克风'}</button> : <>{mode === 'verified' && <button type="button" className="control-chip" onClick={onSpeed}>{speed}×</button>}<button type="button" className={soundOn ? 'control-chip active' : 'control-chip'} onClick={onSound}>{soundOn ? '声音开' : '声音关'}</button><button type="button" className="control-chip" onClick={onPause}>{running ? '暂停' : '继续'}</button></>}<button type="button" className="end-button" disabled={roomEndInFlight} onClick={onEnd}>{roomEndInFlight ? '正在收尾…' : roomClosing ? '完成收尾' : '结束会议'}</button></div></header>
    {mode === 'verified' && verifiedRun && <section className="audio-proof-bar"><div><span className="proof-icon">REC</span><div><b>会议录音</b><p>字幕和提醒会随着实际进度逐步出现</p></div></div><button className={running ? 'audio-transport playing' : 'audio-transport'} type="button" onClick={onPause}><i /><span><b>{running ? '会议进行中' : '会议已暂停'}</b><small>{formatClock(elapsed)} / {formatClock(config.durationSeconds)} · 点击{running ? '暂停' : '继续'}</small></span></button></section>}
    <section className="time-command"><div className="topic-now"><small>当前议题</small><b>{visibleAgenda}</b></div><div className="time-progress"><div className="time-copy"><span>已进行 {formatClock(elapsed)}</span><strong>剩余 {formatClock(remaining)}</strong><span>{mode === 'verified' ? '会议时间轴' : '实时语义分析'}</span></div><div className="time-track"><i style={{ width: `${progress}%` }} className={progress >= 90 ? 'danger' : progress >= 75 ? 'warning' : ''} /></div></div><div className={hasTimeRisk || progress >= 75 ? 'forecast warning' : 'forecast'}><small>节奏预测</small><b>{hasTimeRisk ? '预计超时 · 请立即收敛' : progress < 58 ? '按时推进' : progress < 75 ? '需要收敛' : progress < 92 ? '决策时间不足' : '准备生成报告'}</b></div></section>
    {(error || roomClosing) && <div className="service-error" role="status"><b>{roomClosing ? '会议收尾中' : '链路提示'}</b><span>{roomClosing ? '正在等待所有成员提交最后一句，随后生成完整报告。' : error}</span></div>}
    <section className="meeting-grid"><section className="transcript-panel"><div className="panel-heading"><div><p>{mode === 'verified' ? '随发言更新' : '实时现场'}</p><h2>会议字幕</h2></div><div className="signal-bars"><i /><i /><i /><i /><i /></div></div>
      {mode === 'live' && <div className="speaker-switcher"><span>当前发言者</span>{config.attendees.map((person, index) => <button type="button" key={person.id} className={selectedSpeakerId === person.id ? 'speaker-pill active' : 'speaker-pill'} onClick={() => onSpeaker(person.id)} style={{ '--speaker': person.color } as CSSProperties}><i>{person.short}</i>{person.name}<kbd>{index + 1}</kbd></button>)}<button type="button" className="commit-draft" disabled={!liveDraft.trim()} onClick={onCommitDraft}>提交这一句</button></div>}
      {mode === 'room' && <div className="room-live-banner"><b>多人会议进行中</b><span>正在聚合 {roomCount || 1} 位成员的实时转写</span><strong>{roomCode}</strong></div>}
      <div className="transcript-list" ref={listRef} aria-live="polite">{transcript.length === 0 && partialTranscript.length === 0 && !liveDraft && <div className="list-empty"><span className="listening-orbit"><i /></span><b>{mode === 'room' ? '等待参会者发言…' : mode === 'verified' ? '会议开始后，字幕会逐句出现' : '正在等待第一句话…'}</b><p>每句发言结束后形成稳定字幕。</p></div>}{transcript.map((line, index) => { const speaker = getSpeaker(line.speakerId, config.attendees); return <article className={index === transcript.length - 1 ? 'transcript-line latest' : 'transcript-line'} key={line.id} style={{ '--speaker': speaker.color } as CSSProperties}><time>{formatClock(line.at)}</time><span className="line-avatar">{speaker.short}</span><div><p className="speaker-name">{speaker.name}{speaker.isPriority && <em>拍板人</em>}{line.interrupted && <em className="interrupted">被打断</em>}</p><p className="line-copy">{line.text || '（本句未识别）'}</p><span className="line-topic"># {line.topic || '实时讨论'}</span></div></article>; })}{partialTranscript.filter((line) => !(liveDraft && line.speakerId === selectedSpeakerId)).map((line) => { const speaker = getSpeaker(line.speakerId, config.attendees); return <article className="transcript-line latest draft" key={`partial-${line.id}`} style={{ '--speaker': speaker.color } as CSSProperties}><time>{formatClock(line.at)}</time><span className="line-avatar">{speaker.short}</span><div><p className="speaker-name">{speaker.name}<em>听写中</em></p><p className="line-copy">{line.text}<span className="typing-cursor" /></p></div></article>; })}{liveDraft && <article className="transcript-line latest draft" style={{ '--speaker': getSpeaker(selectedSpeakerId, config.attendees).color } as CSSProperties}><time>{formatClock(elapsed)}</time><span className="line-avatar">{getSpeaker(selectedSpeakerId, config.attendees).short}</span><div><p className="speaker-name">{getSpeaker(selectedSpeakerId, config.attendees).name}<em>听写中</em></p><p className="line-copy">{liveDraft}<span className="typing-cursor" /></p></div></article>}</div>
    </section><aside className="assistant-panel"><div className="assistant-heading"><div><span className="ai-orb"><i /></span><div><p>CUICUI AGENT</p><h2>现场干预</h2></div></div><span className="agent-state"><i /> {roomClosing ? '正在收尾' : running ? '持续分析' : '已暂停'}</span></div><section className={latestEvent ? `intervention-card ${latestEvent.severity}` : 'intervention-card calm'}>{!latestEvent ? <div className="calm-state"><span>✓</span><div><b>尚无充分介入证据</b><p>正在结合转写、议题和剩余时间判断。</p></div></div> : <><div className="intervention-top"><span>{latestEvent.label}</span><time>{formatClock(latestEvent.at)}</time></div><div className="intervention-copy"><p><b>观察</b>{latestEvent.observation}</p><p><b>影响</b>{latestEvent.impact}</p><p><b>建议</b>{latestEvent.suggestion}</p></div><div className="evidence-line"><span>判断依据</span><b>{latestEvent.evidence}</b></div>{latestEvent.actions && !actionState[latestEvent.id] && <div className="intervention-actions">{latestEvent.actions.includes('adopt') && <button type="button" onClick={() => onAction(latestEvent, 'adopt')}>采纳建议</button>}{latestEvent.actions.includes('park') && <button type="button" onClick={() => onAction(latestEvent, 'park')}>放入停车场</button>}{latestEvent.actions.includes('ignore') && <button type="button" className="quiet" onClick={() => onAction(latestEvent, 'ignore')}>忽略</button>}</div>}{actionState[latestEvent.id] && <div className="action-confirmed">✓ 本次操作已记录</div>}</>}</section><PulseTimeline elapsed={elapsed} duration={duration} events={events} segments={liveSegments} labels={mode === 'verified' ? undefined : config.agenda} /><section className="speaker-stats"><div className="mini-section-head"><span>发言分布</span><b>{transcript.length} 段转写</b></div>{config.attendees.map((person) => { const seconds = speakerSeconds.get(person.id) || 0; const share = seconds / totalSpeech * 100; return <div className="speaker-stat" key={person.id}><span className="stat-avatar" style={{ background: person.color }}>{person.short}</span><span className="stat-name">{person.name}</span><div className="stat-bar"><i style={{ width: `${share}%`, background: person.color }} /></div><b>{Math.round(share)}%</b></div>; })}</section>{parkingItems.length > 0 && <section className="parking-lot"><div className="mini-section-head"><span>会后停车场</span><b>{parkingItems.length} 项</b></div>{parkingItems.map((item) => <p key={item}>↳ {item}</p>)}</section>}</aside></section>
    <footer className="meeting-footer"><span>{mode === 'verified' ? '会议字幕同步中' : '同类提醒冷却 20 秒'}</span><span>催催正在判断是否需要介入</span>{mode === 'verified' && <button type="button" onClick={onSkip}>跳到下个触发点 →</button>}</footer>
  </main>;
}

function ReportView({ config, report, events, loading, mode, onReplay, onReset }: { config: MeetingConfig; report: MeetingReport; events: Intervention[]; loading: boolean; mode: Mode; onReplay: () => void; onReset: () => void }) {
  const [selectedEvent, setSelectedEvent] = useState<Intervention | null>(events[0] || null);
  const reportSegments = useMemo<readonly PulseSegment[]>(() => {
    if (mode === 'verified') return TOPIC_SEGMENTS;
    const count = Math.max(1, config.agenda.length);
    return config.agenda.map((label, index) => ({ start: index / count * 100, end: (index + 1) / count * 100, label, tone: 'focus' }));
  }, [mode, config.agenda]);
  const exportReport = () => { const blob = new Blob([JSON.stringify({ meeting: config, report, interventions: events }, null, 2)], { type: 'application/json;charset=utf-8' }); const url = URL.createObjectURL(blob); const link = document.createElement('a'); link.href = url; link.download = `催催会议报告-${new Date().toISOString().slice(0, 10)}.json`; link.click(); URL.revokeObjectURL(url); };
  return <main className="report-shell"><header className="report-header"><button className="brand brand-button" type="button" onClick={onReset}><span className="brand-mark">C²</span><span><strong>催催</strong><small>会议效率助手</small></span></button><nav className="stage-track"><span className="stage done"><i>✓</i> 会前</span><span className="stage-line done" /><span className="stage done"><i>✓</i> 会中</span><span className="stage-line done" /><span className="stage active"><i>3</i> 会后</span></nav><div className="report-actions"><button type="button" onClick={() => window.print()}>打印 / PDF</button><button type="button" onClick={exportReport}>导出纪要</button></div></header>
    {loading && <div className="report-loading"><span className="ai-orb"><i /></span><b>催催正在整理本次会议…</b><p>正在梳理摘要、决策和行动项。</p></div>}
    <section className="report-hero"><div className="score-orbit" style={{ '--score': `${report.overall * 3.6}deg` } as CSSProperties}><div><strong>{report.overall}</strong><span>效率综合分</span></div></div><div className="verdict-block"><p>催催判词</p><h1>{report.verdict}</h1><div className="necessity-verdict"><span>{report.necessity}</span><p>{report.necessityReason}</p></div></div><div className="report-meta"><span><small>实际 / 计划</small><b>{formatClock(report.actualSeconds)} / {formatClock(config.durationSeconds)}</b></span><span><small>会中干预</small><b>{events.length} 次</b></span><span><small>行动项</small><b>{report.actions.length} 项</b></span></div></section>
    <section className="report-evidence"><div className="report-section-heading"><div><p>关键节点复盘</p><h2>沿着时间轴回看会议变化</h2></div><span>点击标记查看当时讨论</span></div><div className="replay-timeline"><PulseTimeline elapsed={config.durationSeconds} duration={config.durationSeconds} events={events} compact segments={reportSegments} />{events.map((event) => <button type="button" key={event.id} className={`replay-marker ${event.severity} ${selectedEvent?.id === event.id ? 'active' : ''}`} style={{ left: `${Math.min(100, event.at / config.durationSeconds * 100)}%` }} onClick={() => setSelectedEvent(event)}><i /></button>)}</div>{selectedEvent && <article className={`replay-detail ${selectedEvent.severity}`}><div><time>{formatClock(selectedEvent.at)}</time><b>{selectedEvent.label}</b></div><p>{selectedEvent.observation}</p><span>{selectedEvent.evidence}</span></article>}</section>
    <section className="report-grid"><article className="report-card score-card"><div className="report-section-heading small"><div><p>四维评分</p><h2>由本次数据计算</h2></div></div>{report.scores.map((score) => <div className="score-row" key={score.key}><div><b>{score.label}</b><span>{score.detail}</span></div><div className="score-bar"><i style={{ width: `${score.value}%` }} /></div><strong>{score.value}</strong></div>)}</article><article className="report-card summary-card"><div className="report-section-heading small"><div><p>会议结果</p><h2>摘要与明确结论</h2></div></div><p className="summary-copy">{report.summary}</p><div className="result-list"><h3>已形成决策</h3>{report.decisions.length ? report.decisions.map((item) => <p key={item}><span>✓</span>{item}</p>) : <p><span>·</span>尚未识别明确决策</p>}</div></article><article className="report-card actions-card"><div className="report-section-heading small"><div><p>下一步</p><h2>行动项</h2></div></div>{report.actions.length ? report.actions.map((action) => <div className="action-item" key={`${action.owner}-${action.task}`}><span>{action.owner.slice(0, 1)}</span><div><b>{action.task}</b><p>{action.owner} · {action.due}</p></div></div>) : <p className="empty-report-copy">本次没有识别到行动项。</p>}</article><article className="report-card participation-card"><div className="report-section-heading small"><div><p>参与度</p><h2>谁在推动讨论</h2></div></div><div className="participation-list">{report.speakerStats.map((stat) => { const person = getSpeaker(stat.id, config.attendees); return <div key={stat.id}><span className="stat-avatar" style={{ background: person.color }}>{person.short}</span><b>{person.name}</b><div><i style={{ width: `${stat.share}%`, background: person.color }} /></div><strong>{stat.share.toFixed(1)}%</strong></div>; })}</div><p className="attendance-advice"><span>参会建议</span>{report.attendanceAdvice}</p></article><article className="report-card suggestions-card"><div className="report-section-heading small"><div><p>下次更好</p><h2>可执行改进</h2></div></div><ol>{report.suggestions.map((suggestion) => <li key={suggestion}>{suggestion}</li>)}</ol></article></section>
    <footer className="report-footer"><div><b>这场会的结论已经整理完成</b><span>可以导出报告，也可以返回重新体验</span></div><button type="button" onClick={onReset}>{mode === 'room' ? '创建新会议' : '返回会前'}</button>{mode === 'verified' && <button className="replay-button" type="button" onClick={onReplay}>重新播放录音</button>}</footer>
  </main>;
}

function HostMeetingApp() {
  const [screen, setScreen] = useState<Screen>('setup');
  const [mode, setMode] = useState<Mode>('verified');
  const [config, setConfig] = useState<MeetingConfig>(cloneConfig);
  const [health, setHealth] = useState<ServiceHealth | null>(null);
  const [verifiedRun, setVerifiedRun] = useState<VerifiedRun | null>(null);
  const [verifiedError, setVerifiedError] = useState<string | null>(null);
  const [showConfig, setShowConfig] = useState(false);
  const [showRoomDialog, setShowRoomDialog] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [running, setRunning] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [soundOn, setSoundOn] = useState(true);
  const [liveLines, setLiveLines] = useState<TranscriptLine[]>([]);
  const [liveDraft, setLiveDraft] = useState('');
  const [liveEvents, setLiveEvents] = useState<Intervention[]>([]);
  const [liveStatus, setLiveStatus] = useState<TranscriberStatus | null>(null);
  const [engine, setEngine] = useState<'iflytek' | null>(null);
  const [selectedSpeakerId, setSelectedSpeakerId] = useState('host');
  const [actionState, setActionState] = useState<ActionState>({});
  const [parkingItems, setParkingItems] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [report, setReport] = useState<MeetingReport>(EMPTY_REPORT);
  const [reportLoading, setReportLoading] = useState(false);
  const [roomSession, setRoomSession] = useState<RoomSession | null>(null);
  const [roomSnapshot, setRoomSnapshot] = useState<RoomSnapshot | null>(null);
  const [roomDraftLines, setRoomDraftLines] = useState<TranscriptLine[]>([]);
  const [roomLoading, setRoomLoading] = useState(false);
  const [roomCopied, setRoomCopied] = useState(false);
  const [roomClosing, setRoomClosing] = useState(false);
  const [roomEndInFlight, setRoomEndInFlight] = useState(false);
  const [hostMicActive, setHostMicActive] = useState(false);
  const [analysisRetryTick, setAnalysisRetryTick] = useState(0);
  const transcriberRef = useRef<MeetingTranscriber | null>(null);
  const transcriberTransitionRef = useRef<Promise<void>>(Promise.resolve());
  const transcriberStartingRef = useRef(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const liveLinesRef = useRef<TranscriptLine[]>([]);
  const engineRef = useRef<'iflytek' | null>(null);
  const roomRevisionRef = useRef(0);
  const roomSessionRef = useRef<RoomSession | null>(null);
  const roomSnapshotRef = useRef<RoomSnapshot | null>(null);
  const roomUploadQueueRef = useRef<Promise<void>>(Promise.resolve());
  const roomUploadFailureRef = useRef<Error | null>(null);
  const roomLatestPartialSeqRef = useRef(new Map<string, number>());
  const roomFinalQueuedRef = useRef(new Set<string>());
  const roomEndInFlightRef = useRef(false);
  const roomSeqRef = useRef(0);
  const roomClientEventIdRef = useRef('');
  const roomDraftStartedAtRef = useRef<number | null>(null);
  const roomPendingPartialRef = useRef<RoomUpload | null>(null);
  const roomPartialTimerRef = useRef<number | null>(null);
  const roomLastPartialAtRef = useRef(0);
  const roomRecognitionRef = useRef('');
  const roomCommittedCharsRef = useRef(0);
  const lastRoomAnalyzedAtRef = useRef(0);
  const roomReportStartedRef = useRef(false);
  const errorSourceRef = useRef<ErrorSource | null>(null);
  const analysisRetryTimerRef = useRef<number | null>(null);

  const showScopedError = useCallback((source: ErrorSource, message: string) => {
    errorSourceRef.current = source;
    setError(message);
  }, []);
  const clearScopedError = useCallback((source: ErrorSource) => {
    if (errorSourceRef.current !== source) return;
    errorSourceRef.current = null;
    setError(null);
  }, []);
  const clearAllErrors = useCallback(() => {
    errorSourceRef.current = null;
    setError(null);
  }, []);
  const elapsedRef = useRef(0);
  const selectedSpeakerRef = useRef('host');
  const fullRecognitionRef = useRef('');
  const committedCharsRef = useRef(0);
  const lastSpokenRef = useRef('');
  const lastAnalyzedRef = useRef('');

  useEffect(() => {
    void fetch('/api/health', { cache: 'no-store' }).then((response) => response.json() as Promise<{ services: ServiceHealth }>).then((data) => setHealth(data.services)).catch(() => setHealth({ openrouter: false, iflytek: false, speech: true }));
    void fetch('/demo/verified-run.json', { cache: 'no-store' }).then(async (response) => { if (!response.ok) throw new Error('演示会议尚未准备好'); return response.json() as Promise<VerifiedRun>; }).then((data) => { setVerifiedRun(data); const meeting = data.meeting; setConfig({ title: meeting.title, durationSeconds: meeting.durationSeconds, meetingType: meeting.meetingType, agenda: meeting.agenda, attendees: meeting.attendees, prioritySpeakerId: meeting.prioritySpeakerId || 'boss', contextUrl: meeting.contextUrl || '' }); }).catch((reason) => setVerifiedError(reason instanceof Error ? reason.message : '无法读取演示会议'));
    const timer = window.setTimeout(() => { try { const saved = localStorage.getItem('cuicui-meeting-config'); if (saved) setConfig((current) => ({ ...current, ...JSON.parse(saved) })); } catch { /* preference optional */ } }, 0);
    return () => window.clearTimeout(timer);
  }, []);
  useEffect(() => { elapsedRef.current = elapsed; }, [elapsed]);
  useEffect(() => { liveLinesRef.current = liveLines; }, [liveLines]);
  useEffect(() => { selectedSpeakerRef.current = selectedSpeakerId; }, [selectedSpeakerId]);
  useEffect(() => { roomSessionRef.current = roomSession; }, [roomSession]);
  useEffect(() => { roomSnapshotRef.current = roomSnapshot; }, [roomSnapshot]);
  useEffect(() => {
    const timer = window.setTimeout(() => { try {
      const saved = JSON.parse(sessionStorage.getItem(ROOM_HOST_STORAGE_KEY) || 'null') as Partial<RoomSession> | null;
      if (saved?.code && saved.hostToken && saved.participantToken && saved.participantId) {
        const restored: RoomSession = { code: String(saved.code).toUpperCase(), hostToken: String(saved.hostToken), participantToken: String(saved.participantToken), participantId: String(saved.participantId), expiresAt: Number(saved.expiresAt || 0), joinUrl: roomJoinUrl(String(saved.code).toUpperCase()) };
        roomSessionRef.current = restored;
        setRoomSession(restored);
      }
    } catch { sessionStorage.removeItem(ROOM_HOST_STORAGE_KEY); } }, 0);
    return () => window.clearTimeout(timer);
  }, []);
  useEffect(() => () => { if (roomPartialTimerRef.current !== null) window.clearTimeout(roomPartialTimerRef.current); if (analysisRetryTimerRef.current !== null) window.clearTimeout(analysisRetryTimerRef.current); void transcriberRef.current?.stop(); audioRef.current?.pause(); }, []);

  useEffect(() => {
    if (!roomSession) return;
    let cancelled = false;
    let inFlight = false;
    const poll = async () => {
      if (inFlight) return; inFlight = true;
      const controller = new AbortController();
      const requestTimer = window.setTimeout(() => controller.abort(), 5000);
      try {
        const response = await fetch(`/api/room?code=${encodeURIComponent(roomSession.code)}`, { cache: 'no-store', headers: { Authorization: `Bearer ${roomSession.participantToken}` }, signal: controller.signal });
        const payload = await response.json() as { room?: RoomSnapshot; error?: string };
        if (!response.ok) {
          if (response.status === 401 || response.status === 404 || response.status === 410) {
            try { sessionStorage.removeItem(ROOM_HOST_STORAGE_KEY); } catch { /* storage is optional */ }
            roomSessionRef.current = null;
            roomSnapshotRef.current = null;
            if (!cancelled) { setRoomSession(null); setRoomSnapshot(null); }
          }
          throw new Error(payload.error || `HTTP ${response.status}`);
        }
        if (!cancelled) clearScopedError('room-sync');
        if (!cancelled && payload.room && payload.room.revision >= roomRevisionRef.current) {
          roomRevisionRef.current = payload.room.revision;
          roomSnapshotRef.current = payload.room;
          setRoomSnapshot(payload.room);
          if (mode === 'room') {
            const finalLines = roomTranscript(payload.room, true);
            liveLinesRef.current = finalLines;
            setLiveLines(finalLines);
            setRoomDraftLines(roomTranscript(payload.room, false));
            setRoomClosing(payload.room.status === 'closing');
            if (payload.room.status === 'closing' || payload.room.status === 'ended') setRunning(false);
          }
        }
      } catch (reason) { if (!cancelled) showScopedError('room-sync', controller.signal.aborted ? '会场同步超时，正在自动重试。' : reason instanceof Error ? reason.message : '会场同步失败'); }
      finally { window.clearTimeout(requestTimer); inFlight = false; }
    };
    void poll();
    const timer = window.setInterval(() => void poll(), 1000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [roomSession, mode, clearScopedError, showScopedError]);

  const displayConfig = useMemo(() => {
    if (mode === 'room' && roomSnapshot) {
      const attendees = roomSpeakers(roomSnapshot);
      return { ...config, ...roomSnapshot.meeting, attendees: attendees.length ? attendees : config.attendees, prioritySpeakerId: attendees.find((person) => person.isPriority)?.id || attendees[0]?.id || config.prioritySpeakerId };
    }
    if (mode === 'verified' && verifiedRun) return verifiedRun.meeting;
    return config;
  }, [mode, roomSnapshot, config, verifiedRun]);

  const roomElapsedNow = useCallback(() => {
    const snapshot = roomSnapshotRef.current;
    if (!snapshot?.startedAt) return Math.max(0, elapsedRef.current);
    const endpoint = snapshot.endedAt || Date.now();
    return Math.max(0, (endpoint - snapshot.startedAt) / 1000);
  }, []);

  const enqueueRoomUpload = useCallback((upload: RoomUpload) => {
    const session = roomSessionRef.current;
    if (!session) return Promise.reject(new Error('主持会场身份已失效，请返回首页重新创建。'));
    const seq = ++roomSeqRef.current;
    if (upload.final) roomFinalQueuedRef.current.add(upload.clientEventId);
    else roomLatestPartialSeqRef.current.set(upload.clientEventId, seq);
    const operation = roomUploadQueueRef.current.then(async () => {
      if (!upload.final && (roomFinalQueuedRef.current.has(upload.clientEventId) || roomLatestPartialSeqRef.current.get(upload.clientEventId) !== seq)) return;
      const attempts = upload.final ? 3 : 1;
      let lastError: unknown = null;
      for (let attempt = 0; attempt < attempts; attempt += 1) {
        try {
          await postRoom({
            action: 'utterance',
            code: session.code,
            clientEventId: upload.clientEventId,
            seq,
            text: upload.text,
            final: upload.final,
            source: 'iflytek',
            startedAt: upload.startedAt,
            endedAt: upload.endedAt,
          }, session.participantToken, upload.final ? Math.max(900, 1800 - attempt * 400) : 1500);
          if (upload.final) roomUploadFailureRef.current = null;
          clearScopedError('room-upload');
          return;
        } catch (reason) {
          lastError = reason;
          if (attempt + 1 < attempts) await new Promise((resolve) => window.setTimeout(resolve, 250 * (attempt + 1)));
        }
      }
      throw lastError instanceof Error ? lastError : new Error('主持人转写上传失败');
    });
    roomUploadQueueRef.current = operation.catch((reason) => {
      const failure = reason instanceof Error ? reason : new Error('主持人转写上传失败');
      if (upload.final) roomUploadFailureRef.current = failure;
      showScopedError('room-upload', failure.message);
    }).finally(() => {
      if (upload.final) {
        roomFinalQueuedRef.current.delete(upload.clientEventId);
        roomLatestPartialSeqRef.current.delete(upload.clientEventId);
      }
    });
    return operation;
  }, [clearScopedError, showScopedError]);

  const flushRoomPartial = useCallback(() => {
    if (roomPartialTimerRef.current !== null) window.clearTimeout(roomPartialTimerRef.current);
    roomPartialTimerRef.current = null;
    const pending = roomPendingPartialRef.current;
    roomPendingPartialRef.current = null;
    if (!pending?.text.trim()) return;
    roomLastPartialAtRef.current = Date.now();
    void enqueueRoomUpload(pending).catch(() => undefined);
  }, [enqueueRoomUpload]);

  const scheduleRoomPartial = useCallback((text: string) => {
    const clean = text.trim();
    if (!clean) return;
    if (!roomClientEventIdRef.current) roomClientEventIdRef.current = crypto.randomUUID();
    if (roomDraftStartedAtRef.current === null) roomDraftStartedAtRef.current = roomElapsedNow();
    roomPendingPartialRef.current = {
      clientEventId: roomClientEventIdRef.current,
      text: clean,
      final: false,
      startedAt: roomDraftStartedAtRef.current,
      endedAt: roomElapsedNow(),
    };
    if (roomPartialTimerRef.current !== null) return;
    const delay = Math.max(0, 800 - (Date.now() - roomLastPartialAtRef.current));
    roomPartialTimerRef.current = window.setTimeout(flushRoomPartial, delay);
  }, [flushRoomPartial, roomElapsedNow]);

  const finalizeRoomDraft = useCallback((text: string) => {
    if (roomPartialTimerRef.current !== null) window.clearTimeout(roomPartialTimerRef.current);
    roomPartialTimerRef.current = null;
    const clean = text.trim() || roomPendingPartialRef.current?.text.trim() || '';
    roomPendingPartialRef.current = null;
    if (clean) {
      if (!roomClientEventIdRef.current) roomClientEventIdRef.current = crypto.randomUUID();
      const upload: RoomUpload = {
        clientEventId: roomClientEventIdRef.current,
        text: clean,
        final: true,
        startedAt: roomDraftStartedAtRef.current ?? roomElapsedNow(),
        endedAt: roomElapsedNow(),
      };
      void enqueueRoomUpload(upload).catch(() => undefined);
    }
    roomClientEventIdRef.current = '';
    roomDraftStartedAtRef.current = null;
    setLiveDraft('');
  }, [enqueueRoomUpload, roomElapsedNow]);

  const startRoomHostMic = useCallback(async () => {
    const session = roomSessionRef.current;
    if (!session || roomSnapshotRef.current?.status !== 'live') {
      showScopedError('microphone', '会议尚未开始，暂时不能开启主持人麦克风。');
      return;
    }
    await transcriberTransitionRef.current;
    if (transcriberRef.current || transcriberStartingRef.current) return;
    transcriberStartingRef.current = true;
    clearScopedError('microphone');
    setLiveDraft('');
    roomRecognitionRef.current = '';
    roomCommittedCharsRef.current = 0;
    let direct: XfyunTranscriber | null = null;
    try {
      const accessToken = await getDemoSession();
      const callbacks: TranscriberOptions = {
        accessToken,
        onPartial: (text) => {
          roomRecognitionRef.current = text;
          const tail = text.length >= roomCommittedCharsRef.current ? text.slice(roomCommittedCharsRef.current).trimStart() : text.trimStart();
          setLiveDraft(tail);
          scheduleRoomPartial(tail);
        },
        onFinal: (text) => {
          roomRecognitionRef.current = text;
          const tail = text.length >= roomCommittedCharsRef.current ? text.slice(roomCommittedCharsRef.current).trim() : text.trim();
          roomCommittedCharsRef.current = text.length;
          finalizeRoomDraft(tail);
        },
        onStatus: setLiveStatus,
        onError: (message) => {
          showScopedError('microphone', message);
          if (transcriberRef.current === direct) transcriberRef.current = null;
          engineRef.current = null;
          setEngine(null);
          setHostMicActive(false);
          setLiveStatus('closed');
        },
      };
      direct = new XfyunTranscriber(callbacks);
      transcriberRef.current = direct;
      await direct.start();
      engineRef.current = 'iflytek';
      setEngine('iflytek');
      setHostMicActive(true);
      clearScopedError('microphone');
    } catch (reason) {
      if (direct) await direct.stop().catch(() => undefined);
      if (!direct || transcriberRef.current === direct) transcriberRef.current = null;
      engineRef.current = null;
      setEngine(null);
      setHostMicActive(false);
      setLiveStatus('closed');
      showScopedError('microphone', `主持人麦克风未启动：${reason instanceof Error ? reason.message : '连接失败'}`);
    } finally {
      transcriberStartingRef.current = false;
    }
  }, [clearScopedError, finalizeRoomDraft, scheduleRoomPartial, showScopedError]);

  const stopRoomHostMic = useCallback(async () => {
    const current = transcriberRef.current;
    transcriberRef.current = null;
    let failure: unknown = null;
    try {
      if (current) {
        try { await current.stop(); }
        catch (reason) { failure = reason; }
      }
      const pendingText = roomRecognitionRef.current.length >= roomCommittedCharsRef.current
        ? roomRecognitionRef.current.slice(roomCommittedCharsRef.current).trim()
        : roomPendingPartialRef.current?.text.trim() || '';
      if (pendingText || roomPendingPartialRef.current) finalizeRoomDraft(pendingText);
      await roomUploadQueueRef.current;
      if (roomUploadFailureRef.current) failure = roomUploadFailureRef.current;
      roomUploadFailureRef.current = null;
    } finally {
      engineRef.current = null;
      setEngine(null);
      setHostMicActive(false);
      setLiveStatus('closed');
    }
    if (failure) throw failure instanceof Error ? failure : new Error('主持人最后一句未能完成同步');
  }, [finalizeRoomDraft]);

  const toggleRoomHostMic = useCallback(() => {
    if (hostMicActive) void stopRoomHostMic().catch((reason) => showScopedError('room-upload', reason instanceof Error ? reason.message : '无法关闭主持人麦克风'));
    else void startRoomHostMic();
  }, [hostMicActive, showScopedError, startRoomHostMic, stopRoomHostMic]);

  const createRoom = useCallback(async (draft: RoomDraft) => {
    setRoomLoading(true);
    clearAllErrors();
    try {
      const payload = await postRoom({
        action: 'create',
        meeting: { title: draft.title, durationSeconds: draft.durationSeconds, meetingType: draft.meetingType, agenda: draft.agenda },
        hostName: draft.hostName,
      });
      const code = String(payload.code || '').toUpperCase();
      if (!/^[A-Z2-9]{6}$/.test(code)) throw new Error('服务端没有返回有效加入码。');
      const session: RoomSession = {
        code,
        hostToken: String(payload.hostToken || ''),
        participantToken: String(payload.participantToken || ''),
        participantId: String(payload.participantId || ''),
        expiresAt: Number(payload.expiresAt || 0),
        joinUrl: roomJoinUrl(code),
      };
      if (!session.hostToken || !session.participantToken || !session.participantId) throw new Error('服务端没有返回完整的主持凭证。');
      roomSessionRef.current = session;
      roomRevisionRef.current = 0;
      setRoomSession(session);
      setRoomSnapshot(null);
      setRoomCopied(false);
      sessionStorage.setItem(ROOM_HOST_STORAGE_KEY, JSON.stringify(session));
    } catch (reason) {
      throw reason instanceof Error ? reason : new Error('创建会场失败，请稍后重试。');
    } finally {
      setRoomLoading(false);
    }
  }, [clearAllErrors]);

  const copyRoomLink = useCallback(async () => {
    const session = roomSessionRef.current;
    if (!session) return;
    try {
      await navigator.clipboard.writeText(session.joinUrl);
      setRoomCopied(true);
      clearScopedError('general');
      window.setTimeout(() => setRoomCopied(false), 1800);
    } catch { showScopedError('general', '复制失败，请手动复制卡片中的分享链接。'); }
  }, [clearScopedError, showScopedError]);

  const commitDraft = useCallback(() => {
    const text = liveDraft.trim(); if (!text) return;
    const speaker = selectedSpeakerRef.current;
    setLiveLines((previous) => [...previous, { id: `live-${Date.now()}`, at: elapsedRef.current, end: elapsedRef.current + Math.max(1, text.length / 5), speakerId: speaker, text, topic: '实时讨论', workRelated: true, asrSource: '讯飞实时' }]);
    committedCharsRef.current = fullRecognitionRef.current.length;
    setLiveDraft('');
  }, [liveDraft]);

  const startTranscriber = useCallback(async () => {
    await transcriberTransitionRef.current;
    if (transcriberRef.current || transcriberStartingRef.current) return;
    transcriberStartingRef.current = true;
    clearAllErrors(); setEngine(null); setLiveDraft('');
    fullRecognitionRef.current = '';
    committedCharsRef.current = 0;
    let direct: XfyunTranscriber | null = null;
    try {
      const accessToken = await getDemoSession();
      const callbacks: TranscriberOptions = {
        accessToken,
        onPartial: (text) => { fullRecognitionRef.current = text; setLiveDraft(text.slice(committedCharsRef.current).trimStart()); },
        onFinal: (text) => { const tail = text.slice(committedCharsRef.current).trim(); if (tail) { const line: TranscriptLine = { id: `live-${Date.now()}`, at: elapsedRef.current, end: elapsedRef.current + Math.max(1, tail.length / 5), speakerId: selectedSpeakerRef.current, text: tail, topic: '实时讨论', workRelated: true, asrSource: '讯飞实时' }; liveLinesRef.current = [...liveLinesRef.current, line]; setLiveLines(liveLinesRef.current); } committedCharsRef.current = text.length; setLiveDraft(''); },
        onStatus: setLiveStatus,
        onError: (message) => {
          showScopedError('microphone', message);
          if (transcriberRef.current === direct) {
            transcriberRef.current = null;
            engineRef.current = null;
            setEngine(null);
            setLiveStatus('closed');
            setRunning(false);
          }
        },
      };
      direct = new XfyunTranscriber(callbacks);
      transcriberRef.current = direct;
      await direct.start();
      engineRef.current = 'iflytek'; setEngine('iflytek');
    } catch (directError) {
      if (direct) await direct.stop().catch(() => undefined);
      if (!direct || transcriberRef.current === direct) transcriberRef.current = null;
      engineRef.current = null; setEngine(null); setRunning(false); setLiveStatus('closed');
      showScopedError('microphone', `讯飞实时听写未启动：${directError instanceof Error ? directError.message : '连接失败'}`);
    } finally {
      transcriberStartingRef.current = false;
    }
  }, [clearAllErrors, showScopedError]);

  const startMeeting = useCallback(async (targetMode: Mode) => {
    if (targetMode === 'verified' && !verifiedRun) return;
    if (targetMode === 'room') return;
    const startingConfig = targetMode === 'verified' && verifiedRun ? verifiedRun.meeting : config;
    const startingSpeakerId = startingConfig.attendees[0]?.id || 'host';
    setMode(targetMode); setScreen('meeting'); setElapsed(0); setRunning(targetMode !== 'verified'); clearAllErrors(); setActionState({}); setParkingItems([]); setLiveLines([]); setLiveDraft(''); setLiveEvents([]); setSelectedSpeakerId(startingSpeakerId);
    selectedSpeakerRef.current = startingSpeakerId; lastSpokenRef.current = ''; lastAnalyzedRef.current = ''; fullRecognitionRef.current = ''; committedCharsRef.current = 0;
    if (targetMode === 'live') window.setTimeout(() => void startTranscriber(), 120);
    if (targetMode === 'verified' && audioRef.current) { audioRef.current.currentTime = 0; audioRef.current.playbackRate = speed; audioRef.current.muted = !soundOn; void audioRef.current.play().catch(() => { setRunning(false); showScopedError('general', '浏览器阻止了自动播放，请点击“继续”开始录音。'); }); }
  }, [verifiedRun, config, startTranscriber, speed, soundOn, clearAllErrors, showScopedError]);

  const startRoomMeeting = useCallback(async () => {
    const session = roomSessionRef.current;
    if (!session) return;
    setRoomLoading(true);
    clearAllErrors();
    roomEndInFlightRef.current = false;
    setRoomEndInFlight(false);
    roomReportStartedRef.current = false;
    try {
      let snapshot = roomSnapshotRef.current;
      if (!snapshot) {
        const response = await fetch(`/api/room?code=${encodeURIComponent(session.code)}`, { cache: 'no-store', headers: { Authorization: `Bearer ${session.participantToken}` } });
        const payload = await response.json() as { room?: RoomSnapshot; error?: string };
        if (!response.ok || !payload.room) throw new Error(payload.error || '无法读取会场状态');
        snapshot = payload.room;
      }
      if (snapshot.status === 'waiting') {
        const payload = await postRoom({ action: 'control', code: session.code, status: 'live' }, session.hostToken) as { room?: RoomSnapshot };
        if (!payload.room) throw new Error('服务端没有返回已启动会场。');
        snapshot = payload.room;
      }
      if (snapshot.status !== 'live') throw new Error(snapshot.status === 'closing' ? '会议正在收尾，不能重新进入。' : '会议已经结束，请创建一场新会议。');
      roomSnapshotRef.current = snapshot;
      roomRevisionRef.current = snapshot.revision;
      setRoomSnapshot(snapshot);
      const finalLines = roomTranscript(snapshot, true);
      liveLinesRef.current = finalLines;
      setLiveLines(finalLines);
      setRoomDraftLines(roomTranscript(snapshot, false));
      setMode('room');
      setScreen('meeting');
      setElapsed(snapshot.startedAt ? Math.max(0, (Date.now() - snapshot.startedAt) / 1000) : 0);
      setRunning(true);
      setRoomClosing(false);
      setLiveDraft('');
      setLiveEvents([]);
      setActionState({});
      setParkingItems([]);
      setSelectedSpeakerId(session.participantId);
      selectedSpeakerRef.current = session.participantId;
      lastSpokenRef.current = '';
      lastAnalyzedRef.current = '';
      lastRoomAnalyzedAtRef.current = 0;
      clearScopedError('room-control');
    } catch (reason) {
      showScopedError('room-control', reason instanceof Error ? reason.message : '无法启动多人会议');
    } finally {
      setRoomLoading(false);
    }
  }, [clearAllErrors, clearScopedError, showScopedError]);

  useEffect(() => {
    if (screen !== 'meeting' || mode === 'verified') return;
    if (mode === 'room') {
      const update = () => setElapsed(Math.min(displayConfig.durationSeconds + 3600, roomElapsedNow()));
      update();
      const interval = window.setInterval(update, 250);
      return () => window.clearInterval(interval);
    }
    if (!running) return;
    const interval = window.setInterval(() => setElapsed((value) => Math.min(displayConfig.durationSeconds + 3600, value + .1)), 100);
    return () => window.clearInterval(interval);
  }, [screen, running, mode, displayConfig.durationSeconds, roomElapsedNow]);

  const visibleTranscript = mode === 'verified' ? (verifiedRun?.transcript || []).filter((line) => line.end <= elapsed + .05) : liveLines;
  const visibleEvents = mode === 'verified' ? (verifiedRun?.events || []).filter((event) => event.at <= elapsed) : liveEvents;
  const liveAnalysisDraft = mode === 'room' ? '' : liveDraft;

  useEffect(() => {
    if (screen !== 'meeting' || !soundOn || !visibleEvents.length) return;
    const latest = visibleEvents.at(-1)!;
    if (!latest.voice || lastSpokenRef.current === latest.id || actionState[latest.id] === 'ignored') return;
    lastSpokenRef.current = latest.id;
    if ('speechSynthesis' in window) { window.speechSynthesis.cancel(); const utterance = new SpeechSynthesisUtterance(latest.voice); utterance.lang = 'zh-CN'; window.speechSynthesis.speak(utterance); }
  }, [screen, soundOn, visibleEvents, actionState]);

  useEffect(() => {
    if (screen !== 'meeting' || mode === 'verified' || !running) return;
    const analysisLines = mode === 'room' ? [...liveLines, ...roomDraftLines] : liveLines;
    const hasEvidence = mode === 'room' ? analysisLines.some((line) => line.text.trim().length >= 4) : liveAnalysisDraft.length >= 8 || liveLines.length > 0;
    if (!hasEvidence) return;
    const snapshotKey = [...analysisLines.map((line) => `${line.id}:${line.speakerId}:${line.text}`), mode === 'live' ? `${selectedSpeakerId}:${liveAnalysisDraft}` : ''].join('|');
    if (!snapshotKey || snapshotKey === lastAnalyzedRef.current) return;
    const roomCooldown = mode === 'room' ? Math.max(250, 6000 - (Date.now() - lastRoomAnalyzedAtRef.current)) : 1300;
    const timer = window.setTimeout(async () => {
      if (mode === 'room') lastRoomAnalyzedAtRef.current = Date.now();
      const controller = new AbortController();
      const requestTimer = window.setTimeout(() => controller.abort(), 10_000);
      try {
        const transcript = [...analysisLines.map((line) => ({ speaker: getSpeaker(line.speakerId, displayConfig.attendees).name, text: line.text, at: line.at })), ...(mode === 'live' && liveAnalysisDraft ? [{ speaker: getSpeaker(selectedSpeakerId, displayConfig.attendees).name, text: liveAnalysisDraft, at: elapsedRef.current }] : [])];
        const accessToken = await getDemoSession();
        const response = await fetch('/api/analyze', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Cuicui-Session': accessToken }, body: JSON.stringify({ meeting: { title: displayConfig.title, type: displayConfig.meetingType, durationSeconds: displayConfig.durationSeconds, agenda: displayConfig.agenda }, elapsedSeconds: elapsedRef.current, previousEventTypes: liveEvents.map((event) => event.type), transcript }), signal: controller.signal });
        const data = await response.json() as { events?: Array<Omit<Intervention, 'id' | 'at'>>; error?: string };
        if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
        lastAnalyzedRef.current = snapshotKey;
        if (analysisRetryTimerRef.current !== null) window.clearTimeout(analysisRetryTimerRef.current);
        analysisRetryTimerRef.current = null;
        clearScopedError('analysis');
        if (Array.isArray(data.events) && data.events.length) setLiveEvents((previous) => [...previous, ...data.events!.filter((event) => !previous.some((item) => item.type === event.type && elapsedRef.current - item.at < 20)).map((event, index) => ({ ...event, id: `ai-${Date.now()}-${index}`, at: elapsedRef.current, actions: event.severity === 'critical' ? ['adopt', 'park'] : ['adopt', 'ignore'] } as Intervention))]);
      } catch {
        showScopedError('analysis', 'AI 分析暂时不可用，转写仍在保存，正在自动重试。');
        if (analysisRetryTimerRef.current !== null) window.clearTimeout(analysisRetryTimerRef.current);
        analysisRetryTimerRef.current = window.setTimeout(() => setAnalysisRetryTick((value) => value + 1), 3500);
      } finally {
        window.clearTimeout(requestTimer);
      }
    }, roomCooldown);
    return () => window.clearTimeout(timer);
  }, [screen, mode, running, liveAnalysisDraft, liveLines, roomDraftLines, liveEvents, selectedSpeakerId, displayConfig, analysisRetryTick, clearScopedError, showScopedError]);

  const buildStats = useCallback((lines: TranscriptLine[], attendees: Speaker[]) => {
    const totals = new Map<string, number>(); for (const line of lines) totals.set(line.speakerId, (totals.get(line.speakerId) || 0) + Math.max(1, line.end - line.at));
    const total = Math.max(1, [...totals.values()].reduce((sum, value) => sum + value, 0));
    return attendees.map((person) => ({ id: person.id, seconds: Math.round(totals.get(person.id) || 0), share: (totals.get(person.id) || 0) / total * 100, turns: lines.filter((line) => line.speakerId === person.id).length, interruptions: 0 }));
  }, []);

  const completeRoomReport = useCallback(async (finalSnapshot: RoomSnapshot) => {
    if (finalSnapshot.status !== 'ended' || roomReportStartedRef.current) return;
    roomReportStartedRef.current = true;
    roomEndInFlightRef.current = true;
    setRoomEndInFlight(true);
    setRoomClosing(false);
    setRunning(false);
    roomSnapshotRef.current = finalSnapshot;
    roomRevisionRef.current = finalSnapshot.revision;
    setRoomSnapshot(finalSnapshot);
    const lines = roomTranscript(finalSnapshot, true);
    liveLinesRef.current = lines;
    setLiveLines(lines);
    setRoomDraftLines([]);
    const attendees = roomSpeakers(finalSnapshot);
    const reportBase = verifiedRun?.meeting || config;
    const reportConfig: MeetingConfig = {
      ...reportBase,
      ...finalSnapshot.meeting,
      attendees: attendees.length ? attendees : reportBase.attendees,
      prioritySpeakerId: attendees.find((person) => person.isPriority)?.id || attendees[0]?.id || reportBase.prioritySpeakerId,
    };
    const actualSeconds = finalSnapshot.startedAt
      ? Math.max(1, ((finalSnapshot.endedAt || Date.now()) - finalSnapshot.startedAt) / 1000)
      : Math.max(1, lines.at(-1)?.end || elapsedRef.current);
    setElapsed(actualSeconds);
    setReportLoading(true);
    setScreen('report');
    clearScopedError('room-control');
    clearScopedError('room-sync');
    const controller = new AbortController();
    const requestTimer = window.setTimeout(() => controller.abort(), 15_000);
    try {
      const accessToken = await getDemoSession();
      const response = await fetch('/api/report', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Cuicui-Session': accessToken }, body: JSON.stringify({ meeting: { title: reportConfig.title, durationSeconds: reportConfig.durationSeconds, agenda: reportConfig.agenda, attendees: reportConfig.attendees.map((person) => ({ id: person.id, name: person.name })) }, actualSeconds, transcript: lines.map((line) => ({ ...line, speaker: getSpeaker(line.speakerId, reportConfig.attendees).name })), events: liveEvents }), signal: controller.signal });
      const data = await response.json() as Partial<MeetingReport> & { error?: string };
      if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
      setReport({ ...EMPTY_REPORT, ...data, speakerStats: buildStats(lines, reportConfig.attendees), actualSeconds: Math.round(actualSeconds) });
    } catch {
      setReport({ ...EMPTY_REPORT, overall: 68, verdict: '会议内容已保存，AI 报告暂时不可用。', actualSeconds: Math.round(actualSeconds), speakerStats: buildStats(lines, reportConfig.attendees), summary: '多人会议转写已完整保留，可导出后继续整理。' });
    } finally {
      window.clearTimeout(requestTimer);
      setReportLoading(false);
      setRoomClosing(false);
      roomEndInFlightRef.current = false;
      setRoomEndInFlight(false);
    }
  }, [buildStats, clearScopedError, config, liveEvents, verifiedRun]);

  const endMeeting = useCallback(async () => {
    if (screen !== 'meeting') return;
    setRunning(false); audioRef.current?.pause(); window.speechSynthesis?.cancel();
    if (mode === 'verified' && verifiedRun) { setReport(verifiedRun.report); setScreen('report'); return; }
    if (mode === 'room') {
      const session = roomSessionRef.current;
      if (!session) { showScopedError('room-control', '主持会场凭证已失效，无法完成收尾。'); return; }
      const currentSnapshot = roomSnapshotRef.current;
      if (currentSnapshot?.status === 'ended') { await completeRoomReport(currentSnapshot); return; }
      if (roomEndInFlightRef.current || roomReportStartedRef.current) return;
      roomEndInFlightRef.current = true;
      setRoomEndInFlight(true);
      clearScopedError('room-control');
      try {
        const closingPayload = await postRoom({ action: 'control', code: session.code, status: 'closing' }, session.hostToken) as { room?: RoomSnapshot };
        if (!closingPayload.room) throw new Error('服务端没有返回收尾状态。');
        roomSnapshotRef.current = closingPayload.room;
        roomRevisionRef.current = closingPayload.room.revision;
        setRoomSnapshot(closingPayload.room);
        setRoomClosing(closingPayload.room.status === 'closing');
        clearScopedError('room-control');
        try {
          await stopRoomHostMic();
          clearScopedError('room-upload');
        } catch (reason) {
          showScopedError('room-upload', `${reason instanceof Error ? reason.message : '主持人最后一句未能完成同步'}；其余成员记录仍会正常收尾。`);
        }
        if (closingPayload.room.status === 'ended') { await completeRoomReport(closingPayload.room); return; }
        const closeDeadline = closingPayload.room.closeDeadline || Date.now();
        const remaining = Math.max(0, Math.min(7000, closeDeadline - Date.now() + 120));
        if (remaining > 0) await new Promise((resolve) => window.setTimeout(resolve, remaining));
        const endedPayload = await postRoom({ action: 'control', code: session.code, status: 'ended' }, session.hostToken) as { room?: RoomSnapshot };
        const finalSnapshot = endedPayload.room;
        if (!finalSnapshot || finalSnapshot.status !== 'ended') throw new Error('服务端未能返回最终会议记录，请重试结束会议。');
        clearScopedError('room-control');
        await completeRoomReport(finalSnapshot);
      } catch (reason) {
        roomEndInFlightRef.current = false;
        setRoomEndInFlight(false);
        const recoverableStatus = roomSnapshotRef.current?.status;
        setRoomClosing(recoverableStatus === 'closing');
        setRunning(recoverableStatus === 'live');
        showScopedError('room-control', `${reason instanceof Error ? reason.message : '多人会议收尾失败'}，请点击“${recoverableStatus === 'closing' ? '完成收尾' : '结束会议'}”重试。`);
      }
      return;
    }
    if (mode === 'live') {
      const current = transcriberRef.current;
      transcriberRef.current = null;
      if (current) await current.stop();
      await transcriberTransitionRef.current;
    }
    const draftText = fullRecognitionRef.current.slice(committedCharsRef.current).trim();
    const latestLines = liveLinesRef.current;
    const lines = draftText ? [...latestLines, { id: `live-final-${Date.now()}`, at: elapsedRef.current, end: elapsedRef.current + Math.max(1, draftText.length / 5), speakerId: selectedSpeakerRef.current, text: draftText, topic: '实时讨论', workRelated: true }] : latestLines;
    setReportLoading(true); setScreen('report');
    try {
      const accessToken = await getDemoSession();
      const response = await fetch('/api/report', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Cuicui-Session': accessToken }, body: JSON.stringify({ meeting: { title: displayConfig.title, durationSeconds: displayConfig.durationSeconds, agenda: displayConfig.agenda, attendees: displayConfig.attendees.map((person) => ({ id: person.id, name: person.name })) }, actualSeconds: elapsedRef.current, transcript: lines.map((line) => ({ ...line, speaker: getSpeaker(line.speakerId, displayConfig.attendees).name })), events: liveEvents }) });
      const data = await response.json() as Partial<MeetingReport> & { error?: string };
      if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
      setReport({ ...EMPTY_REPORT, ...data, speakerStats: buildStats(lines, displayConfig.attendees), actualSeconds: Math.round(elapsedRef.current) });
    } catch { setReport({ ...EMPTY_REPORT, overall: 68, verdict: '会议内容已保存，AI 报告暂时不可用。', actualSeconds: Math.round(elapsedRef.current), speakerStats: buildStats(lines, displayConfig.attendees), summary: '实时转写已保留，可导出后继续整理。' }); }
    finally { setReportLoading(false); }
  }, [screen, mode, verifiedRun, stopRoomHostMic, displayConfig, liveEvents, buildStats, clearScopedError, completeRoomReport, showScopedError]);

  useEffect(() => {
    if (screen !== 'meeting' || mode !== 'room' || roomSnapshot?.status !== 'ended' || roomReportStartedRef.current) return;
    void completeRoomReport(roomSnapshot);
  }, [completeRoomReport, mode, roomSnapshot, screen]);

  const resetSession = useCallback(() => {
    const session = roomSessionRef.current;
    const snapshot = roomSnapshotRef.current;
    if (session && (snapshot?.status === 'live' || snapshot?.status === 'closing')) void postRoom({ action: 'control', code: session.code, status: 'ended' }, session.hostToken).catch(() => undefined);
    void transcriberRef.current?.stop();
    transcriberRef.current = null;
    if (roomPartialTimerRef.current !== null) window.clearTimeout(roomPartialTimerRef.current);
    roomPartialTimerRef.current = null;
    roomPendingPartialRef.current = null;
    roomUploadQueueRef.current = Promise.resolve();
    roomUploadFailureRef.current = null;
    roomLatestPartialSeqRef.current.clear();
    roomFinalQueuedRef.current.clear();
    roomEndInFlightRef.current = false;
    roomReportStartedRef.current = false;
    roomSeqRef.current = 0;
    roomSessionRef.current = null;
    roomSnapshotRef.current = null;
    roomRevisionRef.current = 0;
    sessionStorage.removeItem(ROOM_HOST_STORAGE_KEY);
    audioRef.current?.pause();
    if (audioRef.current) audioRef.current.currentTime = 0;
    setMode('verified');
    setScreen('setup');
    setRunning(false);
    setElapsed(0);
    liveLinesRef.current = [];
    setLiveLines([]);
    setRoomDraftLines([]);
    setLiveDraft('');
    setLiveEvents([]);
    setLiveStatus(null);
    engineRef.current = null;
    setEngine(null);
    setHostMicActive(false);
    setRoomClosing(false);
    setRoomEndInFlight(false);
    setRoomSession(null);
    setRoomSnapshot(null);
    setRoomCopied(false);
    setShowRoomDialog(false);
    setActionState({});
    setParkingItems([]);
    errorSourceRef.current = null;
    setError(null);
    setReport(EMPTY_REPORT);
    setReportLoading(false);
    fullRecognitionRef.current = '';
    committedCharsRef.current = 0;
    roomRecognitionRef.current = '';
    roomCommittedCharsRef.current = 0;
    roomClientEventIdRef.current = '';
    roomDraftStartedAtRef.current = null;
    lastSpokenRef.current = '';
    lastAnalyzedRef.current = '';
    lastRoomAnalyzedAtRef.current = 0;
    if (analysisRetryTimerRef.current !== null) window.clearTimeout(analysisRetryTimerRef.current);
    analysisRetryTimerRef.current = null;
    setAnalysisRetryTick(0);
  }, []);
  const selectSpeaker = useCallback((id: string) => { if (id === selectedSpeakerId) return; commitDraft(); setSelectedSpeakerId(id); selectedSpeakerRef.current = id; }, [selectedSpeakerId, commitDraft]);
  const handleAction = (event: Intervention, action: 'adopt' | 'park' | 'ignore') => { setActionState((previous) => ({ ...previous, [event.id]: action === 'adopt' ? 'adopted' : action === 'park' ? 'parked' : 'ignored' })); if (action === 'park') setParkingItems((previous) => [...new Set([...previous, event.observation])]); };
  const pauseMeeting = useCallback(() => {
    if (mode === 'room') return;
    if (mode === 'verified' && audioRef.current) {
      if (audioRef.current.paused) void audioRef.current.play(); else audioRef.current.pause();
      return;
    }
    if (mode !== 'live') { setRunning((value) => !value); return; }
    if (running) {
      setRunning(false);
      const current = transcriberRef.current;
      transcriberRef.current = null;
      engineRef.current = null;
      setEngine(null);
      if (current) transcriberTransitionRef.current = current.stop().catch((reason) => { showScopedError('microphone', reason instanceof Error ? reason.message : '无法暂停实时听写'); });
    } else {
      setRunning(true);
      void startTranscriber();
    }
  }, [mode, running, showScopedError, startTranscriber]);
  const changeSpeed = () => { const next = speed === 1 ? 1.5 : speed === 1.5 ? 2 : 1; setSpeed(next); if (audioRef.current) audioRef.current.playbackRate = next; };
  const changeSound = () => { setSoundOn((value) => { if (audioRef.current) audioRef.current.muted = value; if (value) window.speechSynthesis?.cancel(); return !value; }); };
  const skipToNext = () => { const next = (verifiedRun?.events || []).find((event) => event.at > elapsed + .5); if (audioRef.current) audioRef.current.currentTime = next ? Math.max(0, next.at - .5) : displayConfig.durationSeconds - 1; };
  const saveConfig = (value: MeetingConfig) => { setConfig(value); setShowConfig(false); try { localStorage.setItem('cuicui-meeting-config', JSON.stringify(value)); } catch { /* optional */ } };

  useEffect(() => {
    const audio = audioRef.current; if (!audio) return;
    const time = () => setElapsed(audio.currentTime);
    const play = () => setRunning(true);
    const pause = () => setRunning(false);
    const ended = () => void endMeeting();
    audio.addEventListener('timeupdate', time); audio.addEventListener('play', play); audio.addEventListener('pause', pause); audio.addEventListener('ended', ended);
    return () => { audio.removeEventListener('timeupdate', time); audio.removeEventListener('play', play); audio.removeEventListener('pause', pause); audio.removeEventListener('ended', ended); };
  }, [endMeeting]);

  useEffect(() => {
    const handler = (event: KeyboardEvent) => { const target = event.target as HTMLElement | null; if (target && /INPUT|TEXTAREA|SELECT/.test(target.tagName)) return; if (event.key === 'Escape') { if (showConfig) setShowConfig(false); if (showRoomDialog) setShowRoomDialog(false); return; } if (showConfig || showRoomDialog) return; if (event.code === 'Space') { event.preventDefault(); if (screen === 'setup') void startMeeting('verified'); else if (screen === 'meeting') pauseMeeting(); } if (screen === 'meeting' && mode === 'live' && /^[1-5]$/.test(event.key)) { const person = config.attendees[Number(event.key) - 1]; if (person) selectSpeaker(person.id); } };
    window.addEventListener('keydown', handler); return () => window.removeEventListener('keydown', handler);
  }, [screen, mode, config.attendees, showConfig, showRoomDialog, startMeeting, pauseMeeting, selectSpeaker]);

  return <>
    <audio ref={audioRef} className="persistent-audio" preload="auto" src={verifiedRun?.audio.artifacts.master.path || '/demo/meeting-master-assistant-plan-v1.mp3'} />
    {screen === 'setup' && <SetupView config={config} health={health} verifiedRun={verifiedRun} verifiedError={verifiedError} roomSession={roomSession} roomSnapshot={roomSnapshot} roomLoading={roomLoading} roomCopied={roomCopied} onConfigure={() => setShowConfig(true)} onStart={(target) => void startMeeting(target)} onOpenRoom={() => setShowRoomDialog(true)} onCopyRoom={() => void copyRoomLink()} onStartRoom={() => roomSnapshot?.status === 'ended' ? resetSession() : void startRoomMeeting()} />}
    {screen === 'meeting' && <MeetingView config={displayConfig} mode={mode} roomCode={roomSession?.code} roomCount={roomOnlineParticipants(roomSnapshot).length} engine={engine} elapsed={elapsed} running={running} speed={speed} soundOn={soundOn} liveStatus={liveStatus} selectedSpeakerId={selectedSpeakerId} transcript={visibleTranscript} partialTranscript={mode === 'room' ? roomDraftLines : []} liveDraft={liveDraft} events={visibleEvents} actionState={actionState} parkingItems={parkingItems} error={error} verifiedRun={verifiedRun} roomClosing={roomClosing} roomEndInFlight={roomEndInFlight} hostMicActive={hostMicActive} onPause={pauseMeeting} onSpeed={changeSpeed} onSound={changeSound} onSkip={skipToNext} onEnd={() => void endMeeting()} onReset={resetSession} onSpeaker={selectSpeaker} onCommitDraft={commitDraft} onAction={handleAction} onHostMic={toggleRoomHostMic} />}
    {screen === 'report' && <ReportView config={displayConfig} report={report} events={mode === 'verified' ? verifiedRun?.events || [] : liveEvents} loading={reportLoading} mode={mode} onReplay={() => void startMeeting('verified')} onReset={resetSession} />}
    {showConfig && <ConfigDialog config={config} onSave={saveConfig} onClose={() => setShowConfig(false)} />}
    {showRoomDialog && <RoomDialog config={config} onCreate={createRoom} onClose={() => setShowRoomDialog(false)} />}
  </>;
}

export default function MeetingApp() {
  return <HostMeetingApp />;
}
