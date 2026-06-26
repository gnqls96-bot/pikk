// Shared AI-based dedup utilities used by generate-trends and instagram-daily

export interface AIDupResult {
  isDuplicate: boolean
  duplicateOfId: string | null
  reason: string
}

export interface DuplicateGroup {
  ids: string[]
  reason: string
}

// Single-candidate check: is this new trend the same event as any in `existing`?
export async function checkIsAIDuplicate(
  candidate: { title: string; summary: string; category: string },
  existing: { id: string; title: string; summary: string }[],
  apiKey: string,
): Promise<AIDupResult> {
  if (!apiKey || existing.length === 0) {
    return { isDuplicate: false, duplicateOfId: null, reason: '' }
  }

  const list = existing
    .map(t => `[id:${t.id}] "${t.title}" — ${t.summary.slice(0, 120)}`)
    .join('\n')

  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 200,
        messages: [
          {
            role: 'user',
            content: `Does this new trend cover the SAME SPECIFIC event as any existing trend below?

RULE: Same event = same award/announcement/person's same action on same occasion. General topic overlap is NOT a duplicate.

New trend (category: ${candidate.category}):
Title: "${candidate.title}"
Summary: "${candidate.summary.slice(0, 150)}"

Existing trends (same category):
${list}

Respond with JSON only: {"is_duplicate": boolean, "duplicate_of_id": "id or null", "reason": "..."}`,
          },
        ],
      }),
      signal: AbortSignal.timeout(15000),
    })

    if (!res.ok) return { isDuplicate: false, duplicateOfId: null, reason: 'API error' }
    const data = await res.json()
    const text: string = data.content?.[0]?.text?.trim() ?? ''
    const start = text.indexOf('{')
    const end = text.lastIndexOf('}')
    if (start === -1 || end === -1) return { isDuplicate: false, duplicateOfId: null, reason: 'parse error' }
    const json = JSON.parse(text.slice(start, end + 1))
    return {
      isDuplicate: json.is_duplicate === true,
      duplicateOfId: json.duplicate_of_id ?? null,
      reason: json.reason ?? '',
    }
  } catch {
    return { isDuplicate: false, duplicateOfId: null, reason: 'exception' }
  }
}

// Batch scan: find all duplicate groups within a single category's trend list.
// Returns groups of IDs that cover the same specific event.
export async function findDuplicateGroupsInCategory(
  trends: { id: string; title: string; summary: string; category: string }[],
  apiKey: string,
): Promise<DuplicateGroup[]> {
  if (!apiKey || trends.length < 2) return []

  const list = trends
    .map(t => `[id:${t.id}] "${t.title}" — ${t.summary.slice(0, 120)}`)
    .join('\n')

  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 1000,
        messages: [
          {
            role: 'user',
            content: `Find groups of articles that cover the SAME SPECIFIC event in this list.

RULE: Only group as duplicates if they cover the exact same event (same award, same launch, same person's same action on same date/occasion). Articles about the same general topic or industry are NOT duplicates.

Category: ${trends[0].category}
Articles:
${list}

Respond with JSON only:
{"duplicate_groups": [{"ids": ["id1", "id2"], "reason": "brief reason in English"}, ...]}

If no duplicates found: {"duplicate_groups": []}`,
          },
        ],
      }),
      signal: AbortSignal.timeout(20000),
    })

    if (!res.ok) return []
    const data = await res.json()
    const text: string = data.content?.[0]?.text?.trim() ?? ''
    const start = text.indexOf('{')
    const end = text.lastIndexOf('}')
    if (start === -1 || end === -1) return []
    const parsed = JSON.parse(text.slice(start, end + 1))
    return (parsed.duplicate_groups ?? []) as DuplicateGroup[]
  } catch {
    return []
  }
}
