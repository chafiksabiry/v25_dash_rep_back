const OpenAI = require('openai');
const cloudinary = require('cloudinary').v2;
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const os = require('os');
const VocabularyService = require('./VocabularyService');

// Garde-fou sur l'upload (mémoire). Whisper ne reçoit plus la vidéo mais l'audio
// extrait (mp3) — bien plus léger — donc la limite de 25 Mo de Whisper ne s'applique plus.
const MAX_VIDEO_BYTES = 1000 * 1024 * 1024;
// Limite réelle de l'API Whisper (fichier audio envoyé).
const WHISPER_MAX_BYTES = 50 * 1024 * 1024;
// Durée minimale pour une vidéo de vérification linguistique dédiée (onglet Langues).
const MIN_LANGUAGE_VIDEO_SECONDS = 90; // 1 min 30
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

  items.forEach((item) => {
    if (!item?.id) return;
    const entry = { id: item.id, name: item.name };
    if (item.name) byLower.set(String(item.name).toLowerCase(), entry);
    if (item.code) byLower.set(String(item.code).toLowerCase(), entry);
  });

  return byLower;
};

const buildAnalysisPrompt = (contextStr, transcription, vocab) => `You are an expert HR analyst and skills assessor. ${contextStr}

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

RELEVANCE / OFF-TOPIC CHECK — VERY IMPORTANT:
- The speaker is supposed to describe the SPECIFIC professional experience given in the context above.
- Judge from the TRANSCRIPT whether the speech is actually ABOUT that role/company and professional experience in general.
- If the transcript is clearly unrelated (random talk, testing the mic, a totally different topic, jokes, silence, advertising, reading something off-topic, etc.), set "relevance.onTopic" to false and give a low "relevance.score". Otherwise set it to true.
- IMPORTANT: This relevance flag is INFORMATIONAL only. ALWAYS extract every skill, industry and activity that is genuinely evidenced in the transcript, EVEN IF you judged the video off-topic. Do NOT return empty arrays just because relevance is low — only return empty when there is truly no matching evidence.

STRICT VOCABULARY RULES — VERY IMPORTANT:
- For technicalSkills, professionalSkills, softSkills, industries and activities you MUST ONLY use names taken EXACTLY from the predefined lists below.
- Do NOT invent, rephrase, translate or merge names. Copy them character-for-character from the lists.
- Only include an item if the transcript provides real evidence the person has it. If nothing matches a list, return an empty array for that field.
- spokenLanguages and contactCenterSkills are NOT restricted by any list — detect them freely.

ACTIVITIES — DETECT GENEROUSLY:
- ACTIVITIES describe WHAT the person actually DID day to day (their responsibilities, missions, tasks), e.g. prospecting, advising clients, closing sales, managing quotes, handling support.
- Read the transcript for any described task or responsibility and map each one to the CLOSEST matching name in the ACTIVITIES list (exact copy).
- Be thorough: if the person clearly describes doing something that corresponds to an activity in the list, include it even if they don't use the exact wording. Do NOT return an empty activities array when the speech describes concrete work that matches the list.

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
  "spokenLanguages": [ { "language": "string", "level": "A1|A2|B1|B2|C1|C2|Native", "score": 0-100, "evidence": { "en": "...", "fr": "..." } } ],
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
  "detectedLanguageOfSpeech": "string",
  "relevance": { "onTopic": true, "score": 0-100, "reason": { "en": "speak to the person: e.g. 'You spoke about ...' or 'You didn't talk about your role ...'", "fr": "parlez à la personne : ex. « Vous avez parlé de ... » ou « Vous n'avez pas décrit votre poste ... »" } },
  "summary": { "en": "2-3 sentences spoken DIRECTLY to the person using 'You ...' (never 'The transcript/candidate ...')", "fr": "2-3 phrases adressées DIRECTEMENT à la personne avec « Vous ... » (jamais « La transcription/le candidat ... »)" }
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
const buildLanguageAssessmentPrompt = (transcription, detectedLanguage, allowedLanguages) => `You are a certified CEFR language examiner.

Assess the speaker's command of each spoken language based on the transcript of a professional self-introduction video.

DETECTED LANGUAGE OF SPEECH: ${detectedLanguage || 'unknown'}

TRANSCRIPT:
"${transcription || '[No speech detected]'}"

${renderAllowedList('KNOWN PLATFORM LANGUAGES (use these exact names when the spoken language matches one)', allowedLanguages)}

ASSESSMENT RULES:
- Judge ONLY from real linguistic evidence in the transcript (grammar, vocabulary range, sentence complexity, coherence, connectors, register).
- Pronunciation cannot be measured from text — estimate it conservatively from word choice/coherence and clearly mark lower confidence for it.
- If the transcript is empty or too short to judge, return an empty "languages" array and set "assessable" to false.
- Map every score to the CEFR scale honestly: A1 (very basic) → C2 (mastery / native-like).
- NEVER default to 100. 100 means flawless C2 mastery with rich vocabulary, complex syntax and zero errors across a substantial sample. This is rare.
- Score STRICTLY from the EVIDENCE AVAILABLE. The amount of speech limits how high you can score:
  * Very little speech (< 1 full sentence): cap every score at ~40 and use confidence "low".
  * One or two short sentences: cap around 55-65.
  * A short paragraph (3-5 sentences): cap around 70-80.
  * A rich, multi-paragraph, well-structured sample: only then may scores exceed 85.
- A native-sounding but SHORT or simple statement is NOT 100 — there isn't enough evidence. Reflect that with a lower score AND lower confidence.
- Each sub-score (fluency, grammar, vocabulary, coherence) must be justified by a concrete observation in "feedback". If you cannot justify it, score it lower.
- overallScore must be roughly the average of the sub-scores, not the maximum.

TONE & LANGUAGE — VERY IMPORTANT:
- Address the candidate DIRECTLY in the second person (English "You ...", French polite "Vous ...").
- Every text field ("feedback", "strengths", "areasForImprovement") MUST be a bilingual object { "en": "English", "fr": "français (vouvoiement)" } with equivalent meaning.

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
      "pronunciationEstimate": { "score": 0-100, "confidence": "low|medium|high", "feedback": { "en": "...", "fr": "..." } },
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
) => `You are a certified CEFR language examiner verifying a candidate's proficiency in ONE specific language.

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

SCORING RULES (same strictness as general language assessment):
- NEVER default to 100. Cap scores by amount of speech evidence.
- Very little speech (< 1 sentence): cap scores ~40, confidence "low".
- Short sample: cap ~55-65. Rich sample: may exceed 85.
- overallScore ≈ average of sub-scores.

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
  "pronunciationEstimate": { "score": 0-100, "confidence": "low|medium|high", "feedback": { "en": "...", "fr": "..." } },
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
    ? `- IDENTITY MATCH: Is the person in the video frames the SAME person as in the profile photo? Compare facial features (face shape, eyes, nose, mouth, overall appearance). Ignore differences in lighting, angle, hairstyle, beard length, glasses or clothing. Set "identityMatch" accordingly and give "identityConfidence" (0-100). If you cannot see a face in either the photo or the video, set "identityMatch" to null.`
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

  /** URL Cloudinary d'une image (frame) extraite de la vidéo à un offset donné. */
  buildFrameUrl(publicId, offsetSeconds) {
    return cloudinary.url(publicId, {
      resource_type: 'video',
      format: 'jpg',
      start_offset: String(Math.max(0, Math.floor(offsetSeconds))),
      width: 640,
      height: 640,
      crop: 'limit',
      quality: 'auto',
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
      response_format: 'text',
    };
    if (languageHint && typeof languageHint === 'string' && languageHint.length === 2) {
      params.language = languageHint.toLowerCase();
    }
    const response = await this.openai.audio.transcriptions.create(params);
    return typeof response === 'string' ? response.trim() : String(response).trim();
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
    if (lookup.size === 0) return [];

    return items
      .filter((item) => item?.language && lookup.has(String(item.language).toLowerCase()))
      .map((item) => {
        const entry = lookup.get(String(item.language).toLowerCase());
        return {
          language: { _id: entry.id, name: entry.name },
          level: item.level,
          score: item.score,
          ...(item.evidence !== undefined ? { evidence: item.evidence } : {}),
        };
      });
  }

  async analyzeTranscript(transcription, experienceContext, vocab) {
    const contextStr = experienceContext.title
      ? `The person is describing their experience as "${experienceContext.title}" at "${experienceContext.company || 'a company'}".`
      : 'The person is describing their professional experience.';

    const response = await this.openai.chat.completions.create({
      model: 'gpt-4o',
      messages: [
        {
          role: 'system',
          content: 'You are a JSON-only API. Return only valid JSON, no markdown code blocks, no explanations. You strictly respect the provided allowed vocabulary lists.',
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

    // Server-side guard against score inflation: a credible high score needs a
    // substantial speech sample. We cap scores by the amount of evidence so a
    // short clip can never come back as a flat 100%.
    const wordCount = transcription.trim().split(/\s+/).filter(Boolean).length;
    const scoreCap = this.evidenceScoreCap(wordCount);
    const clamp = (v) => Math.max(0, Math.min(scoreCap, Math.round(Number(v) || 0)));
    const emptyText = { en: '', fr: '' };
    const clampSub = (sub) =>
      sub && typeof sub === 'object'
        ? { ...sub, score: clamp(sub.score) }
        : { score: 0, feedback: { ...emptyText } };

    const lookup = buildLanguageLookup(vocabLanguages);
    const languages = (parsed.languages || []).map((entry) => {
      const ref = entry?.language ? lookup.get(String(entry.language).toLowerCase()) : null;
      const overallScore = clamp(entry.overallScore);
      return {
        ...(ref ? { language: { _id: ref.id, name: ref.name } } : { languageName: entry.language }),
        cefr: this.scoreToCefr(overallScore, entry.cefr),
        overallScore,
        fluency: clampSub(entry.fluency),
        grammar: clampSub(entry.grammar),
        vocabulary: clampSub(entry.vocabulary),
        coherence: clampSub(entry.coherence),
        pronunciationEstimate: entry.pronunciationEstimate
          ? { ...entry.pronunciationEstimate, score: clamp(entry.pronunciationEstimate.score), confidence: entry.pronunciationEstimate.confidence || 'low' }
          : { score: 0, confidence: 'low', feedback: { ...emptyText } },
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
    const clamp = (v) => Math.max(0, Math.min(scoreCap, Math.round(Number(v) || 0)));
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
      pronunciationEstimate: parsed.pronunciationEstimate
        ? {
            ...parsed.pronunciationEstimate,
            score: clamp(parsed.pronunciationEstimate.score),
            confidence: parsed.pronunciationEstimate.confidence || 'low',
          }
        : { score: 0, confidence: 'low', feedback: { ...emptyText } },
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

      const upload = await this.uploadToCloudinary(tmpPath);

      if (typeof upload.duration === 'number' && upload.duration < MIN_LANGUAGE_VIDEO_SECONDS) {
        throw new VideoValidationError(
          `Video is too short (${Math.round(upload.duration)}s). A minimum of ${MIN_LANGUAGE_VIDEO_SECONDS} seconds is required.`,
          'VIDEO_TOO_SHORT',
          { duration: upload.duration, minDuration: MIN_LANGUAGE_VIDEO_SECONDS }
        );
      }

      const audioUrl = this.buildAudioUrl(upload.publicId);
      audioTmpPath = await this.downloadToTemp(audioUrl, 'mp3');

      const whisperHint = languageCode && languageCode.length === 2 ? languageCode : undefined;
      const transcription = await this.transcribeAudio(audioTmpPath, whisperHint);

      const [assessment, fraudCheck] = await Promise.all([
        this.assessTargetLanguage(
          transcription,
          languageName,
          languageCode,
          expectedProficiency,
          safeVocab.languages
        ),
        this.detectFacesAndFraud(upload.publicId, upload.duration, referencePhotoUrl),
      ]);

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

  // Maximum score allowed given how many words of evidence are available.
  evidenceScoreCap(wordCount) {
    if (wordCount >= 80) return 100;
    if (wordCount >= 45) return 88;
    if (wordCount >= 25) return 78;
    if (wordCount >= 12) return 65;
    if (wordCount >= 5) return 50;
    return 35;
  }

  // Keep the CEFR band consistent with the (capped) overall score. We never
  // upgrade above what the model claimed, but we downgrade if the score is low.
  scoreToCefr(score, modelCefr) {
    const order = ['A1', 'A2', 'B1', 'B2', 'C1', 'C2'];
    const fromScore =
      score >= 90 ? 'C2' : score >= 78 ? 'C1' : score >= 65 ? 'B2' : score >= 50 ? 'B1' : score >= 35 ? 'A2' : 'A1';
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
  mergeAssessmentScores(spokenLanguages, languageAssessment) {
    if (!Array.isArray(spokenLanguages) || spokenLanguages.length === 0) return spokenLanguages;
    const assessed = languageAssessment?.languages || [];
    if (assessed.length === 0) return spokenLanguages;

    const byId = new Map();
    const byName = new Map();
    assessed.forEach((a) => {
      const id = a.language?._id ? String(a.language._id) : null;
      const name = (a.language?.name || a.languageName || '').toLowerCase();
      if (id) byId.set(id, a);
      if (name) byName.set(name, a);
    });

    return spokenLanguages.map((lang) => {
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

  /**
   * Anti-fraud facial check: samples a few frames from the uploaded video and
   * asks GPT-4o vision to confirm a single, live, consistent human face.
   * Fails open (returns a neutral result) if anything goes wrong so a transient
   * vision error never blocks a legitimate analysis.
   */
  async detectFacesAndFraud(publicId, duration, referencePhotoUrl = null) {
    const safeDuration = typeof duration === 'number' && duration > 0 ? duration : 30;
    const offsets = [
      Math.floor(safeDuration * 0.15),
      Math.floor(safeDuration * 0.5),
      Math.floor(safeDuration * 0.85),
    ];

    const hasReference = Boolean(referencePhotoUrl);
    const frameContent = offsets.map((offset) => ({
      type: 'image_url',
      image_url: { url: this.buildFrameUrl(publicId, offset), detail: 'low' },
    }));
    // Reference profile photo goes FIRST so the prompt can address it as image #1.
    const imageContent = hasReference
      ? [{ type: 'image_url', image_url: { url: referencePhotoUrl, detail: 'low' } }, ...frameContent]
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

      // A confirmed identity mismatch against the profile photo is a strong fraud signal.
      if (hasReference && identityMatch === false) {
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
        identityMatch,
        identityConfidence,
        identityChecked: hasReference,
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
      const transcription = await this.transcribeAudio(audioTmpPath);

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

      // Dedicated language assessment + anti-fraud facial check run in parallel.
      console.log('Running language assessment and anti-fraud facial check...');
      const [rawLanguageAssessment, fraudCheck] = await Promise.all([
        this.assessLanguages(transcription, parsed.detectedLanguageOfSpeech, safeVocab.languages),
        this.detectFacesAndFraud(upload.publicId, upload.duration, experienceContext.referencePhotoUrl),
      ]);

      const languageAssessment = hasMeaningfulSpeech
        ? rawLanguageAssessment
        : { assessable: false, languages: [] };

      // The raw spokenLanguages score is only a detection confidence (≈100 for a
      // native speaker). Replace it with the evidence-based assessment score so the
      // UI bar reflects real proficiency instead of a flat 100%. When there is no
      // real speech, we drop spoken languages entirely (nothing added to profile).
      const spokenLanguages = hasMeaningfulSpeech
        ? this.mergeAssessmentScores(
            this.resolveLanguageRefs(parsed.spokenLanguages, safeVocab.languages),
            languageAssessment
          )
        : [];

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
