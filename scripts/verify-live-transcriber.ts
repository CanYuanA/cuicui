import assert from 'node:assert/strict';
import { XfyunTranscriber } from '../app/live-transcriber.ts';

class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static readonly instances: FakeWebSocket[] = [];

  readyState = FakeWebSocket.CONNECTING;
  onopen: (() => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  readonly sent: string[] = [];

  constructor(readonlyUrl: string) {
    void readonlyUrl;
    FakeWebSocket.instances.push(this);
    queueMicrotask(() => {
      this.readyState = FakeWebSocket.OPEN;
      this.onopen?.();
    });
  }

  send(payload: string) { this.sent.push(payload); }
  close() { this.readyState = FakeWebSocket.CLOSED; }
  addEventListener() { /* not needed by this configuration check */ }
  removeEventListener() { /* not needed by this configuration check */ }
}

Object.defineProperty(globalThis, 'window', { configurable: true, value: globalThis });
Object.defineProperty(globalThis, 'WebSocket', { configurable: true, value: FakeWebSocket });

const transcriber = new XfyunTranscriber({
  accessToken: 'test-session',
  onPartial: () => undefined,
  onFinal: () => undefined,
  onStatus: () => undefined,
  onError: (message) => { throw new Error(message); },
});
const internals = transcriber as unknown as {
  openSession(auth: { url: string; appId: string }): Promise<void>;
  sendAudioFrame(): void;
  clearTimers(): void;
  pending: number[];
  pendingOffset: number;
  stopping: boolean;
};

await internals.openSession({ url: 'wss://iat-api.xfyun.cn/v2/iat', appId: 'test-app' });
const socket = FakeWebSocket.instances[0];
assert.ok(socket, '讯飞会话应成功建立');

internals.pending = Array.from({ length: 640 }, (_, index) => index % 100);
internals.pendingOffset = 0;
internals.sendAudioFrame();

assert.equal(socket.sent.length, 1, '首个 40ms 音频帧应成功发送');
const payload = JSON.parse(socket.sent[0] || '{}') as {
  data?: { status?: number };
  business?: { vad_eos?: number };
};
assert.equal(payload.data?.status, 0, '首帧必须携带开始状态');
assert.equal(payload.business?.vad_eos, 2000, '短停顿容忍时间应为 2000ms');

internals.stopping = true;
internals.clearTimers();

console.log(JSON.stringify({
  ok: true,
  checks: {
    frameDurationMs: 40,
    shortPauseToleranceMs: 2000,
    openingFrameCarriesVadSetting: true,
  },
}, null, 2));
