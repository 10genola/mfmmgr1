/** MFM registration. Configure Script Properties, then run installRecoveryTrigger(). */
const REGISTRATION_AMOUNT = '200.00';
const PROCESSING_FEE = '4.47';
const EXPECTED_AMOUNT = '204.47';
const EXPECTED_CURRENCY = 'USD';
const PAYMENT_VERSION = 2;
const ZELLE_RECIPIENT = 'giving@mfmnewyork.org';
const COLUMNS = [
  'Timestamp', 'First Name', 'Last Name', 'Email', 'Phone', 'Gender', 'Grade',
  'T-Shirt', 'State', 'Has Coordinator', 'Branch Pastor', 'Waiver Done',
  'Release Done', 'Zipline', 'Payment Status', 'PayPal Order ID', 'Paid At',
  'Paid Amount', 'Registration ID', 'Token Hash', 'Capture ID',
  'Last Payment Check', 'Payment Error',
  // Added to the right of the existing 23 columns; existing rows are preserved.
  'Payment Lock', 'Payment Lock Until', 'Create Request ID', 'Create Requested At',
  'Capture Requested', 'Previous PayPal Orders', 'PayPal Context'
];
// Zero-based indexes for the payment columns.
const COL = {status:14, order:15, paidAt:16, amount:17, id:18, hash:19,
  capture:20, checked:21, error:22, lease:23, leaseUntil:24, createKey:25,
  createAt:26, captureRequested:27, history:28, context:29};
const PAYMENT_LEASE_MS = 10 * 60 * 1000; // Longer than Apps Script's 6-minute execution limit.
const CREATE_RETRY_MS = 5 * 60 * 60 * 1000; // Stay inside PayPal's default 6-hour retention.
const FORM_FIELDS = ['firstName','lastName','email','phone','gender','grade','tshirt',
  'state','coordinator','pastor','waiver','release','zipline'];
const STATES = ('Alabama|Alaska|Arizona|Arkansas|California|Colorado|Connecticut|Delaware|Florida|' +
  'Georgia|Hawaii|Idaho|Illinois|Indiana|Iowa|Kansas|Kentucky|Louisiana|Maine|Maryland|' +
  'Massachusetts|Michigan|Minnesota|Mississippi|Missouri|Montana|Nebraska|Nevada|' +
  'New Hampshire|New Jersey|New Mexico|New York|North Carolina|North Dakota|Ohio|' +
  'Oklahoma|Oregon|Pennsylvania|Rhode Island|South Carolina|South Dakota|Tennessee|' +
  'Texas|Utah|Vermont|Virginia|Washington|West Virginia|Wisconsin|Wyoming').split('|');

function config() {
  const p = PropertiesService.getScriptProperties();
  const c = {client:p.getProperty('PAYPAL_CLIENT_ID'), secret:p.getProperty('PAYPAL_CLIENT_SECRET'),
    merchant:p.getProperty('PAYPAL_MERCHANT_ID'), sheet:p.getProperty('SPREADSHEET_ID'),
    env:p.getProperty('PAYPAL_ENV'), tab:p.getProperty('REGISTRATION_SHEET_ID')};
  if (!c.client || !c.secret || !c.merchant || !c.sheet || !['sandbox','live'].includes(c.env)) {
    throw Error('Payment setup is incomplete. Contact the organizer.');
  }
  c.base = c.env === 'live' ? 'https://api-m.paypal.com' : 'https://api-m.sandbox.paypal.com';
  c.context = c.env + ':' + c.merchant + ':' + c.client;
  return c;
}

// Only short spreadsheet operations belong here. Never call PayPal under this lock.
function locked(fn) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) throw Error('Server busy. Please retry.');
  try { return fn(); }
  finally {
    try { SpreadsheetApp.flush(); } finally { lock.releaseLock(); }
  }
}

function registrationSheet(c) {
  const book = SpreadsheetApp.openById(c.sheet);
  const properties = PropertiesService.getScriptProperties();
  const bindingKey = 'REGISTRATION_TAB_' + c.sheet;
  const pinned = properties.getProperty(bindingKey);
  const selected = pinned === null || pinned === undefined ? c.tab : pinned;
  let s;
  if (selected !== null && selected !== undefined && selected !== '') {
    if (!/^\d+$/.test(String(selected))) throw Error('Invalid registration sheet ID. Contact the organizer.');
    s = book.getSheetById(Number(selected));
    if (!s) throw Error('The registration tab is missing. Restore it before accepting registrations.');
  } else {
    // Discover the previous version's tab by its header, never by tab position.
    const sheets = book.getSheets();
    const matches = sheets.filter(tab => tab.getLastRow() && tab.getMaxColumns() >= 23 &&
      JSON.stringify(tab.getRange(1, 1, 1, 23).getValues()[0]) === JSON.stringify(COLUMNS.slice(0, 23)));
    if (matches.length === 1) s = matches[0];
    else if (!matches.length && sheets.length === 1 && !sheets[0].getLastRow()) s = sheets[0];
    else throw Error('Registration tab is ambiguous. Set REGISTRATION_SHEET_ID to the intended tab gid, then run installRecoveryTrigger.');
  }
  if (s.getMaxColumns() < COLUMNS.length) {
    s.insertColumnsAfter(s.getMaxColumns(), COLUMNS.length - s.getMaxColumns());
  }
  if (!s.getLastRow()) s.appendRow(COLUMNS);
  const header = s.getRange(1, 1, 1, COLUMNS.length).getValues()[0];
  const legacy = header.slice(23).every(v => v === '');
  const expected = legacy ? COLUMNS.slice(0, 23) : COLUMNS;
  if (JSON.stringify(header.slice(0, expected.length)) !== JSON.stringify(expected)) {
    throw Error('Sheet headers do not match. Contact the organizer; do not delete existing registrations.');
  }
  if (legacy) s.getRange(1, 24, 1, COLUMNS.length - 23).setValues([COLUMNS.slice(23)]);
  if (pinned !== String(s.getSheetId())) properties.setProperty(bindingKey, String(s.getSheetId()));
  return s;
}

function registrationRows(s) {
  return s.getRange(1, 1, s.getLastRow(), COLUMNS.length).getValues();
}

function hashToken(token) {
  if (typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token)) throw Error('Invalid registration token.');
  return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, token)
    .map(b => ('0' + ((b + 256) % 256).toString(16)).slice(-2)).join('');
}
function rowFor(s, hash) {
  const rows = registrationRows(s);
  const i = rows.findIndex((r, i) => i > 0 && r[COL.hash] === hash);
  if (i < 0) return null;
  const values = rows[i].slice(0, COLUMNS.length);
  while (values.length < COLUMNS.length) values.push('');
  return {number:i + 1, values:values};
}
function clean(value) {
  const v = String(value || '').trim().slice(0, 300);
  return /^[=+@\-]/.test(v) ? "'" + v : v;
}
function registrationState(r) {
  const attempt = captureAttempt(r);
  return {ok:true, registrationId:r.values[COL.id], paid:r.values[COL.status] === 'Paid',
    coordinatorReported:r.values[COL.status] === 'Coordinator',
    zelleSelected:['Zelle Pending','Zelle'].includes(r.values[COL.status]),
    zelleReported:r.values[COL.status] === 'Zelle',
    paymentVersion:PAYMENT_VERSION, registrationAmount:REGISTRATION_AMOUNT,
    checkoutAmount:onlineAmount(r), zelleRecipient:ZELLE_RECIPIENT,
    paidAmount:r.values[COL.amount] ? String(r.values[COL.amount]) : '',
    retryPayment:r.values[COL.status] === 'Pending' && attempt.retryRequired,
    paymentIssue:attempt.issue || ''};
}

// Keep the price with the existing PayPal context rather than adding columns
// over organizer Notes. Orders started before this release retain their $200 quote.
function checkoutContext(r) {
  const saved = String(r.values[COL.context] || '');
  if (!saved.startsWith('{')) return {account:saved, amount:
    saved || r.values[COL.order] || r.values[COL.createKey] ? REGISTRATION_AMOUNT : EXPECTED_AMOUNT};
  let value;
  try { value = JSON.parse(saved); } catch (e) { throw Error('Payment tracking needs organizer review.'); }
  if (!value || value.version !== PAYMENT_VERSION || typeof value.account !== 'string' || !value.account ||
      value.currency !== EXPECTED_CURRENCY || ![REGISTRATION_AMOUNT, EXPECTED_AMOUNT].includes(value.amount)) {
    throw Error('Payment tracking needs organizer review.');
  }
  return value;
}
function onlineAmount(r) { return checkoutContext(r).amount; }
function validateRegistration(d) {
  const values = {};
  FORM_FIELDS.forEach(key => {
    const limit = key === 'email' ? 254 : key === 'phone' ? 40 : 100;
    if (typeof d[key] !== 'string' || !d[key].trim() || d[key].trim().length > limit || /[\x00-\x1f\x7f]/.test(d[key])) {
      throw Error('Please provide a valid ' + key + '.');
    }
    values[key] = d[key].trim();
  });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(values.email)) throw Error('Please provide a valid email.');
  const digits = values.phone.replace(/\D/g, '');
  if (!/^[+\d\s().-]+$/.test(values.phone) || digits.length < 10 || digits.length > 15) {
    throw Error('Please provide a valid phone number.');
  }
  const choices = {gender:['Male','Female'], grade:['6th','7th','8th','9th','10th','11th','12th','College / Adult'],
    tshirt:['XS','S','M','L','XL','XXL'], state:STATES};
  ['coordinator','waiver','release','zipline'].forEach(key => choices[key] = ['Yes','No']);
  Object.keys(choices).forEach(key => {
    if (!choices[key].includes(values[key])) throw Error('Please choose a valid ' + key + '.');
  });
  // A "No" waiver/release answer is valid; it is not turned into consent.
  return FORM_FIELDS.map(key => clean(values[key]));
}
function register(d, hash, c) {
  return locked(() => {
    const s = registrationSheet(c);
    const details = validateRegistration(d);
    let r = rowFor(s, hash);
    if (!r) {
      const values = [new Date().toISOString(), ...details,
        'Pending','','','',Utilities.getUuid(),hash,'','',''];
      while (values.length < COLUMNS.length) values.push('');
      s.appendRow(values);
      r = rowFor(s, hash);
    } else if (details.some((value, i) => value !== clean(r.values[i + 1]))) {
      const active = r.values[COL.lease] && Number(r.values[COL.leaseUntil]) > Date.now();
      if (r.values[COL.status] !== 'Pending' || active || r.values[COL.order] ||
          r.values[COL.createKey] || r.values[COL.captureRequested] || r.values[COL.history]) {
        throw Error('The submitted details differ from this saved registration, and checkout has already started. Contact the organizer to correct them.');
      }
      // Correct a lost-response resubmission only before any checkout has started.
      s.getRange(r.number, 2, 1, FORM_FIELDS.length).setValues([details]);
      r = rowFor(s, hash);
    }
    return registrationState(r);
  });
}

// A durable lease serializes one registration, while other families can keep saving.
// If an execution dies, the lease expires; request IDs and capture markers survive it.
function withPayment(hash, c, fn) {
  const lease = Utilities.getUuid();
  locked(() => {
    const s = registrationSheet(c);
    const r = rowFor(s, hash);
    if (!r) throw Error('Registration not found. Save your details first.');
    if (r.values[COL.lease] && Number(r.values[COL.leaseUntil]) > Date.now()) {
      throw Error('This registration is already processing a payment request. Wait a moment, then refresh.');
    }
    s.getRange(r.number, COL.lease + 1, 1, 2).setValues([[lease, Date.now() + PAYMENT_LEASE_MS]]);
  });
  const operation = {hash:hash, lease:lease, config:c};
  try { return fn(operation); }
  catch (e) {
    updatePayment(operation, (s, r) => {
      r.values[COL.checked] = new Date().toISOString();
      r.values[COL.error] = clean(e.message);
    });
    throw e;
  } finally {
    locked(() => {
      const s = registrationSheet(c);
      const r = rowFor(s, hash);
      if (r && r.values[COL.lease] === lease) {
        s.getRange(r.number, COL.lease + 1, 1, 2).setValues([['','']]);
      }
    });
  }
}
function updatePayment(op, change) {
  return locked(() => {
    const s = registrationSheet(op.config);
    const r = rowFor(s, op.hash);
    if (!r || r.values[COL.lease] !== op.lease || Number(r.values[COL.leaseUntil]) <= Date.now()) {
      throw Error('Payment request expired. Refresh to check its status before retrying.');
    }
    if (change) {
      change(s, r);
      // Do not rewrite contact details or rely on a row number saved before a network call.
      s.getRange(r.number, COL.status + 1, 1, COLUMNS.length - COL.status)
        .setValues([r.values.slice(COL.status, COLUMNS.length)]);
    }
    return r;
  });
}
function assertContext(r, c) {
  const saved = checkoutContext(r);
  if (saved.account && saved.account !== c.context) {
    throw Error('This checkout belongs to a different PayPal configuration. Contact the organizer.');
  }
}
function requirePending(r) {
  if (r.values[COL.status] !== 'Pending') {
    throw Error('Online checkout is closed for this registration. Refresh to see its payment status.');
  }
}
function hasPayments(order) {
  const p = order.purchase_units[0].payments || {};
  return Object.keys(p).some(key => Array.isArray(p[key]) && p[key].length > 0);
}
function failedCapture(order) {
  if (order.status !== 'COMPLETED') return false;
  const payments = order.purchase_units[0].payments || {};
  const captures = payments.captures || [];
  return captures.length > 0 && captures.every(c => c.id && ['DECLINED','FAILED'].includes(c.status)) &&
    Object.keys(payments).every(key => key === 'captures' || (Array.isArray(payments[key]) && !payments[key].length));
}
function captureAttempt(r) {
  const saved = r.values[COL.captureRequested];
  const original = {orderId:r.values[COL.order],
    key:r.values[COL.history] ? 'capture-' + r.values[COL.order] : 'capture-' + r.values[COL.id],
    retryRequired:false, issue:''};
  if (!saved || saved === r.values[COL.order]) return original; // Upgrade legacy markers.
  let attempt;
  try { attempt = JSON.parse(saved); } catch (e) { throw Error('Payment tracking needs organizer review.'); }
  if (!attempt || attempt.orderId !== r.values[COL.order] || typeof attempt.key !== 'string' ||
      !/^[a-zA-Z0-9_-]{1,108}$/.test(attempt.key) || typeof attempt.retryRequired !== 'boolean' ||
      !['','INSTRUMENT_DECLINED','PAYMENT_DECLINED'].includes(attempt.issue)) {
    throw Error('Payment tracking needs organizer review.');
  }
  return attempt;
}
function requirePaymentRetry(op, issue) {
  return registrationState(updatePayment(op, (s, r) => {
    if (r.values[COL.status] !== 'Pending') return;
    const attempt = captureAttempt(r);
    attempt.retryRequired = true;
    attempt.issue = issue;
    r.values[COL.captureRequested] = JSON.stringify(attempt);
    r.values[COL.checked] = new Date().toISOString();
    r.values[COL.error] = 'Payment declined. The payer must choose another payment method.';
  }));
}
function validateBinding(order, r, c) {
  if (order.id !== r.values[COL.order]) throw Error('Order ID mismatch.');
  if (order.intent !== 'CAPTURE') throw Error('Unexpected payment intent.');
  if (!order.purchase_units || order.purchase_units.length !== 1) throw Error('Unexpected purchase units.');
  const unit = order.purchase_units[0];
  if (unit.custom_id !== r.values[COL.id]) throw Error('Payment belongs to another registration.');
  if (!unit.payee || unit.payee.merchant_id !== c.merchant) throw Error('Payment recipient does not match.');
  const expected = onlineAmount(r);
  if (!unit.amount || unit.amount.currency_code !== EXPECTED_CURRENCY || unit.amount.value !== expected) {
    throw Error('Payment must be exactly ' + expected + ' ' + EXPECTED_CURRENCY + '.');
  }
}
function validateOrder(order, registrationId, merchantId, expected) {
  if (order.status !== 'COMPLETED') throw Error('Payment is not completed.');
  if (!order.purchase_units || order.purchase_units.length !== 1) throw Error('Unexpected purchase units.');
  const unit = order.purchase_units[0];
  if (unit.custom_id !== registrationId) throw Error('Payment belongs to another registration.');
  if (!unit.payee || unit.payee.merchant_id !== merchantId) throw Error('Payment recipient does not match.');
  const captures = unit.payments && unit.payments.captures;
  if (!captures || captures.length !== 1) throw Error('Unexpected payment captures.');
  const capture = captures[0];
  if (capture.status !== 'COMPLETED' || !capture.id) throw Error('Payment capture is not completed.');
  if (!capture.amount || capture.amount.currency_code !== EXPECTED_CURRENCY || capture.amount.value !== expected) {
    throw Error('Payment must be exactly ' + expected + ' ' + EXPECTED_CURRENCY + '.');
  }
  return capture;
}
function loadOrder(op, r) {
  assertContext(r, op.config);
  const order = paypal('/v2/checkout/orders/' + encodeURIComponent(r.values[COL.order]), 'get', null, null, op.config);
  validateBinding(order, r, op.config); // Check recipient and amount BEFORE any capture, too.
  return order;
}
function recordOrder(op, order) {
  if (failedCapture(order)) return requirePaymentRetry(op, 'PAYMENT_DECLINED');
  return registrationState(updatePayment(op, (s, r) => {
    validateBinding(order, r, op.config);
    if (!r.values[COL.context]) r.values[COL.context] = op.config.context;
    r.values[COL.checked] = new Date().toISOString();
    r.values[COL.error] = captureAttempt(r).retryRequired ? 'Payment declined. The payer must choose another payment method.' : '';
    if (order.status !== 'COMPLETED') return;
    const capture = validateOrder(order, r.values[COL.id], op.config.merchant, onlineAmount(r));
    const duplicate = registrationRows(s).some((v, i) => i > 0 && i + 1 !== r.number &&
      (v[COL.order] === order.id || v[COL.capture] === capture.id ||
       String(v[COL.history] || '').split(',').includes(order.id)));
    if (duplicate) throw Error('Payment is already assigned to a different registration.');
    r.values[COL.status] = 'Paid';
    r.values[COL.paidAt] = capture.create_time || new Date().toISOString();
    r.values[COL.amount] = capture.amount.value;
    r.values[COL.capture] = capture.id;
    r.values[COL.captureRequested] = '';
    r.values[COL.error] = '';
  }));
}
function reconcile(op, allowCapture, buyerApproved) {
  let r = updatePayment(op);
  if (['Paid','Coordinator','Zelle Pending','Zelle'].includes(r.values[COL.status]) || !r.values[COL.order]) return registrationState(r);
  let order = loadOrder(op, r);
  const previousAttempt = captureAttempt(r);
  if (allowCapture && (!previousAttempt.retryRequired || buyerApproved) &&
      r.values[COL.status] === 'Pending' && order.status === 'APPROVED' && !hasPayments(order)) {
    const previouslyRequested = r.values[COL.captureRequested];
    r = updatePayment(op, (s, fresh) => {
      requirePending(fresh);
      if (fresh.values[COL.order] !== order.id) throw Error('Checkout changed. Refresh to check payment status.');
      const attempt = captureAttempt(fresh);
      if (attempt.retryRequired) attempt.key = Utilities.getUuid();
      attempt.retryRequired = false;
      attempt.issue = '';
      fresh.values[COL.captureRequested] = JSON.stringify(attempt); // Persist BEFORE charging.
    });
    const requestId = captureAttempt(r).key;
    try {
      paypal('/v2/checkout/orders/' + encodeURIComponent(order.id) + '/capture', 'post', {}, requestId, op.config);
    } catch (e) {
      if (e.paypalIssues && e.paypalIssues.includes('INSTRUMENT_DECLINED')) {
        return requirePaymentRetry(op, 'INSTRUMENT_DECLINED');
      }
      if (e.requestNotSent && (!previouslyRequested || previousAttempt.retryRequired)) {
        updatePayment(op, (s, fresh) => fresh.values[COL.captureRequested] = previouslyRequested || '');
      }
      throw e;
    }
    order = loadOrder(op, r);
  }
  const state = recordOrder(op, order);
  state.paymentProcessing = !state.paid && hasPayments(order) && !failedCapture(order);
  return state;
}
function coordinatorPayment(op) {
  return selectOfflinePayment(op, 'Coordinator');
}
function selectOfflinePayment(op, status) {
  // Close online checkout BEFORE showing Zelle transfer instructions. Reconcile
  // read-only: selecting another payment route must never initiate a PayPal charge.
  const state = reconcile(op, false);
  if (state.paid || state.coordinatorReported || state.zelleSelected) return state;
  if (state.paymentProcessing) throw Error('An online payment is still processing. Please refresh to check it before using another payment method.');
  return registrationState(updatePayment(op, (s, r) => {
    requirePending(r);
    if ((r.values[COL.captureRequested] && !captureAttempt(r).retryRequired) ||
        (r.values[COL.createKey] && !r.values[COL.order])) {
      throw Error('An online payment request is unresolved. Please refresh or contact your youth coordinator before using another payment method.');
    }
    r.values[COL.status] = status;
    r.values[COL.checked] = new Date().toISOString();
    r.values[COL.error] = '';
  }));
}
function zellePayment(op) {
  return registrationState(updatePayment(op, (s, r) => {
    if (r.values[COL.status] === 'Paid' || r.values[COL.status] === 'Zelle') return;
    if (r.values[COL.status] !== 'Zelle Pending') throw Error('Please choose Zelle before reporting your payment.');
    r.values[COL.status] = 'Zelle'; // Self-report only. A church organizer must verify bank receipt.
    r.values[COL.checked] = new Date().toISOString();
    r.values[COL.error] = '';
  }));
}
function retireOrder(op, order) {
  if (hasPayments(order) && !failedCapture(order)) throw Error('An existing payment needs organizer review before another checkout can open.');
  updatePayment(op, (s, r) => {
    requirePending(r);
    if (r.values[COL.order] !== order.id) throw Error('Checkout changed. Refresh to check payment status.');
    const history = String(r.values[COL.history] || '').split(',').filter(Boolean);
    history.push(order.id);
    r.values[COL.history] = history.join(',');
    if (!r.values[COL.context]) r.values[COL.context] = JSON.stringify({version:PAYMENT_VERSION,
      account:op.config.context, amount:onlineAmount(r), currency:EXPECTED_CURRENCY});
    r.values[COL.order] = '';
    r.values[COL.createKey] = '';
    r.values[COL.createAt] = '';
    r.values[COL.captureRequested] = '';
  });
}
function createOrder(op) {
  let r = updatePayment(op);
  if (r.values[COL.status] === 'Paid') return registrationState(r);
  requirePending(r);
  assertContext(r, op.config);
  if (r.values[COL.order]) {
    let order = loadOrder(op, r);
    if (order.status === 'COMPLETED' && !failedCapture(order)) return recordOrder(op, order);
    if (order.status === 'VOIDED' || failedCapture(order)) {
      retireOrder(op, order);
    } else {
      if (!['CREATED','SAVED','PAYER_ACTION_REQUIRED','APPROVED'].includes(order.status) || hasPayments(order) ||
          (r.values[COL.captureRequested] && !captureAttempt(r).retryRequired)) {
        throw Error('An online payment is still being checked. Refresh before trying to pay again.');
      }
      // PayPal can return a stale CREATED order. A no-change update verifies usability.
      // Only an explicit ORDER_EXPIRED response permits replacement; 404/timeouts do not.
      if (['CREATED','APPROVED'].includes(order.status)) {
        try {
          const reference = order.purchase_units[0].reference_id || 'default';
          if (!/^[a-zA-Z0-9_-]+$/.test(reference)) throw Error('Unexpected order reference.');
          paypal('/v2/checkout/orders/' + encodeURIComponent(order.id), 'patch',
            [{op:'replace', path:"/purchase_units/@reference_id=='" + reference + "'/custom_id", value:r.values[COL.id]}], null, op.config);
        } catch (e) {
          if (!e.paypalIssues || !e.paypalIssues.includes('ORDER_EXPIRED')) throw e;
          order = loadOrder(op, r); // Verify again before discarding a known order.
          if (order.status === 'COMPLETED') return recordOrder(op, order);
          retireOrder(op, order);
          order = null;
        }
      }
      if (order) return {...registrationState(r), orderId:order.id};
    }
  }
  let firstAttempt = false;
  let previousContext = '';
  r = updatePayment(op, (s, fresh) => {
    requirePending(fresh);
    if (!fresh.values[COL.createKey]) {
      firstAttempt = true;
      previousContext = fresh.values[COL.context];
      const quotedAmount = onlineAmount(fresh);
      fresh.values[COL.createKey] = fresh.values[COL.history] ? Utilities.getUuid() : 'create-' + fresh.values[COL.id];
      fresh.values[COL.createAt] = new Date().toISOString();
      fresh.values[COL.context] = JSON.stringify({version:PAYMENT_VERSION, account:op.config.context,
        amount:quotedAmount, currency:EXPECTED_CURRENCY});
    }
  });
  const started = Date.parse(r.values[COL.createAt]);
  if (!Number.isFinite(started) || Date.now() - started > CREATE_RETRY_MS) {
    throw Error('An earlier checkout could not be recovered safely. Contact the organizer before making another payment.');
  }
  let order;
  try {
    order = paypal('/v2/checkout/orders', 'post', {
      intent:'CAPTURE', payer:{email_address:String(r.values[3]).trim()},
      purchase_units:[{custom_id:r.values[COL.id], payee:{merchant_id:op.config.merchant},
        description:onlineAmount(r) === EXPECTED_AMOUNT ?
          'MFM Youth & Young Adults event: $'+REGISTRATION_AMOUNT+' registration + $'+PROCESSING_FEE+' processing fee' : 'MFM Youth & Young Adults event registration',
        amount:{currency_code:EXPECTED_CURRENCY, value:onlineAmount(r)}}]
    }, r.values[COL.createKey], op.config);
  } catch (e) {
    // Authentication can fail before PayPal receives an order request. Only clear
    // a first attempt; an earlier ambiguous request still needs reconciliation.
    if (e.requestNotSent && firstAttempt) {
      updatePayment(op, (s, fresh) => {
        fresh.values[COL.createKey] = '';
        fresh.values[COL.createAt] = '';
        fresh.values[COL.context] = previousContext || '';
      });
    }
    throw e;
  }
  if (!order.id || typeof order.id !== 'string' || !/^[A-Z0-9]+$/.test(order.id)) throw Error('PayPal did not return a valid order ID.');
  r = updatePayment(op, (s, fresh) => {
    requirePending(fresh);
    fresh.values[COL.order] = order.id;
    fresh.values[COL.error] = '';
  });
  return {...registrationState(r), orderId:order.id};
}

function doPost(e) {
  try {
    const contents = e && e.postData && e.postData.contents;
    if (typeof contents !== 'string' || contents.length > 16000) throw Error('Invalid registration request.');
    const d = JSON.parse(contents);
    if (!d || typeof d !== 'object' || Array.isArray(d)) throw Error('Invalid registration request.');
    const hash = hashToken(d.token);
    const c = config();
    let result;
    if (d.action === 'register') result = register(d, hash, c);
    else if (['createOrder','coordinatorPayment','selectZelle','zellePayment','confirmPayment','status'].includes(d.action)) {
      if (['createOrder','selectZelle','zellePayment'].includes(d.action) && d.paymentVersion !== PAYMENT_VERSION) {
        throw Error('Payment options have changed. Please refresh this page to view the current amounts.');
      }
      result = withPayment(hash, c, op => {
        if (d.action === 'createOrder') return createOrder(op);
        if (d.action === 'coordinatorPayment') return coordinatorPayment(op);
        if (d.action === 'selectZelle') return selectOfflinePayment(op, 'Zelle Pending');
        if (d.action === 'zellePayment') return zellePayment(op);
        return reconcile(op, true, d.action === 'confirmPayment');
      });
    } else throw Error('Unknown action.');
    return jsonOut(result);
  } catch (e) { return jsonOut({ok:false, error:e.message}); }
}

function paypal(path, method, body, requestId, c) {
  const tokenResponse = UrlFetchApp.fetch(c.base + '/v1/oauth2/token', {
    method:'post', headers:{Authorization:'Basic ' + Utilities.base64Encode(c.client + ':' + c.secret)},
    payload:'grant_type=client_credentials', contentType:'application/x-www-form-urlencoded', muteHttpExceptions:true
  });
  let token;
  try { token = JSON.parse(tokenResponse.getContentText()).access_token; } catch (e) { /* Safe message below. */ }
  if (tokenResponse.getResponseCode() !== 200 || !token) {
    const error = Error('PayPal authentication failed. Contact the organizer.');
    error.requestNotSent = true;
    throw error;
  }
  const options = {method:method || 'get', headers:{Authorization:'Bearer ' + token, 'Content-Type':'application/json'}, muteHttpExceptions:true};
  if (requestId) options.headers['PayPal-Request-Id'] = requestId;
  if (body) options.payload = JSON.stringify(body);
  const response = UrlFetchApp.fetch(c.base + path, options);
  const code = response.getResponseCode();
  let data = {};
  try { data = JSON.parse(response.getContentText() || '{}'); }
  catch (e) { throw Error('PayPal returned an unreadable response. Refresh to check payment status.'); }
  if (code < 200 || code >= 300) {
    const error = Error('PayPal request failed (HTTP ' + code + '). Refresh to check payment status or contact the organizer.');
    error.paypalIssues = (Array.isArray(data.details) ? data.details : []).map(d => d.issue);
    throw error; // Never return credentials, raw PayPal responses, or buyer details.
  }
  return data; // PATCH succeeds with HTTP 204 and an empty body.
}

function recoverPendingPayments() {
  const c = config();
  const start = Date.now();
  const hashes = locked(() => {
    const rows = registrationRows(registrationSheet(c));
    return rows.filter((v, i) => i > 0 && v[COL.status] === 'Pending' && v[COL.order] && v[COL.hash])
      .map(v => v[COL.hash]);
  });
  const p = PropertiesService.getScriptProperties();
  let cursor = Math.max(0, Number(p.getProperty('RECOVERY_CURSOR')) || 0) % Math.max(1, hashes.length);
  for (let n = 0; n < Math.min(10, hashes.length) && Date.now() - start < 180000; n++) {
    const hash = hashes[cursor];
    try { withPayment(hash, c, op => reconcile(op, true)); }
    catch (e) { console.warn('Payment recovery needs attention: ' + clean(e.message)); }
    cursor = (cursor + 1) % hashes.length;
    // Advance even if the next execution or request times out.
    p.setProperty('RECOVERY_CURSOR', String(cursor));
  }
}
function installRecoveryTrigger() {
  const c = config();
  locked(() => registrationSheet(c));
  ScriptApp.getProjectTriggers().filter(t => t.getHandlerFunction() === 'recoverPendingPayments')
    .forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('recoverPendingPayments').timeBased().everyMinutes(5).create();
}
function jsonOut(value) { return ContentService.createTextOutput(JSON.stringify(value)).setMimeType(ContentService.MimeType.JSON); }
function doGet() { return ContentService.createTextOutput('MFM registration service'); }
