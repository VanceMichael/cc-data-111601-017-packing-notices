const TYPES = new Set(['S', 'O', 'P', 'I']);
const ALLOWED_CHILDREN = {
  S: new Set(['O', 'P']),
  O: new Set(['P', 'I']),
  P: new Set(['I', 'O']),
  I: new Set(),
};

function issue(code, message, details = {}) {
  const entry = { code, message, severity: details.severity ?? 'error', scope: details.scope ?? 'transaction' };
  for (const field of ['segment', 'hl', 'field', 'expected', 'actual', 'transaction', 'inherited']) {
    if (details[field] !== undefined) entry[field] = details[field];
  }
  return entry;
}

function scan(bytes) {
  const text = bytes.toString('ascii');
  if (text.length < 106 || !text.startsWith('ISA')) throw new Error('x12_isa_header');
  const element = text[3];
  const component = text[104];
  const terminator = text[105];
  if (new Set([element, component, terminator]).size !== 3) throw new Error('x12_delimiters');
  const parts = text.split(terminator);
  while (parts.length && parts.at(-1).trim() === '') parts.pop();
  const segments = [];
  for (const part of parts) {
    const value = part.trim();
    if (value) segments.push(value.split(element));
  }
  if (!segments.length || segments[0][0] !== 'ISA') throw new Error('x12_isa_header');
  return { delimiters: { element, component, terminator }, segments };
}

function value(segment, index) {
  const item = segment?.[index];
  return typeof item === 'string' ? item.trim() : '';
}

function encodeKeyPart(item) {
  return encodeURIComponent(item ?? '');
}

export function shipmentKeyOf(identity) {
  if (!identity || !identity.sender || !identity.receiver || !identity.shipmentId) return null;
  return [identity.sender, identity.receiver, identity.shipmentId].map(encodeKeyPart).join('/');
}

export function scopedPackageKey(shipmentKey, packageId) {
  if (!shipmentKey || !packageId) return null;
  return `${shipmentKey}#${encodeKeyPart(packageId)}`;
}

export function scopedOrderKey(shipmentKey, orderId) {
  if (!shipmentKey || !orderId) return null;
  return `${shipmentKey}~${encodeKeyPart(orderId)}`;
}

function locatorOf(transaction) {
  return {
    interchange: transaction.interchangeIndex,
    group: transaction.groupIndex,
    transaction: transaction.index,
    control: transaction.control,
    type: transaction.type,
  };
}

function segmentId(segment, index) {
  return { segment: segment?.[0] ?? null, segmentIndex: index };
}

function numberOrNull(raw) {
  if (raw === undefined || raw === null || raw === '') return null;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseEnvelopes(segments, issues) {
  const interchanges = [];
  const transactions = [];
  let index = 0;
  while (index < segments.length) {
    const opening = segments[index];
    if (opening[0] !== 'ISA') {
      issues.push(issue('x12_unexpected_segment', '段位于交换信封之外', {
        scope: 'document', ...segmentId(opening, index),
      }));
      index += 1;
      continue;
    }
    const isa = opening;
    const isaIndex = index;
    index += 1;
    const interchange = {
      index: interchanges.length,
      control: value(isa, 13),
      isaIndex,
      ieaIndex: null,
      groups: [],
      issues: [],
    };
    let iea = null;
    while (index < segments.length) {
      const tag = segments[index][0];
      if (tag === 'IEA') {
        iea = segments[index];
        interchange.ieaIndex = index;
        index += 1;
        break;
      }
      if (tag === 'ISA') {
        interchange.issues.push(issue('x12_interchange_missing_end', '交换信封缺少 IEA', {
          scope: 'interchange', ...segmentId(segments[index], index), control: interchange.control,
        }));
        break;
      }
      if (tag !== 'GS') {
        interchange.issues.push(issue('x12_unexpected_segment', '交换信封内出现非 GS 段', {
          scope: 'interchange', ...segmentId(segments[index], index), control: interchange.control,
        }));
        index += 1;
        continue;
      }
      const gs = segments[index];
      const gsIndex = index;
      index += 1;
      const group = {
        index: interchange.groups.length,
        control: value(gs, 6),
        functional: value(gs, 1),
        sender: value(gs, 2),
        receiver: value(gs, 3),
        gsIndex,
        geIndex: null,
        transactions: [],
        issues: [],
      };
      let ge = null;
      while (index < segments.length) {
        const inner = segments[index][0];
        if (inner === 'GE') {
          ge = segments[index];
          group.geIndex = index;
          index += 1;
          break;
        }
        if (inner === 'GS' || inner === 'IEA' || inner === 'ISA') {
          group.issues.push(issue('x12_group_missing_end', '功能组缺少 GE', {
            scope: 'group', ...segmentId(segments[index], index), control: group.control,
          }));
          break;
        }
        if (inner !== 'ST') {
          group.issues.push(issue('x12_unexpected_segment', '功能组内出现非 ST 段', {
            scope: 'group', ...segmentId(segments[index], index), control: group.control,
          }));
          index += 1;
          continue;
        }
        const st = segments[index];
        const stIndex = index;
        const control = value(st, 2);
        index += 1;
        const body = [];
        let se = null;
        let seIndex = null;
        while (index < segments.length) {
          const tag = segments[index][0];
          if (tag === 'SE') {
            se = segments[index];
            seIndex = index;
            index += 1;
            break;
          }
          if (tag === 'ST' || tag === 'GE' || tag === 'IEA' || tag === 'ISA') break;
          body.push({ index, segment: segments[index] });
          index += 1;
        }
        const transactionIssues = [];
        if (!se) {
          transactionIssues.push(issue('x12_transaction_missing_end', '交易集缺少 SE', {
            scope: 'transaction', ...segmentId(st, stIndex), control,
          }));
        } else {
          if (value(se, 2) !== control) {
            transactionIssues.push(issue('x12_transaction_control', 'SE02 与 ST02 不一致', {
              scope: 'transaction', ...segmentId(se, seIndex), control,
              field: 'SE02', expected: control, actual: value(se, 2),
            }));
          }
          const declared = numberOrNull(value(se, 1));
          const counted = seIndex - stIndex + 1;
          if (declared !== counted) {
            transactionIssues.push(issue('x12_transaction_count', 'SE01 与实际段数不符', {
              scope: 'transaction', ...segmentId(se, seIndex), control,
              field: 'SE01', expected: counted, actual: value(se, 1),
            }));
          }
        }
        const transaction = {
          index: transactions.length,
          interchangeIndex: interchange.index,
          groupIndex: group.index,
          control,
          type: value(st, 1),
          sender: group.sender || value(isa, 6),
          receiver: group.receiver || value(isa, 8),
          stIndex,
          seIndex,
          body,
          issues: transactionIssues,
          envelopeIssues: [],
        };
        transactions.push(transaction);
        group.transactions.push(transaction);
      }
      if (!ge && !group.issues.some(item => item.code === 'x12_group_missing_end')) {
        const tail = Math.min(index, segments.length - 1);
        group.issues.push(issue('x12_group_missing_end', '功能组缺少 GE', {
          scope: 'group', ...segmentId(segments[tail], tail), control: group.control,
        }));
      } else if (ge) {
        const declared = numberOrNull(value(ge, 1));
        if (declared !== group.transactions.length) {
          group.issues.push(issue('x12_group_count', 'GE01 与实际交易集数不符', {
            scope: 'group', ...segmentId(ge, group.geIndex), control: group.control,
            field: 'GE01', expected: group.transactions.length, actual: value(ge, 1),
          }));
        }
        if (value(ge, 2) !== group.control) {
          group.issues.push(issue('x12_group_control', 'GE02 与 GS06 不一致', {
            scope: 'group', ...segmentId(ge, group.geIndex), control: group.control,
            field: 'GE02', expected: group.control, actual: value(ge, 2),
          }));
        }
      }
      interchange.groups.push(group);
    }
    if (!iea && !interchange.issues.some(item => item.code === 'x12_interchange_missing_end')) {
      const tail = Math.max(0, segments.length - 1);
      interchange.issues.push(issue('x12_interchange_missing_end', '交换信封缺少 IEA', {
        scope: 'interchange', ...segmentId(segments[tail], tail), control: interchange.control,
      }));
    } else if (iea) {
      const declared = numberOrNull(value(iea, 1));
      if (declared !== interchange.groups.length) {
        interchange.issues.push(issue('x12_interchange_count', 'IEA01 与实际功能组数不符', {
          scope: 'interchange', ...segmentId(iea, interchange.ieaIndex), control: interchange.control,
          field: 'IEA01', expected: interchange.groups.length, actual: value(iea, 1),
        }));
      }
      if (value(iea, 2) !== interchange.control) {
        interchange.issues.push(issue('x12_interchange_control', 'IEA02 与 ISA13 不一致', {
          scope: 'interchange', ...segmentId(iea, interchange.ieaIndex), control: interchange.control,
          field: 'IEA02', expected: interchange.control, actual: value(iea, 2),
        }));
      }
    }
    for (const group of interchange.groups) {
      group.transactions.forEach(transaction => {
        transaction.envelopeIssues = [...interchange.issues, ...group.issues];
        transaction.issues.push(...transaction.envelopeIssues);
      });
    }
    interchanges.push(interchange);
  }
  return { interchanges, transactions };
}

function parseHierarchy(body, transaction, issues) {
  const nodes = new Map();
  const nodeList = [];
  const prelude = [];
  const transactionIssue = { transaction: transaction.index, transactionControl: transaction.control };
  let current = null;

  const pushIssue = (code, message, details = {}) => issues.push(issue(code, message, {
    ...transactionIssue, ...details,
  }));

  body.forEach(entry => {
    const { segment, index } = entry;
    const tag = segment[0];
    if (tag === 'HL') {
      const hl = value(segment, 1);
      const parent = value(segment, 2);
      const type = value(segment, 3);
      const node = {
        hl,
        parent: parent || null,
        type,
        segmentIndex: index,
        children: [],
        parentType: null,
        orders: [],
        packages: [],
        items: [],
        segments: [{ tag, segmentIndex: index, elements: segment.slice(1) }],
      };
      if (!hl) pushIssue('hl_identifier_missing', 'HL01 节点号缺失', { ...segmentId(segment, index), hl: null });
      if (!TYPES.has(type)) pushIssue('hl_type_unknown', 'HL03 不是 S/O/P/I', {
        ...segmentId(segment, index), hl: hl || null, field: 'HL03', actual: type,
      });
      if (nodes.has(hl) && hl) pushIssue('hl_identifier_duplicate', 'HL01 节点号在本交易集内重复', {
        ...segmentId(segment, index), hl, field: 'HL01', actual: hl,
      });
      nodeList.push(node);
      if (hl && !nodes.has(hl)) nodes.set(hl, node);
      current = node;
      return;
    }
    if (!current) {
      prelude.push({ tag, segmentIndex: index, elements: segment.slice(1) });
      return;
    }
    current.segments.push({ tag, segmentIndex: index, elements: segment.slice(1) });
    if (tag === 'MAN') {
      current.packages.push({ qualifier: value(segment, 1), id: value(segment, 2),
        segmentIndex: index });
    } else if (tag === 'PRF') {
      current.orders.push({ id: value(segment, 1), segmentIndex: index });
    } else if (tag === 'LIN') {
      const line = value(segment, 1);
      const sku = value(segment, 3);
      const item = { line: line || null, sku: sku || null, qualifier: value(segment, 2) || null,
        quantity: null, unit: null, segmentIndex: index, segments: [] };
      current.items.push(item);
    } else if (tag === 'SN1') {
      const item = current.items.at(-1);
      if (!item) {
        pushIssue('quantity_without_line', 'SN1 之前没有可归属的 LIN', {
          ...segmentId(segment, index), hl: current.hl,
        });
      } else {
        const raw = value(segment, 2);
        const quantity = numberOrNull(raw);
        item.quantity = quantity;
        item.quantityRaw = raw;
        item.unit = value(segment, 3) || null;
        item.segments.push({ tag, segmentIndex: index, elements: segment.slice(1) });
      }
    }
  });

  // Resolve every parent reference after the whole transaction is read so that
  // forward references (parent appearing later) are attached, not guessed.
  const roots = [];
  for (const node of nodeList) {
    if (!node.type || !TYPES.has(node.type)) continue;
    if (node.type === 'S') {
      if (node.parent) pushIssue('hl_root_parent', 'S 层不应有父节点', {
        segment: 'HL', segmentIndex: node.segmentIndex,
        hl: node.hl, field: 'HL02', actual: node.parent,
      });
      roots.push(node);
      continue;
    }
    if (!node.parent) {
      pushIssue('hl_parent_missing', '非 S 层缺少 HL02 父节点号', {
        segment: 'HL', segmentIndex: node.segmentIndex, hl: node.hl, field: 'HL02',
      });
      roots.push(node);
      continue;
    }
    if (node.parent === node.hl) {
      pushIssue('hl_parent_cycle', '节点把自身作为父节点', {
        segment: 'HL', segmentIndex: node.segmentIndex, hl: node.hl, field: 'HL02', actual: node.parent,
      });
      continue;
    }
    const parent = nodes.get(node.parent);
    if (!parent || parent === node) {
      pushIssue('hl_parent_unknown', 'HL02 指向的父节点在本交易集内不存在', {
        segment: 'HL', segmentIndex: node.segmentIndex, hl: node.hl, field: 'HL02', actual: node.parent,
        expected: [...nodes.keys()],
      });
      continue;
    }
    node.parentType = parent.type;
    parent.children.push(node.hl);
  }

  for (const node of nodeList) {
    // parentType is only set when a distinct, present parent was resolved.
    if (!node.parentType) continue;
    if (!ALLOWED_CHILDREN[node.parentType]?.has(node.type)) {
      pushIssue('hl_type_conflict', '父子层的 HL03 组合不符合本交换范围', {
        segmentIndex: node.segmentIndex, hl: node.hl, field: 'HL03',
        expected: [...(ALLOWED_CHILDREN[node.parentType] ?? [])], actual: node.type,
        inherited: node.parent,
      });
    }
  }

  // A node whose parent chain never reaches a root is cyclic. Report once per cycle.
  const settled = new Set();
  for (const node of nodeList) {
    const chain = [];
    const positions = new Map();
    let cursor = node;
    while (cursor && !settled.has(cursor.hl)) {
      if (positions.has(cursor.hl)) {
        const cycle = chain.slice(positions.get(cursor.hl));
        pushIssue('hl_parent_cycle', '父子引用形成循环', {
          segmentIndex: cycle[0].segmentIndex, hl: cycle[0].hl,
          actual: cycle.map(item => item.hl), expected: 'acyclic',
        });
        break;
      }
      positions.set(cursor.hl, chain.length);
      chain.push(cursor);
      cursor = cursor.parent ? nodes.get(cursor.parent) : null;
    }
    chain.forEach(item => settled.add(item.hl));
  }

  if (roots.length > 1) {
    pushIssue('hl_multiple_roots', '同一交易集出现多个没有父节点的层次', {
      hl: null, actual: roots.map(node => node.hl),
    });
  }
  if (!nodeList.length) {
    pushIssue('hl_missing', '856 交易集没有任何 HL 层次，不能视为空箱单', {
      segment: 'ST', segmentIndex: transaction.stIndex,
    });
  }

  return { nodes, nodeList, roots, prelude };
}

function nearest(node, nodes, predicate) {
  const seen = new Set();
  let cursor = node;
  while (cursor && !seen.has(cursor.hl)) {
    if (predicate(cursor)) return cursor;
    seen.add(cursor.hl);
    cursor = cursor.parent ? nodes.get(cursor.parent) : null;
  }
  return null;
}

function itemOf(node, item) {
  return {
    line: item.line,
    sku: item.sku,
    qualifier: item.qualifier,
    quantity: item.quantity,
    quantityRaw: item.quantityRaw ?? null,
    unit: item.unit,
    node: node.hl,
    orderId: null,
    orderHl: null,
    packageId: null,
    packageKey: null,
    segmentIndex: item.segmentIndex,
  };
}

function buildAllocation(nodes, nodeList, shipmentKey, transactionIndex, issues) {
  const transactionScope = { transaction: transactionIndex };
  const packages = [];
  const packageByNode = new Map();
  for (const node of nodeList) {
    if (!node.packages.length) continue;
    const ids = [];
    for (const marker of node.packages) {
      if (!marker.id) {
        issues.push(issue('package_identifier_missing', 'MAN02 包装标识缺失', {
          scope: 'transaction', ...transactionScope, segment: 'MAN', segmentIndex: marker.segmentIndex,
          hl: node.hl, field: 'MAN02',
        }));
        continue;
      }
      ids.push({ id: marker.id, qualifier: marker.qualifier, segmentIndex: marker.segmentIndex });
    }
    if (!ids.length) continue;
    if (new Set(ids.map(item => item.id)).size !== ids.length) {
      issues.push(issue('package_identifier_duplicate', '同一层次上的包装标识重复', {
        scope: 'transaction', ...transactionScope, segment: 'MAN', hl: node.hl,
        field: 'MAN02', actual: ids.map(item => item.id),
      }));
    }
    if (node.type !== 'P') {
      issues.push(issue('package_level_unusual', '包装标识不在 P 层', {
        scope: 'transaction', severity: 'warning', ...transactionScope, segment: 'MAN',
        segmentIndex: ids[0].segmentIndex, hl: node.hl, actual: node.type,
      }));
    }
    if (ids.length > 1) {
      issues.push(issue('package_identifiers_multiple', '同一层次带多个包装标识，内容无法拆分到单个标识', {
        scope: 'transaction', severity: 'warning', ...transactionScope, segment: 'MAN',
        segmentIndex: ids[0].segmentIndex, hl: node.hl, actual: ids.map(item => item.id),
      }));
    }
    const primary = ids[0].id;
    const entry = {
      id: primary,
      identifiers: ids,
      scopedKey: scopedPackageKey(shipmentKey, primary),
      hl: node.hl,
      level: node.type,
      orders: [],
      items: [],
      segmentIndex: ids[0].segmentIndex,
    };
    packages.push(entry);
    packageByNode.set(node.hl, entry);
  }

  const seenPackageIds = new Map();
  for (const entry of packages) {
    const previous = seenPackageIds.get(entry.id);
    if (previous && previous !== entry) {
      issues.push(issue('package_identifier_conflict', '同一票内不同层次使用相同包装标识', {
        scope: 'transaction', ...transactionScope, hl: entry.hl, field: 'MAN02',
        actual: entry.id, expected: 'unique-within-shipment', inherited: previous.hl,
      }));
    } else {
      seenPackageIds.set(entry.id, entry);
    }
  }

  const orderNodes = nodeList.filter(node => node.type === 'O' && node.orders.length);
  const orderIds = new Map();
  for (const node of orderNodes) {
    const unique = [...new Set(node.orders.map(order => order.id).filter(Boolean))];
    if (unique.length > 1) {
      issues.push(issue('order_node_multiple_identifiers', '同一 O 层带多个不同订单号', {
        scope: 'transaction', ...transactionScope, segment: 'PRF', hl: node.hl,
        field: 'PRF01', actual: unique,
      }));
    }
    const valid = node.orders.filter(order => order.id);
    if (!valid.length) {
      issues.push(issue('order_identifier_missing', 'PRF01 订单号缺失', {
        scope: 'transaction', ...transactionScope, segment: 'PRF',
        segmentIndex: node.orders[0]?.segmentIndex, hl: node.hl, field: 'PRF01',
      }));
      continue;
    }
    for (const order of valid) {
      const existing = orderIds.get(order.id);
      if (existing && existing !== node) {
        existing.repeatedAt.push({ hl: node.hl, segmentIndex: order.segmentIndex });
      } else if (!existing) {
        orderIds.set(order.id, { id: order.id, hl: node.hl, segmentIndex: order.segmentIndex,
          repeatedAt: [], packages: [], items: [], node });
      }
    }
  }
  for (const order of orderIds.values()) {
    if (order.repeatedAt.length) {
      issues.push(issue('order_identifier_repeated', '同一票内多个 O 层重复同一订单号，已按票号合并', {
        scope: 'transaction', severity: 'warning', ...transactionScope, segment: 'PRF',
        hl: order.hl, field: 'PRF01', actual: order.id,
      }));
    }
  }

  for (const node of nodeList) {
    if (!node.items.length) continue;
    const packageNode = nearest(node, nodes, candidate => packageByNode.has(candidate.hl));
    const orderNode = nearest(node, nodes, candidate => candidate.type === 'O' && candidate.orders.length);
    if (!packageNode) {
      issues.push(issue('item_without_package', '商品行没有任何包装祖先，箱单会缺件', {
        scope: 'transaction', ...transactionScope, segment: 'LIN',
        segmentIndex: node.items[0].segmentIndex, hl: node.hl,
      }));
    }
    const packageEntry = packageNode ? packageByNode.get(packageNode.hl) : null;
    let order = null;
    if (orderNode) {
      const unique = [...new Set(orderNode.orders.map(item => item.id).filter(Boolean))];
      if (unique.length === 1) order = orderIds.get(unique[0]) ?? null;
      else if (unique.length > 1) {
        issues.push(issue('order_allocation_ambiguous', '商品行的祖先 O 层存在多个订单号，不进行分配', {
          scope: 'transaction', ...transactionScope, segment: 'LIN',
          segmentIndex: node.items[0].segmentIndex, hl: node.hl, actual: unique,
        }));
      }
    } else {
      issues.push(issue('order_allocation_unknown', '商品行没有祖先 O 层订单号，保留为未分配', {
        scope: 'transaction', severity: 'warning', ...transactionScope, segment: 'LIN',
        segmentIndex: node.items[0].segmentIndex, hl: node.hl,
      }));
    }
    if (!packageEntry && !order) {
      // Nothing can carry these rows: retain the raw evidence instead of dropping them.
      continue;
    }
    for (const source of node.items) {
      const item = itemOf(node, source);
      if (packageEntry) {
        item.packageId = packageEntry.id;
        item.packageKey = packageEntry.scopedKey;
        item.orderId = order?.id ?? null;
        item.orderHl = order?.hl ?? null;
        packageEntry.items.push(item);
        if (order && !packageEntry.orders.includes(order.id)) packageEntry.orders.push(order.id);
        if (order) {
          order.items.push(item);
          if (!order.packages.some(entry => entry.scopedKey === packageEntry.scopedKey)) {
            order.packages.push({ id: packageEntry.id, scopedKey: packageEntry.scopedKey, hl: packageEntry.hl });
          }
        }
      }
    }
  }

  return { packages, orders: [...orderIds.values()] };
}

function analyzeTransaction(transaction) {
  const transactionIssue = { transaction: transaction.index, transactionControl: transaction.control };
  const evidence = {
    locator: locatorOf(transaction),
    segmentRange: { from: transaction.stIndex, to: transaction.seIndex ?? transaction.stIndex + transaction.body.length },
    segments: [
      { tag: 'ST', segmentIndex: transaction.stIndex, elements: [transaction.type, transaction.control] },
      ...transaction.body.map(entry => ({
        tag: entry.segment[0], segmentIndex: entry.index, elements: entry.segment.slice(1),
      })),
    ],
  };
  const baseIssues = transaction.issues;
  if (transaction.type !== '856') {
    return {
      locator: locatorOf(transaction),
      status: 'unsupported',
      shipment: null,
      packages: [],
      orders: [],
      issues: baseIssues,
      evidence,
    };
  }

  // Transaction-local issue list: a hierarchy defect in one set must not
  // reject an independent set in the same interchange or group.
  const localIssues = [];
  const hierarchy = parseHierarchy(transaction.body, transaction, localIssues);
  const bsn = hierarchy.prelude.find(entry => entry.tag === 'BSN');
  const shipmentId = bsn ? value(bsn.elements, 1) : '';
  let shipment = null;
  if (!shipmentId) {
    localIssues.push(issue('shipment_identifier_missing', 'BSN02 票号缺失，无法确定箱件归属', {
      ...transactionIssue, scope: 'transaction', segment: 'BSN', field: 'BSN02',
    }));
  } else {
    const identity = { sender: transaction.sender, receiver: transaction.receiver, shipmentId };
    shipment = { id: shipmentId, sender: transaction.sender, receiver: transaction.receiver,
      key: shipmentKeyOf(identity), bsn: bsn ? bsn.elements : null };
  }

  const allocation = shipment
    ? buildAllocation(hierarchy.nodes, hierarchy.nodeList, shipment.key, transaction.index, localIssues)
    : { packages: [], orders: [] };

  const hasError = baseIssues.some(entry => entry.severity !== 'warning') ||
    localIssues.some(entry => entry.severity !== 'warning');
  const status = hasError ? 'rejected' : 'accepted';
  const packaged = status === 'accepted' ? allocation.packages : [];
  const ordered = status === 'accepted' ? allocation.orders.map(order => ({
    id: order.id,
    scopedKey: scopedOrderKey(shipment?.key, order.id),
    hl: order.hl,
    packages: order.packages,
    items: order.items,
  })) : [];

  if (status === 'rejected') {
    // Keep the observed hierarchy so the defect can be located, but expose no
    // package/order allocation that could be mistaken for an outbound list.
    evidence.hierarchy = hierarchy.nodeList.map(node => ({
      hl: node.hl,
      parent: node.parent,
      type: node.type,
      children: node.children,
      segmentIndex: node.segmentIndex,
    }));
  }
  return {
    locator: locatorOf(transaction),
    status,
    shipment,
    packages: packaged,
    orders: ordered,
    issues: [...baseIssues, ...localIssues],
    evidence,
  };
}

function mergeShipmentGroup(key, members) {
  const source = members[0].shipment;
  const identity = { id: source.id, sender: source.sender, receiver: source.receiver, key };
  const locators = members.map(member => member.locator);
  const issues = members.flatMap(member => member.issues);
  const evidence = members.map(member => member.evidence);
  const reject = () => ({
    key, identity, status: 'rejected', packages: [], orders: [],
    issues, locators, evidence,
  });
  if (members.some(member => member.status !== 'accepted')) return reject();
  if (members.length === 1) {
    return {
      key, identity, status: 'accepted',
      packages: members[0].packages, orders: members[0].orders,
      issues, locators, evidence,
    };
  }

  const packages = [];
  const seen = new Map();
  for (const member of members) {
    for (const entry of member.packages) {
      if (seen.has(entry.scopedKey)) {
        issues.push(issue('package_identifier_conflict_across_transactions',
          '同一票的多张交易集重复声明了同一包装标识，无法判断是重复还是续装', {
            scope: 'document', severity: 'error', segment: 'MAN', hl: entry.hl,
            field: 'MAN02', actual: entry.id, inherited: seen.get(entry.scopedKey).hl,
          }));
        continue;
      }
      seen.set(entry.scopedKey, entry);
      packages.push(entry);
    }
  }
  if (issues.some(entry => entry.severity !== 'warning')) return reject();

  const orders = new Map();
  for (const member of members) {
    for (const entry of member.orders) {
      const existing = orders.get(entry.scopedKey);
      if (!existing) {
        orders.set(entry.scopedKey, { ...entry, packages: [...entry.packages], items: [...entry.items] });
      } else {
        for (const item of entry.packages) {
          if (!existing.packages.some(known => known.scopedKey === item.scopedKey)) {
            existing.packages.push(item);
          }
        }
        existing.items.push(...entry.items);
      }
    }
  }
  return { key, identity, status: 'accepted', packages, orders: [...orders.values()],
    issues, locators, evidence };
}

function groupByShipment(transactions) {
  const groups = new Map();
  for (const transaction of transactions) {
    if (!transaction.shipment) continue;
    const key = transaction.shipment.key;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(transaction);
  }
  return [...groups.entries()].map(([key, members]) => mergeShipmentGroup(key, members));
}

/**
 * Read an X12 document into shipment structures without flattening HL trees.
 * Control-count failures at any envelope level mark the affected transaction sets
 * rejected; those sets still carry their segment evidence and locator.
 */
export function readShipments(bytes) {
  const { delimiters, segments } = scan(bytes);
  const issues = [];
  const { interchanges, transactions } = parseEnvelopes(segments, issues);
  const parsed = transactions.map(transaction => analyzeTransaction(transaction));
  const shipments = groupByShipment(parsed);
  const acceptedTransactions = parsed.filter(item => item.status === 'accepted').length;
  const acceptedShipments = shipments.filter(item => item.status === 'accepted').length;
  const status = !parsed.length ? 'rejected'
    : acceptedTransactions === parsed.length && acceptedShipments === shipments.length ? 'accepted'
      : acceptedTransactions || acceptedShipments ? 'partial' : 'rejected';
  return {
    kind: 'x12-shipment-receipt',
    delimiters,
    interchanges: interchanges.map(interchange => ({
      index: interchange.index,
      control: interchange.control,
      groups: interchange.groups.map(group => ({
        index: group.index,
        control: group.control,
        functional: group.functional,
        transactions: group.transactions.map(transaction => transaction.index),
      })),
      issues: interchange.issues,
    })),
    transactions: parsed,
    shipments,
    issues: issues.filter(entry => entry.scope === 'document'),
    status,
  };
}





