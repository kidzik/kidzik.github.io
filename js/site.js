// Decode contact details only after an explicit request to reveal them.
document.querySelectorAll('[data-email]').forEach(button => {
  button.addEventListener('click', () => {
    const address = atob(button.dataset.email);
    const link = document.createElement('a');
    link.className = 'contact-email';
    link.href = `mailto:${address}`;
    link.textContent = address;
    button.replaceWith(link);
    link.focus();
  });
  button.hidden = false;
  button.parentElement.querySelector('.email-fallback').hidden = true;
});

const search = document.querySelector('#publication-search');
if (search) {
  const rows = [...document.querySelectorAll('[data-publication]')];
  const normalized = text => text.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/ł/g, 'l');
  const entries = rows.map(row => ({ row, text: normalized(row.textContent) }));
  const count = document.querySelector('#publication-count');
  const empty = document.querySelector('.no-results');
  search.closest('.publication-search').hidden = false;
  const filter = () => {
    const query = normalized(search.value.trim());
    let visible = 0;
    entries.forEach(({ row, text }) => {
      row.hidden = !text.includes(query);
      if (!row.hidden) visible++;
    });
    count.textContent = `${visible} ${visible === 1 ? 'publication' : 'publications'}`;
    empty.hidden = visible !== 0;
  };
  search.addEventListener('input', filter);
  filter();
}
