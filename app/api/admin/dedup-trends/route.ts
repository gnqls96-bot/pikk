import { NextRequest, NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase/server'
import { findDuplicateGroupsInCategory } from '@/lib/utils/aiDedup'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 300

interface TrendRow {
  id: string
  title: string
  summary: string
  category: string
  instagram_post_id: string | null
  published_at: string
  source_url: string | null
}

const PLACEHOLDER_IDS = new Set(['skipped', 'PUBLISHING', 'duplicate_removed'])

function isRealPostId(id: string | null): boolean {
  if (!id) return false
  return !PLACEHOLDER_IDS.has(id)
}

// GET /api/admin/dedup-trends?secret=CRON_SECRET[&dry_run=false]
// Scans ALL trends for duplicates (same specific event) using Claude Haiku.
// Default: dry_run=true (report only). Pass dry_run=false to actually write.
export async function GET(req: NextRequest) {
  const secret = req.nextUrl.searchParams.get('secret')
  if (secret !== process.env.CRON_SECRET && secret !== process.env.ADMIN_PASSWORD) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const dryRun = req.nextUrl.searchParams.get('dry_run') !== 'false'
  const apiKey = process.env.ANTHROPIC_API_KEY ?? ''
  if (!apiKey) return NextResponse.json({ error: 'ANTHROPIC_API_KEY not set' }, { status: 500 })

  const supabase = createServerClient()

  // Fetch all trends (paginated 1000/page)
  const allTrends: TrendRow[] = []
  let offset = 0
  while (true) {
    const { data, error } = await supabase
      .from('trends')
      .select('id, title, summary, category, instagram_post_id, published_at, source_url')
      .order('published_at', { ascending: true })
      .range(offset, offset + 999)
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    if (!data || data.length === 0) break
    allTrends.push(...(data as TrendRow[]))
    if (data.length < 1000) break
    offset += 1000
  }

  // Group by category
  const byCategory: Record<string, TrendRow[]> = {}
  for (const t of allTrends) {
    if (!byCategory[t.category]) byCategory[t.category] = []
    byCategory[t.category].push(t)
  }

  const report: {
    category: string
    kept_id: string
    kept_title: string
    kept_published_to_ig: boolean
    removed: { id: string; title: string; was: string | null }[]
    reason: string
  }[] = []

  // Process each category
  for (const [category, catTrends] of Object.entries(byCategory)) {
    if (catTrends.length < 2) continue

    const groups = await findDuplicateGroupsInCategory(catTrends, apiKey)

    for (const group of groups) {
      if (!group.ids || group.ids.length < 2) continue
      const groupTrends = group.ids
        .map(id => allTrends.find(t => t.id === id))
        .filter(Boolean) as TrendRow[]
      if (groupTrends.length < 2) continue

      // Keep: 1) already published to IG (real post ID), 2) earliest published_at (groupTrends sorted asc)
      const publishedOne = groupTrends.find(t => isRealPostId(t.instagram_post_id))
      const keep = publishedOne ?? groupTrends[0]
      const toRemove = groupTrends.filter(t => t.id !== keep.id)

      // Only mark rows that don't have a real IG post ID (never published)
      const safeToRemove = toRemove.filter(t => !isRealPostId(t.instagram_post_id))
      if (safeToRemove.length === 0) continue

      report.push({
        category,
        kept_id: keep.id,
        kept_title: keep.title,
        kept_published_to_ig: isRealPostId(keep.instagram_post_id),
        removed: safeToRemove.map(t => ({ id: t.id, title: t.title, was: t.instagram_post_id })),
        reason: group.reason,
      })

      if (!dryRun) {
        for (const t of safeToRemove) {
          const { error: updateErr } = await supabase
            .from('trends')
            .update({ instagram_post_id: 'duplicate_removed' })
            .eq('id', t.id)
          if (updateErr) console.error('dedup update error', t.id, updateErr.message)
        }
      }
    }
  }

  const totalRemoved = report.reduce((sum, r) => sum + r.removed.length, 0)

  return NextResponse.json({
    dry_run: dryRun,
    total_scanned: allTrends.length,
    duplicate_groups_found: report.length,
    total_removed: dryRun ? `(dry run — would remove ${totalRemoved})` : totalRemoved,
    report,
  })
}
