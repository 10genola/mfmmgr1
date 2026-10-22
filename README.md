# MFM registration

Registration: **$200.00 with Zelle** to **giving@mfmnewyork.org**, or **$204.47 with PayPal / debit or credit card** ($200.00 registration + $4.47 processing fee).

Zelle payments are confirmed by the church after checking bank receipt. A member's payment report does not automatically mark the registration Paid.

Read **SETUP.md** for installation and updates. Deploy the updated Apps Script backend and the updated HTML together; both are required for the new options.

- **index.html** — registration form; upload to the static website host.
- **google-apps-script.js** — backend; paste into Google Apps Script and deploy a new version.
- **SETUP.md** — configuration, deployment, and sandbox testing instructions.
- **run-checks.cjs** — run all offline checks with `node run-checks.cjs`.
- **payment-tests.cjs** — regression checks using simulated Google and PayPal services.
- **failure-tests.cjs** — simulated interrupted writes and retries.
- **browser-tests.cjs** — optional full-page Chromium checks with simulated services; see SETUP.md.

The backend preserves existing registrations from the previous 23-column version and adds its tracking columns automatically.
