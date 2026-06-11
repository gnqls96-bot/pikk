import { Suspense } from 'react'
import Header from '@/components/Header'
import TrendCard from '@/components/TrendCard'
import CategoryFilter from '@/components/CategoryFilter'
import { getTrends } from '@/lib/data/trends'
import type { Category } from '@/lib/types'

export default async function FeedPage({
  searchParams,
}: {
  searchParams: Promise<{ category?: string }>
}) {
  const params = await searchParams
  const category = params.category as Category | undefined
  const trends = await getTrends(category)

  return (
    <div className="min-h-screen" style={{ backgroundColor: '#F7F5F0' }}>
      <Header />

      <main className="max-w-5xl mx-auto px-4 py-6">
        {/* Page title */}
        <div className="mb-5">
          <h1 className="text-xl font-black" style={{ color: '#2C3E50' }}>
            {category ? `${category} 트렌드` : '전체 트렌드'}
          </h1>
          <p className="text-xs mt-1" style={{ color: '#7F8C8D' }}>
            {new Date().toLocaleDateString('ko-KR', {
              year: 'numeric',
              month: 'long',
              day: 'numeric',
              weekday: 'long',
            })}{' '}
            기준
          </p>
        </div>

        {/* Category filter */}
        <div className="mb-6">
          <Suspense fallback={<div className="h-9" />}>
            <CategoryFilter />
          </Suspense>
        </div>

        {/* Trend grid */}
        {trends.length === 0 ? (
          <div className="text-center py-20" style={{ color: '#7F8C8D' }}>
            <p className="text-4xl mb-3">🔍</p>
            <p className="text-sm">아직 트렌드가 없어요</p>
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {trends.map((trend) => (
              <TrendCard key={trend.id} trend={trend} />
            ))}
          </div>
        )}
      </main>
    </div>
  )
}
