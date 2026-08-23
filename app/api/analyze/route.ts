import { accessErrorResponse, authorizeDemo } from '../../server/demo-access';

type TranscriptInput = { speaker?: string; text?: string; at?: number };

type AnalyzeInput = {
  meeting?: { title?: string; type?: string; durationSeconds?: number; agenda?: string[] };
  elapsedSeconds?: number;
  transcript?: TranscriptInput[];
  previousEventTypes?: string[];
};

const eventTypes = ['off_topic', 'smalltalk', 'interrupt', 'repeat', 'disagreement', 'time', 'decision'] as const;

function fallbackAnalysis(input: AnalyzeInput) {
  const transcript = Array.isArray(input.transcript) ? input.transcript : [];
  const recent = transcript.slice(-8).map((item) => `${item.speaker || '未知'}：${item.text || ''}`).join('\n');
  const normalized = recent.toLowerCase();
  const elapsed = Number(input.elapsedSeconds || 0);
  const duration = Math.max(1, Number(input.meeting?.durationSeconds || 1800));
  const previous = new Set(input.previousEventTypes || []);
  let event: Record<string, unknown> | null = null;

  if (!previous.has('smalltalk') && /(吃饭|烧肉|甜品|周末|电影|游戏|午饭|聚餐)/.test(normalized)) {
    event = {
      type: 'smalltalk', severity: 'warning', label: '△ 催一下 · 闲聊偏题',
      observation: '最近讨论出现与会议目标无关的生活闲聊。', impact: '核心议题推进被暂停。',
      suggestion: '把闲聊放入会后停车场，回到当前议题。', evidence: '本地规则兜底 · 闲聊关键词命中', confidence: 0.76,
    };
  } else if (!previous.has('disagreement') && /(不同意|反对|不认可|风险|但是|不行)/.test(normalized) && /(必须|应该|建议|方案)/.test(normalized)) {
    event = {
      type: 'disagreement', severity: elapsed / duration > 0.72 ? 'critical' : 'warning', label: '△ 催一下 · 观点分歧',
      observation: '同一方案出现明显的支持与反对立场。', impact: '继续增加论据可能导致会议超时。',
      suggestion: '请记录双方条件，由主持人明确决策标准。', evidence: '本地规则兜底 · 相反立场词命中', confidence: 0.68,
    };
  } else if (!previous.has('time') && elapsed / duration >= 0.75) {
    event = {
      type: 'time', severity: elapsed >= duration ? 'critical' : 'info', label: '○ 提个醒 · 时间进度',
      observation: `会议已进行 ${Math.round(elapsed)} 秒。`, impact: `剩余约 ${Math.max(0, Math.round(duration - elapsed))} 秒。`,
      suggestion: '请主持人确认未决议题并开始收尾。', evidence: `本地规则兜底 · 时间进度 ${Math.round(elapsed / duration * 100)}%`, confidence: 1,
    };
  }

  return {
    topic: input.meeting?.agenda?.[0] || input.meeting?.title || '当前议题',
    focusScore: event?.type === 'smalltalk' ? 28 : 82,
    progress: Math.min(100, Math.round(elapsed / duration * 100)),
    events: event ? [event] : [],
    source: 'local-fallback',
  };
}

function parseContent(content: unknown) {
  if (typeof content !== 'string') throw new Error('模型未返回文本结果');
  const cleaned = content.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  return JSON.parse(cleaned) as Record<string, unknown>;
}

function normalizeEvents(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 2).map((item) => {
    const event = item && typeof item === 'object' ? item as Record<string, unknown> : {};
    const evidenceText = `${event.topic || ''} ${event.observation || ''} ${event.reason || ''} ${event.reasoning || ''}`;
    const suppliedType = String(event.type || '');
    const type = eventTypes.includes(suppliedType as typeof eventTypes[number]) ? suppliedType
      : /咖啡|闲聊|偏离|发散/.test(evidenceText) ? 'smalltalk'
        : /分歧|僵持|争执|反对|不同意/.test(evidenceText) ? 'disagreement'
          : /超时|剩余|时间/.test(evidenceText) ? 'time' : 'off_topic';
    const suppliedSeverity = String(event.severity || 'warning');
    const severity = ['info', 'warning', 'critical', 'success'].includes(suppliedSeverity) ? suppliedSeverity : event.critical ? 'critical' : 'warning';
    const observation = String(event.observation || event.reason || event.reasoning || '检测到需要主持人关注的讨论信号。').slice(0, 260);
    return {
      type,
      severity,
      label: String(event.label || `△ 催一下 · ${type === 'smalltalk' ? '闲聊偏题' : type === 'disagreement' ? '观点分歧' : type === 'time' ? '时间风险' : '议题偏离'}`).slice(0, 60),
      observation,
      impact: String(event.impact || '可能压缩核心议题的决策时间。').slice(0, 240),
      suggestion: String(event.suggestion || '请主持人确认当前议题并推动形成下一步。').slice(0, 240),
      evidence: String(event.evidence || `AI 根据最近转写判断 · ${String(event.topic || '当前讨论').slice(0, 80)}`).slice(0, 240),
      confidence: Math.max(0, Math.min(1, Number(event.confidence) || .72)),
    };
  });
}

export async function POST(request: Request) {
  try { authorizeDemo(request, 'analyze'); } catch (error) { return accessErrorResponse(error) || Response.json({ error: '分析服务暂不可用' }, { status: 500 }); }
  let input: AnalyzeInput;
  try {
    input = await request.json() as AnalyzeInput;
  } catch {
    return Response.json({ error: '请求格式无效' }, { status: 400 });
  }

  const transcript = Array.isArray(input.transcript) ? input.transcript.slice(-24) : [];
  if (!transcript.some((item) => typeof item.text === 'string' && item.text.trim())) {
    return Response.json({ ...fallbackAnalysis(input), source: 'empty-snapshot' });
  }

  const apiKey = process.env.OPENROUTER_API_KEY;
  const model = process.env.OPENROUTER_ANALYSIS_MODEL || 'qwen/qwen3.5-flash-02-23';
  if (!apiKey) return Response.json(fallbackAnalysis(input));

  const title = String(input.meeting?.title || '未命名会议').slice(0, 240);
  const agenda = (input.meeting?.agenda || []).slice(0, 8).map((item) => String(item).slice(0, 160));
  const elapsed = Math.max(0, Number(input.elapsedSeconds || 0));
  const duration = Math.max(1, Number(input.meeting?.durationSeconds || 1800));
  const transcriptText = transcript
    .map((item) => `[${Math.max(0, Number(item.at || 0)).toFixed(0)}s] ${String(item.speaker || '未知').slice(0, 30)}：${String(item.text || '').slice(0, 700)}`)
    .join('\n')
    .slice(-8000);

  const systemPrompt = `你是“催催”，一个克制但有行动力的会中干预 Agent。你的任务不是会后总结，而是判断此刻是否需要介入。
规则：
1. 只基于给定转写证据，不猜测人格或身份。
2. 正常的论证与短暂发散不要提醒；只有偏离持续、观点重复、分歧僵持或时间风险确实出现时才介入。
3. 同类事件若已出现在 previousEventTypes 中，除非严重程度明显升级，否则不要重复。
4. 提醒必须写成“观察—影响—建议”，事实具体、语气坚定、不羞辱个人。
5. critical 仅用于已超时，或剩余时间不超过 25% 且重要分歧仍未收敛。
6. 最多返回 2 个事件；没有充分证据时 events 返回空数组。
7. 输出简体中文，topic 控制在 12 字以内。最终输出必须是符合给定 schema 的 JSON。`;

  const userPrompt = `会议主题：${title}
会议类型：${String(input.meeting?.type || '讨论会')}
议题：${agenda.join('；') || '未设置'}
进度：${elapsed.toFixed(0)} / ${duration.toFixed(0)} 秒（${Math.round(elapsed / duration * 100)}%）
已提醒类型：${(input.previousEventTypes || []).join('、') || '无'}

最近转写：
${transcriptText}`;

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
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        temperature: 0.15,
        max_tokens: 650,
        reasoning: { enabled: false },
        include_reasoning: false,
        provider: { require_parameters: true },
        response_format: {
          type: 'json_schema',
          json_schema: {
            name: 'meeting_intervention',
            strict: true,
            schema: {
              type: 'object', additionalProperties: false,
              properties: {
                topic: { type: 'string' },
                focusScore: { type: 'integer', minimum: 0, maximum: 100 },
                progress: { type: 'integer', minimum: 0, maximum: 100 },
                events: {
                  type: 'array', maxItems: 2,
                  items: {
                    type: 'object', additionalProperties: false,
                    properties: {
                      type: { type: 'string', enum: eventTypes },
                      severity: { type: 'string', enum: ['info', 'warning', 'critical', 'success'] },
                      label: { type: 'string' }, observation: { type: 'string' }, impact: { type: 'string' },
                      suggestion: { type: 'string' }, evidence: { type: 'string' },
                      confidence: { type: 'number', minimum: 0, maximum: 1 },
                    },
                    required: ['type', 'severity', 'label', 'observation', 'impact', 'suggestion', 'evidence', 'confidence'],
                  },
                },
              },
              required: ['topic', 'focusScore', 'progress', 'events'],
            },
          },
        },
      }),
      signal: AbortSignal.timeout(18000),
    });

    if (!response.ok) {
      const failure = await response.json().catch(() => ({})) as { error?: { message?: string; metadata?: { raw?: string } } };
      throw new Error(`OpenRouter ${response.status}: ${failure.error?.metadata?.raw || failure.error?.message || '请求失败'}`);
    }
    const result = await response.json() as {
      choices?: Array<{ message?: { content?: string } }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number; cost?: number };
    };
    const parsed = parseContent(result.choices?.[0]?.message?.content);
    return Response.json({ ...parsed, events: normalizeEvents(parsed.events), source: 'openrouter', model, usage: result.usage || null });
  } catch (error) {
    const fallback = fallbackAnalysis(input);
    return Response.json({ ...fallback, degraded: true, reason: error instanceof Error ? error.message : 'AI 服务暂时不可用' });
  }
}
