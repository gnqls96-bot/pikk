import { NextRequest, NextResponse } from 'next/server'
import { fetchOgImage, fetchRelatedGalleryImages } from '@/lib/utils/og-image'
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
    // 오늘 KST 자정 이후 트렌드
    const now = new Date()
    const kstOffset = 9 * 60 * 60 * 1000
    const kstNow = new Date(now.getTime() + kstOffset)
    const kstMidnight = new Date(Date.UTC(kstNow.getUTCFullYear(), kstNow.getUTCMonth(), kstNow.getUTCDate()))
    const cutoff = new Date(kstMidnight.getTime() - kstOffset).toISOString()

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
      const isYouTube = trend.source_url.includes('youtube.com') || trend.source_url.includes('youtu.be')
      let imageUrl: string | null = null

      if (isYouTube) {
        const videoId = trend.source_url.match(/[?&]v=([^&]+)/)?.[1] ??
          trend.source_url.match(/youtu\.be\/([^?]+)/)?.[1]
        if (videoId) {
          imageUrl = `https://img.youtube.com/vi/${videoId}/maxresdefault.jpg`
        }
      }

      if (!imageUrl) {
        imageUrl = await fetchOgImage(trend.source_url)
      }

      // 갤러리: 원본 기사 + 관련 기사 og:image
      const galleryImages: GalleryImage[] = []
      if (imageUrl) {
        galleryImages.push({ url: imageUrl, source_url: trend.source_url, site_name: siteName })
      }

      const searchQuery = trend.title.slice(0, 40)
      const related = await fetchRelatedGalleryImages(searchQuery, trend.source_url, 4)
      const remaining = 4 - (galleryImages.length > 0 ? 1 : 0)
      galleryImages.push(...related.slice(0, remaining))

      // 메인 이미지가 없으면 갤러리 첫 번째 이미지 사용
      const finalImageUrl = imageUrl ?? galleryImages[0]?.url ?? null

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
