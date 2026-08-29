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

const sessionResponse = await fetch(`${baseUrl}/api/demo-session`, {
  method: 'POST',
  headers: { Cookie: accessCookie },
});
const session = await sessionResponse.json().catch(() => ({}));
const unauthorizedStt = await fetch(`${baseUrl}/api/transcribe`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ audioBase64: 'AAAA', format: 'webm' }),
});

const checks = {
  demoSessionIssued: sessionResponse.ok && typeof session.token === 'string',
  paidEndpointProtected: unauthorizedStt.status === 401,
};
const ok = Object.values(checks).every(Boolean);
console.log(JSON.stringify({ ok, baseUrl, checks }, null, 2));
if (!ok) process.exitCode = 1;

// Run the full create/join/live/partial/final/closing/ended lifecycle against
// the same public origin. This module never prints credentials or room tokens.
await import('./verify-room-api.mjs');
