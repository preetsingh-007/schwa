"""
Builds the endless listen-and-repeat corpus in public/corpus/ from:
  * Tatoeba English sentences (CC BY 2.0 FR) — eng_sentences_detailed.tsv
    https://downloads.tatoeba.org/exports/per_language/eng/eng_sentences_detailed.tsv.bz2
  * Public-domain British prose from Project Gutenberg (plain-text UTF-8 files)

Usage:
  python3 scripts/data-src/corpus.py <eng_sentences_detailed.tsv> <gutenberg_dir>
then `npm run annotate` to add phoneme sets.

Sentences are filtered for spoken British English (lexical Americanisms dropped,
US spellings converted), graded into levels by length and word rarity, and
sharded one file per level so the app only downloads what it is using.
"""
import json, math, os, random, re, sys
from collections import Counter

random.seed(7)
ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..')
OUT = os.path.join(ROOT, 'public', 'corpus')
LEVELS = 12
PER_LEVEL = 2000
MAX_WORDS, MIN_WORDS = 22, 5

# Lexical Americanisms: sentences containing them are skipped (we practise British usage).
US_WORDS = set('''apartment apartments elevator elevators sidewalk sidewalks cookie cookies candy candies vacation vacations mom moms
mommy cellphone cellphones garbage trash truck trucks subway diaper diapers sneakers freeway freeways soccer math gotten restroom restrooms
faucet faucets flashlight flashlights stroller strollers zipcode gasoline realtor checkbook drugstore drugstores fries semester semesters
awesome y'all ain't kindergarten bangs closet closets eggplant zucchini cilantro mailman mailbox mailboxes pantyhose purse purses
sweatpants toilet-paper parkway hood trunk cab cabs downtown uptown dorm dorms fall-semester'''.split())
US_PHRASES = [r'\bgas station', r'\bparking lot', r'\bzip code', r'\bcell phone', r'\bhigh school', r'\bpotato chips', r'\bfrench fries',
              r'\bi guess\b', r'\bin the hospital\b', r'\bon the weekend\b', r'\bwrite me\b', r'\bdo you have a\b.*\?$']
# Common US → UK spellings (speech is identical; the screen should match British norms).
SPELL = {
 'color': 'colour', 'colors': 'colours', 'colored': 'coloured', 'favor': 'favour', 'favors': 'favours', 'favorite': 'favourite',
 'favorites': 'favourites', 'honor': 'honour', 'honored': 'honoured', 'labor': 'labour', 'neighbor': 'neighbour', 'neighbors': 'neighbours',
 'neighborhood': 'neighbourhood', 'behavior': 'behaviour', 'humor': 'humour', 'flavor': 'flavour', 'harbor': 'harbour', 'rumor': 'rumour',
 'center': 'centre', 'centers': 'centres', 'theater': 'theatre', 'theaters': 'theatres', 'meter': 'metre', 'meters': 'metres',
 'liter': 'litre', 'liters': 'litres', 'fiber': 'fibre', 'gray': 'grey', 'traveled': 'travelled', 'traveling': 'travelling',
 'traveler': 'traveller', 'travelers': 'travellers', 'canceled': 'cancelled', 'canceling': 'cancelling', 'jewelry': 'jewellery',
 'pajamas': 'pyjamas', 'mustache': 'moustache', 'defense': 'defence', 'offense': 'offence', 'license': 'licence', 'practicing': 'practising',
 'catalog': 'catalogue', 'dialog': 'dialogue', 'analyze': 'analyse', 'analyzed': 'analysed', 'realize': 'realise', 'realized': 'realised',
 'recognize': 'recognise', 'recognized': 'recognised', 'organize': 'organise', 'organized': 'organised', 'apologize': 'apologise',
 'apologized': 'apologised', 'criticize': 'criticise', 'memorize': 'memorise', 'memorized': 'memorised', 'emphasize': 'emphasise',
 'tire': 'tyre', 'tires': 'tyres', 'mom': 'mum', 'program': 'programme', 'programs': 'programmes', 'aluminum': 'aluminium',
 'plow': 'plough', 'skeptical': 'sceptical', 'cozy': 'cosy', 'mold': 'mould', 'gotta': 'got to', 'gonna': 'going to', 'wanna': 'want to',
 'airplane': 'aeroplane', 'airplanes': 'aeroplanes', 'movie': 'film', 'movies': 'films', 'fall': 'fall', 'vacuum': 'hoover',
}
PROFANITY = set('fuck fucking shit bitch bastard cunt dick pussy whore slut nigger fag faggot rape raped kill kills killed suicide porn sex sexy naked'.split())

WORD_RE = re.compile(r"[A-Za-z']+")


def words(s):
    return [w.lower() for w in WORD_RE.findall(s)]


def britishise(s):
    def rep(m):
        w = m.group(0)
        uk = SPELL.get(w.lower())
        if not uk or uk == w.lower():
            return w
        return uk[0].upper() + uk[1:] if w[0].isupper() else uk
    return re.sub(r"[A-Za-z]+", rep, s)


def ok_sentence(s):
    if not (MIN_WORDS <= len(words(s)) <= MAX_WORDS):
        return False
    if not re.match(r'^[A-Z"\']', s) or not re.search(r'[.!?]["\']?$', s):
        return False
    if re.search(r'[^A-Za-z0-9 ,.!?\'";:\-’]', s) or re.search(r'\d', s):
        return False
    ws = set(words(s))
    if ws & US_WORDS or ws & PROFANITY:
        return False
    low = s.lower()
    if any(re.search(p, low) for p in US_PHRASES):
        return False
    return True


def load_tatoeba(path):
    out, seen = [], set()
    with open(path, encoding='utf-8') as f:
        for line in f:
            parts = line.rstrip('\n').split('\t')
            if len(parts) < 4:
                continue
            sid, _, text, user = parts[0], parts[1], parts[2].strip().replace('’', "'"), parts[3]
            if not ok_sentence(text):
                continue
            key = re.sub(r'\W+', ' ', text.lower()).strip()
            if key in seen:
                continue
            seen.add(key)
            out.append({'id': f'tt{sid}', 'text': britishise(text), 'src': 'tatoeba', 'by': user if user != '\\N' else ''})
    return out


def strip_gutenberg(raw):
    raw = raw.replace('\r', '')
    a = re.search(r'\*\*\* ?START OF (THE|THIS) PROJECT GUTENBERG[^\n]*\n', raw)
    b = re.search(r'\*\*\* ?END OF (THE|THIS) PROJECT GUTENBERG', raw)
    return raw[a.end() if a else 0: b.start() if b else len(raw)]


def load_gutenberg(d):
    out = []
    for fn in sorted(os.listdir(d)):
        if not fn.endswith('.txt'):
            continue
        raw = open(os.path.join(d, fn), encoding='utf-8', errors='replace').read()
        title = (re.search(r'^Title: *(.+)$', raw, re.M) or [None, fn])[1].strip()
        author = (re.search(r'^Author: *(.+)$', raw, re.M) or [None, ''])[1].strip()
        body = strip_gutenberg(raw)
        paras = [re.sub(r'\s+', ' ', p).strip() for p in re.split(r'\n\s*\n', body)]
        book = []
        for p in paras:
            p = p.replace('_', '').replace('--', ' — ').replace('“', '"').replace('”', '"').replace('‘', "'").replace('’', "'")
            p = re.sub(r'\s+', ' ', p).strip()
            n = len(words(p))
            if n < 22 or n > 70 or p.isupper() or re.search(r'CHAPTER|\[|\]|\*|\d{2,}', p):
                continue
            if p.count('"') > 4 or not re.search(r'[.!?]"?$', p) or set(words(p)) & PROFANITY:
                continue
            book.append({'id': f'gb{fn[:-4]}-{len(book)}', 'text': p, 'src': f'gutenberg:{fn[:-4]}', 'by': f'{title} — {author}'})
        random.shuffle(book)
        out.extend(book[:260])
    return out


def main():
    tatoeba = load_tatoeba(sys.argv[1])
    guten = load_gutenberg(sys.argv[2])
    freq = Counter(w for s in tatoeba for w in words(s['text']))
    total = sum(freq.values())

    def difficulty(s):
        ws = words(s['text'])
        rar = sorted((-math.log((freq.get(w, 0) + 1) / total) for w in ws), reverse=True)
        top = sum(rar[:3]) / min(3, len(rar))
        return 0.65 * top + 0.35 * math.log(len(ws)) * 3

    # Cap the ubiquitous Tatoeba "Tom"/"Mary" sentences at 8 %.
    named = [s for s in tatoeba if re.search(r'\b(Tom|Mary)\b', s['text'])]
    plain = [s for s in tatoeba if not re.search(r'\b(Tom|Mary)\b', s['text'])]
    random.shuffle(named)
    pool = plain + named[: int(len(plain) * 0.08)]
    for s in pool + guten:
        s['d'] = difficulty(s)
    pool.sort(key=lambda s: s['d'])
    # Stratified sample: PER_LEVEL sentences from each difficulty quantile.
    levels = []
    q = len(pool) / LEVELS
    for L in range(LEVELS):
        band = pool[int(L * q): int((L + 1) * q)]
        levels.append(random.sample(band, min(PER_LEVEL, len(band))))
    # Passages: spread over the upper half of the levels by their own difficulty.
    guten.sort(key=lambda s: s['d'])
    gq = len(guten) / (LEVELS // 2)
    for k in range(LEVELS // 2):
        for s in guten[int(k * gq): int((k + 1) * gq)]:
            levels[LEVELS // 2 + k - 1 if k else LEVELS // 2 - 1].append(s)

    os.makedirs(OUT, exist_ok=True)
    shards = []
    for L, items in enumerate(levels, start=1):
        random.shuffle(items)
        rows = [{'id': s['id'], 'text': s['text'], 'src': s['src'], 'by': s['by']} for s in items]
        name = f'level-{L:02d}.json'
        with open(os.path.join(OUT, name), 'w', encoding='utf-8') as f:
            json.dump(rows, f, ensure_ascii=False, separators=(',', ':'))
        shards.append({'level': L, 'file': name, 'count': len(rows), 'passages': sum(1 for r in rows if r['src'] != 'tatoeba')})
    books = sorted({(s['src'], s['by']) for s in guten})
    index = {
        'version': 1,
        'levels': shards,
        'total': sum(s['count'] for s in shards),
        'sources': [
            {'id': 'tatoeba', 'name': 'Tatoeba', 'license': 'CC BY 2.0 FR', 'url': 'https://tatoeba.org/', 'itemUrl': 'https://tatoeba.org/en/sentences/show/{id}'},
            *({'id': src, 'name': by, 'license': 'Public domain', 'url': f'https://www.gutenberg.org/ebooks/{src.split(":")[1]}'} for src, by in books),
        ],
    }
    with open(os.path.join(OUT, 'index.json'), 'w', encoding='utf-8') as f:
        json.dump(index, f, ensure_ascii=False, indent=1)
    print(f'tatoeba kept {len(tatoeba)} (pool {len(pool)}), gutenberg passages {len(guten)}, shipped {index["total"]} in {LEVELS} levels')


if __name__ == '__main__':
    main()
