'use strict';

const fileInput = document.getElementById('file-input');
const dropzone = document.getElementById('dropzone');
const fileName = document.getElementById('file-name');
const imposeBtn = document.getElementById('impose-btn');
const preflightBtn = document.getElementById('preflight-btn');
const statusEl = document.getElementById('status');
const summaryEl = document.getElementById('summary');
const previewEl = document.getElementById('preview');
const sheetsEl = document.getElementById('sheets');
const downloadBtn = document.getElementById('download-btn');
const signatureModeInput = document.getElementById('signature-mode');
const maxSheetsField = document.getElementById('max-sheets-field');
const maxSheetsInput = document.getElementById('max-sheets');
const summaryListEl = document.getElementById('summary-list');
const signatureSummaryEl = document.getElementById('signature-summary');

const reportEl = document.getElementById('report');
const reportVerdictEl = document.getElementById('report-verdict');
const reportSummaryEl = document.getElementById('report-summary');
const issueListEl = document.getElementById('issue-list');
const reportEmptyEl = document.getElementById('report-empty');
const reportDownloadBtn = document.getElementById('report-download-btn');
const pageTableBody = document.getElementById('page-table-body');
const pageDetailCount = document.getElementById('page-detail-count');
const filterChips = document.querySelectorAll('.filter-chip');
const filterCountEls = document.querySelectorAll('.chip-count');

const MAX_SHEETS = 20;

let selectedFile = null;
let resultBlobUrl = null;
let resultBaseName = 'booklet';
let preflightReport = null;
let activeLevelFilter = 'all';

signatureModeInput.addEventListener('change', () => {
  maxSheetsField.hidden = !signatureModeInput.checked;
});

/**
 * 校验每帖最多纸张数：仅接受 1～20 的整数。
 * @returns {number|null} 合法时返回整数，非法时返回 null（并已设置错误提示）
 */
function readMaxSheets() {
  const raw = maxSheetsInput.value;
  if (!/^\s*\d+\s*$/.test(raw)) {
    setStatus(`请填写每帖最多纸张数（1～${MAX_SHEETS} 的整数）`, 'error');
    return null;
  }
  const value = Number(raw.trim());
  if (value < 1 || value > MAX_SHEETS) {
    setStatus(`每帖最多纸张数必须在 1～${MAX_SHEETS} 之间`, 'error');
    return null;
  }
  return value;
}

function setStatus(text, kind) {
  statusEl.textContent = text || '';
  statusEl.className = kind ? `status ${kind}` : 'status';
}

function clearResult() {
  if (resultBlobUrl) {
    URL.revokeObjectURL(resultBlobUrl);
    resultBlobUrl = null;
  }
  summaryEl.hidden = true;
  previewEl.hidden = true;
  sheetsEl.innerHTML = '';
  summaryListEl.innerHTML = '';
  signatureSummaryEl.hidden = true;
  signatureSummaryEl.innerHTML = '';
}

/**
 * 重新选择文件时清空上一份校验报告；报告 JSON 通过 Blob 下载。
 */
function clearReport() {
  preflightReport = null;
  reportEl.hidden = true;
  issueListEl.innerHTML = '';
  pageTableBody.innerHTML = '';
  reportSummaryEl.innerHTML = '';
  reportVerdictEl.textContent = '';
  activeLevelFilter = 'all';
  updateFilterChips();
}

function selectFile(file) {
  clearResult();
  clearReport();
  if (!file) {
    selectedFile = null;
    fileName.textContent = '';
    imposeBtn.disabled = true;
    preflightBtn.disabled = true;
    return;
  }
  if (file.type && file.type !== 'application/pdf') {
    setStatus('请选择 PDF 文件', 'error');
    return;
  }
  selectedFile = file;
  fileName.textContent = file.name;
  resultBaseName = (file.name || 'booklet').replace(/\.pdf$/i, '');
  imposeBtn.disabled = false;
  preflightBtn.disabled = false;
  setStatus(`已选择：${file.name}（${(file.size / 1024 / 1024).toFixed(2)} MB）`, 'info');
}

// ---------- 印前校验 ----------

const SEVERITY_LABELS = { error: '错误', warning: '警告', info: '提示' };

function formatRange(issue) {
  if (issue.pageFrom === null || issue.pageTo === null) return '整篇文档';
  return issue.pageFrom === issue.pageTo
    ? `第 ${issue.pageFrom} 页`
    : `第 ${issue.pageFrom}～${issue.pageTo} 页`;
}

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

preflightBtn.addEventListener('click', async () => {
  if (!selectedFile) return;
  preflightBtn.disabled = true;
  imposeBtn.disabled = true;
  setStatus('正在执行印前校验，不会生成拼版文件…', 'info');

  const form = new FormData();
  form.append('pdf', selectedFile);

  try {
    const resp = await fetch('/api/preflight', { method: 'POST', body: form });
    if (!resp.ok) {
      let message = `校验失败（HTTP ${resp.status}）`;
      try {
        const data = await resp.json();
        if (data && data.error) message = data.error;
      } catch (_) { /* 非 JSON 错误响应，使用默认提示 */ }
      throw new Error(message);
    }
    preflightReport = await resp.json();
    renderReport(preflightReport);
    const { summary } = preflightReport;
    if (summary.error > 0) {
      setStatus(`校验完成：发现 ${summary.error} 个错误、${summary.warning} 个警告、`
        + `${summary.info} 个提示。仍可继续拼版，请先评估错误项。`, 'error');
    } else if (summary.warning > 0 || summary.info > 0) {
      setStatus(`校验完成：${summary.warning} 个警告、${summary.info} 个提示，不影响继续拼版。`, 'info');
    } else {
      setStatus('校验完成：未发现印前问题，可以直接拼版。', 'info');
    }
  } catch (err) {
    setStatus(err.message || '印前校验失败', 'error');
  } finally {
    preflightBtn.disabled = false;
    imposeBtn.disabled = false;
  }
});

function renderReport(report) {
  reportEl.hidden = false;

  const { summary, referenceSize } = report;
  reportVerdictEl.className = `report-verdict ${summary.passed ? 'ok' : 'bad'}`;
  reportVerdictEl.textContent = summary.passed
    ? `结论：未发现错误级问题（${report.pageCount} 页；主尺寸 ${referenceSize.widthMm} × `
      + `${referenceSize.heightMm} mm）。警告/提示可选择性处理，拼版不受阻断。`
    : `结论：发现 ${summary.error} 个错误级问题（${report.pageCount} 页；主尺寸 `
      + `${referenceSize.widthMm} × ${referenceSize.heightMm} mm）。建议修复后再印刷，`
      + '但仍可继续拼版。';

  renderReportSummary(summary);
  renderIssueList(report.issues);
  renderPageTable(report.pages);

  filterCountEls.forEach((el) => {
    const level = el.dataset.count;
    el.textContent = level === 'all' ? report.issues.length : summary[level];
  });
}

function renderReportSummary(summary) {
  reportSummaryEl.innerHTML = '';
  const cards = [
    { level: 'error', label: '错误', count: summary.error },
    { level: 'warning', label: '警告', count: summary.warning },
    { level: 'info', label: '提示', count: summary.info },
    { level: 'pages', label: '涉及页面', count: summary.pagesWithIssues },
  ];
  for (const card of cards) {
    const div = document.createElement('div');
    div.className = `report-stat ${card.level}`;
    div.innerHTML = `<span class="stat-num">${card.count}</span>`
      + `<span class="stat-label">${card.label}</span>`;
    reportSummaryEl.appendChild(div);
  }
}

function updateFilterChips() {
  filterChips.forEach((chip) => {
    chip.classList.toggle('active', chip.dataset.level === activeLevelFilter);
  });
}

filterChips.forEach((chip) => {
  chip.addEventListener('click', () => {
    activeLevelFilter = chip.dataset.level;
    updateFilterChips();
    if (preflightReport) renderIssueList(preflightReport.issues);
  });
});

function renderIssueList(issues) {
  issueListEl.innerHTML = '';
  const visible = activeLevelFilter === 'all'
    ? issues
    : issues.filter((issue) => issue.severity === activeLevelFilter);

  reportEmptyEl.hidden = visible.length !== 0;

  for (const issue of visible) {
    const li = document.createElement('li');
    li.className = `issue ${issue.severity}`;

    const head = document.createElement('div');
    head.className = 'issue-head';
    const badge = document.createElement('span');
    badge.className = `severity-badge ${issue.severity}`;
    badge.textContent = SEVERITY_LABELS[issue.severity];
    const title = document.createElement('span');
    title.className = 'issue-title';
    title.textContent = issue.title;
    const range = document.createElement('span');
    range.className = 'issue-range';
    range.textContent = formatRange(issue)
      + (issue.pageCount > 1 ? `（连续 ${issue.pageCount} 页）` : '');
    head.append(badge, title, range);
    li.appendChild(head);

    const message = document.createElement('p');
    message.className = 'issue-message';
    message.textContent = issue.message;
    li.appendChild(message);

    if (issue.values && issue.values.length) {
      const dl = document.createElement('dl');
      dl.className = 'issue-values';
      for (const value of issue.values) {
        const dt = document.createElement('dt');
        dt.textContent = value.label;
        const dd = document.createElement('dd');
        dd.textContent = value.value;
        dl.append(dt, dd);
      }
      li.appendChild(dl);
    }

    const advice = document.createElement('p');
    advice.className = 'issue-advice';
    advice.innerHTML = `<strong>修复建议：</strong>${escapeHtml(issue.advice)}`;
    li.appendChild(advice);

    issueListEl.appendChild(li);
  }
}

function renderPageTable(pages) {
  pageTableBody.innerHTML = '';
  pageDetailCount.textContent = String(pages.length);
  const frag = document.createDocumentFragment();
  for (const p of pages) {
    const tr = document.createElement('tr');
    tr.className = p.issues.length ? 'has-issue' : 'clean';
    const issueText = p.issues.length
      ? p.issues.map((i) => SEVERITY_LABELS[i.severity] + '·' + i.title).join('；')
      : '—';
    tr.innerHTML = `<td>第 ${p.page} 页</td>`
      + `<td>${p.effectiveWidth.toFixed(1)} × ${p.effectiveHeight.toFixed(1)} pt`
      + `（${p.widthMm} × ${p.heightMm} mm）</td>`
      + `<td>${p.rotation}°</td>`
      + `<td>${p.transparent ? '是' : '否'}</td>`
      + `<td>${p.textExtractable === null ? '无法判定' : (p.textExtractable ? '可提取' : '不可提取')}</td>`
      + `<td class="page-issues">${escapeHtml(issueText)}</td>`;
    frag.appendChild(tr);
  }
  pageTableBody.appendChild(frag);
}

reportDownloadBtn.addEventListener('click', () => {
  if (!preflightReport) return;
  const json = JSON.stringify(preflightReport, null, 2);
  const blob = new Blob([json], { type: 'application/json;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${resultBaseName}-印前校验报告.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});

fileInput.addEventListener('change', () => {
  const file = fileInput.files && fileInput.files[0];
  selectFile(file);
});

['dragenter', 'dragover'].forEach((evt) => {
  dropzone.addEventListener(evt, (e) => {
    e.preventDefault();
    dropzone.classList.add('dragover');
  });
});
['dragleave', 'drop'].forEach((evt) => {
  dropzone.addEventListener(evt, (e) => {
    e.preventDefault();
    dropzone.classList.remove('dragover');
  });
});
dropzone.addEventListener('drop', (e) => {
  const file = e.dataTransfer.files && e.dataTransfer.files[0];
  selectFile(file);
});

imposeBtn.addEventListener('click', async () => {
  if (!selectedFile) return;

  const useSignatures = signatureModeInput.checked;
  let maxSheets = null;
  if (useSignatures) {
    maxSheets = readMaxSheets();
    if (maxSheets === null) return;
  }

  imposeBtn.disabled = true;
  setStatus('正在拼版，请稍候…', 'info');
  clearResult();

  const form = new FormData();
  form.append('pdf', selectedFile);
  if (useSignatures) {
    form.append('signatureMode', 'on');
    form.append('maxSheetsPerSignature', String(maxSheets));
  }

  try {
    const resp = await fetch('/api/impose', { method: 'POST', body: form });

    if (!resp.ok) {
      let message = `拼版失败（HTTP ${resp.status}）`;
      try {
        const data = await resp.json();
        if (data && data.error) message = data.error;
      } catch (_) { /* 非 JSON 错误响应，使用默认提示 */ }
      throw new Error(message);
    }

    const planHeader = resp.headers.get('X-Imposition-Plan');
    if (!planHeader) throw new Error('响应缺少拼版方案');
    const plan = JSON.parse(decodeURIComponent(planHeader));

    const blob = await resp.blob();
    resultBlobUrl = URL.createObjectURL(blob);

    renderSummary(plan);
    renderPreview(plan);
    setStatus('拼版完成，可预览页序或下载 PDF。', 'info');
  } catch (err) {
    setStatus(err.message || '拼版失败', 'error');
  } finally {
    imposeBtn.disabled = false;
  }
});

downloadBtn.addEventListener('click', () => {
  if (!resultBlobUrl) return;
  const a = document.createElement('a');
  a.href = resultBlobUrl;
  a.download = `${resultBaseName}-拼版.pdf`;
  document.body.appendChild(a);
  a.click();
  a.remove();
});

const ORIENTATION_LABELS = {
  portrait: '竖版',
  landscape: '横版',
  square: '方形',
};

function ptToMm(pt) {
  return ((pt * 25.4) / 72).toFixed(1);
}

function appendSummaryItem(label, value) {
  const li = document.createElement('li');
  const strong = document.createElement('strong');
  strong.textContent = value;
  li.append(`${label}：`, strong);
  summaryListEl.appendChild(li);
}

function renderSummary(plan) {
  const sheetCount = plan.signatureMode ? plan.sheetCount : plan.sheets.length;
  appendSummaryItem('原始页数', `${plan.sourceCount} 页`);
  appendSummaryItem('末尾补白', `${plan.paddedCount} 页`);
  if (plan.signatureMode) {
    appendSummaryItem(
      '签帖数量',
      `${plan.signatureCount} 帖（每帖最多 ${plan.maxSheetsPerSignature} 张纸）`,
    );
  }
  appendSummaryItem('用纸数量', `${sheetCount} 张（每张正反 4 页）`);
  if (plan.panel) {
    const { width, height, orientation } = plan.panel;
    appendSummaryItem(
      '统一面板',
      `${width.toFixed(1)} × ${height.toFixed(1)} pt（约 ${ptToMm(width)} × ${ptToMm(height)} mm）`,
    );
    appendSummaryItem('页面方向', ORIENTATION_LABELS[orientation] || orientation);
  }

  if (plan.signatureMode) {
    renderSignatureSummary(plan);
  }
  summaryEl.hidden = false;
}

function renderSignatureSummary(plan) {
  const wrap = document.createElement('div');

  const hint = document.createElement('p');
  hint.className = 'signature-hint';
  hint.textContent = `按原页序切分为 ${plan.signatureCount} 帖，各帖仅在帖末补白；`
    + '结果 PDF 按帖号顺序连续输出，下载仍为一个文件。';
  wrap.appendChild(hint);

  const table = document.createElement('table');
  table.className = 'signature-table';
  const thead = document.createElement('thead');
  thead.innerHTML = '<tr>'
    + '<th>帖号</th><th>原始页范围</th><th>原始页数</th>'
    + '<th>帖末补白</th><th>帖内纸张编号</th><th>用纸</th>'
    + '</tr>';
  table.appendChild(thead);

  const tbody = document.createElement('tbody');
  for (const sig of plan.signatures) {
    const tr = document.createElement('tr');
    const range = sig.sourceCount === 1
      ? `第 ${sig.startPage} 页`
      : `第 ${sig.startPage} ～ ${sig.endPage} 页`;
    const sheetNums = sig.sheets.map((s) => s.sheet).join(', ');
    tr.innerHTML = `<td>第 ${sig.signature} 帖</td>`
      + `<td>${range}</td>`
      + `<td>${sig.sourceCount} 页</td>`
      + `<td>${sig.blanks} 页</td>`
      + `<td class="sheet-nums">第 ${sheetNums} 张</td>`
      + `<td>${sig.sheets.length} 张</td>`;
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  wrap.appendChild(table);

  signatureSummaryEl.innerHTML = '';
  signatureSummaryEl.appendChild(wrap);
  signatureSummaryEl.hidden = false;
}

/**
 * 统一遍历方案中的纸张：整册模式直接遍历 plan.sheets；
 * 签帖模式按帖序遍历，并在每帖前插入帖标题分组。
 */
function forEachSheet(plan, callbacks) {
  if (plan.signatureMode) {
    for (const sig of plan.signatures) {
      callbacks.onSignature(sig);
      for (const sheet of sig.sheets) {
        callbacks.onSheet(sheet, sig);
      }
    }
  } else {
    for (const sheet of plan.sheets) {
      callbacks.onSheet(sheet, null);
    }
  }
}

function renderPreview(plan) {
  const frag = document.createDocumentFragment();
  // 预览按真实纸张比例渲染：宽 = 2 × 面板宽，高 = 面板高
  const sheetRatio = plan.panel && plan.panel.height > 0
    ? (2 * plan.panel.width) / plan.panel.height
    : 2;

  forEachSheet(plan, {
    onSignature(sig) {
      const group = document.createElement('div');
      group.className = 'signature-group';
      const range = sig.sourceCount === 1
        ? `第 ${sig.startPage} 页`
        : `第 ${sig.startPage} ～ ${sig.endPage} 页`;
      group.textContent = `第 ${sig.signature} 帖 · 原始页 ${range} · 帖末补白 ${sig.blanks} 页`
        + ` · 用纸 ${sig.sheets.length} 张`;
      frag.appendChild(group);
    },
    onSheet(sheet, sig) {
      const card = document.createElement('div');
      card.className = 'sheet';

      const title = document.createElement('div');
      title.className = 'sheet-title';
      if (sig) {
        title.textContent = `第 ${sig.signature} 帖 · 帖内第 ${sheet.sheet} 张纸 / 共 ${sig.sheets.length} 张`;
      } else {
        title.textContent = `第 ${sheet.sheet} 张纸 / 共 ${plan.sheets.length} 张`;
      }
      card.appendChild(title);

      card.appendChild(buildSide('正面', sheet.front, false, sheetRatio));
      card.appendChild(buildSide('背面', sheet.back, true, sheetRatio));

      frag.appendChild(card);
    },
  });
  sheetsEl.appendChild(frag);
  previewEl.hidden = false;
}

function buildSide(labelText, side, isBack, sheetRatio) {
  const sideEl = document.createElement('div');
  sideEl.className = 'side';

  const label = document.createElement('span');
  label.className = isBack ? 'side-label back' : 'side-label';
  label.textContent = labelText;
  sideEl.appendChild(label);

  const spread = document.createElement('div');
  spread.className = 'spread';
  spread.style.aspectRatio = String(sheetRatio);
  spread.appendChild(buildPanel(side.left, 'left'));
  spread.appendChild(buildPanel(side.right, 'right'));

  sideEl.appendChild(spread);
  return sideEl;
}

function buildPanel(slot, position) {
  const panel = document.createElement('div');
  panel.className = slot.blank ? 'panel blank' : 'panel';

  const pos = document.createElement('span');
  pos.className = `pos ${position}`;
  pos.textContent = position === 'left' ? '左' : '右';
  panel.appendChild(pos);

  if (slot.blank) {
    const tag = document.createElement('span');
    tag.className = 'blank-tag';
    tag.textContent = '空白页';
    panel.appendChild(tag);
  } else {
    const num = document.createElement('span');
    num.textContent = `第 ${slot.page} 页`;
    panel.appendChild(num);
  }
  return panel;
}

// ---------- 印前报告差异对比 ----------

const diffBaselineInput = document.getElementById('diff-baseline-input');
const diffDeliveryInput = document.getElementById('diff-delivery-input');
const diffBaselineName = document.getElementById('diff-baseline-name');
const diffDeliveryName = document.getElementById('diff-delivery-name');
const diffBtn = document.getElementById('diff-btn');
const diffStatusEl = document.getElementById('diff-status');
const diffReportEl = document.getElementById('diff-report');
const diffVerdictEl = document.getElementById('diff-verdict');
const diffMetaEl = document.getElementById('diff-meta');
const diffSummaryEl = document.getElementById('diff-summary');
const diffIssueListEl = document.getElementById('diff-issue-list');
const diffIssueEmptyEl = document.getElementById('diff-issue-empty');
const diffPageTableBody = document.getElementById('diff-page-table-body');
const diffPageCount = document.getElementById('diff-page-count');
const diffDownloadBtn = document.getElementById('diff-download-btn');
const diffFilterChips = document.querySelectorAll('.diff-filter-chip');

const DIFF_GROUP_LABELS = { added: '新增问题', resolved: '已解决', persistent: '仍存在' };
const DIFF_STATUS_LABELS = { added: '新增页', removed: '移除页', retained: '保留页' };

let diffBaselineFile = null;
let diffDeliveryFile = null;
let diffReportData = null;
let activeDiffGroup = 'added';

function setDiffStatus(text, kind) {
  diffStatusEl.textContent = text || '';
  diffStatusEl.className = kind ? `status ${kind}` : 'status';
}

function updateDiffButton() {
  diffBtn.disabled = !diffBaselineFile || !diffDeliveryFile;
}

/**
 * 重新选择任一对比文件时清空上一次差异结果。
 */
function clearDiffReport() {
  diffReportData = null;
  diffReportEl.hidden = true;
  diffIssueListEl.innerHTML = '';
  diffPageTableBody.innerHTML = '';
  diffSummaryEl.innerHTML = '';
  diffMetaEl.innerHTML = '';
  diffVerdictEl.textContent = '';
}

function pickDiffFile(input, nameEl, which) {
  const file = input.files && input.files[0];
  clearDiffReport();
  if (!file) {
    if (which === 'baseline') {
      diffBaselineFile = null;
      nameEl.textContent = '点击选择基准 PDF';
    } else {
      diffDeliveryFile = null;
      nameEl.textContent = '点击选择待交付 PDF';
    }
    updateDiffButton();
    return;
  }
  if (file.type && file.type !== 'application/pdf' && !/\.pdf$/i.test(file.name)) {
    setDiffStatus('请选择 PDF 文件', 'error');
    input.value = '';
    return;
  }
  if (which === 'baseline') {
    diffBaselineFile = file;
  } else {
    diffDeliveryFile = file;
  }
  nameEl.textContent = `${file.name}（${(file.size / 1024 / 1024).toFixed(2)} MB）`;
  setDiffStatus('', '');
  updateDiffButton();
}

diffBaselineInput.addEventListener('change', () => {
  pickDiffFile(diffBaselineInput, diffBaselineName, 'baseline');
});
diffDeliveryInput.addEventListener('change', () => {
  pickDiffFile(diffDeliveryInput, diffDeliveryName, 'delivery');
});

diffBtn.addEventListener('click', async () => {
  if (!diffBaselineFile || !diffDeliveryFile) return;
  diffBtn.disabled = true;
  setDiffStatus('正在分别校验两份 PDF 并生成差异对比…', 'info');

  const form = new FormData();
  form.append('baseline', diffBaselineFile);
  form.append('delivery', diffDeliveryFile);

  try {
    const resp = await fetch('/api/preflight/diff', { method: 'POST', body: form });
    if (!resp.ok) {
      let message = `差异对比失败（HTTP ${resp.status}）`;
      try {
        const data = await resp.json();
        if (data && data.error) message = data.error;
      } catch (_) { /* 非 JSON 错误响应，使用默认提示 */ }
      throw new Error(message);
    }
    diffReportData = await resp.json();
    activeDiffGroup = 'added';
    updateDiffFilterChips();
    renderDiffReport(diffReportData);
    const { summary } = diffReportData;
    if (summary.added.total > 0) {
      setDiffStatus(`对比完成：新增 ${summary.added.total} 项、已解决 ${summary.resolved.total} 项、`
        + `仍存在 ${summary.persistent.total} 项问题（按页计；文档级问题各计 1 项）。`, 'error');
    } else if (summary.persistent.total > 0) {
      setDiffStatus(`对比完成：无新增问题；已解决 ${summary.resolved.total} 项，`
        + `仍有 ${summary.persistent.total} 项问题存在。`, 'info');
    } else {
      setDiffStatus('对比完成：基准中的问题已全部解决，且未引入新问题。', 'info');
    }
  } catch (err) {
    clearDiffReport();
    setDiffStatus(err.message || '差异对比失败', 'error');
  } finally {
    diffBtn.disabled = false;
  }
});

function renderDiffMeta(data) {
  const { baseline, delivery, pageCount } = data;
  const deltaText = pageCount.delta === 0
    ? '页数一致'
    : (pageCount.delta > 0
      ? `增加 ${pageCount.delta} 页`
      : `减少 ${Math.abs(pageCount.delta)} 页`);
  const fileLine = (label, info) => {
    const name = info.file && info.file.name ? info.file.name : '未命名 PDF';
    return `<div class="diff-meta-item"><span class="diff-meta-label">${label}</span>`
      + `<span class="diff-meta-value">${escapeHtml(name)} · ${info.pageCount} 页</span></div>`;
  };
  diffMetaEl.innerHTML = fileLine('基准 PDF', baseline)
    + fileLine('待交付 PDF', delivery)
    + `<div class="diff-meta-item"><span class="diff-meta-label">页数变化</span>`
    + `<span class="diff-meta-value">${baseline.pageCount} → ${delivery.pageCount} 页（${deltaText}）`
    + `，新增页 ${pageCount.addedPages.length} / 移除页 ${pageCount.removedPages.length}</span></div>`;
}

function renderDiffSummary(data) {
  diffSummaryEl.innerHTML = '';
  const { summary } = data;
  const cards = [
    { level: 'error', label: '新增问题', count: summary.added.total },
    { level: 'ok', label: '已解决', count: summary.resolved.total },
    { level: 'warning', label: '仍存在', count: summary.persistent.total },
    { level: 'pages', label: '页数变化', count: data.pageCount.delta, signed: true },
  ];
  for (const card of cards) {
    const div = document.createElement('div');
    div.className = `report-stat ${card.level}`;
    const numText = card.signed && card.count > 0 ? `+${card.count}` : String(card.count);
    div.innerHTML = `<span class="stat-num">${numText}</span>`
      + `<span class="stat-label">${card.label}</span>`;
    diffSummaryEl.appendChild(div);
  }
}

function renderDiffVerdict(data) {
  const addedErrors = countSeverity(data.added, 'error');
  const resolvedErrors = countSeverity(data.resolved, 'error');
  const persistentErrors = countSeverity(data.persistent, 'error');
  diffVerdictEl.className = 'report-verdict '
    + (addedErrors > 0 || persistentErrors > 0 ? 'bad' : 'ok');
  diffVerdictEl.textContent = addedErrors > 0
    ? `结论：待交付版本引入了 ${addedErrors} 个错误级问题（仍存在错误 ${persistentErrors} 个，`
      + `已解决错误 ${resolvedErrors} 个），建议修复后再交付。`
    : (persistentErrors > 0
      ? `结论：未引入新的错误级问题；仍有 ${persistentErrors} 个错误级问题未解决`
        + `（已解决 ${resolvedErrors} 个），请确认后交付。`
      : `结论：待交付版本无错误级问题（已解决 ${resolvedErrors} 个错误，无残留错误）。`);
}

function countSeverity(entries, severity) {
  return entries
    .filter((entry) => entry.severity === severity)
    .reduce((sum, entry) => sum + (entry.documentLevel ? 1 : entry.pages.length), 0);
}

function updateDiffFilterChips() {
  diffFilterChips.forEach((chip) => {
    chip.classList.toggle('active', chip.dataset.group === activeDiffGroup);
  });
}

diffFilterChips.forEach((chip) => {
  chip.addEventListener('click', () => {
    activeDiffGroup = chip.dataset.group;
    updateDiffFilterChips();
    if (diffReportData) renderDiffIssueList(diffReportData);
  });
});

function formatDiffPageList(pages) {
  if (!pages.length) return '—';
  return pages.map((p) => `第 ${p} 页`).join('、');
}

function renderDiffIssueList(data) {
  diffIssueListEl.innerHTML = '';
  const groups = { added: data.added, resolved: data.resolved, persistent: data.persistent };
  const entries = groups[activeDiffGroup];

  diffIssueEmptyEl.hidden = entries.length !== 0;
  diffIssueEmptyEl.textContent = entries.length === 0
    ? {
      added: '未发现新增问题：待交付版本没有引入新的印前问题。',
      resolved: '没有已解决的问题：基准中的问题在待交付版本中依然存在（或基准本无问题）。',
      persistent: '没有仍存在的问题：两个版本未在相同页码/文档级上同时命中同一问题。',
    }[activeDiffGroup]
    : '';

  for (const entry of entries) {
    const li = document.createElement('li');
    li.className = `issue ${entry.severity} diff-${activeDiffGroup}`;

    const head = document.createElement('div');
    head.className = 'issue-head';
    const typeBadge = document.createElement('span');
    typeBadge.className = `diff-tag ${activeDiffGroup}`;
    typeBadge.textContent = DIFF_GROUP_LABELS[activeDiffGroup];
    const severityBadge = document.createElement('span');
    severityBadge.className = `severity-badge ${entry.severity}`;
    severityBadge.textContent = SEVERITY_LABELS[entry.severity];
    const title = document.createElement('span');
    title.className = 'issue-title';
    title.textContent = entry.title;
    const range = document.createElement('span');
    range.className = 'issue-range';
    range.textContent = entry.documentLevel
      ? '整篇文档'
      : `${formatDiffPageList(entry.pages)}（${entry.pages.length} 页）`;
    head.append(typeBadge, severityBadge, title, range);
    li.appendChild(head);

    const dl = document.createElement('dl');
    dl.className = 'issue-values';
    const appendValue = (label, value) => {
      const dt = document.createElement('dt');
      dt.textContent = label;
      const dd = document.createElement('dd');
      dd.textContent = value || '—';
      dl.append(dt, dd);
    };
    if (entry.documentLevel) {
      appendValue('基准说明', entry.baselineDetail);
      appendValue('待交付说明', entry.deliveryDetail);
      if (activeDiffGroup === 'persistent' && entry.detailChanged) {
        const note = document.createElement('p');
        note.className = 'diff-detail-changed';
        note.textContent = '问题仍存在，但检测值已发生变化，见上。';
        li.appendChild(note);
      }
    } else {
      const detailText = (items) => items.length
        ? items.map((d) => `第 ${d.page} 页：${d.detail || '存在'}`).join('；')
        : '';
      if (activeDiffGroup === 'added') {
        appendValue('待交付检测值', detailText(entry.deliveryDetails));
      } else if (activeDiffGroup === 'resolved') {
        appendValue('基准检测值', detailText(entry.baselineDetails));
      } else {
        appendValue('基准检测值', detailText(entry.baselineDetails));
        appendValue('待交付检测值', detailText(entry.deliveryDetails));
        if (entry.detailChangedPages.length) {
          const note = document.createElement('p');
          note.className = 'diff-detail-changed';
          note.textContent = `检测值变化：${formatDiffPageList(entry.detailChangedPages)}`;
          li.appendChild(note);
        }
      }
    }
    li.appendChild(dl);

    if (entry.advice) {
      const advice = document.createElement('p');
      advice.className = 'issue-advice';
      advice.innerHTML = `<strong>修复建议：</strong>${escapeHtml(entry.advice)}`;
      li.appendChild(advice);
    }

    diffIssueListEl.appendChild(li);
  }
}

function metricCell(record) {
  if (!record) return '—';
  const text = record.textExtractable === null
    ? '无法判定'
    : (record.textExtractable ? '可提取' : '不可提取');
  return `${record.mediaWidth} × ${record.mediaHeight} pt`
    + ` / ${record.rotation}° / ${record.transparent ? '透明' : '不透明'} / ${text}`;
}

function changeMarks(changes) {
  if (!changes) return '';
  const marks = [];
  if (changes.sizeChanged) marks.push('尺寸变化');
  if (changes.rotationChanged) marks.push('旋转变化');
  if (changes.transparencyChanged) marks.push('透明度变化');
  if (changes.textChanged) marks.push('文字可提取性变化');
  return marks.length
    ? `<span class="diff-change-marks">${marks.map(escapeHtml).join('、')}</span>`
    : '';
}

function issueCodeChips(codes, group, codeTitles) {
  if (!codes.length) return '—';
  return codes
    .map((code) => `<span class="diff-code-chip ${group}">${escapeHtml(codeTitles[code] || code)}</span>`)
    .join(' ');
}

function renderDiffPageTable(data) {
  diffPageTableBody.innerHTML = '';
  diffPageCount.textContent = String(data.pages.length);

  // 代码 -> 标题，取自三个分组中的条目（兜底直接显示代码）
  const codeTitles = {};
  for (const group of ['added', 'resolved', 'persistent']) {
    for (const entry of data[group]) codeTitles[entry.code] = entry.title;
  }

  const frag = document.createDocumentFragment();
  for (const row of data.pages) {
    const tr = document.createElement('tr');
    tr.className = `diff-page-${row.status}`;
    const statusText = DIFF_STATUS_LABELS[row.status];
    const metrics = row.status === 'retained'
      ? `${metricCell(row.baseline)} → ${metricCell(row.delivery)}`
      : (row.baseline ? metricCell(row.baseline) : metricCell(row.delivery));
    tr.innerHTML = `<td>第 ${row.page} 页</td>`
      + `<td><span class="diff-page-status ${row.status}">${statusText}</span></td>`
      + `<td>${escapeHtml(metrics)} ${changeMarks(row.changes)}</td>`
      + `<td>${issueCodeChips(row.issues.added, 'added', codeTitles)}</td>`
      + `<td>${issueCodeChips(row.issues.resolved, 'resolved', codeTitles)}</td>`
      + `<td>${issueCodeChips(row.issues.persistent, 'persistent', codeTitles)}</td>`;
    frag.appendChild(tr);
  }
  diffPageTableBody.appendChild(frag);
}

function renderDiffReport(data) {
  renderDiffVerdict(data);
  renderDiffMeta(data);
  renderDiffSummary(data);
  document.getElementById('diff-count-added').textContent = String(data.added.length);
  document.getElementById('diff-count-resolved').textContent = String(data.resolved.length);
  document.getElementById('diff-count-persistent').textContent = String(data.persistent.length);
  renderDiffIssueList(data);
  renderDiffPageTable(data);
  diffReportEl.hidden = false;
}

diffDownloadBtn.addEventListener('click', () => {
  if (!diffReportData) return;
  const json = JSON.stringify(diffReportData, null, 2);
  const blob = new Blob([json], { type: 'application/json;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = '印前报告差异对比.json';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});
