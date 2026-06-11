import { readFileSync } from 'fs'
import { join } from 'path'

// Parse .env.local without dotenv dependency
const envPath = join(process.cwd(), '.env.local')
const env = Object.fromEntries(
  readFileSync(envPath, 'utf-8')
    .split('\n')
    .filter(l => l.trim() && !l.startsWith('#'))
    .map(l => {
      const idx = l.indexOf('=')
      return [l.slice(0, idx).trim(), l.slice(idx + 1).trim()]
    })
)

const SUPABASE_URL = env.NEXT_PUBLIC_SUPABASE_URL
const SUPABASE_KEY = env.SUPABASE_SERVICE_ROLE_KEY ?? env.NEXT_PUBLIC_SUPABASE_ANON_KEY
const PEXELS_KEY = env.PEXELS_API_KEY

if (!SUPABASE_URL || !SUPABASE_KEY || !PEXELS_KEY) {
  console.error('Missing env vars. Check .env.local')
  process.exit(1)
}

// Korean title keywords → accurate English search queries
const TITLE_TO_QUERY = {
  '두바이 초콜릿':  'dubai chocolate pistachio dessert',
  '젤리 스킨':     'jelly skin korean beauty skincare',
  '글래시 스킨':   'glassy skin beauty glow skincare',
  'AI 슬럼':       'social media content creator digital',
  'AI 슬롭':       'social media content creator digital',
  '고프코어':      'gorpcore outdoor fashion streetwear hiking',
  'AI 에이전트':   'artificial intelligence robot automation technology',
  '슬로우 리빙':   'slow living mindful lifestyle cozy home',
  '브루탈리즘':    'brutalism graphic design typography bold',
  '6초 광고':      'advertising marketing billboard campaign',
  '숏폼':          'short video social media smartphone content',
  '모션 그래픽':   'motion graphics 3d typography video editing',
  '훠궈':          'hotpot chinese food spicy restaurant',
  '마라탕':        'chinese spicy soup noodles restaurant',
  '조용한 럭셔리': 'quiet luxury fashion minimalist cashmere',
  '아우라 메이크업': 'makeup blush beauty cosmetics aesthetic',
  '핀터레스트':    'pinterest moodboard inspiration lifestyle',
  '디지털 디톡스': 'nature wellness mindfulness outdoor calm',
}

function getSearchQuery(title) {
  for (const [keyword, query] of Object.entries(TITLE_TO_QUERY)) {
    if (title.includes(keyword)) return query
  }
  // Fallback: strip Korean, use remaining ASCII words
  const ascii = title.replace(/[^\x00-\x7F]/g, ' ').replace(/\s+/g, ' ').trim()
  return ascii || 'trend lifestyle'
}

const usedUrls = new Set()

async function searchPexels(query) {
  for (let page = 1; page <= 3; page++) {
    const res = await fetch(
      `https://api.pexels.com/v1/search?query=${encodeURIComponent(query)}&per_page=5&orientation=landscape&page=${page}`,
      { headers: { Authorization: PEXELS_KEY } }
    )
    if (!res.ok) throw new Error(`Pexels ${res.status}`)
    const data = await res.json()
    for (const photo of (data.photos ?? [])) {
      const url = photo.src.large2x
      if (!usedUrls.has(url)) {
        usedUrls.add(url)
        return url
      }
    }
  }
  return null
}

async function fetchTrends() {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/trends?select=id,title,image_url&order=published_at.desc`,
    {
      headers: {
        apikey: SUPABASE_KEY,
        Authorization: `Bearer ${SUPABASE_KEY}`,
      },
    }
  )
  if (!res.ok) throw new Error(`Supabase fetch ${res.status}: ${await res.text()}`)
  return res.json()
}

async function updateImageUrl(id, imageUrl) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/trends?id=eq.${id}`, {
    method: 'PATCH',
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'return=minimal',
    },
    body: JSON.stringify({ image_url: imageUrl }),
  })
  if (!res.ok) throw new Error(`Supabase update ${res.status}: ${await res.text()}`)
}

async function main() {
  console.log('Fetching trends from Supabase...')
  const trends = await fetchTrends()
  console.log(`Found ${trends.length} trends\n`)

  let updated = 0

  for (const trend of trends) {
    const query = getSearchQuery(trend.title)
    console.log(`🔍 "${trend.title}"`)
    console.log(`   query: "${query}"`)

    try {
      const imageUrl = await searchPexels(query)
      if (!imageUrl) {
        console.log(`   ✗ No unique image found\n`)
        continue
      }
      await updateImageUrl(trend.id, imageUrl)
      console.log(`   ✓ Updated\n`)
      updated++
    } catch (err) {
      console.error(`   ✗ Error: ${err.message}\n`)
    }

    // Pexels free tier: 200 req/min
    await new Promise(r => setTimeout(r, 400))
  }

  console.log(`Done. Updated: ${updated} / ${trends.length}`)
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
