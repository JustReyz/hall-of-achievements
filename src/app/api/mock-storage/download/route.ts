import { type NextRequest, NextResponse } from 'next/server';
import { getStorage } from '@/lib/storage';

export async function GET(request: NextRequest) {
  const url = new URL(request.url);
  const key = url.searchParams.get('key');
  const filename = url.searchParams.get('download');

  if (!key) {
    return NextResponse.json({ error: 'Missing key parameter' }, { status: 400 });
  }

  const storage = getStorage();
  try {
    const obj = await storage.getObject(key);
    const headers = new Headers();
    headers.set('Content-Type', obj.metadata.mimeType || 'application/octet-stream');
    headers.set('Content-Length', String(obj.data.length));
    headers.set('Cache-Control', 'private, no-store, no-cache, must-revalidate');

    if (filename) {
      headers.set('Content-Disposition', `attachment; filename="${filename}"`);
    }

    return new NextResponse(new Uint8Array(obj.data), {
      status: 200,
      headers,
    });
  } catch {
    return NextResponse.json({ error: 'Object not found' }, { status: 404 });
  }
}
