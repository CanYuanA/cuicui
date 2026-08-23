export const fixture = {
  meeting: {
    title: '催催助手现场演示方案会',
    durationSeconds: 100,
    meetingType: '方案决策会',
    agenda: ['确定评委能看懂的单人演示主线', '收敛首版范围并明确验收负责人'],
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
    { id: 'u01', start: 0.8, end: 7.0, speakerId: 'host', topic: '会议目标', workRelated: true, text: '好，我们用一百秒定催催的演示主线：先让评委看懂，再让他相信有用。', tts: '(clear-throat) 好，我们用一百秒定催催的演示主线：先让评委看懂，再让他相信有用。' },
    { id: 'u02', start: 8.0, end: 15.2, speakerId: 'designer', topic: '演示主线', workRelated: true, text: '我建议从一个普通方案会开始。大家正常说话，催催边听边记，别先讲模型。' },
    { id: 'u03', start: 16.2, end: 21.3, speakerId: 'observer', topic: '演示厅闲聊', workRelated: false, text: '等一下，演示厅是不是特别冷？我刚下楼拿了件外套。' },
    { id: 'u04', start: 22.2, end: 28.2, speakerId: 'host', topic: '拉回议题', workRelated: true, text: '是有点冷。这个先放会后，我们回到评委第一眼能看到什么。' },
    { id: 'u05', start: 29.1, end: 36.4, speakerId: 'engineer', topic: '功能范围', workRelated: true, interrupted: true, text: '技术上先演实时转写，再演多人接入和音频分轨，我还想把接口证据也……', tts: '技术上先演实时转写，再演多人接入和音频分轨，我还想把接口证据也……' },
    { id: 'u06', start: 35.4, end: 43.5, speakerId: 'designer', topic: '单人主线', workRelated: true, text: '等一下，先别堆功能。评委看到一句话说完，字幕再出现，提醒还能指出依据，就够了。' },
    { id: 'u07', start: 44.5, end: 50.9, speakerId: 'boss', topic: '演示主线', workRelated: true, text: '对，主线就三步：听见、提醒、形成行动。多人模式这一版先不演。' },
    { id: 'u08', start: 52.0, end: 58.5, speakerId: 'engineer', topic: '多人模式', workRelated: true, text: '但不展示多人，怎么证明说话人区分？这个能力我还是觉得必须讲。' },
    { id: 'u09', start: 59.5, end: 66.0, speakerId: 'designer', topic: '多人模式', workRelated: true, text: '我不同意。入口现在不稳定，现场只要失败一次，前面的可信度就没了。' },
    { id: 'u10', start: 67.0, end: 74.3, speakerId: 'engineer', topic: '范围分歧', workRelated: true, text: '我还是那个意见，多人的身份区分很关键；不演的话，至少得在口头上解释一下。' },
    { id: 'u11', start: 75.3, end: 81.8, speakerId: 'host', topic: '预计超时', workRelated: true, text: '这个点已经来回说了两遍，范围还没定。现在只剩二十三秒，请周总直接拍板。' },
    { id: 'u12', start: 82.7, end: 88.9, speakerId: 'boss', topic: '范围决策', workRelated: true, text: '拍板：只演单人链路，多人入口先隐藏；报告必须从现场转写生成。' },
    { id: 'u13', start: 89.8, end: 94.3, speakerId: 'engineer', topic: '工程行动', workRelated: true, text: '我负责讯飞直连和逐句时间戳；识别失败就明确报错，不做假字幕兜底。' },
    { id: 'u14', start: 95.2, end: 99.0, speakerId: 'designer', topic: '产品行动', workRelated: true, text: '我负责按真实节点出字幕和提醒，明天下午四点请林主持验收。' },
  ],
};

export function speakerFor(id) {
  return fixture.speakers.find((speaker) => speaker.id === id);
}
