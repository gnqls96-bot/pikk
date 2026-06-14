import { NextRequest, NextResponse } from 'next/server'
import type { Category, GalleryImage, RelatedSource } from '@/lib/types'
import { fetchOgImage, fetchRelatedGalleryImages, fetchPexelsImages } from '@/lib/utils/og-image'

export const maxDuration = 60

// ── Structured logging ──────────────────────────────────────────
function log(msg: string, data?: unknown) {
  console.log(JSON.stringify({ ts: new Date().toISOString(), msg, ...(data != null ? { data } : {}) }))
}

// ── Types ───────────────────────────────────────────────────────
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
  if (!key) return { items: [], status: 'YOUTUBE_API_KEY 미설정' }
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

// ── Claude 저널리스트 (선별 + 짧은 기사) ────────────────────────
function makeJournalistPrompt(items: CrawledItem[]): string {
  const list = items
    .map((item, i) => `${i + 1}. [${item.site_name}] ${item.title}`)
    .join('\n')

  return `트렌드 에디터. 아래 ${items.length}개 중 핫한 10개를 골라 한국어 카드뉴스를 작성하세요.
JSON 배열만 출력. 마크다운·코드블록 없음. source_id는 1부터 시작.
모든 텍스트 필드는 매우 짧게 작성하세요(body 40자, 나머지 25자 이내).

[{"source_id":N,"title":"제목(15자)","summary":"요약(25자)","body":"본문(40자)","why_trending":"이유(25자)","who_affected":"대상(20자)","tags":["태그1","태그2","태그3","태그4","태그5"],"category":"테크|SNS|푸드|뷰티|패션|라이프|디자인|광고|영상 중 하나"}]

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
      signal: AbortSignal.timeout(15000),
    })
    if (!res.ok) return null
    const data = await res.json()
    return (data.content?.[0]?.text as string | undefined)?.trim() ?? null
  } catch { return null }
}

// ── 이미지 수집 ───────────────────────────────────────────────
const CATEGORY_KEYWORD: Record<string, string> = {
  '테크': 'technology digital innovation',
  'SNS': 'social media smartphone app',
  '영상': 'video camera screen',
  '푸드': 'food restaurant meal',
  '패션': 'fashion style clothing',
  '라이프': 'lifestyle wellness',
  '디자인': 'design creative',
  '광고': 'advertising marketing',
  '뷰티': 'beauty cosmetics',
}

function extractEnglishKeyword(claudeTitle: string, fallback: string): string {
  // Claude 제목에서 영어 단어 추출
  const english = (claudeTitle.match(/[A-Za-z][A-Za-z0-9 ]{1,}/g) ?? []).join(' ').trim()
  if (english.length > 2) return english.slice(0, 50)
  // 소스 제목에서 영어 단어만 추출 (첫 3단어)
  const fromFallback = fallback
    .replace(/[가-힣]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 2 && /[A-Za-z]/.test(w))
    .slice(0, 3)
    .join(' ')
    .trim()
  return fromFallback.slice(0, 50)
}

// 원본 제목과 Claude 제목이 같은 주제인지 확인
function titleTopicMatch(originalTitle: string, claudeTitle: string): boolean {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9가-힣]/g, ' ')
  const origWords = new Set(norm(originalTitle).split(/\s+/).filter(w => w.length >= 3))
  const claudeWords = new Set(norm(claudeTitle).split(/\s+/).filter(w => w.length >= 3))
  return [...origWords].some(w => claudeWords.has(w))
}

async function collectImages(
  claudeTitle: string,
  item: CrawledItem,
  category: string = '테크'
): Promise<{ mainImg: string | null; gallery: GalleryImage[] }> {
  const topicMatches = titleTopicMatch(item.title, claudeTitle)

  let mainImg: string | null = null

  // ① 소스 이미지 (제목 일치 시에만 — 환각 방지)
  if (topicMatches) {
    if (item.source === 'youtube') {
      const videoId = item.source_url.match(/[?&]v=([^&]+)/)?.[1]
      mainImg = videoId ? `https://img.youtube.com/vi/${videoId}/maxresdefault.jpg` : (item.image_url ?? null)
    } else {
      mainImg = await fetchOgImage(item.source_url)
    }
  }

  // ② Bing News 갤러리 (항상 Claude 제목으로 검색, 병렬)
  const [fetchedOg, related] = await Promise.all([
    (!mainImg && !topicMatches) ? fetchOgImage(item.source_url) : Promise.resolve<string | null>(null),
    fetchRelatedGalleryImages(claudeTitle, item.source_url, 4),
  ])
  if (!mainImg && fetchedOg) mainImg = fetchedOg

  // Bing에서 결과 없으면 영문 키워드로 재시도
  let finalRelated = related
  if (related.length === 0) {
    const engKeyword = extractEnglishKeyword(claudeTitle, item.title).trim()
    if (engKeyword.length > 2) {
      finalRelated = await fetchRelatedGalleryImages(engKeyword, item.source_url, 4)
    }
  }

  // ③ Bing 첫 번째 이미지를 메인으로
  if (!mainImg && finalRelated.length > 0) mainImg = finalRelated[0].url

  // ④ Pexels fallback
  const engKeyword = extractEnglishKeyword(claudeTitle, item.title).trim()
  if (!mainImg && engKeyword) {
    const pexels = await fetchPexelsImages(engKeyword, 1)
    mainImg = pexels[0]?.url ?? null
  }
  // ⑤ 카테고리 기반 최종 폴백 (모든 시도 실패 시)
  if (!mainImg) {
    const catKeyword = CATEGORY_KEYWORD[category] ?? 'trending news'
    const pexels = await fetchPexelsImages(catKeyword, 1)
    mainImg = pexels[0]?.url ?? null
  }

  // 갤러리 구성 (URL 중복 제거, 4개 채우기)
  const seenUrls = new Set<string>()
  const gallery: GalleryImage[] = []

  const addToGallery = (img: GalleryImage) => {
    if (!seenUrls.has(img.url) && gallery.length < 4) {
      seenUrls.add(img.url)
      gallery.push(img)
    }
  }

  if (mainImg && topicMatches) {
    addToGallery({ url: mainImg, source_url: item.source_url, site_name: item.site_name })
  }
  for (const r of finalRelated) addToGallery(r)

  // Pexels로 4개 보충
  if (gallery.length < 4 && engKeyword) {
    const pexels = await fetchPexelsImages(engKeyword, 4 - gallery.length)
    for (const p of pexels) addToGallery(p)
  }
  // 카테고리 키워드로 나머지 채우기
  if (gallery.length < 4) {
    const catKeyword = CATEGORY_KEYWORD[category] ?? 'trending news'
    const pexels = await fetchPexelsImages(catKeyword, 4 - gallery.length)
    for (const p of pexels) addToGallery(p)
  }

  return { mainImg: mainImg ?? gallery[0]?.url ?? null, gallery }
}

// ── Claude 생성 ───────────────────────────────────────────────
async function generateWithClaude(items: CrawledItem[]): Promise<{ results: ClaudeResult[], error?: string }> {
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) return { results: [], error: 'ANTHROPIC_API_KEY 미설정' }
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 2200,
        messages: [{ role: 'user', content: makeJournalistPrompt(items) }],
      }),
      signal: AbortSignal.timeout(40000),
    })
    if (!res.ok) {
      const errText = await res.text().catch(() => '')
      return { results: [], error: `Claude API HTTP ${res.status}: ${errText.slice(0, 200)}` }
    }
    const data = await res.json()
    if (data.error) return { results: [], error: `Claude API 오류: ${data.error.message ?? JSON.stringify(data.error)}` }

    const text: string = data.content?.[0]?.text ?? ''
    const jsonMatch = text.match(/\[[\s\S]*\]/)
    if (!jsonMatch) return { results: [], error: `JSON 파싱 실패. 응답 앞 300자: ${text.slice(0, 300)}` }

    let parsed: Record<string, unknown>[]
    try { parsed = JSON.parse(jsonMatch[0]) }
    catch (e) { return { results: [], error: `JSON.parse 실패: ${String(e)}` } }
    if (!Array.isArray(parsed)) return { results: [], error: 'Claude 응답이 배열이 아님' }

    const seen = new Set<number>()
    const results = parsed
      .filter(p => {
        const id = Number(p.source_id)
        if (!Number.isInteger(id) || id < 1 || id > items.length || seen.has(id)) return false
        seen.add(id)
        return true
      })
      .slice(0, 10)
      .map(p => {
        const sid = Number(p.source_id)
        const src = items[sid - 1]
        return {
          source_id: sid,
          title: String(p.title ?? '').slice(0, 80),
          summary: String(p.summary ?? '').slice(0, 200),
          body: String(p.body ?? '').slice(0, 2000),
          why_trending: String(p.why_trending ?? '').slice(0, 500),
          who_affected: String(p.who_affected ?? '').slice(0, 300),
          tags: Array.isArray(p.tags) ? (p.tags as unknown[]).map(String).slice(0, 7) : extractTags(src?.title ?? ''),
          category: (VALID_CATS.has(String(p.category)) ? String(p.category) : mapCategory(src?.title ?? '', src?.yt_category_id)) as Category,
        }
      })

    if (results.length === 0) {
      return { results: [], error: `source_id 검증 실패. 파싱 ${parsed.length}개, items.length: ${items.length}` }
    }
    return { results }
  } catch (e) {
    return { results: [], error: `예외 발생: ${String(e)}` }
  }
}

// ── Vercel Cron ─────────────────────────────────────────────────
export async function GET(req: NextRequest) {
  const secret = process.env.CRON_SECRET
  if (secret && req.headers.get('authorization') !== `Bearer ${secret}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  return runCrawl('cron')
}

export async function POST() {
  return runCrawl('manual')
}

async function runCrawl(trigger: 'cron' | 'manual' = 'manual') {
  const startedAt = Date.now()
  log('crawl_start', { trigger })

  const SURL = process.env.NEXT_PUBLIC_SUPABASE_URL!
  const SKEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  const sbHeaders = { apikey: SKEY, Authorization: `Bearer ${SKEY}` }

  // ── 중복 실행 방지 (크론 재시도 시 이미 성공한 경우 스킵) ──
  if (trigger === 'cron') {
    const since = new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString()
    const checkRes = await fetch(
      `${SURL}/rest/v1/trends?published_at=gte.${encodeURIComponent(since)}&select=id&limit=1`,
      { headers: sbHeaders }
    ).catch(() => null)
    if (checkRes?.ok) {
      const existing = await checkRes.json().catch(() => [])
      if (Array.isArray(existing) && existing.length > 0) {
        log('crawl_skip', { reason: '최근 6시간 이내 트렌드 존재', count: existing.length })
        return NextResponse.json({ skipped: true, reason: '최근 6시간 내 트렌드 존재' })
      }
    }
  }

  // ── 소스 병렬 수집 ──────────────────────────────────────────
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

  const combined = [
    ...youtube.slice(0, 4), ...hn.slice(0, 4),
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
  log('sources_collected', {
    youtube: youtube.length, hn: hn.length,
    rss: selected.length - youtube.length - hn.length,
    total: selected.length,
    youtubeStatus: ytResult.status,
  })

  if (selected.length === 0) {
    log('crawl_error', { reason: '소스 수집 0개' })
    return NextResponse.json({ error: '소스 수집 실패', youtubeStatus: ytResult.status }, { status: 502 })
  }

  // ── Claude 기사 생성 ────────────────────────────────────────
  const { results: claudeResults, error: claudeError } = await generateWithClaude(selected)
  log('claude_generated', { count: claudeResults.length, error: claudeError ?? null })

  if (claudeResults.length === 0) {
    return NextResponse.json({
      error: claudeError ?? 'Claude 생성 실패',
      collected: selected.length,
    }, { status: 500 })
  }

  // ── Supabase insert (이미지 없이 먼저) ─────────────────────
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
    const errText = await insertRes.text()
    log('insert_error', { status: insertRes.status, body: errText.slice(0, 300) })
    return NextResponse.json({ error: errText }, { status: 500 })
  }

  const inserted: { id: string }[] = await insertRes.json()
  log('insert_ok', { count: inserted.length })

  // ── 이미지 수집 + 본문 확장 (병렬) ────────────────────────
  const apiKey = process.env.ANTHROPIC_API_KEY
  const imageResults: { title: string; image_url: string | null; gallery_count: number }[] = []

  await Promise.all(
    inserted.map(async (ins, i) => {
      const result = claudeResults[i]
      const item = selected[result.source_id - 1]
      const row = rows[i]

      const [{ mainImg, gallery }, expandedBody] = await Promise.all([
        collectImages(result.title, item, result.category),
        apiKey ? expandBody(apiKey, row.title, item.site_name, row.summary || item.description) : Promise.resolve<string | null>(null),
      ])

      imageResults.push({ title: row.title, image_url: mainImg, gallery_count: gallery.length })

      await fetch(`${SURL}/rest/v1/trends?id=eq.${ins.id}`, {
        method: 'PATCH',
        headers: { ...sbHeaders, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
        body: JSON.stringify({
          image_url: mainImg,
          gallery_images: gallery,
          body: expandedBody || row.body || null,
        }),
      }).catch(e => log('patch_error', { id: ins.id, error: String(e) }))
    })
  )

  const elapsed = Date.now() - startedAt
  log('crawl_done', {
    trigger, elapsed_ms: elapsed,
    count: inserted.length,
    images: imageResults,
  })

  return NextResponse.json({
    success: true,
    count: inserted.length,
    elapsed_ms: elapsed,
    trends: imageResults,
    sources: {
      youtube: youtube.length,
      hn: hn.length,
      rss: selected.length - youtube.length - hn.length,
    },
    youtubeStatus: ytResult.status,
  })
}
