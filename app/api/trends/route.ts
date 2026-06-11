import { NextRequest, NextResponse } from 'next/server'
import { seedTrends } from '@/lib/data/seed'
import type { Category } from '@/lib/types'

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url)
  const category = searchParams.get('category') as Category | null

  // If Supabase is configured, use it; otherwise fall back to seed data
  if (process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.NEXT_PUBLIC_SUPABASE_URL !== 'your_supabase_project_url') {
    try {
      const { createServerClient } = await import('@/lib/supabase/server')
      const supabase = createServerClient()
      let query = supabase
        .from('trends')
        .select('*')
        .order('published_at', { ascending: false })
      if (category) query = query.eq('category', category)
      const { data, error } = await query
      if (error) throw error
      return NextResponse.json(data)
    } catch {
      // fall through to seed data
    }
  }

  const filtered = category
    ? seedTrends.filter((t) => t.category === category)
    : seedTrends
  return NextResponse.json(filtered)
}
