interface ProxyOpts {
  w?: number
  h?: number
  blur?: boolean
}

export function proxyUrl(url: string | null | undefined, opts?: ProxyOpts): string | null {
  if (!url) return null
  if (!url.startsWith('http')) return url
  const base = `/api/image-proxy?url=${encodeURIComponent(url)}`
  if (!opts) return base
  const { w, h, blur } = opts
  const params = [
    w ? `&w=${w}` : '',
    h ? `&h=${h}` : '',
    blur ? '&blur=1' : '',
  ].join('')
  return base + params
}
