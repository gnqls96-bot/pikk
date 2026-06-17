import { NextRequest, NextResponse } from 'next/server'
import type { GalleryImage, RelatedSource } from '@/lib/types'
import { isValidTrendImage } from '@/lib/utils/og-image'

export const maxDuration = 30

function checkAuth(req: NextRequest) {
  return req.headers.get('x-admin-token') === process.env.ADMIN_PASSWORD
}

// 검색/추정 없이, 운영자가 직접 확인한 이미지 URL을 그대로 트렌드에 반영하는 1회성 수동 수정 도구.
// (자동 수집 로직 우회 — generate-trends-crawl의 collectImages와는 무관)
export async function POST(req: NextRequest) {
  if (!checkAuth(req)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { trendId, image_url, gallery_images, related_sources } = (await req.json()) as {
    trendId?: string
    image_url?: string
    gallery_images?: GalleryImage[]
    related_sources?: RelatedSource[]
  }
  if (!trendId || !image_url) {
    return NextResponse.json({ error: 'Missing trendId or image_url' }, { status: 400 })
  }

  const allUrls = [image_url, ...(gallery_images ?? []).map(g => g.url)]
  const checks = await Promise.all(allUrls.map(isValidTrendImage))
  const badUrls = allUrls.filter((_, i) => !checks[i])
  if (badUrls.length > 0) {
    return NextResponse.json({ error: '이미지 검증 실패 (404 또는 300x200 미달)', badUrls }, { status: 422 })
  }

  const SURL = process.env.NEXT_PUBLIC_SUPABASE_URL!
  const SKEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  const headers = { apikey: SKEY, Authorization: `Bearer ${SKEY}`, 'Content-Type': 'application/json', Prefer: 'return=representation' }

  const body: Record<string, unknown> = { image_url, gallery_images: gallery_images ?? [] }
  if (related_sources) body.related_sources = related_sources

  const res = await fetch(`${SURL}/rest/v1/trends?id=eq.${trendId}`, {
    method: 'PATCH',
    headers,
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    const err = await res.text()
    return NextResponse.json({ error: err }, { status: res.status })
  }
  const updated = await res.json().catch(() => [])
  return NextResponse.json({ success: true, updated })
}
