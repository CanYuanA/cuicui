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

type AuthPayload = { url: string; appId: string; expiresAt?: number };

const FRAME_SAMPLES = 640;
const FRAME_INTERVAL_MS = 40;
const SESSION_ROTATION_MS = 50_000;
const IFLYTEK_HOST = 'iat-api.xfyun.cn';
const AUDIO_FORMAT = 'audio/L16;rate=16000';

function int16ToBase64(samples: Int16Array) {
  const bytes = new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength);
  let binary = '';
  const batch = 8192;
  for (let index = 0; index < bytes.length; index += batch) binary += String.fromCharCode(...bytes.subarray(index, index + batch));
  return btoa(binary);
}

function toInt16(value: number) {
  const normalized = Math.max(-1, Math.min(1, value));
  return Math.round(normalized < 0 ? normalized * 0x8000 : normalized * 0x7fff);
}

class StreamingPcm16Resampler {
  private inputRate = 0;
  private inputOffset = 0;
  private nextOutputAt = 0;
  private previousSample = 0;
  private hasPreviousSample = false;

  reset() {
    this.inputRate = 0;
    this.inputOffset = 0;
    this.nextOutputAt = 0;
    this.previousSample = 0;
    this.hasPreviousSample = false;
  }

  process(input: Float32Array, inputRate: number) {
    if (!input.length || !Number.isFinite(inputRate) || inputRate <= 0) return new Int16Array();
    if (this.inputRate !== inputRate) {
      this.reset();
      this.inputRate = inputRate;
    }
    if (inputRate === 16000) return Int16Array.from(input, toInt16);

    const firstIndex = this.inputOffset;
    const lastIndex = firstIndex + input.length - 1;
    const step = inputRate / 16000;
    const output: number[] = [];

    while (this.nextOutputAt <= lastIndex) {
      const leftIndex = Math.floor(this.nextOutputAt);
      const mix = this.nextOutputAt - leftIndex;
      const rightIndex = leftIndex + 1;
      if (mix > Number.EPSILON && rightIndex > lastIndex) break;

      const left = leftIndex === firstIndex - 1 && this.hasPreviousSample
        ? this.previousSample
        : input[leftIndex - firstIndex];
      if (left === undefined) break;
      const right = mix <= Number.EPSILON
        ? left
        : rightIndex === firstIndex - 1 && this.hasPreviousSample
          ? this.previousSample
          : input[rightIndex - firstIndex];
      if (right === undefined) break;
      output.push(toInt16(left * (1 - mix) + right * mix));
      this.nextOutputAt += step;
    }

    this.inputOffset += input.length;
    this.previousSample = input[input.length - 1];
    this.hasPreviousSample = true;
    return Int16Array.from(output);
  }
}

async function requestMicrophone() {
  if (!window.isSecureContext) throw new Error('麦克风需要 HTTPS 安全连接，请从正式演示地址进入。');
  if (!navigator.mediaDevices?.getUserMedia) throw new Error('当前浏览器不支持麦克风采集，请使用最新版 Chrome 或 Edge。');
  try {
    return await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      video: false,
    });
  } catch (error) {
    if (error instanceof DOMException && (error.name === 'NotAllowedError' || error.name === 'SecurityError')) {
      throw new Error('麦克风权限未开启，请在浏览器地址栏允许本网站使用麦克风后重试。');
    }
    if (error instanceof DOMException && error.name === 'NotFoundError') throw new Error('没有检测到可用麦克风，请连接麦克风后重试。');
    throw new Error(`无法启动麦克风：${error instanceof Error ? error.message : '未知错误'}`);
  }
}

function providerErrorMessage(message: XfyunMessage) {
  const code = message.code ?? -1;
  if (code === 10005) return '当前讯飞应用未开通流式语音听写，请在讯飞控制台为这个 APPID 开通后重试。';
  if (code === 10010 || code === 10110) return '讯飞流式语音听写授权或免费额度不可用，请检查控制台套餐状态。';
  if (code === 11200) return '讯飞应用未开通当前语种或方言，请启用中文普通话听写。';
  if (code === 10163) return '发送给讯飞的音频帧过长，请刷新页面后重试。';
  return `讯飞听写返回错误 ${code}：${message.message || '未知错误'}`;
}

function connectionErrorMessage(code?: number, reason?: string) {
  const detail = code ? `（连接代码 ${code}${reason ? ` · ${reason}` : ''}）` : '';
  return `讯飞实时听写握手失败${detail}。请确认当前网络允许访问 ${IFLYTEK_HOST}；若讯飞控制台启用了 IP 白名单，需要关闭白名单或加入当前浏览器的出口 IP。`;
}

export class XfyunTranscriber implements MeetingTranscriber {
  private options: TranscriberOptions;
  private socket: WebSocket | null = null;
  private stream: MediaStream | null = null;
  private audioContext: AudioContext | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private processor: ScriptProcessorNode | null = null;
  private silentSink: GainNode | null = null;
  private frameTimer: number | null = null;
  private rotationTimer: number | null = null;
  private reconnectTimer: number | null = null;
  private pending: number[] = [];
  private pendingOffset = 0;
  private resampler = new StreamingPcm16Resampler();
  private pieces = new Map<number, string>();
  private completedText = '';
  private firstFrame = true;
  private captureEnabled = false;
  private stopping = false;
  private waitingForFinal = false;
  private sessionEpoch = 0;
  private reconnectFailures = 0;
  private appId = '';

  constructor(options: TranscriberOptions) {
    this.options = options;
  }

  async start() {
    if (this.stream) return;
    this.stopping = false;
    this.pending = [];
    this.pendingOffset = 0;
    this.resampler.reset();
    this.options.onStatus('requesting');
    try {
      // Request permission before minting the five-minute signed URL. A user can
      // leave a permission prompt open long enough for an earlier URL to expire.
      this.stream = await requestMicrophone();
      const context = new AudioContext({ latencyHint: 'interactive' });
      this.audioContext = context;
      if (context.state === 'suspended') await context.resume();
      const source = context.createMediaStreamSource(this.stream);
      const processor = context.createScriptProcessor(2048, 1, 1);
      const silentSink = context.createGain();
      silentSink.gain.value = 0;
      this.source = source;
      this.processor = processor;
      this.silentSink = silentSink;
      processor.onaudioprocess = (event) => {
        if (this.stopping || !this.captureEnabled) return;
        this.enqueue(this.resampler.process(event.inputBuffer.getChannelData(0), context.sampleRate));
      };
      source.connect(processor);
      processor.connect(silentSink);
      silentSink.connect(context.destination);

      const firstAuth = await this.fetchAuth();
      await this.openSession(firstAuth);
      this.frameTimer = window.setInterval(() => this.sendAudioFrame(), FRAME_INTERVAL_MS);
    } catch (error) {
      this.stopping = true;
      this.clearTimers();
      this.releaseMedia();
      this.options.onStatus('closed');
      throw error;
    }
  }

  private async fetchAuth() {
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 8000);
    let response: Response;
    try {
      response = await fetch('/api/iflytek-auth', {
        cache: 'no-store',
        headers: { 'X-Cuicui-Session': this.options.accessToken },
        signal: controller.signal,
      });
    } catch (error) {
      if (controller.signal.aborted) throw new Error('讯飞鉴权请求超时，请检查当前网络后重试。');
      throw new Error(`无法获取讯飞鉴权：${error instanceof Error ? error.message : '网络错误'}`);
    } finally {
      window.clearTimeout(timeout);
    }
    const payload = await response.json().catch(() => ({})) as { url?: string; appId?: string; expiresAt?: number; error?: string };
    if (!response.ok || !payload.url || !payload.appId) throw new Error(payload.error || `讯飞鉴权失败（HTTP ${response.status}）`);
    let endpoint: URL;
    try { endpoint = new URL(payload.url); } catch { throw new Error('讯飞鉴权服务返回了无效地址。'); }
    if (endpoint.protocol !== 'wss:' || endpoint.hostname !== IFLYTEK_HOST || endpoint.pathname !== '/v2/iat') {
      throw new Error('讯飞鉴权服务返回了非预期地址。');
    }
    return { url: endpoint.toString(), appId: payload.appId, expiresAt: payload.expiresAt } satisfies AuthPayload;
  }

  private async openSession(auth?: AuthPayload) {
    const epoch = ++this.sessionEpoch;
    const credentials = auth || await this.fetchAuth();
    if (this.stopping || epoch !== this.sessionEpoch) throw new Error('听写已停止');
    if (credentials.expiresAt && credentials.expiresAt <= Date.now() + 5000) throw new Error('讯飞鉴权地址已过期，请重新开启麦克风。');
    this.appId = credentials.appId;
    this.options.onStatus('connecting');

    return new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(credentials.url);
      this.socket = socket;
      this.firstFrame = true;
      this.waitingForFinal = false;
      this.pieces.clear();
      let opened = false;
      let settled = false;
      const finishConnect = (error?: Error) => {
        if (settled) return;
        settled = true;
        window.clearTimeout(connectTimeout);
        if (error) reject(error);
        else resolve();
      };
      const connectTimeout = window.setTimeout(() => {
        finishConnect(new Error('讯飞 WebSocket 连接超时，请检查当前网络后重试。'));
        try { socket.close(4000, 'connect timeout'); } catch { /* already closed */ }
      }, 9000);

      socket.onopen = () => {
        if (epoch !== this.sessionEpoch || this.stopping) {
          socket.close(1000, 'stale session');
          return;
        }
        opened = true;
        this.captureEnabled = true;
        this.options.onStatus('listening');
        this.scheduleRotation();
        finishConnect();
      };
      socket.onmessage = (event) => this.handleMessage(epoch, event.data);
      socket.onerror = () => {
        if (!opened) finishConnect(new Error(connectionErrorMessage()));
      };
      socket.onclose = (event) => {
        window.clearTimeout(connectTimeout);
        if (this.socket === socket) this.socket = null;
        if (epoch !== this.sessionEpoch) return;
        const expectedClose = this.waitingForFinal;
        this.finishCurrentText();
        if (!opened) {
          finishConnect(new Error(connectionErrorMessage(event.code, event.reason)));
          return;
        }
        if (this.stopping || expectedClose) return;
        this.scheduleReconnect(`连接关闭 ${event.code}${event.reason ? ` · ${event.reason}` : ''}`);
      };
    });
  }

  private combinedSessionText() {
    return [...this.pieces.entries()].sort((a, b) => a[0] - b[0]).map(([, text]) => text).join('').trim();
  }

  private fullText() {
    return `${this.completedText}${this.combinedSessionText()}`.trim();
  }

  private handleMessage(epoch: number, raw: unknown) {
    if (epoch !== this.sessionEpoch) return;
    try {
      if (typeof raw !== 'string') throw new Error('non-text response');
      const message = JSON.parse(raw) as XfyunMessage;
      if (message.code !== 0) {
        this.failPermanently(providerErrorMessage(message));
        return;
      }
      this.reconnectFailures = 0;
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
      this.failPermanently('讯飞返回了无法解析的听写结果，请刷新页面后重试。');
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

  private enqueue(samples: Int16Array) {
    for (let index = 0; index < samples.length; index += 1) this.pending.push(samples[index]);
  }

  private availableSamples() {
    return this.pending.length - this.pendingOffset;
  }

  private takeSamples(maximum: number, exact = false) {
    const available = this.availableSamples();
    if (exact && available < maximum) return new Int16Array();
    const count = Math.min(maximum, available);
    const result = Int16Array.from(this.pending.slice(this.pendingOffset, this.pendingOffset + count));
    this.pendingOffset += count;
    if (this.pendingOffset >= 8192 && this.pendingOffset * 2 >= this.pending.length) {
      this.pending = this.pending.slice(this.pendingOffset);
      this.pendingOffset = 0;
    }
    return result;
  }

  private sendAudioFrame() {
    const socket = this.socket;
    if (this.stopping || this.waitingForFinal || !socket || socket.readyState !== WebSocket.OPEN) return;
    const chunk = this.takeSamples(FRAME_SAMPLES, true);
    if (chunk.length !== FRAME_SAMPLES) return;
    const payload: Record<string, unknown> = {
      data: { status: this.firstFrame ? 0 : 1, format: AUDIO_FORMAT, encoding: 'raw', audio: int16ToBase64(chunk) },
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
    this.rotationTimer = window.setTimeout(() => void this.rotateSession(), SESSION_ROTATION_MS);
  }

  private async rotateSession() {
    if (this.stopping) return;
    this.captureEnabled = false;
    await this.endSocketSession();
    if (!this.stopping) await this.openSession().catch((error) => this.scheduleReconnect(error instanceof Error ? error.message : '轮换失败'));
  }

  private endSocketSession() {
    return new Promise<void>((resolve) => {
      const socket = this.socket;
      if (!socket || socket.readyState !== WebSocket.OPEN) {
        if (socket?.readyState === WebSocket.CONNECTING) {
          this.sessionEpoch += 1;
          try { socket.close(1000, 'cancelled'); } catch { /* already closed */ }
        }
        resolve();
        return;
      }
      this.waitingForFinal = true;
      if (this.rotationTimer) window.clearTimeout(this.rotationTimer);
      this.rotationTimer = null;

      const chunks: Int16Array[] = [];
      while (this.availableSamples() > 0) chunks.push(this.takeSamples(FRAME_SAMPLES));
      if (this.firstFrame && chunks.length === 0) {
        socket.close(1000, 'empty session');
        resolve();
        return;
      }

      const epoch = this.sessionEpoch;
      let completed = false;
      let sendTimer: number | null = null;
      let finalTimer: number | null = null;
      const done = () => {
        if (completed) return;
        completed = true;
        if (sendTimer) window.clearTimeout(sendTimer);
        if (finalTimer) window.clearTimeout(finalTimer);
        socket.removeEventListener('close', done);
        if (epoch === this.sessionEpoch) this.finishCurrentText();
        resolve();
      };
      socket.addEventListener('close', done, { once: true });

      const waitForProviderFinal = () => {
        finalTimer = window.setTimeout(() => {
          if (socket.readyState === WebSocket.OPEN) socket.close(1000, 'final timeout');
          done();
        }, 3500);
      };
      const sendEmptyTerminal = () => {
        if (completed || socket.readyState !== WebSocket.OPEN) return done();
        socket.send(JSON.stringify({ data: { status: 2, format: AUDIO_FORMAT, encoding: 'raw', audio: '' } }));
        waitForProviderFinal();
      };
      const sendChunk = (index: number) => {
        if (completed || socket.readyState !== WebSocket.OPEN) return done();
        const chunk = chunks[index];
        const opening = this.firstFrame;
        const last = index === chunks.length - 1;
        const payload: Record<string, unknown> = {
          data: { status: opening ? 0 : last ? 2 : 1, format: AUDIO_FORMAT, encoding: 'raw', audio: int16ToBase64(chunk) },
        };
        if (opening) {
          payload.common = { app_id: this.appId };
          payload.business = { language: 'zh_cn', domain: 'iat', accent: 'mandarin', dwa: 'wpgs', vad_eos: 10000 };
          this.firstFrame = false;
        }
        socket.send(JSON.stringify(payload));
        if (opening && last) sendTimer = window.setTimeout(sendEmptyTerminal, FRAME_INTERVAL_MS);
        else if (last) waitForProviderFinal();
        else sendTimer = window.setTimeout(() => sendChunk(index + 1), FRAME_INTERVAL_MS);
      };

      if (chunks.length) sendChunk(0);
      else sendEmptyTerminal();
    });
  }

  private scheduleReconnect(reason: string) {
    if (this.stopping || this.reconnectTimer) return;
    this.captureEnabled = false;
    this.pending = [];
    this.pendingOffset = 0;
    this.resampler.reset();
    this.reconnectFailures += 1;
    if (this.reconnectFailures >= 4) {
      this.failPermanently(`讯飞实时听写连续重连失败（${reason}）。请检查网络或讯飞 IP 白名单后重新开启麦克风。`);
      return;
    }
    this.options.onStatus('connecting');
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      void this.openSession().catch((error) => this.scheduleReconnect(error instanceof Error ? error.message : '重新连接失败'));
    }, Math.min(3000, 500 * this.reconnectFailures));
  }

  private clearTimers() {
    if (this.frameTimer) window.clearInterval(this.frameTimer);
    if (this.rotationTimer) window.clearTimeout(this.rotationTimer);
    if (this.reconnectTimer) window.clearTimeout(this.reconnectTimer);
    this.frameTimer = null;
    this.rotationTimer = null;
    this.reconnectTimer = null;
  }

  private failPermanently(message: string) {
    if (this.stopping) return;
    this.stopping = true;
    this.captureEnabled = false;
    this.clearTimers();
    this.finishCurrentText();
    this.options.onError(message);
    this.releaseMedia();
    this.options.onStatus('closed');
  }

  async stop() {
    if (this.stopping) return;
    this.stopping = true;
    this.captureEnabled = false;
    this.options.onStatus('finishing');
    this.clearTimers();
    await this.endSocketSession();
    this.finishCurrentText();
    this.releaseMedia();
    this.options.onStatus('closed');
  }

  private releaseMedia() {
    this.sessionEpoch += 1;
    this.captureEnabled = false;
    const socket = this.socket;
    if (socket && socket.readyState < WebSocket.CLOSING) {
      try { socket.close(1000, 'transcriber closed'); } catch { /* already closed */ }
    }
    try { this.source?.disconnect(); } catch { /* disconnected */ }
    try { this.processor?.disconnect(); } catch { /* disconnected */ }
    try { this.silentSink?.disconnect(); } catch { /* disconnected */ }
    if (this.processor) this.processor.onaudioprocess = null;
    this.stream?.getTracks().forEach((track) => track.stop());
    if (this.audioContext && this.audioContext.state !== 'closed') void this.audioContext.close();
    this.socket = null;
    this.stream = null;
    this.audioContext = null;
    this.source = null;
    this.processor = null;
    this.silentSink = null;
  }
}
