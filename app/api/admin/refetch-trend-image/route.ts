import { NextRequest, NextResponse } from 'next/server'
import type { GalleryImage, RelatedSource } from '@/lib/types'
import {
  fetchOgImage,
  fetchArticleImages,
  sameSiteDomain,
  isValidTrendImage,
  isLowQualityImageUrl,
} from '@/lib/utils/og-image'

export const maxDuration = 60

function checkAuth(req: NextRequest) {
  return req.headers.get('x-admin-token') === process.env.ADMIN_PASSWORD
}

// 일회성 복구 도구: 신규 collectImages() 규칙(같은 기사 자신에서만 수집)으로
// 이미 발행된 트렌드의 image_url/gallery_images를 재수집해 PATCH한다.
// (구 아키텍처로 생성된 과거 트렌드를 새 규칙에 맞게 재정렬하기 위함 — 일회성, 영구 로직 아님)
export async function POST(req: NextRequest) {
  if (!checkAuth(req)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { trendId, dryRun } = (await req.json()) as { trendId?: string; dryRun?: boolean }
  if (!trendId) return NextResponse.json({ error: 'Missing trendId' }, { status: 400 })

  const SURL = process.env.NEXT_PUBLIC_SUPABASE_URL!
  const ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  const SKEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? ANON
  const readHeaders = { apikey: ANON, Authorization: `Bearer ${ANON}` }

  const getRes = await fetch(
    `${SURL}/rest/v1/trends?id=eq.${trendId}&select=id,title,source_url`,
    { headers: readHeaders }
  )
  const rows = await getRes.json()
  const trend = rows?.[0]
  if (!trend?.source_url) return NextResponse.json({ error: 'Trend not found or no source_url' }, { status: 404 })

  const sourceUrl: string = trend.source_url
  const siteName = (() => { try { return new URL(sourceUrl).hostname.replace(/^www\./, '') } catch { return '' } })()

  let mainImg: string | null = null

  const ytVid = sourceUrl.match(/[?&]v=([^&]+)/)?.[1] ?? sourceUrl.match(/youtu\.be\/([^?]+)/)?.[1]
  if (ytVid) {
    for (const variant of ['maxresdefault', 'hqdefault']) {
      const ytThumb = `https://img.youtube.com/vi/${ytVid}/${variant}.jpg`
      if (!isLowQualityImageUrl(ytThumb) && await isValidTrendImage(ytThumb)) {
        mainImg = ytThumb
        break
      }
    }
  } else {
    const og = await fetchOgImage(sourceUrl)
    if (og && sameSiteDomain(og, sourceUrl) && !isLowQualityImageUrl(og) && await isValidTrendImage(og)) {
      mainImg = og
    }
  }

  const articleImages = ytVid ? [] : await fetchArticleImages(sourceUrl, 5)
  const seenUrls = new Set<string>(mainImg ? [mainImg] : [])
  const gallery: GalleryImage[] = []
  for (const img of articleImages) {
    if (isLowQualityImageUrl(img.url) || seenUrls.has(img.url)) continue
    seenUrls.add(img.url)
    gallery.push(img)
    if (gallery.length >= 4) break
  }

  if (!mainImg && gallery.length > 0) mainImg = gallery.shift()!.url

  if (!mainImg) {
    return NextResponse.json({ error: 'no_image_found_same_article_only', trendId, sourceUrl }, { status: 422 })
  }

  const related_sources: RelatedSource[] = [{ title: trend.title, url: sourceUrl, site_name: siteName }]

  if (dryRun) {
    return NextResponse.json({ dryRun: true, trendId, sourceUrl, mainImg, gallery, related_sources })
  }

  const patchRes = await fetch(`${SURL}/rest/v1/trends?id=eq.${trendId}`, {
    method: 'PATCH',
    headers: { apikey: SKEY, Authorization: `Bearer ${SKEY}`, 'Content-Type': 'application/json', Prefer: 'return=representation' },
    body: JSON.stringify({ image_url: mainImg, gallery_images: gallery, related_sources }),
  })
  if (!patchRes.ok) {
    const err = await patchRes.text()
    return NextResponse.json({ error: err }, { status: patchRes.status })
  }
  const updated = await patchRes.json().catch(() => [])
  return NextResponse.json({ success: true, mainImg, gallery, updated })
}
