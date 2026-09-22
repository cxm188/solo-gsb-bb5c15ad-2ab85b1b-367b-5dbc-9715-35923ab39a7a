'use strict';

const path = require('path');
const express = require('express');
const multer = require('multer');
const { imposePdf, parseMaxSheetsPerSignature } = require('./lib/impose');
const { preflightPdf } = require('./lib/preflight');
const { diffPreflightReports } = require('./lib/preflight-diff');
const { buildPaperQuote } = require('./lib/quote');

const app = express();
const PORT = parseInt(process.env.PORT, 10) || 3000;
const MAX_FILE_SIZE = parseInt(process.env.MAX_FILE_SIZE_MB, 10) * 1024 * 1024
  || 50 * 1024 * 1024;

// 上传文件仅保留在内存中（拼版后直接返回，不写磁盘）
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_SIZE },
});

app.use(express.static(path.join(__dirname, 'public')));

// 报价接口仅接收拼版方案 + 纸张规格的 JSON（无文件上传）
app.use(express.json({ limit: '1mb' }));

app.get('/api/health', (req, res) => {
  res.json({ ok: true });
});

/**
 * 判断上传内容是否为 PDF：以 PDF 文件头魔数为准；部分浏览器以
 * application/octet-stream 上传时，回退校验文件名后缀。
 */
function looksLikePdf(file) {
  if (!file) return false;
  if (file.buffer.slice(0, 5).toString('latin1') === '%PDF-') return true;
  return (!file.mimetype || file.mimetype === 'application/octet-stream')
    && /\.pdf$/i.test(file.originalname || '');
}

function missingFileResponse(res) {
  return res.status(400).json({ error: '请通过字段 pdf 上传一个 PDF 文件' });
}

// 印前校验接口：仅逐页检查并返回 JSON 报告，不生成拼版文件。
// 报告中即便存在错误/警告也以 200 返回（校验结果本身），不阻断后续拼版。
app.post('/api/preflight', upload.single('pdf'), async (req, res) => {
  if (!req.file) return missingFileResponse(res);
  if (!looksLikePdf(req.file)) {
    return res.status(400).json({ error: '仅支持 PDF 文件' });
  }
  try {
    const report = await preflightPdf(req.file.buffer, {
      fileName: req.file.originalname,
      sizeBytes: req.file.size,
    });
    return res.json(report);
  } catch (err) {
    return res.status(422).json({
      error: `无法校验该 PDF：${err && err.message ? err.message : '未知错误'}`,
    });
  }
});

// 印前报告差异对比：分别上传基准 PDF 与待交付 PDF，复用逐页校验后按
// 「页码 + 问题代码」对齐，返回新增/已解决/仍存在问题及页数变化。
// 任一文件缺失或非 PDF 返回 400；任一 PDF 损坏/加密返回 422 并标明是哪一份。
const diffUpload = upload.fields([
  { name: 'baseline', maxCount: 1 },
  { name: 'delivery', maxCount: 1 },
]);

app.post('/api/preflight/diff', diffUpload, async (req, res) => {
  const files = req.files || {};
  const baselineFile = files.baseline && files.baseline[0];
  const deliveryFile = files.delivery && files.delivery[0];
  if (!baselineFile || !deliveryFile) {
    return res.status(400).json({
      error: '请通过字段 baseline（基准 PDF）与 delivery（待交付 PDF）各上传一个 PDF 文件',
    });
  }
  if (!looksLikePdf(baselineFile)) {
    return res.status(400).json({ error: '基准文件仅支持 PDF 格式' });
  }
  if (!looksLikePdf(deliveryFile)) {
    return res.status(400).json({ error: '待交付文件仅支持 PDF 格式' });
  }

  // 两份文件分别校验：损坏/加密时在错误信息中标明具体是哪一份，便于定位
  let baselineReport;
  let deliveryReport;
  try {
    baselineReport = await preflightPdf(baselineFile.buffer, {
      fileName: baselineFile.originalname,
      sizeBytes: baselineFile.size,
    });
  } catch (err) {
    return res.status(422).json({
      error: `基准 PDF 无法校验：${err && err.message ? err.message : '未知错误'}`,
    });
  }
  try {
    deliveryReport = await preflightPdf(deliveryFile.buffer, {
      fileName: deliveryFile.originalname,
      sizeBytes: deliveryFile.size,
    });
  } catch (err) {
    return res.status(422).json({
      error: `待交付 PDF 无法校验：${err && err.message ? err.message : '未知错误'}`,
    });
  }

  try {
    const diff = diffPreflightReports(baselineReport, deliveryReport);
    return res.json(diff);
  } catch (err) {
    return res.status(422).json({
      error: `差异对比失败：${err && err.message ? err.message : '未知错误'}`,
    });
  }
});

// 拼版接口：上传 PDF，返回拼版后的 PDF；拼版页序方案通过响应头回传
app.post('/api/impose', upload.single('pdf'), async (req, res) => {
  try {
    if (!req.file) {
      return missingFileResponse(res);
    }
    if (!looksLikePdf(req.file)) {
      return res.status(400).json({ error: '仅支持 PDF 文件' });
    }

    // 分册签帖模式：signatureMode=on 时启用；maxSheetsPerSignature 必须为 1～20 的整数
    const options = {};
    if (req.body && req.body.signatureMode === 'on') {
      try {
        options.maxSheetsPerSignature =
          parseMaxSheetsPerSignature(req.body.maxSheetsPerSignature);
      } catch (err) {
        return res.status(400).json({ error: err.message });
      }
    }

    const { pdfBytes, plan } = await imposePdf(req.file.buffer, options);

    // 页序方案为纯 ASCII JSON，放入自定义响应头供前端渲染预览
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'attachment; filename="booklet-imposed.pdf"');
    res.setHeader('X-Imposition-Plan', encodeURIComponent(JSON.stringify(plan)));
    res.setHeader('Access-Control-Expose-Headers', 'X-Imposition-Plan');
    return res.end(Buffer.from(pdfBytes));
  } catch (err) {
    const message = err && err.message ? err.message : '拼版失败';
    // 加密 PDF、损坏文件、超大文件等都返回 422，便于前端提示
    if (err && err.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({ error: `文件超过大小限制（${MAX_FILE_SIZE / 1024 / 1024}MB）` });
    }
    return res.status(422).json({ error: `无法处理该 PDF：${message}` });
  }
});

// 印刷用纸报价：根据拼版方案（统一面板/纸张数/分册签帖）与用户维护的
// 纸张规格，枚举每个纸张的原向与旋转 90°，选择可容纳版面的最低总价方案。
// 入参不合法返回 400；没有任何纸张可容纳时仍返回 200，结果中 feasible=false
// 并在 reason 中给出明确原因（属正常报价结果，便于前端直接展示）。
app.post('/api/quote', (req, res) => {
  const body = req.body;
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return res.status(400).json({ error: '请以 JSON body 提供拼版方案 plan 与纸张规格 papers' });
  }
  const { plan, papers } = body;
  if (!plan || typeof plan !== 'object') {
    return res.status(400).json({ error: '缺少拼版方案 plan（请使用拼版响应头 X-Imposition-Plan 的内容）' });
  }
  if (!Array.isArray(papers)) {
    return res.status(400).json({ error: '缺少纸张规格数组 papers（宽、高、单价、开机费）' });
  }
  try {
    const quote = buildPaperQuote(plan, papers);
    return res.json(quote);
  } catch (err) {
    return res.status(400).json({
      error: `报价参数无效：${err && err.message ? err.message : '未知错误'}`,
    });
  }
});

// JSON 解析错误等兜底
app.use((err, req, res, next) => {
  if (err && err.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({ error: `文件超过大小限制（${MAX_FILE_SIZE / 1024 / 1024}MB）` });
  }
  if (err && err.type === 'entity.too.large') {
    return res.status(413).json({ error: '请求体超过大小限制（1MB）' });
  }
  if (err && err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: '请求体不是合法的 JSON' });
  }
  return res.status(500).json({ error: '服务器内部错误' });
});

// 直接运行时启动服务；被测试代码 require 时不监听端口
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`小册子拼版应用已启动: http://localhost:${PORT}`);
  });
}

module.exports = { app };
