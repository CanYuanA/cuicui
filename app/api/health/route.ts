export async function GET() {
  const services = {
    openrouter: Boolean(process.env.OPENROUTER_API_KEY),
    iflytek: Boolean(process.env.IFLYTEK_APP_ID && process.env.IFLYTEK_API_KEY && process.env.IFLYTEK_API_SECRET),
    access: Boolean(process.env.SITE_ACCESS_PASSWORD && process.env.DEMO_SESSION_SECRET),
    speech: true,
  };
  return Response.json({
    ok: services.openrouter && services.iflytek && services.access,
    services,
    models: {
      analysis: process.env.OPENROUTER_ANALYSIS_MODEL || 'qwen/qwen3.5-flash-02-23',
      report: process.env.OPENROUTER_REPORT_MODEL || 'qwen/qwen3.7-plus',
      transcription: process.env.OPENROUTER_STT_MODEL || 'qwen/qwen3-asr-1.7b',
    },
  }, { headers: { 'Cache-Control': 'no-store' } });
}
