'use client'

import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { CATEGORIES } from '@/lib/types'

interface Props {
  currentCategory: string
}

export default function HomeHeader({ currentCategory }: Props) {
  const router = useRouter()

  function selectCategory(cat: string) {
    router.push(cat === '전체' ? '/' : `/?category=${encodeURIComponent(cat)}`)
  }

  return (
    <header
      className="sticky top-0 z-50 border-b border-black/5"
      style={{ backgroundColor: '#F7F5F0' }}
    >
      <div className="max-w-6xl mx-auto px-4">
        {/* Logo row */}
        <div className="h-13 flex items-center justify-between py-3">
          <Link href="/" className="flex items-center gap-1.5">
            <span className="text-xl font-black tracking-tight" style={{ color: '#1A1A1A' }}>
              fliqk
            </span>
            <span
              className="text-xs font-bold px-1.5 py-0.5 rounded-full"
              style={{ backgroundColor: '#E8A87C', color: '#fff' }}
            >
              BETA
            </span>
          </Link>

          <AppDownloadButton />
        </div>

        {/* Category tabs */}
        <div
          className="flex gap-2 overflow-x-auto pb-3"
          style={{ scrollbarWidth: 'none', msOverflowStyle: 'none' }}
        >
          {['전체', ...CATEGORIES].map((cat) => {
            const isActive = currentCategory === cat
            return (
              <button
                key={cat}
                onClick={() => selectCategory(cat)}
                className="flex-shrink-0 text-xs font-semibold px-3.5 py-1.5 rounded-full transition-all duration-150"
                style={
                  isActive
                    ? { backgroundColor: '#4A90A4', color: '#fff' }
                    : { backgroundColor: '#fff', color: '#7F8C8D', border: '1px solid #e5e5e5' }
                }
              >
                {cat}
              </button>
            )
          })}
        </div>
      </div>
    </header>
  )
}

function AppDownloadButton() {
  return (
    <div className="relative group">
      <button
        className="flex items-center gap-1.5 text-xs font-bold px-3 py-2 rounded-full transition-opacity hover:opacity-80"
        style={{ backgroundColor: '#2C3E50', color: '#fff' }}
      >
        <span>📱</span>
        앱 다운로드
      </button>
      {/* Tooltip */}
      <div
        className="absolute right-0 top-full mt-2 w-44 rounded-xl px-4 py-3 text-center text-xs font-semibold text-white shadow-lg opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none"
        style={{ backgroundColor: '#2C3E50' }}
      >
        🚀 곧 출시 예정이에요!
        <div
          className="absolute -top-1.5 right-4 w-3 h-3 rotate-45"
          style={{ backgroundColor: '#2C3E50' }}
        />
      </div>
    </div>
  )
}
