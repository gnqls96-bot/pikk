import { NextRequest, NextResponse } from 'next/server'
import { fetchOgImage, fetchRelatedGalleryImages } from '@/lib/utils/og-image'
import type { GalleryImage } from '@/lib/types'

async function getPexelsImage(keyword: string): Promise<string | null> {
  const key = process.env.PEXELS_API_KEY
  if (!key || !keyword) return null
  try {
    const res = await fetch(
      `https://api.pexels.com/v1/search?query=${encodeURIComponent(keyword)}&per_page=1&orientation=landscape`,
      { headers: { Authorization: key }, signal: AbortSignal.timeout(5000) }
    )
    if (!res.ok) return null
    const data = await res.json()
    return (data.photos?.[0]?.src?.large2x as string) ?? null
  } catch { return null }
}

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
      const siteName = trend.related_sources?.[0]?.site_name ?? (() => {
        try { return new URL(trend.source_url).hostname.replace(/^www\./, '') } catch { return 'Unknown' }
      })()

      // YouTube 썸네일 직접 추출
      const searchQuery = trend.title.slice(0, 40)
      const isYouTube = trend.source_url.includes('youtube.com') || trend.source_url.includes('youtu.be')

      // ① Bing News 트렌드 제목 검색 (항상 최우선)
      let related = await fetchRelatedGalleryImages(searchQuery, trend.source_url, 4)
      // 결과 없으면 영어 키워드만으로 재시도 (e.g. "Anthropic 비즈니스 점유율 1위" → "Anthropic")
      if (related.length === 0) {
        const engWords = (trend.title.match(/[A-Za-z][A-Za-z0-9 ]{1,}/g) ?? []).join(' ').trim()
        if (engWords.length > 2) {
          related = await fetchRelatedGalleryImages(engWords, trend.source_url, 4)
        }
      }
      let imageUrl: string | null = related.length > 0 ? related[0].url : null

      // ② Bing News 결과 없으면: og:image (비-YouTube) 또는 YouTube 썸네일
      if (!imageUrl) {
        if (isYouTube) {
          const videoId = trend.source_url.match(/[?&]v=([^&]+)/)?.[1] ??
            trend.source_url.match(/youtu\.be\/([^?]+)/)?.[1]
          if (videoId) imageUrl = `https://img.youtube.com/vi/${videoId}/maxresdefault.jpg`
        } else {
          imageUrl = await fetchOgImage(trend.source_url)
        }
      }

      // ③ Pexels fallback (영어 키워드)
      if (!imageUrl) {
        const english = (trend.title.match(/[A-Za-z][A-Za-z0-9 ]{2,}/g) ?? []).join(' ').trim()
        const keyword = english.length > 3 ? english.slice(0, 50) : trend.title.slice(0, 30)
        imageUrl = await getPexelsImage(keyword)
      }

      // 갤러리: Bing News 관련 기사 최대 4장
      const galleryImages: GalleryImage[] = [...related.slice(0, 4)]
      const finalImageUrl = imageUrl ?? null

      await fetch(`${SURL}/rest/v1/trends?id=eq.${trend.id}`, {
        method: 'PATCH',
        headers: { ...headers, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
        body: JSON.stringify({ image_url: finalImageUrl, gallery_images: galleryImages }),
      })

      return {
        id: trend.id,
        title: trend.title,
        image_url: finalImageUrl,
        gallery_count: galleryImages.length,
      }
    })
  )

  return NextResponse.json({ success: true, updated: results })
}
