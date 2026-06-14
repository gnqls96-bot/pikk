import { NextRequest, NextResponse } from 'next/server'
import { translateToKorean, translateTags } from '@/lib/utils/translate'

export const maxDuration = 30

function checkAuth(req: NextRequest) {
  return req.headers.get('x-admin-token') === process.env.ADMIN_PASSWORD
}

export async function POST(req: NextRequest) {
  if (!checkAuth(req)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { trendId } = await req.json()
  if (!trendId) return NextResponse.json({ error: 'Missing trendId' }, { status: 400 })

  const SURL = process.env.NEXT_PUBLIC_SUPABASE_URL!
  const SKEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  const headers = { apikey: SKEY, Authorization: `Bearer ${SKEY}` }

  const trendRes = await fetch(
    `${SURL}/rest/v1/trends?id=eq.${trendId}&select=id,title,summary,body,tags`,
    { headers }
  )
  const [trend] = await trendRes.json()
  if (!trend) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const [title, summary, body, tags] = await Promise.all([
    translateToKorean(trend.title ?? ''),
    translateToKorean(trend.summary ?? ''),
    translateToKorean((trend.body ?? '').slice(0, 400)),
    translateTags(trend.tags ?? []),
  ])

  await fetch(`${SURL}/rest/v1/trends?id=eq.${trendId}`, {
    method: 'PATCH',
    headers: { ...headers, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
    body: JSON.stringify({ title, summary, body: body || null, tags }),
  })

  return NextResponse.json({ success: true })
}
