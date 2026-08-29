import Link from 'next/link';
import ParticipantView from '../participant-view';

type JoinPageProps = {
  searchParams: Promise<{ code?: string | string[] }>;
};

const ROOM_CODE_PATTERN = /^[A-HJ-NP-Z2-9]{6}$/;

export default async function JoinPage({ searchParams }: JoinPageProps) {
  const params = await searchParams;
  const rawCode = Array.isArray(params.code) ? params.code[0] : params.code;
  const code = String(rawCode || '').trim().toUpperCase();

  if (ROOM_CODE_PATTERN.test(code)) return <ParticipantView code={code} />;

  return <main className="join-shell">
    <section className="join-card">
      <div className="brand"><span className="brand-mark">C²</span><span><strong>催催</strong><small>会议参与端</small></span></div>
      <p className="eyebrow"><span /> 多人会议</p>
      <h1>输入加入码</h1>
      <p>向主持人获取六位加入码，进入后填写你的姓名即可参会。</p>
      <form action="/join" method="get">
        <label className="field" htmlFor="room-code"><span>会议加入码</span><input id="room-code" name="code" required autoFocus maxLength={6} minLength={6} pattern="[A-HJ-NP-Za-hj-np-z2-9]{6}" autoCapitalize="characters" autoComplete="off" spellCheck={false} defaultValue={code} placeholder="例如：ABC234" style={{ textTransform: 'uppercase', letterSpacing: '.16em' }} /></label>
        {rawCode && <div className="service-error" role="alert"><b>加入码无效</b><span>请检查六位加入码后重试。</span></div>}
        <button className="primary-action" type="submit">继续</button>
      </form>
      <Link className="text-button" href="/" style={{ display: 'block', textAlign: 'center', textDecoration: 'none' }}>返回首页</Link>
    </section>
  </main>;
}
