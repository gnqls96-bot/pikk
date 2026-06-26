import { seedTrends } from './seed'
import type { Trend } from '../types'

export async function getTrends(category?: string): Promise<Trend[]> {
  if (
    process.env.NEXT_PUBLIC_SUPABASE_URL &&
    process.env.NEXT_PUBLIC_SUPABASE_URL !== 'your_supabase_project_url'
  ) {
    try {
      const { createServerClient } = await import('../supabase/server')
      const supabase = createServerClient()
      let query = supabase
        .from('trends')
        .select('*')
        .or('instagram_post_id.is.null,instagram_post_id.not.in.(duplicate_removed,skipped)')
        .order('published_at', { ascending: false })
      if (category) query = query.eq('category', category)
      const { data, error } = await query
      if (!error && data) return data as Trend[]
    } catch {
      // fall through
    }
  }
  return category
    ? seedTrends.filter((t) => t.category === category)
    : seedTrends
}
