import { NextRequest, NextResponse } from 'next/server'

export const runtime = 'nodejs'

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'

function isPrivateHost(hostname: string): boolean {
  return (
    hostname === 'localhost' ||
    hostname === '127.0.0.1' ||
    hostname === '::1' ||
    hostname.startsWith('192.168.') ||
    hostname.startsWith('10.') ||
    hostname.startsWith('172.16.') ||
    hostname.endsWith('.local') ||
    hostname.endsWith('.internal')
  )
}

export async function GET(req: NextRequest) {
  const url = req.nextUrl.searchParams.get('url')
  if (!url) return new NextResponse('Missing url', { status: 400 })

  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return new NextResponse('Invalid url', { status: 400 })
  }

  if (!['http:', 'https:'].includes(parsed.protocol)) {
    return new NextResponse('Invalid protocol', { status: 400 })
  }
  if (isPrivateHost(parsed.hostname)) {
    return new NextResponse('Forbidden', { status: 403 })
  }

  const blur = req.nextUrl.searchParams.get('blur') === '1'
  const w = parseInt(req.nextUrl.searchParams.get('w') ?? '0', 10) || 0
  const h = parseInt(req.nextUrl.searchParams.get('h') ?? '0', 10) || 0

  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, Accept: 'image/webp,image/avif,image/*,*/*;q=0.8' },
      signal: AbortSignal.timeout(10000),
      redirect: 'follow',
    })
    if (!res.ok) return new NextResponse('Upstream error', { status: 502 })

    const contentType = res.headers.get('content-type') ?? 'image/jpeg'
    if (!contentType.startsWith('image/')) {
      return new NextResponse('Not an image', { status: 415 })
    }

    const body = Buffer.from(await res.arrayBuffer())

    if (blur && w > 0 && h > 0) {
      try {
        const { buildCoverComposite } = await import('@/lib/utils/buildCoverComposite')
        const composed = await buildCoverComposite(body, w, h)
        return new NextResponse(composed.buffer as ArrayBuffer, {
          headers: {
            'Content-Type': 'image/jpeg',
            'Cache-Control': 'public, max-age=604800, s-maxage=604800',
            'Access-Control-Allow-Origin': '*',
          },
        })
      } catch (err) {
        console.error('[image-proxy blur] sharp failed, falling through:', err)
        // fall through to pass-through response
      }
    }

    return new NextResponse(body.buffer as ArrayBuffer, {
      headers: {
        'Content-Type': contentType,
        'Cache-Control': 'public, max-age=86400, s-maxage=86400',
        'Access-Control-Allow-Origin': '*',
      },
    })
  } catch {
    return new NextResponse('Fetch failed', { status: 502 })
  }
}
