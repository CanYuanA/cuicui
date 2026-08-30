import type { InterventionLevel } from './demo-data';

let sharedContext: AudioContext | null = null;

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
    const start = context.currentTime + .01;
    const end = start + .46;
    const master = context.createGain();
    master.gain.setValueAtTime(.0001, start);
    master.gain.linearRampToValueAtTime(level === 'L2' ? .045 : .034, start + .022);
    master.gain.exponentialRampToValueAtTime(.0001, end);
    master.connect(context.destination);

    // A quiet three-part bell has a softer edge than a short electronic beep.
    for (const [frequency, weight] of [[587.33, 1], [880, .24], [1174.66, .08]] as const) {
      const oscillator = context.createOscillator();
      const partial = context.createGain();
      oscillator.type = 'sine';
      oscillator.frequency.setValueAtTime(frequency, start);
      partial.gain.setValueAtTime(weight, start);
      oscillator.connect(partial);
      partial.connect(master);
      oscillator.start(start);
      oscillator.stop(end);
    }
  };

  if (context.state === 'suspended') void context.resume().then(ring).catch(() => undefined);
  else ring();
}
