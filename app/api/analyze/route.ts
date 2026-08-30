import { accessErrorResponse, authorizeDemo } from '../../server/demo-access';
import { routeInterventions, type InterventionCandidate, type PreviousIntervention } from '../../intervention-routing';
import type { EventType, Severity } from '../../demo-data';

type TranscriptInput = {
  id?: string;
  speakerId?: string;
  speaker?: string;
  text?: string;
  at?: number;
  end?: number;
  workRelated?: boolean;
  interrupted?: boolean;
};

type AnalyzeInput = {
  meeting?: { title?: string; type?: string; durationSeconds?: number; agenda?: string[] };
  elapsedSeconds?: number;
  transcript?: TranscriptInput[];
  previousEvents?: PreviousIntervention[];
  previousEventTypes?: string[];
};

const eventTypes = ['agenda_progress', 'topic_shift', 'action_item', 'off_topic', 'smalltalk', 'interrupt', 'repeat', 'disagreement', 'time', 'decision'] as const;

function explicitDecision(text: string) {
  if (/(?:请|需要|等待|尚未|还没|未).{0,12}(?:拍板|决定|确认)|负责人是谁|谁负责|是否|待确认|决定一下/.test(text)) return false;
  if (/(?:今天|本次|这次|我们).{0,8}(?:确认|确定).{0,30}(?:先听|讨论|征求|听取|过一遍)/.test(text)) return false;
  return /(?:拍板[:：]|(?:最终|已经|已)(?:决定|确认|确定)|(?:我们|团队)?决定(?:采用|按|为|先)|就按|确定为|行[，,。 ]*(?:就|那就|按))/.test(text);
}

function evidenceLabel(line: TranscriptInput) {
  return `${line.speaker || line.speakerId || '未知'}：${String(line.text || '').slice(0, 90)}`;
}

function localCandidates(input: AnalyzeInput, transcript: TranscriptInput[]): InterventionCandidate[] {
  const latest = transcript.at(-1);
  if (!latest?.text?.trim()) return [];
  const previous = transcript.at(-2);
  const text = latest.text.trim();
  const elapsed = Math.max(0, Number(input.elapsedSeconds || latest.end || latest.at || 0));
  const duration = Math.max(1, Number(input.meeting?.durationSeconds || 1800));
  const allText = transcript.map((line) => String(line.text || '')).join('');
  const candidates: InterventionCandidate[] = [];

  if (transcript.length === 3 || /(?:路径做短|信息收集完成|先定.+再定)/.test(text)) {
    candidates.push({
      at: Number(latest.end || elapsed), type: 'agenda_progress', severity: 'success', incidentKey: 'agenda-progress:opening',
      label: '议题信息已收齐', observation: '上线规则与用户路径已经形成清晰选项。', impact: '讨论可以进入风险与发布条件。',
      suggestion: '继续确认灰度、回滚与负责人。', evidence: evidenceLabel(latest), confidence: .94,
    });
  }

  const isReturningToAgenda = /(?:会后再?聊|回到|继续|先不聊|拉回)/.test(text);
  const isSmalltalk = latest.workRelated === false || (!isReturningToAgenda && /(团建|烤肉|订位|吃饭|餐厅|电影|周末|聚餐)/.test(text));
  if (isSmalltalk) {
    candidates.push({
      at: Number(latest.end || elapsed), type: 'smalltalk', severity: 'warning', incidentKey: 'smalltalk:current-agenda',
      label: '闲聊偏题', observation: '讨论连续转向与当前上线评审无关的生活话题。', impact: '发布条件的决策时间正在被压缩。',
      suggestion: '建议会后再聊，先确认上线条件。', evidence: evidenceLabel(latest), confidence: .98,
    });
  }

  const ratio = elapsed / duration;
  const unresolved = /(不用|必须|至少|风险|回滚|暂停|不能|不同意|技术问题)/.test(allText.slice(-900));
  if (ratio >= .63 && !explicitDecision(allText.slice(-700)) && unresolved) {
    const estimatedOverrun = Math.max(10, Math.round(duration * .17));
    candidates.push({
      at: elapsed, type: 'time', severity: elapsed >= duration ? 'critical' : 'warning', incidentKey: 'time:meeting',
      label: '预计超时', observation: '发布条件仍未收敛，计划时间已经接近尾段。', impact: `按当前节奏预计超时约 ${estimatedOverrun} 秒。`,
      suggestion: '请冻结新增观点，只确认不影响上线承诺的兜底条件。', evidence: `时间进度 ${Math.round(elapsed)} / ${Math.round(duration)} 秒 · 最近转写仍有未决条件`, confidence: .96,
    });
  }

  const overlapsPrevious = Boolean(previous && latest.speaker !== previous.speaker
    && Number.isFinite(Number(latest.at)) && Number.isFinite(Number(previous.end))
    && Number(latest.at) < Number(previous.end) - .15);
  if (overlapsPrevious || previous?.interrupted) {
    candidates.push({
      at: Number(latest.end || elapsed), type: 'interrupt', severity: 'warning', incidentKey: `interrupt:${latest.speakerId || latest.speaker || 'speaker'}`,
      label: '连续打断', observation: `${latest.speaker || '当前发言者'}在上一位成员尚未说完时开始发言。`, impact: '关键风险与回滚条件可能无法被完整表达。',
      suggestion: '请让当前发言者完成表述后再补充。', evidence: `${evidenceLabel(previous || {})} ↔ ${evidenceLabel(latest)}`, confidence: .99,
    });
  }

  if (explicitDecision(text)) {
    candidates.push({
      at: Number(latest.end || elapsed), type: 'decision', severity: 'success', incidentKey: 'decision:release-plan',
      label: '形成决策', observation: '发布节奏、异常阈值与暂停条件已经明确。', impact: '团队可以进入执行与验收。',
      suggestion: '继续补齐负责人和时间点。', evidence: evidenceLabel(latest), confidence: .97,
    });
  } else if (/负责(?!人)/.test(text) && !/(谁负责|负责人是谁|待确认)/.test(text)) {
    candidates.push({
      at: Number(latest.end || elapsed), type: 'action_item', severity: 'success', incidentKey: 'action-item:release-plan',
      label: '行动项已明确', observation: '执行任务已经对应到具体成员和时间点。', impact: '会后可以直接按分工推进。',
      suggestion: '按约定时间回传结果。', evidence: evidenceLabel(latest), confidence: .96,
    });
  }

  return candidates.slice(0, 3);
}

function parseContent(content: unknown) {
  if (typeof content !== 'string') throw new Error('模型未返回文本结果');
  return JSON.parse(content.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')) as Record<string, unknown>;
}

function normalizeModelEvents(value: unknown): InterventionCandidate[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 2).map((item) => {
    const event = item && typeof item === 'object' ? item as Record<string, unknown> : {};
    const suppliedType = String(event.type || 'off_topic') as EventType;
    const type = eventTypes.includes(suppliedType as typeof eventTypes[number]) ? suppliedType : 'off_topic';
    const suppliedSeverity = String(event.severity || 'warning') as Severity;
    const severity = ['info', 'warning', 'critical', 'success'].includes(suppliedSeverity) ? suppliedSeverity : 'warning';
    return {
      type, severity, incidentKey: String(event.incidentKey || type).slice(0, 100),
      label: String(event.label || '需要关注').slice(0, 60),
      observation: String(event.observation || '检测到需要主持人关注的讨论信号。').slice(0, 260),
      impact: String(event.impact || '可能压缩核心议题的决策时间。').slice(0, 240),
      suggestion: String(event.suggestion || '请主持人确认当前议题并推动形成下一步。').slice(0, 240),
      evidence: String(event.evidence || '最近转写中出现了可定位的讨论信号。').slice(0, 240),
      confidence: Math.max(0, Math.min(1, Number(event.confidence) || .72)),
    };
  }).filter((event) => (event.confidence || 0) >= .82);
}

function previousEvents(input: AnalyzeInput): PreviousIntervention[] {
  if (Array.isArray(input.previousEvents)) return input.previousEvents.slice(-30);
  return (input.previousEventTypes || []).slice(-30).map((type, index) => ({
    id: `legacy-${index}`, at: 0, type: (eventTypes.includes(type as typeof eventTypes[number]) ? type : 'off_topic') as EventType,
    level: 'L1', priority: 100,
  }));
}

function responseShape(input: AnalyzeInput, candidates: InterventionCandidate[], source: string, extra: Record<string, unknown> = {}) {
  const elapsed = Math.max(0, Number(input.elapsedSeconds || 0));
  const duration = Math.max(1, Number(input.meeting?.durationSeconds || 1800));
  return {
    topic: input.meeting?.agenda?.[0] || input.meeting?.title || '当前议题',
    focusScore: candidates.some((event) => event.type === 'smalltalk' || event.type === 'off_topic') ? 45 : 84,
    progress: Math.min(100, Math.round(elapsed / duration * 100)),
    events: routeInterventions(candidates, previousEvents(input), elapsed),
    source,
    ...extra,
  };
}

export async function POST(request: Request) {
  try { authorizeDemo(request, 'analyze'); } catch (error) { return accessErrorResponse(error) || Response.json({ error: '分析服务暂不可用' }, { status: 500 }); }
  let input: AnalyzeInput;
  try { input = await request.json() as AnalyzeInput; } catch { return Response.json({ error: '请求格式无效' }, { status: 400 }); }
  const transcript = Array.isArray(input.transcript) ? input.transcript.slice(-32) : [];
  if (!transcript.some((line) => String(line.text || '').trim())) return Response.json(responseShape(input, [], 'empty-snapshot'));

  const deterministic = localCandidates(input, transcript);
  const apiKey = process.env.OPENROUTER_API_KEY;
  const model = process.env.OPENROUTER_ANALYSIS_MODEL || 'qwen/qwen3.5-flash-02-23';
  if (!apiKey) return Response.json(responseShape(input, deterministic, 'local-fallback'));

  const elapsed = Math.max(0, Number(input.elapsedSeconds || 0));
  const duration = Math.max(1, Number(input.meeting?.durationSeconds || 1800));
  const transcriptText = transcript.map((line) => `[${Math.max(0, Number(line.at || 0)).toFixed(1)}-${Math.max(0, Number(line.end || line.at || 0)).toFixed(1)}s] ${line.speaker || line.speakerId || '未知'}：${String(line.text || '').slice(0, 600)}`).join('\n').slice(-9000);
  const systemPrompt = `你是克制的会中事件检测器。只检测，不决定提醒层级；层级由服务端规则路由。
严格规则：生活闲聊连续出现才算 smalltalk；工作内容偏离当前议题才算 off_topic；同一观点至少三次且没有新增事实才算 repeat；至少两轮相反立场才算 disagreement；interrupt 必须有时间重叠或 interrupted 标记；time 必须有进度与未决议题证据。正常论证不提醒。身份和职级不影响判断。每个结论必须引用最近转写原话，不得写“AI判断”。最多返回两个候选，没有充分证据返回空数组。最终输出必须符合 JSON schema。`;
  const userPrompt = `会议：${String(input.meeting?.title || '未命名会议')}\n议题：${(input.meeting?.agenda || []).join('；') || '未设置'}\n进度：${elapsed.toFixed(0)} / ${duration.toFixed(0)} 秒\n历史事件：${previousEvents(input).map((event) => `${event.type}-${event.level}`).join('、') || '无'}\n\n最近转写：\n${transcriptText}`;

  try {
    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', 'HTTP-Referer': process.env.PUBLIC_SITE_URL || 'http://localhost:3000', 'X-Title': 'Cuicui Meeting Assistant' },
      body: JSON.stringify({
        model, messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: userPrompt }], temperature: .1, max_tokens: 650,
        reasoning: { enabled: false }, include_reasoning: false, provider: { require_parameters: true },
        response_format: { type: 'json_schema', json_schema: { name: 'meeting_incidents', strict: true, schema: {
          type: 'object', additionalProperties: false,
          properties: { events: { type: 'array', maxItems: 2, items: { type: 'object', additionalProperties: false, properties: {
            type: { type: 'string', enum: eventTypes }, severity: { type: 'string', enum: ['info', 'warning', 'critical', 'success'] }, incidentKey: { type: 'string' },
            label: { type: 'string' }, observation: { type: 'string' }, impact: { type: 'string' }, suggestion: { type: 'string' }, evidence: { type: 'string' }, confidence: { type: 'number', minimum: 0, maximum: 1 },
          }, required: ['type', 'severity', 'incidentKey', 'label', 'observation', 'impact', 'suggestion', 'evidence', 'confidence'] } } }, required: ['events'],
        } } },
      }),
      signal: AbortSignal.timeout(18000),
    });
    if (!response.ok) throw new Error(`OpenRouter ${response.status}`);
    const result = await response.json() as { choices?: Array<{ message?: { content?: string } }>; usage?: unknown };
    const parsed = parseContent(result.choices?.[0]?.message?.content);
    const candidates = deterministic.length ? deterministic : normalizeModelEvents(parsed.events);
    return Response.json(responseShape(input, candidates, 'openrouter', { model, usage: result.usage || null }));
  } catch (error) {
    return Response.json(responseShape(input, deterministic, 'local-fallback', { degraded: true, reason: error instanceof Error ? error.message : '分析服务暂不可用' }));
  }
}
