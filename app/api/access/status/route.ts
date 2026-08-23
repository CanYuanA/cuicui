import { isAccessAuthorized } from '../../../server/access-auth';

export async function GET(request: Request) {
  return Response.json(
    { authenticated: isAccessAuthorized(request) },
    { headers: { 'Cache-Control': 'no-store, private' } },
  );
}
