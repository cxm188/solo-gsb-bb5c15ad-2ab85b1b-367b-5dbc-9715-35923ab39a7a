'use strict';

/**
 * 印刷用纸报价核心。
 *
 * 用户维护最多 MAX_PAPER_SPECS（8）种纸张规格（宽 mm、高 mm、每张单价、
 * 每次开机费）。报价依据拼版计划的统一面板尺寸（每张拼版纸 = 2 × 面板宽 ×
 * 面板高）、全册总用纸张数与分册签帖数：
 *
 *   - 对每种纸张枚举「按原方向」与「旋转 90°」两种放置方向，任一方向能容纳
 *     版面即为可用；两种方向都能放下时优先按原方向（利用率相同，面积与方向无关）；
 *   - 有效利用率 = 拼版纸面面积 / 纸张面积（每张纸相同，故不随张数变化）；
 *   - 纸张费 = 单价（元/张）× 总用纸张数；
 *   - 开机费 = 开机费（元/次）× 开机次数；分册签帖模式下每个签帖需单独
 *     上机折订，开机次数 = 签帖数；整册拼版开机次数 = 1；
 *   - 在所有可容纳版面的纸张中选择总价最低者（同分按利用率、纸号兜底排序）；
 *   - 没有任何纸张能容纳时，feasible=false 并逐纸给出放不下的明确原因。
 */

const MM_TO_PT = 72 / 25.4;
const PT_TO_MM = 25.4 / 72;

/** 最多维护的纸张规格数量 */
const MAX_PAPER_SPECS = 8;

/**
 * 尺寸容纳判定容差（pt，约 0.018mm）：
 * 面板尺寸以 pt 给出、纸张以 mm 给出，换算后允许极小浮点误差。
 */
const FIT_TOLERANCE_PT = 0.05;

/** 纸张尺寸合理输入范围（mm），用于拦截明显的单位/手滑错误 */
const MIN_PAPER_MM = 1;
const MAX_PAPER_MM = 10000;
/** 费用合理输入范围（元） */
const MAX_PRICE = 1e8;
/** 张数 / 签帖数上限（防御性校验） */
const MAX_COUNT = 1e6;

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

/**
 * @param {number} value
 * @param {number} digits
 * @returns {number}
 */
function roundTo(value, digits) {
  const factor = 10 ** digits;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

function mmToPt(mm) {
  return mm * MM_TO_PT;
}

function ptToMm(pt) {
  return pt * PT_TO_MM;
}

/**
 * 读取一个必填的正数（毫米）字段。
 * @param {*} value
 * @param {string} label 错误信息中的字段中文名
 * @returns {number}
 */
function parsePositiveMm(value, label) {
  if (!isFiniteNumber(value)) {
    throw new Error(`${label}必须是大于 0 的数字（单位 mm）`);
  }
  if (value <= 0) {
    throw new Error(`${label}必须大于 0（单位 mm）`);
  }
  if (value < MIN_PAPER_MM || value > MAX_PAPER_MM) {
    throw new Error(`${label}超出允许范围（${MIN_PAPER_MM}～${MAX_PAPER_MM} mm）`);
  }
  return value;
}

/**
 * 读取一个必填的非负费用字段。
 * @param {*} value
 * @param {string} label
 * @returns {number}
 */
function parsePrice(value, label) {
  if (!isFiniteNumber(value)) {
    throw new Error(`${label}必须是不小于 0 的数字（单位：元）`);
  }
  if (value < 0) {
    throw new Error(`${label}不能为负数`);
  }
  if (value > MAX_PRICE) {
    throw new Error(`${label}超出允许范围（0～${MAX_PRICE} 元）`);
  }
  return value;
}

/**
 * 读取可选正整数字段，缺省时返回默认值。
 * @param {*} value
 * @param {string} label
 * @param {number} defaultValue
 * @returns {number}
 */
function parsePositiveInteger(value, label, defaultValue) {
  if (value === undefined || value === null) {
    if (defaultValue === undefined) {
      throw new Error(`缺少必填字段 ${label}`);
    }
    return defaultValue;
  }
  if (!isFiniteNumber(value) || !Number.isInteger(value) || value < 1) {
    throw new Error(`${label}必须是不小于 1 的整数`);
  }
  if (value > MAX_COUNT) {
    throw new Error(`${label}超出允许范围（1～${MAX_COUNT}）`);
  }
  return value;
}

/**
 * 规范化纸张名称：缺省时用「纸张 N」兜底，去除首尾空白并限制长度。
 * @param {*} value
 * @param {number} index 0 基序号
 * @returns {string}
 */
function normalizePaperName(value, index) {
  const fallback = `纸张 ${index + 1}`;
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'string') {
    throw new Error(`第 ${index + 1} 种纸张的名称必须是字符串`);
  }
  const name = value.trim();
  if (!name) return fallback;
  return name.length > 40 ? name.slice(0, 40) : name;
}

/**
 * 解析并校验报价请求中的纸张规格列表。
 *
 * @param {*} raw 请求 body.papers
 * @returns {Array<{
 *   paperId: number, name: string,
 *   widthMm: number, heightMm: number,
 *   pricePerSheet: number, setupFee: number
 * }>}
 */
function parsePapers(raw) {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new Error(`papers 必须为非空数组：至少维护 1 种纸张，最多 ${MAX_PAPER_SPECS} 种`);
  }
  if (raw.length > MAX_PAPER_SPECS) {
    throw new Error(`纸张规格最多 ${MAX_PAPER_SPECS} 种（当前 ${raw.length} 种）`);
  }
  return raw.map((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new Error(`第 ${index + 1} 种纸张格式不正确，应为对象`);
    }
    return {
      paperId: index + 1,
      name: normalizePaperName(item.name, index),
      widthMm: parsePositiveMm(item.widthMm, `第 ${index + 1} 种纸张的宽度`),
      heightMm: parsePositiveMm(item.heightMm, `第 ${index + 1} 种纸张的高度`),
      pricePerSheet: parsePrice(item.pricePerSheet, `第 ${index + 1} 种纸张的单价`),
      setupFee: parsePrice(item.setupFee, `第 ${index + 1} 种纸张的开机费`),
    };
  });
}

/**
 * 解析完整报价请求。
 *
 * @param {*} body 已解析的 JSON body
 * @returns {{
 *   panel: { width: number, height: number, orientation: string|null },
 *   sheetWidthPt: number, sheetHeightPt: number,
 *   sheetCount: number, signatureCount: number, signatureMode: boolean,
 *   sourceCount: number|null, paddedCount: number|null,
 *   papers: Array
 * }}
 */
function parseQuoteRequest(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new Error('请求体必须是 JSON 对象');
  }

  const panel = body.panel;
  if (!panel || typeof panel !== 'object' || Array.isArray(panel)) {
    throw new Error('缺少 panel：请传入拼版计划的统一面板尺寸 { width, height }（pt）');
  }
  if (!isFiniteNumber(panel.width) || !isFiniteNumber(panel.height)
    || panel.width <= 0 || panel.height <= 0) {
    throw new Error('panel.width 与 panel.height 必须是大于 0 的数字（pt）');
  }
  if (panel.width > MAX_PAPER_MM * MM_TO_PT
    || panel.height > MAX_PAPER_MM * MM_TO_PT) {
    throw new Error('panel 尺寸超出允许范围');
  }
  const orientation = typeof panel.orientation === 'string' ? panel.orientation : null;

  const sheetCount = parsePositiveInteger(body.sheetCount, 'sheetCount（用纸张数）', undefined);
  const signatureCount = parsePositiveInteger(
    body.signatureCount, 'signatureCount（签帖数）', 1,
  );
  if (signatureCount > sheetCount) {
    throw new Error('signatureCount 不能大于 sheetCount（每个签帖至少使用 1 张纸）');
  }

  const signatureMode = body.signatureMode === true;
  const papers = parsePapers(body.papers);

  // sourceCount / paddedCount 仅用于回显，可为空
  let sourceCount = null;
  let paddedCount = null;
  if (body.sourceCount !== undefined && body.sourceCount !== null) {
    sourceCount = parsePositiveInteger(body.sourceCount, 'sourceCount', undefined);
  }
  if (body.paddedCount !== undefined && body.paddedCount !== null) {
    if (!isFiniteNumber(body.paddedCount) || !Number.isInteger(body.paddedCount)
      || body.paddedCount < 0) {
      throw new Error('paddedCount 必须是不小于 0 的整数');
    }
    paddedCount = body.paddedCount;
  }

  return {
    panel: { width: panel.width, height: panel.height, orientation },
    // 每张拼版纸为横向：宽 = 2 × 面板宽，高 = 面板高
    sheetWidthPt: panel.width * 2,
    sheetHeightPt: panel.height,
    sheetCount,
    signatureCount,
    signatureMode,
    sourceCount,
    paddedCount,
    papers,
  };
}

/**
 * 判定纸张（给定方向下）能否容纳拼版纸面。
 * @param {number} paperW 该方向下纸张宽（pt）
 * @param {number} paperH 该方向下纸张高（pt）
 * @param {number} sheetW 拼版纸面宽（pt）
 * @param {number} sheetH 拼版纸面高（pt）
 * @returns {boolean}
 */
function fitsWith(paperW, paperH, sheetW, sheetH) {
  return paperW + FIT_TOLERANCE_PT >= sheetW
    && paperH + FIT_TOLERANCE_PT >= sheetH;
}

/**
 * 评估一种纸张：枚举按原方向 / 旋转 90° 两种放置方式，计算利用率与费用。
 * 两种方向都可容纳时优先按原方向（利用率相同，省一次转纸）。
 *
 * @param {object} paper 规范化后的纸张规格
 * @param {number} sheetW 拼版纸面宽（pt）
 * @param {number} sheetH 拼版纸面高（pt）
 * @param {number} sheetCount 总用纸张数
 * @param {number} runs 开机次数（签帖数；整册为 1）
 * @returns {object} 报价选项
 */
function evaluatePaper(paper, sheetW, sheetH, sheetCount, runs) {
  const paperW = mmToPt(paper.widthMm);
  const paperH = mmToPt(paper.heightMm);

  const base = {
    paperId: paper.paperId,
    name: paper.name,
    widthMm: paper.widthMm,
    heightMm: paper.heightMm,
    pricePerSheet: paper.pricePerSheet,
    setupFeePerRun: paper.setupFee,
    sheets: sheetCount,
    runs,
  };

  const straight = fitsWith(paperW, paperH, sheetW, sheetH);
  const rotated = fitsWith(paperH, paperW, sheetW, sheetH);

  if (!straight && !rotated) {
    const sheetWMm = roundTo(ptToMm(sheetW), 1);
    const sheetHMm = roundTo(ptToMm(sheetH), 1);
    return {
      ...base,
      fit: false,
      orientation: null,
      paperRotated: false,
      utilization: null,
      utilizationPercent: null,
      paperCost: null,
      setupCost: null,
      totalCost: null,
      reason: `纸张尺寸不足：每张拼版纸需要 ${sheetWMm} × ${sheetHMm} mm（宽 × 高）；`
        + `「${paper.name}」为 ${paper.widthMm} × ${paper.heightMm} mm，旋转 90° 后为 `
        + `${paper.heightMm} × ${paper.widthMm} mm，两种方向均无法容纳`,
    };
  }

  const useRotated = !straight && rotated; // 两种方向都可时优先原方向
  const utilization = (sheetW * sheetH) / (paperW * paperH);
  const paperCost = roundTo(paper.pricePerSheet * sheetCount, 2);
  const setupCost = roundTo(paper.setupFee * runs, 2);
  const totalCost = roundTo(paperCost + setupCost, 2);

  return {
    ...base,
    fit: true,
    orientation: useRotated ? 'rotated90' : 'straight',
    paperRotated: useRotated,
    utilization,
    utilizationPercent: `${roundTo(utilization * 100, 2).toFixed(2)}%`,
    paperCost,
    setupCost,
    totalCost,
    reason: null,
  };
}

/**
 * 生成印刷用纸报价。
 *
 * @param {*} body 原始 JSON 请求体（内部调用 parseQuoteRequest 校验）
 * @returns {object} 报价结果（feasible=false 时仍返回 200，由调用方决定展示）
 */
function buildPrintQuote(body) {
  const input = parseQuoteRequest(body);

  const options = input.papers.map((paper) => evaluatePaper(
    paper,
    input.sheetWidthPt,
    input.sheetHeightPt,
    input.sheetCount,
    input.signatureCount,
  ));

  const feasibleOptions = options
    .filter((option) => option.fit)
    .sort((a, b) => {
      if (a.totalCost !== b.totalCost) return a.totalCost - b.totalCost;
      if (b.utilization !== a.utilization) return b.utilization - a.utilization;
      return a.paperId - b.paperId;
    });
  const infeasibleOptions = options.filter((option) => !option.fit);

  // 选项列表：可用方案在前（按总价排序），放不下的纸张附在后面并给出原因
  const orderedOptions = [...feasibleOptions, ...infeasibleOptions];

  const panelWidthMm = roundTo(ptToMm(input.panel.width), 1);
  const panelHeightMm = roundTo(ptToMm(input.panel.height), 1);
  const sheetWidthMm = roundTo(ptToMm(input.sheetWidthPt), 1);
  const sheetHeightMm = roundTo(ptToMm(input.sheetHeightPt), 1);

  const requestEcho = {
    panel: {
      width: input.panel.width,
      height: input.panel.height,
      orientation: input.panel.orientation,
      widthMm: panelWidthMm,
      heightMm: panelHeightMm,
    },
    sheetSize: {
      width: input.sheetWidthPt,
      height: input.sheetHeightPt,
      widthMm: sheetWidthMm,
      heightMm: sheetHeightMm,
    },
    sheetCount: input.sheetCount,
    signatureCount: input.signatureCount,
    signatureMode: input.signatureMode,
    sourceCount: input.sourceCount,
    paddedCount: input.paddedCount,
    papers: input.papers,
  };

  const envelope = {
    schemaVersion: 1,
    kind: 'print-quote',
    tool: 'booklet-imposer',
    generatedAt: new Date().toISOString(),
    request: requestEcho,
    feasible: feasibleOptions.length > 0,
    selectedPaperId: null,
    options: orderedOptions,
    selection: null,
    totals: null,
    reason: null,
  };

  if (feasibleOptions.length === 0) {
    envelope.reason = `维护的 ${options.length} 种纸张均无法容纳版面：每张拼版纸尺寸为 `
      + `${sheetWidthMm} × ${sheetHeightMm} mm（宽 × 高；统一面板 `
      + `${panelWidthMm} × ${panelHeightMm} mm 横向双联）。可将纸张旋转 90° 放置，`
      + '仍放不下时请改用更大的纸张，或在纸张规格中新增更大的规格。';
    return envelope;
  }

  const selection = feasibleOptions[0];
  envelope.selectedPaperId = selection.paperId;
  envelope.selection = selection;
  envelope.totals = {
    paperId: selection.paperId,
    name: selection.name,
    orientation: selection.orientation,
    paperRotated: selection.paperRotated,
    utilization: selection.utilization,
    utilizationPercent: selection.utilizationPercent,
    sheets: selection.sheets,
    runs: selection.runs,
    paperCost: selection.paperCost,
    setupCost: selection.setupCost,
    totalCost: selection.totalCost,
  };
  return envelope;
}

module.exports = {
  MM_TO_PT,
  PT_TO_MM,
  MAX_PAPER_SPECS,
  FIT_TOLERANCE_PT,
  mmToPt,
  ptToMm,
  roundTo,
  parsePapers,
  parseQuoteRequest,
  evaluatePaper,
  buildPrintQuote,
};
