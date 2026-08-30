import assert from 'node:assert/strict';
import { findDisagreementEvidence, isContentInterruption } from '../app/intervention-routing.ts';
import { appendStableLiveLine, resolveLiveDraftSpeaker, SerialSnapshotQueue, stableLiveAnalysisLines } from '../app/single-live-flow.ts';
import type { TranscriptLine } from '../app/demo-data.ts';

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
assert.equal(queue.enqueue('turn-a', async () => { processed.push('turn-a'); }), true);
assert.equal(queue.enqueue('turn-a', async () => { processed.push('duplicate'); }), false, '同一稳定快照不得重复分析');
assert.equal(queue.enqueue('turn-a|turn-b', async () => { processed.push('turn-a|turn-b'); }), true);
assert.equal(queue.enqueue('turn-a|turn-b|turn-c', async () => { processed.push('turn-a|turn-b|turn-c'); }), true);
await queue.idle();
assert.deepEqual(processed, ['turn-a', 'turn-a|turn-b', 'turn-a|turn-b|turn-c'], '连续稳定句必须逐个按顺序分析，不能折叠中间分歧');

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

console.log(JSON.stringify({
  ok: true,
  checks: {
    delayedFinalKeepsPreviousSpeaker: true,
    committedLineIsNotOverwritten: true,
    stableTurnsTriggerDisagreement: true,
    finalRevisionIsDeduplicated: true,
    corruptedSpeakerReproducesFailure: true,
    stableSnapshotsAreSerialized: true,
    queueResetsBetweenMeetings: true,
    staleMeetingResultsAreIgnored: true,
  },
}, null, 2));
