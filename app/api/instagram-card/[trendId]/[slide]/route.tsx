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
  '푸드': '#FF6B6B', '뷰티': '#FF8DA1', 'SNS': '#7C67EE', '패션': '#2ECC71',
  '테크': '#4A90A4', '라이프': '#E8A87C', '디자인': '#9B59B6', 'KPOP': '#FF4081', '엔터': '#E74C3C',
}
const CATEGORY_EMOJI: Record<string, string> = {
  '푸드': '🍜', '뷰티': '💄', 'SNS': '📱', '패션': '👗',
  '테크': '💻', '라이프': '✨', '디자인': '🎨', 'KPOP': '🎤', '엔터': '🎭',
}

// ── Noto Sans KR Bold (로컬 TTF — next/og는 woff2 미지원) ────
// 모듈 레벨 캐시: 워밍업된 Lambda 인스턴스에서 재사용
let _fontCache: { name: string; data: ArrayBuffer; weight: 700; style: 'normal' }[] | null = null

async function getKoreanFonts() {
  if (_fontCache) return _fontCache
  const buf = await readFile(join(process.cwd(), 'public/fonts/NotoSansKR-Bold.ttf'))
  const data = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer
  _fontCache = [{ name: 'NotoSansKR', data, weight: 700 as const, style: 'normal' as const }]
  return _fontCache
}

// ── Supabase 트렌드 조회 ──────────────────────────────────────
interface TrendData {
  title: string
  summary: string | null
  body: string | null
  category: string
  image_url: string | null
  gallery_images: { url: string; source_url: string; site_name: string }[] | null
  tags: string[]
}

async function fetchTrend(trendId: string): Promise<TrendData | null> {
  const SURL = process.env.NEXT_PUBLIC_SUPABASE_URL
  const SKEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  if (!SURL || !SKEY) return null
  try {
    const res = await fetch(
      `${SURL}/rest/v1/trends?id=eq.${trendId}&select=title,summary,body,category,image_url,gallery_images,tags`,
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

// ── 본문 핵심 문장 추출 ───────────────────────────────────────
function extractKeyFact(body: string): string {
  const sentences = body
    .replace(/\n+/g, ' ')
    .split(/(?<=[.!?])\s+/)
    .map(s => s.trim())
    .filter(s => s.length >= 25 && s.length <= 140)
  const withStats = sentences.filter(s => /[\d%억만천백]+/.test(s))
  const best = withStats[0] ?? sentences[1] ?? sentences[0] ?? body.slice(0, 100)
  return best.length > 130 ? best.slice(0, 127) + '...' : best
}

// ── 슬라이드 컴포넌트 ─────────────────────────────────────────

function Slide1Cover({
  title, category, catColor, catEmoji, bgData,
}: { title: string; category: string; catColor: string; catEmoji: string; bgData: string | null }) {
  return (
    <div
      style={{
        width: SIZE, height: SIZE, display: 'flex', flexDirection: 'column',
        justifyContent: 'flex-end',
        backgroundImage: bgData
          ? `url(${bgData})`
          : `linear-gradient(160deg, ${catColor}CC 0%, ${BRAND_DARK} 100%)`,
        backgroundSize: 'cover', backgroundPosition: 'center',
        fontFamily: 'NotoSansKR',
      }}
    >
      {/* 하단 그라데이션 오버레이 + 텍스트 */}
      <div style={{
        display: 'flex', flexDirection: 'column', gap: 20,
        padding: '160px 64px 72px',
        background: 'linear-gradient(to bottom, rgba(0,0,0,0) 0%, rgba(0,0,0,0.5) 40%, rgba(0,0,0,0.88) 100%)',
      }}>
        {/* 카테고리 배지 */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
          <div style={{
            background: catColor, color: 'white',
            padding: '10px 28px', borderRadius: 40,
            fontSize: 30, fontWeight: 700,
            display: 'flex', alignItems: 'center', gap: 8,
          }}>
            <span>{catEmoji}</span>
            <span>{category}</span>
          </div>
        </div>

        {/* 제목 */}
        <div style={{
          color: 'white', fontSize: 64, fontWeight: 700, lineHeight: 1.3,
          wordBreak: 'keep-all',
        }}>
          {title}
        </div>

        {/* Pikk 워터마크 */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div style={{ color: 'rgba(255,255,255,0.55)', fontSize: 26, letterSpacing: 1 }}>
            트렌드를 가장 먼저 · Pikk
          </div>
          <div style={{
            color: 'rgba(255,255,255,0.4)', fontSize: 22,
            background: 'rgba(255,255,255,0.12)', padding: '6px 18px', borderRadius: 20,
          }}>
            1 / 4
          </div>
        </div>
      </div>
    </div>
  )
}

function Slide2Summary({
  title, summaryLines, tags, category, catColor,
}: { title: string; summaryLines: string[]; tags: string; category: string; catColor: string }) {
  const markers = ['①', '②', '③']
  return (
    <div style={{
      width: SIZE, height: SIZE, display: 'flex', flexDirection: 'column',
      background: `linear-gradient(160deg, ${BRAND_TEAL} 0%, #2C7A8C 60%, #1D5F72 100%)`,
      padding: '72px 72px', fontFamily: 'NotoSansKR',
      justifyContent: 'space-between',
    }}>
      {/* 헤더 */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div style={{ color: 'rgba(255,255,255,0.65)', fontSize: 28, fontWeight: 700, letterSpacing: 2 }}>
            PIKK
          </div>
          <div style={{ color: 'rgba(255,255,255,0.4)', fontSize: 22 }}>2 / 4</div>
        </div>
        <div style={{
          display: 'flex', alignItems: 'center', gap: 10,
          color: 'rgba(255,255,255,0.7)', fontSize: 26,
        }}>
          <span>⚡</span>
          <span>핵심 요약</span>
        </div>
        <div style={{
          color: 'white', fontSize: 40, fontWeight: 700,
          lineHeight: 1.3, marginTop: 8, wordBreak: 'keep-all',
        }}>
          {title}
        </div>
      </div>

      {/* 구분선 */}
      <div style={{ height: 2, background: 'rgba(255,255,255,0.2)', borderRadius: 1 }} />

      {/* 요약 라인 */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 28, flex: 1, justifyContent: 'center' }}>
        {summaryLines.slice(0, 3).map((line, i) => (
          <div key={i} style={{ display: 'flex', gap: 20, alignItems: 'flex-start' }}>
            <div style={{
              color: catColor === BRAND_TEAL ? BRAND_PEACH : catColor,
              fontSize: 32, fontWeight: 700, minWidth: 40, flexShrink: 0, marginTop: 4,
            }}>
              {markers[i]}
            </div>
            <div style={{
              color: 'white', fontSize: 32, fontWeight: 700,
              lineHeight: 1.55, flex: 1, wordBreak: 'keep-all',
            }}>
              {line}
            </div>
          </div>
        ))}
      </div>

      {/* 해시태그 */}
      <div style={{ color: 'rgba(255,255,255,0.5)', fontSize: 24, lineHeight: 1.6 }}>
        {tags}
      </div>
    </div>
  )
}

function Slide3Highlight({
  keyFact, bgData, catColor,
}: { keyFact: string; bgData: string | null; catColor: string }) {
  // Satori throws on undefined style values — build bg styles conditionally
  const outerBgStyle = bgData
    ? { backgroundImage: `url(${bgData})`, backgroundSize: 'cover' as const, backgroundPosition: 'center' as const }
    : { background: BRAND_DARK }
  const overlayBg = bgData ? 'rgba(0,0,0,0.62)' : BRAND_DARK

  return (
    <div style={{
      width: SIZE, height: SIZE, display: 'flex', flexDirection: 'column',
      fontFamily: 'NotoSansKR', ...outerBgStyle,
    }}>
      <div style={{
        display: 'flex', flexDirection: 'column', justifyContent: 'center',
        flex: 1, padding: '80px 72px', background: overlayBg, gap: 40,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <div style={{ width: 6, height: 36, background: BRAND_PEACH, borderRadius: 3 }} />
          <div style={{ color: BRAND_PEACH, fontSize: 28, fontWeight: 700 }}>
            본문 하이라이트
          </div>
        </div>

        {/* 인용 블록 */}
        <div style={{ display: 'flex', gap: 0 }}>
          <div style={{ width: 6, background: catColor, borderRadius: 3, marginRight: 32 }} />
          <div style={{
            color: 'white', fontSize: 46, fontWeight: 700,
            lineHeight: 1.6, wordBreak: 'keep-all', flex: 1,
          }}>
            {keyFact}
          </div>
        </div>

        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div style={{ color: 'rgba(255,255,255,0.45)', fontSize: 24 }}>
            pikk.app에서 전체 내용 확인
          </div>
          <div style={{ color: 'rgba(255,255,255,0.35)', fontSize: 22 }}>3 / 4</div>
        </div>
      </div>
    </div>
  )
}

function Slide4CTA({ category, catColor, catEmoji, hashtagStr }: {
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
        <div style={{ color: '#B0B0B0', fontSize: 22 }}>4 / 4</div>
      </div>

      {/* 중앙 브랜딩 */}
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 28 }}>
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4 }}>
          <div style={{ fontSize: 96, fontWeight: 700, color: BRAND_DARK, letterSpacing: -3 }}>
            Pikk
          </div>
          <div style={{ width: 80, height: 5, background: BRAND_TEAL, borderRadius: 3 }} />
        </div>
        <div style={{
          fontSize: 36, color: BRAND_TEAL, fontWeight: 700,
          textAlign: 'center' as const, lineHeight: 1.4,
        }}>
          남들보다 먼저 아는 사람들의 앱
        </div>
        <div style={{
          display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8,
        }}>
          <div style={{
            background: BRAND_DARK, color: 'white',
            padding: '18px 48px', borderRadius: 50, fontSize: 32, fontWeight: 700,
          }}>
            👉 프로필 링크에서 더 보기
          </div>
          <div style={{ color: '#B0B0B0', fontSize: 24 }}>pikk.app</div>
        </div>
      </div>

      {/* 해시태그 */}
      <div style={{ color: '#B0B0B0', fontSize: 22, textAlign: 'center' as const, lineHeight: 1.8 }}>
        {hashtagStr}
      </div>
    </div>
  )
}

// ── Route Handler ─────────────────────────────────────────────
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ trendId: string; slide: string }> }
) {
  const { trendId, slide } = await params
  const slideNum = parseInt(slide, 10)

  if (isNaN(slideNum) || slideNum < 1 || slideNum > 4) {
    return new Response('slide must be 1-4', { status: 400 })
  }

  const [trend, fonts] = await Promise.all([fetchTrend(trendId), getKoreanFonts()])
  if (!trend) return new Response('Trend not found', { status: 404 })

  const catColor = CATEGORY_COLORS[trend.category] ?? BRAND_TEAL
  const catEmoji = CATEGORY_EMOJI[trend.category] ?? '✨'
  const summaryLines = (trend.summary ?? '').split('\n').filter(Boolean)
  const tags = (trend.tags ?? []).slice(0, 5)
  const hashtagStr = [...tags.map(t => `#${t}`), '#Pikk', '#트렌드'].join(' ')

  const opts = { width: SIZE, height: SIZE, fonts }

  if (slideNum === 1) {
    const bgData = trend.image_url ? await toDataUrl(trend.image_url) : null
    return new ImageResponse(<Slide1Cover
      title={trend.title} category={trend.category}
      catColor={catColor} catEmoji={catEmoji} bgData={bgData}
    />, opts)
  }

  if (slideNum === 2) {
    return new ImageResponse(<Slide2Summary
      title={trend.title} summaryLines={summaryLines}
      tags={hashtagStr} category={trend.category} catColor={catColor}
    />, opts)
  }

  if (slideNum === 3) {
    const keyFact = extractKeyFact(trend.body ?? trend.summary ?? trend.title)
    const galleryImgUrl = trend.gallery_images?.[0]?.url ?? null
    const bgData = galleryImgUrl ? await toDataUrl(galleryImgUrl) : null
    return new ImageResponse(<Slide3Highlight
      keyFact={keyFact} bgData={bgData} catColor={catColor}
    />, opts)
  }

  // slide 4
  return new ImageResponse(<Slide4CTA
    category={trend.category} catColor={catColor}
    catEmoji={catEmoji} hashtagStr={hashtagStr}
  />, opts)
}
