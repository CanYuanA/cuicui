import { accessErrorResponse, authorizeDemo } from '../../server/demo-access';

type TranscribeRequest = {
  audioBase64?: string;
  format?: string;
  language?: string;
};

const allowedFormats = new Set(['wav', 'mp3', 'flac', 'm4a', 'ogg', 'webm', 'aac']);

export async function POST(request: Request) {
  try { authorizeDemo(request, 'transcribe'); } catch (error) { return accessErrorResponse(error) || Response.json({ error: '转写服务暂不可用' }, { status: 500 }); }
  if (Number(request.headers.get('content-length') || 0) > 1_500_000) return Response.json({ error: '音频请求超过 1.5MB 限制' }, { status: 413 });
  let input: TranscribeRequest;
  try {
    input = await request.json() as TranscribeRequest;
  } catch {
    return Response.json({ error: '音频请求格式无效' }, { status: 400 });
  }

  const audioBase64 = String(input.audioBase64 || '');
  const format = String(input.format || 'webm').toLowerCase();
  if (!allowedFormats.has(format)) return Response.json({ error: '不支持的音频格式' }, { status: 400 });
  if (!audioBase64 || audioBase64.length > 1_200_000 || !/^[A-Za-z0-9+/=]+$/.test(audioBase64)) return Response.json({ error: '音频为空、格式无效或超过 0.9MB 限制' }, { status: 400 });

  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) return Response.json({ error: 'HTTP 转写服务尚未配置' }, { status: 503 });
  const model = process.env.OPENROUTER_STT_MODEL || 'qwen/qwen3-asr-1.7b';

  try {
    const response = await fetch('https://openrouter.ai/api/v1/audio/transcriptions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': process.env.PUBLIC_SITE_URL || 'http://localhost:3000',
        'X-Title': 'Cuicui Live Meeting Transcription',
      },
      body: JSON.stringify({
        model,
        input_audio: { data: audioBase64, format },
        language: input.language || 'zh',
        temperature: 0,
      }),
      signal: AbortSignal.timeout(45000),
    });
    const payload = await response.json().catch(() => ({})) as { text?: string; usage?: unknown; error?: { message?: string; metadata?: { raw?: string } } };
    if (!response.ok) throw new Error(payload.error?.metadata?.raw || payload.error?.message || `OpenRouter ${response.status}`);
    return Response.json({ text: String(payload.text || '').trim(), source: 'openrouter-stt', model, usage: payload.usage || null });
  } catch (error) {
    console.error('transcribe-upstream', error);
    return Response.json({ error: 'HTTP 转写暂不可用，请稍后重试' }, { status: 502 });
  }
}
