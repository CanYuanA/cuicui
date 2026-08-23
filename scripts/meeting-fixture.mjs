export const fixture = {
  meeting: {
    title: '双十一会员券灰度上线决策会',
    durationSeconds: 115,
    meetingType: '方案决策会',
    agenda: ['确定会员券灰度比例与升级门槛', '明确监控、回滚与联调负责人'],
    prioritySpeakerId: 'boss',
    contextUrl: '',
  },
  speakers: [
    { id: 'host', name: '林主持', short: '林', role: '主持人 · 产品负责人', color: '#59e1ff', voice: 'female-chengshu', volume: 0.96 },
    { id: 'boss', name: '周总', short: '周', role: '业务拍板人', color: '#ffc857', voice: 'Chinese (Mandarin)_Reliable_Executive', volume: 0.98, isPriority: true },
    { id: 'engineer', name: '王工', short: '王', role: '后端负责人', color: '#a8f05a', voice: 'Chinese (Mandarin)_Gentleman', volume: 0.94 },
    { id: 'designer', name: '郭产品', short: '郭', role: '产品体验负责人', color: '#a994ff', voice: 'Chinese (Mandarin)_Warm_Bestie', volume: 0.93 },
    { id: 'observer', name: '黄运营', short: '黄', role: '活动运营', color: '#ff8297', voice: 'Chinese (Mandarin)_Unrestrained_Young_Man', volume: 0.92 },
  ],
  utterances: [
    { id: 'u01', start: 0.0, speakerId: 'host', topic: '会议开场', workRelated: true, text: '好，人齐了。今天只定灰度比例和回滚负责人，一百二十秒内拍板。', tts: '(clear-throat) 好，人齐了。今天只定灰度比例和回滚负责人，一百二十秒内拍板。' },
    { id: 'u02', start: 7.2, speakerId: 'engineer', topic: '压测数据', workRelated: true, text: '昨晚压测峰值每秒一万二，百分之二十没问题，五十时数据库延迟涨了四成。' },
    { id: 'u03', start: 15.6, speakerId: 'observer', topic: '咖啡闲聊', workRelated: false, text: '说到昨晚，楼下哪家咖啡真不行，我喝完到两点都没困。', tts: '(laughs) 说到昨晚，楼下哪家咖啡真不行，我喝完到两点都没困。' },
    { id: 'u04', start: 21.5, speakerId: 'designer', topic: '咖啡闲聊', workRelated: false, text: '他们燕麦拿铁还可以，就是排队太久。我都准备自己带咖啡了。' },
    { id: 'u05', start: 28.0, speakerId: 'boss', topic: '业务目标', workRelated: true, text: '先回正题。业务希望百分之五十，量太小看不出转化差异。' },
    { id: 'u06', start: 35.0, speakerId: 'engineer', topic: '技术风险', workRelated: true, interrupted: true, text: '我担心五十会碰到写入瓶颈，回滚脚本还没完整压过，所以建议。', tts: '(emm) 我担心五十会碰到写入瓶颈，回滚脚本还没完整压过，所以建议。' },
    { id: 'u07', start: 40.6, speakerId: 'boss', topic: '业务目标', workRelated: true, text: '我们每次都说风险，百分之二十的数据根本没法做决策。' },
    { id: 'u08', start: 47.0, speakerId: 'designer', topic: '混合方案', workRelated: true, interrupted: true, text: '可以先二十，指标稳定十分钟后自动升到五十，同时给用户明确提示。' },
    { id: 'u09', start: 52.5, speakerId: 'boss', topic: '业务目标', workRelated: true, text: '我还是那个观点，不到五十就没有说服力，业务侧不能白等一周。' },
    { id: 'u10', start: 60.2, speakerId: 'engineer', topic: '混合方案', workRelated: true, text: '折中方案是二十起步，错误率低于千分之三且库存一致，再自动升到五十。' },
    { id: 'u11', start: 68.5, speakerId: 'boss', topic: '门槛分歧', workRelated: true, text: '我不同意把门槛设这么严，真实流量一定会有抖动。', tts: '(sighs) 我不同意把门槛设这么严，真实流量一定会有抖动。' },
    { id: 'u12', start: 75.0, speakerId: 'designer', topic: '门槛分歧', workRelated: true, text: '但如果券状态不一致，客服和用户都会直接承受，不能只看转化。' },
    { id: 'u13', start: 83.0, speakerId: 'host', topic: '主持人决策', workRelated: true, text: '分歧清楚了。我拍板：二十起步，十分钟达标升五十；不达标自动回滚。' },
    { id: 'u14', start: 92.3, speakerId: 'boss', topic: '决策确认', workRelated: true, text: '可以，门槛用千分之三，不过业务仪表盘要同步看。' },
    { id: 'u15', start: 99.5, speakerId: 'host', topic: '行动项', workRelated: true, text: '王工负责回滚和告警，郭产品负责仪表盘，周三七点半联调。会就到这。' },
  ],
};

export function speakerFor(id) {
  return fixture.speakers.find((speaker) => speaker.id === id);
}
