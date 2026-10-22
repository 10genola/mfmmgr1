const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const assert = require('node:assert/strict');
const appDir = __dirname;
const harness = fs.readFileSync(path.join(appDir, 'payment-tests.cjs'), 'utf8').split('let passed = 0;')[0];
const moduleBox = {exports:{}};
vm.runInNewContext(harness + '\nmodule.exports = {fixture, C};', {require, __dirname:appDir, module:moduleBox, console});
const {fixture, C} = moduleBox.exports;
const scenarios = {
  create: {action:'createOrder', setup:f=>{}, check:f=>{
    assert.equal(f.orders.size, 1); assert.equal(f.row()[C.order], 'ORDER1');
    assert.equal(f.count('capture'), 0); assert.equal(f.row()[C.status], 'Pending');
  }},
  capture: {action:'confirmPayment', setup:f=>{ f.create(); f.order().status = 'APPROVED'; }, check:f=>{
    assert.equal(f.orders.size, 1); assert.equal(f.count('capture'), 1);
    assert.equal(f.row()[C.status], 'Paid'); assert.equal(f.row()[C.capture], 'CAPTUREORDER1');
  }},
  coordinator: {action:'coordinatorPayment', setup:f=>{ f.create(); f.order().status = 'APPROVED'; }, check:f=>{
    assert.equal(f.orders.size, 1); assert.equal(f.count('capture'), 0);
    assert.equal(f.row()[C.status], 'Coordinator');
    assert.equal(f.call('createOrder').ok, false);
  }},
  correction: {action:'register', data:{firstName:'One', lastName:'Camper', email:'correct@example.com', phone:'+1 (212) 555-1234',
    gender:'Female', grade:'8th', tshirt:'M', state:'New York', coordinator:'Yes', pastor:'Pastor A', waiver:'No', release:'Yes', zipline:'No'},
    setup:f=>{}, check:f=>{ assert.equal(f.row()[3], 'correct@example.com'); assert.equal(f.rows.length, 2); assert.equal(f.orders.size, 0); }},
  reapproved: {action:'confirmPayment', setup:f=>{
    f.create(); f.order().status = 'APPROVED';
    f.beforeRequest = ({path}) => {
      if (path.endsWith('/capture')) { const e = Error('Declined'); e.paypalIssues = ['INSTRUMENT_DECLINED']; throw e; }
    };
    assert.equal(f.call('confirmPayment').retryPayment, true); f.beforeRequest = null;
  }, check:f=>{ assert.equal(f.orders.size, 1); assert.equal(f.count('capture'), 2); assert.equal(f.row()[C.status], 'Paid'); }},
  declinedDecision: {action:'confirmPayment', setup:f=>{
    f.create(); f.order().status = 'APPROVED';
    f.beforeRequest = ({path}) => {
      if (path.endsWith('/capture')) { const e = Error('Declined'); e.paypalIssues = ['INSTRUMENT_DECLINED']; throw e; }
    };
  }, check:f=>{
    assert.equal(f.row()[C.status], 'Pending');
    assert.equal(JSON.parse(f.row()[C.requested]).retryRequired, true);
    const attempts = f.count('capture'); f.ctx.recoverPendingPayments();
    assert.equal(f.count('capture'), attempts);
    assert.equal(f.create(), 'ORDER1'); assert.equal(f.orders.size, 1);
  }},
  replaceDeclined: {action:'createOrder', setup:f=>{
    f.create(); f.complete(f.order()); f.order().purchase_units[0].payments.captures[0].status = 'DECLINED';
  }, check:f=>{ assert.equal(f.orders.size, 2); assert.equal(f.row()[C.history], 'ORDER1'); assert.equal(f.row()[C.order], 'ORDER2'); }},
  upgrade: {action:'status', setup:f=>{
    f.rows.forEach(row => row.splice(23)); delete f.properties.REGISTRATION_TAB_sheet;
    f.blank = fixture(7); f.sheets.unshift(f.blank.sheet);
  }, check:f=>{ assert.equal(f.blank.rows.length, 0); assert.equal(f.rows.length, 2); assert.equal(f.properties.REGISTRATION_TAB_sheet, '0'); }},
  replaceVoided: {action:'createOrder', setup:f=>{ f.create(); f.order().status = 'VOIDED'; }, check:f=>{
    assert.equal(f.orders.size, 2); assert.equal(f.count('capture'), 0);
    assert.equal(f.row()[C.order], 'ORDER2'); assert.equal(f.row()[C.history], 'ORDER1');
  }}
};
let completed = 0, injected = 0;
const results = {};
for (const [name, scenario] of Object.entries(scenarios)) {
  let cases = 0;
  for (const phase of ['before', 'after']) for (let failAt = 1; failAt <= 30; failAt++) {
    const f = fixture(); f.register(); scenario.setup(f);
    let count = 0, failed = false;
    const wrap = operation => (...args) => {
      const call = ++count;
      if (!failed && call === failAt && phase === 'before') { failed = true; throw Error('Injected write failure'); }
      const value = operation(...args);
      if (!failed && call === failAt && phase === 'after') { failed = true; throw Error('Injected write failure'); }
      return value;
    };
    const sheet = f.sheet;
    const originalRange = sheet.getRange;
    const originalFlush = f.ctx.SpreadsheetApp.flush;
    const originalProperties = f.ctx.PropertiesService.getScriptProperties;
    sheet.getRange = (...args) => {
      const range = originalRange(...args);
      range.setValue = wrap(range.setValue);
      range.setValues = wrap(range.setValues);
      return range;
    };
    f.ctx.SpreadsheetApp.flush = wrap(originalFlush);
    f.ctx.PropertiesService.getScriptProperties = () => {
      const properties = originalProperties(); properties.setProperty = wrap(properties.setProperty); return properties;
    };
    f.call(scenario.action, 1, scenario.data || {});
    sheet.getRange = originalRange;
    f.ctx.SpreadsheetApp.flush = originalFlush;
    f.ctx.PropertiesService.getScriptProperties = originalProperties;
    // Simulate returning after a crashed execution's registration lease expires.
    f.advance(11 * 60 * 1000);
    const retry = f.call(scenario.action, 1, scenario.data || {});
    assert.equal(retry.ok, true, name + ' ' + phase + ' ' + failAt + ': ' + JSON.stringify(retry));
    scenario.check(f);
    completed++;
    if (failed) { injected++; cases++; }
  }
  results[name] = cases;
}
console.log(JSON.stringify({scenarios:results, distinctInjectedFailureCases:injected, totalChecks:completed,
  result:'No extra orders, duplicate captures, or incorrect final statuses in these simulated storage-failure cases.'}, null, 2));
