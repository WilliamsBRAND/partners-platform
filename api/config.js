// Partners app public config. Returns non-secret values the browser needs.
export default function handler(req, res) {
  const siteUrl = process.env.SITE_URL || 'https://partners.tomidewilliams.com';
  const adminUrl = siteUrl + '/admin';
  return res.status(200).json({
    ok: true,
    siteUrl,
    adminUrl,
    appName: 'Partners',
  });
}
