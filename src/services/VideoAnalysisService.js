const OpenAI = require('openai');
const cloudinary = require('cloudinary').v2;
const fs = require('fs');
const path = require('path');
const os = require('os');
const VocabularyService = require('./VocabularyService');

const MAX_VIDEO_BYTES = 25 * 1024 * 1024;

const renderAllowedList = (label, names) => {
  if (!Array.isArray(names) || names.length === 0) {
    return `${label}: (no predefined list provided — return an empty array for this field)`;
  }
  return `${label} (choose ONLY from these exact names, copy them verbatim):\n${names.map((n) => `- ${n}`).join('\n')}`;
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
          resolve(result.secure_url);
        }
      );
    });
  }

  async transcribeAudio(filePath) {
    const response = await this.openai.audio.transcriptions.create({
      file: fs.createReadStream(filePath),
      model: 'whisper-1',
      response_format: 'text',
    });
    return typeof response === 'string' ? response.trim() : String(response).trim();
  }

  // Keep only AI items whose name is in the allowed list (exact, case-insensitive).
  filterToAllowed(items, allowedNames) {
    if (!Array.isArray(items)) return [];
    if (!Array.isArray(allowedNames) || allowedNames.length === 0) return [];
    const allowedByLower = new Map(allowedNames.map((n) => [String(n).toLowerCase(), String(n)]));
    return items
      .filter((item) => item && item.name && allowedByLower.has(String(item.name).toLowerCase()))
      .map((item) => ({ ...item, name: allowedByLower.get(String(item.name).toLowerCase()) }));
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
      };
    }

    const ext = mimetype.includes('mp4') ? 'mp4' : 'webm';
    const tmpPath = path.join(os.tmpdir(), `exp-video-${Date.now()}.${ext}`);

    try {
      fs.writeFileSync(tmpPath, videoBuffer);

      console.log(`Uploading video to Cloudinary (${Math.round(videoBuffer.length / 1024)}KB)...`);
      const videoUrl = await this.uploadToCloudinary(tmpPath);

      console.log('Transcribing audio with Whisper...');
      const transcription = await this.transcribeAudio(tmpPath);

      console.log('Analyzing transcript with GPT-4o (constrained to DB vocabulary)...');
      const parsed = await this.analyzeTranscript(transcription, experienceContext, safeVocab);

      // Enforce the vocabulary server-side as a safety net against the model drifting.
      return {
        videoUrl,
        transcription,
        analysis: {
          technicalSkills: this.filterToAllowed(parsed.technicalSkills, safeVocab.technicalSkills),
          professionalSkills: this.filterToAllowed(parsed.professionalSkills, safeVocab.professionalSkills),
          softSkills: this.filterToAllowed(parsed.softSkills, safeVocab.softSkills),
          spokenLanguages: parsed.spokenLanguages || [],
          industries: this.filterToAllowed(parsed.industries, safeVocab.industries),
          activities: this.filterToAllowed(parsed.activities, safeVocab.activities),
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
    }
  }
}

module.exports = VideoAnalysisService;
