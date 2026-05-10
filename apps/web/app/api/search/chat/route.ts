import { NextResponse } from 'next/server';

import { getAuthenticatedUserId } from '../../../../lib/auth';
import { runChatTurn } from '../../../../lib/search/agent';
import { loadClientProfile, persistProfileUpdates } from '../../../../lib/search/profile';
import { EMPTY_FILTERS, type ChatRequest } from '../../../../lib/search/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  const userId = await getAuthenticatedUserId();
  if (!userId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let body: ChatRequest;
  try {
    body = (await req.json()) as ChatRequest;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const messages = Array.isArray(body.messages) ? body.messages : [];
  const selectedPills = Array.isArray(body.selected_pills) ? body.selected_pills : [];
  if (messages.length === 0 && selectedPills.length === 0) {
    return NextResponse.json({ error: 'messages or selected_pills required' }, { status: 400 });
  }
  const filters = { ...EMPTY_FILTERS, ...(body.filters ?? {}) };

  try {
    const profileBefore = await loadClientProfile(userId);

    const agent = await runChatTurn({ messages, filters, profile: profileBefore, selectedPills });

    if (Object.keys(agent.profile_updates).length > 0) {
      await persistProfileUpdates(userId, agent.profile_updates);
    }

    // Re-read the profile so the response reflects the current persistent state.
    const profileAfter = await loadClientProfile(userId);

    return NextResponse.json(
      {
        message: agent.message,
        filters: agent.filters,
        profile: profileAfter,
        done: agent.done,
        suggestions: agent.suggestions,
      },
      { status: 200 },
    );
  } catch (err) {
    console.error('[search:chat] agent error:', err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Agent failed' },
      { status: 502 },
    );
  }
}
