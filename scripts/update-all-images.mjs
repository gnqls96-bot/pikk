#!/usr/bin/env node
/**
 * 기존 트렌드 이미지 전체 업데이트 스크립트
 * 사용법: node scripts/update-all-images.mjs
 *
 * 우선순위: DuckDuckGo(Bing) → og:image(검증) → Pexels(fallback)
 * 이미지 검증: HEAD 요청으로 실제 접근 가능 여부 + 최소 10KB 확인
 * 키워드 없는 트렌드: Claude haiku로 영어 키워드 생성 후 DB 저장
 */

import { readFileSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))

// ── .env.local 로드 ────────────────────────────────────────────
const envPath = resolve(__dirname, '..', '.env.local')
const content = readFileSync(envPath, 'utf8')
for (const line of content.split('\n')) {
  const m = line.match(/^([^#=\s][^=]*?)\s*=\s*(.*)$/)
  if (m) process.env[m[1].trim()] = m[2].trim().replace(/^['"]|['"]$/g, '')
}

const SUPABASE_URL   = process.env.NEXT_PUBLIC_SUPABASE_URL
const SUPABASE_KEY   = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
const PEXELS_KEY     = process.env.PEXELS_API_KEY
const ANTHROPIC_KEY  = process.env.ANTHROPIC_API_KEY

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('❌ SUPABASE 환경변수 없음'); process.exit(1)
}

// ── Supabase REST ───────────────────────────────────────────────
async function supabaseFetch(path) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` },
  })
  if (!res.ok) throw new Error(`Supabase GET 실패: ${await res.text()}`)
  return res.json()
}

async function supabasePatch(table, id, body) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}?id=eq.${id}`, {
    method: 'PATCH',
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'return=minimal',
    },
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error(`Supabase PATCH 실패: ${await res.text()}`)
}

// ── Claude haiku로 영어 키워드 생성 ────────────────────────────
async function generateKeyword(koreanTitle, category) {
  if (!ANTHROPIC_KEY) return null
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 30,
        messages: [{
          role: 'user',
          content: `Korean trend title: "${koreanTitle}" (category: ${category})\nGenerate 3-4 English image search keywords that best represent this trend visually. Return ONLY the keywords, no explanation.`,
        }],
      }),
      signal: AbortSignal.timeout(8000),
    })
    if (!res.ok) return null
    const data = await res.json()
    const keyword = data.content?.[0]?.text?.trim()
    return keyword && keyword.length > 2 ? keyword : null
  } catch { return null }
}

// ── 이미지 수집 함수 ────────────────────────────────────────────
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'

async function validateImage(url) {
  try {
    const res = await fetch(url, {
      method: 'HEAD',
      headers: { 'User-Agent': UA },
      signal: AbortSignal.timeout(5000),
      redirect: 'follow',
    })
    if (!res.ok) return false
    const ct = res.headers.get('content-type') ?? ''
    if (!ct.match(/^image\/(jpeg|jpg|png|webp|gif|avif)/i)) return false
    const cl = parseInt(res.headers.get('content-length') ?? '0')
    if (cl > 0 && cl < 10000) return false
    return true
  } catch { return false }
}

async function fetchDDGImages(query, count = 6) {
  try {
    const pageRes = await fetch(
      `https://duckduckgo.com/?q=${encodeURIComponent(query)}&iax=images&ia=images`,
      {
        headers: { 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9' },
        signal: AbortSignal.timeout(10000),
        redirect: 'follow',
      }
    )
    if (!pageRes.ok) return []
    const html = await pageRes.text()
    const vqdMatch = html.match(/vqd=["']([^"']+)["']/) ?? html.match(/vqd=([\d-]+)/)
    const vqd = vqdMatch?.[1]
    if (!vqd) return []

    const apiRes = await fetch(
      `https://duckduckgo.com/i.js?q=${encodeURIComponent(query)}&o=json&p=1&s=0&u=bing&f=,,,&vqd=${encodeURIComponent(vqd)}`,
      {
        headers: { 'User-Agent': UA, Referer: 'https://duckduckgo.com/' },
        signal: AbortSignal.timeout(8000),
      }
    )
    if (!apiRes.ok) return []
    const data = await apiRes.json()

    return (data.results ?? [])
      .filter(img => img.image && (img.width ?? 0) >= 800)
      .slice(0, count + 4)
      .map(img => {
        let siteName = 'Web'
        try { siteName = new URL(img.url ?? img.image).hostname.replace(/^www\./, '') } catch {}
        return { url: img.image, source_url: img.url ?? img.image, site_name: siteName }
      })
  } catch { return [] }
}

async function fetchOgImage(src) {
  if (!src?.url || src.url.includes('example.com')) return null
  try {
    const res = await fetch(src.url, {
      headers: { 'User-Agent': UA, Accept: 'text/html' },
      signal: AbortSignal.timeout(7000),
      redirect: 'follow',
    })
    if (!res.ok) return null
    const html = await res.text()
    const m =
      html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i) ??
      html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i)
    const raw = m?.[1]?.trim()
    if (!raw || raw.length < 10) return null
    const imgUrl = raw.startsWith('http') ? raw : new URL(raw, src.url).href
    const valid = await validateImage(imgUrl)
    if (!valid) return null
    return { url: imgUrl, source_url: src.url, site_name: src.site_name }
  } catch { return null }
}

async function fetchPexelsImages(keyword, count = 5) {
  if (!PEXELS_KEY || count <= 0) return []
  const queries = [keyword, keyword.split(' ').slice(0, 3).join(' ')]
  const results = []
  for (const q of queries) {
    try {
      const res = await fetch(
        `https://api.pexels.com/v1/search?query=${encodeURIComponent(q)}&per_page=${Math.min(count + 3, 15)}&orientation=landscape`,
        { headers: { Authorization: PEXELS_KEY }, signal: AbortSignal.timeout(8000) }
      )
      if (!res.ok) continue
      const data = await res.json()
      for (const p of data.photos ?? []) {
        const url = p.src?.large2x ?? ''
        if (url && !results.find(r => r.url === url)) {
          results.push({ url, source_url: p.url ?? 'https://www.pexels.com', site_name: 'Pexels' })
        }
        if (results.length >= count + 2) break
      }
    } catch {}
    if (results.length >= count) break
  }
  return results.slice(0, count)
}

async function collectImages(keyword, sources = []) {
  const TARGET = 5
  const seen = new Set()
  const gallery = []

  const addIfNew = async (img, validate = false) => {
    if (!img?.url || seen.has(img.url) || gallery.length >= TARGET) return
    if (validate && !(await validateImage(img.url))) return
    seen.add(img.url)
    gallery.push(img)
  }

  // 1순위: DuckDuckGo
  const ddgImgs = await fetchDDGImages(keyword, TARGET)
  for (const img of ddgImgs) {
    if (gallery.length >= TARGET) break
    await addIfNew(img, true)
  }

  // 2순위: og:image
  if (gallery.length < TARGET) {
    const ogResults = await Promise.all((sources ?? []).map(fetchOgImage))
    for (const img of ogResults) await addIfNew(img)
  }

  // 3순위: Pexels
  if (gallery.length < TARGET) {
    const pexels = await fetchPexelsImages(keyword, TARGET - gallery.length)
    for (const img of pexels) await addIfNew(img)
  }

  return { image_url: gallery[0]?.url ?? null, gallery_images: gallery }
}

// ── 메인 실행 ──────────────────────────────────────────────────
async function main() {
  console.log('\n🔄 Pikk 전체 트렌드 이미지 업데이트 시작\n')

  const trends = await supabaseFetch(
    'trends?select=id,title,image_search_keyword,related_sources,category&order=published_at.desc'
  )
  console.log(`📋 총 ${trends.length}개 트렌드 이미지 재수집\n`)

  let updated = 0, failed = 0, keywordGenerated = 0

  for (let i = 0; i < trends.length; i++) {
    const t = trends[i]
    const label = `[${i + 1}/${trends.length}] ${t.category ?? ''}`

    // 영어 키워드 결정: DB 값 → Claude 생성 → fallback
    let keyword = t.image_search_keyword?.trim()

    if (!keyword) {
      process.stdout.write(`${label} │ ${t.title.slice(0, 30)}... 키워드 생성 중... `)
      const generated = await generateKeyword(t.title, t.category)
      if (generated) {
        keyword = generated
        keywordGenerated++
        process.stdout.write(`"${keyword}"\n`)
        // DB에 키워드 저장
        try {
          await supabasePatch('trends', t.id, { image_search_keyword: keyword })
        } catch { /* 키워드 저장 실패해도 계속 진행 */ }
      } else {
        keyword = 'trend lifestyle'
        process.stdout.write(`fallback\n`)
      }
    } else {
      process.stdout.write(`${label} │ ${t.title.slice(0, 30)}... `)
    }

    try {
      const { image_url, gallery_images } = await collectImages(keyword, t.related_sources ?? [])
      const ddgCount = gallery_images.filter(g => g.site_name !== 'Pexels').length
      const pxCount  = gallery_images.filter(g => g.site_name === 'Pexels').length
      console.log(`→ ${gallery_images.length}장 (DDG/OG:${ddgCount} + Pexels:${pxCount}) [${keyword.slice(0, 25)}]`)

      await supabasePatch('trends', t.id, { image_url, gallery_images })
      updated++
    } catch (e) {
      console.log(`❌ ${e.message}`)
      failed++
    }

    await new Promise(r => setTimeout(r, 600))
  }

  console.log(`\n──────────────────────────────────────`)
  console.log(`✨ 완료! 업데이트: ${updated}개 | 실패: ${failed}개 | 키워드 신규 생성: ${keywordGenerated}개`)
  console.log(`🌐 확인: http://localhost:3000\n`)
}

main().catch(err => { console.error('❌ 치명적 오류:', err); process.exit(1) })
