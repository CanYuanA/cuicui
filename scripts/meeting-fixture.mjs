export const fixture = {
  meeting: {
    title: '会员日活动上线评审',
    durationSeconds: 120,
    meetingType: '上线评审会',
    agenda: ['确认满减规则与用户路径', '确定灰度方案、异常阈值和负责人'],
    prioritySpeakerId: 'boss',
    contextUrl: '',
  },
  speakers: [
    { id: 'host', name: '林主持', short: '林', role: '主持人 · 产品负责人', color: '#1a73e8', voice: 'female-chengshu', volume: 0.96 },
    { id: 'boss', name: '周总', short: '周', role: '业务拍板人', color: '#f9ab00', voice: 'Chinese (Mandarin)_Reliable_Executive', volume: 0.98, isPriority: true },
    { id: 'engineer', name: '王工', short: '王', role: '后端负责人', color: '#188038', voice: 'Chinese (Mandarin)_Gentleman', volume: 0.94 },
    { id: 'designer', name: '郭产品', short: '郭', role: '产品体验负责人', color: '#7e57c2', voice: 'Chinese (Mandarin)_Warm_Bestie', volume: 0.93 },
    { id: 'observer', name: '黄运营', short: '黄', role: '活动运营', color: '#d93025', voice: 'Chinese (Mandarin)_Unrestrained_Young_Man', volume: 0.92 },
  ],
  utterances: [
    { id: 'u01', start: 0.8, end: 10.8, speakerId: 'host', topic: '会议目标', workRelated: true, text: '好，今天用两分钟过完会员日活动上线评审。先定优惠规则，再定发布节奏和负责人。', tts: '(clear-throat) 好，今天用两分钟过完会员日活动上线评审。先定优惠规则，再定发布节奏和负责人。' },
    { id: 'u02', start: 11.1, end: 19.6, speakerId: 'observer', topic: '满减规则', workRelated: true, text: '运营方案是周五十点上线，会员满三十九减八。推送和首页资源位都已经排好了。' },
    { id: 'u03', start: 19.9, end: 25.7, speakerId: 'designer', topic: '用户路径', workRelated: true, text: '产品这边建议结算页直接展示优惠，不再加抽奖入口，先把路径做短。' },
    { id: 'u04', start: 26.0, end: 32.5, speakerId: 'engineer', topic: '上线风险', workRelated: true, text: '领券高峰会同时查库存和优惠资格，我建议先把超时和回滚条件定下来。' },
    { id: 'u05', start: 33.0, end: 39.1, speakerId: 'observer', topic: '团建闲聊', workRelated: false, text: '说到周五，团建是不是也定在那天？楼下新开的烤肉店好像不错。' },
    { id: 'u06', start: 39.4, end: 44.5, speakerId: 'designer', topic: '团建闲聊', workRelated: false, text: '我看过了，那家六点以后要排很久，真去的话得提前订位。' },
    { id: 'u07', start: 44.8, end: 49.8, speakerId: 'host', topic: '拉回议题', workRelated: true, text: '团建会后聊。王工继续，把满减券上线风险说完。' },
    { id: 'u08', start: 50.1, end: 56.3, speakerId: 'engineer', topic: '灰度方案', workRelated: true, interrupted: true, text: '建议早上八点先对内部账号灰度，异常率低于百分之一，十点再全量。' },
    { id: 'u09', start: 54.9, end: 58.7, speakerId: 'boss', topic: '全量上线', workRelated: true, text: '不用灰度，资源位已经买了，十点必须全量。' },
    { id: 'u10', start: 59.1, end: 65.2, speakerId: 'engineer', topic: '回滚条件', workRelated: true, interrupted: true, text: '我说的是高峰期兜底，如果没有灰度数据，出了问题只能边上线边回滚。' },
    { id: 'u11', start: 63.7, end: 67.9, speakerId: 'boss', topic: '全量上线', workRelated: true, text: '活动口径都发出去了，技术问题你们自己想办法解决。' },
    { id: 'u12', start: 68.3, end: 73.6, speakerId: 'engineer', topic: '异常阈值', workRelated: true, interrupted: true, text: '至少让我把回滚条件说完，异常率超过百分之一就应该暂停推送。' },
    { id: 'u13', start: 72.2, end: 76.9, speakerId: 'boss', topic: '全量上线', workRelated: true, text: '十点全量，先上再看，别把方案越说越复杂。' },
    { id: 'u14', start: 77.5, end: 83.8, speakerId: 'host', topic: '分歧收敛', workRelated: true, text: '周总先让王工说完。我们只判断这套兜底会不会影响十点对外承诺。' },
    { id: 'u15', start: 84.2, end: 91.7, speakerId: 'engineer', topic: '灰度与回滚', workRelated: true, text: '不会。八点只灰度内部账号，用户仍然十点看到活动；异常超过百分之一就暂停推送。' },
    { id: 'u16', start: 92.0, end: 97.4, speakerId: 'observer', topic: '运营确认', workRelated: true, text: '这个方案不影响推送口径，运营可以配合，九点五十分再做一次确认。' },
    { id: 'u17', start: 98.0, end: 104.5, speakerId: 'boss', topic: '上线决策', workRelated: true, text: '行，就按这个执行。八点内部灰度，十点全量，异常超过百分之一暂停。' },
    { id: 'u18', start: 105.0, end: 113.7, speakerId: 'host', topic: '行动分工', workRelated: true, text: '王工八点开监控，黄运营九点五十分确认推送，郭产品负责验收结算页。散会。' },
  ],
};

export function speakerFor(id) {
  return fixture.speakers.find((speaker) => speaker.id === id);
}
