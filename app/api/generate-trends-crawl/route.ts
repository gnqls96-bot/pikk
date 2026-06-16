import { NextRequest, NextResponse } from 'next/server'
import type { Category, GalleryImage, RelatedSource } from '@/lib/types'
import {
  fetchRelatedGalleryImages,
  searchYouTubeThumbnail,
  isValidTrendImage,
  isLowQualityImageUrl,
} from '@/lib/utils/og-image'

export const maxDuration = 300

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
  // 영구 고정: 번역 없이 소스 원본 제목 그대로 저장 (다른 트렌드 제목 혼입 절대 금지)
  original_title: string
  title: string
  summary: string
  // 영구 고정: 실제 트렌딩 강도 기반 점수 (40-99), 소스 데이터와 별개로 저널리스트가 판단
  heat_score: number
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

// ─── 카테고리별 전용 소스 (영구 고정) ──────────────────────────────
// 규칙: 카테고리 9개 × 각 1개 = 하루 총 9개 고정 발행
// 같은 카테고리 2개 발행 절대 금지
const ALL_CATS: Category[] = ['푸드', '뷰티', 'SNS', '패션', '테크', '라이프', '디자인', '광고', '영상']

const CAT_RSS_SOURCES: Array<{ cat: Category; url: string; name: string }> = [
  // 푸드
  { cat: '푸드',  url: 'https://www.eater.com/rss/index.xml',           name: 'Eater' },
  { cat: '푸드',  url: 'https://www.seriouseats.com/atom.xml',           name: 'Serious Eats' },
  { cat: '푸드',  url: 'https://www.bonappetit.com/feed/rss',            name: 'Bon Appétit' },
  // 뷰티
  { cat: '뷰티',  url: 'https://www.allure.com/feed/rss',                name: 'Allure' },
  { cat: '뷰티',  url: 'https://www.byrdie.com/rss',                     name: 'Byrdie' },
  { cat: '뷰티',  url: 'https://wwd.com/beauty-industry-news/feed/',     name: 'WWD Beauty' },
  // 패션
  { cat: '패션',  url: 'https://www.vogue.com/feed/rss',                 name: 'Vogue' },
  { cat: '패션',  url: 'https://wwd.com/feed/',                          name: 'WWD' },
  { cat: '패션',  url: 'https://hypebeast.com/feed',                     name: 'Hypebeast' },
  // 테크
  { cat: '테크',  url: 'https://techcrunch.com/feed/',                   name: 'TechCrunch' },
  { cat: '테크',  url: 'https://www.theverge.com/rss/index.xml',         name: 'The Verge' },
  // 라이프
  { cat: '라이프', url: 'https://lifehacker.com/rss',                    name: 'Lifehacker' },
  { cat: '라이프', url: 'https://www.realsimple.com/syndication/rss',    name: 'Real Simple' },
  // 디자인
  { cat: '디자인', url: 'https://www.dezeen.com/feed/',                  name: 'Dezeen' },
  { cat: '디자인', url: 'https://design-milk.com/feed/',                 name: 'Design Milk' },
  // 광고
  { cat: '광고',  url: 'https://www.adweek.com/feed/',                   name: 'Adweek' },
  { cat: '광고',  url: 'https://www.marketingweek.com/feed/',            name: 'Marketing Week' },
  { cat: '광고',  url: 'https://www.campaignlive.com/rss',               name: 'Campaign' },
  { cat: '광고',  url: 'https://www.marketingdive.com/feeds/news/',      name: 'Marketing Dive' },
  // 영상
  { cat: '영상',  url: 'https://variety.com/feed/',                      name: 'Variety' },
  { cat: '영상',  url: 'https://deadline.com/feed/',                     name: 'Deadline' },
  { cat: '영상',  url: 'https://www.hollywoodreporter.com/feed/',        name: 'Hollywood Reporter' },
]
const CAT_REDDIT_SOURCES: Array<{ cat: Category; subreddit: string; minScore: number }> = [
  { cat: '푸드',  subreddit: 'food',             minScore: 200 },
  { cat: 'SNS',   subreddit: 'OutOfTheLoop',     minScore: 300 },
  { cat: 'SNS',   subreddit: 'tiktokcringe',     minScore: 100 },
  { cat: 'SNS',   subreddit: 'socialmedia',      minScore: 30 },
  { cat: '테크',  subreddit: 'technology',        minScore: 500 },
  { cat: '라이프', subreddit: 'selfimprovement',  minScore: 100 },
  { cat: '라이프', subreddit: 'lifestyle',        minScore: 50 },
  { cat: '영상',  subreddit: 'videos',            minScore: 500 },
  { cat: '패션',  subreddit: 'femalefashionadvice', minScore: 100 },
]
// YouTube 카테고리ID → 픽크 카테고리 매핑
const YT_CAT_MAP: Record<string, Category> = {
  '1': '영상', '10': '영상', '23': 'SNS', '24': 'SNS',
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

// 영구 고정: 태그 5개 미달이면 원본 제목에서 추출해 보충 (최대 7개)
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
// 픽크 온도 (RSS): pubDate 기반 신선도 계산 — 하드코딩 금지
// 영구 고정: 발행 시간이 다르면 온도도 달라야 함
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
    const imgUrl = c.match(/<media:content[^>]+url=["']([^"']+)["'][^>]*medium=["']image["']/i)?.[1] ?? c.match(/<media:thumbnail[^>]+url=["']([^"']+)["']/i)?.[1] ?? null
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

// ╔══════════════════════════════════════════════════════════════════════╗
// ║  핵심 원칙 — 이 함수는 절대 변경 금지 (2026-06-16 영구 고정)              ║
// ║                                                                      ║
// ║  이미지 수집 방식:                                                     ║
// ║   1순위: 트렌드 키워드로 뉴스 기사 4~5개 검색 → 각 기사 og:image 직접 추출 ║
// ║          (해당 트렌드의 키워드만 사용 — 병렬 처리해도 트렌드 간 혼용 금지)   ║
// ║          기사 이미지가 품질 기준 미달이면 자동으로 다음 기사로 넘어감       ║
// ║          첫 통과 기사 og:image = 메인, 나머지 통과 기사 = 갤러리(최대 4)   ║
// ║   2순위: 갤러리가 4개 미달이면 YouTube 썸네일로 남은 슬롯만 보충           ║
// ║          (뉴스 기사 이미지가 0개면 YouTube 썸네일이 메인 이미지를 대체)    ║
// ║   3순위: 그래도 이미지가 전혀 없으면 mainImg=null → 해당 트렌드 발행 거부   ║
// ║                                                                      ║
// ║  절대 금지:                                                            ║
// ║  ✗ Bing Image Search / 이미지 직접 검색 (뉴스 RSS → og:image 추출만 허용) ║
// ║  ✗ Pexels (뉴스 og:image + YouTube 모두 실패한 마지막 수단만 — 현재 미사용)║
// ║  ✗ 다른 트렌드 기사 이미지 혼합 금지                                      ║
// ║  ✗ 로고/프로필/아바타/워터마크 이미지, 300x200 미만 이미지                ║
// ║  ✗ 이미지 없는 트렌드 발행 금지                                           ║
// ╚══════════════════════════════════════════════════════════════════════╝
async function collectImages(
  claudeTitle: string,
  item: CrawledItem,
  category: string = '테크'
): Promise<{ mainImg: string | null; gallery: GalleryImage[]; articles: GalleryImage[] }> {
  const engKeyword = extractEnglishKeyword(claudeTitle, item.title)

  // ─────────────────────────────────────────────────────────────────────
  // 1단계: 트렌드 키워드로 뉴스 기사 검색 (한국어 + 영어 동시)
  //        Bing News RSS → 기사 URL → 각 기사에서 og:image 직접 추출
  //        이것이 유일한 이미지 수집 경로 (이미지 검색 X, 스톡 사진 X)
  // ─────────────────────────────────────────────────────────────────────
  const [koArticleImages, enArticleImages] = await Promise.all([
    fetchRelatedGalleryImages(claudeTitle, item.source_url, 5),
    engKeyword.length > 2
      ? fetchRelatedGalleryImages(engKeyword, item.source_url, 5)
      : Promise.resolve<GalleryImage[]>([]),
  ])

  // 2단계: 한국어 우선 합치기 (중복 URL + 저품질 URL 제외)
  const seenUrls = new Set<string>()
  const allImages: GalleryImage[] = []
  for (const img of [...koArticleImages, ...enArticleImages]) {
    // 영구 고정: URL 패턴 기반 저품질 이미지 즉시 제외
    if (isLowQualityImageUrl(img.url)) continue
    if (!seenUrls.has(img.url) && allImages.length < 5) {
      seenUrls.add(img.url)
      allImages.push(img)
    }
  }

  // 3단계: 메인 이미지 = 첫 번째 기사 og:image, 갤러리 = 나머지 최대 4개
  const mainImg = allImages[0]?.url ?? null

  // ─────────────────────────────────────────────────────────────────
  // 4단계 폴백 (영구 고정 우선순위):
  //   1순위: 뉴스 기사 og:image (위에서 수집)
  //   2순위: YouTube 관련 영상 썸네일 (API 검색)
  //   3순위: 없으면 mainImg=null → 발행 금지 (isValidTrendImage에서 필터)
  //   ✗ Pexels 사용 금지
  // ─────────────────────────────────────────────────────────────────
  if (!mainImg) {
    // YouTube 소스 직접 썸네일 (API 불필요, YouTube 트렌드 전용)
    const ytVid = item.source_url.match(/[?&]v=([^&]+)/)?.[1]
      ?? item.source_url.match(/youtu\.be\/([^?]+)/)?.[1]
    const ytSourceThumb = ytVid ? `https://img.youtube.com/vi/${ytVid}/maxresdefault.jpg` : null

    // YouTube API 검색 (키워드 검색)
    const ytSearchThumb = await searchYouTubeThumbnail(claudeTitle)

    const ytThumb = ytSourceThumb ?? ytSearchThumb
    if (ytThumb && !isLowQualityImageUrl(ytThumb)) {
      log('youtube_fallback', { title: claudeTitle })
      const ytImg: GalleryImage = { url: ytThumb, source_url: item.source_url, site_name: 'YouTube' }
      return { mainImg: ytThumb, gallery: [ytImg], articles: [ytImg] }
    }

    // 3순위: 이미지 완전 없음 → mainImg null → runCrawl에서 발행 거부
    log('no_image_all_failed', { title: claudeTitle })
    return { mainImg: null, gallery: [], articles: [] }
  }

  // 영구 고정: 뉴스 기사로 갤러리 4개를 못 채우면 메인 이미지는 그대로 두고
  // YouTube 썸네일로 남은 슬롯만 보충 (메인 이미지를 대체하지 않음)
  if (allImages.length < 4) {
    const ytThumb = await searchYouTubeThumbnail(claudeTitle)
    if (ytThumb && !isLowQualityImageUrl(ytThumb) && !allImages.some(img => img.url === ytThumb)) {
      log('gallery_youtube_supplement', { title: claudeTitle })
      allImages.push({ url: ytThumb, source_url: item.source_url, site_name: 'YouTube' })
    }
  }

  return { mainImg, gallery: allImages.slice(0, 4), articles: allImages }
}

// ── Claude 저널리스트 (카테고리별 1개 선택) ──────────────────────
// 영구 고정: 카테고리 9개 각 1개씩, 하루 총 9개
function makeCategoryJournalistPrompt(
  catGroups: Map<Category, CrawledItem[]>,
  selected: CrawledItem[],
  recentTitles: string[]
): string {
  const recentBlock = recentTitles.length > 0
    ? `이미 발행됨 (선택 금지): ${recentTitles.slice(0, 20).join(' / ')}\n\n`
    : ''

  // 카테고리별 소스 블록 (전역 source_id 사용)
  let sections = ''
  let globalId = 1
  const catRanges: Record<string, string> = {}
  for (const cat of ALL_CATS) {
    const items = catGroups.get(cat) ?? []
    if (items.length === 0) { catRanges[cat] = '없음'; continue }
    const start = globalId
    sections += `\n=== ${cat} ===\n`
    for (const item of items) {
      sections += `${globalId}. [${item.site_name}] ${item.title}\n`
      globalId++
    }
    catRanges[cat] = `${start}~${globalId - 1}`
  }

  return `당신은 트렌드 에디터입니다. 아래 9개 카테고리에서 각 1개씩 선택하여 총 9개 출력하세요.

${recentBlock}필수 규칙 (절대 고정):
- 반드시 9개 출력 (카테고리당 정확히 1개)
- 같은 카테고리 2개 선택 절대 금지
- 출력은 유효한 JSON이어야 함: 문자열 값 안에 줄바꿈을 절대 넣지 말고 한 줄로 이어 쓸 것
- 문자열 값 안에서 큰따옴표(")를 쓰지 말 것 (강조가 필요하면 따옴표 없이 표현)
- original_title: 해당 source_id 번호의 소스 제목(영어 원문)을 번역 없이 그대로 복사
- heat_score: 40~99, 트렌드마다 반드시 다른 값
- why_trending: 왜 지금 뜨는지 3문장 이상, 구체적 수치·사례·브랜드명 포함 (120자 이상)
- who_affected: 어떤 업계·소비자층이 주목하는지 구체적으로 (60자 이상)
- tags: 정확히 5개 이상 (최대 7개)
- summary는 본문 요약이지만 본문 그대로 반복하면 안 됨

형식 (JSON 배열, 마크다운 없음):
[{"source_id":N,"category":"카테고리명","original_title":"영어원본제목그대로","title":"한국어20자이내","summary":"요약60자이내(본문과달라야함)","heat_score":40~99,"why_trending":"3문장이상120자이상","who_affected":"60자이상구체적","tags":["태그1","태그2","태그3","태그4","태그5"]}]
${sections}`
}

// 프리미엄 저널리스트 본문 단일 배치 생성
// ─────────────────────────────────────────────────────────────────────────
// 본문 품질 원칙 (절대 변경 금지):
// - 1000자 이상 필수 (미달 시 해당 트렌드 발행 거부)
// - 배경+왜뜨는가+글로벌동향+한국의미+전망 전부 포함
// - 핵심 요약과 달라야 함 (요약 반복 금지)
//
// 타임아웃 계산 (최악 케이스 기준):
// 7개 × 1000자 × 2 tokens/자 = 14,000 tokens ÷ 79 tok/s = 177s
// 소스(10s) + 저널리스트(30s) + 이미지(37s) + 본문(177s) = 254s < maxDuration(300s) ✓
// → 8개 이상은 300s 초과 위험 → 상위 7개로 제한 (step 7에서 slice)
// ─────────────────────────────────────────────────────────────────────────
async function expandAllBodies(
  apiKey: string,
  trends: { title: string; siteName: string; description: string; summary: string }[]
): Promise<string[]> {

  const trendList = trends.map((t, i) =>
    `${i + 1}. 제목: ${t.title}\n   출처: ${t.siteName}\n   핵심요약(반복금지): ${t.summary}\n   ${t.description ? `설명: ${t.description.slice(0, 200)}` : ''}`
  ).join('\n\n')

  // 출력 형식: JSON 배열 X → 구분자 텍스트 (JSON 이스케이프 오류 원천 차단)
  const prompt = `당신은 구독료를 받는 프리미엄 저널리스트입니다. 독자들이 돈을 내고 읽는 깊이 있는 기사를 씁니다.

아래 ${trends.length}개 트렌드 각각에 대해 한국어 기사 본문을 작성하세요.

각 본문에 반드시 포함 (빠지면 실패):
1. 배경: 이 트렌드가 생겨난 맥락과 역사적 흐름
2. 왜 지금 뜨는가: 최근 촉발 요인, 구체적 수치·데이터·사례
3. 글로벌 동향: 세계 주요 국가·기업·인물의 반응과 움직임
4. 한국에서의 의미: 한국 시장·소비자·기업에 미치는 영향
5. 전망: 앞으로 3~6개월, 1~3년 시나리오

규칙:
- 각 본문 반드시 1000자 이상 (절대 기준)
- "핵심요약"을 그대로 반복하지 말 것
- 구체적 수치, 기업명, 인물명, 날짜 적극 사용
- 제목·마크다운 헤더 없이 본문만 출력

출력 형식 (이것만 허용):
===BODY_1===
(트렌드 1 본문)
===BODY_2===
(트렌드 2 본문)
...

트렌드:
${trendList}`

  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 16000,
        messages: [{ role: 'user', content: prompt }],
      }),
      signal: AbortSignal.timeout(190000),  // 190s: 7×1000자×2tok/79tok/s=177s + 여유 13s
    })
    if (!res.ok) { log('expandBodies_error', { status: res.status }); return trends.map(() => '') }
    const data = await res.json()
    const text: string = data.content?.[0]?.text ?? ''
    const sections = text.split(/===BODY_\d+===/).map(s => s.trim()).filter(Boolean)
    log('expandBodies_done', { sections: sections.length, firstLen: sections[0]?.length ?? 0 })
    if (sections.length === 0) { log('expandBodies_no_sections', { preview: text.slice(0, 300) }); return trends.map(() => '') }
    while (sections.length < trends.length) sections.push('')
    return sections.slice(0, trends.length)
  } catch (e) {
    log('expandBodies_exception', { error: String(e) })
    return trends.map(() => '')
  }
}

// Claude가 JSON 문자열 값 안에 raw 줄바꿈/탭을 그대로 넣어버리는 경우가 있어
// (why_trending 3문장 이상 요구 후 발생) 표준 JSON.parse가 실패함.
// 1차: 그대로 파싱 → 2차: 문자열 리터럴 내부의 raw 제어문자만 \n으로 escape 후 재시도.
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
    let inString = false
    let escaped = false
    for (const ch of raw) {
      if (inString) {
        if (escaped) { repaired += ch; escaped = false; continue }
        if (ch === '\\') { repaired += ch; escaped = true; continue }
        if (ch === '"') { inString = false; repaired += ch; continue }
        if (ch === '\n') { repaired += '\\n'; continue }
        if (ch === '\r') { continue }
        if (ch === '\t') { repaired += ' '; continue }
        repaired += ch
        continue
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

// 영구 고정: 카테고리당 1개, 총 9개 선택
// catGroups: 카테고리 → 후보 items (순서 그대로 전역 source_id 부여)
// returns: results + selected (source_id → item 매핑용)
async function generateWithClaude(
  catGroups: Map<Category, CrawledItem[]>,
  recentTitles: string[]
): Promise<{ results: ClaudeResult[]; selected: CrawledItem[]; error?: string }> {
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) return { results: [], selected: [], error: 'ANTHROPIC_API_KEY 미설정' }

  // 전역 source_id 부여 (카테고리 순서로 flat)
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
        max_tokens: 4000,
        messages: [{ role: 'user', content: makeCategoryJournalistPrompt(catGroups, selected, recentTitles) }],
      }),
      // 90s: 소스 수집(~1s)이 빨라 여유 있음. 50s는 2026-06-16 연속 2회 타임아웃 확인 후 상향.
      signal: AbortSignal.timeout(90000),
    })
    if (!res.ok) return { results: [], selected, error: `Claude HTTP ${res.status}: ${await res.text().catch(() => '')}`.slice(0, 200) }
    const data = await res.json()
    if (data.error) return { results: [], selected, error: `Claude 오류: ${data.error.message}` }
    const text: string = data.content?.[0]?.text ?? ''
    const { parsed, raw, error: parseError } = parseClaudeJsonArray(text)
    if (!parsed) {
      const body = raw ?? text
      const pos = Number(parseError?.match(/position (\d+)/)?.[1] ?? -1)
      const around = pos >= 0 ? body.slice(Math.max(0, pos - 300), pos + 300) : body.slice(0, 4000)
      log('claude_parse_fail', { parseError, len: body.length, pos, around })
      return { results: [], selected, error: `JSON 파싱 실패. 응답: ${text.slice(0, 200)}` }
    }

    const seenSourceIds = new Set<number>()
    const seenCats = new Set<string>()
    const results = parsed
      .filter(p => {
        const id = Number(p.source_id)
        const cat = String(p.category ?? '')
        // source_id 유효성 + 카테고리당 1개 강제
        if (!Number.isInteger(id) || id < 1 || id > selected.length) return false
        if (seenSourceIds.has(id)) return false
        if (!VALID_CATS.has(cat) || seenCats.has(cat)) return false
        seenSourceIds.add(id)
        seenCats.add(cat)
        return true
      })
      .slice(0, 9)  // 영구 고정: 최대 9개 (카테고리 9개)
      .map(p => {
        const sid = Number(p.source_id), src = selected[sid - 1]
        // original_title 영구 고정: Claude 반환값 우선, 없으면 items 배열 직접 조회
        const originalTitle = String(p.original_title ?? '').trim() || (src?.title ?? '')
        // heat_score 영구 고정: 저널리스트 판단값, 범위 벗어나면 소스값으로 대체
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
          // 영구 고정: 태그 5개 미달 시 원본 제목에서 보충
          tags: ensureMinTags(Array.isArray(p.tags) ? (p.tags as unknown[]).map(String) : [], src?.title ?? originalTitle),
          category: String(p.category) as Category,
        }
      })
    if (results.length === 0) return { results: [], selected, error: `검증 실패. ${parsed.length}개 파싱, sources: ${selected.length}` }
    return { results, selected }
  } catch (e) { return { results: [], selected, error: `예외: ${e}` } }
}

// ── 카테고리 폴백 에디토리얼 (영구 고정) ──────────────────────────
// 1차 선택의 이미지가 실패한 카테고리를 위해, 같은 카테고리의 다른 후보를
// 골라 별도로 에디토리얼 메타데이터(제목/요약/태그 등)를 생성한다.
// "카테고리당 1개"가 깨지지 않도록 1차 선택과 동일한 검증 규칙을 적용.
async function generateRetryEditorial(
  items: { source_id: number; item: CrawledItem; category: Category }[],
  recentTitles: string[]
): Promise<ClaudeResult[]> {
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey || items.length === 0) return []

  const recentBlock = recentTitles.length > 0
    ? `이미 발행됨 (선택 금지): ${recentTitles.slice(0, 20).join(' / ')}\n\n` : ''
  const sections = items.map(({ source_id, item, category }) =>
    `${source_id}. [카테고리:${category}] [${item.site_name}] ${item.title}`
  ).join('\n')

  const prompt = `당신은 트렌드 에디터입니다. 아래 ${items.length}개 소스 각각에 대해 카드뉴스용 메타데이터를 작성하세요.

${recentBlock}각 항목에 대해 정확히 하나씩 출력하세요 (총 ${items.length}개).
- original_title: 해당 source_id 번호의 소스 제목(영어 원문)을 번역 없이 그대로 복사
- heat_score: 40~99, 트렌드마다 반드시 다른 값
- why_trending: 3문장 이상, 구체적 수치·사례·브랜드명 포함 (120자 이상)
- who_affected: 어떤 업계·소비자층이 주목하는지 구체적으로 (60자 이상)
- tags: 정확히 5개 이상 (최대 7개)
- 출력은 유효한 JSON이어야 함: 문자열 값 안에 줄바꿈을 절대 넣지 말고 한 줄로 이어 쓸 것
- 문자열 값 안에서 큰따옴표(")를 쓰지 말 것 (강조가 필요하면 따옴표 없이 표현)

형식 (JSON 배열, 마크다운 없음):
[{"source_id":N,"category":"카테고리명","original_title":"영어원본제목그대로","title":"한국어20자이내","summary":"요약60자이내","heat_score":40~99,"why_trending":"3문장이상120자이상","who_affected":"60자이상구체적","tags":["태그1","태그2","태그3","태그4","태그5"]}]

${sections}`

  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 1500,
        messages: [{ role: 'user', content: prompt }],
      }),
      signal: AbortSignal.timeout(25000),
    })
    if (!res.ok) return []
    const data = await res.json()
    const text: string = data.content?.[0]?.text ?? ''
    const { parsed } = parseClaudeJsonArray(text)
    if (!parsed) return []

    const bySourceId = new Map(items.map(it => [it.source_id, it]))
    const results: ClaudeResult[] = []
    for (const p of parsed) {
      const sid = Number(p.source_id)
      const matched = bySourceId.get(sid)
      if (!matched) continue
      const originalTitle = String(p.original_title ?? '').trim() || matched.item.title
      const rawHeat = Number(p.heat_score)
      const heatScore = Number.isInteger(rawHeat) && rawHeat >= 40 && rawHeat <= 99 ? rawHeat : matched.item.heat_score
      results.push({
        source_id: sid,
        original_title: originalTitle.slice(0, 300),
        title: String(p.title ?? '').slice(0, 80),
        summary: String(p.summary ?? '').slice(0, 200),
        heat_score: heatScore,
        why_trending: String(p.why_trending ?? '').slice(0, 500),
        who_affected: String(p.who_affected ?? '').slice(0, 300),
        tags: ensureMinTags(Array.isArray(p.tags) ? (p.tags as unknown[]).map(String) : [], matched.item.title),
        category: matched.category,
      })
    }
    return results
  } catch { return [] }
}

// ── Cron ────────────────────────────────────────────────────────
// 영구 고정: 매일 06:00 KST = UTC 21:00 (vercel.json "0 21 * * *"), 실패 시 07:30 KST 재시도("30 22 * * *")
// CRON_SECRET 환경변수가 설정되어 있으면 Vercel이 자동으로 Authorization 헤더를 붙여 보내고, 여기서 검증한다.
export async function GET(req: NextRequest) {
  const secret = process.env.CRON_SECRET
  if (secret && req.headers.get('authorization') !== `Bearer ${secret}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  return runCrawl('cron')
}
export async function POST() { return runCrawl('manual') }

// ╔══════════════════════════════════════════════════════════════════╗
// ║  영구 규칙 — 기존 데이터 보호 (Cron이든 수동 실행이든 동일하게 적용)    ║
// ║  이 함수는 절대 DELETE를 호출하지 않는다. 오늘 날짜 새 트렌드를         ║
// ║  INSERT만 한다. 기존 트렌드를 지우는 로직을 이 함수에 추가하지 말 것.    ║
// ║  (트렌드 전체/일부 삭제가 필요하면 app/api/admin/* 의 별도 관리자       ║
// ║   전용 엔드포인트를 사람이 직접 호출해야 한다 — 자동 플로우에서 절대 금지) ║
// ╚══════════════════════════════════════════════════════════════════╝
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

  // ── 2. 카테고리별 소스 수집 (모두 병렬) ────────────────────────
  // 영구 고정: 카테고리 9개 전용 소스 → 카테고리당 1개 → 총 9개
  const since7d = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()

  const [ytResult, hnItems, recentRes, ...catFetchResults] = await Promise.all([
    fetchYouTubeTrending(),
    fetchHNTop(),
    fetch(`${SURL}/rest/v1/trends?published_at=gte.${encodeURIComponent(since7d)}&select=title,tags&limit=50`, { headers: sbHeaders }).catch(() => null),
    // 카테고리 전용 RSS (병렬)
    ...CAT_RSS_SOURCES.map(s => fetchRSSFeed(s.url, s.name).then(items => ({ cat: s.cat, items }))),
    // 카테고리 Reddit (병렬)
    ...CAT_REDDIT_SOURCES.map(s => fetchRedditHot(s.subreddit, s.minScore).then(items => ({ cat: s.cat, items }))),
  ])

  const recentTrends: { title: string; tags: string[] }[] = recentRes?.ok
    ? await recentRes.json().catch(() => []) : []
  const recentTitles = recentTrends.map(t => t.title)

  // 카테고리별 후보 구성
  const catGroups = new Map<Category, CrawledItem[]>()
  for (const cat of ALL_CATS) catGroups.set(cat, [])

  // YouTube → YT 카테고리ID로 픽크 카테고리 결정
  for (const item of ytResult.items) {
    const cat: Category = (item.yt_category_id && YT_CAT_MAP[item.yt_category_id])
      ? YT_CAT_MAP[item.yt_category_id]
      : mapCategory(item.title, item.yt_category_id)
    catGroups.get(cat)?.push(item)
  }

  // HN → 테크
  for (const item of hnItems) catGroups.get('테크')!.push(item)

  // RSS + Reddit 결과 배분
  for (const { cat, items } of catFetchResults as Array<{ cat: Category; items: CrawledItem[] }>) {
    catGroups.get(cat)?.push(...items)
  }

  // 카테고리 내 중복 제거, 최대 6개로 제한
  for (const [cat, items] of catGroups) {
    catGroups.set(cat, dedup(items).slice(0, 6))
  }

  const totalSources = [...catGroups.values()].reduce((s, v) => s + v.length, 0)
  log('sources', {
    total: totalSources,
    youtube: ytResult.items.length,
    hn: hnItems.length,
    recent: recentTrends.length,
    byCat: Object.fromEntries(ALL_CATS.map(c => [c, catGroups.get(c)?.length ?? 0])),
  })

  if (totalSources === 0) {
    return NextResponse.json({ error: '소스 수집 실패' }, { status: 502 })
  }

  // ── 3. Claude 저널리스트 (카테고리당 1개 선택) ────────────────
  const { results: claudeResults, selected, error: claudeError } = await generateWithClaude(catGroups, recentTitles)
  log('claude', { count: claudeResults.length, error: claudeError ?? null, elapsed: Date.now() - t0 })

  if (claudeResults.length === 0) {
    return NextResponse.json({ error: claudeError ?? 'Claude 실패', totalSources }, { status: 500 })
  }

  // ── 4. 이미지 수집 (모든 트렌드 병렬) ──────────────────────────
  // 핵심: 이미지+본문을 먼저 확정하고 단일 INSERT → 순서 불일치 버그 완전 제거
  // 순서: ① 이미지 수집 완료 → ② 본문 생성 (100+ 이미지 HTTP와 Haiku 동시실행 시 연결 풀 포화)
  const imageResults = await Promise.all(
    claudeResults.map(async (result) => {
      const item = selected[result.source_id - 1]
      return { result, item, ...(await collectImages(result.title, item, result.category)) }
    })
  )
  log('images_done', { elapsed: Date.now() - t0 })

  // ── 5. 이미지 품질 검증 (URL 필터 + 크기 300×200 이상 확인) ──────
  // 영구 고정: isValidTrendImage = URL 패턴 필터 + 이미지 크기 검증
  const validated = await Promise.all(
    imageResults.map(async (e) => ({
      ...e,
      imageOk: e.mainImg ? await isValidTrendImage(e.mainImg) : false,
    }))
  )

  // ── 6. 필터: 이미지 없거나 중복이면 제외 (카테고리당 1개 보장됨) ──
  // 9개 상한: 9×1000자×2tok/실측161tok/s=112s + 소스/저널/이미지 80s = 192s < maxDuration 300s
  const filterLog: { title: string; reason?: string; imageOk: boolean }[] = []
  const valid = validated.filter(e => {
    const entry = { title: e.result.title, imageOk: e.imageOk }
    if (!e.imageOk) {
      log('skip_no_image', { title: e.result.title, mainImg: e.mainImg })
      filterLog.push({ ...entry, reason: 'no_image' })
      return false
    }
    if (isDuplicateTrend(e.result.title, e.result.tags, recentTrends)) {
      log('skip_duplicate', { title: e.result.title })
      filterLog.push({ ...entry, reason: 'duplicate' })
      return false
    }
    filterLog.push(entry)
    return true
  }).slice(0, 9)  // 최대 9개 (카테고리 9개 × 1개)

  // ── 6.5. 카테고리 폴백: 1차 선택 이미지가 실패한 카테고리는 같은 카테고리의
  //         다른 후보로 재시도 (영구 고정 — "하루 9개" 규칙을 지키기 위한 보강) ──
  // 이미지 품질 기준은 그대로 유지(isValidTrendImage), 카테고리당 1개 제한도 그대로.
  const filledCats = new Set(valid.map(e => e.result.category))
  const failedCats = ALL_CATS.filter(c => !filledCats.has(c))

  type FallbackEntry = typeof valid[number]
  let fallbackEnriched: FallbackEntry[] = []

  if (failedCats.length > 0 && apiKey) {
    const triedUrls = new Set(claudeResults.map(r => selected[r.source_id - 1]?.source_url))
    type FallbackWinner = { cat: Category; item: CrawledItem; mainImg: string | null; gallery: GalleryImage[]; articles: GalleryImage[] }

    const winners = (await Promise.all(failedCats.map(async (cat): Promise<FallbackWinner | null> => {
      const candidates = (catGroups.get(cat) ?? []).filter(c => !triedUrls.has(c.source_url))
      for (const cand of candidates.slice(0, 3)) {
        const imgRes = await collectImages(cand.title, cand, cat)
        if (imgRes.mainImg && await isValidTrendImage(imgRes.mainImg)) {
          return { cat, item: cand, ...imgRes }
        }
      }
      return null
    }))).filter((w): w is FallbackWinner => w !== null)

    if (winners.length > 0) {
      const retryItems = winners.map((w, i) => ({ source_id: i + 1, item: w.item, category: w.cat }))
      const retryResults = await generateRetryEditorial(retryItems, recentTitles)
      fallbackEnriched = retryResults
        .filter(r => !isDuplicateTrend(r.title, r.tags, recentTrends))
        .map(r => {
          const w = winners[r.source_id - 1]
          return { result: r, item: w.item, mainImg: w.mainImg, gallery: w.gallery, articles: w.articles, imageOk: true }
        })
      log('category_fallback', { recovered: fallbackEnriched.map(e => e.result.category) })
    }
  }

  const finalValid = [...valid, ...fallbackEnriched].slice(0, 9)

  // ── 7. 본문 생성 (이미지 수집 완료 후 단일 배치) ─────────────
  // 이미지 수집 완료 후 실행 — 이미지 HTTP와 Haiku 동시실행 시 연결 풀 포화 방지
  const bodies = apiKey
    ? await expandAllBodies(apiKey, finalValid.map(e => ({
        title: e.result.title,
        siteName: e.item.site_name,
        description: e.item.description,
        summary: e.result.summary,
      })))
    : finalValid.map(() => '')

  const enriched = finalValid.map((e, i) => ({
    ...e,
    expandedBody: bodies[i] ?? '',
  }))

  // ── 7.5. 본문 자동 재생성: 1000자 미만이면 한 번 더 시도 (영구 고정) ──
  // 짧은 본문만 모아 재생성 → 그래도 짧으면 step 8에서 최종 제외
  const shortIdx = enriched
    .map((e, i) => ({ e, i }))
    .filter(({ e }) => e.expandedBody.length < 1000)
  if (shortIdx.length > 0 && apiKey) {
    log('body_regen_attempt', { titles: shortIdx.map(({ e }) => e.result.title) })
    const retryBodies = await expandAllBodies(apiKey, shortIdx.map(({ e }) => ({
      title: e.result.title,
      siteName: e.item.site_name,
      description: e.item.description,
      summary: e.result.summary,
    })))
    shortIdx.forEach(({ i }, j) => {
      if ((retryBodies[j] ?? '').length > enriched[i].expandedBody.length) {
        enriched[i] = { ...enriched[i], expandedBody: retryBodies[j] }
      }
    })
  }

  // ── 8. 본문 길이 필터: 1000자 미만이면 제외 ────────────────────
  const bodyFilterLog: { title: string; reason?: string; bodyLen: number }[] = []
  const validWithBody = enriched.filter(e => {
    const entry = { title: e.result.title, bodyLen: e.expandedBody.length }
    if (e.expandedBody.length < 1000) {
      log('skip_short_body', { title: e.result.title, bodyLen: e.expandedBody.length })
      bodyFilterLog.push({ ...entry, reason: 'short_body' })
      return false
    }
    bodyFilterLog.push(entry)
    return true
  })

  log('filter', {
    total: claudeResults.length,
    passed_image: finalValid.length,
    passed_body: validWithBody.length,
    elapsed: Date.now() - t0,
    filterLog,
    bodyFilterLog,
  })

  if (validWithBody.length === 0) {
    return NextResponse.json({
      error: '유효한 트렌드 없음',
      collected: selected.length,
      filterLog,
      bodyFilterLog,
    }, { status: 500 })
  }

  // ── 9. 단일 INSERT (이미지+본문 포함) ────────────────────────
  // → PATCH 불필요, 순서 불일치 버그 없음
  // → related_sources = 뉴스 기사 수집 결과 (이미지 출처 그대로)
  // 영구 고정: 여기는 INSERT만 한다. 기존 행을 지우는 DELETE를 추가하지 말 것.
  const rows = validWithBody.map(e => {
    const relatedSources: RelatedSource[] = e.articles.length > 0
      ? e.articles.map(a => ({ title: a.site_name, url: a.source_url, site_name: a.site_name }))
      : [{ title: e.item.title, url: e.item.source_url, site_name: e.item.site_name }]
    return {
      title: e.result.title,
      summary: e.result.summary,
      // 영구 고정: original_title = 저널리스트가 확인한 해당 트렌드 원본 제목
      // source_id 오매핑 방어: Claude의 original_title 필드 우선, 없으면 items 배열 직접 조회
      original_title: e.result.original_title || e.item?.title || '',
      body: e.expandedBody,
      why_trending: e.result.why_trending || null,
      who_affected: e.result.who_affected || null,
      // 영구 고정: 저널리스트 판단 열기 점수 사용 (트렌드마다 고유값, 전부 동일값 금지)
      heat_score: e.result.heat_score,
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
    trigger, elapsed_ms: elapsed, inserted: validWithBody.length,
    trends: validWithBody.map(e => ({ title: e.result.title, image_url: e.mainImg, gallery: e.gallery.length, body_length: e.expandedBody.length })),
  })

  return NextResponse.json({
    success: true,
    count: validWithBody.length,
    elapsed_ms: elapsed,
    skipped: claudeResults.length - validWithBody.length,
    trends: validWithBody.map(e => ({ title: e.result.title, image_url: e.mainImg, gallery_count: e.gallery.length, body_length: e.expandedBody.length })),
    sources: { youtube: ytResult.items.length, hn: hnItems.length, total: selected.length },
  })
}
