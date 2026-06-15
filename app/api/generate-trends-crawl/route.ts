import { NextRequest, NextResponse } from 'next/server'
import type { Category, GalleryImage, RelatedSource } from '@/lib/types'
import {
  fetchOgImage,
  fetchRelatedGalleryImages,
  fetchPexelsImages,
  searchYouTubeThumbnail,
  isValidImageUrl,
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
// ║  핵심 원칙 — 이 함수는 절대 변경 금지                                    ║
// ║                                                                      ║
// ║  이미지 수집 방식: 트렌드 키워드로 뉴스 기사 검색 → 각 기사 og:image 추출  ║
// ║                                                                      ║
// ║  절대 금지:                                                            ║
// ║  ✗ Bing Image Search (뉴스 RSS만 허용, 이미지 직접 검색 X)               ║
// ║  ✗ Pexels (뉴스 og:image 완전 실패 시 마지막 수단만)                     ║
// ║  ✗ YouTube 검색 썸네일 (해당 트렌드 원본 YouTube URL 썸네일은 허용)        ║
// ║  ✗ 다른 트렌드 기사 이미지 혼합 금지                                      ║
// ║  ✗ 트렌드 내용과 무관한 이미지 금지                                       ║
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

  // 2단계: 한국어 우선 합치기 (중복 이미지 URL 제거)
  const seenUrls = new Set<string>()
  const allImages: GalleryImage[] = []
  for (const img of [...koArticleImages, ...enArticleImages]) {
    if (!seenUrls.has(img.url) && allImages.length < 5) {
      seenUrls.add(img.url)
      allImages.push(img)
    }
  }

  // 3단계: 메인 이미지 = 첫 번째 기사 og:image
  //        갤러리 = 나머지 기사 og:images (최대 4개)
  const mainImg = allImages[0]?.url ?? null
  const gallery = allImages.slice(0, 4)

  // 4단계: 뉴스 og:image가 하나도 없을 때만 Pexels (마지막 수단)
  //        이 경로는 최대한 피해야 함 — 트렌드와 직접 관련 없는 이미지
  if (!mainImg) {
    const keyword = engKeyword.length > 2 ? engKeyword : (CATEGORY_KEYWORD[category] ?? 'trending news')
    const pexels = await fetchPexelsImages(keyword, 4)
    log('pexels_fallback', { title: claudeTitle, reason: 'news_og_image_all_failed' })
    return { mainImg: pexels[0]?.url ?? null, gallery: pexels.slice(0, 4), articles: pexels }
  }

  return { mainImg, gallery, articles: allImages }
}

// ── Claude 저널리스트 ──────────────────────────────────────────
function makeJournalistPrompt(items: CrawledItem[], recentTitles: string[]): string {
  // 소스 번호와 원본 제목을 함께 표시 — original_title 혼입 방지
  const list = items.map((item, i) => `${i + 1}. [${item.site_name}] ${item.title}`).join('\n')
  const recentBlock = recentTitles.length > 0
    ? `\n이미 발행됨 (선택 금지): ${recentTitles.slice(0, 15).join(' / ')}\n`
    : ''
  return `당신은 트렌드 에디터입니다. 아래 ${items.length}개 중 가장 핫한 10개를 골라 한국 독자용 카드뉴스 메타데이터를 작성하세요.
JSON 배열만 출력. 마크다운·코드블록 없음. source_id는 1부터 시작.
${recentBlock}
형식:
[{"source_id":N,"original_title":"소스 목록의 해당 번호 제목을 번역 없이 그대로 복사","title":"한국어 제목(20자 이내)","summary":"핵심 요약 한 문장(60자 이내, 본문과 달라야 함)","heat_score":40~99,"why_trending":"왜 지금 뜨는지(30자)","who_affected":"누가 영향받는지(20자)","tags":["태그1","태그2","태그3","태그4","태그5"],"category":"테크|SNS|푸드|뷰티|패션|라이프|디자인|광고|영상 중 하나"}]

heat_score 기준 (영구 고정 — 트렌드마다 반드시 다른 값):
- 90~99: 글로벌 바이럴, 수백만 반응
- 80~89: 광범위 화제, 주요 미디어 집중 보도
- 70~79: 업계/커뮤니티 핫토픽
- 60~69: 부상 중인 트렌드
- 50~59: 관심 증가 초기 단계
- 40~49: 틈새 관심

original_title 규칙 (영구 고정):
- 반드시 소스 목록의 해당 source_id 번호의 제목을 그대로 복사
- 번역·수정·다른 트렌드 제목 혼입 절대 금지
- 예: source_id=3이면 "3. [사이트명] 제목" 에서 "제목" 부분만 복사

소스 목록:
${list}`
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

async function generateWithClaude(items: CrawledItem[], recentTitles: string[]): Promise<{ results: ClaudeResult[], error?: string }> {
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) return { results: [], error: 'ANTHROPIC_API_KEY 미설정' }
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 3500,
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
        // original_title 영구 고정: Claude가 반환한 original_title 우선 사용
        // 없으면 source_id로 items 배열에서 직접 조회 — 절대 다른 트렌드 제목 사용 금지
        const originalTitle = String(p.original_title ?? '').trim() || (src?.title ?? '')
        // heat_score 영구 고정: 저널리스트 판단값 사용, 범위 벗어나면 소스값으로 대체
        const rawHeat = Number(p.heat_score)
        const heatScore = Number.isInteger(rawHeat) && rawHeat >= 40 && rawHeat <= 99
          ? rawHeat
          : (src?.heat_score ?? 60)
        return {
          source_id: sid,
          original_title: originalTitle.slice(0, 300),
          title: String(p.title ?? '').slice(0, 80),
          summary: String(p.summary ?? '').slice(0, 200),
          heat_score: heatScore,
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

  // ── 5. 이미지 유효성 검증 (병렬 HEAD) ───────────────────────
  const validated = await Promise.all(
    imageResults.map(async (e) => ({
      ...e,
      imageOk: e.mainImg ? await isValidImageUrl(e.mainImg) : false,
    }))
  )

  // ── 6. 필터: 이미지 없거나 중복이면 제외, 상위 7개로 제한 ──────
  // 7개 제한 이유: 7×1000자×2tok/79tok/s=177s + 소스/저널리스트/이미지 77s = 254s < maxDuration 300s
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
  }).slice(0, 7)  // 최대 7개: 타임아웃 방지

  // ── 7. 본문 생성 (이미지 수집 완료 후 단일 배치) ─────────────
  // 이미지 수집 완료 후 실행 — 이미지 HTTP와 Haiku 동시실행 시 연결 풀 포화 방지
  const bodies = apiKey
    ? await expandAllBodies(apiKey, valid.map(e => ({
        title: e.result.title,
        siteName: selected[e.result.source_id - 1]?.site_name ?? '',
        description: selected[e.result.source_id - 1]?.description ?? '',
        summary: e.result.summary,
      })))
    : valid.map(() => '')

  const enriched = valid.map((e, i) => ({
    ...e,
    expandedBody: bodies[i] ?? '',
  }))

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
    passed_image: valid.length,
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
    sources: { youtube: youtube.length, hn: hn.length, rss: selected.length - youtube.length - hn.length },
  })
}
