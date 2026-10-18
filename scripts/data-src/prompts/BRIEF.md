# Prompt authoring brief (Tier 2 and Tier 3)

These prompts are for schwa, a speaking coach that trains Modern RP and concise, natural British English. Learners are educated speakers from an Indian or international English background. They tend to pad their speech with verbal scaffolding ("actually what I am trying to say is…", "do the needful", "revert back", "small-small issues", "kindly", "prepone", repetition and stacked hedges). Every answer is **spoken aloud**.

`headwords.tsv` lists every vocabulary item the app has a card for, with its register (GREEN = formal-safe, AMBER = colleague or everyday, RED = social only) and category. **Targets must be copied exactly from this list.**

## Tier 2 — lexical compression (`tier2_<pack>.json`)

The learner sees a verbose, padded paragraph and has 10 seconds to say the same thing concisely in British English.

```json
{
  "domain": "software",
  "category": "status update",
  "verbose": "Actually what I wanted to tell you is that there are some small-small issues coming up with the new login page, so we are trying to fix them as soon as possible.",
  "reference": "We're seeing a few teething problems with the new login page — a fix is in hand.",
  "targets": ["teething problems"]
}
```

Rules:
- **verbose** is 25–70 words. It should sound like realistic spoken padding: scaffolding openers, Indian-English set phrases, tautology, stacked hedges, over-explanation. Vary the habits; don't use the same opener twice in a row.
- **reference** is a natural British version a fluent RP speaker would actually say, at most 45% of the verbose word count, speakable within 10 seconds. It must keep the meaning. Use British spelling and idiom. Contractions are good.
- **targets** has 1–2 headwords from `headwords.tsv` that appear in the reference (an inflected form is fine). Prefer GREEN/AMBER items. Use RED only when the domain is social.
- No names except common British first names. No real companies, products or people. Nothing that dates quickly.
- Spread across many situations within your domain. No near-duplicates.

## Tier 3 — open-ended monologue (`tier3_<pack>.json`)

The learner gets a scenario and speaks for 30–60 seconds.

```json
{
  "domain": "workplace",
  "category": "pushback",
  "register": "work",
  "prompt": "Your manager asks you to present the quarterly figures tomorrow, but the data won't be ready until Friday. Explain the problem and propose a realistic alternative.",
  "seconds": 60,
  "targets": ["a bit of a stretch", "provisional", "in the pipeline"]
}
```

Rules:
- **prompt** is a concrete, vivid situation in second person, 15–45 words. It ends with a clear speaking task (explain, persuade, push back, apologise, describe, recommend, tell a story, give an opinion and justify it, and so on).
- **register** is one of `"work"`, `"social"` or `"everyday"`. Targets must suit it: RED only for social.
- **seconds** is 30, 45 or 60, matched to how much there is to say.
- **targets** has 2–3 headwords from `headwords.tsv` that would naturally fit a good answer.
- Every prompt must be distinct: different situations, people, stakes and settings. No templated "{X} wants {Y}" repetition.
- Make it British: realistic UK settings and institutions (GP surgery, council, landlord, the Tube, a village fête, a team away day). Keep it inclusive and non-controversial: no partisan politics, religion debates or graphic content.

## Output

Write a strictly valid JSON array to the file you're assigned. Before finishing, validate it with Python. Check:
- the item count;
- no duplicates;
- every target appears in `headwords.tsv` (match case-insensitively on the first column);
- Tier 2 only: the reference word count is at most 0.45 × the verbose word count, and every target appears in the reference (inflections allowed).

Fix anything that fails.
