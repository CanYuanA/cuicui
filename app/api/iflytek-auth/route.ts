const encoder = new TextEncoder();

function toBase64(value: ArrayBuffer | Uint8Array | string) {
  const bytes = typeof value === 'string'
    ? encoder.encode(value)
    : value instanceof Uint8Array
      ? value
      : new Uint8Array(value);
  let binary = '';
  for (let index = 0; index < bytes.length; index += 8192) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 8192));
  }
  return btoa(binary);
}

export async function GET() {
  const appId = process.env.IFLYTEK_APP_ID;
  const apiKey = process.env.IFLYTEK_API_KEY;
  const apiSecret = process.env.IFLYTEK_API_SECRET;
  if (!appId || !apiKey || !apiSecret) {
    return Response.json({ error: '讯飞听写服务尚未配置，请使用开卷演示模式。' }, { status: 503 });
  }

  const host = 'iat-api.xfyun.cn';
  const path = '/v2/iat';
  const date = new Date().toUTCString();
  const signatureOrigin = `host: ${host}\ndate: ${date}\nGET ${path} HTTP/1.1`;
  const key = await crypto.subtle.importKey(
    'raw', encoder.encode(apiSecret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  const digest = await crypto.subtle.sign('HMAC', key, encoder.encode(signatureOrigin));
  const signature = toBase64(digest);
  const authorizationOrigin = `api_key="${apiKey}", algorithm="hmac-sha256", headers="host date request-line", signature="${signature}"`;
  const query = new URLSearchParams({ authorization: toBase64(authorizationOrigin), date, host });

  return Response.json(
    { url: `wss://${host}${path}?${query.toString()}`, appId, expiresIn: 300 },
    { headers: { 'Cache-Control': 'no-store, private', Pragma: 'no-cache' } },
  );
}
