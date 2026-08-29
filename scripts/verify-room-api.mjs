const baseUrl = (process.env.BASE_URL || 'http://localhost:3000').replace(/\/$/, '');
const password = process.env.SITE_ACCESS_PASSWORD;
if (!password) throw new Error('缺少 SITE_ACCESS_PASSWORD');

const loginResponse = await fetch(`${baseUrl}/api/access/login`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ password }),
});
const setCookieHeaders = typeof loginResponse.headers.getSetCookie === 'function'
  ? loginResponse.headers.getSetCookie()
  : [loginResponse.headers.get('set-cookie') || ''];
const accessSetCookie = setCookieHeaders
  .flatMap((header) => header.split(/,(?=\s*[^;,=\s]+=[^;,]*)/))
  .find((header) => /^\s*cuicui_access=/.test(header));
const accessCookie = (accessSetCookie || '').trim().split(';')[0];
if (!loginResponse.ok || !accessCookie) throw new Error(`访问登录失败（HTTP ${loginResponse.status}）`);

async function requestJson(path, options = {}) {
  const headers = new Headers(options.headers || {});
  headers.set('Cookie', accessCookie);
  const response = await fetch(`${baseUrl}${path}`, { ...options, headers });
  const payload = await response.json().catch(() => ({}));
  return { response, payload };
}

async function roomPost(body, token) {
  const headers = new Headers({ 'Content-Type': 'application/json' });
  if (token) headers.set('Authorization', `Bearer ${token}`);
  return requestJson('/api/room', {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
}

async function requireRoomPost(body, token) {
  const result = await roomPost(body, token);
  if (!result.response.ok) {
    throw new Error(`房间请求失败（HTTP ${result.response.status}：${result.payload.error || '未知错误'}）`);
  }
  return result.payload;
}

const created = await requireRoomPost({
  action: 'create',
  meeting: {
    title: '多人链路自动验收会',
    durationSeconds: 180,
    meetingType: '联调会',
    agenda: ['验证并发加入', '验证实时转写排空'],
  },
  hostName: '自动验收主持人',
});

const joinAttempts = await Promise.all(Array.from({ length: 14 }, (_, index) => roomPost({
  action: 'join',
  code: created.code,
  name: `验收成员${String(index + 1).padStart(2, '0')}`,
  role: '链路验收',
})));
const joined = joinAttempts.filter((item) => item.response.ok).map((item) => item.payload);
const rejected = joinAttempts.filter((item) => !item.response.ok);
if (!joined.length) throw new Error('并发加入未产生可用参会身份');
const speaker = joined[0];
const leaving = joined[1];
const leavingName = leaving?.room?.participants?.find((person) => person.id === leaving.participantId)?.name;
if (!leaving || !leavingName) throw new Error('没有可用于验证退出重进的参会身份');
const left = await requireRoomPost({ action: 'leave', code: created.code }, leaving.participantToken);
const rejectedLeftTokenRead = await requestJson(`/api/room?code=${encodeURIComponent(created.code)}`, {
  headers: { Authorization: `Bearer ${leaving.participantToken}` },
});
const rejoined = await requireRoomPost({
  action: 'join',
  code: created.code,
  name: leavingName,
  role: '链路验收',
});

const live = await requireRoomPost({ action: 'control', code: created.code, status: 'live' }, created.hostToken);
const clientEventId = `verify-${crypto.randomUUID()}`;
const partial = await requireRoomPost({
  action: 'utterance',
  code: created.code,
  clientEventId,
  seq: 1,
  text: '这是一段正在识别的多人发言',
  isFinal: false,
  source: 'iflytek',
  startedAt: 0,
  endedAt: 1.2,
}, speaker.participantToken);
const final = await requireRoomPost({
  action: 'utterance',
  code: created.code,
  clientEventId,
  seq: 2,
  text: '这是一段已经稳定的多人发言。',
  isFinal: true,
  source: 'iflytek',
  startedAt: 0,
  endedAt: 1.6,
}, speaker.participantToken);
const stale = await requireRoomPost({
  action: 'utterance',
  code: created.code,
  clientEventId,
  seq: 1,
  text: '旧序号绝不能覆盖最终结果',
  isFinal: true,
  source: 'iflytek',
  startedAt: 0,
  endedAt: 1.1,
}, speaker.participantToken);

const interventionId = `verify-reminder-${crypto.randomUUID()}`;
const intervention = {
  id: interventionId,
  at: 1.6,
  type: 'time',
  severity: 'warning',
  label: '节奏提醒',
  observation: '当前议题讨论时间已接近计划上限。',
  impact: '后续决策时间可能不足。',
  suggestion: '请主持人收敛当前议题并明确下一步。',
  evidence: '计划时长与服务端会议时钟对比。',
  confidence: 0.9,
  actions: ['adopt', 'ignore'],
};
const rejectedParticipantIntervention = await roomPost({
  action: 'intervention', code: created.code, intervention,
}, speaker.participantToken);
const publishedIntervention = await requireRoomPost({
  action: 'intervention', code: created.code, intervention,
}, created.hostToken);
const interventionRevision = publishedIntervention.room?.revision;
const duplicateIntervention = await requireRoomPost({
  action: 'intervention', code: created.code, intervention,
}, created.hostToken);
const conflictingIntervention = await roomPost({
  action: 'intervention', code: created.code, intervention: { ...intervention, label: '冲突内容' },
}, created.hostToken);

const rateEventId = `rate-${crypto.randomUUID()}`;
const rateBurst = await Promise.all(Array.from({ length: 45 }, (_, index) => roomPost({
  action: 'utterance',
  code: created.code,
  clientEventId: rateEventId,
  seq: index + 1,
  text: `同一个识别片段的高频更新 ${index + 1}`,
  isFinal: false,
  source: 'iflytek',
  startedAt: 0,
  endedAt: 1.8,
}, rejoined.participantToken)));
const rateAccepted = rateBurst.filter((item) => item.response.ok);
const rateRejected = rateBurst.filter((item) => item.response.status === 429);

const beforeClosing = await requestJson(`/api/room?code=${encodeURIComponent(created.code)}`, {
  headers: { Authorization: `Bearer ${created.participantToken}` },
});
const closing = await requireRoomPost({ action: 'control', code: created.code, status: 'closing' }, created.hostToken);
const closingDeadline = Number(closing.room?.closeDeadline || 0);
const closingServerNow = Number(closing.room?.serverNow);
const configuredClosingDrainMs = closingDeadline - closingServerNow;
const drainEventId = `drain-${crypto.randomUUID()}`;
const drained = await requireRoomPost({
  action: 'utterance',
  code: created.code,
  clientEventId: drainEventId,
  seq: 1,
  text: '主持人结束时，这句稳定字幕仍然被收拢。',
  isFinal: true,
  source: 'iflytek',
  startedAt: 1.7,
  endedAt: 2.5,
}, speaker.participantToken);
const ended = await requireRoomPost({ action: 'control', code: created.code, status: 'ended' }, created.hostToken);
const rejectedAfterEnd = await roomPost({
  action: 'utterance',
  code: created.code,
  clientEventId: `late-${crypto.randomUUID()}`,
  seq: 1,
  text: '结束后不应再写入',
  isFinal: true,
  source: 'manual',
  startedAt: 2.6,
  endedAt: 3,
}, speaker.participantToken);
const rejectedInterventionAfterEnd = await roomPost({
  action: 'intervention', code: created.code,
  intervention: { ...intervention, id: `late-reminder-${crypto.randomUUID()}` },
}, created.hostToken);

const roomBeforeClosing = beforeClosing.payload.room;
const stableRows = (roomBeforeClosing?.utterances || []).filter((item) => item.client_event_id === clientEventId);
const rateRows = (roomBeforeClosing?.utterances || []).filter((item) => item.client_event_id === rateEventId);
const finalRows = (ended.room?.utterances || []).filter((item) => item.client_event_id === clientEventId);
const drainRows = (ended.room?.utterances || []).filter((item) => item.client_event_id === drainEventId);
const interventionRows = (ended.room?.interventions || []).filter((item) => item.id === interventionId);
const serializedSnapshots = JSON.stringify([roomBeforeClosing, ended.room]);
const tokenValues = [created.hostToken, created.participantToken, rejoined.participantToken, ...joined.map((item) => item.participantToken)];
const activeParticipants = (roomBeforeClosing?.participants || []).filter((person) => person.left_at === null);

const checks = {
  roomCreated: typeof created.code === 'string' && created.code.length === 6 && typeof created.joinUrl === 'string',
  concurrentCapacityIsTwelve: joined.length === 11 && rejected.length === 3 && rejected.every((item) => item.response.status === 409) && activeParticipants.length === 12,
  participantIdsAreUnique: new Set([...joined.map((item) => item.participantId), rejoined.participantId]).size === joined.length + 1,
  leaveAndSameNameRejoin: left.room?.participants?.find((person) => person.id === leaving.participantId)?.left_at !== null && rejoined.participantId !== leaving.participantId,
  leftTokenCannotReadSharedRoom: rejectedLeftTokenRead.response.status === 401,
  liveTransitioned: live.room?.status === 'live',
  partialAccepted: partial.utterance?.client_event_id === clientEventId && partial.utterance?.final === false && partial.utterance?.seq === 1,
  partialFinalUpsertedOnce: stableRows.length === 1 && finalRows.length === 1 && final.utterance?.id === partial.utterance?.id,
  staleSequenceDidNotOverwrite: stale.utterance?.seq === 2 && stale.utterance?.text === '这是一段已经稳定的多人发言。' && finalRows[0]?.text === '这是一段已经稳定的多人发言。',
  participantCannotPublishIntervention: rejectedParticipantIntervention.response.status === 403,
  hostInterventionShared: publishedIntervention.intervention?.id === interventionId && interventionRows.length === 1,
  interventionRetryIsIdempotent: duplicateIntervention.room?.revision === interventionRevision && interventionRows.length === 1,
  interventionIdConflictRejected: conflictingIntervention.response.status === 409,
  participantBurstRateProtected: rateAccepted.length === 40 && rateRejected.length === 5 && rateRejected.every((item) => Number(item.response.headers.get('retry-after')) >= 1),
  existingEventUpdatesUseOneRow: rateRows.length === 1,
  closingExposedDeadline: closing.room?.status === 'closing'
    && Number.isFinite(closingServerNow)
    && configuredClosingDrainMs >= 11_500 && configuredClosingDrainMs <= 12_500,
  closingAcceptedFinal: drained.utterance?.final === true && drainRows.length === 1,
  endedReturnedFinalSnapshot: ended.room?.status === 'ended' && Number.isFinite(ended.room?.endedAt) && drainRows[0]?.text.includes('仍然被收拢'),
  endedRejectedNewUtterance: rejectedAfterEnd.response.status === 409,
  endedRejectedNewIntervention: rejectedInterventionAfterEnd.response.status === 409,
  tokensNotLeaked: tokenValues.every((token) => typeof token === 'string' && token.length > 0 && !serializedSnapshots.includes(token)),
};

const ok = Object.values(checks).every(Boolean);
console.log(JSON.stringify({
  ok,
  baseUrl,
  participantCount: ended.room?.participants?.length,
  utteranceCount: ended.room?.utterances?.length,
  timing: { configuredClosingDrainMs },
  checks,
}, null, 2));
if (!ok) process.exitCode = 1;
