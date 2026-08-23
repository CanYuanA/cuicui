export type TranscriberStatus = 'requesting' | 'connecting' | 'listening' | 'finishing' | 'closed';

export type TranscriberOptions = {
  accessToken: string;
  onPartial: (text: string) => void;
  onFinal: (text: string) => void;
  onStatus: (status: TranscriberStatus) => void;
  onError: (message: string) => void;
};

export interface MeetingTranscriber {
  start(): Promise<void>;
  stop(): Promise<void>;
}

type XfyunResult = {
  sn: number;
  pgs?: 'apd' | 'rpl';
  rg?: [number, number];
  ws?: Array<{ cw?: Array<{ w?: string }> }>;
};

type XfyunMessage = {
  code?: number;
  message?: string;
  sid?: string;
  data?: { status?: number; result?: XfyunResult };
};

type AuthPayload = { url: string; appId: string };

function int16ToBase64(samples: Int16Array) {
  const bytes = new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength);
  let binary = '';
  const batch = 8192;
  for (let index = 0; index < bytes.length; index += batch) binary += String.fromCharCode(...bytes.subarray(index, index + batch));
  return btoa(binary);
}

function resampleTo16k(input: Float32Array, inputRate: number) {
  if (inputRate === 16000) return input;
  const ratio = inputRate / 16000;
  const outputLength = Math.max(1, Math.floor(input.length / ratio));
  const output = new Float32Array(outputLength);
  for (let index = 0; index < outputLength; index += 1) {
    const source = index * ratio;
    const left = Math.floor(source);
    const right = Math.min(input.length - 1, left + 1);
    const mix = source - left;
    output[index] = input[left] * (1 - mix) + input[right] * mix;
  }
  return output;
}

function floatToInt16(input: Float32Array) {
  const output = new Int16Array(input.length);
  for (let index = 0; index < input.length; index += 1) {
    const value = Math.max(-1, Math.min(1, input[index]));
    output[index] = value < 0 ? value * 0x8000 : value * 0x7fff;
  }
  return output;
}

function blobToBase64(blob: Blob) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || '').split(',')[1] || '');
    reader.onerror = () => reject(reader.error || new Error('读取录音失败'));
    reader.readAsDataURL(blob);
  });
}

async function requestMicrophone() {
  if (!navigator.mediaDevices?.getUserMedia) throw new Error('当前浏览器不支持麦克风采集，请使用最新版 Chrome 或 Edge。');
  return navigator.mediaDevices.getUserMedia({
    audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    video: false,
  });
}

export class XfyunTranscriber implements MeetingTranscriber {
  private options: TranscriberOptions;
  private socket: WebSocket | null = null;
  private stream: MediaStream | null = null;
  private audioContext: AudioContext | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private processor: ScriptProcessorNode | null = null;
  private frameTimer: number | null = null;
  private rotationTimer: number | null = null;
  private reconnectTimer: number | null = null;
  private pending: number[] = [];
  private pieces = new Map<number, string>();
  private completedText = '';
  private firstFrame = true;
  private stopping = false;
  private waitingForFinal = false;
  private connectedOnce = false;
  private sessionEpoch = 0;
  private reconnectFailures = 0;
  private appId = '';

  constructor(options: TranscriberOptions) {
    this.options = options;
  }

  async start() {
    if (this.stream) return;
    this.stopping = false;
    this.options.onStatus('requesting');
    const firstAuth = await this.fetchAuth();
    try {
      this.stream = await requestMicrophone();
      const context = new AudioContext({ latencyHint: 'interactive' });
      this.audioContext = context;
      if (context.state === 'suspended') await context.resume();
      const source = context.createMediaStreamSource(this.stream);
      const processor = context.createScriptProcessor(4096, 1, 1);
      this.source = source;
      this.processor = processor;
      processor.onaudioprocess = (event) => {
        if (this.stopping) return;
        const pcm = floatToInt16(resampleTo16k(event.inputBuffer.getChannelData(0), context.sampleRate));
        for (const sample of pcm) this.pending.push(sample);
      };
      source.connect(processor);
      processor.connect(context.destination);
      await this.openSession(firstAuth);
      this.frameTimer = window.setInterval(() => this.sendAudioFrame(), 40);
    } catch (error) {
      this.releaseMedia();
      throw error;
    }
  }

  private async fetchAuth() {
    const response = await fetch('/api/iflytek-auth', { cache: 'no-store', headers: { 'X-Cuicui-Session': this.options.accessToken }, signal: AbortSignal.timeout(8000) });
    const payload = await response.json().catch(() => ({})) as { url?: string; appId?: string; error?: string };
    if (!response.ok || !payload.url || !payload.appId) throw new Error(payload.error || `讯飞鉴权失败（HTTP ${response.status}）`);
    return { url: payload.url, appId: payload.appId } satisfies AuthPayload;
  }

  private openSession(auth?: AuthPayload) {
    return new Promise<void>(async (resolve, reject) => {
      const epoch = ++this.sessionEpoch;
      try {
        const credentials = auth || await this.fetchAuth();
        if (this.stopping || epoch !== this.sessionEpoch) return reject(new Error('听写已停止'));
        this.appId = credentials.appId;
        this.options.onStatus('connecting');
        const socket = new WebSocket(credentials.url);
        this.socket = socket;
        this.firstFrame = true;
        this.waitingForFinal = false;
        this.pieces.clear();
        const timeout = window.setTimeout(() => {
          try { socket.close(4000, 'connect timeout'); } catch { /* already closed */ }
          reject(new Error('讯飞 WebSocket 连接超时'));
        }, 9000);

        socket.onopen = () => {
          if (epoch !== this.sessionEpoch || this.stopping) return;
          window.clearTimeout(timeout);
          this.connectedOnce = true;
          this.reconnectFailures = 0;
          this.options.onStatus('listening');
          this.scheduleRotation();
          resolve();
        };
        socket.onmessage = (event) => this.handleMessage(epoch, event.data);
        socket.onerror = () => {
          if (!this.connectedOnce) {
            window.clearTimeout(timeout);
            reject(new Error('讯飞浏览器直连失败'));
          }
        };
        socket.onclose = (event) => {
          window.clearTimeout(timeout);
          if (epoch !== this.sessionEpoch) return;
          const expectedClose = this.waitingForFinal;
          this.finishCurrentText();
          if (this.stopping || expectedClose) return;
          this.scheduleReconnect(`连接关闭 ${event.code}${event.reason ? ` · ${event.reason}` : ''}`);
        };
      } catch (error) {
        reject(error);
      }
    });
  }

  private combinedSessionText() {
    return [...this.pieces.entries()].sort((a, b) => a[0] - b[0]).map(([, text]) => text).join('').trim();
  }

  private fullText() {
    return `${this.completedText}${this.combinedSessionText()}`.trim();
  }

  private handleMessage(epoch: number, raw: string) {
    if (epoch !== this.sessionEpoch) return;
    try {
      const message = JSON.parse(raw) as XfyunMessage;
      if (message.code !== 0) {
        this.options.onError(`讯飞听写错误 ${message.code}：${message.message || '未知错误'}${message.sid ? `（${message.sid}）` : ''}`);
        this.socket?.close(4001, 'provider error');
        return;
      }
      const result = message.data?.result;
      if (result) {
        const fragment = (result.ws || []).map((item) => item.cw?.[0]?.w || '').join('');
        if (result.pgs === 'rpl' && Array.isArray(result.rg)) for (let sn = result.rg[0]; sn <= result.rg[1]; sn += 1) this.pieces.delete(sn);
        this.pieces.set(result.sn, fragment);
        this.options.onPartial(this.fullText());
      }
      if (message.data?.status === 2) {
        this.finishCurrentText();
        this.socket?.close(1000, 'session complete');
      }
    } catch {
      this.options.onError('讯飞返回了无法解析的听写结果，正在自动续接。');
      this.socket?.close(4002, 'invalid response');
    }
  }

  private finishCurrentText() {
    const current = this.combinedSessionText();
    if (current) {
      this.completedText = `${this.completedText}${current}`.trim();
      this.options.onFinal(this.completedText);
    }
    this.pieces.clear();
  }

  private sendAudioFrame() {
    const socket = this.socket;
    if (this.stopping || this.waitingForFinal || !socket || socket.readyState !== WebSocket.OPEN || this.pending.length < 640) return;
    const chunk = new Int16Array(this.pending.splice(0, 640));
    const payload: Record<string, unknown> = {
      data: { status: this.firstFrame ? 0 : 1, format: 'audio/L16;rate=16000', encoding: 'raw', audio: int16ToBase64(chunk) },
    };
    if (this.firstFrame) {
      payload.common = { app_id: this.appId };
      payload.business = { language: 'zh_cn', domain: 'iat', accent: 'mandarin', dwa: 'wpgs', vad_eos: 10000 };
    }
    socket.send(JSON.stringify(payload));
    this.firstFrame = false;
  }

  private scheduleRotation() {
    if (this.rotationTimer) window.clearTimeout(this.rotationTimer);
    this.rotationTimer = window.setTimeout(() => void this.rotateSession(), 50_000);
  }

  private async rotateSession() {
    if (this.stopping) return;
    await this.endSocketSession();
    if (!this.stopping) await this.openSession().catch((error) => this.scheduleReconnect(error instanceof Error ? error.message : '轮换失败'));
  }

  private endSocketSession() {
    return new Promise<void>((resolve) => {
      const socket = this.socket;
      if (!socket || socket.readyState !== WebSocket.OPEN) return resolve();
      this.waitingForFinal = true;
      if (this.rotationTimer) window.clearTimeout(this.rotationTimer);
      const pending = new Int16Array(this.pending.splice(0, Math.min(640, this.pending.length)));
      if (this.firstFrame) {
        socket.send(JSON.stringify({
          common: { app_id: this.appId },
          business: { language: 'zh_cn', domain: 'iat', accent: 'mandarin', dwa: 'wpgs', vad_eos: 10000 },
          data: { status: 0, format: 'audio/L16;rate=16000', encoding: 'raw', audio: int16ToBase64(pending) },
        }));
        window.setTimeout(() => {
          if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ data: { status: 2, format: 'audio/L16;rate=16000', encoding: 'raw', audio: '' } }));
        }, 40);
      } else {
        socket.send(JSON.stringify({ data: { status: 2, format: 'audio/L16;rate=16000', encoding: 'raw', audio: int16ToBase64(pending) } }));
      }
      const done = () => {
        socket.removeEventListener('close', done);
        resolve();
      };
      socket.addEventListener('close', done, { once: true });
      window.setTimeout(() => {
        if (socket.readyState === WebSocket.OPEN) socket.close(1000, 'final timeout');
        done();
      }, 3500);
    });
  }

  private scheduleReconnect(reason: string) {
    if (this.stopping || this.reconnectTimer) return;
    this.reconnectFailures += 1;
    if (this.reconnectFailures >= 3) this.options.onError(`讯飞直连连续失败（${reason}），可切换同源 HTTP 转写。`);
    this.options.onStatus('connecting');
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      void this.openSession().catch((error) => this.scheduleReconnect(error instanceof Error ? error.message : '重新连接失败'));
    }, Math.min(3000, 500 * this.reconnectFailures));
  }

  async stop() {
    if (this.stopping) return;
    this.stopping = true;
    this.options.onStatus('finishing');
    if (this.frameTimer) window.clearInterval(this.frameTimer);
    if (this.rotationTimer) window.clearTimeout(this.rotationTimer);
    if (this.reconnectTimer) window.clearTimeout(this.reconnectTimer);
    await this.endSocketSession();
    this.finishCurrentText();
    this.releaseMedia();
    this.options.onStatus('closed');
  }

  private releaseMedia() {
    try { this.source?.disconnect(); } catch { /* disconnected */ }
    try { this.processor?.disconnect(); } catch { /* disconnected */ }
    if (this.processor) this.processor.onaudioprocess = null;
    this.stream?.getTracks().forEach((track) => track.stop());
    if (this.audioContext && this.audioContext.state !== 'closed') void this.audioContext.close();
    this.socket = null;
    this.stream = null;
    this.audioContext = null;
    this.source = null;
    this.processor = null;
  }
}

export class HttpChunkTranscriber implements MeetingTranscriber {
  private options: TranscriberOptions;
  private stream: MediaStream | null = null;
  private recorder: MediaRecorder | null = null;
  private stopped = false;
  private completedText = '';
  private loopPromise: Promise<void> | null = null;

  constructor(options: TranscriberOptions) {
    this.options = options;
  }

  async start() {
    if (!window.MediaRecorder) throw new Error('当前浏览器不支持备用录音模式。');
    this.options.onStatus('requesting');
    this.stream = await requestMicrophone();
    this.stopped = false;
    this.options.onStatus('listening');
    this.loopPromise = this.runLoop();
  }

  private async runLoop() {
    while (!this.stopped && this.stream) {
      try {
        const blob = await this.recordChunk(4800);
        if (blob.size < 800) continue;
        const audioBase64 = await blobToBase64(blob);
        const response = await fetch('/api/transcribe', {
          method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Cuicui-Session': this.options.accessToken },
          body: JSON.stringify({ audioBase64, format: 'webm', language: 'zh' }),
          signal: AbortSignal.timeout(45000),
        });
        const payload = await response.json().catch(() => ({})) as { text?: string; error?: string };
        if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
        const text = String(payload.text || '').trim();
        if (text) {
          this.completedText = `${this.completedText}${text}`.trim();
          this.options.onPartial(this.completedText);
          this.options.onFinal(this.completedText);
        }
      } catch (error) {
        if (!this.stopped) this.options.onError(`备用转写失败：${error instanceof Error ? error.message : '未知错误'}。正在继续录音并重试。`);
      }
    }
  }

  private recordChunk(milliseconds: number) {
    return new Promise<Blob>((resolve, reject) => {
      if (!this.stream || this.stopped) return resolve(new Blob());
      const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : 'audio/webm';
      const chunks: BlobPart[] = [];
      const recorder = new MediaRecorder(this.stream, { mimeType });
      this.recorder = recorder;
      recorder.ondataavailable = (event) => { if (event.data.size) chunks.push(event.data); };
      recorder.onerror = () => reject(new Error('浏览器录音失败'));
      recorder.onstop = () => {
        this.recorder = null;
        resolve(new Blob(chunks, { type: mimeType }));
      };
      recorder.start();
      window.setTimeout(() => { if (recorder.state === 'recording') recorder.stop(); }, milliseconds);
    });
  }

  async stop() {
    if (this.stopped) return;
    this.stopped = true;
    this.options.onStatus('finishing');
    if (this.recorder?.state === 'recording') this.recorder.stop();
    this.stream?.getTracks().forEach((track) => track.stop());
    await Promise.race([this.loopPromise || Promise.resolve(), new Promise((resolve) => window.setTimeout(resolve, 1200))]);
    this.stream = null;
    this.options.onStatus('closed');
  }
}
