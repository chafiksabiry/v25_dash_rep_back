const { GoogleGenerativeAI } = require('@google/generative-ai');
const cloudinary = require('cloudinary').v2;
const fs = require('fs');
const path = require('path');
const os = require('os');

// Gemini inline video limit (~20 MB); experience clips are capped at 2 min.
const MAX_INLINE_VIDEO_BYTES = 15 * 1024 * 1024;

const ANALYSIS_PROMPT = (contextStr) => `You are an expert HR analyst and skills assessor. ${contextStr}

Analyze this video where a professional describes their work experience.

Extract and score ALL of the following from what the person says and how they say it:

Return ONLY a valid JSON object with this exact structure (no markdown, no code blocks):
{
  "transcription": "full verbatim transcription of what was said",
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
- For spokenLanguages: detect ALL languages actually spoken in the video
- For contactCenterSkills: infer transferable scores even for non-contact-center roles
- Return pure JSON only, nothing else`;

class VideoAnalysisService {
  constructor() {
    this._initialized = false;
  }

  _ensureInitialized() {
    if (this._initialized) return;

    const apiKey = process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY;
    if (!apiKey) {
      throw new Error('GOOGLE_API_KEY or GEMINI_API_KEY environment variable is not set');
    }

    this.genAI = new GoogleGenerativeAI(apiKey);
    this.model = this.genAI.getGenerativeModel({ model: 'gemini-2.0-flash' });

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

  async analyzeExperienceVideo(videoBuffer, mimetype, experienceContext = {}) {
    this._ensureInitialized();

    if (videoBuffer.length > MAX_INLINE_VIDEO_BYTES) {
      throw new Error(
        `Video is too large for analysis (${Math.round(videoBuffer.length / 1024 / 1024)}MB). Maximum is ${Math.round(MAX_INLINE_VIDEO_BYTES / 1024 / 1024)}MB.`
      );
    }

    const ext = mimetype.includes('mp4') ? 'mp4' : 'webm';
    const tmpPath = path.join(os.tmpdir(), `exp-video-${Date.now()}.${ext}`);

    try {
      fs.writeFileSync(tmpPath, videoBuffer);

      const contextStr = experienceContext.title
        ? `The person is describing their experience as "${experienceContext.title}" at "${experienceContext.company || 'a company'}".`
        : 'The person is describing their professional experience.';

      console.log(`Uploading video to Cloudinary (${Math.round(videoBuffer.length / 1024)}KB)...`);
      const videoUrl = await this.uploadToCloudinary(tmpPath);

      console.log('Sending video to Gemini for inline analysis...');
      const result = await this.model.generateContent([
        {
          inlineData: {
            mimeType: mimetype,
            data: videoBuffer.toString('base64'),
          },
        },
        { text: ANALYSIS_PROMPT(contextStr) },
      ]);

      const rawText = result.response.text().trim();
      const cleaned = rawText.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
      const parsed = JSON.parse(cleaned);

      return {
        videoUrl,
        transcription: parsed.transcription || '',
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
      };
    } finally {
      if (fs.existsSync(tmpPath)) {
        fs.unlinkSync(tmpPath);
      }
    }
  }
}

module.exports = VideoAnalysisService;
