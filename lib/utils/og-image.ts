import type { GalleryImage } from '@/lib/types'

function cleanHtml(s: string) {
  return s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#039;/g, "'").trim()
}

// ╔═══════════════════════════════════════════════════════════════════╗
// ║  이미지 품질 필터 — 영구 고정, 절대 변경 금지                          ║
// ║                                                                   ║
// ║  제외 대상:                                                         ║
// ║  1. URL에 logo/profile/avatar/author/reporter 포함                  ║
// ║  2. 뉴스사 기본 썸네일 패턴 (placeholder, noimage, default)           ║
// ║  3. 이미지 크기 300×200 이하                                         ║
// ║                                                                   ║
// ║  적용 순서: URL 필터(빠름) → 크기 필터(HTTP 요청) → 통과 시 사용         ║
// ╚═══════════════════════════════════════════════════════════════════╝

// 영구 고정: 이 목록을 줄이지 말 것
const LOW_QUALITY_URL_KEYWORDS = [
  'logo', 'profile', 'avatar', 'author', 'reporter', 'journalist',
  'headshot', 'byline', 'watermark', 'favicon', 'placeholder',
  'noimage', 'no-image', 'no_image', 'default-image', 'default_image',
  'blank', 'missing', 'dummy',
  // 소셜 공유 아이콘 및 UI 요소 제외 (SVG 파일은 크기 검증 우회하므로 URL 단계에서 차단)
  'social_icon', 'share_dropdown', 'share-icon', 'share_icon',
]

export function isLowQualityImageUrl(url: string): boolean {
  const lurl = url.toLowerCase()
  // SVG는 raster 크기 검증을 우회하므로 URL 단계에서 일괄 제외
  if (lurl.endsWith('.svg') || lurl.includes('.svg?')) return true
  return LOW_QUALITY_URL_KEYWORDS.some(kw => lurl.includes(kw))
}

// JPEG/PNG/WebP 헤더에서 이미지 크기 추출 (최대 32KB만 읽음)
function parseImageDimensions(bytes: Uint8Array): { w: number; h: number } | null {
  if (bytes.length < 12) return null
  // PNG: 매직바이트 89 50 4E 47, IHDR at offset 16-24
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4E && bytes[3] === 0x47 && bytes.length >= 24) {
    return {
      w: (bytes[16] << 24) | (bytes[17] << 16) | (bytes[18] << 8) | bytes[19],
      h: (bytes[20] << 24) | (bytes[21] << 16) | (bytes[22] << 8) | bytes[23],
    }
  }
  // JPEG: FF D8로 시작, SOF 마커 스캔
  if (bytes[0] === 0xFF && bytes[1] === 0xD8) {
    for (let i = 2; i < bytes.length - 8;) {
      if (bytes[i] !== 0xFF) { i++; continue }
      const marker = bytes[i + 1]
      const segLen = (bytes[i + 2] << 8) | bytes[i + 3]
      if ((marker >= 0xC0 && marker <= 0xC3) || (marker >= 0xC5 && marker <= 0xC7) ||
          (marker >= 0xC9 && marker <= 0xCB) || (marker >= 0xCD && marker <= 0xCF)) {
        if (i + 8 < bytes.length) {
          return { h: (bytes[i + 5] << 8) | bytes[i + 6], w: (bytes[i + 7] << 8) | bytes[i + 8] }
        }
      }
      if (segLen < 2) break
      i += 2 + segLen
    }
  }
  // WebP: RIFF....WEBP
  if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
      bytes.length >= 30 && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) {
    if (bytes[12] === 0x56 && bytes[13] === 0x50 && bytes[14] === 0x38) {
      if (bytes[15] === 0x20) { // VP8 (lossy)
        return { w: ((bytes[26] | (bytes[27] << 8)) & 0x3FFF) + 1, h: ((bytes[28] | (bytes[29] << 8)) & 0x3FFF) + 1 }
      }
      if (bytes[15] === 0x4C && bytes.length >= 25 && bytes[20] === 0x2F) { // VP8L (lossless)
        const raw = bytes[21] | (bytes[22] << 8) | (bytes[23] << 16) | (bytes[24] << 24)
        return { w: (raw & 0x3FFF) + 1, h: ((raw >>> 14) & 0x3FFF) + 1 }
      }
    }
  }
  return null
}

// 이미지 크기 확인 (300×200 미만 제외)
async function checkImageSize(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Googlebot/2.1)', Range: 'bytes=0-65535' },
      signal: AbortSignal.timeout(6000),
      redirect: 'follow',
    })
    if (!res.ok) return res.status < 500  // 5xx만 거부, 나머지는 통과
    const reader = res.body?.getReader()
    if (!reader) return true
    let bytes = new Uint8Array(0)
    while (bytes.length < 65536) {
      const { done, value } = await reader.read()
      if (done || !value) break
      const merged = new Uint8Array(bytes.length + value.length)
      merged.set(bytes); merged.set(value, bytes.length); bytes = merged
    }
    reader.cancel().catch(() => null)
    const dims = parseImageDimensions(bytes)
    if (!dims) return true  // 크기 판별 불가 = 통과 (보수적 판단)
    const ok = dims.w >= 300 && dims.h >= 200
    return ok
  } catch { return false }
}

// ── 트렌드 이미지 품질 종합 검증 (영구 고정) ─────────────────────────
// isValidImageUrl 대신 이 함수를 사용할 것 (더 엄격한 품질 기준)
// URL 필터 → 크기 확인 (300×200 이상만 통과)
export async function isValidTrendImage(url: string): Promise<boolean> {
  if (!url || !url.startsWith('http')) return false
  if (isLowQualityImageUrl(url)) return false
  return checkImageSize(url)
}

function resolveUrl(base: string, href: string): string {
  try { return new URL(href, base).toString() }
  catch { return href }
}

// 이미지 호스트가 기사 사이트 소속인지 확인 (CDN 서브도메인은 허용: img.eater.com,
// static-eater-com.akamaized.net 등 — 기사의 2단계 도메인 라벨이 이미지 호스트에 포함되면 같은 사이트로 판단)
export function sameSiteDomain(imageUrl: string, articleUrl: string): boolean {
  try {
    const imgHost = new URL(imageUrl).hostname.toLowerCase()
    const artHost = new URL(articleUrl).hostname.toLowerCase().replace(/^www\./, '')
    const labels = artHost.split('.')
    const sld = labels.length >= 2 ? labels[labels.length - 2] : artHost
    return sld.length >= 3 && imgHost.includes(sld)
  } catch { return false }
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

// 이미지 URL 유효성 검증 (HEAD 요청)
export async function isValidImageUrl(url: string): Promise<boolean> {
  if (!url || !url.startsWith('http')) return false
  try {
    const res = await fetch(url, {
      method: 'HEAD',
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Googlebot/2.1)' },
      signal: AbortSignal.timeout(4000),
      redirect: 'follow',
    })
    // 서버 오류(5xx)와 연결 실패만 거부 — CDN quirks(403/404) 제외
    return res.status < 500
  } catch { return false }
}

// ── 같은 기사 본문에서 갤러리용 추가 이미지 수집 (영구 고정, 2026-06-16) ──
// 다른 기사를 검색해서 이미지를 끌어오지 않음 — 반드시 이 기사(url) 자신의 페이지에서만 추출
// og:image를 1순위 후보로 포함하고, 본문 <img> 태그들을 추가 후보로 스캔.
// sameSiteDomain으로 기사 도메인과 다른 이미지(광고/CDN 외부 임베드 등)는 즉시 제외.
export async function fetchArticleImages(url: string, limit = 5): Promise<GalleryImage[]> {
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
        Accept: 'text/html,application/xhtml+xml',
      },
      signal: AbortSignal.timeout(7000),
      redirect: 'follow',
    })
    if (!res.ok) return []
    const html = await res.text()
    const siteName = (() => { try { return new URL(url).hostname.replace(/^www\./, '') } catch { return '' } })()

    const ogMatch =
      html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i) ??
      html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i)

    // 본문 영역만 스캔: <article> 태그로 범위를 좁히고, "관련기사/인기글" 위젯 마커 이전까지만 사용.
    // (Vox Media류 사이트는 "가장 많이 본 기사" 위젯이 <article> 내부에 같이 렌더링돼
    //  범위를 <article>만으로 좁혀도 다른 기사 썸네일이 섞여 들어옴 — 위젯 마커로 추가 차단)
    const artStart = html.search(/<article[ >]/i)
    const artEnd = html.search(/<\/article>/i)
    let bodyHtml = artStart >= 0 && artEnd > artStart ? html.slice(artStart, artEnd) : html
    const widgetMarker = bodyHtml.search(/most[-_ ]?popular|related[-_ ]?(articles|stories|posts)|you may also like|recommended[-_ ]?(for|stories)|trending[-_ ]?now|more from/i)
    if (widgetMarker > 0) bodyHtml = bodyHtml.slice(0, widgetMarker)

    const rawCandidates: string[] = [
      ...(ogMatch?.[1] ? [ogMatch[1]] : []),
      ...[...bodyHtml.matchAll(/<img[^>]+(?:src|data-src)=["']([^"']+)["']/gi)].map(m => m[1]),
    ]

    // 같은 사진의 반응형 crop/width 변형(쿼리스트링만 다름)은 동일 이미지로 취급해 중복 제거
    const seen = new Set<string>()
    const uniqueAbs: string[] = []
    for (const raw of rawCandidates) {
      const abs = resolveUrl(url, cleanHtml(raw))
      if (isLowQualityImageUrl(abs) || !sameSiteDomain(abs, url)) continue
      const dedupKey = (() => { try { const u = new URL(abs); return u.origin + u.pathname } catch { return abs } })()
      if (seen.has(dedupKey)) continue
      seen.add(dedupKey)
      uniqueAbs.push(abs)
      if (uniqueAbs.length >= limit + 8) break
    }

    const checked = await Promise.all(uniqueAbs.map(async u => (await isValidTrendImage(u)) ? u : null))
    const results: GalleryImage[] = []
    for (const u of checked) {
      if (u && results.length < limit) results.push({ url: u, source_url: url, site_name: siteName })
    }
    return results
  } catch { return [] }
}

// Bing News RSS → 관련 기사 og:image (URL 중복 제거)
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
      candidates.slice(0, limit + 4).map(async ({ link, siteName }) => {
        const imgUrl = await fetchOgImage(link)
        // 영구 고정: URL 패턴(로고/프로필/아바타 등) + 크기(300x200 미만) + 기사와 다른 도메인 즉시 제외
        // → 실패하면 이 기사는 버려지고 다음 기사 후보가 자동으로 그 자리를 채움
        if (!imgUrl || !sameSiteDomain(imgUrl, link) || !(await isValidTrendImage(imgUrl))) return null
        return { url: imgUrl, source_url: link, site_name: siteName }
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

// YouTube Data API 검색 → 썸네일 (이미지 폴백용)
export async function searchYouTubeThumbnail(query: string): Promise<string | null> {
  const key = process.env.YOUTUBE_API_KEY
  if (!key) return null
  try {
    const res = await fetch(
      `https://www.googleapis.com/youtube/v3/search?q=${encodeURIComponent(query)}&type=video&maxResults=3&part=snippet&key=${key}`,
      { signal: AbortSignal.timeout(5000) }
    )
    if (!res.ok) return null
    const data = await res.json()
    for (const item of (data.items ?? [])) {
      const thumb =
        item.snippet?.thumbnails?.maxres?.url ??
        item.snippet?.thumbnails?.high?.url ??
        item.snippet?.thumbnails?.medium?.url
      if (thumb) return thumb as string
    }
    return null
  } catch { return null }
}

// Pexels 이미지 다수 수집
export async function fetchPexelsImages(keyword: string, limit = 4): Promise<GalleryImage[]> {
  const key = process.env.PEXELS_API_KEY
  if (!key || !keyword.trim()) return []
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
