'use client'

import { useState } from 'react'

export default function EmailCapture() {
  const [email, setEmail] = useState('')
  const [status, setStatus] = useState<'idle' | 'loading' | 'success' | 'error'>('idle')
  const [message, setMessage] = useState('')

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!email) return
    setStatus('loading')
    try {
      const res = await fetch('/api/waitlist', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? '오류가 발생했습니다')
      setStatus('success')
      setMessage('등록 완료! 곧 소식을 전해드릴게요 🎉')
      setEmail('')
    } catch (err) {
      setStatus('error')
      setMessage(err instanceof Error ? err.message : '오류가 발생했습니다')
    }
  }

  if (status === 'success') {
    return (
      <div
        className="flex items-center gap-2 px-5 py-3 rounded-xl text-sm font-medium"
        style={{ backgroundColor: '#4A90A4' + '18', color: '#4A90A4' }}
      >
        <span>✓</span>
        <span>{message}</span>
      </div>
    )
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col sm:flex-row gap-2 w-full max-w-md">
      <input
        type="email"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        placeholder="이메일 주소를 입력하세요"
        required
        className="flex-1 px-4 py-3 rounded-xl text-sm outline-none transition-shadow"
        style={{
          backgroundColor: '#fff',
          color: '#2C3E50',
          border: '1.5px solid #e5e5e5',
        }}
      />
      <button
        type="submit"
        disabled={status === 'loading'}
        className="px-6 py-3 rounded-xl text-sm font-bold transition-opacity disabled:opacity-60 whitespace-nowrap"
        style={{ backgroundColor: '#E8A87C', color: '#fff' }}
      >
        {status === 'loading' ? '등록 중...' : '사전 신청하기'}
      </button>
      {status === 'error' && (
        <p className="text-xs mt-1" style={{ color: '#FF6B6B' }}>{message}</p>
      )}
    </form>
  )
}
