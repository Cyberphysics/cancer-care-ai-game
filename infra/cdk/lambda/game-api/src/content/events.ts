import type { EventTemplate, StageKey } from '../types';

/**
 * The event catalog.
 *
 * Pure data. The rule engine receives this as a parameter rather than importing
 * it directly, so relocating the catalog to S3 later is a one-line change at the
 * composition root (`handlers.ts`) and nothing in `domain/` is touched.
 *
 * **Content rules (GDD §16):** health education only. No diagnosis, no treatment
 * recommendations, no drug names, no survival figures. Every rationale explains
 * a *concept*; none of them tells the player what to do medically. The lessons
 * are about caregiving behaviour — noticing symptoms, keeping records, arranging
 * follow-up, managing nutrition and mood — which is what the player actually
 * controls.
 *
 * Impact values are game mechanics, not clinical estimates. They encode "this
 * choice tends to help / hurt the caregiver's situation" and nothing more.
 */
export const EVENT_CATALOG: readonly EventTemplate[] = [
  /* ---------------------------- Prevention ---------------------------- */
  {
    id: 'prev-persistent-cough',
    stage: 'prevention',
    type: 'medical',
    title: '持续咳嗽两个月',
    description:
      '咳嗽已经持续两个月，偶尔还觉得胸闷。对方说「可能是天气干燥」，但你也注意到最近精神不太好。',
    choices: [
      {
        id: 'A',
        text: '认为只是小问题，继续观察',
        impact: { qualityOfLife: -5, energy: -4, stress: 10 },
        score: 0,
        rationale:
          '持续数周不缓解的咳嗽值得认真对待。症状本身不代表严重疾病，但「先等等看」会让后续选择的空间变小。',
      },
      {
        id: 'B',
        text: '预约医院做进一步检查',
        impact: { qualityOfLife: 5, energy: -3, stress: 8 },
        score: 20,
        rationale:
          '对长期吸烟者而言，出现持续呼吸道症状时及时就医评估是合理的。检查会带来一点紧张和奔波，但能换来确定的信息。',
      },
      {
        id: 'C',
        text: '自行购买止咳药',
        impact: { qualityOfLife: -2, stress: 5, nutrition: -3 },
        score: -5,
        rationale:
          '自行用药可能暂时掩盖症状，让真正需要关注的问题被推迟。缓解症状和查明原因是两件事。',
      },
    ],
  },
  {
    id: 'prev-lifestyle-plan',
    stage: 'prevention',
    type: 'care',
    title: '一起调整生活习惯',
    description: '医生提到生活方式与长期健康有关。对方抽了很多年烟，也几乎不运动。',
    choices: [
      {
        id: 'A',
        text: '和家人一起制定戒烟与活动计划，分阶段执行',
        impact: { qualityOfLife: 8, energy: 5, stress: -3, nutrition: 5 },
        score: 20,
        rationale:
          '行为改变最难的是坚持，而分阶段的小目标配合家人陪伴，比一次性的决心更容易维持。',
      },
      {
        id: 'B',
        text: '口头提醒对方少抽一点',
        impact: { stress: 2 },
        score: 5,
        rationale: '口头提醒成本低，但缺少具体安排时通常难以转化为持续的改变。',
      },
      {
        id: 'C',
        text: '觉得这是个人习惯，旁人帮不上忙',
        impact: { qualityOfLife: -3, stress: 5 },
        score: 0,
        rationale: '家庭支持是行为改变的重要外部条件。放弃介入等于放弃了这部分资源。',
      },
    ],
  },

  /* ----------------------------- Screening ---------------------------- */
  {
    id: 'screen-abnormal-imaging',
    stage: 'screening',
    type: 'medical',
    title: '体检发现肺部异常影像',
    description:
      '体检报告提示肺部有异常影像，建议进一步检查。报告上有很多不熟悉的术语，家里人对「要不要马上查」意见不一。',
    choices: [
      {
        id: 'A',
        text: '按建议预约低剂量螺旋 CT 进一步评估',
        impact: { qualityOfLife: 3, stress: 10 },
        score: 20,
        rationale:
          '低剂量螺旋 CT 是国际上用于肺癌高危人群筛查的常用手段之一。影像异常不等于确诊，进一步检查是为了把它弄清楚。',
      },
      {
        id: 'B',
        text: '先观察半年再复查',
        impact: { qualityOfLife: -5, stress: 5 },
        score: 0,
        rationale: '推迟复查会让不确定性持续存在，也可能错过更容易处理的时机。',
      },
      {
        id: 'C',
        text: '换一家医院重新做一遍',
        impact: { qualityOfLife: -1, stress: 8, energy: -4 },
        score: 10,
        rationale:
          '寻求第二意见是合理的，但单纯重复同类检查而不推进诊断路径，会增加时间和精力成本。',
      },
    ],
  },
  {
    id: 'screen-organize-records',
    stage: 'screening',
    type: 'care',
    title: '资料开始变多了',
    description: '化验单、影像报告、缴费凭证……几次检查下来，纸质和电子资料散落各处。',
    choices: [
      {
        id: 'A',
        text: '按时间顺序建一个资料档案，记录关键结论',
        impact: { qualityOfLife: 2, stress: -6 },
        score: 15,
        rationale:
          '就诊时能快速提供完整的既往资料，会显著减少重复检查和沟通成本。这是家属能提供的、最实际的帮助之一。',
      },
      {
        id: 'B',
        text: '先都放在一个袋子里',
        impact: { stress: 3 },
        score: 0,
        rationale: '集中存放比散落好，但在需要快速翻找时仍然会很吃力。',
      },
    ],
  },
  {
    id: 'screen-further-test',
    stage: 'screening',
    type: 'medical',
    title: '医生建议做进一步检查',
    description: '医生建议做活检以明确病变性质。家里人听到「活检」两个字有些紧张。',
    choices: [
      {
        id: 'A',
        text: '先向医生了解流程和注意事项，再安排时间',
        impact: { qualityOfLife: 3, stress: 7 },
        score: 20,
        rationale:
          '活检是获取组织学诊断的常规手段。事先了解流程、风险和准备事项，能明显降低未知带来的焦虑。',
      },
      {
        id: 'B',
        text: '因为害怕，一拖再拖',
        impact: { qualityOfLife: -8, stress: 12 },
        score: 0,
        rationale: '回避不会让不确定性消失，只会让等待的这段时间更难熬。',
      },
    ],
  },

  /* ----------------------------- Diagnosis ---------------------------- */
  {
    id: 'diag-understand-result',
    stage: 'diagnosis',
    type: 'medical',
    title: '需要弄懂病理报告',
    description: '病理结果出来了，报告上有分型、分期等专业术语。家里人各自上网查，越查越慌。',
    choices: [
      {
        id: 'A',
        text: '带好问题清单，请医生逐条解释',
        impact: { qualityOfLife: 5, stress: -4 },
        score: 20,
        rationale:
          '分型和分期描述的是疾病特征，用于指导后续的诊疗安排。由主诊医生结合具体病情解释，比碎片化的网络信息可靠得多。',
      },
      {
        id: 'B',
        text: '在网上自行搜索各种说法',
        impact: { qualityOfLife: -5, stress: 12 },
        score: 0,
        rationale:
          '网络信息往往脱离具体病情，且容易接触到极端案例，通常会让焦虑放大而不是减少。',
      },
    ],
  },
  {
    id: 'diag-family-communication',
    stage: 'diagnosis',
    type: 'emotion',
    title: '要不要告诉家人',
    description: '确诊之后，家里在「怎么跟患者说、跟谁说」这件事上没有共识。',
    choices: [
      {
        id: 'A',
        text: '在充分了解情况后，选择合适的方式坦诚沟通',
        impact: { qualityOfLife: 6, stress: -8 },
        score: 20,
        rationale:
          '坦诚且循序渐进的沟通，通常比隐瞒更有利于后续的配合与情绪支持。患者往往比家人以为的更能承受信息。',
      },
      {
        id: 'B',
        text: '自己一个人扛着，不告诉其他人',
        impact: { qualityOfLife: -6, stress: 12 },
        score: 0,
        rationale:
          '独自承担会同时消耗照护者的精力和患者的支持来源。照护者的情绪耗竭是真实存在的风险。',
      },
    ],
  },

  /* ----------------------------- Treatment ---------------------------- */
  {
    id: 'treat-medication-records',
    stage: 'treatment',
    type: 'care',
    title: '治疗开始，记录变得重要',
    description: '治疗进入日程化阶段，复诊、检查、用药的时间点越来越多。',
    choices: [
      {
        id: 'A',
        text: '建立用药与复诊记录表，每次就诊后更新',
        impact: { qualityOfLife: 3, stress: -7 },
        score: 20,
        rationale:
          '清晰的记录能让医生快速掌握用药与反应情况，也减少家属之间交接时的信息遗漏。',
      },
      {
        id: 'B',
        text: '凭记忆，到时间再说',
        impact: { qualityOfLife: -3, stress: 6 },
        score: 0,
        rationale: '治疗周期往往较长，依靠记忆在多个环节并行时很容易出错。',
      },
    ],
  },
  {
    id: 'treat-nutrition',
    stage: 'treatment',
    type: 'care',
    title: '治疗期间的吃饭问题',
    description: '治疗期间胃口变差，家里人想着「好好补一补」。',
    choices: [
      {
        id: 'A',
        text: '咨询营养门诊，调整成少量多餐、易消化的安排',
        impact: { qualityOfLife: 5, nutrition: 10, energy: 5 },
        score: 20,
        rationale:
          '治疗期间的营养重点是维持体重和耐受性。少食多餐、选择易消化的食物，通常比集中进补更有效。',
      },
      {
        id: 'B',
        text: '多炖补品，劝对方多吃一点',
        impact: { qualityOfLife: -3, nutrition: -5, stress: 3 },
        score: -5,
        rationale:
          '在不了解具体情况时大量进补，可能加重胃肠负担，也可能与治疗安排冲突。营养方案应当个体化。',
      },
    ],
  },
  {
    id: 'treat-emotional-support',
    stage: 'treatment',
    type: 'emotion',
    title: '情绪的低谷',
    description: '治疗一段时间后，患者变得不爱说话，家里人也疲惫不堪。',
    choices: [
      {
        id: 'A',
        text: '一起散步、聊天，必要时寻求心理支持',
        impact: { qualityOfLife: 6, stress: -10, energy: 5 },
        score: 20,
        rationale:
          '适度的活动与陪伴对情绪有帮助；当低落持续存在时，专业的心理支持是有效且常见的资源，不必回避。',
      },
      {
        id: 'B',
        text: '大家都避开这个话题',
        impact: { qualityOfLife: -5, stress: 10 },
        score: 0,
        rationale: '回避会让情绪缺少出口，长期积累往往表现为更大的冲突或更深的耗竭。',
      },
    ],
  },

  /* ----------------------------- Recovery ----------------------------- */
  {
    id: 'recover-sleep-routine',
    stage: 'recovery',
    type: 'care',
    title: '把作息调回来',
    description: '治疗告一段落，但长期的作息紊乱还没调整过来。',
    choices: [
      {
        id: 'A',
        text: '固定起居时间，睡前减少屏幕使用',
        impact: { qualityOfLife: 5, energy: 8, stress: -5 },
        score: 15,
        rationale: '规律作息是康复期恢复体能和情绪的基础，也是最容易被忽略的一环。',
      },
      {
        id: 'B',
        text: '顺其自然，睡到什么时候算什么',
        impact: { energy: -6, stress: 5 },
        score: 0,
        rationale: '长期不规律的作息会持续消耗精力，延缓整体恢复。',
      },
    ],
  },
  {
    id: 'recover-follow-up',
    stage: 'recovery',
    type: 'medical',
    title: '定期复查的安排',
    description: '医生交代了复查计划。最近感觉还不错，家里人开始犹豫还要不要按时去。',
    choices: [
      {
        id: 'A',
        text: '按计划安排复查，并把结果归档',
        impact: { qualityOfLife: 4, stress: -5 },
        score: 20,
        rationale:
          '康复期的定期随访是诊疗计划的一部分，目的是及时发现变化。感觉良好并不替代规律复查。',
      },
      {
        id: 'B',
        text: '感觉没事，这次先不去了',
        impact: { qualityOfLife: -6, stress: 4 },
        score: 0,
        rationale: '随访的价值恰恰在于症状出现之前发现问题，跳过复查等于放弃了这项保障。',
      },
    ],
  },
  {
    id: 'recover-family-rota',
    stage: 'recovery',
    type: 'emotion',
    title: '长期照护的可持续性',
    description: '照护已经持续了很长时间，主要照护者的疲惫越来越明显。',
    choices: [
      {
        id: 'A',
        text: '和家人商量轮换安排，给彼此留出休息时间',
        impact: { qualityOfLife: 6, stress: -8 },
        score: 15,
        rationale:
          '照护是一场长跑。排班与轮换能让支持持续下去，避免主要照护者先垮掉。',
      },
      {
        id: 'B',
        text: '觉得自己照顾才放心，继续一个人撑',
        impact: { qualityOfLife: -4, stress: 8 },
        score: 0,
        rationale: '长期单人照护容易导致耗竭，反而会影响照护质量本身。',
      },
    ],
  },
] as const;

export function eventsForStage(stage: StageKey): readonly EventTemplate[] {
  return EVENT_CATALOG.filter((event) => event.stage === stage);
}

export function findEventTemplate(id: string): EventTemplate | undefined {
  return EVENT_CATALOG.find((event) => event.id === id);
}

/** Player-facing reminder that this is an educational game, not medical advice. */
export const DISCLAIMER =
  '本内容仅用于健康教育，不构成诊断或治疗建议。所有病例均为合成案例，请勿据此做医疗决策。';
