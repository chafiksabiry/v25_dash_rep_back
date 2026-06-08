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

STRICT VOCABULARY RULES — VERY IMPORTANT:
- For technicalSkills, professionalSkills, softSkills, industries and activities you MUST ONLY use names taken EXACTLY from the predefined lists below.
- Do NOT invent, rephrase, translate or merge names. Copy them character-for-character from the lists.
- Only include an item if the transcript provides real evidence the person has it. If nothing matches a list, return an empty array for that field.
- spokenLanguages and contactCenterSkills are NOT restricted by any list — detect them freely.

${renderAllowedList('TECHNICAL SKILLS', vocab.technicalSkills)}

${renderAllowedList('PROFESSIONAL SKILLS', vocab.professionalSkills)}

${renderAllowedList('SOFT SKILLS', vocab.softSkills)}

${renderAllowedList('INDUSTRIES', vocab.industries)}

${renderAllowedList('ACTIVITIES', vocab.activities)}

Return ONLY a valid JSON object with this exact structure (no markdown, no code blocks):
{
  "technicalSkills": [ { "name": "string (from TECHNICAL SKILLS list)", "score": 0-100, "evidence": "brief quote or reason" } ],
  "professionalSkills": [ { "name": "string (from PROFESSIONAL SKILLS list)", "score": 0-100, "evidence": "brief quote or reason" } ],
  "softSkills": [ { "name": "string (from SOFT SKILLS list)", "score": 0-100, "evidence": "brief quote or reason" } ],
  "spokenLanguages": [ { "language": "string", "level": "A1|A2|B1|B2|C1|C2|Native", "score": 0-100, "evidence": "reason" } ],
  "industries": [ { "name": "string (from INDUSTRIES list)", "score": 0-100 } ],
  "activities": [ { "name": "string (from ACTIVITIES list)", "score": 0-100 } ],
  "contactCenterSkills": {
    "customerService": { "score": 0-100, "notes": "string" },
    "communication": { "score": 0-100, "notes": "string" },
    "problemSolving": { "score": 0-100, "notes": "string" },
    "empathy": { "score": 0-100, "notes": "string" },
    "multitasking": { "score": 0-100, "notes": "string" },
    "salesOrientation": { "score": 0-100, "notes": "string" },
    "conflictResolution": { "score": 0-100, "notes": "string" },
    "productKnowledge": { "score": 0-100, "notes": "string" }
  },
  "overallConfidence": 0-100,
  "detectedLanguageOfSpeech": "string",
  "summary": "2-3 sentence professional summary of this experience"
}

Scoring rules:
- Score 0 = not detected / not applicable (omit such items rather than listing them at 0)
- Score 100 = expert-level, strongly evidenced
- Clear mention with detail → 70+
- Vague mention → 30-60
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
- Do NOT inflate scores. A short fluent paragraph is typically B2–C1, not automatically C2.

Return ONLY valid JSON (no markdown):
{
  "assessable": true,
  "languages": [
    {
      "language": "string (platform name if it matches the list, else the plain language name)",
      "cefr": "A1|A2|B1|B2|C1|C2",
      "overallScore": 0-100,
      "fluency": { "score": 0-100, "feedback": "string" },
      "grammar": { "score": 0-100, "feedback": "string" },
      "vocabulary": { "score": 0-100, "feedback": "string" },
      "coherence": { "score": 0-100, "feedback": "string" },
      "pronunciationEstimate": { "score": 0-100, "confidence": "low|medium|high", "feedback": "string" },
      "strengths": "string",
      "areasForImprovement": "string"
    }
  ]
}`;

// Anti-fraud facial check run over several still frames extracted from the video.
const FRAUD_SYSTEM_PROMPT =
  'You are a fraud-detection vision system for an identity-sensitive hiring platform. You receive several still frames sampled from one short self-introduction video. Return only valid JSON.';

const buildFraudPrompt = () => `Analyze these frames sampled from a SINGLE self-introduction video.

Check for signs of fraud or non-genuine recordings:
- Is there exactly ONE real, live human face visible (not zero, not several different people)?
- Does it look like a live person filmed by a webcam, NOT a photo, a screen/monitor re-filming, a printed picture, a deepfake, or an AI-generated avatar?
- Is it plausibly the SAME person across all frames?
- Any obvious manipulation, overlays, or spoofing artifacts?

Return ONLY valid JSON (no markdown):
{
  "faceDetected": true,
  "faceCount": 0,
  "samePersonAcrossFrames": true,
  "looksLive": true,
  "livenessConfidence": 0-100,
  "fraudRisk": "low|medium|high",
  "reasons": ["short reason", "..."]
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

  async transcribeAudio(filePath) {
    const response = await this.openai.audio.transcriptions.create({
      file: fs.createReadStream(filePath),
      model: 'whisper-1',
      response_format: 'text',
    });
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
    if (!transcription || transcription.trim().length < 15) {
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

    const lookup = buildLanguageLookup(vocabLanguages);
    const languages = (parsed.languages || []).map((entry) => {
      const ref = entry?.language ? lookup.get(String(entry.language).toLowerCase()) : null;
      return {
        ...(ref ? { language: { _id: ref.id, name: ref.name } } : { languageName: entry.language }),
        cefr: entry.cefr || null,
        overallScore: entry.overallScore || 0,
        fluency: entry.fluency || { score: 0, feedback: '' },
        grammar: entry.grammar || { score: 0, feedback: '' },
        vocabulary: entry.vocabulary || { score: 0, feedback: '' },
        coherence: entry.coherence || { score: 0, feedback: '' },
        pronunciationEstimate: entry.pronunciationEstimate || { score: 0, confidence: 'low', feedback: '' },
        strengths: entry.strengths || '',
        areasForImprovement: entry.areasForImprovement || '',
      };
    });

    return { assessable: parsed.assessable !== false, languages };
  }

  /**
   * Anti-fraud facial check: samples a few frames from the uploaded video and
   * asks GPT-4o vision to confirm a single, live, consistent human face.
   * Fails open (returns a neutral result) if anything goes wrong so a transient
   * vision error never blocks a legitimate analysis.
   */
  async detectFacesAndFraud(publicId, duration) {
    const safeDuration = typeof duration === 'number' && duration > 0 ? duration : 30;
    const offsets = [
      Math.floor(safeDuration * 0.15),
      Math.floor(safeDuration * 0.5),
      Math.floor(safeDuration * 0.85),
    ];

    const imageContent = offsets.map((offset) => ({
      type: 'image_url',
      image_url: { url: this.buildFrameUrl(publicId, offset), detail: 'low' },
    }));

    try {
      const response = await this.openai.chat.completions.create({
        model: 'gpt-4o',
        messages: [
          { role: 'system', content: FRAUD_SYSTEM_PROMPT },
          {
            role: 'user',
            content: [{ type: 'text', text: buildFraudPrompt() }, ...imageContent],
          },
        ],
        temperature: 0,
        response_format: { type: 'json_object' },
      });

      const parsed = JSON.parse(response.choices[0].message.content);
      return {
        faceDetected: parsed.faceDetected === true,
        faceCount: typeof parsed.faceCount === 'number' ? parsed.faceCount : 0,
        samePersonAcrossFrames: parsed.samePersonAcrossFrames !== false,
        looksLive: parsed.looksLive === true,
        livenessConfidence: typeof parsed.livenessConfidence === 'number' ? parsed.livenessConfidence : 0,
        fraudRisk: ['low', 'medium', 'high'].includes(parsed.fraudRisk) ? parsed.fraudRisk : 'medium',
        reasons: Array.isArray(parsed.reasons) ? parsed.reasons : [],
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
        fraudRisk: 'unknown',
        reasons: ['Anti-fraud check could not be completed'],
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

      console.log('Analyzing transcript with GPT-4o (constrained to DB vocabulary)...');
      const parsed = await this.analyzeTranscript(transcription, experienceContext, safeVocab);

      // Dedicated language assessment + anti-fraud facial check run in parallel.
      console.log('Running language assessment and anti-fraud facial check...');
      const [languageAssessment, fraudCheck] = await Promise.all([
        this.assessLanguages(transcription, parsed.detectedLanguageOfSpeech, safeVocab.languages),
        this.detectFacesAndFraud(upload.publicId, upload.duration),
      ]);

      // Enforce vocabulary server-side and persist ObjectId refs instead of names.
      return {
        videoUrl: upload.url,
        duration: upload.duration,
        transcription,
        languageAssessment,
        fraudCheck,
        analysis: {
          technicalSkills: this.resolveNamedRefs(
            parsed.technicalSkills,
            safeVocab.technicalSkills,
            'skill'
          ),
          professionalSkills: this.resolveNamedRefs(
            parsed.professionalSkills,
            safeVocab.professionalSkills,
            'skill'
          ),
          softSkills: this.resolveNamedRefs(parsed.softSkills, safeVocab.softSkills, 'skill'),
          spokenLanguages: this.resolveLanguageRefs(parsed.spokenLanguages, safeVocab.languages),
          industries: this.resolveNamedRefs(parsed.industries, safeVocab.industries, 'industry'),
          activities: this.resolveNamedRefs(parsed.activities, safeVocab.activities, 'activity'),
          contactCenterSkills: parsed.contactCenterSkills || {},
          overallConfidence: parsed.overallConfidence || 0,
          detectedLanguageOfSpeech: parsed.detectedLanguageOfSpeech || '',
          summary: parsed.summary || '',
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
