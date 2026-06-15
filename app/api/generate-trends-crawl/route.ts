import { NextRequest, NextResponse } from 'next/server'
import type { Category, GalleryImage, RelatedSource } from '@/lib/types'
import {
  fetchOgImage,
  fetchRelatedGalleryImages,
  fetchPexelsImages,
  searchYouTubeThumbnail,
  isValidImageUrl,
} from '@/lib/utils/og-image'

export const maxDuration = 60

// ── Logging ─────────────────────────────────────────────────────
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
  [['marketing', 'advertising', 'brand', 'campaign', 'commercial', 'promotion'], '광고'],
  [['beauty', 'makeup', 'skincare', 'cosmetic', 'haircare', 'nail', '뷰티', '화장'], '뷰티'],
]
const VALID_CATS = new Set<string>(['푸드', '뷰티', 'SNS', '패션', '테크', '라이프', '디자인', '광고', '영상'])
const CATEGORY_KEYWORD: Record<string, string> = {
  '테크': 'technology digital innovation',
  'SNS': 'social media smartphone app',
  '영상': 'video creative screen',
  '푸드': 'food restaurant meal',
  '패션': 'fashion style clothing',
  '라이프': 'lifestyle wellness',
  '디자인': 'design creative',
  '광고': 'advertising marketing',
  '뷰티': 'beauty cosmetics skincare',
}

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
      .filter(w => w.length > 2 && /[A-Z가-힣]/.test(w[0]))
      .map(w => w.replace(/[^a-zA-Z0-9가-힣]/g, ''))
      .filter(w => w.length > 1).slice(0, 5)
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
    if (!res.ok) return { items: [], status: `YouTube HTTP ${res.status}` }
    const data = await res.json()
    if (data.error) return { items: [], status: `YouTube 오류: ${data.error.message}` }
    const items = (data.items ?? []).map((item: {
      id: string; snippet: { title: string; description: string; channelTitle: string; categoryId: string; thumbnails: { maxres?: { url: string }; high?: { url: string }; medium?: { url: string } } }; statistics: { viewCount?: string }
    }) => ({
      title: item.snippet.title,
      description: (item.snippet.description ?? '').split('\n')[0].slice(0, 300),
      image_url: item.snippet.thumbnails?.maxres?.url ?? item.snippet.thumbnails?.high?.url ?? null,
      source_url: `https://www.youtube.com/watch?v=${item.id}`,
      site_name: item.snippet.channelTitle ?? 'YouTube',
      heat_score: calcHeatFromLog(parseInt(item.statistics?.viewCount ?? '0')),
      source: 'youtube' as const,
      yt_category_id: item.snippet.categoryId,
    }))
    return { items, status: `OK: ${items.length}개` }
  } catch (e) { return { items: [], status: `연결 오류: ${String(e).slice(0, 80)}` } }
}

// ── Hacker News ─────────────────────────────────────────────────
async function fetchHNTop(): Promise<CrawledItem[]> {
  try {
    const idsRes = await fetch('https://hacker-news.firebaseio.com/v0/topstories.json', { signal: AbortSignal.timeout(8000) })
    const ids: number[] = await idsRes.json()
    const items = await Promise.all(
      ids.slice(0, 30).map(async id => {
        try { return await (await fetch(`https://hacker-news.firebaseio.com/v0/item/${id}.json`, { signal: AbortSignal.timeout(4000) })).json() }
        catch { return null }
      })
    )
    return items
      .filter((item): item is NonNullable<typeof item> => item?.url && item.score >= 80 && item.title)
      .slice(0, 6)
      .map(item => {
        let siteName = 'Hacker News'
        try { siteName = new URL(item.url).hostname.replace(/^www\./, '') } catch {}
        return { title: item.title, description: `${item.score} pts`, image_url: null, source_url: item.url, site_name: siteName, heat_score: calcHeatFromLog(item.score, 45), source: 'hn' as const }
      })
  } catch { return [] }
}

// ── RSS ─────────────────────────────────────────────────────────
function cleanText(s: string) {
  return s.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ').trim()
}
function parseFeedXml(xml: string, siteName: string): Omit<CrawledItem, 'source'>[] {
  const isAtom = xml.includes('<feed')
  const results: Omit<CrawledItem, 'source'>[] = []
  for (const match of [...xml.matchAll(isAtom ? /<entry[^>]*>([\s\S]*?)<\/entry>/gi : /<item[^>]*>([\s\S]*?)<\/item>/gi)].slice(0, 6)) {
    const c = match[1]
    const title = cleanText(c.match(/<title[^>]*>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/i)?.[1] ?? '')
    if (!title) continue
    const link = isAtom ? (c.match(/<link[^>]+href=["']([^"']+)["']/i)?.[1] ?? '') : (c.match(/<link[^>]*>\s*([^\s<][^<]*)\s*<\/link>/i)?.[1]?.trim() ?? '')
    if (!link) continue
    const desc = cleanText((isAtom ? c.match(/<(?:summary|content)[^>]*>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/(?:summary|content)>/i)?.[1] : c.match(/<description[^>]*>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/description>/i)?.[1]) ?? '').slice(0, 300)
    const imgUrl = c.match(/<media:content[^>]+url=["']([^"']+)["'][^>]*medium=["']image["']/i)?.[1] ?? c.match(/<media:thumbnail[^>]+url=["']([^"']+)["']/i)?.[1] ?? null
    results.push({ title, description: desc, image_url: imgUrl, source_url: link, site_name: siteName, heat_score: 62 })
  }
  return results
}
async function fetchRSSFeed(url: string, siteName: string): Promise<CrawledItem[]> {
  try {
    const res = await fetch(url, { headers: { 'User-Agent': 'PikkBot/1.0 (+https://pikk.app)' }, signal: AbortSignal.timeout(8000) })
    if (!res.ok) return []
    return parseFeedXml(await res.text(), siteName).map(item => ({ ...item, source: 'rss' as const }))
  } catch { return [] }
}
async function fetchRedditHot(subreddit: string, minScore = 300): Promise<CrawledItem[]> {
  try {
    const res = await fetch(`https://www.reddit.com/r/${subreddit}/hot.json?limit=15`, { headers: { 'User-Agent': 'PikkBot/1.0', Accept: 'application/json' }, signal: AbortSignal.timeout(8000) })
    if (!res.ok) return []
    const data = await res.json()
    return (data?.data?.children ?? []).map((c: { data: Record<string, unknown> }) => c.data)
      .filter((p: Record<string, unknown>) => !p.over_18 && !p.stickied && p.url && Number(p.score) >= minScore)
      .slice(0, 4)
      .map((p: Record<string, unknown>) => ({ title: String(p.title ?? '').slice(0, 200), description: String(p.selftext ?? '').slice(0, 200), image_url: String(p.thumbnail ?? '').startsWith('http') ? String(p.thumbnail) : null, source_url: p.is_self ? `https://www.reddit.com${String(p.permalink)}` : String(p.url ?? ''), site_name: `r/${subreddit}`, heat_score: calcHeatFromLog(Number(p.score ?? 0), 45), source: 'rss' as const }))
  } catch { return [] }
}
async function fetchDevTo(): Promise<CrawledItem[]> {
  try {
    const res = await fetch('https://dev.to/api/articles?top=7&per_page=6', { headers: { 'User-Agent': 'PikkBot/1.0' }, signal: AbortSignal.timeout(8000) })
    if (!res.ok) return []
    const articles: Array<{ title: string; description: string; url: string; cover_image: string | null; public_reactions_count: number }> = await res.json()
    return articles.map(a => ({ title: a.title, description: a.description ?? '', image_url: a.cover_image, source_url: a.url, site_name: 'Dev.to', heat_score: calcHeatFromLog(a.public_reactions_count ?? 0, 50), source: 'rss' as const }))
  } catch { return [] }
}

// ── Dedup ───────────────────────────────────────────────────────
function normalize(s: string) { return s.toLowerCase().replace(/[^a-z0-9가-힣]/g, ' ').replace(/\s+/g, ' ').trim() }
function titleSimilarity(a: string, b: string): number {
  const na = normalize(a), nb = normalize(b)
  if (na === nb) return 1
  // 2자 이상 단어로 체크 (Korean short words 포함)
  const wa = new Set(na.split(' ').filter(w => w.length >= 2))
  const wb = new Set(nb.split(' ').filter(w => w.length >= 2))
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

// 최근 트렌드 대비 중복 체크 (50% 이상 겹치면 중복)
function isDuplicateTrend(
  newTitle: string,
  newTags: string[],
  recentTrends: { title: string; tags: string[] }[]
): boolean {
  const newTagSet = new Set(newTags.map(t => t.toLowerCase()))
  return recentTrends.some(rt => {
    if (titleSimilarity(rt.title, newTitle) >= 0.5) return true
    const rtTags = new Set(rt.tags.map(t => t.toLowerCase()))
    const tagOverlap = [...newTagSet].filter(t => rtTags.has(t)).length
    return tagOverlap >= 2 && newTagSet.size > 0
  })
}

// ── 이미지 수집 (모든 소스 병렬 실행) ───────────────────────────
function extractEnglishKeyword(claudeTitle: string, fallback: string): string {
  const fromClaude = (claudeTitle.match(/[A-Za-z][A-Za-z0-9 ]{1,}/g) ?? []).join(' ').trim()
  if (fromClaude.length > 2) return fromClaude.slice(0, 50)
  return fallback.replace(/[가-힣]/g, ' ').split(/\s+/).filter(w => w.length > 2 && /[A-Za-z]/.test(w)).slice(0, 3).join(' ').trim().slice(0, 50)
}

function titleTopicMatch(originalTitle: string, claudeTitle: string): boolean {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9가-힣]/g, ' ')
  const origWords = new Set(norm(originalTitle).split(/\s+/).filter(w => w.length >= 2))
  const claudeWords = new Set(norm(claudeTitle).split(/\s+/).filter(w => w.length >= 2))
  return [...origWords].some(w => claudeWords.has(w))
}

// 이미지 수집: 모든 소스를 병렬로 실행해 최선의 결과 선택
// → INSERT 이전에 호출됨 (PATCH 없음, 이미지 확정 후 단일 INSERT)
async function collectImages(
  claudeTitle: string,
  item: CrawledItem,
  category: string = '테크'
): Promise<{ mainImg: string | null; gallery: GalleryImage[] }> {
  const topicMatches = titleTopicMatch(item.title, claudeTitle)
  const engKeyword = extractEnglishKeyword(claudeTitle, item.title)
  const catKeyword = CATEGORY_KEYWORD[category] ?? 'trending news'

  // ① 모든 이미지 소스 동시 실행 (속도 최적화: 순차 X, 병렬 O)
  const [
    sourceOg,       // 소스 og:image (제목 일치 시)
    bingKo,         // Bing News 한국어
    bingEn,         // Bing News 영어
    ytSearch,       // YouTube 검색 썸네일
    pexelsKw,       // Pexels 키워드
    pexelsCat,      // Pexels 카테고리 (키워드 없을 때 보충)
  ] = await Promise.all([
    topicMatches && item.source !== 'youtube'
      ? fetchOgImage(item.source_url)
      : Promise.resolve<string | null>(null),
    fetchRelatedGalleryImages(claudeTitle, item.source_url, 4),
    engKeyword.length > 2
      ? fetchRelatedGalleryImages(engKeyword, item.source_url, 4)
      : Promise.resolve<GalleryImage[]>([]),
    searchYouTubeThumbnail(claudeTitle),
    engKeyword.length > 2
      ? fetchPexelsImages(engKeyword, 4)
      : Promise.resolve<GalleryImage[]>([]),
    fetchPexelsImages(catKeyword, 4),
  ])

  // YouTube 소스 썸네일 (제목 일치 시)
  const ytSourceThumb = (topicMatches && item.source === 'youtube')
    ? (() => { const vid = item.source_url.match(/[?&]v=([^&]+)/)?.[1]; return vid ? `https://img.youtube.com/vi/${vid}/maxresdefault.jpg` : null })()
    : null

  // ② 우선순위로 메인 이미지 결정
  const mainImg =
    sourceOg ??
    bingKo[0]?.url ??
    bingEn[0]?.url ??
    ytSourceThumb ??
    ytSearch ??
    pexelsKw[0]?.url ??
    pexelsCat[0]?.url ??
    null

  // ③ 갤러리 구성 (중복 없이 4개)
  const seenUrls = new Set<string>()
  const gallery: GalleryImage[] = []
  const addToGallery = (img: GalleryImage) => {
    if (!seenUrls.has(img.url) && gallery.length < 4) {
      seenUrls.add(img.url)
      gallery.push(img)
    }
  }

  if (sourceOg && topicMatches) {
    addToGallery({ url: sourceOg, source_url: item.source_url, site_name: item.site_name })
  }
  if (ytSourceThumb && topicMatches) {
    addToGallery({ url: ytSourceThumb, source_url: item.source_url, site_name: item.site_name })
  }
  for (const r of [...bingKo, ...bingEn]) addToGallery(r)
  if (ytSearch) addToGallery({ url: ytSearch, source_url: item.source_url, site_name: 'YouTube' })
  for (const p of [...pexelsKw, ...pexelsCat]) addToGallery(p)

  return { mainImg, gallery }
}

// ── Claude 저널리스트 ──────────────────────────────────────────
function makeJournalistPrompt(items: CrawledItem[], recentTitles: string[]): string {
  const list = items.map((item, i) => `${i + 1}. [${item.site_name}] ${item.title}`).join('\n')
  const recentBlock = recentTitles.length > 0
    ? `\n이미 발행됨 (선택 금지): ${recentTitles.slice(0, 15).join(' / ')}\n`
    : ''
  return `트렌드 에디터. 아래 ${items.length}개 중 핫한 10개를 골라 한국어 카드뉴스를 작성하세요.
JSON 배열만 출력. 마크다운·코드블록 없음. source_id는 1부터 시작.
모든 텍스트 필드는 매우 짧게 작성하세요(body 40자, 나머지 25자 이내).
${recentBlock}
[{"source_id":N,"title":"제목(15자)","summary":"요약(25자)","body":"본문(40자)","why_trending":"이유(25자)","who_affected":"대상(20자)","tags":["태그1","태그2","태그3","태그4","태그5"],"category":"테크|SNS|푸드|뷰티|패션|라이프|디자인|광고|영상 중 하나"}]

${list}`
}

// 본문 확장 (Haiku — 빠르고 비용 효율적)
async function expandBody(apiKey: string, title: string, siteName: string, description: string): Promise<string | null> {
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 600,
        messages: [{ role: 'user', content: `다음 트렌드에 대해 400-600자 한국어 기사 본문을 작성하세요.\n배경·왜 화제·글로벌 동향·한국 의미·전망 포함. 본문만 출력.\n\n트렌드: ${title}\n출처: ${siteName}${description ? `\n설명: ${description.slice(0, 150)}` : ''}` }],
      }),
      signal: AbortSignal.timeout(8000),
    })
    if (!res.ok) return null
    const data = await res.json()
    return (data.content?.[0]?.text as string | undefined)?.trim() ?? null
  } catch { return null }
}

async function generateWithClaude(items: CrawledItem[], recentTitles: string[]): Promise<{ results: ClaudeResult[], error?: string }> {
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) return { results: [], error: 'ANTHROPIC_API_KEY 미설정' }
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 2200,
        messages: [{ role: 'user', content: makeJournalistPrompt(items, recentTitles) }],
      }),
      signal: AbortSignal.timeout(38000),
    })
    if (!res.ok) return { results: [], error: `Claude HTTP ${res.status}: ${await res.text().catch(() => '')}`.slice(0, 200) }
    const data = await res.json()
    if (data.error) return { results: [], error: `Claude 오류: ${data.error.message}` }
    const text: string = data.content?.[0]?.text ?? ''
    const jsonMatch = text.match(/\[[\s\S]*\]/)
    if (!jsonMatch) return { results: [], error: `JSON 없음. 응답: ${text.slice(0, 200)}` }
    let parsed: Record<string, unknown>[]
    try { parsed = JSON.parse(jsonMatch[0]) } catch (e) { return { results: [], error: `JSON.parse 실패: ${e}` } }
    if (!Array.isArray(parsed)) return { results: [], error: '배열 아님' }
    const seen = new Set<number>()
    const results = parsed
      .filter(p => { const id = Number(p.source_id); if (!Number.isInteger(id) || id < 1 || id > items.length || seen.has(id)) return false; seen.add(id); return true })
      .slice(0, 10)
      .map(p => {
        const sid = Number(p.source_id), src = items[sid - 1]
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
    if (results.length === 0) return { results: [], error: `검증 실패. ${parsed.length}개 파싱, items: ${items.length}` }
    return { results }
  } catch (e) { return { results: [], error: `예외: ${e}` } }
}

// ── Cron ────────────────────────────────────────────────────────
export async function GET(req: NextRequest) {
  const secret = process.env.CRON_SECRET
  if (secret && req.headers.get('authorization') !== `Bearer ${secret}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  return runCrawl('cron')
}
export async function POST() { return runCrawl('manual') }

async function runCrawl(trigger: 'cron' | 'manual' = 'manual') {
  const t0 = Date.now()
  log('crawl_start', { trigger })

  const SURL = process.env.NEXT_PUBLIC_SUPABASE_URL!
  const SKEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  const sbHeaders = { apikey: SKEY, Authorization: `Bearer ${SKEY}` }
  const apiKey = process.env.ANTHROPIC_API_KEY

  // ── 1. Cron 중복 실행 방지 ──────────────────────────────────
  if (trigger === 'cron') {
    const since = new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString()
    const check = await fetch(`${SURL}/rest/v1/trends?published_at=gte.${encodeURIComponent(since)}&select=id&limit=1`, { headers: sbHeaders }).catch(() => null)
    if (check?.ok) {
      const existing = await check.json().catch(() => [])
      if (Array.isArray(existing) && existing.length > 0) {
        log('crawl_skip', { reason: '6h 내 트렌드 존재' })
        return NextResponse.json({ skipped: true })
      }
    }
  }

  // ── 2. 소스 수집 + 최근 7일 트렌드 병렬 조회 ─────────────────
  const since7d = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()
  const [
    ytResult, hn,
    techcrunch, verge, bbc, reuters, aljazeera, japantimes,
    producthunt, devto,
    mediumTech, mediumDesign, mediumBusiness, mediumCulture,
    redditWorld, redditTech, redditScience, redditBusiness, redditFashion, redditFood,
    recentRes,
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
    fetch(`${SURL}/rest/v1/trends?published_at=gte.${encodeURIComponent(since7d)}&select=title,tags&limit=50`, { headers: sbHeaders }).catch(() => null),
  ])

  const youtube = ytResult.items
  const recentTrends: { title: string; tags: string[] }[] = recentRes?.ok
    ? await recentRes.json().catch(() => [])
    : []
  const recentTitles = recentTrends.map(t => t.title)

  const combined = [
    ...youtube.slice(0, 4), ...hn.slice(0, 4),
    ...techcrunch.slice(0, 2), ...verge.slice(0, 2), ...bbc.slice(0, 2),
    ...reuters.slice(0, 2), ...aljazeera.slice(0, 2), ...japantimes.slice(0, 2),
    ...producthunt.slice(0, 2), ...devto.slice(0, 2),
    ...mediumTech.slice(0, 1), ...mediumDesign.slice(0, 1), ...mediumBusiness.slice(0, 1), ...mediumCulture.slice(0, 1),
    ...redditWorld.slice(0, 2), ...redditTech.slice(0, 2),
    ...redditScience.slice(0, 1), ...redditBusiness.slice(0, 1), ...redditFashion.slice(0, 1), ...redditFood.slice(0, 1),
  ]
  const selected = dedup(combined).slice(0, 30)
  log('sources', { total: selected.length, youtube: youtube.length, hn: hn.length, recent: recentTrends.length })

  if (selected.length === 0) {
    return NextResponse.json({ error: '소스 수집 실패' }, { status: 502 })
  }

  // ── 3. Claude 기사 생성 ────────────────────────────────────
  const { results: claudeResults, error: claudeError } = await generateWithClaude(selected, recentTitles)
  log('claude', { count: claudeResults.length, error: claudeError ?? null, elapsed: Date.now() - t0 })

  if (claudeResults.length === 0) {
    return NextResponse.json({ error: claudeError ?? 'Claude 실패', collected: selected.length }, { status: 500 })
  }

  // ── 4. 이미지 수집 + 본문 확장 병렬 실행 (INSERT 이전!) ───────
  // 핵심: 이미지를 먼저 확정하고 INSERT → 순서 불일치 버그 완전 제거
  const enriched = await Promise.all(
    claudeResults.map(async (result) => {
      const item = selected[result.source_id - 1]
      // 이미지 수집 & 본문 확장 동시 실행
      const [{ mainImg, gallery }, expandedBody] = await Promise.all([
        collectImages(result.title, item, result.category),
        apiKey ? expandBody(apiKey, result.title, item.site_name, result.summary || item.description) : Promise.resolve<string | null>(null),
      ])
      return { result, item, mainImg, gallery, expandedBody }
    })
  )

  // ── 5. 이미지 유효성 검증 (병렬 HEAD) ───────────────────────
  const validated = await Promise.all(
    enriched.map(async (e) => ({
      ...e,
      imageOk: e.mainImg ? await isValidImageUrl(e.mainImg) : false,
    }))
  )

  // ── 6. 필터: 이미지 없거나 중복이면 제외 ────────────────────
  const valid = validated.filter(e => {
    if (!e.imageOk) { log('skip_no_image', { title: e.result.title, mainImg: e.mainImg }); return false }
    if (isDuplicateTrend(e.result.title, e.result.tags, recentTrends)) { log('skip_duplicate', { title: e.result.title }); return false }
    return true
  })

  log('filter', { total: claudeResults.length, valid: valid.length, elapsed: Date.now() - t0 })

  if (valid.length === 0) {
    return NextResponse.json({ error: '유효한 트렌드 없음 (이미지 없거나 중복)', collected: selected.length }, { status: 500 })
  }

  // ── 7. 단일 INSERT (이미지+본문 포함) ────────────────────────
  // → PATCH 불필요, 순서 불일치 버그 없음
  const rows = valid.map(e => {
    const relatedSources: RelatedSource[] = [{ title: e.item.title, url: e.item.source_url, site_name: e.item.site_name }]
    return {
      title: e.result.title,
      summary: e.result.summary,
      original_title: e.item.title,
      body: e.expandedBody || e.result.body || null,
      why_trending: e.result.why_trending || null,
      who_affected: e.result.who_affected || null,
      heat_score: e.item.heat_score,
      category: e.result.category,
      tags: e.result.tags,
      source_url: e.item.source_url,
      related_sources: relatedSources,
      image_search_keyword: e.item.title.slice(0, 60),
      image_url: e.mainImg,
      gallery_images: e.gallery,
      published_at: new Date().toISOString(),
    }
  })

  const insertRes = await fetch(`${SURL}/rest/v1/trends`, {
    method: 'POST',
    headers: { ...sbHeaders, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
    body: JSON.stringify(rows),
  })
  if (!insertRes.ok) {
    const errText = await insertRes.text()
    log('insert_error', { status: insertRes.status, body: errText.slice(0, 200) })
    return NextResponse.json({ error: errText }, { status: 500 })
  }

  const elapsed = Date.now() - t0
  log('crawl_done', {
    trigger, elapsed_ms: elapsed, inserted: valid.length,
    trends: valid.map(e => ({ title: e.result.title, image_url: e.mainImg, gallery: e.gallery.length })),
  })

  return NextResponse.json({
    success: true,
    count: valid.length,
    elapsed_ms: elapsed,
    skipped: claudeResults.length - valid.length,
    trends: valid.map(e => ({ title: e.result.title, image_url: e.mainImg, gallery_count: e.gallery.length })),
    sources: { youtube: youtube.length, hn: hn.length, rss: selected.length - youtube.length - hn.length },
  })
}
