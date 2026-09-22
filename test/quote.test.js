'use strict';

// 印刷用纸报价纯函数单测：尺寸容纳、旋转方向枚举、利用率、费用与最低总价选择、
// 签帖开机次数、放不下时的明确原因，以及入参校验。
const assert = require('assert');
const {
  MM_TO_PT,
  MAX_PAPER_SPECS,
  mmToPt,
  ptToMm,
  parseQuoteRequest,
  buildPrintQuote,
} = require('../lib/quote');

function approx(a, b, eps = 1e-6) {
  return Math.abs(a - b) <= eps;
}

// 构造拼版面板（pt）：统一面板宽高对应的 mm 直接给出，便于断言
function panelFromMm(widthMm, heightMm, orientation = 'portrait') {
  return { width: mmToPt(widthMm), height: mmToPt(heightMm), orientation };
}

function baseBody(overrides = {}) {
  return {
    panel: panelFromMm(150, 200), // 每张拼版纸需要 300 × 200 mm（横向双联）
    sheetCount: 10,
    signatureMode: false,
    signatureCount: 1,
    papers: [
      { name: '合适纸 300×200', widthMm: 300, heightMm: 200, pricePerSheet: 0.5, setupFee: 20 },
    ],
    ...overrides,
  };
}

// ---------- 1. 基础换算 ----------
assert.ok(approx(ptToMm(72), 25.4));
assert.ok(approx(mmToPt(25.4), 72));
assert.strictEqual(MAX_PAPER_SPECS, 8);

// ---------- 2. 原方向恰好容纳：利用率 100%，费用 = 单价×张数 + 开机费 ----------
{
  const quote = buildPrintQuote(baseBody());
  assert.strictEqual(quote.feasible, true);
  assert.strictEqual(quote.selectedPaperId, 1);
  const sel = quote.selection;
  assert.strictEqual(sel.fit, true);
  assert.strictEqual(sel.orientation, 'straight');
  assert.strictEqual(sel.paperRotated, false);
  assert.ok(approx(sel.utilization, 1, 1e-9), `利用率应为 1，实际 ${sel.utilization}`);
  assert.strictEqual(sel.utilizationPercent, '100.00%');
  assert.strictEqual(sel.paperCost, 5);    // 0.5 × 10
  assert.strictEqual(sel.setupCost, 20);   // 20 × 1
  assert.strictEqual(sel.totalCost, 25);
  assert.strictEqual(sel.sheets, 10);
  assert.strictEqual(sel.runs, 1);
  assert.strictEqual(quote.totals.totalCost, 25);
  assert.strictEqual(quote.request.sheetSize.widthMm, 300);
  assert.strictEqual(quote.request.sheetSize.heightMm, 200);
  assert.strictEqual(quote.kind, 'print-quote');
  assert.strictEqual(quote.schemaVersion, 1);
}

// ---------- 3. 仅旋转 90° 才能容纳 ----------
{
  const body = baseBody({
    papers: [{ name: '竖纸 200×300', widthMm: 200, heightMm: 300, pricePerSheet: 0.5, setupFee: 20 }],
  });
  const quote = buildPrintQuote(body);
  assert.strictEqual(quote.feasible, true);
  assert.strictEqual(quote.selection.orientation, 'rotated90');
  assert.strictEqual(quote.selection.paperRotated, true);
  assert.ok(approx(quote.selection.utilization, 1, 1e-9));
}

// ---------- 4. 两个方向都能放下时优先原方向 ----------
{
  // 需要 300 × 200；纸张 320 × 220：原方向可容纳；旋转后 220 × 320 也可容纳
  const body = baseBody({
    papers: [{ name: '宽松纸', widthMm: 320, heightMm: 220, pricePerSheet: 0.5, setupFee: 20 }],
  });
  const quote = buildPrintQuote(body);
  assert.strictEqual(quote.selection.orientation, 'straight');
  // 利用率 = 拼版纸面积 / 纸张面积 = 300×200 / 320×220
  assert.ok(approx(quote.selection.utilization, (300 * 200) / (320 * 220), 1e-9));
  assert.strictEqual(quote.selection.utilizationPercent,
    `${(((300 * 200) / (320 * 220)) * 100).toFixed(2)}%`);
}

// ---------- 5. 利用率与费用不随方向变化 ----------
{
  // 同一张纸的原方向/旋转面积相同；不同命名的等价纸利用率应一致
  const body = baseBody({
    papers: [
      { name: '横纸', widthMm: 300, heightMm: 200, pricePerSheet: 0.5, setupFee: 20 },
      { name: '竖纸', widthMm: 200, heightMm: 300, pricePerSheet: 0.5, setupFee: 20 },
    ],
  });
  const quote = buildPrintQuote(body);
  const [a, b] = quote.options;
  assert.ok(approx(a.utilization, b.utilization, 1e-9));
  assert.strictEqual(a.totalCost, b.totalCost);
  // 同分先按利用率（相同）再按纸号：纸号 1 选中
  assert.strictEqual(quote.selectedPaperId, 1);
}

// ---------- 6. 最低总价选择（单价 + 开机费综合比较） ----------
{
  const body = baseBody({
    papers: [
      { name: '便宜纸但开机贵', widthMm: 300, heightMm: 200, pricePerSheet: 0.2, setupFee: 30 }, // 2+30=32
      { name: '纸贵开机便宜', widthMm: 300, heightMm: 200, pricePerSheet: 0.5, setupFee: 5 },  // 5+5=10
      { name: '纸张更大', widthMm: 400, heightMm: 300, pricePerSheet: 0.05, setupFee: 0 },     // 0.5 -> 选中
    ],
  });
  const quote = buildPrintQuote(body);
  assert.strictEqual(quote.selectedPaperId, 3);
  assert.strictEqual(quote.selection.totalCost, 0.5);
  // options 按总价升序
  assert.deepStrictEqual(quote.options.map((o) => o.totalCost), [0.5, 10, 32]);
}

// ---------- 7. 分册签帖：开机次数 = 签帖数 ----------
{
  const body = baseBody({
    signatureMode: true,
    signatureCount: 3,
    sheetCount: 12,
    papers: [{ name: '签帖用纸', widthMm: 300, heightMm: 200, pricePerSheet: 0.25, setupFee: 15 }],
  });
  const quote = buildPrintQuote(body);
  assert.strictEqual(quote.selection.sheets, 12);
  assert.strictEqual(quote.selection.runs, 3);
  assert.strictEqual(quote.selection.paperCost, 3);   // 0.25 × 12
  assert.strictEqual(quote.selection.setupCost, 45); // 15 × 3
  assert.strictEqual(quote.selection.totalCost, 48);
}

// ---------- 8. 放不下：feasible=false 且逐纸给出原因 ----------
{
  const body = baseBody({
    papers: [
      { name: '太小 290×190', widthMm: 290, heightMm: 190, pricePerSheet: 0.5, setupFee: 20 },
      { name: '只窄一点', widthMm: 299, heightMm: 200, pricePerSheet: 0.5, setupFee: 20 },
    ],
  });
  const quote = buildPrintQuote(body);
  assert.strictEqual(quote.feasible, false);
  assert.strictEqual(quote.selection, null);
  assert.strictEqual(quote.totals, null);
  assert.strictEqual(quote.selectedPaperId, null);
  assert.ok(/无法容纳/.test(quote.reason));
  assert.strictEqual(quote.options.length, 2);
  for (const option of quote.options) {
    assert.strictEqual(option.fit, false);
    assert.strictEqual(option.orientation, null);
    assert.strictEqual(option.utilization, null);
    assert.strictEqual(option.totalCost, null);
    assert.ok(/纸张尺寸不足/.test(option.reason), option.reason);
    assert.ok(option.reason.includes(option.name));
    assert.ok(option.reason.includes('旋转 90°'));
  }
}

// ---------- 9. 混合：可用方案在前、放不下的在后 ----------
{
  const body = baseBody({
    papers: [
      { name: '放不下', widthMm: 100, heightMm: 100, pricePerSheet: 0.1, setupFee: 0 },
      { name: '放得下', widthMm: 300, heightMm: 200, pricePerSheet: 0.5, setupFee: 20 },
    ],
  });
  const quote = buildPrintQuote(body);
  assert.strictEqual(quote.feasible, true);
  assert.strictEqual(quote.options[0].fit, true);
  assert.strictEqual(quote.options[1].fit, false);
  assert.strictEqual(quote.selectedPaperId, 2);
}

// ---------- 10. 费用四舍五入到分 ----------
{
  const body = baseBody({
    sheetCount: 7,
    papers: [{ name: '三位小数单价', widthMm: 300, heightMm: 200, pricePerSheet: 0.333, setupFee: 1.999 }],
  });
  const quote = buildPrintQuote(body);
  // 0.333 × 7 = 2.331 -> 2.33；1.999 × 1 -> 2.00；总价基于四舍五入后相加
  assert.strictEqual(quote.selection.paperCost, 2.33);
  assert.strictEqual(quote.selection.setupCost, 2);
  assert.strictEqual(quote.selection.totalCost, 4.33);
}

// ---------- 11. 入参校验 ----------
function expectThrow(body, pattern) {
  assert.throws(() => parseQuoteRequest(body), (err) => {
    assert.ok(pattern.test(err.message), `错误信息「${err.message}」不匹配 ${pattern}`);
    return true;
  });
}

expectThrow({}, /panel/);
expectThrow({ panel: { width: 0, height: 10 } }, /panel/);
expectThrow({ panel: { width: 10, height: -1 } }, /panel/);
expectThrow({ panel: { width: 10 }, sheetCount: 1, papers: [] }, /panel/);
expectThrow({ panel: panelFromMm(150, 200) }, /sheetCount/);
expectThrow({ panel: panelFromMm(150, 200), sheetCount: 0, papers: [] }, /sheetCount/);
expectThrow({ panel: panelFromMm(150, 200), sheetCount: 2, signatureCount: 3, papers: [] }, /signatureCount/);
expectThrow({ panel: panelFromMm(150, 200), sheetCount: 2 }, /papers/);
expectThrow({ panel: panelFromMm(150, 200), sheetCount: 2, papers: [] }, /papers/);

// 超过 8 种
expectThrow({
  panel: panelFromMm(150, 200),
  sheetCount: 2,
  papers: Array.from({ length: 9 }, (_, i) => ({
    name: `P${i}`, widthMm: 300, heightMm: 200, pricePerSheet: 1, setupFee: 1,
  })),
}, new RegExp(`最多 ${MAX_PAPER_SPECS} 种`));

// 纸张字段非法
function badPaper(paper, pattern) {
  expectThrow({ panel: panelFromMm(150, 200), sheetCount: 2, papers: [paper] }, pattern);
}
badPaper({ name: '无宽', heightMm: 200, pricePerSheet: 1, setupFee: 1 }, /宽度/);
badPaper({ name: '负高', widthMm: 300, heightMm: -1, pricePerSheet: 1, setupFee: 1 }, /高度/);
badPaper({ name: '字符串宽', widthMm: 'a', heightMm: 200, pricePerSheet: 1, setupFee: 1 }, /宽度/);
badPaper({ name: '负单价', widthMm: 300, heightMm: 200, pricePerSheet: -0.1, setupFee: 1 }, /单价/);
badPaper({ name: '负开机费', widthMm: 300, heightMm: 200, pricePerSheet: 1, setupFee: -1 }, /开机费/);
badPaper('not-object', /格式不正确/);

// 缺省名称自动补「纸张 N」
{
  const quote = buildPrintQuote(baseBody({
    papers: [{ widthMm: 300, heightMm: 200, pricePerSheet: 0.5, setupFee: 20 }],
  }));
  assert.strictEqual(quote.selection.name, '纸张 1');
}

// ---------- 12. 容差：毫米换算后差约 0.003mm 仍可容纳 ----------
{
  // 面板用 pt 直接给：纸面宽 = 2×面板宽，超出 0.04pt（< 0.05pt 容差），高度刚好
  const body = {
    panel: { width: mmToPt(150) + 0.02, height: mmToPt(200) },
    sheetCount: 1,
    papers: [{ name: '恰好 300×200', widthMm: 300, heightMm: 200, pricePerSheet: 1, setupFee: 0 }],
  };
  const quote = buildPrintQuote(body);
  assert.strictEqual(quote.feasible, true);

  // 超出容差则判为放不下
  const tooTight = buildPrintQuote({
    panel: { width: mmToPt(150) + 0.1, height: mmToPt(200) },
    sheetCount: 1,
    papers: [{ name: '300×200', widthMm: 300, heightMm: 200, pricePerSheet: 1, setupFee: 0 }],
  });
  assert.strictEqual(tooTight.feasible, false);
}

console.log('✅ 印刷用纸报价单测通过：双方向枚举、利用率、费用与开机次数、最低总价选择、');
console.log('   放不下原因、签帖模式、入参校验均符合预期');
