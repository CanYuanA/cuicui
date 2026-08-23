import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export const ACCESS_COOKIE_NAME = 'cuicui_access';

const COOKIE_VERSION = 1;

function accessPassword() {
  return process.env.SITE_ACCESS_PASSWORD || '';
}

function signingSecret() {
  const value = process.env.DEMO_SESSION_SECRET;
  if (!value) throw new Error('DEMO_SESSION_SECRET is required for site access cookies');
  return value;
}

function sign(payload: string) {
  return createHmac('sha256', signingSecret()).update(payload).digest('base64url');
}

function safeEqual(left: string, right: string) {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

export function verifyAccessPassword(candidate: string) {
  const expected = accessPassword();
  return Boolean(expected) && safeEqual(candidate, expected);
}

export function issueAccessCookie() {
  const payload = Buffer.from(JSON.stringify({
    v: COOKIE_VERSION,
    nonce: randomBytes(18).toString('base64url'),
  })).toString('base64url');
  return `${payload}.${sign(payload)}`;
}

export function verifyAccessToken(token: string | undefined | null) {
  if (!token) return false;
  const [payload, signature, extra] = token.split('.');
  if (!payload || !signature || extra || !safeEqual(signature, sign(payload))) return false;
  try {
    const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { v?: number };
    return decoded.v === COOKIE_VERSION;
  } catch {
    return false;
  }
}

function cookieValue(request: Request, name: string) {
  const cookieHeader = request.headers.get('cookie') || '';
  for (const entry of cookieHeader.split(';')) {
    const separator = entry.indexOf('=');
    if (separator < 0) continue;
    const key = entry.slice(0, separator).trim();
    if (key !== name) continue;
    try { return decodeURIComponent(entry.slice(separator + 1).trim()); } catch { return ''; }
  }
  return '';
}

export function isAccessAuthorized(request: Request) {
  return verifyAccessToken(cookieValue(request, ACCESS_COOKIE_NAME));
}

export function safeReturnPath(value: unknown) {
  const candidate = typeof value === 'string' ? value.trim() : '';
  if (!candidate.startsWith('/') || candidate.startsWith('//') || candidate.includes('\\')) return '/';
  return candidate;
}
