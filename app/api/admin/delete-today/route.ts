import { NextRequest, NextResponse } from 'next/server'

function checkAuth(req: NextRequest) {
  return req.headers.get('x-admin-token') === process.env.ADMIN_PASSWORD
}

export async function DELETE(req: NextRequest) {
  if (!checkAuth(req)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const SURL = process.env.NEXT_PUBLIC_SUPABASE_URL!
  // DELETE requires service role key (anon key blocked by RLS)
  const SKEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  const headers = { apikey: SKEY, Authorization: `Bearer ${SKEY}`, Prefer: 'return=representation' }

  // 오늘 KST 자정 = 전날 15:00 UTC
  const now = new Date()
  const kstOffset = 9 * 60 * 60 * 1000
  const kstNow = new Date(now.getTime() + kstOffset)
  const kstMidnight = new Date(Date.UTC(kstNow.getUTCFullYear(), kstNow.getUTCMonth(), kstNow.getUTCDate()))
  const cutoff = new Date(kstMidnight.getTime() - kstOffset).toISOString()

  const res = await fetch(
    `${SURL}/rest/v1/trends?published_at=gte.${encodeURIComponent(cutoff)}`,
    { method: 'DELETE', headers }
  )

  if (!res.ok) {
    const err = await res.text()
    return NextResponse.json({ error: err }, { status: res.status })
  }

  const deleted: { id: string }[] = await res.json().catch(() => [])
  return NextResponse.json({ success: true, deleted: deleted.length, cutoff })
}
