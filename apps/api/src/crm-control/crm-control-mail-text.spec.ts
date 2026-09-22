import { normalizeCrmControlMailText } from './crm-control-mail-text';
import { parseBrowserMailParticipants } from './crm-control-browser-history';

describe('current email body and private participants', () => {
  it.each([
    ['Да, переносим на 25.09.2026.', 'Да, переносим на 25.09.2026.'],
    ['<div>Да, переносим<br>на 25.09.2026.</div>', 'Да, переносим\nна 25.09.2026.'],
    ['Нет.\n> Да, переносим на 25.09.2026.', 'Нет.'],
    ['<p>Нет.</p><blockquote>Да, переносим на 25.09.2026.</blockquote>', 'Нет.'],
    ['<div>Нет.</div><div class="gmail_quote">Да, переносим.</div>', 'Нет.'],
    ['Нет.\nFrom: example\nTo: example\nSubject: old\nДа, переносим.', 'Нет.'],
    ['<p>Цена &lt; 100 &amp; срок &#50;&#53;.09.</p>', 'Цена < 100 & срок 25.09.'],
  ])('attributes only current text: %s', (body, expected) => {
    expect(normalizeCrmControlMailText(body)).toMatchObject({ text: expected, eligibleAsSemanticText: true });
  });
  it.each(['> Только старое письмо', '<blockquote>Да</blockquote>', '<script>Да</script>', '<div hidden>Да</div>',
    '<p style="display:none">Да</p>', '<div><p>Да</div>', '<div onclick="x()">Да</div>', '<p>Да &unknown;</p>',
    'Нет.\n>Да\nНовый ответ внутри цитаты', '<blockquote>Да</blockquote><p>Нет</p>', 'Да\u200b', 'a'.repeat(200001)])
    ('does not certify ambiguous HTML, quoting or invisible text', body => {
      expect(normalizeCrmControlMailText(body).eligibleAsSemanticText).toBe(false);
    });
  it('keeps contact identifiers private without interpreting role from participant type', () => {
    const contact = { email: 'person@example.test', name: 'Person', type: 'contact', id: 55 };
    expect(parseBrowserMailParticipants({ from: [contact], to: [contact], cc: null })).toMatchObject({
      from: [{ ...contact, id: '55' }], to: [{ ...contact, id: '55' }], cc: [], reasonCodes: [] });
    expect(parseBrowserMailParticipants({ from: [{ ...contact, id: -1 }], to: [], cc: null }).reasonCodes).toContain('MAIL_FROM_UNVERIFIED');
  });
});
