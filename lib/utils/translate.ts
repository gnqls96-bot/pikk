const EMAIL = 'gnqls96@gmail.com'

function isKorean(text: string): boolean {
  const korean = (text.match(/[가-힣]/g) ?? []).length
  return text.length > 0 && korean / text.length > 0.05
}

export async function translateToKorean(text: string): Promise<string> {
  if (!text || isKorean(text)) return text
  try {
    const res = await fetch(
      `https://api.mymemory.translated.net/get?q=${encodeURIComponent(text.slice(0, 450))}&langpair=en|ko&de=${encodeURIComponent(EMAIL)}`,
      { signal: AbortSignal.timeout(8000) }
    )
    if (!res.ok) return text
    const data = await res.json()
    if (data.responseStatus !== 200) return text
    return (data.responseData?.translatedText as string | undefined) ?? text
  } catch {
    return text
  }
}

export async function translateTags(tags: string[]): Promise<string[]> {
  return Promise.all(tags.map(translateToKorean))
}
