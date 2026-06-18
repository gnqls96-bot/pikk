'use client'

import Link from 'next/link'
import { useState, useEffect } from 'react'
import type { Trend } from '@/lib/types'
import { CATEGORY_COLORS, CATEGORY_EMOJI } from '@/lib/types'
import { proxyUrl } from '@/lib/utils/proxyUrl'

function formatDate(dateStr: string) {
  const date = new Date(dateStr)
  const now = new Date()
  const diff = Math.floor((now.getTime() - date.getTime()) / 1000)
  if (diff < 3600) return `${Math.floor(diff / 60)}분 전`
  if (diff < 86400) return `${Math.floor(diff / 3600)}시간 전`
  return `${Math.floor(diff / 86400)}일 전`
}

export default function TrendCard({ trend }: { trend: Trend }) {
  const categoryColor = CATEGORY_COLORS[trend.category]
  const [imgSrc, setImgSrc] = useState<string | null>(proxyUrl(trend.image_url, { w: 600, h: 264, blur: true }))
  const [loading, setLoading] = useState(!trend.image_url)
  const [imgError, setImgError] = useState(false)

  useEffect(() => {
    if (trend.image_url) return
    fetch(`/api/pexels?q=${encodeURIComponent(trend.title)}`)
      .then(r => r.json())
      .then(data => { if (data.url) setImgSrc(proxyUrl(data.url, { w: 600, h: 264, blur: true })) })
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [trend.id, trend.title, trend.image_url])

  return (
    <Link href={`/trend/${trend.id}`} className="block group">
      <article
        className="rounded-2xl overflow-hidden transition-all duration-200 group-hover:-translate-y-1 group-hover:shadow-lg"
        style={{ backgroundColor: '#fff', boxShadow: '0 1px 4px rgba(0,0,0,0.06)' }}
      >
        {/* Category bar */}
        <div className="h-1" style={{ backgroundColor: categoryColor }} />

        {/* Image */}
        <div className="relative h-44 w-full overflow-hidden bg-gray-100">
          {loading ? (
            <div
              className="w-full h-full animate-pulse"
              style={{ backgroundColor: categoryColor + '30' }}
            />
          ) : imgSrc && !imgError ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={imgSrc}
              alt={trend.title}
              className="w-full h-full object-cover transition-transform duration-300 group-hover:scale-105"
              onError={() => setImgError(true)}
            />
          ) : (
            <div
              className="w-full h-full flex items-center justify-center text-4xl"
              style={{ backgroundColor: categoryColor + '20' }}
            >
              {CATEGORY_EMOJI[trend.category]}
            </div>
          )}
        </div>

        {/* Content */}
        <div className="p-4">
          <div className="flex items-center justify-between mb-2">
            <span
              className="text-xs font-bold px-2 py-0.5 rounded-full"
              style={{ backgroundColor: categoryColor + '18', color: categoryColor }}
            >
              {trend.category}
            </span>
            <span className="text-xs" style={{ color: '#7F8C8D' }}>
              {formatDate(trend.published_at)}
            </span>
          </div>

          <h2
            className="font-bold text-sm leading-snug mb-2 line-clamp-2"
            style={{ color: '#2C3E50' }}
          >
            {trend.title}
          </h2>

          <p
            className="text-xs leading-relaxed line-clamp-3"
            style={{ color: '#7F8C8D' }}
          >
            {trend.summary}
          </p>

          <div className="mt-3 flex items-center justify-between">
            <div className="flex gap-1 flex-wrap">
              {trend.tags.slice(0, 2).map((tag) => (
                <span
                  key={tag}
                  className="text-xs px-2 py-0.5 rounded-full"
                  style={{ backgroundColor: '#F7F5F0', color: '#7F8C8D' }}
                >
                  #{tag}
                </span>
              ))}
            </div>
            <span className="text-xs font-medium" style={{ color: '#4A90A4' }}>
              읽기 →
            </span>
          </div>
        </div>
      </article>
    </Link>
  )
}
