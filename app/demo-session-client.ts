'use client';

type CachedSession = { token: string; expiresAt: number };
let pending: Promise<string> | null = null;

export async function getDemoSession() {
  try {
    const cached = JSON.parse(sessionStorage.getItem('cuicui-demo-session') || 'null') as CachedSession | null;
    if (cached?.token && cached.expiresAt > Date.now() + 60_000) return cached.token;
  } catch { /* storage is optional */ }
  if (!pending) {
    pending = fetch('/api/demo-session', { method: 'POST', cache: 'no-store' }).then(async (response) => {
      const payload = await response.json() as Partial<CachedSession> & { error?: string };
      if (!response.ok || !payload.token || !payload.expiresAt) throw new Error(payload.error || '无法创建体验会话');
      const session = { token: payload.token, expiresAt: payload.expiresAt };
      try { sessionStorage.setItem('cuicui-demo-session', JSON.stringify(session)); } catch { /* optional */ }
      return session.token;
    }).finally(() => { pending = null; });
  }
  return pending;
}
