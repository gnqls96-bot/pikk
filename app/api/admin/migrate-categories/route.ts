import { NextRequest, NextResponse } from 'next/server'

function checkAuth(req: NextRequest) {
  return req.headers.get('x-admin-token') === process.env.ADMIN_PASSWORD
}

// 카테고리명 일괄 변경: 광고→KPOP, 영상→엔터
// 기존 발행 트렌드 DB 마이그레이션 전용 1회성 엔드포인트
export async function POST(req: NextRequest) {
  if (!checkAuth(req)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const SURL = process.env.NEXT_PUBLIC_SUPABASE_URL!
  const SKEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  const headers = { apikey: SKEY, Authorization: `Bearer ${SKEY}`, 'Content-Type': 'application/json', Prefer: 'return=representation' }

  const migrations = [
    { from: '광고', to: 'KPOP' },
    { from: '영상', to: '엔터' },
  ]

  const results: { from: string; to: string; updated: number; status?: number; error?: unknown }[] = []

  for (const { from, to } of migrations) {
    const res = await fetch(
      `${SURL}/rest/v1/trends?category=eq.${encodeURIComponent(from)}`,
      { method: 'PATCH', headers, body: JSON.stringify({ category: to }) }
    )
    const body = await res.json().catch(() => null)
    if (!res.ok) {
      results.push({ from, to, updated: 0, status: res.status, error: body })
    } else {
      results.push({ from, to, updated: Array.isArray(body) ? body.length : 0, status: res.status })
    }
  }

  return NextResponse.json({ success: true, results })
}
