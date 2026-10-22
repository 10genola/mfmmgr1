// Optional full-page tests: requires Playwright and its Chromium browser.
// Every browser request is intercepted. Google and PayPal are simulated;
// no registrations, credentials, or payments reach an external service.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const {chromium} = require('playwright');
const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
const harness = fs.readFileSync(path.join(__dirname, 'payment-tests.cjs'), 'utf8').split('let passed = 0;')[0];
const box = {exports:{}};
vm.runInNewContext(harness + '\nmodule.exports = {fixture, C};', {require, __dirname, module:box, console});
const {fixture, C} = box.exports;
const origin = 'https://mfm-registration.test/';
const sdk = `window.paypal = {Buttons(options) {
  window.checkout = options;
  return {render: async container => {
    const button = document.createElement('button');
    button.textContent = 'Test PayPal checkout';
    button.onclick = async () => {
      try { window.testOrderId = await options.createOrder(); }
      catch (error) { options.onError(error); }
    };
    container.appendChild(button);
  }};
}};`;

async function openForm(browser, options = {}) {
  const f = options.fixture || fixture();
  const context = await browser.newContext({viewport:{width:390, height:844}, serviceWorkers:'block'});
  const requests = [], errors = [], dialogs = [];
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  page.on('dialog', async dialog => { dialogs.push(dialog.message()); await dialog.dismiss(); });
  await context.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.href === origin) return route.fulfill({contentType:'text/html', body:html});
    if (url.hostname === 'www.paypal.com' && url.pathname === '/sdk/js') {
      return options.missingSDK ? route.abort() : route.fulfill({contentType:'application/javascript', body:sdk});
    }
    if (url.hostname === 'script.google.com' && route.request().method() === 'POST') {
      const payload = route.request().postDataJSON();
      requests.push(payload);
      const result = f.ctx.doPost({postData:{contents:JSON.stringify(payload)}});
      if (options.loseSave && payload.action === 'register') { options.loseSave = false; return route.abort(); }
      return route.fulfill({contentType:'application/json', headers:{'Access-Control-Allow-Origin':'*'}, body:JSON.stringify(result)});
    }
    // Fonts and all other external URLs are disabled in this test.
    return route.fulfill({status:200, body:''});
  });
  await page.goto(origin);
  return {page, context, f, requests, errors, dialogs};
}
async function fillForm(page, email = 'parent@example.com') {
  await page.locator('#firstName').fill('One');
  await page.locator('#lastName').fill('Camper');
  await page.locator('#email').fill(email);
  await page.locator('#phone').fill('+1 (212) 555-1234');
  for (const id of ['gFemale','sM','coordYes','zNo','wNo','rYes']) await page.locator('label[for="' + id + '"]').click();
  await page.locator('#grade').selectOption('8th');
  await page.locator('#state').selectOption('New York');
  await page.locator('#pastor').selectOption({index:1});
}
async function save(page) {
  await page.locator('#regForm button[type="submit"]').click();
  await page.locator('#success-msg').waitFor({state:'visible'});
}
async function row(f) { return f.rows.find((r, i) => i > 0 && r[C.hash]); }
async function run() {
  const browser = await chromium.launch({headless:true,
    ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? {executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH} : {})});
  let passed = 0;
  async function test(name, fn) {
    const contexts = [];
    const open = async options => { const form = await openForm(browser, options); contexts.push(form); return form; };
    try {
      await fn(open);
      for (const form of contexts) assert.deepEqual(form.errors, [], 'no uncaught page errors');
      passed++; console.log('PASS browser: ' + name);
    } finally { for (const form of contexts) await form.context.close(); }
  }
  try {
    await test('page structure, local logo, mobile layout, and empty-form validation', async open => {
      const {page, requests} = await open();
      const layout = await page.evaluate(() => ({
        uniqueIds:new Set([...document.querySelectorAll('[id]')].map(e => e.id)).size,
        ids:document.querySelectorAll('[id]').length,
        missingLabels:[...document.querySelectorAll('label[for]')].filter(e => !document.getElementById(e.htmlFor)).length,
        logo:document.querySelector('.hero-logo').naturalWidth,
        overflow:document.documentElement.scrollWidth > innerWidth
      }));
      assert.equal(layout.uniqueIds, layout.ids); assert.equal(layout.missingLabels, 0);
      assert(layout.logo > 0); assert.equal(layout.overflow, false);
      await page.locator('#regForm button[type="submit"]').click();
      assert.equal(requests.length, 0);
      assert.equal(await page.locator('#val-summary').isVisible(), true);
      assert.equal(await page.locator('#success-msg').isVisible(), false);
    });
    await test('all required radio groups can be selected with a keyboard', async open => {
      const {page} = await open();
      await page.locator('#phone').focus();
      await page.keyboard.press('Tab');
      assert.equal(await page.evaluate(() => document.activeElement.name), 'gender');
      await page.keyboard.press('ArrowRight');
      assert.equal(await page.locator('input[name="gender"]:checked').count(), 1);
      for (const name of ['shirt','coordinator','zipline','waiver','release']) {
        await page.locator('input[name="' + name + '"]').first().focus();
        assert.equal(await page.evaluate(() => document.activeElement.name), name);
        await page.keyboard.press('Space');
        assert.equal(await page.locator('input[name="' + name + '"]:checked').count(), 1);
      }
    });
    await test('US country-code autofill preserves the correct phone number', async open => {
      const {page} = await open();
      await page.locator('#phone').fill('+1 (212) 555-1234');
      assert.equal((await page.locator('#phone').inputValue()).replace(/\D/g, ''), '2125551234');
      await page.locator('#phone').fill('212555123456');
      assert.equal((await page.locator('#phone').inputValue()).replace(/\D/g, ''), '212555123456', 'never silently cut off digits');
    });
    await test('form saves exact details, then verifies payment once and restores on refresh', async open => {
      const {page, f, requests} = await open();
      await fillForm(page); await save(page);
      assert.equal((await row(f))[3], 'parent@example.com');
      assert.equal((await row(f))[4], '(212) 555-1234');
      assert.equal((await row(f))[C.status], 'Pending');
      assert.equal(f.orders.size, 0, 'saving alone cannot start payment');
      await page.getByText('Test PayPal checkout', {exact:true}).click();
      await page.waitForFunction(() => window.testOrderId);
      const order = [...f.orders.values()][0];
      assert.equal(order.purchase_units[0].amount.value, '200.00');
      order.status = 'APPROVED';
      await page.evaluate(() => window.checkout.onApprove({}, {}));
      assert.equal(await page.locator('#success-msg h2').textContent(), 'Registration confirmed');
      assert.equal(await page.getByText('Payment made to your coordinator', {exact:true}).count(), 0);
      assert.equal((await row(f))[C.status], 'Paid');
      await page.reload();
      await page.locator('#success-msg').waitFor({state:'visible'});
      assert.equal(await page.locator('#success-msg h2').textContent(), 'Registration confirmed');
      assert.equal(f.rows.length, 2); assert.equal(f.count('capture'), 1);
      assert.equal(new Set(requests.map(r => r.token)).size, 1);
    });
    await test('coordinator report closes checkout and stays uncharged after refresh', async open => {
      const {page, f} = await open(); await fillForm(page); await save(page);
      await page.getByText('Payment made to your coordinator', {exact:true}).click();
      await page.getByText('Awaiting coordinator verification', {exact:true}).waitFor();
      assert.equal((await row(f))[C.status], 'Coordinator');
      await page.reload(); await page.getByText('Awaiting coordinator verification', {exact:true}).waitFor();
      assert.equal(await page.getByText('Test PayPal checkout', {exact:true}).count(), 0);
      assert.equal(f.count('capture'), 0);
    });
    await test('save-response loss retries the same registration and accepts a corrected email', async open => {
      const form = await open({loseSave:true}); const {page, f} = form;
      await fillForm(page, 'typo@example.com');
      await page.locator('#regForm button[type="submit"]').click();
      await page.waitForFunction(() => !document.querySelector('#regForm button[type="submit"]').disabled);
      assert.equal(form.dialogs.length, 1); assert.equal(f.rows.length, 2);
      const id = (await row(f))[C.id];
      await page.locator('#email').fill('correct@example.com'); await save(page);
      assert.equal(f.rows.length, 2); assert.equal((await row(f))[C.id], id);
      assert.equal((await row(f))[3], 'correct@example.com');
    });
    await test('separate registration sessions can share an email without sharing a payment', async open => {
      const f = fixture();
      for (let i = 0; i < 2; i++) { const {page} = await open({fixture:f}); await fillForm(page); await save(page); }
      assert.equal(f.rows.length, 3); assert.notEqual(f.rows[1][C.id], f.rows[2][C.id]);
      assert.notEqual(f.rows[1][C.hash], f.rows[2][C.hash]); assert.equal(f.orders.size, 0);
    });
    await test('missing PayPal SDK leaves details saved with a clear error', async open => {
      const {page, f} = await open({missingSDK:true}); await fillForm(page); await save(page);
      assert.match(await page.locator('#paypal-button-container').textContent(), /PayPal is not configured or could not load/);
      assert.equal((await row(f))[C.status], 'Pending');
      assert.equal(f.orders.size, 0);
    });
    await test('checkout errors remain pending; funding declines restart only after buyer approval', async open => {
      const {page, f} = await open(); await fillForm(page); await save(page);
      f.beforeRequest = () => { const e = Error('PayPal authentication failed.'); e.requestNotSent = true; throw e; };
      await page.getByText('Test PayPal checkout', {exact:true}).click();
      await page.waitForFunction(() => document.getElementById('paypal-button-container').textContent.includes('authentication failed'));
      assert.equal((await row(f))[C.status], 'Pending');
      f.beforeRequest = null;
      await page.getByText('Test PayPal checkout', {exact:true}).click();
      await page.waitForFunction(() => window.testOrderId);
      [...f.orders.values()][0].status = 'APPROVED';
      f.beforeRequest = ({path}) => { if (path.endsWith('/capture')) { const e = Error('Declined'); e.paypalIssues = ['INSTRUMENT_DECLINED']; throw e; } };
      await page.evaluate(() => window.checkout.onApprove({}, {restart:async () => { window.restarted = true; }}));
      assert.equal(await page.evaluate(() => window.restarted), true);
      assert.equal((await row(f))[C.status], 'Pending');
      f.beforeRequest = null; f.ctx.recoverPendingPayments(); assert.equal(f.count('capture'), 1);
      await page.evaluate(() => window.checkout.onApprove({}, {}));
      assert.equal((await row(f))[C.status], 'Paid');
    });
    console.log('\n' + passed + ' browser groups passed. Hosted PayPal checkout is simulated.');
  } finally { await browser.close(); }
}
run().catch(error => { console.error(error); process.exitCode = 1; });
