import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startProvider } from '../src/provider.mjs';
import { startService } from '../src/service.mjs';
const directory = await mkdtemp(join(tmpdir(), 'intake-demo-'));
const provider = await startProvider();
const service = await startService({ source: provider.url, directory });
try {
  console.log(JSON.stringify({ source: provider.url, product: service.url }));
  console.log('来源目录', await (await fetch(`${provider.url}/catalog`)).json());
  const response = await fetch(`${service.url}/intakes`, { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: '/primary' }) });
  if (response.status !== 201) throw new Error(await response.text());
  console.log('接收结果', await response.json());
  console.log('已保存资料', await (await fetch(`${service.url}/records`)).json());

  const structured = await fetch(`${service.url}/shipment-intakes`, { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: '/shipments/multi' }) });
  console.log('装运领取', structured.status, await structured.json());
  if (structured.status !== 201) throw new Error('shipment_intake_failed');
  const views = await (await fetch(`${service.url}/shipments`)).json();
  console.log('箱单视图', JSON.stringify(views.map(view => ({
    shipmentId: view.identity.shipmentId,
    packages: view.current.packages.map(item => ({ id: item.id, orders: item.orders })),
    orders: view.current.orders.map(item => ({ id: item.id, packages: item.packages.map(entry => entry.id) })),
  }))));

  const broken = await fetch(`${service.url}/shipment-intakes`, { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: '/shipments/forward' }) });
  console.log('父节点缺失领取', broken.status, (await broken.json()).transactions[0].issueCodes);
} finally { await service.close(); await provider.close(); await rm(directory, { recursive: true, force: true }); }
