import { NextRequest, NextResponse } from 'next/server'
import type { Category, GalleryImage, RelatedSource } from '@/lib/types'
import { fetchOgImage, fetchRelatedGalleryImages } from '@/lib/utils/og-image'

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

interface ClaudeResult {
  source_id: number
  title: string
  summary: string
  body: string
  why_trending: string
  who_affected: string
  tags: string[]
  category: Category
}

// ── Category mapping ────────────────────────────────────────────
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
    'pizza', 'sushi', 'chocolate', 'chef'], '푸드'],
  [['fashion', 'style', 'clothing', 'outfit', 'brand', 'luxury', 'shoes', 'dress',
    'runway', 'couture', 'streetwear'], '패션'],
  [['health', 'wellness', 'fitness', 'workout', 'sleep', 'mental', 'exercise', 'yoga',
    'nutrition', 'diet', 'meditation'], '라이프'],
  [['design', 'graphic', 'UI', 'UX', 'logo', 'typography', 'visual', 'illustration',
    'Figma', 'creative'], '디자인'],
  [['marketing', 'advertising', 'brand', 'campaign', 'commercial', 'promotion',
    'ad', 'influencer'], '광고'],
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
    title.split(/\s+/)
      .filter(w => w.length > 3 && /[A-Z가-힣]/.test(w[0]))
      .map(w => w.replace(/[^a-zA-Z0-9가-힣]/g, ''))
      .filter(w => w.length > 2).slice(0, 5)
  )]
}

function calcHeatFromLog(value: number, base = 50): number {
  return Math.min(99, Math.max(40, base + Math.floor(Math.log10(value + 1) * 12)))
}

// ── YouTube KR ──────────────────────────────────────────────────
async function fetchYouTubeTrending(): Promise<{ items: CrawledItem[], status: string }> {
  const key = process.env.YOUTUBE_API_KEY
  if (!key) return { items: [], status: 'YOUTUBE_API_KEY 환경변수 미설정' }
  try {
    const res = await fetch(
      `https://www.googleapis.com/youtube/v3/videos?part=snippet,statistics&chart=mostPopular&regionCode=KR&maxResults=15&key=${key}`,
      { signal: AbortSignal.timeout(10000) }
    )
    if (!res.ok) {
      const err = await res.text().catch(() => '')
      return { items: [], status: `YouTube HTTP ${res.status}: ${err.slice(0, 120)}` }
    }
    const data = await res.json()
    if (data.error) return { items: [], status: `YouTube API 오류: ${data.error.message ?? data.error.status}` }
    const items = (data.items ?? []).map((item: {
      id: string
      snippet: {
        title: string; description: string; channelTitle: string; categoryId: string
        thumbnails: { maxres?: { url: string }; high?: { url: string }; medium?: { url: string } }
      }
      statistics: { viewCount?: string }
    }) => ({
      title: item.snippet.title,
      description: (item.snippet.description ?? '').split('\n')[0].slice(0, 300),
      image_url: item.snippet.thumbnails?.maxres?.url ?? item.snippet.thumbnails?.high?.url ?? item.snippet.thumbnails?.medium?.url ?? null,
      source_url: `https://www.youtube.com/watch?v=${item.id}`,
      site_name: item.snippet.channelTitle ?? 'YouTube',
      heat_score: calcHeatFromLog(parseInt(item.statistics?.viewCount ?? '0')),
      source: 'youtube' as const,
      yt_category_id: item.snippet.categoryId,
    }))
    return { items, status: `OK: ${items.length}개 수집` }
  } catch (e) {
    return { items: [], status: `연결 오류: ${String(e).slice(0, 80)}` }
  }
}

// ── Hacker News ─────────────────────────────────────────────────
async function fetchHNTop(): Promise<CrawledItem[]> {
  try {
    const idsRes = await fetch('https://hacker-news.firebaseio.com/v0/topstories.json', { signal: AbortSignal.timeout(8000) })
    const ids: number[] = await idsRes.json()
    const items = await Promise.all(
      ids.slice(0, 30).map(async (id) => {
        try {
          return (await fetch(`https://hacker-news.firebaseio.com/v0/item/${id}.json`, { signal: AbortSignal.timeout(5000) })).json()
        } catch { return null }
      })
    )
    return items
      .filter((item): item is NonNullable<typeof item> => item?.url && item.score >= 80 && item.title)
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
  } catch { return [] }
}

// ── RSS / Atom ──────────────────────────────────────────────────
function cleanText(s: string): string {
  return s.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ').trim()
}

function parseFeedXml(xml: string, siteName: string): Omit<CrawledItem, 'source'>[] {
  const isAtom = xml.includes('<feed')
  const entryRe = isAtom ? /<entry[^>]*>([\s\S]*?)<\/entry>/gi : /<item[^>]*>([\s\S]*?)<\/item>/gi
  const results: Omit<CrawledItem, 'source'>[] = []
  for (const match of [...xml.matchAll(entryRe)].slice(0, 6)) {
    const c = match[1]
    const title = cleanText(c.match(/<title[^>]*>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/i)?.[1] ?? '')
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
    return parseFeedXml(await res.text(), siteName).map(item => ({ ...item, source: 'rss' as const }))
  } catch { return [] }
}

// ── Reddit JSON API ─────────────────────────────────────────────
async function fetchRedditHot(subreddit: string, minScore = 300): Promise<CrawledItem[]> {
  try {
    const res = await fetch(`https://www.reddit.com/r/${subreddit}/hot.json?limit=15`, {
      headers: { 'User-Agent': 'PikkBot/1.0 (+https://pikk.app)', Accept: 'application/json' },
      signal: AbortSignal.timeout(8000),
    })
    if (!res.ok) return []
    const data = await res.json()
    const children = (data?.data?.children ?? []) as { data: Record<string, unknown> }[]
    return children
      .map(c => c.data)
      .filter(p => !p.over_18 && !p.stickied && p.url && Number(p.score) >= minScore)
      .slice(0, 4)
      .map(p => {
        const thumb = String(p.thumbnail ?? '')
        return {
          title: String(p.title ?? '').slice(0, 200),
          description: String(p.selftext ?? '').slice(0, 200),
          image_url: thumb.startsWith('http') ? thumb : null,
          source_url: p.is_self ? `https://www.reddit.com${String(p.permalink)}` : String(p.url ?? ''),
          site_name: `r/${subreddit}`,
          heat_score: calcHeatFromLog(Number(p.score ?? 0), 45),
          source: 'rss' as const,
        }
      })
  } catch { return [] }
}

// ── Dev.to API ──────────────────────────────────────────────────
async function fetchDevTo(): Promise<CrawledItem[]> {
  try {
    const res = await fetch('https://dev.to/api/articles?top=7&per_page=6', {
      headers: { 'User-Agent': 'PikkBot/1.0' },
      signal: AbortSignal.timeout(8000),
    })
    if (!res.ok) return []
    const articles: Array<{ title: string; description: string; url: string; cover_image: string | null; public_reactions_count: number }> = await res.json()
    return articles.map(a => ({
      title: a.title,
      description: a.description ?? '',
      image_url: a.cover_image,
      source_url: a.url,
      site_name: 'Dev.to',
      heat_score: calcHeatFromLog(a.public_reactions_count ?? 0, 50),
      source: 'rss' as const,
    }))
  } catch { return [] }
}


// ── Dedup ───────────────────────────────────────────────────────
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

// ── Claude Sonnet 4.6 저널리스트 — 단일 호출 (선별 + 짧은 기사) ──
function makeJournalistPrompt(items: CrawledItem[]): string {
  const list = items
    .map((item, i) => `${i + 1}. [${item.site_name}] ${item.title}`)
    .join('\n')

  return `트렌드 에디터. 아래 ${items.length}개 중 핫한 5개를 골라 한국어 카드뉴스를 작성하세요.
JSON 배열만 출력. 마크다운·코드블록 없음. source_id는 1부터 시작.
모든 텍스트 필드는 매우 짧게 작성하세요(body 60자, 나머지 30자 이내).

[{"source_id":N,"title":"제목(15자)","summary":"요약(30자)","body":"본문(60자)","why_trending":"이유(30자)","who_affected":"대상(20자)","tags":["태그1","태그2","태그3","태그4","태그5"],"category":"테크|SNS|푸드|뷰티|패션|라이프|디자인|광고|영상 중 하나"}]

${list}`
}

// ── 본문 확장 ─────────────────────────────────────────────────
async function expandBody(
  apiKey: string, title: string, siteName: string, description: string
): Promise<string | null> {
  const prompt = `다음 트렌드에 대해 400-600자 한국어 기사 본문을 작성하세요.
배경·왜 지금 화제·글로벌 동향·한국 의미·전망을 포함하세요.
본문 텍스트만 출력. JSON·마크다운 없음.

트렌드: ${title}
출처: ${siteName}${description ? `\n설명: ${description.slice(0, 150)}` : ''}`
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 700,
        messages: [{ role: 'user', content: prompt }],
      }),
      signal: AbortSignal.timeout(18000),
    })
    if (!res.ok) return null
    const data = await res.json()
    return (data.content?.[0]?.text as string | undefined)?.trim() ?? null
  } catch { return null }
}

// ── 이미지 수집 (Claude 제목 기준) ────────────────────────────
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

// Claude 제목에서 영어 키워드 추출 (Pexels용)
function extractEnglishKeyword(claudeTitle: string, fallback: string): string {
  const english = (claudeTitle.match(/[A-Za-z][A-Za-z0-9 ]{2,}/g) ?? []).join(' ').trim()
  if (english.length > 3) return english.slice(0, 50)
  return fallback.replace(/[가-힣]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 50)
}

// 원본 제목과 Claude 제목이 같은 주제인지 확인 (이미지 관련성 체크)
function titleTopicMatch(originalTitle: string, claudeTitle: string): boolean {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9가-힣]/g, ' ')
  const origWords = new Set(norm(originalTitle).split(/\s+/).filter(w => w.length >= 3))
  const claudeWords = new Set(norm(claudeTitle).split(/\s+/).filter(w => w.length >= 3))
  const shared = [...origWords].filter(w => claudeWords.has(w))
  return shared.length > 0
}

async function collectImages(
  claudeTitle: string,
  item: CrawledItem
): Promise<{ mainImg: string | null; gallery: GalleryImage[] }> {
  // 제목 불일치면 소스 이미지 건너뜀 (Claude 환각으로 YouTube K-pop이 Musk 기사에 연결되는 경우 방지)
  const topicMatches = titleTopicMatch(item.title, claudeTitle)

  let mainImg: string | null = null

  // ① 소스 이미지 (제목이 일치할 때만)
  if (topicMatches) {
    if (item.source === 'youtube') {
      const videoId = item.source_url.match(/[?&]v=([^&]+)/)?.[1]
      mainImg = videoId
        ? `https://img.youtube.com/vi/${videoId}/maxresdefault.jpg`
        : (item.image_url ?? null)
    } else {
      mainImg = await fetchOgImage(item.source_url)
    }
  }

  // ② Bing News 갤러리 (항상 Claude 제목으로 검색)
  const [fetchedOg, related] = await Promise.all([
    (mainImg || topicMatches) ? Promise.resolve<string | null>(null) : fetchOgImage(item.source_url),
    fetchRelatedGalleryImages(claudeTitle, item.source_url, 4),
  ])
  if (!mainImg && fetchedOg) mainImg = fetchedOg

  // ③ Bing News 첫 번째 이미지를 메인으로 (소스가 불일치하거나 이미지 없을 때)
  if (!mainImg && related.length > 0) mainImg = related[0].url

  // ④ Pexels fallback (Claude 제목의 영어 키워드로 검색)
  if (!mainImg) {
    const keyword = extractEnglishKeyword(claudeTitle, item.title)
    mainImg = await getPexelsImage(keyword)
  }

  // 갤러리 구성
  const gallery: GalleryImage[] = []
  // 소스 이미지는 제목이 일치할 때만 갤러리에 포함
  if (mainImg && topicMatches) {
    gallery.push({ url: mainImg, source_url: item.source_url, site_name: item.site_name })
  }
  gallery.push(...related.slice(0, 4 - Math.min(gallery.length, 1)))

  const finalMainImg = mainImg ?? gallery[0]?.url ?? null
  return { mainImg: finalMainImg, gallery }
}

async function generateWithClaude(items: CrawledItem[]): Promise<{ results: ClaudeResult[], error?: string, _articleErrors?: string[] }> {
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) return { results: [], error: 'ANTHROPIC_API_KEY 미설정' }
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 1200,
        messages: [{ role: 'user', content: makeJournalistPrompt(items) }],
      }),
      signal: AbortSignal.timeout(45000),
    })
    if (!res.ok) {
      const errText = await res.text().catch(() => '')
      return { results: [], error: `Claude API HTTP ${res.status}: ${errText.slice(0, 200)}` }
    }
    const data = await res.json()
    if (data.error) return { results: [], error: `Claude API 오류: ${data.error.message ?? JSON.stringify(data.error)}` }
    const text: string = data.content?.[0]?.text ?? ''
    const jsonMatch = text.match(/\[[\s\S]*\]/)
    if (!jsonMatch) return { results: [], error: `JSON 파싱 실패. Claude 응답 앞 300자: ${text.slice(0, 300)}` }
    let parsed: Record<string, unknown>[]
    try {
      parsed = JSON.parse(jsonMatch[0])
    } catch (e) {
      return { results: [], error: `JSON.parse 실패: ${String(e)}. 매칭 앞 200자: ${jsonMatch[0].slice(0, 200)}` }
    }
    if (!Array.isArray(parsed)) return { results: [], error: 'Claude 응답이 배열이 아님' }

    const seen = new Set<number>()
    const results = parsed
      .filter(p => {
        const id = Number(p.source_id)
        if (!Number.isInteger(id) || id < 1 || id > items.length || seen.has(id)) return false
        seen.add(id)
        return true
      })
      .slice(0, 5)
      .map(p => ({
        source_id: Number(p.source_id),
        title: String(p.title ?? '').slice(0, 80),
        summary: String(p.summary ?? '').slice(0, 200),
        body: String(p.body ?? '').slice(0, 2000),
        why_trending: String(p.why_trending ?? '').slice(0, 500),
        who_affected: String(p.who_affected ?? '').slice(0, 300),
        tags: Array.isArray(p.tags) ? (p.tags as unknown[]).map(String).slice(0, 7) : extractTags(items[Number(p.source_id) - 1]?.title ?? ''),
        category: (VALID_CATS.has(String(p.category)) ? String(p.category) : mapCategory(items[Number(p.source_id) - 1]?.title ?? '', items[Number(p.source_id) - 1]?.yt_category_id)) as Category,
      }))

    if (results.length === 0) {
      const ids = parsed.slice(0, 5).map(p => p.source_id)
      return { results: [], error: `source_id 검증 실패. 파싱 ${parsed.length}개, 샘플: ${JSON.stringify(ids)}, items.length: ${items.length}` }
    }
    return { results }
  } catch (e) {
    return { results: [], error: `예외 발생: ${String(e)}` }
  }
}

// ── Vercel Cron ─────────────────────────────────────────────────
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

  // 전체 소스 병렬 수집
  const [
    ytResult, hn,
    techcrunch, verge, bbc, reuters, aljazeera, japantimes,
    producthunt, devto,
    mediumTech, mediumDesign, mediumBusiness, mediumCulture,
    redditWorld, redditTech, redditScience, redditBusiness, redditFashion, redditFood,
  ] = await Promise.all([
    fetchYouTubeTrending(),
    fetchHNTop(),
    fetchRSSFeed('https://techcrunch.com/feed/', 'TechCrunch'),
    fetchRSSFeed('https://www.theverge.com/rss/index.xml', 'The Verge'),
    fetchRSSFeed('https://feeds.bbci.co.uk/news/technology/rss.xml', 'BBC Tech'),
    fetchRSSFeed('https://feeds.reuters.com/reuters/topNews', 'Reuters'),
    fetchRSSFeed('https://www.aljazeera.com/xml/rss/all.xml', 'Al Jazeera'),
    fetchRSSFeed('https://www.japantimes.co.jp/feed/', 'Japan Times'),
    fetchRSSFeed('https://www.producthunt.com/feed', 'Product Hunt'),
    fetchDevTo(),
    fetchRSSFeed('https://medium.com/feed/tag/technology', 'Medium'),
    fetchRSSFeed('https://medium.com/feed/tag/design', 'Medium'),
    fetchRSSFeed('https://medium.com/feed/tag/business', 'Medium'),
    fetchRSSFeed('https://medium.com/feed/tag/culture', 'Medium'),
    fetchRedditHot('worldnews', 1000),
    fetchRedditHot('technology', 500),
    fetchRedditHot('science', 500),
    fetchRedditHot('business', 300),
    fetchRedditHot('fashion', 100),
    fetchRedditHot('food', 100),
  ])

  const youtube = ytResult.items
  const youtubeStatus = ytResult.status

  // 소스별 쿼터 적용 후 합산
  const combined = [
    ...youtube.slice(0, 4),
    ...hn.slice(0, 4),
    ...techcrunch.slice(0, 2), ...verge.slice(0, 2), ...bbc.slice(0, 2),
    ...reuters.slice(0, 2), ...aljazeera.slice(0, 2), ...japantimes.slice(0, 2),
    ...producthunt.slice(0, 2), ...devto.slice(0, 2),
    ...mediumTech.slice(0, 1), ...mediumDesign.slice(0, 1),
    ...mediumBusiness.slice(0, 1), ...mediumCulture.slice(0, 1),
    ...redditWorld.slice(0, 2), ...redditTech.slice(0, 2),
    ...redditScience.slice(0, 1), ...redditBusiness.slice(0, 1),
    ...redditFashion.slice(0, 1), ...redditFood.slice(0, 1),
  ]

  const selected = dedup(combined).slice(0, 30)

  if (selected.length === 0) {
    return NextResponse.json({ error: 'No trends collected', youtubeStatus }, { status: 502 })
  }

  // Claude가 30개 중 10개 선별 + 한국어 기사 작성
  const { results: claudeResults, error: claudeError, _articleErrors } = await generateWithClaude(selected)

  if (claudeResults.length === 0) {
    return NextResponse.json({ error: claudeError ?? 'Claude generation failed', youtubeStatus, collected: selected.length }, { status: 500 })
  }

  // 이미지 없이 먼저 insert (이후 병렬로 이미지+본문 확장)
  const rows = claudeResults.map((result) => {
    const item = selected[result.source_id - 1]
    const relatedSources: RelatedSource[] = [{ title: item.title, url: item.source_url, site_name: item.site_name }]
    return {
      title: result.title,
      summary: result.summary,
      original_title: item.title,
      body: result.body || null,
      why_trending: result.why_trending || null,
      who_affected: result.who_affected || null,
      heat_score: item.heat_score,
      category: result.category,
      tags: result.tags,
      source_url: item.source_url,
      related_sources: relatedSources,
      image_search_keyword: item.title.slice(0, 60),
      image_url: null as string | null,
      gallery_images: [] as GalleryImage[],
      published_at: new Date().toISOString(),
    }
  })

  const insertRes = await fetch(`${SURL}/rest/v1/trends`, {
    method: 'POST',
    headers: { ...sbHeaders, 'Content-Type': 'application/json', Prefer: 'return=representation' },
    body: JSON.stringify(rows),
  })

  if (!insertRes.ok) {
    return NextResponse.json({ error: await insertRes.text(), youtubeStatus }, { status: 500 })
  }

  const data: { id: string; image_url: string | null }[] = await insertRes.json()

  // 이미지 수집 + 본문 확장 병렬 실행 후 단일 PATCH
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (data.length > 0) {
    await Promise.all(
      data.map(async (inserted, i) => {
        const result = claudeResults[i]
        const item = selected[result.source_id - 1]
        const row = rows[i]

        // 이미지 수집 + 본문 확장 동시 실행
        const [{ mainImg, gallery }, expandedBody] = await Promise.all([
          collectImages(result.title, item),
          apiKey ? expandBody(apiKey, row.title, item.site_name, row.summary || item.description) : Promise.resolve<string | null>(null),
        ])

        await fetch(`${SURL}/rest/v1/trends?id=eq.${inserted.id}`, {
          method: 'PATCH',
          headers: { ...sbHeaders, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
          body: JSON.stringify({
            image_url: mainImg,
            gallery_images: gallery,
            body: expandedBody || row.body || null,
          }),
        }).catch(() => null)
      })
    )
  }

  return NextResponse.json({
    success: true,
    count: data.length,
    withImages: claudeResults.length,
    collected: selected.length,
    sources: {
      youtube: youtube.length, hn: hn.length,
      rss: selected.length - youtube.length - hn.length,
    },
    hasYoutube: youtube.length > 0,
    youtubeStatus,
    articleErrors: _articleErrors?.length ? _articleErrors : undefined,
  })
}
