import type { EventType, Intervention, InterventionLevel, Severity } from './demo-data';

export type InterventionCandidate = {
  at?: number;
  type: EventType;
  severity: Severity;
  label: string;
  observation: string;
  impact: string;
  suggestion: string;
  evidence: string;
  confidence?: number;
  incidentKey?: string;
};

export type PreviousIntervention = Pick<Intervention, 'id' | 'at' | 'type' | 'level' | 'priority'> & Partial<Pick<Intervention, 'incidentKey' | 'occurrence'>>;

export type TranscriptSignal = {
  speakerId?: string;
  speaker?: string;
  text?: string;
  at?: number;
  end?: number;
};

const speakerKey = (line?: TranscriptSignal) => line?.speakerId || line?.speaker || '';

export function isContentInterruption(previous?: TranscriptSignal, latest?: TranscriptSignal) {
  if (!previous || !latest || !String(previous.text || '').trim() || !String(latest.text || '').trim()) return false;
  if (!speakerKey(previous) || !speakerKey(latest) || speakerKey(previous) === speakerKey(latest)) return false;
  const text = String(latest.text || '').replace(/\s+/g, '');
  const explicitStop = /(?:我打断一下|先停一下|先别说|等一下|等等|别说了|到此为止|先听我说)/.test(text);
  const interruptiveReply = /(?:不用(?:再|继续|解释|展开|说|讨论|考虑|灰度)|别把|先上再看|我先说)/.test(text);
  const overlaps = Number.isFinite(Number(latest.at)) && Number.isFinite(Number(previous.end))
    && Number(latest.at) < Number(previous.end) - .15;
  return explicitStop || (overlaps && interruptiveReply);
}

export function findDisagreementEvidence(transcript: TranscriptSignal[]) {
  const latest = transcript.at(-1);
  const latestText = String(latest?.text || '').replace(/\s+/g, '');
  if (!latest || !speakerKey(latest) || !/(?:不同意|反对|不认可|不能接受|不赞成|有不同意见|不应该|不能按|不行)/.test(latestText)) return null;
  const prior = transcript.slice(0, -1).reverse().find((line) => {
    if (!speakerKey(line) || speakerKey(line) === speakerKey(latest)) return false;
    const text = String(line.text || '').replace(/\s+/g, '');
    return text.length >= 8 && /(?:建议|认为|应该|必须|方案|可以|不能|不要|主张|倾向|支持|同意|反对|全量|灰度|上线)/.test(text);
  });
  return prior ? { prior, latest } : null;
}

const visiblePriority = (type: EventType, level: InterventionLevel): 0 | 100 | 200 | 300 => {
  if (level === 'L0') return 0;
  if (type === 'interrupt') return 100;
  if (level === 'L2') return 300;
  return type === 'time' || type === 'disagreement' ? 200 : 100;
};

function routeLevel(candidate: InterventionCandidate, occurrence: number): InterventionLevel {
  if (candidate.severity === 'success' || candidate.severity === 'info') return 'L0';
  if (candidate.type === 'decision' || candidate.type === 'action_item' || candidate.type === 'agenda_progress' || candidate.type === 'topic_shift') return 'L0';
  if (candidate.type === 'interrupt') return candidate.severity === 'critical' && occurrence >= 3 ? 'L2' : occurrence >= 2 ? 'L1' : 'L0';
  if (candidate.severity === 'critical') return 'L2';
  if (candidate.type === 'disagreement') return occurrence >= 2 ? 'L2' : 'L1';
  if (candidate.type === 'time') return occurrence >= 2 ? 'L2' : 'L1';
  if (candidate.type === 'smalltalk' || candidate.type === 'off_topic' || candidate.type === 'repeat') {
    return occurrence >= 3 ? 'L2' : occurrence === 2 ? 'L1' : 'L0';
  }
  return 'L1';
}

export function routeInterventions(candidates: InterventionCandidate[], previous: PreviousIntervention[], now: number) {
  const routed: Array<Omit<Intervention, 'id'>> = [];
  for (const candidate of candidates.slice(0, 3)) {
    const incidentKey = candidate.incidentKey || candidate.type;
    const occurrence = previous.filter((event) => (event.incidentKey || event.type) === incidentKey).length
      + routed.filter((event) => (event.incidentKey || event.type) === incidentKey).length + 1;
    let level = routeLevel(candidate, occurrence);
    let priority = visiblePriority(candidate.type, level);
    const at = Math.max(0, Number.isFinite(candidate.at) ? Number(candidate.at) : now);
    const recentVisible = [...previous, ...routed.map((event, index) => ({ ...event, id: `pending-${index}` }))]
      .filter((event) => event.level !== 'L0' && at - event.at >= 0 && at - event.at < 8)
      .sort((left, right) => right.at - left.at)[0];
    let replacesId: string | undefined;
    if (recentVisible) {
      if (priority > recentVisible.priority) replacesId = recentVisible.id;
      else {
        level = 'L0';
        priority = 0;
      }
    }
    routed.push({
      ...candidate,
      at,
      incidentKey,
      occurrence,
      level,
      priority,
      displayMs: level === 'L2' ? 10000 : level === 'L1' ? 7000 : 0,
      ...(replacesId ? { replacesId, escalationReason: '更高优先级事件替换当前轻提醒' } : {}),
    });
  }
  return routed;
}
