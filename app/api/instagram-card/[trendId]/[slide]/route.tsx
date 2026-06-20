import { ImageResponse } from 'next/og'
import { NextRequest } from 'next/server'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// ── 디자인 상수 ────────────────────────────────────────────────
const SIZE = 1080
const BRAND_TEAL = '#4A90A4'
const BRAND_DARK = '#2C3E50'
const BRAND_WARM = '#F7F5F0'
const BRAND_PEACH = '#E8A87C'

const CATEGORY_COLORS: Record<string, string> = {
  '푸드': '#E74C3C', '뷰티': '#E91E8C', 'SNS': '#6C3CE1', '패션': '#27AE60',
  '테크': '#2980B9', '라이프': '#E8A87C', '디자인': '#8E44AD', 'KPOP': '#E040FB', '엔터': '#C0392B',
}
const CATEGORY_EMOJI: Record<string, string> = {
  '푸드': '🍜', '뷰티': '💄', 'SNS': '📱', '패션': '👗',
  '테크': '💻', '라이프': '✨', '디자인': '🎨', 'KPOP': '🎤', '엔터': '🎭',
}

// ── 폰트: Uint8Array로 캐싱 후 렌더마다 fresh ArrayBuffer 생성 ──
// Satori가 파싱 시 ArrayBuffer를 in-place 수정하므로 재사용 금지
let _fontBytes: Uint8Array | null = null

async function getKoreanFonts() {
  if (!_fontBytes) {
    const buf = await readFile(join(process.cwd(), 'public/fonts/NotoSansKR-Bold.ttf'))
    _fontBytes = new Uint8Array(buf)
  }
  const data = new ArrayBuffer(_fontBytes.byteLength)
  new Uint8Array(data).set(_fontBytes)
  return [{ name: 'NotoSansKR', data, weight: 700 as const, style: 'normal' as const }]
}

// ── Supabase 트렌드 조회 (body 포함) ─────────────────────────
interface TrendData {
  title: string
  summary: string | null
  body: string | null
  category: string
  image_url: string | null
  tags: string[]
}

async function fetchTrend(trendId: string): Promise<TrendData | null> {
  const SURL = process.env.NEXT_PUBLIC_SUPABASE_URL
  const SKEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  if (SURL && SKEY) {
    try {
      const res = await fetch(
        `${SURL}/rest/v1/trends?id=eq.${trendId}&select=title,summary,body,category,image_url,tags`,
        { headers: { apikey: SKEY, Authorization: `Bearer ${SKEY}` }, signal: AbortSignal.timeout(6000) }
      )
      if (!res.ok) return null
      const rows = await res.json()
      return rows[0] ?? null
    } catch { return null }
  }
  // 로컬 개발: Supabase 미설정 시 시드 데이터로 폴백
  const { seedTrends } = await import('@/lib/data/seed')
  return (seedTrends.find(t => t.id === trendId) as TrendData | undefined) ?? null
}

// ── 표지 이미지 합성: 블러 배경 + contain 전경 + 가장자리 페더링 ──────
// Satori가 CSS filter:blur를 미지원하므로 sharp로 서버사이드에서 선처리.
// 실패 시 원본 이미지 data URL로 폴백.
async function buildCoverCompositeDataUrl(imageUrl: string): Promise<string | null> {
  try {
    const res = await fetch(imageUrl, { signal: AbortSignal.timeout(8000) })
    if (!res.ok) return null
    const inputBuf = Buffer.from(await res.arrayBuffer())
    const { buildCoverComposite } = await import('@/lib/utils/buildCoverComposite')
    const composed = await buildCoverComposite(inputBuf, 1080, 1080, 28, 55)
    return `data:image/jpeg;base64,${composed.toString('base64')}`
  } catch (err) {
    console.error('[buildCoverComposite] sharp 실패, 원본 폴백:', err)
    try {
      const res = await fetch(imageUrl, { signal: AbortSignal.timeout(8000) })
      if (!res.ok) return null
      const buf = await res.arrayBuffer()
      const ct = res.headers.get('content-type') ?? 'image/jpeg'
      return `data:${ct};base64,${Buffer.from(buf).toString('base64')}`
    } catch { return null }
  }
}

// ── 따옴표 보호: 내부 공백을 NBSP로 치환 → 줄바꿈 시 분리 방지 ─────
function protectQuotes(text: string): string {
  return text
    .replace(/'([^']+)'/g,   (_, i) => `'${i.replace(/ /g, ' ')}'`)
    .replace(/"([^"]+)"/g,   (_, i) => `"${i.replace(/ /g, ' ')}"`)
    .replace(/「([^」]+)」/g, (_, i) => `「${i.replace(/ /g, ' ')}」`)
    .replace(/‘([^’]+)’/g, (_, i) => `‘${i.replace(/ /g, ' ')}’`)
    .replace(/“([^”]+)”/g, (_, i) => `“${i.replace(/ /g, ' ')}”`)
}

// ── 한국어 타이포그래피: ?·! 뒤 자연스러운 줄바꿈 분리 ──────────────
// . 은 인용 내부에서도 자주 등장해 분기 불안전 → ?! 만 사용
function smartBreak(text: string): string[] {
  const segments: string[] = []
  let cur = ''
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    cur += ch
    if ((ch === '?' || ch === '!') && text[i + 1] === ' ') {
      segments.push(cur.trim())
      cur = ''
      i++
    }
  }
  if (cur.trim()) segments.push(cur.trim())
  return segments.length > 1 ? segments : [text]
}

// ── 핵심 포인트 슬라이드 동적 폰트: 말줄임 없이 전체 표시 ──────────
function pointFontSize(len: number): number {
  if (len <= 50)  return 52
  if (len <= 80)  return 46
  if (len <= 120) return 40
  if (len <= 170) return 34
  if (len <= 230) return 29
  return 25
}

// ── 표지 제목 동적 폰트 ────────────────────────────────────────
function coverTitleFontSize(len: number): number {
  if (len <= 18) return 68
  if (len <= 28) return 60
  if (len <= 40) return 52
  if (len <= 55) return 44
  return 38
}

// ── CTA 제목 동적 폰트 ─────────────────────────────────────────
function ctaTitleFontSize(len: number): number {
  if (len <= 12) return 42
  if (len <= 20) return 36
  if (len <= 30) return 32
  if (len <= 42) return 28
  return 24
}

// ── 티저 문구: 첫 의미 단위 추출 (말줄임 없음) ─────────────────
function makeTeaserClause(text: string): string {
  if (text.length <= 28) return text
  const sub = text.slice(0, 34)
  const clauseMatch = sub.match(/^(.{12,})[,，、.。!?]/)
  if (clauseMatch) return clauseMatch[1]
  const lastSpace = sub.lastIndexOf(' ')
  return lastSpace > 8 ? sub.slice(0, lastSpace) : sub.slice(0, 28)
}

// ── 콘텐츠 포인트 추출 (placeholder 절대 불가) ────────────────
// 우선순위: ① 개행 구분 summary ② body 단락 ③ 문장 분리
function deriveContentPoints(summary: string | null, body: string | null): string[] {
  // ① summary를 \n으로 분리해서 2개 이상이면 바로 사용
  const sumLines = (summary ?? '')
    .split('\n')
    .map(s => s.trim().replace(/^[\-\*•·]\s*/, ''))
    .filter(s => s.length >= 15)

  if (sumLines.length >= 2) return sumLines.slice(0, 3)

  // ② body를 단락(\n 기준)으로 분리해서 내용 보충
  const bodyParas = (body ?? '')
    .split('\n')
    .map(s => s.trim())
    .filter(s => s.length >= 30 && s.length <= 250)

  const combined = [...sumLines, ...bodyParas]
  if (combined.length >= 2) return combined.slice(0, 3)

  // ③ 문장 단위로 자르기 (한/영 공통)
  const fullText = [(summary ?? ''), (body ?? '')].filter(Boolean).join(' ')
  const sents = fullText
    .replace(/\n+/g, ' ')
    .split(/(?<=[.!?。])\s+/)
    .map(s => s.trim())
    .filter(s => s.length >= 25 && s.length <= 200)

  if (sents.length >= 2) {
    // 90자 내외로 묶어 최대 3개 포인트 생성
    const chunks: string[] = []
    let cur = ''
    for (const sent of sents) {
      const joined = cur ? `${cur} ${sent}` : sent
      if (joined.length > 100 && cur) {
        chunks.push(cur.trim())
        cur = sent
      } else {
        cur = joined
      }
      if (chunks.length >= 3) break
    }
    if (cur && chunks.length < 3) chunks.push(cur.trim())
    if (chunks.length >= 1) return chunks.slice(0, 3)
  }

  // ④ 최후 수단: summary or title fragment
  return [(sumLines[0] ?? summary ?? '').slice(0, 200)].filter(Boolean)
}

// ── 발행 직전 카드 텍스트 품질 로깅 ─────────────────────────────────
function validateCardContent(title: string, points: string[]): void {
  if (/…$|\.{2,}$/.test(title.trim())) console.warn('[Card] 제목 말줄임표:', title)
  for (const p of points) {
    if (/…$|\.{2,}$/.test(p)) console.warn('[Card] 포인트 말줄임표:', p.slice(-30))
    const sq = (p.match(/['']/g) ?? []).length
    const dq = (p.match(/[""]/g) ?? []).length
    if (sq % 2 !== 0) console.warn('[Card] 홑따옴표 짝 불일치:', p.slice(0, 60))
    if (dq % 2 !== 0) console.warn('[Card] 겹따옴표 짝 불일치:', p.slice(0, 60))
  }
}

// ═══════════════════════════════════════════════════════════════
// 슬라이드 컴포넌트
// ═══════════════════════════════════════════════════════════════

// ── Slide 1: 표지 ─────────────────────────────────────────────
// bgData = sharp로 미리 합성한 1080×1080 JPEG data URL
// (블러 배경 + 선명 전경 + 가장자리 페더링 완료)
function Slide1Cover({
  title, category, catColor, catEmoji, bgData, teaser,
}: {
  title: string; category: string; catColor: string
  catEmoji: string; bgData: string | null; teaser: string
}) {
  const titleLines = smartBreak(protectQuotes(title))
  const titleStyle = {
    color: 'white' as const, fontSize: coverTitleFontSize(title.length),
    fontWeight: 700, lineHeight: 1.25, wordBreak: 'keep-all' as const,
  }

  return (
    <div style={{
      width: SIZE, height: SIZE, display: 'flex', flexDirection: 'column',
      position: 'relative', overflow: 'hidden',
      background: `linear-gradient(160deg, ${catColor}BB 0%, ${BRAND_DARK} 100%)`,
      fontFamily: 'NotoSansKR',
    }}>
      {/* 합성된 배경 이미지 (블러+선명 합성 1080×1080) */}
      {bgData && (
        <img
          src={bgData}
          width={SIZE}
          height={SIZE}
          style={{ position: 'absolute', top: 0, left: 0, objectFit: 'fill' }}
        />
      )}

      {/* 비네트: 상단 */}
      <div style={{
        position: 'absolute', top: 0, left: 0, width: SIZE, height: 220,
        background: 'linear-gradient(to bottom, rgba(0,0,0,0.50) 0%, rgba(0,0,0,0) 100%)',
      }} />
      {/* 비네트: 좌측 */}
      <div style={{
        position: 'absolute', top: 0, left: 0, width: 200, height: SIZE,
        background: 'linear-gradient(to right, rgba(0,0,0,0.30) 0%, rgba(0,0,0,0) 100%)',
      }} />
      {/* 비네트: 우측 */}
      <div style={{
        position: 'absolute', top: 0, right: 0, width: 200, height: SIZE,
        background: 'linear-gradient(to left, rgba(0,0,0,0.30) 0%, rgba(0,0,0,0) 100%)',
      }} />

      {/* 텍스트 가독성: 하단 강한 그라데이션 */}
      <div style={{
        position: 'absolute', bottom: 0, left: 0, width: SIZE, height: 600,
        background: 'linear-gradient(to top, rgba(0,0,0,0.95) 0%, rgba(0,0,0,0.65) 40%, rgba(0,0,0,0) 100%)',
      }} />

      {/* 상단 브랜드 바 */}
      <div style={{
        position: 'absolute', top: 56, left: 64, right: 64,
        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
      }}>
        <div style={{
          background: catColor, color: 'white',
          padding: '10px 28px', borderRadius: 40, fontSize: 28, fontWeight: 700,
          display: 'flex', alignItems: 'center', gap: 8,
        }}>
          <span>{catEmoji}</span>
          <span>{category}</span>
        </div>
        <div style={{ color: 'rgba(255,255,255,0.8)', fontSize: 26, fontWeight: 700, letterSpacing: 2 }}>
          FLIQK
        </div>
      </div>

      {/* 하단 텍스트 블록 */}
      <div style={{
        position: 'absolute', bottom: 0, left: 0, right: 0,
        display: 'flex', flexDirection: 'column', gap: 20,
        padding: '0 64px 72px',
      }}>
        <div style={{
          color: BRAND_PEACH, fontSize: 30, fontWeight: 700,
          display: 'flex', alignItems: 'center', gap: 10,
        }}>
          <span>⚡</span>
          <span>{teaser}</span>
        </div>
        {titleLines.length === 1
          ? <div style={titleStyle}>{titleLines[0]}</div>
          : <div style={{ display: 'flex' as const, flexDirection: 'column' as const }}>
              {titleLines.map((line, i) => <div key={i} style={titleStyle}>{line}</div>)}
            </div>
        }
        <div style={{ color: 'rgba(255,255,255,0.4)', fontSize: 23, letterSpacing: 1 }}>
          fliqk.app · 트렌드를 가장 먼저
        </div>
      </div>
    </div>
  )
}

// ── Slides 2~N: 핵심 포인트 (동일 템플릿) ─────────────────────
function SlideKeyPoint({
  category, catEmoji, catColor, slideNum, totalSlides, point, pointIndex,
}: {
  category: string; catEmoji: string; catColor: string
  slideNum: number; totalSlides: number; point: string; pointIndex: number
}) {
  const nums = ['01', '02', '03', '04']
  const num = nums[pointIndex] ?? `0${pointIndex + 1}`

  return (
    <div style={{
      width: SIZE, height: SIZE, display: 'flex', flexDirection: 'column',
      background: `linear-gradient(150deg, #3A7D91 0%, ${BRAND_TEAL} 45%, #1D5F72 100%)`,
      padding: '64px 72px', fontFamily: 'NotoSansKR',
      justifyContent: 'space-between',
    }}>
      {/* 헤더 */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div style={{
          display: 'flex', alignItems: 'center', gap: 10,
          background: 'rgba(255,255,255,0.12)', padding: '8px 22px', borderRadius: 30,
          color: 'rgba(255,255,255,0.85)', fontSize: 26, fontWeight: 700,
        }}>
          <span>{catEmoji}</span>
          <span>{category}</span>
        </div>
        <div style={{ color: 'rgba(255,255,255,0.5)', fontSize: 26, fontWeight: 700 }}>
          {`${slideNum}/${totalSlides}`}
        </div>
      </div>

      {/* 핵심 내용 */}
      <div style={{
        display: 'flex', flexDirection: 'column', gap: 32,
        flex: 1, justifyContent: 'center',
      }}>
        {/* 번호 + 구분선 */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 20 }}>
          <div style={{
            color: BRAND_PEACH, fontSize: 88, fontWeight: 700,
            lineHeight: 1, letterSpacing: -2,
          }}>
            {num}
          </div>
          <div style={{ flex: 1, height: 3, background: `${BRAND_PEACH}55`, borderRadius: 2 }} />
        </div>

        {/* 포인트 텍스트 — 동적 폰트, 말줄임 없음 */}
        <div style={{
          color: 'white', fontSize: pointFontSize(point.length), fontWeight: 700,
          lineHeight: point.length > 100 ? 1.4 : 1.55, wordBreak: 'keep-all',
        }}>
          {protectQuotes(point)}
        </div>
      </div>

      {/* 하단 워터마크 */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, color: 'rgba(255,255,255,0.3)', fontSize: 22 }}>
        <div style={{ width: 32, height: 2, background: 'rgba(255,255,255,0.2)', borderRadius: 1 }} />
        <span>FLIQK</span>
      </div>
    </div>
  )
}

// ── Slide CTA ─────────────────────────────────────────────────
// 고정 2줄 포맷: 1줄 = "[트렌드 제목]", 2줄 = 전체 이야기가 궁금하다면?
function SlideCTA({
  category, catColor, catEmoji, hashtagStr, title, totalSlides,
}: {
  category: string; catColor: string; catEmoji: string
  hashtagStr: string; title: string; totalSlides: number
}) {
  const ctaFontSz = ctaTitleFontSize(title.length)
  const titleProtected = protectQuotes(title)

  return (
    <div style={{
      width: SIZE, height: SIZE, display: 'flex', flexDirection: 'column',
      background: BRAND_WARM, padding: '80px 72px',
      fontFamily: 'NotoSansKR', justifyContent: 'space-between',
    }}>
      {/* 상단 배지 */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div style={{
          background: `${catColor}22`, color: catColor,
          padding: '10px 28px', borderRadius: 40, fontSize: 28, fontWeight: 700,
          display: 'flex', alignItems: 'center', gap: 8,
        }}>
          <span>{catEmoji}</span>
          <span>{category}</span>
        </div>
        <div style={{ color: '#C0C0C0', fontSize: 22 }}>{`${totalSlides}/${totalSlides}`}</div>
      </div>

      {/* 중앙 콘텐츠 */}
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 32 }}>
        {/* Fliqk 로고 */}
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8 }}>
          <div style={{ fontSize: 96, fontWeight: 700, color: BRAND_DARK, letterSpacing: -4 }}>
            Fliqk
          </div>
          <div style={{ width: 72, height: 5, background: BRAND_TEAL, borderRadius: 3 }} />
        </div>

        {/* CTA 2줄 고정 포맷
            Satori에서 textAlign:'center'는 flex item에서 작동 불안정.
            alignItems:'center' + 자동 너비(auto) 방식으로 시각 중앙 정렬.
            maxWidth로 너비 제한, wordBreak로 어절 단위 줄바꿈 보장. */}
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12 }}>
          <div style={{
            fontSize: ctaFontSz, color: BRAND_DARK, fontWeight: 700,
            lineHeight: 1.4, wordBreak: 'keep-all', maxWidth: SIZE - 144,
          }}>
            {`"${titleProtected}"`}
          </div>
          <div style={{
            fontSize: ctaFontSz, color: BRAND_TEAL, fontWeight: 700, maxWidth: SIZE - 144,
          }}>
            조금 더 일찍 트렌드를 알고 싶다면?
          </div>
        </div>

        {/* 버튼 */}
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10 }}>
          <div style={{
            background: BRAND_TEAL, color: 'white',
            padding: '20px 52px', borderRadius: 50, fontSize: 32, fontWeight: 700,
            display: 'flex', alignItems: 'center', gap: 10,
          }}>
            <span>👉</span>
            <span>fliqk.app에서 확인하기</span>
          </div>
          <div style={{ color: '#AAAAAA', fontSize: 22 }}>프로필 링크 클릭</div>
        </div>
      </div>

      {/* 해시태그 */}
      <div style={{
        color: '#BBBBBB', fontSize: 21,
        textAlign: 'center' as const, lineHeight: 1.8,
      }}>
        {hashtagStr}
      </div>
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════
// Route Handler
// ═══════════════════════════════════════════════════════════════
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ trendId: string; slide: string }> }
) {
  const { trendId, slide } = await params
  const slideNum = parseInt(slide, 10)

  // slideNum 기본 유효성 (상세는 콘텐츠 로드 후 재확인)
  if (isNaN(slideNum) || slideNum < 1 || slideNum > 10) {
    return new Response('slide must be 1-10', { status: 400 })
  }

  const [trend, fonts] = await Promise.all([fetchTrend(trendId), getKoreanFonts()])
  if (!trend) return new Response('Trend not found', { status: 404 })

  const catColor = CATEGORY_COLORS[trend.category] ?? BRAND_TEAL
  const catEmoji = CATEGORY_EMOJI[trend.category] ?? '✨'
  const tags = (trend.tags ?? []).slice(0, 5)
  const hashtagStr = [...tags.map((t: string) => `#${t}`), '#Fliqk', '#트렌드'].join(' ')

  // 콘텐츠 포인트 동적 결정 — 소스 데이터의 trailing "…" 도 제거
  const contentPoints = deriveContentPoints(trend.summary, trend.body)
    .map(s => s.replace(/[.…]{2,}$|…$/, '').trimEnd())
    .filter(s => s.length >= 15)
  validateCardContent(trend.title, contentPoints)
  const totalSlides = 1 + contentPoints.length + 1  // cover + content... + CTA

  if (slideNum > totalSlides) {
    return new Response(`slide ${slideNum} does not exist (total: ${totalSlides})`, { status: 404 })
  }

  const opts = { width: SIZE, height: SIZE, fonts }

  // ── 슬라이드 1: 표지 ────────────────────────────────────────
  if (slideNum === 1) {
    const bgData = trend.image_url ? await buildCoverCompositeDataUrl(trend.image_url) : null
    const teaser = contentPoints[0] ? makeTeaserClause(contentPoints[0]) : `${trend.category} 트렌드`
    return new ImageResponse(<Slide1Cover
      title={trend.title} category={trend.category}
      catColor={catColor} catEmoji={catEmoji}
      bgData={bgData} teaser={teaser}
    />, opts)
  }

  // ── 슬라이드 N (마지막): CTA ─────────────────────────────────
  if (slideNum === totalSlides) {
    return new ImageResponse(<SlideCTA
      category={trend.category} catColor={catColor} catEmoji={catEmoji}
      hashtagStr={hashtagStr} title={trend.title} totalSlides={totalSlides}
    />, opts)
  }

  // ── 슬라이드 2~N-1: 핵심 포인트 ─────────────────────────────
  const pointIndex = slideNum - 2
  const point = contentPoints[pointIndex]
  if (!point) return new Response('Not Found', { status: 404 })

  return new ImageResponse(<SlideKeyPoint
    category={trend.category} catEmoji={catEmoji} catColor={catColor}
    slideNum={slideNum} totalSlides={totalSlides}
    point={point} pointIndex={pointIndex}
  />, opts)
}
