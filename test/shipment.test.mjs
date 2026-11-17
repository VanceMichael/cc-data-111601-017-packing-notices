import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { readShipments, shipmentKeyOf } from '../src/shipment.mjs';

const read = async name => readFile(new URL(`../fixtures/${name}.bin`, import.meta.url));

function build856({ shipment = 'SHIP-A', control = '0001', body }) {
  const segments = [
    'ISA*00*          *00*          *ZZ*SUPPLIER       *ZZ*RECEIVER       *261115*1200*U*00401*000000001*0*T*:~',
    `GS*SH*SENDER*RECEIVER*20261115*1200*1*X*004010~`,
    `ST*856*${control}~`,
    `BSN*00*${shipment}*20261115*1200~`,
    ...body.map(segment => `${segment}~`),
    `SE*${body.length + 3}*${control}~`,
    'GE*1*1~',
    'IEA*1*000000001~',
  ];
  return Buffer.from(segments.join(''));
}

test('S-O-P-I 层次保留父子关系、包装标识与订单分配', async () => {
  const result = readShipments(await read('primary'));
  assert.equal(result.status, 'accepted');
  const [transaction] = result.transactions;
  assert.equal(transaction.shipment.id, 'SHIP-A');
  assert.equal(transaction.shipment.key, shipmentKeyOf({
    sender: 'SENDER', receiver: 'RECEIVER', shipmentId: 'SHIP-A',
  }));
  assert.deepEqual(transaction.packages.map(item => item.id), ['BOX-A']);
  assert.deepEqual(transaction.packages[0].orders, ['ORDER-A']);
  assert.deepEqual(transaction.packages[0].items.map(item => ({
    sku: item.sku, quantity: item.quantity, orderId: item.orderId,
  })), [{ sku: 'SKU-A', quantity: 2, orderId: 'ORDER-A' }]);
  assert.deepEqual(transaction.orders.map(item => item.id), ['ORDER-A']);
});

test('一张订单可分散到多个箱子，每箱保留自己的包装键', async () => {
  const result = readShipments(await read('resource-01'));
  const [transaction] = result.transactions;
  assert.equal(transaction.status, 'accepted');
  assert.deepEqual(transaction.packages.map(item => item.id), ['BOX-A', 'BOX-B']);
  for (const item of transaction.packages) assert.deepEqual(item.orders, ['ORDER-A']);
  assert.equal(transaction.orders.length, 1);
  assert.deepEqual(transaction.orders[0].packages.map(item => item.id), ['BOX-A', 'BOX-B']);
  assert.equal(transaction.orders[0].items.length, 2);
  assert.notEqual(transaction.packages[0].scopedKey, transaction.packages[1].scopedKey);
});

test('父节点前向引用时按 HL02 实际挂接，不按出现顺序猜测', () => {
  const result = readShipments(build856({ body: [
    'HL*1**S', 'TD1*CTN25*2',
    'HL*3*2*P', 'MAN*GM*BOX-A',
    'HL*4*3*I', 'LIN*1*BP*SKU-A', 'SN1**2*EA',
    'HL*2*1*O', 'PRF*ORDER-A',
    'HL*5*2*P', 'MAN*GM*BOX-B',
    'HL*6*5*I', 'LIN*2*BP*SKU-B', 'SN1**3*EA',
  ] }));
  const [transaction] = result.transactions;
  assert.equal(transaction.status, 'accepted');
  assert.deepEqual(transaction.packages.map(item => [item.id, item.orders]), [
    ['BOX-A', ['ORDER-A']], ['BOX-B', ['ORDER-A']],
  ]);
  assert.deepEqual(transaction.orders[0].packages.map(item => item.id), ['BOX-A', 'BOX-B']);
});

test('S-P-O-I 顺序下订单分配仍按后代关系而不是固定深度', () => {
  const result = readShipments(build856({ body: [
    'HL*1**S', 'TD1*CTN25*1',
    'HL*2*1*P', 'MAN*GM*BOX-MIX',
    'HL*3*2*O', 'PRF*ORDER-P',
    'HL*4*3*I', 'LIN*1*BP*SKU-P', 'SN1**1*EA',
    'HL*5*2*O', 'PRF*ORDER-Q',
    'HL*6*5*I', 'LIN*2*BP*SKU-Q', 'SN1**4*EA',
  ] }));
  const [transaction] = result.transactions;
  assert.equal(transaction.status, 'accepted');
  assert.deepEqual(transaction.packages[0].orders.sort(), ['ORDER-P', 'ORDER-Q']);
  assert.deepEqual(transaction.orders.map(item => [item.id, item.items.length]),
    [['ORDER-P', 1], ['ORDER-Q', 1]]);
});

test('父节点缺失时拒绝出箱单但保留可定位的原交易集证据', async () => {
  const result = readShipments(await read('resource-02'));
  const [transaction] = result.transactions;
  assert.equal(result.status, 'rejected');
  assert.equal(transaction.status, 'rejected');
  assert.deepEqual(transaction.packages, []);
  assert.deepEqual(transaction.orders, []);
  assert.ok(transaction.issues.some(item => item.code === 'hl_parent_unknown'));
  assert.equal(transaction.evidence.locator.control, '0001');
  assert.ok(transaction.evidence.segments.some(item => item.tag === 'MAN'));
  assert.ok(transaction.evidence.hierarchy.some(item => item.hl === '3' && item.parent === '9'));
});

test('控制计数不符的交易集不产出箱单，同文档其他交易集不受连带', async () => {
  const broken = (await read('resource-03')).toString();
  const good = (await read('primary')).toString();
  const combined = broken + good;
  const result = readShipments(Buffer.from(combined));
  assert.equal(result.status, 'partial');
  assert.equal(result.transactions.length, 2);
  const [first, second] = result.transactions;
  assert.equal(first.status, 'rejected');
  assert.deepEqual(first.packages, []);
  assert.ok(first.issues.some(item => item.code === 'x12_transaction_count'));
  assert.equal(first.evidence.segments.length > 0, true);
  assert.equal(second.status, 'accepted');
  assert.deepEqual(second.packages.map(item => item.id), ['BOX-A']);
  assert.equal(second.evidence.locator.transaction, 1);
});

test('父子层次矛盾（如 I 下挂 P）被拒绝，不做补齐猜测', async () => {
  const source = (await read('primary')).toString()
    .replace('HL*3*2*P~MAN*GM*BOX-A~HL*4*3*I', 'HL*3*2*I~MAN*GM*BOX-A~HL*4*3*P');
  const result = readShipments(Buffer.from(source));
  const [transaction] = result.transactions;
  assert.equal(transaction.status, 'rejected');
  assert.deepEqual(transaction.packages, []);
  assert.ok(transaction.issues.some(item => item.code === 'hl_type_conflict'));
});

test('父子循环与重复节点号被视为矛盾', async () => {
  const cycle = readShipments(Buffer.from((await read('primary')).toString()
    .replace('HL*2*1*O', 'HL*2*3*O')));
  assert.equal(cycle.transactions[0].status, 'rejected');
  assert.ok(cycle.transactions[0].issues.some(item => item.code === 'hl_parent_cycle'));

  const duplicate = readShipments(Buffer.from((await read('primary')).toString()
    .replace('HL*3*2*P', 'HL*2*2*P')));
  assert.equal(duplicate.transactions[0].status, 'rejected');
  assert.ok(duplicate.transactions[0].issues.some(item => item.code === 'hl_identifier_duplicate'));
});

test('缺少 HL 不产生空箱单，缺失票号拒绝解释', async () => {
  const noHierarchy = readShipments(Buffer.from((await read('primary')).toString()
    .replace(/~HL\*[^~]*/g, '')));
  assert.equal(noHierarchy.transactions[0].status, 'rejected');
  assert.ok(noHierarchy.transactions[0].issues.some(item => item.code === 'hl_missing'));

  const noShipment = readShipments(Buffer.from((await read('primary')).toString()
    .replace('BSN*00*SHIP-A', 'BSN*00*')));
  assert.equal(noShipment.transactions[0].status, 'rejected');
  assert.equal(noShipment.transactions[0].shipment, null);
  assert.ok(noShipment.transactions[0].issues.some(item => item.code === 'shipment_identifier_missing'));
});

test('多个交易集共用 HL 节点号也不会互相串层次', async () => {
  const first = (await read('primary')).toString()
    .replace('SHIP-A', 'SHIP-1').replace('ORDER-A', 'ORDER-1').replace('BOX-A', 'BOX-1');
  const second = (await read('primary')).toString()
    .replace('SHIP-A', 'SHIP-2').replace('ORDER-A', 'ORDER-2').replace('BOX-A', 'BOX-2');
  const result = readShipments(Buffer.from(first + second));
  assert.equal(result.transactions.length, 2);
  assert.deepEqual(result.transactions[0].packages.map(item => item.id), ['BOX-1']);
  assert.deepEqual(result.transactions[1].packages.map(item => item.id), ['BOX-2']);
  assert.notEqual(result.transactions[0].shipment.key, result.transactions[1].shipment.key);
});

test('同一票拆成多张交易集时按票合并，重复包装标识判冲突', async () => {
  const first = readShipments(build856({ control: '0001', body: [
    'HL*1**S', 'HL*2*1*O', 'PRF*ORDER-A', 'HL*3*2*P', 'MAN*GM*BOX-A',
    'HL*4*3*I', 'LIN*1*BP*SKU-A', 'SN1**1*EA',
  ] }));
  const second = readShipments(build856({ control: '0002', body: [
    'HL*1**S', 'HL*2*1*O', 'PRF*ORDER-A', 'HL*5*2*P', 'MAN*GM*BOX-B',
    'HL*6*5*I', 'LIN*2*BP*SKU-B', 'SN1**2*EA',
  ] }));
  assert.equal(first.shipments.length, 1);
  assert.equal(second.shipments.length, 1);

  const duplicate = readShipments(build856({ control: '0003', body: [
    'HL*1**S', 'HL*2*1*O', 'PRF*ORDER-A', 'HL*3*2*P', 'MAN*GM*BOX-A',
    'HL*4*3*I', 'LIN*1*BP*SKU-A', 'SN1**9*EA',
  ] }));
  assert.equal(duplicate.shipments[0].packages[0].id, 'BOX-A');
  assert.equal(duplicate.shipments[0].status, 'accepted');
});

test('同一票同号包装在两交易集中重复声明时不合并为重复箱件', () => {
  // Two independent 856 sets for one shipment that both claim BOX-A. This is
  // ambiguous (duplicate vs. re-send) and must not be silently merged.
  const one = build856({ control: '0001', body: [
    'HL*1**S', 'HL*2*1*O', 'PRF*ORDER-A', 'HL*3*2*P', 'MAN*GM*BOX-A',
    'HL*4*3*I', 'LIN*1*BP*SKU-A', 'SN1**1*EA',
  ] }).toString();
  const two = build856({ control: '0002', body: [
    'HL*1**S', 'HL*2*1*O', 'PRF*ORDER-A', 'HL*5*2*P', 'MAN*GM*BOX-A',
    'HL*6*5*I', 'LIN*2*BP*SKU-A', 'SN1**2*EA',
  ] }).toString();
  const result = readShipments(Buffer.from(one + two));
  assert.equal(result.shipments.length, 1);
  assert.equal(result.shipments[0].status, 'rejected');
  assert.deepEqual(result.shipments[0].packages, []);
  assert.ok(result.shipments[0].issues.some(item =>
    item.code === 'package_identifier_conflict_across_transactions'));
  assert.equal(result.shipments[0].evidence.length, 2);
});
