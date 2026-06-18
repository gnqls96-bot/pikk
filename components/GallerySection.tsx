'use client'

import { useState } from 'react'
import type { GalleryImage } from '@/lib/types'
import { proxyUrl } from '@/lib/utils/proxyUrl'

export default function GallerySection({ images }: { images: GalleryImage[] }) {
  const [broken, setBroken] = useState<Set<string>>(new Set())
  const mark = (url: string) => setBroken(prev => new Set([...prev, url]))

  const valid = images.filter(img => !broken.has(img.url))
  if (valid.length === 0) return null

  const gridItems = valid.slice(0, 4)
  const fifth = valid[4]

  return (
    <>
      <div className="border-t border-black/5 my-5" />
      <p className="text-xs font-bold mb-3" style={{ color: '#7F8C8D' }}>
        관련 이미지
      </p>
      <div className="grid grid-cols-2 gap-2">
        {gridItems.map((img) => (
          <div key={img.url}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={proxyUrl(img.url, { w: 400, h: 220, blur: true }) ?? img.url}
              alt=""
              className="w-full rounded-xl object-cover"
              style={{ height: '110px' }}
              loading="lazy"
              onError={() => mark(img.url)}
            />
            <a
              href={img.source_url}
              target="_blank"
              rel="noopener noreferrer"
              className="block text-center text-xs mt-1 transition-opacity hover:opacity-60 truncate px-1"
              style={{ color: '#7F8C8D' }}
            >
              출처: {img.site_name}
            </a>
          </div>
        ))}
      </div>
      {fifth && (
        <div className="mt-2">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={proxyUrl(fifth.url, { w: 800, h: 220, blur: true }) ?? fifth.url}
            alt=""
            className="w-full rounded-xl object-cover"
            style={{ height: '110px' }}
            loading="lazy"
            onError={() => mark(fifth.url)}
          />
          <a
            href={fifth.source_url}
            target="_blank"
            rel="noopener noreferrer"
            className="block text-center text-xs mt-1 transition-opacity hover:opacity-60"
            style={{ color: '#7F8C8D' }}
          >
            출처: {fifth.site_name}
          </a>
        </div>
      )}
    </>
  )
}
