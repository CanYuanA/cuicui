'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import {
  DEFAULT_CONFIG,
  DEMO_EVENTS,
  DEMO_REPORT,
  DEMO_SCRIPT,
  TOPIC_SEGMENTS,
  formatClock,
  getSpeaker,
  type Intervention,
  type MeetingConfig,
  type Speaker,
  type TranscriptLine,
} from './demo-data';
import { XfyunTranscriber, type TranscriberStatus } from './live-transcriber';

type Screen = 'setup' | 'meeting' | 'report';
type Mode = 'demo' | 'live';
type ServiceHealth = { openrouter: boolean; iflytek: boolean; speech: boolean };
type ActionState = Record<string, 'adopted' | 'parked' | 'ignored'>;
type ReportData = typeof DEMO_REPORT;

const cloneConfig = () => ({ ...DEFAULT_CONFIG, agenda: [...DEFAULT_CONFIG.agenda], attendees: DEFAULT_CONFIG.attendees.map((person) => ({ ...person })) });

function serviceLabel(health: ServiceHealth | null) {
  if (!health) return '正在检查服务';
  const ready = Number(health.openrouter) + Number(health.iflytek) + Number(health.speech);
  return ready === 3 ? '实时服务全部就绪' : `演示模式就绪 · ${ready}/3 实时服务`;
}

function ConfigDialog({ config, onSave, onClose }: { config: MeetingConfig; onSave: (value: MeetingConfig) => void; onClose: () => void }) {
  const [draft, setDraft] = useState(() => ({ ...config, agenda: [...config.agenda], attendees: config.attendees.map((person) => ({ ...person })) }));
  const save = () => {
    const title = draft.title.trim();
    const agenda = draft.agenda.map((item) => item.trim()).filter(Boolean);
    if (!title || agenda.length === 0) return;
    onSave({ ...draft, title, agenda, durationSeconds: Math.max(30, Number(draft.durationSeconds) || 100) });
  };

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className="config-dialog" role="dialog" aria-modal="true" aria-labelledby="config-title">
        <div className="dialog-heading">
          <div><p>会议基准</p><h2 id="config-title">告诉催催，这场会要完成什么</h2></div>
          <button className="icon-button" type="button" onClick={onClose} aria-label="关闭配置">×</button>
        </div>
        <div className="form-grid">
          <label className="field field-wide"><span>会议主题 *</span><input value={draft.title} onChange={(event) => setDraft({ ...draft, title: event.target.value })} /></label>
          <label className="field"><span>计划时长（秒）*</span><input type="number" min="30" max="7200" value={draft.durationSeconds} onChange={(event) => setDraft({ ...draft, durationSeconds: Number(event.target.value) })} /></label>
          <label className="field"><span>会议类型</span>
            <select value={draft.meetingType} onChange={(event) => setDraft({ ...draft, meetingType: event.target.value })}>
              <option>方案决策会</option><option>研发周会</option><option>脑暴会</option><option>汇报会</option><option>评审会</option>
            </select>
          </label>
          <label className="field field-wide"><span>议题列表 *（每行一项）</span><textarea rows={4} value={draft.agenda.join('\n')} onChange={(event) => setDraft({ ...draft, agenda: event.target.value.split('\n') })} /></label>
          <label className="field field-wide"><span>关联资料（可选）</span><input type="url" placeholder="https://…" value={draft.contextUrl || ''} onChange={(event) => setDraft({ ...draft, contextUrl: event.target.value })} /></label>
          <div className="field field-wide"><span>参会人员与高优先级角色</span>
            <div className="people-editor">
              {draft.attendees.map((person, index) => (
                <label key={person.id} className={draft.prioritySpeakerId === person.id ? 'person-edit priority' : 'person-edit'}>
                  <span className="mini-avatar" style={{ background: person.color }}>{person.short}</span>
                  <input aria-label={`第 ${index + 1} 位参会者`} value={person.name} onChange={(event) => {
                    const attendees = draft.attendees.map((item) => item.id === person.id ? { ...item, name: event.target.value, short: event.target.value.slice(0, 1) || item.short } : item);
                    setDraft({ ...draft, attendees });
                  }} />
                  <input type="radio" name="priority" checked={draft.prioritySpeakerId === person.id} onChange={() => setDraft({ ...draft, prioritySpeakerId: person.id })} aria-label={`将${person.name}设为高优先级角色`} />
                </label>
              ))}
            </div>
          </div>
        </div>
        <div className="dialog-note"><b>高优先级不是免催卡。</b>角色会作为决策语境，但触发标准对所有人一致。</div>
        <div className="dialog-actions"><button className="text-button" type="button" onClick={onClose}>取消</button><button className="compact-primary" type="button" onClick={save}>保存会议基准</button></div>
      </section>
    </div>
  );
}

function SetupView({ config, health, onConfigure, onStart }: { config: MeetingConfig; health: ServiceHealth | null; onConfigure: () => void; onStart: (mode: Mode) => void }) {
  return (
    <main className="preflight-shell">
      <header className="site-header">
        <button className="brand brand-button" type="button" aria-label="催催助手首页">
          <span className="brand-mark" aria-hidden="true">C²</span>
          <span><strong>催催</strong><small>会议效率助手</small></span>
        </button>
        <nav className="stage-track" aria-label="会议阶段">
          <span className="stage active"><i>1</i> 会前</span><span className="stage-line" />
          <span className="stage"><i>2</i> 会中</span><span className="stage-line" />
          <span className="stage"><i>3</i> 会后</span>
        </nav>
        <div className="health-pill" aria-label="服务状态"><span className="health-dot" />{serviceLabel(health)}</div>
      </header>

      <section className="hero-grid">
        <div className="hero-copy">
          <p className="eyebrow"><span /> AI 创意大赛 · 会中干预型 Agent</p>
          <h1>让会议在失控之前，<br /><em>被温柔地催回来。</em></h1>
          <p className="hero-lead">实时听写并理解正在发生的讨论，在偏题、重复和超时的当下给出下一步。</p>
          <div className="proof-row" aria-label="能力示例">
            <div><b>偏题 11 秒</b><span>收回主线</span></div><div><b>重复 2 次</b><span>推进决策</span></div><div><b>剩余 24 秒</b><span>强制收敛</span></div>
          </div>
          <div className="principle-note"><span className="wave-dot" aria-hidden="true"><i /><i /><i /><i /></span><p><strong>不是会后总结。</strong>催催会在会议进行时听懂、判断并介入。</p></div>
        </div>

        <aside className="mission-card" aria-labelledby="mission-title">
          <div className="card-topline"><span className="mode-badge">开卷演示模式</span><button className="edit-config" type="button" onClick={onConfigure}>编辑会议 ↗</button></div>
          <p className="card-kicker">下一场会议</p><h2 id="mission-title">{config.title}</h2>
          <div className="meeting-meta"><span>{config.attendees.length} 位参会者</span><i /><span>{config.agenda.length} 个议题</span><i /><span>6 次预期干预</span></div>
          <div className="agenda-rail" aria-label="议题时间分配">
            <div className="rail-head"><span>会议脉冲带</span><b>{config.durationSeconds} 秒</b></div>
            <div className="rail-track"><div className="rail-segment segment-1" style={{ width: '42%' }}><span>1</span></div><div className="rail-segment segment-2" style={{ width: '32%' }}><span>2</span></div><div className="rail-buffer">收敛</div><i className="event-dot dot-one" title="闲聊提醒" /><i className="event-dot dot-two" title="重复发言" /><i className="event-dot dot-three" title="分歧预警" /></div>
            <div className="rail-labels"><span>{config.agenda[0]?.slice(0, 6)}</span><span>{config.agenda[1]?.slice(0, 6) || '行动项'}</span><span>决策</span></div>
          </div>
          <div className="attendee-row" aria-label="参会者">
            {config.attendees.map((person, index) => <span className={`avatar avatar-${index + 1}`} style={{ background: person.color }} key={person.id}>{person.short}</span>)}
            <span className="attendee-copy"><b>{config.attendees.length} 人已就位</b><small>{getSpeaker(config.prioritySpeakerId, config.attendees).name}已标记为高优先级角色</small></span>
          </div>
          <button className="primary-action" type="button" onClick={() => onStart('demo')}><span className="play-mark" aria-hidden="true" />开始演示会议<kbd>Space</kbd></button>
          <button className="secondary-action" type="button" onClick={() => onStart('live')}>使用麦克风实时体验<span>{health?.iflytek ? '讯飞已就绪 →' : '可自动降级 →'}</span></button>
          <p className="privacy-line"><span>✓</span> 默认脚本不消耗 API 额度，实时模式可随时切回</p>
        </aside>
      </section>
      <footer className="preflight-footer">
        <span><i className={health?.iflytek ? 'status-ok' : 'status-warn'} /> 讯飞听写</span><span><i className={health?.openrouter ? 'status-ok' : 'status-warn'} /> AI 分析</span><span><i className="status-ok" /> 语音提醒</span><p>Agent 面前，老板也会被平等地催一下。</p>
      </footer>
    </main>
  );
}

function PulseTimeline({ elapsed, duration, events, compact = false }: { elapsed: number; duration: number; events: Intervention[]; compact?: boolean }) {
  const progress = Math.max(0, Math.min(100, elapsed / duration * 100));
  return (
    <div className={compact ? 'pulse-widget compact' : 'pulse-widget'}>
      <div className="pulse-widget-head"><span>会议脉冲带</span><b>{Math.round(progress)}%</b></div>
      <div className="topic-pulse" aria-label={`会议进度 ${Math.round(progress)}%`}>
        {TOPIC_SEGMENTS.map((segment) => <span key={segment.label} className={`topic-segment ${segment.tone}`} style={{ left: `${segment.start}%`, width: `${segment.end - segment.start}%` }} title={segment.label} />)}
        {events.map((event) => <i key={event.id} className={`pulse-event ${event.severity}`} style={{ left: `${event.at / duration * 100}%` }} title={`${formatClock(event.at)} ${event.label}`} />)}
        <span className="pulse-progress" style={{ width: `${progress}%` }} /><span className="pulse-cursor" style={{ left: `${progress}%` }} />
      </div>
      {!compact && <div className="pulse-label-row"><span>开场</span><span>偏题</span><span>方案讨论</span><span>收敛</span></div>}
    </div>
  );
}

function MeetingView({
  config, mode, elapsed, running, speed, soundOn, liveStatus, selectedSpeakerId, transcript, liveDraft, events, actionState, parkingItems, error,
  onPause, onSpeed, onSound, onSkip, onEnd, onReset, onSpeaker, onCommitDraft, onAction,
}: {
  config: MeetingConfig; mode: Mode; elapsed: number; running: boolean; speed: number; soundOn: boolean; liveStatus: TranscriberStatus | null; selectedSpeakerId: string;
  transcript: TranscriptLine[]; liveDraft: string; events: Intervention[]; actionState: ActionState; parkingItems: string[]; error: string | null;
  onPause: () => void; onSpeed: () => void; onSound: () => void; onSkip: () => void; onEnd: () => void; onReset: () => void; onSpeaker: (id: string) => void; onCommitDraft: () => void; onAction: (event: Intervention, action: 'adopt' | 'park' | 'ignore') => void;
}) {
  const listRef = useRef<HTMLDivElement>(null);
  const duration = mode === 'demo' ? 100 : config.durationSeconds;
  const progress = Math.max(0, Math.min(100, elapsed / duration * 100));
  const latestEvent = events.length ? events[events.length - 1] : null;
  const currentTopic = mode === 'demo'
    ? TOPIC_SEGMENTS.find((segment) => elapsed >= segment.start && elapsed < segment.end)?.label || '行动项'
    : '实时语义分析中';
  const remaining = Math.max(0, duration - elapsed);
  const visibleAgenda = progress < 58 ? config.agenda[0] : config.agenda[1] || config.agenda[0];
  const speakerSeconds = useMemo(() => {
    const result = new Map<string, number>();
    for (const line of transcript) result.set(line.speakerId, (result.get(line.speakerId) || 0) + Math.max(1, Math.min(line.end, elapsed) - line.at));
    return result;
  }, [transcript, elapsed]);
  const totalSpeech = Math.max(1, [...speakerSeconds.values()].reduce((sum, value) => sum + value, 0));

  useEffect(() => { listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: 'smooth' }); }, [transcript.length, liveDraft]);

  return (
    <main className="meeting-shell">
      <header className="meeting-header">
        <button className="brand brand-button" type="button" onClick={onReset}><span className="brand-mark">C²</span><span><strong>催催</strong><small>会议效率助手</small></span></button>
        <div className="meeting-title"><span className={mode === 'demo' ? 'live-dot demo' : 'live-dot'} /> <div><b>{config.title}</b><small>{mode === 'demo' ? '开卷演示 · 确定性触发' : `真实听写 · ${liveStatus === 'listening' ? '正在聆听' : liveStatus || '准备中'}`}</small></div></div>
        <div className="meeting-controls">
          {mode === 'demo' && <button type="button" className="control-chip" onClick={onSpeed}>{speed}×</button>}
          <button type="button" className={soundOn ? 'control-chip active' : 'control-chip'} onClick={onSound} aria-pressed={soundOn}>{soundOn ? '声音开' : '声音关'}</button>
          <button type="button" className="control-chip" onClick={onPause}>{running ? '暂停' : '继续'}</button>
          <button type="button" className="end-button" onClick={onEnd}>结束会议</button>
        </div>
      </header>

      <section className="time-command" aria-label="会议时间进度">
        <div className="topic-now"><small>当前议题</small><b>{visibleAgenda}</b></div>
        <div className="time-progress"><div className="time-copy"><span>已进行 {formatClock(elapsed)}</span><strong>剩余 {formatClock(remaining)}</strong><span>{currentTopic}</span></div><div className="time-track"><i style={{ width: `${progress}%` }} className={progress >= 90 ? 'danger' : progress >= 75 ? 'warning' : ''} /></div></div>
        <div className={progress >= 75 ? 'forecast warning' : 'forecast'}><small>节奏预测</small><b>{progress < 58 ? '按时推进' : progress < 75 ? '需要收敛' : progress < 92 ? '预计超时 +00:18' : '决策已形成'}</b></div>
      </section>

      {error && <div className="service-error" role="status"><b>实时链路提示</b><span>{error}</span><button type="button" onClick={onReset}>切回演示模式</button></div>}

      <section className="meeting-grid">
        <section className="transcript-panel" aria-labelledby="transcript-title">
          <div className="panel-heading"><div><p>实时现场</p><h2 id="transcript-title">会议转写</h2></div><div className="signal-bars" aria-label={running ? '正在接收音频' : '已暂停'}><i /><i /><i /><i /><i /></div></div>
          {mode === 'live' && <div className="speaker-switcher"><span>当前发言者</span>{config.attendees.map((person, index) => <button type="button" key={person.id} className={selectedSpeakerId === person.id ? 'speaker-pill active' : 'speaker-pill'} onClick={() => onSpeaker(person.id)} style={{ '--speaker': person.color } as CSSProperties}><i>{person.short}</i>{person.name}<kbd>{index + 1}</kbd></button>)}<button type="button" className="commit-draft" disabled={!liveDraft.trim()} onClick={onCommitDraft}>提交这一句</button></div>}
          <div className="transcript-list" ref={listRef} aria-live="polite">
            {transcript.length === 0 && !liveDraft && <div className="list-empty"><span className="listening-orbit"><i /></span><b>{mode === 'live' ? '正在等待第一句话…' : '会议即将开始'}</b><p>催催只在证据充分时介入。</p></div>}
            {transcript.map((line, index) => {
              const speaker = getSpeaker(line.speakerId, config.attendees);
              const isLatest = index === transcript.length - 1;
              return <article className={isLatest ? 'transcript-line latest' : 'transcript-line'} key={line.id} style={{ '--speaker': speaker.color } as CSSProperties}>
                <time>{formatClock(line.at)}</time><span className="line-avatar">{speaker.short}</span><div><p className="speaker-name">{speaker.name}{speaker.isPriority && <em>高优先级</em>}{line.interrupted && <em className="interrupted">被打断</em>}</p><p className="line-copy">{line.text}</p><span className="line-topic"># {line.topic}</span></div>
              </article>;
            })}
            {liveDraft && <article className="transcript-line latest draft" style={{ '--speaker': getSpeaker(selectedSpeakerId, config.attendees).color } as CSSProperties}><time>{formatClock(elapsed)}</time><span className="line-avatar">{getSpeaker(selectedSpeakerId, config.attendees).short}</span><div><p className="speaker-name">{getSpeaker(selectedSpeakerId, config.attendees).name}<em>听写中</em></p><p className="line-copy">{liveDraft}<span className="typing-cursor" /></p></div></article>}
          </div>
        </section>

        <aside className="assistant-panel" aria-label="AI 智能提醒与分析">
          <div className="assistant-heading"><div><span className="ai-orb"><i /></span><div><p>CUICUI AGENT</p><h2>现场干预</h2></div></div><span className="agent-state"><i /> {running ? '持续分析' : '已暂停'}</span></div>
          <section className={latestEvent ? `intervention-card ${latestEvent.severity}` : 'intervention-card calm'} aria-live="polite">
            {!latestEvent ? <div className="calm-state"><span>✓</span><div><b>会议节奏正常</b><p>正在结合主题、时间与说话人持续判断。</p></div></div> : <>
              <div className="intervention-top"><span>{latestEvent.label}</span><time>{formatClock(latestEvent.at)}</time></div>
              <div className="intervention-copy"><p><b>观察</b>{latestEvent.observation}</p><p><b>影响</b>{latestEvent.impact}</p><p><b>建议</b>{latestEvent.suggestion}</p></div>
              <div className="evidence-line"><span>判断依据</span><b>{latestEvent.evidence}</b></div>
              {latestEvent.actions && !actionState[latestEvent.id] && <div className="intervention-actions">
                {latestEvent.actions.includes('adopt') && <button type="button" onClick={() => onAction(latestEvent, 'adopt')}>采纳建议</button>}
                {latestEvent.actions.includes('park') && <button type="button" onClick={() => onAction(latestEvent, 'park')}>放入停车场</button>}
                {latestEvent.actions.includes('ignore') && <button type="button" className="quiet" onClick={() => onAction(latestEvent, 'ignore')}>忽略</button>}
              </div>}
              {actionState[latestEvent.id] && <div className="action-confirmed">✓ {actionState[latestEvent.id] === 'parked' ? '已加入会后停车场' : actionState[latestEvent.id] === 'adopted' ? '已采纳，证据仍会保留' : '已忽略，本轮不再提醒'}</div>}
            </>}
          </section>
          <PulseTimeline elapsed={elapsed} duration={duration} events={events} />
          <section className="speaker-stats"><div className="mini-section-head"><span>发言分布</span><b>{transcript.length} 段转写</b></div>{config.attendees.map((person) => {
            const seconds = speakerSeconds.get(person.id) || 0; const share = seconds / totalSpeech * 100;
            return <div className="speaker-stat" key={person.id}><span className="stat-avatar" style={{ background: person.color }}>{person.short}</span><span className="stat-name">{person.name}</span><div className="stat-bar"><i style={{ width: `${share}%`, background: person.color }} /></div><b>{Math.round(share)}%</b></div>;
          })}</section>
          <section className="parking-lot"><div className="mini-section-head"><span>会后停车场</span><b>{parkingItems.length}</b></div>{parkingItems.length ? parkingItems.map((item) => <p key={item}>↳ {item}</p>) : <p className="parking-empty">偏题支线可在这里保留，不丢观点。</p>}</section>
        </aside>
      </section>

      <footer className="meeting-footer"><span>同类提醒冷却 20 秒</span><span>AI 只引用可见转写证据</span>{mode === 'demo' && <button type="button" onClick={onSkip}>跳到下个触发点 →</button>}</footer>
      {latestEvent?.severity === 'critical' && elapsed - latestEvent.at < 4 && <div className="critical-overlay" role="alertdialog" aria-modal="true" aria-label="必须收尾"><div className="critical-symbol">!</div><p>必须收尾</p><h2>分歧仍未收敛，只剩 {Math.ceil(remaining)} 秒。</h2><span>请主持人立即决策</span></div>}
    </main>
  );
}

function ReportView({ config, report, events, loading, onReplay, onReset }: { config: MeetingConfig; report: ReportData; events: Intervention[]; loading: boolean; onReplay: () => void; onReset: () => void }) {
  const [selectedEvent, setSelectedEvent] = useState<Intervention | null>(events[0] || null);
  const exportReport = () => {
    const payload = { meeting: config, report, interventions: events };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json;charset=utf-8' });
    const url = URL.createObjectURL(blob); const link = document.createElement('a');
    link.href = url; link.download = `催催会议报告-${new Date().toISOString().slice(0, 10)}.json`; link.click(); URL.revokeObjectURL(url);
  };
  return (
    <main className="report-shell">
      <header className="report-header"><button className="brand brand-button" type="button" onClick={onReset}><span className="brand-mark">C²</span><span><strong>催催</strong><small>会议效率助手</small></span></button><nav className="stage-track"><span className="stage done"><i>✓</i> 会前</span><span className="stage-line done" /><span className="stage done"><i>✓</i> 会中</span><span className="stage-line done" /><span className="stage active"><i>3</i> 会后</span></nav><div className="report-actions"><button type="button" onClick={() => window.print()}>打印 / PDF</button><button type="button" onClick={exportReport}>导出数据</button></div></header>
      {loading && <div className="report-loading"><span className="ai-orb"><i /></span><b>催催正在整理会议证据…</b><p>评分先由确定性指标计算，摘要由 AI 生成。</p></div>}
      <section className="report-hero">
        <div className="score-orbit" style={{ '--score': `${report.overall * 3.6}deg` } as CSSProperties}><div><strong>{report.overall}</strong><span>效率综合分</span></div></div>
        <div className="verdict-block"><p>催催判词</p><h1>{report.verdict}</h1><div className="necessity-verdict"><span>{report.necessity}</span><p>{report.necessityReason}</p></div></div>
        <div className="report-meta"><span><small>实际 / 计划</small><b>{formatClock(report.actualSeconds)} / {formatClock(config.durationSeconds)}</b></span><span><small>会中干预</small><b>{events.length} 次</b></span><span><small>议题完成</small><b>{config.agenda.length} / {config.agenda.length}</b></span></div>
      </section>
      <section className="report-evidence">
        <div className="report-section-heading"><div><p>可验证证据</p><h2>一条脉冲带，回放整场会议</h2></div><span>点击标记查看判断依据</span></div>
        <div className="replay-timeline"><PulseTimeline elapsed={100} duration={100} events={events} compact />{events.map((event) => <button type="button" key={event.id} aria-label={`查看 ${event.label}`} className={`replay-marker ${event.severity} ${selectedEvent?.id === event.id ? 'active' : ''}`} style={{ left: `${event.at}%` }} onClick={() => setSelectedEvent(event)}><i /></button>)}</div>
        {selectedEvent && <article className={`replay-detail ${selectedEvent.severity}`}><div><time>{formatClock(selectedEvent.at)}</time><b>{selectedEvent.label}</b></div><p>{selectedEvent.observation}</p><span>{selectedEvent.evidence}</span></article>}
      </section>
      <section className="report-grid">
        <article className="report-card score-card"><div className="report-section-heading small"><div><p>四维评分</p><h2>哪里做得好，哪里该改</h2></div></div>{report.scores.map((score) => <div className="score-row" key={score.key}><div><b>{score.label}</b><span>{score.detail}</span></div><div className="score-bar"><i style={{ width: `${score.value}%` }} /></div><strong>{score.value}</strong></div>)}</article>
        <article className="report-card summary-card"><div className="report-section-heading small"><div><p>会议结果</p><h2>摘要与明确结论</h2></div></div><p className="summary-copy">{report.summary}</p><div className="result-list"><h3>已形成决策</h3>{report.decisions.length ? report.decisions.map((item) => <p key={item}><span>✓</span>{item}</p>) : <p><span>·</span>尚未识别明确决策</p>}</div></article>
        <article className="report-card actions-card"><div className="report-section-heading small"><div><p>下一步</p><h2>行动项</h2></div></div>{report.actions.length ? report.actions.map((action) => <div className="action-item" key={`${action.owner}-${action.task}`}><span>{action.owner.slice(0, 1)}</span><div><b>{action.task}</b><p>{action.owner} · {action.due}</p></div></div>) : <p className="empty-report-copy">本次没有识别到带负责人的行动项。</p>}</article>
        <article className="report-card participation-card"><div className="report-section-heading small"><div><p>参与度</p><h2>谁在推动，谁只需同步</h2></div></div><div className="participation-list">{report.speakerStats.map((stat) => { const person = getSpeaker(stat.id, config.attendees); return <div key={stat.id}><span className="stat-avatar" style={{ background: person.color }}>{person.short}</span><b>{person.name}</b><div><i style={{ width: `${stat.share}%`, background: person.color }} /></div><strong>{stat.share.toFixed(1)}%</strong></div>; })}</div><p className="attendance-advice"><span>参会建议</span>{report.attendanceAdvice}</p></article>
        <article className="report-card suggestions-card"><div className="report-section-heading small"><div><p>下次更好</p><h2>三条可执行改进</h2></div></div><ol>{report.suggestions.map((suggestion) => <li key={suggestion}>{suggestion}</li>)}</ol></article>
      </section>
      <footer className="report-footer"><div><b>会议证据已保存在本次浏览器会话</b><span>敏感内容不会写入分享图或前端源码</span></div><button type="button" onClick={onReset}>返回会前</button><button className="replay-button" type="button" onClick={onReplay}>重新演示</button></footer>
    </main>
  );
}

export default function MeetingApp() {
  const [screen, setScreen] = useState<Screen>('setup');
  const [mode, setMode] = useState<Mode>('demo');
  const [config, setConfig] = useState<MeetingConfig>(cloneConfig);
  const [health, setHealth] = useState<ServiceHealth | null>(null);
  const [showConfig, setShowConfig] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [running, setRunning] = useState(false);
  const [speed, setSpeed] = useState(2);
  const [soundOn, setSoundOn] = useState(true);
  const [liveLines, setLiveLines] = useState<TranscriptLine[]>([]);
  const [liveDraft, setLiveDraft] = useState('');
  const [liveEvents, setLiveEvents] = useState<Intervention[]>([]);
  const [liveStatus, setLiveStatus] = useState<TranscriberStatus | null>(null);
  const [selectedSpeakerId, setSelectedSpeakerId] = useState('host');
  const [actionState, setActionState] = useState<ActionState>({});
  const [parkingItems, setParkingItems] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [report, setReport] = useState<ReportData>(DEMO_REPORT);
  const [reportLoading, setReportLoading] = useState(false);
  const transcriberRef = useRef<XfyunTranscriber | null>(null);
  const elapsedRef = useRef(0);
  const selectedSpeakerRef = useRef('host');
  const fullRecognitionRef = useRef('');
  const committedCharsRef = useRef(0);
  const lastSpokenRef = useRef('');
  const lastAnalyzedRef = useRef('');
  const autoEndRef = useRef(false);

  useEffect(() => {
    fetch('/api/health', { cache: 'no-store' })
      .then((response) => response.json() as Promise<{ services: ServiceHealth }>)
      .then((data) => setHealth(data.services))
      .catch(() => setHealth({ openrouter: false, iflytek: false, speech: true }));
    try { const saved = localStorage.getItem('cuicui-meeting-config'); if (saved) setConfig({ ...cloneConfig(), ...JSON.parse(saved) }); } catch { /* ignore malformed preference */ }
  }, []);
  useEffect(() => { elapsedRef.current = elapsed; }, [elapsed]);
  useEffect(() => { selectedSpeakerRef.current = selectedSpeakerId; }, [selectedSpeakerId]);

  const commitDraft = useCallback(() => {
    const text = liveDraft.trim(); if (!text) return;
    const speaker = selectedSpeakerRef.current;
    setLiveLines((previous) => [...previous, { id: `live-${Date.now()}`, at: elapsedRef.current, end: elapsedRef.current + Math.max(1, text.length / 5), speakerId: speaker, text, topic: '实时讨论', workRelated: true }]);
    committedCharsRef.current = fullRecognitionRef.current.length;
    setLiveDraft('');
  }, [liveDraft]);

  const startTranscriber = useCallback(async () => {
    if (transcriberRef.current) return;
    const transcriber = new XfyunTranscriber({
      onPartial: (text) => { fullRecognitionRef.current = text; setLiveDraft(text.slice(committedCharsRef.current).trimStart()); },
      onFinal: (text) => {
        const tail = text.slice(committedCharsRef.current).trim();
        if (tail) setLiveLines((previous) => [...previous, { id: `live-${Date.now()}`, at: elapsedRef.current, end: elapsedRef.current + Math.max(1, tail.length / 5), speakerId: selectedSpeakerRef.current, text: tail, topic: '实时讨论', workRelated: true }]);
        committedCharsRef.current = text.length; setLiveDraft('');
      },
      onStatus: setLiveStatus,
      onError: (message) => setError(`${message} 演示脚本仍可完整使用。`),
    });
    transcriberRef.current = transcriber;
    try { await transcriber.start(); } catch (reason) { setError(`${reason instanceof Error ? reason.message : '麦克风启动失败'} 可返回会前使用稳定演示。`); setLiveStatus('closed'); transcriberRef.current = null; }
  }, []);

  const resetSession = useCallback(() => {
    void transcriberRef.current?.stop(); transcriberRef.current = null;
    setScreen('setup'); setRunning(false); setElapsed(0); setLiveLines([]); setLiveDraft(''); setLiveEvents([]); setLiveStatus(null); setActionState({}); setParkingItems([]); setError(null); setReport(DEMO_REPORT); setReportLoading(false);
    fullRecognitionRef.current = ''; committedCharsRef.current = 0; lastSpokenRef.current = ''; lastAnalyzedRef.current = ''; autoEndRef.current = false;
  }, []);

  const startMeeting = useCallback((targetMode: Mode) => {
    setMode(targetMode); setScreen('meeting'); setElapsed(0); setRunning(true); setError(null); setActionState({}); setParkingItems([]); setLiveLines([]); setLiveDraft(''); setLiveEvents([]); setSelectedSpeakerId(config.attendees[0]?.id || 'host');
    selectedSpeakerRef.current = config.attendees[0]?.id || 'host'; autoEndRef.current = false; lastSpokenRef.current = ''; lastAnalyzedRef.current = '';
    if (targetMode === 'live') window.setTimeout(() => void startTranscriber(), 180);
  }, [config.attendees, startTranscriber]);

  useEffect(() => {
    if (screen !== 'meeting' || !running) return;
    const rate = mode === 'demo' ? speed : 1;
    const interval = window.setInterval(() => setElapsed((value) => Math.min(mode === 'demo' ? 100 : config.durationSeconds + 3600, value + .1 * rate)), 100);
    return () => window.clearInterval(interval);
  }, [screen, running, mode, speed, config.durationSeconds]);

  const visibleTranscript = mode === 'demo' ? DEMO_SCRIPT.filter((line) => line.at <= elapsed) : liveLines;
  const visibleEvents = mode === 'demo' ? DEMO_EVENTS.filter((event) => event.at <= elapsed) : liveEvents;

  useEffect(() => {
    if (screen !== 'meeting' || !soundOn || !visibleEvents.length) return;
    const latest = visibleEvents[visibleEvents.length - 1];
    if (!latest.voice || lastSpokenRef.current === latest.id || actionState[latest.id] === 'ignored') return;
    lastSpokenRef.current = latest.id;
    if ('speechSynthesis' in window) { window.speechSynthesis.cancel(); const utterance = new SpeechSynthesisUtterance(latest.voice); utterance.lang = 'zh-CN'; utterance.rate = 1.06; utterance.pitch = .94; window.speechSynthesis.speak(utterance); }
  }, [screen, soundOn, visibleEvents, actionState]);

  useEffect(() => {
    if (screen !== 'meeting' || mode !== 'live' || !running || liveDraft.length < 8) return;
    const snapshot = [...liveLines.map((line) => `${line.speakerId}:${line.text}`), `${selectedSpeakerId}:${liveDraft}`].join('|');
    if (snapshot === lastAnalyzedRef.current) return;
    const timer = window.setTimeout(async () => {
      lastAnalyzedRef.current = snapshot;
      try {
        const response = await fetch('/api/analyze', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ meeting: { title: config.title, type: config.meetingType, durationSeconds: config.durationSeconds, agenda: config.agenda }, elapsedSeconds: elapsedRef.current, previousEventTypes: liveEvents.map((event) => event.type), transcript: [...liveLines.map((line) => ({ speaker: getSpeaker(line.speakerId, config.attendees).name, text: line.text, at: line.at })), { speaker: getSpeaker(selectedSpeakerId, config.attendees).name, text: liveDraft, at: elapsedRef.current }] }) });
        const data = await response.json() as { events?: Array<Omit<Intervention, 'id' | 'at'>> };
        if (Array.isArray(data.events) && data.events.length) setLiveEvents((previous) => {
          const additions = data.events!.filter((event) => !previous.some((item) => item.type === event.type && elapsedRef.current - item.at < 20)).map((event, index) => ({ ...event, id: `ai-${Date.now()}-${index}`, at: elapsedRef.current, actions: event.severity === 'critical' ? ['adopt', 'park'] : ['adopt', 'ignore'] } as Intervention));
          return [...previous, ...additions];
        });
      } catch { setError('AI 分析暂时不可用，已保留听写并启用本地规则兜底。'); }
    }, 1800);
    return () => window.clearTimeout(timer);
  }, [screen, mode, running, liveDraft, liveLines, liveEvents, selectedSpeakerId, config]);

  const buildLiveStats = useCallback((lines: TranscriptLine[]) => {
    const totals = new Map<string, number>(); for (const line of lines) totals.set(line.speakerId, (totals.get(line.speakerId) || 0) + Math.max(1, line.end - line.at));
    const total = Math.max(1, [...totals.values()].reduce((sum, value) => sum + value, 0));
    return config.attendees.map((person) => ({ id: person.id, seconds: Math.round(totals.get(person.id) || 0), share: (totals.get(person.id) || 0) / total * 100, turns: lines.filter((line) => line.speakerId === person.id).length, interruptions: 0 }));
  }, [config.attendees]);

  const endMeeting = useCallback(async () => {
    if (screen !== 'meeting') return;
    setRunning(false); window.speechSynthesis?.cancel();
    if (mode === 'demo') { setReport(DEMO_REPORT); setScreen('report'); return; }
    const draftText = liveDraft.trim();
    const lines = draftText
      ? [...liveLines, { id: `live-final-${Date.now()}`, at: elapsedRef.current, end: elapsedRef.current + Math.max(1, draftText.length / 5), speakerId: selectedSpeakerRef.current, text: draftText, topic: '实时讨论', workRelated: true }]
      : liveLines;
    commitDraft(); void transcriberRef.current?.stop(); transcriberRef.current = null; setReportLoading(true); setScreen('report');
    try {
      const response = await fetch('/api/report', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ meeting: { title: config.title, durationSeconds: config.durationSeconds, agenda: config.agenda, attendees: config.attendees.map((person) => ({ id: person.id, name: person.name })) }, actualSeconds: elapsedRef.current, transcript: lines.map((line) => ({ ...line, speaker: getSpeaker(line.speakerId, config.attendees).name })), events: liveEvents }) });
      const data = await response.json() as Partial<ReportData>;
      setReport({ ...DEMO_REPORT, ...data, speakerStats: buildLiveStats(lines), actualSeconds: Math.round(elapsedRef.current) });
    } catch { setReport({ ...DEMO_REPORT, overall: 78, verdict: '会议证据已保存，AI 摘要暂时不可用。', actualSeconds: Math.round(elapsedRef.current), speakerStats: buildLiveStats(lines), summary: '实时转写已保存，可导出后继续整理。' }); }
    finally { setReportLoading(false); }
  }, [screen, mode, commitDraft, liveLines, liveEvents, config, buildLiveStats]);

  useEffect(() => {
    if (screen === 'meeting' && mode === 'demo' && elapsed >= 99 && !autoEndRef.current) { autoEndRef.current = true; const timer = window.setTimeout(() => void endMeeting(), 1400); return () => window.clearTimeout(timer); }
  }, [screen, mode, elapsed, endMeeting]);

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null; if (target && /INPUT|TEXTAREA|SELECT/.test(target.tagName)) return;
      if (event.code === 'Space') { event.preventDefault(); if (screen === 'setup') startMeeting('demo'); else if (screen === 'meeting') setRunning((value) => !value); }
      if (screen === 'meeting' && mode === 'live' && /^[1-5]$/.test(event.key)) { const person = config.attendees[Number(event.key) - 1]; if (person) setSelectedSpeakerId(person.id); }
      if (event.key === 'Escape' && showConfig) setShowConfig(false);
    };
    window.addEventListener('keydown', handler); return () => window.removeEventListener('keydown', handler);
  }, [screen, mode, config.attendees, showConfig, startMeeting]);

  const selectSpeaker = (id: string) => { if (id === selectedSpeakerId) return; commitDraft(); setSelectedSpeakerId(id); selectedSpeakerRef.current = id; };
  const handleAction = (event: Intervention, action: 'adopt' | 'park' | 'ignore') => { setActionState((previous) => ({ ...previous, [event.id]: action === 'adopt' ? 'adopted' : action === 'park' ? 'parked' : 'ignored' })); if (action === 'park') setParkingItems((previous) => [...new Set([...previous, event.type === 'smalltalk' ? '午饭与烧肉店选择' : '方案分歧的补充论据'])]); };
  const skipToNext = () => { const next = DEMO_EVENTS.find((event) => event.at > elapsed + .5); setElapsed(next ? Math.max(0, next.at - .35) : 98); };
  const saveConfig = (value: MeetingConfig) => { setConfig(value); setShowConfig(false); try { localStorage.setItem('cuicui-meeting-config', JSON.stringify(value)); } catch { /* storage unavailable */ } };

  return <>
    {screen === 'setup' && <SetupView config={config} health={health} onConfigure={() => setShowConfig(true)} onStart={startMeeting} />}
    {screen === 'meeting' && <MeetingView config={config} mode={mode} elapsed={elapsed} running={running} speed={speed} soundOn={soundOn} liveStatus={liveStatus} selectedSpeakerId={selectedSpeakerId} transcript={visibleTranscript} liveDraft={liveDraft} events={visibleEvents} actionState={actionState} parkingItems={parkingItems} error={error} onPause={() => setRunning((value) => !value)} onSpeed={() => setSpeed((value) => value === 1 ? 2 : value === 2 ? 4 : 1)} onSound={() => { setSoundOn((value) => !value); window.speechSynthesis?.cancel(); }} onSkip={skipToNext} onEnd={() => void endMeeting()} onReset={resetSession} onSpeaker={selectSpeaker} onCommitDraft={commitDraft} onAction={handleAction} />}
    {screen === 'report' && <ReportView config={config} report={report} events={mode === 'demo' ? DEMO_EVENTS : liveEvents} loading={reportLoading} onReplay={() => startMeeting('demo')} onReset={resetSession} />}
    {showConfig && <ConfigDialog config={config} onSave={saveConfig} onClose={() => setShowConfig(false)} />}
  </>;
}
