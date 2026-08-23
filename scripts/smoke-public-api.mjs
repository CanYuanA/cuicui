const baseUrl = (process.env.BASE_URL || 'http://localhost:3000').replace(/\/$/, '');
const password = process.env.SITE_ACCESS_PASSWORD;
if (!password) throw new Error('缺少 SITE_ACCESS_PASSWORD');

const loginResponse = await fetch(`${baseUrl}/api/access/login`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password }),
});
const accessCookie = (loginResponse.headers.get('set-cookie') || '').split(';')[0];
if (!loginResponse.ok || !accessCookie) throw new Error(`access login ${loginResponse.status}`);

async function json(path, options = {}) {
  const headers = new Headers(options.headers || {});
  headers.set('Cookie', accessCookie);
  const response = await fetch(`${baseUrl}${path}`, { ...options, headers });
  const payload = await response.json().catch(() => ({}));
  return { response, payload };
}

async function post(body) {
  const result = await json('/api/room', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!result.response.ok) throw new Error(`room ${result.response.status}: ${result.payload.error || 'failed'}`);
  return result.payload;
}

const session = await json('/api/demo-session', { method: 'POST' });
const unauthorizedStt = await fetch(`${baseUrl}/api/transcribe`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ audioBase64: 'AAAA', format: 'webm' }) });
const created = await post({ action: 'create', meeting: { title: '房间链路验收会', durationSeconds: 180, meetingType: '联调会', agenda: ['验证独立身份', '验证主持台聚合'] }, hostName: '林主持' });
const guestA = await post({ action: 'join', code: created.code, name: '王工', role: '后端负责人' });
const guestB = await post({ action: 'join', code: created.code, name: '郭产品', role: '体验负责人' });
await post({ action: 'control', status: 'live', code: created.code, hostToken: created.hostToken });
await post({ action: 'utterance', code: created.code, participantToken: guestA.participantToken, text: '建议先灰度百分之二十。' });
await post({ action: 'utterance', code: created.code, participantToken: guestB.participantToken, text: '用户提示和仪表盘需要同步。' });

const snapshot = await json(`/api/room?code=${encodeURIComponent(created.code)}`, { headers: { Authorization: `Bearer ${created.participantToken}` } });
const anonymousSnapshot = await fetch(`${baseUrl}/api/room?code=${encodeURIComponent(created.code)}`);
const lines = snapshot.payload.room?.utterances || [];
const checks = {
  demoSessionIssued: session.response.ok && typeof session.payload.token === 'string',
  paidEndpointProtected: unauthorizedStt.status === 401,
  roomCreated: typeof created.code === 'string' && created.code.length === 6,
  uniqueParticipantIds: guestA.participantId !== guestB.participantId,
  correctSpeakerIdentity: lines[0]?.name === '王工' && lines[1]?.name === '郭产品',
  serverTimeline: lines.every((line) => Number.isFinite(line.started_at) && line.started_at >= 0 && line.ended_at >= line.started_at),
  privateSnapshot: anonymousSnapshot.status === 401,
  liveState: snapshot.payload.room?.status === 'live',
  tokensNotLeaked: !JSON.stringify(snapshot.payload.room).includes(created.hostToken) && !JSON.stringify(snapshot.payload.room).includes(guestA.participantToken),
};

await post({ action: 'control', status: 'ended', code: created.code, hostToken: created.hostToken });
const ok = Object.values(checks).every(Boolean);
console.log(JSON.stringify({ ok, baseUrl, participantCount: snapshot.payload.room?.participants?.length, utteranceCount: lines.length, speakers: lines.map((line) => line.name), checks }, null, 2));
if (!ok) process.exitCode = 1;
