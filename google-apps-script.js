/**
 * MFM Youth Retreat — Registration Backend (with PayPal verification)
 *
 * Paste this entire file into Google Apps Script (script.google.com)
 * attached to your registration Google Sheet, then deploy as a Web App.
 *
 * BEFORE DEPLOYING — add your PayPal credentials as Script Properties:
 *   1. In Apps Script, click the ⚙ Project Settings icon (left sidebar)
 *   2. Scroll to "Script Properties" → Add script property
 *   3. Add THREE properties:
 *        PAYPAL_CLIENT_ID      = your PayPal Client ID
 *        PAYPAL_CLIENT_SECRET  = your PayPal Client Secret
 *        PAYPAL_ENV            = "sandbox"  (or "live" when you go live)
 *   4. Set EXPECTED_AMOUNT below to your registration fee.
 *
 * The Client Secret stays here in Apps Script — it is never exposed to the browser.
 */

// ============================================================
// CONFIG
// ============================================================
const EXPECTED_AMOUNT   = '200.00';   // must match EVENT_PRICE in index.html
const EXPECTED_CURRENCY = 'USD';
// ============================================================

// Column order in the Sheet (must match the header row exactly)
const COLUMNS = [
  'Timestamp', 'First Name', 'Last Name', 'Email', 'Phone',
  'Gender', 'Grade', 'T-Shirt', 'State',
  'Has Coordinator', 'Branch Pastor',
  'Waiver Done', 'Release Done', 'Zipline',
  'Payment Status', 'PayPal Order ID', 'Paid At', 'Paid Amount'
];

function doPost(e) {
  try {
    const data = JSON.parse(e.postData.contents);
    const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheets()[0];

    // Make sure header row exists
    if (sheet.getLastRow() === 0) {
      sheet.appendRow(COLUMNS);
      sheet.getRange(1, 1, 1, COLUMNS.length)
           .setFontWeight('bold')
           .setBackground('#0E1C36')
           .setFontColor('#FFFFFF');
      sheet.setFrozenRows(1);
    }

    // ============================================================
    // Branch 1: payment confirmation — VERIFY with PayPal first
    // ============================================================
    if (data.confirmPayment) {
      const orderId = data.paypalOrderId;
      const email   = data.email;

      if (!orderId || !email) {
        return jsonOut({ ok: false, error: 'Missing orderId or email' });
      }

      // Ask PayPal directly whether this order is real and completed
      const verification = verifyPayPalOrder(orderId);

      if (!verification.ok) {
        return jsonOut({ ok: false, error: 'PayPal verification failed: ' + verification.error });
      }

      // Find the registration row by email
      const range = sheet.getDataRange().getValues();
      let rowIndex = -1;
      for (let i = 1; i < range.length; i++) {
        if (range[i][3] === email) { rowIndex = i + 1; break; }
      }
      if (rowIndex === -1) {
        return jsonOut({ ok: false, error: 'Registration not found for ' + email });
      }

      // Idempotency: don't double-process the same order
      const existingOrderId = sheet.getRange(rowIndex, 16).getValue();
      if (existingOrderId && existingOrderId === orderId) {
        return jsonOut({ ok: true, alreadyProcessed: true });
      }

      // Mark as paid with verified data straight from PayPal
      sheet.getRange(rowIndex, 15).setValue('Paid');                 // Payment Status
      sheet.getRange(rowIndex, 16).setValue(orderId);                // PayPal Order ID
      sheet.getRange(rowIndex, 17).setValue(verification.paidAt);    // Paid At
      sheet.getRange(rowIndex, 18).setValue(verification.amount);    // Paid Amount

      // Highlight the row green
      sheet.getRange(rowIndex, 1, 1, COLUMNS.length)
           .setBackground('#E8F5E9');

      return jsonOut({ ok: true, verified: true });
    }

    // ============================================================
    // Branch 2: new registration
    // ============================================================
    sheet.appendRow([
      data.timestamp || new Date().toISOString(),
      data.firstName, data.lastName, data.email, data.phone,
      data.gender, data.grade, data.tshirt, data.state,
      data.coordinator, data.pastor,
      data.waiver, data.release, data.zipline,
      'Pending', '', '', ''
    ]);

    // Optional: email yourself when a new registration arrives.
    // Uncomment and set your email to enable.
    /*
    MailApp.sendEmail({
      to: 'youremail@example.com',
      subject: 'New Youth Retreat registration: ' + data.firstName + ' ' + data.lastName,
      body: 'Name: ' + data.firstName + ' ' + data.lastName + '\n' +
            'Email: ' + data.email + '\n' +
            'Phone: ' + data.phone + '\n' +
            'Grade: ' + data.grade + '\n' +
            'Pastor: ' + data.pastor + '\n\n' +
            'See the Sheet for full details.'
    });
    */

    return jsonOut({ ok: true });

  } catch (err) {
    return jsonOut({ ok: false, error: err.toString() });
  }
}

// ============================================================
// PayPal verification — calls PayPal's API server-side
// ============================================================
function verifyPayPalOrder(orderId) {
  const props = PropertiesService.getScriptProperties();
  const clientId     = props.getProperty('PAYPAL_CLIENT_ID');
  const clientSecret = props.getProperty('PAYPAL_CLIENT_SECRET');
  const env          = props.getProperty('PAYPAL_ENV') || 'sandbox';

  if (!clientId || !clientSecret) {
    return { ok: false, error: 'PayPal credentials not configured in Script Properties' };
  }

  const baseUrl = (env === 'live')
    ? 'https://api-m.paypal.com'
    : 'https://api-m.sandbox.paypal.com';

  // Step 1: get an access token
  let token;
  try {
    const tokenRes = UrlFetchApp.fetch(baseUrl + '/v1/oauth2/token', {
      method: 'post',
      headers: {
        'Authorization': 'Basic ' + Utilities.base64Encode(clientId + ':' + clientSecret),
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      payload: 'grant_type=client_credentials',
      muteHttpExceptions: true
    });
    const tokenData = JSON.parse(tokenRes.getContentText());
    token = tokenData.access_token;
    if (!token) return { ok: false, error: 'Could not get PayPal token' };
  } catch (err) {
    return { ok: false, error: 'Token request failed: ' + err.toString() };
  }

  // Step 2: look up the order
  let order;
  try {
    const orderRes = UrlFetchApp.fetch(baseUrl + '/v2/checkout/orders/' + orderId, {
      method: 'get',
      headers: { 'Authorization': 'Bearer ' + token },
      muteHttpExceptions: true
    });
    if (orderRes.getResponseCode() !== 200) {
      return { ok: false, error: 'Order not found (HTTP ' + orderRes.getResponseCode() + ')' };
    }
    order = JSON.parse(orderRes.getContentText());
  } catch (err) {
    return { ok: false, error: 'Order lookup failed: ' + err.toString() };
  }

  // Step 3: validate the order's status, currency, and amount
  if (order.status !== 'COMPLETED') {
    return { ok: false, error: 'Order status is ' + order.status + ', not COMPLETED' };
  }

  const unit = order.purchase_units && order.purchase_units[0];
  const capture = unit && unit.payments && unit.payments.captures && unit.payments.captures[0];
  if (!capture) {
    return { ok: false, error: 'No capture found on order' };
  }

  const amount   = capture.amount.value;
  const currency = capture.amount.currency_code;

  if (currency !== EXPECTED_CURRENCY) {
    return { ok: false, error: 'Wrong currency: ' + currency };
  }
  if (parseFloat(amount) < parseFloat(EXPECTED_AMOUNT)) {
    return { ok: false, error: 'Amount too low: ' + amount };
  }

  return {
    ok: true,
    amount: amount,
    currency: currency,
    paidAt: capture.create_time || new Date().toISOString()
  };
}

function jsonOut(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

// Optional: visiting the URL in a browser shows a friendly message
function doGet() {
  return ContentService.createTextOutput(
    'MFM Youth Retreat registration endpoint is live.'
  );
}
