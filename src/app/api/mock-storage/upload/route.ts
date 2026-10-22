import { type NextRequest, NextResponse } from 'next/server';
import { getStorage } from '@/lib/storage';

export async function PUT(request: NextRequest) {
  const url = new URL(request.url);
  const key = url.searchParams.get('key');
  if (!key) {
    return NextResponse.json({ error: 'Missing key parameter' }, { status: 400 });
  }

  const contentType = request.headers.get('content-type') || 'application/octet-stream';
  const arrayBuffer = await request.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);

  const storage = getStorage();
  await storage.putObject(key, buffer, { contentType, upsert: true });

  return NextResponse.json({ success: true, key, size: buffer.length });
}
