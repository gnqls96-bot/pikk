import { NextRequest, NextResponse } from 'next/server'
import { fetchOgImage, fetchRelatedGalleryImages, searchYouTubeThumbnail, isValidTrendImage, isLowQualityImageUrl } from '@/lib/utils/og-image'
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

  // ── 이미지 품질 규칙 (영구 고정, generate-trends-crawl와 동일) ──────
  // 1순위: 뉴스 기사 og:image (Bing News RSS → 각 기사 og:image 추출)
  // 2순위: YouTube 관련 영상 썸네일
  // 3순위: 없으면 해당 트렌드 삭제
  // ✗ Pexels 사용 금지 / ✗ logo·profile·avatar·author URL 제외 / ✗ 300×200 이하 제외
  const results = await Promise.all(
    trends.map(async (trend) => {
      const isYouTube = trend.source_url.includes('youtube.com') || trend.source_url.includes('youtu.be')
      const searchQuery = trend.title.slice(0, 50)
      const engWords = (trend.title.match(/[A-Za-z][A-Za-z0-9 ]{1,}/g) ?? []).join(' ').trim()

      // 1순위: 뉴스 기사 og:image (한국어 + 영어 병렬)
      const [bingKo, bingEn, ogImg] = await Promise.all([
        fetchRelatedGalleryImages(searchQuery, trend.source_url, 5),
        engWords.length > 2 ? fetchRelatedGalleryImages(engWords, trend.source_url, 5) : Promise.resolve<GalleryImage[]>([]),
        isYouTube ? Promise.resolve<string | null>(null) : fetchOgImage(trend.source_url),
      ])

      // 갤러리 구성: 저품질 URL 즉시 제외
      const seenUrls = new Set<string>()
      const galleryImages: GalleryImage[] = []
      const addToGallery = (img: GalleryImage) => {
        if (!isLowQualityImageUrl(img.url) && !seenUrls.has(img.url) && galleryImages.length < 4) {
          seenUrls.add(img.url); galleryImages.push(img)
        }
      }
      for (const r of [...bingKo, ...bingEn]) addToGallery(r)
      if (ogImg && !isLowQualityImageUrl(ogImg)) addToGallery({ url: ogImg, source_url: trend.source_url, site_name: 'og:image' })

      let imageUrl = galleryImages[0]?.url ?? null

      // 2순위: YouTube 썸네일 (뉴스 이미지 없을 때)
      if (!imageUrl) {
        const ytVid = trend.source_url.match(/[?&]v=([^&]+)/)?.[1]
          ?? trend.source_url.match(/youtu\.be\/([^?]+)/)?.[1]
        const ytSourceThumb = ytVid ? `https://img.youtube.com/vi/${ytVid}/maxresdefault.jpg` : null
        const ytSearchThumb = await searchYouTubeThumbnail(searchQuery)
        const ytThumb = ytSourceThumb ?? ytSearchThumb
        if (ytThumb && !isLowQualityImageUrl(ytThumb)) {
          imageUrl = ytThumb
          galleryImages.push({ url: ytThumb, source_url: trend.source_url, site_name: 'YouTube' })
        }
      }

      // 이미지 품질 종합 검증 (URL 패턴 + 크기 300×200 이상)
      const imageOk = imageUrl ? await isValidTrendImage(imageUrl) : false

      if (!imageOk) {
        // 품질 기준 미달 → 트렌드 삭제
        const svcKey = process.env.SUPABASE_SERVICE_ROLE_KEY
        if (svcKey) {
          await fetch(`${SURL}/rest/v1/trends?id=eq.${trend.id}`, {
            method: 'DELETE',
            headers: { apikey: svcKey, Authorization: `Bearer ${svcKey}` },
          })
        }
        return { id: trend.id, title: trend.title, deleted: true, reason: '이미지 품질 기준 미달' }
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
