const APP_FEATURES = [
  '매일 아침 7시 트렌드 알림',
  '관심 카테고리 맞춤 큐레이션',
  'AI에게 트렌드 더 물어보기',
  '트렌드 저장 & 컬렉션 만들기',
]

export default function AppDownloadBanner() {
  return (
    <div
      className="rounded-2xl p-6 sm:p-8 flex flex-col sm:flex-row items-start sm:items-center gap-6"
      style={{ backgroundColor: '#2C3E50' }}
    >
      {/* Left: features */}
      <div className="flex-1 min-w-0">
        <p className="text-xs font-black tracking-wide uppercase mb-4" style={{ color: '#E8A87C' }}>
          앱에서만 가능한 것들
        </p>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
          {APP_FEATURES.map((feature) => (
            <div key={feature} className="flex items-center gap-2">
              <span className="text-sm font-bold" style={{ color: '#2ECC71' }}>✓</span>
              <span className="text-xs leading-snug" style={{ color: 'rgba(255,255,255,0.8)' }}>
                {feature}
              </span>
            </div>
          ))}
        </div>
      </div>

      {/* Right: store buttons */}
      <div className="flex flex-row sm:flex-col gap-2 flex-shrink-0">
        <StoreButton icon="🍎" store="App Store" />
        <StoreButton icon="▶" store="Google Play" />
      </div>
    </div>
  )
}

function StoreButton({ icon, store }: { icon: string; store: string }) {
  return (
    <div
      className="flex items-center gap-2 px-4 py-2.5 rounded-xl cursor-not-allowed"
      style={{ backgroundColor: 'rgba(255,255,255,0.1)', border: '1px solid rgba(255,255,255,0.15)' }}
    >
      <span className="text-sm">{icon}</span>
      <div>
        <p className="text-xs font-bold text-white leading-none">{store}</p>
        <p className="text-xs mt-0.5" style={{ color: 'rgba(255,255,255,0.45)' }}>곧 출시 예정</p>
      </div>
    </div>
  )
}
