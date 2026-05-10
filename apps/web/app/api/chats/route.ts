import { NextResponse } from 'next/server';

import { getAuthenticatedUserId } from '../../../lib/auth';
import { kapsoEnv } from '../../../lib/kapso/env';
import { sendOutbound } from '../../../lib/kapso/messaging';
import { toE164 } from '../../../lib/kapso/phone';
import { createServiceClient } from '../../../lib/supabase/service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface CreateChatBody {
  posting_id?: string;
  phone?: string;
  contact_name?: string;
  initial_message?: string;
}

export async function POST(req: Request) {
  const userId = await getAuthenticatedUserId();
  if (!userId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let body: CreateChatBody;
  try {
    body = (await req.json()) as CreateChatBody;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const env = kapsoEnv();

  // Resolve destination phone: explicit `phone`, or pulled from `propiedades.seller_whatsapp_digits`.
  const supabase = createServiceClient();
  let phoneRaw = body.phone ?? null;
  const postingId = body.posting_id ?? null;

  if (!phoneRaw && postingId) {
    const { data: prop, error: propErr } = await supabase
      .from('propiedades' as never)
      .select('seller_whatsapp_digits' as never)
      .eq('posting_id' as never, postingId as never)
      .maybeSingle();
    if (propErr) {
      return NextResponse.json(
        { error: `Propiedad lookup failed: ${propErr.message}` },
        { status: 500 },
      );
    }
    const sellerPhone =
      (prop as { seller_whatsapp_digits?: string | null } | null)?.seller_whatsapp_digits ?? null;
    if (!sellerPhone) {
      return NextResponse.json({ error: 'Propiedad sin seller_whatsapp_digits' }, { status: 404 });
    }
    phoneRaw = sellerPhone;
  }
  if (!phoneRaw) {
    return NextResponse.json({ error: 'Missing phone or posting_id' }, { status: 400 });
  }

  let phoneE164: string;
  try {
    phoneE164 = toE164(phoneRaw, env.KAPSO_DEFAULT_COUNTRY_ISO);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Invalid phone' },
      { status: 400 },
    );
  }

  // Upsert chat by phone (one chat per destination).
  const { data: existing } = await supabase
    .from('chats')
    .select('id, phone_e164, last_inbound_at')
    .eq('phone_e164', phoneE164)
    .eq('user_id', userId)
    .maybeSingle();

  let chat = existing;
  if (!chat) {
    const { data: created, error } = await supabase
      .from('chats')
      .insert({
        phone_e164: phoneE164,
        propiedad_posting_id: postingId,
        contact_name: body.contact_name ?? null,
        user_id: userId,
      })
      .select('id, phone_e164, last_inbound_at')
      .single();
    if (error || !created) {
      return NextResponse.json(
        { error: error?.message ?? 'Failed to create chat' },
        { status: 500 },
      );
    }
    chat = created;
  }

  if (body.initial_message) {
    try {
      const result = await sendOutbound(chat, body.initial_message);
      return NextResponse.json({ chat, sent: result }, { status: 201 });
    } catch (err) {
      return NextResponse.json(
        { chat, error: err instanceof Error ? err.message : 'Send failed' },
        { status: 502 },
      );
    }
  }

  return NextResponse.json({ chat }, { status: 201 });
}
