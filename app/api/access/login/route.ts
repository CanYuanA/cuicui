import { NextResponse } from 'next/server';
import {
  ACCESS_COOKIE_NAME,
  issueAccessCookie,
  safeReturnPath,
  verifyAccessPassword,
} from '../../../server/access-auth';

const MAX_LOGIN_BODY_BYTES = 4096;

function setAccessCookie(response: NextResponse) {
  response.cookies.set({
    name: ACCESS_COOKIE_NAME,
    value: issueAccessCookie(),
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
  });
  response.headers.set('Cache-Control', 'no-store, private');
  return response;
}

export async function POST(request: Request) {
  const contentLength = Number(request.headers.get('content-length') || 0);
  if (Number.isFinite(contentLength) && contentLength > MAX_LOGIN_BODY_BYTES) {
    return NextResponse.json({ error: '请求内容过大' }, { status: 413, headers: { 'Cache-Control': 'no-store' } });
  }
  const contentType = request.headers.get('content-type') || '';
  if (contentType.includes('application/json')) {
    const body = await request.json().catch(() => ({})) as { password?: unknown };
    if (!verifyAccessPassword(String(body.password || ''))) {
      return NextResponse.json({ error: '密码不正确' }, { status: 401, headers: { 'Cache-Control': 'no-store' } });
    }
    return setAccessCookie(NextResponse.json({ ok: true }));
  }

  const form = await request.formData().catch(() => new FormData());
  const nextPath = safeReturnPath(form.get('next'));
  if (!verifyAccessPassword(String(form.get('password') || ''))) {
    const failureUrl = new URL('/access', request.url);
    failureUrl.searchParams.set('error', '1');
    failureUrl.searchParams.set('next', nextPath);
    return NextResponse.redirect(failureUrl, 303);
  }
  return setAccessCookie(NextResponse.redirect(new URL(nextPath, request.url), 303));
}
