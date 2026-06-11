'use client'

import { useRouter, useSearchParams, usePathname } from 'next/navigation'
import { CATEGORIES } from '@/lib/types'

const ALL = '전체'

export default function CategoryFilter() {
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const current = searchParams.get('category') ?? ALL

  function handleSelect(cat: string) {
    const params = new URLSearchParams(searchParams.toString())
    if (cat === ALL) {
      params.delete('category')
    } else {
      params.set('category', cat)
    }
    router.push(`${pathname}?${params.toString()}`)
  }

  const tabs = [ALL, ...CATEGORIES]

  return (
    <div className="flex gap-2 overflow-x-auto pb-1 scrollbar-hide" style={{ scrollbarWidth: 'none' }}>
      {tabs.map((cat) => {
        const isActive = current === cat
        return (
          <button
            key={cat}
            onClick={() => handleSelect(cat)}
            className="flex-shrink-0 text-sm font-medium px-4 py-1.5 rounded-full transition-all duration-150"
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
  )
}
