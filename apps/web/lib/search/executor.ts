import 'server-only';

import Anthropic from '@anthropic-ai/sdk';

import { createServiceClient } from '../supabase/service';

import { getCurrentClientUserId, loadClientProfile } from './profile';
import type { ClientProfile, SearchFilters } from './types';

const MODEL = 'claude-haiku-4-5';
const FETCH_LIMIT = 60;
const SAVE_LIMIT = 12;

export interface FeedRowOut {
  id: string;
  posting_id: string;
  match_score: number;
  report_summary: string;
  report_highlights: { pros: string[]; cons: string[] } | null;
}

export interface ExecuteAndSaveResult {
  search_id: string;
  saved: number;
  total_candidates: number;
  rows: FeedRowOut[];
  notice: string | null;
}

interface PropiedadRow {
  posting_id: string;
  url: string | null;
  image_urls: string[] | null;
  address: string | null;
  neighborhood: string | null;
  city: string | null;
  price_value: number | null;
  price_type: string | null;
  expenses_value: number | null;
  square_meters_area: number | null;
  rooms: number | null;
  bedrooms: number | null;
  bathrooms: number | null;
  parking: number | null;
  description: string | null;
  description_summary?: string | null;
}

const PROP_SELECT =
  'posting_id, url, image_urls, address, neighborhood, city, price_value, price_type, expenses_value, square_meters_area, rooms, bedrooms, bathrooms, parking, description, description_summary';
const PROP_SELECT_FALLBACK =
  'posting_id, url, image_urls, address, neighborhood, city, price_value, price_type, expenses_value, square_meters_area, rooms, bedrooms, bathrooms, parking, description';

let anthropic: Anthropic | null = null;
function getClient(): Anthropic {
  if (anthropic) return anthropic;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not set');
  anthropic = new Anthropic({ apiKey });
  return anthropic;
}

export async function executeAndSave(
  filters: SearchFilters,
  authenticatedUserId?: string,
): Promise<ExecuteAndSaveResult> {
  const supabase = createServiceClient();
  const userId = authenticatedUserId ?? (await getCurrentClientUserId());
  const profile = await loadClientProfile(userId);

  const candidates = await queryProperties(filters);
  if (candidates.length === 0) {
    return {
      search_id: crypto.randomUUID(),
      saved: 0,
      total_candidates: 0,
      rows: [],
      notice: 'No se encontraron propiedades que matcheen estos filtros. Probá ampliar criterios.',
    };
  }

  const search_id = crypto.randomUUID();
  const top = candidates.slice(0, SAVE_LIMIT);

  const enriched = await Promise.all(
    top.map(async (p) => {
      const score = scoreCandidate(p, filters);
      let report_summary: string | null = null;
      let report_highlights: { pros: string[]; cons: string[] } | null = null;
      try {
        const ai = await summarizeOne(p, filters, profile);
        report_summary = ai.summary;
        report_highlights = { pros: ai.pros, cons: ai.cons };
      } catch (err) {
        console.warn('[executor] summarize failed for', p.posting_id, (err as Error).message);
        report_summary = fallbackSummary(p);
      }
      return { p, score, report_summary, report_highlights };
    }),
  );

  const rowsToInsert = enriched.map(({ p, score, report_summary, report_highlights }) => ({
    user_id: userId,
    search_id,
    posting_id: p.posting_id,
    filters: filters as unknown as Record<string, unknown>,
    match_score: score,
    report_summary,
    report_highlights,
    status: 'pending' as const,
  }));

  // Idempotent on (search_id, posting_id) thanks to the unique index — but insert
  // can still error on the conflict, so use upsert.
  const { data, error } = await supabase
    .from('feed_results')
    .upsert(rowsToInsert, { onConflict: 'search_id,posting_id', ignoreDuplicates: false })
    .select('id, posting_id, match_score, report_summary, report_highlights');

  if (error) {
    console.error('[executor] insert feed_results failed:', error);
    throw new Error(`Failed to persist pending: ${error.message}`);
  }

  const rows: FeedRowOut[] = (data ?? []).map((r) => ({
    id: r.id,
    posting_id: r.posting_id,
    match_score: r.match_score ?? 0,
    report_summary: r.report_summary ?? '',
    report_highlights:
      r.report_highlights && typeof r.report_highlights === 'object'
        ? (r.report_highlights as { pros: string[]; cons: string[] })
        : null,
  }));

  // Trigger analysis generation for items with score > 70 (fire-and-forget)
  const itemsNeedingAnalysis = enriched.filter(({ score }) => score > 70).map(({ p }) => p);

  if (itemsNeedingAnalysis.length > 0) {
    triggerAnalysisGeneration(itemsNeedingAnalysis).catch((err) => {
      console.warn('[executor] analysis generation failed (non-blocking):', err);
    });
  }

  return {
    search_id,
    saved: rows.length,
    total_candidates: candidates.length,
    rows,
    notice: null,
  };
}

interface PropQueryResult {
  data: PropiedadRow[] | null;
  error: { message: string } | null;
}

interface PropQueryBuilder {
  select(cols: string): PropQueryBuilder;
  not(col: string, op: string, val: unknown): PropQueryBuilder;
  in(col: string, vals: unknown[]): PropQueryBuilder;
  or(filter: string): PropQueryBuilder;
  ilike(col: string, pattern: string): PropQueryBuilder;
  lte(col: string, val: unknown): PropQueryBuilder;
  gte(col: string, val: unknown): PropQueryBuilder;
  eq(col: string, val: unknown): PropQueryBuilder;
  order(col: string, opts: { ascending: boolean }): PropQueryBuilder;
  limit(n: number): Promise<PropQueryResult>;
}

async function queryProperties(filters: SearchFilters): Promise<PropiedadRow[]> {
  const supabase = createServiceClient();

  async function run(cols: string): Promise<PropQueryResult> {
    let q = (supabase.from('propiedades' as never) as unknown as PropQueryBuilder)
      .select(cols)
      .not('url', 'is', null);

    if (filters.neighborhoods.length > 0) {
      // Use ilike for each neighborhood so "Palermo" matches "Palermo Soho", "Palermo Hollywood", etc.
      const orFilter = filters.neighborhoods.map((n) => `neighborhood.ilike.%${n}%`).join(',');
      q = q.or(orFilter);
    }
    if (filters.price_max !== null) {
      q = q.lte('price_value', filters.price_max);
      // Only filter by price_type for USD; ARS properties may be stored as "$" or "ARS"
      if (filters.price_currency === 'USD') {
        q = q.eq('price_type', 'USD');
      } else if (filters.price_currency === 'ARS') {
        q = q.not('price_type', 'eq', 'USD');
      }
    }
    if (filters.min_rooms !== null) q = q.gte('rooms', filters.min_rooms);
    if (filters.max_rooms !== null) q = q.lte('rooms', filters.max_rooms);
    return q.order('scraped_at', { ascending: false }).limit(FETCH_LIMIT);
  }

  let { data, error } = await run(PROP_SELECT);
  if (error) {
    console.warn('[executor] fallback select (no description_summary):', error.message);
    ({ data, error } = await run(PROP_SELECT_FALLBACK));
  }

  if (error || !data) {
    console.error('[executor] queryProperties failed', error);
    return [];
  }
  return data;
}

function scoreCandidate(p: PropiedadRow, filters: SearchFilters): number {
  let score = 60;

  if (
    filters.neighborhoods.length > 0 &&
    p.neighborhood &&
    filters.neighborhoods.includes(p.neighborhood)
  ) {
    score += 15;
  }
  if (filters.price_max !== null && p.price_value !== null && p.price_value <= filters.price_max) {
    const ratio = p.price_value / filters.price_max;
    if (ratio < 0.85) score += 10;
    else if (ratio < 0.95) score += 5;
  }
  if (filters.min_rooms !== null && p.rooms !== null && p.rooms >= filters.min_rooms) score += 5;
  if (filters.max_rooms !== null && p.rooms !== null && p.rooms <= filters.max_rooms) score += 5;

  // Feature mentions inside description / description_summary
  const features = filters.must_have_features ?? [];
  if (features.length > 0) {
    const hay = stripAccents(
      `${p.description ?? ''} ${p.description_summary ?? ''} ${p.address ?? ''} ${p.neighborhood ?? ''}`.toLowerCase(),
    );
    const hits = features.filter((f) =>
      hay.includes(stripAccents(f.replace(/_/g, ' ').toLowerCase())),
    ).length;
    score += Math.min(15, hits * 5);
  }

  return Math.max(0, Math.min(100, Math.round(score)));
}

function stripAccents(text: string): string {
  return text.normalize('NFD').replace(/[̀-ͯ]/g, '');
}

interface AISummary {
  summary: string;
  pros: string[];
  cons: string[];
}

async function summarizeOne(
  p: PropiedadRow,
  filters: SearchFilters,
  profile: ClientProfile,
): Promise<AISummary> {
  const prompt = `Sos Casita, una IA que analiza propiedades inmobiliarias en Argentina y le explica al usuario por qué una propiedad puede o no servirle.

Filtros del usuario: ${JSON.stringify(filters)}
Perfil del usuario: ${JSON.stringify(profile)}

Propiedad:
- Dirección: ${p.address ?? '—'} (${p.neighborhood ?? p.city ?? '—'})
- Precio: ${p.price_value ? `${p.price_type ?? '$'} ${p.price_value}` : '—'}${p.expenses_value ? ` + expensas $${p.expenses_value}` : ''}
- Ambientes: ${p.rooms ?? '—'} · Dorm: ${p.bedrooms ?? '—'} · Baños: ${p.bathrooms ?? '—'} · Cochera: ${p.parking ?? 0}
- Superficie: ${p.square_meters_area ? `${p.square_meters_area} m²` : '—'}
- Descripción: ${(p.description_summary ?? p.description ?? '').slice(0, 800)}

Devolvé EXCLUSIVAMENTE un JSON válido (sin code fences, sin texto extra) con este shape:
{
  "summary": "1-2 oraciones cortas en castellano rioplatense explicando el match con el usuario.",
  "pros": ["punto fuerte 1", "punto fuerte 2"],
  "cons": ["punto débil 1", "punto débil 2"]
}

Cada pro/con: máximo 8 palabras. Sin emojis. Sin invenciones: si no hay info, omitilo.`;

  const res = await getClient().messages.create({
    model: MODEL,
    max_tokens: 350,
    messages: [{ role: 'user', content: prompt }],
  });

  const text = res.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('')
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```\s*$/i, '')
    .trim();

  try {
    const parsed = JSON.parse(text) as Partial<AISummary>;
    return {
      summary: typeof parsed.summary === 'string' ? parsed.summary : fallbackSummary(p),
      pros: Array.isArray(parsed.pros)
        ? parsed.pros.filter((s): s is string => typeof s === 'string').slice(0, 4)
        : [],
      cons: Array.isArray(parsed.cons)
        ? parsed.cons.filter((s): s is string => typeof s === 'string').slice(0, 4)
        : [],
    };
  } catch {
    return { summary: fallbackSummary(p), pros: [], cons: [] };
  }
}

function fallbackSummary(p: PropiedadRow): string {
  const where = p.neighborhood ?? p.city ?? 'CABA';
  const ambs = p.rooms ? `${p.rooms} amb` : 'depto';
  const m2 = p.square_meters_area ? `${Math.round(p.square_meters_area)} m²` : '';
  const price = p.price_value
    ? `${p.price_type === 'USD' ? 'USD' : '$'} ${new Intl.NumberFormat('es-AR').format(Math.round(p.price_value))}`
    : '';
  return `${ambs} en ${where}${m2 ? `, ${m2}` : ''}${price ? `, ${price}` : ''}.`;
}

async function triggerAnalysisGeneration(properties: PropiedadRow[]): Promise<void> {
  const apiUrl = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000';

  for (const prop of properties) {
    if (!prop.neighborhood) continue;

    try {
      await fetch(`${apiUrl}/analysis/analyze`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ neighborhood: prop.neighborhood }),
        signal: AbortSignal.timeout(180000),
      });
      console.log(`[executor] triggered analysis for ${prop.posting_id}`);
    } catch (err) {
      console.warn(
        `[executor] failed to trigger analysis for ${prop.posting_id}:`,
        (err as Error).message,
      );
    }
  }
}
