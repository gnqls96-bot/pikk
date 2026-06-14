'use client'

import { useState, useEffect, useCallback } from 'react'

type RecentTrend = { id: string; title: string; category: string; published_at: string }
type Stats = { count: number; allIds: string[]; recent: RecentTrend[] }
type GenResult = {
  count: number; withImages: number; collected?: number
  sources?: { youtube: number; hn: number; rss: number }
  hasYoutube?: boolean; youtubeStatus?: string
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

  // 오늘 초기화 후 재생성
  const [resetting, setResetting] = useState(false)
  const [resetResult, setResetResult] = useState<{ deleted: number; generated: number } | null>(null)
  const [resetError, setResetError] = useState('')

  // 기존 트렌드 전체 재생성
  const [regenerating, setRegenerating] = useState(false)
  const [regenProgress, setRegenProgress] = useState({ done: 0, total: 0 })
  const [regenDone, setRegenDone] = useState(false)

  const loadStats = useCallback(async (tok: string) => {
    setStatsLoading(true)
    try {
      const res = await fetch('/api/admin/stats', { headers: { 'x-admin-token': tok } })
      if (res.ok) setStats(await res.json())
    } finally { setStatsLoading(false) }
  }, [])

  useEffect(() => {
    const saved = sessionStorage.getItem('admin_token')
    if (saved) { setToken(saved); loadStats(saved) }
  }, [loadStats])

  const handleLogin = async () => {
    setAuthLoading(true); setAuthError('')
    try {
      const res = await fetch('/api/admin/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }),
      })
      if (res.ok) {
        sessionStorage.setItem('admin_token', password)
        setToken(password); loadStats(password)
      } else { setAuthError('비밀번호가 틀렸습니다') }
    } catch { setAuthError('네트워크 오류') }
    setAuthLoading(false)
  }

  const handleGenerate = async () => {
    setGenerating(true); setGenResult(null); setGenError('')
    try {
      const res = await fetch('/api/generate-trends-crawl', { method: 'POST' })
      if (res.ok) { setGenResult(await res.json()); loadStats(token!) }
      else { const err = await res.json().catch(() => ({})); setGenError(err.error ?? '생성 실패') }
    } catch { setGenError('네트워크 오류') }
    setGenerating(false)
  }

  const handleResetAndGenerate = async () => {
    if (!confirm('오늘 생성된 트렌드를 삭제하고 새로 생성합니다. 계속하시겠습니까?')) return
    setResetting(true); setResetResult(null); setResetError('')
    try {
      // 1. 오늘 트렌드 삭제
      const delRes = await fetch('/api/admin/delete-today', {
        method: 'DELETE',
        headers: { 'x-admin-token': token! },
      })
      const delData = await delRes.json()
      if (!delRes.ok) { setResetError(delData.error ?? '삭제 실패'); setResetting(false); return }

      // 2. 새로 생성
      const genRes = await fetch('/api/generate-trends-crawl', { method: 'POST' })
      const genData = await genRes.json()
      if (!genRes.ok) { setResetError(genData.error ?? '생성 실패'); setResetting(false); return }

      setResetResult({ deleted: delData.deleted ?? 0, generated: genData.count ?? 0 })
      loadStats(token!)
    } catch { setResetError('네트워크 오류') }
    setResetting(false)
  }

  const handleRegenerateAll = async () => {
    if (!stats?.allIds?.length) return
    setRegenerating(true); setRegenDone(false)
    const ids = stats.allIds
    setRegenProgress({ done: 0, total: ids.length })
    for (let i = 0; i < ids.length; i++) {
      try {
        await fetch('/api/admin/regenerate-trend', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-admin-token': token! },
          body: JSON.stringify({ trendId: ids[i] }),
        })
      } catch {}
      setRegenProgress({ done: i + 1, total: ids.length })
    }
    setRegenerating(false); setRegenDone(true); loadStats(token!)
  }

  const handleLogout = () => {
    sessionStorage.removeItem('admin_token'); setToken(null); setStats(null); setPassword('')
  }

  // ── 로그인 ─────────────────────────────────────────────────────
  if (!token) {
    return (
      <div className="min-h-screen flex items-center justify-center p-6" style={{ backgroundColor: '#F7F5F0' }}>
        <div className="w-full max-w-sm">
          <div className="text-center mb-8">
            <h1 className="text-4xl font-black" style={{ color: '#2C3E50' }}>Pikk</h1>
            <p className="text-sm mt-1.5 font-medium" style={{ color: '#7F8C8D' }}>관리자 페이지</p>
          </div>
          <div className="rounded-2xl p-6" style={{ backgroundColor: '#fff', boxShadow: '0 2px 16px rgba(0,0,0,0.08)' }}>
            <input
              type="password" value={password}
              onChange={(e) => setPassword(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && !authLoading && password && handleLogin()}
              placeholder="비밀번호 입력" autoComplete="current-password"
              className="w-full px-4 py-4 rounded-xl outline-none mb-3"
              style={{ backgroundColor: '#F7F5F0', color: '#2C3E50', fontSize: '16px', border: authError ? '1.5px solid #E74C3C' : '1.5px solid transparent' }}
            />
            {authError && <p className="text-sm mb-3 px-1" style={{ color: '#E74C3C' }}>{authError}</p>}
            <button
              onClick={handleLogin} disabled={authLoading || !password}
              className="w-full py-4 rounded-xl font-bold text-white transition-opacity active:opacity-80 disabled:opacity-50"
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
  const regenPct = regenProgress.total ? Math.round((regenProgress.done / regenProgress.total) * 100) : 0

  return (
    <div className="min-h-screen" style={{ backgroundColor: '#F7F5F0' }}>
      <div className="max-w-lg mx-auto px-4 py-6 pb-12">

        {/* 헤더 */}
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-2xl font-black" style={{ color: '#2C3E50' }}>Pikk Admin</h1>
            <p className="text-sm mt-0.5" style={{ color: '#7F8C8D' }}>
              {statsLoading ? '로딩 중...' : `총 트렌드 ${stats?.count ?? 0}개`}
            </p>
          </div>
          <button onClick={handleLogout} className="text-sm px-4 py-2 rounded-xl font-medium" style={{ color: '#7F8C8D', backgroundColor: '#E8E4DE' }}>
            로그아웃
          </button>
        </div>

        {/* ── 오늘 트렌드 생성 ──────────────────────────────────── */}
        <div className="rounded-2xl p-5 mb-4" style={{ backgroundColor: '#fff', boxShadow: '0 1px 6px rgba(0,0,0,0.06)' }}>
          <p className="text-xs font-bold mb-1 uppercase tracking-wide" style={{ color: '#7F8C8D' }}>트렌드 생성</p>
          <p className="text-xs mb-3" style={{ color: '#95A5A6' }}>
            YouTube · HN · Reuters · Al Jazeera · Japan Times · Reddit · Medium · Dev.to · Product Hunt
          </p>

          <button
            onClick={handleGenerate} disabled={generating || resetting}
            className="w-full rounded-xl font-bold text-white transition-opacity active:opacity-80 disabled:opacity-60 mb-3"
            style={{ backgroundColor: '#4A90A4', fontSize: '17px', padding: '18px 16px', lineHeight: 1.3 }}
          >
            {generating ? '⏳ 수집·선별·생성 중...' : '🚀 오늘 트렌드 생성'}
          </button>

          <button
            onClick={handleResetAndGenerate} disabled={generating || resetting}
            className="w-full rounded-xl font-bold text-white transition-opacity active:opacity-80 disabled:opacity-60"
            style={{ backgroundColor: '#E74C3C', fontSize: '15px', padding: '14px 16px', lineHeight: 1.3 }}
          >
            {resetting ? '🔄 초기화 후 재생성 중...' : '🔄 오늘 트렌드 초기화 후 재생성'}
          </button>

          {(generating || resetting) && (
            <div className="flex items-center gap-2.5 mt-4 px-1">
              <div className="w-4 h-4 rounded-full border-2 flex-shrink-0"
                style={{ borderColor: '#4A90A4', borderTopColor: 'transparent', animation: 'spin 0.8s linear infinite' }} />
              <p className="text-sm" style={{ color: '#7F8C8D' }}>
                {resetting ? '오늘 트렌드 삭제 → 전 세계 소스 수집 → Sonnet 4.6 선별·기사 작성 중...' : '전 세계 소스 수집 → Sonnet 4.6 선별·기사 작성 중... (30~50초)'}
              </p>
            </div>
          )}

          {genResult && !generating && !resetting && (
            <div className="mt-4 px-4 py-3 rounded-xl" style={{ backgroundColor: '#F0FFF4', border: '1.5px solid #68D391' }}>
              <p className="text-sm font-bold" style={{ color: '#276749' }}>✅ {genResult.count}개 생성 완료</p>
              {genResult.collected && <p className="text-xs mt-0.5" style={{ color: '#38A169' }}>수집 {genResult.collected}개 중 선별</p>}
              {genResult.sources && (
                <p className="text-xs mt-0.5" style={{ color: '#38A169' }}>
                  {genResult.hasYoutube ? `YouTube ${genResult.sources.youtube} · ` : ''}HN {genResult.sources.hn} · RSS/기타 {genResult.sources.rss}개
                </p>
              )}
              <p className="text-xs mt-0.5" style={{ color: '#38A169' }}>이미지 포함 {genResult.withImages}개</p>
              {genResult.youtubeStatus && !genResult.hasYoutube && (
                <p className="text-xs mt-1.5 font-mono break-all" style={{ color: '#D97706' }}>⚠️ {genResult.youtubeStatus}</p>
              )}
            </div>
          )}

          {resetResult && !resetting && (
            <div className="mt-4 px-4 py-3 rounded-xl" style={{ backgroundColor: '#F0FFF4', border: '1.5px solid #68D391' }}>
              <p className="text-sm font-bold" style={{ color: '#276749' }}>✅ 초기화 후 재생성 완료</p>
              <p className="text-xs mt-0.5" style={{ color: '#38A169' }}>삭제 {resetResult.deleted}개 → 새로 생성 {resetResult.generated}개</p>
            </div>
          )}

          {(genError || resetError) && !generating && !resetting && (
            <div className="mt-4 px-4 py-3 rounded-xl" style={{ backgroundColor: '#FFF5F5', border: '1.5px solid #FC8181' }}>
              <p className="text-sm" style={{ color: '#C53030' }}>{genError || resetError}</p>
            </div>
          )}
        </div>

        {/* ── 기존 트렌드 전체 재생성 ──────────────────────────── */}
        <div className="rounded-2xl p-5 mb-4" style={{ backgroundColor: '#fff', boxShadow: '0 1px 6px rgba(0,0,0,0.06)' }}>
          <p className="text-xs font-bold mb-1 uppercase tracking-wide" style={{ color: '#7F8C8D' }}>기존 트렌드 재생성</p>
          <p className="text-xs mb-3" style={{ color: '#95A5A6' }}>Sonnet 4.6 저널리스트 모드로 기존 트렌드 전체 재작성 (800자+ 본문)</p>
          <button
            onClick={handleRegenerateAll} disabled={regenerating || !stats?.allIds?.length}
            className="w-full rounded-xl font-bold text-white transition-opacity active:opacity-80 disabled:opacity-60"
            style={{ backgroundColor: '#2C3E50', fontSize: '17px', padding: '20px 16px', lineHeight: 1.3 }}
          >
            {regenerating ? `✍️ 재생성 중... ${regenProgress.done}/${regenProgress.total}` : '✍️ 전체 트렌드 재생성'}
          </button>

          {regenerating && (
            <div className="mt-4">
              <div className="rounded-full overflow-hidden" style={{ backgroundColor: '#E8E4DE', height: '10px' }}>
                <div className="h-full rounded-full" style={{ width: `${regenPct}%`, backgroundColor: '#2C3E50', transition: 'width 0.4s ease' }} />
              </div>
              <p className="text-xs mt-2 text-center" style={{ color: '#7F8C8D' }}>
                {regenProgress.done} / {regenProgress.total} 완료 ({regenPct}%) · Sonnet 4.6
              </p>
            </div>
          )}

          {regenDone && !regenerating && (
            <div className="mt-4 px-4 py-3 rounded-xl" style={{ backgroundColor: '#F0FFF4', border: '1.5px solid #68D391' }}>
              <p className="text-sm font-bold" style={{ color: '#276749' }}>✅ 전체 재생성 완료</p>
            </div>
          )}
        </div>

        {/* ── 최근 트렌드 ──────────────────────────────────────── */}
        {stats?.recent && stats.recent.length > 0 && (
          <div className="rounded-2xl p-5" style={{ backgroundColor: '#fff', boxShadow: '0 1px 6px rgba(0,0,0,0.06)' }}>
            <p className="text-xs font-bold mb-4 uppercase tracking-wide" style={{ color: '#7F8C8D' }}>최근 트렌드</p>
            <div className="space-y-3.5">
              {stats.recent.map((trend, i) => (
                <div key={trend.id} className="flex items-start gap-3"
                  style={i < stats.recent.length - 1 ? { paddingBottom: '14px', borderBottom: '1px solid rgba(0,0,0,0.05)' } : {}}
                >
                  <span className="text-xs font-bold px-2 py-0.5 rounded-full flex-shrink-0 mt-0.5"
                    style={{ backgroundColor: '#4A90A418', color: '#4A90A4' }}>
                    {trend.category}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-semibold leading-snug line-clamp-2" style={{ color: '#2C3E50' }}>{trend.title}</p>
                    <p className="text-xs mt-0.5" style={{ color: '#7F8C8D' }}>{formatRelativeTime(trend.published_at)}</p>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      <style jsx global>{`
        @keyframes spin { to { transform: rotate(360deg); } }
      `}</style>
    </div>
  )
}
