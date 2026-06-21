import { NextRequest, NextResponse } from 'next/server'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// POST /api/admin/reset-instagram-ids?secret=CRON_SECRET
// Resets instagram_post_id to null for today's trends so they can be re-published.
export async function POST(req: NextRequest) {
  const secret = req.nextUrl.searchParams.get('secret')
  if (secret !== process.env.CRON_SECRET && secret !== process.env.ADMIN_PASSWORD) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const SURL = process.env.NEXT_PUBLIC_SUPABASE_URL
  const SKEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  if (!SURL || !SKEY) {
    return NextResponse.json({ error: 'Supabase not configured' }, { status: 500 })
  }

  const headers = {
    apikey: SKEY,
    Authorization: `Bearer ${SKEY}`,
    'Content-Type': 'application/json',
    Prefer: 'return=representation',
  }

  // KST 오늘 자정 이후 published_at 기준
  const now = new Date()
  const kstOffset = 9 * 60 * 60 * 1000
  const kstNow = new Date(now.getTime() + kstOffset)
  const kstMidnight = new Date(Date.UTC(kstNow.getUTCFullYear(), kstNow.getUTCMonth(), kstNow.getUTCDate()))
  const since = new Date(kstMidnight.getTime() - kstOffset).toISOString()

  const res = await fetch(
    `${SURL}/rest/v1/trends?published_at=gte.${since}`,
    {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ instagram_post_id: null }),
    }
  )

  if (!res.ok) {
    const err = await res.text()
    return NextResponse.json({ error: err }, { status: res.status })
  }

  const rows: { id: string; title: string }[] = await res.json().catch(() => [])
  return NextResponse.json({ success: true, reset: rows.length, trends: rows.map(r => ({ id: r.id, title: r.title })) })
}
