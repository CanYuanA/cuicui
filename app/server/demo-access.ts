import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

type RateEntry = { count: number; resetAt: number };
type SharedState = { rates: Map<string, RateEntry> };

const stateKey = Symbol.for('cuicui.demo-access');
const shared = globalThis as typeof globalThis & { [stateKey]?: SharedState };
const state = shared[stateKey] ||= { rates: new Map() };

export class AccessError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

export function clientIp(request: Request) {
  const forwarded = request.headers.get('cf-connecting-ip') || request.headers.get('x-real-ip') || request.headers.get('x-forwarded-for')?.split(',')[0];
  return (forwarded || 'local').trim().slice(0, 80);
}

export function enforceRate(scope: string, subject: string, limit: number, windowMs: number) {
  const now = Date.now();
  const key = `${scope}:${subject}`;
  const current = state.rates.get(key);
  if (!current || current.resetAt <= now) {
    state.rates.set(key, { count: 1, resetAt: now + windowMs });
    return;
  }
  if (current.count >= limit) throw new AccessError(429, '体验额度已达上限，请稍后再试');
  current.count += 1;
}

function secret() {
  const value = process.env.DEMO_SESSION_SECRET || process.env.IFLYTEK_API_SECRET || process.env.OPENROUTER_API_KEY;
  if (!value) throw new AccessError(503, '体验服务尚未配置');
  return value;
}

function ipDigest(ip: string) {
  return createHash('sha256').update(`${secret()}:${ip}`).digest('base64url').slice(0, 18);
}

export function issueDemoSession(request: Request) {
  const ip = clientIp(request);
  enforceRate('session-issue', ip, 10, 60 * 60 * 1000);
  const expiresAt = Date.now() + 2 * 60 * 60 * 1000;
  const payload = Buffer.from(JSON.stringify({ exp: expiresAt, ip: ipDigest(ip), nonce: randomBytes(10).toString('hex') })).toString('base64url');
  const signature = createHmac('sha256', secret()).update(payload).digest('base64url');
  return { token: `${payload}.${signature}`, expiresAt };
}

export function authorizeDemo(request: Request, scope: 'iflytek' | 'transcribe' | 'analyze' | 'report') {
  const token = request.headers.get('x-cuicui-session') || '';
  const [payload, signature] = token.split('.');
  if (!payload || !signature) throw new AccessError(401, '体验会话无效，请刷新页面重试');
  const expected = createHmac('sha256', secret()).update(payload).digest();
  let supplied: Buffer;
  try { supplied = Buffer.from(signature, 'base64url'); } catch { throw new AccessError(401, '体验会话无效'); }
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) throw new AccessError(401, '体验会话无效');
  let decoded: { exp?: number; ip?: string };
  try { decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')); } catch { throw new AccessError(401, '体验会话无效'); }
  const ip = clientIp(request);
  if (!decoded.exp || decoded.exp < Date.now() || decoded.ip !== ipDigest(ip)) throw new AccessError(401, '体验会话已过期，请刷新页面');
  const limits = { iflytek: 10, transcribe: 150, analyze: 80, report: 12 } as const;
  enforceRate(`paid-${scope}`, `${decoded.ip}:${payload.slice(-16)}`, limits[scope], 2 * 60 * 60 * 1000);
  const globalLimits = { iflytek: 500, transcribe: 1800, analyze: 900, report: 180 } as const;
  enforceRate(`global-${scope}`, new Date().toISOString().slice(0, 10), globalLimits[scope], 24 * 60 * 60 * 1000);
}

export function accessErrorResponse(error: unknown) {
  if (error instanceof AccessError) return Response.json({ error: error.message }, { status: error.status });
  return null;
}
