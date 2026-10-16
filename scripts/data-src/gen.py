import json, re, sys, os
sys.path.insert(0, os.path.dirname(__file__))
from vocab import V, LABEL
from phonemes import PHONEMES
from prompts import T1, T2, T3, DOMAINS
import rules as R

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..', 'public', 'data')
os.makedirs(OUT, exist_ok=True)

def dump(name, obj):
    with open(os.path.join(OUT, name), 'w', encoding='utf-8') as f:
        json.dump(obj, f, ensure_ascii=False, indent=1)
        f.write('\n')

# ---- vocab
ids = {}
vocab = []
for (vid, head, ipa, stress, badge, trap, usage, prag, repl, coll, examples, forms) in V:
    full = f'lex_{vid}_01'
    ids[vid] = full
    vocab.append({
        'id': full, 'headword': head, 'ipa_rp': ipa, 'syllable_stress': stress, 'audio_uri': None,
        'phonetic_trap': trap, 'register_badge': badge, 'register_label': LABEL[badge],
        'usage_context': usage, 'pragmatic_note': prag, 'replaces_verbose': repl, 'collocations': coll,
        'examples_rp': [{'text': e, 'ipa_connected': ''} for e in examples],
        **({'forms': forms} if forms else {}),
    })
dump('vocab_curriculum.json', vocab)

def vid(x):
    if x not in ids:
        raise SystemExit(f'unknown vocab id {x}')
    return ids[x]

# ---- rules
DROP = {r'\brevert(?![\w\'])', r'\bno\?$', r"\bisn'?t\s+it\?", r'\bonly\s+(itself|myself)(?![\w\'])', r'\bitself\s+only(?![\w\'])',
        r'\bgood\s+name(?![\w\'])', r'\b(from|since)\s+(\w+)\s+onwards(?![\w\'])'}
DROP_PHRASES = {'the reason why', 'enter into', 'protest against', 'fall down', 'rise up', 'on the other hand', 'in other words',
                'is going to be', 'are going to be', 'we are going to', 'i am going to', 'and all', 'so so', 'whatsoever'}
MINOR_INDIANISMS = {'kindly', 'as per', 'herewith', 'too good', 'very much (busy|happy|interested)', 'at your earliest convenience',
                    'with immediate effect', 'on priority( basis)?', 'please find (attached|enclosed) herewith', 'i am telling you'}
SPECIAL = [
 ('today (morning|afternoon|evening)', 'this $1', 'indianism', 'critical', "UK English says 'this morning', not 'today morning'."),
 ('today night', 'tonight', 'indianism', 'critical', "'Tonight', not 'today night'."),
 ('yesterday night', 'last night', 'indianism', 'critical', "'Last night', not 'yesterday night'."),
 ('(he|she|it) is having (a )?(fever|cold|headache)', '$1 has a $3', 'indianism', 'minor', "Stative 'have' isn't used in the progressive in UK English."),
 ('(i|we|they|you) (am|are) having (a )?(fever|cold|headache)', '$1 have a $4', 'indianism', 'minor', "Stative 'have' isn't used in the progressive in UK English."),
 ('too good(?! to)', 'excellent', 'indianism', 'minor', "'Too good' means 'excessively good' in UK English."),
 ('as far as (\\w+) (is|are) concerned', 'on $1', 'scaffold', 'minor', "Shorter: 'On cost, …'."),
]

def rx(p):
    return p.replace(' ', r'\s+')

def build(pattern, repl, cat, sev, note, vocab_ids=None):
    pat = r'\b' + rx(pattern) + r"(?![\w'])"
    if not pat.endswith(r"(?![\w'])"):
        pat += r"(?![\w'])"
    return {'pattern': pat, 'replacements': [r.replace('\\1', '$1').replace('\\2', '$2').replace('\\3', '$3') for r in repl],
            'category': cat, 'severity': sev, 'note': note, **({'vocab': [vid(v) for v in vocab_ids]} if vocab_ids else {})}

rules = []
seen = set()
def push(rule):
    if rule['pattern'] in DROP or rule['pattern'] in seen:
        return
    seen.add(rule['pattern'])
    rules.append(rule)

for p, r, sev, note, vids in R.UPGRADES:
    if p.startswith('(it|this) is (too|very) risky'):
        continue
    if p.startswith('the main problem'):
        sev = R.M
    push(build(p, r, 'upgrade', sev, note, vids))
SOFT_SCAFFOLDS = ('in terms of', 'when it comes to', 'with regard', 'with respect to', 'in relation to', 'in connection with', 'first of all',
    'last but not least', 'to sum', 'in conclusion', 'as you (all )?know', 'as we all know', 'like i said', 'long story short', 'to make a long story',
    'having said that', 'that being said', 'with (all )?that being said', 'needless to say', 'it goes without saying', 'from my side',
    'all things considered', 'at the end of the day', 'when all is said and done', 'for all intents', 'it is what it is', 'my question is',
    'i have a small', 'if i am not wrong', "if i'?m not mistaken", 'i would say that', 'as i was saying', 'as i (already)', 'if you (see', 'you know what',
    'if you know what', 'do you get', 'i hope (you', 'the reason (why )?(is|was) because', 'the reason why (is|was) that')
for p, r, sev, note, vids in R.EXTRA_UPGRADES:
    push(build(p, r, 'upgrade', sev, note, vids))
for p, r in R.SCAFFOLDS:
    if p.startswith('as far as'):
        continue
    if p == 'in terms of':
        r = ['on']
    sev = R.M if p.startswith(SOFT_SCAFFOLDS) else R.C
    push(build(p, r, 'scaffold', sev, 'Verbal scaffolding: it delays the point. Start with the point itself.'))
for p in R.FILLERS:
    if p in DROP_PHRASES:
        continue
    push(build(p, [''], 'filler', R.M, 'Filler — a short silence is better than a filler.'))
for p, r in R.WORDY:
    if p in DROP_PHRASES:
        continue
    push(build(p, [r], 'wordy', R.M, f"Wordy — '{r}' says the same." if r else 'Wordy — cut it.'))
for p, r in R.PLEONASMS:
    if p in DROP_PHRASES:
        continue
    push(build(p, [r], 'pleonasm', R.M, 'Redundant pair (pleonasm): one word already carries the meaning.'))
for p, r, note in R.INDIANISMS:
    if p.startswith('(today|yesterday|tomorrow)') or p.startswith('(is|are) having') or p == 'too good' or p.startswith('(from|since)'):
        continue
    sev = R.M if p in MINOR_INDIANISMS else R.C
    push(build(p, [r], 'indianism', sev, note or 'Indian-English usage that reads oddly to British listeners.'))
for p, r, cat, sev, note in SPECIAL:
    push(build(p, [r], cat, sev, note))
for p, r in R.HEDGES:
    push(build(p, [r], 'hedge', R.M, 'Stacked hedges sound unsure; one well-placed hedge is very British.'))
for p, r in R.INTENSIFIERS:
    push(build(p, [r], 'intensifier', R.M, 'Stacked intensifiers — pick one precise word instead.'))

for i, r in enumerate(rules):
    r['id'] = f'rr_{i + 1:03d}'
    try:
        re.compile(r['pattern'].replace('(?![\\w\'])', ''))
    except re.error as e:
        raise SystemExit(f'bad regex {r["pattern"]}: {e}')
rules = [{'id': r['id'], **{k: v for k, v in r.items() if k != 'id'}} for r in rules]
dump('redundancy_rules.json', rules)

# ---- prompts
prompts = []
for i, (pillar, title, text, pairs) in enumerate(T1):
    prompts.append({'id': f't1_{i + 1:03d}', 'tier': 1, 'pillar': pillar, 'category': pillar, 'title': title, 'text': text,
                    'reference': text, 'targetVocab': [vid('untenable')] if 'untenable' in text else [], 'timeLimitSec': 20,
                    **({'pairs': pairs} if pairs else {})})
for i, (cat, verbose, vids, ref) in enumerate(T2):
    prompts.append({'id': f't2_{i + 1:03d}', 'tier': 2, 'category': cat, 'title': 'Compress it — 10 seconds', 'text': verbose,
                    'reference': ref, 'targetVocab': [vid(v) for v in vids], 'timeLimitSec': 10})
n3 = 0
seen_text = set()
for t_i, (cat, tmpl, vids, secs) in enumerate(T3):
    for d in DOMAINS:
        text = tmpl.format(**d)
        text = text[0].upper() + text[1:]
        if text in seen_text:
            continue
        seen_text.add(text)
        n3 += 1
        prompts.append({'id': f't3_{t_i + 1:02d}_{d["key"]}', 'tier': 3, 'category': cat, 'title': cat.capitalize(), 'text': text,
                        'targetVocab': [vid(v) for v in vids], 'timeLimitSec': secs})
dump('prompts_tiered.json', prompts)
dump('rp_phonemes_44.json', PHONEMES)

cats = {}
for r in rules:
    cats[r['category']] = cats.get(r['category'], 0) + 1
print(f'vocab {len(vocab)} · rules {len(rules)} {cats} · prompts t1={len(T1)} t2={len(T2)} t3={n3} · phonemes {len(PHONEMES)}')
