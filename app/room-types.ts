export type RoomStatus = 'waiting' | 'live' | 'closing' | 'ended';

export type RoomMeeting = {
  title: string;
  durationSeconds: number;
  meetingType: string;
  agenda: string[];
};

export type Participant = {
  id: string;
  name: string;
  role: string;
  joined_at: number;
  last_seen: number;
  left_at: number | null;
  online: boolean;
};

export type UtteranceSource = 'iflytek' | 'manual';

export type Utterance = {
  id: string;
  participant_id: string;
  name: string;
  role: string;
  text: string;
  started_at: number;
  ended_at: number;
  created_at: number;
  updated_at: number;
  client_event_id: string;
  seq: number;
  final: boolean;
  source: UtteranceSource;
};

export type RoomSnapshot = {
  code: string;
  meeting: RoomMeeting;
  status: RoomStatus;
  revision: number;
  serverNow: number;
  createdAt: number;
  startedAt: number | null;
  closeDeadline: number | null;
  endedAt: number | null;
  expiresAt: number;
  participants: Participant[];
  utterances: Utterance[];
};

export type RoomSession = {
  code: string;
  hostToken: string;
  participantToken: string;
  participantId: string;
  joinUrl: string;
  expiresAt: number;
};
