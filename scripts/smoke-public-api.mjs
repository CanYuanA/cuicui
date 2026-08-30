const baseUrl = (process.env.BASE_URL || 'http://localhost:3000').replace(/\/$/, '');
const entryResponse = await fetch(`${baseUrl}/`, { cache: 'no-store' });
const setCookieHeaders = typeof entryResponse.headers.getSetCookie === 'function'
  ? entryResponse.headers.getSetCookie()
  : [entryResponse.headers.get('set-cookie') || ''];
const accessSetCookie = setCookieHeaders
  .flatMap((header) => header.split(/,(?=\s*[^;,=\s]+=[^;,]*)/))
  .find((header) => /^\s*cuicui_access=/.test(header));
const accessCookie = (accessSetCookie || '').trim().split(';')[0];
if (!entryResponse.ok || !accessCookie) throw new Error(`无感体验会话初始化失败（HTTP ${entryResponse.status}）`);

const sessionResponse = await fetch(`${baseUrl}/api/demo-session`, {
  method: 'POST',
  headers: { Cookie: accessCookie },
});
const session = await sessionResponse.json().catch(() => ({}));
const healthResponse = await fetch(`${baseUrl}/api/health`, { cache: 'no-store' });
const health = await healthResponse.json().catch(() => ({}));
const [unauthorizedStt, unauthorizedAnalyze, unauthorizedReport, unauthorizedIflytek] = await Promise.all([
  fetch(`${baseUrl}/api/transcribe`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ audioBase64: 'AAAA', format: 'webm' }),
  }),
  fetch(`${baseUrl}/api/analyze`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ transcript: [] }),
  }),
  fetch(`${baseUrl}/api/report`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ transcript: [] }),
  }),
  fetch(`${baseUrl}/api/iflytek-auth`),
]);

const checks = {
  passwordlessEntry: !entryResponse.url.includes('/access'),
  demoSessionIssued: sessionResponse.ok && typeof session.token === 'string',
  paidEndpointsProtected: [unauthorizedStt, unauthorizedAnalyze, unauthorizedReport, unauthorizedIflytek]
    .every((response) => response.status === 401),
  glmModelsConfigured: healthResponse.ok
    && health.models?.analysis === 'z-ai/glm-5.3-flash'
    && health.models?.report === 'z-ai/glm-5.3-flash',
};
const ok = Object.values(checks).every(Boolean);
console.log(JSON.stringify({ ok, baseUrl, checks }, null, 2));
if (!ok) process.exitCode = 1;

// Run the full create/join/live/partial/final/closing/ended lifecycle against
// the same public origin. This module never prints credentials or room tokens.
await import('./verify-room-api.mjs');
