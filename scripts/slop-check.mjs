#!/usr/bin/env node

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const scanTargets = ['apps/web/src', 'apps/web/index.html'];
const extensions = new Set(['.css', '.html', '.jsx', '.tsx']);
const issues = [];

const allowGradientSelectors = new Set(['.progress-fill']);
const suspiciousEnglishLabels = ['Sales', 'Forecast', 'Dashboard', 'Overview', 'Revenue', 'Pipeline'];

function walk(target) {
  const absolute = path.join(root, target);
  if (!existsSync(absolute)) return [];
  const stats = statSync(absolute);
  if (stats.isFile()) return [absolute];
  return readdirSync(absolute)
    .filter((entry) => !entry.startsWith('.'))
    .flatMap((entry) => walk(path.join(target, entry)));
}

function relative(file) {
  return path.relative(root, file).replaceAll(path.sep, '/');
}

function addIssue(file, line, rule, message, fix) {
  issues.push({ file: relative(file), line, rule, message, fix });
}

function isAllowed(line, rule) {
  return line.includes('slop-check: allow') || line.includes(`slop-check: allow ${rule}`);
}

function scanFile(file) {
  if (!extensions.has(path.extname(file))) return;

  const text = readFileSync(file, 'utf8');
  const lines = text.split(/\r?\n/);
  let selector = '';
  let insideTextElement = false;

  for (const [index, line] of lines.entries()) {
    const lineNumber = index + 1;
    const trimmed = line.trim();

    if (path.extname(file) === '.css' && trimmed.endsWith('{')) {
      selector = trimmed.slice(0, -1).trim();
    }

    if (path.extname(file) === '.tsx' && /<(p|h[1-6]|span|button|label|div)\b/i.test(line) && !/<\/(p|h[1-6]|span|button|label|div)>/i.test(line)) {
      insideTextElement = true;
    }

    if (!isAllowed(line, 'decorative-pill') && /\b(summary|metric|stat|info|count)?[-_]?(pill|chip|capsule)\b/i.test(line)) {
      addIssue(
        file,
        lineNumber,
        'decorative-pill',
        'Подозрительная декоративная плашка/chip/pill. Такой элемент допустим только если это действие, фильтр, статус или навигация.',
        'Убрать элемент, заменить существующей секцией или сделать полноценным управлением с состоянием.'
      );
    }

    if (!isAllowed(line, 'ai-decor') && /(?:className=|[.#])[^"'{}\n]*(orb|blob|bokeh|glow|glassmorphism|shine)[^"'{}\n]*/i.test(line)) {
      addIssue(
        file,
        lineNumber,
        'ai-decor',
        'Найден AI-декор: orb/blob/bokeh/glow/glass/shine. В рабочем CRM/аналитическом интерфейсе это стоп-сигнал.',
        'Оставить только функциональную визуальную иерархию: сетка, таблица, фильтр, статус, график, рабочий акцент.'
      );
    }

    if (
      path.extname(file) === '.css' &&
      !isAllowed(line, 'decorative-gradient') &&
      /\b(?:linear|radial|conic)-gradient\(/i.test(line) &&
      !allowGradientSelectors.has(selector)
    ) {
      addIssue(
        file,
        lineNumber,
        'decorative-gradient',
        `Градиент вне разрешённого функционального селектора (${selector || 'неизвестный селектор'}).`,
        'Доказать функцию градиента через allow-комментарий или заменить на системный цвет/границу.'
      );
    }

    if (!isAllowed(line, 'english-visible-label')) {
      for (const label of suspiciousEnglishLabels) {
        const visibleText = new RegExp(`>[^<{}]*\\b${label}\\b[^<{}]*<`);
        const textOnlyLine = insideTextElement && !/[{}=;]/.test(line) && new RegExp(`\\b${label}\\b`).test(line);
        const propText = new RegExp(`\\b(title|label|aria-label)=["']${label}["']`);
        const labelObjectText = new RegExp(`\\blabel:\\s*["']${label}["']`);
        if (visibleText.test(line) || textOnlyLine || propText.test(line) || labelObjectText.test(line)) {
          addIssue(
            file,
            lineNumber,
            'english-visible-label',
            `Английская видимая подпись "${label}" в русскоязычном интерфейсе.`,
            'Перевести подпись или оставить короткий комментарий slop-check: allow english-visible-label с причиной.'
          );
          break;
        }
      }
    }

    if (path.extname(file) === '.tsx' && /<\/(p|h[1-6]|span|button|label|div)>/i.test(line)) {
      insideTextElement = false;
    }
  }
}

for (const file of scanTargets.flatMap(walk)) {
  scanFile(file);
}

if (issues.length > 0) {
  console.error('\nSlop check failed: найдены UI-паттерны, похожие на нейрослоп.\n');
  for (const issue of issues) {
    console.error(`${issue.file}:${issue.line} [${issue.rule}] ${issue.message}`);
    console.error(`  Исправление: ${issue.fix}\n`);
  }
  console.error('Если это осознанное исключение, добавь на строку комментарий: slop-check: allow <rule>\n');
  process.exit(1);
}

console.log('Slop check passed: явных AI-slop паттернов не найдено.');
