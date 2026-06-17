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
const TOTAL_SLIDES = 5

const CATEGORY_COLORS: Record<string, string> = {
  '푸드': '#E74C3C', '뷰티': '#E91E8C', 'SNS': '#6C3CE1', '패션': '#27AE60',
  '테크': '#2980B9', '라이프': '#E8A87C', '디자인': '#8E44AD', 'KPOP': '#E040FB', '엔터': '#C0392B',
}
const CATEGORY_EMOJI: Record<string, string> = {
  '푸드': '🍜', '뷰티': '💄', 'SNS': '📱', '패션': '👗',
  '테크': '💻', '라이프': '✨', '디자인': '🎨', 'KPOP': '🎤', '엔터': '🎭',
}

// ── Noto Sans KR Bold (로컬 TTF — next/og는 woff2 미지원) ────
// Satori는 내부 파싱 시 ArrayBuffer를 수정(in-place)할 수 있음.
// 따라서 원본 바이트는 Uint8Array로 캐싱하고, 렌더마다 새 ArrayBuffer를 생성해야 함.
let _fontBytes: Uint8Array | null = null

async function getKoreanFonts() {
  if (!_fontBytes) {
    const buf = await readFile(join(process.cwd(), 'public/fonts/NotoSansKR-Bold.ttf'))
    _fontBytes = new Uint8Array(buf)
  }
  // 렌더마다 fresh copy — Satori가 ArrayBuffer를 수정해도 원본 보존
  const data = new ArrayBuffer(_fontBytes.byteLength)
  new Uint8Array(data).set(_fontBytes)
  return [{ name: 'NotoSansKR', data, weight: 700 as const, style: 'normal' as const }]
}

// ── Supabase 트렌드 조회 ──────────────────────────────────────
interface TrendData {
  title: string
  summary: string | null
  category: string
  image_url: string | null
  tags: string[]
}

async function fetchTrend(trendId: string): Promise<TrendData | null> {
  const SURL = process.env.NEXT_PUBLIC_SUPABASE_URL
  const SKEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  if (!SURL || !SKEY) return null
  try {
    const res = await fetch(
      `${SURL}/rest/v1/trends?id=eq.${trendId}&select=title,summary,category,image_url,tags`,
      { headers: { apikey: SKEY, Authorization: `Bearer ${SKEY}` }, signal: AbortSignal.timeout(6000) }
    )
    if (!res.ok) return null
    const rows = await res.json()
    return rows[0] ?? null
  } catch { return null }
}

// ── 이미지 → base64 data URL ──────────────────────────────────
async function toDataUrl(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) })
    if (!res.ok) return null
    const buf = await res.arrayBuffer()
    const ct = res.headers.get('content-type') ?? 'image/jpeg'
    return `data:${ct};base64,${Buffer.from(buf).toString('base64')}`
  } catch { return null }
}

// ── 텍스트 길이 제한 ──────────────────────────────────────────
function cap(text: string, max: number): string {
  return text.length > max ? text.slice(0, max - 1) + '…' : text
}

// ═══════════════════════════════════════════════════════════════
// 슬라이드 컴포넌트
// ═══════════════════════════════════════════════════════════════

// ── Slide 1: 표지 ─────────────────────────────────────────────
// <img objectFit="cover"> 로 정확한 센터 크롭
function Slide1Cover({
  title, category, catColor, catEmoji, bgData, teaser,
}: {
  title: string; category: string; catColor: string
  catEmoji: string; bgData: string | null; teaser: string
}) {
  const fallbackBg = `linear-gradient(160deg, ${catColor}CC 0%, ${BRAND_DARK} 100%)`
  return (
    <div style={{
      width: SIZE, height: SIZE, display: 'flex', flexDirection: 'column',
      position: 'relative', overflow: 'hidden',
      background: fallbackBg, fontFamily: 'NotoSansKR',
    }}>
      {/* 배경 이미지 — objectFit cover로 정확한 센터 크롭 */}
      {bgData && (
        <img
          src={bgData}
          width={SIZE}
          height={SIZE}
          style={{
            position: 'absolute', top: 0, left: 0,
            objectFit: 'cover', objectPosition: 'center',
          }}
        />
      )}

      {/* 상단 페이드 (브랜드 가독성) */}
      <div style={{
        position: 'absolute', top: 0, left: 0, width: SIZE, height: 240,
        background: 'linear-gradient(to bottom, rgba(0,0,0,0.55) 0%, rgba(0,0,0,0) 100%)',
      }} />

      {/* 하단 그라데이션 오버레이 */}
      <div style={{
        position: 'absolute', bottom: 0, left: 0, width: SIZE, height: 560,
        background: 'linear-gradient(to top, rgba(0,0,0,0.92) 0%, rgba(0,0,0,0.6) 50%, rgba(0,0,0,0) 100%)',
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
        <div style={{
          color: 'rgba(255,255,255,0.8)', fontSize: 26, fontWeight: 700, letterSpacing: 2,
        }}>
          PIKK
        </div>
      </div>

      {/* 하단 텍스트 블록 */}
      <div style={{
        position: 'absolute', bottom: 0, left: 0, right: 0,
        display: 'flex', flexDirection: 'column', gap: 20,
        padding: '0 64px 72px',
      }}>
        {/* 티저 라인 (첫 번째 요약 포인트) */}
        <div style={{
          color: BRAND_PEACH, fontSize: 30, fontWeight: 700,
          display: 'flex', alignItems: 'center', gap: 10,
        }}>
          <span>⚡</span>
          <span>{teaser}</span>
        </div>

        {/* 메인 후킹 제목 */}
        <div style={{
          color: 'white', fontSize: 68, fontWeight: 700,
          lineHeight: 1.25, wordBreak: 'keep-all',
        }}>
          {cap(title, 40)}
        </div>

        {/* 하단 픽 워터마크 */}
        <div style={{
          color: 'rgba(255,255,255,0.4)', fontSize: 23, letterSpacing: 1,
        }}>
          pikk.app · 트렌드를 가장 먼저
        </div>
      </div>
    </div>
  )
}

// ── Slides 2–4: 핵심 포인트 슬라이드 (동일 템플릿) ─────────────
function SlideKeyPoint({
  category, catEmoji, catColor, slideNum, point, pointIndex,
}: {
  category: string; catEmoji: string; catColor: string
  slideNum: number; point: string; pointIndex: number
}) {
  const nums = ['01', '02', '03']
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
        <div style={{
          color: 'rgba(255,255,255,0.5)', fontSize: 26, fontWeight: 700,
        }}>
          {`${slideNum}/${TOTAL_SLIDES}`}
        </div>
      </div>

      {/* 핵심 내용 — 중앙 */}
      <div style={{
        display: 'flex', flexDirection: 'column', gap: 32,
        flex: 1, justifyContent: 'center',
      }}>
        {/* 번호 레이블 */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 20 }}>
          <div style={{
            color: BRAND_PEACH, fontSize: 88, fontWeight: 700,
            lineHeight: 1, letterSpacing: -2,
          }}>
            {num}
          </div>
          <div style={{ flex: 1, height: 3, background: `${BRAND_PEACH}55`, borderRadius: 2 }} />
        </div>

        {/* 포인트 텍스트 */}
        <div style={{
          color: 'white', fontSize: 54, fontWeight: 700,
          lineHeight: 1.5, wordBreak: 'keep-all',
        }}>
          {cap(point, 60)}
        </div>
      </div>

      {/* 하단 PIKK 워터마크 */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 12,
        color: 'rgba(255,255,255,0.3)', fontSize: 22,
      }}>
        <div style={{ width: 32, height: 2, background: 'rgba(255,255,255,0.2)', borderRadius: 1 }} />
        <span>PIKK</span>
      </div>
    </div>
  )
}

// ── Slide 5: CTA ─────────────────────────────────────────────
function Slide5CTA({ category, catColor, catEmoji, hashtagStr }: {
  category: string; catColor: string; catEmoji: string; hashtagStr: string
}) {
  return (
    <div style={{
      width: SIZE, height: SIZE, display: 'flex', flexDirection: 'column',
      background: BRAND_WARM, padding: '80px 72px',
      fontFamily: 'NotoSansKR', justifyContent: 'space-between',
    }}>
      {/* 상단 배지 */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div style={{
          background: catColor + '22', color: catColor,
          padding: '10px 28px', borderRadius: 40, fontSize: 28, fontWeight: 700,
          display: 'flex', alignItems: 'center', gap: 8,
        }}>
          <span>{catEmoji}</span>
          <span>{category}</span>
        </div>
        <div style={{ color: '#C0C0C0', fontSize: 22 }}>{`${TOTAL_SLIDES}/${TOTAL_SLIDES}`}</div>
      </div>

      {/* 중앙 브랜딩 */}
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 32 }}>
        {/* 로고 */}
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8 }}>
          <div style={{ fontSize: 100, fontWeight: 700, color: BRAND_DARK, letterSpacing: -4 }}>
            Pikk
          </div>
          <div style={{ width: 72, height: 5, background: BRAND_TEAL, borderRadius: 3 }} />
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4 }}>
          <div style={{ fontSize: 36, color: '#555', fontWeight: 700, lineHeight: 1.5 }}>
            매일 아침, 9가지 트렌드를
          </div>
          <div style={{ fontSize: 36, color: '#555', fontWeight: 700, lineHeight: 1.5 }}>
            가장 먼저 알려드립니다
          </div>
        </div>

        {/* CTA 버튼 */}
        <div style={{
          display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10,
        }}>
          <div style={{
            background: BRAND_TEAL, color: 'white',
            padding: '20px 52px', borderRadius: 50, fontSize: 34, fontWeight: 700,
            display: 'flex', alignItems: 'center', gap: 10,
          }}>
            <span>👉</span>
            <span>프로필 링크에서 더 보기</span>
          </div>
          <div style={{ color: '#AAAAAA', fontSize: 24 }}>pikk.app</div>
        </div>
      </div>

      {/* 해시태그 */}
      <div style={{
        color: '#BBBBBB', fontSize: 22,
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
  try {
  const { trendId, slide } = await params
  const slideNum = parseInt(slide, 10)

  if (isNaN(slideNum) || slideNum < 1 || slideNum > TOTAL_SLIDES) {
    return new Response(`slide must be 1-${TOTAL_SLIDES}`, { status: 400 })
  }

  const [trend, fonts] = await Promise.all([fetchTrend(trendId), getKoreanFonts()])
  if (!trend) return new Response('Trend not found', { status: 404 })

  const catColor = CATEGORY_COLORS[trend.category] ?? BRAND_TEAL
  const catEmoji = CATEGORY_EMOJI[trend.category] ?? '✨'
  const summaryLines = (trend.summary ?? '').split('\n').filter(Boolean)
  const tags = (trend.tags ?? []).slice(0, 5)
  const hashtagStr = [...tags.map((t: string) => `#${t}`), '#Pikk', '#트렌드'].join(' ')

  const opts = { width: SIZE, height: SIZE, fonts }

  // ── 슬라이드 1: 표지 ────────────────────────────────────────
  if (slideNum === 1) {
    const bgData = trend.image_url ? await toDataUrl(trend.image_url) : null
    const teaser = summaryLines[0] ? cap(summaryLines[0], 30) : trend.category + ' 트렌드'
    return new ImageResponse(<Slide1Cover
      title={trend.title} category={trend.category}
      catColor={catColor} catEmoji={catEmoji}
      bgData={bgData} teaser={teaser}
    />, opts)
  }

  // ── 슬라이드 2–4: 핵심 포인트 ───────────────────────────────
  if (slideNum >= 2 && slideNum <= 4) {
    const pointIndex = slideNum - 2  // 0, 1, 2
    // 요약 라인이 부족하면 제목에서 임시 생성
    const point = summaryLines[pointIndex]
      ?? (pointIndex === 0 ? trend.title : `${trend.category} 트렌드 핵심 포인트 ${pointIndex + 1}`)
    return new ImageResponse(<SlideKeyPoint
      category={trend.category} catEmoji={catEmoji} catColor={catColor}
      slideNum={slideNum} point={point} pointIndex={pointIndex}
    />, opts)
  }

  // ── 슬라이드 5: CTA ──────────────────────────────────────────
  return new ImageResponse(<Slide5CTA
    category={trend.category} catColor={catColor}
    catEmoji={catEmoji} hashtagStr={hashtagStr}
  />, opts)
  } catch (err) {
    const msg = err instanceof Error ? err.message + '\n' + err.stack : String(err)
    console.error('[instagram-card] Error:', msg)
    return new Response(JSON.stringify({ error: msg }), { status: 500, headers: { 'content-type': 'application/json' } })
  }
}
