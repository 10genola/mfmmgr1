// Offline regression tests: no Google account, PayPal credentials, or network needed.
const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const source = fs.readFileSync(__dirname + '/google-apps-script.js', 'utf8');
const html = fs.readFileSync(__dirname + '/index.html', 'utf8');
const clone = value => JSON.parse(JSON.stringify(value));
const fields = {firstName:'One', lastName:'Camper', email:'parent@example.com', phone:'+1 (212) 555-1234',
  gender:'Female', grade:'8th', tshirt:'M', state:'New York', coordinator:'Yes',
  pastor:'Pastor A', waiver:'No', release:'Yes', zipline:'No'};
const token = n => n.toString(16).padStart(64, '0');
const C = {status:14, order:15, id:18, hash:19, capture:20, checked:21, error:22,
  lease:23, until:24, key:25, started:26, requested:27, history:28, context:29};

function fixture(sheetId = 0) {
  const rows = [], orders = new Map(), keys = new Map(), calls = [], warnings = [];
  const properties = {PAYPAL_CLIENT_ID:'client', PAYPAL_CLIENT_SECRET:'secret',
    PAYPAL_MERCHANT_ID:'merchant', SPREADSHEET_ID:'sheet', PAYPAL_ENV:'sandbox'};
  let locked = false, maxColumns = 26, now = Date.now(), sequence = 0;
  const f = {rows, orders, properties, calls, warnings, beforeRequest:null, afterRequest:null, flushFailure:false};
  const sheet = {
    getSheetId:() => sheetId,
    getMaxColumns:() => maxColumns,
    insertColumnsAfter:(after, count) => { assert.equal(after, maxColumns); maxColumns += count; },
    getLastRow:() => rows.length,
    appendRow:row => rows.push(row.slice()),
    getDataRange:() => ({getValues:() => rows.map(r => Array.from({length:Math.max(...rows.map(v => v.length))}, (_,i) => r[i] ?? ''))}),
    getRange:(row, col, height = 1, width = 1) => {
      assert(col + width - 1 <= maxColumns);
      const write = values => {
        assert.equal(values.length, height, 'setValues row count must match');
        values.forEach((v, i) => {
          assert.equal(v.length, width, 'setValues column count must match');
          rows[row - 1 + i] ||= [];
          v.forEach((value, j) => rows[row - 1 + i][col - 1 + j] = value);
        });
      };
      return {
        getValues:() => Array.from({length:height}, (_, i) =>
          Array.from({length:width}, (_, j) => rows[row - 1 + i]?.[col - 1 + j] ?? '')),
        setValue:value => write([[value]]), setValues:write
      };
    }
  };
  f.sheet = sheet;
  f.sheets = [sheet];
  class Clock extends Date {
    constructor(...args) { super(...(args.length ? args : [now])); }
    static now() { return now; }
  }
  const ctx = {Date:Clock, console:{warn:message => warnings.push(message)},
    PropertiesService:{getScriptProperties:() => ({getProperty:key => properties[key], setProperty:(key,v) => properties[key] = v})},
    SpreadsheetApp:{openById:() => ({getSheets:() => f.sheets, getSheetById:id => f.sheets.find(s => s.getSheetId() === id) || null}), flush:() => { if (f.flushFailure) throw Error('flush failed'); }},
    LockService:{getScriptLock:() => ({tryLock:() => { if (locked) return false; locked = true; return true; }, releaseLock:() => { locked = false; }})},
    Utilities:{getUuid:() => crypto.randomUUID(), DigestAlgorithm:{SHA_256:'SHA256'},
      computeDigest:(_,v) => [...crypto.createHash('sha256').update(v).digest()], base64Encode:v => Buffer.from(v).toString('base64')},
    ContentService:{MimeType:{JSON:'json'}, createTextOutput:s => ({setMimeType:() => JSON.parse(s)})}
  };
  vm.createContext(ctx);
  vm.runInContext(source, ctx);
  f.transport = ctx.paypal;
  f.ctx = ctx;
  f.advance = ms => now += ms;
  f.call = (action, n = 1, data = {}) => ctx.doPost({postData:{contents:JSON.stringify({action, token:token(n), paymentVersion:2, ...data})}});
  f.row = (n = 1) => rows.find(row => row[C.hash] === ctx.hashToken(token(n)));
  f.register = (n = 1, overrides = {}) => {
    const result = f.call('register', n, {...fields, ...overrides});
    assert.equal(result.ok, true, JSON.stringify(result));
    return result;
  };
  f.order = (n = 1) => orders.get(f.row(n)[C.order]);
  f.create = (n = 1) => {
    const result = f.call('createOrder', n);
    assert.equal(result.ok, true, JSON.stringify(result));
    return result.orderId;
  };
  f.complete = order => {
    order.status = 'COMPLETED';
    order.purchase_units[0].payments = {captures:[{id:'CAPTURE' + order.id,
      status:'COMPLETED', amount:clone(order.purchase_units[0].amount), create_time:new Clock().toISOString()}]};
  };
  ctx.paypal = (path, method = 'get', body, requestId, c) => {
    assert.equal(locked, false, 'PayPal must never run under the global script lock');
    calls.push({path, method, body:body && clone(body), requestId});
    if (f.beforeRequest) f.beforeRequest({path, method, body, requestId});
    let result;
    if (path === '/v2/checkout/orders' && method === 'post') {
      assert(requestId, 'creation requires an idempotency key');
      if (!keys.has(requestId)) {
        const order = {id:'ORDER' + (++sequence), status:'CREATED', intent:body.intent,
          purchase_units:clone(body.purchase_units)};
        keys.set(requestId, order.id);
        orders.set(order.id, order);
      }
      result = orders.get(keys.get(requestId));
    } else {
      const id = path.split('/')[4];
      const order = orders.get(id);
      if (!order) throw Error('PayPal request failed (HTTP 404).');
      if (path.endsWith('/capture')) {
        assert(requestId, 'capture requires an idempotency key');
        f.complete(order);
      }
      result = method === 'patch' ? {} : order;
    }
    if (f.afterRequest) f.afterRequest({path, method, body, requestId, result});
    return clone(result);
  };
  f.count = method => calls.filter(c => method === 'capture' ? c.path.endsWith('/capture') : c.method === method).length;
  return f;
}

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('PASS ' + name); }
  catch (e) { console.error('FAIL ' + name); throw e; }
}

test('registration retries, sibling records, server-owned IDs and status', () => {
  const f = fixture();
  const first = f.register(1, {paymentStatus:'Paid', registrationId:'fake'});
  assert.equal(first.paid, false);
  assert.notEqual(first.registrationId, 'fake');
  assert.equal(f.call('register', 1, fields).registrationId, first.registrationId);
  assert.notEqual(f.register(2).registrationId, first.registrationId);
  assert.equal(f.rows.length, 3);
  assert.equal(f.call('status', 3).ok, false);
  assert.equal(f.call('register', 3, {token:[], ...fields}).ok, false);
});

test('all required fields, enums, types and length limits are validated server-side', () => {
  for (const field of Object.keys(fields)) {
    for (const bad of ['', ' ', null, [], {}, 42, true, 'x'.repeat(301), 'x\ny']) {
      const f = fixture();
      assert.equal(f.call('register', 1, {...fields, [field]:bad}).ok, false, field + ': ' + JSON.stringify(bad));
      assert.equal(f.rows.length, 1);
    }
  }
  for (const field of ['gender','grade','tshirt','state','coordinator','waiver','release','zipline']) {
    const f = fixture();
    assert.equal(f.call('register', 1, {...fields, [field]:'invalid choice'}).ok, false);
  }
  for (const bad of ['1234', '2125551234 junk', '+1234567890123456']) {
    assert.equal(fixture().call('register', 1, {...fields, phone:bad}).ok, false);
  }
  assert.equal(fixture().call('register', 1, {...fields, email:'bad@address'}).ok, false);
  const f = fixture(); f.register(1, {waiver:'No', release:'No', zipline:'No'});
  assert.equal(f.row()[11], 'No');
});

test('formula escaping and malformed/oversized requests', () => {
  const f = fixture(); f.register(1, {firstName:'=IMPORTXML("x")'});
  assert.equal(f.row()[1][0], "'");
  assert.equal(f.ctx.doPost({postData:{contents:'null'}}).ok, false);
  assert.equal(f.ctx.doPost({postData:{contents:'x'.repeat(16001)}}).ok, false);
  assert.equal(f.ctx.doPost({postData:{contents:'{'}}).ok, false);
});

test('outdoor sports accepts every checklist combination, including none, and saves a stable selection', () => {
  const options=['Basketball','Soccer','Other sports'];
  for(let mask=0;mask<8;mask++) {
    const sports=options.filter((_,i)=>mask & (1<<i));
    const f=fixture();const result=f.register(1,{sports});
    assert.equal(result.ok,true);assert.equal(f.row()[13],sports.join(', ')||'None selected');
    assert.equal(f.rows[0][13],'Outdoor Sports');
    f.create();
    assert.equal(f.register(1,{sports:[...sports].reverse()}).ok,true,'order of checks does not change the saved details');
    assert.equal(f.rows.length,2);
  }
  for(const sports of [null,'Basketball',42,{},['Zip line'],['basketball'],['Basketball','Basketball'],[true],['=IMPORTXML("x")'],options.concat('Soccer')]) {
    const f=fixture();assert.equal(f.call('register',1,{...fields,sports}).ok,false);assert.equal(f.rows.length,1);
  }
  const f=fixture();const data={...fields,sports:[]};delete data.zipline;
  assert.equal(f.call('register',1,data).ok,true);assert.equal(f.row()[13],'None selected');
});

test('historical zip line answers migrate without moving payment data or organizer notes', () => {
  const f=fixture();f.register();f.register(2,{zipline:'Yes'});
  f.rows[0][13]='Zipline';f.rows[1][13]='No';f.rows[2][13]='Yes';
  f.rows[0][30]='Notes';f.rows[1][30]='Keep this note';
  f.rows[2][C.status]='Paid';f.rows[2][17]='200.00';
  const before=clone(f.rows);
  assert.equal(f.call('status').ok,true);
  assert.equal(f.rows[0][13],'Outdoor Sports');
  for(let i=1;i<f.rows.length;i++) {
    assert.equal(f.rows[i][13],'Zip line: '+before[i][13]);
    assert.deepEqual(clone(f.rows[i].slice(0,13)),before[i].slice(0,13));
    assert.equal(f.rows[i][C.status],before[i][C.status]);
    assert.equal(f.rows[i][17],before[i][17]);
    assert.equal(f.rows[i][30],before[i][30]);
  }
  assert.equal(f.register().ok,true,'an old form can retry its unchanged answer');
  assert.equal(f.row()[13],'Zip line: No');
  f.rows[0][13]='Zipline'; // Interrupted upgrade after values were written.
  delete f.properties.REGISTRATION_TAB_sheet;
  assert.equal(f.call('status').ok,true);assert.equal(f.row()[13],'Zip line: No');
  assert.equal(f.rows[0][13],'Outdoor Sports');
});

test('legacy 23-column sheet is upgraded without changing existing data', () => {
  const f = fixture(); f.register();
  f.rows.forEach(row => row.splice(23));
  const before = clone(f.rows[1]);
  assert.equal(f.call('status').ok, true);
  assert.equal(f.rows[0].length, 30);
  assert.deepEqual(clone(f.rows[1].slice(0,23)), before);
  f.rows[0][1] = 'Unexpected Header';
  assert.equal(f.call('register', 2, fields).ok, false);
  assert.equal(f.rows.length, 2);
});

test('checkout uses saved email, fixed amount/recipient and ignores browser order ID', () => {
  const f = fixture(); f.register(); f.register(2); f.create();
  const body = f.calls.find(c => c.method === 'post').body;
  assert.equal(body.payer.email_address, fields.email);
  assert.deepEqual(body.purchase_units[0].amount, {currency_code:'USD', value:'204.47'});
  assert.equal(body.purchase_units[0].payee.merchant_id, 'merchant');
  assert.equal(f.call('confirmPayment', 2, {paypalOrderId:f.order().id}).paid, false);
});

test('valid existing order is checked and reused, completed order does not reopen checkout', () => {
  const f = fixture(); f.register(); const id = f.create();
  assert.equal(f.create(), id);
  assert.equal(f.orders.size, 1);
  assert.equal(f.count('patch'), 1);
  f.complete(f.order());
  assert.equal(f.call('createOrder').paid, true);
  assert.equal(f.call('createOrder').paid, true);
  assert.equal(f.row()[C.status], 'Paid');
  assert.equal(f.count('capture'), 0);
});

test('recipient, amount, currency, order ID, intent and registration are checked BEFORE capture', () => {
  for (const mutate of [o => o.id = 'OTHER', o => o.intent = 'AUTHORIZE',
    o => o.purchase_units[0].custom_id = 'other', o => o.purchase_units[0].payee.merchant_id = 'other',
    o => o.purchase_units[0].amount.value = '100.00', o => o.purchase_units[0].amount.currency_code = 'EUR',
    o => o.purchase_units.push(clone(o.purchase_units[0]))]) {
    const f = fixture(); f.register(); f.create(); f.order().status = 'APPROVED'; mutate(f.order());
    assert.equal(f.call('confirmPayment').ok, false);
    assert.equal(f.count('capture'), 0);
    assert.equal(f.row()[C.status], 'Pending');
  }
});

test('pending, underpaid, overpaid, foreign or duplicate captures never confirm registration', () => {
  for (const mutate of [c => c.status = 'PENDING', c => c.amount.value = '100.00',
    c => c.amount.value = '205.00', c => c.amount.currency_code = 'EUR', c => c.id = '']) {
    const f = fixture(); f.register(); f.create(); f.complete(f.order());
    mutate(f.order().purchase_units[0].payments.captures[0]);
    assert.equal(f.call('confirmPayment').ok, false);
    assert.equal(f.row()[C.status], 'Pending');
  }
  const f = fixture(); f.register(); f.register(2); f.create(); f.complete(f.order());
  f.row(2)[C.capture] = f.order().purchase_units[0].payments.captures[0].id;
  assert.equal(f.call('confirmPayment').ok, false);
  f.row(2)[C.capture] = ''; f.row(2)[C.history] = f.order().id;
  assert.equal(f.call('confirmPayment').ok, false);
});

test('recovery captures approved Pending rows and confirmation is idempotent', () => {
  const f = fixture(); f.register(); f.create(); f.order().status = 'APPROVED';
  f.ctx.recoverPendingPayments();
  assert.equal(f.row()[C.status], 'Paid');
  assert.equal(f.row()[C.capture], 'CAPTUREORDER1');
  assert.equal(f.call('confirmPayment').paid, true);
  assert.equal(f.count('capture'), 1);
});

test('Coordinator prevents new checkout, confirmation capture, and scheduled capture', () => {
  const f = fixture(); f.register(); f.create(); f.order().status = 'APPROVED';
  assert.equal(f.call('coordinatorPayment').coordinatorReported, true);
  assert.equal(f.row()[C.status], 'Coordinator');
  assert.equal(f.call('createOrder').ok, false);
  assert.equal(f.call('confirmPayment').coordinatorReported, true);
  f.ctx.recoverPendingPayments();
  assert.equal(f.count('capture'), 0);
  assert.equal(f.orders.size, 1);
});

test('coordinator report checks an already completed payment and cannot downgrade Paid', () => {
  const f = fixture(); f.register(); f.create(); f.complete(f.order());
  assert.equal(f.call('coordinatorPayment').paid, true);
  assert.equal(f.row()[C.status], 'Paid');
  assert.equal(f.call('coordinatorPayment').paid, true);
});

test('in-flight capture blocks coordinator changes while unrelated registrations still save', () => {
  const f = fixture(); f.register(); f.create(); f.order().status = 'APPROVED';
  f.beforeRequest = ({path}) => {
    if (!path.endsWith('/capture')) return;
    assert.equal(f.call('coordinatorPayment').ok, false);
    assert.equal(f.call('createOrder').ok, false);
    f.register(2); // Would time out if a global script lock spanned the network call.
  };
  assert.equal(f.call('confirmPayment').paid, true);
  assert.equal(f.row(2)[C.status], 'Pending');
});

test('stale recovery snapshot re-reads Coordinator state before any charge', () => {
  const f = fixture();
  for (const n of [1,2]) { f.register(n); f.create(n); f.order(n).status = 'APPROVED'; }
  f.beforeRequest = ({path}) => { if (path.includes('ORDER1')) f.row(2)[C.status] = 'Coordinator'; };
  f.ctx.recoverPendingPayments();
  assert.equal(f.row(1)[C.status], 'Paid');
  assert.equal(f.row(2)[C.status], 'Coordinator');
  assert.equal(f.count('capture'), 1);
});

test('capture timeout retains marker, blocks alternate payment and safely retries same order/key', () => {
  const f = fixture(); f.register(); f.create(); f.order().status = 'APPROVED';
  let fail = true;
  f.beforeRequest = ({path}) => { if (path.endsWith('/capture') && fail) throw Error('Timeout'); };
  assert.equal(f.call('confirmPayment').ok, false);
  assert.equal(JSON.parse(f.row()[C.requested]).orderId, 'ORDER1');
  assert.equal(f.call('coordinatorPayment').ok, false);
  assert.equal(f.call('createOrder').ok, false);
  fail = false;
  assert.equal(f.call('confirmPayment').paid, true);
  const requests = f.calls.filter(c => c.path.endsWith('/capture'));
  assert.equal(requests[0].requestId, requests[1].requestId);
  assert.equal(f.orders.size, 1);
});

test('lost successful capture response is recovered by read without another capture', () => {
  const f = fixture(); f.register(); f.create(); f.order().status = 'APPROVED';
  f.afterRequest = ({path}) => { if (path.endsWith('/capture')) throw Error('Response lost'); };
  assert.equal(f.call('confirmPayment').ok, false);
  assert.equal(f.call('coordinatorPayment').paid, true);
  assert.equal(f.count('capture'), 1);
});

test('legacy pending capture also blocks coordinator reporting and another checkout', () => {
  const f = fixture(); f.register(); f.create();
  f.order().status = 'APPROVED';
  f.order().purchase_units[0].payments = {captures:[{id:'CAPTURE1', status:'PENDING'}]};
  assert.equal(f.row()[C.requested], '');
  assert.equal(f.call('coordinatorPayment').ok, false);
  assert.equal(f.call('createOrder').ok, false);
  assert.equal(f.count('capture'), 0);
});

test('voided order without payments is archived and replaced with a new creation key', () => {
  const f = fixture(); f.register(); const oldId = f.create();
  const oldKey = f.row()[C.key]; f.order().status = 'VOIDED';
  const newId = f.create();
  assert.notEqual(newId, oldId);
  assert.notEqual(f.row()[C.key], oldKey);
  assert.equal(f.row()[C.history], oldId);
  f.order().status = 'APPROVED';
  assert.equal(f.call('confirmPayment').paid, true);
  assert.equal(f.calls.find(c => c.path.endsWith('/capture')).requestId, 'capture-' + newId);
});

test('explicit expiry is verified before replacement; generic errors do not replace an order', () => {
  const f = fixture(); f.register(); f.create();
  f.beforeRequest = ({path, method}) => {
    if (path.endsWith('ORDER1') && method === 'patch') {
      const e = Error('Expired'); e.paypalIssues = ['ORDER_EXPIRED']; throw e;
    }
  };
  assert.notEqual(f.create(), 'ORDER1');
  assert.equal(f.row()[C.history], 'ORDER1');
  for (const message of ['Timeout', 'HTTP 404', 'HTTP 500']) {
    const g = fixture(); g.register(); g.create();
    g.beforeRequest = () => { throw Error(message); };
    assert.equal(g.call('createOrder').ok, false);
    assert.equal(g.orders.size, 1);
    assert.equal(g.row()[C.order], 'ORDER1');
  }
});

test('an order with payment evidence is never retired, even when voided', () => {
  const f = fixture(); f.register(); f.create(); f.complete(f.order()); f.order().status = 'VOIDED';
  assert.equal(f.call('createOrder').ok, false);
  assert.equal(f.orders.size, 1);
});

test('lost creation response retries the same idempotency key and keeps one order', () => {
  const f = fixture(); f.register();
  let lose = true;
  f.afterRequest = ({path}) => { if (path === '/v2/checkout/orders' && lose) throw Error('Response lost'); };
  assert.equal(f.call('createOrder').ok, false);
  assert.equal(f.call('coordinatorPayment').ok, false);
  assert.equal(f.row()[C.order], '');
  lose = false;
  assert.equal(f.create(), 'ORDER1');
  assert.equal(f.orders.size, 1);
  assert.equal(f.calls[0].requestId, f.calls[1].requestId);
});

test('unresolved creation beyond idempotency retention fails closed', () => {
  const f = fixture(); f.register();
  f.afterRequest = () => { throw Error('Response lost'); };
  assert.equal(f.call('createOrder').ok, false);
  f.afterRequest = null; f.advance(6 * 60 * 60 * 1000);
  assert.match(f.call('createOrder').error, /could not be recovered safely/);
  assert.equal(f.orders.size, 1);
});

test('a first authentication failure does not trap registration as an uncertain payment', () => {
  const f = fixture(); f.register();
  const authFailure = () => { const e = Error('Authentication failed'); e.requestNotSent = true; throw e; };
  f.beforeRequest = authFailure;
  assert.equal(f.call('createOrder').ok, false);
  assert.equal(f.row()[C.key], '');
  f.beforeRequest = null; f.advance(6 * 60 * 60 * 1000);
  f.create(); f.order().status = 'APPROVED';
  f.beforeRequest = ({path}) => { if (path.endsWith('/capture')) authFailure(); };
  assert.equal(f.call('confirmPayment').ok, false);
  assert.equal(f.row()[C.requested], '');
  f.beforeRequest = null;
  assert.equal(f.call('coordinatorPayment').coordinatorReported, true);
});

test('later authentication failures do not erase an earlier uncertain request', () => {
  const f = fixture(); f.register();
  f.afterRequest = () => { throw Error('Response lost'); };
  assert.equal(f.call('createOrder').ok, false);
  const key = f.row()[C.key];
  f.afterRequest = null;
  f.beforeRequest = () => { const e = Error('Authentication failed'); e.requestNotSent = true; throw e; };
  assert.equal(f.call('createOrder').ok, false);
  assert.equal(f.row()[C.key], key);
  assert.equal(f.call('coordinatorPayment').ok, false);
});

test('environment/merchant/client changes cannot silently replace an existing checkout', () => {
  for (const [key, value] of [['PAYPAL_ENV','live'],['PAYPAL_MERCHANT_ID','other'],['PAYPAL_CLIENT_ID','other']]) {
    const f = fixture(); f.register(); f.create(); f.properties[key] = value;
    assert.equal(f.call('createOrder').ok, false);
    assert.equal(f.call('confirmPayment').ok, false);
    assert.equal(f.orders.size, 1);
  }
});

test('expired operation lease can recover; active lease cannot be stolen', () => {
  const f = fixture(); f.register();
  f.row()[C.lease] = 'stopped'; f.row()[C.until] = Date.now() + 120000;
  assert.equal(f.call('status').ok, false);
  f.advance(11 * 60 * 1000);
  assert.equal(f.call('status').ok, true);
  assert.equal(f.row()[C.lease], '');
});

test('row sorting during network activity does not update another camper', () => {
  const f = fixture(); f.register(); f.register(2); f.create(); f.order().status = 'APPROVED';
  let sorted = false;
  f.beforeRequest = () => { if (!sorted) { [f.rows[1], f.rows[2]] = [f.rows[2], f.rows[1]]; sorted = true; } };
  assert.equal(f.call('confirmPayment').paid, true);
  assert.equal(f.row()[C.status], 'Paid');
  assert.equal(f.row(2)[C.status], 'Pending');
});

test('expired operations cannot capture or overwrite a newer operation', () => {
  const f = fixture(); f.register(); f.create(); f.order().status = 'APPROVED';
  f.beforeRequest = () => { f.advance(11 * 60 * 1000); f.row()[C.lease] = 'new-owner'; };
  assert.equal(f.call('confirmPayment').ok, false);
  assert.equal(f.count('capture'), 0);
  assert.equal(f.row()[C.lease], 'new-owner');
  assert.equal(f.row()[C.status], 'Pending');
});

test('recovery rotates bounded batches and logs failures without stopping other registrations', () => {
  const f = fixture();
  for (let n = 1; n <= 12; n++) { f.register(n); f.create(n); }
  f.calls.length = 0;
  f.beforeRequest = ({path}) => { if (path.endsWith('/ORDER1')) throw Error('Test error'); };
  f.ctx.recoverPendingPayments();
  assert.equal(f.calls.length, 10);
  assert.equal(f.row()[C.error], 'Test error');
  assert.equal(f.properties.RECOVERY_CURSOR, '10');
  f.ctx.recoverPendingPayments();
  assert(f.row(12)[C.checked]);
});

test('script lock is released even if SpreadsheetApp.flush fails', () => {
  const f = fixture(); f.flushFailure = true;
  assert.equal(f.call('register', 1, fields).ok, false);
  f.flushFailure = false;
  assert.equal(f.call('register', 1, fields).ok, true);
});

test('PayPal transport handles empty 204, structured errors, and sanitized auth failures', () => {
  const f = fixture(); let apiCode = 204, apiBody = '', authCode = 200, authBody = '{"access_token":"test-token"}';
  f.ctx.UrlFetchApp = {fetch:(url, options) => {
    const auth = url.endsWith('/v1/oauth2/token');
    return {getResponseCode:() => auth ? authCode : apiCode, getContentText:() => auth ? authBody : apiBody};
  }};
  assert.equal(JSON.stringify(f.transport('/order', 'patch', [], null, f.ctx.config())), '{}');
  apiCode = 422; apiBody = '{"details":[{"issue":"ORDER_EXPIRED","description":"private payer data"}]}';
  assert.throws(() => f.transport('/order', 'patch', [], null, f.ctx.config()), e =>
    e.paypalIssues.includes('ORDER_EXPIRED') && !e.message.includes('private payer data'));
  authCode = 401; authBody = '<html>secret</html>';
  assert.throws(() => f.transport('/order', 'get', null, null, f.ctx.config()), /authentication failed/);
});

test('declined funding waits for buyer approval, restarts checkout, and uses a new capture key', () => {
  const f = fixture(); f.register(); f.create(); f.order().status = 'APPROVED';
  f.beforeRequest = ({path}) => {
    if (path.endsWith('/capture')) {
      const e = Error('HTTP 422'); e.paypalIssues = ['INSTRUMENT_DECLINED']; throw e;
    }
  };
  const result = f.call('confirmPayment');
  assert.equal(result.ok, true);
  assert.equal(result.retryPayment, true);
  assert.equal(result.paymentIssue, 'INSTRUMENT_DECLINED');
  const declinedKey = f.calls.find(c => c.path.endsWith('/capture')).requestId;
  f.beforeRequest = null;
  f.ctx.recoverPendingPayments();
  assert.equal(f.call('status').retryPayment, true);
  assert.equal(f.count('capture'), 1, 'recovery and refresh must not retry a declined instrument');
  assert.equal(f.create(), 'ORDER1');
  assert.equal(f.call('confirmPayment').paid, true);
  const attempts = f.calls.filter(c => c.path.endsWith('/capture'));
  assert.notEqual(attempts[1].requestId, declinedKey);
  assert.equal(f.orders.size, 1);
  assert.equal(f.row()[C.error], '');
});

test('a restarted capture with a lost response reuses its new key until resolved', () => {
  const f = fixture(); f.register(); f.create(); f.order().status = 'APPROVED';
  f.beforeRequest = ({path}) => {
    if (path.endsWith('/capture')) { const e = Error('Declined'); e.paypalIssues = ['INSTRUMENT_DECLINED']; throw e; }
  };
  assert.equal(f.call('confirmPayment').retryPayment, true);
  f.beforeRequest = ({path}) => { if (path.endsWith('/capture')) throw Error('Timeout'); };
  assert.equal(f.call('confirmPayment').ok, false);
  const retryKey = f.calls.filter(c => c.path.endsWith('/capture'))[1].requestId;
  assert.equal(f.call('coordinatorPayment').ok, false);
  assert.equal(f.call('createOrder').ok, false);
  f.beforeRequest = null;
  assert.equal(f.call('confirmPayment').paid, true);
  assert.equal(f.calls.filter(c => c.path.endsWith('/capture'))[2].requestId, retryKey);
});

test('coordinator report is allowed after a definite decline, but never captures', () => {
  const f = fixture(); f.register(); f.create(); f.order().status = 'APPROVED';
  f.beforeRequest = ({path}) => {
    if (path.endsWith('/capture')) { const e = Error('Declined'); e.paypalIssues = ['INSTRUMENT_DECLINED']; throw e; }
  };
  f.call('confirmPayment'); f.beforeRequest = null;
  assert.equal(f.call('coordinatorPayment').coordinatorReported, true);
  assert.equal(f.call('confirmPayment').coordinatorReported, true);
  f.ctx.recoverPendingPayments();
  assert.equal(f.count('capture'), 1);
  assert.equal(f.row()[C.status], 'Coordinator');
});

test('terminal declined/failed captures are archived before offering a replacement order', () => {
  for (const status of ['DECLINED','FAILED']) {
    const f = fixture(); f.register(); f.create(); f.complete(f.order());
    f.order().purchase_units[0].payments.captures[0].status = status;
    assert.equal(f.call('status').retryPayment, true);
    assert.equal(f.row()[C.status], 'Pending');
    f.ctx.recoverPendingPayments();
    assert.equal(f.count('capture'), 0);
    assert.equal(f.create(), 'ORDER2');
    assert.equal(f.row()[C.history], 'ORDER1');
    f.order().status = 'APPROVED';
    assert.equal(f.call('confirmPayment').paid, true);
    assert.equal(f.row()[C.capture], 'CAPTUREORDER2');
  }
});

test('pending, refunded, mixed and unrecognized capture outcomes cannot open another order', () => {
  for (const status of ['PENDING','REFUNDED','PARTIALLY_REFUNDED','UNKNOWN']) {
    const f = fixture(); f.register(); f.create(); f.complete(f.order());
    f.order().purchase_units[0].payments.captures[0].status = status;
    assert.equal(f.call('createOrder').ok, false);
    assert.equal(f.orders.size, 1);
  }
  const f = fixture(); f.register(); f.create(); f.complete(f.order());
  f.order().purchase_units[0].payments.captures.push({id:'CAPTURE2',status:'FAILED'});
  assert.equal(f.call('createOrder').ok, false);
  assert.equal(f.orders.size, 1);
});

test('unknown capture errors stay unresolved and legacy attempt markers remain compatible', () => {
  const f = fixture(); f.register(); f.create(); f.order().status = 'APPROVED';
  f.beforeRequest = ({path}) => {
    if (path.endsWith('/capture')) { const e = Error('HTTP 422'); e.paypalIssues = ['UNKNOWN_ISSUE']; throw e; }
  };
  assert.equal(f.call('confirmPayment').ok, false);
  assert.equal(f.call('createOrder').ok, false);
  assert.equal(f.call('coordinatorPayment').ok, false);
  f.beforeRequest = null;
  f.row()[C.requested] = 'ORDER1';
  assert.equal(f.call('confirmPayment').paid, true);
  assert.equal(f.calls.filter(c => c.path.endsWith('/capture')).at(-1).requestId, 'capture-' + f.row()[C.id]);
});

test('payment updates preserve extra Notes and formula columns', () => {
  const f = fixture(); f.register(); f.create();
  f.sheet.insertColumnsAfter(f.sheet.getMaxColumns(), 2);
  f.rows[0][30] = 'Notes'; f.rows[0][31] = 'Organizer formula';
  f.row()[30] = 'Bus seat requested'; f.row()[31] = '=A2';
  f.order().status = 'APPROVED';
  assert.equal(f.call('confirmPayment').paid, true);
  assert.equal(f.row()[30], 'Bus seat requested');
  assert.equal(f.row()[31], '=A2');
  assert.equal(f.call('status').paid, true);
});

test('fixed sheet identity survives tab reordering and cannot reopen a paid checkout', () => {
  const f = fixture(); f.register(); f.create(); f.complete(f.order()); f.call('confirmPayment');
  const registrationId = f.row()[C.id];
  const blank = fixture(7);
  f.sheets.unshift(blank.sheet);
  assert.equal(f.call('status').paid, true);
  assert.equal(f.call('register', 1, fields).registrationId, registrationId);
  assert.equal(f.call('createOrder').paid, true);
  assert.equal(f.orders.size, 1);
  assert.equal(blank.rows.length, 0);
  assert.equal(f.properties.REGISTRATION_TAB_sheet, '0');
});

test('upgrade discovers the existing registration header even when another tab is first', () => {
  const f = fixture(); f.register();
  const id = f.row()[C.id]; delete f.properties.REGISTRATION_TAB_sheet;
  f.rows.forEach(row => row.splice(23));
  const blank = fixture(7); f.sheets.unshift(blank.sheet);
  assert.equal(f.call('status').registrationId, id);
  assert.equal(blank.rows.length, 0);
  assert.equal(f.rows[0].length, 30);
  assert.equal(f.properties.REGISTRATION_TAB_sheet, '0');
});

test('missing or ambiguous registration tabs fail without creating replacement records', () => {
  const f = fixture(); f.register(); const blank = fixture(7);
  f.sheets = [blank.sheet];
  assert.equal(f.call('status').ok, false);
  assert.equal(f.call('register', 1, fields).ok, false);
  assert.equal(blank.rows.length, 0);
  const g = fixture(7); g.register();
  f.sheets = [g.sheet, f.sheet]; delete f.properties.REGISTRATION_TAB_sheet;
  assert.match(f.call('status').error, /ambiguous/);
  f.properties.REGISTRATION_SHEET_ID = '0';
  assert.equal(f.call('status').registrationId, f.row()[C.id]);
});

test('corrected details update the same pending record before any checkout starts', () => {
  const f = fixture(); f.register(1, {email:'typo@example.com'});
  const id = f.row()[C.id];
  const result = f.call('register', 1, {...fields, email:'correct@example.com'});
  assert.equal(result.ok, true);
  assert.equal(result.registrationId, id);
  assert.equal(f.row()[3], 'correct@example.com');
  assert.equal(f.rows.length, 2);
  f.create();
  assert.equal(f.calls.find(c => c.method === 'post').body.payer.email_address, 'correct@example.com');
});

test('changed details are explicitly rejected once checkout, coordinator reporting, or payment starts', () => {
  for (const stage of ['order','creating','coordinator','zelle','paid','busy']) {
    const f = fixture(); f.register();
    if (stage === 'order' || stage === 'paid') f.create();
    if (stage === 'paid') { f.complete(f.order()); f.call('confirmPayment'); }
    if (stage === 'coordinator') f.call('coordinatorPayment');
    if (stage === 'zelle') f.call('selectZelle');
    if (stage === 'creating') f.row()[C.key] = 'pending-create';
    if (stage === 'busy') { f.row()[C.lease] = 'active'; f.row()[C.until] = Date.now() + 600000; }
    const result = f.call('register', 1, {...fields, email:'different@example.com'});
    assert.equal(result.ok, false, stage);
    assert.match(result.error, /details differ/);
    assert.equal(f.row()[3], fields.email);
    assert.equal(f.call('register', 1, fields).ok, true);
  }
});

test('sheet escaping does not make an unchanged registration look like an edit', () => {
  const f = fixture(); f.register(1, {firstName:'=Name'}); f.create();
  f.row()[1] = '=Name'; f.row()[4] = fields.phone; // Sheets returns unescaped text.
  assert.equal(f.call('register', 1, {...fields, firstName:'=Name'}).ok, true);
});

test('phone formatting caps local numbers at ten digits and accepts a US country code', () => {
  const ctx = {};
  vm.createContext(ctx);
  vm.runInContext(html.slice(html.indexOf('function formatPhone('), html.indexOf("document.getElementById('phone').addEventListener")), ctx);
  for (const value of ['2125551234', '(212) 555-1234', '+1 (212) 555-1234', '12125551234', '212555123456', '+1 212555123456', '2125551234 ext 5']) {
    assert.equal(ctx.formatPhone(value), '(212) 555-1234');
  }
  assert.equal(ctx.formatPhone('abc'), '');
  assert.equal(ctx.formatPhone(''), '');
});

test('new quotes separate registration and processing fee; client cannot set the price', () => {
  const f=fixture(); const state=f.register();
  assert.equal(state.registrationAmount, '200.00'); assert.equal(state.checkoutAmount, '204.47');
  assert.equal(state.paymentVersion, 2); assert.equal(state.zelleRecipient, 'giving@mfmnewyork.org');
  const order=f.call('createOrder',1,{amount:'0.01', checkoutAmount:'200.00', processingFee:0});
  assert.equal(order.checkoutAmount,'204.47');
  assert.equal(f.order().purchase_units[0].amount.value,'204.47');
  const saved=JSON.parse(f.row()[C.context]); assert.equal(saved.amount,'204.47'); assert.equal(saved.currency,'USD');
});

test('older browser versions cannot start checkout at an undisclosed higher price', () => {
  for (const paymentVersion of [undefined,1,'2',null]) {
    const f=fixture(); f.register();
    for (const action of ['createOrder','selectZelle','zellePayment']) {
      assert.match(f.call(action,1,{paymentVersion}).error,/refresh this page/);
    }
    assert.equal(f.calls.length,0); assert.equal(f.row()[C.status],'Pending');
  }
});

test('new checkout rejects a capture that omits the processing fee', () => {
  const f=fixture(); f.register(); f.create(); f.complete(f.order());
  f.order().purchase_units[0].payments.captures[0].amount.value='200.00';
  assert.equal(f.call('confirmPayment').ok,false); assert.equal(f.row()[C.status],'Pending');
});

test('legacy $200 orders remain verifiable with or without their original context', () => {
  for (const savedContext of ['', 'sandbox:merchant:client']) {
    const f=fixture(); f.register(); f.create();
    f.row()[C.context]=savedContext;
    f.order().purchase_units[0].amount.value='200.00';
    assert.equal(f.call('status').checkoutAmount,'200.00');
    f.order().status='APPROVED';
    const state=f.call('confirmPayment');
    assert.equal(state.paid,true,JSON.stringify(state)); assert.equal(state.paidAmount,'200.00');
    assert.equal(f.count('capture'),1);
  }
});

test('replacement legacy orders retain their $200 quote, including authentication failure', () => {
  for (const savedContext of ['', 'sandbox:merchant:client']) {
    const f=fixture(); f.register(); f.create();
    f.row()[C.context]=savedContext; f.order().purchase_units[0].amount.value='200.00'; f.order().status='VOIDED';
    f.beforeRequest=({method})=>{if(method==='post'){const e=Error('Authentication failed'); e.requestNotSent=true;throw e;}};
    assert.equal(f.call('createOrder').ok,false);
    assert.equal(f.call('status').checkoutAmount,'200.00');
    f.beforeRequest=null; f.create();
    assert.equal(f.order().purchase_units[0].amount.value,'200.00');
    f.order().status='APPROVED'; assert.equal(f.call('confirmPayment').paid,true);
  }
});

test('lost legacy creation responses recover the same $200 order', () => {
  const f=fixture(); f.register(); f.create();
  f.order().purchase_units[0].amount.value='200.00'; f.row()[C.context]='sandbox:merchant:client';
  f.row()[C.order]='';
  assert.equal(f.create(),'ORDER1'); assert.equal(f.orders.size,1);
  assert.equal(f.call('status').checkoutAmount,'200.00');
});

test('invalid saved price contexts fail closed without creating or capturing payments', () => {
  for(const saved of ['{bad',JSON.stringify({version:2,account:'sandbox:merchant:client',amount:'1.00',currency:'USD'}),
    JSON.stringify({version:2,account:'sandbox:merchant:client',amount:'204.47',currency:'EUR'})]) {
    const f=fixture();f.register();f.row()[C.context]=saved;
    assert.equal(f.call('createOrder').ok,false); assert.equal(f.calls.length,0);
  }
});

test('choosing and reporting Zelle are idempotent and never claim verified payment', () => {
  const f=fixture();f.register();
  assert.equal(f.call('zellePayment').ok,false);
  for(let i=0;i<2;i++) {
    const selected=f.call('selectZelle'); assert.equal(selected.zelleSelected,true);assert.equal(selected.paid,false);
    assert.equal(selected.zelleReported,false);assert.equal(f.row()[C.status],'Zelle Pending');
  }
  for(let i=0;i<2;i++) {
    const reported=f.call('zellePayment');assert.equal(reported.zelleReported,true);assert.equal(reported.paid,false);
    assert.equal(f.row()[C.status],'Zelle');
  }
  assert.equal(f.call('status').zelleReported,true);assert.equal(f.calls.length,0);
  assert.equal(f.row()[17],'');assert.equal(f.row()[C.capture],'');
});

test('Zelle closes an approved online order before transfer instructions and prevents recovery charges', () => {
  const f=fixture();f.register();f.create();f.order().status='APPROVED';
  assert.equal(f.call('selectZelle').zelleSelected,true);
  assert.equal(f.call('createOrder').ok,false);
  assert.equal(f.call('confirmPayment').zelleSelected,true);
  f.ctx.recoverPendingPayments();
  assert.equal(f.count('capture'),0);assert.equal(f.row()[C.status],'Zelle Pending');
  assert.equal(f.call('zellePayment').zelleReported,true);
  f.ctx.recoverPendingPayments();assert.equal(f.count('capture'),0);
});

test('Zelle cannot replace an in-flight or unresolved online payment', () => {
  for(const stage of ['pendingCapture','captureUnknown','createUnknown']) {
    const f=fixture();f.register();
    if(stage==='createUnknown') f.row()[C.key]='unresolved';
    else {
      f.create();f.order().status='APPROVED';
      if(stage==='pendingCapture') f.order().purchase_units[0].payments={captures:[{status:'PENDING'}]};
      else f.row()[C.requested]=new Date().toISOString();
    }
    assert.equal(f.call('selectZelle').ok,false,stage);assert.equal(f.row()[C.status],'Pending');
    assert.equal(f.count('capture'),0);
  }
});

test('Zelle cannot race a capture or downgrade a completed online payment', () => {
  const f=fixture();f.register();f.create();f.order().status='APPROVED';
  f.beforeRequest=({path})=>{if(path.endsWith('/capture'))assert.equal(f.call('selectZelle').ok,false);};
  assert.equal(f.call('confirmPayment').paid,true);
  assert.equal(f.call('selectZelle').paid,true);assert.equal(f.call('zellePayment').paid,true);
  const g=fixture();g.register();g.create();g.complete(g.order());
  assert.equal(g.call('selectZelle').paid,true);assert.equal(g.row()[C.status],'Paid');assert.equal(g.count('capture'),0);
});

test('offline reports cannot change each other and manual receipt confirmation stays Paid', () => {
  const f=fixture();f.register();f.call('selectZelle');f.call('zellePayment');
  assert.equal(f.call('coordinatorPayment').zelleReported,true);assert.equal(f.row()[C.status],'Zelle');
  f.row()[C.status]='Paid';f.row()[17]='200.00';
  for(const action of ['status','selectZelle','zellePayment','createOrder','confirmPayment'])assert.equal(f.call(action).paid,true);
  assert.equal(f.calls.length,0);
  const g=fixture();g.register();g.call('coordinatorPayment');
  assert.equal(g.call('selectZelle').coordinatorReported,true);assert.equal(g.call('zellePayment').ok,false);
  assert.equal(g.row()[C.status],'Coordinator');
});

test('direct visits start fresh; only a matching continuation link restores a tab-local registration', () => {
  const storage = new Map([['mfm-registration-token', token(99)], ['mfm-registration-saved','yes']]);
  const sessionSource = html.slice(html.indexOf('let activeRegistration = null;'), html.indexOf('async function api('));
  function page(href, data = storage) {
    const location = {href};
    const ctx = {URL, location, crypto:crypto.webcrypto, Uint8Array,
      sessionStorage:{getItem:key => data.get(key) ?? null, setItem:(key,value) => data.set(key,value)},
      history:{replaceState:(_state,_title,url) => {location.href = url;}}};
    vm.createContext(ctx);vm.runInContext(sessionSource,ctx);
    return ctx;
  }
  const first=page('https://mfm-registration.test/?source=church#top');
  assert.equal(first.loadRegistrationSession(),false,'legacy saved flags must not reopen a submission');
  const firstToken=first.registrationToken();
  const firstURL=first.location.href;
  const firstID=new URL(firstURL).searchParams.get('registration');
  assert.match(firstID,/^[a-f0-9]{32}$/);assert.match(firstToken,/^[a-f0-9]{64}$/);
  assert.equal(storage.get('mfm-registration:'+firstID),firstToken);
  assert(!firstURL.includes(firstToken),'the URL must never contain a bearer token');
  assert.equal(new URL(firstURL).searchParams.get('source'),'church');
  assert.equal(new URL(firstURL).hash,'#top');
  assert.equal(first.registrationToken(),firstToken,'retry must use the same registration');
  const reload=page(firstURL);
  assert.equal(reload.loadRegistrationSession(),true);assert.equal(reload.registrationToken(),firstToken);
  const direct=page('https://mfm-registration.test/');
  assert.equal(direct.loadRegistrationSession(),false);
  const secondToken=direct.registrationToken();assert.notEqual(secondToken,firstToken);
  assert.equal(first.registrationToken(),firstToken,'an older page keeps its own token after another submission');
  const back=page(firstURL);
  assert.equal(back.loadRegistrationSession(),true);assert.equal(back.registrationToken(),firstToken);
  const shared=page(firstURL,new Map());
  assert.equal(shared.loadRegistrationSession(),false);
  assert.equal(new URL(shared.location.href).searchParams.has('registration'),false);
  const invalid=page('https://mfm-registration.test/?registration=invalid&source=church');
  assert.equal(invalid.loadRegistrationSession(),false);
  assert.equal(invalid.location.href,'https://mfm-registration.test/?source=church');
  storage.set('mfm-registration:'+firstID,'invalid');
  assert.equal(page(firstURL).loadRegistrationSession(),false);
});

async function frontendTests() {
  for (const match of html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)) {
    if (match[1].trim()) new vm.Script(match[1]);
  }
  assert(!html.includes("mode: 'no-cors'"));
  assert(!html.includes('actions.order.capture'));
  function ui(response, initial={}) {
    const nodes = {}, all=[];
    function element() {
      const el={style:{}, textContent:'', children:[], setAttribute:() => {},
        appendChild(child) { this.children.push(child); }, replaceChildren() { this.children = []; },
        remove() { this.removed = true; }, querySelector:selector => nodes[selector] ||= element()};
      all.push(el);return el;
    }
    let callbacks;
    const ctx = {PAYMENT_VERSION:2, document:{getElementById:id => nodes[id] ||= element(), createElement:element},
      paypal:{Buttons:options => { callbacks = options; return {render:() => Promise.resolve()}; }},
      api:async () => response};
    vm.createContext(ctx);
    vm.runInContext(html.slice(html.indexOf('function showSuccessAndPay('), html.indexOf('if (loadRegistrationSession())')), ctx);
    ctx.showSuccessAndPay({registrationId:'REG1', paid:false,paymentVersion:2,checkoutAmount:'204.47',...initial});
    return {nodes, callbacks, ctx, find:text=>all.find(el=>el.textContent===text)};
  }
  const f = ui({paid:true, paidAmount:'204.47',registrationId:'REG1'});
  await assert.rejects(f.callbacks.createOrder());f.callbacks.onError(Error('Checkout closed'));f.callbacks.onCancel();
  assert.equal(f.nodes.h2.textContent, 'Registration confirmed');
  assert.match(f.nodes['paypal-button-container'].children[0].textContent, /Payment verified: \$204.47/);
  assert.equal(f.find('I have paid my youth coordinator').removed,true);
  const g = ui({paid:false, coordinatorReported:true, registrationId:'REG1'});
  await g.callbacks.onApprove();assert.equal(g.nodes.h2.textContent,'Awaiting coordinator verification');
  assert.equal(g.nodes['paypal-button-container'].children[2].hidden,true);
  let restarts = 0;
  const declined = ui({paid:false, retryPayment:true, paymentIssue:'INSTRUMENT_DECLINED', registrationId:'REG1'});
  await declined.callbacks.onApprove({}, {restart:async () => { restarts++; }});
  assert.equal(restarts, 1);
  assert.match(declined.nodes['paypal-button-container'].children[0].textContent, /choose another/i);
  const pending = ui({paid:false, registrationId:'REG1'});
  await pending.callbacks.onApprove({}, {restart:async () => { restarts++; }});
  assert.equal(restarts, 1, 'pending payments must not restart checkout');
  const zelle=ui({}, {zelleSelected:true,zelleReported:true,zelleRecipient:'giving@mfmnewyork.org'});
  assert.equal(zelle.callbacks,undefined);assert.equal(zelle.nodes.h2.textContent,'Zelle payment reported');
  const stale=ui({}, {paymentVersion:undefined});assert.equal(stale.callbacks,undefined);
  assert.match(stale.nodes['paypal-button-container'].children[0].textContent,/Payments are temporarily unavailable/);
  assert.notEqual(stale.nodes['paypal-button-container'].children[2].hidden,true);
  assert.equal(stale.find('Pay with Zelle').disabled,true);
  assert.equal(stale.find('Pay with PayPal or card').disabled,true);
  assert(stale.find('$204.47'));assert(stale.find('$200.00'));
  await stale.find('Pay with Zelle').onclick();
  assert.match(stale.nodes['paypal-button-container'].children[0].textContent,/Payments are temporarily unavailable/);
  passed++;
  console.log('PASS frontend syntax, payment states, version guard, and PayPal funding restart callbacks');
}
frontendTests().then(() => console.log('\n' + passed + ' regression groups passed (including all required-field permutations).'))
  .catch(error => { console.error(error); process.exitCode = 1; });
