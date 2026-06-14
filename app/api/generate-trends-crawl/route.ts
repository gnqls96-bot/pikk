import { NextRequest, NextResponse } from 'next/server'
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

interface KoreanContent {
  title: string
  summary: string
  body: string
  why_trending: string
  who_affected: string
  tags: string[]
  category: Category
}

// ── Category mapping ───────────────────────────────────────────
const YT_CATEGORY_MAP: Record<string, Category> = {
  '1': '영상', '10': '영상', '20': '라이프', '22': 'SNS', '23': 'SNS',
  '24': 'SNS', '26': '뷰티', '28': '테크',
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

const VALID_CATS = new Set<string>([
  '푸드', '뷰티', 'SNS', '패션', '테크', '라이프', '디자인', '광고', '영상',
])

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

// ── YouTube KR Trending ─────────────────────────────────────────
async function fetchYouTubeTrending(): Promise<{ items: CrawledItem[], status: string }> {
  const key = process.env.YOUTUBE_API_KEY
  if (!key) return { items: [], status: 'YOUTUBE_API_KEY 환경변수 미설정' }
  try {
    const res = await fetch(
      `https://www.googleapis.com/youtube/v3/videos?part=snippet,statistics&chart=mostPopular&regionCode=KR&maxResults=15&key=${key}`,
      { signal: AbortSignal.timeout(10000) }
    )
    if (!res.ok) {
      const errText = await res.text().catch(() => '')
      return { items: [], status: `YouTube HTTP ${res.status}: ${errText.slice(0, 120)}` }
    }
    const data = await res.json()
    if (data.error) {
      return { items: [], status: `YouTube API 오류: ${data.error.message ?? data.error.status}` }
    }
    const items = (data.items ?? []).map((item: {
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
    return { items, status: `OK: ${items.length}개 수집` }
  } catch (e) {
    return { items: [], status: `연결 오류: ${String(e).slice(0, 80)}` }
  }
}

// ── Hacker News Top Stories ─────────────────────────────────────
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

// ── RSS / Atom feed parser ──────────────────────────────────────
function cleanText(s: string): string {
  return s
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ')
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
    const imageUrl =
      c.match(/<media:content[^>]+url=["']([^"']+)["'][^>]*medium=["']image["']/i)?.[1] ??
      c.match(/<media:thumbnail[^>]+url=["']([^"']+)["']/i)?.[1] ??
      c.match(/<enclosure[^>]+type=["']image[^"']*["'][^>]+url=["']([^"']+)["']/i)?.[1] ??
      c.match(/<enclosure[^>]+url=["']([^"']+)["'][^>]+type=["']image/i)?.[1] ??
      null
    results.push({ title, description, image_url: imageUrl, source_url: link, site_name: siteName, heat_score: 62 })
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

// ── Pexels image fallback ───────────────────────────────────────
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

// ── Deduplication ───────────────────────────────────────────────
function normalize(s: string) {
  return s.toLowerCase().replace(/[^a-z0-9가-힣]/g, ' ').replace(/\s+/g, ' ').trim()
}

function titleSimilarity(a: string, b: string): number {
  const na = normalize(a); const nb = normalize(b)
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
    if (!result.some(r => titleSimilarity(r.title, item.title) > 0.45)) result.push(item)
  }
  return result
}

// ── Claude Sonnet 4.6 journalist content generation ─────────────
function makePrompt(count: number, itemsJson: string): string {
  return `당신은 전세계 트렌드를 분석하는 최고의 저널리스트입니다. 한국 독자들이 글로벌 트렌드를 깊이 이해할 수 있도록 심층 분석 기사를 작성합니다.

다음 ${count}개 트렌드를 분석해 JSON 배열만 출력하세요. 마크다운·설명 없이 순수 JSON만.

각 항목 형식:
{"title":"독자가 클릭하고 싶은 강렬한 한국어 제목 (20-35자)","summary":"핵심 한 줄 요약 (50-80자)","body":"최소 1000자 한국어 심층 본문. 반드시 포함: 1)배경과 맥락 2)왜 지금 뜨는가(구체적 수치·사례) 3)글로벌 동향과 주요 플레이어 4)한국 시장 의미와 영향 5)앞으로의 전망. 자연스럽고 읽기 쉬운 한국어로.","why_trending":"왜 지금 이 트렌드가 폭발적으로 주목받는가를 3줄 이상 구체적으로","who_affected":"이 트렌드에 주목해야 하는 사람들 구체적으로 (업계 관계자·소비자·투자자 등)","tags":["한국어태그1","한국어태그2","한국어태그3","한국어태그4","한국어태그5"],"category":"테크|SNS|푸드|뷰티|패션|라이프|디자인|광고|영상 중 하나"}

분석할 트렌드:
${itemsJson}`
}

function makeFallback(items: CrawledItem[]): KoreanContent[] {
  return items.map((item) => ({
    title: item.title.slice(0, 60),
    summary: item.description.slice(0, 100) || `${item.site_name}의 트렌드`,
    body: item.description.slice(0, 500) || '',
    why_trending: '',
    who_affected: '',
    tags: extractTags(item.title),
    category: mapCategory(item.title + ' ' + item.description, item.yt_category_id),
  }))
}

async function callClaude(batch: CrawledItem[]): Promise<KoreanContent[]> {
  const apiKey = process.env.ANTHROPIC_API_KEY!
  const itemsJson = JSON.stringify(
    batch.map((item, i) => ({
      id: i + 1,
      title: item.title,
      description: item.description.slice(0, 250),
      source: item.site_name,
      type: item.source,
    }))
  )
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 8192,
      messages: [{ role: 'user', content: makePrompt(batch.length, itemsJson) }],
    }),
    signal: AbortSignal.timeout(50000),
  })
  if (!res.ok) throw new Error(`Anthropic HTTP ${res.status}`)
  const data = await res.json()
  const text: string = data.content?.[0]?.text ?? ''
  const jsonMatch = text.match(/\[[\s\S]*\]/)
  if (!jsonMatch) throw new Error('No JSON array in response')
  const parsed: Record<string, unknown>[] = JSON.parse(jsonMatch[0])
  if (!Array.isArray(parsed) || parsed.length !== batch.length) throw new Error('Count mismatch')
  return parsed.map((p, i) => ({
    title: String(p.title ?? batch[i].title).slice(0, 80),
    summary: String(p.summary ?? '').slice(0, 200),
    body: String(p.body ?? '').slice(0, 2000),
    why_trending: String(p.why_trending ?? '').slice(0, 500),
    who_affected: String(p.who_affected ?? '').slice(0, 300),
    tags: Array.isArray(p.tags) ? (p.tags as unknown[]).map(String).slice(0, 7) : extractTags(batch[i].title),
    category: (VALID_CATS.has(String(p.category))
      ? String(p.category)
      : mapCategory(batch[i].title + ' ' + batch[i].description, batch[i].yt_category_id)) as Category,
  }))
}

async function generateKoreanContent(items: CrawledItem[]): Promise<KoreanContent[]> {
  if (!process.env.ANTHROPIC_API_KEY) return makeFallback(items)
  try {
    // 5개씩 병렬 처리 (토큰 한도 내 처리)
    const mid = Math.ceil(items.length / 2)
    const [b1, b2] = await Promise.all([
      callClaude(items.slice(0, mid)),
      items.length > mid ? callClaude(items.slice(mid)) : Promise.resolve([] as KoreanContent[]),
    ])
    return [...b1, ...b2]
  } catch {
    return makeFallback(items)
  }
}

// ── Vercel Cron (매일 06:00 KST = 21:00 UTC) ───────────────────
export async function GET(req: NextRequest) {
  if (req.headers.get('authorization') !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  return runCrawl()
}

export async function POST() {
  return runCrawl()
}

async function runCrawl() {
  const SURL = process.env.NEXT_PUBLIC_SUPABASE_URL!
  const SKEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  const sbHeaders = { apikey: SKEY, Authorization: `Bearer ${SKEY}` }

  // 모든 소스 병렬 수집
  const [ytResult, hn, techcrunch, verge, bbc] = await Promise.all([
    fetchYouTubeTrending(),
    fetchHNTop(),
    fetchRSSFeed('https://techcrunch.com/feed/', 'TechCrunch'),
    fetchRSSFeed('https://www.theverge.com/rss/index.xml', 'The Verge'),
    fetchRSSFeed('https://feeds.bbci.co.uk/news/technology/rss.xml', 'BBC Tech'),
  ])
  const youtube = ytResult.items
  const youtubeStatus = ytResult.status

  const combined = [
    ...youtube.slice(0, 4),
    ...hn.slice(0, 3),
    ...techcrunch.slice(0, 2),
    ...verge.slice(0, 2),
    ...bbc.slice(0, 2),
  ]
  const selected = dedup(combined).slice(0, 10)

  if (selected.length === 0) {
    return NextResponse.json(
      { error: 'No trends collected from any source', youtubeStatus },
      { status: 502 }
    )
  }

  // 이미지 수집 (YouTube 썸네일 + Pexels fallback)
  const rows = await Promise.all(
    selected.map(async (item) => {
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
      return {
        original_title: item.title,
        source_url: item.source_url,
        related_sources: related,
        image_search_keyword: item.title.slice(0, 60),
        image_url: imageUrl,
        gallery_images: galleryImages,
        heat_score: item.heat_score,
        who_affected: null as string | null,
        published_at: new Date().toISOString(),
        // Claude가 덮어쓸 필드 (placeholder)
        title: item.title,
        summary: '',
        body: null as string | null,
        why_trending: '',
        tags: [] as string[],
        category: mapCategory(item.title + ' ' + item.description, item.yt_category_id) as Category,
      }
    })
  )

  // Claude Sonnet 4.6으로 한국어 심층 콘텐츠 생성
  const koreanContents = await generateKoreanContent(selected)

  // 이미지·메타 + Claude 콘텐츠 합성
  const finalRows = rows.map((row, i) => ({
    ...row,
    title: koreanContents[i].title,
    summary: koreanContents[i].summary,
    body: koreanContents[i].body || null,
    why_trending: koreanContents[i].why_trending || null,
    who_affected: koreanContents[i].who_affected || null,
    tags: koreanContents[i].tags,
    category: koreanContents[i].category,
  }))

  const insertRes = await fetch(`${SURL}/rest/v1/trends`, {
    method: 'POST',
    headers: { ...sbHeaders, 'Content-Type': 'application/json', Prefer: 'return=representation' },
    body: JSON.stringify(finalRows),
  })

  if (!insertRes.ok) {
    return NextResponse.json({ error: await insertRes.text(), youtubeStatus }, { status: 500 })
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
    youtubeStatus,
  })
}
