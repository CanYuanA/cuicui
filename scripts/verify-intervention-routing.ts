import assert from 'node:assert/strict';
import { INTERVENTION_CHIME_CUES } from '../app/intervention-chime.ts';
import { findDisagreementEvidence, isContentInterruption, routeInterventions, type InterventionCandidate, type PreviousIntervention } from '../app/intervention-routing.ts';

assert.equal(INTERVENTION_CHIME_CUES.L1.length, 1, 'L1 应使用单次柔和提示音');
assert.equal(INTERVENTION_CHIME_CUES.L2.length, 1, 'L2 也应保持单次提示音');
assert.notEqual(INTERVENTION_CHIME_CUES.L1[0].frequency, INTERVENTION_CHIME_CUES.L2[0].frequency, 'L1 与 L2 的主音高必须不同');
assert.notDeepEqual(INTERVENTION_CHIME_CUES.L1[0].partials, INTERVENTION_CHIME_CUES.L2[0].partials, 'L1 与 L2 的音色必须不同');
assert.ok(Math.max(...INTERVENTION_CHIME_CUES.L2.map((note) => note.gain)) <= .055, 'L2 音量应保持克制');

const normalOverlap = [
  { speakerId: 'a', speaker: '甲', text: '我建议先灰度一小时，再决定是否全量。', at: 10, end: 16 },
  { speakerId: 'b', speaker: '乙', text: '这个方案需要补充监控阈值。', at: 15.6, end: 20 },
];
assert.equal(isContentInterruption(normalOverlap[0], normalOverlap[1]), false, '正常接话即使时间戳轻微重叠也不应判为打断');

const explicitInterrupt = [
  normalOverlap[0],
  { speakerId: 'b', speaker: '乙', text: '不用继续解释灰度了，直接全量。', at: 14.8, end: 18 },
];
assert.equal(isContentInterruption(explicitInterrupt[0], explicitInterrupt[1]), true, '时间重叠并带明确抢断语义时应识别打断');

const disagreementLines = [
  { speakerId: 'a', speaker: '甲', text: '我建议把灰度作为全量上线的前置条件。', at: 20, end: 25 },
  { speakerId: 'b', speaker: '乙', text: '我不同意把灰度设成前置，十点上线不能改。', at: 25.4, end: 30 },
];
const disagreementEvidence = findDisagreementEvidence(disagreementLines);
assert.ok(disagreementEvidence, '非重叠的明确相反立场应识别为意见分歧');
assert.equal(isContentInterruption(disagreementLines[0], disagreementLines[1]), false, '意见分歧不应被误判为打断');

const interruptCandidate: InterventionCandidate = {
  at: 40, type: 'interrupt', severity: 'warning', incidentKey: 'interrupt:b', label: '打断', observation: '明确抢断', impact: '观点未说完', suggestion: '让对方说完', evidence: '证据',
};
const disagreementCandidate: InterventionCandidate = {
  at: 40, type: 'disagreement', severity: 'warning', incidentKey: 'disagreement:topic', label: '分歧', observation: '相反立场', impact: '尚未收敛', suggestion: '明确条件', evidence: '证据',
};
const first = routeInterventions([disagreementCandidate, interruptCandidate], [], 40);
assert.equal(first.find((event) => event.type === 'disagreement')?.level, 'L1');
assert.equal(first.find((event) => event.type === 'disagreement')?.priority, 200);
assert.equal(first.find((event) => event.type === 'interrupt')?.level, 'L0', '首次打断只静默记录');

const previous: PreviousIntervention[] = first.map((event, index) => ({ ...event, id: `first-${index}`, at: 20 }));
const repeated = routeInterventions([{ ...disagreementCandidate, at: 40 }, { ...interruptCandidate, at: 40 }], previous, 40);
assert.equal(repeated.find((event) => event.type === 'disagreement')?.level, 'L2');
assert.equal(repeated.find((event) => event.type === 'disagreement')?.priority, 300);
assert.equal(repeated.find((event) => event.type === 'interrupt')?.level, 'L0', '同一时刻的低优先级打断不得覆盖分歧提醒');

const recentCriticalInterrupt: PreviousIntervention[] = [{
  ...interruptCandidate,
  id: 'recent-interrupt',
  at: 36,
  level: 'L2',
  priority: 100,
  occurrence: 3,
}];
const afterInterrupt = routeInterventions([{ ...disagreementCandidate, at: 40 }], recentCriticalInterrupt, 40);
assert.equal(afterInterrupt[0]?.level, 'L1', '即使刚出现加强打断，新的明确分歧仍应正常提醒');
assert.equal(afterInterrupt[0]?.replacesId, 'recent-interrupt', '分歧应替换低优先级打断');

console.log(JSON.stringify({
  ok: true,
  checks: {
    normalOverlapIgnored: true,
    contentInterruptionRecognized: true,
    sequentialDisagreementRecognized: true,
    disagreementOutranksInterrupt: true,
    disagreementReplacesCriticalInterrupt: true,
    l1AndL2UseDistinctChimes: true,
  },
}, null, 2));
