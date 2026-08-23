export type Severity = 'info' | 'warning' | 'critical' | 'success';
export type EventType = 'smalltalk' | 'off_topic' | 'interrupt' | 'repeat' | 'disagreement' | 'time' | 'decision';

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
  { id: 'host', name: '林主持', short: '林', role: '主持人 · 产品负责人', color: '#59e1ff' },
  { id: 'boss', name: '周总', short: '周', role: '业务拍板人', color: '#ffc857', isPriority: true },
  { id: 'engineer', name: '王工', short: '王', role: '后端负责人', color: '#a8f05a' },
  { id: 'designer', name: '郭产品', short: '郭', role: '产品体验负责人', color: '#a994ff' },
  { id: 'observer', name: '黄运营', short: '黄', role: '活动运营', color: '#ff8297' },
];

export const DEFAULT_CONFIG: MeetingConfig = {
  title: '催催助手现场演示方案会',
  durationSeconds: 100,
  meetingType: '方案决策会',
  agenda: ['确定评委能看懂的单人演示主线', '收敛首版范围并明确验收负责人'],
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
    { key: 'punctuality', label: '准时率', value: 0, detail: '等待会议结束' },
    { key: 'focus', label: '话题集中度', value: 0, detail: '等待会议结束' },
    { key: 'balance', label: '发言均衡度', value: 0, detail: '等待会议结束' },
    { key: 'coverage', label: '议题覆盖率', value: 0, detail: '等待会议结束' },
  ],
  speakerStats: SPEAKERS.map((speaker) => ({ id: speaker.id, seconds: 0, share: 0, turns: 0, interruptions: 0 })),
  summary: '尚未生成报告。',
  decisions: [],
  actions: [],
  suggestions: [],
  attendanceAdvice: '会议结束后生成参会建议。',
};

export const TOPIC_SEGMENTS = [
  { start: 0, end: 16, label: '目标对齐', tone: 'focus' },
  { start: 16, end: 29, label: '短暂跑题', tone: 'warning' },
  { start: 29, end: 52, label: '演示主线', tone: 'focus' },
  { start: 52, end: 76, label: '范围分歧', tone: 'critical' },
  { start: 76, end: 100, label: '收敛行动', tone: 'success' },
] as const;

export function getSpeaker(id: string, speakers: Speaker[] = SPEAKERS) {
  return speakers.find((speaker) => speaker.id === id) ?? speakers[0];
}

export function formatClock(seconds: number) {
  const safe = Math.max(0, Math.floor(seconds));
  return `${String(Math.floor(safe / 60)).padStart(2, '0')}:${String(safe % 60).padStart(2, '0')}`;
}
