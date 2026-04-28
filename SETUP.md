# MFM Youth Retreat — Setup Guide

Three things to set up, in this order:

1. **PayPal sandbox credentials** (you need both Client ID *and* Client Secret)
2. **Google Sheet + Apps Script** (saves registrations and verifies payments)
3. **Hosting on Netlify** (so people can reach your form)

Total time: ~25 minutes.

---

## 1. PayPal credentials

You need **two** things from PayPal: a Client ID (goes in the public HTML) and a Client Secret (stays in Apps Script, never sent to the browser).

1. Go to [developer.paypal.com](https://developer.paypal.com), log in.
2. Click **Apps & Credentials**.
3. Toggle to **Sandbox** for testing.
4. Click **Create App**, name it something like "MFM Retreat", create.
5. Copy two values from the app page:
   - **Client ID** (long string, safe to share)
   - **Client Secret** (click "Show" — keep this private)
6. While you're there: under **Testing Tools → Sandbox Accounts**, note the email/password of the auto-created **personal** account. That's your fake buyer for testing.

You'll switch to **Live** credentials only when you're ready to take real money.

---

## 2. Google Sheet + Apps Script

### 2a. Create the Sheet

1. Go to [sheets.new](https://sheets.new). Name it *MFM Youth Retreat Registrations*.
2. **Extensions → Apps Script**. The code editor opens.
3. Delete the placeholder `function myFunction() {}` and paste the **entire contents of `google-apps-script.js`**.
4. Save (💾 icon or Ctrl/Cmd + S).

### 2b. Add your PayPal credentials as Script Properties

This is the new part — it's how the script knows your secret without the browser ever seeing it.

1. In Apps Script, click the ⚙ **Project Settings** icon (left sidebar, looks like a gear).
2. Scroll down to **Script Properties**.
3. Click **Add script property** and add three properties:

| Property name | Value |
|---|---|
| `PAYPAL_CLIENT_ID` | (paste your Client ID from Step 1) |
| `PAYPAL_CLIENT_SECRET` | (paste your Client Secret from Step 1) |
| `PAYPAL_ENV` | `sandbox` (later change to `live`) |

4. Click **Save script properties**.
5. Back in the editor, near the top of the file, set `EXPECTED_AMOUNT` to your registration fee — must match the price in `index.html`.

### 2c. Deploy as a Web App

1. Click the blue **Deploy** button → **New deployment**.
2. Click ⚙ → choose **Web app**.
3. Set:
   - **Execute as**: `Me`
   - **Who has access**: `Anyone` ← required for the form to submit
4. Click **Deploy**. Authorize when prompted (it'll ask for Sheet access and external URL access — that's PayPal).
5. Copy the **Web app URL**.
6. In `index.html`, paste it where `YOUR_GOOGLE_APPS_SCRIPT_URL` is.
7. In `index.html`, also paste your **Client ID** where `YOUR_PAYPAL_CLIENT_ID` is.
8. Set `EVENT_PRICE` in `index.html` to the same value as `EXPECTED_AMOUNT` in the Apps Script.

> If you change the script later: **Deploy → Manage deployments → ✏ Edit → New version → Deploy**. This keeps the URL the same.

---

## 3. Host on Netlify

1. Go to [app.netlify.com/drop](https://app.netlify.com/drop)
2. Drag `index.html` onto the page.
3. You'll get a URL like `https://random-name-123.netlify.app`. Open it.

---

## 4. Test the full flow

1. Open the Netlify URL.
2. Fill out the form, submit. → A row appears in your Sheet with status **Pending**.
3. Click the PayPal button. Log in with your **sandbox personal account** from Step 1.
4. Complete the fake payment.
5. Watch the success screen briefly say "Verifying payment with PayPal…", then "✓ Payment verified".
6. Check your Sheet — the row turns green, status flips to **Paid**, and you'll see the order ID, paid timestamp, and amount filled in.

### Try the cheating attack

To prove server-side verification works, open browser dev tools (F12 → Console) on the form page and try:

```js
fetch('YOUR_GOOGLE_APPS_SCRIPT_URL', {
  method: 'POST',
  headers: {'Content-Type': 'text/plain;charset=utf-8'},
  body: JSON.stringify({
    confirmPayment: true,
    email: 'someone@example.com',
    paypalOrderId: 'FAKE_ORDER_123'
  })
}).then(r => r.json()).then(console.log);
```

You should see: `{ ok: false, error: "PayPal verification failed: Order not found..." }`. The Sheet stays Pending. ✅

---

## 5. Don't forget — placeholders still in the form

| Placeholder | What to do |
|---|---|
| `YOUR_GOOGLE_APPS_SCRIPT_URL` | Paste your Apps Script Web App URL |
| `YOUR_PAYPAL_CLIENT_ID` | Paste your PayPal Client ID |
| `YOUR_WAIVER_LINK_HERE` | Paste your Google Drive Retreat Waiver link |
| `YOUR_RELEASE_WAIVER_LINK_HERE` | Paste your Google Drive Release Waiver link |
| `Pastor A (placeholder)` etc. | Replace with your actual list of branch pastors |

---

## How it all flows now

```
User fills form
      ↓
Click "Complete Registration"
      ↓
Form data → Apps Script → Google Sheet (new row, "Pending")
      ↓
Success screen, PayPal button appears
      ↓
User pays via PayPal → browser sends ONLY the order ID to Apps Script
      ↓
Apps Script asks PayPal directly: "Is order XYZ real and paid?"
      ↓
PayPal replies → if COMPLETED + amount matches → row marked Paid
                 if not → row stays Pending, user is told to contact leader
```

The Sheet never trusts the browser's word for payment status. The fake-payment attack from before now fails because PayPal won't recognize a fake order ID.

---

## Going live

When you're ready for real money:

1. In PayPal developer dashboard, switch to **Live** and create a Live app (or use your existing live app's credentials).
2. Update **all three** Script Properties in Apps Script: new `PAYPAL_CLIENT_ID`, new `PAYPAL_CLIENT_SECRET`, and change `PAYPAL_ENV` from `sandbox` to `live`.
3. Update the Client ID in `index.html` to the live one.
4. Re-upload to Netlify (drag-drop replaces the file).
5. Do one real $0.01-style test if your event allows it, then refund yourself.

---

## Troubleshooting

- **"PayPal verification failed: Order not found"** → either `PAYPAL_ENV` doesn't match (sandbox order being checked against live API or vice versa), or the Client ID/Secret don't match the environment.
- **"PayPal credentials not configured"** → Script Properties weren't saved correctly. Re-check the spelling of the property names — they must be exactly `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`, `PAYPAL_ENV`.
- **Authorization error when deploying** → re-deploy and click through the auth screens again. Apps Script needs permission to make external URL requests (that's how it talks to PayPal).
- **"Amount too low"** → `EXPECTED_AMOUNT` in Apps Script must be ≤ `EVENT_PRICE` in `index.html`. Easiest is keeping them identical.
- **Row appears but PayPal button never shows** → Check the browser console. Most likely cause: the SDK URL still has the literal string `YOUR_PAYPAL_CLIENT_ID`.
