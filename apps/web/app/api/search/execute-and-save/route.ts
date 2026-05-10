import { NextResponse } from 'next/server';

import { getAuthenticatedUserId } from '../../../../lib/auth';
import { executeAndSave } from '../../../../lib/search/executor';
import { EMPTY_FILTERS, type SearchFilters } from '../../../../lib/search/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface ExecuteRequestBody {
  filters?: Partial<SearchFilters>;
}

export async function POST(req: Request) {
  const userId = await getAuthenticatedUserId();
  if (!userId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let body: ExecuteRequestBody;
  try {
    body = (await req.json()) as ExecuteRequestBody;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const filters: SearchFilters = { ...EMPTY_FILTERS, ...(body.filters ?? {}) };
  if (
    filters.neighborhoods.length === 0 &&
    filters.price_max === null &&
    filters.min_rooms === null &&
    filters.max_rooms === null &&
    filters.must_have_features.length === 0
  ) {
    return NextResponse.json(
      { error: 'Filters are too broad. At least one criterion is required.' },
      { status: 400 },
    );
  }

  try {
    const result = await executeAndSave(filters, userId);
    return NextResponse.json(result, { status: 200 });
  } catch (err) {
    console.error('[search:execute-and-save] failed:', err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Execution failed' },
      { status: 502 },
    );
  }
}
