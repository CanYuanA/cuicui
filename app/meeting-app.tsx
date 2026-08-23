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

type Screen = 'setup' | 'meeting' | 'report';
type Mode = 'verified' | 'live' | 'room';
type ServiceHealth = { openrouter: boolean; iflytek: boolean; speech: boolean };
type ActionState = Record<string, 'adopted' | 'parked' | 'ignored'>;
type RoomSession = { code: string; hostToken: string; participantToken: string; participantId: string; joinUrl: string; expiresAt: number };
type RoomSnapshot = {
  code: string;
  meeting: { title: string; durationSeconds: number; meetingType: string; agenda: string[] };
  status: 'waiting' | 'live' | 'ended';
  revision: number;
  createdAt: number;
  startedAt: number | null;
  expiresAt: number;
  participants: Array<{ id: string; name: string; role: string; joined_at: number; last_seen: number }>;
  utterances: Array<{ id: string; participant_id: string; name: string; role: string; text: string; started_at: number; ended_at: number }>;
};

const palette = ['#59e1ff', '#ffc857', '#a8f05a', '#a994ff', '#ff8297', '#ff9f68', '#77e0bc'];
const cloneConfig = () => ({ ...DEFAULT_CONFIG, agenda: [...DEFAULT_CONFIG.agenda], attendees: DEFAULT_CONFIG.attendees.map((person) => ({ ...person })) });

function serviceLabel(health: ServiceHealth | null) {
  if (!health) return '正在检查服务';
  const ready = Number(health.openrouter) + Number(health.iflytek) + Number(health.speech);
  return ready === 3 ? '实时服务已就绪' : `${ready}/3 服务就绪`;
}

async function postRoom(body: Record<string, unknown>) {
  const response = await fetch('/api/room', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const payload = await response.json() as Record<string, unknown>;
  if (!response.ok) throw new Error(String(payload.error || `HTTP ${response.status}`));
  return payload;
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

function SetupView({
  config, health, verifiedRun, verifiedError, onConfigure, onStart,
}: {
  config: MeetingConfig; health: ServiceHealth | null; verifiedRun: VerifiedRun | null; verifiedError: string | null;
  onConfigure: () => void; onStart: (mode: Mode) => void;
}) {
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
        <button className="room-create-button" type="button" disabled>多人协作模式<span>即将开放</span></button>
        <button className="secondary-action" type="button" onClick={() => onStart('live')}>使用麦克风实时体验<span>讯飞实时听写 →</span></button>
      </aside>
    </section>
    <footer className="preflight-footer"><span><i className={health?.iflytek ? 'status-ok' : 'status-warn'} /> 讯飞实时听写</span><span><i className={health?.openrouter ? 'status-ok' : 'status-warn'} /> 会中语义分析</span><span><i className={verifiedRun ? 'status-ok' : 'status-warn'} /> 动态会议报告</span><p>Agent 面前，老板也会被平等地催一下。</p></footer>
  </main>;
}

function PulseTimeline({ elapsed, duration, events, compact = false }: { elapsed: number; duration: number; events: Intervention[]; compact?: boolean }) {
  const progress = Math.max(0, Math.min(100, elapsed / Math.max(1, duration) * 100));
  return <div className={compact ? 'pulse-widget compact' : 'pulse-widget'}><div className="pulse-widget-head"><span>会议脉冲带</span><b>{Math.round(progress)}%</b></div><div className="topic-pulse">{TOPIC_SEGMENTS.map((segment) => { const visibleEnd = Math.min(segment.end, progress); return visibleEnd > segment.start ? <span key={segment.label} className={`topic-segment ${segment.tone}`} style={{ left: `${segment.start}%`, width: `${visibleEnd - segment.start}%` }} title={segment.label} /> : null; })}{events.map((event) => <i key={event.id} className={`pulse-event ${event.severity}`} style={{ left: `${Math.min(100, event.at / Math.max(1, duration) * 100)}%` }} title={`${formatClock(event.at)} ${event.label}`} />)}<span className="pulse-progress" style={{ width: `${progress}%` }} /><span className="pulse-cursor" style={{ left: `${progress}%` }} /></div>{!compact && <div className="pulse-label-row"><span>开场</span><span>问题</span><span>方案</span><span>收敛</span></div>}</div>;
}

function MeetingView({
  config, mode, roomCode, roomCount, engine, elapsed, running, speed, soundOn, liveStatus, selectedSpeakerId,
  transcript, liveDraft, events, actionState, parkingItems, error, verifiedRun,
  onPause, onSpeed, onSound, onSkip, onEnd, onReset, onSpeaker, onCommitDraft, onAction,
}: {
  config: MeetingConfig; mode: Mode; roomCode?: string; roomCount?: number; engine: 'iflytek' | null;
  elapsed: number; running: boolean; speed: number; soundOn: boolean; liveStatus: TranscriberStatus | null; selectedSpeakerId: string;
  transcript: TranscriptLine[]; liveDraft: string; events: Intervention[]; actionState: ActionState; parkingItems: string[]; error: string | null;
  verifiedRun: VerifiedRun | null;
  onPause: () => void; onSpeed: () => void; onSound: () => void; onSkip: () => void; onEnd: () => void; onReset: () => void;
  onSpeaker: (id: string) => void; onCommitDraft: () => void; onAction: (event: Intervention, action: 'adopt' | 'park' | 'ignore') => void;
}) {
  const listRef = useRef<HTMLDivElement>(null);
  const duration = config.durationSeconds;
  const progress = Math.max(0, Math.min(100, elapsed / duration * 100));
  const latestEvent = events.at(-1) || null;
  const hasTimeRisk = events.some((event) => event.type === 'time');
  const remaining = Math.max(0, duration - elapsed);
  const visibleAgenda = progress < 58 ? config.agenda[0] : config.agenda[1] || config.agenda[0];
  const speakerSeconds = useMemo(() => {
    const result = new Map<string, number>();
    for (const line of transcript) result.set(line.speakerId, (result.get(line.speakerId) || 0) + Math.max(1, Math.min(line.end, elapsed) - line.at));
    return result;
  }, [transcript, elapsed]);
  const totalSpeech = Math.max(1, [...speakerSeconds.values()].reduce((sum, value) => sum + value, 0));
  const modeCopy = mode === 'verified' ? '演示会议 · 提醒随讨论出现' : mode === 'room' ? `多人会场 ${roomCode} · ${roomCount || 1} 人在线` : `单人麦克风 · ${engine === 'iflytek' ? '讯飞实时听写' : liveStatus || '准备中'}`;
  useEffect(() => { listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: 'smooth' }); }, [transcript.length, liveDraft]);
  return <main className={mode === 'verified' ? 'meeting-shell has-audio-proof' : 'meeting-shell'}>
    <header className="meeting-header"><button className="brand brand-button" type="button" onClick={onReset}><span className="brand-mark">C²</span><span><strong>催催</strong><small>会议效率助手</small></span></button><div className="meeting-title"><span className={mode === 'verified' ? 'live-dot demo' : 'live-dot'} /><div><b>{config.title}</b><small>{modeCopy}</small></div></div><div className="meeting-controls">{mode === 'verified' && <button type="button" className="control-chip" onClick={onSpeed}>{speed}×</button>}<button type="button" className={soundOn ? 'control-chip active' : 'control-chip'} onClick={onSound}>{soundOn ? '声音开' : '声音关'}</button><button type="button" className="control-chip" onClick={onPause}>{running ? '暂停' : '继续'}</button><button type="button" className="end-button" onClick={onEnd}>结束会议</button></div></header>
    {mode === 'verified' && verifiedRun && <section className="audio-proof-bar"><div><span className="proof-icon">REC</span><div><b>会议录音</b><p>字幕和提醒会随着实际进度逐步出现</p></div></div><button className={running ? 'audio-transport playing' : 'audio-transport'} type="button" onClick={onPause}><i /><span><b>{running ? '会议进行中' : '会议已暂停'}</b><small>{formatClock(elapsed)} / {formatClock(config.durationSeconds)} · 点击{running ? '暂停' : '继续'}</small></span></button></section>}
    <section className="time-command"><div className="topic-now"><small>当前议题</small><b>{visibleAgenda}</b></div><div className="time-progress"><div className="time-copy"><span>已进行 {formatClock(elapsed)}</span><strong>剩余 {formatClock(remaining)}</strong><span>{mode === 'verified' ? '会议时间轴' : '实时语义分析'}</span></div><div className="time-track"><i style={{ width: `${progress}%` }} className={progress >= 90 ? 'danger' : progress >= 75 ? 'warning' : ''} /></div></div><div className={hasTimeRisk || progress >= 75 ? 'forecast warning' : 'forecast'}><small>节奏预测</small><b>{hasTimeRisk ? '预计超时 · 请立即收敛' : progress < 58 ? '按时推进' : progress < 75 ? '需要收敛' : progress < 92 ? '决策时间不足' : '准备生成报告'}</b></div></section>
    {error && <div className="service-error" role="status"><b>链路提示</b><span>{error}</span></div>}
    <section className="meeting-grid"><section className="transcript-panel"><div className="panel-heading"><div><p>{mode === 'verified' ? '随发言更新' : '实时现场'}</p><h2>会议字幕</h2></div><div className="signal-bars"><i /><i /><i /><i /><i /></div></div>
      {mode === 'live' && <div className="speaker-switcher"><span>当前发言者</span>{config.attendees.map((person, index) => <button type="button" key={person.id} className={selectedSpeakerId === person.id ? 'speaker-pill active' : 'speaker-pill'} onClick={() => onSpeaker(person.id)} style={{ '--speaker': person.color } as CSSProperties}><i>{person.short}</i>{person.name}<kbd>{index + 1}</kbd></button>)}<button type="button" className="commit-draft" disabled={!liveDraft.trim()} onClick={onCommitDraft}>提交这一句</button></div>}
      {mode === 'room' && <div className="room-live-banner"><b>说话人来自加入身份</b><span>主持台正在聚合 {roomCount || 1} 条独立参会端音轨</span><strong>{roomCode}</strong></div>}
      <div className="transcript-list" ref={listRef} aria-live="polite">{transcript.length === 0 && !liveDraft && <div className="list-empty"><span className="listening-orbit"><i /></span><b>{mode === 'room' ? '等待参会者发言…' : mode === 'verified' ? '会议开始后，字幕会逐句出现' : '正在等待第一句话…'}</b><p>每句发言结束后形成稳定字幕。</p></div>}{transcript.map((line, index) => { const speaker = getSpeaker(line.speakerId, config.attendees); return <article className={index === transcript.length - 1 ? 'transcript-line latest' : 'transcript-line'} key={line.id} style={{ '--speaker': speaker.color } as CSSProperties}><time>{formatClock(line.at)}</time><span className="line-avatar">{speaker.short}</span><div><p className="speaker-name">{speaker.name}{speaker.isPriority && <em>拍板人</em>}{line.interrupted && <em className="interrupted">被打断</em>}</p><p className="line-copy">{line.text || '（本句未识别）'}</p><span className="line-topic"># {line.topic || '实时讨论'}</span></div></article>; })}{liveDraft && <article className="transcript-line latest draft" style={{ '--speaker': getSpeaker(selectedSpeakerId, config.attendees).color } as CSSProperties}><time>{formatClock(elapsed)}</time><span className="line-avatar">{getSpeaker(selectedSpeakerId, config.attendees).short}</span><div><p className="speaker-name">{getSpeaker(selectedSpeakerId, config.attendees).name}<em>听写中</em></p><p className="line-copy">{liveDraft}<span className="typing-cursor" /></p></div></article>}</div>
    </section><aside className="assistant-panel"><div className="assistant-heading"><div><span className="ai-orb"><i /></span><div><p>CUICUI AGENT</p><h2>现场干预</h2></div></div><span className="agent-state"><i /> {running ? '持续分析' : '已暂停'}</span></div><section className={latestEvent ? `intervention-card ${latestEvent.severity}` : 'intervention-card calm'}>{!latestEvent ? <div className="calm-state"><span>✓</span><div><b>尚无充分介入证据</b><p>正在结合转写、议题和剩余时间判断。</p></div></div> : <><div className="intervention-top"><span>{latestEvent.label}</span><time>{formatClock(latestEvent.at)}</time></div><div className="intervention-copy"><p><b>观察</b>{latestEvent.observation}</p><p><b>影响</b>{latestEvent.impact}</p><p><b>建议</b>{latestEvent.suggestion}</p></div><div className="evidence-line"><span>判断依据</span><b>{latestEvent.evidence}</b></div>{latestEvent.actions && !actionState[latestEvent.id] && <div className="intervention-actions">{latestEvent.actions.includes('adopt') && <button type="button" onClick={() => onAction(latestEvent, 'adopt')}>采纳建议</button>}{latestEvent.actions.includes('park') && <button type="button" onClick={() => onAction(latestEvent, 'park')}>放入停车场</button>}{latestEvent.actions.includes('ignore') && <button type="button" className="quiet" onClick={() => onAction(latestEvent, 'ignore')}>忽略</button>}</div>}{actionState[latestEvent.id] && <div className="action-confirmed">✓ 本次操作已记录</div>}</>}</section><PulseTimeline elapsed={elapsed} duration={duration} events={events} /><section className="speaker-stats"><div className="mini-section-head"><span>发言分布</span><b>{transcript.length} 段转写</b></div>{config.attendees.map((person) => { const seconds = speakerSeconds.get(person.id) || 0; const share = seconds / totalSpeech * 100; return <div className="speaker-stat" key={person.id}><span className="stat-avatar" style={{ background: person.color }}>{person.short}</span><span className="stat-name">{person.name}</span><div className="stat-bar"><i style={{ width: `${share}%`, background: person.color }} /></div><b>{Math.round(share)}%</b></div>; })}</section>{parkingItems.length > 0 && <section className="parking-lot"><div className="mini-section-head"><span>会后停车场</span><b>{parkingItems.length} 项</b></div>{parkingItems.map((item) => <p key={item}>↳ {item}</p>)}</section>}</aside></section>
    <footer className="meeting-footer"><span>{mode === 'verified' ? '会议字幕同步中' : '同类提醒冷却 20 秒'}</span><span>催催正在判断是否需要介入</span>{mode === 'verified' && <button type="button" onClick={onSkip}>跳到下个触发点 →</button>}</footer>
  </main>;
}

function ReportView({ config, report, events, loading, onReplay, onReset }: { config: MeetingConfig; report: MeetingReport; events: Intervention[]; loading: boolean; onReplay: () => void; onReset: () => void }) {
  const [selectedEvent, setSelectedEvent] = useState<Intervention | null>(events[0] || null);
  const exportReport = () => { const blob = new Blob([JSON.stringify({ meeting: config, report, interventions: events }, null, 2)], { type: 'application/json;charset=utf-8' }); const url = URL.createObjectURL(blob); const link = document.createElement('a'); link.href = url; link.download = `催催会议报告-${new Date().toISOString().slice(0, 10)}.json`; link.click(); URL.revokeObjectURL(url); };
  return <main className="report-shell"><header className="report-header"><button className="brand brand-button" type="button" onClick={onReset}><span className="brand-mark">C²</span><span><strong>催催</strong><small>会议效率助手</small></span></button><nav className="stage-track"><span className="stage done"><i>✓</i> 会前</span><span className="stage-line done" /><span className="stage done"><i>✓</i> 会中</span><span className="stage-line done" /><span className="stage active"><i>3</i> 会后</span></nav><div className="report-actions"><button type="button" onClick={() => window.print()}>打印 / PDF</button><button type="button" onClick={exportReport}>导出纪要</button></div></header>
    {loading && <div className="report-loading"><span className="ai-orb"><i /></span><b>催催正在整理本次会议…</b><p>正在梳理摘要、决策和行动项。</p></div>}
    <section className="report-hero"><div className="score-orbit" style={{ '--score': `${report.overall * 3.6}deg` } as CSSProperties}><div><strong>{report.overall}</strong><span>效率综合分</span></div></div><div className="verdict-block"><p>催催判词</p><h1>{report.verdict}</h1><div className="necessity-verdict"><span>{report.necessity}</span><p>{report.necessityReason}</p></div></div><div className="report-meta"><span><small>实际 / 计划</small><b>{formatClock(report.actualSeconds)} / {formatClock(config.durationSeconds)}</b></span><span><small>会中干预</small><b>{events.length} 次</b></span><span><small>行动项</small><b>{report.actions.length} 项</b></span></div></section>
    <section className="report-evidence"><div className="report-section-heading"><div><p>关键节点复盘</p><h2>沿着时间轴回看会议变化</h2></div><span>点击标记查看当时讨论</span></div><div className="replay-timeline"><PulseTimeline elapsed={config.durationSeconds} duration={config.durationSeconds} events={events} compact />{events.map((event) => <button type="button" key={event.id} className={`replay-marker ${event.severity} ${selectedEvent?.id === event.id ? 'active' : ''}`} style={{ left: `${Math.min(100, event.at / config.durationSeconds * 100)}%` }} onClick={() => setSelectedEvent(event)}><i /></button>)}</div>{selectedEvent && <article className={`replay-detail ${selectedEvent.severity}`}><div><time>{formatClock(selectedEvent.at)}</time><b>{selectedEvent.label}</b></div><p>{selectedEvent.observation}</p><span>{selectedEvent.evidence}</span></article>}</section>
    <section className="report-grid"><article className="report-card score-card"><div className="report-section-heading small"><div><p>四维评分</p><h2>由本次数据计算</h2></div></div>{report.scores.map((score) => <div className="score-row" key={score.key}><div><b>{score.label}</b><span>{score.detail}</span></div><div className="score-bar"><i style={{ width: `${score.value}%` }} /></div><strong>{score.value}</strong></div>)}</article><article className="report-card summary-card"><div className="report-section-heading small"><div><p>会议结果</p><h2>摘要与明确结论</h2></div></div><p className="summary-copy">{report.summary}</p><div className="result-list"><h3>已形成决策</h3>{report.decisions.length ? report.decisions.map((item) => <p key={item}><span>✓</span>{item}</p>) : <p><span>·</span>尚未识别明确决策</p>}</div></article><article className="report-card actions-card"><div className="report-section-heading small"><div><p>下一步</p><h2>行动项</h2></div></div>{report.actions.length ? report.actions.map((action) => <div className="action-item" key={`${action.owner}-${action.task}`}><span>{action.owner.slice(0, 1)}</span><div><b>{action.task}</b><p>{action.owner} · {action.due}</p></div></div>) : <p className="empty-report-copy">本次没有识别到行动项。</p>}</article><article className="report-card participation-card"><div className="report-section-heading small"><div><p>参与度</p><h2>谁在推动讨论</h2></div></div><div className="participation-list">{report.speakerStats.map((stat) => { const person = getSpeaker(stat.id, config.attendees); return <div key={stat.id}><span className="stat-avatar" style={{ background: person.color }}>{person.short}</span><b>{person.name}</b><div><i style={{ width: `${stat.share}%`, background: person.color }} /></div><strong>{stat.share.toFixed(1)}%</strong></div>; })}</div><p className="attendance-advice"><span>参会建议</span>{report.attendanceAdvice}</p></article><article className="report-card suggestions-card"><div className="report-section-heading small"><div><p>下次更好</p><h2>可执行改进</h2></div></div><ol>{report.suggestions.map((suggestion) => <li key={suggestion}>{suggestion}</li>)}</ol></article></section>
    <footer className="report-footer"><div><b>这场会的结论已经整理完成</b><span>可以导出报告，也可以返回重新体验</span></div><button type="button" onClick={onReset}>返回会前</button><button className="replay-button" type="button" onClick={onReplay}>重新播放录音</button></footer>
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
  const [roomSession] = useState<RoomSession | null>(null);
  const [roomSnapshot, setRoomSnapshot] = useState<RoomSnapshot | null>(null);
  const transcriberRef = useRef<MeetingTranscriber | null>(null);
  const transcriberTransitionRef = useRef<Promise<void>>(Promise.resolve());
  const transcriberStartingRef = useRef(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const liveLinesRef = useRef<TranscriptLine[]>([]);
  const engineRef = useRef<'iflytek' | null>(null);
  const roomRevisionRef = useRef(0);
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
  useEffect(() => () => { void transcriberRef.current?.stop(); audioRef.current?.pause(); }, []);

  useEffect(() => {
    if (!roomSession) return;
    let cancelled = false;
    let inFlight = false;
    const poll = async () => {
      if (inFlight) return; inFlight = true;
      try {
        const response = await fetch(`/api/room?code=${encodeURIComponent(roomSession.code)}`, { cache: 'no-store', headers: { Authorization: `Bearer ${roomSession.participantToken}` } });
        const payload = await response.json() as { room?: RoomSnapshot; error?: string };
        if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
        if (!cancelled && payload.room && payload.room.revision >= roomRevisionRef.current) {
          roomRevisionRef.current = payload.room.revision;
          setRoomSnapshot(payload.room);
          if (mode === 'room') { const mapped = payload.room.utterances.map((line) => ({ id: line.id, at: line.started_at, end: line.ended_at, speakerId: line.participant_id, speaker: line.name, text: line.text, topic: '多人实时讨论', workRelated: true, asrSource: '身份音轨' })); liveLinesRef.current = mapped; setLiveLines(mapped); }
        }
      } catch (reason) { if (!cancelled) setError(reason instanceof Error ? reason.message : '会场同步失败'); }
      finally { inFlight = false; }
    };
    void poll();
    const timer = window.setInterval(() => void poll(), 700);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [roomSession, mode]);

  const displayConfig = useMemo(() => {
    if (mode === 'room' && roomSnapshot) {
      const attendees = roomSpeakers(roomSnapshot);
      return { ...config, ...roomSnapshot.meeting, attendees: attendees.length ? attendees : config.attendees, prioritySpeakerId: attendees.find((person) => person.isPriority)?.id || attendees[0]?.id || config.prioritySpeakerId };
    }
    return config;
  }, [mode, roomSnapshot, config]);

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
    setError(null); setEngine(null); setLiveDraft('');
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
          setError(message);
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
      setError(`讯飞实时听写未启动：${directError instanceof Error ? directError.message : '连接失败'}`);
    } finally {
      transcriberStartingRef.current = false;
    }
  }, []);

  const startMeeting = useCallback(async (targetMode: Mode) => {
    if (targetMode === 'verified' && !verifiedRun) return;
    if (targetMode === 'room' && !roomSession) return;
    setMode(targetMode); setScreen('meeting'); setElapsed(0); setRunning(targetMode !== 'verified'); setError(null); setActionState({}); setParkingItems([]); setLiveLines([]); setLiveDraft(''); setLiveEvents([]); setSelectedSpeakerId(config.attendees[0]?.id || 'host');
    selectedSpeakerRef.current = config.attendees[0]?.id || 'host'; lastSpokenRef.current = ''; lastAnalyzedRef.current = ''; fullRecognitionRef.current = ''; committedCharsRef.current = 0;
    if (targetMode === 'live') window.setTimeout(() => void startTranscriber(), 120);
    if (targetMode === 'room' && roomSession) await postRoom({ action: 'control', code: roomSession.code, hostToken: roomSession.hostToken, status: 'live' }).catch((reason) => setError(reason instanceof Error ? reason.message : '无法启动会场'));
    if (targetMode === 'verified' && audioRef.current) { audioRef.current.currentTime = 0; audioRef.current.playbackRate = speed; audioRef.current.muted = !soundOn; void audioRef.current.play().catch(() => { setRunning(false); setError('浏览器阻止了自动播放，请点击“继续”开始录音。'); }); }
  }, [verifiedRun, roomSession, config.attendees, startTranscriber, speed, soundOn]);

  useEffect(() => {
    if (screen !== 'meeting' || !running || mode === 'verified') return;
    const interval = window.setInterval(() => setElapsed((value) => Math.min(displayConfig.durationSeconds + 3600, value + .1)), 100);
    return () => window.clearInterval(interval);
  }, [screen, running, mode, displayConfig.durationSeconds]);

  const visibleTranscript = mode === 'verified' ? (verifiedRun?.transcript || []).filter((line) => line.end <= elapsed + .05) : liveLines;
  const visibleEvents = mode === 'verified' ? (verifiedRun?.events || []).filter((event) => event.at <= elapsed) : liveEvents;

  useEffect(() => {
    if (screen !== 'meeting' || !soundOn || !visibleEvents.length) return;
    const latest = visibleEvents.at(-1)!;
    if (!latest.voice || lastSpokenRef.current === latest.id || actionState[latest.id] === 'ignored') return;
    lastSpokenRef.current = latest.id;
    if ('speechSynthesis' in window) { window.speechSynthesis.cancel(); const utterance = new SpeechSynthesisUtterance(latest.voice); utterance.lang = 'zh-CN'; window.speechSynthesis.speak(utterance); }
  }, [screen, soundOn, visibleEvents, actionState]);

  useEffect(() => {
    if (screen !== 'meeting' || mode === 'verified' || !running) return;
    const hasEvidence = mode === 'room' ? liveLines.length > 0 : liveDraft.length >= 8 || liveLines.length > 0;
    if (!hasEvidence) return;
    const snapshotKey = [...liveLines.map((line) => `${line.speakerId}:${line.text}`), mode === 'live' ? `${selectedSpeakerId}:${liveDraft}` : ''].join('|');
    if (!snapshotKey || snapshotKey === lastAnalyzedRef.current) return;
    const timer = window.setTimeout(async () => {
      lastAnalyzedRef.current = snapshotKey;
      try {
        const transcript = [...liveLines.map((line) => ({ speaker: getSpeaker(line.speakerId, displayConfig.attendees).name, text: line.text, at: line.at })), ...(mode === 'live' && liveDraft ? [{ speaker: getSpeaker(selectedSpeakerId, displayConfig.attendees).name, text: liveDraft, at: elapsedRef.current }] : [])];
        const accessToken = await getDemoSession();
        const response = await fetch('/api/analyze', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Cuicui-Session': accessToken }, body: JSON.stringify({ meeting: { title: displayConfig.title, type: displayConfig.meetingType, durationSeconds: displayConfig.durationSeconds, agenda: displayConfig.agenda }, elapsedSeconds: elapsedRef.current, previousEventTypes: liveEvents.map((event) => event.type), transcript }) });
        const data = await response.json() as { events?: Array<Omit<Intervention, 'id' | 'at'>>; error?: string };
        if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
        if (Array.isArray(data.events) && data.events.length) setLiveEvents((previous) => [...previous, ...data.events!.filter((event) => !previous.some((item) => item.type === event.type && elapsedRef.current - item.at < 20)).map((event, index) => ({ ...event, id: `ai-${Date.now()}-${index}`, at: elapsedRef.current, actions: event.severity === 'critical' ? ['adopt', 'park'] : ['adopt', 'ignore'] } as Intervention))]);
      } catch { setError('AI 分析暂时不可用，转写仍在保存，可稍后继续生成报告。'); }
    }, mode === 'room' ? 650 : 1300);
    return () => window.clearTimeout(timer);
  }, [screen, mode, running, liveDraft, liveLines, liveEvents, selectedSpeakerId, displayConfig]);

  const buildStats = useCallback((lines: TranscriptLine[], attendees: Speaker[]) => {
    const totals = new Map<string, number>(); for (const line of lines) totals.set(line.speakerId, (totals.get(line.speakerId) || 0) + Math.max(1, line.end - line.at));
    const total = Math.max(1, [...totals.values()].reduce((sum, value) => sum + value, 0));
    return attendees.map((person) => ({ id: person.id, seconds: Math.round(totals.get(person.id) || 0), share: (totals.get(person.id) || 0) / total * 100, turns: lines.filter((line) => line.speakerId === person.id).length, interruptions: 0 }));
  }, []);

  const endMeeting = useCallback(async () => {
    if (screen !== 'meeting') return;
    setRunning(false); audioRef.current?.pause(); window.speechSynthesis?.cancel();
    if (mode === 'verified' && verifiedRun) { setReport(verifiedRun.report); setScreen('report'); return; }
    if (mode === 'room' && roomSession) await postRoom({ action: 'control', code: roomSession.code, hostToken: roomSession.hostToken, status: 'ended' }).catch(() => undefined);
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
  }, [screen, mode, verifiedRun, roomSession, displayConfig, liveEvents, buildStats]);

  const resetSession = useCallback(() => { if (roomSession && roomSnapshot?.status === 'live') void postRoom({ action: 'control', code: roomSession.code, hostToken: roomSession.hostToken, status: 'ended' }); void transcriberRef.current?.stop(); transcriberRef.current = null; audioRef.current?.pause(); if (audioRef.current) audioRef.current.currentTime = 0; setScreen('setup'); setRunning(false); setElapsed(0); liveLinesRef.current = []; setLiveLines([]); setLiveDraft(''); setLiveEvents([]); setLiveStatus(null); engineRef.current = null; setEngine(null); setActionState({}); setParkingItems([]); setError(null); setReport(EMPTY_REPORT); setReportLoading(false); fullRecognitionRef.current = ''; committedCharsRef.current = 0; lastSpokenRef.current = ''; lastAnalyzedRef.current = ''; }, [roomSession, roomSnapshot?.status]);
  const selectSpeaker = useCallback((id: string) => { if (id === selectedSpeakerId) return; commitDraft(); setSelectedSpeakerId(id); selectedSpeakerRef.current = id; }, [selectedSpeakerId, commitDraft]);
  const handleAction = (event: Intervention, action: 'adopt' | 'park' | 'ignore') => { setActionState((previous) => ({ ...previous, [event.id]: action === 'adopt' ? 'adopted' : action === 'park' ? 'parked' : 'ignored' })); if (action === 'park') setParkingItems((previous) => [...new Set([...previous, event.observation])]); };
  const pauseMeeting = useCallback(() => {
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
      if (current) transcriberTransitionRef.current = current.stop().catch((reason) => { setError(reason instanceof Error ? reason.message : '无法暂停实时听写'); });
    } else {
      setRunning(true);
      void startTranscriber();
    }
  }, [mode, running, startTranscriber]);
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
    const handler = (event: KeyboardEvent) => { const target = event.target as HTMLElement | null; if (target && /INPUT|TEXTAREA|SELECT/.test(target.tagName)) return; if (event.code === 'Space') { event.preventDefault(); if (screen === 'setup') void startMeeting('verified'); else if (screen === 'meeting') pauseMeeting(); } if (screen === 'meeting' && mode === 'live' && /^[1-5]$/.test(event.key)) { const person = config.attendees[Number(event.key) - 1]; if (person) selectSpeaker(person.id); } if (event.key === 'Escape' && showConfig) setShowConfig(false); };
    window.addEventListener('keydown', handler); return () => window.removeEventListener('keydown', handler);
  }, [screen, mode, config.attendees, showConfig, startMeeting, pauseMeeting, selectSpeaker]);

  return <>
    <audio ref={audioRef} className="persistent-audio" preload="auto" src={verifiedRun?.audio.artifacts.master.path || '/demo/meeting-master-assistant-plan-v1.mp3'} />
    {screen === 'setup' && <SetupView config={config} health={health} verifiedRun={verifiedRun} verifiedError={verifiedError} onConfigure={() => setShowConfig(true)} onStart={(target) => void startMeeting(target)} />}
    {screen === 'meeting' && <MeetingView config={displayConfig} mode={mode} roomCode={roomSession?.code} roomCount={roomSnapshot?.participants.length} engine={engine} elapsed={elapsed} running={running} speed={speed} soundOn={soundOn} liveStatus={liveStatus} selectedSpeakerId={selectedSpeakerId} transcript={visibleTranscript} liveDraft={liveDraft} events={visibleEvents} actionState={actionState} parkingItems={parkingItems} error={error} verifiedRun={verifiedRun} onPause={pauseMeeting} onSpeed={changeSpeed} onSound={changeSound} onSkip={skipToNext} onEnd={() => void endMeeting()} onReset={resetSession} onSpeaker={selectSpeaker} onCommitDraft={commitDraft} onAction={handleAction} />}
    {screen === 'report' && <ReportView config={displayConfig} report={report} events={mode === 'verified' ? verifiedRun?.events || [] : liveEvents} loading={reportLoading} onReplay={() => void startMeeting('verified')} onReset={resetSession} />}
    {showConfig && <ConfigDialog config={config} onSave={saveConfig} onClose={() => setShowConfig(false)} />}
  </>;
}

export default function MeetingApp() {
  return <HostMeetingApp />;
}
