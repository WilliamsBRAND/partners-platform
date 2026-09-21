import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const CONFIG = {
  SUPABASE_URL: "https://pkdpaltivlcdwvvbkjbf.supabase.co",
  SUPABASE_SERVICE_KEY: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InBrZHBhbHRpdmxjZHd2dmJramJmIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc4ODQ0NjYxNiwiZXhwIjoyMTA0MDIyNjE2fQ.dP0sEfZ9hpVlAAd9hoe_Q0oeq9rMtLz_P2amB-tR9vc",
  SENDER_NAME: "Tomide Williams",
  SENDER_EMAIL: "sodunketomide@gmail.com",
  DASHBOARD_URL: "https://partners.tomidewilliams.com/affiliates/dashboard.html",
  FUNDS_URL: "https://partners.tomidewilliams.com/affiliates/funds.html",
  STATE_FILE: path.join(__dirname, "notified_commissions.json"),
  POLL_INTERVAL_MS: 15000
};

/**
 * Get fresh Google OAuth Access Token via GWS CLI credentials
 */
async function getAccessToken() {
  try {
    const raw = execSync('gws.cmd auth export --unmasked', { encoding: 'utf8' });
    const credentials = JSON.parse(raw.replace(/Using keyring backend:.*\n/, '').trim());

    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: credentials.client_id,
        client_secret: credentials.client_secret,
        refresh_token: credentials.refresh_token,
        grant_type: 'refresh_token'
      })
    });

    const tokenData = await tokenRes.json();
    if (!tokenData.access_token) {
      throw new Error('Failed to refresh access token: ' + JSON.stringify(tokenData));
    }
    return tokenData.access_token;
  } catch (err) {
    console.error('[GWS Auth Error]:', err.message);
    throw err;
  }
}

/**
 * Load list of already notified commission IDs (separate sets for pending and approved)
 */
function loadNotifiedCommissions() {
  if (fs.existsSync(CONFIG.STATE_FILE)) {
    try {
      const data = JSON.parse(fs.readFileSync(CONFIG.STATE_FILE, 'utf8'));
      if (Array.isArray(data)) {
        return {
          pending: new Set(data),
          approved: new Set()
        };
      }
      return {
        pending: new Set(data.pending || []),
        approved: new Set(data.approved || [])
      };
    } catch (e) {
      return { pending: new Set(), approved: new Set() };
    }
  }
  return { pending: new Set(), approved: new Set() };
}

/**
 * Save state of notified commission IDs
 */
function saveNotifiedCommissions(state) {
  const output = {
    pending: Array.from(state.pending),
    approved: Array.from(state.approved)
  };
  fs.writeFileSync(CONFIG.STATE_FILE, JSON.stringify(output, null, 2), 'utf8');
}

/**
 * Template 1: Sale Recorded / Pending Review (Ultra-Polished Red & Black, Zero Slop/Emojis)
 */
export function buildPartnerSaleNotificationHtml({ partnerName, partnerCode, productName, orderAmountNaira, commissionNaira }) {
  const firstName = (partnerName || "Partner").split(" ")[0];
  
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Commission Notification</title>
</head>
<body style="margin: 0; padding: 0; background-color: #070707; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; color: #ededed; -webkit-font-smoothing: antialiased;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background-color: #070707; padding: 40px 15px;">
    <tr>
      <td align="center">
        <table role="presentation" width="100%" style="max-width: 540px; background-color: #111111; border: 1px solid #222222; border-radius: 8px; overflow: hidden;" cellspacing="0" cellpadding="0" border="0">
          
          <!-- TOP BRAND HEADER -->
          <tr>
            <td style="padding: 24px 32px 20px 32px; border-bottom: 1px solid #1c1c1c;">
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">
                <tr>
                  <td>
                    <span style="font-size: 11px; font-weight: 700; letter-spacing: 0.14em; text-transform: uppercase; color: #7A0A15;">
                      NEXORA PARTNER NETWORK
                    </span>
                  </td>
                  <td align="right">
                    <span style="display: inline-block; font-size: 10px; font-weight: 600; letter-spacing: 0.08em; text-transform: uppercase; color: #d97706; background-color: #241a0e; border: 1px solid #452b14; padding: 3px 8px; border-radius: 4px;">
                      PENDING REVIEW
                    </span>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- MAIN CONTENT -->
          <tr>
            <td style="padding: 32px 32px 28px 32px;">
              <h1 style="margin: 0 0 16px 0; font-size: 20px; font-weight: 600; color: #ffffff; letter-spacing: -0.01em; line-height: 1.4;">
                New commission recorded for your referral
              </h1>
              
              <p style="margin: 0 0 16px 0; font-size: 14px; line-height: 1.6; color: #a1a1aa;">
                Hi ${firstName},
              </p>
              
              <p style="margin: 0 0 24px 0; font-size: 14px; line-height: 1.6; color: #a1a1aa;">
                A new order has been attributed to your affiliate referral code (<strong style="color: #ffffff;">${partnerCode}</strong>) for <strong style="color: #ffffff;">${productName}</strong>.
              </p>

              <!-- TRANSACTION SUMMARY CARD -->
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background-color: #171717; border: 1px solid #262626; border-radius: 6px; margin-bottom: 24px;">
                <tr>
                  <td style="padding: 16px 20px;">
                    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">
                      <tr>
                        <td style="padding: 8px 0; color: #737373; font-size: 12px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em;">Product</td>
                        <td align="right" style="padding: 8px 0; color: #f5f5f5; font-size: 13px; font-weight: 500;">${productName}</td>
                      </tr>
                      <tr>
                        <td style="padding: 8px 0; color: #737373; font-size: 12px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; border-top: 1px solid #222222;">Order Value</td>
                        <td align="right" style="padding: 8px 0; color: #f5f5f5; font-size: 13px; font-weight: 500; border-top: 1px solid #222222;">₦${orderAmountNaira}</td>
                      </tr>
                      <tr>
                        <td style="padding: 8px 0; color: #737373; font-size: 12px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; border-top: 1px solid #222222;">Commission Amount</td>
                        <td align="right" style="padding: 8px 0; color: #ffffff; font-size: 15px; font-weight: 700; border-top: 1px solid #222222;">₦${commissionNaira}</td>
                      </tr>
                      <tr>
                        <td style="padding: 8px 0; color: #737373; font-size: 12px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; border-top: 1px solid #222222;">Status</td>
                        <td align="right" style="padding: 8px 0; color: #fbbf24; font-size: 12px; font-weight: 600; border-top: 1px solid #222222;">Pending Approval</td>
                      </tr>
                    </table>
                  </td>
                </tr>
              </table>

              <!-- CALLOUT BLOCK -->
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="border-left: 2px solid #7A0A15; background-color: #141414; margin-bottom: 28px;">
                <tr>
                  <td style="padding: 12px 16px; font-size: 13px; line-height: 1.6; color: #9ca3af;">
                    This transaction is logged in our verification queue. As soon as the review is complete, the earnings will move into your available balance for immediate withdrawal.
                  </td>
                </tr>
              </table>

              <!-- CTA BUTTON -->
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="margin-bottom: 32px;">
                <tr>
                  <td>
                    <a href="${CONFIG.DASHBOARD_URL}" target="_blank" style="display: inline-block; background-color: #7A0A15; color: #ffffff; text-decoration: none; font-size: 13px; font-weight: 600; letter-spacing: 0.04em; text-transform: uppercase; padding: 12px 26px; border-radius: 4px; text-align: center;">
                      Open Partner Dashboard
                    </a>
                  </td>
                </tr>
              </table>

              <!-- SIGNATURE -->
              <p style="margin: 0; font-size: 14px; line-height: 1.6; color: #a1a1aa;">
                Best regards,<br>
                <strong style="color: #ffffff; font-weight: 600;">Tomide Williams</strong>
              </p>
            </td>
          </tr>

          <!-- FOOTER -->
          <tr>
            <td style="padding: 20px 32px; background-color: #0c0c0c; border-top: 1px solid #1c1c1c;">
              <p style="margin: 0 0 4px 0; font-size: 12px; color: #71717a;">
                Tomide Williams | Nexora Partner Network
              </p>
              <p style="margin: 0; font-size: 11px; color: #52525b;">
                Partner Code: ${partnerCode}
              </p>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

/**
 * Template 2: Commission Approved (Ultra-Polished Red & Black, Zero Slop/Emojis)
 */
export function buildPartnerApprovedNotificationHtml({ partnerName, partnerCode, productName, orderAmountNaira, commissionNaira }) {
  const firstName = (partnerName || "Partner").split(" ")[0];
  
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Commission Approved</title>
</head>
<body style="margin: 0; padding: 0; background-color: #070707; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; color: #ededed; -webkit-font-smoothing: antialiased;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background-color: #070707; padding: 40px 15px;">
    <tr>
      <td align="center">
        <table role="presentation" width="100%" style="max-width: 540px; background-color: #111111; border: 1px solid #222222; border-radius: 8px; overflow: hidden;" cellspacing="0" cellpadding="0" border="0">
          
          <!-- TOP BRAND HEADER -->
          <tr>
            <td style="padding: 24px 32px 20px 32px; border-bottom: 1px solid #1c1c1c;">
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">
                <tr>
                  <td>
                    <span style="font-size: 11px; font-weight: 700; letter-spacing: 0.14em; text-transform: uppercase; color: #7A0A15;">
                      NEXORA PARTNER NETWORK
                    </span>
                  </td>
                  <td align="right">
                    <span style="display: inline-block; font-size: 10px; font-weight: 600; letter-spacing: 0.08em; text-transform: uppercase; color: #16a34a; background-color: #0d2114; border: 1px solid #164e26; padding: 3px 8px; border-radius: 4px;">
                      APPROVED
                    </span>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- MAIN CONTENT -->
          <tr>
            <td style="padding: 32px 32px 28px 32px;">
              <h1 style="margin: 0 0 16px 0; font-size: 20px; font-weight: 600; color: #ffffff; letter-spacing: -0.01em; line-height: 1.4;">
                Commission approved and credited to your wallet
              </h1>
              
              <p style="margin: 0 0 16px 0; font-size: 14px; line-height: 1.6; color: #a1a1aa;">
                Hi ${firstName},
              </p>
              
              <p style="margin: 0 0 24px 0; font-size: 14px; line-height: 1.6; color: #a1a1aa;">
                Your commission for the referral sale of <strong style="color: #ffffff;">${productName}</strong> (Code: <strong style="color: #ffffff;">${partnerCode}</strong>) has been verified and approved.
              </p>

              <!-- TRANSACTION SUMMARY CARD -->
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background-color: #171717; border: 1px solid #262626; border-radius: 6px; margin-bottom: 24px;">
                <tr>
                  <td style="padding: 16px 20px;">
                    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">
                      <tr>
                        <td style="padding: 8px 0; color: #737373; font-size: 12px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em;">Product</td>
                        <td align="right" style="padding: 8px 0; color: #f5f5f5; font-size: 13px; font-weight: 500;">${productName}</td>
                      </tr>
                      <tr>
                        <td style="padding: 8px 0; color: #737373; font-size: 12px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; border-top: 1px solid #222222;">Order Value</td>
                        <td align="right" style="padding: 8px 0; color: #f5f5f5; font-size: 13px; font-weight: 500; border-top: 1px solid #222222;">₦${orderAmountNaira}</td>
                      </tr>
                      <tr>
                        <td style="padding: 8px 0; color: #737373; font-size: 12px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; border-top: 1px solid #222222;">Credited Amount</td>
                        <td align="right" style="padding: 8px 0; color: #22c55e; font-size: 15px; font-weight: 700; border-top: 1px solid #222222;">₦${commissionNaira}</td>
                      </tr>
                      <tr>
                        <td style="padding: 8px 0; color: #737373; font-size: 12px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; border-top: 1px solid #222222;">Status</td>
                        <td align="right" style="padding: 8px 0; color: #4ade80; font-size: 12px; font-weight: 600; border-top: 1px solid #222222;">Available in Balance</td>
                      </tr>
                    </table>
                  </td>
                </tr>
              </table>

              <!-- CALLOUT BLOCK -->
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="border-left: 2px solid #16a34a; background-color: #141414; margin-bottom: 28px;">
                <tr>
                  <td style="padding: 12px 16px; font-size: 13px; line-height: 1.6; color: #9ca3af;">
                    This amount is now part of your cleared funds. You can initiate a withdrawal directly to your registered bank account from the wallet tab.
                  </td>
                </tr>
              </table>

              <!-- CTA BUTTON -->
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="margin-bottom: 32px;">
                <tr>
                  <td>
                    <a href="${CONFIG.FUNDS_URL}" target="_blank" style="display: inline-block; background-color: #7A0A15; color: #ffffff; text-decoration: none; font-size: 13px; font-weight: 600; letter-spacing: 0.04em; text-transform: uppercase; padding: 12px 26px; border-radius: 4px; text-align: center;">
                      Withdraw Funds
                    </a>
                  </td>
                </tr>
              </table>

              <!-- SIGNATURE -->
              <p style="margin: 0; font-size: 14px; line-height: 1.6; color: #a1a1aa;">
                Best regards,<br>
                <strong style="color: #ffffff; font-weight: 600;">Tomide Williams</strong>
              </p>
            </td>
          </tr>

          <!-- FOOTER -->
          <tr>
            <td style="padding: 20px 32px; background-color: #0c0c0c; border-top: 1px solid #1c1c1c;">
              <p style="margin: 0 0 4px 0; font-size: 12px; color: #71717a;">
                Tomide Williams | Nexora Partner Network
              </p>
              <p style="margin: 0; font-size: 11px; color: #52525b;">
                Partner Code: ${partnerCode}
              </p>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

/**
 * Send Email via Gmail API (GWS CLI token)
 */
export async function sendGmail(accessToken, { to, subject, htmlBody }) {
  const utf8Subject = `=?utf-8?B?${Buffer.from(subject).toString('base64')}?=`;
  const messageParts = [
    `From: "${CONFIG.SENDER_NAME}" <${CONFIG.SENDER_EMAIL}>`,
    `To: ${to}`,
    `Subject: ${utf8Subject}`,
    'MIME-Version: 1.0',
    'Content-Type: text/html; charset=utf-8',
    '',
    htmlBody
  ];
  const message = messageParts.join('\n');
  const encodedMessage = Buffer.from(message)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

  const res = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ raw: encodedMessage })
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Gmail API error (${res.status}): ${errText}`);
  }

  return await res.json();
}

/**
 * Main Worker Loop to process both Pending and Approved commissions
 */
async function checkAndNotifyCommissions() {
  const state = loadNotifiedCommissions();
  
  const headers = {
    apikey: CONFIG.SUPABASE_SERVICE_KEY,
    Authorization: 'Bearer ' + CONFIG.SUPABASE_SERVICE_KEY,
    'Content-Type': 'application/json'
  };

  try {
    const res = await fetch(`${CONFIG.SUPABASE_URL}/rest/v1/commissions?select=*,partners(*),products(*)`, { headers });
    if (!res.ok) {
      console.error(`[Supabase Error ${res.status}]:`, await res.text());
      return;
    }

    const commissions = await res.json();
    let stateChanged = false;
    let accessToken = null;

    for (const comm of commissions) {
      const partner = comm.partners;
      const product = comm.products;

      if (!partner || !partner.email) {
        state.pending.add(comm.id);
        state.approved.add(comm.id);
        continue;
      }

      const orderAmountNaira = (comm.amount_kobo / 100).toLocaleString('en-NG', { minimumFractionDigits: 2 });
      const commissionNaira = (comm.commission_kobo / 100).toLocaleString('en-NG', { minimumFractionDigits: 2 });
      const productName = product?.name || 'Nexora Product';
      const partnerCode = partner.code || 'PARTNER';

      // 1. EVENT 1: New Sale Pending Review
      if (!state.pending.has(comm.id)) {
        console.log(`[Event: Sale Pending] ID: ${comm.id} | Partner: ${partner.name} (${partner.email}) | Product: ${productName}`);

        if (!accessToken) accessToken = await getAccessToken();

        const htmlBody = buildPartnerSaleNotificationHtml({
          partnerName: partner.name,
          partnerCode: partnerCode,
          productName: productName,
          orderAmountNaira: orderAmountNaira,
          commissionNaira: commissionNaira
        });

        const subject = `New Commission Recorded: ₦${commissionNaira} (Pending Review)`;

        try {
          await sendGmail(accessToken, {
            to: partner.email,
            subject: subject,
            htmlBody: htmlBody
          });
          console.log(`  ✓ Pending notification sent to: ${partner.email}`);
          state.pending.add(comm.id);
          stateChanged = true;
        } catch (emailErr) {
          console.error(`  ✗ Failed to send pending email to ${partner.email}:`, emailErr.message);
        }
      }

      // 2. EVENT 2: Commission Approved
      if (comm.status === 'approved' && !state.approved.has(comm.id)) {
        console.log(`[Event: Commission Approved] ID: ${comm.id} | Partner: ${partner.name} (${partner.email}) | Product: ${productName}`);

        if (!accessToken) accessToken = await getAccessToken();

        const htmlBody = buildPartnerApprovedNotificationHtml({
          partnerName: partner.name,
          partnerCode: partnerCode,
          productName: productName,
          orderAmountNaira: orderAmountNaira,
          commissionNaira: commissionNaira
        });

        const subject = `Commission Approved: ₦${commissionNaira} Ready for Withdrawal`;

        try {
          await sendGmail(accessToken, {
            to: partner.email,
            subject: subject,
            htmlBody: htmlBody
          });
          console.log(`  ✓ Approval notification sent to: ${partner.email}`);
          state.approved.add(comm.id);
          stateChanged = true;
        } catch (emailErr) {
          console.error(`  ✗ Failed to send approval email to ${partner.email}:`, emailErr.message);
        }
      }
    }

    if (stateChanged) {
      saveNotifiedCommissions(state);
      console.log(`[State Updated] Notification state synced.`);
    }

  } catch (err) {
    console.error('[Worker Error]:', err.message);
  }
}

// Run immediately or start watch loop
const isWatchMode = process.argv.includes('--watch');

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  console.log(`⚡ Starting Nexora Partner GWS Email Notifier (${isWatchMode ? 'Live Watch Mode' : 'Single Check'})...`);

  checkAndNotifyCommissions().then(() => {
    if (isWatchMode) {
      setInterval(checkAndNotifyCommissions, CONFIG.POLL_INTERVAL_MS);
    }
  });
}
