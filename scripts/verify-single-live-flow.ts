import assert from 'node:assert/strict';
import { findDisagreementEvidence, isContentInterruption } from '../app/intervention-routing.ts';
import { appendStableLiveLine, isSingleSnapshotEventCurrent, mergeSingleInterventions, resolveLiveDraftSpeaker, SerialSnapshotQueue, stableLiveAnalysisLines } from '../app/single-live-flow.ts';
import type { Intervention, TranscriptLine } from '../app/demo-data.ts';

const proposal: TranscriptLine = {
  id: 'turn-a', at: 10, end: 16, speakerId: 'engineer', text: '我建议把灰度作为全量上线的前置条件。', topic: '实时讨论', workRelated: true,
};

let lines = appendStableLiveLine([], proposal);
const delayedFinalSpeaker = resolveLiveDraftSpeaker('engineer', 'boss');
assert.equal(delayedFinalSpeaker, 'engineer', '切换角色后迟到的讯飞终句仍应归属切换前角色');

lines = appendStableLiveLine(lines, {
  id: 'turn-a-final', at: 16, end: 16.4, speakerId: delayedFinalSpeaker, text: '灰度方案要先验证监控阈值。', topic: '实时讨论', workRelated: true,
});
lines = appendStableLiveLine(lines, {
  id: 'turn-b', at: 17, end: 22, speakerId: 'boss', text: '我不同意把灰度设成前置，十点上线不能改。', topic: '实时讨论', workRelated: true,
});

assert.equal(lines.length, 3, '迟到终句不得覆盖已提交的上一角色发言');
assert.equal(lines[0]?.speakerId, 'engineer');
assert.equal(lines[2]?.speakerId, 'boss');
assert.ok(findDisagreementEvidence(stableLiveAnalysisLines(lines)), '稳定提交的两角色发言应触发意见分歧证据');
assert.equal(isContentInterruption(lines[1], lines[2]), false, '正常的相反意见不应误判为打断');

const corrected = appendStableLiveLine(lines, { ...lines[2], text: '我不同意直接全量，十点上线条件需要重审。' });
assert.equal(corrected.length, 3, '同一字幕 ID 的终句修订不得新增轮次');
assert.equal(corrected[2]?.text, '我不同意直接全量，十点上线条件需要重审。');

const corruptedSpeakers = corrected.map((line) => ({ ...line, speakerId: 'boss' }));
assert.equal(findDisagreementEvidence(corruptedSpeakers), null, '测试样本应能复现错误归属导致规则失效');

const queue = new SerialSnapshotQueue();
const processed: string[] = [];
let releaseFirst!: () => void;
const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
assert.equal(queue.enqueue('turn-a', async () => { processed.push('turn-a'); await firstGate; }), true);
assert.equal(queue.enqueue('turn-a', async () => { processed.push('duplicate'); }), false, '同一稳定快照不得重复分析');
assert.equal(queue.enqueue('turn-a|turn-b', async () => { processed.push('turn-a|turn-b'); }), true);
assert.equal(queue.enqueue('turn-a|turn-b|turn-c', async () => { processed.push('turn-a|turn-b|turn-c'); }), true);
releaseFirst();
await queue.idle();
assert.deepEqual(processed, ['turn-a', 'turn-a|turn-b|turn-c'], '慢请求期间只能保留最新待分析快照，不能回放过期中间状态');

queue.reset();
assert.equal(queue.enqueue('turn-a', async () => { processed.push('new-meeting'); }), true, '新会议应清空旧会议的快照去重状态');
await queue.idle();

let releaseOldMeeting!: () => void;
const oldMeetingGate = new Promise<void>((resolve) => { releaseOldMeeting = resolve; });
let finishOldMeeting!: () => void;
const oldMeetingFinished = new Promise<void>((resolve) => { finishOldMeeting = resolve; });
let generation = 1;
const isolatedResults: string[] = [];
const oldGeneration = generation;
queue.reset();
queue.enqueue('old-meeting', async () => {
  await oldMeetingGate;
  if (oldGeneration === generation) isolatedResults.push('old-meeting');
  finishOldMeeting();
});
generation += 1;
queue.reset();
const newGeneration = generation;
queue.enqueue('new-meeting', async () => {
  if (newGeneration === generation) isolatedResults.push('new-meeting');
});
await queue.idle();
releaseOldMeeting();
await oldMeetingFinished;
assert.deepEqual(isolatedResults, ['new-meeting'], '旧会议的迟到分析不得写入新会议');

const smalltalkLine: TranscriptLine = {
  id: 'turn-c', at: 23, end: 27, speakerId: 'designer', text: '周末聚餐我们去吃烤肉吧。', topic: '实时讨论', workRelated: true,
};
const latestSmalltalk = [...corrected, smalltalkLine];
assert.equal(isSingleSnapshotEventCurrent({ type: 'disagreement', evidence: `周总：${corrected.at(-1)?.text}` }, corrected), true, '当前发言形成分歧且证据引用当前原话时应保留');
assert.equal(isSingleSnapshotEventCurrent({ type: 'disagreement', evidence: '王工与周总对全量上线持相反意见。' }, latestSmalltalk), false, '已经进入新话题后不得补发旧分歧提醒');
assert.equal(isSingleSnapshotEventCurrent({ type: 'smalltalk', evidence: '郭产品：周末聚餐我们去吃烤肉吧。' }, latestSmalltalk), true, '提醒证据锚定最新发言时应保留');
assert.equal(isSingleSnapshotEventCurrent({ type: 'smalltalk', evidence: '上一轮讨论了周末聚餐。' }, [...latestSmalltalk, { ...smalltalkLine, id: 'turn-d', at: 28, end: 30, text: '先不聊这个，继续确认上线条件。' }]), false, '最新发言已经拉回议题时不得再提醒旧闲聊');

const intervention = (id: string, level: Intervention['level'], incidentKey: string, at: number): Intervention => ({
  id, at, type: 'disagreement', severity: level === 'L2' ? 'critical' : 'warning', incidentKey,
  label: id, observation: '双方对上线方案持相反意见。', impact: '方案尚未收敛。', suggestion: '明确决策条件。', evidence: '周总与王工对全量上线持相反意见。',
  level, priority: level === 'L2' ? 300 : level === 'L1' ? 200 : 0, actions: level === 'L0' ? [] : ['adopt'],
});
let mergedEvents = mergeSingleInterventions([], [intervention('first-l1', 'L1', '模型生成键一', 20)]);
mergedEvents = mergeSingleInterventions(mergedEvents, [intervention('duplicate-l1', 'L1', '另一个模型键', 35)]);
assert.deepEqual(mergedEvents.map((event) => event.id), ['first-l1'], '同一分歧即使模型更换标题或键，也不得重复记录同级提醒');
mergedEvents = mergeSingleInterventions(mergedEvents, [intervention('escalated-l2', 'L2', '第三个模型键', 50)]);
assert.deepEqual(mergedEvents.map((event) => event.id), ['escalated-l2'], '同一问题真实升级时应替换旧记录，而不是追加重复提醒');

console.log(JSON.stringify({
  ok: true,
  checks: {
    delayedFinalKeepsPreviousSpeaker: true,
    committedLineIsNotOverwritten: true,
    stableTurnsTriggerDisagreement: true,
    finalRevisionIsDeduplicated: true,
    corruptedSpeakerReproducesFailure: true,
    slowSnapshotsKeepOnlyLatestPending: true,
    queueResetsBetweenMeetings: true,
    staleMeetingResultsAreIgnored: true,
    staleIssueIsNotReplayedAfterTopicChange: true,
    repeatedIncidentIsCoalesced: true,
  },
}, null, 2));
