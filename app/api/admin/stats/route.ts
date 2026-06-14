import { NextRequest, NextResponse } from 'next/server'

function checkAuth(req: NextRequest) {
  return req.headers.get('x-admin-token') === process.env.ADMIN_PASSWORD
}

export async function GET(req: NextRequest) {
  if (!checkAuth(req)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!
  const SUPABASE_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  const headers = { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` }

  const [allRes, recentRes] = await Promise.all([
    fetch(`${SUPABASE_URL}/rest/v1/trends?select=id&order=published_at.desc`, { headers }),
    fetch(`${SUPABASE_URL}/rest/v1/trends?select=id,title,category,published_at&order=published_at.desc&limit=5`, { headers }),
  ])

  const allTrends: { id: string }[] = await allRes.json()
  const recent = await recentRes.json()

  return NextResponse.json({
    count: allTrends.length,
    allIds: allTrends.map((t) => t.id),
    recent,
  })
}
