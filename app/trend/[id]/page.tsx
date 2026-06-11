import Link from 'next/link'
import Image from 'next/image'
import { notFound } from 'next/navigation'
import Header from '@/components/Header'
import { CATEGORY_COLORS } from '@/lib/types'
import { getTrends } from '@/lib/data/trends'
import type { Trend } from '@/lib/types'

async function getTrend(id: string): Promise<Trend | null> {
  if (
    process.env.NEXT_PUBLIC_SUPABASE_URL &&
    process.env.NEXT_PUBLIC_SUPABASE_URL !== 'your_supabase_project_url'
  ) {
    try {
      const { createServerClient } = await import('@/lib/supabase/server')
      const supabase = createServerClient()
      const { data, error } = await supabase
        .from('trends')
        .select('*')
        .eq('id', id)
        .single()
      if (!error && data) return data as Trend
    } catch {
      // fall through
    }
  }
  const { seedTrends } = await import('@/lib/data/seed')
  return seedTrends.find((t) => t.id === id) ?? null
}

function formatDate(dateStr: string) {
  return new Date(dateStr).toLocaleDateString('ko-KR', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  })
}

export default async function TrendDetailPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params
  const [trend, allTrends] = await Promise.all([getTrend(id), getTrends()])

  if (!trend) notFound()

  const categoryColor = CATEGORY_COLORS[trend.category]
  const related = allTrends
    .filter((t) => t.category === trend.category && t.id !== id)
    .slice(0, 3)

  return (
    <div className="min-h-screen" style={{ backgroundColor: '#F7F5F0' }}>
      <Header />

      <main className="max-w-2xl mx-auto px-4 py-8">
        {/* Back */}
        <Link
          href="/"
          className="inline-flex items-center gap-1.5 text-sm mb-6 transition-opacity hover:opacity-70"
          style={{ color: '#7F8C8D' }}
        >
          ← 피드로 돌아가기
        </Link>

        {/* Article card */}
        <article
          className="rounded-2xl overflow-hidden mb-8"
          style={{ backgroundColor: '#fff', boxShadow: '0 1px 8px rgba(0,0,0,0.08)' }}
        >
          {/* Category bar */}
          <div className="h-1.5" style={{ backgroundColor: categoryColor }} />

          {/* Hero image */}
          {trend.image_url && (
            <div className="relative h-52 sm:h-72 w-full overflow-hidden bg-gray-100">
              <Image
                src={trend.image_url}
                alt={trend.title}
                fill
                className="object-cover"
                priority
                sizes="(max-width: 672px) 100vw, 672px"
              />
            </div>
          )}

          <div className="p-6 sm:p-8">
            {/* Meta */}
            <div className="flex items-center gap-2 mb-4">
              <span
                className="text-xs font-bold px-2.5 py-1 rounded-full"
                style={{ backgroundColor: categoryColor + '18', color: categoryColor }}
              >
                {trend.category}
              </span>
              <span className="text-xs" style={{ color: '#7F8C8D' }}>
                {formatDate(trend.published_at)}
              </span>
              <span className="text-xs" style={{ color: '#7F8C8D' }}>
                · 조회 {trend.view_count.toLocaleString()}
              </span>
            </div>

            {/* Title */}
            <h1
              className="text-xl sm:text-2xl font-black leading-snug mb-2"
              style={{ color: '#2C3E50' }}
            >
              {trend.title}
            </h1>

            {/* Original title */}
            {trend.original_title && (
              <p className="text-sm mb-5 italic" style={{ color: '#7F8C8D' }}>
                {trend.original_title}
              </p>
            )}

            <div className="border-t border-black/5 my-5" />

            {/* Summary */}
            <p className="text-sm leading-loose" style={{ color: '#2C3E50' }}>
              {trend.summary}
            </p>

            {/* Tags */}
            {trend.tags.length > 0 && (
              <div className="flex flex-wrap gap-2 mt-6">
                {trend.tags.map((tag) => (
                  <span
                    key={tag}
                    className="text-xs px-3 py-1 rounded-full"
                    style={{ backgroundColor: '#F7F5F0', color: '#7F8C8D' }}
                  >
                    #{tag}
                  </span>
                ))}
              </div>
            )}

            {/* Source */}
            {trend.source_url && trend.source_url !== 'https://example.com' && (
              <div className="mt-6 pt-5 border-t border-black/5">
                <a
                  href={trend.source_url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1.5 text-xs font-medium transition-opacity hover:opacity-70"
                  style={{ color: '#4A90A4' }}
                >
                  원문 보기 →
                </a>
              </div>
            )}
          </div>
        </article>

        {/* App download CTA */}
        <section
          className="rounded-2xl p-6 sm:p-8 mb-8"
          style={{ backgroundColor: '#2C3E50' }}
        >
          <div className="flex items-start gap-3 mb-3">
            <span className="text-2xl">🤖</span>
            <div>
              <h2 className="font-black text-white text-base leading-snug">
                이 트렌드를 더 깊게 파고 싶다면?
              </h2>
              <p className="text-xs mt-1 leading-relaxed" style={{ color: 'rgba(255,255,255,0.6)' }}>
                Pikk 앱에서 AI와 대화하며 트렌드를 깊이 분석해보세요.
                &ldquo;이 트렌드가 한국에 언제 오나요?&rdquo;,
                &ldquo;비슷한 트렌드는 뭐가 있나요?&rdquo; 바로 물어볼 수 있어요.
              </p>
            </div>
          </div>

          <div className="mt-5 flex flex-wrap gap-2">
            <StoreButton icon="🍎" store="App Store" />
            <StoreButton icon="▶" store="Google Play" />
          </div>
        </section>

        {/* Related trends */}
        {related.length > 0 && (
          <section>
            <h2 className="text-sm font-bold mb-3" style={{ color: '#2C3E50' }}>
              같은 카테고리 트렌드
            </h2>
            <div className="flex flex-col gap-3">
              {related.map((t) => (
                <Link
                  key={t.id}
                  href={`/trend/${t.id}`}
                  className="flex items-center gap-3 p-3 rounded-xl transition-opacity hover:opacity-80"
                  style={{ backgroundColor: '#fff', boxShadow: '0 1px 4px rgba(0,0,0,0.05)' }}
                >
                  {t.image_url && (
                    <div className="relative w-14 h-14 rounded-lg overflow-hidden flex-shrink-0 bg-gray-100">
                      <Image
                        src={t.image_url}
                        alt={t.title}
                        fill
                        className="object-cover"
                        sizes="56px"
                      />
                    </div>
                  )}
                  <div className="min-w-0">
                    <p
                      className="text-xs font-semibold leading-snug line-clamp-2"
                      style={{ color: '#2C3E50' }}
                    >
                      {t.title}
                    </p>
                    <p className="text-xs mt-0.5" style={{ color: '#7F8C8D' }}>
                      {formatDate(t.published_at)}
                    </p>
                  </div>
                </Link>
              ))}
            </div>
          </section>
        )}
      </main>
    </div>
  )
}

function StoreButton({ icon, store }: { icon: string; store: string }) {
  return (
    <div
      className="flex items-center gap-2 px-4 py-2.5 rounded-xl cursor-not-allowed"
      style={{
        backgroundColor: 'rgba(255,255,255,0.1)',
        border: '1px solid rgba(255,255,255,0.15)',
      }}
    >
      <span className="text-sm">{icon}</span>
      <div>
        <p className="text-xs font-bold text-white leading-none">{store}</p>
        <p className="text-xs mt-0.5" style={{ color: 'rgba(255,255,255,0.45)' }}>
          곧 출시 예정
        </p>
      </div>
    </div>
  )
}
