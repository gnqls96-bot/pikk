export type Category = '푸드' | '뷰티' | 'SNS' | '패션' | '테크' | '라이프' | '디자인' | '광고' | '영상'

export const CATEGORIES: Category[] = ['푸드', '뷰티', 'SNS', '패션', '테크', '라이프', '디자인', '광고', '영상']

export const CATEGORY_COLORS: Record<Category, string> = {
  '푸드': '#FF6B6B',
  '뷰티': '#FF8DA1',
  'SNS': '#7C67EE',
  '패션': '#2ECC71',
  '테크': '#4A90A4',
  '라이프': '#E8A87C',
  '디자인': '#9B59B6',
  '광고': '#F39C12',
  '영상': '#E74C3C',
}

export const CATEGORY_BG: Record<Category, string> = {
  '푸드': 'bg-[#FF6B6B]',
  '뷰티': 'bg-[#FF8DA1]',
  'SNS': 'bg-[#7C67EE]',
  '패션': 'bg-[#2ECC71]',
  '테크': 'bg-[#4A90A4]',
  '라이프': 'bg-[#E8A87C]',
  '디자인': 'bg-[#9B59B6]',
  '광고': 'bg-[#F39C12]',
  '영상': 'bg-[#E74C3C]',
}

export const CATEGORY_EMOJI: Record<Category, string> = {
  '푸드': '🍜', '뷰티': '💄', 'SNS': '📱', '패션': '👗',
  '테크': '💻', '라이프': '✨', '디자인': '🎨', '광고': '📣', '영상': '🎬',
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
