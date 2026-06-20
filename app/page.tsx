import Link from 'next/link'
import { Suspense } from 'react'
import HomeHeader from '@/components/HomeHeader'
import TrendCard from '@/components/TrendCard'
import AppDownloadBanner from '@/components/AppDownloadBanner'
import EmailCapture from '@/components/EmailCapture'
import { getTrends } from '@/lib/data/trends'
import { CATEGORY_COLORS } from '@/lib/types'
import type { Category, Trend } from '@/lib/types'

function chunkArray<T>(arr: T[], size: number): T[][] {
  const chunks: T[][] = []
  for (let i = 0; i < arr.length; i += size) chunks.push(arr.slice(i, i + size))
  return chunks
}

export default async function HomePage({
  searchParams,
}: {
  searchParams: Promise<{ category?: string }>
}) {
  const params = await searchParams
  const category = params.category as Category | undefined
  const trends = await getTrends(category)

  const heroTrend = trends[0] ?? null
  const restTrends = trends.slice(1)
  const chunks = chunkArray(restTrends, 6)
  const currentCategory = category ?? '전체'

  return (
    <div className="min-h-screen" style={{ backgroundColor: '#F7F5F0' }}>
      <Suspense fallback={null}>
        <HomeHeader currentCategory={currentCategory} />
      </Suspense>

      <main className="max-w-6xl mx-auto px-4 py-6">

        {/* Hero — top trend */}
        {heroTrend && <HeroTrend trend={heroTrend} />}

        {/* Section header */}
        <div className="flex items-center justify-between mb-4 mt-8">
          <h2 className="text-sm font-black" style={{ color: '#2C3E50' }}>
            {category ? `${category} 트렌드` : '최신 트렌드'}
          </h2>
          <span className="text-xs" style={{ color: '#7F8C8D' }}>
            {restTrends.length}개
          </span>
        </div>

        {/* Trend grid with banners every 6 cards */}
        {restTrends.length === 0 ? (
          <div className="text-center py-20" style={{ color: '#7F8C8D' }}>
            <p className="text-4xl mb-3">🔍</p>
            <p className="text-sm">아직 트렌드가 없어요</p>
          </div>
        ) : (
          <div className="space-y-6">
            {chunks.map((chunk, i) => (
              <div key={i}>
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                  {chunk.map((trend) => (
                    <TrendCard key={trend.id} trend={trend} />
                  ))}
                </div>
                <div className="mt-6">
                  <AppDownloadBanner />
                </div>
              </div>
            ))}
          </div>
        )}
      </main>

      {/* Footer with email capture */}
      <footer
        className="mt-16 border-t border-black/5 py-12"
        style={{ backgroundColor: '#fff' }}
      >
        <div className="max-w-6xl mx-auto px-4">
          <div className="max-w-md mx-auto text-center">
            <p className="text-sm font-black mb-1" style={{ color: '#2C3E50' }}>
              앱 출시 알림 신청
            </p>
            <p className="text-xs mb-5" style={{ color: '#7F8C8D' }}>
              출시되면 가장 먼저 알려드려요
            </p>
            <EmailCapture />
          </div>
          <div className="mt-10 pt-6 border-t border-black/5 text-center">
            <p className="text-xs" style={{ color: '#7F8C8D' }}>
              © 2026 Fliqk. 남들보다 먼저 아는 사람들의 앱.
            </p>
          </div>
        </div>
      </footer>
    </div>
  )
}

function HeroTrend({ trend }: { trend: Trend }) {
  const color = CATEGORY_COLORS[trend.category]

  return (
    <Link href={`/trend/${trend.id}`} className="block group mb-2">
      <div
        className="relative rounded-2xl overflow-hidden"
        style={{ height: '420px' }}
      >
        {trend.image_url ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={trend.image_url}
            alt={trend.title}
            className="w-full h-full object-cover transition-transform duration-500 group-hover:scale-105"
          />
        ) : (
          <div className="w-full h-full" style={{ backgroundColor: color + '30' }} />
        )}

        {/* Gradient overlay */}
        <div
          className="absolute inset-0"
          style={{
            background:
              'linear-gradient(to top, rgba(0,0,0,0.82) 0%, rgba(0,0,0,0.35) 45%, transparent 100%)',
          }}
        />

        {/* TOP badge */}
        <div className="absolute top-5 left-5">
          <span
            className="text-xs font-black px-2.5 py-1 rounded-full"
            style={{ backgroundColor: '#E8A87C', color: '#fff' }}
          >
            TODAY TOP
          </span>
        </div>

        {/* Content */}
        <div className="absolute bottom-0 left-0 right-0 p-6 sm:p-8">
          <span
            className="inline-block text-xs font-bold px-2.5 py-1 rounded-full mb-3"
            style={{ backgroundColor: color, color: '#fff' }}
          >
            {trend.category}
          </span>
          <h1
            className="text-2xl sm:text-3xl font-black text-white leading-tight mb-2"
            style={{ textShadow: '0 1px 4px rgba(0,0,0,0.3)' }}
          >
            {trend.title}
          </h1>
          <p
            className="text-sm line-clamp-2 mb-4"
            style={{ color: 'rgba(255,255,255,0.75)' }}
          >
            {trend.summary}
          </p>
          <div className="flex items-center gap-2">
            <span
              className="text-xs font-bold px-3 py-1.5 rounded-full transition-opacity group-hover:opacity-80"
              style={{ backgroundColor: '#fff', color: '#2C3E50' }}
            >
              자세히 보기 →
            </span>
            <div className="flex gap-1">
              {trend.tags.slice(0, 2).map((tag) => (
                <span key={tag} className="text-xs px-2 py-1 rounded-full" style={{ backgroundColor: 'rgba(255,255,255,0.15)', color: 'rgba(255,255,255,0.8)' }}>
                  #{tag}
                </span>
              ))}
            </div>
          </div>
        </div>
      </div>
    </Link>
  )
}
