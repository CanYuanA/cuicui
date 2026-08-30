import { accessErrorResponse, authorizeDemo } from '../../server/demo-access';
import { explicitDecision, scoreMeeting, type ScoringInput } from '../../server/report-scoring';

type ReportInput = ScoringInput;

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
  const seen = new Set<string>();
  return (Array.isArray(value) ? value : []).map((item) => textValue(item)).filter((item) => {
    const key = item.replace(/[\s，。；、]/g, '');
    if (!item || seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, limit);
}

function explicitDecisions(value: unknown) {
  return stringList(value, 8).filter(explicitDecision).slice(0, 6);
}

function normalizeNarrative(value: Record<string, unknown>, fallback: ReturnType<typeof fallbackNarrative>) {
  const modelActions = (Array.isArray(value.actions) ? value.actions : []).map((item) => {
    const action = item && typeof item === 'object' ? item as Record<string, unknown> : {};
    return { owner: textValue(action.owner, '待认领').slice(0, 40), task: textValue(action.task || action.description, '跟进会议结论').slice(0, 220), due: textValue(action.due, '待确认').slice(0, 60) };
  }).filter((item) => item.task).slice(0, 8);
  const actions = fallback.actions.length ? fallback.actions : modelActions;
  const decisions = explicitDecisions(value.decisions);
  return {
    summary: textValue(value.summary, fallback.summary),
    verdict: textValue(value.verdict, fallback.verdict),
    necessity: textValue(value.necessity, fallback.necessity) === '有必要开' ? '有必要开' : '可考虑异步',
    necessityReason: textValue(value.necessityReason, fallback.necessityReason),
    decisions: decisions.length ? decisions : fallback.decisions,
    actions: actions.length ? actions : fallback.actions,
    suggestions: stringList(value.suggestions, 5).length ? stringList(value.suggestions, 5) : fallback.suggestions,
    attendanceAdvice: textValue(value.attendanceAdvice, fallback.attendanceAdvice),
  };
}

function alignNarrativeWithEvidence(narrative: ReturnType<typeof normalizeNarrative>, metrics: ReturnType<typeof scoreMeeting>) {
  const strongOutcome = metrics.evidence.evidenceFactor >= .5 && metrics.decisionCount > 0 && metrics.actionCount > 0;
  const noOutcome = metrics.decisionCount === 0 && metrics.actionCount === 0;
  if (strongOutcome) return {
    ...narrative,
    verdict: '这场会形成了明确决策和下一步，值得召开。',
    necessity: '有必要开',
    necessityReason: '讨论同时形成了可核验的决策和行动安排。',
  };
  if (noOutcome) return {
    ...narrative,
    verdict: '讨论有推进，但尚未形成可执行结论。',
    necessity: '可考虑异步',
    necessityReason: '当前转写中没有识别到明确决策或行动安排。',
  };
  return narrative;
}

function fallbackNarrative(input: ReportInput) {
  const attendees = input.meeting?.attendees || [];
  const transcript = input.transcript || [];
  const meaningful = transcript.filter((line) => String(line.text || '').replace(/[\s，。；、！？,.!?;：]/g, '').length >= 5);
  const spoken = new Set(transcript.map((line) => line.speakerId).filter(Boolean));
  const silent = attendees.find((person) => person.id && !spoken.has(person.id));
  const decisionLines = transcript.filter((line) => explicitDecision(String(line.text || '')));
  const extractedActions: Array<{ owner: string; task: string; due: string }> = [];
  const duePattern = /(?:(?:今天|明天|后天|本周|下周|周[一二三四五六日天])(?:上午|下午|晚上)?\s*)?(?:(?:[零一二三四五六七八九十]{1,3}|\d{1,2})点(?:半|(?:[零一二三四五六七八九十]{1,3}|\d{1,2})分)?|\d{1,2}:\d{1,2})/;
  const rememberAction = (owner: string, rawTask: string, due: string) => {
    const task = rawTask.replace(due === '待确认' ? /^$/ : due, '').replace(/^[，,：:\s]*(?:负责)?/, '').replace(/(?:散会|结束会议?|会议结束)$/g, '').replace(/结算业/g, '结算页').replace(/[。；;\s]+$/g, '').trim();
    if (task && !extractedActions.some((item) => item.owner === owner && item.task === task)) extractedActions.push({ owner, task, due });
  };
  for (const line of transcript) {
    const text = String(line.text || '');
    for (const clause of text.split(/[，,。；;]/).map((item) => item.trim()).filter(Boolean)) {
      const selfDuty = clause.match(/(?:^|\s)(?:我|由我)负责(.+)$/);
      if (selfDuty) {
        const owner = String(line.speaker || attendees.find((person) => person.id === line.speakerId)?.name || '待确认').trim();
        const due = clause.match(duePattern)?.[0] || '待确认';
        rememberAction(owner, selfDuty[1], due);
      }
      for (const attendee of attendees) {
        const name = String(attendee.name || '').trim();
        const nameAt = name ? clause.indexOf(name) : -1;
        if (nameAt < 0) continue;
        let tail = clause.slice(nameAt + name.length).trim();
        const nextAttendeeAt = attendees
          .filter((person) => person !== attendee)
          .map((person) => tail.indexOf(String(person.name || '').trim()))
          .filter((index) => index > 0)
          .sort((left, right) => left - right)[0];
        if (nextAttendeeAt !== undefined) tail = tail.slice(0, nextAttendeeAt).trim();
        const due = tail.match(duePattern)?.[0] || '待确认';
        const explicitlyAssigned = /^负责(?!人)/.test(tail);
        if (!explicitlyAssigned && due === '待确认') continue;
        rememberAction(name, tail, due);
      }
    }
  }
  const hasDecision = decisionLines.length > 0 || input.events?.some((event) => event.type === 'decision');
  if (meaningful.length < 2 || meaningful.reduce((sum, line) => sum + String(line.text || '').length, 0) < 30) {
    return {
      summary: '没有足够的有效讨论，暂时无法形成会议结论。',
      verdict: '讨论证据不足，无法评价会议效率。',
      necessity: '可考虑异步',
      necessityReason: '实质发言不足，暂时看不出必须同步开会的理由。',
      decisions: [], actions: [],
      suggestions: ['会前先写明要解决的问题，再邀请必要成员进入讨论。'],
      attendanceAdvice: '当前没有足够证据判断参会结构是否合理。',
    };
  }
  return {
    summary: `围绕“${input.meeting?.title || '会议主题'}”完成了一轮讨论，并整理出当前决策与待办。`,
    verdict: hasDecision ? '这场会形成了明确决策，值得召开。' : '这场会完成了讨论，但决策还需要进一步明确。',
    necessity: hasDecision ? '有必要开' : '可考虑异步',
    necessityReason: hasDecision ? '讨论产生了明确决策或行动安排。' : '当前转写中尚未识别到清晰决策。',
    decisions: explicitDecisions(decisionLines.slice(-3).map((line) => String(line.text || '').trim())),
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
  const metrics = scoreMeeting({ ...input, transcript, events });

  const apiKey = process.env.OPENROUTER_API_KEY;
  const model = process.env.OPENROUTER_REPORT_MODEL || 'qwen/qwen3.5-flash-02-23';
  if (!apiKey || transcript.length === 0) return Response.json({ ...metrics, ...fallbackNarrative(input), source: 'local-fallback' });

  const transcriptText = transcript.map((line) => `${line.speaker || line.speakerId || '未知'}：${String(line.text || '').slice(0, 700)}`).join('\n').slice(-14000);
  const eventText = events.map((event) => `${event.type || 'event'}：${event.observation || ''}；建议：${event.suggestion || ''}`).join('\n').slice(-5000);
  const attendeeText = (input.meeting?.attendees || []).map((person) => String(person.name || '').trim()).filter(Boolean).join('、');
  const prompt = `请为以下会议生成精炼的中文会后报告。你只做证据审计，不直接打分；数值由服务端根据转写计算。只基于转写和事件，不补造事实。
严格规则：有效文本不足 60 字或实质轮次不足 3 次时，不得宣称完成讨论、形成共识或值得召开；未设置明确议题时不得推断隐含议题；“请某人拍板”“需要决定”“还没决定”“尚未确认”“负责人是谁”都不是决策；决策只提取明确确认的具体范围。行动项必须包含明确任务，缺少负责人时 owner 写“待确认”，缺少时间时 due 写“待确认”。没有决策和行动项时 necessity 应为“可考虑异步”。suggestions 不重复，attendanceAdvice 语气尊重，不羞辱未发言者。

会议：${String(input.meeting?.title || '未命名会议')}
议题：${(input.meeting?.agenda || []).join('；')}
参会人：${attendeeText || '未提供'}
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
        messages: [{ role: 'system', content: '你是严谨的会议证据审计器。不得给鼓励性默认结论，不得补造决策、负责人或期限。最终输出必须是符合给定 schema 的 JSON。' }, { role: 'user', content: prompt }],
        temperature: 0.2,
        max_tokens: 1400,
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
    const narrative = alignNarrativeWithEvidence(normalizeNarrative(parseContent(result.choices?.[0]?.message?.content), fallback), metrics);
    return Response.json({ ...metrics, ...narrative, source: 'openrouter', model, usage: result.usage || null });
  } catch (error) {
    return Response.json({ ...metrics, ...fallbackNarrative(input), source: 'local-fallback', degraded: true, reason: error instanceof Error ? error.message : 'AI 报告暂不可用' });
  }
}
