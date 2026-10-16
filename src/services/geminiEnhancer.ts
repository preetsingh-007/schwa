/**
 * OPTIONAL Google AI Studio (Gemini 2.5 Flash) enhancer — Bring Your Own Key.
 *
 * Hard rule: nothing in LexiPhon depends on this. Every call has a timeout and
 * returns null on any failure, and callers always render the local result
 * first. The only data sent is the transcript text of the current turn and
 * the prompt (never audio, never state).
 */

const ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent';

export interface GeminiRewrite {
  executive: string;
  colleague: string;
  idiomatic: string;
  pragmatics: string;
  followUp: string;
}

const SCHEMA = {
  type: 'OBJECT',
  properties: {
    executive: { type: 'STRING', description: 'Executive Concise British version (boardroom safe), max ~40% of the original length' },
    colleague: { type: 'STRING', description: 'Natural Colleague British version (standup / Teams register)' },
    idiomatic: { type: 'STRING', description: 'Idiomatic British version using one or two natural idioms' },
    pragmatics: { type: 'STRING', description: 'Two sentences on British pragmatics: hedging, understatement, register appropriateness of what the speaker said' },
    followUp: { type: 'STRING', description: 'One Socratic follow-up question that challenges the speaker\'s argument, to be answered aloud' },
  },
  required: ['executive', 'colleague', 'idiomatic', 'pragmatics', 'followUp'],
};

export function isGeminiAvailable(key: string, enabled: boolean): boolean {
  return enabled && key.trim().length > 20 && typeof navigator !== 'undefined' && navigator.onLine;
}

export async function enhanceMonologue(
  key: string,
  o: { prompt: string; transcript: string; targetWords: string[] },
  timeoutMs = 15_000,
  fetchImpl: typeof fetch = fetch,
): Promise<GeminiRewrite | null> {
  if (!o.transcript.trim()) return null;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const text = [
      'You are a Modern RP (Standard Southern British English) speaking coach for an Indian-English speaker who tends towards verbosity.',
      `Speaking prompt: "${o.prompt}"`,
      `Target vocabulary: ${o.targetWords.join(', ') || '(none)'}`,
      `What the speaker said (ASR transcript): "${o.transcript}"`,
      'Rewrite it three ways in British English, each speakable in one breath group per sentence, keeping the speaker\'s meaning and using the target vocabulary where natural.',
      'Avoid Americanisms and Indian-English set phrases (do the needful, revert back, prepone, kindly).',
    ].join('\n');
    const res = await fetchImpl(ENDPOINT, {
      method: 'POST',
      signal: ctrl.signal,
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key.trim() },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text }] }],
        generationConfig: { responseMimeType: 'application/json', responseSchema: SCHEMA, temperature: 0.6, maxOutputTokens: 1024, thinkingConfig: { thinkingBudget: 0 } },
      }),
    });
    if (!res.ok) return null;
    const j = (await res.json()) as { candidates?: { content?: { parts?: { text?: string }[] } }[] };
    const raw = j.candidates?.[0]?.content?.parts?.map((p) => p.text ?? '').join('') ?? '';
    const parsed = JSON.parse(raw) as Partial<GeminiRewrite>;
    if (!parsed.executive || !parsed.colleague || !parsed.idiomatic) return null;
    return {
      executive: parsed.executive,
      colleague: parsed.colleague,
      idiomatic: parsed.idiomatic,
      pragmatics: parsed.pragmatics ?? '',
      followUp: parsed.followUp ?? '',
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Cheap key check used by the Settings vault. */
export async function testGeminiKey(key: string, fetchImpl: typeof fetch = fetch): Promise<boolean> {
  try {
    const res = await fetchImpl('https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash', { headers: { 'x-goog-api-key': key.trim() } });
    return res.ok;
  } catch {
    return false;
  }
}
