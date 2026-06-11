import { NextRequest, NextResponse } from 'next/server'

export async function GET(req: NextRequest) {
  const q = req.nextUrl.searchParams.get('q')
  if (!q) return NextResponse.json({ error: 'Missing q' }, { status: 400 })

  const res = await fetch(
    `https://api.pexels.com/v1/search?query=${encodeURIComponent(q)}&per_page=1&orientation=landscape`,
    {
      headers: { Authorization: process.env.PEXELS_API_KEY! },
      next: { revalidate: 86400 },
    }
  )

  if (!res.ok) return NextResponse.json({ error: 'Pexels API error' }, { status: 502 })

  const data = await res.json()
  const url = (data.photos?.[0]?.src?.large2x as string) ?? null

  return NextResponse.json({ url })
}
