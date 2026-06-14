export function proxyUrl(url: string | null | undefined): string | null {
  if (!url) return null
  if (!url.startsWith('http')) return url
  return `/api/image-proxy?url=${encodeURIComponent(url)}`
}
