export type Severity = 'info' | 'warning' | 'critical' | 'success';
export type InterventionLevel = 'L0' | 'L1' | 'L2';
export type EventType = 'agenda_progress' | 'topic_shift' | 'action_item' | 'smalltalk' | 'off_topic' | 'interrupt' | 'repeat' | 'disagreement' | 'time' | 'decision';

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
  speaker?: string;
  text: string;
  expectedText?: string;
  topic: string;
  workRelated: boolean;
  interrupted?: boolean;
  asrSource?: string;
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
  confidence?: number;
  level: InterventionLevel;
  priority: 0 | 100 | 200 | 300;
  occurrence?: number;
  incidentKey?: string;
  displayMs?: 0 | 7000 | 10000;
  replacesId?: string;
  escalationReason?: string;
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

export type MeetingReport = {
  overall: number;
  verdict: string;
  necessity: string;
  necessityReason: string;
  actualSeconds: number;
  scores: Array<{ key: string; label: string; value: number; detail: string }>;
  speakerStats: Array<{ id: string; seconds: number; share: number; turns: number; interruptions: number }>;
  summary: string;
  decisions: string[];
  actions: Array<{ owner: string; task: string; due: string }>;
  suggestions: string[];
  attendanceAdvice: string;
  source?: string;
  model?: string;
};

export type VerifiedRun = {
  verifiedAt: string;
  provenance: { kind: string; statement: string; sourceAudioSha256: string; sourceAsrWavSha256: string };
  meeting: MeetingConfig & { attendees: Speaker[] };
  audio: { estimatedTtsCostUsd: number; artifacts: { master: { path: string; sha256: string; durationSeconds: number } } };
  pipeline: {
    tts: { provider: string; model: string };
    asr: { provider: string; protocol: string; frame: string; rollingSessions: boolean };
    analysis: { endpoint: string; sources: string[]; models: string[] };
    report: { endpoint: string; source: string; model: string | null };
  };
  masterAsr: { text: string };
  transcript: TranscriptLine[];
  events: Intervention[];
  report: MeetingReport;
  checks: Record<string, boolean>;
};

export const SPEAKERS: Speaker[] = [
  { id: 'host', name: '林主持', short: '林', role: '主持人 · 产品负责人', color: '#1a73e8' },
  { id: 'boss', name: '周总', short: '周', role: '业务拍板人', color: '#f9ab00', isPriority: true },
  { id: 'engineer', name: '王工', short: '王', role: '后端负责人', color: '#188038' },
  { id: 'designer', name: '郭产品', short: '郭', role: '产品体验负责人', color: '#7e57c2' },
  { id: 'observer', name: '黄运营', short: '黄', role: '活动运营', color: '#d93025' },
];

export const DEFAULT_CONFIG: MeetingConfig = {
  title: '新用户首周留存改进会',
  durationSeconds: 900,
  meetingType: '方案决策会',
  agenda: ['梳理注册后前三天的主要流失节点', '确定本周实验方案、指标与负责人'],
  attendees: SPEAKERS,
  prioritySpeakerId: 'boss',
  contextUrl: '',
};

export const EMPTY_REPORT: MeetingReport = {
  overall: 0,
  verdict: '等待本次会议证据',
  necessity: '待判断',
  necessityReason: '完成转写与分析后生成。',
  actualSeconds: 0,
  scores: [
    { key: 'time', label: '时间管理', value: 0, detail: '等待会议结束' },
    { key: 'focus', label: '议题聚焦', value: 0, detail: '等待会议结束' },
    { key: 'participation', label: '参与质量', value: 0, detail: '等待会议结束' },
    { key: 'agenda', label: '议题推进', value: 0, detail: '等待会议结束' },
    { key: 'outcome', label: '决策闭环', value: 0, detail: '等待会议结束' },
  ],
  speakerStats: SPEAKERS.map((speaker) => ({ id: speaker.id, seconds: 0, share: 0, turns: 0, interruptions: 0 })),
  summary: '尚未生成报告。',
  decisions: [],
  actions: [],
  suggestions: [],
  attendanceAdvice: '会议结束后生成参会建议。',
};

export const TOPIC_SEGMENTS = [
  { start: 0, end: 27, label: '方案收集', tone: 'focus' },
  { start: 27, end: 37, label: '短暂闲聊', tone: 'warning' },
  { start: 37, end: 42, label: '回到上线条件', tone: 'success' },
  { start: 42, end: 64, label: '打断与时间风险', tone: 'critical' },
  { start: 64, end: 82, label: '风险收敛', tone: 'focus' },
  { start: 82, end: 100, label: '决策与行动', tone: 'success' },
] as const;

export function getSpeaker(id: string, speakers: Speaker[] = SPEAKERS) {
  return speakers.find((speaker) => speaker.id === id) ?? speakers[0];
}

export function formatClock(seconds: number) {
  const safe = Math.max(0, Math.floor(seconds));
  return `${String(Math.floor(safe / 60)).padStart(2, '0')}:${String(safe % 60).padStart(2, '0')}`;
}
