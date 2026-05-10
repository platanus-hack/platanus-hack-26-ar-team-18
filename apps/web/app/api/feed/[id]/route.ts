import { NextResponse } from 'next/server';

import { getAuthenticatedUserId } from '../../../../lib/auth';
import { createServiceClient } from '../../../../lib/supabase/service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface PatchBody {
  status?: 'accepted' | 'rejected';
}

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const userId = await getAuthenticatedUserId();
  if (!userId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { id } = await params;
  if (!id) return NextResponse.json({ error: 'Missing id' }, { status: 400 });

  let body: PatchBody;
  try {
    body = (await req.json()) as PatchBody;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const status = body.status;
  if (status !== 'accepted' && status !== 'rejected') {
    return NextResponse.json({ error: 'status must be "accepted" or "rejected"' }, { status: 400 });
  }

  const supabase = createServiceClient();
  const { data, error } = await supabase
    .from('feed_results')
    .update({ status, decided_at: new Date().toISOString() })
    .eq('id', id)
    .eq('user_id', userId)
    .select('id')
    .maybeSingle();

  if (error) {
    console.error('[feed] update failed:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  if (!data) {
    return NextResponse.json({ error: 'Feed result not found' }, { status: 404 });
  }

  return NextResponse.json({ ok: true, status }, { status: 200 });
}
