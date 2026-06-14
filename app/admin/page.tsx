'use client'

import { useState, useEffect, useCallback } from 'react'

type RecentTrend = {
  id: string
  title: string
  category: string
  published_at: string
}

type Stats = {
  count: number
  allIds: string[]
  recent: RecentTrend[]
}

type GenResult = {
  count: number
  withImages: number
  sources?: { youtube: number; hn: number; rss: number }
  hasYoutube?: boolean
}

function formatRelativeTime(dateStr: string) {
  const diff = Math.floor((Date.now() - new Date(dateStr).getTime()) / 1000)
  if (diff < 3600) return `${Math.floor(diff / 60)}분 전`
  if (diff < 86400) return `${Math.floor(diff / 3600)}시간 전`
  return `${Math.floor(diff / 86400)}일 전`
}

export default function AdminPage() {
  const [token, setToken] = useState<string | null>(null)
  const [password, setPassword] = useState('')
  const [authError, setAuthError] = useState('')
  const [authLoading, setAuthLoading] = useState(false)

  const [stats, setStats] = useState<Stats | null>(null)
  const [statsLoading, setStatsLoading] = useState(false)

  const [generating, setGenerating] = useState(false)
  const [genResult, setGenResult] = useState<GenResult | null>(null)
  const [genError, setGenError] = useState('')

  const [updating, setUpdating] = useState(false)
  const [updateProgress, setUpdateProgress] = useState({ done: 0, total: 0 })
  const [updateDone, setUpdateDone] = useState(false)

  const loadStats = useCallback(async (tok: string) => {
    setStatsLoading(true)
    try {
      const res = await fetch('/api/admin/stats', {
        headers: { 'x-admin-token': tok },
      })
      if (res.ok) setStats(await res.json())
    } finally {
      setStatsLoading(false)
    }
  }, [])

  useEffect(() => {
    const saved = sessionStorage.getItem('admin_token')
    if (saved) {
      setToken(saved)
      loadStats(saved)
    }
  }, [loadStats])

  const handleLogin = async () => {
    setAuthLoading(true)
    setAuthError('')
    try {
      const res = await fetch('/api/admin/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }),
      })
      if (res.ok) {
        sessionStorage.setItem('admin_token', password)
        setToken(password)
        loadStats(password)
      } else {
        setAuthError('비밀번호가 틀렸습니다')
      }
    } catch {
      setAuthError('네트워크 오류')
    }
    setAuthLoading(false)
  }

  const handleGenerate = async () => {
    setGenerating(true)
    setGenResult(null)
    setGenError('')
    try {
      const res = await fetch('/api/generate-trends-crawl', { method: 'POST' })
      if (res.ok) {
        const data = await res.json()
        setGenResult({ count: data.count, withImages: data.withImages })
        loadStats(token!)
      } else {
        const err = await res.json().catch(() => ({}))
        setGenError(err.error ?? '생성 실패. 다시 시도해주세요.')
      }
    } catch {
      setGenError('네트워크 오류가 발생했습니다.')
    }
    setGenerating(false)
  }

  const handleUpdateImages = async () => {
    if (!stats?.allIds?.length) return
    setUpdating(true)
    setUpdateDone(false)
    const ids = stats.allIds
    setUpdateProgress({ done: 0, total: ids.length })

    for (let i = 0; i < ids.length; i++) {
      try {
        await fetch('/api/admin/update-image', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-admin-token': token! },
          body: JSON.stringify({ trendId: ids[i] }),
        })
      } catch {}
      setUpdateProgress({ done: i + 1, total: ids.length })
    }

    setUpdating(false)
    setUpdateDone(true)
  }

  const handleLogout = () => {
    sessionStorage.removeItem('admin_token')
    setToken(null)
    setStats(null)
    setPassword('')
  }

  // ── 로그인 화면 ────────────────────────────────────────────────
  if (!token) {
    return (
      <div
        className="min-h-screen flex items-center justify-center p-6"
        style={{ backgroundColor: '#F7F5F0' }}
      >
        <div className="w-full max-w-sm">
          <div className="text-center mb-8">
            <h1 className="text-4xl font-black" style={{ color: '#2C3E50' }}>
              Pikk
            </h1>
            <p className="text-sm mt-1.5 font-medium" style={{ color: '#7F8C8D' }}>
              관리자 페이지
            </p>
          </div>

          <div
            className="rounded-2xl p-6"
            style={{ backgroundColor: '#fff', boxShadow: '0 2px 16px rgba(0,0,0,0.08)' }}
          >
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && !authLoading && password && handleLogin()}
              placeholder="비밀번호 입력"
              autoComplete="current-password"
              className="w-full px-4 py-4 rounded-xl outline-none mb-3"
              style={{
                backgroundColor: '#F7F5F0',
                color: '#2C3E50',
                fontSize: '16px',
                border: authError ? '1.5px solid #E74C3C' : '1.5px solid transparent',
              }}
            />
            {authError && (
              <p className="text-sm mb-3 px-1" style={{ color: '#E74C3C' }}>
                {authError}
              </p>
            )}
            <button
              onClick={handleLogin}
              disabled={authLoading || !password}
              className="w-full py-4 rounded-xl font-bold text-white text-base transition-opacity active:opacity-80 disabled:opacity-50"
              style={{ backgroundColor: '#4A90A4', fontSize: '17px' }}
            >
              {authLoading ? '확인 중...' : '로그인'}
            </button>
          </div>
        </div>
      </div>
    )
  }

  // ── 대시보드 ───────────────────────────────────────────────────
  const updatePct = updateProgress.total
    ? Math.round((updateProgress.done / updateProgress.total) * 100)
    : 0

  return (
    <div className="min-h-screen" style={{ backgroundColor: '#F7F5F0' }}>
      <div className="max-w-lg mx-auto px-4 py-6 pb-12">

        {/* 헤더 */}
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-2xl font-black" style={{ color: '#2C3E50' }}>
              Pikk Admin
            </h1>
            <p className="text-sm mt-0.5" style={{ color: '#7F8C8D' }}>
              {statsLoading
                ? '로딩 중...'
                : `총 트렌드 ${stats?.count ?? 0}개`}
            </p>
          </div>
          <button
            onClick={handleLogout}
            className="text-sm px-4 py-2 rounded-xl font-medium transition-opacity active:opacity-70"
            style={{ color: '#7F8C8D', backgroundColor: '#E8E4DE' }}
          >
            로그아웃
          </button>
        </div>

        {/* ── 트렌드 생성 카드 ─────────────────────────────────── */}
        <div
          className="rounded-2xl p-5 mb-4"
          style={{ backgroundColor: '#fff', boxShadow: '0 1px 6px rgba(0,0,0,0.06)' }}
        >
          <p className="text-xs font-bold mb-3 uppercase tracking-wide" style={{ color: '#7F8C8D' }}>
            트렌드 생성
          </p>
          <button
            onClick={handleGenerate}
            disabled={generating}
            className="w-full rounded-xl font-bold text-white transition-opacity active:opacity-80 disabled:opacity-60"
            style={{
              backgroundColor: '#4A90A4',
              fontSize: '17px',
              padding: '20px 16px',
              lineHeight: 1.3,
            }}
          >
            {generating ? '⏳ 생성 중...' : '🚀 오늘 트렌드 생성'}
          </button>

          {generating && (
            <div className="flex items-center gap-2.5 mt-4 px-1">
              <div
                className="w-4 h-4 rounded-full border-2 flex-shrink-0"
                style={{
                  borderColor: '#4A90A4',
                  borderTopColor: 'transparent',
                  animation: 'spin 0.8s linear infinite',
                }}
              />
              <p className="text-sm" style={{ color: '#7F8C8D' }}>
                YouTube · HN · RSS 수집 중... (20~40초 소요)
              </p>
            </div>
          )}

          {genResult && !generating && (
            <div
              className="mt-4 px-4 py-3 rounded-xl"
              style={{ backgroundColor: '#F0FFF4', border: '1.5px solid #68D391' }}
            >
              <p className="text-sm font-bold" style={{ color: '#276749' }}>
                ✅ {genResult.count}개 생성 완료
              </p>
              {genResult.sources && (
                <p className="text-xs mt-1" style={{ color: '#38A169' }}>
                  {genResult.hasYoutube ? `YouTube ${genResult.sources.youtube}개 · ` : ''}
                  HN {genResult.sources.hn}개 · RSS {genResult.sources.rss}개
                </p>
              )}
              <p className="text-xs mt-0.5" style={{ color: '#38A169' }}>
                이미지 포함 {genResult.withImages}개
              </p>
              {!genResult.hasYoutube && (
                <p className="text-xs mt-1.5" style={{ color: '#D97706' }}>
                  ⚠️ YouTube API 키 없음 — HN+RSS만 수집됨
                </p>
              )}
            </div>
          )}

          {genError && !generating && (
            <div
              className="mt-4 px-4 py-3 rounded-xl"
              style={{ backgroundColor: '#FFF5F5', border: '1.5px solid #FC8181' }}
            >
              <p className="text-sm" style={{ color: '#C53030' }}>{genError}</p>
            </div>
          )}
        </div>

        {/* ── 이미지 업데이트 카드 ─────────────────────────────── */}
        <div
          className="rounded-2xl p-5 mb-4"
          style={{ backgroundColor: '#fff', boxShadow: '0 1px 6px rgba(0,0,0,0.06)' }}
        >
          <p className="text-xs font-bold mb-3 uppercase tracking-wide" style={{ color: '#7F8C8D' }}>
            이미지 업데이트
          </p>
          <button
            onClick={handleUpdateImages}
            disabled={updating || !stats?.allIds?.length}
            className="w-full rounded-xl font-bold text-white transition-opacity active:opacity-80 disabled:opacity-60"
            style={{
              backgroundColor: '#7C67EE',
              fontSize: '17px',
              padding: '20px 16px',
              lineHeight: 1.3,
            }}
          >
            {updating
              ? `🖼 업데이트 중... ${updateProgress.done}/${updateProgress.total}`
              : '🖼 전체 이미지 재수집'}
          </button>

          {updating && (
            <div className="mt-4">
              <div
                className="rounded-full overflow-hidden"
                style={{ backgroundColor: '#E8E4DE', height: '10px' }}
              >
                <div
                  className="h-full rounded-full"
                  style={{
                    width: `${updatePct}%`,
                    backgroundColor: '#7C67EE',
                    transition: 'width 0.4s ease',
                  }}
                />
              </div>
              <p className="text-xs mt-2 text-center" style={{ color: '#7F8C8D' }}>
                {updateProgress.done} / {updateProgress.total} 완료 ({updatePct}%)
              </p>
            </div>
          )}

          {updateDone && !updating && (
            <div
              className="mt-4 px-4 py-3 rounded-xl"
              style={{ backgroundColor: '#F0FFF4', border: '1.5px solid #68D391' }}
            >
              <p className="text-sm font-bold" style={{ color: '#276749' }}>
                ✅ 전체 이미지 업데이트 완료
              </p>
            </div>
          )}
        </div>

        {/* ── 최근 트렌드 ──────────────────────────────────────── */}
        {stats?.recent && stats.recent.length > 0 && (
          <div
            className="rounded-2xl p-5"
            style={{ backgroundColor: '#fff', boxShadow: '0 1px 6px rgba(0,0,0,0.06)' }}
          >
            <p className="text-xs font-bold mb-4 uppercase tracking-wide" style={{ color: '#7F8C8D' }}>
              최근 트렌드
            </p>
            <div className="space-y-3.5">
              {stats.recent.map((trend, i) => (
                <div
                  key={trend.id}
                  className="flex items-start gap-3"
                  style={
                    i < stats.recent.length - 1
                      ? { paddingBottom: '14px', borderBottom: '1px solid rgba(0,0,0,0.05)' }
                      : {}
                  }
                >
                  <span
                    className="text-xs font-bold px-2 py-0.5 rounded-full flex-shrink-0 mt-0.5"
                    style={{ backgroundColor: '#4A90A418', color: '#4A90A4' }}
                  >
                    {trend.category}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p
                      className="text-sm font-semibold leading-snug line-clamp-2"
                      style={{ color: '#2C3E50' }}
                    >
                      {trend.title}
                    </p>
                    <p className="text-xs mt-0.5" style={{ color: '#7F8C8D' }}>
                      {formatRelativeTime(trend.published_at)}
                    </p>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      <style jsx global>{`
        @keyframes spin {
          to { transform: rotate(360deg); }
        }
      `}</style>
    </div>
  )
}
