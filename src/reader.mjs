export function inspect(bytes) {
  const text = bytes.toString('ascii');
  if (text.length < 106 || !text.startsWith('ISA')) throw new Error('x12_isa_header');
  const element = text[3]; const component = text[104]; const terminator = text[105];
  if (new Set([element, component, terminator]).size !== 3) throw new Error('x12_delimiters');
  const segments = text.split(terminator).map(segment => segment.trim()).filter(Boolean).map(segment => segment.split(element));
  const envelopes = []; let current;
  for (const segment of segments) {
    if (segment[0] === 'ST') {
      if (current) throw new Error('x12_nested_st');
      current = { type: segment[1], control: segment[2], segments: [segment] };
    } else if (segment[0] === 'SE') {
      if (!current || segment[2] !== current.control) throw new Error('x12_transaction_control');
      current.segments.push(segment);
      if (Number(segment[1]) !== current.segments.length) throw new Error('x12_transaction_count');
      envelopes.push(current); current = null;
    } else if (current) current.segments.push(segment);
  }
  if (current || !envelopes.length) throw new Error('x12_transaction_missing_end');
  return { kind: 'x12-transaction-list', delimiters: { element, component, terminator }, transactions: envelopes };
}
