const { GoogleGenerativeAI, GoogleAIFileManager } = require('@google/generative-ai');
const fs = require('fs');
const path = require('path');
const os = require('os');

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
    this.fileManager = new GoogleAIFileManager(apiKey);
    this.model = this.genAI.getGenerativeModel({ model: 'gemini-2.0-flash' });
    this._initialized = true;
  }

  async analyzeExperienceVideo(videoBuffer, mimetype, experienceContext = {}) {
    this._ensureInitialized();
    const ext = mimetype.includes('mp4') ? 'mp4' : 'webm';
    const tmpPath = path.join(os.tmpdir(), `exp-video-${Date.now()}.${ext}`);

    try {
      fs.writeFileSync(tmpPath, videoBuffer);

      const contextStr = experienceContext.title
        ? `The person is describing their experience as "${experienceContext.title}" at "${experienceContext.company || 'a company'}".`
        : 'The person is describing their professional experience.';

      // Upload video to Gemini File API
      console.log(`Uploading video to Gemini File API (${Math.round(videoBuffer.length / 1024)}KB)...`);
      const uploadResponse = await this.fileManager.uploadFile(tmpPath, {
        mimeType: mimetype,
        displayName: `experience-${Date.now()}.${ext}`,
      });

      const fileUri = uploadResponse.file.uri;
      const uploadedMime = uploadResponse.file.mimeType;

      // Wait for file to finish processing
      await this.waitForFileActive(uploadResponse.file.name);

      console.log('Sending video to Gemini for analysis...');
      const result = await this.model.generateContent([
        {
          fileData: {
            mimeType: uploadedMime,
            fileUri,
          },
        },
        { text: ANALYSIS_PROMPT(contextStr) },
      ]);

      const rawText = result.response.text().trim();

      // Delete uploaded file from Gemini after analysis
      this.fileManager.deleteFile(uploadResponse.file.name).catch(() => {});

      // Parse JSON — strip markdown code fences if present
      const cleaned = rawText.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
      const parsed = JSON.parse(cleaned);

      return {
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

  async waitForFileActive(fileName, maxWaitMs = 60000, pollMs = 2000) {
    const deadline = Date.now() + maxWaitMs;
    while (Date.now() < deadline) {
      const file = await this.fileManager.getFile(fileName);
      if (file.state === 'ACTIVE') return;
      if (file.state === 'FAILED') throw new Error('Gemini file processing failed');
      await new Promise((r) => setTimeout(r, pollMs));
    }
    throw new Error('Gemini file processing timed out');
  }
}

module.exports = VideoAnalysisService;
