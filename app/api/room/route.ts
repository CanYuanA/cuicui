import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type {
  Participant,
  RoomMeeting,
  RoomSession,
  RoomSnapshot,
  RoomStatus,
  Utterance,
  UtteranceSource,
} from '../../room-types';
import { AccessError, clientIp, enforceRate } from '../../server/demo-access';

export const runtime = 'nodejs';

const MAX_BODY_BYTES = 16_384;
const ROOM_CAPACITY = 12;
const ROOM_TTL_MS = 6 * 60 * 60 * 1000;
const ENDED_ROOM_TTL_MS = 60 * 60 * 1000;
const CLOSE_DRAIN_MS = 12_000;
const ONLINE_WINDOW_MS = 15_000;
const MAX_UNIQUE_UTTERANCES = 2_400;
const UTTERANCE_RATE_WINDOW_MS = 10_000;
const UTTERANCE_RATE_REQUESTS = 40;

type RoomRow = {
  code: string;
  meeting_json: string;
  status: RoomStatus;
  revision: number;
  created_at: number;
  started_at: number | null;
  close_deadline: number | null;
  ended_at: number | null;
  expires_at: number;
  host_token_hash: string;
};

type ParticipantRow = {
  id: string;
  room_code: string;
  token_hash: string;
  name: string;
  name_key: string;
  role: string;
  joined_at: number;
  last_seen: number;
  left_at: number | null;
};

type UtteranceRow = {
  id: string;
  room_code: string;
  participant_id: string;
  name: string;
  role: string;
  text: string;
  started_at: number;
  ended_at: number;
  created_at: number;
  updated_at: number;
  client_event_id: string;
  seq: number;
  final: number;
  source: UtteranceSource;
};

type SharedDatabase = { path: string; database: DatabaseSync };
const databaseKey = Symbol.for('cuicui.room-database');
const shared = globalThis as typeof globalThis & { [databaseKey]?: SharedDatabase };

type UtteranceRateBucket = { startedAt: number; count: number };
type UtteranceRateState = { buckets: Map<string, UtteranceRateBucket>; lastCleanup: number };
const utteranceRateKey = Symbol.for('cuicui.room-utterance-rate');
const rateShared = globalThis as typeof globalThis & { [utteranceRateKey]?: UtteranceRateState };
const utteranceRate = rateShared[utteranceRateKey] ||= { buckets: new Map(), lastCleanup: 0 };

class RoomAccessError extends AccessError {
  constructor(status: number, message: string, public headers?: HeadersInit) {
    super(status, message);
  }
}

function openDatabase() {
  const path = process.env.CUICUI_ROOM_DB_PATH?.trim() || ':memory:';
  if (shared[databaseKey]?.path === path) return shared[databaseKey].database;
  if (shared[databaseKey]) shared[databaseKey].database.close();
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });

  const database = new DatabaseSync(path);
  database.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 5000;
    PRAGMA synchronous = NORMAL;

    CREATE TABLE IF NOT EXISTS rooms (
      code TEXT PRIMARY KEY,
      meeting_json TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('waiting', 'live', 'closing', 'ended')),
      revision INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      started_at INTEGER,
      close_deadline INTEGER,
      ended_at INTEGER,
      expires_at INTEGER NOT NULL,
      host_token_hash TEXT NOT NULL UNIQUE
    );

    CREATE TABLE IF NOT EXISTS participants (
      id TEXT PRIMARY KEY,
      room_code TEXT NOT NULL REFERENCES rooms(code) ON DELETE CASCADE,
      token_hash TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      name_key TEXT NOT NULL,
      role TEXT NOT NULL,
      joined_at INTEGER NOT NULL,
      last_seen INTEGER NOT NULL,
      left_at INTEGER
    );

    DROP INDEX IF EXISTS participants_room_name_unique;
    CREATE UNIQUE INDEX participants_room_name_unique
      ON participants(room_code, name_key) WHERE left_at IS NULL;
    CREATE INDEX IF NOT EXISTS participants_room_active
      ON participants(room_code, left_at);

    CREATE TABLE IF NOT EXISTS utterances (
      id TEXT PRIMARY KEY,
      room_code TEXT NOT NULL REFERENCES rooms(code) ON DELETE CASCADE,
      participant_id TEXT NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
      client_event_id TEXT NOT NULL,
      seq INTEGER NOT NULL,
      final INTEGER NOT NULL CHECK (final IN (0, 1)),
      source TEXT NOT NULL CHECK (source IN ('iflytek', 'manual')),
      text TEXT NOT NULL,
      started_at REAL NOT NULL,
      ended_at REAL NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE(room_code, participant_id, client_event_id)
    );

    CREATE INDEX IF NOT EXISTS utterances_room_order
      ON utterances(room_code, started_at, created_at);
  `);
  shared[databaseKey] = { path, database };
  return database;
}

function transaction<T>(database: DatabaseSync, operation: () => T) {
  database.exec('BEGIN IMMEDIATE');
  try {
    const result = operation();
    database.exec('COMMIT');
    return result;
  } catch (error) {
    try { database.exec('ROLLBACK'); } catch { /* transaction already closed */ }
    throw error;
  }
}

function cleanText(value: unknown, limit: number) {
  return String(value ?? '').trim().slice(0, limit);
}

function cleanName(value: unknown) {
  return cleanText(value, 30).normalize('NFKC');
}

function nameKey(value: string) {
  return value.normalize('NFKC').toLocaleLowerCase('zh-CN');
}

function cleanMeeting(value: unknown): RoomMeeting {
  const record = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  const rawDuration = Number(record.durationSeconds);
  return {
    title: cleanText(record.title, 180) || '未命名会议',
    durationSeconds: Math.max(30, Math.min(7200, Number.isFinite(rawDuration) ? rawDuration : 1800)),
    meetingType: cleanText(record.meetingType, 40) || '讨论会',
    agenda: (Array.isArray(record.agenda) ? record.agenda : [])
      .map((item) => cleanText(item, 160))
      .filter(Boolean)
      .slice(0, 8),
  };
}

function digest(value: string) {
  return createHash('sha256').update(value).digest('hex');
}

function safeHashEqual(left: string, right: string) {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

function newToken() {
  return randomBytes(32).toString('hex');
}

function roomCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return [...randomBytes(6)].map((value) => alphabet[value % alphabet.length]).join('');
}

function bearer(request: Request) {
  return request.headers.get('authorization')?.replace(/^Bearer\s+/i, '').trim().slice(0, 128) || '';
}

function enforceUtteranceRate(subject: string, now: number) {
  if (now - utteranceRate.lastCleanup >= 60_000) {
    for (const [key, bucket] of utteranceRate.buckets) {
      if (now - bucket.startedAt >= UTTERANCE_RATE_WINDOW_MS * 2) utteranceRate.buckets.delete(key);
    }
    utteranceRate.lastCleanup = now;
  }

  let bucket = utteranceRate.buckets.get(subject);
  if (!bucket || now - bucket.startedAt >= UTTERANCE_RATE_WINDOW_MS) {
    bucket = { startedAt: now, count: 0 };
    utteranceRate.buckets.set(subject, bucket);
  }
  if (bucket.count >= UTTERANCE_RATE_REQUESTS) {
    const retryAfter = Math.max(1, Math.ceil((bucket.startedAt + UTTERANCE_RATE_WINDOW_MS - now) / 1000));
    throw new RoomAccessError(429, '发言同步过于密集，请稍后继续', {
      'Cache-Control': 'no-store',
      'Retry-After': String(retryAfter),
    });
  }
  bucket.count += 1;
}

async function readJson(request: Request) {
  const declaredLength = Number(request.headers.get('content-length') || 0);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
    throw new AccessError(413, '请求内容过大');
  }
  if (!request.body) throw new AccessError(400, '请求内容为空');

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_BODY_BYTES) {
        await reader.cancel();
        throw new AccessError(413, '请求内容过大');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  try {
    const decoded = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
    const value = JSON.parse(decoded) as unknown;
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('object required');
    return value as Record<string, unknown>;
  } catch {
    throw new AccessError(400, '请求 JSON 格式无效');
  }
}

function maintainRooms(database: DatabaseSync, now: number, code?: string) {
  if (code) {
    database.prepare(`
      UPDATE rooms
      SET status = 'ended', ended_at = COALESCE(ended_at, ?), revision = revision + 1,
          expires_at = MIN(expires_at, ?)
      WHERE code = ? AND status = 'closing' AND close_deadline IS NOT NULL AND close_deadline <= ?
    `).run(now, now + ENDED_ROOM_TTL_MS, code, now);
  } else {
    database.prepare(`
      UPDATE rooms
      SET status = 'ended', ended_at = COALESCE(ended_at, ?), revision = revision + 1,
          expires_at = MIN(expires_at, ?)
      WHERE status = 'closing' AND close_deadline IS NOT NULL AND close_deadline <= ?
    `).run(now, now + ENDED_ROOM_TTL_MS, now);
  }
  database.prepare('DELETE FROM rooms WHERE expires_at <= ?').run(now);
}

function roomRow(database: DatabaseSync, code: string) {
  return (database.prepare('SELECT * FROM rooms WHERE code = ?').get(code) || null) as RoomRow | null;
}

function participantByToken(database: DatabaseSync, code: string, rawToken: string) {
  if (!rawToken) return null;
  return (database.prepare(`
    SELECT * FROM participants WHERE room_code = ? AND token_hash = ?
  `).get(code, digest(rawToken)) || null) as ParticipantRow | null;
}

function utteranceById(database: DatabaseSync, id: string) {
  return (database.prepare(`
    SELECT utterances.*, participants.name, participants.role
    FROM utterances
    JOIN participants ON participants.id = utterances.participant_id
    WHERE utterances.id = ?
  `).get(id) || null) as UtteranceRow | null;
}

function toUtterance(row: UtteranceRow): Utterance {
  return {
    id: row.id,
    participant_id: row.participant_id,
    name: row.name,
    role: row.role,
    text: row.text,
    started_at: row.started_at,
    ended_at: row.ended_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
    client_event_id: row.client_event_id,
    seq: row.seq,
    final: Boolean(row.final),
    source: row.source,
  };
}

function snapshot(database: DatabaseSync, room: RoomRow, now = Date.now()): RoomSnapshot {
  let meeting: RoomMeeting;
  try { meeting = cleanMeeting(JSON.parse(room.meeting_json)); } catch { meeting = cleanMeeting({}); }
  const participantRows = database.prepare(`
    SELECT * FROM participants WHERE room_code = ? ORDER BY joined_at, id
  `).all(room.code) as unknown as ParticipantRow[];
  const utteranceRows = database.prepare(`
    SELECT utterances.*, participants.name, participants.role
    FROM utterances
    JOIN participants ON participants.id = utterances.participant_id
    WHERE utterances.room_code = ?
    ORDER BY utterances.started_at, utterances.created_at, utterances.id
  `).all(room.code) as unknown as UtteranceRow[];

  const participants: Participant[] = participantRows.map((person) => ({
    id: person.id,
    name: person.name,
    role: person.role,
    joined_at: person.joined_at,
    last_seen: person.last_seen,
    left_at: person.left_at,
    online: person.left_at === null && now - person.last_seen <= ONLINE_WINDOW_MS,
  }));

  return {
    code: room.code,
    meeting,
    status: room.status,
    revision: room.revision,
    serverNow: now,
    createdAt: room.created_at,
    startedAt: room.started_at,
    closeDeadline: room.close_deadline,
    endedAt: room.ended_at,
    expiresAt: room.expires_at,
    participants,
    utterances: utteranceRows.map(toUtterance),
  };
}

function requireRoom(database: DatabaseSync, code: string, now: number) {
  maintainRooms(database, now, code);
  const room = roomRow(database, code);
  if (!room) throw new AccessError(404, '会议不存在或已过期');
  return room;
}

function responseError(error: unknown) {
  if (error instanceof RoomAccessError) {
    return Response.json({ error: error.message }, { status: error.status, headers: error.headers });
  }
  if (error instanceof AccessError) return Response.json({ error: error.message }, { status: error.status });
  console.error('room-api', error);
  return Response.json({ error: '会议房间暂不可用' }, { status: 500 });
}

function finiteTime(value: unknown, fallback: number) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function wait(milliseconds: number) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export async function GET(request: Request) {
  try {
    const database = openDatabase();
    const url = new URL(request.url);
    const code = cleanText(url.searchParams.get('code'), 6).toUpperCase();
    const now = Date.now();
    const room = requireRoom(database, code, now);
    const rawToken = bearer(request);
    const participant = participantByToken(database, code, rawToken);
    const isHost = Boolean(rawToken) && safeHashEqual(digest(rawToken), room.host_token_hash);
    if (!participant && !isHost) throw new AccessError(401, '参会身份无效，请重新加入');

    if (participant && participant.left_at === null) {
      database.prepare('UPDATE participants SET last_seen = ? WHERE id = ?').run(now, participant.id);
    }
    const freshRoom = roomRow(database, code)!;
    return Response.json({ room: snapshot(database, freshRoom, now) }, {
      headers: { 'Cache-Control': 'no-store, private' },
    });
  } catch (error) {
    return responseError(error);
  }
}

export async function POST(request: Request) {
  try {
    const database = openDatabase();
    const input = await readJson(request);
    const action = cleanText(input.action, 20);
    const now = Date.now();
    const ip = clientIp(request);
    maintainRooms(database, now);

    if (action === 'create') {
      enforceRate('room-create', ip, 4, 60 * 60 * 1000);
      const meeting = cleanMeeting(input.meeting);
      const hostName = cleanName(input.hostName) || '主持人';
      const hostToken = newToken();
      const participantToken = newToken();
      const participantId = crypto.randomUUID();
      const expiresAt = now + ROOM_TTL_MS;

      const code = transaction(database, () => {
        const count = Number((database.prepare('SELECT COUNT(*) AS count FROM rooms').get() as { count: number }).count);
        if (count >= 200) throw new AccessError(503, '会场服务繁忙，请稍后再试');

        let selectedCode = '';
        const insertRoom = database.prepare(`
          INSERT OR IGNORE INTO rooms
            (code, meeting_json, status, revision, created_at, started_at, close_deadline, ended_at, expires_at, host_token_hash)
          VALUES (?, ?, 'waiting', 1, ?, NULL, NULL, NULL, ?, ?)
        `);
        for (let attempt = 0; attempt < 12; attempt += 1) {
          const candidate = roomCode();
          const result = insertRoom.run(candidate, JSON.stringify(meeting), now, expiresAt, digest(hostToken));
          if (Number(result.changes) === 1) { selectedCode = candidate; break; }
        }
        if (!selectedCode) throw new AccessError(503, '无法分配会议加入码，请重试');

        database.prepare(`
          INSERT INTO participants
            (id, room_code, token_hash, name, name_key, role, joined_at, last_seen, left_at)
          VALUES (?, ?, ?, ?, ?, '主持人', ?, ?, NULL)
        `).run(participantId, selectedCode, digest(participantToken), hostName, nameKey(hostName), now, now);
        return selectedCode;
      });

      const joinUrl = new URL(request.url);
      joinUrl.pathname = '/join';
      joinUrl.search = '';
      joinUrl.searchParams.set('code', code);
      const session: RoomSession = {
        code,
        hostToken,
        participantToken,
        participantId,
        joinUrl: joinUrl.toString(),
        expiresAt,
      };
      const room = roomRow(database, code)!;
      return Response.json({ ...session, room: snapshot(database, room, now) }, { status: 201 });
    }

    const code = cleanText(input.code, 6).toUpperCase();
    if (!code) throw new AccessError(400, '缺少会议加入码');

    if (action === 'join') {
      enforceRate('room-join', `${ip}:${code}`, 20, 60 * 60 * 1000);
      const name = cleanName(input.name);
      const role = cleanText(input.role, 40) || '参会者';
      if (!name) throw new AccessError(400, '请填写姓名');
      if (role.normalize('NFKC') === '主持人') throw new AccessError(400, '参会角色不能设置为主持人');
      const participantToken = newToken();
      const participantId = crypto.randomUUID();

      transaction(database, () => {
        const room = roomRow(database, code);
        if (!room) throw new AccessError(404, '会议不存在或已过期');
        if (room.status === 'closing' || room.status === 'ended') throw new AccessError(409, '会议正在收尾或已经结束');
        const duplicate = database.prepare(`
          SELECT 1 FROM participants WHERE room_code = ? AND name_key = ? AND left_at IS NULL
        `).get(code, nameKey(name));
        if (duplicate) throw new AccessError(409, '该姓名已在会场中，请使用可区分的姓名');
        const active = Number((database.prepare(`
          SELECT COUNT(*) AS count FROM participants WHERE room_code = ? AND left_at IS NULL
        `).get(code) as { count: number }).count);
        if (active >= ROOM_CAPACITY) throw new AccessError(409, `会场最多支持 ${ROOM_CAPACITY} 人`);
        database.prepare(`
          INSERT INTO participants
            (id, room_code, token_hash, name, name_key, role, joined_at, last_seen, left_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)
        `).run(participantId, code, digest(participantToken), name, nameKey(name), role, now, now);
        database.prepare('UPDATE rooms SET revision = revision + 1 WHERE code = ?').run(code);
      });

      const room = roomRow(database, code)!;
      return Response.json({ participantToken, participantId, room: snapshot(database, room, now) }, { status: 201 });
    }

    if (action === 'utterance') {
      const rawToken = bearer(request);
      const participant = participantByToken(database, code, rawToken);
      if (!participant || participant.left_at !== null) throw new AccessError(401, '参会身份无效，请重新加入');

      const clientEventId = cleanText(input.clientEventId, 80);
      if (!/^[A-Za-z0-9._:-]{1,80}$/.test(clientEventId)) throw new AccessError(400, '发言事件标识无效');
      const seq = Number(input.seq);
      if (!Number.isInteger(seq) || seq < 0 || seq > 1_000_000_000) throw new AccessError(400, '发言序号无效');
      const finalValue = input.isFinal ?? input.final;
      if (typeof finalValue !== 'boolean') throw new AccessError(400, '缺少发言稳定状态');
      const isFinal = finalValue;
      const source = cleanText(input.source, 16) as UtteranceSource;
      if (source !== 'iflytek' && source !== 'manual') throw new AccessError(400, '发言来源无效');
      const text = cleanText(input.text, 600);
      if (!text) throw new AccessError(400, '转写内容为空');
      enforceUtteranceRate(participant.token_hash, now);

      const result = transaction(database, () => {
        const room = roomRow(database, code);
        if (!room) throw new AccessError(404, '会议不存在或已过期');
        if (!room.started_at || room.status === 'waiting') throw new AccessError(409, '会议尚未开始');
        if (room.status === 'ended') throw new AccessError(409, '会议已经结束');
        if (room.status === 'closing' && !isFinal) throw new AccessError(409, '会议正在收拢最后发言，只接受稳定字幕');

        const serverElapsed = Math.max(0, (now - room.started_at) / 1000);
        const requestedEnd = finiteTime(input.endedAt, serverElapsed);
        const endedAt = Math.max(0, Math.min(serverElapsed + 2, requestedEnd));
        const requestedStart = finiteTime(input.startedAt, Math.max(0, endedAt - Math.min(30, Math.max(1, text.length / 5))));
        const startedAt = Math.max(0, Math.min(endedAt, requestedStart));
        const existing = (database.prepare(`
          SELECT * FROM utterances
          WHERE room_code = ? AND participant_id = ? AND client_event_id = ?
        `).get(code, participant.id, clientEventId) || null) as Omit<UtteranceRow, 'name' | 'role'> | null;

        database.prepare('UPDATE participants SET last_seen = ? WHERE id = ?').run(now, participant.id);
        if (existing && (existing.final || seq < existing.seq || (seq === existing.seq && !isFinal))) {
          return { id: existing.id, revision: room.revision };
        }

        const id = existing?.id || crypto.randomUUID();
        if (existing) {
          database.prepare(`
            UPDATE utterances
            SET seq = ?, final = ?, text = ?, started_at = ?, ended_at = ?, updated_at = ?
            WHERE id = ?
          `).run(seq, isFinal ? 1 : 0, text, startedAt, endedAt, now, id);
        } else {
          const uniqueUtterances = Number((database.prepare(`
            SELECT COUNT(*) AS count FROM utterances WHERE room_code = ?
          `).get(code) as { count: number }).count);
          if (uniqueUtterances >= MAX_UNIQUE_UTTERANCES) {
            throw new RoomAccessError(429, '会议记录出现异常密集写入，已暂停新增发言片段', {
              'Cache-Control': 'no-store',
              'Retry-After': '60',
            });
          }
          database.prepare(`
            INSERT INTO utterances
              (id, room_code, participant_id, client_event_id, seq, final, source, text, started_at, ended_at, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).run(id, code, participant.id, clientEventId, seq, isFinal ? 1 : 0, source, text, startedAt, endedAt, now, now);
        }
        database.prepare('UPDATE rooms SET revision = revision + 1 WHERE code = ?').run(code);
        const revision = Number((database.prepare('SELECT revision FROM rooms WHERE code = ?').get(code) as { revision: number }).revision);
        return { id, revision };
      });

      const utterance = utteranceById(database, result.id);
      if (!utterance) throw new Error('utterance disappeared after commit');
      return Response.json({ id: result.id, revision: result.revision, utterance: toUtterance(utterance) });
    }

    if (action === 'leave') {
      const participant = participantByToken(database, code, bearer(request));
      if (!participant) throw new AccessError(401, '参会身份无效，请重新加入');
      transaction(database, () => {
        if (participant.left_at !== null) return;
        database.prepare('UPDATE participants SET left_at = ?, last_seen = ? WHERE id = ?').run(now, now, participant.id);
        database.prepare('UPDATE rooms SET revision = revision + 1 WHERE code = ?').run(code);
      });
      const room = requireRoom(database, code, now);
      return Response.json({ room: snapshot(database, room, now) });
    }

    if (action === 'control') {
      const requested = cleanText(input.status, 10) as RoomStatus;
      if (requested !== 'live' && requested !== 'closing' && requested !== 'ended') {
        throw new AccessError(400, '会议控制状态无效');
      }
      const rawToken = bearer(request);
      const tokenHash = rawToken ? digest(rawToken) : '';
      const transition = transaction(database, () => {
        const room = roomRow(database, code);
        if (!room) throw new AccessError(404, '会议不存在或已过期');
        if (!tokenHash || !safeHashEqual(tokenHash, room.host_token_hash)) {
          throw new AccessError(403, '只有主持人可以控制会议');
        }

        if (room.status === 'waiting' && requested === 'live') {
          database.prepare(`
            UPDATE rooms SET status = 'live', started_at = ?, revision = revision + 1 WHERE code = ?
          `).run(now, code);
          return { waitUntil: null as number | null };
        }
        if (room.status === 'live' && requested === 'live') return { waitUntil: null as number | null };
        if (room.status === 'live' && (requested === 'closing' || requested === 'ended')) {
          const deadline = now + CLOSE_DRAIN_MS;
          database.prepare(`
            UPDATE rooms SET status = 'closing', close_deadline = ?, revision = revision + 1 WHERE code = ?
          `).run(deadline, code);
          return { waitUntil: requested === 'ended' ? deadline : null };
        }
        if (room.status === 'closing' && requested === 'closing') return { waitUntil: null as number | null };
        if (room.status === 'closing' && requested === 'ended') return { waitUntil: room.close_deadline || now };
        if (room.status === 'ended' && (requested === 'closing' || requested === 'ended')) {
          return { waitUntil: null as number | null };
        }
        throw new AccessError(409, `不允许从 ${room.status} 切换到 ${requested}`);
      });

      if (transition.waitUntil !== null) {
        const remaining = transition.waitUntil - Date.now();
        if (remaining > 0) await wait(remaining + 25);
        maintainRooms(database, Date.now(), code);
      }
      const room = requireRoom(database, code, Date.now());
      return Response.json({ room: snapshot(database, room) });
    }

    throw new AccessError(400, '未知操作');
  } catch (error) {
    return responseError(error);
  }
}
