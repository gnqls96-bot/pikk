import Link from 'next/link'

export default function Header() {
  return (
    <header
      className="sticky top-0 z-50 border-b border-black/5"
      style={{ backgroundColor: '#F7F5F0' }}
    >
      <div className="max-w-5xl mx-auto px-4 h-14 flex items-center justify-between">
        <Link href="/" className="flex items-center gap-1.5">
          <span
            className="text-2xl font-black tracking-tight"
            style={{ color: '#1A1A1A' }}
          >
            fliqk
          </span>
          <span
            className="text-xs font-medium px-1.5 py-0.5 rounded-full"
            style={{ backgroundColor: '#E8A87C', color: '#fff' }}
          >
            BETA
          </span>
        </Link>
        <nav className="flex items-center gap-2">
          <Link
            href="/feed"
            className="text-sm font-medium px-4 py-2 rounded-full transition-colors hover:opacity-80"
            style={{ backgroundColor: '#4A90A4', color: '#fff' }}
          >
            트렌드 보기
          </Link>
        </nav>
      </div>
    </header>
  )
}
