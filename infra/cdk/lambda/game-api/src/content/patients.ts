import type { PatientTemplate } from '../types';

/**
 * Synthetic case templates.
 *
 * **Every case here is fabricated.** GDD §16 forbids real patient data, and this
 * is the only place in the codebase where patient details originate. Nothing in
 * this file is drawn from a real person.
 *
 * The risk factors are chosen to be epidemiologically plausible so the
 * educational content that follows has something to hook onto — not to imply
 * that any particular lifestyle causes cancer in any particular individual.
 */
export const PATIENT_TEMPLATES: readonly PatientTemplate[] = [
  {
    id: 'case-wang-55-m',
    profile: {
      // The case from the GDD (§4, Stage 1) — the default for demos.
      displayName: '王先生',
      age: 55,
      gender: 'male',
      occupation: '办公室职员',
      riskFactors: ['长期吸烟', '缺少运动', '饮食不规律'],
    },
    initialHealth: { qualityOfLife: 70, energy: 62, stress: 28, nutrition: 65 },
    initialFamilySupport: 60,
    openingNote: '王先生最近持续咳嗽，家人开始留意他的状态。',
  },
  {
    id: 'case-li-62-f',
    profile: {
      displayName: '李女士',
      age: 62,
      gender: 'female',
      occupation: '退休教师',
      riskFactors: ['长期二手烟暴露', '厨房油烟', '家族史'],
    },
    initialHealth: { qualityOfLife: 74, energy: 58, stress: 34, nutrition: 72 },
    initialFamilySupport: 75,
    openingNote: '李女士从不吸烟，但家中长期有人吸烟，最近体检有些异常。',
  },
  {
    id: 'case-zhang-48-m',
    profile: {
      displayName: '张先生',
      age: 48,
      gender: 'male',
      occupation: '网约车司机',
      riskFactors: ['吸烟', '长期户外空气污染暴露', '作息不规律'],
    },
    initialHealth: { qualityOfLife: 66, energy: 70, stress: 40, nutrition: 55 },
    initialFamilySupport: 50,
    openingNote: '张先生工作节奏紧张，长期在车内，作息很不规律。',
  },
] as const;

export const DEFAULT_PATIENT_TEMPLATE_ID = PATIENT_TEMPLATES[0].id;

export function findPatientTemplate(id: string): PatientTemplate | undefined {
  return PATIENT_TEMPLATES.find((template) => template.id === id);
}

/**
 * Picks a template without randomness.
 *
 * Deterministic selection keeps demos reproducible and keeps the rule engine
 * fully testable — a random case would make every assertion flaky.
 */
export function pickPatientTemplate(seed: string): PatientTemplate {
  let hash = 0;
  for (let i = 0; i < seed.length; i += 1) {
    hash = (hash * 31 + seed.charCodeAt(i)) | 0;
  }
  return PATIENT_TEMPLATES[Math.abs(hash) % PATIENT_TEMPLATES.length];
}
