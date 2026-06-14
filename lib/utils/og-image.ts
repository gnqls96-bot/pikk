import type { GalleryImage } from '@/lib/types'

function cleanHtml(s: string) {
  return s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#039;/g, "'").trim()
}

function resolveUrl(base: string, href: string): string {
  try {
    return new URL(href, base).toString()
  } catch { return href }
}

export async function fetchOgImage(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
        Accept: 'text/html,application/xhtml+xml',
      },
      signal: AbortSignal.timeout(6000),
      redirect: 'follow',
    })
    if (!res.ok) return null
    // Only read first 20KB to find og:image quickly
    const reader = res.body?.getReader()
    if (!reader) return null
    let html = ''
    while (html.length < 20000) {
      const { done, value } = await reader.read()
      if (done) break
      html += new TextDecoder().decode(value)
      if (html.toLowerCase().includes('</head>')) break
    }
    reader.cancel().catch(() => null)

    // og:image (property or name variant)
    const ogMatch =
      html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i) ??
      html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i) ??
      html.match(/<meta[^>]+name=["']twitter:image["'][^>]+content=["']([^"']+)["']/i) ??
      html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+name=["']twitter:image["']/i)

    const raw = cleanHtml(ogMatch?.[1] ?? '')
    if (!raw) return null
    return resolveUrl(url, raw)
  } catch { return null }
}

// Bing News RSS → 관련 기사 og:image 수집 (URL 중복 제거)
export async function fetchRelatedGalleryImages(
  query: string,
  excludeUrl: string,
  limit = 4
): Promise<GalleryImage[]> {
  try {
    const rssUrl = `https://www.bing.com/news/search?q=${encodeURIComponent(query)}&format=rss&mkt=ko-KR`
    const res = await fetch(rssUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
      signal: AbortSignal.timeout(7000),
    })
    if (!res.ok) return []
    const xml = await res.text()

    const itemMatches = [...xml.matchAll(/<item[^>]*>([\s\S]*?)<\/item>/gi)].slice(0, limit + 4)

    const candidates: { link: string; siteName: string }[] = []
    const seenLinks = new Set<string>()
    for (const [, content] of itemMatches) {
      const rawLink = cleanHtml(
        content.match(/<link[^>]*>\s*([^\s<][^<]*?)\s*<\/link>/i)?.[1]?.trim() ?? ''
      )
      if (!rawLink) continue

      const urlParam = rawLink.match(/[?&]url=([^&]+)/)?.[1]
      const articleUrl = urlParam ? decodeURIComponent(urlParam) : rawLink
      if (!articleUrl || articleUrl === excludeUrl || seenLinks.has(articleUrl)) continue
      seenLinks.add(articleUrl)

      const titleRaw = cleanHtml(
        content.match(/<title[^>]*>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/i)?.[1] ?? ''
      )
      const siteFromTitle = titleRaw.match(/ - ([^-]+)$/)?.[1]?.trim() ?? ''
      const siteName = siteFromTitle || (() => {
        try { return new URL(articleUrl).hostname.replace(/^www\./, '') } catch { return 'Bing News' }
      })()

      candidates.push({ link: articleUrl, siteName })
    }

    if (candidates.length === 0) return []

    const fetches = await Promise.all(
      candidates.slice(0, limit + 2).map(async ({ link, siteName }) => {
        const imgUrl = await fetchOgImage(link)
        return imgUrl ? { url: imgUrl, source_url: link, site_name: siteName } : null
      })
    )

    const results: GalleryImage[] = []
    const seenImgUrls = new Set<string>()
    for (const f of fetches) {
      if (f && !seenImgUrls.has(f.url)) {
        seenImgUrls.add(f.url)
        results.push(f)
      }
      if (results.length >= limit) break
    }
    return results
  } catch { return [] }
}

// Pexels에서 갤러리용 이미지 여러 장 수집
export async function fetchPexelsImages(keyword: string, limit = 4): Promise<GalleryImage[]> {
  const key = process.env.PEXELS_API_KEY
  if (!key || !keyword) return []
  try {
    const res = await fetch(
      `https://api.pexels.com/v1/search?query=${encodeURIComponent(keyword)}&per_page=${limit}&orientation=landscape`,
      { headers: { Authorization: key }, signal: AbortSignal.timeout(5000) }
    )
    if (!res.ok) return []
    const data = await res.json()
    return (data.photos ?? []).map((p: { src: { large2x: string }; url: string }) => ({
      url: p.src.large2x,
      source_url: p.url,
      site_name: 'Pexels',
    }))
  } catch { return [] }
}
