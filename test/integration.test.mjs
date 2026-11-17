import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startProvider } from '../src/provider.mjs';
import { startService } from '../src/service.mjs';
import { Store } from '../src/store.mjs';
import { inspect } from '../src/reader.mjs';
import { readShipments, shipmentKeyOf } from '../src/shipment.mjs';

test('单件资料可解释，畸形输入被拒绝', async () => {
  const fixture = await readFile(new URL('../fixtures/primary.bin', import.meta.url));
  assert.ok(inspect(fixture));
  assert.throws(() => inspect(Buffer.alloc(0)));
});
test('来源领取、原件持久化、重启查询及无副作用拒收', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'intake-test-'));
  const provider = await startProvider();
  const service = await startService({ source: provider.url, directory });
  try {
    const body = JSON.stringify({ path: '/primary' });
    const send = path => fetch(`${service.url}/intakes`, { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path }) });
    const first = await send('/primary');
    assert.equal(first.status, 201);
    const record = await first.json();
    assert.deepEqual(await new Store(directory).list(), [record]);
    assert.deepEqual(Buffer.from(await (await fetch(`${service.url}/objects/${record.digest}`)).arrayBuffer()),
      await readFile(new URL('../fixtures/primary.bin', import.meta.url)));
    const repeated = await send('/primary');
    assert.equal((await repeated.json()).id, record.id);
    assert.equal((await send('/missing')).status, 422);
    assert.equal((await send('https://example.invalid/foreign')).status, 422);
    assert.equal((await new Store(directory).list()).length, 1);
    const range = await fetch(`${provider.url}/primary`, { headers: { range: 'bytes=0-0' } });
    assert.equal(range.status, 206);
    assert.equal((await range.arrayBuffer()).byteLength, 1);
    const reject = await fetch(`${provider.url}/primary`, { headers: { 'if-match': '"old"' } });
    assert.equal(reject.status, 412);
    assert.ok(body.includes('primary'));
  } finally { await service.close(); await provider.close(); await rm(directory, { recursive: true, force: true }); }
});

function shipmentDocument({ shipment, order, box, sku = 'SKU-A', count = 2, control = '0001' }) {
  const body = [
    'HL*1**S', 'TD1*CTN25*1',
    `HL*2*1*O`, `PRF*${order}`,
    'HL*3*2*P', `MAN*GM*${box}`,
    'HL*4*3*I', `LIN*1*BP*${sku}`, `SN1**${count}*EA`,
  ];
  return Buffer.from([
    'ISA*00*          *00*          *ZZ*SUPPLIER       *ZZ*RECEIVER       *261115*1200*U*00401*000000001*0*T*:~',
    'GS*SH*SENDER*RECEIVER*20261115*1200*1*X*004010~',
    `ST*856*${control}~`,
    `BSN*00*${shipment}*20261115*1200~`,
    ...body.map(segment => `${segment}~`),
    `SE*${body.length + 3}*${control}~`,
    'GE*1*1~', 'IEA*1*000000001~',
  ].join(''));
}

test('结构化领取保存层次、包装与订单分配，重领同摘要幂等', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'shipment-test-'));
  const provider = await startProvider();
  let service = await startService({ source: provider.url, directory });
  try {
    const send = path => fetch(`${service.url}/shipment-intakes`, { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path }) });
    const first = await send('/shipments/multi');
    assert.equal(first.status, 201);
    const receipt = await first.json();
    assert.equal(receipt.status, 'accepted');
    const [view] = await (await fetch(`${service.url}/shipments`)).json();
    assert.equal(view.identity.shipmentId, 'SHIP-A');
    assert.deepEqual(view.current.packages.map(item => item.id), ['BOX-A', 'BOX-B']);
    assert.deepEqual(view.current.packages.map(item => item.orders), [['ORDER-A'], ['ORDER-A']]);
    assert.deepEqual(view.current.orders.map(item => item.packages.map(entry => entry.id)),
      [['BOX-A', 'BOX-B']]);
    assert.equal(view.revisions.length, 1);

    const again = await send('/shipments/multi');
    assert.equal(again.status, 201);
    assert.equal((await again.json()).receipt, receipt.receipt);
    assert.equal((await (await fetch(`${service.url}/shipments`)).json())[0].revisions.length, 1);

    // Persisted across a fresh service instance on the same directory.
    await service.close();
    service = await startService({ source: provider.url, directory });
    const reopened = await (await fetch(`${service.url}/shipments`)).json();
    assert.deepEqual(reopened.map(item => item.current.packages.map(entry => entry.id)),
      [['BOX-A', 'BOX-B']]);
  } finally { await service.close(); await provider.close(); await rm(directory, { recursive: true, force: true }); }
});

test('被拒报文留存原证据，不产出可出库箱单', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'shipment-bad-'));
  const provider = await startProvider();
  const service = await startService({ source: provider.url, directory });
  try {
    const send = path => fetch(`${service.url}/shipment-intakes`, { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path }) });
    const response = await send('/shipments/bad-count');
    assert.equal(response.status, 422);
    const receipt = await response.json();
    assert.equal(receipt.status, 'rejected');
    assert.ok(receipt.transactions[0].issueCodes.includes('x12_transaction_count'));
    const [view] = await (await fetch(`${service.url}/shipments`)).json();
    assert.equal(view.current, null);
    assert.deepEqual(view.rejectedAttempts.length, 1);
    const evidence = view.rejectedAttempts[0].evidence;
    assert.equal(evidence.length, 1);
    assert.equal(evidence[0].locator.control, '0001');
    assert.ok(evidence[0].segments.some(item => item.tag === 'MAN'));
    const stored = await (await fetch(`${service.url}/objects/${view.rejectedAttempts[0].digest}`)).arrayBuffer();
    assert.deepEqual(Buffer.from(stored), await readFile(new URL('../fixtures/resource-03.bin', import.meta.url)));
  } finally { await service.close(); await provider.close(); await rm(directory, { recursive: true, force: true }); }
});

test('更正报文与另一票同号箱件互不覆盖', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'shipment-correct-'));
  const store = await new Store(directory).initialize();
  const first = shipmentDocument({ shipment: 'SHIP-A', order: 'ORDER-A', box: 'BOX-1', sku: 'SKU-A' });
  const correction = shipmentDocument({ shipment: 'SHIP-A', order: 'ORDER-A', box: 'BOX-1', sku: 'SKU-A', count: 5 });
  const other = shipmentDocument({ shipment: 'SHIP-B', order: 'ORDER-B', box: 'BOX-1', sku: 'SKU-B' });
  await store.acceptShipmentDocument(first, 'http://source/one', readShipments(first));
  await store.acceptShipmentDocument(other, 'http://source/two', readShipments(other));
  assert.equal((await store.shipmentView()).length, 2);
  // Same content from a different source path is the same revision.
  await store.acceptShipmentDocument(first, 'http://source/one-alias', readShipments(first));
  assert.equal((await store.shipmentView()).find(view => view.identity.shipmentId === 'SHIP-A')
    .revisions.length, 1);
  await store.acceptShipmentDocument(correction, 'http://source/three', readShipments(correction));

  const views = await store.shipmentView();
  assert.equal(views.length, 2);
  const a = views.find(view => view.identity.shipmentId === 'SHIP-A');
  const b = views.find(view => view.identity.shipmentId === 'SHIP-B');
  assert.equal(a.key, shipmentKeyOf({ sender: 'SENDER', receiver: 'RECEIVER', shipmentId: 'SHIP-A' }));
  assert.equal(b.key, shipmentKeyOf({ sender: 'SENDER', receiver: 'RECEIVER', shipmentId: 'SHIP-B' }));
  assert.notEqual(a.key, b.key);
  assert.equal(a.revisions.length, 2);
  assert.equal(a.current.packages[0].items[0].quantity, 5);
  assert.equal(b.current.packages[0].items[0].sku, 'SKU-B');
  assert.equal(b.revisions.length, 1);
  // Package keys are shipment-scoped even when the physical identifier matches.
  assert.notEqual(a.current.packages[0].scopedKey, b.current.packages[0].scopedKey);
  assert.notEqual(a.current.packages[0].scopedKey, a.revisions[0].digest);
});

test('合法装运被后续坏报文重领时不覆盖有效版本', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'shipment-regress-'));
  const store = await new Store(directory).initialize();
  const good = shipmentDocument({ shipment: 'SHIP-A', order: 'ORDER-A', box: 'BOX-1' });
  const bad = Buffer.from(good.toString().replace(/SE\*\d+\*0001/, 'SE*99*0001'));
  await store.acceptShipmentDocument(good, 'http://source/one', readShipments(good));
  await store.acceptShipmentDocument(bad, 'http://source/two', readShipments(bad));
  const [view] = await store.shipmentView();
  assert.ok(view.current);
  assert.equal(view.current.packages.length, 1);
  assert.equal(view.rejectedAttempts.length, 1);
  assert.ok(view.rejectedAttempts[0].issueCodes.includes('x12_transaction_count'));
});
