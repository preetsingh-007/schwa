"""
Builds the automatic word layer (the ~20,000 most frequent English lemmas)
for the LexiPhon lexicon.

Sources (all open):
  * wordfreq (Robyn Speer et al.) frequency ranks — data CC BY-SA 4.0
  * Princeton WordNet 3.0 (via NLTK) definitions/examples, senses ranked by
    SemCor usage counts — WordNet 3.0 licence (permissive, attribution)
  * Tatoeba example sentences — CC BY 2.0 FR

Usage:
  NLTK_DATA=<dir with corpora/wordnet.zip> PYTHONPATH=<dir with wordfreq, nltk> \
      python3 scripts/data-src/words.py eng_sentences_detailed.tsv out.json
then `npx vite-node scripts/build-lexicon.ts` adds RP IPA and shards it.
"""
import json, re, sys, os
from collections import defaultdict

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from corpus import SPELL, PROFANITY, US_WORDS, britishise, ok_sentence, words as tokens  # noqa: E402
from wordfreq import top_n_list  # noqa: E402

TARGET = 20000
POS_NAME = {'n': 'noun', 'v': 'verb', 'a': 'adjective', 's': 'adjective', 'r': 'adverb'}
FUNCTION = set('''the a an and or but if so as at by for from in into of off on onto out over to up with without about above after
before below between during through under until upon is am are was were be been being have has had do does did can could may might
must shall should will would i me my mine we us our ours you your yours he him his she her hers it its they them their theirs this that
these those there here what which who whom whose when where why how not no yes than then too very just also'''.split())


FUNCTION_GLOSS = {
    'the': 'definite article', 'a': 'indefinite article (before consonant sounds)', 'an': 'indefinite article (before vowel sounds)',
    'and': 'joins words or clauses', 'or': 'introduces an alternative', 'but': 'introduces a contrast', 'if': 'introduces a condition',
    'so': 'therefore; to such a degree', 'as': 'in the role of; while; because', 'at': 'indicates a place or time', 'by': 'next to; through the action of',
    'for': 'intended for; because of; during', 'from': 'indicates a starting point or source', 'in': 'inside; during', 'into': 'to the inside of',
    'of': 'belonging to; made from; part of', 'off': 'away from; not on', 'on': 'supported by a surface; about', 'onto': 'to a position on',
    'out': 'away from the inside', 'over': 'above; across; finished', 'to': 'towards; infinitive marker', 'up': 'towards a higher place',
    'with': 'accompanied by; using', 'without': 'not having', 'about': 'on the subject of; approximately', 'above': 'higher than',
    'after': 'later than', 'before': 'earlier than', 'below': 'lower than', 'between': 'in the space separating two things',
    'during': 'throughout a period', 'through': 'from one side to the other', 'under': 'beneath', 'until': 'up to a time', 'upon': 'on (formal)',
    'is': 'third-person singular of “be”', 'am': 'first-person singular of “be”', 'are': 'plural and second-person form of “be”',
    'was': 'past of “be” (singular)', 'were': 'past of “be” (plural)', 'be': 'exist; auxiliary verb', 'been': 'past participle of “be”',
    'being': 'present participle of “be”', 'have': 'possess; auxiliary verb', 'has': 'third-person singular of “have”', 'had': 'past of “have”',
    'do': 'perform; auxiliary verb', 'does': 'third-person singular of “do”', 'did': 'past of “do”', 'can': 'be able to', 'could': 'was able to; might',
    'may': 'might; be allowed to', 'might': 'possibly will', 'must': 'have to', 'shall': 'will (formal, first person)', 'should': 'ought to',
    'will': 'future auxiliary', 'would': 'conditional auxiliary', 'i': 'first-person subject pronoun', 'me': 'first-person object pronoun',
    'my': 'belonging to me', 'mine': 'the one belonging to me', 'we': 'first-person plural pronoun', 'us': 'first-person plural object pronoun',
    'our': 'belonging to us', 'ours': 'the one belonging to us', 'you': 'second-person pronoun', 'your': 'belonging to you', 'yours': 'the one belonging to you',
    'he': 'male subject pronoun', 'him': 'male object pronoun', 'his': 'belonging to him', 'she': 'female subject pronoun', 'her': 'female object pronoun; belonging to her',
    'hers': 'the one belonging to her', 'it': 'thing pronoun', 'its': 'belonging to it', 'they': 'plural (or singular neutral) subject pronoun',
    'them': 'plural object pronoun', 'their': 'belonging to them', 'theirs': 'the one belonging to them', 'this': 'the one here', 'that': 'the one there; introduces a clause',
    'these': 'the ones here', 'those': 'the ones there', 'there': 'in that place; existential subject', 'here': 'in this place', 'what': 'which thing',
    'which': 'what one (of a set)', 'who': 'what person', 'whom': 'what person (object, formal)', 'whose': 'belonging to whom', 'when': 'at what time',
    'where': 'in what place', 'why': 'for what reason', 'how': 'in what way', 'not': 'negation', 'no': 'not any; negative answer', 'yes': 'affirmative answer',
    'than': 'introduces the second part of a comparison', 'then': 'at that time; next', 'too': 'also; excessively', 'very': 'to a high degree',
    'just': 'only; exactly; very recently', 'also': 'in addition',
}


# Plural-only or plural-form nouns that are vocabulary items in their own right.
PLURALIA = set('''news species series means physics mathematics politics economics athletics glasses clothes trousers scissors jeans
savings stairs headquarters thanks premises goods arms surroundings remains outskirts belongings congratulations pyjamas shorts
binoculars tongs pliers earnings proceeds odds whereabouts crossroads barracks'''.split())


def lemma_candidates(w):
    """Regular inflection stems, most specific first."""
    if w.endswith('ies') and len(w) > 4: yield w[:-3] + 'y'
    if w.endswith('es') and len(w) > 3: yield w[:-2]
    if w.endswith('s') and not w.endswith('ss') and len(w) > 3: yield w[:-1]
    if w.endswith('ied') and len(w) > 4: yield w[:-3] + 'y'
    if w.endswith('ed') and len(w) > 3:
        if len(w) > 5 and w[-3] == w[-4]: yield w[:-3]
        yield w[:-1]; yield w[:-2]
    if w.endswith('ing') and len(w) > 4:
        if len(w) > 6 and w[-4] == w[-5]: yield w[:-4]
        yield w[:-3] + 'e'; yield w[:-3]


def wordnet_sense(wn, lem):
    """(part of speech, definition, example) of the most frequent sense, by SemCor counts."""
    synsets = wn.synsets(lem)
    if not synsets:
        return None
    best, best_key = None, None
    order = {'n': 0, 'v': 1, 'a': 2, 's': 2, 'r': 3}
    pos_count = defaultdict(int)
    for s in synsets:
        pos_count[s.pos()] += sum(l.count() for l in s.lemmas() if l.name().lower() == lem)
    for i, s in enumerate(synsets):
        c = sum(l.count() for l in s.lemmas() if l.name().lower() == lem)
        first = 1 if s.lemmas()[0].name().lower() == lem else 0
        # rank: usage count, then the POS with most usage, then headword-first synsets, then WordNet order
        key = (c, pos_count[s.pos()], first, -order.get(s.pos(), 4), -i)
        if best_key is None or key > best_key:
            best, best_key = s, key
    ex = best.examples()[0] if best.examples() else ''
    return POS_NAME.get(best.pos(), ''), best.definition(), ex


def main():
    from nltk.corpus import wordnet as wn
    tatoeba_path, out_path = sys.argv[1:3]
    to_lemma = {}

    def lemma_of(w):
        if w in to_lemma:
            return to_lemma[w]
        res = None
        if wn.synsets(w):
            # Prefer the base form for inflections ("played" → "play"), unless the
            # inflected form is a lexical item in its own right ("building", "news").
            # morphy() returns the word itself when it has its own entry ("years" = old age),
            # so try regular stems first.
            base = next((c for c in lemma_candidates(w) if c != w and wn.synsets(c)), None) or wn.morphy(w)
            own_nouns = [s for s in wn.synsets(w, 'n') if any(l.name().lower() == w for l in s.lemmas())]
            plural = w.endswith('s') and w not in PLURALIA
            # plurals always fold to the singular; -ing/-ed forms only if not a noun in their own right
            res = base if base and base != w and (plural or len(own_nouns) < 2) else w
            # Proper-noun-only entries (all lemmas capitalised) are not vocabulary.
            if all(all(l.name()[:1].isupper() for l in s.lemmas() if l.name().lower() == res) for s in wn.synsets(res)):
                res = None
        to_lemma[w] = res
        return res

    raw = top_n_list('en', 90000)
    chosen, seen = [], set()
    for rank, w in enumerate(raw, start=1):
        if not re.fullmatch(r"[a-z][a-z\-]*", w) or len(w) < 2 and w not in ('a', 'i'):
            continue
        if w in PROFANITY or w in US_WORDS:
            continue
        uk = SPELL.get(w)
        if uk and uk != w:
            w = uk  # store the British spelling
        if w in FUNCTION:
            lem = w
        else:
            lem = lemma_of(w)
            if lem is None:
                continue
        lem = SPELL.get(lem, lem)
        if lem in seen:
            continue
        seen.add(lem)
        chosen.append((lem, rank))
        if len(chosen) >= TARGET:
            break

    # Examples from Tatoeba: shortest natural sentence (6–14 words) that uses the lemma or an inflection.
    want = {l for l, _ in chosen}
    best = {}
    with open(tatoeba_path, encoding='utf-8') as f:
        for line in f:
            parts = line.rstrip('\n').split('\t')
            if len(parts) < 4:
                continue
            text = parts[2].strip().replace('’', "'")
            if not ok_sentence(text):
                continue
            toks = tokens(text)
            if not 6 <= len(toks) <= 14 or re.search(r'\b(Tom|Mary)\b', text):
                continue
            for t in set(toks):
                l = t if t in want else lemma_of(t)
                if l in want:
                    cur = best.get(l)
                    score = abs(len(toks) - 9)
                    if cur is None or score < cur[0]:
                        best[l] = (score, britishise(text), parts[0], parts[3])

    out = []
    for lem, rank in chosen:
        if lem in FUNCTION:
            pos, d, wex = 'function word', FUNCTION_GLOSS.get(lem, ''), ''
        else:
            sense = wordnet_sense(wn, lem)
            pos, d, wex = sense if sense else ('', '', '')
        ex = best.get(lem)
        row = {'w': lem, 'r': rank, 'p': pos, 'd': d}
        if ex:
            row.update({'x': ex[1], 'xs': f'tt{ex[2]}', 'xb': ex[3] if ex[3] != '\\N' else ''})
        elif wex:
            row.update({'x': wex[0].upper() + wex[1:], 'xs': 'wordnet'})
        out.append(row)
    with open(out_path, 'w', encoding='utf-8') as f:
        json.dump(out, f, ensure_ascii=False)
    with_ex = sum(1 for r in out if 'x' in r)
    print(f'{len(out)} lemmas · {with_ex} with examples · {sum(1 for r in out if r["d"])} with definitions')


if __name__ == '__main__':
    main()
