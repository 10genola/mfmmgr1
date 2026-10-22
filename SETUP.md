# MFM registration setup

Registration is **$200.00 USD**. Members may send **$200.00 by Zelle** to **giving@mfmnewyork.org**, or pay **$204.47 by PayPal / debit or credit card** ($200.00 registration + $4.47 processing fee). The $4.47 is the church's configured processing fee; it is not a statement of PayPal's actual fee for a transaction.

This package updates the local registration site used for Cloudflare, not the separate summer-camp Site. Both the backend and HTML must be updated. Existing PayPal checkouts already started at $200 keep that amount.

## Updating your existing deployment

1. Open your existing Google Apps Script project.
2. Replace the contents of its code file with **google-apps-script.js** from this package. Save.
3. Keep your existing Script Properties and spreadsheet. This version automatically adds seven tracking columns to the right of the previous 23-column header. Existing registrations stay in place. The script finds the existing registration tab by its headers and saves its fixed tab ID, so moving tabs does not switch the registration data.
4. Select **installRecoveryTrigger** from the function dropdown and click **Run**. Approve permissions if asked. This installs one five-minute payment recovery trigger, replacing an earlier trigger for the same function.
5. Choose **Deploy → Manage deployments → Edit (pencil) → Version: New version → Deploy**. Keep the existing deployment URL. Saving code alone does not update the web app.
6. Replace **index.html** in your GitHub repository with this package's updated file. Let Cloudflare Pages finish its deployment, then refresh your browser. If using direct upload, upload the index-only **mfm-cloudflare-upload.zip**.
   - An older browser page will be asked to refresh before starting checkout with the new total.
   - New HTML connected to an older backend shows both payment options and prices, with disabled buttons and a temporary-unavailability notice. Deploying both files resolves this; do not bypass the version check.
7. Complete the sandbox checks below before accepting real payments.

The original older POC sheet without registration IDs and token hashes cannot be converted automatically. Keep that sheet for reconciliation and start a blank spreadsheet if you are upgrading from that original version. A sheet whose first 23 headers match this package upgrades automatically.

## First-time setup

The recipient account owner must create an app in their PayPal Developer Dashboard. Start in Sandbox. The public Client ID, backend credentials, and recipient merchant ID must belong to the same environment and intended recipient. A PayPal email or PayPal.Me link alone cannot support automatic verification.

Create a blank Google spreadsheet and open **Extensions → Apps Script**. Paste the backend code. In **Project Settings → Script Properties**, set:

| Property | Value |
| --- | --- |
| `PAYPAL_CLIENT_ID` | Recipient app's sandbox Client ID |
| `PAYPAL_CLIENT_SECRET` | Matching sandbox Client Secret |
| `PAYPAL_MERCHANT_ID` | Recipient's sandbox merchant ID, not an email |
| `PAYPAL_ENV` | `sandbox` |
| `SPREADSHEET_ID` | The ID between `/d/` and `/edit` in the spreadsheet URL |

Keep the Client Secret in Script Properties only. Run **installRecoveryTrigger** and authorize it. Deploy as a **Web app**, executing as **Me**, accessible to **Anyone**. Set the resulting `/exec` URL in `index.html`.

The supplied `/exec` URL and public PayPal Client ID are already in this package. Ensure they match your deployment. Replace `YOUR_WAIVER_LINK_HERE`, `YOUR_RELEASE_WAIVER_LINK_HERE`, and the placeholder pastor choices with the real documents and pastor list.

For local preview:

```sh
cd /path/to/mfmmgr1-fixed
python3 -m http.server 8090
```

Open http://127.0.0.1:8090/ . For public use, upload `index.html` to an HTTPS static host. The backend code belongs in Apps Script. Do not use `no-cors`; the form must read the save and payment-verification responses.

## Payment behavior

- A new registration is **Pending**. The server validates all required fields, saves the record, and returns its reference before showing checkout. A waiver or release answer of **No** remains No; the app does not turn it into consent.
- The server fixes new PayPal/card payments at **$204.47 USD**, checks the recipient, amount, currency, and registration before capture, and requires a completed matching capture before recording **Paid**. The price is stored with each checkout. Existing $200 orders retain their original price, including safely replaced expired orders; a browser cannot select its own price.
- A corrected form resubmission updates the same Pending row only before checkout starts. Once an order, payment request, Zelle selection, or coordinator report exists, changed details produce an explicit error; the organizer must handle corrections. Identical resubmissions remain safe.
- A tab's random token restores the same registration on refresh. Retrying a save does not create another row. Siblings may share an email but need separate registration sessions, such as separately opened browser tabs.
- Each registration has a short-lived payment operation lock. PayPal calls run outside the shared spreadsheet lock so other families can keep registering. If an execution stops unexpectedly, its operation lock expires after ten minutes.
- Capture attempts and creation request IDs are saved before contacting PayPal. An interrupted request keeps this information, allowing retries to check or reuse that payment instead of opening another one.
- An existing usable order is reused. A voided order with no payment evidence, or an order explicitly confirmed expired by PayPal with no payment evidence, can be archived and replaced. A timeout, missing order, pending capture, or uncertain response does **not** authorize a new checkout.
- A confirmed funding decline prompts the buyer to choose another payment method through PayPal. Background recovery waits for that choice instead of repeatedly charging a declined instrument. The next approved attempt receives a new request ID; uncertain attempts retain their existing ID. A terminal order whose captures are all confirmed Declined or Failed can be archived and replaced. Pending, refunded, mixed, and unknown outcomes never authorize another order.
- Background recovery checks up to ten Pending orders per run, rotating through the list. It can capture an approved Pending order after the browser closes. It never initiates a charge for a Coordinator, Zelle Pending, or Zelle row.
- New orders include the saved registration email. PayPal controls whether its hosted card form shows that prefill and may let the buyer change it.

## Zelle payments

The payment page offers **Pay with Zelle**. The backend first checks any existing PayPal order without initiating a charge, then records **Zelle Pending** and closes online checkout. Only after that response does the page show the recipient address and transfer instructions. The member sends $200 from their bank's app, using the participant's name and registration reference in the memo when space allows.

Clicking **I have sent my Zelle payment** records **Zelle**. This is a member's report, not confirmation that money arrived. The page says the church is verifying receipt. Refreshing restores the same selection/report; neither step creates a PayPal order or charge.

| Payment Status | Meaning | Organizer action |
| --- | --- | --- |
| Pending | Registration saved; payment not confirmed | Await payment |
| Zelle Pending | Member selected Zelle | Await transfer and report |
| Zelle | Member reports sending a transfer | Check the church's bank activity |
| Coordinator | Member reports paying a coordinator | Confirm receipt with that coordinator |
| Paid | Online payment verified, or receipt confirmed by organizer | Registration confirmed |

To confirm a Zelle transfer, check the recipient bank account for the actual $200 receipt and match it to the participant/reference. Then change **Payment Status** to **Paid**. You may fill **Paid Amount** with `200.00` and **Paid At** with the receipt date, and keep the bank reference in an organizer Notes column after AD. Leave PayPal Order ID and Capture ID unchanged. Never mark Paid based only on a screenshot or the member pressing the report button.

Zelle does not use PayPal credentials or PayPal verification. This implementation has no bank connection, so it cannot automatically detect Zelle receipt. If the member selects Zelle by mistake, have the organizer review the record and any existing PayPal activity before changing the route. The public page does not switch between offline routes once selected.

An online payment that is processing or has an uncertain result blocks Zelle selection until resolved. A completed matching PayPal payment is recorded as Paid instead of offering Zelle.

## Coordinator payments

**I have paid my youth coordinator** records **Coordinator** in Payment Status. This is a report by the registrant, not proof of receipt. Once reported, online checkout is closed and background recovery will not charge that registration.

Before recording the report, the server checks any existing PayPal order without initiating a charge. If payment already completed, it records Paid. If an online payment is processing or its outcome is unknown, the coordinator report is blocked until that payment is resolved.

After independently confirming receipt with the coordinator, the organizer can change Payment Status from Coordinator to Paid. This prevents future online checkout. Do not mark a record Paid merely because the registrant clicked the button.

## Sandbox acceptance checks

Use a sandbox buyer account separate from the sandbox recipient account. These checks involve test money only.

1. Submit a completed form. Verify one Pending row and a registration reference.
2. Refresh or retry a save in the same tab. Verify no duplicate registration.
3. Confirm the page shows $200.00 registration + $4.47 processing fee, then pay $204.47 with the sandbox buyer. Verify Paid, a Capture ID, and the transaction in the recipient's sandbox activity.
4. Cancel checkout. Verify the registration remains Pending.
5. Report payment to a coordinator before approving an online payment. Verify Coordinator in the sheet, no online payment buttons after refresh, and no charge when recovery runs.
6. Close checkout immediately after approving payment. Run **recoverPendingPayments** manually or wait for the trigger. Verify capture and Paid, without making another payment.
7. Refresh after a connection failure. Verify the existing transaction before trying again. A pending capture must not show Registration confirmed.
8. Register a sibling in a fresh registration session. Verify a separate row and payment despite using the same email.
9. Test a funding decline using PayPal sandbox testing tools. Verify that the payer can choose another payment method, and that recovery does not keep retrying the declined instrument.
10. Move another sheet tab before the registration tab and add a Notes column after the application columns. Verify that an existing Paid registration stays Paid and that new payments can still update the correct tab.
11. On a separate test registration, choose Zelle and verify **Zelle Pending** in the sheet. Verify the page shows **giving@mfmnewyork.org** and $200.00. In this test, do not send real money. Click the sent-payment report button and verify **Zelle**, pending confirmation on the page, and no PayPal charge after refresh or recovery. For testing only, mark that test row Paid and confirm the page updates on refresh.
12. Restore a registration whose PayPal checkout started at $200 before this update. Verify its $200 total is disclosed and its existing order still confirms correctly.
13. Before opening checkout, resubmit with a corrected email after a simulated save-response failure. Verify the same row is corrected. After checkout starts, verify changed details are rejected with a clear message.

Run `node run-checks.cjs` for every offline check. This runs JavaScript syntax checks, the regression suite in `payment-tests.cjs`, and the interrupted-write suite in `failure-tests.cjs`. It tests server validation, migration, payment verification, legacy price preservation, Zelle and coordinator races, retry behavior, expired-order handling, recovery, and frontend confirmation callbacks using simulated Google and PayPal services. It does not test Google deployment permissions, browser CORS, account credentials, or PayPal's hosted checkout. No account credentials or money are used by this suite.

For the additional full-page browser suite, install Playwright and Chromium in your development environment (`npm install --no-save playwright`, then `npx playwright install chromium`) and run `node run-checks.cjs --browser`. This also checks keyboard selection, phone autofill, form submission, save-response loss, session restoration, fee disclosure, Zelle selection/reporting and lost responses, backend-version mismatch, coordinator reporting, and payment callbacks in Chromium. All browser requests are intercepted; Google and PayPal are still simulated. You may set `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` to use an already installed Chromium executable.

## Troubleshooting and operations

- Check **Last Payment Check** and **Payment Error** in the spreadsheet. API errors return JSON with `ok:false`, so an Apps Script execution marked Completed does not by itself mean a payment succeeded.
- The automatic `REGISTRATION_TAB_<spreadsheet ID>` Script Property pins the registration tab. Keep it intact. If that tab is deleted, restore it; the app will not silently start a new registration table. For first-time setup or an upgrade with multiple matching tabs, set optional `REGISTRATION_SHEET_ID` to the intended tab’s numeric `gid` from its URL before running `installRecoveryTrigger`. A pinned tab remains authoritative afterward.
- You may add organizer columns, such as Notes, **after column AD**. The app only reads and writes its own first 30 columns.
- Keep the payment tracking columns intact. **PayPal Context** now stores the account and quoted amount together; do not edit it. Do not clear order IDs, request IDs, capture markers, or token hashes to force a fresh payment. Review the existing order in the recipient's PayPal account first.
- If a create-order response was lost and could not be recovered within five hours, the app asks for organizer assistance. It does not assume an old idempotency key still prevents duplicates indefinitely.
- If you switch PayPal environment, merchant, or Client ID, existing checkouts are blocked from being reused under the different configuration. Use a separate spreadsheet for live registrations.
- Recovery depends on Google Apps Script execution limits, quotas, and trigger availability. Check **Triggers** and **Executions** after deployment.
- Closing the browser tab may lose access to its registration token. The organizer can locate the registration by its displayed reference; server recovery continues independently.
- Confirmation emails, refunds/disputes tracking, capacity limits, and spam protection are not implemented. Paid reflects successful verification or organizer confirmation, not subsequent refund/dispute status.

## Going live

After sandbox acceptance, use the recipient's matching **live** Client ID, Client Secret, merchant ID, and `PAYPAL_ENV=live`. Change the PayPal Client ID in the HTML too. Use a new live spreadsheet so sandbox records cannot be mistaken for actual registrations. Deploy a new backend version, upload the HTML, and run **installRecoveryTrigger** against the live configuration.

References: [PayPal funding-failure handling](https://developer.paypal.com/v5/checkout/handle-funding-failure/), [PayPal order updates](https://developer.paypal.com/api/orders/v2/orders-patch), [PayPal request ID retention](https://developer.paypal.com/sdk/orders/v2/orders-create/), [Apps Script installable triggers](https://developers.google.com/apps-script/guides/triggers/installable).
