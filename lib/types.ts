export type Category = '푸드' | '뷰티' | 'SNS' | '패션' | '테크' | '라이프' | '디자인' | 'KPOP' | '엔터'

export const CATEGORIES: Category[] = ['푸드', '뷰티', 'SNS', '패션', '테크', '라이프', '디자인', 'KPOP', '엔터']

export const CATEGORY_COLORS: Record<Category, string> = {
  '푸드': '#FF6B6B',
  '뷰티': '#FF8DA1',
  'SNS': '#7C67EE',
  '패션': '#2ECC71',
  '테크': '#4A90A4',
  '라이프': '#E8A87C',
  '디자인': '#9B59B6',
  'KPOP': '#FF4081',
  '엔터': '#E74C3C',
}

export const CATEGORY_BG: Record<Category, string> = {
  '푸드': 'bg-[#FF6B6B]',
  '뷰티': 'bg-[#FF8DA1]',
  'SNS': 'bg-[#7C67EE]',
  '패션': 'bg-[#2ECC71]',
  '테크': 'bg-[#4A90A4]',
  '라이프': 'bg-[#E8A87C]',
  '디자인': 'bg-[#9B59B6]',
  'KPOP': 'bg-[#FF4081]',
  '엔터': 'bg-[#E74C3C]',
}

export const CATEGORY_EMOJI: Record<Category, string> = {
  '푸드': '🍜', '뷰티': '💄', 'SNS': '📱', '패션': '👗',
  '테크': '💻', '라이프': '✨', '디자인': '🎨', 'KPOP': '🎤', '엔터': '🎭',
}

// DB 마이그레이션 전 기존 값('광고', '영상') 폴백 — SQL 마이그레이션 완료 후 제거
const LEGACY_COLORS: Record<string, string> = { '광고': '#FF4081', '영상': '#E74C3C' }
const LEGACY_EMOJI: Record<string, string> = { '광고': '🎤', '영상': '🎭' }
export function getCategoryColor(cat: string): string {
  return (CATEGORY_COLORS as Record<string, string>)[cat] ?? LEGACY_COLORS[cat] ?? '#4A90A4'
}
export function getCategoryEmoji(cat: string): string {
  return (CATEGORY_EMOJI as Record<string, string>)[cat] ?? LEGACY_EMOJI[cat] ?? '✨'
}

export interface RelatedSource {
  title: string
  url: string
  site_name: string
}

export interface GalleryImage {
  url: string
  source_url: string
  site_name: string
}

export interface Trend {
  id: string
  title: string
  summary: string
  original_title: string | null
  category: Category
  source_url: string | null
  image_url: string | null
  tags: string[]
  view_count: number
  created_at: string
  published_at: string
  why_trending: string | null
  who_affected: string | null
  heat_score: number | null
  body: string | null
  related_sources: RelatedSource[] | null
  gallery_images: GalleryImage[] | null
}

export interface WaitlistEntry {
  id: string
  email: string
  created_at: string
}
