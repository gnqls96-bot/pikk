'use client'

import { useState } from 'react'
import type { GalleryImage } from '@/lib/types'
import { proxyUrl } from '@/lib/utils/proxyUrl'

interface Props {
  imageUrl: string
  title: string
  gallery0?: GalleryImage
  fallbackEmoji: string
  categoryColor: string
}

export default function HeroImage({ imageUrl, title, gallery0, fallbackEmoji, categoryColor }: Props) {
  const [error, setError] = useState(false)

  if (error) {
    return (
      <div
        className="h-52 sm:h-72 w-full flex items-center justify-center text-6xl"
        style={{ backgroundColor: categoryColor + '15' }}
      >
        {fallbackEmoji}
      </div>
    )
  }

  return (
    <div className="relative h-52 sm:h-72 w-full overflow-hidden bg-gray-100">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={proxyUrl(imageUrl, { w: 1200, h: 576, blur: true }) ?? imageUrl}
        alt={title}
        className="w-full h-full object-cover"
        onError={() => setError(true)}
      />
      {gallery0 && (
        <a
          href={gallery0.source_url}
          target="_blank"
          rel="noopener noreferrer"
          className="absolute bottom-2 right-2 text-xs px-2 py-0.5 rounded-full transition-opacity hover:opacity-80"
          style={{ backgroundColor: 'rgba(0,0,0,0.5)', color: 'rgba(255,255,255,0.85)' }}
        >
          {gallery0.site_name}
        </a>
      )}
    </div>
  )
}
