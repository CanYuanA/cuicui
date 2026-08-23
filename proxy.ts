import { NextResponse, type NextRequest } from 'next/server';
import { ACCESS_COOKIE_NAME, verifyAccessToken } from './app/server/access-auth';

const OPEN_PATHS = new Set([
  '/access',
  '/api/access/login',
  '/api/access/logout',
  '/api/access/status',
  '/api/health',
  '/favicon.svg',
  '/favicon.ico',
  '/og.png',
]);

export function proxy(request: NextRequest) {
  const { pathname, search } = request.nextUrl;
  if (OPEN_PATHS.has(pathname) || verifyAccessToken(request.cookies.get(ACCESS_COOKIE_NAME)?.value)) {
    return NextResponse.next();
  }

  if (pathname.startsWith('/api/')) {
    return NextResponse.json(
      { error: '请先输入访问密码' },
      { status: 401, headers: { 'Cache-Control': 'no-store' } },
    );
  }

  const loginUrl = request.nextUrl.clone();
  loginUrl.pathname = '/access';
  loginUrl.search = '';
  loginUrl.searchParams.set('next', `${pathname}${search}`);
  return NextResponse.redirect(loginUrl);
}

export const config = {
  matcher: ['/((?!_next/static|_next/image).*)'],
};
