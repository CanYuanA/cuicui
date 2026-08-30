export type ScoringLine = {
  id?: string;
  speakerId?: string;
  speaker?: string;
  text?: string;
  topic?: string;
  at?: number;
  end?: number;
  workRelated?: boolean;
  interrupted?: boolean;
};

export type ScoringEvent = { type?: string; severity?: string; observation?: string; suggestion?: string };

export type ScoringInput = {
  meeting?: { title?: string; durationSeconds?: number; agenda?: string[]; attendees?: Array<{ id?: string; name?: string }> };
  actualSeconds?: number;
  transcript?: ScoringLine[];
  events?: ScoringEvent[];
};

const clamp = (value: number) => Math.max(0, Math.min(100, Math.round(value)));
const clean = (value: unknown) => String(value || '').replace(/[\s，。；、！？,.!?;：:“”‘’（）()《》【】\[\]-]/g, '');

function isMeaningful(text: string) {
  const normalized = clean(text);
  if (normalized.length < 5) return false;
  return !/^(大家好|开始吧|可以开始|好的|好吧|好|嗯|收到|知道了|谢谢|散会|没问题|同意)+$/.test(normalized);
}

function lineSeconds(line: ScoringLine) {
  const measured = Number(line.end || 0) - Number(line.at || 0);
  const estimated = Math.ceil(clean(line.text).length / 5);
  return Math.max(1, Math.min(60, measured > 0 ? measured : estimated));
}

function balanceScore(values: number[]) {
  if (!values.length || values.reduce((sum, value) => sum + value, 0) <= 0) return 0;
  if (values.length === 1) return 100;
  const total = values.reduce((sum, value) => sum + value, 0);
  let differences = 0;
  for (const left of values) for (const right of values) differences += Math.abs(left - right);
  const gini = differences / (2 * values.length * total);
  const maximum = (values.length - 1) / values.length;
  return clamp(100 * (1 - gini / maximum));
}

export function explicitDecision(text: string) {
  const unresolved = /(?:请|需要|等待|尚未|还没|未).{0,12}(?:拍板|决定|确认|确定)|负责人是谁|谁负责|是否|待确认|(?:决定|确认|确定)一下/.test(text);
  if (unresolved) return false;

  // Opening an agenda often uses the same verbs as a real decision. Phrases such
  // as “今天确认灰度范围，先听各方意见” describe what the meeting intends to
  // decide, not an outcome that has already been agreed.
  const agendaFraming = /(?:今天|本次|这次|本场|这场|接下来).{0,16}(?:确认|确定|决定|拍板)/.test(text)
    || /(?:确认|确定|决定|拍板).{0,36}(?:先(?:听|看|讨论|收集|评估)|听取|征求).{0,12}(?:意见|数据|方案|情况)/.test(text);
  const resolvedForm = /(?:拍板[：:]|最终(?:决定|确认|确定)|已(?:经)?(?:决定|确认|确定)|就按|(?:确认|确定)(?:了|为|是|采用|选择|由|按)|决定(?:了|采用|选择|由|按|上线|下线|取消|延期|暂缓|保留|使用)|行[，,。 ]*(?:就|那就|按))/.test(text);
  if (agendaFraming && !resolvedForm) return false;

  return resolvedForm || /(?:我|我们|团队|会议)(?:现)?决定(?!一下)/.test(text);
}

export function explicitAction(text: string) {
  return /负责(?!人)/.test(text) && !/(谁负责|负责人是谁|尚未|还没|未确认|待确认)/.test(text);
}

function hasDue(text: string) {
  return /(?:今天|明天|后天|本周|下周|周[一二三四五六日天]|(?:[零一二三四五六七八九十]{1,3}|\d{1,2})点|\d{1,2}:\d{1,2}|\d{1,2}月\d{1,2}日)/.test(text);
}

const genericAgenda = /^(?:讨论|会议|同步|待定|其他|无|自由讨论|方案)$/;
const ignoredTokens = new Set(['确认', '确定', '讨论', '方案', '问题', '相关', '本次', '进行', '负责人']);

function agendaTokens(agenda: string) {
  const parts = agenda.split(/[、，,；;：:\s与和及]/).map(clean).filter((item) => item.length >= 2 && !ignoredTokens.has(item));
  const compact = clean(agenda.replace(/确认|确定|讨论|梳理|本周|方案|负责人/g, ''));
  const grams: string[] = [];
  for (let size = 4; size >= 2; size -= 1) {
    for (let index = 0; index + size <= compact.length; index += 1) {
      const token = compact.slice(index, index + size);
      if (!ignoredTokens.has(token)) grams.push(token);
    }
  }
  return [...new Set([...parts, ...grams])].slice(0, 36);
}

export function scoreMeeting(input: ScoringInput) {
  const transcript = (Array.isArray(input.transcript) ? input.transcript : []).slice(-200);
  const events = (Array.isArray(input.events) ? input.events : []).slice(-60);
  const agenda = (input.meeting?.agenda || []).map((item) => String(item).trim()).filter((item) => item.length >= 2 && !genericAgenda.test(item)).slice(0, 8);
  const planned = Math.max(1, Number(input.meeting?.durationSeconds || 1800));
  const lastAt = Number(transcript.at(-1)?.end || transcript.at(-1)?.at || 0);
  const actual = Math.max(1, Number(input.actualSeconds || lastAt || 1));
  const meaningful = transcript.filter((line) => isMeaningful(String(line.text || '')));
  const meaningfulChars = meaningful.reduce((sum, line) => sum + clean(line.text).length, 0);
  const speechSeconds = meaningful.reduce((sum, line) => sum + lineSeconds(line), 0);
  const meaningfulTurns = meaningful.length;
  const evidenceFactor = Math.min(1,
    .4 * Math.min(1, meaningfulTurns / 6)
    + .35 * Math.min(1, meaningfulChars / 180)
    + .25 * Math.min(1, speechSeconds / 45));

  const attendeeIds = (input.meeting?.attendees || []).map((person) => person.id || person.name || 'unknown');
  const inferredIds = [...new Set(meaningful.map((line) => line.speakerId || line.speaker || 'unknown'))];
  const speakerIds = attendeeIds.length ? attendeeIds : inferredIds;
  const speakerTime = new Map<string, number>();
  for (const line of meaningful) {
    const id = line.speakerId || line.speaker || 'unknown';
    speakerTime.set(id, (speakerTime.get(id) || 0) + lineSeconds(line));
  }
  const values = speakerIds.map((id) => speakerTime.get(id) || 0);
  const activeSpeakers = values.filter((value) => value > 0).length;
  const evidenceMultiplier = evidenceFactor <= 0 ? 0 : .35 + .65 * evidenceFactor;

  const offTopicSecondsFromLines = meaningful.filter((line) => line.workRelated === false).reduce((sum, line) => sum + lineSeconds(line), 0);
  const offTopicSeconds = offTopicSecondsFromLines || events.filter((event) => event.type === 'smalltalk' || event.type === 'off_topic').length * 6;
  const punctualityBase = 100 * Math.min(1, planned / actual);
  const time = evidenceFactor < .25 ? 0 : clamp(punctualityBase * evidenceMultiplier);
  const focus = !agenda.length || !meaningfulTurns ? 0 : clamp(100 * (1 - Math.min(1, offTopicSeconds / Math.max(1, speechSeconds))) * evidenceMultiplier);
  const participationBase = .6 * balanceScore(values) + .4 * (speakerIds.length ? activeSpeakers / speakerIds.length * 100 : 0);
  const participation = meaningfulTurns ? clamp(participationBase * evidenceMultiplier) : 0;

  const decisionLines = meaningful.filter((line) => explicitDecision(String(line.text || '')));
  const attendeeNames = (input.meeting?.attendees || []).map((person) => String(person.name || '').trim()).filter(Boolean);
  const actionClauses = meaningful.flatMap((line) => String(line.text || '').split(/[，,。；;]/).map((item) => item.trim()).filter(Boolean)).filter((clause) => {
    if (explicitAction(clause)) return true;
    return attendeeNames.some((name) => clause.includes(name)) && hasDue(clause) && /(?:开|确认|验收|提交|完成|跟进|发布|监控|回传|处理|准备)/.test(clause);
  });
  const hasDecisionEvent = events.some((event) => event.type === 'decision');
  const decisionCount = Math.min(2, decisionLines.length + Number(hasDecisionEvent && !decisionLines.length));
  const hasActionEvent = events.some((event) => event.type === 'action_item');
  const actionCount = Math.min(3, actionClauses.length + Number(hasActionEvent && !actionClauses.length));
  const ownedActions = actionClauses.length;
  const timedActions = actionClauses.filter(hasDue).length;
  const outcome = clamp(Math.min(70, decisionCount * 35) + Math.min(40, actionCount * 20) + (ownedActions ? 10 : 0) + (timedActions ? 10 : 0));

  const agendaAssessments = agenda.map((item) => {
    const tokens = agendaTokens(item);
    const related = meaningful.filter((line) => {
      const haystack = `${clean(line.topic)}${clean(line.text)}`;
      return tokens.some((token) => haystack.includes(token));
    });
    if (!related.length) return 0;
    return related.some((line) => explicitDecision(String(line.text || '')) || explicitAction(String(line.text || ''))) ? 100 : 55;
  });
  const agendaProgress = agenda.length ? clamp(agendaAssessments.reduce<number>((sum, value) => sum + value, 0) / agenda.length * evidenceMultiplier) : 0;

  let overall = clamp(.15 * time + .2 * focus + .15 * participation + .2 * agendaProgress + .3 * outcome);
  const caps: number[] = [100];
  if (!meaningfulTurns || meaningfulChars < 12) caps.push(5);
  else if (evidenceFactor < .25) caps.push(20);
  else if (evidenceFactor < .5) caps.push(40);
  if (!agenda.length) caps.push(30);
  if (!decisionCount && !actionCount) caps.push(55);
  overall = Math.min(overall, ...caps);

  const totalSpeakerTime = Math.max(1, values.reduce((sum, value) => sum + value, 0));
  const speakerStats = speakerIds.map((id) => ({
    id,
    seconds: Math.round(speakerTime.get(id) || 0),
    share: (speakerTime.get(id) || 0) / totalSpeakerTime * 100,
    turns: meaningful.filter((line) => (line.speakerId || line.speaker || 'unknown') === id).length,
    interruptions: meaningful.filter((line) => (line.speakerId || line.speaker || 'unknown') === id && line.interrupted).length,
  }));

  return {
    overall,
    actualSeconds: Math.round(actual),
    scores: [
      { key: 'time', label: '时间管理', value: time, detail: evidenceFactor < .25 ? '有效讨论不足，不因提前结束加分' : actual <= planned ? '在计划时间内完成' : `超出计划 ${Math.round(actual - planned)} 秒` },
      { key: 'focus', label: '议题聚焦', value: focus, detail: !agenda.length ? '没有设置明确议题' : offTopicSeconds ? `约 ${Math.round(offTopicSeconds)} 秒偏离议题` : '未检测到明确偏题' },
      { key: 'participation', label: '参与质量', value: participation, detail: `${activeSpeakers} / ${Math.max(1, speakerIds.length)} 人产生实质发言` },
      { key: 'agenda', label: '议题推进', value: agendaProgress, detail: !agenda.length ? '没有可核验的议题' : `${agendaAssessments.filter((value) => value > 0).length} / ${agenda.length} 项获得讨论证据` },
      { key: 'outcome', label: '决策闭环', value: outcome, detail: `${decisionCount} 项决策 · ${actionCount} 项行动` },
    ],
    speakerStats,
    evidence: { meaningfulTurns, meaningfulChars, speechSeconds: Math.round(speechSeconds), activeSpeakers, evidenceFactor, agendaProvided: agenda.length > 0 },
    decisionCount,
    actionCount,
  };
}
