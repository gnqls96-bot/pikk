import { NextRequest, NextResponse } from 'next/server'

export const runtime = 'nodejs'
export const maxDuration = 300
export const dynamic = 'force-dynamic'

const IG_API = 'https://graph.instagram.com/v21.0'
const CARD_BASE = 'https://fliqk.vercel.app/api/instagram-card'

function log(msg: string, data?: unknown) {
  console.log(JSON.stringify({ ts: new Date().toISOString(), route: 'instagram-daily', msg, ...(data != null ? { data } : {}) }))
}

// ── Types ────────────────────────────────────────────────────────────────────
interface IgError {
  message: string
  code?: number
  type?: string
  error_subcode?: number
  error_user_msg?: string
  fbtrace_id?: string
}
interface IgResult { id?: string; error?: IgError }

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

// ── Supabase ─────────────────────────────────────────────────────────────────
function sbHeaders() {
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? ''
  return { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }
}

// Oldest unpublished trend across all time (unlike instagram-publish which limits to 24h)
async function fetchOldestUnpublished(): Promise<TrendRow | null> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  if (!url) return null
  const res = await fetch(
    `${url}/rest/v1/trends?instagram_post_id=is.null&select=id,title,summary,body,category,tags,instagram_post_id,published_at&order=published_at.asc&limit=1`,
    { headers: sbHeaders(), signal: AbortSignal.timeout(8000) }
  )
  if (!res.ok) { log('fetchOldestUnpublished error', await res.text()); return null }
  const rows: TrendRow[] = await res.json()
  return rows[0] ?? null
}

async function markPublished(trendId: string, postId: string) {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  if (!url) return
  const res = await fetch(`${url}/rest/v1/trends?id=eq.${trendId}`, {
    method: 'PATCH',
    headers: { ...sbHeaders(), Prefer: 'return=minimal' },
    body: JSON.stringify({ instagram_post_id: postId }),
    signal: AbortSignal.timeout(8000),
  })
  if (!res.ok) log('markPublished error', { trendId, postId, err: await res.text() })
}

// ── Instagram API helpers ────────────────────────────────────────────────────
async function igPost(path: string, body: Record<string, string>): Promise<IgResult> {
  const token = process.env.INSTAGRAM_ACCESS_TOKEN ?? ''
  const res = await fetch(`${IG_API}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...body, access_token: token }),
    signal: AbortSignal.timeout(30000),
  })
  const json: IgResult = await res.json()
  if (!res.ok && !json.error) json.error = { message: `HTTP ${res.status}`, code: res.status }
  return json
}


async function waitForFinished(containerId: string, label: string, timeoutMs = 90000): Promise<boolean> {
  const token = process.env.INSTAGRAM_ACCESS_TOKEN ?? ''
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 4000))
    const res = await fetch(
      `${IG_API}/${containerId}?fields=status_code&access_token=${token}`,
      { signal: AbortSignal.timeout(10000) }
    )
    const data: { status_code?: string; error?: IgError } = await res.json()
    log(`${label} status`, { containerId, status_code: data.status_code })
    if (data.status_code === 'FINISHED') return true
    if (data.status_code === 'ERROR' || data.status_code === 'EXPIRED') {
      log(`${label} failed state`, { containerId, status_code: data.status_code })
      return false
    }
  }
  log(`${label} timeout`, { containerId })
  return false
}

// Returns null (with blocked flag) if code=4 detected
async function createCarouselItem(
  accountId: string,
  imageUrl: string,
): Promise<{ id: string | null; blocked?: boolean }> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const data = await igPost(`/${accountId}/media`, { image_url: imageUrl, is_carousel_item: 'true' })
    if (data.id) return { id: data.id }
    if (data.error?.code === 4) return { id: null, blocked: true }
    log('createCarouselItem failed', { attempt, igError: data.error })
    await new Promise(r => setTimeout(r, 2000 * (attempt + 1)))
  }
  return { id: null }
}

async function createCarousel(accountId: string, childrenIds: string[], caption: string): Promise<string | null> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const data = await igPost(`/${accountId}/media`, {
      media_type: 'CAROUSEL',
      children: childrenIds.join(','),
      caption,
    })
    if (data.id) return data.id
    log('createCarousel failed', { attempt, igError: data.error })
    await new Promise(r => setTimeout(r, 2000 * (attempt + 1)))
  }
  return null
}

async function publishMedia(
  accountId: string,
  creationId: string,
): Promise<{ id: string | null; igError?: IgError }> {
  let lastIgError: IgError | undefined
  for (let attempt = 0; attempt < 2; attempt++) {
    const data = await igPost(`/${accountId}/media_publish`, { creation_id: creationId })
    if (data.id) return { id: data.id }
    lastIgError = data.error
    if (data.error?.code === 4) break  // action blocked — don't retry
    log('publishMedia failed', { attempt, igError: data.error })
    await new Promise(r => setTimeout(r, 5000))
  }
  return { id: null, igError: lastIgError }
}

// ── Caption ───────────────────────────────────────────────────────────────────
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
  const tags = (trend.tags ?? []).map((t: string) => `#${t.replace(/\s+/g, '')}`).join(' ')
  return [
    trend.title, '',
    trend.summary, '',
    '나중에 다시 보고 싶다면 저장해두세요 📌', '',
    'fliqk.app에서 전체 이야기 확인하세요 🔗 링크는 프로필에!', '',
    '이 트렌드에 대해 어떻게 생각하시나요? 댓글로 알려주세요 💬', '',
    `#플릭 #fliqk #트렌드 #${trend.category} ${tags}`,
  ].join('\n')
}

// ── Core publish ──────────────────────────────────────────────────────────────
async function publishTrend(trend: TrendRow): Promise<{
  success: boolean
  postId?: string
  error?: string
  blocked?: boolean
}> {
  const accountId = process.env.INSTAGRAM_BUSINESS_ACCOUNT_ID ?? ''
  if (!accountId || !process.env.INSTAGRAM_ACCESS_TOKEN) {
    return { success: false, error: 'Instagram 자격증명 미설정' }
  }

  log('publishTrend start', { trendId: trend.id, title: trend.title })

  // 1. Probe slide count
  let totalSlides = 3
  for (let n = 5; n >= 4; n--) {
    const probe = await fetch(`${CARD_BASE}/${trend.id}/${n}`, { method: 'HEAD', signal: AbortSignal.timeout(10000) })
    if (probe.ok) { totalSlides = n; break }
  }
  log('totalSlides', { totalSlides })

  // 2. Create carousel items
  const childrenIds: string[] = []
  for (let slide = 1; slide <= totalSlides; slide++) {
    const { id, blocked: itemBlocked } = await createCarouselItem(accountId, `${CARD_BASE}/${trend.id}/${slide}`)
    if (itemBlocked) return { success: false, blocked: true, error: `슬라이드 ${slide} 생성 단계에서 action blocked` }
    if (!id) return { success: false, error: `슬라이드 ${slide} 컨테이너 생성 실패` }
    childrenIds.push(id)
  }

  // 3. Wait for each item to reach FINISHED
  for (let i = 0; i < childrenIds.length; i++) {
    const ready = await waitForFinished(childrenIds[i], `slide${i + 1}`)
    if (!ready) return { success: false, error: `슬라이드 ${i + 1} FINISHED 대기 실패` }
  }

  // 4. Caption
  const caption = await generateCaption(trend)
  log('caption generated', { length: caption.length })

  // 5. Create carousel container
  const carouselId = await createCarousel(accountId, childrenIds, caption)
  if (!carouselId) return { success: false, error: '캐러셀 컨테이너 생성 실패' }

  // 6. Wait for carousel to reach FINISHED
  const carouselReady = await waitForFinished(carouselId, 'carousel')
  if (!carouselReady) return { success: false, error: '캐러셀 FINISHED 대기 실패' }

  // 7. Publish
  const { id: postId, igError } = await publishMedia(accountId, carouselId)
  if (!postId) {
    const isBlocked = igError?.code === 4
    const igMsg = igError
      ? `[ig code=${igError.code ?? '?'} sub=${igError.error_subcode ?? '-'}] ${igError.message}`
      : '알 수 없음'
    return { success: false, blocked: isBlocked, error: `발행 실패: ${igMsg}` }
  }

  // 8. Record in DB immediately after success
  await markPublished(trend.id, postId)
  log('publishTrend success', { trendId: trend.id, postId })
  return { success: true, postId }
}

// ── Route handler ─────────────────────────────────────────────────────────────
// GET /api/instagram-daily?secret=CRON_SECRET
// Called daily by cron-job.org at 06:00 KST (21:00 UTC).
// Flow: (1) account check → (2) block check → (3) publish oldest unpublished trend.
// Logs every step so status can be queried at any time.
export async function GET(req: NextRequest) {
  if (process.env.AUTO_PUBLISH_ENABLED !== '1') {
    return NextResponse.json({ paused: true, reason: 'AUTO_PUBLISH_ENABLED != 1' }, { status: 503 })
  }
  const secret = req.nextUrl.searchParams.get('secret')
  if (secret !== process.env.CRON_SECRET && secret !== process.env.ADMIN_PASSWORD) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  log('daily run start')

  // ── Step 1: Account health check ──────────────────────────────────────────
  const token = process.env.INSTAGRAM_ACCESS_TOKEN ?? ''
  const accountId = process.env.INSTAGRAM_BUSINESS_ACCOUNT_ID ?? ''
  if (!token || !accountId) {
    log('credentials missing')
    return NextResponse.json({ error: 'Instagram 자격증명 미설정' }, { status: 500 })
  }

  const acctRes = await fetch(
    `${IG_API}/${accountId}?fields=id,username,media_count&access_token=${token}`,
    { signal: AbortSignal.timeout(10000) }
  )
  const acctData = await acctRes.json()
  log('account check', { ok: acctRes.ok, username: acctData.username, media_count: acctData.media_count, igError: acctData.error })

  if (!acctRes.ok) {
    return NextResponse.json({ error: 'account check failed', detail: acctData.error }, { status: 500 })
  }

  // ── Step 2: Find oldest unpublished trend ────────────────────────────────
  const trend = await fetchOldestUnpublished()
  if (!trend) {
    log('no unpublished trends')
    return NextResponse.json({
      noTrends: true,
      ts: new Date().toISOString(),
      account: { username: acctData.username, media_count: acctData.media_count },
    })
  }
  log('trend selected', { trendId: trend.id, title: trend.title, published_at: trend.published_at })

  // ── Step 3: Publish (block detection happens here via code=4) ─────────────
  const result = await publishTrend(trend)

  if (!result.success) {
    log('publish failed', { trendId: trend.id, title: trend.title, error: result.error, blocked: result.blocked })
    if (result.blocked) {
      return NextResponse.json({
        blocked: true,
        error: result.error,
        trendId: trend.id,
        title: trend.title,
      })
    }
    return NextResponse.json({ error: result.error, trendId: trend.id, title: trend.title }, { status: 500 })
  }

  log('daily publish success', { trendId: trend.id, title: trend.title, postId: result.postId })
  return NextResponse.json({
    success: true,
    ts: new Date().toISOString(),
    trendId: trend.id,
    title: trend.title,
    postId: result.postId,
    account: { username: acctData.username, media_count: acctData.media_count + 1 },
  })
}
