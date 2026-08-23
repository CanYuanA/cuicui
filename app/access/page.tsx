type AccessPageProps = {
  searchParams: Promise<{ error?: string; next?: string }>;
};

export default async function AccessPage({ searchParams }: AccessPageProps) {
  const params = await searchParams;
  const nextPath = typeof params.next === 'string' ? params.next : '/';
  return (
    <main style={{ minHeight: '100svh', display: 'grid', placeItems: 'center', padding: 24, background: '#f3f1eb', color: '#24231f' }}>
      <section style={{ width: 'min(100%, 420px)', padding: '40px 36px', borderRadius: 28, background: 'rgba(255,255,255,.92)', boxShadow: '0 24px 70px rgba(40,35,20,.12)', border: '1px solid rgba(37,35,28,.08)' }}>
        <div aria-hidden="true" style={{ width: 48, height: 48, display: 'grid', placeItems: 'center', borderRadius: 16, marginBottom: 26, background: '#ffdc61', fontWeight: 900, fontSize: 22 }}>催</div>
        <p style={{ margin: '0 0 8px', color: '#77736a', fontSize: 14, letterSpacing: '.08em' }}>催催会议助手</p>
        <h1 style={{ margin: '0 0 12px', fontSize: 30, lineHeight: 1.2, letterSpacing: '-.04em' }}>输入访问密码</h1>
        <p style={{ margin: '0 0 28px', color: '#68655e', fontSize: 15, lineHeight: 1.7 }}>这是内部演示环境，验证后即可进入完整会议体验。</p>
        <form action="/api/access/login" method="post">
          <input type="hidden" name="next" value={nextPath} />
          <label htmlFor="access-password" style={{ display: 'block', marginBottom: 9, fontWeight: 700, fontSize: 14 }}>访问密码</label>
          <input
            id="access-password"
            name="password"
            type="password"
            required
            autoFocus
            autoComplete="current-password"
            aria-invalid={params.error === '1'}
            aria-describedby={params.error === '1' ? 'password-error' : undefined}
            style={{ width: '100%', boxSizing: 'border-box', height: 52, padding: '0 16px', borderRadius: 14, border: params.error === '1' ? '1.5px solid #c94c40' : '1.5px solid #d8d4ca', background: '#fff', color: '#24231f', fontSize: 17, outline: 'none' }}
          />
          {params.error === '1' && <p id="password-error" role="alert" style={{ margin: '9px 0 0', color: '#b33b31', fontSize: 14 }}>密码不正确，请重新输入。</p>}
          <button type="submit" style={{ width: '100%', height: 52, marginTop: 18, border: 0, borderRadius: 14, background: '#24231f', color: '#fff', fontWeight: 800, fontSize: 16, cursor: 'pointer' }}>进入演示</button>
        </form>
      </section>
    </main>
  );
}
