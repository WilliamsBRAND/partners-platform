import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const CONFIG = {
  SUPABASE_URL: "https://pkdpaltivlcdwvvbkjbf.supabase.co",
  SUPABASE_SERVICE_KEY: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InBrZHBhbHRpdmxjZHd2dmJramJmIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc4ODQ0NjYxNiwiZXhwIjoyMTA0MDIyNjE2fQ.dP0sEfZ9hpVlAAd9hoe_Q0oeq9rMtLz_P2amB-tR9vc",
  ADMIN_EMAIL: "sodunketomide@gmail.com",
  ADMIN_NAME: "Tomide Williams",
  SENDER_NAME: "Tomide Williams (Nexora Partners)",
  SENDER_EMAIL: "sodunketomide@gmail.com",
  ADMIN_URL: "https://partners.tomidewilliams.store/admin/",
  DASHBOARD_URL: "https://partners.tomidewilliams.store/affiliates/dashboard",
  FUNDS_URL: "https://partners.tomidewilliams.store/affiliates/funds",
  STATE_FILE: path.join(__dirname, "notified_commissions.json"),
  POLL_INTERVAL_MS: 15000,
  REMINDER_HOURS_THRESHOLD: 24
};

/**
 * Get fresh Google OAuth Access Token via GWS CLI credentials
 */
async function getAccessToken() {
  try {
    const nodeBin = "C:\\Users\\t.williams\\.cache\\codex-runtimes\\codex-primary-runtime\\dependencies\\node\\bin";
    const raw = execSync('C:\\Users\\t.williams\\AppData\\Roaming\\npm\\gws.cmd auth export --unmasked', {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${nodeBin};${process.env.PATH || ''}`
      }
    });
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
 * Load list of already notified event IDs
 */
function loadState() {
  const defaultState = {
    pending: new Set(),
    approved: new Set(),
    payout_initial: new Set(),
    payout_reminder_24h: new Set(),
    payout_completed: new Set()
  };

  if (fs.existsSync(CONFIG.STATE_FILE)) {
    try {
      const data = JSON.parse(fs.readFileSync(CONFIG.STATE_FILE, 'utf8'));
      return {
        pending: new Set(data.pending || []),
        approved: new Set(data.approved || []),
        payout_initial: new Set(data.payout_initial || []),
        payout_reminder_24h: new Set(data.payout_reminder_24h || []),
        payout_completed: new Set(data.payout_completed || [])
      };
    } catch (e) {
      return defaultState;
    }
  }
  return defaultState;
}

/**
 * Save notification state to disk
 */
function saveState(state) {
  const output = {
    pending: Array.from(state.pending),
    approved: Array.from(state.approved),
    payout_initial: Array.from(state.payout_initial),
    payout_reminder_24h: Array.from(state.payout_reminder_24h),
    payout_completed: Array.from(state.payout_completed)
  };
  fs.writeFileSync(CONFIG.STATE_FILE, JSON.stringify(output, null, 2), 'utf8');
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

// ---------------------------------------------------------------------------
// HTML EMAIL TEMPLATES (TW Brand: Dark #070707, Panel #111111, Crimson #7A0A15)
// ---------------------------------------------------------------------------

/**
 * Template: Admin Alert for Payout Request (Immediate or 24h Reminder)
 */
export function buildAdminPayoutAlertHtml({ partner, amountNaira, payoutRow, isReminder, hoursElapsed }) {
  const badgeText = isReminder ? "24-HOUR OVERDUE REMINDER" : "NEW WITHDRAWAL REQUEST";
  const badgeBg = isReminder ? "#3d0a0e" : "#241a0e";
  const badgeBorder = isReminder ? "#7A0A15" : "#593a18";
  const badgeColor = isReminder ? "#f87171" : "#fbbf24";
  const titleText = isReminder
    ? `Action Needed: Withdrawal Request is ${hoursElapsed}h Overdue`
    : `New Partner Withdrawal Request: ₦${amountNaira}`;

  const reqDate = new Date(payoutRow.created_at).toLocaleString('en-GB', {
    timeZone: 'Africa/Lagos',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  });

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${isReminder ? 'Overdue Withdrawal Reminder' : 'New Withdrawal Request'}</title>
</head>
<body style="margin: 0; padding: 0; background-color: #070707; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; color: #ededed; -webkit-font-smoothing: antialiased;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background-color: #070707; padding: 40px 15px;">
    <tr>
      <td align="center">
        <table role="presentation" width="100%" style="max-width: 560px; background-color: #111111; border: 1px solid #222222; border-radius: 8px; overflow: hidden;" cellspacing="0" cellpadding="0" border="0">
          
          <!-- TOP BRAND HEADER -->
          <tr>
            <td style="padding: 24px 32px 20px 32px; border-bottom: 1px solid #1c1c1c;">
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">
                <tr>
                  <td>
                    <span style="font-size: 11px; font-weight: 700; letter-spacing: 0.14em; text-transform: uppercase; color: #7A0A15;">
                      NEXORA ADMIN ALERTS
                    </span>
                  </td>
                  <td align="right">
                    <span style="display: inline-block; font-size: 10px; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; color: ${badgeColor}; background-color: ${badgeBg}; border: 1px solid ${badgeBorder}; padding: 3px 9px; border-radius: 4px;">
                      ${badgeText}
                    </span>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- MAIN CONTENT -->
          <tr>
            <td style="padding: 32px 32px 28px 32px;">
              <h1 style="margin: 0 0 16px 0; font-size: 20px; font-weight: 700; color: #ffffff; letter-spacing: -0.01em; line-height: 1.4;">
                ${titleText}
              </h1>
              
              <p style="margin: 0 0 20px 0; font-size: 14px; line-height: 1.6; color: #a1a1aa;">
                ${isReminder
                  ? `This is an automated 24-hour follow-up alert. A withdrawal request from <strong style="color: #ffffff;">${partner.name}</strong> was submitted <strong style="color: #f87171;">${hoursElapsed} hours ago</strong> and remains in pending status.`
                  : `A partner has requested a payout withdrawal from their cleared balance. Please review the bank details below and initiate the manual transfer.`}
              </p>

              <!-- PAYOUT DETAILS TABLE -->
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background-color: #161616; border: 1px solid #262626; border-radius: 6px; margin-bottom: 24px;">
                <tr>
                  <td style="padding: 16px 20px;">
                    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">
                      <tr>
                        <td style="padding: 8px 0; color: #737373; font-size: 12px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em;">Partner Name</td>
                        <td align="right" style="padding: 8px 0; color: #f5f5f5; font-size: 13px; font-weight: 600;">${partner.name}</td>
                      </tr>
                      <tr>
                        <td style="padding: 8px 0; color: #737373; font-size: 12px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; border-top: 1px solid #222222;">Partner Code</td>
                        <td align="right" style="padding: 8px 0; color: #f5f5f5; font-size: 13px; font-weight: 500; border-top: 1px solid #222222;">${partner.code || '-'}</td>
                      </tr>
                      <tr>
                        <td style="padding: 8px 0; color: #737373; font-size: 12px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; border-top: 1px solid #222222;">Email</td>
                        <td align="right" style="padding: 8px 0; color: #f5f5f5; font-size: 13px; font-weight: 500; border-top: 1px solid #222222;">${partner.email}</td>
                      </tr>
                      <tr>
                        <td style="padding: 8px 0; color: #737373; font-size: 12px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; border-top: 1px solid #222222;">Phone / WhatsApp</td>
                        <td align="right" style="padding: 8px 0; color: #f5f5f5; font-size: 13px; font-weight: 500; border-top: 1px solid #222222;">${partner.phone || '-'}</td>
                      </tr>
                      <tr>
                        <td style="padding: 10px 0; color: #737373; font-size: 12px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.05em; border-top: 1px solid #222222;">Amount to Transfer</td>
                        <td align="right" style="padding: 10px 0; color: #22c55e; font-size: 17px; font-weight: 800; border-top: 1px solid #222222;">₦${amountNaira}</td>
                      </tr>
                      <tr>
                        <td style="padding: 8px 0; color: #737373; font-size: 12px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; border-top: 1px solid #222222;">Bank Name</td>
                        <td align="right" style="padding: 8px 0; color: #ffffff; font-size: 13.5px; font-weight: 700; border-top: 1px solid #222222;">${partner.bank_name || '-'}</td>
                      </tr>
                      <tr>
                        <td style="padding: 8px 0; color: #737373; font-size: 12px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; border-top: 1px solid #222222;">Account Number</td>
                        <td align="right" style="padding: 8px 0; color: #ffffff; font-size: 14.5px; font-weight: 800; letter-spacing: 0.05em; border-top: 1px solid #222222;">${partner.account_number || '-'}</td>
                      </tr>
                      <tr>
                        <td style="padding: 8px 0; color: #737373; font-size: 12px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; border-top: 1px solid #222222;">Account Name</td>
                        <td align="right" style="padding: 8px 0; color: #f5f5f5; font-size: 13.5px; font-weight: 600; border-top: 1px solid #222222;">${partner.account_name || '-'}</td>
                      </tr>
                      <tr>
                        <td style="padding: 8px 0; color: #737373; font-size: 12px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; border-top: 1px solid #222222;">Submitted Time</td>
                        <td align="right" style="padding: 8px 0; color: #a1a1aa; font-size: 12px; border-top: 1px solid #222222;">${reqDate} WAT</td>
                      </tr>
                    </table>
                  </td>
                </tr>
              </table>

              <!-- CALLOUT ACTION -->
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="border-left: 3px solid ${isReminder ? '#ef4444' : '#7A0A15'}; background-color: #141414; margin-bottom: 28px;">
                <tr>
                  <td style="padding: 12px 16px; font-size: 13px; line-height: 1.6; color: #d4d4d8;">
                    After sending the transfer, open the admin panel and mark the payout as completed to notify the partner and update their ledger.
                  </td>
                </tr>
              </table>

              <!-- CTA BUTTON -->
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="margin-bottom: 28px;">
                <tr>
                  <td>
                    <a href="${CONFIG.ADMIN_URL}" target="_blank" style="display: inline-block; background-color: #7A0A15; color: #ffffff; text-decoration: none; font-size: 13px; font-weight: 700; letter-spacing: 0.04em; text-transform: uppercase; padding: 13px 28px; border-radius: 4px; text-align: center;">
                      Open Admin Dashboard to Process
                    </a>
                  </td>
                </tr>
              </table>

              <p style="margin: 0; font-size: 13px; color: #71717a;">
                Nexora Automated Partner Platform System
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
 * Template: Partner Confirmation for Withdrawal Request
 */
export function buildPartnerPayoutRequestConfirmationHtml({ partnerName, partnerCode, amountNaira, bankName, accountNumber }) {
  const firstName = (partnerName || "Partner").split(" ")[0];

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Withdrawal Request Received</title>
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
                    <span style="display: inline-block; font-size: 10px; font-weight: 600; letter-spacing: 0.08em; text-transform: uppercase; color: #38bdf8; background-color: #082f49; border: 1px solid #0369a1; padding: 3px 8px; border-radius: 4px;">
                      PROCESSING
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
                Withdrawal request received
              </h1>
              
              <p style="margin: 0 0 16px 0; font-size: 14px; line-height: 1.6; color: #a1a1aa;">
                Hi ${firstName},
              </p>
              
              <p style="margin: 0 0 24px 0; font-size: 14px; line-height: 1.6; color: #a1a1aa;">
                We have received your withdrawal request for <strong style="color: #ffffff;">₦${amountNaira}</strong>. Our team is processing the bank transfer to your registered account.
              </p>

              <!-- SUMMARY CARD -->
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background-color: #171717; border: 1px solid #262626; border-radius: 6px; margin-bottom: 24px;">
                <tr>
                  <td style="padding: 16px 20px;">
                    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">
                      <tr>
                        <td style="padding: 8px 0; color: #737373; font-size: 12px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em;">Requested Amount</td>
                        <td align="right" style="padding: 8px 0; color: #ffffff; font-size: 15px; font-weight: 700;">₦${amountNaira}</td>
                      </tr>
                      <tr>
                        <td style="padding: 8px 0; color: #737373; font-size: 12px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; border-top: 1px solid #222222;">Destination Bank</td>
                        <td align="right" style="padding: 8px 0; color: #f5f5f5; font-size: 13px; font-weight: 500; border-top: 1px solid #222222;">${bankName || '-'}</td>
                      </tr>
                      <tr>
                        <td style="padding: 8px 0; color: #737373; font-size: 12px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; border-top: 1px solid #222222;">Account Number</td>
                        <td align="right" style="padding: 8px 0; color: #f5f5f5; font-size: 13px; font-weight: 500; border-top: 1px solid #222222;">${accountNumber || '-'}</td>
                      </tr>
                      <tr>
                        <td style="padding: 8px 0; color: #737373; font-size: 12px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; border-top: 1px solid #222222;">Estimated Timing</td>
                        <td align="right" style="padding: 8px 0; color: #38bdf8; font-size: 12px; font-weight: 600; border-top: 1px solid #222222;">Within 24–48 Hours</td>
                      </tr>
                    </table>
                  </td>
                </tr>
              </table>

              <!-- CTA BUTTON -->
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="margin-bottom: 32px;">
                <tr>
                  <td>
                    <a href="${CONFIG.FUNDS_URL}" target="_blank" style="display: inline-block; background-color: #7A0A15; color: #ffffff; text-decoration: none; font-size: 13px; font-weight: 600; letter-spacing: 0.04em; text-transform: uppercase; padding: 12px 26px; border-radius: 4px; text-align: center;">
                      View Wallet & Payout History
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
              <p style="margin: 0; font-size: 11px; color: #52525b;">
                Partner Code: ${partnerCode} &middot; Nexora Partner Network
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
 * Template: Partner Payout Completed Confirmation
 */
export function buildPartnerPayoutCompletedHtml({ partnerName, partnerCode, amountNaira, bankName, accountNumber }) {
  const firstName = (partnerName || "Partner").split(" ")[0];

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Payout Sent</title>
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
                    <span style="display: inline-block; font-size: 10px; font-weight: 600; letter-spacing: 0.08em; text-transform: uppercase; color: #22c55e; background-color: #0d2114; border: 1px solid #164e26; padding: 3px 8px; border-radius: 4px;">
                      TRANSFERRED
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
                Payout sent to your bank account
              </h1>
              
              <p style="margin: 0 0 16px 0; font-size: 14px; line-height: 1.6; color: #a1a1aa;">
                Hi ${firstName},
              </p>
              
              <p style="margin: 0 0 24px 0; font-size: 14px; line-height: 1.6; color: #a1a1aa;">
                Your withdrawal of <strong style="color: #22c55e;">₦${amountNaira}</strong> has been completed and sent to your bank account (${bankName} - ${accountNumber}).
              </p>

              <!-- CTA BUTTON -->
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="margin-bottom: 32px;">
                <tr>
                  <td>
                    <a href="${CONFIG.DASHBOARD_URL}" target="_blank" style="display: inline-block; background-color: #7A0A15; color: #ffffff; text-decoration: none; font-size: 13px; font-weight: 600; letter-spacing: 0.04em; text-transform: uppercase; padding: 12px 26px; border-radius: 4px; text-align: center;">
                      Go to Dashboard & Keep Promoting
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
              <p style="margin: 0; font-size: 11px; color: #52525b;">
                Partner Code: ${partnerCode} &middot; Nexora Partner Network
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
 * Template: Sale Recorded / Pending Review
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

              <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="border-left: 2px solid #7A0A15; background-color: #141414; margin-bottom: 28px;">
                <tr>
                  <td style="padding: 12px 16px; font-size: 13px; line-height: 1.6; color: #9ca3af;">
                    This transaction is logged in our verification queue. As soon as the review is complete, the earnings will move into your available balance for immediate withdrawal.
                  </td>
                </tr>
              </table>

              <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="margin-bottom: 32px;">
                <tr>
                  <td>
                    <a href="${CONFIG.DASHBOARD_URL}" target="_blank" style="display: inline-block; background-color: #7A0A15; color: #ffffff; text-decoration: none; font-size: 13px; font-weight: 600; letter-spacing: 0.04em; text-transform: uppercase; padding: 12px 26px; border-radius: 4px; text-align: center;">
                      Open Partner Dashboard
                    </a>
                  </td>
                </tr>
              </table>

              <p style="margin: 0; font-size: 14px; line-height: 1.6; color: #a1a1aa;">
                Best regards,<br>
                <strong style="color: #ffffff; font-weight: 600;">Tomide Williams</strong>
              </p>
            </td>
          </tr>

          <tr>
            <td style="padding: 20px 32px; background-color: #0c0c0c; border-top: 1px solid #1c1c1c;">
              <p style="margin: 0; font-size: 11px; color: #52525b;">
                Partner Code: ${partnerCode} &middot; Nexora Partner Network
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
 * Template: Commission Approved
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

              <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="border-left: 2px solid #16a34a; background-color: #141414; margin-bottom: 28px;">
                <tr>
                  <td style="padding: 12px 16px; font-size: 13px; line-height: 1.6; color: #9ca3af;">
                    This amount is now part of your cleared funds. You can initiate a withdrawal directly to your registered bank account from the wallet tab.
                  </td>
                </tr>
              </table>

              <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="margin-bottom: 32px;">
                <tr>
                  <td>
                    <a href="${CONFIG.FUNDS_URL}" target="_blank" style="display: inline-block; background-color: #7A0A15; color: #ffffff; text-decoration: none; font-size: 13px; font-weight: 600; letter-spacing: 0.04em; text-transform: uppercase; padding: 12px 26px; border-radius: 4px; text-align: center;">
                      Withdraw Funds
                    </a>
                  </td>
                </tr>
              </table>

              <p style="margin: 0; font-size: 14px; line-height: 1.6; color: #a1a1aa;">
                Best regards,<br>
                <strong style="color: #ffffff; font-weight: 600;">Tomide Williams</strong>
              </p>
            </td>
          </tr>

          <tr>
            <td style="padding: 20px 32px; background-color: #0c0c0c; border-top: 1px solid #1c1c1c;">
              <p style="margin: 0; font-size: 11px; color: #52525b;">
                Partner Code: ${partnerCode} &middot; Nexora Partner Network
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

// ---------------------------------------------------------------------------
// NOTIFICATION WORKERS
// ---------------------------------------------------------------------------

/**
 * Process Payout Request Notifications (Immediate Alert, 24h Reminder, Completion)
 */
async function checkAndNotifyPayouts(state, accessTokenRef) {
  const headers = {
    apikey: CONFIG.SUPABASE_SERVICE_KEY,
    Authorization: 'Bearer ' + CONFIG.SUPABASE_SERVICE_KEY,
    'Content-Type': 'application/json'
  };

  try {
    const res = await fetch(`${CONFIG.SUPABASE_URL}/rest/v1/payouts?select=*,partners(*)`, { headers });
    if (!res.ok) {
      console.error(`[Payouts Fetch Error ${res.status}]:`, await res.text());
      return false;
    }

    const payouts = await res.json();
    let stateChanged = false;

    for (const payout of payouts) {
      const partner = payout.partners;
      if (!partner) continue;

      const amountNaira = ((payout.amount_kobo || 0) / 100).toLocaleString('en-NG', { minimumFractionDigits: 2 });
      const createdTime = new Date(payout.created_at).getTime();
      const elapsedMs = Date.now() - createdTime;
      const hoursElapsed = Math.floor(elapsedMs / (1000 * 60 * 60));

      // 1. EVENT 1: New Withdrawal Request (Immediate Admin Alert & Partner Confirmation)
      if (!state.payout_initial.has(payout.id)) {
        console.log(`[Event: New Payout Request] ID: ${payout.id} | Partner: ${partner.name} | Amount: ₦${amountNaira}`);

        if (!accessTokenRef.token) accessTokenRef.token = await getAccessToken();

        // 1A. Email to Admin (Tomide)
        const adminHtml = buildAdminPayoutAlertHtml({
          partner,
          amountNaira,
          payoutRow: payout,
          isReminder: false,
          hoursElapsed
        });

        try {
          await sendGmail(accessTokenRef.token, {
            to: CONFIG.ADMIN_EMAIL,
            subject: `[Action Required] New Withdrawal Request: ₦${amountNaira} — ${partner.name}`,
            htmlBody: adminHtml
          });
          console.log(`  ✓ Admin payout alert sent to: ${CONFIG.ADMIN_EMAIL}`);
        } catch (adminErr) {
          console.error(`  ✗ Failed to send admin payout alert:`, adminErr.message);
        }

        // 1B. Confirmation Email to Partner
        if (partner.email) {
          const partnerHtml = buildPartnerPayoutRequestConfirmationHtml({
            partnerName: partner.name,
            partnerCode: partner.code,
            amountNaira,
            bankName: partner.bank_name,
            accountNumber: partner.account_number
          });

          try {
            await sendGmail(accessTokenRef.token, {
              to: partner.email,
              subject: `Withdrawal Request Received: ₦${amountNaira}`,
              htmlBody: partnerHtml
            });
            console.log(`  ✓ Partner payout confirmation sent to: ${partner.email}`);
          } catch (partnerErr) {
            console.error(`  ✗ Failed to send partner confirmation:`, partnerErr.message);
          }
        }

        state.payout_initial.add(payout.id);
        stateChanged = true;
      }

      // 2. EVENT 2: 24-Hour Follow-up Reminder if Still Pending
      if (
        payout.status === 'pending' &&
        hoursElapsed >= CONFIG.REMINDER_HOURS_THRESHOLD &&
        !state.payout_reminder_24h.has(payout.id)
      ) {
        console.log(`[Event: 24h Payout Reminder] ID: ${payout.id} | Partner: ${partner.name} | Overdue: ${hoursElapsed}h`);

        if (!accessTokenRef.token) accessTokenRef.token = await getAccessToken();

        const reminderHtml = buildAdminPayoutAlertHtml({
          partner,
          amountNaira,
          payoutRow: payout,
          isReminder: true,
          hoursElapsed
        });

        try {
          await sendGmail(accessTokenRef.token, {
            to: CONFIG.ADMIN_EMAIL,
            subject: `[Reminder: 24h Overdue] Pending Withdrawal: ₦${amountNaira} for ${partner.name}`,
            htmlBody: reminderHtml
          });
          console.log(`  ✓ 24h overdue reminder sent to: ${CONFIG.ADMIN_EMAIL}`);
          state.payout_reminder_24h.add(payout.id);
          stateChanged = true;
        } catch (remErr) {
          console.error(`  ✗ Failed to send 24h reminder:`, remErr.message);
        }
      }

      // 3. EVENT 3: Payout Completed Notification to Partner
      if (payout.status === 'completed' && !state.payout_completed.has(payout.id)) {
        if (partner.email) {
          if (!accessTokenRef.token) accessTokenRef.token = await getAccessToken();

          const completedHtml = buildPartnerPayoutCompletedHtml({
            partnerName: partner.name,
            partnerCode: partner.code,
            amountNaira,
            bankName: partner.bank_name,
            accountNumber: partner.account_number
          });

          try {
            await sendGmail(accessTokenRef.token, {
              to: partner.email,
              subject: `Payout Sent: ₦${amountNaira} Transferred to Your Account`,
              htmlBody: completedHtml
            });
            console.log(`  ✓ Payout completed notice sent to: ${partner.email}`);
            state.payout_completed.add(payout.id);
            stateChanged = true;
          } catch (compErr) {
            console.error(`  ✗ Failed to send payout completed notice:`, compErr.message);
          }
        } else {
          state.payout_completed.add(payout.id);
          stateChanged = true;
        }
      }
    }

    return stateChanged;
  } catch (err) {
    console.error('[Payouts Worker Error]:', err.message);
    return false;
  }
}

/**
 * Process Commissions Notifications (Pending & Approved)
 */
async function checkAndNotifyCommissions(state, accessTokenRef) {
  const headers = {
    apikey: CONFIG.SUPABASE_SERVICE_KEY,
    Authorization: 'Bearer ' + CONFIG.SUPABASE_SERVICE_KEY,
    'Content-Type': 'application/json'
  };

  try {
    const res = await fetch(`${CONFIG.SUPABASE_URL}/rest/v1/commissions?select=*,partners(*),products(*)`, { headers });
    if (!res.ok) {
      console.error(`[Commissions Fetch Error ${res.status}]:`, await res.text());
      return false;
    }

    const commissions = await res.json();
    let stateChanged = false;

    for (const comm of commissions) {
      const partner = comm.partners;
      const product = comm.products;

      if (!partner || !partner.email) {
        state.pending.add(comm.id);
        state.approved.add(comm.id);
        continue;
      }

      const orderAmountNaira = ((comm.amount_kobo || 0) / 100).toLocaleString('en-NG', { minimumFractionDigits: 2 });
      const commissionNaira = ((comm.commission_kobo || 0) / 100).toLocaleString('en-NG', { minimumFractionDigits: 2 });
      const productName = product?.name || 'Nexora Product';
      const partnerCode = partner.code || 'PARTNER';

      // 1. EVENT 1: New Sale Pending Review
      if (!state.pending.has(comm.id)) {
        console.log(`[Event: Sale Pending] ID: ${comm.id} | Partner: ${partner.name} (${partner.email}) | Product: ${productName}`);

        if (!accessTokenRef.token) accessTokenRef.token = await getAccessToken();

        const htmlBody = buildPartnerSaleNotificationHtml({
          partnerName: partner.name,
          partnerCode,
          productName,
          orderAmountNaira,
          commissionNaira
        });

        try {
          await sendGmail(accessTokenRef.token, {
            to: partner.email,
            subject: `New Commission Recorded: ₦${commissionNaira} (Pending Review)`,
            htmlBody
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

        if (!accessTokenRef.token) accessTokenRef.token = await getAccessToken();

        const htmlBody = buildPartnerApprovedNotificationHtml({
          partnerName: partner.name,
          partnerCode,
          productName,
          orderAmountNaira,
          commissionNaira
        });

        try {
          await sendGmail(accessTokenRef.token, {
            to: partner.email,
            subject: `Commission Approved: ₦${commissionNaira} Ready for Withdrawal`,
            htmlBody
          });
          console.log(`  ✓ Approval notification sent to: ${partner.email}`);
          state.approved.add(comm.id);
          stateChanged = true;
        } catch (emailErr) {
          console.error(`  ✗ Failed to send approval email to ${partner.email}:`, emailErr.message);
        }
      }
    }

    return stateChanged;
  } catch (err) {
    console.error('[Commissions Worker Error]:', err.message);
    return false;
  }
}

/**
 * Main cycle: processes both payouts and commissions
 */
export async function runNotificationCycle() {
  const state = loadState();
  const accessTokenRef = { token: null };

  const payoutsChanged = await checkAndNotifyPayouts(state, accessTokenRef);
  const commsChanged = await checkAndNotifyCommissions(state, accessTokenRef);

  if (payoutsChanged || commsChanged) {
    saveState(state);
    console.log(`[State Updated] Notification state synced.`);
  }
}

// ---------------------------------------------------------------------------
// EXECUTION ENTRY POINT
// ---------------------------------------------------------------------------
const isWatchMode = process.argv.includes('--watch');

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  console.log(`⚡ Starting Nexora Partner & Payouts GWS Email Notifier (${isWatchMode ? 'Live Watch Mode' : 'Single Check'})...`);

  runNotificationCycle().then(() => {
    if (isWatchMode) {
      setInterval(runNotificationCycle, CONFIG.POLL_INTERVAL_MS);
    }
  });
}
