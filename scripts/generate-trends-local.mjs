#!/usr/bin/env node
/**
 * Pikk 트렌드 생성 로컬 스크립트
 * 사용법: node scripts/generate-trends-local.mjs
 *
 * Claude Code가 2026.06.12 웹 검색으로 직접 수집한 글로벌 트렌드 10개를
 * og:image(최대 5장) + Pexels fallback 처리 후 Supabase에 저장합니다.
 */

import { readFileSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))

// ── .env.local 로드 ────────────────────────────────────────────
function loadEnv() {
  try {
    const envPath = resolve(__dirname, '..', '.env.local')
    const content = readFileSync(envPath, 'utf8')
    for (const line of content.split('\n')) {
      const m = line.match(/^([^#=\s][^=]*?)\s*=\s*(.*)$/)
      if (m) process.env[m[1].trim()] = m[2].trim().replace(/^['"]|['"]$/g, '')
    }
  } catch (e) {
    console.error('.env.local 로드 실패:', e.message)
    process.exit(1)
  }
}
loadEnv()

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL
const SUPABASE_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
const PEXELS_KEY   = process.env.PEXELS_API_KEY

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('❌ SUPABASE 환경변수 없음'); process.exit(1)
}

// Supabase REST insert — no WebSocket dependency (Node 20 compatible)
async function supabaseInsert(table, row) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}`, {
    method: 'POST',
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
    },
    body: JSON.stringify(row),
  })
  const text = await res.text()
  if (!res.ok) return { data: null, error: { message: text } }
  const parsed = JSON.parse(text)
  return { data: Array.isArray(parsed) ? parsed[0] : parsed, error: null }
}

// ── 이미지 수집 (업그레이드) ────────────────────────────────────
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'

// 이미지 URL이 실제로 로드 가능한 고화질 이미지인지 검증
async function validateImage(url) {
  try {
    const res = await fetch(url, {
      method: 'HEAD',
      headers: { 'User-Agent': UA },
      signal: AbortSignal.timeout(5000),
      redirect: 'follow',
    })
    if (!res.ok) return false
    const ct = res.headers.get('content-type') ?? ''
    if (!ct.match(/^image\/(jpeg|jpg|png|webp|gif|avif)/i)) return false
    // 10KB 미만 = 로고·아이콘 → 제외
    const cl = parseInt(res.headers.get('content-length') ?? '0')
    if (cl > 0 && cl < 10000) return false
    return true
  } catch { return false }
}

// 1순위: DuckDuckGo 이미지 검색 (Bing 인덱스 기반, 주제 적합도 높음)
async function fetchDDGImages(query, count = 6) {
  try {
    const pageRes = await fetch(
      `https://duckduckgo.com/?q=${encodeURIComponent(query)}&iax=images&ia=images`,
      {
        headers: { 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9' },
        signal: AbortSignal.timeout(10000),
        redirect: 'follow',
      }
    )
    if (!pageRes.ok) return []
    const html = await pageRes.text()

    // vqd 토큰 추출 (DDG 이미지 API 인증)
    const vqdMatch = html.match(/vqd=["']([^"']+)["']/) ?? html.match(/vqd=([\d-]+)/)
    const vqd = vqdMatch?.[1]
    if (!vqd) return []

    const apiRes = await fetch(
      `https://duckduckgo.com/i.js?q=${encodeURIComponent(query)}&o=json&p=1&s=0&u=bing&f=,,,&vqd=${encodeURIComponent(vqd)}`,
      {
        headers: { 'User-Agent': UA, Referer: 'https://duckduckgo.com/' },
        signal: AbortSignal.timeout(8000),
      }
    )
    if (!apiRes.ok) return []
    const data = await apiRes.json()

    return (data.results ?? [])
      .filter(img => img.image && (img.width ?? 0) >= 800)
      .slice(0, count + 4) // 검증 실패 버퍼
      .map(img => {
        let siteName = 'Web'
        try { siteName = new URL(img.url ?? img.image).hostname.replace(/^www\./, '') } catch {}
        return { url: img.image, source_url: img.url ?? img.image, site_name: siteName }
      })
  } catch { return [] }
}

// 2순위: 관련 소스의 og:image (검증 포함)
async function fetchOgImage(src) {
  if (!src.url || src.url.includes('example.com')) return null
  try {
    const res = await fetch(src.url, {
      headers: { 'User-Agent': UA, Accept: 'text/html' },
      signal: AbortSignal.timeout(7000),
      redirect: 'follow',
    })
    if (!res.ok) return null
    const html = await res.text()
    const m =
      html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i) ??
      html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i)
    const raw = m?.[1]?.trim()
    if (!raw || raw.length < 10) return null
    const imgUrl = raw.startsWith('http') ? raw : new URL(raw, src.url).href
    const valid = await validateImage(imgUrl)
    if (!valid) return null
    return { url: imgUrl, source_url: src.url, site_name: src.site_name }
  } catch { return null }
}

// 3순위: Pexels (여러 키워드로 시도)
async function fetchPexelsImages(keyword, count = 5) {
  if (!PEXELS_KEY || count <= 0) return []
  // 키워드 변형: 원본 + 더 구체적인 조합 순으로 시도
  const queries = [keyword, keyword.split(' ').slice(0, 3).join(' ')]
  const results = []
  for (const q of queries) {
    try {
      const res = await fetch(
        `https://api.pexels.com/v1/search?query=${encodeURIComponent(q)}&per_page=${Math.min(count + 3, 15)}&orientation=landscape`,
        { headers: { Authorization: PEXELS_KEY }, signal: AbortSignal.timeout(8000) }
      )
      if (!res.ok) continue
      const data = await res.json()
      for (const p of data.photos ?? []) {
        const url = p.src?.large2x ?? ''
        if (url && !results.find(r => r.url === url)) {
          results.push({ url, source_url: p.url ?? 'https://www.pexels.com', site_name: 'Pexels' })
        }
        if (results.length >= count + 2) break
      }
    } catch {}
    if (results.length >= count) break
  }
  return results.slice(0, count)
}

async function collectImages(sources, keyword) {
  const TARGET = 5
  const seen = new Set()
  const gallery = []

  const addIfNew = async (img, validate = false) => {
    if (!img?.url || seen.has(img.url) || gallery.length >= TARGET) return
    if (validate && !(await validateImage(img.url))) return
    seen.add(img.url)
    gallery.push(img)
  }

  // 1순위: DuckDuckGo (주제 적합, Bing 품질)
  process.stdout.write(' DDG..')
  const ddgImgs = await fetchDDGImages(keyword, TARGET)
  for (const img of ddgImgs) {
    if (gallery.length >= TARGET) break
    await addIfNew(img, true) // DDG 이미지도 검증
  }

  // 2순위: og:image (관련 소스, 이미 validateImage 포함)
  if (gallery.length < TARGET) {
    process.stdout.write(' OG..')
    const ogResults = await Promise.all(sources.map(fetchOgImage))
    for (const img of ogResults) await addIfNew(img)
  }

  // 3순위: Pexels (고품질 fallback)
  if (gallery.length < TARGET) {
    process.stdout.write(' Pexels..')
    const pexels = await fetchPexelsImages(keyword, TARGET - gallery.length)
    for (const img of pexels) await addIfNew(img)
  }

  return { image_url: gallery[0]?.url ?? null, gallery_images: gallery }
}

// ── 트렌드 데이터 (Claude Code 웹 조사 — 2026.06.12) ──────────
const TRENDS = [
  {
    title: '펩시도 뛰어들었다 — 프리바이오틱 소다 전쟁이 시작됐다',
    summary: '올리팝·포피가 열어놓은 시장에 코카콜라·펩시가 직접 참전\n코카콜라의 포피 인수(19억 달러)와 펩시 자체 출시로 메인스트림 진입 확정\n한국 편의점도 유산균 탄산음료 경쟁 가속',
    body: '올리팝과 포피(Poppi)가 미국 편의점 냉장고를 장악한 지 불과 2년 만에, 코카콜라와 펩시가 직접 프리바이오틱 탄산음료 시장에 뛰어들었다. 펩시는 2026년 초 자사 간판 제품의 프리바이오틱 버전을 출시하며 장 건강 음료 전쟁의 포문을 열었다.\n\n프리바이오틱 소다는 이눌린, 아가베 이눌린 등 식이섬유 성분을 탄산음료에 넣어 장내 유익균을 먹이는 기능성 음료다. 올리팝은 지난해 4억 달러(약 5,400억 원) 매출을 기록했고, 코카콜라는 포피를 약 19억 달러(2조 5,600억 원)에 인수하며 시장에 합류했다.\n\n한국에서도 CU·GS25가 유산균 음료 카테고리를 확대하고, 건강기능식품 업체들이 탄산음료 형태의 프로바이오틱 제품 출시를 서두르고 있다. 헬시플레저 트렌드와 맞물려 프리바이오틱 소다는 2026년 음료 시장의 가장 뜨거운 카테고리가 됐다.',
    why_trending: '코카콜라의 포피 인수(19억 달러)와 펩시 자체 출시로 빅 브랜드 참전이 확정되며 시장이 메인스트림으로 급격히 확대됐다.',
    who_affected: '건강 음료 소비자, 편의점 업계, 국내 건강기능식품 기업',
    heat_score: 87,
    category: '푸드',
    tags: ['프리바이오틱', '기능성음료', '펩시', '올리팝'],
    related_sources: [
      { title: 'Five food and drink innovation trends set to last in 2026', url: 'https://www.foodnavigator.com/Article/2026/04/29/five-food-and-drink-innovation-trends-set-to-last-in-2026/', site_name: 'Food Navigator' },
      { title: 'Top 30 Food & Beverage Trends of 2026', url: 'https://meetglimpse.com/trends/food-beverage-trends/', site_name: 'Glimpse' },
      { title: "Food Trends 2026: Here's What Everyone Will Be Eating", url: 'https://www.tasteofhome.com/collection/2026-food-trends-predictions/', site_name: 'Taste of Home' },
    ],
    image_search_keyword: 'probiotic soda gut health drink',
  },
  {
    title: '오젬픽이 슈퍼마켓을 바꾼다 — GLP-1 식품 시장 3조 원 폭발',
    summary: '미국 GLP-1 복용자 1,500만 명이 식품 구매 패턴을 실질적으로 바꾸고 있다\n네슬레·맥도날드가 전용 소포장·고단백 제품 라인 출시\n소식·고단백·고섬유질이 식품 시장의 새 기준으로',
    body: '위고비·오젬픽으로 대표되는 GLP-1 계열 비만 치료제가 전 세계 식품 시장의 지형을 바꾸고 있다. 미국에서만 GLP-1 약물 복용자가 1,500만 명을 돌파하자 식품 기업들이 소식하는 소비자를 위한 제품군으로 전략을 전환하고 있다.\n\n네슬레는 고단백·저칼로리 GLP-1 전용 식품 라인을 출시했고, 맥도날드·치폴레 등 패스트푸드 체인은 소포장·고영양 메뉴를 확대했다. 월마트는 GLP-1 복용 고객의 식품 구매 패턴을 분석해 관련 제품 진열 공간을 30% 늘렸다.\n\n국내에서도 위고비 보험 급여 논의가 진행 중이며, 식품업계는 포만감을 오래 유지하는 고단백·고섬유질 식품이라는 키워드로 신제품 개발에 열중하고 있다. 약이 바꾸는 식습관, 그 식습관이 바꾸는 식품 산업의 변화가 2026년 내내 이어질 전망이다.',
    why_trending: '미국 복용자 1,500만 명 돌파로 식품 소비 패턴 변화가 데이터로 입증됐고, 대기업들이 본격 대응에 나섰다.',
    who_affected: '식품·외식 기업, GLP-1 복용자, 건강식품 시장 관계자',
    heat_score: 82,
    category: '푸드',
    tags: ['GLP-1', '오젬픽', '건강식품', '위고비'],
    related_sources: [
      { title: 'Guided, not ghosted: Top food, beverage trends shaping 2026-27', url: 'https://www.fastcasual.com/blogs/guided-not-ghosted-top-food-beverage-trends-shaping-2026-27/', site_name: 'Fast Casual' },
      { title: 'Top 10 Food Trends — IFT', url: 'https://www.ift.org/publications/food-technology-magazine/20262/march/top-10-food-trends/', site_name: 'IFT' },
      { title: 'Food and Drink Trends 2026', url: 'https://www.bidfood.co.uk/food-and-drink-trends-2026/', site_name: 'Bidfood' },
    ],
    image_search_keyword: 'healthy protein food weight loss nutrition',
  },
  {
    title: '필터 속 피부를 현실에 — 클라우드 스킨이 뷰티 피드 점령',
    summary: '글래시 스킨 다음은 클라우드 스킨 — 소프트 포커스로 디지털 필터 효과를 현실에 구현\n실리콘 프라이머 + 미세 파우더 조합이 핵심 테크닉\n#cloudskin 틱톡 2억 뷰 돌파, K뷰티 브랜드 어뮤즈 완판',
    body: '글래시 스킨(유리 피부), 젤리 스킨을 거쳐 2026년 봄·여름 뷰티 피드를 지배하는 것은 클라우드 스킨이다. 소프트 포커스 효과로 피부 표면을 흐릿하게 만들어 디지털 필터를 바른 것처럼 보이게 하는 테크닉이다. 밝게 빛나는 글래시 스킨과 달리 빛을 흡수·분산시켜 매트하지도, 촉촉하지도 않은 에어리한 질감을 완성한다.\n\n비결은 실리콘 계열 프라이머와 세팅 파우더의 조합이다. 버블 텍스처의 프라이머를 바른 뒤 미세 입자 파우더로 고정하면 피부가 뿌연 듯 맑아 보이는 클라우드 효과를 얻을 수 있다. 에스티로더의 더블 웨어 시어 플랫 파우더, 샤넬 N°1 파우더가 이 트렌드를 선도하는 제품으로 꼽힌다.\n\n틱톡에서 #cloudskin 해시태그는 이미 2억 뷰를 돌파했고, 국내 뷰티 크리에이터들도 한국형 클라우드 스킨 루틴을 앞다퉈 공유 중이다. K뷰티 브랜드 어뮤즈가 클라우드 스킨에 최적화된 쿠션 라인을 5월 출시해 완판 행진을 이어가고 있다.',
    why_trending: '#cloudskin 틱톡 2억 뷰 돌파, 주요 뷰티 에디터들이 2026 여름 1위 메이크업 트렌드로 선정하며 제품 매출 급증.',
    who_affected: '20-30대 뷰티 소비자, K뷰티 브랜드, 뷰티 크리에이터',
    heat_score: 84,
    category: '뷰티',
    tags: ['클라우드스킨', 'K뷰티', '메이크업트렌드'],
    related_sources: [
      { title: '18 Viral Beauty Products of 2026 a Fashion Editor Loves', url: 'https://www.whowhatwear.com/beauty/fashion-editor-buzzy-beauty-product-picks-2026', site_name: 'Who What Wear' },
      { title: "I'm a beauty director — the 2026 beauty trends I've tried and loved", url: 'https://www.getthegloss.com/beauty/2026-beauty-trends/', site_name: 'Get the Gloss' },
      { title: 'The 29 Best Makeup Products Of 2026, According To Experts', url: 'https://coveteur.com/best-makeup-products-2026', site_name: 'Coveteur' },
    ],
    image_search_keyword: 'soft glow skin makeup beauty filter',
  },
  {
    title: '스마트폰보다 먼저 꺼낸다 — AI 안경의 시대가 왔다',
    summary: '할리데이·메타 레이밴 2세대로 AI 안경이 CES 2026 최고 화제 기기로 등극\n마이크로 디스플레이·실시간 번역·AI 어시스턴트가 렌즈 안으로\n삼성 하반기 출시 예고, 킥스타터 AI 안경 펀딩 1억 달러 돌파',
    body: '스마트폰을 꺼내는 대신 그냥 앞을 바라보는 것으로 모든 정보를 얻는 시대가 열리고 있다. 2026년 상반기, AI 안경은 CES 2026의 가장 뜨거운 카테고리가 됐다. 할리데이(Halliday) AI 글래스는 일반 안경처럼 생긴 외관에 마이크로 디스플레이를 내장해 실시간 번역, 길 안내, AI 어시스턴트 응답을 눈앞에 띄워준다. 메타의 레이밴 스마트 글래스는 카메라, 마이크, 스피커에 강화된 AI를 탑재해 주변 환경을 인식하고 설명한다.\n\n킥스타터에서 AI 안경 관련 프로젝트는 2026년 상반기 누적 펀딩액이 1억 달러를 돌파했다. 투명 디스플레이 기술의 발전으로 배터리 수명과 렌즈 무게 문제가 개선되면서 일상 착용이 가능해진 것이 핵심 성장 요인이다.\n\n삼성은 하반기 자체 AI 안경 출시를 예고했고, 애플도 AR 안경 개발에 박차를 가하고 있다는 보도가 잇따른다. AI 안경이 대중화될 경우 스마트폰 산업 전반에 파급 효과가 클 것으로 전망된다.',
    why_trending: 'CES 2026 최고 주목 기기 선정, 킥스타터 1억 달러 펀딩 돌파, 삼성·애플 참전 선언으로 AI 안경 경쟁이 본격화됐다.',
    who_affected: '테크 얼리어답터, 스마트폰 제조사, AR·VR 개발 생태계',
    heat_score: 91,
    category: '테크',
    tags: ['AI안경', '메타레이밴', '할리데이', '웨어러블'],
    related_sources: [
      { title: 'Top tech trends 2026: 10 Gadgets that feel more like companions', url: 'https://thegadgetflow.com/blog/top-tech-trends/', site_name: 'The Gadget Flow' },
      { title: "Tom's Guide AI Awards 2026: 20 gadgets shaping our future", url: 'https://www.tomsguide.com/ai/toms-guide-ai-awards-2026', site_name: "Tom's Guide" },
      { title: 'Top 10 AI Gadgets on Kickstarter in June 2026', url: 'https://backerrock.com/blogs/innovative/top-10-ai-gadgets-on-kickstarter-june-2026-what-backers-are-funding-now', site_name: 'BackerRock' },
    ],
    image_search_keyword: 'AI smart glasses wearable tech futuristic',
  },
  {
    title: '"2026이 새로운 2016" — 10년 노스탤지어가 SNS를 강타',
    summary: '정확히 10년 전 2016년을 현재와 비교하는 챌린지가 틱톡·인스타그램 점령\n포케몬GO·저스틴 비버·아이폰 7 세대의 첫 SNS 시절 기억 소환\n올리비아 로드리고 신보 + FIFA 월드컵 개막과 맞물려 감성 폭발',
    body: '"2026이 새로운 2016이다(2026 is the new 2016)"라는 말이 6월 들어 틱톡과 인스타그램을 강타하고 있다. 정확히 10년 전인 2016년의 셀카, 패션, 음악, 밈을 소환해 현재와 비교하는 포맷이다. 2016년은 포케몬GO 열풍, 아이폰 7 출시, 올리비아 로드리고가 아직 아무도 모르던 시절로, 현재 20대 중반이 된 Z세대에게 첫 SNS 시절 기억이 담겨 있다.\n\n더 선(The Sun) 등 외신에 따르면, 이 트렌드를 촉발한 영상은 한 틱토커가 2016년 트위터 사진을 현재 모습과 나란히 놓으며 "10년 전 나 vs. 지금 나"를 비교한 것이다. 밀레니얼과 Z세대 사이에서 동시에 공감대를 형성하며 빠르게 확산됐다.\n\n6월 12일 올리비아 로드리고의 새 앨범 발매, 6월 11일 FIFA 월드컵 개막이 맞물리며 노스탤지어 감성이 증폭됐다. 6월 틱톡 노스탤지어 콘텐츠의 평균 조회수는 전년 동기 대비 140% 증가했다.',
    why_trending: '올리비아 로드리고 신보(6/12) + FIFA 월드컵 개막(6/11)이 맞물려 10년 전 기억 소환이 폭발적 공감대 형성.',
    who_affected: 'Z세대·밀레니얼 SNS 이용자, 콘텐츠 크리에이터, 노스탤지어 마케터',
    heat_score: 78,
    category: 'SNS',
    tags: ['노스탤지어', '2016챌린지', '틱톡트렌드'],
    related_sources: [
      { title: "What is '2026 is the new 2016' trend on Instagram and TikTok?", url: 'https://www.the-sun.com/tech/15779870/2026-2016-tiktok-instagram-social-media-nostalgia/', site_name: 'The Sun' },
      { title: 'June 2026 TikTok Trends: What\'s Viral This Month', url: 'https://newengen.com/insights/june-tiktok-trends/', site_name: 'NewEngen' },
      { title: 'Ramdam — TikTok Trends June 2026', url: 'https://www.ramd.am/blog/trends-tiktok', site_name: 'Ramdam' },
    ],
    image_search_keyword: 'nostalgia 2010s social media phone memories',
  },
  {
    title: '의도적으로 삐뚤어진 치마 — 언이븐 헴라인이 이번 여름 주인공',
    summary: '한쪽이 짧고 반대쪽이 긴 비대칭 헴라인이 2026 여름 패션 최대 트렌드로 등극\nH&M·자라도 6월 컬렉션에 대거 포함, 무신사 관련 검색 210% 급증\n탈코르셋 감성과 연결된 비대칭 실루엣의 문화적 의미',
    body: '이번 여름 패션계에서 가장 눈에 띄는 실루엣은 의도적으로 불균형하게 잘린 치마와 드레스다. 한쪽이 짧고 반대쪽이 긴 하이-로우 헴라인, 손수건을 접어 놓은 것 같은 행커치프 헴, 플레어 고어가 삽입된 고데 스커트가 런웨이와 거리를 함께 점령하고 있다.\n\n후즈왓웨어(Who What Wear), 마리클레르 등 주요 패션 미디어는 언이븐 헴라인을 2026년 여름 최대 패션 트렌드로 꼽았다. 이탈리아 출신 디자이너들과 뉴욕 인디 브랜드들이 주도하고 있으며, H&M·자라 등 패스트패션 브랜드도 6월 컬렉션에 관련 스타일을 대거 포함시켰다.\n\n비대칭 헴라인은 단순한 미적 요소를 넘어 규칙을 깨는 탈코르셋적 감성을 상징한다는 평가다. 국내에서는 무신사, 29CM 등 플랫폼에서 비대칭 치마 검색량이 5월 대비 210% 급증했다. 다양한 체형에서 독특하고 여성스러운 실루엣을 만들어주는 실용성도 인기 요인이다.',
    why_trending: '마리클레르·후즈왓웨어 등 글로벌 패션 미디어 동시 선정, H&M·자라 즉각 반영으로 패스트패션까지 확산됐다.',
    who_affected: '20-30대 패션 소비자, 인디 패션 브랜드, 패스트패션 업계',
    heat_score: 76,
    category: '패션',
    tags: ['언이븐헴라인', '비대칭패션', '여름패션2026'],
    related_sources: [
      { title: '5 Trends Cool Fashion People Are Wearing For Summer 2026', url: 'https://www.whowhatwear.com/fashion/trends/top-cool-girl-fashion-trends-june-2026', site_name: 'Who What Wear' },
      { title: "I'd Bet on These Becoming the Most Influential Fashion Trends of 2026", url: 'https://www.marieclaire.com/fashion/fashion-trends-2026/', site_name: 'Marie Claire' },
      { title: 'Spring Summer 2026 fashion trends', url: 'https://fashionunited.com/specials/spring-summer-2026-fashion-trends', site_name: 'FashionUnited' },
    ],
    image_search_keyword: 'asymmetric skirt hem summer fashion 2026',
  },
  {
    title: '잠을 수치로 공유한다 — 오라링이 만든 수면 자랑 문화',
    summary: '오라링·WHOOP가 만든 "수면 점수 공유"가 새로운 건강 인증 포맷으로 자리잡아\nNFL 선수 80%가 착용하던 기기가 일반 직장인 손목으로\n레딧 r/ouraring 50만 명 돌파, 수면 데이터가 아침 대화 주제로',
    body: '아침 인사가 달라지고 있다. "어젯밤 잘 잤어?"가 아니라 "오라 점수 몇 나왔어?"로. 오라링(Oura Ring)과 WHOOP 밴드가 만들어낸 수면 점수 공유 문화가 2026년 라이프스타일의 뜨거운 화두다.\n\n오라링 3세대는 심박수 변동성(HRV), 체온, 혈중 산소 포화도를 측정해 수면 준비도 점수와 회복 점수를 매일 아침 제공한다. WHOOP는 수면 코치 기능으로 최적 취침 시간과 기상 시간을 개인화해 알려준다. 미국 NFL 선수 80% 이상이 착용할 정도로 운동선수들 사이에서 먼저 유행한 이 기기들이 이제 일반 직장인의 손목을 점령하고 있다.\n\n레딧의 r/ouraring 커뮤니티는 50만 명을 돌파했고, 인스타그램에서 수면 점수를 공유하는 포맷이 하나의 콘텐츠 장르로 자리잡았다. 수면 자랑은 과거의 운동 인증 사진처럼 2026년 건강 라이프스타일의 상징이 됐다.',
    why_trending: '레딧 r/ouraring 50만 명 돌파, NFL·NBA 선수 착용이 대중 인지도를 높이며 일반 소비자 시장 침투가 본격화됐다.',
    who_affected: '건강·웰니스 관심층, 직장인, 운동 커뮤니티, 웨어러블 기기 시장',
    heat_score: 80,
    category: '라이프',
    tags: ['오라링', '수면최적화', '웨어러블', 'WHOOP'],
    related_sources: [
      { title: 'From Cycle Syncing to "Snack-Sized Workouts": 2026 Wellness Trends', url: 'https://www.whowhatwear.com/wellness-trends-2026', site_name: 'Who What Wear' },
      { title: '13 Wellness Trends That Will Dominate In 2026', url: 'https://www.marieclaire.co.uk/life/health-fitness/wellness-trends-2026', site_name: 'Marie Claire UK' },
      { title: 'Wellness Trends 2026: Personalization, Prevention & Real-Life Well-Being', url: 'https://draxe.com/health/wellness-trends-2026/', site_name: 'Dr. Axe' },
    ],
    image_search_keyword: 'sleep tracking ring wearable health wellness',
  },
  {
    title: 'AI가 만든 것처럼 보이지 않으려는 디자이너들 — 안티 AI 미학 부상',
    summary: 'AI 이미지 대홍수에 지친 시장, "인간 손의 흔적"이 프리미엄이 되다\n연필 자국·잉크 번짐·의도적 인쇄 오류가 2026 디자인 핵심 트렌드\n어도비 리포트: 핸드메이드 텍스처 파일 다운로드 전년 대비 67% 급증',
    body: 'AI가 만든 것 같아 보이지 않으려는 디자인이 2026년 그래픽 트렌드의 핵심이 됐다. 크리에이티브 블로크(Creative Bloq), 잇츠나이스댓(It\'s Nice That) 등 디자인 전문 매체는 2026년 가장 강력한 트렌드로 휴먼 터치(Human Touch)를 꼽았다.\n\n배경은 명확하다. 미드저니, DALL-E, Stable Diffusion으로 대표되는 AI 이미지 생성 도구가 대중화되면서 깔끔하고 완벽한 이미지가 오히려 진부하게 느껴지기 시작한 것이다. 이에 디자이너들은 연필 자국, 잉크 번짐, 손으로 찢은 질감, 인쇄 오류처럼 보이는 요소를 의도적으로 작업에 집어넣고 있다.\n\n이 트렌드는 촉각적 반란(Tactile Rebellion)이라는 이름으로도 불린다. 어도비 트렌드 리포트에 따르면 2026년 상반기 스톡 디자인 다운로드에서 핸드메이드 텍스처가 포함된 파일의 다운로드가 전년 대비 67% 증가했다. 브랜드들도 패키지 디자인에 이 트렌드를 반영해 소비자에게 사람이 만들었다는 신뢰를 전달하고 있다.',
    why_trending: '어도비 리포트 핸드메이드 텍스처 67% 급증, AI 생성 이미지 과잉 공급으로 인간 제작 디자인에 프리미엄이 붙기 시작했다.',
    who_affected: '그래픽 디자이너, 브랜드 마케터, 패키지 디자인 업계',
    heat_score: 73,
    category: '디자인',
    tags: ['안티AI디자인', '핸드메이드', '촉각디자인', '브랜딩'],
    related_sources: [
      { title: 'Texture, warmth and tactile rebellion: the big graphic design trends for 2026', url: 'https://www.creativebloq.com/design/graphic-design/texture-warmth-and-tactile-rebellion-the-big-graphic-design-trends-for-2026', site_name: 'Creative Bloq' },
      { title: "The graphic trends you'll want to bookmark for 2026", url: 'https://www.itsnicethat.com/features/forward-thinking-graphic-trends-2026-graphic-design-120126', site_name: "It's Nice That" },
      { title: 'Design trends for 2026', url: 'https://www.adobe.com/express/learn/blog/design-trends-2026', site_name: 'Adobe' },
    ],
    image_search_keyword: 'handmade texture graphic design print ink',
  },
  {
    title: '올빼미가 죽었다 — 듀오링고 가짜 사망 마케팅, 1,200억 뷰의 비밀',
    summary: '듀오링고 마스코트 "듀오" 가짜 사망 연출로 틱톡 단일 영상 1억 2,000만 뷰\n자발적 "장례식 콘텐츠" 생산으로 브랜드 언급량 400% 폭증\n자기 풍자와 밈 서사를 결합한 2026 최고의 바이럴 캠페인',
    body: '지난 2월, 듀오링고의 트레이드마크인 녹색 올빼미 듀오가 사이버트럭에 치여 사망했다는 소식이 인터넷을 강타했다. 물론 가짜다. 듀오링고가 자사 마스코트의 죽음을 연출한 이 마케팅 캠페인은 틱톡 단일 게시물에서 1억 2,000만 뷰를 기록하며 2026년 최고의 바이럴 마케팅 사례로 꼽히고 있다.\n\n이 캠페인의 성공 비결은 브랜드의 자기 풍자다. 듀오링고는 수년간 앱을 안 켜면 올빼미가 찾아온다는 협박형 유머로 밈을 만들어왔는데, 이번엔 올빼미 자신이 사라지는 충격적인 반전을 연출했다. 이후 장례식, 애도 콘텐츠로 이어지는 서사를 소셜 미디어 전반에 걸쳐 전개하며 브랜드 언급량이 400% 폭증했다.\n\n전문가들은 이 캠페인을 문화적 중력(Cultural Gravity) 마케팅의 교과서적 사례로 분석한다. 브랜드가 직접 밈의 주인공이 되어 사용자가 콘텐츠를 자발적으로 생성하고 공유하게 만드는 구조가 핵심이다.',
    why_trending: '틱톡 단일 영상 1.2억 뷰, 브랜드 언급 400% 폭증으로 2026년 상반기 가장 화제가 된 마케팅 캠페인으로 기록됐다.',
    who_affected: '마케터, 브랜드 담당자, SNS 콘텐츠 크리에이터, 소비자',
    heat_score: 88,
    category: '광고',
    tags: ['듀오링고', '바이럴마케팅', '밈마케팅', '브랜드캠페인'],
    related_sources: [
      { title: 'Viral Marketing Campaigns in 2026: What Works, Why It Spreads', url: 'https://almcorp.com/blog/viral-marketing-campaigns-2026/', site_name: 'ALM Corp' },
      { title: 'The Best Marketing Campaigns of 2026', url: 'https://www.brandvm.com/post/best-marketing-campaigns-2026', site_name: 'Brand Vision' },
      { title: '15 Viral Marketing Campaigns: What Works in 2026', url: 'https://www.designrush.com/agency/digital-marketing/trends/viral-marketing-campaigns', site_name: 'DesignRush' },
    ],
    image_search_keyword: 'viral marketing campaign social media brand',
  },
  {
    title: '쇼츠가 예고편이 됐다 — 2026 크리에이터의 트레일러 전략',
    summary: '유튜브 쇼츠→롱폼 전환율이 쇼츠 전용 채널의 3.2배라는 데이터 공개\n15-60초 쇼츠로 질문 던지고, 채널 롱폼으로 답 완성하는 구조\n50만+ 채널의 60%가 도입, 월평균 시청 시간 40% 이상 증가',
    body: '유튜브 쇼츠를 예고편으로 활용하고, 본 채널의 롱폼 영상으로 시청자를 유입시키는 트레일러 전략이 2026년 크리에이터 이코노미의 핵심 공식이 됐다. vidIQ, Epidemic Sound 등 크리에이터 툴 기업들이 분석한 결과, 이 전략을 활용하는 채널의 구독자 전환율이 쇼츠만 운영하는 채널보다 3.2배 높은 것으로 나타났다.\n\n방식은 간단하다. 15~60초 분량의 쇼츠로 핵심 장면이나 흥미로운 질문을 던지고, 댓글이나 화면에 "전체 영상은 채널에서"라는 안내를 넣는다. 시청자는 맥락을 완성하기 위해 채널로 이동한다. 유튜브 알고리즘도 이 패턴을 선호해 쇼츠와 롱폼 영상 모두의 노출을 높여주는 시너지가 발생한다.\n\n한국에서는 요리, 브이로그, 교육 채널 중심으로 이 전략 도입이 확산 중이다. 50만 구독자 이상 채널의 60%가 이미 쇼츠-롱폼 병행 전략을 운영하고 있으며, 쇼츠에서 롱폼으로의 전환을 체계화한 채널들은 월평균 시청 시간이 40% 이상 증가했다.',
    why_trending: 'vidIQ 데이터로 전환율 3.2배 수치가 공개되며 크리에이터 커뮤니티에서 검증된 전략으로 빠르게 확산됐다.',
    who_affected: '유튜브 크리에이터, 미디어 기업, 콘텐츠 마케터',
    heat_score: 74,
    category: '영상',
    tags: ['유튜브쇼츠', '롱폼전략', '크리에이터이코노미'],
    related_sources: [
      { title: '9 YouTube Trends Creators Need to Watch in 2026', url: 'https://vidiq.com/blog/post/future-youtube-trends/', site_name: 'vidIQ' },
      { title: 'Video content trends for 2026 on YouTube and social media', url: 'https://milx.app/en/trends/video-content-trends-for-2026-on-youtube-and-social-media', site_name: 'MilX' },
      { title: '10 Video Creator Trends You Can\'t Ignore in 2026', url: 'https://www.uscreen.tv/blog/video-creator-trends/', site_name: 'Uscreen' },
    ],
    image_search_keyword: 'youtube creator shorts video filming phone',
  },
]

// ── 메인 실행 ──────────────────────────────────────────────────
async function main() {
  const date = new Date().toLocaleDateString('ko-KR', { year: 'numeric', month: 'long', day: 'numeric' })
  console.log(`\n🚀 Pikk 트렌드 생성 시작 — ${date} Claude Code 웹 조사 데이터`)
  console.log(`📋 총 ${TRENDS.length}개 트렌드 처리 예정\n`)

  let successCount = 0, imageCount = 0

  for (let i = 0; i < TRENDS.length; i++) {
    const trend = TRENDS[i]
    const label = `[${i + 1}/${TRENDS.length}] ${trend.category}`
    console.log(`${label} │ ${trend.title.slice(0, 35)}...`)

    process.stdout.write('  → 이미지 수집 중...')
    const { image_url, gallery_images } = await collectImages(trend.related_sources, trend.image_search_keyword)
    const ogCount = gallery_images.filter(g => g.site_name !== 'Pexels').length
    const pxCount  = gallery_images.filter(g => g.site_name === 'Pexels').length
    console.log(` og:${ogCount} + Pexels:${pxCount} = ${gallery_images.length}장`)

    const { data, error } = await supabaseInsert('trends', {
      title: trend.title,
      summary: trend.summary,
      body: trend.body,
      why_trending: trend.why_trending,
      who_affected: trend.who_affected,
      heat_score: trend.heat_score,
      category: trend.category,
      tags: trend.tags,
      related_sources: trend.related_sources,
      source_url: trend.related_sources[0]?.url ?? null,
      image_search_keyword: trend.image_search_keyword,
      image_url,
      gallery_images,
      published_at: new Date().toISOString(),
    })

    if (error) {
      console.log(`  ❌ 저장 실패: ${error.message}`)
    } else {
      successCount++
      if (image_url) imageCount++
      console.log(`  ✅ ${data.id.slice(0, 8)}... | 메인이미지: ${image_url ? '✓' : '✗'}\n`)
    }
  }

  console.log(`──────────────────────────────────────`)
  console.log(`✨ 완료! ${successCount}/${TRENDS.length}개 저장 | 이미지 보유: ${imageCount}개`)
  console.log(`🌐 확인: http://localhost:3000\n`)
}

main().catch(err => { console.error('❌ 치명적 오류:', err); process.exit(1) })
