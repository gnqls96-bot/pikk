import { NextRequest, NextResponse } from 'next/server'
import type { GalleryImage } from '@/lib/types'

export const maxDuration = 30

function checkAuth(req: NextRequest) {
  return req.headers.get('x-admin-token') === process.env.ADMIN_PASSWORD
}

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'

async function validateImage(url: string): Promise<boolean> {
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
  } catch {
    return false
  }
}

async function fetchDDGImages(query: string, count = 6): Promise<GalleryImage[]> {
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
      .filter((img: { image: string; width?: number }) => img.image && (img.width ?? 0) >= 800)
      .slice(0, count + 4)
      .map((img: { image: string; url?: string }) => {
        let siteName = 'Web'
        try {
          siteName = new URL(img.url ?? img.image).hostname.replace(/^www\./, '')
        } catch {}
        return { url: img.image, source_url: img.url ?? img.image, site_name: siteName }
      })
  } catch {
    return []
  }
}

async function fetchOgImage(src: { url: string; site_name: string }): Promise<GalleryImage | null> {
  if (!src.url || src.url.includes('example.com')) return null
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
    if (!(await validateImage(imgUrl))) return null
    return { url: imgUrl, source_url: src.url, site_name: src.site_name }
  } catch {
    return null
  }
}

async function fetchPexelsImages(keyword: string, count: number): Promise<GalleryImage[]> {
  if (!process.env.PEXELS_API_KEY || count <= 0) return []
  try {
    const res = await fetch(
      `https://api.pexels.com/v1/search?query=${encodeURIComponent(keyword)}&per_page=${Math.min(count + 3, 15)}&orientation=landscape`,
      { headers: { Authorization: process.env.PEXELS_API_KEY }, signal: AbortSignal.timeout(8000) }
    )
    if (!res.ok) return []
    const data = await res.json()
    return (data.photos ?? [])
      .slice(0, count)
      .map((p: { src: { large2x: string }; url: string }) => ({
        url: p.src?.large2x ?? '',
        source_url: p.url ?? 'https://www.pexels.com',
        site_name: 'Pexels',
      }))
      .filter((img: GalleryImage) => img.url)
  } catch {
    return []
  }
}

async function collectImages(
  keyword: string,
  sources: { url: string; site_name: string }[]
): Promise<{ image_url: string | null; gallery_images: GalleryImage[] }> {
  const TARGET = 5
  const seen = new Set<string>()
  const gallery: GalleryImage[] = []

  const addIfNew = async (img: GalleryImage | null, validate = false) => {
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
    const ogResults = await Promise.all(sources.map(fetchOgImage))
    for (const img of ogResults) await addIfNew(img)
  }

  // 3순위: Pexels
  if (gallery.length < TARGET) {
    const pexels = await fetchPexelsImages(keyword, TARGET - gallery.length)
    for (const img of pexels) await addIfNew(img)
  }

  return { image_url: gallery[0]?.url ?? null, gallery_images: gallery }
}

export async function POST(req: NextRequest) {
  if (!checkAuth(req)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { trendId } = await req.json()
  if (!trendId) return NextResponse.json({ error: 'Missing trendId' }, { status: 400 })

  const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!
  const SUPABASE_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  const headers = { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` }

  const trendRes = await fetch(
    `${SUPABASE_URL}/rest/v1/trends?id=eq.${trendId}&select=id,image_search_keyword,related_sources`,
    { headers }
  )
  const [trend] = await trendRes.json()
  if (!trend) return NextResponse.json({ error: 'Trend not found' }, { status: 404 })

  const keyword = trend.image_search_keyword ?? 'trend lifestyle'
  const { image_url, gallery_images } = await collectImages(keyword, trend.related_sources ?? [])

  await fetch(`${SUPABASE_URL}/rest/v1/trends?id=eq.${trendId}`, {
    method: 'PATCH',
    headers: { ...headers, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
    body: JSON.stringify({ image_url, gallery_images }),
  })

  return NextResponse.json({ success: true, imageCount: gallery_images.length })
}
