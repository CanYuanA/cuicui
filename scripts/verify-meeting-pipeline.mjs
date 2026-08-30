import { createHash, createHmac } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import ffmpegPath from 'ffmpeg-static';
import { fixture, speakerFor } from './meeting-fixture.mjs';

const root = resolve(import.meta.dirname, '..');
const demoDir = join(root, 'public', 'demo');
const evidenceDir = join(demoDir, 'evidence');
const workDir = join(root, 'work', 'audio-proof');
const manifestPath = join(demoDir, 'audio-manifest.json');
const outputPath = join(demoDir, 'verified-run.json');
const progressPath = join(workDir, 'verification-progress.json');
let demoSessionToken = '';
let accessCookie = '';

function readEnv(path) {
  const values = {};
  if (!existsSync(path)) return values;
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^([^#=]+)=(.*)$/);
    if (match) values[match[1].trim()] = match[2].trim();
  }
  return values;
}

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function runFfmpeg(args) {
  const result = spawnSync(ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-y', ...args], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`ffmpeg 失败：${result.stderr || result.stdout}`);
}

function toSignedUrl(env) {
  const host = 'iat-api.xfyun.cn';
  const requestPath = '/v2/iat';
  const date = new Date().toUTCString();
  const origin = `host: ${host}\ndate: ${date}\nGET ${requestPath} HTTP/1.1`;
  const signature = createHmac('sha256', env.IFLYTEK_API_SECRET).update(origin).digest('base64');
  const authorization = Buffer.from(`api_key="${env.IFLYTEK_API_KEY}", algorithm="hmac-sha256", headers="host date request-line", signature="${signature}"`).toString('base64');
  const query = new URLSearchParams({ authorization, date, host });
  return `wss://${host}${requestPath}?${query.toString()}`;
}

function combinePieces(pieces) {
  return [...pieces.entries()].sort((a, b) => a[0] - b[0]).map(([, value]) => value).join('').trim();
}

function normalizeChinese(value) {
  return String(value || '').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
}

function similarity(leftValue, rightValue) {
  const left = [...normalizeChinese(leftValue)];
  const right = [...normalizeChinese(rightValue)];
  if (!left.length && !right.length) return 1;
  if (!left.length || !right.length) return 0;
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let row = 1; row <= left.length; row += 1) {
    const current = [row];
    for (let column = 1; column <= right.length; column += 1) {
      current[column] = Math.min(current[column - 1] + 1, previous[column] + 1, previous[column - 1] + (left[row - 1] === right[column - 1] ? 0 : 1));
    }
    previous = current;
  }
  return Math.max(0, 1 - previous[right.length] / Math.max(left.length, right.length));
}

function transcribePcm(pcm, env, label) {
  return new Promise((resolvePromise, rejectPromise) => {
    const pieces = new Map();
    const messages = [];
    const socket = new WebSocket(toSignedUrl(env));
    let frameIndex = 0;
    let settled = false;
    let frameTimer = null;
    let totalTimeout = null;
    const frames = Math.max(1, Math.ceil(pcm.length / 1280));
    const finish = (error) => {
      if (settled) return;
      settled = true;
      if (frameTimer) clearTimeout(frameTimer);
      if (totalTimeout) clearTimeout(totalTimeout);
      try { socket.close(); } catch { /* already closed */ }
      if (error) rejectPromise(error);
      else resolvePromise({ label, text: combinePieces(pieces), messages, frameCount: frames });
    };
    totalTimeout = setTimeout(() => finish(new Error(`${label} 识别超时`)), Math.max(60000, frames * 40 + 45000));

    socket.addEventListener('open', () => {
      const sendNext = () => {
        if (settled || socket.readyState !== WebSocket.OPEN) return;
        if (frameIndex >= frames) return;
        const start = frameIndex * 1280;
        const end = Math.min(pcm.length, start + 1280);
        const audio = pcm.subarray(start, end).toString('base64');
        const isFirst = frameIndex === 0;
        const isLast = frameIndex === frames - 1;
        const payload = {
          data: { status: isFirst ? 0 : isLast ? 2 : 1, format: 'audio/L16;rate=16000', encoding: 'raw', audio },
        };
        if (isFirst) {
          payload.common = { app_id: env.IFLYTEK_APP_ID };
          payload.business = { language: 'zh_cn', domain: 'iat', accent: 'mandarin', dwa: 'wpgs', vad_eos: 10000 };
        }
        socket.send(JSON.stringify(payload));
        frameIndex += 1;
        if (isFirst && isLast) {
          frameTimer = setTimeout(() => socket.send(JSON.stringify({ data: { status: 2, format: 'audio/L16;rate=16000', encoding: 'raw', audio: '' } })), 40);
        } else if (!isLast) frameTimer = setTimeout(sendNext, 40);
      };
      sendNext();
    });
    socket.addEventListener('message', (event) => {
      try {
        const message = JSON.parse(String(event.data));
        messages.push(message);
        if (message.code !== 0) return finish(new Error(`${label} 讯飞错误 ${message.code}: ${message.message || ''}`));
        const result = message.data?.result;
        if (result) {
          if (result.pgs === 'rpl' && Array.isArray(result.rg)) for (let index = result.rg[0]; index <= result.rg[1]; index += 1) pieces.delete(index);
          pieces.set(result.sn, (result.ws || []).map((item) => item.cw?.[0]?.w || '').join(''));
        }
        if (message.data?.status === 2) {
          finish();
        }
      } catch (error) { finish(error); }
    });
    socket.addEventListener('error', () => finish(new Error(`${label} WebSocket 连接失败`)));
    socket.addEventListener('close', () => { if (!settled) finish(new Error(`${label} 在收到讯飞终态前关闭`)); });
  });
}

function decodeToPcm(input, output) {
  runFfmpeg(['-i', input, '-vn', '-f', 's16le', '-acodec', 'pcm_s16le', '-ar', '16000', '-ac', '1', output]);
  return readFileSync(output);
}

function slicePcm(pcm, fromSeconds, toSeconds) {
  const bytesPerSecond = 16000 * 2;
  return pcm.subarray(Math.floor(fromSeconds * bytesPerSecond), Math.min(pcm.length, Math.floor(toSeconds * bytesPerSecond)));
}

async function callApi(path, body) {
  const response = await fetch(`http://localhost:3000${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: accessCookie, 'X-Cuicui-Session': demoSessionToken }, body: JSON.stringify(body), signal: AbortSignal.timeout(30000),
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(`${path} ${response.status}: ${JSON.stringify(payload).slice(0, 400)}`);
  return payload;
}

async function main() {
  mkdirSync(evidenceDir, { recursive: true });
  mkdirSync(workDir, { recursive: true });
  const env = { ...readEnv(join(root, '.env.local')), ...process.env };
  for (const key of ['IFLYTEK_APP_ID', 'IFLYTEK_API_KEY', 'IFLYTEK_API_SECRET', 'SITE_ACCESS_PASSWORD']) if (!env[key]) throw new Error(`缺少 ${key}`);
  if (!existsSync(manifestPath)) throw new Error('请先运行 generate-meeting-audio.mjs');
  const healthResponse = await fetch('http://localhost:3000/api/health', { signal: AbortSignal.timeout(5000) });
  if (!healthResponse.ok) throw new Error(`本地应用预检失败：HTTP ${healthResponse.status}`);
  const health = await healthResponse.json();
  if (!health.services?.openrouter || !health.services?.iflytek) throw new Error('本地应用预检失败：真实 AI/讯飞服务未就绪');
  const loginResponse = await fetch('http://localhost:3000/api/access/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: env.SITE_ACCESS_PASSWORD }), signal: AbortSignal.timeout(5000),
  });
  accessCookie = (loginResponse.headers.get('set-cookie') || '').split(';')[0];
  if (!loginResponse.ok || !accessCookie) throw new Error('本地应用预检失败：访问密码验证失败');
  const sessionResponse = await fetch('http://localhost:3000/api/demo-session', { method: 'POST', headers: { Cookie: accessCookie }, signal: AbortSignal.timeout(5000) });
  const session = await sessionResponse.json();
  if (!sessionResponse.ok || !session.token) throw new Error('本地应用预检失败：无法创建受控体验会话');
  demoSessionToken = session.token;
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  let masterSessions = [];
  let transcript = [];
  let utteranceSessions = [];
  const masterChunkSeconds = 20;
  const expectedMasterSessions = Math.ceil(fixture.meeting.durationSeconds / masterChunkSeconds);
  const rejectedPath = join(workDir, 'rejected-verification.json');
  const rawEvidencePath = join(evidenceDir, 'iflytek-raw.json');
  for (const candidatePath of [outputPath, rejectedPath]) {
    try {
      const previous = JSON.parse(readFileSync(candidatePath, 'utf8'));
      const raw = JSON.parse(readFileSync(rawEvidencePath, 'utf8'));
      if (previous.provenance?.sourceAudioSha256 === manifest.artifacts.master.sha256 && previous.transcript?.length === fixture.utterances.length && raw.master?.length === expectedMasterSessions && raw.utterances?.length === fixture.utterances.length) {
        masterSessions = raw.master; transcript = previous.transcript; utteranceSessions = raw.utterances;
        console.log('reusing hash-matched iFlytek evidence; only AI analysis/report will rerun');
        break;
      }
    } catch { /* try the next reusable proof candidate */ }
  }

  if (!transcript.length) {
    const masterPcmPath = join(workDir, 'master.pcm');
    const masterPcm = decodeToPcm(join(demoDir, 'meeting-master-asr.wav'), masterPcmPath);
    const cuts = Array.from({ length: expectedMasterSessions + 1 }, (_, index) => Math.min(fixture.meeting.durationSeconds, index * masterChunkSeconds));
    for (let index = 0; index < cuts.length - 1; index += 1) {
      const label = `master-${index + 1}`;
      console.log(`transcribing ${label} ${cuts[index]}-${cuts[index + 1]}s`);
      masterSessions.push(await transcribePcm(slicePcm(masterPcm, cuts[index], cuts[index + 1]), env, label));
    }

    for (let index = 0; index < fixture.utterances.length; index += 1) {
      const utterance = fixture.utterances[index];
      const segment = manifest.utterances[index].audio.filename;
      const pcmPath = join(workDir, `${utterance.id}.pcm`);
      const pcm = decodeToPcm(join(demoDir, 'segments', segment), pcmPath);
      console.log(`transcribing ${utterance.id}`);
      const result = await transcribePcm(pcm, env, utterance.id);
      utteranceSessions.push(result);
      const speaker = speakerFor(utterance.speakerId);
      const spokenSeconds = Number(manifest.utterances[index]?.audio?.durationSeconds) || Math.max(1, utterance.text.length / 4.5);
      const spokenEnd = Math.min(fixture.meeting.durationSeconds, utterance.start + spokenSeconds);
      transcript.push({ id: utterance.id, at: utterance.start, end: spokenEnd, speakerId: utterance.speakerId, speaker: speaker.name, text: result.text, expectedText: utterance.text, topic: utterance.topic, workRelated: utterance.workRelated, interrupted: Boolean(utterance.interrupted), asrSource: 'iflytek-iat' });
      writeFileSync(progressPath, `${JSON.stringify({ masterSessions, utteranceSessions, transcript }, null, 2)}\n`);
    }
  }

  let events = [];
  let analysisRuns = [];
  try {
    const previous = JSON.parse(readFileSync(outputPath, 'utf8'));
    if (previous.analysisRulesVersion === 'intervention-ladder-v4' && previous.provenance?.sourceAudioSha256 === manifest.artifacts.master.sha256 && previous.analysisRuns?.length === transcript.length && previous.analysisRuns.every((run) => run.source === 'openrouter') && previous.events?.every((event) => event.type && event.level)) {
      events = previous.events; analysisRuns = previous.analysisRuns;
      console.log('reusing verified OpenRouter analysis runs; only report will rerun');
    }
  } catch { /* analysis must run */ }
  if (!analysisRuns.length) {
    for (let index = 0; index < transcript.length; index += 1) {
      const snapshot = transcript.slice(0, index + 1);
      const analysis = await callApi('/api/analyze', {
        meeting: { title: fixture.meeting.title, type: fixture.meeting.meetingType, durationSeconds: fixture.meeting.durationSeconds, agenda: fixture.meeting.agenda },
        elapsedSeconds: snapshot.at(-1).end,
        previousEvents: events.map(({ id, at, type, level, priority, incidentKey, occurrence }) => ({ id, at, type, level, priority, incidentKey, occurrence })),
        transcript: snapshot.map(({ id, speakerId, speaker, text, at, end, workRelated, interrupted }) => ({ id, speakerId, speaker, text, at, end, workRelated, interrupted })),
      });
      analysisRuns.push({ at: snapshot.at(-1).end, source: analysis.source, model: analysis.model || null, usage: analysis.usage || null, events: analysis.events || [] });
      for (const [eventIndex, event] of (analysis.events || []).entries()) {
        events.push({
          ...event,
          id: `verified-${event.type}-${analysisRuns.length}-${eventIndex}`,
          at: Number.isFinite(Number(event.at)) ? Number(event.at) : snapshot.at(-1).end,
          actions: event.level === 'L0' ? [] : event.level === 'L2' ? ['adopt', 'park'] : ['adopt', 'ignore'],
        });
      }
    }
  }
  const report = await callApi('/api/report', {
    meeting: { ...fixture.meeting, attendees: fixture.speakers.map(({ id, name }) => ({ id, name })) },
    actualSeconds: fixture.meeting.durationSeconds,
    transcript,
    events,
  });

  const safeSessions = (sessions) => sessions.map((session) => ({
    label: session.label,
    text: session.text,
    frameCount: session.frameCount,
    messages: session.messages.map((message) => ({ code: message.code, message: message.message, sid: message.sid, data: message.data })),
  }));
  const segmentSimilarities = transcript.map((line) => similarity(line.expectedText, line.text));
  const averageSegmentSimilarity = segmentSimilarities.reduce((sum, value) => sum + value, 0) / Math.max(1, segmentSimilarities.length);
  const masterText = masterSessions.map((session) => session.text).join('');
  const evidence = {
    schemaVersion: 2,
    analysisRulesVersion: 'intervention-ladder-v4',
    scoringVersion: 'meeting-radar-v3',
    verifiedAt: new Date().toISOString(),
    provenance: {
      kind: 'real-pipeline-run',
      statement: '录音由 MiniMax Speech 2.8 HD 逐角色生成并混音；每个真实音频片段和完整 master 均通过讯飞 IAT，随后调用本项目 analyze/report 接口。',
      sourceAudioSha256: manifest.artifacts.master.sha256,
      sourceAsrWavSha256: sha256(join(demoDir, 'meeting-master-asr.wav')),
    },
    meeting: { ...fixture.meeting, attendees: fixture.speakers.map(({ id, name, short, role, color, isPriority }) => ({ id, name, short, role, color, isPriority })) },
    audio: manifest,
    pipeline: {
      tts: { provider: 'OpenRouter', model: 'minimax/speech-2.8-hd' },
      asr: { provider: '科大讯飞', protocol: 'IAT WebAPI /v2/iat', frame: '40ms / 1280 bytes', rollingSessions: true },
      analysis: { endpoint: '/api/analyze', sources: [...new Set(analysisRuns.map((run) => run.source))], models: [...new Set(analysisRuns.map((run) => run.model).filter(Boolean))] },
      report: { endpoint: '/api/report', source: report.source, model: report.model || null, usage: report.usage || null },
    },
    masterAsr: { text: masterText, sessions: safeSessions(masterSessions) },
    transcript,
    analysisRuns,
    events,
    report,
    checks: {
      audioExists: statSync(join(demoDir, 'meeting-master-assistant-plan-v1.mp3')).size > 1000,
      audioHashMatches: sha256(join(demoDir, 'meeting-master-assistant-plan-v1.mp3')) === manifest.artifacts.master.sha256,
      everyUtteranceRecognized: transcript.every((line) => line.text.trim().length > 0),
      iflytekEverySessionSucceeded: [...masterSessions, ...utteranceSessions].every((session) => session.messages.some((message) => message.code === 0 && message.data?.status === 2)),
      masterRecognized: normalizeChinese(masterText).length >= 80,
      segmentAccuracyAcceptable: averageSegmentSimilarity >= 0.55 && segmentSimilarities.every((value) => value >= 0.2),
      analysisWasInvoked: analysisRuns.length === transcript.length,
      analysisUsedOpenRouter: analysisRuns.every((run) => run.source === 'openrouter'),
      reportWasInvoked: Boolean(report.summary),
      reportUsedOpenRouter: report.source === 'openrouter',
      reportShapeValid: typeof report.verdict === 'string' && typeof report.necessityReason === 'string' && Array.isArray(report.decisions) && Array.isArray(report.actions) && Array.isArray(report.suggestions),
      reportActionsClean: report.actions.every((action) => !/(?:会议结束|散会)/.test(String(action.task || ''))
        && !fixture.speakers.some((speaker) => speaker.name !== action.owner && String(action.task || '').includes(speaker.name))),
      interventionLadderValid: events.some((event) => event.level === 'L0') && events.some((event) => event.level === 'L1') && events.some((event) => event.level === 'L2'),
      disagreementDetected: events.some((event) => event.type === 'disagreement' && event.level !== 'L0'),
      disagreementEscalationValid: events.filter((event) => event.type === 'disagreement' && event.incidentKey === 'disagreement:current-agenda').slice(0, 2).map((event) => event.level).join(',') === 'L1,L2',
      interruptionCountReduced: events.filter((event) => event.type === 'interrupt').length >= 1 && events.filter((event) => event.type === 'interrupt').length <= 2,
      interruptNeverDominates: events.filter((event) => event.type === 'interrupt').every((event) => event.level !== 'L2' && event.priority < 200),
      sequentialDisagreementIsNotInterrupt: transcript.some((line, index) => line.id === 'u10' && transcript[index + 1]?.id === 'u11' && line.end <= transcript[index + 1].at),
      scoreShapeValid: Array.isArray(report.scores) && report.scores.length === 5 && report.scores.every((score) => Number.isFinite(score.value) && score.value >= 0 && score.value <= 100),
    },
    quality: { averageSegmentSimilarity, segmentSimilarities },
  };
  const verified = Object.values(evidence.checks).every(Boolean);
  writeFileSync(join(evidenceDir, 'iflytek-raw.json'), `${JSON.stringify({ master: safeSessions(masterSessions), utterances: safeSessions(utteranceSessions) }, null, 2)}\n`);
  const resultPath = verified ? outputPath : join(workDir, 'rejected-verification.json');
  writeFileSync(resultPath, `${JSON.stringify(evidence, null, 2)}\n`);
  console.log(JSON.stringify({ ok: verified, output: resultPath, checks: evidence.checks, quality: evidence.quality, transcriptCharacters: transcript.reduce((sum, line) => sum + line.text.length, 0), events: events.map((event) => event.type), reportSource: report.source }, null, 2));
  if (!verified) throw new Error(`真实链路证据未通过全部检查，详见 ${resultPath}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});
