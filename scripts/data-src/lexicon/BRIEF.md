# Lexicon authoring brief

These files hold the curated British-English lexicon for schwa, a speaking
coach for Modern Received Pronunciation (RP) and concise, natural British
English. Learners are educated speakers from an Indian or international
English background who read English well. Every card is practised **aloud**.

Each category file `scripts/data-src/lexicon/<category>.json` is a JSON array of
card objects:

```json
{
  "headword": "chips",
  "register": "GREEN",
  "us_equivalent": "French fries",
  "gloss": "Thick-cut strips of potato, deep-fried — as in fish and chips.",
  "usage": "Everyday word in shops, pubs and restaurants; a 'chippy' is a fish-and-chip shop.",
  "pragmatic_note": "Thin American-style fries are often still called 'fries' in the UK, especially at fast-food chains.",
  "pitfall": "In the US 'chips' means what Britons call crisps.",
  "examples": ["Shall we grab fish and chips on the way home?", "Do you want salt and vinegar on your chips?"],
  "collocations": ["fish and chips", "chip shop", "oven chips"],
  "wiki": "French fries",
  "forms": ["chip"]
}
```

## Field rules

- **headword** (required): the British word or phrase exactly as written in UK English: UK spelling, lower case unless it is a proper noun or an acronym (NHS, GP, A-levels, Boxing Day).
- **register** (required): `"GREEN"` = safe in boardroom, academic or formal writing; `"AMBER"` = natural colleague or everyday register; `"RED"` = colloquial or social only (warn the learner off using it at work).
- **us_equivalent** (optional): the American term, if there is a different one. Otherwise `null`.
- **gloss** (required): a crisp definition, at most 20 words.
- **usage** (required): one sentence on when and where Britons use it.
- **pragmatic_note** (optional): one sentence of genuine cultural or pragmatic insight (understatement, class or regional connotation, politeness), or `null`.
- **pitfall** (optional): a false-friend or misuse warning, especially for Indian-English or American-English speakers, or `null`.
- **examples** (required): 1–2 natural sentences a British person would actually say, each at most 18 words, in UK spelling. No names other than common British ones.
- **collocations** (optional): 0–3 common collocations.
- **wiki** (optional): the exact title of an existing English Wikipedia article whose lead image *shows* the thing (e.g. "Fish and chips", "Zebra crossing", "Hot water bottle"). Use `null` for abstract words, idioms or slang. Be accurate: a wrong title is worse than null.
- **forms** (optional): inflections or variants that also count as using the word (`["queued","queuing"]`).

## Quality bar

- British accuracy is everything. Only include items you are confident are current in mainstream UK usage. Mark dated or regional items as such in `usage`.
- No duplicates within your file. Avoid the 83 core headwords already in the app (listed in `core_headwords.txt`).
- Be factual about institutions and customs (NHS, council tax, A-levels, bank holidays). Avoid anything that will date quickly, such as prices, office-holders or brands that may vanish.
- Keep it inclusive and non-offensive. RED slang must be mild enough for a learner app; no slurs, sexual content or drug references.
- Output strictly valid JSON (double quotes, no comments, no trailing commas), UTF-8, using real typographic apostrophes in prose being optional (straight `'` is fine).
