import { NextResponse, type NextRequest } from 'next/server';
import { ACCESS_COOKIE_NAME, issueAccessCookie, verifyAccessToken } from './app/server/access-auth';

const OPEN_PATHS = new Set([
  '/api/health',
  '/favicon.svg',
  '/favicon.ico',
  '/og.png',
]);

export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  if (OPEN_PATHS.has(pathname)) return NextResponse.next();

  const authorized = verifyAccessToken(request.cookies.get(ACCESS_COOKIE_NAME)?.value);
  if (authorized) return NextResponse.next();

  if (pathname.startsWith('/api/')) {
    return NextResponse.json(
      { error: '请先打开演示页面初始化体验' },
      { status: 401, headers: { 'Cache-Control': 'no-store' } },
    );
  }

  const response = NextResponse.next();
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

export const config = {
  matcher: ['/((?!_next/static|_next/image).*)'],
};
