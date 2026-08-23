import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import ffmpegPath from 'ffmpeg-static';
import { fixture, speakerFor } from './meeting-fixture.mjs';

const root = resolve(import.meta.dirname, '..');
const outputDir = join(root, 'public', 'demo');
const segmentDir = join(outputDir, 'segments');
const stemDir = join(outputDir, 'stems');
const manifestPath = join(outputDir, 'audio-manifest.json');
const masterPath = join(outputDir, 'meeting-master.mp3');
const asrPath = join(outputDir, 'meeting-master-asr.wav');

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

function durationOf(path) {
  const result = spawnSync(ffmpegPath, ['-hide_banner', '-i', path, '-f', 'null', '-'], { encoding: 'utf8' });
  const match = `${result.stderr || ''}`.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
  return match ? Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]) : null;
}

async function generateSegment(utterance, apiKey, previous) {
  const speaker = speakerFor(utterance.speakerId);
  const index = fixture.utterances.indexOf(utterance) + 1;
  const filename = `${String(index).padStart(2, '0')}-${utterance.id}-${utterance.speakerId}.mp3`;
  const path = join(segmentDir, filename);
  if (existsSync(path) && statSync(path).size > 1000) {
    return { filename, generationId: previous?.generationId || 'cached', bytes: statSync(path).size, sha256: sha256(path), durationSeconds: durationOf(path) };
  }

  let lastError;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      const response = await fetch('https://openrouter.ai/api/v1/audio/speech', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': 'http://localhost:3000',
          'X-Title': 'Cuicui Verified Meeting Audio',
        },
        body: JSON.stringify({
          model: 'minimax/speech-2.8-hd',
          input: utterance.tts || utterance.text,
          voice: speaker.voice,
          response_format: 'mp3',
        }),
        signal: AbortSignal.timeout(60000),
      });
      if (!response.ok) throw new Error(`OpenRouter ${response.status}: ${(await response.text()).slice(0, 300)}`);
      const bytes = Buffer.from(await response.arrayBuffer());
      if (bytes.length < 1000) throw new Error('返回的音频过短');
      writeFileSync(path, bytes);
      return {
        filename,
        generationId: response.headers.get('x-generation-id') || 'unknown',
        bytes: bytes.length,
        sha256: sha256(path),
        durationSeconds: durationOf(path),
      };
    } catch (error) {
      lastError = error;
      if (attempt < 2) await new Promise((resolvePromise) => setTimeout(resolvePromise, 1200));
    }
  }
  throw lastError;
}

function buildMix(segmentRecords) {
  const inputs = segmentRecords.flatMap((record) => ['-i', join(segmentDir, record.filename)]);
  const noiseIndex = segmentRecords.length;
  inputs.push('-f', 'lavfi', '-t', String(fixture.meeting.durationSeconds), '-i', 'anoisesrc=color=pink:amplitude=0.0012:sample_rate=32000');
  const filtered = fixture.utterances.map((utterance, index) => {
    const speaker = speakerFor(utterance.speakerId);
    return `[${index}:a]volume=${speaker.volume},adelay=${Math.round(utterance.start * 1000)}:all=1[a${index}]`;
  });
  filtered.push(`[${noiseIndex}:a]volume=0.16[room]`);
  const mixInputs = [...fixture.utterances.map((_, index) => `[a${index}]`), '[room]'].join('');
  filtered.push(`${mixInputs}amix=inputs=${fixture.utterances.length + 1}:duration=longest:dropout_transition=0:normalize=0,loudnorm=I=-18:TP=-1.5:LRA=11,alimiter=limit=0.92,atrim=0:${fixture.meeting.durationSeconds},asplit=2[mixmp3][mixwav]`);
  runFfmpeg([
    ...inputs, '-filter_complex', filtered.join(';'),
    '-map', '[mixmp3]', '-ar', '32000', '-ac', '1', '-b:a', '128k', masterPath,
    '-map', '[mixwav]', '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', asrPath,
  ]);
}

function buildStems(segmentRecords) {
  for (const speaker of fixture.speakers) {
    const selected = fixture.utterances.map((utterance, index) => ({ utterance, index })).filter(({ utterance }) => utterance.speakerId === speaker.id);
    const inputs = selected.flatMap(({ index }) => ['-i', join(segmentDir, segmentRecords[index].filename)]);
    const filtered = selected.map(({ utterance }, localIndex) => `[${localIndex}:a]volume=${speaker.volume},adelay=${Math.round(utterance.start * 1000)}:all=1[s${localIndex}]`);
    const labels = selected.map((_, index) => `[s${index}]`).join('');
    filtered.push(`${labels}amix=inputs=${selected.length}:duration=longest:dropout_transition=0:normalize=0,alimiter=limit=0.92,apad=pad_dur=${fixture.meeting.durationSeconds},atrim=0:${fixture.meeting.durationSeconds}[stem]`);
    runFfmpeg([...inputs, '-filter_complex', filtered.join(';'), '-map', '[stem]', '-ar', '32000', '-ac', '1', '-b:a', '96k', join(stemDir, `${speaker.id}.mp3`)]);
  }
}

async function main() {
  mkdirSync(segmentDir, { recursive: true });
  mkdirSync(stemDir, { recursive: true });
  const env = { ...readEnv(join(root, '.env.local')), ...process.env };
  const apiKey = env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error('缺少 OPENROUTER_API_KEY');
  let previousManifest = null;
  try { previousManifest = JSON.parse(readFileSync(manifestPath, 'utf8')); } catch { /* first run */ }

  const segmentRecords = [];
  for (const utterance of fixture.utterances) {
    const previous = previousManifest?.utterances?.find((item) => item.id === utterance.id)?.audio;
    const record = await generateSegment(utterance, apiKey, previous);
    segmentRecords.push(record);
    console.log(`generated ${utterance.id} ${record.bytes} bytes`);
  }
  buildMix(segmentRecords);
  buildStems(segmentRecords);

  const totalCharacters = fixture.utterances.reduce((sum, item) => sum + (item.tts || item.text).length, 0);
  const manifest = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    provider: 'OpenRouter',
    model: 'minimax/speech-2.8-hd',
    totalCharacters,
    estimatedTtsCostUsd: Number((totalCharacters * 0.0001).toFixed(6)),
    meeting: fixture.meeting,
    speakers: fixture.speakers.map(({ voice, volume, ...speaker }) => ({ ...speaker, voiceId: voice, mixVolume: volume })),
    utterances: fixture.utterances.map((utterance, index) => ({ ...utterance, tts: utterance.tts || utterance.text, audio: segmentRecords[index] })),
    artifacts: {
      master: { path: '/demo/meeting-master.mp3', sha256: sha256(masterPath), bytes: statSync(masterPath).size, durationSeconds: durationOf(masterPath) },
      asrWav: { path: '/demo/meeting-master-asr.wav', sha256: sha256(asrPath), bytes: statSync(asrPath).size, format: '16kHz mono PCM16 WAV' },
      stems: Object.fromEntries(fixture.speakers.map((speaker) => {
        const path = join(stemDir, `${speaker.id}.mp3`);
        return [speaker.id, { path: `/demo/stems/${speaker.id}.mp3`, sha256: sha256(path), bytes: statSync(path).size }];
      })),
    },
  };
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(JSON.stringify({ ok: true, manifest: manifestPath, ...manifest.artifacts.master, estimatedTtsCostUsd: manifest.estimatedTtsCostUsd }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});
