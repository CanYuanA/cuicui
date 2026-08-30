import type { Intervention, TranscriptLine } from './demo-data';
import { findDisagreementEvidence, isContentInterruption } from './intervention-routing.ts';

export function appendStableLiveLine(current: TranscriptLine[], line: TranscriptLine) {
  const existing = current.findIndex((item) => item.id === line.id);
  if (existing < 0) return [...current, line];
  return current.map((item, index) => index === existing ? line : item);
}

export function resolveLiveDraftSpeaker(draftSpeakerId: string | null, selectedSpeakerId: string) {
  return draftSpeakerId || selectedSpeakerId;
}

export function stableLiveAnalysisLines(lines: TranscriptLine[]) {
  return lines.filter((line) => line.text.trim().length >= 4).slice(-32);
}

type SnapshotJob = { key: string; run: () => Promise<void> };
type QueueCycle = {
  running: boolean;
  pending: SnapshotJob | null;
  keys: Set<string>;
  idle: Promise<void>;
};

function queueCycle(): QueueCycle {
  return { running: false, pending: null, keys: new Set<string>(), idle: Promise.resolve() };
}

export class SerialSnapshotQueue {
  private cycle = queueCycle();

  enqueue(key: string, job: () => Promise<void>) {
    const cycle = this.cycle;
    if (cycle.keys.has(key)) return false;
    cycle.keys.add(key);
    const next = { key, run: job };
    if (cycle.running) {
      if (cycle.pending) cycle.keys.delete(cycle.pending.key);
      cycle.pending = next;
      return true;
    }
    cycle.running = true;
    cycle.idle = this.drain(cycle, next);
    return true;
  }

  forget(key: string) {
    this.cycle.keys.delete(key);
  }

  reset() {
    this.cycle.pending = null;
    this.cycle = queueCycle();
  }

  idle() {
    return this.cycle.idle;
  }

  private async drain(cycle: QueueCycle, first: SnapshotJob) {
    let next: SnapshotJob | null = first;
    while (next) {
      try { await next.run(); } catch { /* a failed snapshot must not block the latest one */ }
      if (this.cycle !== cycle) break;
      next = cycle.pending;
      cycle.pending = null;
    }
    cycle.running = false;
  }
}

const returningToAgenda = /(?:会后再?聊|回到|继续|先不聊|拉回|回归正题|言归正传)/;

function normalizedText(value: string) {
  return value.replace(/[\s，。！？、；：,.!?;:'"“”‘’（）()《》【】\[\]—-]/g, '');
}

function evidenceTouchesLatestTurn(evidence: string, latestText: string) {
  const evidenceText = normalizedText(evidence);
  const turnText = normalizedText(latestText);
  if (!evidenceText || !turnText) return false;
  const width = Math.min(6, turnText.length);
  for (let index = 0; index <= turnText.length - width; index += 1) {
    if (evidenceText.includes(turnText.slice(index, index + width))) return true;
  }
  return false;
}

export function isSingleSnapshotEventCurrent(event: Pick<Intervention, 'type' | 'evidence'>, lines: TranscriptLine[]) {
  const latest = lines.at(-1);
  if (!latest) return false;
  if (event.type === 'disagreement') return Boolean(findDisagreementEvidence(lines)) && evidenceTouchesLatestTurn(event.evidence, latest.text);
  if (event.type === 'interrupt') return isContentInterruption(lines.at(-2), latest) && evidenceTouchesLatestTurn(event.evidence, latest.text);
  if (event.type === 'smalltalk' || event.type === 'off_topic' || event.type === 'repeat') {
    if (returningToAgenda.test(latest.text)) return false;
    return evidenceTouchesLatestTurn(event.evidence, latest.text);
  }
  return true;
}

function singleIncidentKey(event: Intervention) {
  if (event.type === 'disagreement') return 'disagreement:current-agenda';
  if (event.type === 'smalltalk') return 'smalltalk:current-agenda';
  if (event.type === 'off_topic') return 'off-topic:current-agenda';
  if (event.type === 'repeat') return 'repeat:current-agenda';
  if (event.type === 'time') return 'time:meeting';
  if (event.type === 'interrupt') return event.incidentKey || `interrupt:${event.evidence.slice(0, 48)}`;
  return null;
}

const levelRank = { L0: 0, L1: 1, L2: 2 } as const;

export function mergeSingleInterventions(current: Intervention[], incoming: Intervention[]) {
  const merged = [...current];
  for (const event of incoming) {
    const incidentKey = singleIncidentKey(event);
    if (!incidentKey) {
      if (!merged.some((existing) => existing.id === event.id)) merged.push(event);
      continue;
    }
    const normalized = { ...event, incidentKey };
    const existingIndex = merged.findIndex((existing) => singleIncidentKey(existing) === incidentKey);
    if (existingIndex < 0) {
      merged.push(normalized);
      continue;
    }
    const existing = merged[existingIndex];
    if (levelRank[normalized.level] > levelRank[existing.level]
      || (normalized.level === existing.level && normalized.priority > existing.priority)) {
      merged[existingIndex] = normalized;
    }
  }
  return merged.sort((left, right) => left.at - right.at || left.id.localeCompare(right.id));
}
