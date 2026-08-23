import { accessErrorResponse, authorizeDemo } from '../../server/demo-access';

type ReportLine = {
  speakerId?: string;
  speaker?: string;
  text?: string;
  at?: number;
  end?: number;
  workRelated?: boolean;
};

type ReportEvent = { type?: string; severity?: string; observation?: string; suggestion?: string };

type ReportInput = {
  meeting?: { title?: string; durationSeconds?: number; agenda?: string[]; attendees?: Array<{ id?: string; name?: string }> };
  actualSeconds?: number;
  transcript?: ReportLine[];
  events?: ReportEvent[];
};

function clamp(value: number) {
  return Math.max(0, Math.min(100, Math.round(value)));
}

function calculateBalance(values: number[]) {
  if (values.length <= 1) return 100;
  const total = values.reduce((sum, value) => sum + value, 0);
  if (!total) return 0;
  let differences = 0;
  for (const left of values) for (const right of values) differences += Math.abs(left - right);
  const gini = differences / (2 * values.length * total);
  const maxGini = (values.length - 1) / values.length;
  return clamp(100 * (1 - gini / maxGini));
}

function parseContent(content: unknown) {
  if (typeof content !== 'string') throw new Error('模型未返回文本结果');
  return JSON.parse(content.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')) as Record<string, unknown>;
}

function textValue(value: unknown, fallback = '') {
  if (typeof value === 'string' || typeof value === 'number') return String(value).trim();
  if (value && typeof value === 'object') {
    const item = value as Record<string, unknown>;
    const main = item.description || item.text || item.task || item.title || item.label || item.summary;
    const rationale = item.rationale || item.reason;
    return [main, rationale].filter((part) => typeof part === 'string' && part.trim()).join('：').slice(0, 500);
  }
  return fallback;
}

function stringList(value: unknown, limit: number) {
  return (Array.isArray(value) ? value : []).map((item) => textValue(item)).filter(Boolean).slice(0, limit);
}

function normalizeNarrative(value: Record<string, unknown>, fallback: ReturnType<typeof fallbackNarrative>) {
  const actions = (Array.isArray(value.actions) ? value.actions : []).map((item) => {
    const action = item && typeof item === 'object' ? item as Record<string, unknown> : {};
    return { owner: textValue(action.owner, '待认领').slice(0, 40), task: textValue(action.task || action.description, '跟进会议结论').slice(0, 220), due: textValue(action.due, '待确认').slice(0, 60) };
  }).filter((item) => item.task).slice(0, 8);
  return {
    summary: textValue(value.summary, fallback.summary),
    verdict: textValue(value.verdict, fallback.verdict),
    necessity: textValue(value.necessity, fallback.necessity) === '有必要开' ? '有必要开' : '可考虑异步',
    necessityReason: textValue(value.necessityReason, fallback.necessityReason),
    decisions: stringList(value.decisions, 6).length ? stringList(value.decisions, 6) : fallback.decisions,
    actions: actions.length ? actions : fallback.actions,
    suggestions: stringList(value.suggestions, 5).length ? stringList(value.suggestions, 5) : fallback.suggestions,
    attendanceAdvice: textValue(value.attendanceAdvice, fallback.attendanceAdvice),
  };
}

function fallbackNarrative(input: ReportInput) {
  const attendees = input.meeting?.attendees || [];
  const transcript = input.transcript || [];
  const spoken = new Set(transcript.map((line) => line.speakerId).filter(Boolean));
  const silent = attendees.find((person) => person.id && !spoken.has(person.id));
  const decisionLines = transcript.filter((line) => /(拍板|决定|决策|确认|就按|起步|自动升|自动回滚)/.test(String(line.text || '')));
  const extractedActions: Array<{ owner: string; task: string; due: string }> = [];
  for (const line of transcript) {
    const text = String(line.text || '');
    const due = text.match(/(周[一二三四五六日天](?:上午|下午|晚上)?\s*\d{1,2}(?::\d{1,2})?|明天|今天)/)?.[1] || '按会议约定';
    for (const attendee of attendees) {
      const name = String(attendee.name || '').trim();
      const nameAt = name ? text.indexOf(name) : -1;
      const dutyAt = nameAt >= 0 ? text.indexOf('负责', nameAt + name.length) : -1;
      if (dutyAt < 0 || dutyAt - nameAt > 8) continue;
      const nextPersonAt = attendees.map((other) => String(other.name || '')).filter((other) => other && other !== name).map((other) => text.indexOf(other, dutyAt + 2)).filter((index) => index > dutyAt).sort((a, b) => a - b)[0] ?? text.length;
      const timeAt = text.search(/周[一二三四五六日天]|明天|今天/);
      const end = timeAt > dutyAt ? Math.min(nextPersonAt, timeAt) : nextPersonAt;
      const task = text.slice(dutyAt + 2, end).replace(/^[，,：:\s]+|[。；;\s]+$/g, '').trim();
      if (task) extractedActions.push({ owner: name, task, due });
    }
  }
  const hasDecision = decisionLines.length > 0 || input.events?.some((event) => event.type === 'decision');
  return {
    summary: `围绕“${input.meeting?.title || '会议主题'}”完成了一轮讨论。系统已保留关键转写与干预证据，可据此继续确认决策和待办。`,
    verdict: hasDecision ? '这场会形成了明确决策，值得召开。' : '这场会完成了讨论，但决策还需要进一步明确。',
    necessity: hasDecision ? '有必要开' : '可考虑异步',
    necessityReason: hasDecision ? '讨论产生了明确决策或行动安排。' : '当前转写中尚未识别到清晰决策。',
    decisions: decisionLines.slice(-3).map((line) => String(line.text || '').trim()).filter(Boolean),
    actions: extractedActions.slice(0, 8),
    suggestions: (input.events || []).slice(0, 3).map((event) => event.suggestion || '').filter(Boolean),
    attendanceAdvice: silent ? `${silent.name || '一位参会者'}未产生发言记录，下次可考虑异步接收纪要。` : '本次所有参会者均有发言记录。',
  };
}

export async function POST(request: Request) {
  try { authorizeDemo(request, 'report'); } catch (error) { return accessErrorResponse(error) || Response.json({ error: '报告服务暂不可用' }, { status: 500 }); }
  let input: ReportInput;
  try { input = await request.json() as ReportInput; } catch { return Response.json({ error: '请求格式无效' }, { status: 400 }); }
  const transcript = (Array.isArray(input.transcript) ? input.transcript : []).slice(-160);
  const events = (Array.isArray(input.events) ? input.events : []).slice(-40);
  const planned = Math.max(1, Number(input.meeting?.durationSeconds || 1800));
  const actual = Math.max(1, Number(input.actualSeconds || transcript.at(-1)?.end || transcript.at(-1)?.at || 1));
  const attendees = input.meeting?.attendees || [];

  const speakerTime = new Map<string, number>();
  for (const line of transcript) {
    const key = line.speakerId || line.speaker || 'unknown';
    const seconds = Math.max(1, Number(line.end || 0) - Number(line.at || 0) || Math.ceil(String(line.text || '').length / 5));
    speakerTime.set(key, (speakerTime.get(key) || 0) + seconds);
  }
  const speakerIds = attendees.length ? attendees.map((person) => person.id || person.name || 'unknown') : [...speakerTime.keys()];
  const values = speakerIds.map((id) => speakerTime.get(id) || 0);
  const offTopicSeconds = transcript.filter((line) => line.workRelated === false).reduce((sum, line) => sum + Math.max(1, Number(line.end || 0) - Number(line.at || 0)), 0)
    || events.filter((event) => event.type === 'smalltalk' || event.type === 'off_topic').length * 8;
  const focus = clamp(100 * (1 - offTopicSeconds / actual));
  const punctuality = clamp(100 * Math.min(1, planned / actual));
  const balance = calculateBalance(values);
  const agendaCount = Math.max(1, input.meeting?.agenda?.length || 1);
  const hasDecision = events.some((event) => event.type === 'decision') || transcript.some((line) => /(决定|决策|就按|确认|行动项|负责)/.test(String(line.text || '')));
  const coverage = clamp(hasDecision ? 100 : 100 / agendaCount);
  const overall = clamp(.3 * punctuality + .3 * focus + .2 * balance + .2 * coverage);
  const totalSpeakerTime = Math.max(1, values.reduce((sum, value) => sum + value, 0));
  const speakerStats = speakerIds.map((id) => ({
    id,
    seconds: Math.round(speakerTime.get(id) || 0),
    share: (speakerTime.get(id) || 0) / totalSpeakerTime * 100,
    turns: transcript.filter((line) => (line.speakerId || line.speaker || 'unknown') === id).length,
    interruptions: transcript.filter((line) => (line.speakerId || line.speaker || 'unknown') === id && (line as ReportLine & { interrupted?: boolean }).interrupted).length,
  }));
  const metrics = { overall, actualSeconds: actual, speakerStats, scores: [
    { key: 'punctuality', label: '准时率', value: punctuality, detail: actual <= planned ? '在计划时间内结束' : `超出计划 ${Math.round(actual - planned)} 秒` },
    { key: 'focus', label: '话题集中度', value: focus, detail: offTopicSeconds ? `约 ${Math.round(offTopicSeconds)} 秒偏题内容` : '未检测到明确偏题' },
    { key: 'balance', label: '发言均衡度', value: balance, detail: `${speakerIds.filter((id) => (speakerTime.get(id) || 0) > 0).length} 人产生有效发言` },
    { key: 'coverage', label: '议题覆盖率', value: coverage, detail: hasDecision ? '已识别决策或行动项' : '尚未识别明确决策' },
  ] };

  const apiKey = process.env.OPENROUTER_API_KEY;
  const model = process.env.OPENROUTER_REPORT_MODEL || 'qwen/qwen3.5-flash-02-23';
  if (!apiKey || transcript.length === 0) return Response.json({ ...metrics, ...fallbackNarrative(input), source: 'local-fallback' });

  const transcriptText = transcript.map((line) => `${line.speaker || line.speakerId || '未知'}：${String(line.text || '').slice(0, 700)}`).join('\n').slice(-14000);
  const eventText = events.map((event) => `${event.type || 'event'}：${event.observation || ''}；建议：${event.suggestion || ''}`).join('\n').slice(-5000);
  const prompt = `请为以下会议生成精炼、可验证的中文会后报告。只基于转写和事件，不补造事实。决策必须是明确达成共识的内容；行动项缺少负责人时 owner 写“待确认”，缺少时间时 due 写“待确认”。attendanceAdvice 语气尊重，不羞辱未发言者。

会议：${String(input.meeting?.title || '未命名会议')}
议题：${(input.meeting?.agenda || []).join('；')}
转写：
${transcriptText}

会中事件：
${eventText || '无'}`;

  try {
    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': process.env.PUBLIC_SITE_URL || 'http://localhost:3000',
        'X-Title': 'Cuicui Meeting Assistant',
      },
      body: JSON.stringify({
        model,
        messages: [{ role: 'system', content: '你是严谨的会议效率分析师，输出结构化中文报告。最终输出必须是符合给定 schema 的 JSON。' }, { role: 'user', content: prompt }],
        temperature: 0.2,
        max_tokens: 850,
        reasoning: { enabled: false },
        include_reasoning: false,
        provider: { require_parameters: true },
        response_format: {
          type: 'json_schema',
          json_schema: {
            name: 'meeting_report', strict: true,
            schema: {
              type: 'object', additionalProperties: false,
              properties: {
                summary: { type: 'string' }, verdict: { type: 'string' },
                necessity: { type: 'string', enum: ['有必要开', '可考虑异步'] }, necessityReason: { type: 'string' },
                decisions: { type: 'array', items: { type: 'string' }, maxItems: 6 },
                actions: { type: 'array', maxItems: 8, items: { type: 'object', additionalProperties: false, properties: { owner: { type: 'string' }, task: { type: 'string' }, due: { type: 'string' } }, required: ['owner', 'task', 'due'] } },
                suggestions: { type: 'array', items: { type: 'string' }, maxItems: 5 }, attendanceAdvice: { type: 'string' },
              },
              required: ['summary', 'verdict', 'necessity', 'necessityReason', 'decisions', 'actions', 'suggestions', 'attendanceAdvice'],
            },
          },
        },
      }),
      signal: AbortSignal.timeout(22000),
    });
    if (!response.ok) {
      const failure = await response.json().catch(() => ({})) as { error?: { message?: string; metadata?: { raw?: string } } };
      throw new Error(`OpenRouter ${response.status}: ${failure.error?.metadata?.raw || failure.error?.message || '请求失败'}`);
    }
    const result = await response.json() as { choices?: Array<{ message?: { content?: string } }>; usage?: unknown };
    const fallback = fallbackNarrative(input);
    return Response.json({ ...metrics, ...normalizeNarrative(parseContent(result.choices?.[0]?.message?.content), fallback), source: 'openrouter', model, usage: result.usage || null });
  } catch (error) {
    return Response.json({ ...metrics, ...fallbackNarrative(input), source: 'local-fallback', degraded: true, reason: error instanceof Error ? error.message : 'AI 报告暂不可用' });
  }
}
