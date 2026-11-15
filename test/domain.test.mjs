import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { inspect } from '../src/reader.mjs';
const primary=await readFile(new URL('../fixtures/primary.bin',import.meta.url));
const manifest=JSON.parse(await readFile(new URL('../fixtures/upstream.json',import.meta.url),'utf8'));
async function resource(path) {
  const item=manifest.resources[path];
  return item.file ? readFile(new URL(`../fixtures/${item.file}`,import.meta.url)) : Buffer.from(item.body);
}

test('交换分隔与控制计数可核对',()=>{
  const result=inspect(primary);assert.equal(result.transactions[0].type,'856');
  assert.equal(result.delimiters.element,'*');assert.equal(result.transactions[0].control,'0001');
});
test('多箱与前向引用信息仍为原段，不偷平面聚合',async()=>{
  const result=inspect(await resource('/shipments/multi'));
  assert.equal(result.transactions[0].segments.filter(row=>row[0]==='MAN').length,2);
  const forward=inspect(await resource('/shipments/forward'));
  assert.ok(forward.transactions[0].segments.some(row=>row[0]==='HL'&&row[2]==='9'));
});
test('交易控制不匹配和错误计数拒绝',async()=>{
  assert.throws(()=>inspect(Buffer.from(primary.toString().replace('SE*12*0001','SE*12*0002'))));
  const broken=await resource('/shipments/bad-count');assert.throws(()=>inspect(broken));
});
