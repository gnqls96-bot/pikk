import { NextRequest, NextResponse } from 'next/server'

export async function POST(req: NextRequest) {
  const body = await req.json()
  const { email } = body

  if (!email || typeof email !== 'string' || !email.includes('@')) {
    return NextResponse.json({ error: '유효한 이메일을 입력해주세요' }, { status: 400 })
  }

  if (process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.NEXT_PUBLIC_SUPABASE_URL !== 'your_supabase_project_url') {
    try {
      const { createServerClient } = await import('@/lib/supabase/server')
      const supabase = createServerClient()
      const { error } = await supabase.from('waitlist').insert({ email })
      if (error) {
        if (error.code === '23505') {
          return NextResponse.json({ error: '이미 등록된 이메일입니다' }, { status: 409 })
        }
        throw error
      }
    } catch (err) {
      console.error('Waitlist insert error:', err)
      return NextResponse.json({ error: '서버 오류가 발생했습니다' }, { status: 500 })
    }
  }

  return NextResponse.json({ success: true })
}
