export type TranscriberStatus = 'requesting' | 'connecting' | 'listening' | 'finishing' | 'closed';

type Options = {
  onPartial: (text: string) => void;
  onFinal: (text: string) => void;
  onStatus: (status: TranscriberStatus) => void;
  onError: (message: string) => void;
};

type XfyunResult = {
  sn: number;
  pgs?: 'apd' | 'rpl';
  rg?: [number, number];
  ws?: Array<{ cw?: Array<{ w?: string }> }>;
};

function int16ToBase64(samples: Int16Array) {
  const bytes = new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength);
  let binary = '';
  const batch = 8192;
  for (let index = 0; index < bytes.length; index += batch) {
    binary += String.fromCharCode(...bytes.subarray(index, index + batch));
  }
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

export class XfyunTranscriber {
  private options: Options;
  private socket: WebSocket | null = null;
  private stream: MediaStream | null = null;
  private audioContext: AudioContext | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private processor: ScriptProcessorNode | null = null;
  private pending: number[] = [];
  private pieces = new Map<number, string>();
  private firstFrame = true;
  private stopping = false;
  private finalSent = false;
  private appId = '';

  constructor(options: Options) {
    this.options = options;
  }

  async start() {
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error('当前浏览器不支持麦克风采集，请使用最新版 Chrome 或 Edge。');
    }

    this.options.onStatus('requesting');
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      video: false,
    });
    this.stream = stream;

    const response = await fetch('/api/iflytek-auth', { cache: 'no-store' });
    const payload = await response.json() as { url?: string; appId?: string; error?: string };
    if (!response.ok || !payload.url || !payload.appId) {
      this.releaseMedia();
      throw new Error(payload.error || '讯飞听写服务尚未配置。');
    }
    this.appId = payload.appId;

    this.options.onStatus('connecting');
    const socket = new WebSocket(payload.url);
    this.socket = socket;

    socket.onopen = async () => {
      if (this.stopping) return;
      const AudioContextClass = window.AudioContext;
      const context = new AudioContextClass({ latencyHint: 'interactive' });
      this.audioContext = context;
      if (context.state === 'suspended') await context.resume();
      const source = context.createMediaStreamSource(stream);
      const processor = context.createScriptProcessor(4096, 1, 1);
      this.source = source;
      this.processor = processor;
      processor.onaudioprocess = (event) => {
        if (this.stopping || socket.readyState !== WebSocket.OPEN) return;
        const mono = event.inputBuffer.getChannelData(0);
        const pcm = floatToInt16(resampleTo16k(mono, context.sampleRate));
        for (const sample of pcm) this.pending.push(sample);
        this.flushFrames(false, payload.appId!);
      };
      source.connect(processor);
      processor.connect(context.destination);
      this.options.onStatus('listening');
    };

    socket.onmessage = (event) => {
      try {
        const message = JSON.parse(event.data) as {
          code?: number;
          message?: string;
          sid?: string;
          data?: { status?: number; result?: XfyunResult };
        };
        if (message.code !== 0) {
          this.options.onError(`讯飞听写返回错误：${message.message || message.code}${message.sid ? `（${message.sid}）` : ''}`);
          return;
        }
        if (message.data?.result) this.applyResult(message.data.result);
        if (message.data?.status === 2) {
          const text = this.combinedText();
          if (text) this.options.onFinal(text);
          socket.close(1000, 'recognition complete');
        }
      } catch {
        this.options.onError('收到无法解析的听写结果。');
      }
    };

    socket.onerror = () => this.options.onError('无法连接讯飞听写，请检查网络或应用服务权限。');
    socket.onclose = () => {
      if (!this.finalSent) {
        const text = this.combinedText();
        if (text) this.options.onFinal(text);
      }
      this.releaseMedia();
      this.options.onStatus('closed');
    };
  }

  private applyResult(result: XfyunResult) {
    const fragment = (result.ws ?? []).map((item) => item.cw?.[0]?.w ?? '').join('');
    if (result.pgs === 'rpl' && Array.isArray(result.rg)) {
      for (let sn = result.rg[0]; sn <= result.rg[1]; sn += 1) this.pieces.delete(sn);
    }
    this.pieces.set(result.sn, fragment);
    this.options.onPartial(this.combinedText());
  }

  private combinedText() {
    return [...this.pieces.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([, text]) => text)
      .join('')
      .trim();
  }

  private flushFrames(final: boolean, appId: string) {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    while (this.pending.length >= 640 || (final && this.pending.length > 0)) {
      const size = this.pending.length >= 640 ? 640 : this.pending.length;
      const chunk = new Int16Array(this.pending.splice(0, size));
      const isLast = final && this.pending.length === 0;
      const status = this.firstFrame ? 0 : isLast ? 2 : 1;
      const frame: Record<string, unknown> = {
        data: {
          status,
          format: 'audio/L16;rate=16000',
          encoding: 'raw',
          audio: int16ToBase64(chunk),
        },
      };
      if (this.firstFrame) {
        frame.common = { app_id: appId };
        frame.business = {
          language: 'zh_cn', domain: 'iat', accent: 'mandarin', dwa: 'wpgs', vad_eos: 3000,
        };
      }
      socket.send(JSON.stringify(frame));
      this.firstFrame = false;
      if (isLast) this.finalSent = true;
    }

    if (final && !this.finalSent) {
      const status = this.firstFrame ? 0 : 2;
      const frame: Record<string, unknown> = {
        data: { status, format: 'audio/L16;rate=16000', encoding: 'raw', audio: '' },
      };
      if (this.firstFrame) {
        frame.common = { app_id: appId };
        frame.business = { language: 'zh_cn', domain: 'iat', accent: 'mandarin', dwa: 'wpgs', vad_eos: 3000 };
      }
      socket.send(JSON.stringify(frame));
      this.firstFrame = false;
      this.finalSent = true;
    }
  }

  async stop() {
    if (this.stopping) return;
    this.stopping = true;
    this.options.onStatus('finishing');
    if (this.processor) this.processor.onaudioprocess = null;
    this.flushFrames(true, this.appId);
    this.releaseMedia(false);
    window.setTimeout(() => {
      if (this.socket?.readyState === WebSocket.OPEN) this.socket.close(1000, 'client timeout');
      this.releaseMedia();
    }, 2500);
  }

  private releaseMedia(closeContext = true) {
    try { this.source?.disconnect(); } catch { /* already disconnected */ }
    try { this.processor?.disconnect(); } catch { /* already disconnected */ }
    this.stream?.getTracks().forEach((track) => track.stop());
    if (closeContext && this.audioContext && this.audioContext.state !== 'closed') void this.audioContext.close();
    this.source = null;
    this.processor = null;
    this.stream = null;
  }
}
