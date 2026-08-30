import { isAccessAuthorized } from './access-auth';

export class AccessError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

export function clientIp(request: Request) {
  const forwarded = request.headers.get('cf-connecting-ip') || request.headers.get('x-real-ip') || request.headers.get('x-forwarded-for')?.split(',')[0];
  return (forwarded || 'local').trim().slice(0, 80);
}

export function enforceRate(scope: string, subject: string, limit: number, windowMs: number) {
  void scope;
  void subject;
  void limit;
  void windowMs;
}

export function issueDemoSession(request: Request) {
  if (!isAccessAuthorized(request)) throw new AccessError(401, '请先打开演示页面初始化体验');
  // The old client still expects these fields, but access now comes from the
  // signed HttpOnly cookie and does not expire or consume a quota.
  return { token: 'cookie-authenticated', expiresAt: Number.MAX_SAFE_INTEGER };
}

export function authorizeDemo(request: Request, scope: 'iflytek' | 'transcribe' | 'analyze' | 'report') {
  void scope;
  if (!isAccessAuthorized(request)) throw new AccessError(401, '体验会话无效，请重新打开页面');
}

export function accessErrorResponse(error: unknown) {
  if (error instanceof AccessError) return Response.json({ error: error.message }, { status: error.status });
  return null;
}
