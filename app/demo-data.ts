export type Severity = 'info' | 'warning' | 'critical' | 'success';
export type EventType =
  | 'smalltalk'
  | 'off_topic'
  | 'interrupt'
  | 'repeat'
  | 'disagreement'
  | 'time'
  | 'decision';

export type Speaker = {
  id: string;
  name: string;
  short: string;
  role: string;
  color: string;
  isPriority?: boolean;
};

export type TranscriptLine = {
  id: string;
  at: number;
  end: number;
  speakerId: string;
  text: string;
  topic: string;
  workRelated: boolean;
  interrupted?: boolean;
};

export type Intervention = {
  id: string;
  at: number;
  type: EventType;
  severity: Severity;
  label: string;
  observation: string;
  impact: string;
  suggestion: string;
  evidence: string;
  voice?: string;
  actions?: Array<'adopt' | 'park' | 'ignore'>;
};

export type MeetingConfig = {
  title: string;
  durationSeconds: number;
  meetingType: string;
  agenda: string[];
  attendees: Speaker[];
  prioritySpeakerId: string;
  contextUrl?: string;
};

export const SPEAKERS: Speaker[] = [
  { id: 'host', name: '刘主持', short: '刘', role: '主持人 · 拍板人', color: '#59e1ff' },
  { id: 'boss', name: '周总', short: '周', role: '高优先级角色', color: '#ffc857', isPriority: true },
  { id: 'engineer', name: '王工', short: '王', role: '技术负责人', color: '#a8f05a' },
  { id: 'designer', name: '郭设计', short: '郭', role: '交互负责人', color: '#a994ff' },
  { id: 'observer', name: '黄观察', short: '黄', role: '列席观察', color: '#ff8297' },
];

export const DEFAULT_CONFIG: MeetingConfig = {
  title: '确定「会议催催助手」现场 Demo 方案',
  durationSeconds: 100,
  meetingType: '方案决策会',
  agenda: ['确定演示链路：纯实时或实时 + 兜底', '明确负责人和联调时间'],
  attendees: SPEAKERS,
  prioritySpeakerId: 'boss',
  contextUrl: '',
};

export const DEMO_SCRIPT: TranscriptLine[] = [
  { id: 't01', at: 0, end: 6, speakerId: 'host', text: '今天只定一件事：会议催催 Demo 怎么演，100 秒内结束。', topic: '会议开场', workRelated: true },
  { id: 't02', at: 6, end: 12, speakerId: 'engineer', text: '实时转写已经跑通，但现场网络还有波动风险。', topic: '演示链路', workRelated: true },
  { id: 't03', at: 12, end: 17, speakerId: 'observer', text: '先说个题外话，中午去新开的烧肉店吗？', topic: '午饭闲聊', workRelated: false },
  { id: 't04', at: 17, end: 23, speakerId: 'designer', text: '听说排队很久，不过他们家的甜品确实不错。', topic: '午饭闲聊', workRelated: false },
  { id: 't05', at: 26, end: 34, speakerId: 'boss', text: '回到正题。我认为必须全实时，现场跑起来才有说服力。', topic: '演示链路', workRelated: true },
  { id: 't06', at: 34, end: 43, speakerId: 'engineer', text: '全实时一旦网络抖动，字幕和提醒都可能卡住，所以我建议——', topic: '演示链路', workRelated: true, interrupted: true },
  { id: 't07', at: 39, end: 44, speakerId: 'boss', text: '别总说风险，比赛就得全实时，才能有说服力。', topic: '演示链路', workRelated: true },
  { id: 't08', at: 44, end: 50, speakerId: 'designer', text: '可以实时为主，同时准备一段预录音频做兜底——', topic: '演示链路', workRelated: true, interrupted: true },
  { id: 't09', at: 48, end: 54, speakerId: 'boss', text: '我还是那句话，必须全实时，现场跑才有说服力。', topic: '演示链路', workRelated: true },
  { id: 't10', at: 57, end: 64, speakerId: 'engineer', text: '我的方案是实时主链路，失败时一键切预录，界面保持连续。', topic: '混合方案', workRelated: true },
  { id: 't11', at: 64, end: 70, speakerId: 'boss', text: '加预录会让评委觉得我们在演戏，我不同意这个兜底。', topic: '方案分歧', workRelated: true },
  { id: 't12', at: 70, end: 76, speakerId: 'designer', text: '完全不做兜底，一旦现场断了，核心能力反而展示不出来。', topic: '方案分歧', workRelated: true },
  { id: 't13', at: 80, end: 88, speakerId: 'host', text: '分歧已记录。决策：实时为主、预录兜底，只在主链路失败时切换。周总，可以吗？', topic: '主持人决策', workRelated: true },
  { id: 't14', at: 88, end: 92, speakerId: 'boss', text: '可以，按这个方案，演示时不主动切兜底。', topic: '决策确认', workRelated: true },
  { id: 't15', at: 92, end: 98, speakerId: 'host', text: '王工负责链路，郭设计负责提示动效，今晚八点联调。会议结束。', topic: '行动项', workRelated: true },
];

export const DEMO_EVENTS: Intervention[] = [
  {
    id: 'e-smalltalk', at: 23, type: 'smalltalk', severity: 'warning', label: '△ 催一下 · 闲聊偏题',
    observation: '“烧肉店”闲聊已持续 11 秒，且有 2 人参与。',
    impact: '核心议题仍有 2 项未完成。',
    suggestion: '把午饭话题放入会后停车场，回到演示链路。',
    evidence: '主题相关度 12% · 持续 11 秒',
    voice: '检测到闲聊，请回到 Demo 方案。', actions: ['park', 'adopt', 'ignore'],
  },
  {
    id: 'e-interrupt', at: 54, type: 'interrupt', severity: 'warning', label: '△ 催一下 · 频繁打断',
    observation: '周总在 20 秒内连续打断了 2 位发言者。',
    impact: '王工与郭设计的完整方案尚未表达。',
    suggestion: '请先让当前发言者说完，再补充观点。',
    evidence: '说话人重叠 2 次 · 间隔低于 300ms',
    voice: '周总，请先让当前发言者说完。', actions: ['adopt', 'ignore'],
  },
  {
    id: 'e-repeat', at: 55, type: 'repeat', severity: 'warning', label: '△ 催一下 · 观点重复',
    observation: '“必须全实时才有说服力”已由周总表达 2 次。',
    impact: '观点已记录，重复表达正在挤占决策时间。',
    suggestion: '请回应技术风险或给出拍板条件，推进讨论。',
    evidence: '语义相似度 91% · 21 秒内重复', actions: ['adopt', 'ignore'],
  },
  {
    id: 'e-time', at: 75, type: 'time', severity: 'info', label: '○ 提个醒 · 时间进度',
    observation: '会议已进行 75 秒，只剩 25 秒。',
    impact: '还有 2 项需要收敛：方案决策、责任分工。',
    suggestion: '停止扩展论据，由主持人进入拍板。',
    evidence: '时间进度 75% · 议题完成 0/2', actions: ['adopt'],
  },
  {
    id: 'e-dispute', at: 76, type: 'disagreement', severity: 'critical', label: '⬣ 必须收尾 · 分歧未决',
    observation: '“纯实时 / 预录兜底”形成明确相反观点，已持续 12 秒。',
    impact: '按当前速度预计超时 18 秒。',
    suggestion: '请主持人立即决策，保留双方观点作为会后证据。',
    evidence: '2 组相反立场 · 剩余时间 24%',
    voice: '分歧仍未收敛，只剩二十四秒，请主持人立即决策。', actions: ['adopt', 'park'],
  },
  {
    id: 'e-decision', at: 92, type: 'decision', severity: 'success', label: '✓ 决策已收敛',
    observation: '实时主链路、故障时切换预录兜底。',
    impact: '王工负责链路，郭设计负责提示动效。',
    suggestion: '今晚 20:00 联调；演示时不主动切换兜底。',
    evidence: '主持人拍板 · 关键角色确认',
  },
];

export const TOPIC_SEGMENTS = [
  { start: 0, end: 12, label: '会议目标', tone: 'focus' },
  { start: 12, end: 23, label: '午饭闲聊', tone: 'warning' },
  { start: 23, end: 57, label: '演示链路', tone: 'focus' },
  { start: 57, end: 76, label: '方案分歧', tone: 'critical' },
  { start: 76, end: 92, label: '主持人决策', tone: 'focus' },
  { start: 92, end: 100, label: '行动项', tone: 'success' },
] as const;

export const DEMO_REPORT = {
  overall: 91,
  verdict: '这场会值得开，但少一位旁听者会更高效。',
  necessity: '有必要开',
  necessityReason: '存在真实方案分歧，会议完成了拍板并明确两项行动安排。',
  actualSeconds: 98,
  scores: [
    { key: 'punctuality', label: '准时率', value: 100, detail: '比计划提前 2 秒结束' },
    { key: 'focus', label: '话题集中度', value: 88, detail: '11 秒闲聊已被及时拉回' },
    { key: 'balance', label: '发言均衡度', value: 72, detail: '周总发言占比最高' },
    { key: 'coverage', label: '议题覆盖率', value: 100, detail: '2 / 2 个议题完成' },
  ],
  speakerStats: [
    { id: 'host', seconds: 20, share: 21.3, turns: 3, interruptions: 0 },
    { id: 'boss', seconds: 29, share: 30.9, turns: 4, interruptions: 2 },
    { id: 'engineer', seconds: 22, share: 23.4, turns: 3, interruptions: 0 },
    { id: 'designer', seconds: 18, share: 19.1, turns: 3, interruptions: 0 },
    { id: 'observer', seconds: 5, share: 5.3, turns: 1, interruptions: 0 },
  ],
  summary: '团队决定采用“实时主链路 + 预录兜底”的演示方案，仅在主链路故障时切换。会议经历一次闲聊偏题和一轮方案分歧，均在助手干预后回到主线。',
  decisions: ['实时转写与 Agent 分析作为主演示链路', '主链路失败时一键切换预录音频，界面保持连续', '演示正常时不主动触发兜底'],
  actions: [
    { owner: '王工', task: '完成实时链路与兜底切换', due: '今晚 20:00 前' },
    { owner: '郭设计', task: '完成提醒与切换动效', due: '今晚 20:00 前' },
  ],
  suggestions: [
    '周总在 20 秒内打断 2 次，建议主持人启用轮流发言机制。',
    '本次有 11 秒偏题闲聊，建议将非议题内容放入会后停车场。',
    '分歧直到剩余 24 秒才收敛，下次应在会前明确拍板人。',
  ],
  attendanceAdvice: '黄观察本次没有工作相关发言或待办，下次可异步接收会议纪要。',
};

export function getSpeaker(id: string, speakers: Speaker[] = SPEAKERS) {
  return speakers.find((speaker) => speaker.id === id) ?? speakers[0];
}

export function formatClock(seconds: number) {
  const safe = Math.max(0, Math.floor(seconds));
  return `${String(Math.floor(safe / 60)).padStart(2, '0')}:${String(safe % 60).padStart(2, '0')}`;
}
