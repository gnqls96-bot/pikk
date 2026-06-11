import type { Metadata } from 'next'
import './globals.css'
import FloatingAppButton from '@/components/FloatingAppButton'

export const metadata: Metadata = {
  title: 'Pikk — 남들보다 먼저 아는 사람들의 앱',
  description: '전세계 트렌드를 매일 한국어로 큐레이션해드립니다. 푸드, 뷰티, SNS, 패션, 테크, 라이프 트렌드를 가장 빠르게 만나보세요.',
  keywords: ['트렌드', '글로벌 트렌드', '큐레이션', '한국어', 'Pikk'],
  openGraph: {
    title: 'Pikk — 남들보다 먼저 아는 사람들의 앱',
    description: '전세계 트렌드를 매일 한국어로 큐레이션',
    type: 'website',
  },
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ko" className="h-full">
      <body className="min-h-full flex flex-col antialiased">
        {children}
        <FloatingAppButton />
      </body>
    </html>
  )
}
