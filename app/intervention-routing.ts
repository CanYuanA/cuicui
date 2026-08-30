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

const visiblePriority = (type: EventType, level: InterventionLevel): 0 | 100 | 200 | 300 => {
  if (level === 'L0') return 0;
  if (level === 'L2') return 300;
  return type === 'time' || type === 'disagreement' ? 200 : 100;
};

function routeLevel(candidate: InterventionCandidate, occurrence: number): InterventionLevel {
  if (candidate.severity === 'success' || candidate.severity === 'info') return 'L0';
  if (candidate.type === 'decision' || candidate.type === 'action_item' || candidate.type === 'agenda_progress' || candidate.type === 'topic_shift') return 'L0';
  if (candidate.type === 'interrupt') return occurrence >= 3 || candidate.severity === 'critical' ? 'L2' : 'L0';
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
