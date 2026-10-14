import {
  findViolations,
  isSafe,
  SAFE_FALLBACK,
  sanitize,
} from '../../lambda/game-api/src/domain/safety';

/**
 * The same example strings are run through the Python guard in
 * `agents/game-master/tests/test_safety.py`. The two implementations exist in
 * different languages and cannot share code, so agreeing on *behaviour* is what
 * keeps them from drifting — and behaviour is what actually matters.
 *
 * If you add a case here, add it there.
 */

describe('allowed — concepts, not prescriptions', () => {
  test('educational concepts pass', () => {
    const text =
      '低剂量螺旋 CT 是常用的肺癌筛查手段。病理检查用于明确病变性质。' +
      '靶向治疗和免疫治疗是近年来发展的治疗方向，是否适用需由医生结合具体病情判断。';
    expect(isSafe(text)).toBe(true);
  });

  test('encouraging a medical consultation passes', () => {
    expect(isSafe('建议尽快咨询专业医生，由医生评估后决定下一步检查。')).toBe(true);
  });

  test('a duration that is not a percentage passes', () => {
    // The dosage rule must not swallow ordinary numbers.
    expect(isSafe('治疗通常按周期进行，一个周期可能是 21 天。')).toBe(true);
  });
});

describe('rejected', () => {
  test('percentage figures', () => {
    expect(findViolations('五年生存率约为 32%')).toContain('百分比数字（可能是生存率或治愈率）');
  });

  test('survival language without a number', () => {
    expect(findViolations('这种情况的生存率并不乐观').length).toBeGreaterThan(0);
  });

  test('drug names and dosages', () => {
    expect(findViolations('可以服用奥希替尼').length).toBeGreaterThan(0);
    expect(findViolations('每日服用 80 毫克').length).toBeGreaterThan(0);
    expect(findViolations('剂量为 500mg').length).toBeGreaterThan(0);
  });

  test('treatment recommendations', () => {
    expect(findViolations('建议使用靶向治疗').length).toBeGreaterThan(0);
    expect(findViolations('推荐服用中药调理').length).toBeGreaterThan(0);
  });

  test('diagnosis assertions', () => {
    expect(findViolations('您患有早期肺癌').length).toBeGreaterThan(0);
    expect(findViolations('确诊为肺腺癌').length).toBeGreaterThan(0);
  });

  test('every broken rule is named, not just the first', () => {
    const violations = findViolations('您患有肺癌，生存率约 30%，建议服用奥希替尼');
    expect(violations.length).toBeGreaterThanOrEqual(3);
  });
});

describe('sanitize', () => {
  test('passes clean text through untouched', () => {
    expect(sanitize('一段合规的解释。')).toEqual({ text: '一段合规的解释。', degraded: false });
  });

  test('substitutes the fallback and flags it', () => {
    const result = sanitize('生存率约 30%');
    expect(result.degraded).toBe(true);
    expect(result.text).toBe(SAFE_FALLBACK);
  });

  test('the fallback itself is clean', () => {
    // Otherwise a guard failure would recurse.
    expect(isSafe(SAFE_FALLBACK)).toBe(true);
  });
});
