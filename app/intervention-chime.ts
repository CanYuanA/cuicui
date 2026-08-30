import type { InterventionLevel } from './demo-data';

let sharedContext: AudioContext | null = null;

export const INTERVENTION_CHIME_CUES = {
  L1: [
    { offset: 0, duration: .46, frequency: 587.33, gain: .04, partials: [[1, 1], [1.5, .24], [2, .08]] },
  ],
  L2: [
    { offset: 0, duration: .5, frequency: 783.99, gain: .052, partials: [[1, 1], [1.5, .18], [2, .05]] },
  ],
} as const;

function audioContext() {
  if (typeof window === 'undefined' || !window.AudioContext) return null;
  if (!sharedContext || sharedContext.state === 'closed') sharedContext = new window.AudioContext({ latencyHint: 'interactive' });
  return sharedContext;
}

export function primeInterventionChime() {
  const context = audioContext();
  if (context?.state === 'suspended') void context.resume().catch(() => undefined);
}

export function playInterventionChime(level: InterventionLevel) {
  if (level === 'L0') return;
  const context = audioContext();
  if (!context) return;

  const ring = () => {
    for (const note of INTERVENTION_CHIME_CUES[level]) {
      const start = context.currentTime + .01 + note.offset;
      const end = start + note.duration;
      const master = context.createGain();
      master.gain.setValueAtTime(.0001, start);
      master.gain.linearRampToValueAtTime(note.gain, start + .022);
      master.gain.exponentialRampToValueAtTime(.0001, end);
      master.connect(context.destination);

      // Both levels stay as one soft bell; pitch and timbre make L2 distinct.
      for (const [ratio, weight] of note.partials) {
        const oscillator = context.createOscillator();
        const partial = context.createGain();
        oscillator.type = 'sine';
        oscillator.frequency.setValueAtTime(note.frequency * ratio, start);
        partial.gain.setValueAtTime(weight, start);
        oscillator.connect(partial);
        partial.connect(master);
        oscillator.start(start);
        oscillator.stop(end);
      }
    }
  };

  if (context.state === 'suspended') void context.resume().then(ring).catch(() => undefined);
  else ring();
}
