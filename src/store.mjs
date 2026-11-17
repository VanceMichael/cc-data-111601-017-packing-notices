import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

export class Store {
  constructor(directory) {
    this.directory = directory;
    this.pending = Promise.resolve();
  }
  async initialize() {
    await mkdir(join(this.directory, 'objects'), { recursive: true });
    try { await this.list(); } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      await this.saveIndex([]);
    }
    try { await this.listShipments(); } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      await this.saveShipments([]);
    }
    return this;
  }
  async saveIndex(records) {
    const temporary = join(this.directory, `index-${randomUUID()}.tmp`);
    await writeFile(temporary, JSON.stringify(records));
    await rename(temporary, join(this.directory, 'index.json'));
  }
  async list() {
    return JSON.parse(await readFile(join(this.directory, 'index.json'), 'utf8'));
  }
  async saveShipments(entries) {
    const temporary = join(this.directory, `shipments-${randomUUID()}.tmp`);
    await writeFile(temporary, JSON.stringify(entries));
    await rename(temporary, join(this.directory, 'shipments.json'));
  }
  async listShipments() {
    return JSON.parse(await readFile(join(this.directory, 'shipments.json'), 'utf8'));
  }
  async accept(bytes, source, parsed) {
    const digest = createHash('sha256').update(bytes).digest('hex');
    const operation = this.pending.then(async () => {
      const records = await this.list();
      const existing = records.find(record => record.digest === digest && record.source === source);
      if (existing) return existing;
      await writeFile(join(this.directory, 'objects', digest), bytes);
      const record = { id: randomUUID(), digest, source, bytes: bytes.length, parsed };
      records.push(record);
      await this.saveIndex(records);
      return record;
    });
    this.pending = operation.catch(() => {});
    return operation;
  }
  /**
   * Persist a structured shipment document. The raw bytes stay addressable by
   * digest, while per-shipment revisions are keyed by sender/receiver/shipment id
   * so a correction for one shipment can never displace another shipment's
   * identically numbered package.
   */
  async acceptShipmentDocument(bytes, source, document) {
    const digest = createHash('sha256').update(bytes).digest('hex');
    const operation = this.pending.then(async () => {
      const records = await this.list();
      let record = records.find(item => item.digest === digest && item.source === source);
      const isNew = !record;
      if (isNew) {
        await writeFile(join(this.directory, 'objects', digest), bytes);
        record = {
          id: randomUUID(),
          digest,
          source,
          bytes: bytes.length,
          kind: document.kind,
          receivedAt: new Date().toISOString(),
          status: document.status,
          transactions: document.transactions.map(item => ({
            locator: item.locator,
            status: item.status,
            shipmentKey: item.shipment?.key ?? null,
            issueCodes: item.issues.map(entry => entry.code),
          })),
          shipments: document.shipments.map(item => ({
            key: item.key,
            status: item.status,
            issueCodes: [...new Set(item.issues.map(entry => entry.code))],
          })),
          parsed: document,
        };
        records.push(record);
        await this.saveIndex(records);
      }
      const shipments = await this.listShipments();
      let changed = false;
      for (const shipment of document.shipments) {
        const key = shipment.key;
        let entry = shipments.find(item => item.key === key);
        if (!entry) {
          entry = {
            key,
            id: randomUUID(),
            identity: {
              sender: shipment.identity.sender,
              receiver: shipment.identity.receiver,
              shipmentId: shipment.identity.id,
            },
            revisions: [],
          };
          shipments.push(entry);
        }
        // Identical content is the same revision regardless of source path.
        if (entry.revisions.some(item => item.digest === digest)) continue;
        const accepted = shipment.status === 'accepted';
        const revision = {
          receipt: record.id,
          digest,
          source,
          at: record.receivedAt,
          status: shipment.status,
          locators: shipment.locators,
          packages: accepted ? shipment.packages : [],
          orders: accepted ? shipment.orders : [],
          issueCodes: [...new Set(shipment.issues.map(item => item.code))],
          evidence: accepted ? null : shipment.evidence,
        };
        entry.revisions.push(revision);
        changed = true;
      }
      if (changed) await this.saveShipments(shipments);
      return record;
    });
    this.pending = operation.catch(() => {});
    return operation;
  }
  async shipmentView() {
    const entries = await this.listShipments();
    return entries.map(entry => {
      const accepted = entry.revisions.filter(item => item.status === 'accepted');
      const current = accepted.at(-1) ?? null;
      return {
        key: entry.key,
        id: entry.id,
        identity: entry.identity,
        current: current ? {
          receipt: current.receipt,
          digest: current.digest,
          source: current.source,
          at: current.at,
          locators: current.locators,
          packages: current.packages,
          orders: current.orders,
        } : null,
        revisions: entry.revisions.map(item => ({
          receipt: item.receipt,
          digest: item.digest,
          source: item.source,
          at: item.at,
          status: item.status,
          locators: item.locators,
          packageCount: item.packages.length,
          orderCount: item.orders.length,
          issueCodes: item.issueCodes,
        })),
        rejectedAttempts: entry.revisions.filter(item => item.status !== 'accepted').map(item => ({
          receipt: item.receipt,
          digest: item.digest,
          source: item.source,
          at: item.at,
          locators: item.locators,
          issueCodes: item.issueCodes,
          evidence: item.evidence,
        })),
      };
    });
  }
  async shipment(key) {
    const entries = await this.shipmentView();
    return entries.find(item => item.key === key) ?? null;
  }
  async object(digest) {
    if (!/^[a-f0-9]{64}$/.test(digest)) throw new Error('invalid_digest');
    return readFile(join(this.directory, 'objects', digest));
  }
}
