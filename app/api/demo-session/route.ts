import { accessErrorResponse, issueDemoSession } from '../../server/demo-access';

export async function POST(request: Request) {
  try {
    return Response.json(issueDemoSession(request), { headers: { 'Cache-Control': 'no-store, private' } });
  } catch (error) {
    return accessErrorResponse(error) || Response.json({ error: '暂时无法验证访问状态' }, { status: 500 });
  }
}
