import { NextRequest, NextResponse } from 'next/server'

export const runtime = 'nodejs'
export const maxDuration = 300

const IG_API = 'https://graph.instagram.com/v21.0'
const CARD_BASE = 'https://fliqk.vercel.app/api/instagram-card'

function log(msg: string, data?: unknown) {
  console.log(JSON.stringify({ ts: new Date().toISOString(), msg, ...(data != null ? { data } : {}) }))
}

// ── Types ───────────────────────────────────────────────────────────────────
interface TrendRow {
  id: string
  title: string
  summary: string
  body: string | null
  category: string
  tags: string[]
  instagram_post_id: string | null
  published_at: string
}

// ── Supabase helpers ─────────────────────────────────────────────────────────
function sbHeaders() {
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? ''
  return { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }
}

async function fetchTodayTrends(): Promise<TrendRow[]> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  if (!url) return []
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
  // Try with instagram_post_id first; fall back without it if column missing
  for (const cols of [
    'id,title,summary,body,category,tags,instagram_post_id,published_at',
    'id,title,summary,body,category,tags,published_at',
  ]) {
    const res = await fetch(
      `${url}/rest/v1/trends?published_at=gte.${since}&select=${cols}&order=published_at.asc`,
      { headers: sbHeaders(), signal: AbortSignal.timeout(8000) }
    )
    if (res.ok) {
      const rows: TrendRow[] = await res.json()
      return rows
    }
    const errText = await res.text()
    if (!errText.includes('instagram_post_id')) {
      log('fetchTodayTrends error', errText)
      return []
    }
    log('instagram_post_id column missing, retrying without it')
  }
  return []
}

async function countTodayInstagramPosts(): Promise<number> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  if (!url) return 0
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
  const res = await fetch(
    `${url}/rest/v1/trends?instagram_post_id=not.is.null&published_at=gte.${since}&select=id`,
    { headers: sbHeaders(), signal: AbortSignal.timeout(8000) }
  )
  if (!res.ok) return 0  // column missing → treat as 0 published
  const rows: unknown[] = await res.json()
  return rows.length
}

async function markPublished(trendId: string, postId: string) {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  if (!url) return
  const res = await fetch(
    `${url}/rest/v1/trends?id=eq.${trendId}`,
    {
      method: 'PATCH',
      headers: { ...sbHeaders(), Prefer: 'return=minimal' },
      body: JSON.stringify({ instagram_post_id: postId }),
      signal: AbortSignal.timeout(8000),
    }
  )
  if (!res.ok) {
    const err = await res.text()
    log('markPublished error (column may be missing)', { trendId, postId, err })
  }
}

// ── Instagram Graph API helpers ──────────────────────────────────────────────
async function igPost(path: string, body: Record<string, string>): Promise<{ id?: string; error?: { message: string } }> {
  const token = process.env.INSTAGRAM_ACCESS_TOKEN ?? ''
  const res = await fetch(`${IG_API}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...body, access_token: token }),
    signal: AbortSignal.timeout(30000),
  })
  return res.json()
}

async function createCarouselItem(accountId: string, imageUrl: string): Promise<string | null> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const data = await igPost(`/${accountId}/media`, {
      image_url: imageUrl,
      is_carousel_item: 'true',
    })
    if (data.id) return data.id
    log('createCarouselItem failed', { attempt, imageUrl, error: data.error?.message })
    await new Promise(r => setTimeout(r, 2000 * (attempt + 1)))
  }
  return null
}

async function createCarousel(accountId: string, childrenIds: string[], caption: string): Promise<string | null> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const data = await igPost(`/${accountId}/media`, {
      media_type: 'CAROUSEL',
      children: childrenIds.join(','),
      caption,
    })
    if (data.id) return data.id
    log('createCarousel failed', { attempt, error: data.error?.message })
    await new Promise(r => setTimeout(r, 2000 * (attempt + 1)))
  }
  return null
}

async function publishMedia(accountId: string, creationId: string): Promise<string | null> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const data = await igPost(`/${accountId}/media_publish`, { creation_id: creationId })
    if (data.id) return data.id
    log('publishMedia failed', { attempt, error: data.error?.message })
    await new Promise(r => setTimeout(r, 3000 * (attempt + 1)))
  }
  return null
}

// ── Caption generation ───────────────────────────────────────────────────────
async function generateCaption(trend: TrendRow): Promise<string> {
  const apiKey = process.env.ANTHROPIC_API_KEY ?? ''
  if (!apiKey) return defaultCaption(trend)

  const prompt = `당신은 인스타그램 알고리즘과 콘텐츠 전략을 잘 아는 전문가입니다. 아래 트렌드 정보를 바탕으로 인스타그램 캡션을 작성해주세요.

트렌드 제목: ${trend.title}
카테고리: ${trend.category}
요약: ${trend.summary}
태그: ${(trend.tags ?? []).join(', ')}

다음 형식으로 정확히 작성하세요:
1. 첫 줄: 호기심을 자극하는 후킹 문장 (질문형 또는 충격적 사실, 이모지 포함)
2. 빈 줄
3. 핵심 내용 2-3줄 (카드뉴스와 중복되지 않게, 더 보고 싶게 만드는 내용)
4. 빈 줄
5. 저장 유도 문구 1줄: 이 트렌드의 성격과 톤에 맞게 자연스럽게 변형. 아래 패턴을 참고해 매번 다르게 작성 (그대로 복사 금지):
   - "나중에 다시 보고 싶다면 저장해두세요 📌"
   - "놓치기 아까운 트렌드라면 저장 먼저 🔖"
   - "팔로워한테 공유하기 전에 저장해두세요 📌"
   - "이 흐름 계속 따라가고 싶다면 저장하세요 🔖"
6. 빈 줄
7. CTA 문구 (고정, 반드시 그대로): "fliqk.app에서 전체 이야기 확인하세요 🔗 링크는 프로필에!"
8. 빈 줄
9. 댓글 유도 질문 1줄: 이 트렌드의 주제에 맞는 구체적인 질문. 일반적인 "어떻게 생각하세요?" 반복 금지. 독자가 짧게라도 대답하고 싶어지는 질문으로 작성 (이모지 포함).
10. 빈 줄
11. 해시태그 10-15개 (관련 키워드, 카테고리, 트렌드 태그 포함)

해시태그는 #플릭 #fliqk #트렌드 를 반드시 포함하고, 카테고리와 주제 관련 태그를 추가하세요.
응답은 캡션 텍스트만 출력하세요. 번호나 설명 없이 캡션 내용만.`

  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 800,
        messages: [{ role: 'user', content: prompt }],
      }),
      signal: AbortSignal.timeout(20000),
    })
    if (!res.ok) return defaultCaption(trend)
    const data = await res.json()
    return data.content?.[0]?.text?.trim() ?? defaultCaption(trend)
  } catch {
    return defaultCaption(trend)
  }
}

function defaultCaption(trend: TrendRow): string {
  const tags = (trend.tags ?? []).map(t => `#${t.replace(/\s+/g, '')}`).join(' ')
  return [
    trend.title,
    '',
    trend.summary,
    '',
    '나중에 다시 보고 싶다면 저장해두세요 📌',
    '',
    'fliqk.app에서 전체 이야기 확인하세요 🔗 링크는 프로필에!',
    '',
    '이 트렌드에 대해 어떻게 생각하시나요? 댓글로 알려주세요 💬',
    '',
    `#플릭 #fliqk #트렌드 #${trend.category} ${tags}`,
  ].join('\n')
}

// ── Core publish logic ───────────────────────────────────────────────────────
async function publishTrend(trend: TrendRow): Promise<{ success: boolean; postId?: string; caption?: string; error?: string }> {
  const accountId = process.env.INSTAGRAM_BUSINESS_ACCOUNT_ID ?? ''
  if (!accountId) return { success: false, error: 'INSTAGRAM_BUSINESS_ACCOUNT_ID 미설정' }
  if (!process.env.INSTAGRAM_ACCESS_TOKEN) return { success: false, error: 'INSTAGRAM_ACCESS_TOKEN 미설정' }

  log('publishTrend start', { trendId: trend.id, title: trend.title })

  // 1. Determine actual slide count for this trend (cover + content + CTA = 3–5)
  let totalSlides = 3
  for (let n = 5; n >= 4; n--) {
    const probe = await fetch(`${CARD_BASE}/${trend.id}/${n}`, { method: 'HEAD', signal: AbortSignal.timeout(10000) })
    if (probe.ok) { totalSlides = n; break }
  }
  log('totalSlides', { totalSlides })

  const childrenIds: string[] = []
  for (let slide = 1; slide <= totalSlides; slide++) {
    const imageUrl = `${CARD_BASE}/${trend.id}/${slide}`
    log('createCarouselItem', { slide, imageUrl })
    const id = await createCarouselItem(accountId, imageUrl)
    if (!id) return { success: false, error: `슬라이드 ${slide} 컨테이너 생성 실패` }
    childrenIds.push(id)
  }

  // 2. Generate caption
  const caption = await generateCaption(trend)
  log('caption generated', { length: caption.length })

  // 3. Create carousel container
  const carouselId = await createCarousel(accountId, childrenIds, caption)
  if (!carouselId) return { success: false, error: '캐러셀 컨테이너 생성 실패', caption }

  // 4. Publish
  const postId = await publishMedia(accountId, carouselId)
  if (!postId) return { success: false, error: '미디어 발행 실패', caption }

  // 5. Record in Supabase
  await markPublished(trend.id, postId)
  log('publishTrend success', { trendId: trend.id, postId })

  return { success: true, postId, caption }
}

// ── Route handlers ───────────────────────────────────────────────────────────

// POST /api/instagram-publish
// Body: { trendId?: string }  -- publish specific trend or pick first unpublished
// Query: secret=CRON_SECRET
// AUTO_PUBLISH_ENABLED=1 이 설정되지 않으면 Instagram 발행이 차단됩니다.
// 재개 방법: Vercel 환경 변수에 AUTO_PUBLISH_ENABLED=1 추가 후 재배포.
//           cron-job.org 9개 스케줄도 resume 필요.
export async function POST(req: NextRequest) {
  if (process.env.AUTO_PUBLISH_ENABLED !== '1') {
    return NextResponse.json({ paused: true, reason: 'brand conflict — set AUTO_PUBLISH_ENABLED=1 to resume' }, { status: 503 })
  }
  const secret = req.nextUrl.searchParams.get('secret')
  if (secret !== process.env.CRON_SECRET && secret !== process.env.ADMIN_PASSWORD) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const accountId = process.env.INSTAGRAM_BUSINESS_ACCOUNT_ID ?? ''
  const token = process.env.INSTAGRAM_ACCESS_TOKEN ?? ''
  if (!accountId || !token) {
    return NextResponse.json({ error: 'Instagram credentials not configured' }, { status: 500 })
  }

  // Rate limit check: Instagram allows 25 posts per 24h
  const todayCount = await countTodayInstagramPosts()
  if (todayCount >= 25) {
    log('rate limit reached', { todayCount })
    return NextResponse.json({ error: '일일 발행 한도(25개) 초과', todayCount }, { status: 429 })
  }

  let body: { trendId?: string; preview?: boolean } = {}
  try { body = await req.json() } catch { /* no body */ }

  const trends = await fetchTodayTrends()
  if (trends.length === 0) {
    return NextResponse.json({ error: '오늘 발행된 트렌드 없음' }, { status: 404 })
  }

  let trend: TrendRow | undefined
  if (body.trendId) {
    trend = trends.find(t => t.id === body.trendId)
    if (!trend) return NextResponse.json({ error: `트렌드 ${body.trendId} 없음` }, { status: 404 })
  } else {
    trend = trends.find(t => !t.instagram_post_id)
    if (!trend) return NextResponse.json({ error: '발행되지 않은 트렌드 없음', todayCount }, { status: 200 })
  }

  // preview mode: generate caption only, no actual publish
  if (body.preview) {
    const caption = await generateCaption(trend)
    return NextResponse.json({ preview: true, trendId: trend.id, title: trend.title, caption })
  }

  const result = await publishTrend(trend)
  if (!result.success) {
    log('publishTrend failed', result)
    return NextResponse.json({ error: result.error, caption: result.caption }, { status: 500 })
  }

  return NextResponse.json({
    success: true,
    trendId: trend.id,
    title: trend.title,
    postId: result.postId,
    caption: result.caption,
    todayCount: todayCount + 1,
  })
}

// GET /api/instagram-publish
// Query: secret=CRON_SECRET&slot=0-8
// External cron service calls this at 6:00, 6:30, 7:00 ... 10:00 KST
// slot=0 → publish 1st trend, slot=1 → 2nd trend, etc.
export async function GET(req: NextRequest) {
  if (process.env.AUTO_PUBLISH_ENABLED !== '1') {
    return NextResponse.json({ paused: true, reason: 'brand conflict — set AUTO_PUBLISH_ENABLED=1 to resume' }, { status: 503 })
  }
  const secret = req.nextUrl.searchParams.get('secret')
  if (secret !== process.env.CRON_SECRET && secret !== process.env.ADMIN_PASSWORD) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const slot = parseInt(req.nextUrl.searchParams.get('slot') ?? '0', 10)
  if (isNaN(slot) || slot < 0 || slot > 8) {
    return NextResponse.json({ error: 'slot must be 0-8' }, { status: 400 })
  }

  const accountId = process.env.INSTAGRAM_BUSINESS_ACCOUNT_ID ?? ''
  const token = process.env.INSTAGRAM_ACCESS_TOKEN ?? ''
  if (!accountId || !token) {
    return NextResponse.json({ error: 'Instagram credentials not configured' }, { status: 500 })
  }

  const todayCount = await countTodayInstagramPosts()
  if (todayCount >= 25) {
    return NextResponse.json({ error: '일일 발행 한도(25개) 초과', todayCount }, { status: 429 })
  }

  const trends = await fetchTodayTrends()
  if (slot >= trends.length) {
    return NextResponse.json({ skipped: true, reason: `slot ${slot} >= ${trends.length} trends today` })
  }

  const trend = trends[slot]
  if (trend.instagram_post_id) {
    return NextResponse.json({ skipped: true, reason: '이미 발행됨', postId: trend.instagram_post_id })
  }

  const result = await publishTrend(trend)
  if (!result.success) {
    return NextResponse.json({ error: result.error }, { status: 500 })
  }

  return NextResponse.json({
    success: true,
    slot,
    trendId: trend.id,
    title: trend.title,
    postId: result.postId,
    todayCount: todayCount + 1,
  })
}
