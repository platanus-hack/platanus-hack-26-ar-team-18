import { NextResponse } from 'next/server';

import { getAuthenticatedUserId } from '../../../../../lib/auth';
import { sendOutbound } from '../../../../../lib/kapso/messaging';
import { createServiceClient } from '../../../../../lib/supabase/service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface SendBody {
  body?: string;
}

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const userId = await getAuthenticatedUserId();
  if (!userId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { id } = await ctx.params;
  let payload: SendBody;
  try {
    payload = (await req.json()) as SendBody;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  if (!payload.body || !payload.body.trim()) {
    return NextResponse.json({ error: 'Missing body' }, { status: 400 });
  }

  const supabase = createServiceClient();
  const { data: chat, error } = await supabase
    .from('chats')
    .select('id, phone_e164, last_inbound_at, user_id')
    .eq('id', id)
    .eq('user_id', userId)
    .single();

  if (error || !chat) {
    return NextResponse.json({ error: 'Chat not found' }, { status: 404 });
  }

  try {
    const result = await sendOutbound(chat, payload.body.trim());
    return NextResponse.json(result, { status: 200 });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Send failed' },
      { status: 502 },
    );
  }
}
