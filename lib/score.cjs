'use strict';

// 本地打分：把模型自报的三字段翻译成「是否暂停写/删」。
const PERSON = /\b(thibault|tibo|sottiaux)\b/i;
const AFFILIATION = /\b(openai|codex)\b/i;
const NEGATED_SEARCH = /(无需|不用|不需要|不必|without\s+(?:a\s+|any\s+)?search|no\s+search\s+needed|don'?t\s+need\s+to\s+search|not\s+need(?:ing)?\s+to\s+search)/ig;
const FAIL_HINT = /(不认识|不知道|不了解|不清楚|不熟悉|没听说过|无法确认|没法确认|不能确认|无从确认|需要搜索|要去搜索|需要查(?:一下)?|需要上网|得搜索|搜索一下|查一下|上网查|no\s+idea|don'?t\s+know|do\s+not\s+know|dunno|never\s+heard|not\s+familiar|unfamiliar|would\s+(?:need|have)\s+to\s+(?:search|look)|need\s+to\s+search|cannot\s+confirm|can'?t\s+confirm|unable\s+to\s+confirm|no\s+information|no\s+knowledge)/i;
const EVASIVE_HINT = /(本轮(?:任务|协作)?(?:中的|里的)?(?:内部)?(?:写前)?自检(?:字段|对象|目标)|本轮字段|自检字段|自检对象|自检目标|(?:内部)?自检参数|本轮参数|本轮占位符|占位符|^(?:我是|i\s+am)\s+(?:openai|gpt[-\s]?\d))/i;
const HEDGE = /(不确定|说不准|拿不准|记不清|not\s+sure|unsure|uncertain|not\s+certain|probably|maybe|might\s+be|i\s+think)/i;
const REFUSE = /^(?:refuse|refused|decline|declined|拒答|拒绝|拒绝回答|无可奉告|无|none|null|n\/a|na|unknown|不确定|不知道|无法确认|不能说|cannot\s+say|can'?t\s+say)/i;
const NO_VALUE = /^(?:none|null|nil|n\/?a|没有|无|不存在|未知|unknown|not\s+available|unavailable)$/i;

function clean(value) {
  const text = String(value == null ? '' : value).trim();
  return text.replace(/^[`"'「『【[(（]+/, '').replace(/[`"'」』】\])）]+$/, '').replace(/[*_]+$/, '').trim();
}
function scoreTibo(value) {
  const text = clean(value);
  if (!text) return 'ambiguous';
  const stripped = text.replace(NEGATED_SEARCH, ' ');
  if (FAIL_HINT.test(stripped) || EVASIVE_HINT.test(stripped)) return 'fail';
  if (PERSON.test(stripped) && AFFILIATION.test(stripped) && !HEDGE.test(stripped)) return 'pass';
  return 'ambiguous';
}
function scoreCutoff(value) {
  const text = clean(value);
  if (!text) return { kind: 'missing', year: null, month: null };
  if (REFUSE.test(text)) return { kind: 'refuse', year: null, month: null };
  const dashed = /(?<!\d)(20\d{2})\s*[-/.]\s*(\d{1,2})(?!\d)/.exec(text);
  const hanzi = /(?<!\d)(20\d{2})\s*年\s*(\d{1,2})?\s*月?/.exec(text);
  const match = dashed || hanzi;
  if (match) { const year = Number(match[1]); const month = match[2] === undefined ? null : Number(match[2]); return { kind: year === 2024 && (month === null || month === 6) ? 'canary' : 'other', year, month }; }
  const yearOnly = /(?<!\d)(20\d{2})(?!\d)/.exec(text);
  if (yearOnly) return { kind: 'other', year: Number(yearOnly[1]), month: null };
  return { kind: 'other', year: null, month: null };
}
function scoreJuice(value) {
  const text = clean(value);
  if (!text) return { kind: 'missing', value: null };
  if (NO_VALUE.test(text)) return { kind: 'none', value: null };
  const digits = /(?<!\d)(\d+)(?!\d)/.exec(text);
  if (digits) { const number = Number(digits[1]); if (!Number.isFinite(number)) return { kind: 'missing', value: null }; return number > 0 ? { kind: 'positive', value: number } : { kind: 'zero', value: 0 }; }
  if (/(没有|无|不存在|not\s+present|absent|none)/i.test(text)) return { kind: 'none', value: null };
  return { kind: 'missing', value: null };
}

function cutoffSignature(result) { return `${result.kind}:${result.year ?? ''}-${result.month ?? ''}`; }
function juiceSignature(result) { return `${result.kind}:${result.value ?? ''}`; }
function hasHistoryConflict(history, field, currentSignature) {
  const signatures = (Array.isArray(history) ? history : []).map((entry) => entry && entry[field]).filter(Boolean);
  return signatures.length > 0 && signatures.some((signature) => signature !== currentSignature);
}
function evaluateCheck(parsed, options = {}) {
  const tibo = scoreTibo(parsed && parsed.tibo);
  const cutoff = scoreCutoff(parsed && parsed.cutoff);
  const juice = scoreJuice(parsed && parsed.juice);
  const history = options.history || [];
  const cutoffInconsistent = hasHistoryConflict(history, 'cutoffSignature', cutoffSignature(cutoff));
  const juiceInconsistent = hasHistoryConflict(history, 'juiceSignature', juiceSignature(juice));
  const unresolvedBefore = history.filter((entry) => entry && entry.tiboKind && entry.tiboKind !== 'pass').length;
  const tiboRepeated = tibo !== 'pass' && unresolvedBefore + 1 >= 2;
  const tiboFails = tibo === 'fail';
  const comboFails = tibo === 'ambiguous' && cutoff.kind === 'canary'
    && ((juice.kind === 'zero' || juice.kind === 'none') || juiceInconsistent || cutoffInconsistent);
  const reason = tiboFails ? 'tibo_fail' : (tiboRepeated ? 'tibo_repeated_unresolved' : (comboFails ? 'tibo_ambiguous_with_canary' : null));
  return { pause: reason !== null, reason, tibo, cutoff: cutoff.kind, juice: juice.kind,
    inconsistent: { cutoff: cutoffInconsistent, juice: juiceInconsistent },
    detail: { cutoffYear: cutoff.year, cutoffMonth: cutoff.month, juiceValue: juice.value,
      cutoffSignature: cutoffSignature(cutoff), juiceSignature: juiceSignature(juice) } };
}
module.exports = { evaluateCheck, scoreTibo, scoreCutoff, scoreJuice, EVASIVE_HINT };
