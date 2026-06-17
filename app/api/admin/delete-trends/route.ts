import { NextRequest, NextResponse } from 'next/server'

function checkAuth(req: NextRequest) {
  return req.headers.get('x-admin-token') === process.env.ADMIN_PASSWORD
}

// 특정 트렌드 ID 목록을 삭제하는 일회성 관리 도구
export async function DELETE(req: NextRequest) {
  if (!checkAuth(req)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { ids } = (await req.json()) as { ids?: string[] }
  if (!ids || ids.length === 0) return NextResponse.json({ error: 'Missing ids' }, { status: 400 })

  const SURL = process.env.NEXT_PUBLIC_SUPABASE_URL!
  const SKEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  const headers = { apikey: SKEY, Authorization: `Bearer ${SKEY}`, Prefer: 'return=representation' }

  const filter = `id=in.(${ids.join(',')})`
  const res = await fetch(`${SURL}/rest/v1/trends?${filter}`, { method: 'DELETE', headers })

  if (!res.ok) {
    const err = await res.text()
    return NextResponse.json({ error: err }, { status: res.status })
  }

  const deleted: { id: string }[] = await res.json().catch(() => [])
  return NextResponse.json({ success: true, deleted: deleted.length, ids })
}
