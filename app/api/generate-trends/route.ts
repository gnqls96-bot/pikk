import { NextResponse } from 'next/server'
import Anthropic from '@anthropic-ai/sdk'
import { createServerClient } from '@/lib/supabase/server'
import type { Category, RelatedSource, GalleryImage } from '@/lib/types'

export const maxDuration = 300

const CATEGORIES: Category[] = ['푸드', '뷰티', 'SNS', '패션', '테크', '라이프', '디자인', '광고', '영상']

const SYSTEM_PROMPT = `당신은 전세계 트렌드를 한국어로 큐레이션하는 전문 에디터입니다.
web_search와 web_fetch 도구를 적극 활용해 실시간 최신 정보를 수집하고,
한국 독자들이 쉽게 이해할 수 있도록 깊이 있는 분석 기사를 작성합니다.
사용 가능한 카테고리: ${CATEGORIES.join(', ')}`

const USER_PROMPT = `지금 이 순간 전세계에서 가장 화제인 트렌드 10개를 실시간 웹 검색으로 직접 찾아서 분석해줘.

다음 순서로 진행해:
1. 각 카테고리(푸드, 뷰티, SNS, 패션, 테크, 라이프, 디자인, 광고, 영상)별로 웹 검색
   - 영어: "trending 2026 [category]", "[topic] viral 2026"
   - Reddit, X(Twitter), Google Trends, 주요 외신(CNN, BBC, Vogue, TechCrunch 등) 탐색
2. 각 트렌드마다 실제 수치·데이터·사례 수집 (추가 검색 적극 활용)
3. 수집 완료 후 아래 형식의 JSON만 반환 (다른 텍스트 없이 JSON만)

{
  "trends": [
    {
      "title": "후킹되는 한국어 제목 — 부제 (예: '스타벅스도 뛰어들었다 — 단백질 음료 전쟁 시작')",
      "summary": "핵심 3줄 요약. 각 줄은 개행문자(\\n)로 구분. 한 줄당 하나의 핵심 포인트.",
      "body": "본문 500-800자. 배경 → 현황(실제 수치/데이터) → 구체적 사례 → 한국 영향 순으로 작성.",
      "why_trending": "왜 지금 뜨는가. 구체적 수치·사례 포함. (50-100자)",
      "who_affected": "누가 주목하나. (30-60자, 예: '20-30대 직장인', 'Z세대 크리에이터')",
      "heat_score": 실제 검색량·언급량 기반 1-100 정수,
      "category": "${CATEGORIES.join(' | ')} 중 정확히 하나",
      "tags": ["태그1", "태그2", "태그3"],
      "related_sources": [
        {"title": "실제 기사/페이지 제목", "url": "https://실제존재하는URL", "site_name": "CNN"},
        {"title": "...", "url": "https://...", "site_name": "..."},
        {"title": "...", "url": "https://...", "site_name": "..."}
      ],
      "image_search_keyword": "Pexels 검색용 영어 키워드 2-3단어"
    }
  ]
}

규칙:
- 카테고리별 최대 2개 (9개 카테고리에서 10개 선택)
- related_sources는 반드시 실제로 존재하는 URL 3개
- 반드시 유효한 JSON만 반환, 다른 텍스트 없음`

interface GeneratedTrend {
  title: string
  summary: string
  body: string
  why_trending: string
  who_affected: string
  heat_score: number
  category: Category
  tags: string[]
  related_sources: RelatedSource[]
  image_search_keyword: string
}

async function fetchOgImage(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
        Accept: 'text/html,application/xhtml+xml',
      },
      signal: AbortSignal.timeout(7000),
      redirect: 'follow',
    })
    if (!res.ok) return null
    const html = await res.text()
    const match =
      html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i) ??
      html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i)
    const raw = match?.[1]?.trim() ?? null
    if (!raw || raw.length < 10) return null
    return raw.startsWith('http') ? raw : new URL(raw, url).href
  } catch {
    return null
  }
}

const GALLERY_TARGET = 5

async function fetchPexelsImages(keyword: string, count: number): Promise<GalleryImage[]> {
  try {
    const res = await fetch(
      `https://api.pexels.com/v1/search?query=${encodeURIComponent(keyword)}&per_page=${Math.min(count, 10)}&orientation=landscape`,
      { headers: { Authorization: process.env.PEXELS_API_KEY! } }
    )
    if (!res.ok) return []
    const data = await res.json()
    return (data.photos ?? []).map((p: { src: { large2x: string }; url: string }) => ({
      url: p.src?.large2x ?? '',
      source_url: p.url ?? 'https://www.pexels.com',
      site_name: 'Pexels',
    })).filter((img: GalleryImage) => img.url)
  } catch {
    return []
  }
}

async function collectImages(
  sources: RelatedSource[],
  keyword: string
): Promise<{ image_url: string | null; gallery_images: GalleryImage[] }> {
  // 1. Try og:image from each related_source in parallel
  const ogResults = await Promise.all(
    sources.map(async (src): Promise<GalleryImage | null> => {
      if (!src.url || src.url.includes('example.com')) return null
      const ogUrl = await fetchOgImage(src.url)
      if (!ogUrl) return null
      return { url: ogUrl, source_url: src.url, site_name: src.site_name }
    })
  )

  const seen = new Set<string>()
  const gallery: GalleryImage[] = []

  for (const img of ogResults) {
    if (img && !seen.has(img.url)) {
      seen.add(img.url)
      gallery.push(img)
    }
  }

  // 2. Fill remaining slots up to GALLERY_TARGET with Pexels (only as fallback)
  if (gallery.length < GALLERY_TARGET) {
    const needed = GALLERY_TARGET - gallery.length
    const pexelsImgs = await fetchPexelsImages(keyword, needed + 2) // +2 buffer for dedup
    for (const img of pexelsImgs) {
      if (!seen.has(img.url) && gallery.length < GALLERY_TARGET) {
        seen.add(img.url)
        gallery.push(img)
      }
    }
  }

  return {
    image_url: gallery[0]?.url ?? null,
    gallery_images: gallery,
  }
}

export async function POST() {
  if (!process.env.ANTHROPIC_API_KEY) {
    return NextResponse.json({ error: 'ANTHROPIC_API_KEY not set' }, { status: 500 })
  }

  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

  try {
    // 1. Claude로 실시간 웹 검색 + 트렌드 분석 (streaming으로 타임아웃 방지)
    const stream = client.messages.stream({
      model: 'claude-opus-4-8',
      max_tokens: 16000,
      tools: [
        { type: 'web_search_20260209', name: 'web_search' },
        { type: 'web_fetch_20260209', name: 'web_fetch' },
      ],
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: USER_PROMPT }],
    })

    const response = await stream.finalMessage()

    // 마지막 text 블록에서 JSON 추출
    const textBlocks = response.content.filter((b) => b.type === 'text')
    const lastText = textBlocks[textBlocks.length - 1]
    if (!lastText || lastText.type !== 'text') {
      return NextResponse.json({ error: 'No text block in response', content: response.content }, { status: 500 })
    }

    let parsed: { trends: GeneratedTrend[] }
    try {
      const raw = lastText.text.trim()
      const start = raw.indexOf('{')
      const end = raw.lastIndexOf('}')
      if (start === -1 || end === -1) throw new Error('No JSON found')
      parsed = JSON.parse(raw.slice(start, end + 1))
    } catch (e) {
      return NextResponse.json(
        { error: 'JSON parse failed', detail: String(e), raw: lastText.text.slice(0, 500) },
        { status: 500 }
      )
    }

    const trends = parsed.trends
    if (!Array.isArray(trends) || trends.length === 0) {
      return NextResponse.json({ error: 'No trends in response' }, { status: 500 })
    }

    // 2. 이미지 수집 (og:image → Pexels fallback) — 전체 병렬 처리
    const imageData = await Promise.all(
      trends.map((t) =>
        collectImages(
          Array.isArray(t.related_sources) ? t.related_sources : [],
          t.image_search_keyword ?? t.title
        )
      )
    )

    // 3. Supabase에 저장
    const supabase = createServerClient()
    const rows = trends.map((t, i) => ({
      title: t.title,
      summary: t.summary,
      body: t.body ?? null,
      why_trending: t.why_trending ?? null,
      who_affected: t.who_affected ?? null,
      heat_score: Math.min(100, Math.max(1, Math.round(t.heat_score ?? 50))),
      category: CATEGORIES.includes(t.category) ? t.category : '라이프',
      tags: Array.isArray(t.tags) ? t.tags.slice(0, 5) : [],
      source_url: t.related_sources?.[0]?.url ?? null,
      related_sources: Array.isArray(t.related_sources) ? t.related_sources : [],
      image_search_keyword: t.image_search_keyword ?? null,
      image_url: imageData[i].image_url,
      gallery_images: imageData[i].gallery_images,
      published_at: new Date().toISOString(),
    }))

    const { data, error } = await supabase.from('trends').insert(rows).select()
    if (error) {
      return NextResponse.json({ error: error.message, rows }, { status: 500 })
    }

    const withImages = (data as Array<{ image_url: string | null }>).filter((r) => r.image_url).length
    const withBody = (data as Array<{ body: string | null }>).filter((r) => r.body).length

    return NextResponse.json({
      success: true,
      count: data.length,
      withImages,
      withBody,
      trends: data,
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
