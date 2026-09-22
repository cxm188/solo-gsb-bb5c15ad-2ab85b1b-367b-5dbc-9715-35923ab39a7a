'use strict';

// HTTP 集成测试：不监听固定端口，直接在 ephemeral 端口上启动 app。
const assert = require('assert');
const http = require('http');
const { PDFDocument, StandardFonts, rgb, degrees } = require('pdf-lib');
const { app } = require('../server');

function multipartBody(fields, boundary) {
  const chunks = [];
  for (const [name, value] of Object.entries(fields.text || {})) {
    chunks.push(Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
    ));
  }
  for (const file of fields.files || []) {
    chunks.push(Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="${file.field}"; `
        + `filename="${file.filename}"\r\nContent-Type: ${file.contentType}\r\n\r\n`,
    ));
    chunks.push(file.data);
    chunks.push(Buffer.from('\r\n'));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return Buffer.concat(chunks);
}

function request(server, method, urlPath, { body, headers } = {}) {
  const { port } = server.address();
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path: urlPath,
      method,
      headers: headers || {},
    }, (res) => {
      const parts = [];
      res.on('data', (c) => parts.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(parts) }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function jsonRequest(server, urlPath, payload) {
  const body = Buffer.from(JSON.stringify(payload));
  return request(server, 'POST', urlPath, {
    body,
    headers: { 'Content-Type': 'application/json', 'Content-Length': body.length },
  });
}

(async () => {
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));

  try {
    // 构造 5 页问题 PDF：尺寸不一致 + 无文字页 + 非 4 倍数
    const src = await PDFDocument.create();
    const font = await src.embedFont(StandardFonts.Helvetica);
    for (let i = 1; i <= 4; i += 1) {
      const p = src.addPage([595.28, 841.89]);
      p.drawText(`PAGE ${i}`, { x: 80, y: 400, size: 24, font, color: rgb(0, 0, 0) });
    }
    const rotated = src.addPage([595.28, 841.89]);
    rotated.setRotation(degrees(180));
    rotated.drawText('ROTATED', { x: 80, y: 400, size: 24, font });
    const pdfBytes = Buffer.from(await src.save());

    // 1. 健康检查
    const health = await request(server, 'GET', '/api/health');
    assert.strictEqual(health.status, 200);
    assert.deepStrictEqual(JSON.parse(health.body.toString()), { ok: true });

    // 2. 印前校验返回 JSON 报告（不返回 PDF），含 180° 错误也仍为 200
    const boundary = '----test-boundary';
    const body = multipartBody({
      files: [{ field: 'pdf', filename: 'sample.pdf', contentType: 'application/pdf', data: pdfBytes }],
    }, boundary);
    const preflightResp = await request(server, 'POST', '/api/preflight', {
      body,
      headers: {
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': body.length,
      },
    });
    assert.strictEqual(preflightResp.status, 200);
    assert.ok(!preflightResp.headers['content-type'].includes('pdf'));
    const report = JSON.parse(preflightResp.body.toString());
    assert.strictEqual(report.pageCount, 5);
    assert.strictEqual(report.summary.passed, false);
    assert.ok(report.issues.some((i) => i.code === 'rotated_180' && i.pageFrom === 5));
    assert.ok(report.issues.some((i) => i.code === 'blank_padding'));

    // 3. 缺少文件 -> 400；非 PDF -> 400；垃圾内容 -> 422
    const empty = multipartBody({}, boundary);
    const missing = await request(server, 'POST', '/api/preflight', {
      body: empty,
      headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}`, 'Content-Length': empty.length },
    });
    assert.strictEqual(missing.status, 400);

    const txtBody = multipartBody({
      files: [{ field: 'pdf', filename: 'a.txt', contentType: 'text/plain', data: Buffer.from('hello') }],
    }, boundary);
    const badType = await request(server, 'POST', '/api/preflight', {
      body: txtBody,
      headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}`, 'Content-Length': txtBody.length },
    });
    assert.strictEqual(badType.status, 400);

    const garbageBody = multipartBody({
      files: [{ field: 'pdf', filename: 'x.pdf', contentType: 'application/pdf', data: Buffer.from('%PDF-broken') }],
    }, boundary);
    const garbage = await request(server, 'POST', '/api/preflight', {
      body: garbageBody,
      headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}`, 'Content-Length': garbageBody.length },
    });
    assert.strictEqual(garbage.status, 422);
    assert.match(JSON.parse(garbage.body.toString()).error, /无法校验/);

    // ---------- 印前报告差异对比 ----------
    // 基准 5 页：第 5 页 180° 旋转（错误）+ 非 4 倍数补白
    const base = await PDFDocument.create();
    const baseFont = await base.embedFont(StandardFonts.Helvetica);
    for (let i = 1; i <= 4; i += 1) {
      base.addPage([595.28, 841.89]).drawText(`BASE ${i}`, {
        x: 80, y: 400, size: 24, font: baseFont,
      });
    }
    const baseRot = base.addPage([595.28, 841.89]);
    baseRot.setRotation(degrees(180));
    baseRot.drawText('BASE 5', { x: 80, y: 400, size: 24, font: baseFont });
    const baseBytes = Buffer.from(await base.save());

    // 待交付 8 页：全部正常无旋转（问题全部解决，补白提示也消失），新增 3 页
    const finalDoc = await PDFDocument.create();
    const finalFont = await finalDoc.embedFont(StandardFonts.Helvetica);
    for (let i = 1; i <= 8; i += 1) {
      finalDoc.addPage([595.28, 841.89]).drawText(`FINAL ${i}`, {
        x: 80, y: 400, size: 24, font: finalFont,
      });
    }
    const finalBytes = Buffer.from(await finalDoc.save());

    // 5. 正常对比 -> 200，180° 与补白均已解决，页数 5 -> 8
    const diffBody = multipartBody({
      files: [
        { field: 'baseline', filename: 'base.pdf', contentType: 'application/pdf', data: baseBytes },
        { field: 'delivery', filename: 'final.pdf', contentType: 'application/pdf', data: finalBytes },
      ],
    }, boundary);
    const diffResp = await request(server, 'POST', '/api/preflight/diff', {
      body: diffBody,
      headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}`, 'Content-Length': diffBody.length },
    });
    assert.strictEqual(diffResp.status, 200);
    const diff = JSON.parse(diffResp.body.toString());
    assert.strictEqual(diff.kind, 'preflight-diff');
    assert.strictEqual(diff.pageCount.baseline, 5);
    assert.strictEqual(diff.pageCount.delivery, 8);
    assert.deepStrictEqual(diff.pageCount.addedPages, [6, 7, 8]);
    assert.ok(diff.resolved.some((e) => e.code === 'rotated_180'));
    assert.ok(diff.resolved.some((e) => e.code === 'blank_padding' && e.documentLevel));
    assert.strictEqual(diff.added.length, 0);
    assert.strictEqual(diff.persistent.length, 0);
    assert.strictEqual(diff.baseline.file.name, 'base.pdf');
    assert.strictEqual(diff.delivery.file.name, 'final.pdf');

    // 同一份 PDF 自比：三个分组为空、页数不变
    const selfBody = multipartBody({
      files: [
        { field: 'baseline', filename: 'f.pdf', contentType: 'application/pdf', data: finalBytes },
        { field: 'delivery', filename: 'f.pdf', contentType: 'application/pdf', data: finalBytes },
      ],
    }, boundary);
    const selfResp = await request(server, 'POST', '/api/preflight/diff', {
      body: selfBody,
      headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}`, 'Content-Length': selfBody.length },
    });
    assert.strictEqual(selfResp.status, 200);
    const selfDiff = JSON.parse(selfResp.body.toString());
    assert.strictEqual(selfDiff.added.length, 0);
    assert.strictEqual(selfDiff.resolved.length, 0);
    assert.strictEqual(selfDiff.persistent.length, 0);
    assert.strictEqual(selfDiff.pageCount.delta, 0);

    // 6. 缺少任一字段 -> 400
    const oneOnlyBody = multipartBody({
      files: [{ field: 'baseline', filename: 'base.pdf', contentType: 'application/pdf', data: baseBytes }],
    }, boundary);
    const oneOnly = await request(server, 'POST', '/api/preflight/diff', {
      body: oneOnlyBody,
      headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}`, 'Content-Length': oneOnlyBody.length },
    });
    assert.strictEqual(oneOnly.status, 400);
    assert.match(JSON.parse(oneOnly.body.toString()).error, /baseline/);

    // 基准为非 PDF（.txt）-> 400
    const txtDiffBody = multipartBody({
      files: [
        { field: 'baseline', filename: 'a.txt', contentType: 'text/plain', data: Buffer.from('hello') },
        { field: 'delivery', filename: 'final.pdf', contentType: 'application/pdf', data: finalBytes },
      ],
    }, boundary);
    const txtDiff = await request(server, 'POST', '/api/preflight/diff', {
      body: txtDiffBody,
      headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}`, 'Content-Length': txtDiffBody.length },
    });
    assert.strictEqual(txtDiff.status, 400);
    assert.match(JSON.parse(txtDiff.body.toString()).error, /基准/);

    // 基准损坏 -> 422 且错误标明「基准」
    const brokenBaseBody = multipartBody({
      files: [
        { field: 'baseline', filename: 'bad.pdf', contentType: 'application/pdf', data: Buffer.from('%PDF-broken') },
        { field: 'delivery', filename: 'final.pdf', contentType: 'application/pdf', data: finalBytes },
      ],
    }, boundary);
    const brokenBase = await request(server, 'POST', '/api/preflight/diff', {
      body: brokenBaseBody,
      headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}`, 'Content-Length': brokenBaseBody.length },
    });
    assert.strictEqual(brokenBase.status, 422);
    assert.match(JSON.parse(brokenBase.body.toString()).error, /基准 PDF 无法校验/);

    // 待交付损坏 -> 422 且错误标明「待交付」
    const brokenFinalBody = multipartBody({
      files: [
        { field: 'baseline', filename: 'base.pdf', contentType: 'application/pdf', data: baseBytes },
        { field: 'delivery', filename: 'bad.pdf', contentType: 'application/pdf', data: Buffer.from('%PDF-broken') },
      ],
    }, boundary);
    const brokenFinal = await request(server, 'POST', '/api/preflight/diff', {
      body: brokenFinalBody,
      headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}`, 'Content-Length': brokenFinalBody.length },
    });
    assert.strictEqual(brokenFinal.status, 422);
    assert.match(JSON.parse(brokenFinal.body.toString()).error, /待交付 PDF 无法校验/);

    // 7. 对比接口的使用不影响单文件校验（再次调用仍 200）
    const recheck = await request(server, 'POST', '/api/preflight', {
      body,
      headers: {
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': body.length,
      },
    });
    assert.strictEqual(recheck.status, 200);

    // 4. 校验失败/有错误不阻断：同一文件仍可拼版，返回 application/pdf
    const imposeBody = multipartBody({
      files: [{ field: 'pdf', filename: 'sample.pdf', contentType: 'application/pdf', data: pdfBytes }],
    }, boundary);
    const imposeResp = await request(server, 'POST', '/api/impose', {
      body: imposeBody,
      headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}`, 'Content-Length': imposeBody.length },
    });
    assert.strictEqual(imposeResp.status, 200);
    assert.ok(imposeResp.headers['content-type'].includes('application/pdf'));
    assert.ok(imposeResp.headers['x-imposition-plan']);
    const imposedPdf = await PDFDocument.load(imposeResp.body);
    // 5 页 -> 补 3 白 -> 8 面板 -> 2 张纸 -> 4 个输出页
    assert.strictEqual(imposedPdf.getPageCount(), 4);

    // ---------- 印刷用纸报价 /api/quote ----------
    // 5 页 -> 补白到 8 -> 2 张纸；A4 竖版面展开 420 × 297 mm
    const panel = { width: 595.2756, height: 841.8898, orientation: 'portrait' };
    const quotePlan = {
      sheets: [{ sheet: 1 }, { sheet: 2 }],
      sourceCount: 5, paddedCount: 3, totalCount: 8, blanks: 3,
      panel,
    };

    // 正常报价：A3 与 B2，选最低总价；A3 原向容纳（420×297），B2 更便宜
    const quoteResp = await jsonRequest(server, '/api/quote', {
      plan: quotePlan,
      papers: [
        { name: 'A3 铜版', widthMm: 420, heightMm: 297, pricePerSheet: 1, setupFee: 50 },
        { name: 'B2 胶版', widthMm: 500, heightMm: 707, pricePerSheet: 0.5, setupFee: 30 },
      ],
    });
    assert.strictEqual(quoteResp.status, 200);
    const quote = JSON.parse(quoteResp.body.toString());
    assert.strictEqual(quote.kind, 'paper-quote');
    assert.strictEqual(quote.feasible, true);
    assert.strictEqual(quote.selected.name, 'B2 胶版');
    assert.strictEqual(quote.selected.totalCost, 31);
    assert.strictEqual(quote.layout.sheetCount, 2);
    assert.strictEqual(quote.layout.runCount, 1);
    assert.ok(Math.abs(quote.layout.sheet.widthMm - 420) < 0.01);
    assert.ok(Math.abs(quote.layout.sheet.heightMm - 297) < 0.01);

    // 无纸张可容纳：HTTP 200 + feasible=false + 明确原因
    const noFitResp = await jsonRequest(server, '/api/quote', {
      plan: quotePlan,
      papers: [{ name: 'A4', widthMm: 297, heightMm: 210, pricePerSheet: 0.3, setupFee: 10 }],
    });
    assert.strictEqual(noFitResp.status, 200);
    const noFit = JSON.parse(noFitResp.body.toString());
    assert.strictEqual(noFit.feasible, false);
    assert.strictEqual(noFit.selected, null);
    assert.strictEqual(noFit.reasonCode, 'no_fitting_paper');
    assert.match(noFit.reason, /A4/);
    assert.strictEqual(noFit.options[0].fits, false);

    // 签帖方案：开机次数 = 帖数（3 帖 → 开机费 ×3）
    const sigQuoteResp = await jsonRequest(server, '/api/quote', {
      plan: {
        signatureMode: true,
        signatures: [
          { signature: 1, sheets: [{ sheet: 1 }] },
          { signature: 2, sheets: [{ sheet: 1 }] },
          { signature: 3, sheets: [{ sheet: 1 }] },
        ],
        sheetCount: 3, signatureCount: 3, panel,
      },
      papers: [{ name: 'A3', widthMm: 420, heightMm: 297, pricePerSheet: 1, setupFee: 50 }],
    });
    assert.strictEqual(sigQuoteResp.status, 200);
    const sigQuote = JSON.parse(sigQuoteResp.body.toString());
    assert.strictEqual(sigQuote.layout.runCount, 3);
    assert.strictEqual(sigQuote.selected.setupCost, 150);
    assert.strictEqual(sigQuote.selected.totalCost, 153);

    // 参数错误 -> 400
    const missingPlan = await jsonRequest(server, '/api/quote', {
      papers: [{ widthMm: 420, heightMm: 297 }],
    });
    assert.strictEqual(missingPlan.status, 400);
    assert.match(JSON.parse(missingPlan.body.toString()).error, /plan/);

    const missingPapers = await jsonRequest(server, '/api/quote', { plan: quotePlan });
    assert.strictEqual(missingPapers.status, 400);
    assert.match(JSON.parse(missingPapers.body.toString()).error, /papers/);

    const emptyPapers = await jsonRequest(server, '/api/quote', { plan: quotePlan, papers: [] });
    assert.strictEqual(emptyPapers.status, 400);
    assert.match(JSON.parse(emptyPapers.body.toString()).error, /至少维护一种/);

    const badPaper = await jsonRequest(server, '/api/quote', {
      plan: quotePlan,
      papers: [{ name: '坏', widthMm: -1, heightMm: 297 }],
    });
    assert.strictEqual(badPaper.status, 400);
    assert.match(JSON.parse(badPaper.body.toString()).error, /宽必须是大于 0/);

    // 超过 8 种纸张 -> 400
    const tooMany = await jsonRequest(server, '/api/quote', {
      plan: quotePlan,
      papers: Array(9).fill({ widthMm: 420, heightMm: 297 }),
    });
    assert.strictEqual(tooMany.status, 400);
    assert.match(JSON.parse(tooMany.body.toString()).error, /最多维护 8 种/);

    // 非法 JSON body -> 400
    const badJsonRaw = Buffer.from('{not-json');
    const badJson = await request(server, 'POST', '/api/quote', {
      body: badJsonRaw,
      headers: { 'Content-Type': 'application/json', 'Content-Length': badJsonRaw.length },
    });
    assert.strictEqual(badJson.status, 400);
    assert.match(JSON.parse(badJson.body.toString()).error, /JSON/);

    console.log('✅ HTTP 集成测试通过：preflight 200 返回 JSON（含错误不阻断），缺文件 400，');
    console.log('   非 PDF 400，损坏文件 422；同一份带错误报告的 PDF 仍可成功 /api/impose');
  } finally {
    server.close();
  }
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
