import { NextResponse } from 'next/server';
import { ACCESS_COOKIE_NAME } from '../../../server/access-auth';

export async function POST(request: Request) {
  const response = NextResponse.redirect(new URL('/access', request.url), 303);
  response.cookies.set({
    name: ACCESS_COOKIE_NAME,
    value: '',
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict',
    path: '/',
    maxAge: 0,
  });
  response.headers.set('Cache-Control', 'no-store, private');
  return response;
}
