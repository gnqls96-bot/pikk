import { NextRequest, NextResponse } from 'next/server'
import type { Category } from '@/lib/types'

export const maxDuration = 30

function checkAuth(req: NextRequest) {
  return req.headers.get('x-admin-token') === process.env.ADMIN_PASSWORD
}

const VALID_CATS = new Set<string>([
  '푸드', '뷰티', 'SNS', '패션', '테크', '라이프', '디자인', '광고', '영상',
])

async function regenerateWithClaude(trend: {
  title: string
  original_title: string | null
  body: string | null
  source_url: string | null
  site_name: string
  category: string
}): Promise<{
  title: string; summary: string; body: string
  why_trending: string; who_affected: string
  tags: string[]; category: Category
} | null> {
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) return null

  const topic = trend.original_title ?? trend.title
  const existingBody = trend.body ? `현재 내용: ${trend.body.slice(0, 300)}` : ''

  const prompt = `당신은 전세계 트렌드를 분석하는 최고의 저널리스트입니다.
한국 독자들이 글로벌 트렌드를 깊이 이해할 수 있도록 심층 분석 기사를 작성합니다.

다음 트렌드에 대한 한국어 심층 기사를 작성하세요.
JSON만 출력하세요. 마크다운·설명 없이 순수 JSON만.

{"title":"독자가 클릭하고 싶은 강렬한 한국어 제목 (20-35자)","summary":"핵심 한 줄 요약 (50-80자)","body":"최소 1000자 한국어 심층 본문. 반드시 포함: 1)배경과 맥락 2)왜 지금 뜨는가(구체적 수치·사례) 3)글로벌 동향과 주요 플레이어 4)한국 시장 의미와 영향 5)앞으로의 전망","why_trending":"왜 지금 이 트렌드가 폭발적으로 주목받는가를 3줄 이상 구체적으로","who_affected":"이 트렌드에 주목해야 하는 사람들 구체적으로 (업계 관계자·소비자·투자자 등)","tags":["태그1","태그2","태그3","태그4","태그5"],"category":"테크|SNS|푸드|뷰티|패션|라이프|디자인|광고|영상 중 하나"}

트렌드: ${topic}
출처: ${trend.site_name}${trend.source_url ? ` (${trend.source_url})` : ''}
${existingBody}`

  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 4096,
        messages: [{ role: 'user', content: prompt }],
      }),
      signal: AbortSignal.timeout(25000),
    })
    if (!res.ok) return null
    const data = await res.json()
    const text: string = data.content?.[0]?.text ?? ''
    const jsonMatch = text.match(/\{[\s\S]*\}/)
    if (!jsonMatch) return null
    const p: Record<string, unknown> = JSON.parse(jsonMatch[0])
    return {
      title: String(p.title ?? topic).slice(0, 80),
      summary: String(p.summary ?? '').slice(0, 200),
      body: String(p.body ?? '').slice(0, 2000),
      why_trending: String(p.why_trending ?? '').slice(0, 500),
      who_affected: String(p.who_affected ?? '').slice(0, 300),
      tags: Array.isArray(p.tags) ? (p.tags as unknown[]).map(String).slice(0, 7) : [],
      category: (VALID_CATS.has(String(p.category)) ? String(p.category) : trend.category) as Category,
    }
  } catch {
    return null
  }
}

export async function POST(req: NextRequest) {
  if (!checkAuth(req)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { trendId } = await req.json()
  if (!trendId) return NextResponse.json({ error: 'Missing trendId' }, { status: 400 })

  const SURL = process.env.NEXT_PUBLIC_SUPABASE_URL!
  const SKEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  const headers = { apikey: SKEY, Authorization: `Bearer ${SKEY}` }

  const trendRes = await fetch(
    `${SURL}/rest/v1/trends?id=eq.${trendId}&select=id,title,original_title,body,source_url,related_sources,category`,
    { headers }
  )
  const [trend] = await trendRes.json()
  if (!trend) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const siteName =
    trend.related_sources?.[0]?.site_name ??
    (trend.source_url ? new URL(trend.source_url).hostname.replace(/^www\./, '') : 'Unknown')

  const generated = await regenerateWithClaude({ ...trend, site_name: siteName })
  if (!generated) return NextResponse.json({ error: 'Claude generation failed' }, { status: 500 })

  await fetch(`${SURL}/rest/v1/trends?id=eq.${trendId}`, {
    method: 'PATCH',
    headers: { ...headers, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
    body: JSON.stringify(generated),
  })

  return NextResponse.json({ success: true })
}
