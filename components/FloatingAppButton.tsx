'use client'

import { useState } from 'react'

export default function FloatingAppButton() {
  const [showTooltip, setShowTooltip] = useState(false)

  return (
    <div className="fixed bottom-6 right-5 z-50">
      {/* Tooltip */}
      {showTooltip && (
        <div
          className="absolute bottom-full right-0 mb-3 w-52 rounded-2xl p-4 shadow-xl"
          style={{ backgroundColor: '#2C3E50' }}
        >
          <p className="text-xs font-black text-white mb-3">📱 앱 출시 알림 받기</p>
          <div className="space-y-1.5 mb-3">
            {['매일 아침 7시 트렌드 알림', 'AI 트렌드 분석', '맞춤 큐레이션'].map((f) => (
              <div key={f} className="flex items-center gap-1.5">
                <span className="text-xs" style={{ color: '#2ECC71' }}>✓</span>
                <span className="text-xs" style={{ color: 'rgba(255,255,255,0.75)' }}>{f}</span>
              </div>
            ))}
          </div>
          <div className="space-y-1.5">
            <div
              className="flex items-center gap-2 px-3 py-2 rounded-lg text-xs font-bold"
              style={{ backgroundColor: 'rgba(255,255,255,0.1)', color: 'rgba(255,255,255,0.5)' }}
            >
              🍎 App Store — 곧 출시
            </div>
            <div
              className="flex items-center gap-2 px-3 py-2 rounded-lg text-xs font-bold"
              style={{ backgroundColor: 'rgba(255,255,255,0.1)', color: 'rgba(255,255,255,0.5)' }}
            >
              ▶ Google Play — 곧 출시
            </div>
          </div>
          {/* Arrow */}
          <div
            className="absolute -bottom-1.5 right-5 w-3 h-3 rotate-45"
            style={{ backgroundColor: '#2C3E50' }}
          />
        </div>
      )}

      {/* Floating button */}
      <button
        onClick={() => setShowTooltip((v) => !v)}
        className="flex items-center gap-2 px-4 py-3 rounded-full text-sm font-bold shadow-lg transition-transform hover:scale-105 active:scale-95"
        style={{ backgroundColor: '#2C3E50', color: '#fff' }}
      >
        <span>📱</span>
        <span className="hidden sm:inline">앱 다운로드</span>
      </button>
    </div>
  )
}
