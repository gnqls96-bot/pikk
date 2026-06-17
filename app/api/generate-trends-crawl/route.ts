import { NextRequest, NextResponse } from 'next/server'
import type { Category, GalleryImage, RelatedSource } from '@/lib/types'
import {
  fetchOgImage,
  fetchArticleImages,
  sameSiteDomain,
  isValidTrendImage,
  isLowQualityImageUrl,
} from '@/lib/utils/og-image'

export const maxDuration = 300

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
  original_title: string
  title: string
  summary: string
  heat_score: number
  why_trending: string
  who_affected: string
  tags: string[]
  category: Category
}

// ── Category mapping ────────────────────────────────────────────
const YT_CATEGORY_MAP: Record<string, Category> = {
  '1': '엔터', '10': 'KPOP', '20': '라이프', '22': 'SNS', '23': 'SNS',
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
  [['K-pop', 'kpop', 'K드라마', '한류', 'hallyu', '아이돌', 'idol', 'BTS', 'Blackpink',
    'Twice', '케이팝', 'girl group', 'boy band', 'Soompi', 'koreaboo',
    '뮤직', '노래', '아이유', '뉴진스', 'NewJeans', 'aespa', 'STAYC'], 'KPOP'],
  [['YouTube', 'video', 'film', 'movie', 'streaming', 'Netflix', 'Disney',
    'animation', '유튜브', '영상', '드라마', 'celebrity', 'entertainment',
    'Variety', 'Deadline', 'Hollywood', 'series', 'episode'], '엔터'],
  [['food', 'restaurant', 'recipe', 'eating', 'coffee', 'drink', 'meal', 'cuisine',
    'pizza', 'sushi', 'chocolate', 'chef'], '푸드'],
  [['fashion', 'style', 'clothing', 'outfit', 'brand', 'luxury', 'shoes', 'dress',
    'runway', 'couture', 'streetwear'], '패션'],
  [['health', 'wellness', 'fitness', 'workout', 'sleep', 'mental', 'exercise', 'yoga',
    'nutrition', 'diet', 'meditation'], '라이프'],
  [['design', 'graphic', 'UI', 'UX', 'logo', 'typography', 'visual', 'illustration',
    'Figma', 'creative'], '디자인'],
  [['beauty', 'makeup', 'skincare', 'cosmetic', 'haircare', 'nail', '뷰티', '화장'], '뷰티'],
]
const VALID_CATS = new Set<string>(['푸드', '뷰티', 'SNS', '패션', '테크', '라이프', '디자인', 'KPOP', '엔터'])
const CATEGORY_KEYWORD: Record<string, string> = {
  '테크': 'technology digital innovation',
  'SNS': 'social media smartphone app',
  'KPOP': 'kpop korean music idol',
  '엔터': 'entertainment film streaming',
  '푸드': 'food restaurant meal',
  '패션': 'fashion style clothing',
  '라이프': 'lifestyle wellness',
  '디자인': 'design creative',
  '뷰티': 'beauty cosmetics skincare',
}
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const _CATEGORY_KEYWORD = CATEGORY_KEYWORD  // keep for future use

const ALL_CATS: Category[] = ['푸드', '뷰티', 'SNS', '패션', '테크', '라이프', '디자인', 'KPOP', '엔터']

// ─── 카테고리별 RSS 소스 풀 (카테고리당 4~5개로 확장 — fetch 실패 시 대체 후보 확보) ───
const CAT_RSS_SOURCES: Array<{ cat: Category; url: string; name: string }> = [
  // 푸드
  { cat: '푸드', url: 'https://www.eater.com/rss/index.xml',         name: 'Eater' },
  { cat: '푸드', url: 'https://www.seriouseats.com/atom.xml',         name: 'Serious Eats' },
  { cat: '푸드', url: 'https://www.bonappetit.com/feed/rss',          name: 'Bon Appétit' },
  { cat: '푸드', url: 'https://www.foodandwine.com/rss',              name: 'Food & Wine' },
  { cat: '푸드', url: 'https://www.tastingtable.com/feed',            name: 'Tasting Table' },
  // 뷰티
  { cat: '뷰티', url: 'https://www.allure.com/feed/rss',              name: 'Allure' },
  { cat: '뷰티', url: 'https://www.byrdie.com/rss',                   name: 'Byrdie' },
  { cat: '뷰티', url: 'https://wwd.com/beauty-industry-news/feed/',   name: 'WWD Beauty' },
  { cat: '뷰티', url: 'https://www.refinery29.com/en-us/beauty/rss.xml', name: 'Refinery29 Beauty' },
  { cat: '뷰티', url: 'https://www.glamour.com/beauty/rss',           name: 'Glamour Beauty' },
  // 패션
  { cat: '패션', url: 'https://www.vogue.com/feed/rss',               name: 'Vogue' },
  { cat: '패션', url: 'https://wwd.com/feed/',                        name: 'WWD' },
  { cat: '패션', url: 'https://hypebeast.com/feed',                   name: 'Hypebeast' },
  { cat: '패션', url: 'https://www.elle.com/fashion/rss/',            name: 'Elle Fashion' },
  { cat: '패션', url: 'https://www.harpersbazaar.com/fashion/rss/',   name: 'Harper\'s Bazaar' },
  // 테크 (Cloudflare 많음 — 소스 다양화)
  { cat: '테크', url: 'https://techcrunch.com/feed/',                 name: 'TechCrunch' },
  { cat: '테크', url: 'https://www.theverge.com/rss/index.xml',       name: 'The Verge' },
  { cat: '테크', url: 'https://www.wired.com/feed/rss',               name: 'Wired' },
  { cat: '테크', url: 'https://feeds.arstechnica.com/arstechnica/index', name: 'Ars Technica' },
  { cat: '테크', url: 'https://www.technologyreview.com/topnews.rss', name: 'MIT Tech Review' },
  // 라이프
  { cat: '라이프', url: 'https://lifehacker.com/rss',                 name: 'Lifehacker' },
  { cat: '라이프', url: 'https://www.wellandgood.com/feed/',           name: 'Well+Good' },
  { cat: '라이프', url: 'https://www.self.com/feed/rss',              name: 'Self' },
  { cat: '라이프', url: 'https://www.menshealth.com/rss/all.xml/',    name: 'Men\'s Health' },
  { cat: '라이프', url: 'https://www.mindbodygreen.com/rss',          name: 'MindBodyGreen' },
  // 디자인 (Dezeen = Cloudflare 차단 가능 — 대체 소스 확보)
  { cat: '디자인', url: 'https://www.dezeen.com/feed/',               name: 'Dezeen' },
  { cat: '디자인', url: 'https://design-milk.com/feed/',              name: 'Design Milk' },
  { cat: '디자인', url: 'https://www.itsnicethat.com/rss',            name: 'It\'s Nice That' },
  { cat: '디자인', url: 'https://www.fastcompany.com/co-design/rss',  name: 'Co.Design' },
  { cat: '디자인', url: 'https://www.creativebloq.com/rss',           name: 'Creative Bloq' },
  // KPOP
  { cat: 'KPOP', url: 'https://www.soompi.com/feed/',                 name: 'Soompi' },
  { cat: 'KPOP', url: 'https://www.allkpop.com/feed/',                name: 'Allkpop' },
  { cat: 'KPOP', url: 'https://www.koreaboo.com/feed/',               name: 'Koreaboo' },
  { cat: 'KPOP', url: 'https://www.nme.com/tags/k-pop/rss/',          name: 'NME KPOP' },
  // 엔터
  { cat: '엔터', url: 'https://variety.com/feed/',                    name: 'Variety' },
  { cat: '엔터', url: 'https://deadline.com/feed/',                   name: 'Deadline' },
  { cat: '엔터', url: 'https://www.hollywoodreporter.com/feed/',      name: 'Hollywood Reporter' },
  { cat: '엔터', url: 'https://www.indiewire.com/feed/',              name: 'IndieWire' },
  { cat: '엔터', url: 'https://collider.com/feed/',                   name: 'Collider' },
  // SNS (기존 Reddit 전용 → RSS 소스 추가)
  { cat: 'SNS', url: 'https://www.socialmediatoday.com/rss/1.0/',     name: 'Social Media Today' },
  { cat: 'SNS', url: 'https://mashable.com/feeds/rss/all',            name: 'Mashable' },
  { cat: 'SNS', url: 'https://digiday.com/feed/',                     name: 'Digiday' },
]

const CAT_REDDIT_SOURCES: Array<{ cat: Category; subreddit: string; minScore: number }> = [
  { cat: '푸드',  subreddit: 'food',               minScore: 200 },
  { cat: 'SNS',   subreddit: 'OutOfTheLoop',       minScore: 300 },
  { cat: 'SNS',   subreddit: 'socialmedia',        minScore: 30 },
  { cat: '테크',  subreddit: 'technology',          minScore: 500 },
  { cat: '라이프', subreddit: 'selfimprovement',    minScore: 100 },
  { cat: 'KPOP',  subreddit: 'kpop',               minScore: 300 },
  { cat: '엔터',  subreddit: 'entertainment',       minScore: 200 },
  { cat: '패션',  subreddit: 'femalefashionadvice', minScore: 100 },
]

const YT_CAT_MAP: Record<string, Category> = {
  '1': '엔터', '10': 'KPOP', '23': 'SNS', '24': 'SNS',
  '22': 'SNS', '26': '뷰티', '28': '테크',
  '2': '라이프', '15': '라이프', '17': '라이프', '19': '라이프',
  '20': '라이프', '25': '라이프', '27': '라이프', '29': '라이프',
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

function ensureMinTags(tags: string[], fallbackTitle: string, min = 5, max = 7): string[] {
  const result = [...new Set(tags.filter(Boolean))]
  if (result.length >= min) return result.slice(0, max)
  for (const t of extractTags(fallbackTitle)) {
    if (result.length >= min) break
    if (!result.includes(t)) result.push(t)
  }
  return result.slice(0, max)
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

function rssFreshnessScore(pubDateStr: string): number {
  if (!pubDateStr) return 52
  try {
    const ageHours = (Date.now() - new Date(pubDateStr).getTime()) / 3600000
    if (isNaN(ageHours) || ageHours < 0) return 52
    if (ageHours < 2) return 80
    if (ageHours < 6) return 73
    if (ageHours < 12) return 67
    if (ageHours < 24) return 60
    if (ageHours < 48) return 53
    return 46
  } catch { return 52 }
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
    // RSS 자체 media 태그 이미지 우선 (발행처가 직접 명시)
    const imgUrl =
      c.match(/<media:content[^>]+url=["']([^"']+)["'][^>]*medium=["']image["']/i)?.[1] ??
      c.match(/<media:thumbnail[^>]+url=["']([^"']+)["']/i)?.[1] ??
      c.match(/<enclosure[^>]+url=["']([^"']+)["'][^>]*type=["']image\/[^"']*["']/i)?.[1] ??
      c.match(/<enclosure[^>]+type=["']image\/[^"']*["'][^>]*url=["']([^"']+)["']/i)?.[1] ??
      null
    const pubDate = cleanText(
      c.match(/<pubDate[^>]*>([\s\S]*?)<\/pubDate>/i)?.[1] ??
      c.match(/<updated[^>]*>([\s\S]*?)<\/updated>/i)?.[1] ??
      c.match(/<published[^>]*>([\s\S]*?)<\/published>/i)?.[1] ?? ''
    )
    results.push({ title, description: desc, image_url: imgUrl, source_url: link, site_name: siteName, heat_score: rssFreshnessScore(pubDate) })
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

// ── Dedup ───────────────────────────────────────────────────────
function normalize(s: string) { return s.toLowerCase().replace(/[^a-z0-9가-힣]/g, ' ').replace(/\s+/g, ' ').trim() }
function titleSimilarity(a: string, b: string): number {
  const na = normalize(a), nb = normalize(b)
  if (na === nb) return 1
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
function isDuplicateTrend(newTitle: string, newTags: string[], recentTrends: { title: string; tags: string[] }[]): boolean {
  const newTagSet = new Set(newTags.map(t => t.toLowerCase()))
  return recentTrends.some(rt => {
    if (titleSimilarity(rt.title, newTitle) >= 0.5) return true
    const rtTags = new Set(rt.tags.map(t => t.toLowerCase()))
    const tagOverlap = [...newTagSet].filter(t => rtTags.has(t)).length
    return tagOverlap >= 2 && newTagSet.size > 0
  })
}

// ══════════════════════════════════════════════════════════════════
//  NEW: 실제 기사 본문 페치
//  - Cloudflare/봇 차단 감지 → { ok: false }
//  - 본문 300자 미만 → { ok: false }
//  - YouTube SPA는 fetch 불가 → 즉시 { ok: false }
// ══════════════════════════════════════════════════════════════════
async function fetchArticleText(url: string): Promise<{ text: string; ok: boolean }> {
  if (url.includes('youtube.com') || url.includes('youtu.be') || url.includes('reddit.com')) {
    return { text: '', ok: false }
  }
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
        Accept: 'text/html,application/xhtml+xml',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      signal: AbortSignal.timeout(9000),
      redirect: 'follow',
    })
    if (!res.ok) return { text: '', ok: false }
    const html = await res.text()

    // Cloudflare/봇 챌린지 감지
    if (
      html.length < 15000 && (
        html.includes('Just a moment') ||
        html.includes('cf-browser-verification') ||
        html.includes('challenge-platform') ||
        html.includes('Enable JavaScript and cookies') ||
        html.includes('Checking your browser')
      )
    ) {
      return { text: '', ok: false }
    }

    // 본문 영역 추출: <article> → <main> → 전체 순
    let scope = html
    const articleMatch = html.match(/<article[^>]*>([\s\S]*?)<\/article>/i)
    if (articleMatch) {
      scope = articleMatch[1]
    } else {
      const mainMatch = html.match(/<main[^>]*>([\s\S]*?)<\/main>/i)
      if (mainMatch) scope = mainMatch[1]
    }

    // 노이즈 제거
    const cleaned = scope
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
      .replace(/<nav[^>]*>[\s\S]*?<\/nav>/gi, '')
      .replace(/<footer[^>]*>[\s\S]*?<\/footer>/gi, '')
      .replace(/<header[^>]*>[\s\S]*?<\/header>/gi, '')
      .replace(/<aside[^>]*>[\s\S]*?<\/aside>/gi, '')
      .replace(/<figure[^>]*>[\s\S]*?<\/figure>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()

    if (cleaned.length < 300) return { text: '', ok: false }
    return { text: cleaned.slice(0, 3000), ok: true }
  } catch {
    return { text: '', ok: false }
  }
}

// ── Claude 선택 프롬프트 ─────────────────────────────────────────
function makeCategoryJournalistPrompt(
  catGroups: Map<Category, CrawledItem[]>,
  selected: CrawledItem[],
  recentTitles: string[]
): string {
  const recentBlock = recentTitles.length > 0
    ? `이미 발행됨 (선택 금지): ${recentTitles.slice(0, 20).join(' / ')}\n\n`
    : ''

  let sections = ''
  let globalId = 1
  for (const cat of ALL_CATS) {
    const items = catGroups.get(cat) ?? []
    if (items.length === 0) continue
    sections += `\n=== ${cat} ===\n`
    for (const item of items) {
      sections += `${globalId}. [${item.site_name}] ${item.title}\n`
      globalId++
    }
  }

  return `당신은 트렌드 에디터입니다. 아래 9개 카테고리에서 각 1개씩 선택하여 총 9개 출력하세요.

${recentBlock}필수 규칙:
- 반드시 9개 출력 (카테고리당 정확히 1개)
- 같은 카테고리 2개 선택 절대 금지
- 출력은 유효한 JSON이어야 함: 문자열 값 안에 줄바꿈 절대 금지
- 문자열 값 안에서 큰따옴표(") 사용 금지
- original_title: 해당 source_id 번호의 소스 제목(영어)을 번역 없이 그대로 복사
- title: 한국어 훅 제목 20자 이내
- heat_score: 40~99, 트렌드마다 반드시 다른 값
- why_trending: 왜 지금 뜨는지 3문장 이상, 구체적 수치·사례 포함 (120자 이상)
- who_affected: 어떤 업계·소비자층이 주목하는지 (60자 이상)
- tags: 정확히 5개 이상 (최대 7개)
- summary: 한 줄 티저 (60자 이내, 참고용 — 발행 본문은 원문 기반으로 별도 생성)

형식 (JSON 배열, 마크다운 없음):
[{"source_id":N,"category":"카테고리명","original_title":"영어원본그대로","title":"한국어훅제목","summary":"한줄티저60자이내","heat_score":40~99,"why_trending":"3문장이상","who_affected":"60자이상","tags":["태그1","태그2","태그3","태그4","태그5"]}]
${sections}`
}

function parseClaudeJsonArray(text: string): { parsed: Record<string, unknown>[] | null; raw: string | null; error?: string } {
  const jsonMatch = text.match(/\[[\s\S]*\]/)
  if (!jsonMatch) return { parsed: null, raw: null }
  const raw = jsonMatch[0]
  try {
    const parsed = JSON.parse(raw)
    return { parsed: Array.isArray(parsed) ? parsed : null, raw }
  } catch {}
  let repaired = ''
  try {
    let inString = false, escaped = false
    for (const ch of raw) {
      if (inString) {
        if (escaped) { repaired += ch; escaped = false; continue }
        if (ch === '\\') { repaired += ch; escaped = true; continue }
        if (ch === '"') { inString = false; repaired += ch; continue }
        if (ch === '\n') { repaired += '\\n'; continue }
        if (ch === '\r') { continue }
        if (ch === '\t') { repaired += ' '; continue }
        repaired += ch; continue
      }
      if (ch === '"') inString = true
      repaired += ch
    }
    const parsed = JSON.parse(repaired)
    return { parsed: Array.isArray(parsed) ? parsed : null, raw }
  } catch (e) {
    return { parsed: null, raw: repaired || raw, error: String(e) }
  }
}

async function generateWithClaude(
  catGroups: Map<Category, CrawledItem[]>,
  recentTitles: string[]
): Promise<{ results: ClaudeResult[]; selected: CrawledItem[]; error?: string }> {
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) return { results: [], selected: [], error: 'ANTHROPIC_API_KEY 미설정' }

  const selected: CrawledItem[] = []
  for (const cat of ALL_CATS) {
    selected.push(...(catGroups.get(cat) ?? []))
  }

  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 8000,
        messages: [{ role: 'user', content: makeCategoryJournalistPrompt(catGroups, selected, recentTitles) }],
      }),
      signal: AbortSignal.timeout(100000),
    })
    if (!res.ok) return { results: [], selected, error: `Claude HTTP ${res.status}` }
    const data = await res.json()
    if (data.error) return { results: [], selected, error: `Claude 오류: ${data.error.message}` }
    const text: string = data.content?.[0]?.text ?? ''
    const { parsed, raw, error: parseError } = parseClaudeJsonArray(text)
    if (!parsed) {
      const body = raw ?? text
      const pos = Number(parseError?.match(/position (\d+)/)?.[1] ?? -1)
      const around = pos >= 0 ? body.slice(Math.max(0, pos - 300), pos + 300) : body.slice(0, 4000)
      log('claude_parse_fail', { parseError, len: body.length, pos, around })
      return { results: [], selected, error: `JSON 파싱 실패` }
    }

    const seenSourceIds = new Set<number>()
    const seenCats = new Set<string>()
    const results = parsed
      .filter(p => {
        const id = Number(p.source_id)
        const cat = String(p.category ?? '')
        if (!Number.isInteger(id) || id < 1 || id > selected.length) return false
        if (seenSourceIds.has(id)) return false
        if (!VALID_CATS.has(cat) || seenCats.has(cat)) return false
        seenSourceIds.add(id); seenCats.add(cat)
        return true
      })
      .slice(0, 9)
      .map(p => {
        const sid = Number(p.source_id), src = selected[sid - 1]
        const originalTitle = String(p.original_title ?? '').trim() || (src?.title ?? '')
        const rawHeat = Number(p.heat_score)
        const heatScore = Number.isInteger(rawHeat) && rawHeat >= 40 && rawHeat <= 99
          ? rawHeat : (src?.heat_score ?? 60)
        return {
          source_id: sid,
          original_title: originalTitle.slice(0, 300),
          title: String(p.title ?? '').slice(0, 80),
          summary: String(p.summary ?? '').slice(0, 200),
          heat_score: heatScore,
          why_trending: String(p.why_trending ?? '').slice(0, 500),
          who_affected: String(p.who_affected ?? '').slice(0, 300),
          tags: ensureMinTags(Array.isArray(p.tags) ? (p.tags as unknown[]).map(String) : [], src?.title ?? originalTitle),
          category: String(p.category) as Category,
        }
      })
    if (results.length === 0) return { results: [], selected, error: `검증 실패` }
    return { results, selected }
  } catch (e) { return { results: [], selected: [], error: `예외: ${e}` } }
}

// ══════════════════════════════════════════════════════════════════
//  NEW: 실제 기사 본문 기반 본문 + 핵심 요약 생성
//  - articleText: fetchArticleText()로 가져온 실제 기사 내용 (최대 3000자)
//  - koreanTitle: Claude 선택 단계의 한국어 제목 (있으면 우선 사용)
//  - 출력: TITLE / SUMMARY / BODY 섹션으로 구분
// ══════════════════════════════════════════════════════════════════
async function generateBodyAndSummary(
  apiKey: string,
  opts: {
    engTitle: string
    koreanTitle: string | null
    siteName: string
    category: string
    articleText: string
    description: string
  }
): Promise<{ finalTitle: string; summary: string; body: string; tags: string[] }> {
  const sourceContent = opts.articleText.trim() || opts.description.trim()
  const titleInstruction = opts.koreanTitle
    ? `제목은 아래 것을 그대로 사용: "${opts.koreanTitle}"`
    : `원문 제목(${opts.engTitle})을 바탕으로 독자 흥미를 끄는 한국어 제목 작성 (20자 이내, 훅 있게)`

  const prompt = `당신은 구독료를 내고 읽는 프리미엄 트렌드 매거진의 수석 저널리스트입니다.
아래 원문 기사를 기반으로 한국 독자를 위한 트렌드 기사를 작성하세요.

원문 정보:
- 제목(원어): ${opts.engTitle}
- 출처: ${opts.siteName}
- 카테고리: ${opts.category}
- 원문 내용 (반드시 이 내용에 기반해 작성 — 원문에 없는 내용 창작 금지):
${sourceContent.slice(0, 2500)}

---
[제목]
${titleInstruction}

[핵심 요약] — 반드시 2~3줄, 각 줄은 \\n으로 구분
• 1줄: 무슨 일인지 — 원문의 구체적 수치/브랜드명/인물명 포함. "최근 들어", "주목할 만한" 같은 클리셰 금지. 제목 단순 재진술 금지.
• 2줄: 왜 지금 화제인지 — 트렌드 배경·맥락·이유
• 3줄: 원문에서만 찾을 수 있는 구체적 디테일 하나 (수치, 사례, 인용 등)

[본문] — 1000자 이상 필수
1. 도입: 독자가 멈추게 만드는 훅 문장 (클리셰 완전 금지)
2. 배경: 이 사건/트렌드가 생겨난 맥락과 역사적 흐름
3. 핵심 사실: 원문의 수치·기업명·인물명·날짜를 정확히 인용
4. 한국 연결: 한국 시장/소비자에게 이것이 왜 중요한지
5. 전망: 시사점 또는 앞으로의 전개로 마무리 (요약 반복 금지)

[태그]: 트렌드 핵심 키워드 5~7개

[출력 형식 — 반드시 이 구조 그대로, 마크다운 헤더(#) 없이]
===TITLE===
(한국어 제목)
===SUMMARY===
(핵심 요약 2~3줄)
===BODY===
(본문 1000자 이상)
===TAGS===
태그1,태그2,태그3,태그4,태그5`

  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 2800,
        messages: [{ role: 'user', content: prompt }],
      }),
      signal: AbortSignal.timeout(60000),
    })
    const empty = { finalTitle: opts.koreanTitle ?? opts.engTitle, summary: '', body: '', tags: [] }
    if (!res.ok) return empty
    const data = await res.json()
    const text: string = data.content?.[0]?.text ?? ''

    const titleMatch   = text.match(/===TITLE===\s*([\s\S]*?)===SUMMARY===/)
    const summaryMatch = text.match(/===SUMMARY===\s*([\s\S]*?)===BODY===/)
    const bodyMatch    = text.match(/===BODY===\s*([\s\S]*?)(?:===TAGS===|$)/)
    const tagsMatch    = text.match(/===TAGS===\s*([\s\S]*)$/)

    const generatedTitle = titleMatch?.[1]?.trim() ?? ''
    const finalTitle = (opts.koreanTitle || generatedTitle || opts.engTitle).slice(0, 80)
    const summary    = summaryMatch?.[1]?.trim() ?? ''
    const body       = bodyMatch?.[1]?.trim() ?? ''
    const tags       = (tagsMatch?.[1]?.trim() ?? '').split(',').map(t => t.trim()).filter(Boolean).slice(0, 7)

    return { finalTitle, summary, body, tags }
  } catch {
    return { finalTitle: opts.koreanTitle ?? opts.engTitle, summary: '', body: '', tags: [] }
  }
}

// ╔══════════════════════════════════════════════════════════════════════╗
// ║  이미지 수집 원칙 — 영구 고정 (2026-06-16 v2)                           ║
// ║  1순위: RSS media 태그 이미지 (발행처 직접 명시)                          ║
// ║  2순위: og:image (sameSiteDomain 통과한 것만)                           ║
// ║  갤러리: 같은 기사 페이지 본문 <img>만 (다른 기사 검색 금지)               ║
// ║  YouTube: 해당 영상 자체 썸네일만 허용                                   ║
// ║  이미지 없으면 → mainImg=null (발행 불가)                                ║
// ╚══════════════════════════════════════════════════════════════════════╝
async function collectImages(
  claudeTitle: string,
  item: CrawledItem,
): Promise<{ mainImg: string | null; gallery: GalleryImage[] }> {
  let mainImg: string | null = null

  // 1순위: RSS 자체 태그 이미지
  if (item.image_url && !isLowQualityImageUrl(item.image_url) && await isValidTrendImage(item.image_url)) {
    mainImg = item.image_url
  } else {
    // 2순위: og:image (도메인 일치 + 품질 검증)
    const og = await fetchOgImage(item.source_url)
    if (og && sameSiteDomain(og, item.source_url) && !isLowQualityImageUrl(og) && await isValidTrendImage(og)) {
      mainImg = og
    }
  }

  // 갤러리: 반드시 같은 기사 페이지에서만 (다른 기사 검색 금지)
  const articleImages = await fetchArticleImages(item.source_url, 5)
  const seenUrls = new Set<string>(mainImg ? [mainImg] : [])
  const gallery: GalleryImage[] = []
  for (const img of articleImages) {
    if (isLowQualityImageUrl(img.url) || seenUrls.has(img.url)) continue
    seenUrls.add(img.url)
    gallery.push(img)
    if (gallery.length >= 4) break
  }

  // 메인 없으면 갤러리 첫 장 승격
  if (!mainImg && gallery.length > 0) {
    mainImg = gallery.shift()!.url
  }

  // YouTube 썸네일 (마지막 수단 — 해당 영상 자체)
  if (!mainImg) {
    const ytVid = item.source_url.match(/[?&]v=([^&]+)/)?.[1]
      ?? item.source_url.match(/youtu\.be\/([^?]+)/)?.[1]
    const ytThumb = ytVid ? `https://img.youtube.com/vi/${ytVid}/maxresdefault.jpg` : null
    if (ytThumb && !isLowQualityImageUrl(ytThumb) && await isValidTrendImage(ytThumb)) {
      mainImg = ytThumb
    }
  }

  if (!mainImg) {
    log('no_image', { title: claudeTitle, source: item.source_url })
    return { mainImg: null, gallery: [] }
  }
  return { mainImg, gallery }
}

// ══════════════════════════════════════════════════════════════════
//  NEW: 발행 전 최종 5단계 검증
// ══════════════════════════════════════════════════════════════════
function validatePublishable(
  title: string,
  summary: string,
  body: string,
  mainImg: string | null,
  category: string,
  recentTrends: { title: string; tags: string[] }[],
  tags: string[]
): { ok: boolean; reason?: string } {
  // 1. 본문 길이 1000자 이상
  if (body.length < 1000) return { ok: false, reason: `본문 ${body.length}자 미달` }

  // 2. 핵심 요약 존재 여부
  if (!summary || summary.length < 20) return { ok: false, reason: '요약 없음 또는 너무 짧음' }

  // 3. 요약-본문 키워드 최소 3개 공통 (내용 일치 검증)
  const bodyWords = new Set(
    body.replace(/[^가-힣a-zA-Z0-9]/g, ' ').split(/\s+/).filter(w => w.length >= 2)
  )
  const summaryWords = summary.replace(/[^가-힣a-zA-Z0-9]/g, ' ').split(/\s+/).filter(w => w.length >= 2)
  const overlap = summaryWords.filter(w => bodyWords.has(w)).length
  if (overlap < 3) return { ok: false, reason: `요약-본문 키워드 불일치 (공통 단어 ${overlap}개)` }

  // 4. 메인 이미지 필수
  if (!mainImg) return { ok: false, reason: '메인 이미지 없음' }

  // 5. 7일 내 중복 토픽
  if (isDuplicateTrend(title, tags, recentTrends)) return { ok: false, reason: '7일 내 중복 토픽' }

  // 6. 유효한 카테고리
  if (!VALID_CATS.has(category)) return { ok: false, reason: `유효하지 않은 카테고리: ${category}` }

  return { ok: true }
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

// ╔══════════════════════════════════════════════════════════════════╗
// ║  데이터 보호 원칙 — 영구 고정                                        ║
// ║  이 함수는 절대 DELETE를 호출하지 않는다. INSERT만 한다.               ║
// ║  기존 트렌드 삭제는 반드시 /api/admin/* 를 사람이 직접 호출해야 한다.   ║
// ╚══════════════════════════════════════════════════════════════════╝
async function runCrawl(trigger: 'cron' | 'manual' = 'manual') {
  const t0 = Date.now()
  log('crawl_start', { trigger })

  const SURL = process.env.NEXT_PUBLIC_SUPABASE_URL!
  const SKEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  const sbHeaders = { apikey: SKEY, Authorization: `Bearer ${SKEY}` }
  const apiKey = process.env.ANTHROPIC_API_KEY ?? ''

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

  // ── 2. 소스 수집 (병렬) ─────────────────────────────────────
  const since7d = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()
  const [ytResult, hnItems, recentRes, ...catFetchResults] = await Promise.all([
    fetchYouTubeTrending(),
    fetchHNTop(),
    fetch(`${SURL}/rest/v1/trends?published_at=gte.${encodeURIComponent(since7d)}&select=title,tags&limit=50`, { headers: sbHeaders }).catch(() => null),
    ...CAT_RSS_SOURCES.map(s => fetchRSSFeed(s.url, s.name).then(items => ({ cat: s.cat, items }))),
    ...CAT_REDDIT_SOURCES.map(s => fetchRedditHot(s.subreddit, s.minScore).then(items => ({ cat: s.cat, items }))),
  ])

  const recentTrends: { title: string; tags: string[] }[] = recentRes?.ok
    ? await recentRes.json().catch(() => []) : []
  const recentTitles = recentTrends.map(t => t.title)

  // RSS/Reddit 먼저, YouTube는 마지막에 (낮은 우선순위 — fetch 불가)
  const catGroups = new Map<Category, CrawledItem[]>()
  for (const cat of ALL_CATS) catGroups.set(cat, [])

  for (const item of hnItems) catGroups.get('테크')!.push(item)
  for (const { cat, items } of catFetchResults as Array<{ cat: Category; items: CrawledItem[] }>) {
    catGroups.get(cat)?.push(...items)
  }
  // YouTube → 각 카테고리 후미에 추가 (fetch 불가 fallback용)
  for (const item of ytResult.items) {
    const cat: Category = (item.yt_category_id && YT_CAT_MAP[item.yt_category_id])
      ? YT_CAT_MAP[item.yt_category_id]
      : mapCategory(item.title, item.yt_category_id)
    catGroups.get(cat)?.push(item)
  }

  // 카테고리 내 중복 제거, 최대 8개 (폴백 후보 확보)
  for (const [cat, items] of catGroups) {
    catGroups.set(cat, dedup(items).slice(0, 8))
  }

  log('sources', {
    total: [...catGroups.values()].reduce((s, v) => s + v.length, 0),
    youtube: ytResult.items.length, hn: hnItems.length, recent: recentTrends.length,
    byCat: Object.fromEntries(ALL_CATS.map(c => [c, catGroups.get(c)?.length ?? 0])),
  })

  // ── 3. Claude 선택 (카테고리당 1개) ─────────────────────────
  const { results: claudeResults, selected, error: claudeError } = await generateWithClaude(catGroups, recentTitles)
  log('claude', { count: claudeResults.length, error: claudeError ?? null, elapsed: Date.now() - t0 })
  if (claudeResults.length === 0) {
    return NextResponse.json({ error: claudeError ?? 'Claude 실패' }, { status: 500 })
  }

  // Claude 선택 결과를 카테고리별로 정리
  const catToPrimary = new Map<Category, { result: ClaudeResult; item: CrawledItem }>()
  for (const result of claudeResults) {
    catToPrimary.set(result.category, { result, item: selected[result.source_id - 1] })
  }

  // ── 4. 기사 본문 페치 + 카테고리 폴백 ──────────────────────
  // Phase A: 1차 선택 병렬 페치
  const primaryFetches = await Promise.all(
    ALL_CATS.map(async (cat) => {
      const primary = catToPrimary.get(cat)
      if (!primary) return { cat, primary: null, text: '', ok: false }
      const { text, ok } = await fetchArticleText(primary.item.source_url)
      return { cat, primary, text, ok }
    })
  )

  // Phase B: 실패한 카테고리 → 같은 카테고리 다른 후보 병렬 재시도
  interface FetchedEntry {
    cat: Category
    claudeResult: ClaudeResult | null
    item: CrawledItem
    articleText: string
    isFallback: boolean
  }

  const fetchedEntries: FetchedEntry[] = []
  const failedCats: Category[] = []

  await Promise.all(
    primaryFetches.map(async ({ cat, primary, text, ok }) => {
      if (ok && primary) {
        fetchedEntries.push({ cat, claudeResult: primary.result, item: primary.item, articleText: text, isFallback: false })
        return
      }
      // 1차 실패 → 같은 카테고리 후보들 병렬 시도 (최대 5개)
      const allCandidates = catGroups.get(cat) ?? []
      const triedUrl = primary?.item.source_url
      const candidates = allCandidates.filter(c => c.source_url !== triedUrl).slice(0, 5)
      if (candidates.length === 0) { failedCats.push(cat); return }

      const fallbackResults = await Promise.all(
        candidates.map(c => fetchArticleText(c.source_url).then(r => ({ ...r, item: c })))
      )
      const firstOk = fallbackResults.find(r => r.ok)
      if (firstOk) {
        log('fetch_fallback_ok', { cat, url: firstOk.item.source_url })
        fetchedEntries.push({ cat, claudeResult: null, item: firstOk.item, articleText: firstOk.text, isFallback: true })
      } else {
        log('fetch_all_failed', { cat, tried: candidates.length + 1 })
        failedCats.push(cat)
      }
    })
  )

  log('fetch_done', { fetched: fetchedEntries.length, failed: failedCats, elapsed: Date.now() - t0 })
  if (fetchedEntries.length === 0) {
    return NextResponse.json({ error: '기사 본문 페치 전부 실패', failedCats }, { status: 500 })
  }

  // ── 5. 본문 + 요약 생성 (실제 기사 기반, 병렬) ───────────────
  const bodyResults = await Promise.all(
    fetchedEntries.map(e => generateBodyAndSummary(apiKey, {
      engTitle: e.item.title,
      koreanTitle: e.claudeResult?.title ?? null,
      siteName: e.item.site_name,
      category: e.cat,
      articleText: e.articleText,
      description: e.item.description,
    }))
  )
  log('bodies_done', { count: bodyResults.length, elapsed: Date.now() - t0 })

  // ── 6. 이미지 수집 (병렬) ────────────────────────────────────
  const imageResults = await Promise.all(
    fetchedEntries.map((e, i) => collectImages(bodyResults[i].finalTitle || e.item.title, e.item))
  )
  log('images_done', { elapsed: Date.now() - t0 })

  // ── 7. 발행 전 최종 검증 ─────────────────────────────────────
  const rows: Record<string, unknown>[] = []
  const validationLog: { title: string; ok: boolean; reason?: string }[] = []

  for (let i = 0; i < fetchedEntries.length; i++) {
    const e = fetchedEntries[i]
    const { finalTitle, summary, body, tags: genTags } = bodyResults[i]
    const { mainImg, gallery } = imageResults[i]

    // Claude 선택 태그 우선, 부족하면 생성된 태그로 보충
    const claudeTags = e.claudeResult?.tags ?? []
    const finalTags = ensureMinTags(claudeTags.length >= 5 ? claudeTags : genTags, e.item.title)

    const validation = validatePublishable(finalTitle, summary, body, mainImg, e.cat, recentTrends, finalTags)
    validationLog.push({ title: finalTitle, ...validation })

    if (!validation.ok) {
      log('skip_validation', { title: finalTitle, reason: validation.reason })
      continue
    }

    rows.push({
      title: finalTitle,
      summary,
      original_title: e.claudeResult?.original_title || e.item.title,
      body,
      why_trending: e.claudeResult?.why_trending || null,
      who_affected: e.claudeResult?.who_affected || null,
      heat_score: e.claudeResult?.heat_score ?? e.item.heat_score,
      category: e.cat,
      tags: finalTags,
      source_url: e.item.source_url,
      related_sources: [{ title: e.item.title, url: e.item.source_url, site_name: e.item.site_name }],
      image_url: mainImg,
      gallery_images: gallery,
      published_at: new Date().toISOString(),
    })
  }

  log('validation', { total: fetchedEntries.length, passed: rows.length, validationLog, elapsed: Date.now() - t0 })

  if (rows.length === 0) {
    return NextResponse.json({ error: '검증 통과한 트렌드 없음', validationLog, failedCats }, { status: 500 })
  }

  // ── 8. INSERT (기존 데이터 절대 건드리지 않음) ────────────────
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
  log('crawl_done', { trigger, elapsed_ms: elapsed, inserted: rows.length, failedCats, validationLog })

  return NextResponse.json({
    success: true,
    count: rows.length,
    elapsed_ms: elapsed,
    failedCategories: failedCats,
    validationLog,
    trends: rows.map((r: Record<string, unknown>) => ({
      title: r.title,
      category: r.category,
      image_url: r.image_url,
      body_length: String(r.body ?? '').length,
      summary_preview: String(r.summary ?? '').slice(0, 80),
    })),
  })
}
