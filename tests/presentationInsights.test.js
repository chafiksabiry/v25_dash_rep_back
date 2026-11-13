const mongoose = require('mongoose');
const {
  rebuildProfileVideoInsights,
  VIDEO_SKILL_DETAILS,
} = require('../src/services/VideoInsightsService');

const oid = () => new mongoose.Types.ObjectId();
const ids = { sales: oid(), excel: oid(), empathy: oid(), telecom: oid(), support: oid(), en: oid(), fr: oid() };

const presentation = (analysis, extra = {}) => ({
  analyzedVideoUrl: 'https://cdn.example/pres.mp4',
  analysis,
  languageAssessment: {},
  ...extra,
});

const fullAnalysis = () => ({
  technicalSkills: [{ skill: ids.excel, score: 70 }],
  professionalSkills: [{ skill: ids.sales, score: 85 }],
  softSkills: [{ skill: ids.empathy, score: 60 }],
  industries: [{ industry: ids.telecom, score: 80 }],
  activities: [{ activity: ids.support, score: 80 }],
  spokenLanguages: [{ language: ids.en, level: 'C1', score: 85 }],
});

const ensure = (set, key) => (set[key] === undefined ? [] : set[key]);

describe('presentation video → profile merge', () => {
  test('proposes detected skills, sectors, activities and languages', () => {
    const agent = { personalInfo: { presentationVideo: presentation(fullAnalysis()) } };
    const set = rebuildProfileVideoInsights(agent);

    expect(set.proposedSkills.technical.map((s) => String(s.skill))).toEqual([String(ids.excel)]);
    expect(set.proposedSkills.professional.map((s) => String(s.skill))).toEqual([String(ids.sales)]);
    expect(set.proposedSkills.soft.map((s) => String(s.skill))).toEqual([String(ids.empathy)]);
    expect(set['professionalSummary.industries'].map(String)).toEqual([String(ids.telecom)]);
    expect(set['professionalSummary.activities'].map(String)).toEqual([String(ids.support)]);
    const langs = set['personalInfo.languages'];
    expect(langs).toHaveLength(1);
    expect(String(langs[0].language)).toBe(String(ids.en));
    expect(langs[0].proficiency).toBe('C1');
    expect(langs[0].assessmentResults.experienceIndex).toBeNull();
  });

  test('merges without duplicates and without overwriting existing data', () => {
    const agent = {
      skills: { professional: [{ skill: ids.sales, level: 2, details: 'manual' }], technical: [], soft: [] },
      professionalSummary: { industries: [ids.telecom], activities: [] },
      personalInfo: {
        languages: [{ language: ids.en, proficiency: 'B2' }, { language: ids.fr, proficiency: 'C2' }],
        presentationVideo: presentation(fullAnalysis()),
      },
    };
    const set = rebuildProfileVideoInsights(agent);

    // Existing confirmed skill kept (single entry, level raised only), not re-proposed.
    expect(set['skills.professional']).toHaveLength(1);
    expect(set['skills.professional'][0].details).toBe('manual');
    expect(set['skills.professional'][0].level).toBeGreaterThanOrEqual(2);
    expect(set.proposedSkills.professional).toHaveLength(0);
    // Industry not duplicated.
    expect(set['professionalSummary.industries']).toHaveLength(1);
    // Languages: existing FR untouched, EN kept once with the higher level (B2 → C1).
    const langs = set['personalInfo.languages'];
    expect(langs).toHaveLength(2);
    expect(langs.find((l) => String(l.language) === String(ids.fr)).proficiency).toBe('C2');
    expect(langs.find((l) => String(l.language) === String(ids.en)).proficiency).toBe('C1');
  });

  test('never lowers an existing language level', () => {
    const agent = {
      personalInfo: {
        languages: [{ language: ids.en, proficiency: 'C2' }],
        presentationVideo: presentation({
          ...fullAnalysis(),
          spokenLanguages: [{ language: ids.en, level: 'B1', score: 55 }],
        }),
      },
    };
    const set = rebuildProfileVideoInsights(agent);
    expect(set['personalInfo.languages'][0].proficiency).toBe('C2');
  });

  test('empty presentation changes nothing on the profile', () => {
    const agent = {
      personalInfo: {
        languages: [{ language: ids.fr, proficiency: 'C2' }],
        presentationVideo: presentation({
          technicalSkills: [], professionalSkills: [], softSkills: [],
          industries: [], activities: [], spokenLanguages: [],
        }),
      },
      professionalSummary: { industries: [ids.telecom] },
    };
    const set = rebuildProfileVideoInsights(agent);
    expect(set['personalInfo.languages']).toBeUndefined();
    expect(set['professionalSummary.industries']).toBeUndefined();
    expect(set['professionalSummary.activities']).toBeUndefined();
    expect(set.proposedSkills).toEqual({ technical: [], professional: [], soft: [] });
  });

  test('legacy string presentationVideo: analysis read from the sibling field', () => {
    const agent = {
      personalInfo: {
        presentationVideo: 'https://cdn.example/legacy.mp4',
        presentationVideoAnalysis: presentation(fullAnalysis()),
      },
    };
    expect(rebuildProfileVideoInsights(agent).proposedSkills.professional).toHaveLength(1);
  });

  test('presentation survives an experience analysis and vice versa (same skill → one entry)', () => {
    const agent = {
      experience: [
        {
          videoUrl: 'https://cdn.example/exp.mp4',
          videoAnalysis: { professionalSkills: [{ skill: ids.sales, score: 95 }], technicalSkills: [{ skill: ids.excel, score: 40 }] },
        },
      ],
      personalInfo: { presentationVideo: presentation(fullAnalysis()) },
    };
    const set = rebuildProfileVideoInsights(agent);
    expect(set.proposedSkills.professional).toHaveLength(1);
    expect(set.proposedSkills.technical).toHaveLength(1);
    expect(set.proposedSkills.soft).toHaveLength(1); // only from the presentation
  });

  test('keeps non-video proposals (e.g. CV import) and does not duplicate them', () => {
    const agent = {
      proposedSkills: {
        technical: [{ skill: ids.excel, level: 4, details: 'From CV' }],
        professional: [{ skill: oid(), level: 3, details: 'From CV' }],
        soft: [{ skill: ids.empathy, level: 1, details: VIDEO_SKILL_DETAILS }],
      },
      personalInfo: { presentationVideo: presentation(fullAnalysis()) },
    };
    const set = rebuildProfileVideoInsights(agent);
    expect(set.proposedSkills.technical).toHaveLength(1);
    expect(set.proposedSkills.technical[0].level).toBe(4); // higher CV level kept
    expect(set.proposedSkills.professional).toHaveLength(2); // CV one + detected
    expect(set.proposedSkills.soft).toHaveLength(1); // stale video proposal rebuilt, not duplicated
  });

  test('no presentation and no experience: nothing detected, nothing lost', () => {
    const set = rebuildProfileVideoInsights({ personalInfo: {} });
    expect(set['personalInfo.languages']).toBeUndefined();
    expect(ensure(set, 'skills.technical')).toEqual([]);
  });
});
