import { Page } from 'playwright-core';
import { EvidenceBinding, EvidenceFrame, frameSourceIds, MAX_EVIDENCE_CAPTURE_MS, MAX_EVIDENCE_FRAMES, VisibleRecord } from './crm-control-evidence-manifest';

// Verified on real amoCRM cards on 2026-09-22. Only scrolling is performed; no editing controls are activated.
const FEED = '#card_holder .js-card-feed';
const SCROLLER = '#card_holder .notes-wrapper__scroller';
const RECORDS = '#card_holder .feed-note-wrapper-task[data-id], #card_holder .feed-note-wrapper-note[data-id]';

async function visibleRecords(page: Page, clip: { x: number; y: number; width: number; height: number }): Promise<VisibleRecord[]> {
  return page.locator(RECORDS).evaluateAll((elements, area) => {
    const inside = (element: Element) => {
      const box = element.getBoundingClientRect();
      if (box.width <= 0 || box.height <= 0 || box.left < area.x || box.top < area.y
        || box.right > area.x + area.width || box.bottom > area.y + area.height) return false;
      for (let parent = element.parentElement; parent; parent = parent.parentElement) {
        const css = getComputedStyle(parent), parentBox = parent.getBoundingClientRect();
        if (css.visibility === 'hidden' || css.display === 'none' || Number(css.opacity) === 0) return false;
        if (/(auto|scroll|hidden|clip)/.test(css.overflowY) && (box.top < parentBox.top || box.bottom > parentBox.bottom)) return false;
        if (/(auto|scroll|hidden|clip)/.test(css.overflowX) && (box.left < parentBox.left || box.right > parentBox.right)) return false;
      }
      const center = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
      return !!center && element.contains(center);
    };
    return elements.filter(inside).map(element => {
      const task = element.classList.contains('feed-note-wrapper-task');
      const open = element.querySelector('.card-task');
      const done = element.querySelector('.feed-note__body_task-completed');
      const content = element.querySelector('.card-task__inner-content > p, .feed-note__task-text > p');
      let text: string | null = null;
      if (content && inside(content) && content.scrollWidth <= content.clientWidth + 1 && content.scrollHeight <= content.clientHeight + 1) {
        const copy = content.cloneNode(true) as Element;
        copy.querySelectorAll('.task-type-name-with-icon').forEach(node => node.remove());
        text = copy.textContent ?? '';
      }
      return { kind: task ? 'task' as const : 'note' as const, domId: element.getAttribute('data-id') ?? '',
        text: task ? text : null, completed: task ? (done ? true : open ? false : null) : null };
    });
  }, clip);
}

export async function collectCrmEvidenceFrames(page: Page, binding: EvidenceBinding,
  store: (buffer: Buffer) => Promise<{ storageKey: string; sha256: string; width: number; height: number }>) {
  const frames: EvidenceFrame[] = [];
  const records = new Map<string, VisibleRecord[]>();
  const deadline = Date.now() + MAX_EVIDENCE_CAPTURE_MS;
  let truncated = false;
  const viewport = page.viewportSize() ?? { width: 1600, height: 1200 };
  const full = { x: 0, y: 0, ...viewport };
  const shot = async (id: string, label: string, kind: EvidenceFrame['kind'], clip = full) => {
    if (Date.now() >= deadline || frames.length >= MAX_EVIDENCE_FRAMES) { truncated = true; return false; }
    if (await page.locator('input[type="password"]').isVisible()) throw new Error('Authentication required during capture');
    const card = page.locator('textarea[name="lead[NAME]"]');
    if (await card.getAttribute('placeholder') !== `Сделка #${binding.dealExternalId}`) throw new Error('Card changed during capture');
    const before = await visibleRecords(page, clip);
    const capturedAt = new Date().toISOString();
    const buffer = await page.screenshot({ type: 'png', clip, animations: 'disabled', timeout: Math.max(1, Math.min(15_000, deadline - Date.now())) });
    const after = await visibleRecords(page, clip);
    // Do not link a changing row to a frame. Text stays in process memory and is never written into the manifest.
    const stable = before.filter(record => after.some(item => item.kind === record.kind && item.domId === record.domId
      && item.text === record.text && item.completed === record.completed));
    const stored = await store(buffer);
    frames.push({ id, label, kind, ...stored, capturedAt,
      sourceIds: frameSourceIds(stable, binding.snapshot) });
    records.set(id, stable);
    return true;
  };
  await shot('card', 'Карточка: основные поля и текущая лента', 'card');
  const taskIds = [...new Set((binding.results ?? []).filter(result => !['PASS', 'NA'].includes(result.status)
    && ['task_deadline', 'task_type', 'task_text', 'task_stage_deadline'].includes(result.ruleCode))
    .map(result => result.subjectId.replace(/^amo:/, '')).filter(id => /^\d+$/.test(id)))];
  for (const taskId of taskIds.slice(0, 4)) {
    if (Date.now() >= deadline) { truncated = true; break; }
    const row = page.locator(`#card_holder .feed-note-wrapper-task[data-id="${taskId}"]`).first();
    if (!await row.count()) continue;
    try {
      await row.scrollIntoViewIfNeeded({ timeout: Math.max(1, Math.min(2500, deadline - Date.now())) });
      await shot(`task-${taskId}`, `Задача #${taskId} в карточке`, 'task');
    } catch { truncated = true; }
  }
  if (taskIds.length > 4) truncated = true;
  const scroller = page.locator(SCROLLER).first();
  if (!await scroller.count()) return { frames, records, truncated: true };
  await scroller.evaluate(element => { element.scrollTop = element.scrollHeight; });
  let previousTop: number | null = null;
  for (let index = 0; index < 3; index += 1) {
    if (Date.now() >= deadline || frames.length >= MAX_EVIDENCE_FRAMES) { truncated = true; break; }
    const box = await page.locator(FEED).first().boundingBox();
    if (!box) { truncated = true; break; }
    const x = Math.max(0, Math.ceil(box.x)), y = Math.max(0, Math.ceil(box.y));
    const width = Math.floor(Math.min(viewport.width, box.x + box.width) - x);
    const height = Math.floor(Math.min(viewport.height, box.y + box.height) - y);
    if (width < 100 || height < 100) { truncated = true; break; }
    await shot(`feed-${index + 1}`, `Лента и примечания: фрагмент ${index + 1}`, 'feed', { x, y, width, height });
    const position = await scroller.evaluate(element => ({ top: element.scrollTop, height: element.clientHeight }));
    if (position.top <= 1) break;
    if (previousTop === position.top) { truncated = true; break; }
    previousTop = position.top;
    if (index === 2) { truncated = true; break; }
    await scroller.evaluate(element => { element.scrollTop = Math.max(0, element.scrollTop - Math.max(200, element.clientHeight - 100)); });
    // Two paint frames let native scrolling settle without waiting for amoCRM's long-lived requests.
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  }
  return { frames, records, truncated };
}
