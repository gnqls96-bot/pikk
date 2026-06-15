import { NextRequest, NextResponse } from 'next/server'
import { fetchOgImage, fetchRelatedGalleryImages, fetchPexelsImages, isValidImageUrl, searchYouTubeThumbnail } from '@/lib/utils/og-image'
import type { GalleryImage } from '@/lib/types'

export const maxDuration = 60

function checkAuth(req: NextRequest) {
  return req.headers.get('x-admin-token') === process.env.ADMIN_PASSWORD
}

export async function POST(req: NextRequest) {
  if (!checkAuth(req)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { trendId } = await req.json().catch(() => ({}))

  const SURL = process.env.NEXT_PUBLIC_SUPABASE_URL!
  const SKEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  const headers = { apikey: SKEY, Authorization: `Bearer ${SKEY}` }

  // 단일 트렌드 또는 오늘 트렌드 전부
  let trends: { id: string; title: string; source_url: string; related_sources: { site_name: string }[] | null }[]

  if (trendId) {
    const res = await fetch(
      `${SURL}/rest/v1/trends?id=eq.${trendId}&select=id,title,source_url,related_sources`,
      { headers }
    )
    trends = await res.json()
  } else {
    // 최근 36시간 트렌드 (날짜 변경되어도 전날 트렌드 포함)
    const cutoff = new Date(Date.now() - 36 * 60 * 60 * 1000).toISOString()

    const res = await fetch(
      `${SURL}/rest/v1/trends?published_at=gte.${encodeURIComponent(cutoff)}&select=id,title,source_url,related_sources`,
      { headers }
    )
    trends = await res.json()
  }

  if (!trends || trends.length === 0) {
    return NextResponse.json({ error: '트렌드 없음' }, { status: 404 })
  }

  const results = await Promise.all(
    trends.map(async (trend) => {
      const isYouTube = trend.source_url.includes('youtube.com') || trend.source_url.includes('youtu.be')
      const searchQuery = trend.title.slice(0, 50)
      const engWords = (trend.title.match(/[A-Za-z][A-Za-z0-9 ]{1,}/g) ?? []).join(' ').trim()

      // 모든 이미지 소스 병렬 실행
      const [bingKo, bingEn, ogImg, ytSearchThumb, pexels] = await Promise.all([
        fetchRelatedGalleryImages(searchQuery, trend.source_url, 4),
        engWords.length > 2 ? fetchRelatedGalleryImages(engWords, trend.source_url, 4) : Promise.resolve<GalleryImage[]>([]),
        isYouTube ? Promise.resolve<string | null>(null) : fetchOgImage(trend.source_url),
        searchYouTubeThumbnail(searchQuery),
        fetchPexelsImages(engWords.length > 2 ? engWords.slice(0, 50) : searchQuery.slice(0, 30), 4),
      ])

      // YouTube 소스 썸네일
      const ytSourceThumb = isYouTube ? (() => {
        const vid = trend.source_url.match(/[?&]v=([^&]+)/)?.[1] ?? trend.source_url.match(/youtu\.be\/([^?]+)/)?.[1]
        return vid ? `https://img.youtube.com/vi/${vid}/maxresdefault.jpg` : null
      })() : null

      // 우선순위 메인 이미지
      const imageUrl =
        bingKo[0]?.url ?? bingEn[0]?.url ?? ogImg ?? ytSourceThumb ?? ytSearchThumb ?? pexels[0]?.url ?? null

      // 갤러리 구성 (중복 없이 4개)
      const seenUrls = new Set<string>()
      const galleryImages: GalleryImage[] = []
      const addToGallery = (img: GalleryImage) => {
        if (!seenUrls.has(img.url) && galleryImages.length < 4) {
          seenUrls.add(img.url); galleryImages.push(img)
        }
      }
      for (const r of [...bingKo, ...bingEn]) addToGallery(r)
      if (ytSourceThumb) addToGallery({ url: ytSourceThumb, source_url: trend.source_url, site_name: 'YouTube' })
      if (ytSearchThumb) addToGallery({ url: ytSearchThumb, source_url: trend.source_url, site_name: 'YouTube' })
      for (const p of pexels) addToGallery(p)

      // 이미지 유효성 검증
      const imageOk = imageUrl ? await isValidImageUrl(imageUrl) : false

      if (!imageOk) {
        // 재시도 후에도 이미지 없으면 삭제
        const svcKey = process.env.SUPABASE_SERVICE_ROLE_KEY
        if (svcKey) {
          await fetch(`${SURL}/rest/v1/trends?id=eq.${trend.id}`, {
            method: 'DELETE',
            headers: { apikey: svcKey, Authorization: `Bearer ${svcKey}` },
          })
        }
        return { id: trend.id, title: trend.title, deleted: true, reason: '이미지 수집 실패' }
      }

      await fetch(`${SURL}/rest/v1/trends?id=eq.${trend.id}`, {
        method: 'PATCH',
        headers: { ...headers, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
        body: JSON.stringify({ image_url: imageUrl, gallery_images: galleryImages }),
      })

      return { id: trend.id, title: trend.title, image_url: imageUrl, gallery_count: galleryImages.length }
    })
  )

  return NextResponse.json({ success: true, updated: results })
}
