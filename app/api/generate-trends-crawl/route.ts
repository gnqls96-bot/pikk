import { NextResponse } from 'next/server'
import type { Category, GalleryImage, RelatedSource } from '@/lib/types'

export const maxDuration = 60

// ── Types ──────────────────────────────────────────────────────
interface CrawledItem {
  title: string
  description: string
  image_url: string | null
  source_url: string
  site_name: string
  heat_score: number
  source: 'youtube' | 'hn' | 'rss'
  yt_category_id?: string
}

// ── Category mapping ───────────────────────────────────────────
const YT_CATEGORY_MAP: Record<string, Category> = {
  '1': '영상',   // Film & Animation
  '10': '영상',  // Music
  '20': '라이프', // Gaming
  '22': 'SNS',   // People & Blogs
  '23': 'SNS',   // Comedy
  '24': 'SNS',   // Entertainment
  '26': '뷰티',  // Howto & Style
  '28': '테크',  // Science & Technology
  '2': '라이프', '15': '라이프', '17': '라이프',
  '19': '라이프', '25': '라이프', '27': '라이프', '29': '라이프',
}

const KEYWORD_CATEGORY: [string[], Category][] = [
  [['AI', 'ChatGPT', 'GPT', 'LLM', 'OpenAI', 'Anthropic', 'Google', 'Apple', 'Microsoft',
    'Samsung', 'tech', 'software', 'hardware', 'startup', 'GPU', 'chip', 'robot',
    'developer', 'programming', 'code', 'model', 'Claude', 'Gemini'], '테크'],
  [['TikTok', 'Instagram', 'Twitter', 'X.com', 'social media', 'viral', 'meme',
    'Reddit', 'Facebook', 'influencer', 'challenge', 'trending'], 'SNS'],
  [['YouTube', 'video', 'film', 'movie', 'music', 'streaming', 'Netflix', 'Disney',
    'animation', 'K-pop', 'kpop', '유튜브', '영상', '뮤직', '노래', '드라마'], '영상'],
  [['food', 'restaurant', 'recipe', 'eating', 'coffee', 'drink', 'meal', 'cuisine',
    'pizza', 'sushi', 'chocolate'], '푸드'],
  [['fashion', 'style', 'clothing', 'outfit', 'brand', 'luxury', 'shoes', 'dress'], '패션'],
  [['health', 'wellness', 'fitness', 'workout', 'sleep', 'mental', 'exercise', 'yoga',
    'nutrition', 'diet', 'meditation'], '라이프'],
  [['design', 'graphic', 'UI', 'UX', 'logo', 'typography', 'visual', 'illustration'], '디자인'],
  [['marketing', 'advertising', 'brand', 'campaign', 'commercial', 'promotion'], '광고'],
  [['beauty', 'makeup', 'skincare', 'cosmetic', 'haircare', 'nail', '뷰티', '화장', '스킨'], '뷰티'],
]

function mapCategory(text: string, ytCategoryId?: string): Category {
  if (ytCategoryId && YT_CATEGORY_MAP[ytCategoryId]) return YT_CATEGORY_MAP[ytCategoryId]
  const lower = text.toLowerCase()
  for (const [keywords, cat] of KEYWORD_CATEGORY) {
    if (keywords.some(kw => lower.includes(kw.toLowerCase()))) return cat
  }
  return '테크'
}

function extractTags(title: string): string[] {
  return [...new Set(
    title
      .split(/\s+/)
      .filter(w => w.length > 3 && /[A-Z가-힣]/.test(w[0]))
      .map(w => w.replace(/[^a-zA-Z0-9가-힣]/g, ''))
      .filter(w => w.length > 2)
      .slice(0, 5)
  )]
}

function calcHeatFromLog(value: number, base = 50): number {
  return Math.min(99, Math.max(40, base + Math.floor(Math.log10(value + 1) * 12)))
}

// ── YouTube KR Trending ────────────────────────────────────────
async function fetchYouTubeTrending(): Promise<CrawledItem[]> {
  const key = process.env.YOUTUBE_API_KEY
  if (!key) return []
  try {
    const res = await fetch(
      `https://www.googleapis.com/youtube/v3/videos?part=snippet,statistics&chart=mostPopular&regionCode=KR&maxResults=15&key=${key}`,
      { signal: AbortSignal.timeout(10000) }
    )
    if (!res.ok) return []
    const data = await res.json()
    if (data.error) return []

    return (data.items ?? []).map((item: {
      id: string
      snippet: {
        title: string
        description: string
        channelTitle: string
        categoryId: string
        thumbnails: { maxres?: { url: string }; high?: { url: string }; medium?: { url: string } }
      }
      statistics: { viewCount?: string }
    }) => {
      const viewCount = parseInt(item.statistics?.viewCount ?? '0')
      return {
        title: item.snippet.title,
        description: (item.snippet.description ?? '').split('\n')[0].slice(0, 300),
        image_url:
          item.snippet.thumbnails?.maxres?.url ??
          item.snippet.thumbnails?.high?.url ??
          item.snippet.thumbnails?.medium?.url ??
          null,
        source_url: `https://www.youtube.com/watch?v=${item.id}`,
        site_name: item.snippet.channelTitle ?? 'YouTube',
        heat_score: calcHeatFromLog(viewCount),
        source: 'youtube' as const,
        yt_category_id: item.snippet.categoryId,
      }
    })
  } catch {
    return []
  }
}

// ── Hacker News Top Stories ────────────────────────────────────
async function fetchHNTop(): Promise<CrawledItem[]> {
  try {
    const idsRes = await fetch(
      'https://hacker-news.firebaseio.com/v0/topstories.json',
      { signal: AbortSignal.timeout(8000) }
    )
    const ids: number[] = await idsRes.json()

    const items = await Promise.all(
      ids.slice(0, 30).map(async (id) => {
        try {
          const res = await fetch(
            `https://hacker-news.firebaseio.com/v0/item/${id}.json`,
            { signal: AbortSignal.timeout(5000) }
          )
          return res.json()
        } catch { return null }
      })
    )

    return items
      .filter((item): item is NonNullable<typeof item> =>
        item?.url && item.score >= 80 && item.title
      )
      .slice(0, 6)
      .map((item) => {
        let siteName = 'Hacker News'
        try { siteName = new URL(item.url).hostname.replace(/^www\./, '') } catch {}
        return {
          title: item.title,
          description: `${item.score} points · ${item.descendants ?? 0} comments`,
          image_url: null,
          source_url: item.url,
          site_name: siteName,
          heat_score: calcHeatFromLog(item.score, 45),
          source: 'hn' as const,
        }
      })
  } catch {
    return []
  }
}

// ── RSS / Atom feed parser ─────────────────────────────────────
function cleanText(s: string): string {
  return s
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .trim()
}

function parseFeedXml(xml: string, siteName: string): Omit<CrawledItem, 'source'>[] {
  const isAtom = xml.includes('<feed')
  const entryRe = isAtom
    ? /<entry[^>]*>([\s\S]*?)<\/entry>/gi
    : /<item[^>]*>([\s\S]*?)<\/item>/gi

  const results: Omit<CrawledItem, 'source'>[] = []

  for (const match of [...xml.matchAll(entryRe)].slice(0, 6)) {
    const c = match[1]

    const title = cleanText(
      c.match(/<title[^>]*>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/i)?.[1] ?? ''
    )
    if (!title) continue

    const link = isAtom
      ? (c.match(/<link[^>]+href=["']([^"']+)["']/i)?.[1] ?? '')
      : (c.match(/<link[^>]*>\s*([^\s<][^<]*)\s*<\/link>/i)?.[1]?.trim() ?? '')
    if (!link) continue

    const descRaw = isAtom
      ? (c.match(/<(?:summary|content)[^>]*>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/(?:summary|content)>/i)?.[1] ?? '')
      : (c.match(/<description[^>]*>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/description>/i)?.[1] ?? '')
    const description = cleanText(descRaw).slice(0, 300)

    // Try to extract embedded image from feed
    const imageUrl =
      c.match(/<media:content[^>]+url=["']([^"']+)["'][^>]*medium=["']image["']/i)?.[1] ??
      c.match(/<media:thumbnail[^>]+url=["']([^"']+)["']/i)?.[1] ??
      c.match(/<enclosure[^>]+type=["']image[^"']*["'][^>]+url=["']([^"']+)["']/i)?.[1] ??
      c.match(/<enclosure[^>]+url=["']([^"']+)["'][^>]+type=["']image/i)?.[1] ??
      null

    results.push({
      title,
      description,
      image_url: imageUrl,
      source_url: link,
      site_name: siteName,
      heat_score: 62,
    })
  }
  return results
}

async function fetchRSSFeed(url: string, siteName: string): Promise<CrawledItem[]> {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; PikkBot/1.0; +https://pikk.app)' },
      signal: AbortSignal.timeout(8000),
    })
    if (!res.ok) return []
    const xml = await res.text()
    return parseFeedXml(xml, siteName).map(item => ({ ...item, source: 'rss' as const }))
  } catch {
    return []
  }
}

// ── Pexels fallback ────────────────────────────────────────────
async function getPexelsImage(keyword: string): Promise<string | null> {
  const key = process.env.PEXELS_API_KEY
  if (!key) return null
  try {
    const res = await fetch(
      `https://api.pexels.com/v1/search?query=${encodeURIComponent(keyword)}&per_page=1&orientation=landscape`,
      { headers: { Authorization: key }, signal: AbortSignal.timeout(6000) }
    )
    if (!res.ok) return null
    const data = await res.json()
    return (data.photos?.[0]?.src?.large2x as string) ?? null
  } catch {
    return null
  }
}

// ── Deduplication ──────────────────────────────────────────────
function normalize(s: string) {
  return s.toLowerCase().replace(/[^a-z0-9가-힣]/g, ' ').replace(/\s+/g, ' ').trim()
}

function titleSimilarity(a: string, b: string): number {
  const na = normalize(a)
  const nb = normalize(b)
  if (na === nb) return 1
  const wa = new Set(na.split(' ').filter(w => w.length > 3))
  const wb = new Set(nb.split(' ').filter(w => w.length > 3))
  const shared = [...wa].filter(w => wb.has(w)).length
  const union = wa.size + wb.size - shared
  return union > 0 ? shared / union : 0
}

function dedup(items: CrawledItem[]): CrawledItem[] {
  const result: CrawledItem[] = []
  for (const item of items) {
    if (!result.some(r => titleSimilarity(r.title, item.title) > 0.45)) {
      result.push(item)
    }
  }
  return result
}

// ── Main handler ───────────────────────────────────────────────
export async function POST() {
  const SURL = process.env.NEXT_PUBLIC_SUPABASE_URL!
  const SKEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  const sbHeaders = { apikey: SKEY, Authorization: `Bearer ${SKEY}` }

  // Parallel fetch from all sources
  const [youtube, hn, techcrunch, verge, bbc] = await Promise.all([
    fetchYouTubeTrending(),
    fetchHNTop(),
    fetchRSSFeed('https://techcrunch.com/feed/', 'TechCrunch'),
    fetchRSSFeed('https://www.theverge.com/rss/index.xml', 'The Verge'),
    fetchRSSFeed('https://feeds.bbci.co.uk/news/technology/rss.xml', 'BBC Tech'),
  ])

  // Combine with priority: YouTube KR → HN → RSS
  const combined = [
    ...youtube.slice(0, 4),
    ...hn.slice(0, 3),
    ...techcrunch.slice(0, 2),
    ...verge.slice(0, 2),
    ...bbc.slice(0, 2),
  ]
  const selected = dedup(combined).slice(0, 10)

  if (selected.length === 0) {
    return NextResponse.json({ error: 'No trends collected from any source' }, { status: 502 })
  }

  // Build Supabase rows (with image fallback in parallel)
  const rows = await Promise.all(
    selected.map(async (item) => {
      const category = mapCategory(item.title + ' ' + item.description, item.yt_category_id)
      const tags = extractTags(item.title)

      let imageUrl = item.image_url
      const galleryImages: GalleryImage[] = []

      if (imageUrl) {
        galleryImages.push({ url: imageUrl, source_url: item.source_url, site_name: item.site_name })
      } else {
        const keyword = item.title.replace(/[^\x00-\x7F]/g, ' ').trim().slice(0, 50) || item.site_name
        const pexUrl = await getPexelsImage(keyword)
        if (pexUrl) {
          imageUrl = pexUrl
          galleryImages.push({ url: pexUrl, source_url: 'https://www.pexels.com', site_name: 'Pexels' })
        }
      }

      const related: RelatedSource[] = [{ title: item.title, url: item.source_url, site_name: item.site_name }]

      const whyTrending =
        item.source === 'youtube'
          ? 'YouTube 한국 실시간 인기 트렌딩'
          : item.source === 'hn'
          ? `Hacker News 커뮤니티 인기 게시물`
          : `${item.site_name} 최신 화제 기사`

      const summary =
        item.description.length > 10
          ? item.description.slice(0, 200)
          : `${item.site_name}에서 지금 주목받고 있는 트렌드입니다.`

      return {
        title: item.title,
        summary,
        original_title: item.title,
        body: item.description || null,
        why_trending: whyTrending,
        who_affected: null,
        heat_score: item.heat_score,
        category,
        tags,
        source_url: item.source_url,
        related_sources: related,
        image_search_keyword: item.title.slice(0, 60),
        image_url: imageUrl,
        gallery_images: galleryImages,
        published_at: new Date().toISOString(),
      }
    })
  )

  const insertRes = await fetch(`${SURL}/rest/v1/trends`, {
    method: 'POST',
    headers: { ...sbHeaders, 'Content-Type': 'application/json', Prefer: 'return=representation' },
    body: JSON.stringify(rows),
  })

  if (!insertRes.ok) {
    return NextResponse.json({ error: await insertRes.text() }, { status: 500 })
  }

  const data: { image_url: string | null }[] = await insertRes.json()

  return NextResponse.json({
    success: true,
    count: data.length,
    withImages: data.filter(r => r.image_url).length,
    sources: {
      youtube: Math.min(youtube.length, 4),
      hn: Math.min(hn.length, 3),
      rss: data.length - Math.min(youtube.length, 4) - Math.min(hn.length, 3),
    },
    hasYoutube: youtube.length > 0,
  })
}
