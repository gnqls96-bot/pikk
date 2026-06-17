import { NextRequest, NextResponse } from 'next/server'
import Anthropic from '@anthropic-ai/sdk'

function checkAuth(req: NextRequest) {
  return req.headers.get('x-admin-token') === process.env.ADMIN_PASSWORD
}

// 본문 기반 핵심 요약 재생성
// POST { ids?: string[], dryRun?: boolean }
// ids 생략 시 전체 트렌드 대상
export async function POST(req: NextRequest) {
  if (!checkAuth(req)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = await req.json().catch(() => ({}))
  const dryRun = body.dryRun === true

  const SURL = process.env.NEXT_PUBLIC_SUPABASE_URL!
  const SKEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  const headers = {
    apikey: SKEY,
    Authorization: `Bearer ${SKEY}`,
    'Content-Type': 'application/json',
    Prefer: 'return=representation',
  }

  // 대상 트렌드 조회
  let url = `${SURL}/rest/v1/trends?select=id,title,body,why_trending,who_affected,category&order=published_at.desc`
  if (Array.isArray(body.ids) && body.ids.length > 0) {
    url += `&id=in.(${body.ids.map((id: string) => `"${id}"`).join(',')})`
  }
  const fetchRes = await fetch(url, { headers })
  if (!fetchRes.ok) return NextResponse.json({ error: 'DB fetch failed' }, { status: 500 })
  const trends: Array<{ id: string; title: string; body: string | null; why_trending: string | null; who_affected: string | null; category: string }> = await fetchRes.json()

  if (!process.env.ANTHROPIC_API_KEY) {
    return NextResponse.json({ error: 'ANTHROPIC_API_KEY not set' }, { status: 500 })
  }
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

  const results: Array<{ id: string; title: string; old_summary?: string; new_summary: string; status: string }> = []

  for (const trend of trends) {
    if (!trend.body || trend.body.trim().length < 100) {
      results.push({ id: trend.id, title: trend.title, new_summary: '', status: 'SKIP: 본문 없음' })
      continue
    }

    const prompt = `아래는 트렌드 기사의 제목과 본문이다. 본문만을 기반으로 독자가 클릭하고 싶어지는 핵심 요약을 작성하라.

제목: ${trend.title}
카테고리: ${trend.category}

본문:
${trend.body.slice(0, 2000)}

${trend.why_trending ? `왜 화제인가: ${trend.why_trending}` : ''}

[요약 규칙 — 반드시 준수]
1. 정확히 2~3줄 (각 줄을 \\n으로 구분)
2. 첫 줄: 무엇이 일어났는지 — 구체적 브랜드명/수치/고유명사 포함 (제목 그대로 복사 금지)
3. 둘째 줄: 왜 화제인지 / 트렌드인 이유 — 수치나 맥락 포함
4. 셋째 줄(선택): 본문에만 있는 구체적 디테일 1가지 (없으면 생략)
5. 각 줄은 30~70자 이내
6. 마케팅 문구, 광고 언어, 모호한 표현 금지
7. 반드시 본문 정보를 사용할 것 — 추측/일반론 금지
8. JSON 없이 요약 텍스트만 반환`

    try {
      const msg = await client.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 300,
        messages: [{ role: 'user', content: prompt }],
      })
      const newSummary = (msg.content[0] as { type: string; text: string }).text.trim()

      if (!dryRun) {
        await fetch(`${SURL}/rest/v1/trends?id=eq.${trend.id}`, {
          method: 'PATCH',
          headers,
          body: JSON.stringify({ summary: newSummary }),
        })
      }

      results.push({ id: trend.id, title: trend.title, new_summary: newSummary, status: dryRun ? 'DRY_RUN' : 'UPDATED' })
    } catch (e) {
      results.push({ id: trend.id, title: trend.title, new_summary: '', status: `ERROR: ${String(e).slice(0, 100)}` })
    }
  }

  return NextResponse.json({ success: true, dryRun, count: results.length, results })
}
