import { AccessError, clientIp, enforceRate } from '../../server/demo-access';

type RoomStatus = 'waiting' | 'live' | 'ended';
type MeetingPayload = { title: string; durationSeconds: number; meetingType: string; agenda: string[] };
type Participant = { id: string; tokenHash: string; name: string; role: string; joined_at: number; last_seen: number };
type Utterance = { id: string; participant_id: string; name: string; role: string; text: string; started_at: number; ended_at: number; created_at: number };
type StoredRoom = {
  code: string; meeting: MeetingPayload; status: RoomStatus; revision: number; createdAt: number; startedAt: number | null; expiresAt: number;
  hostTokenHash: string; participants: Map<string, Participant>; utterances: Utterance[];
};
type RoomState = { rooms: Map<string, StoredRoom> };

const stateKey = Symbol.for('cuicui.rooms');
const shared = globalThis as typeof globalThis & { [stateKey]?: RoomState };
const state = shared[stateKey] ||= { rooms: new Map() };

function cleanText(value: unknown, limit: number) { return String(value || '').trim().slice(0, limit); }
async function hash(value: string) { const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)); return Buffer.from(digest).toString('hex'); }
function token() { return Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('hex'); }
function roomCode() { const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; const bytes = crypto.getRandomValues(new Uint8Array(6)); return [...bytes].map((value) => alphabet[value % alphabet.length]).join(''); }
function bearer(request: Request) { return request.headers.get('authorization')?.replace(/^Bearer\s+/i, '').trim() || ''; }

function cleanMeeting(value: Record<string, unknown>): MeetingPayload {
  return {
    title: cleanText(value.title, 180) || '未命名会议',
    durationSeconds: Math.max(30, Math.min(7200, Number(value.durationSeconds) || 1800)),
    meetingType: cleanText(value.meetingType, 40) || '讨论会',
    agenda: (Array.isArray(value.agenda) ? value.agenda : []).map((item) => cleanText(item, 160)).filter(Boolean).slice(0, 8),
  };
}

function cleanup(now = Date.now()) { for (const [code, room] of state.rooms) if (room.expiresAt <= now) state.rooms.delete(code); }
function findRoom(code: string) { cleanup(); return state.rooms.get(code) || null; }
async function participantByToken(room: StoredRoom, raw: string) { const digest = raw ? await hash(raw) : ''; return [...room.participants.values()].find((person) => person.tokenHash === digest) || null; }
function snapshot(room: StoredRoom) {
  return {
    code: room.code, meeting: room.meeting, status: room.status, revision: room.revision, createdAt: room.createdAt,
    startedAt: room.startedAt, expiresAt: room.expiresAt,
    participants: [...room.participants.values()].map((person) => ({ id: person.id, name: person.name, role: person.role, joined_at: person.joined_at, last_seen: person.last_seen })),
    utterances: room.utterances.slice(-240),
  };
}

function responseError(error: unknown) {
  if (error instanceof AccessError) return Response.json({ error: error.message }, { status: error.status });
  console.error('room-api', error);
  return Response.json({ error: '会议房间暂不可用' }, { status: 500 });
}

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const code = cleanText(url.searchParams.get('code'), 6).toUpperCase();
    const room = findRoom(code);
    if (!room) return Response.json({ error: '会议不存在或已过期' }, { status: 404 });
    const rawToken = bearer(request);
    const participant = await participantByToken(room, rawToken);
    const isHost = rawToken && await hash(rawToken) === room.hostTokenHash;
    if (!participant && !isHost) return Response.json({ error: '参会身份无效，请重新加入' }, { status: 401 });
    if (participant && Date.now() - participant.last_seen > 10_000) participant.last_seen = Date.now();
    return Response.json({ room: snapshot(room) }, { headers: { 'Cache-Control': 'no-store, private' } });
  } catch (error) { return responseError(error); }
}

export async function POST(request: Request) {
  try {
    if (Number(request.headers.get('content-length') || 0) > 16_384) throw new AccessError(413, '请求内容过大');
    const input = await request.json() as Record<string, unknown>;
    const action = cleanText(input.action, 20);
    const now = Date.now();
    const ip = clientIp(request);

    if (action === 'create') {
      enforceRate('room-create', ip, 4, 60 * 60 * 1000); cleanup(now);
      if (state.rooms.size >= 200) throw new AccessError(503, '公开体验会场已满，请稍后再试');
      const meeting = cleanMeeting((input.meeting || {}) as Record<string, unknown>);
      const hostName = cleanText(input.hostName, 30) || '主持人';
      const hostToken = token(); const participantToken = token(); const participantId = crypto.randomUUID();
      let code = roomCode(); while (state.rooms.has(code)) code = roomCode();
      const room: StoredRoom = { code, meeting, status: 'waiting', revision: 1, createdAt: now, startedAt: null, expiresAt: now + 6 * 60 * 60 * 1000, hostTokenHash: await hash(hostToken), participants: new Map(), utterances: [] };
      room.participants.set(participantId, { id: participantId, tokenHash: await hash(participantToken), name: hostName, role: '主持人', joined_at: now, last_seen: now });
      state.rooms.set(code, room);
      return Response.json({ code, hostToken, participantToken, participantId, expiresAt: room.expiresAt });
    }

    const code = cleanText(input.code, 6).toUpperCase();
    const room = findRoom(code);
    if (!room) return Response.json({ error: '会议不存在或已过期' }, { status: 404 });

    if (action === 'join') {
      enforceRate('room-join', `${ip}:${code}`, 20, 60 * 60 * 1000);
      if (room.status === 'ended') return Response.json({ error: '会议已经结束' }, { status: 409 });
      if (room.participants.size >= 12) return Response.json({ error: '会场人数已满' }, { status: 409 });
      const name = cleanText(input.name, 30); const role = cleanText(input.role, 40) || '参会者';
      if (!name) return Response.json({ error: '请填写姓名' }, { status: 400 });
      const participantToken = token(); const participantId = crypto.randomUUID();
      room.participants.set(participantId, { id: participantId, tokenHash: await hash(participantToken), name, role, joined_at: now, last_seen: now });
      room.revision += 1;
      return Response.json({ participantToken, participantId, room: snapshot(room) });
    }

    if (action === 'utterance') {
      const rawToken = cleanText(input.participantToken || bearer(request), 128);
      const participant = await participantByToken(room, rawToken);
      if (!participant) return Response.json({ error: '参会身份无效，请重新加入' }, { status: 401 });
      if (room.status !== 'live' || !room.startedAt) return Response.json({ error: '会议尚未开始或已经结束' }, { status: 409 });
      enforceRate('room-utterance', participant.tokenHash, 120, 10 * 60 * 1000);
      if (room.utterances.length >= 240) return Response.json({ error: '本场体验已达到 240 段发言上限' }, { status: 409 });
      const text = cleanText(input.text, 600);
      if (!text) return Response.json({ error: '转写内容为空' }, { status: 400 });
      const endedAt = Math.max(0, (now - room.startedAt) / 1000);
      const startedAt = Math.max(0, endedAt - Math.min(30, Math.max(1, text.length / 5)));
      const utterance: Utterance = { id: crypto.randomUUID(), participant_id: participant.id, name: participant.name, role: participant.role, text, started_at: startedAt, ended_at: endedAt, created_at: now };
      room.utterances.push(utterance); participant.last_seen = now; room.revision += 1;
      return Response.json({ id: utterance.id, revision: room.revision });
    }

    if (action === 'control') {
      if (await hash(cleanText(input.hostToken || bearer(request), 128)) !== room.hostTokenHash) return Response.json({ error: '只有主持人可以控制会议' }, { status: 403 });
      const status = cleanText(input.status, 10) as RoomStatus;
      if (room.status === 'waiting' && status === 'live') { room.status = 'live'; room.startedAt = now; }
      else if (room.status === 'live' && status === 'ended') room.status = 'ended';
      else return Response.json({ error: `不允许从 ${room.status} 切换到 ${status}` }, { status: 409 });
      room.revision += 1;
      return Response.json({ room: snapshot(room) });
    }

    return Response.json({ error: '未知操作' }, { status: 400 });
  } catch (error) { return responseError(error); }
}
