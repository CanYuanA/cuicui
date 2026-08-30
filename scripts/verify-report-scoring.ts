import assert from 'node:assert/strict';
import { scoreMeeting, type ScoringInput } from '../app/server/report-scoring.ts';

const attendees = ['host', 'product', 'engineer', 'ops'].map((id) => ({ id, name: id }));

function score(input: ScoringInput) {
  const result = scoreMeeting(input);
  assert.equal(result.scores.length, 5, '雷达必须固定为五个维度');
  for (const item of result.scores) assert.ok(item.value >= 0 && item.value <= 100, `${item.key} 越界`);
  return result;
}

assert.ok(score({ meeting: { durationSeconds: 900, agenda: [], attendees }, transcript: [] }).overall <= 5, '空会议不得得分');

assert.ok(score({
  meeting: { durationSeconds: 900, agenda: ['确认上线方案'], attendees },
  transcript: [{ speakerId: 'host', text: '大家好' }, { speakerId: 'product', text: '好的开始吧' }],
}).overall <= 20, '寒暄不应被视为讨论');

assert.ok(score({
  meeting: { durationSeconds: 900, agenda: [], attendees }, actualSeconds: 300,
  transcript: [
    { speakerId: 'host', text: '我们先看用户注册后的流失数据和几个可能原因。', at: 0, end: 12 },
    { speakerId: 'product', text: '产品观察到第三步资料填写的退出率明显更高。', at: 13, end: 25 },
    { speakerId: 'engineer', text: '接口耗时不是主因，主要是字段一次展示得太多。', at: 26, end: 39 },
    { speakerId: 'ops', text: '运营侧也收到过用户不理解资料用途的反馈。', at: 40, end: 52 },
  ],
}).overall <= 30, '没有明确议题必须低分');

const unresolved = score({
  meeting: { durationSeconds: 600, agenda: ['确认灰度范围', '明确异常阈值'], attendees }, actualSeconds: 420,
  transcript: [
    { speakerId: 'host', text: '今天确认灰度范围和异常阈值，先听各方意见。', at: 0, end: 10 },
    { speakerId: 'engineer', text: '灰度范围可以先覆盖内部账号，异常阈值还需要再看数据。', at: 11, end: 25 },
    { speakerId: 'product', text: '我担心内部账号样本太少，灰度范围应该再扩大一些。', at: 26, end: 39 },
    { speakerId: 'ops', text: '运营认为异常阈值不能影响十点的推送安排。', at: 40, end: 52 },
    { speakerId: 'host', text: '请负责人拍板，我们还没决定最终范围。', at: 53, end: 65 },
    { speakerId: 'engineer', text: '负责人是谁也需要会后确认。', at: 66, end: 75 },
  ],
});
assert.ok(unresolved.overall <= 55, '没有决策和行动项不得高分');
assert.equal(unresolved.scores.find((item) => item.key === 'outcome')?.value, 0, '请求拍板不是决策');

const complete = score({
  meeting: { durationSeconds: 600, agenda: ['确认灰度范围', '明确异常阈值'], attendees }, actualSeconds: 560,
  transcript: [
    { speakerId: 'host', topic: '确认灰度范围', text: '今天确认灰度范围和异常阈值，并明确执行人。', at: 0, end: 10 },
    { speakerId: 'engineer', topic: '确认灰度范围', text: '灰度范围建议早上八点先覆盖内部账号。', at: 11, end: 23 },
    { speakerId: 'product', topic: '确认灰度范围', text: '内部账号不会影响十点对外承诺，我支持这个范围。', at: 24, end: 37 },
    { speakerId: 'ops', topic: '明确异常阈值', text: '异常阈值低于百分之一时，运营可以照常推送。', at: 38, end: 52 },
    { speakerId: 'host', topic: '明确异常阈值', text: '行，就按内部账号灰度，异常超过百分之一暂停推送。', at: 53, end: 66 },
    { speakerId: 'engineer', topic: '明确异常阈值', text: '我负责明天八点开监控并回传灰度结果。', at: 67, end: 80 },
  ],
});
assert.ok(complete.overall > unresolved.overall, '形成闭环的会议应明显高于未决会议');

console.log(JSON.stringify({ ok: true, emptyGuard: true, noAgendaGuard: true, outcomeGuard: true, completeScore: complete.overall }));
