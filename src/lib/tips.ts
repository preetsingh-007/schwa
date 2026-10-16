import type { Diagnosis } from '../services/ipaAligner';

export interface Tip { title: string; mechanics: string; pillar: string }

/** Articulatory Mechanics Card copy for each diagnosis. */
export const TIPS: Record<Diagnosis, Tip> = {
  RETROFLEX: {
    pillar: 'Alveolar precision',
    title: 'Tongue tip curled back (retroflex)',
    mechanics: 'Keep the tongue tip forward: touch the alveolar ridge — the bony bump just behind your upper front teeth — with a flat tip/blade. Don\'t curl it back towards the hard palate. Word-initially, release /t/ with a light puff of air [tʰ].',
  },
  DENTAL_STOP: {
    pillar: 'Alveolar precision',
    title: 'Dental /t d/ instead of alveolar',
    mechanics: 'Your tongue is touching the teeth. Pull it back a few millimetres onto the alveolar ridge; the RP /t/ is crisper and slightly aspirated.',
  },
  TH_STOPPING: {
    pillar: 'Dental fricatives',
    title: '/θ ð/ produced as a stop',
    mechanics: 'Let the tongue tip rest lightly against the back of the upper teeth and push air through continuously — a soft hiss for /θ/ (think), voiced buzz for /ð/ (this). No full closure.',
  },
  VW_MERGER: {
    pillar: '/v/ vs /w/',
    title: '/v/–/w/ merged',
    mechanics: '/v/: upper teeth on the inside of the lower lip, with audible friction and voicing. /w/: no tooth contact at all — round and protrude the lips tightly as for "oo", then open into the vowel.',
  },
  GOAT_MONOPHTHONG: {
    pillar: 'Diphthongs',
    title: 'GOAT flattened to [oː]',
    mechanics: 'Start from a relaxed central schwa /ə/ with lips unrounded, then glide towards /ʊ/ as the lips round: /əʊ/. Say "uh-oo" quickly — "go" is /ɡəʊ/, not [ɡoː].',
  },
  GOAT_BACKED: {
    pillar: 'Diphthongs',
    title: 'GOAT starts too far back ([oʊ])',
    mechanics: 'RP GOAT starts central, not back-rounded. Begin with unrounded /ə/ and only round the lips during the glide.',
  },
  FACE_MONOPHTHONG: {
    pillar: 'Diphthongs',
    title: 'FACE flattened to [eː]',
    mechanics: 'Make a full glide: start at /e/ (as in "bed") and move the tongue up towards /ɪ/ — "make" /meɪk/, "late" /leɪt/. Feel the jaw close slightly during the vowel.',
  },
  TRAP_BATH: {
    pillar: 'Vowel space',
    title: 'BATH word said with TRAP /æ/',
    mechanics: 'In RP, BATH words (ask, bath, chance, demand, branch, can\'t) take the long open back /ɑː/: drop the jaw, tongue low and back, lips neutral — "ahh".',
  },
  LOT_THOUGHT: {
    pillar: 'Vowel space',
    title: 'LOT /ɒ/ – THOUGHT /ɔː/ confusion',
    mechanics: 'LOT /ɒ/ is short, open and lightly rounded (lot, project, often). THOUGHT /ɔː/ is long, closer and strongly rounded (thought, board, water). Keep them distinct in length and lip-rounding.',
  },
  RHOTIC: {
    pillar: 'Non-rhoticity',
    title: 'Post-vocalic /r/ pronounced',
    mechanics: 'RP never pronounces /r/ after a vowel unless another vowel follows. "work" /wɜːk/, "first" /fɜːst/, "market" /ˈmɑːkɪt/: hold the vowel long and keep the tongue tip down — no curl.',
  },
  TAP_R: {
    pillar: 'Non-rhoticity',
    title: 'Tapped or trilled /r/',
    mechanics: 'RP /r/ is an approximant [ɹ]: the tongue tip approaches the back of the alveolar ridge without touching it, lips slightly rounded. No tap, no trill.',
  },
  MISSED_SCHWA: {
    pillar: 'Stress-timing',
    title: 'Weak form not reduced (missed schwa)',
    mechanics: 'Unstressed function words collapse to schwa: to /tə/, for /fə/, of /əv/, and /ən/, can /kən/. Say them quickly and lightly so the stressed content words carry the rhythm.',
  },
  MISSED_LINKING_R: {
    pillar: 'Non-rhoticity',
    title: 'Missing linking /r/',
    mechanics: 'When a word spelled with final r is followed by a vowel, RP links with /r/: "far away" /fɑːr əˈweɪ/, "for a" /fər ə/. It keeps connected speech smooth.',
  },
  VOWEL_LENGTH: {
    pillar: 'Vowel space',
    title: 'Long/short vowel swapped',
    mechanics: '/iː/ (sheep) is long and tense with spread lips; /ɪ/ (ship) is short, lax and a little lower. Likewise /uː/ (pool) vs /ʊ/ (pull). The length difference is phonemic.',
  },
  ELISION: {
    pillar: 'Connected speech',
    title: 'Sound elided',
    mechanics: 'Some elision is natural in fast RP (e.g. a weak schwa). Make sure the word is still recognisable.',
  },
  DELETION: {
    pillar: 'Articulation',
    title: 'Sound dropped',
    mechanics: 'A sound in the target was not produced. Slow down slightly and articulate every consonant in the cluster.',
  },
  INSERTION: {
    pillar: 'Articulation',
    title: 'Extra sound inserted',
    mechanics: 'An extra sound appeared — often an epenthetic vowel in a consonant cluster ("i-school"). Glide straight from consonant to consonant.',
  },
  SUBSTITUTION: {
    pillar: 'Articulation',
    title: 'Different phoneme produced',
    mechanics: 'A different phoneme was produced. Tap "Hear RP" to compare and copy the reference.',
  },
  DRIFT: {
    pillar: 'Articulation',
    title: 'Allophonic drift',
    mechanics: 'Close, but not quite the RP quality. Compare with the reference and adjust tongue height or lip-rounding.',
  },
};
