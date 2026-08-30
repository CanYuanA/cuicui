import type { TranscriptLine } from './demo-data';

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

export class SerialSnapshotQueue {
  private tail: Promise<void> = Promise.resolve();
  private keys = new Set<string>();

  enqueue(key: string, job: () => Promise<void>) {
    if (this.keys.has(key)) return false;
    this.keys.add(key);
    const next = this.tail.then(job, job);
    this.tail = next.catch(() => undefined);
    return true;
  }

  forget(key: string) {
    this.keys.delete(key);
  }

  reset() {
    this.tail = Promise.resolve();
    this.keys.clear();
  }

  idle() {
    return this.tail;
  }
}
