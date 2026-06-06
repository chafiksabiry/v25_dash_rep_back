const OpenAI = require('openai');
const cloudinary = require('cloudinary').v2;
const fs = require('fs');
const path = require('path');
const os = require('os');

const MAX_VIDEO_BYTES = 25 * 1024 * 1024;

const ANALYSIS_PROMPT = (contextStr, transcription) => `You are an expert HR analyst and skills assessor. ${contextStr}

Analyze the following video transcript from a professional experience description and extract structured data.

TRANSCRIPT:
"${transcription || '[No speech detected — infer from context if provided]'}"

Return ONLY a valid JSON object with this exact structure (no markdown, no code blocks):
{
  "technicalSkills": [
    { "name": "string", "score": 0-100, "evidence": "brief quote or reason" }
  ],
  "spokenLanguages": [
    { "language": "string", "level": "A1|A2|B1|B2|C1|C2|Native", "score": 0-100, "evidence": "reason" }
  ],
  "industries": [
    { "name": "string", "score": 0-100 }
  ],
  "activities": [
    { "name": "string", "score": 0-100 }
  ],
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
- Score 0 = not detected / not applicable
- Score 100 = expert-level, strongly evidenced
- Clear mention with detail → 70+
- Vague mention → 30-60
- For spokenLanguages: detect ALL languages actually spoken
- For contactCenterSkills: infer transferable scores even for non-contact-center roles
- Return pure JSON only, nothing else`;

class VideoAnalysisService {
  constructor() {
    this._initialized = false;
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

  async analyzeTranscript(transcription, experienceContext) {
    const contextStr = experienceContext.title
      ? `The person is describing their experience as "${experienceContext.title}" at "${experienceContext.company || 'a company'}".`
      : 'The person is describing their professional experience.';

    const response = await this.openai.chat.completions.create({
      model: 'gpt-4o',
      messages: [
        {
          role: 'system',
          content: 'You are a JSON-only API. Return only valid JSON, no markdown code blocks, no explanations.',
        },
        {
          role: 'user',
          content: ANALYSIS_PROMPT(contextStr, transcription),
        },
      ],
      temperature: 0.3,
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

    const ext = mimetype.includes('mp4') ? 'mp4' : 'webm';
    const tmpPath = path.join(os.tmpdir(), `exp-video-${Date.now()}.${ext}`);

    try {
      fs.writeFileSync(tmpPath, videoBuffer);

      console.log(`Uploading video to Cloudinary (${Math.round(videoBuffer.length / 1024)}KB)...`);
      const videoUrl = await this.uploadToCloudinary(tmpPath);

      console.log('Transcribing audio with Whisper...');
      const transcription = await this.transcribeAudio(tmpPath);

      console.log('Analyzing transcript with GPT-4o...');
      const parsed = await this.analyzeTranscript(transcription, experienceContext);

      return {
        videoUrl,
        transcription,
        analysis: {
          technicalSkills: parsed.technicalSkills || [],
          spokenLanguages: parsed.spokenLanguages || [],
          industries: parsed.industries || [],
          activities: parsed.activities || [],
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
