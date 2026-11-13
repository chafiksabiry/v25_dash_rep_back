const OpenAI = require('openai');
const cloudinary = require('cloudinary').v2;
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const os = require('os');
const VocabularyService = require('./VocabularyService');
const logger = require('../utils/logger');

// Garde-fou sur l'upload (mémoire). Whisper ne reçoit plus la vidéo mais l'audio
// extrait (mp3) — bien plus léger — donc la limite de 25 Mo de Whisper ne s'applique plus.
const MAX_VIDEO_BYTES = 1000 * 1024 * 1024;
// Limite réelle de l'API Whisper (fichier audio envoyé).
const WHISPER_MAX_BYTES = 50 * 1024 * 1024;
// Durée minimale pour une vidéo de vérification linguistique dédiée (onglet Langues).
const MIN_LANGUAGE_VIDEO_SECONDS = 30;
const MAX_LANGUAGE_VIDEO_SECONDS = 180; // 3 min
// Durée minimale exigée pour qu'une vidéo d'expérience soit analysable.
const MIN_DURATION_SECONDS = 30;

// Erreur typée pour permettre au contrôleur de renvoyer un 400 explicite
// (vidéo trop courte, fraude détectée, etc.) plutôt qu'un 500 générique.
class VideoValidationError extends Error {
  constructor(message, code, details = {}) {
    super(message);
    this.name = 'VideoValidationError';
    this.code = code;
    this.details = details;
  }
}

// Minimum number of REAL spoken words required before we detect/assess any
// language. Below this, the person essentially said nothing.
const MIN_MEANINGFUL_WORDS = 4;

// Whisper frequently hallucinates a short phrase on silent / near-silent audio
// (e.g. "Thank you for watching!", "Sous-titres réalisés par la communauté
// d'Amara.org"). These must NOT count as real speech, otherwise a language is
// detected and added to the profile when the person actually said nothing.
const WHISPER_HALLUCINATIONS = [
  'thank you', 'thank you for watching', 'thanks for watching',
  'thank you for watching this video', 'thank you so much for watching',
  'please subscribe', 'like and subscribe', 'subscribe to my channel',
  'see you next time', 'see you in the next video', 'see you',
  'bye', 'bye bye', 'goodbye', 'okay', 'ok', 'you', 'so', 'hmm', 'uh', 'um',
  'merci', "merci d'avoir regardé", "merci d'avoir regardé cette vidéo",
  'merci de votre attention', 'au revoir', 'sous-titres',
  "sous-titres réalisés par la communauté d'amara.org",
  'sous-titrage société radio-canada', 'amara.org', 'amara org',
];

// Normalize text for hallucination matching: lowercase, strip accents and
// punctuation, collapse whitespace, and pad with spaces for word-boundary safe
// substring removal.
const normalizeForSpeechCheck = (text) =>
  ` ${String(text || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()} `;

// Count the real, meaningful words in a transcript after removing known Whisper
// hallucination phrases. Returns 0 when the person essentially said nothing.
const meaningfulSpeechWordCount = (transcription) => {
  let t = normalizeForSpeechCheck(transcription);
  if (t.trim() === '') return 0;
  for (const phrase of WHISPER_HALLUCINATIONS) {
    const clean = normalizeForSpeechCheck(phrase);
    if (clean.trim() === '') continue;
    while (t.includes(clean)) t = t.replace(clean, ' ');
    t = ` ${t.replace(/\s+/g, ' ').trim()} `;
  }
  return t.trim().split(/\s+/).filter(Boolean).length;
};

const vocabNames = (items) =>
  (Array.isArray(items) ? items : []).map((item) => (typeof item === 'string' ? item : item?.name)).filter(Boolean);

const renderAllowedList = (label, items) => {
  const names = vocabNames(items);
  if (names.length === 0) {
    return `${label}: (no predefined list provided — return an empty array for this field)`;
  }
  return `${label} (choose ONLY from these exact names, copy them verbatim):\n${names.map((n) => `- ${n}`).join('\n')}`;
};

const buildLookup = (items) => {
  const byLower = new Map();
  if (!Array.isArray(items)) return byLower;

  items.forEach((item) => {
    if (!item?.id || !item?.name) return;
    byLower.set(String(item.name).toLowerCase(), { id: item.id, name: item.name });
  });

  return byLower;
};

const buildLanguageLookup = (items) => {
  const byLower = new Map();
  if (!Array.isArray(items)) return byLower;

  // Common FR/EN aliases so GPT labels still resolve to platform languages.
  const ALIASES = {
    anglais: 'english',
    english: 'english',
    francais: 'french',
    français: 'french',
    french: 'french',
    espanol: 'spanish',
    español: 'spanish',
    spanish: 'spanish',
    arabe: 'arabic',
    arabic: 'arabic',
    allemand: 'german',
    german: 'german',
    portugais: 'portuguese',
    portuguese: 'portuguese',
    italien: 'italian',
    italian: 'italian',
    neerlandais: 'dutch',
    néerlandais: 'dutch',
    dutch: 'dutch',
  };

  const addKey = (key, entry) => {
    if (!key) return;
    byLower.set(String(key).toLowerCase().normalize('NFD').replace(/\p{M}/gu, ''), entry);
  };

  items.forEach((item) => {
    if (!item?.id) return;
    const entry = { id: item.id, name: item.name };
    addKey(item.name, entry);
    addKey(item.code, entry);
    addKey(item.nativeName, entry);
    if (item.name_i18n && typeof item.name_i18n === 'object') {
      Object.values(item.name_i18n).forEach((label) => addKey(label, entry));
    }

    const canonical = ALIASES[String(item.name || '').toLowerCase().normalize('NFD').replace(/\p{M}/gu, '')]
      || ALIASES[String(item.code || '').toLowerCase()];
    if (canonical) {
      Object.entries(ALIASES).forEach(([alias, target]) => {
        if (target === canonical) addKey(alias, entry);
      });
    }
  });

  return byLower;
};

const buildAnalysisPrompt = (contextStr, transcription, vocab) => `You are an expert career analyst and skills assessor (not limited to HR recruiting). ${contextStr}

Analyze the following video transcript from a professional experience description and extract structured, scored data.

TRANSCRIPT:
"${transcription || '[No speech detected — infer conservatively from the provided context only]'}"

TONE & LANGUAGE — VERY IMPORTANT:
- Address the candidate DIRECTLY in the second person, as if you were talking to them (English "You ...", French polite "Vous ...").
- NEVER write in the third person about "the transcript", "the video", "the candidate", "the speaker", "the individual" or "the person". Speak TO them.
  * BAD: "The transcript does not provide relevant information about the role."
  * GOOD (en): "You didn't really describe your role at the company — try telling us what you did day to day, the tools you used and what you achieved."
  * GOOD (fr): "Vous n'avez pas vraiment décrit votre poste — essayez de nous expliquer ce que vous faisiez au quotidien, les outils utilisés et vos réalisations."
- When information is missing or off-topic, say it directly and helpfully to the person (what to do next), still in the second person.
- Every free-text field (evidence, notes, summary, reason) MUST be a bilingual object: { "en": "English text", "fr": "texte français" }.
- The French text must use the polite "vous" form. Keep both versions equivalent in meaning.

SUMMARY — TRANSCRIPT ONLY (VERY IMPORTANT):
- Base the summary STRICTLY on what the person SAID in THIS recording's transcript. Do not invent domains from the job title, company name, or profile notes alone.
- Cover EVERY distinct work domain actually mentioned in the transcript (e.g. purchasing, logistics/supply chain, communication, HR) — do not collapse to a single theme like HR if others were spoken.
- If the title/context lists domains that were NOT spoken about, you may briefly invite them to cover those next time — but NEVER claim they described those domains.
- Aim for 3–5 sentences: (1) scopes actually heard, (2) concrete actions/tools/results heard, (3) optional missing detail request.
- Stay inside the perimeter of THIS recording. No outside knowledge about the company or the person's career.

RELEVANCE / OFF-TOPIC CHECK — VERY IMPORTANT:
- The speaker is supposed to describe the SPECIFIC professional experience given in the context above.
- Judge from the TRANSCRIPT whether the speech is actually ABOUT that role/company and professional experience in general.
- If the transcript is clearly unrelated (random talk, testing the mic, a totally different topic, jokes, silence, advertising, reading something off-topic, etc.), set "relevance.onTopic" to false and give a low "relevance.score". Otherwise set it to true.
- IMPORTANT: This relevance flag is INFORMATIONAL only. ALWAYS extract every skill, industry and activity that is genuinely evidenced in the transcript, EVEN IF you judged the video off-topic. Do NOT return empty arrays just because relevance is low — only return empty when there is truly no matching evidence.

MATCHING PRIORITY — TRANSCRIPT ONLY:
- Industries and activities are CRITICAL for mission matching, but ONLY when evidenced in THIS transcript.
- Extract EVERY distinct industry/activity clearly supported by the speech — never pad from the job title alone.
- Skills are suggestions only — extract when evidenced in the speech, never invent.
- Do NOT add purchasing / supply-chain / communication / HR (or any other domain) unless the person actually talked about it in the recording.

STRICT VOCABULARY RULES — VERY IMPORTANT:
- For technicalSkills, professionalSkills, softSkills, industries and activities you MUST ONLY use names taken EXACTLY from the predefined lists below.
- Do NOT invent, rephrase, translate or merge names. Copy them character-for-character from the lists.
- Only include an item if the transcript provides real evidence the person has it. If nothing matches a list, return an empty array for that field.
- contactCenterSkills: score only what the speech supports; omit or score low when not evidenced.

SPOKEN LANGUAGES — THIS RECORDING ONLY (VERY IMPORTANT):
- spokenLanguages MUST list ONLY the language(s) the person actually SPOKE in THIS recording.
- detectedLanguageOfSpeech = the primary language of the transcript (e.g. "English" if the whole clip is in English, "Spanish" if Spanish).
- Identify the language from the LINGUISTIC CONTENT of the transcript (words, grammar), NOT from the speaker's accent.
- If the transcript is written in Latin script (a-z, accents) and is Spanish / English / French / Portuguese, NEVER classify it as Arabic.
- Whisper sometimes mislabels Spanish (or accented speech) as Arabic — if the text is clearly Spanish/English/French, correct that.
- Do NOT add French (or any other language) just because the UI, job title, company, or profile/CV is French.
- Do NOT add a language the person merely mentioned (e.g. "I work with French clients") unless they actually spoke that language in the clip.
- You MAY return a language that is NOT already on the candidate's CV — video detection can introduce a new spoken language.
- If the recording is monolingual Spanish, spokenLanguages must contain ONLY Spanish (not Arabic, not French).
- If the recording is monolingual English, spokenLanguages must contain ONLY English.

INDUSTRIES — FROM THE SPEECH ONLY (matching-critical):
- Map sectors ONLY when the transcript describes them (company domain / clients / market as spoken).
- Do NOT fill industries from the job title alone when the speech does not support them.
- When several sectors are spoken about, include ALL of them with distinct scores.

ACTIVITIES — FROM THE SPEECH ONLY (matching-critical):
- Map day-to-day tasks ONLY when described in the transcript.
- If purchasing AND supply-chain AND communication were spoken, map each; if only support/HR was spoken, do not invent the others.
- Empty activities is better than inventing work the person did not describe in THIS recording.

${renderAllowedList('TECHNICAL SKILLS', vocab.technicalSkills)}

${renderAllowedList('PROFESSIONAL SKILLS', vocab.professionalSkills)}

${renderAllowedList('SOFT SKILLS', vocab.softSkills)}

${renderAllowedList('INDUSTRIES', vocab.industries)}

${renderAllowedList('ACTIVITIES', vocab.activities)}

Return ONLY a valid JSON object with this exact structure (no markdown, no code blocks).
Every "evidence", "notes", "reason" and "summary" field MUST be a bilingual object { "en": "...", "fr": "..." }:
{
  "technicalSkills": [ { "name": "string (from TECHNICAL SKILLS list)", "score": 0-100, "evidence": { "en": "brief reason", "fr": "raison courte" } } ],
  "professionalSkills": [ { "name": "string (from PROFESSIONAL SKILLS list)", "score": 0-100, "evidence": { "en": "...", "fr": "..." } } ],
  "softSkills": [ { "name": "string (from SOFT SKILLS list)", "score": 0-100, "evidence": { "en": "...", "fr": "..." } } ],
  "spokenLanguages": [ { "language": "string (ONLY languages actually spoken in THIS recording)", "level": "A1|A2|B1|B2|C1|C2|Native", "score": 0-100, "evidence": { "en": "...", "fr": "..." } } ],
  "industries": [ { "name": "string (from INDUSTRIES list)", "score": 0-100 } ],
  "activities": [ { "name": "string (from ACTIVITIES list)", "score": 0-100 } ],
  "contactCenterSkills": {
    "customerService": { "score": 0-100, "notes": { "en": "...", "fr": "..." } },
    "communication": { "score": 0-100, "notes": { "en": "...", "fr": "..." } },
    "problemSolving": { "score": 0-100, "notes": { "en": "...", "fr": "..." } },
    "empathy": { "score": 0-100, "notes": { "en": "...", "fr": "..." } },
    "multitasking": { "score": 0-100, "notes": { "en": "...", "fr": "..." } },
    "salesOrientation": { "score": 0-100, "notes": { "en": "...", "fr": "..." } },
    "conflictResolution": { "score": 0-100, "notes": { "en": "...", "fr": "..." } },
    "productKnowledge": { "score": 0-100, "notes": { "en": "...", "fr": "..." } }
  },
  "overallConfidence": 0-100,
  "detectedLanguageOfSpeech": "string (primary language of THIS transcript)",
  "relevance": { "onTopic": true, "score": 0-100, "reason": { "en": "speak to the person: e.g. 'You spoke about ...' or 'You didn't talk about your role ...'", "fr": "parlez à la personne : ex. « Vous avez parlé de ... » ou « Vous n'avez pas décrit votre poste ... »" } },
  "summary": { "en": "3-5 sentences based ONLY on what was said in THIS recording", "fr": "3-5 phrases basées UNIQUEMENT sur ce qui a été dit dans CET enregistrement" }
}

Scoring rules:
- Score 0 = not detected / not applicable (omit such items rather than listing them at 0)
- Score 100 = expert-level, strongly evidenced
- Clear mention with detail → 70+
- Vague mention → 30-60
- relevance.score: 80-100 = clearly about the stated experience; 40-70 = loosely related; 0-30 = off-topic/unrelated.
- Return pure JSON only, nothing else`;

// Dedicated, fine-grained spoken-language assessment built from the transcript
// and the language Whisper detected. Produces CEFR + sub-scores per language.
const buildLanguageAssessmentPrompt = (transcription, detectedLanguage, allowedLanguages) => `You are a certified CEFR language examiner assessing candidates for professional contact-center / sales work.

Assess ONLY the language(s) the speaker actually used in THIS recording — not languages from their profile, passport, or job title.

DETECTED LANGUAGE OF SPEECH: ${detectedLanguage || 'unknown'}

TRANSCRIPT:
"${transcription || '[No speech detected]'}"

${renderAllowedList('KNOWN PLATFORM LANGUAGES (use these exact names when the spoken language matches one)', allowedLanguages)}

LANGUAGE SCOPE — CRITICAL:
- Assess ONLY languages that are actually spoken in the transcript of THIS recording.
- If DETECTED LANGUAGE OF SPEECH is Spanish and the transcript is Spanish, return exactly ONE language entry: Spanish.
- If DETECTED LANGUAGE OF SPEECH is English and the transcript is English, return exactly ONE language entry: English.
- Do NOT add French because the product UI / job title / company name / CV is French.
- Do NOT classify Latin-script Spanish (or English/French) as Arabic — that is a known mislabel.
- Do NOT add a language merely mentioned ("I speak French", "French clients") unless a substantial part of THIS recording is spoken in that language.
- A language MAY be assessed even if it is not already on the candidate's CV — video detection can introduce it.
- If the clip is monolingual, languages array length MUST be 1.

ASSESSMENT RULES (FAIR & PROFESSIONAL — NOT OVERLY HARSH):
- Judge from real linguistic evidence (grammar, vocabulary range, sentence complexity, coherence, connectors, register).
- Be encouraging and realistic for short professional intros. A clear, coherent professional sample with few errors SHOULD score well even if brief.
- Pronunciation cannot be measured perfectly from text — estimate it from word choice/coherence and mark confidence honestly.
- If the transcript is empty or too short to judge, return an empty "languages" array and set "assessable" to false.
- Map scores to CEFR: A1 (very basic) → C2 (mastery / native-like).
- NEVER default to 100. Reserve 95–100 for exceptionally rich, near-flawless samples.
- Evidence caps (soft — quality can still score high on shorter clips):
  * Very little speech (< 1 full sentence): prefer ~50–65, confidence "low".
  * One or two short sentences that are clear and correct: ~65–80 is fine.
  * A short paragraph (3–5 clear professional sentences): ~75–90 is expected when quality is good.
  * A rich, multi-paragraph, well-structured sample: 85–98 is appropriate.
- Do NOT punish a candidate for being concise if the speech is clear, professional and accurate.
- Each sub-score (fluency, grammar, vocabulary, coherence, pronunciationEstimate) MUST include concrete justified feedback that cites WHAT was observed (example wording, structure, hesitation, register). Vague praise like "good grammar" is not enough — say why.
- overallScore must be roughly the average of the sub-scores, not the maximum.

ACCENT / REGIONAL VARIETY — REQUIRED FOR EVERY LANGUAGE:
- Detect the speaker's accent or regional variety of the language they are speaking.
- This applies to ALL languages (French, English, Spanish, Arabic, German, Portuguese, etc.).
- Use category:
  * "neutral" — standard / broadcast-like / widely understood variety
  * "mild_regional" — recognizable regional colour, still easy to understand
  * "strong_regional" — strongly marked regional accent/variety
  * "non_native" — clear L2 accent of a non-native speaker
- "variety" must be a bilingual short label naming the variety, e.g.:
  French: "Neutral / standard French" / "Français neutre / standard", "Northern France", "Quebec French", "Belgian French", "Swiss French", "Maghrebi French"
  English: "General American", "British (RP)", "Northern England", "Australian", "Indian English"
  Spanish: "Castilian", "Mexican Spanish", "Rioplatense", "Colombian Spanish"
  Always adapt labels to the language actually spoken. If unsure, use Neutral/standard with confidence "low".
- confidence: low|medium|high (transcript-only cues → usually low/medium unless lexical markers are clear).
- confidenceReason (REQUIRED bilingual): explain WHY that confidence level was chosen.
  Examples:
  * low → limited sample / only transcript cues / conflicting signals
  * medium → short clip or partially converging cues; variety is plausible but not certain
  * high → clear, consistent markers across the sample
- accent.feedback must describe the accent impact for the listener; confidenceReason must specifically justify the confidence badge.

TONE & LANGUAGE — VERY IMPORTANT:
- Address the candidate DIRECTLY in the second person (English "You ...", French polite "Vous ...").
- Every text field ("feedback", "strengths", "areasForImprovement", accent.variety, accent.feedback, accent.confidenceReason, pronunciationEstimate.confidenceReason) MUST be a bilingual object { "en": "English", "fr": "français (vouvoiement)" } with equivalent meaning.

Return ONLY valid JSON (no markdown):
{
  "assessable": true,
  "languages": [
    {
      "language": "string (platform name if it matches the list, else the plain language name)",
      "cefr": "A1|A2|B1|B2|C1|C2",
      "overallScore": 0-100,
      "fluency": { "score": 0-100, "feedback": { "en": "...", "fr": "..." } },
      "grammar": { "score": 0-100, "feedback": { "en": "...", "fr": "..." } },
      "vocabulary": { "score": 0-100, "feedback": { "en": "...", "fr": "..." } },
      "coherence": { "score": 0-100, "feedback": { "en": "...", "fr": "..." } },
      "pronunciationEstimate": { "score": 0-100, "confidence": "low|medium|high", "feedback": { "en": "...", "fr": "..." }, "confidenceReason": { "en": "...", "fr": "..." } },
      "accent": {
        "category": "neutral|mild_regional|strong_regional|non_native",
        "variety": { "en": "...", "fr": "..." },
        "confidence": "low|medium|high",
        "feedback": { "en": "...", "fr": "..." },
        "confidenceReason": { "en": "why this confidence level", "fr": "pourquoi ce niveau de confiance" }
      },
      "strengths": { "en": "...", "fr": "..." },
      "areasForImprovement": { "en": "...", "fr": "..." }
    }
  ]
}`;

// Targeted assessment: verify the speaker used ONE expected language at a claimed level.
const buildTargetLanguageVideoPrompt = (
  transcription,
  targetLanguageName,
  targetLanguageCode,
  expectedProficiency,
  allowedLanguages
) => `You are a certified CEFR language examiner verifying a candidate's proficiency in ONE specific language for professional contact-center / sales work.

TARGET LANGUAGE TO VERIFY: ${targetLanguageName}${targetLanguageCode ? ` (${targetLanguageCode})` : ''}
CLAIMED CEFR LEVEL ON PROFILE: ${expectedProficiency || 'unknown'}

TRANSCRIPT (from a short self-introduction video):
"${transcription || '[No speech detected]'}"

${renderAllowedList('KNOWN PLATFORM LANGUAGES (use these exact names when the spoken language matches one)', allowedLanguages)}

TASKS — VERY IMPORTANT:
1. LANGUAGE MATCH: Determine whether the speech is PRIMARILY in "${targetLanguageName}".
   - If the candidate spoke mostly in another language, set "languageMatch.matches" to false.
   - If they mixed languages heavily or switched away from the target language, set matches to false.
   - Only set matches to true when the transcript is clearly dominated by ${targetLanguageName}.
2. CEFR ASSESSMENT: Judge ONLY the target language (${targetLanguageName}) from linguistic evidence in the transcript.
3. CLAIM CHECK: Set "meetsClaimedLevel" to true when the assessed CEFR is at or above the claimed level (${expectedProficiency}), OR exactly one band below on a short sample (leniency). Otherwise false.
4. ACCENT: Detect accent / regional variety for ${targetLanguageName} (works the same for every language).

SCORING RULES (FAIR — NOT OVERLY HARSH):
- NEVER default to 100. Reserve 95–100 for exceptionally rich samples.
- Clear, coherent professional speech with few errors should score well even on a short intro (~75–90).
- Very little speech (< 1 sentence): prefer ~50–65, confidence "low".
- overallScore ≈ average of sub-scores.
- Do not punish brevity when quality is high.
- Every sub-score feedback MUST justify the score with concrete observations from the speech (not generic praise).

ACCENT / REGIONAL VARIETY:
- category: neutral | mild_regional | strong_regional | non_native
- variety: bilingual short label adapted to the language (e.g. Neutral/standard, Northern France, Quebec, General American, Castilian, Mexican Spanish…)
- confidence: low|medium|high
- confidenceReason (REQUIRED bilingual): explain why that confidence was chosen (short sample, mixed cues, clear markers, etc.)
- feedback: impact of the accent for the listener; confidenceReason: justification of the confidence badge

TONE: Address the candidate directly (English "You ...", French polite "Vous ...").
All text fields MUST be bilingual { "en": "...", "fr": "..." }.

Return ONLY valid JSON (no markdown):
{
  "languageMatch": {
    "matches": true,
    "detectedLanguage": "string",
    "reason": { "en": "...", "fr": "..." }
  },
  "assessable": true,
  "cefr": "A1|A2|B1|B2|C1|C2",
  "overallScore": 0-100,
  "fluency": { "score": 0-100, "feedback": { "en": "...", "fr": "..." } },
  "grammar": { "score": 0-100, "feedback": { "en": "...", "fr": "..." } },
  "vocabulary": { "score": 0-100, "feedback": { "en": "...", "fr": "..." } },
  "coherence": { "score": 0-100, "feedback": { "en": "...", "fr": "..." } },
  "pronunciationEstimate": { "score": 0-100, "confidence": "low|medium|high", "feedback": { "en": "...", "fr": "..." }, "confidenceReason": { "en": "...", "fr": "..." } },
  "accent": {
    "category": "neutral|mild_regional|strong_regional|non_native",
    "variety": { "en": "...", "fr": "..." },
    "confidence": "low|medium|high",
    "feedback": { "en": "...", "fr": "..." },
    "confidenceReason": { "en": "why this confidence level", "fr": "pourquoi ce niveau de confiance" }
  },
  "meetsClaimedLevel": true,
  "summary": { "en": "2-3 sentences to the person", "fr": "2-3 phrases avec vouvoiement" }
}`;

// Anti-fraud facial check run over several still frames extracted from the video.
const FRAUD_SYSTEM_PROMPT =
  'You are a fraud-detection vision system for an identity-sensitive hiring platform. You receive several still frames sampled from one short self-introduction video. Return only valid JSON.';

const buildFraudPrompt = (hasReference = false) => `Analyze the provided images.
${
  hasReference
    ? 'The FIRST image is the candidate\'s official PROFILE PHOTO (identity reference). The REMAINING images are frames sampled from a SINGLE self-introduction video.'
    : 'The images are frames sampled from a SINGLE self-introduction video.'
}

Check for signs of fraud or non-genuine recordings:
- Is there exactly ONE real, live human face visible in the video frames (not zero, not several different people)?
- Does it look like a live person filmed by a webcam, NOT a photo, a screen/monitor re-filming, a printed picture, a deepfake, or an AI-generated avatar?
- Is it plausibly the SAME person across all video frames?
- Any obvious manipulation, overlays, or spoofing artifacts?
${
  hasReference
    ? `- IDENTITY MATCH: Is the person in the video frames the SAME person as in the profile photo? Compare facial features (face shape, eyes, nose, mouth, overall appearance). Ignore lighting, camera angle, hairstyle, beard length, glasses (including sunglasses pushed up on the head), and clothing. Set "identityMatch" to true when it is the same person. Set "identityMatch" to false ONLY when you are sure it is a different person, and then set "identityConfidence" to at least 70. If the face is unclear, partial, or you are not sure, set "identityMatch" to null and "identityConfidence" below 50.`
    : '- No reference photo was provided, so set "identityMatch" to null and "identityConfidence" to 0.'
}

Address the candidate directly in the second person, and provide each reason bilingually (English + French polite "vous").

Return ONLY valid JSON (no markdown):
{
  "faceDetected": true,
  "faceCount": 0,
  "samePersonAcrossFrames": true,
  "looksLive": true,
  "livenessConfidence": 0-100,
  "identityMatch": true,
  "identityConfidence": 0-100,
  "fraudRisk": "low|medium|high",
  "reasons": [ { "en": "short reason", "fr": "raison courte" } ]
}`;

class VideoAnalysisService {
  constructor() {
    this._initialized = false;
    this.vocabularyService = new VocabularyService();
  }

  _ensureInitialized() {
    if (this._initialized) return;

    const openaiKey = process.env.OPENAI_API_KEY;
    if (!openaiKey) {
      throw new Error('OPENAI_API_KEY environment variable is not set');
    }

    this.openai = new OpenAI({ apiKey: openaiKey });

    this.cloudinaryEnabled = Boolean(
      process.env.CLOUDINARY_CLOUD_NAME &&
        process.env.CLOUDINARY_API_KEY &&
        process.env.CLOUDINARY_API_SECRET
    );
    if (this.cloudinaryEnabled) {
      cloudinary.config({
        cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
        api_key: process.env.CLOUDINARY_API_KEY,
        api_secret: process.env.CLOUDINARY_API_SECRET,
      });
    }

    this._initialized = true;
  }

  uploadToCloudinary(tmpPath) {
    if (!this.cloudinaryEnabled) {
      return Promise.reject(new Error('Cloudinary is not configured'));
    }

    return new Promise((resolve, reject) => {
      cloudinary.uploader.upload(
        tmpPath,
        {
          resource_type: 'video',
          folder: 'experience-videos',
          public_id: `exp-${Date.now()}`,
        },
        (error, result) => {
          if (error) {
            return reject(new Error(`Cloudinary upload failed: ${error.message}`));
          }
          if (!result?.secure_url) {
            return reject(new Error('Cloudinary upload returned no URL'));
          }
          resolve({
            url: result.secure_url,
            publicId: result.public_id,
            duration: typeof result.duration === 'number' ? result.duration : null,
            width: result.width || null,
            height: result.height || null,
          });
        }
      );
    });
  }

  /**
   * Cloudinary public id from a stored experience video URL.
   * `.../video/upload/v123/experience-videos/exp-1.webm` → `experience-videos/exp-1`.
   */
  cloudinaryVideoPublicId(url) {
    if (!url || typeof url !== 'string' || !url.includes('/video/upload/')) return null;
    const after = url.split('/video/upload/')[1];
    if (!after) return null;
    const segments = after.split('?')[0].split('/').filter(Boolean);
    const versionAt = segments.findIndex((segment) => /^v\d+$/.test(segment));
    const idSegments = (versionAt >= 0 ? segments.slice(versionAt + 1) : segments).filter(
      (segment) => segment && !segment.includes(',')
    );
    if (!idSegments.length) return null;
    const last = idSegments[idSegments.length - 1];
    const dot = last.lastIndexOf('.');
    if (dot > 0) idSegments[idSegments.length - 1] = last.slice(0, dot);
    const publicId = idSegments.join('/');
    return publicId || null;
  }

  /** URL Cloudinary d'une image (frame) extraite de la vidéo à un offset donné. */
  buildFrameUrl(publicId, offsetSeconds) {
    return cloudinary.url(publicId, {
      resource_type: 'video',
      format: 'jpg',
      start_offset: String(Math.max(0, Math.floor(offsetSeconds))),
      width: 768,
      height: 768,
      crop: 'fill',
      gravity: 'face',
      quality: 'auto:good',
    });
  }

  /**
   * URL Cloudinary de l'audio (mp3 mono 64kbps) extrait de la vidéo.
   * Bien plus léger que la vidéo → respecte la limite de 25 Mo de Whisper.
   */
  buildAudioUrl(publicId) {
    return cloudinary.url(publicId, {
      resource_type: 'video',
      format: 'mp3',
      audio_frequency: 16000,
      audio_codec: 'mp3',
      bit_rate: '64k',
    });
  }

  /** Télécharge une URL vers un fichier temporaire et retourne son chemin. */
  async downloadToTemp(url, ext) {
    const tmpPath = path.join(os.tmpdir(), `exp-audio-${Date.now()}.${ext}`);
    const response = await axios.get(url, { responseType: 'arraybuffer', timeout: 60000 });
    fs.writeFileSync(tmpPath, Buffer.from(response.data));
    return tmpPath;
  }

  async transcribeAudio(filePath, languageHint) {
    const params = {
      file: fs.createReadStream(filePath),
      model: 'whisper-1',
      // verbose_json returns both text and Whisper's detected language code/name.
      response_format: 'verbose_json',
    };
    if (languageHint && typeof languageHint === 'string' && languageHint.length === 2) {
      params.language = languageHint.toLowerCase();
    }
    const response = await this.openai.audio.transcriptions.create(params);
    if (typeof response === 'string') {
      return { text: response.trim(), language: null };
    }
    const text = String(response?.text || '').trim();
    const language = response?.language ? String(response.language).trim() : null;
    return { text, language };
  }

  transcriptScriptStats(transcription) {
    const text = String(transcription || '');
    const arabic = (text.match(/[\u0600-\u06FF]/g) || []).length;
    const latin = (text.match(/[A-Za-zÀ-ÿ]/g) || []).length;
    return { arabic, latin, total: arabic + latin };
  }

  mapWhisperLanguageToName(raw) {
    if (!raw) return null;
    const key = String(raw).toLowerCase().trim();
    const map = {
      en: 'English',
      english: 'English',
      fr: 'French',
      french: 'French',
      es: 'Spanish',
      spanish: 'Spanish',
      spa: 'Spanish',
      ar: 'Arabic',
      arabic: 'Arabic',
      de: 'German',
      german: 'German',
      pt: 'Portuguese',
      portuguese: 'Portuguese',
      it: 'Italian',
      italian: 'Italian',
      nl: 'Dutch',
      dutch: 'Dutch',
    };
    return map[key] || (key.length > 1 ? key.charAt(0).toUpperCase() + key.slice(1) : null);
  }

  inferLatinLanguageName(transcription) {
    const t = String(transcription || '').toLowerCase();
    const count = (re) => (t.match(re) || []).length;
    const spanish = count(
      /\b(el|la|los|las|que|de|en|una|uno|por|para|con|es|está|están|hola|gracias|años|trabajo|experiencia|también|muy|como|pero)\b/g
    );
    const french = count(
      /\b(le|la|les|des|une|est|vous|je|nous|avec|pour|dans|être|merci|expérience|travail|aussi|très|mais)\b/g
    );
    const english = count(
      /\b(the|and|you|was|were|with|that|this|have|from|work|experience|also|very|but|for|your)\b/g
    );
    const portuguese = count(
      /\b(o|a|os|as|que|de|em|uma|por|para|com|é|está|olá|obrigado|anos|trabalho|experiência)\b/g
    );
    const scores = [
      { name: 'Spanish', n: spanish },
      { name: 'French', n: french },
      { name: 'English', n: english },
      { name: 'Portuguese', n: portuguese },
    ].sort((a, b) => b.n - a.n);
    if (!scores[0] || scores[0].n < 2) return null;
    return scores[0].name;
  }

  /**
   * Correct common Whisper/GPT mislabels (e.g. Spanish speech → Arabic) using
   * transcript script + Whisper language + lexical heuristics.
   */
  reconcileDetectedSpeechLanguage(transcription, gptDetected, whisperLanguage) {
    const { arabic, latin, total } = this.transcriptScriptStats(transcription);
    const whisperName = this.mapWhisperLanguageToName(whisperLanguage);
    const gptName = String(gptDetected || '').trim();
    const gptKey = this.languageMatchKey(gptName);
    const whisperKey = this.languageMatchKey(whisperName || '');

    const mostlyLatin = total > 0 && latin / total >= 0.7 && arabic / total <= 0.15;
    const mostlyArabic = total > 0 && arabic / total >= 0.5;

    if (mostlyArabic) {
      return whisperName && whisperKey.includes('arab')
        ? whisperName
        : gptKey.includes('arab')
        ? gptName || 'Arabic'
        : 'Arabic';
    }

    if (mostlyLatin) {
      // Never keep Arabic when the transcript is clearly Latin-script speech.
      if (gptKey.includes('arab') || whisperKey.includes('arab')) {
        if (whisperName && !whisperKey.includes('arab')) return whisperName;
        return this.inferLatinLanguageName(transcription) || 'Spanish';
      }
      if (whisperName && !whisperKey.includes('arab')) {
        // Prefer Whisper when it agrees with a Latin language family.
        return whisperName;
      }
      if (gptName && !gptKey.includes('arab')) return gptName;
      return this.inferLatinLanguageName(transcription) || gptName || whisperName || '';
    }

    return gptName || whisperName || '';
  }

  // Resolves AI names to populated refs { _id, name } so the UI can render labels
  // the same way as other populated profile fields (e.g. personalInfo.languages).
  resolveNamedRefs(items, vocabItems, idField) {
    if (!Array.isArray(items)) return [];
    const lookup = buildLookup(vocabItems);
    if (lookup.size === 0) return [];

    return items
      .filter((item) => item?.name && lookup.has(String(item.name).toLowerCase()))
      .map((item) => {
        const entry = lookup.get(String(item.name).toLowerCase());
        return {
          [idField]: { _id: entry.id, name: entry.name },
          score: item.score,
          ...(item.evidence !== undefined ? { evidence: item.evidence } : {}),
        };
      });
  }

  resolveLanguageRefs(items, vocabItems) {
    if (!Array.isArray(items)) return [];
    const lookup = buildLanguageLookup(vocabItems);

    const normalizeKey = (value) =>
      String(value || '')
        .toLowerCase()
        .normalize('NFD')
        .replace(/\p{M}/gu, '');

    return items
      .filter((item) => item?.language || item?.languageName)
      .map((item) => {
        const rawName = item.language || item.languageName;
        const entry = lookup.size ? lookup.get(normalizeKey(rawName)) : null;
        if (entry) {
          return {
            language: { _id: entry.id, name: entry.name },
            level: item.level,
            score: item.score,
            ...(item.evidence !== undefined ? { evidence: item.evidence } : {}),
          };
        }
        // Keep unresolved spoken languages (e.g. Spanish detected in video but not
        // yet on the CV) so the UI can still show them and VideoInsights can add them.
        return {
          languageName: String(rawName),
          level: item.level,
          score: item.score,
          ...(item.evidence !== undefined ? { evidence: item.evidence } : {}),
        };
      })
      // Drop bogus Arabic when we already corrected detection upstream may still send
      // empty names.
      .filter((item) => item.language?.name || item.languageName);
  }

  async analyzeTranscript(transcription, experienceContext, vocab) {
    const title = String(experienceContext?.title || '').trim();
    const company = String(experienceContext?.company || '').trim();
    const responsibilities = Array.isArray(experienceContext?.responsibilities)
      ? experienceContext.responsibilities.map((r) => String(r || '').trim()).filter(Boolean)
      : String(experienceContext?.responsibilities || '')
          .split(/\n|;|•/)
          .map((r) => r.trim())
          .filter(Boolean);
    const description = String(experienceContext?.description || '').trim();

    let contextStr = title
      ? `The person is describing their experience as "${title}" at "${company || 'a company'}".`
      : 'The person is describing their professional experience.';

    if (responsibilities.length) {
      contextStr += ` Optional profile notes (HINTS ONLY — do NOT extract skills/industries/activities/languages from these unless the transcript also evidences them): ${responsibilities
        .slice(0, 12)
        .map((r) => `"${r}"`)
        .join('; ')}.`;
    }
    if (description) {
      contextStr += ` Optional role notes (HINTS ONLY): "${description.slice(0, 500)}".`;
    }
    contextStr +=
      ' HARD RULE: analyze ONLY what is said in THIS recording transcript. Do not invent domains, languages, or achievements from the title/company/notes. If purchasing, supply chain or communication were not spoken, do not claim them.';

    const response = await this.openai.chat.completions.create({
      model: 'gpt-4o',
      messages: [
        {
          role: 'system',
          content:
            'You are a JSON-only API. Return only valid JSON, no markdown code blocks, no explanations. You strictly respect the provided allowed vocabulary lists. Analyze ONLY this recording transcript — never invent domains, languages, or achievements from the job title, company, UI language, or profile notes.',
        },
        {
          role: 'user',
          content: buildAnalysisPrompt(contextStr, transcription, vocab),
        },
      ],
      temperature: 0.2,
      response_format: { type: 'json_object' },
    });

    return JSON.parse(response.choices[0].message.content);
  }

  /**
   * Dedicated, detailed CEFR assessment of every spoken language detected in the
   * transcript. Resolves language names to platform ObjectId refs when possible.
   */
  async assessLanguages(transcription, detectedLanguage, vocabLanguages) {
    // No real speech (silence + Whisper hallucination) → assess nothing.
    if (meaningfulSpeechWordCount(transcription) < MIN_MEANINGFUL_WORDS) {
      return { assessable: false, languages: [] };
    }

    let parsed;
    try {
      const response = await this.openai.chat.completions.create({
        model: 'gpt-4o',
        messages: [
          {
            role: 'system',
            content: 'You are a certified CEFR language examiner. Return only valid JSON, no markdown.',
          },
          {
            role: 'user',
            content: buildLanguageAssessmentPrompt(transcription, detectedLanguage, vocabLanguages),
          },
        ],
        temperature: 0.2,
        response_format: { type: 'json_object' },
      });
      parsed = JSON.parse(response.choices[0].message.content);
    } catch (err) {
      console.error('Language assessment failed:', err.message);
      return { assessable: false, languages: [] };
    }

    // Soft evidence caps: short but clear professional clips can still score high.
    const wordCount = transcription.trim().split(/\s+/).filter(Boolean).length;
    const scoreCap = this.evidenceScoreCap(wordCount);
    const clamp = (v) => Math.max(0, Math.min(scoreCap, this.softenScore(v)));
    const emptyText = { en: '', fr: '' };
    const clampSub = (sub) =>
      sub && typeof sub === 'object'
        ? { ...sub, score: clamp(sub.score) }
        : { score: 0, feedback: { ...emptyText } };

    const lookup = buildLanguageLookup(vocabLanguages);
    const normalizeKey = (value) =>
      String(value || '')
        .toLowerCase()
        .normalize('NFD')
        .replace(/\p{M}/gu, '');
    const languages = (parsed.languages || []).map((entry) => {
      const ref = entry?.language ? lookup.get(normalizeKey(entry.language)) : null;
      const overallScore = clamp(entry.overallScore);
      return {
        ...(ref ? { language: { _id: ref.id, name: ref.name } } : { languageName: entry.language }),
        cefr: this.scoreToCefr(overallScore, entry.cefr),
        overallScore,
        fluency: clampSub(entry.fluency),
        grammar: clampSub(entry.grammar),
        vocabulary: clampSub(entry.vocabulary),
        coherence: clampSub(entry.coherence),
        pronunciationEstimate: this.normalizePronunciationEstimate(
          entry.pronunciationEstimate,
          emptyText,
          clamp
        ),
        accent: this.normalizeAccent(entry.accent, emptyText, 'transcript'),
        strengths: entry.strengths || { ...emptyText },
        areasForImprovement: entry.areasForImprovement || { ...emptyText },
        evidenceWords: wordCount,
      };
    });

    return { assessable: parsed.assessable !== false, languages };
  }

  /**
   * Assess whether the transcript matches ONE target language and the claimed CEFR level.
   */
  async assessTargetLanguage(transcription, targetLanguageName, targetLanguageCode, expectedProficiency, vocabLanguages) {
    if (meaningfulSpeechWordCount(transcription) < MIN_MEANINGFUL_WORDS) {
      return {
        assessable: false,
        languageMatch: {
          matches: false,
          detectedLanguage: '',
          reason: {
            en: 'You did not speak enough for us to verify this language. Please record again and speak clearly for at least 1 minute 30.',
            fr: 'Vous n’avez pas assez parlé pour que nous puissions vérifier cette langue. Réenregistrez et parlez clairement pendant au moins 1 min 30.',
          },
        },
        meetsClaimedLevel: false,
        cefr: null,
        overallScore: 0,
      };
    }

    let parsed;
    try {
      const response = await this.openai.chat.completions.create({
        model: 'gpt-4o',
        messages: [
          {
            role: 'system',
            content: 'You are a certified CEFR language examiner. Return only valid JSON, no markdown.',
          },
          {
            role: 'user',
            content: buildTargetLanguageVideoPrompt(
              transcription,
              targetLanguageName,
              targetLanguageCode,
              expectedProficiency,
              vocabLanguages
            ),
          },
        ],
        temperature: 0.2,
        response_format: { type: 'json_object' },
      });
      parsed = JSON.parse(response.choices[0].message.content);
    } catch (err) {
      console.error('Target language assessment failed:', err.message);
      return {
        assessable: false,
        languageMatch: {
          matches: false,
          detectedLanguage: '',
          reason: {
            en: 'The language assessment could not be completed. Please try again.',
            fr: 'L’évaluation linguistique n’a pas pu être effectuée. Veuillez réessayer.',
          },
        },
        meetsClaimedLevel: false,
        cefr: null,
        overallScore: 0,
      };
    }

    const wordCount = transcription.trim().split(/\s+/).filter(Boolean).length;
    const scoreCap = this.evidenceScoreCap(wordCount);
    const clamp = (v) => Math.max(0, Math.min(scoreCap, this.softenScore(v)));
    const emptyText = { en: '', fr: '' };
    const clampSub = (sub) =>
      sub && typeof sub === 'object'
        ? { ...sub, score: clamp(sub.score) }
        : { score: 0, feedback: { ...emptyText } };

    const overallScore = clamp(parsed.overallScore);
    const languageMatch = parsed.languageMatch || {
      matches: false,
      detectedLanguage: '',
      reason: { ...emptyText },
    };

    return {
      assessable: parsed.assessable !== false && languageMatch.matches !== false,
      languageMatch: {
        matches: languageMatch.matches === true,
        detectedLanguage: languageMatch.detectedLanguage || '',
        reason: languageMatch.reason || { ...emptyText },
      },
      cefr: this.scoreToCefr(overallScore, parsed.cefr),
      overallScore,
      fluency: clampSub(parsed.fluency),
      grammar: clampSub(parsed.grammar),
      vocabulary: clampSub(parsed.vocabulary),
      coherence: clampSub(parsed.coherence),
      pronunciationEstimate: this.normalizePronunciationEstimate(
        parsed.pronunciationEstimate,
        emptyText,
        clamp
      ),
      accent: this.normalizeAccent(parsed.accent, emptyText, 'transcript'),
      meetsClaimedLevel: parsed.meetsClaimedLevel === true,
      summary: parsed.summary || { ...emptyText },
      evidenceWords: wordCount,
    };
  }

  /**
   * Dedicated language-tab video: verify the rep spoke in the selected language at the claimed level.
   * Does NOT run experience/skills/industry extraction (unlike analyzeExperienceVideo).
   */
  async analyzeLanguageVideo(videoBuffer, mimetype, languageContext = {}) {
    this._ensureInitialized();
    const langLabel = languageContext.languageName || 'unknown';
    const startedAt = Date.now();
    const step = (label) =>
      logger.info(`[lang-video:${langLabel}] ${label} (+${Date.now() - startedAt}ms)`);

    step(`start (${Math.round(videoBuffer.length / 1024)}KB, ${mimetype})`);

    if (videoBuffer.length > MAX_VIDEO_BYTES) {
      throw new Error(
        `Video is too large for analysis (${Math.round(videoBuffer.length / 1024 / 1024)}MB). Maximum is ${Math.round(MAX_VIDEO_BYTES / 1024 / 1024)}MB.`
      );
    }

    const {
      languageName = '',
      languageCode = '',
      expectedProficiency = '',
      referencePhotoUrl = null,
    } = languageContext;

    let safeVocab;
    try {
      safeVocab = await this.vocabularyService.getVocabulary();
    } catch (err) {
      console.error('Failed to load vocabulary from DB:', err.message);
      safeVocab = { languages: [] };
    }

    const ext = mimetype.includes('mp4') ? 'mp4' : 'webm';
    const tmpPath = path.join(os.tmpdir(), `lang-video-${Date.now()}.${ext}`);
    let audioTmpPath = null;

    try {
      fs.writeFileSync(tmpPath, videoBuffer);
      step('temp file written, uploading to Cloudinary');

      const upload = await this.uploadToCloudinary(tmpPath);
      step(`Cloudinary done (duration=${upload.duration ?? '?'}s)`);

      if (typeof upload.duration === 'number' && upload.duration < MIN_LANGUAGE_VIDEO_SECONDS) {
        throw new VideoValidationError(
          `Video is too short (${Math.round(upload.duration)}s). Duration must be between 30 s and 3 min.`,
          'VIDEO_TOO_SHORT',
          { duration: upload.duration, minDuration: MIN_LANGUAGE_VIDEO_SECONDS, maxDuration: MAX_LANGUAGE_VIDEO_SECONDS }
        );
      }

      if (typeof upload.duration === 'number' && upload.duration > MAX_LANGUAGE_VIDEO_SECONDS) {
        throw new VideoValidationError(
          `Video is too long (${Math.round(upload.duration)}s). Duration must be between 30 s and 3 min.`,
          'VIDEO_TOO_LONG',
          { duration: upload.duration, minDuration: MIN_LANGUAGE_VIDEO_SECONDS, maxDuration: MAX_LANGUAGE_VIDEO_SECONDS }
        );
      }

      const audioUrl = this.buildAudioUrl(upload.publicId);
      step('extracting audio mp3 from Cloudinary');
      audioTmpPath = await this.downloadToTemp(audioUrl, 'mp3');
      step('audio ready, Whisper transcription');

      const whisperHint = languageCode && languageCode.length === 2 ? languageCode : undefined;
      const { text: transcription, language: whisperLanguage } = await this.transcribeAudio(
        audioTmpPath,
        whisperHint
      );
      step(`Whisper done (${transcription?.length ?? 0} chars, lang=${whisperLanguage || 'auto'})`);

      step('GPT language assessment + fraud check');
      const [rawAssessment, fraudCheck] = await Promise.all([
        this.assessTargetLanguage(
          transcription,
          languageName,
          languageCode,
          expectedProficiency,
          safeVocab.languages
        ),
        this.detectFacesAndFraud(upload.publicId, upload.duration, referencePhotoUrl),
      ]);
      const heardAccent = await this.assessAccentFromAudio(audioTmpPath, languageName);
      const assessment = heardAccent ? this.applyHeardAccent(rawAssessment, heardAccent) : rawAssessment;

      step(
        `complete — match=${assessment?.languageMatch?.matches}, cefr=${assessment?.cefr}, score=${assessment?.overallScore}, accent=${assessment?.accent?.category || 'none'}`
      );

      return {
        videoUrl: upload.url,
        duration: upload.duration,
        transcription,
        assessment,
        fraudCheck,
        targetLanguage: languageName,
        expectedProficiency,
        provider: 'openai',
      };
    } finally {
      if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
      if (audioTmpPath && fs.existsSync(audioTmpPath)) fs.unlinkSync(audioTmpPath);
    }
  }

  // Mild upward calibration — never invent mastery (95+) from a mid/high sample.
  softenScore(raw) {
    const n = Math.round(Number(raw) || 0);
    if (n <= 0) return 0;
    const lifted = Math.round(n * 1.03 + 2);
    // Keep C1 ceiling below the C2 reserved band; only true excellence hits 95+.
    if (n < 90) return Math.min(92, lifted);
    if (n < 95) return Math.min(96, lifted);
    return Math.min(100, n);
  }

  /**
   * Hear the recording. Whisper's transcript has no accent, so Northern France,
   * Quebec and the rest cannot be scored from text.
   */
  async assessAccentFromAudio(audioPath, languageName) {
    this._ensureInitialized();
    if (!audioPath || !fs.existsSync(audioPath)) return null;
    const bytes = fs.statSync(audioPath).size;
    if (bytes < 1000 || bytes > 8 * 1024 * 1024) return null;

    const prompt = `You are a phonetician. Listen to this spoken recording and describe the speaker's ACCENT. Do not judge grammar or give a proficiency score.

Spoken language hint: ${languageName || 'detect it from the audio'}

Return ONLY JSON:
{
  "category": "neutral|mild_regional|strong_regional|non_native",
  "variety": { "en": "short variety name", "fr": "nom court de la variété" },
  "confidence": "low|medium|high",
  "feedback": { "en": "one sentence to the speaker about the accent impact, You ...", "fr": "une phrase sur l'impact de l'accent, vouvoiement" },
  "confidenceReason": { "en": "one sentence explaining WHY this confidence level", "fr": "une phrase expliquant POURQUOI ce niveau de confiance" }
}

category:
- neutral: standard / broadcast, no marked regional colour
- mild_regional: recognizable but light regional colour
- strong_regional: clearly marked regional accent
- non_native: the speaker's first language is different

variety must name the variety, not repeat the category. French examples: "Français neutre / standard", "Nord de la France", "Sud de la France", "Français québécois", "Français belge", "Français suisse", "Français maghrébin", "Français antillais", "Français d'Afrique de l'Ouest". English examples: "General American", "British (RP)", "Northern England". Use the matching label for whatever language you hear.

confidenceReason is mandatory and must justify the badge:
- low → short/noisy sample, conflicting cues, or hard to place
- medium → plausible variety from partial cues on a short clip; not fully certain
- high → clear, consistent phonetic markers throughout the sample
If you are not sure of the variety, use neutral and confidence "low", and say so in confidenceReason.`;

    try {
      const response = await this.openai.chat.completions.create({
        model: process.env.OPENAI_AUDIO_MODEL || 'gpt-audio-mini',
        modalities: ['text'],
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: prompt },
              {
                type: 'input_audio',
                input_audio: {
                  data: fs.readFileSync(audioPath).toString('base64'),
                  format: 'mp3',
                },
              },
            ],
          },
        ],
        temperature: 0,
      });
      const text = response.choices?.[0]?.message?.content || '';
      const jsonText = String(text).replace(/```json|```/g, '').trim();
      const parsed = JSON.parse(jsonText);
      const accent = parsed?.accent && typeof parsed.accent === 'object' ? parsed.accent : parsed;
      return this.normalizeAccent(accent, { en: '', fr: '' }, 'audio');
    } catch (err) {
      console.error('Audio accent assessment failed:', err.message);
      return null;
    }
  }

  applyHeardAccent(assessment, accent) {
    if (!assessment || !accent) return assessment;
    if (Array.isArray(assessment.languages)) {
      return {
        ...assessment,
        languages: assessment.languages.map((entry) => ({ ...entry, accent })),
      };
    }
    return { ...assessment, accent };
  }

  /**
   * Download an already-stored experience video's audio and measure its accent.
   * Does not change CEFR or the sub-scores.
   */
  async measureStoredVideoAccent(videoUrl, languageName) {
    this._ensureInitialized();
    const publicId = this.cloudinaryVideoPublicId(videoUrl);
    if (!publicId) return null;
    let audioPath = null;
    try {
      audioPath = await this.downloadToTemp(this.buildAudioUrl(publicId), 'mp3');
      return await this.assessAccentFromAudio(audioPath, languageName);
    } finally {
      if (audioPath && fs.existsSync(audioPath)) fs.unlinkSync(audioPath);
    }
  }

  normalizeBilingualText(value, emptyText = { en: '', fr: '' }) {
    if (value && typeof value === 'object') {
      return {
        en: value.en || value.fr || '',
        fr: value.fr || value.en || '',
      };
    }
    if (typeof value === 'string' && value.trim()) {
      return { en: value, fr: value };
    }
    return { ...emptyText };
  }

  normalizePronunciationEstimate(estimate, emptyText = { en: '', fr: '' }, scoreClamp) {
    const clamp = typeof scoreClamp === 'function' ? scoreClamp : (v) => Math.max(0, Math.min(100, Number(v) || 0));
    if (!estimate || typeof estimate !== 'object') {
      return {
        score: 0,
        confidence: 'low',
        feedback: { ...emptyText },
        confidenceReason: {
          en: 'Pronunciation confidence is low because there was not enough speech to judge.',
          fr: 'La confiance sur la prononciation est faible faute d’assez de parole à évaluer.',
        },
      };
    }
    const confidence = ['low', 'medium', 'high'].includes(String(estimate.confidence || '').toLowerCase())
      ? String(estimate.confidence).toLowerCase()
      : 'low';
    let confidenceReason = this.normalizeBilingualText(
      estimate.confidenceReason || estimate.confidence_reason,
      { en: '', fr: '' }
    );
    if (!confidenceReason.en && !confidenceReason.fr) {
      confidenceReason =
        confidence === 'high'
          ? {
              en: 'High confidence: pronunciation cues were clear and consistent in the sample.',
              fr: 'Confiance élevée : les indices de prononciation étaient clairs et constants.',
            }
          : confidence === 'medium'
          ? {
              en: 'Medium confidence: pronunciation cues are plausible on a short sample, but not fully conclusive.',
              fr: 'Confiance moyenne : les indices de prononciation sont plausibles sur un échantillon court, mais pas totalement concluants.',
            }
          : {
              en: 'Low confidence: pronunciation was estimated from limited cues (short sample or text-only signals).',
              fr: 'Confiance faible : la prononciation a été estimée à partir d’indices limités (échantillon court ou signaux textuels).',
            };
    }
    return {
      ...estimate,
      score: clamp(estimate.score),
      confidence,
      feedback: this.normalizeBilingualText(estimate.feedback, emptyText),
      confidenceReason,
    };
  }

  normalizeAccent(accent, emptyText = { en: '', fr: '' }, source) {
    const allowed = new Set(['neutral', 'mild_regional', 'strong_regional', 'non_native']);
    const category = allowed.has(String(accent?.category || '').toLowerCase())
      ? String(accent.category).toLowerCase()
      : 'neutral';
    const confidence = ['low', 'medium', 'high'].includes(String(accent?.confidence || '').toLowerCase())
      ? String(accent.confidence).toLowerCase()
      : 'low';
    const variety =
      accent?.variety && typeof accent.variety === 'object'
        ? {
            en: accent.variety.en || accent.variety.fr || '',
            fr: accent.variety.fr || accent.variety.en || '',
          }
        : typeof accent?.variety === 'string'
        ? { en: accent.variety, fr: accent.variety }
        : {
            en: category === 'non_native' ? 'Non-native accent' : 'Neutral / standard',
            fr: category === 'non_native' ? 'Accent non natif' : 'Neutre / standard',
          };
    const feedback =
      accent?.feedback && typeof accent.feedback === 'object'
        ? {
            en: accent.feedback.en || accent.feedback.fr || '',
            fr: accent.feedback.fr || accent.feedback.en || '',
          }
        : { ...emptyText };
    const confidenceReasonRaw = accent?.confidenceReason || accent?.confidence_reason;
    let confidenceReason =
      confidenceReasonRaw && typeof confidenceReasonRaw === 'object'
        ? {
            en: confidenceReasonRaw.en || confidenceReasonRaw.fr || '',
            fr: confidenceReasonRaw.fr || confidenceReasonRaw.en || '',
          }
        : typeof confidenceReasonRaw === 'string'
        ? { en: confidenceReasonRaw, fr: confidenceReasonRaw }
        : null;
    if (!confidenceReason?.en && !confidenceReason?.fr) {
      // Fallback so the UI never shows a bare confidence badge without explanation.
      if (source === 'transcript') {
        confidenceReason = {
          en: 'Confidence is limited because this accent was estimated from the transcript, not from fine audio cues.',
          fr: 'La confiance est limitée car cet accent a été estimé à partir de la transcription, sans analyse audio fine.',
        };
      } else if (confidence === 'medium') {
        confidenceReason = {
          en: 'Medium confidence: cues are plausible on a short sample, but not fully conclusive.',
          fr: 'Confiance moyenne : les indices sont plausibles sur un échantillon court, mais pas totalement concluants.',
        };
      } else if (confidence === 'low') {
        confidenceReason = {
          en: 'Low confidence: the sample is short, noisy, or the accent cues are ambiguous.',
          fr: 'Confiance faible : l’échantillon est court, bruyant, ou les indices d’accent sont ambigus.',
        };
      } else {
        confidenceReason = {
          en: 'High confidence: accent markers are clear and consistent across the sample.',
          fr: 'Confiance élevée : les marqueurs d’accent sont clairs et constants sur l’échantillon.',
        };
      }
    }
    const heardFrom = source || (accent?.source === 'audio' || accent?.source === 'transcript' ? accent.source : undefined);
    return heardFrom
      ? { category, variety, confidence, feedback, confidenceReason, source: heardFrom }
      : { category, variety, confidence, feedback, confidenceReason };
  }

  // Soft evidence caps: short clear professional clips can still score high.
  evidenceScoreCap(wordCount) {
    if (wordCount >= 60) return 100;
    if (wordCount >= 35) return 96;
    if (wordCount >= 20) return 90;
    if (wordCount >= 12) return 84;
    if (wordCount >= 6) return 75;
    return 62;
  }

  // Keep the CEFR band consistent with the (capped) overall score. We never
  // upgrade above what the model claimed, but we downgrade if the score is low.
  scoreToCefr(score, modelCefr) {
    const order = ['A1', 'A2', 'B1', 'B2', 'C1', 'C2'];
    const fromScore =
      score >= 93 ? 'C2' : score >= 82 ? 'C1' : score >= 68 ? 'B2' : score >= 53 ? 'B1' : score >= 39 ? 'A2' : 'A1';
    if (!modelCefr || !order.includes(modelCefr)) return fromScore;
    // Take the lower of the two so a capped score pulls the band down.
    return order.indexOf(modelCefr) <= order.indexOf(fromScore) ? modelCefr : fromScore;
  }

  // Normalize the model's relevance block. Off-topic when the model says so OR
  // when the relevance score is below the on-topic threshold.
  normalizeRelevance(relevance) {
    const score =
      relevance && typeof relevance.score === 'number'
        ? Math.max(0, Math.min(100, Math.round(relevance.score)))
        : 100;
    const onTopic = relevance?.onTopic !== false && score >= 40;
    const defaultReason = onTopic
      ? { en: 'Your speech matches the stated experience.', fr: 'Votre présentation correspond à l’expérience indiquée.' }
      : { en: 'Your speech does not match the stated experience.', fr: 'Votre présentation ne correspond pas à l’expérience indiquée.' };
    return {
      onTopic,
      score,
      reason: relevance?.reason || defaultReason,
    };
  }

  // Overwrite each spoken-language detection score with the nuanced, evidence-based
  // overallScore (and CEFR) from the dedicated assessment, matched by id or name.
  // Do NOT invent extra languages from the assessment — only enrich languages already
  // detected in THIS recording (or the Whisper/GPT detected speech language).
  mergeAssessmentScores(spokenLanguages, languageAssessment) {
    const spoken = Array.isArray(spokenLanguages) ? [...spokenLanguages] : [];
    const assessed = languageAssessment?.languages || [];
    if (assessed.length === 0) return spoken;

    const byId = new Map();
    const byName = new Map();
    assessed.forEach((a) => {
      const id = a.language?._id ? String(a.language._id) : null;
      const name = (a.language?.name || a.languageName || '').toLowerCase();
      if (id) byId.set(id, a);
      if (name) byName.set(name, a);
    });

    return spoken.map((lang) => {
      const id = lang.language?._id ? String(lang.language._id) : null;
      const name = (lang.language?.name || '').toLowerCase();
      const match = (id && byId.get(id)) || (name && byName.get(name));
      if (!match) return lang;
      return {
        ...lang,
        score: match.overallScore,
        level: match.cefr || lang.level,
      };
    });
  }

  languageMatchKey(value) {
    return String(value || '')
      .toLowerCase()
      .normalize('NFD')
      .replace(/\p{M}/gu, '')
      .replace(/[^a-z]/g, '');
  }

  languageAliases(name) {
    const key = this.languageMatchKey(name);
    const aliases = new Set([key]);
    if (key.startsWith('en') || key.includes('english') || key.includes('anglais')) {
      ['en', 'english', 'anglais'].forEach((a) => aliases.add(a));
    }
    if (key.startsWith('fr') || key.includes('french') || key.includes('francais')) {
      ['fr', 'french', 'francais'].forEach((a) => aliases.add(a));
    }
    if (key.startsWith('es') || key.includes('spanish') || key.includes('espanol')) {
      ['es', 'spanish', 'espanol'].forEach((a) => aliases.add(a));
    }
    if (key.startsWith('de') || key.includes('german') || key.includes('allemand')) {
      ['de', 'german', 'allemand'].forEach((a) => aliases.add(a));
    }
    if (key.startsWith('ar') || key.includes('arabic') || key.includes('arabe')) {
      ['ar', 'arabic', 'arabe'].forEach((a) => aliases.add(a));
    }
    if (key.startsWith('pt') || key.includes('portuguese') || key.includes('portugais')) {
      ['pt', 'portuguese', 'portugais'].forEach((a) => aliases.add(a));
    }
    return aliases;
  }

  /**
   * Keep only languages actually spoken in THIS recording.
   * Primary signal = detectedLanguageOfSpeech from the transcript.
   * Drops profile/UI noise (e.g. French Native on an English-only clip).
   */
  filterLanguagesToRecording(spokenLanguages, languageAssessment, detectedLanguageOfSpeech) {
    const detectedAliases = this.languageAliases(detectedLanguageOfSpeech);
    const spoken = Array.isArray(spokenLanguages) ? spokenLanguages : [];
    const assessed = Array.isArray(languageAssessment?.languages) ? languageAssessment.languages : [];

    // No reliable detection → keep GPT output as-is.
    if (![...detectedAliases].some(Boolean)) {
      return { spokenLanguages: spoken, languageAssessment };
    }

    const keepName = (name) =>
      [...this.languageAliases(name)].some((a) => detectedAliases.has(a));

    const filteredSpoken = spoken.filter((lang) =>
      keepName(lang.language?.name || lang.languageName || lang.language)
    );

    const filteredAssessmentLanguages = assessed.filter((lang) =>
      keepName(lang.language?.name || lang.languageName || '')
    );

    return {
      spokenLanguages: filteredSpoken,
      languageAssessment: languageAssessment
        ? { ...languageAssessment, languages: filteredAssessmentLanguages }
        : languageAssessment,
    };
  }

  /**
   * Anti-fraud facial check: samples a few frames from the uploaded video and
   * asks GPT-4o vision to confirm a single, live, consistent human face.
   * Fails open (returns a neutral result) if anything goes wrong so a transient
   * vision error never blocks a legitimate analysis.
   */
  frameOffsets(duration) {
    let seconds = typeof duration === 'number' && duration > 0 ? duration : 8;
    // Some older clips stored the length in milliseconds.
    if (seconds > 600) seconds = seconds / 1000;
    const last = Math.max(0, Math.floor(seconds) - 1);
    const points = [0.2, 0.5, 0.8].map((ratio) => Math.min(Math.floor(seconds * ratio), last));
    return [...new Set(points)];
  }

  async detectFacesAndFraud(publicId, duration, referencePhotoUrl = null) {
    const offsets = this.frameOffsets(duration);

    const hasReference = Boolean(referencePhotoUrl);
    const frameContent = offsets.map((offset) => ({
      type: 'image_url',
      image_url: { url: this.buildFrameUrl(publicId, offset), detail: 'high' },
    }));
    // Reference profile photo goes FIRST so the prompt can address it as image #1.
    const imageContent = hasReference
      ? [{ type: 'image_url', image_url: { url: referencePhotoUrl, detail: 'high' } }, ...frameContent]
      : frameContent;

    try {
      const response = await this.openai.chat.completions.create({
        model: 'gpt-4o',
        messages: [
          { role: 'system', content: FRAUD_SYSTEM_PROMPT },
          {
            role: 'user',
            content: [{ type: 'text', text: buildFraudPrompt(hasReference) }, ...imageContent],
          },
        ],
        temperature: 0,
        response_format: { type: 'json_object' },
      });

      const parsed = JSON.parse(response.choices[0].message.content);
      const identityMatch =
        parsed.identityMatch === true ? true : parsed.identityMatch === false ? false : null;
      const identityConfidence =
        typeof parsed.identityConfidence === 'number'
          ? Math.max(0, Math.min(100, Math.round(parsed.identityConfidence)))
          : 0;

      let fraudRisk = ['low', 'medium', 'high'].includes(parsed.fraudRisk) ? parsed.fraudRisk : 'medium';
      const reasons = Array.isArray(parsed.reasons) ? parsed.reasons : [];

      // A low score means the model is unsure (angle, sunglasses, short clip), not that
      // it is a different person. Only a confident mismatch is fraud.
      let resolvedMatch = identityMatch;
      let resolvedConfidence = identityConfidence;
      if (hasReference && resolvedMatch === false && resolvedConfidence < 70) {
        const liveSingleFace =
          parsed.faceDetected === true &&
          (typeof parsed.faceCount !== 'number' || parsed.faceCount <= 1) &&
          parsed.looksLive === true &&
          parsed.samePersonAcrossFrames !== false;
        if (liveSingleFace) {
          resolvedMatch = true;
          resolvedConfidence = Math.max(resolvedConfidence, 60);
          fraudRisk = 'low';
        } else {
          resolvedMatch = null;
          fraudRisk = fraudRisk === 'high' ? 'medium' : fraudRisk;
        }
      }

      if (hasReference && resolvedMatch !== false) {
        const mismatch = /profile photo|photo de profil/i;
        const kept = reasons.filter((reason) => !mismatch.test(`${reason?.en || ''} ${reason?.fr || ''}`));
        reasons.length = 0;
        reasons.push(...kept);
      }

      if (hasReference && resolvedMatch === false && resolvedConfidence >= 70) {
        fraudRisk = 'high';
        reasons.unshift({
          en: 'The person in the video does not match your profile photo.',
          fr: 'La personne dans la vidéo ne correspond pas à votre photo de profil.',
        });
      }

      return {
        faceDetected: parsed.faceDetected === true,
        faceCount: typeof parsed.faceCount === 'number' ? parsed.faceCount : 0,
        samePersonAcrossFrames: parsed.samePersonAcrossFrames !== false,
        looksLive: parsed.looksLive === true,
        livenessConfidence: typeof parsed.livenessConfidence === 'number' ? parsed.livenessConfidence : 0,
        identityMatch: resolvedMatch,
        identityConfidence: resolvedConfidence,
        identityChecked: hasReference,
        referencePhotoUrl: referencePhotoUrl || null,
        fraudRisk,
        reasons,
        checkedFrames: offsets.length,
      };
    } catch (err) {
      console.error('Facial/anti-fraud check failed:', err.message);
      return {
        faceDetected: null,
        faceCount: null,
        samePersonAcrossFrames: null,
        looksLive: null,
        livenessConfidence: 0,
        identityMatch: null,
        identityConfidence: 0,
        identityChecked: hasReference,
        referencePhotoUrl: referencePhotoUrl || null,
        fraudRisk: 'unknown',
        reasons: [{ en: 'Anti-fraud check could not be completed.', fr: 'La vérification anti-fraude n’a pas pu être effectuée.' }],
        checkedFrames: 0,
      };
    }
  }

  async analyzeExperienceVideo(videoBuffer, mimetype, experienceContext = {}) {
    this._ensureInitialized();

    if (videoBuffer.length > MAX_VIDEO_BYTES) {
      throw new Error(
        `Video is too large for analysis (${Math.round(videoBuffer.length / 1024 / 1024)}MB). Maximum is ${Math.round(MAX_VIDEO_BYTES / 1024 / 1024)}MB.`
      );
    }

    // Load the allowed vocabularies directly from the shared MongoDB collections.
    let safeVocab;
    try {
      safeVocab = await this.vocabularyService.getVocabulary();
    } catch (err) {
      console.error('Failed to load vocabulary from DB:', err.message);
      safeVocab = {
        technicalSkills: [],
        professionalSkills: [],
        softSkills: [],
        industries: [],
        activities: [],
        languages: [],
      };
    }

    const ext = mimetype.includes('mp4') ? 'mp4' : 'webm';
    const tmpPath = path.join(os.tmpdir(), `exp-video-${Date.now()}.${ext}`);
    let audioTmpPath = null;

    try {
      fs.writeFileSync(tmpPath, videoBuffer);

      console.log(`Uploading video to Cloudinary (${Math.round(videoBuffer.length / 1024)}KB)...`);
      const upload = await this.uploadToCloudinary(tmpPath);

      // Garde-fou durée : une présentation crédible doit durer au moins 30s.
      if (typeof upload.duration === 'number' && upload.duration < MIN_DURATION_SECONDS) {
        throw new VideoValidationError(
          `Video is too short (${Math.round(upload.duration)}s). A minimum of ${MIN_DURATION_SECONDS} seconds is required.`,
          'VIDEO_TOO_SHORT',
          { duration: upload.duration, minDuration: MIN_DURATION_SECONDS }
        );
      }

      // On extrait un mp3 léger depuis la vidéo uploadée : Whisper ne reçoit jamais
      // la vidéo complète (potentiellement > 25 Mo), seulement l'audio.
      console.log('Extracting audio (mp3) from Cloudinary...');
      const audioUrl = this.buildAudioUrl(upload.publicId);
      audioTmpPath = await this.downloadToTemp(audioUrl, 'mp3');

      const audioBytes = fs.statSync(audioTmpPath).size;
      if (audioBytes > WHISPER_MAX_BYTES) {
        throw new Error(
          `Extracted audio is too large for transcription (${Math.round(audioBytes / 1024 / 1024)}MB). Maximum is ${Math.round(WHISPER_MAX_BYTES / 1024 / 1024)}MB.`
        );
      }

      console.log('Transcribing audio with Whisper...');
      const { text: transcription, language: whisperLanguage } = await this.transcribeAudio(audioTmpPath);

      // If the person said essentially nothing (silence → Whisper hallucinates a
      // stock phrase like "Thank you for watching!"), we must NOT detect or add a
      // language. We still run the rest of the analysis, but force the language
      // outputs to empty so nothing bogus reaches the profile.
      const hasMeaningfulSpeech = meaningfulSpeechWordCount(transcription) >= MIN_MEANINGFUL_WORDS;
      if (!hasMeaningfulSpeech) {
        console.log(
          `No meaningful speech detected (transcript="${(transcription || '').slice(0, 80)}") — ` +
            'skipping language detection/assessment.'
        );
      }

      console.log('Analyzing transcript with GPT-4o (constrained to DB vocabulary)...');
      const parsed = await this.analyzeTranscript(transcription, experienceContext, safeVocab);

      // Correct Whisper/GPT language mislabels (common: Spanish → Arabic) using
      // transcript script + Whisper language + lexical cues.
      if (hasMeaningfulSpeech) {
        const reconciled = this.reconcileDetectedSpeechLanguage(
          transcription,
          parsed.detectedLanguageOfSpeech,
          whisperLanguage
        );
        if (reconciled && reconciled !== parsed.detectedLanguageOfSpeech) {
          console.log(
            `Speech language corrected: "${parsed.detectedLanguageOfSpeech || '?'}" → "${reconciled}"` +
              ` (whisper=${whisperLanguage || 'n/a'})`
          );
        }
        parsed.detectedLanguageOfSpeech = reconciled || parsed.detectedLanguageOfSpeech || '';
        // Keep spokenLanguages aligned with the corrected primary language.
        if (parsed.detectedLanguageOfSpeech) {
          const primaryKey = this.languageMatchKey(parsed.detectedLanguageOfSpeech);
          const spoken = Array.isArray(parsed.spokenLanguages) ? parsed.spokenLanguages : [];
          const matching = spoken.filter((entry) =>
            [...this.languageAliases(entry?.language || entry?.languageName || '')].some((a) =>
              this.languageAliases(parsed.detectedLanguageOfSpeech).has(a)
            )
          );
          parsed.spokenLanguages =
            matching.length > 0
              ? matching
              : [
                  {
                    language: parsed.detectedLanguageOfSpeech,
                    level: 'B2',
                    score: 70,
                    evidence: {
                      en: 'Detected from this recording.',
                      fr: 'Détecté à partir de cet enregistrement.',
                    },
                  },
                ];
          // Drop Arabic (or other mismatches) when primary is a Latin language.
          if (!primaryKey.includes('arab')) {
            parsed.spokenLanguages = parsed.spokenLanguages.filter(
              (entry) => !this.languageMatchKey(entry?.language || entry?.languageName || '').includes('arab')
            );
          }
        }
      }

      // Dedicated language assessment + anti-fraud facial check run in parallel.
      console.log('Running language assessment and anti-fraud facial check...');
      const [rawLanguageAssessment, fraudCheck] = await Promise.all([
        this.assessLanguages(transcription, parsed.detectedLanguageOfSpeech, safeVocab.languages),
        this.detectFacesAndFraud(upload.publicId, upload.duration, experienceContext.referencePhotoUrl),
      ]);

      let languageAssessment = hasMeaningfulSpeech
        ? rawLanguageAssessment
        : { assessable: false, languages: [] };
      if (hasMeaningfulSpeech && audioTmpPath) {
        const heardAccent = await this.assessAccentFromAudio(
          audioTmpPath,
          parsed.detectedLanguageOfSpeech
        );
        if (heardAccent) languageAssessment = this.applyHeardAccent(languageAssessment, heardAccent);
      }

      // The raw spokenLanguages score is only a detection confidence (≈100 for a
      // native speaker). Replace it with the evidence-based assessment score so the
      // UI bar reflects real proficiency instead of a flat 100%. When there is no
      // real speech, we drop spoken languages entirely (nothing added to profile).
      let spokenLanguages = hasMeaningfulSpeech
        ? this.mergeAssessmentScores(
            this.resolveLanguageRefs(parsed.spokenLanguages, safeVocab.languages),
            languageAssessment
          )
        : [];

      // Guarantee the speech language itself is present when GPT named it.
      if (hasMeaningfulSpeech && parsed.detectedLanguageOfSpeech) {
        const detectedRefs = this.resolveLanguageRefs(
          [{ language: parsed.detectedLanguageOfSpeech, level: 'B2', score: 70 }],
          safeVocab.languages
        );
        detectedRefs.forEach((ref) => {
          const id = ref.language?._id ? String(ref.language._id) : null;
          if (!id) return;
          if (spokenLanguages.some((s) => String(s.language?._id || s.language) === id)) return;
          spokenLanguages.push(ref);
        });
      }

      // Hard perimeter: drop languages not actually spoken in THIS recording
      // (e.g. French Native on an English-only clip).
      if (hasMeaningfulSpeech) {
        const filtered = this.filterLanguagesToRecording(
          spokenLanguages,
          languageAssessment,
          parsed.detectedLanguageOfSpeech
        );
        spokenLanguages = filtered.spokenLanguages;
        languageAssessment = filtered.languageAssessment;
        // Re-merge scores after filtering assessment languages.
        spokenLanguages = this.mergeAssessmentScores(spokenLanguages, languageAssessment);
      }

      // Relevance is now informational only: we ALWAYS extract whatever skills are
      // genuinely evidenced, and keep the relevance flag just to warn the user when
      // the speech does not clearly match the stated experience.
      const relevance = this.normalizeRelevance(parsed.relevance);

      const technicalSkills = this.resolveNamedRefs(parsed.technicalSkills, safeVocab.technicalSkills, 'skill');
      const professionalSkills = this.resolveNamedRefs(parsed.professionalSkills, safeVocab.professionalSkills, 'skill');
      const softSkills = this.resolveNamedRefs(parsed.softSkills, safeVocab.softSkills, 'skill');
      const industries = this.resolveNamedRefs(parsed.industries, safeVocab.industries, 'industry');
      const activities = this.resolveNamedRefs(parsed.activities, safeVocab.activities, 'activity');

      // Diagnostic: surface the relevance decision + evidence so off-topic/empty
      // results are easy to explain from the logs.
      console.log(
        `Analysis decision for "${experienceContext.title || 'experience'}": ` +
          `onTopic=${relevance.onTopic}, relevanceScore=${relevance.score}, confidence=${parsed.overallConfidence || 0}, ` +
          `tech=${technicalSkills.length}, prof=${professionalSkills.length}, soft=${softSkills.length}, ` +
          `ind=${industries.length}, act=${activities.length}, langs=${spokenLanguages.length}, ` +
          `transcriptChars=${(transcription || '').length}`
      );

      // Enforce vocabulary server-side and persist ObjectId refs instead of names.
      return {
        videoUrl: upload.url,
        duration: upload.duration,
        transcription,
        languageAssessment,
        fraudCheck,
        relevance,
        analysis: {
          technicalSkills,
          professionalSkills,
          softSkills,
          spokenLanguages,
          industries,
          activities,
          contactCenterSkills: parsed.contactCenterSkills || {},
          overallConfidence: parsed.overallConfidence || 0,
          detectedLanguageOfSpeech: parsed.detectedLanguageOfSpeech || '',
          relevance,
          summary: parsed.summary || { en: '', fr: '' },
        },
        provider: 'openai',
      };
    } finally {
      if (fs.existsSync(tmpPath)) {
        fs.unlinkSync(tmpPath);
      }
      if (audioTmpPath && fs.existsSync(audioTmpPath)) {
        fs.unlinkSync(audioTmpPath);
      }
    }
  }
}

module.exports = VideoAnalysisService;
module.exports.VideoValidationError = VideoValidationError;
module.exports.MIN_DURATION_SECONDS = MIN_DURATION_SECONDS;
module.exports.MIN_LANGUAGE_VIDEO_SECONDS = MIN_LANGUAGE_VIDEO_SECONDS;
module.exports.MAX_LANGUAGE_VIDEO_SECONDS = MAX_LANGUAGE_VIDEO_SECONDS;
