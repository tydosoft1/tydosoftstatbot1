'use strict';
/* global chrome, InvitesCore, $, el, toast, storage, plural, showTab, NBSP */

/*
 * Раздел «Инвайты»: аккаунты с семейной подпиской и люди в них.
 * Расчёты (даты, статусы, продление, проверка файла импорта) лежат в invites-core.js,
 * здесь — страница, окна и запись в хранилище.
 *
 * Пароли не пишутся в консоль и попадают на страницу, только пока их просят показать.
 */
(function () {
  const Core = InvitesCore;

  const KEY_INVITES = 'invites';
  const MASK = '••••••••'; // длина маски не выдаёт длину пароля
  const REVEAL_TIME = 30000; // мс: показанный пароль сам прячется
  const DOUBLE_CLICK = 450; // мс: щелчок по «Подтвердить» сразу после открытия окна — случайный
  const IMPORT_MAX_BYTES = 4 * 1024 * 1024;

  const STATUS_NAME = { active: 'Активен', soon: 'Скоро истекает', expired: 'Истёк' };
  const SORT_NAME = { end: 'По дате окончания', free: 'По свободным местам', added: 'По дате добавления' };
  const ENTRY_NAME = {
    purchase: 'Куплена подписка',
    renew: 'Продлена',
    rebuy: 'Куплена заново',
    edit: 'Даты изменены вручную',
  };

  /* Плитки сводки: фильтр, подпись, поле сводки, пояснение во всплывающей подсказке. */
  const TILES = [
    ['all', 'Все', 'total', 'Все аккаунты, кроме архива'],
    ['active', 'Активные', 'active', 'Подписка действует'],
    ['soon', 'Скоро истекают', 'soon', ''],
    ['expired', 'Истёкшие', 'expired', 'Подписка закончилась, её не продлили'],
    ['free', 'Есть места', 'withFree', 'Действующие аккаунты, где есть свободные места'],
    ['full', 'Заполненные', 'full', 'Действующие аккаунты, где заняты все места'],
  ];

  const FAILURES = {
    'account-missing': 'Аккаунт не найден: возможно, его удалили в другом окне',
    'member-missing': 'Участник не найден: возможно, его удалили в другом окне',
    'members-full': 'В аккаунте уже ' + Core.MAX_MEMBERS + ' участников, шестого добавить нельзя',
    stale: 'Срок аккаунта уже изменился — проверьте дату окончания',
    'invalid-input': 'Проверьте поля: не всё заполнено верно',
    'invalid-date': 'Проверьте дату',
    'accounts-limit': 'Аккаунтов слишком много, новый не поместится',
  };

  const IMPORT_FAILURES = {
    'not-json': 'Это не файл экспорта: его не удалось прочитать',
    'wrong-format': 'Это не файл экспорта раздела «Инвайты»',
    'newer-version': 'Файл создан более новой версией расширения — обновите расширение и повторите',
    empty: 'В файле нет ни одного аккаунта',
    'too-many': 'В файле слишком много аккаунтов',
    'no-valid': 'В файле нет ни одной записи с email и датами — импортировать нечего',
  };

  let state = Core.emptyState();
  let today = Core.today();

  /* Что сейчас на экране. В хранилище это не пишется: при следующем открытии всё свёрнуто и скрыто. */
  const view = {
    filter: 'all',
    query: '',
    open: new Set(), // раскрытые карточки
    found: new Set(), // карточки, которые раскрыл поиск по нику
    refind: false, // запрос изменился — раскрыть найденное заново
    selected: new Set(), // отмеченные истёкшие аккаунты
    revealed: new Map(), // id аккаунта → таймер: где сейчас виден пароль
  };

  /* ───────────────────────── Мелкие помощники ───────────────────────── */

  const fmt = Core.formatDate;
  const findAccount = (id) => state.accounts.find((account) => account.id === id) || null;
  const accountsWord = (n) => plural(n, 'аккаунт', 'аккаунта', 'аккаунтов');
  const inWindow = () => document.documentElement.classList.contains('in-window');

  function explain(error) {
    if (error && FAILURES[error.code]) return FAILURES[error.code];
    return 'Изменения не сохранились: ' + (error && error.message ? error.message : 'неизвестная ошибка');
  }

  const ICONS = {
    chevron: 'M4 6l4 4 4-4',
    calendar: 'M4 3.5h8a1.5 1.5 0 0 1 1.5 1.5v7a1.5 1.5 0 0 1-1.5 1.5H4A1.5 1.5 0 0 1 2.5 12V5A1.5 1.5 0 0 1 4 3.5zM2.5 6.5h11M5.5 2v3M10.5 2v3',
  };

  /** Значок 16×16 тем же штрихом, что и значки в шапке. */
  function icon(name, className) {
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    const attrs = {
      viewBox: '0 0 16 16',
      width: '16',
      height: '16',
      fill: 'none',
      stroke: 'currentColor',
      'stroke-width': '1.5',
      'stroke-linecap': 'round',
      'stroke-linejoin': 'round',
      'aria-hidden': 'true',
    };
    for (const [key, value] of Object.entries(attrs)) svg.setAttribute(key, value);
    if (className) svg.setAttribute('class', className);
    const line = document.createElementNS(ns, 'path');
    line.setAttribute('d', ICONS[name]);
    svg.append(line);
    return svg;
  }

  /** Хвост фразы о сроке: «осталось 31 дн.», «последний день», «16 дн. назад». */
  function leftText(daysLeft) {
    if (daysLeft < -1) return -daysLeft + NBSP + 'дн. назад';
    if (daysLeft === -1) return 'вчера';
    if (daysLeft === 0) return 'последний день';
    if (daysLeft === 1) return 'остался 1' + NBSP + 'день';
    return 'осталось ' + daysLeft + NBSP + 'дн.';
  }

  /** «до 06.11.2026, осталось 31 дн.» либо «20.09.2026, 16 дн. назад» */
  const whenText = (date, daysLeft) => (daysLeft < 0 ? '' : 'до ') + fmt(date) + ', ' + leftText(daysLeft);

  const statusMark = (status) => el('span', { class: 'status', text: STATUS_NAME[status], dataset: { status: status } });

  function seatsLabel(item) {
    let text = 'Занято ' + item.used + ' из ' + Core.MAX_MEMBERS + ' мест';
    const expired = item.members.filter((entry) => entry.status === 'expired').length;
    const soon = item.members.filter((entry) => entry.status === 'soon').length;
    if (expired) text += '; у участников срок истёк: ' + expired;
    if (soon) text += '; скоро истекает: ' + soon;
    return text;
  }

  /** Пять мест подписки одной меткой: видно, сколько занято и у кого из участников кончается срок. */
  function seatsMark(item) {
    const label = seatsLabel(item);
    const box = el('span', { class: 'seats', role: 'img', 'aria-label': label, title: label });
    for (let i = 0; i < Core.MAX_MEMBERS; i += 1) {
      const pip = el('span', { class: 'seats__pip' });
      if (item.members[i]) pip.dataset.status = item.members[i].status;
      box.append(pip);
    }
    box.append(el('span', { class: 'seats__count', text: item.used + '/' + Core.MAX_MEMBERS }));
    return box;
  }

  async function copyText(text, done) {
    let copied = false;
    try {
      await navigator.clipboard.writeText(text);
      copied = true;
    } catch (error) {
      // Буфер обмена недоступен напрямую — пробуем старый способ через скрытое поле.
      const field = el('textarea', { class: 'sr-only', readonly: '', 'aria-hidden': 'true' });
      field.value = text;
      document.body.append(field);
      field.select();
      try {
        copied = document.execCommand('copy');
      } catch (failure) {
        copied = false;
      }
      field.remove();
    }
    toast(copied ? done : 'Скопировать не получилось — выделите текст и скопируйте вручную');
  }

  /* ───────────────────────── Хранилище ───────────────────────── */

  /* Правки идут по очереди и каждый раз от свежей копии из хранилища — как в журнале заказов:
     два открытых окна не затирают изменения друг друга. Если change бросает ошибку, ничего не пишется. */
  let queue = Promise.resolve();

  function mutate(change) {
    const run = async () => {
      const saved = await storage.get(KEY_INVITES);
      const fresh = Core.normalizeState(saved[KEY_INVITES]);
      const result = change(fresh);
      await storage.set({ [KEY_INVITES]: fresh });
      state = fresh;
      render();
      return result;
    };
    const next = queue.then(run, run);
    queue = next.catch(() => {});
    return next;
  }

  /** Правка без окна подтверждения: об ошибке говорит сообщение внизу. Возвращает, получилось ли. */
  async function apply(change) {
    try {
      await mutate(change);
      return true;
    } catch (error) {
      toast(explain(error));
      return false;
    }
  }

  /* ───────────────────────── Сводка ───────────────────────── */

  function buildTiles() {
    const box = $('inv-tiles');
    for (const [filter, name, field, title] of TILES) {
      box.append(
        el('label', { class: 'inv-tile', title: title, dataset: { filter: filter } }, [
          el('input', { class: 'inv-tile__input', type: 'radio', name: 'inv-filter', value: filter }),
          el('span', { class: 'inv-tile__body' }, [
            el('span', { class: 'inv-tile__name', text: name }),
            el('span', { class: 'inv-tile__count', dataset: { field: field } }),
          ]),
        ])
      );
    }
  }

  function renderSummary() {
    const sum = Core.summarize(state, today);
    const warnDays = state.prefs.warnDays;

    for (const tile of $('inv-tiles').children) {
      const filter = tile.dataset.filter;
      const count = tile.querySelector('.inv-tile__count');
      const value = sum[count.dataset.field];
      count.textContent = String(value);
      tile.querySelector('.inv-tile__input').checked = filter === view.filter;
      // Число подсвечено, только когда там есть на что смотреть.
      if (value > 0 && (filter === 'soon' || filter === 'expired')) tile.dataset.tone = filter;
      else delete tile.dataset.tone;
      if (filter === 'soon') {
        tile.title =
          warnDays === 0
            ? 'Подписка заканчивается сегодня'
            : 'До конца подписки не больше ' + warnDays + ' ' + plural(warnDays, 'дня', 'дней', 'дней');
      }
    }
    $('inv-members').textContent = String(sum.members);
    $('inv-free').textContent = String(sum.freeSeats);

    const badge = $('invites-count');
    badge.hidden = sum.soon === 0;
    badge.textContent = String(sum.soon);
    badge.title = 'Скоро истекают: ' + sum.soon;

    const nothing = state.accounts.length === 0;
    $('inv-empty').hidden = !nothing;
    $('inv-board').hidden = nothing;
  }

  /* ───────────────────────── Список аккаунтов ───────────────────────── */

  function sortSelect() {
    const select = el('select', { class: 'inv-sort', id: 'inv-sort', 'aria-label': 'Сортировка', dataset: { key: 'sort' } });
    for (const sort of Core.SORTS) select.append(el('option', { value: sort, text: SORT_NAME[sort] }));
    select.value = state.prefs.sort;
    return select;
  }

  function linkButton(text, action, key) {
    return el('button', { class: 'link-btn', type: 'button', text: text, dataset: { inv: action, key: key || action } });
  }

  function memberRow(accountId, entry, matched) {
    const member = entry.member;
    const key = accountId + ':' + member.id;
    const row = el('li', { class: matched ? 'member is-match' : 'member', dataset: { status: entry.status } }, [
      el('span', { class: 'member__name', text: member.nickname }),
      el('span', { class: 'member__tools' }, [
        el('button', {
          class: 'link-btn',
          type: 'button',
          text: 'Изменить',
          'aria-label': 'Изменить участника ' + member.nickname,
          dataset: { inv: 'member-edit', member: member.id, key: 'member-edit:' + key },
        }),
        el('button', {
          class: 'del',
          type: 'button',
          text: '×',
          title: 'Убрать участника',
          'aria-label': 'Убрать участника ' + member.nickname,
          dataset: { inv: 'member-remove', member: member.id, key: 'member-remove:' + key },
        }),
      ]),
      el('span', { class: 'member__line' }, [
        statusMark(entry.status),
        el('span', { text: whenText(member.endDate, entry.daysLeft) }),
      ]),
    ]);
    if (member.startDate) row.title = 'Доступ с ' + fmt(member.startDate);
    return row;
  }

  function freeRow(accountId, index) {
    return el('li', { class: 'member member--free' }, [
      el('span', { class: 'member__name', text: 'Свободное место' }),
      el('span', { class: 'member__tools' }, [
        el('button', {
          class: 'link-btn',
          type: 'button',
          text: 'Добавить',
          'aria-label': 'Добавить участника',
          dataset: { inv: 'member-add', key: 'member-add:' + accountId + ':' + index },
        }),
      ]),
    ]);
  }

  /** Раскрытая часть карточки: данные для входа, сроки, участники и действия. */
  function accountBody(item) {
    const account = item.account;
    const id = account.id;
    const shown = view.revealed.has(id);
    const row = (name, children) => el('div', { class: 'kv__row' }, [el('dt', { text: name }), el('dd', {}, children)]);
    const tools = (children) => el('span', { class: 'kv__tools' }, children);
    const tool = (text, action, label) => {
      const button = linkButton(text, action, action + ':' + id);
      if (label) button.setAttribute('aria-label', label);
      return button;
    };

    const reveal = tool(shown ? 'Скрыть' : 'Показать', 'reveal', shown ? 'Скрыть пароль' : 'Показать пароль');
    const passwordRow = account.password
      ? row('Пароль', [
          el('span', { class: 'kv__value', text: shown ? account.password : MASK }),
          tools([reveal, tool('Скопировать', 'copy-password', 'Скопировать пароль')]),
        ])
      : row('Пароль', [el('span', { class: 'kv__value kv__value--quiet', text: 'не указан' })]);

    const ended = item.daysLeft < 0;
    const seats =
      item.used +
      ' из ' +
      Core.MAX_MEMBERS +
      ' занято, ' +
      (item.free > 0 ? item.free + ' свободно' : 'свободных нет');

    const body = el('div', { class: 'acc__body', id: 'acc-body-' + id });

    // Подписка закончилась, а люди заплатили вперёд — об этом стоит знать сразу.
    const paid = item.members.filter((entry) => entry.status !== 'expired').length;
    if (ended && paid > 0) {
      body.append(
        el('p', {
          class: 'acc__warn',
          text:
            'Подписка закончилась, а у ' +
            paid +
            ' ' +
            plural(paid, 'участника', 'участников', 'участников') +
            ' оплата ещё действует.',
        })
      );
    }

    body.append(
      el('dl', { class: 'kv' }, [
        row('Email', [
          el('span', { class: 'kv__value', text: account.email }),
          tools([tool('Скопировать', 'copy-email', 'Скопировать email')]),
        ]),
        passwordRow,
        row('Куплена', [el('span', { class: 'kv__value', text: fmt(account.subscriptionStartDate) })]),
        row('Окончание', [
          el('span', {
            class: 'kv__value',
            text: fmt(account.subscriptionEndDate) + ', ' + (ended ? 'истекла ' : '') + leftText(item.daysLeft),
          }),
        ]),
        row('Места', [el('span', { class: 'kv__value', text: seats })]),
      ])
    );

    body.append(el('h3', { class: 'acc__sub', text: 'Участники' }));
    const members = el('ol', { class: 'members' });
    for (const entry of item.members) members.append(memberRow(id, entry, item.matched.includes(entry.member.id)));
    for (let i = item.used; i < Core.MAX_MEMBERS; i += 1) members.append(freeRow(id, i));
    body.append(members);

    const actions = el('div', { class: 'acc__actions' });
    if (!account.archived) {
      actions.append(
        el('button', { class: 'btn', type: 'button', text: 'Продлил подписку', dataset: { inv: 'renew', key: 'renew:' + id } })
      );
    }
    const remove = linkButton('Удалить', 'delete', 'delete:' + id);
    remove.classList.add('link-btn--danger');
    actions.append(
      el('span', { class: 'acc__links' }, [
        linkButton('Редактировать', 'edit', 'edit:' + id),
        linkButton('История', 'history', 'history:' + id),
        account.archived
          ? linkButton('Восстановить', 'restore', 'restore:' + id)
          : linkButton('В архив', 'archive', 'archive:' + id),
        remove,
      ])
    );
    body.append(actions);
    return body;
  }

  function accountCard(item, group) {
    const account = item.account;
    const id = account.id;
    const open = view.open.has(id) || view.found.has(id);
    const top = el('div', { class: 'acc__top' });

    // Истёкшие можно отметить и вернуть в работу разом.
    if (group === 'expired') {
      const pick = el('input', {
        class: 'check__input',
        type: 'checkbox',
        'aria-label': 'Выбрать ' + account.email,
        dataset: { inv: 'pick', key: 'pick:' + id },
      });
      pick.checked = view.selected.has(id);
      top.append(el('label', { class: 'acc__pick' }, [pick]));
    }

    const title = el('span', { class: 'acc__title' }, [el('span', { text: account.email })]);
    if (account.label) title.append(el('span', { class: 'acc__label', text: account.label }));

    const head = el(
      'button',
      { class: 'acc__head', type: 'button', 'aria-expanded': String(open), dataset: { inv: 'toggle', key: 'toggle:' + id } },
      [
        title,
        seatsMark(item),
        icon('chevron', 'acc__chev'),
        el('span', { class: 'acc__line' }, [
          statusMark(item.status),
          el('span', { class: 'acc__when', text: whenText(account.subscriptionEndDate, item.daysLeft) }),
        ]),
      ]
    );
    top.append(head);

    const card = el('article', { class: 'acc', dataset: { id: id, status: item.status } }, [top]);
    if (open) {
      head.setAttribute('aria-controls', 'acc-body-' + id);
      card.append(accountBody(item));
    }
    return card;
  }

  function bulkBar(items) {
    const ids = items.map((item) => item.account.id);
    const shown = ids.filter((id) => view.selected.has(id)).length;
    const all = el('input', { class: 'check__input', type: 'checkbox', dataset: { inv: 'pick-all', key: 'pick-all' } });
    all.checked = shown > 0 && shown === ids.length;
    all.indeterminate = shown > 0 && shown < ids.length;

    const count = view.selected.size;
    const button = el('button', {
      class: 'btn',
      type: 'button',
      text: count ? 'Купить подписку заново: ' + count : 'Купить подписку заново',
      dataset: { inv: 'rebuy', key: 'rebuy' },
    });
    button.disabled = count === 0;
    return el('div', { class: 'inv-bulk' }, [el('label', { class: 'check' }, [all, el('span', { text: 'Выбрать все' })]), button]);
  }

  function renderList() {
    const box = $('inv-list');
    const main = $('main');
    const scroll = main.scrollTop;
    const focused = document.activeElement;
    const focusKey = focused && box.contains(focused) ? focused.dataset.key : '';

    // Отметки держатся только на истёкших аккаунтах, которые ещё есть в списке.
    for (const id of Array.from(view.selected)) {
      const account = findAccount(id);
      const expired = account && Core.statusOf(account.subscriptionEndDate, today, state.prefs.warnDays) === 'expired';
      if (!account || account.archived || !expired) view.selected.delete(id);
    }

    const query = view.query.trim();
    const shown = Core.selectAccounts(state, { filter: view.filter, query: query, sort: state.prefs.sort }, today);
    const groups = shown.groups;

    // Нашли человека по нику — его аккаунт раскрывается сам.
    if (view.refind) {
      view.refind = false;
      view.found = new Set();
      for (const name of Object.keys(groups)) {
        for (const item of groups[name]) {
          if (item.matched.length) view.found.add(item.account.id);
        }
      }
    }

    const parts = [];
    let sortPlaced = false;
    const group = (name, title, items, extra) => {
      const head = el('div', { class: 'inv-group__head' }, [
        el('h2', { class: 'inv-group__title', text: title }),
        el('span', { class: 'inv-group__count', text: String(items.length) }),
      ]);
      if (extra) head.append(extra);
      if (!sortPlaced) {
        head.append(sortSelect());
        sortPlaced = true;
      }
      const section = el('section', { class: 'inv-group', 'aria-label': title }, [head]);
      if (name === 'expired') section.append(bulkBar(items));
      for (const item of items) section.append(accountCard(item, name));
      parts.push(section);
    };

    if (view.filter === 'archived') {
      if (groups.archived.length) group('archived', 'Архив', groups.archived, linkButton('К списку', 'leave-archive'));
    } else {
      if (groups.active.length) group('active', 'Активные', groups.active);
      if (groups.expired.length) group('expired', 'Истёкшие', groups.expired);
    }

    const note = (children) => parts.push(el('p', { class: 'inv-note' }, children));
    if (shown.count === 0) {
      if (query) note(['По запросу «' + query + '» здесь ничего не нашлось.']);
      else if (view.filter === 'archived') note(['Архив пуст. ', linkButton('Вернуться к списку', 'leave-archive')]);
      else if (view.filter === 'all') note(['Все аккаунты сейчас в архиве.']);
      else note(['Таких аккаунтов сейчас нет. ', linkButton('Показать все', 'show-all')]);
    }
    // Совпадения, которые не видны из-за фильтра или лежат в архиве, не должны теряться молча.
    const more = shown.count > 0 ? 'ещё ' : '';
    if (query && shown.hidden.other > 0) {
      const n = shown.hidden.other;
      note([
        'Вне выбранного фильтра — ' + more + n + ' ' + plural(n, 'совпадение', 'совпадения', 'совпадений') + '. ',
        linkButton('Показать все', 'show-all'),
      ]);
    }
    if (query && shown.hidden.archived > 0) {
      const n = shown.hidden.archived;
      note([
        'В архиве ' + plural(n, 'нашёлся', 'нашлось', 'нашлось') + ' ' + more + n + ' ' + accountsWord(n) + '. ',
        linkButton('Открыть архив', 'show-archive'),
      ]);
    }

    const archived = state.accounts.filter((account) => account.archived).length;
    if (archived > 0 && view.filter !== 'archived' && !(query && shown.hidden.archived > 0)) {
      note([linkButton('Архив: ' + archived + ' ' + accountsWord(archived), 'show-archive')]);
    }

    box.replaceChildren(...parts);
    main.scrollTop = scroll;
    if (focusKey) {
      const node = box.querySelector('[data-key="' + focusKey + '"]');
      if (node) node.focus({ preventScroll: true });
    }
  }

  function renderSettings() {
    const warn = $('invites-warn-days');
    if (document.activeElement !== warn) {
      warn.value = String(state.prefs.warnDays);
      warn.removeAttribute('aria-invalid');
    }
    $('invites-notify').checked = state.prefs.notify;
  }

  function render() {
    renderSummary();
    renderList();
    renderSettings();
  }

  /** Показывает аккаунт в списке: сбрасывает отбор, раскрывает карточку и прокручивает к ней. */
  function showAccount(id) {
    view.filter = 'all';
    view.query = '';
    view.found = new Set();
    $('inv-search').value = '';
    view.open.add(id);
    render();
    const card = $('inv-list').querySelector('.acc[data-id="' + id + '"]');
    if (card) card.scrollIntoView({ block: 'nearest' });
  }

  /* ───────────────────────── Карточка: мелкие действия ───────────────────────── */

  function hidePassword(id) {
    clearTimeout(view.revealed.get(id));
    view.revealed.delete(id);
  }

  function toggleCard(id) {
    if (view.open.has(id) || view.found.has(id)) {
      view.open.delete(id);
      view.found.delete(id);
      hidePassword(id); // свёрнутая карточка пароль не держит
    } else {
      view.open.add(id);
    }
    renderList();
  }

  function togglePassword(id) {
    if (view.revealed.has(id)) {
      hidePassword(id);
    } else {
      view.revealed.set(
        id,
        setTimeout(() => {
          view.revealed.delete(id);
          renderList();
        }, REVEAL_TIME)
      );
    }
    renderList();
  }

  function setFilter(filter) {
    view.filter = filter;
    render();
    $('main').scrollTop = 0;
  }

  async function archiveAccount(id, archived) {
    if (!(await apply((draft) => Core.setArchived(draft, id, archived)))) return;
    view.selected.delete(id);
    renderList();
    toast(archived ? 'Аккаунт перемещён в архив' : 'Аккаунт восстановлен', {
      action: 'Отменить',
      onAction: () => apply((draft) => Core.setArchived(draft, id, !archived)),
    });
  }

  async function removeMember(accountId, memberId) {
    let removed = null;
    const done = await apply((draft) => {
      removed = Core.removeMember(draft, accountId, memberId);
    });
    if (!done || !removed) return;
    toast('Участник ' + removed.member.nickname + ' убран', {
      action: 'Вернуть',
      onAction: () => apply((draft) => Core.restoreMember(draft, accountId, removed)),
    });
  }

  /* ───────────────────────── Поля дат ─────────────────────────
     Дата набирается как ДД.ММ.ГГГГ — так же, как показана во всём разделе, на каком бы языке
     ни был браузер. Значок рядом открывает календарь. */

  /** Значение поля: «ГГГГ-ММ-ДД», пустая строка, если поле пустое, и null, если набрано не то. */
  const dateOf = (input) => Core.readDate(input.value);

  function setDate(input, date) {
    input.value = date ? fmt(date) : '';
  }

  function wireDate(box) {
    const text = box.querySelector('.input');
    const native = box.querySelector('.date__native');

    // Ушли из поля — дата приводится к общему виду: «6.10.26» → «06.10.2026».
    text.addEventListener('blur', () => {
      const date = dateOf(text);
      if (date) setDate(text, date);
    });
    box.querySelector('.date__pick').addEventListener('click', () => {
      native.value = dateOf(text) || today;
      try {
        native.showPicker();
      } catch (error) {
        text.focus(); // календарь недоступен — дату можно набрать
      }
    });
    native.addEventListener('change', () => {
      if (!Core.isDate(native.value)) return;
      setDate(text, native.value);
      text.dispatchEvent(new Event('input', { bubbles: true }));
      text.focus();
    });
  }

  /* ───────────────────────── Окна ───────────────────────── */

  function setErrors(errors) {
    for (const [id, text] of Object.entries(errors)) {
      $(id).textContent = text;
      $(id).hidden = !text;
    }
  }

  function markInvalid(input, invalid) {
    if (invalid) input.setAttribute('aria-invalid', 'true');
    else input.removeAttribute('aria-invalid');
  }

  /**
   * Форма не сохранилась. Если дело в самих данных (аккаунт удалили в другом окне, мест уже нет),
   * окно закрывается с сообщением. Если не удалась запись в хранилище — остаётся открытым,
   * чтобы набранное не пропало.
   */
  function formFailed(dialogId, errorId, error) {
    if (error && FAILURES[error.code]) {
      $(dialogId).close();
      toast(explain(error));
    } else {
      setErrors({ [errorId]: explain(error) });
    }
  }

  /* Окно аккаунта: добавление и правка */

  const accountForm = { id: '', auto: true };

  function showFormPassword(shown) {
    $('inv-acc-password').type = shown ? 'text' : 'password';
    const toggle = $('inv-acc-password-toggle');
    toggle.textContent = shown ? 'Скрыть' : 'Показать';
    toggle.setAttribute('aria-pressed', String(shown));
  }

  /** Пока окончание равно «покупка + месяц», оно идёт за датой покупки само. */
  function paintAccountEnd() {
    $('inv-acc-hint').textContent = accountForm.auto
      ? 'Окончание считается само: дата покупки + 1 месяц. Его можно поправить вручную.'
      : 'Окончание отличается от «дата покупки + 1 месяц».';
    $('inv-acc-auto').hidden = accountForm.auto || !dateOf($('inv-acc-start'));
  }

  function paintDuplicate() {
    const email = $('inv-acc-email').value.trim().toLowerCase();
    const twin = email !== '' && state.accounts.some((account) => account.id !== accountForm.id && account.email.toLowerCase() === email);
    $('inv-acc-dup').hidden = !twin;
  }

  function clearAccountErrors() {
    setErrors({ 'inv-acc-email-error': '', 'inv-acc-password-error': '', 'inv-acc-dates-error': '', 'inv-account-error': '' });
    for (const id of ['inv-acc-email', 'inv-acc-password', 'inv-acc-start', 'inv-acc-end']) markInvalid($(id), false);
  }

  function openAccount(account) {
    const start = account ? account.subscriptionStartDate : today;
    const end = account ? account.subscriptionEndDate : Core.addMonths(today, 1);
    accountForm.id = account ? account.id : '';
    accountForm.auto = end === Core.addMonths(start, 1);

    $('inv-account-title').textContent = account ? 'Редактировать аккаунт' : 'Новый аккаунт';
    $('inv-acc-email').value = account ? account.email : '';
    $('inv-acc-password').value = account ? account.password : '';
    setDate($('inv-acc-start'), start);
    setDate($('inv-acc-end'), end);
    $('inv-acc-label').value = account ? account.label : '';
    $('inv-account-save').disabled = false;
    showFormPassword(false);
    clearAccountErrors();
    paintAccountEnd();
    paintDuplicate();
    $('inv-account').showModal();
  }

  async function saveAccount(event) {
    event.preventDefault();
    const save = $('inv-account-save');
    if (save.disabled) return;

    const start = dateOf($('inv-acc-start'));
    const end = dateOf($('inv-acc-end'));
    const input = {
      label: $('inv-acc-label').value,
      email: $('inv-acc-email').value,
      password: $('inv-acc-password').value,
      subscriptionStartDate: start || '',
      subscriptionEndDate: end || '', // пустое окончание посчитается само
    };
    const errors = Core.checkAccount(input).errors;
    // Набрано, но не дата — это ошибка, а не «не заполнено»: молча считать окончание за человека нельзя.
    if (start === null) errors.start = 'invalid';
    if (end === null) errors.end = 'invalid';

    const emailText = { missing: 'Укажите email аккаунта', invalid: 'Проверьте email: он должен быть вида name@example.com' };
    const passwordText = { missing: 'Укажите пароль', long: 'Пароль слишком длинный' };
    const startText = { missing: 'Укажите дату покупки', invalid: 'Дата покупки — в виде ДД.ММ.ГГГГ, например ' + fmt(today) };
    const endText = {
      invalid: 'Дата окончания — в виде ДД.ММ.ГГГГ, например ' + fmt(Core.addMonths(today, 1)),
      'before-start': 'Дата окончания раньше даты покупки',
    };
    setErrors({
      'inv-acc-email-error': emailText[errors.email] || '',
      'inv-acc-password-error': passwordText[errors.password] || '',
      'inv-acc-dates-error': startText[errors.start] || endText[errors.end] || '',
      'inv-account-error': '',
    });
    markInvalid($('inv-acc-email'), Boolean(errors.email));
    markInvalid($('inv-acc-password'), Boolean(errors.password));
    markInvalid($('inv-acc-start'), Boolean(errors.start));
    markInvalid($('inv-acc-end'), Boolean(errors.end));
    const wrong = ['email', 'password', 'start', 'end'].find((field) => errors[field]);
    if (wrong) {
      $('inv-acc-' + wrong).focus();
      return;
    }

    save.disabled = true; // второй щелчок не создаст второй аккаунт
    const id = accountForm.id;
    try {
      const account = await mutate((draft) =>
        id ? Core.updateAccount(draft, id, input, today, Date.now()) : Core.createAccount(draft, input, Date.now())
      );
      $('inv-account').close();
      if (id) {
        toast('Изменения сохранены');
      } else {
        showAccount(account.id);
        toast('Аккаунт добавлен: подписка до ' + fmt(account.subscriptionEndDate));
      }
    } catch (error) {
      formFailed('inv-account', 'inv-account-error', error);
    } finally {
      save.disabled = false;
    }
  }

  /* Окно участника */

  const memberForm = { accountId: '', memberId: '', auto: true };

  function clearMemberErrors() {
    setErrors({ 'inv-mem-nick-error': '', 'inv-mem-dates-error': '', 'inv-member-error': '' });
    for (const id of ['inv-mem-nick', 'inv-mem-start', 'inv-mem-end']) markInvalid($(id), false);
  }

  function openMember(accountId, memberId) {
    const account = findAccount(accountId);
    if (!account) return;
    const member = memberId ? account.members.find((item) => item.id === memberId) : null;
    if (memberId && !member) return;
    if (!member && account.members.length >= Core.MAX_MEMBERS) {
      toast(FAILURES['members-full']);
      return;
    }

    // Новый участник по умолчанию заходит сегодня и платит за месяц.
    const start = member ? member.startDate : today;
    const end = member ? member.endDate : Core.addMonths(today, 1);
    memberForm.accountId = accountId;
    memberForm.memberId = member ? member.id : '';
    memberForm.auto = start !== '' && end === Core.addMonths(start, 1);

    $('inv-member-title').textContent = member ? 'Изменить участника' : 'Новый участник';
    $('inv-member-account').textContent = account.email;
    $('inv-mem-nick').value = member ? member.nickname : '';
    setDate($('inv-mem-start'), start);
    setDate($('inv-mem-end'), end);
    $('inv-member-save').disabled = false;
    clearMemberErrors();
    $('inv-member').showModal();
  }

  async function saveMember(event) {
    event.preventDefault();
    const save = $('inv-member-save');
    if (save.disabled) return;

    const start = dateOf($('inv-mem-start'));
    const end = dateOf($('inv-mem-end'));
    const input = { nickname: $('inv-mem-nick').value, startDate: start || '', endDate: end || '' };
    const errors = Core.checkMember(input).errors;
    if (start === null) errors.start = 'invalid';
    if (end === null) errors.end = 'invalid';

    const startText = { invalid: 'Начало доступа — в виде ДД.ММ.ГГГГ, например ' + fmt(today) };
    const endText = {
      missing: 'Укажите, до какой даты оплачено',
      invalid: '«Оплачено до» — в виде ДД.ММ.ГГГГ, например ' + fmt(Core.addMonths(today, 1)),
      'before-start': 'Дата «Оплачено до» раньше начала доступа',
    };
    setErrors({
      'inv-mem-nick-error': errors.nickname ? 'Укажите ник или имя участника' : '',
      'inv-mem-dates-error': startText[errors.start] || endText[errors.end] || '',
      'inv-member-error': '',
    });
    markInvalid($('inv-mem-nick'), Boolean(errors.nickname));
    markInvalid($('inv-mem-start'), Boolean(errors.start));
    markInvalid($('inv-mem-end'), Boolean(errors.end));
    const wrong = ['nickname', 'start', 'end'].find((field) => errors[field]);
    if (wrong) {
      $({ nickname: 'inv-mem-nick', start: 'inv-mem-start', end: 'inv-mem-end' }[wrong]).focus();
      return;
    }

    save.disabled = true; // второй щелчок не добавит второго участника
    const accountId = memberForm.accountId;
    const memberId = memberForm.memberId;
    try {
      await mutate((draft) =>
        memberId ? Core.updateMember(draft, accountId, memberId, input) : Core.addMember(draft, accountId, input, Date.now())
      );
      $('inv-member').close();
      toast(memberId ? 'Изменения сохранены' : 'Участник добавлен');
    } catch (error) {
      formFailed('inv-member', 'inv-member-error', error);
    } finally {
      save.disabled = false;
    }
  }

  /* Окно подтверждения — одно на все случаи */

  let confirmRun = null;
  let confirmOpenedAt = 0;

  /**
   * options.run делает дело и возвращает:
   *   false — окно остаётся открытым (нужно что-то поправить);
   *   функцию — её вызовут после закрытия окна (сообщение внизу видно только тогда).
   */
  function ask(options) {
    $('inv-confirm-title').textContent = options.title;
    $('inv-confirm-body').replaceChildren(...options.body.filter(Boolean));
    const ok = $('inv-confirm-ok');
    ok.textContent = options.confirm;
    ok.className = options.danger ? 'btn btn--danger' : 'btn btn--ink';
    ok.disabled = false;
    confirmRun = options.run;
    confirmOpenedAt = Date.now();
    $('inv-confirm').showModal();
    // У необратимых действий под рукой «Отмена», у остальных — подтверждение.
    if (!options.danger) ok.focus();
  }

  async function submitConfirm(event) {
    event.preventDefault();
    const ok = $('inv-confirm-ok');
    const run = confirmRun;
    if (!run || ok.disabled) return;
    if (Date.now() - confirmOpenedAt < DOUBLE_CLICK) return; // двойной щелчок по кнопке, открывшей окно

    ok.disabled = true; // повторный щелчок, пока идёт запись, ничего не запустит
    let after;
    try {
      after = await run();
    } catch (error) {
      after = () => toast(explain(error));
    }
    if (after === false) {
      ok.disabled = false;
      return;
    }
    $('inv-confirm').close();
    if (typeof after === 'function') after();
  }

  /** Поле «день оплаты» для окна подтверждения. Оплата не может быть в будущем. */
  function dateField(id, label, initial) {
    const input = el('input', {
      class: 'input',
      id: id,
      type: 'text',
      inputmode: 'numeric',
      autocomplete: 'off',
      spellcheck: 'false',
      maxlength: '10',
      placeholder: 'ДД.ММ.ГГГГ',
    });
    setDate(input, initial);
    const pick = el('button', {
      class: 'date__pick',
      type: 'button',
      tabindex: '-1',
      title: 'Календарь',
      'aria-label': 'Выбрать дату в календаре',
    });
    pick.append(icon('calendar'));
    const box = el('div', { class: 'date' }, [
      input,
      el('input', { class: 'date__native', type: 'date', tabindex: '-1', 'aria-hidden': 'true', min: '2000-01-01', max: today }),
      pick,
    ]);
    wireDate(box);
    const read = () => dateOf(input);
    return {
      input: input,
      node: el('div', { class: 'field' }, [el('label', { class: 'label', for: id, text: label }), box]),
      value: read,
      valid: () => Boolean(read()) && read() <= today,
    };
  }

  const accountTitle = (account) => (account.label ? account.email + ' — ' + account.label : account.email);

  /* Продление */

  function askRenew(id) {
    const account = findAccount(id);
    if (!account) return;
    const seenEnd = account.subscriptionEndDate; // срок, который человек видит, когда подтверждает
    const ended = Core.diffDays(seenEnd, today) < 0;
    const date = dateField('inv-renew-date', 'Дата оплаты', today);
    const preview = el('p', { class: 'modal__text', 'aria-live': 'polite' });

    const paint = () => {
      markInvalid(date.input, !date.valid());
      if (!date.valid()) {
        preview.textContent = 'Укажите дату оплаты в виде ДД.ММ.ГГГГ — не позже сегодняшнего дня.';
        return;
      }
      const plan = Core.planRenewal(account, ended ? date.value() : today);
      preview.textContent = plan.extended
        ? 'Сейчас подписка действует до ' + fmt(seenEnd) + '. После продления — до ' + fmt(plan.endDate) + '.'
        : 'Подписка закончилась ' + fmt(seenEnd) + ', поэтому новый месяц считается со дня оплаты: до ' + fmt(plan.endDate) + '.';
    };
    date.input.addEventListener('input', paint);
    paint();

    const renewedToday = account.renewalHistory.some(
      (entry) => (entry.type === 'renew' || entry.type === 'rebuy') && Core.today(new Date(entry.at)) === today
    );

    ask({
      title: 'Продлить подписку ещё на 1 месяц?',
      confirm: 'Продлить',
      body: [
        el('p', { class: 'modal__text modal__text--soft', text: accountTitle(account) }),
        ended ? date.node : null, // у действующей подписки день оплаты на срок не влияет
        preview,
        renewedToday
          ? el('p', { class: 'modal__text modal__text--warn', text: 'Сегодня этот аккаунт уже продлевали. Продлить ещё на месяц?' })
          : null,
      ],
      run: async () => {
        if (ended && !date.valid()) {
          paint();
          date.input.focus();
          return false;
        }
        const result = await mutate((draft) =>
          Core.renewAccount(
            draft,
            id,
            { date: ended ? date.value() : today, expectedEndDate: seenEnd, type: 'renew' },
            Date.now()
          )
        );
        return () =>
          toast('Подписка продлена до ' + fmt(result.endDate) + '.', {
            action: 'Отменить',
            onAction: () => apply((draft) => Core.undoRenewals(draft, [result.undo])),
          });
      },
    });
  }

  /* Повторная покупка для отмеченных истёкших аккаунтов */

  function askRebuy() {
    const picked = Array.from(view.selected)
      .map(findAccount)
      .filter(Boolean)
      .map((account) => ({ account: account, seenEnd: account.subscriptionEndDate }));
    if (!picked.length) return;

    const count = picked.length;
    const date = dateField('inv-rebuy-date', 'Дата покупки', today);
    const list = el('ul', { class: 'modal__list' });

    const paint = () => {
      const valid = date.valid();
      markInvalid(date.input, !valid);
      list.replaceChildren(
        ...picked.map((item) =>
          el('li', {}, [
            item.account.email,
            el('span', { text: valid ? ' — до ' + fmt(Core.planRenewal(item.account, date.value()).endDate) : '' }),
          ])
        )
      );
    };
    date.input.addEventListener('input', paint);
    paint();

    ask({
      title: 'Купить подписку заново',
      confirm: 'Подтвердить',
      body: [
        el('p', {
          class: 'modal__text',
          text: 'Вы выбрали ' + count + ' ' + accountsWord(count) + '. Подтвердить повторное использование?',
        }),
        date.node,
        list,
      ],
      run: async () => {
        if (!date.valid()) {
          date.input.focus();
          return false;
        }
        const items = picked.map((item) => ({ id: item.account.id, expectedEndDate: item.seenEnd }));
        const results = await mutate((draft) => Core.rebuyAccounts(draft, items, date.value(), Date.now()));
        view.selected.clear();
        renderList();
        const ends = new Set(results.map((result) => result.endDate));
        const until = ends.size === 1 ? ' Подписка до ' + fmt(results[0].endDate) + '.' : '';
        return () =>
          toast('Снова в активных: ' + count + ' ' + accountsWord(count) + '.' + until, {
            action: 'Отменить',
            onAction: () => apply((draft) => Core.undoRenewals(draft, results.map((result) => result.undo))),
          });
      },
    });
  }

  /* Удаление */

  function askDelete(id) {
    const account = findAccount(id);
    if (!account) return;
    const members = account.members.length;
    ask({
      title: 'Удалить аккаунт?',
      confirm: 'Удалить',
      danger: true,
      body: [
        el('p', { class: 'modal__text modal__text--soft', text: accountTitle(account) }),
        el('p', {
          class: 'modal__text',
          text:
            'Вместе с аккаунтом удалятся ' +
            (members ? members + ' ' + plural(members, 'участник', 'участника', 'участников') + ' и ' : '') +
            'история продлений. Если аккаунт ещё пригодится, его лучше убрать в архив.',
        }),
      ],
      run: async () => {
        const removed = await mutate((draft) => Core.deleteAccount(draft, id));
        view.open.delete(id);
        view.found.delete(id);
        view.selected.delete(id);
        hidePassword(id);
        return () =>
          toast('Аккаунт удалён', {
            action: 'Вернуть',
            onAction: () => apply((draft) => Core.restoreAccount(draft, removed)),
          });
      },
    });
  }

  /* История */

  function openHistory(id) {
    const account = findAccount(id);
    if (!account) return;
    $('inv-history-account').textContent = accountTitle(account);
    // Свежие записи сверху.
    $('inv-history-list').replaceChildren(
      ...account.renewalHistory
        .slice()
        .reverse()
        .map((entry) =>
          el('li', { class: 'history__item' }, [
            el('span', { class: 'history__date', text: fmt(entry.date) }),
            el('span', { text: ENTRY_NAME[entry.type] }),
            el('span', { class: 'history__to', text: 'до ' + fmt(entry.endDate) }),
          ])
        )
    );
    $('inv-history').showModal();
  }

  /* ───────────────────────── Экспорт и импорт ───────────────────────── */

  function exportInvites() {
    if (!state.accounts.length) {
      toast('Экспортировать пока нечего: аккаунтов нет');
      return;
    }
    const data = JSON.stringify(Core.exportData(state, Date.now()), null, 2);
    const link = el('a', {
      href: 'data:application/json;charset=utf-8,' + encodeURIComponent(data),
      download: 'tydosoft-invites-' + today + '.json',
    });
    document.body.append(link);
    link.click();
    link.remove();
    toast('Экспорт готов. В файле пароли в открытом виде — храните его в надёжном месте.');
  }

  function startImport() {
    if (!inWindow()) {
      // Во всплывающем окне выбор файла ненадёжен: в части браузеров оно закрывается вместе с диалогом,
      // и импорт молча срывается. Поэтому импорт идёт в отдельном окне расширения.
      chrome.windows.create(
        { url: chrome.runtime.getURL('popup.html?window&tab=params&import'), type: 'popup', width: 416, height: 680 },
        () => window.close()
      );
      return;
    }
    const file = $('invites-file');
    file.value = ''; // чтобы тот же файл можно было выбрать повторно
    file.click();
  }

  async function readImport(file) {
    if (file.size > IMPORT_MAX_BYTES) {
      toast('Файл слишком большой для экспорта раздела «Инвайты»');
      return;
    }
    let content;
    try {
      content = await file.text();
    } catch (error) {
      toast('Файл не удалось прочитать');
      return;
    }
    const parsed = Core.parseImport(content);
    if (!parsed.ok) {
      toast(IMPORT_FAILURES[parsed.code] || IMPORT_FAILURES['wrong-format']);
      return;
    }
    askImport(parsed);
  }

  function askImport(parsed) {
    const total = parsed.accounts.length;
    const counted = Core.countImport(state, parsed.accounts);
    const replace = el('input', { class: 'check__input', type: 'checkbox', id: 'inv-import-replace' });

    ask({
      title: 'Импортировать данные?',
      confirm: 'Импортировать',
      body: [
        el('p', {
          class: 'modal__text',
          text:
            'В файле ' +
            total +
            ' ' +
            accountsWord(total) +
            ': новых — ' +
            counted.fresh +
            ', уже есть в расширении — ' +
            counted.same +
            '.',
        }),
        el('p', {
          class: 'modal__text',
          text: 'Новые аккаунты добавятся к списку. Те, что уже есть, останутся как сейчас; удалено ничего не будет.',
        }),
        counted.same > 0
          ? el('label', { class: 'check' }, [replace, el('span', { text: 'Заменить совпавшие аккаунты данными из файла' })])
          : null,
        parsed.rejected > 0
          ? el('p', {
              class: 'modal__text modal__text--warn',
              text: 'Не прочитано записей: ' + parsed.rejected + ' — в них нет email или дат.',
            })
          : null,
      ],
      run: async () => {
        const result = await mutate((draft) => Core.applyImport(draft, parsed, { replace: replace.checked }));
        const done = [];
        if (result.added) done.push('добавлено ' + result.added);
        if (result.updated) done.push('заменено ' + result.updated);
        if (result.skipped) done.push('оставлено как было ' + result.skipped);
        return () => {
          toast('Импорт завершён: ' + done.join(', ') + '.');
          showTab('invites');
        };
      },
    });
  }

  /* ───────────────────────── Сегодняшний день ─────────────────────────
     Статусы считаются от сегодняшней даты. Если окно открыто, когда день сменился,
     список пересчитывается сам. */

  function refreshDay() {
    const now = Core.today();
    if (now === today) return;
    today = now;
    render();
  }

  function watchMidnight() {
    const now = new Date();
    const next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 1);
    setTimeout(() => {
      refreshDay();
      watchMidnight();
    }, Math.max(1000, next.getTime() - now.getTime()));
  }

  /* ───────────────────────── События ───────────────────────── */

  function onListClick(event) {
    const node = event.target.closest('[data-inv]');
    if (!node || node.disabled || node.type === 'checkbox') return;
    const card = node.closest('.acc');
    const id = card ? card.dataset.id : '';
    const action = node.dataset.inv;

    if (action === 'toggle') toggleCard(id);
    else if (action === 'reveal') togglePassword(id);
    else if (action === 'copy-email' && findAccount(id)) copyText(findAccount(id).email, 'Email скопирован');
    else if (action === 'copy-password' && findAccount(id)) copyText(findAccount(id).password, 'Пароль скопирован');
    else if (action === 'renew') askRenew(id);
    else if (action === 'edit' && findAccount(id)) openAccount(findAccount(id));
    else if (action === 'history') openHistory(id);
    else if (action === 'archive') archiveAccount(id, true);
    else if (action === 'restore') archiveAccount(id, false);
    else if (action === 'delete') askDelete(id);
    else if (action === 'member-add') openMember(id, '');
    else if (action === 'member-edit') openMember(id, node.dataset.member);
    else if (action === 'member-remove') removeMember(id, node.dataset.member);
    else if (action === 'rebuy') askRebuy();
    else if (action === 'show-all') setFilter('all');
    else if (action === 'show-archive') setFilter('archived');
    else if (action === 'leave-archive') setFilter('all');
  }

  function onListChange(event) {
    const node = event.target;
    if (node.id === 'inv-sort') {
      const sort = node.value;
      apply((draft) => {
        draft.prefs.sort = sort;
      });
    } else if (node.dataset.inv === 'pick') {
      const id = node.closest('.acc').dataset.id;
      if (node.checked) view.selected.add(id);
      else view.selected.delete(id);
      renderList();
    } else if (node.dataset.inv === 'pick-all') {
      // «Выбрать все» касается тех истёкших, что сейчас показаны.
      for (const card of $('inv-list').querySelectorAll('.acc[data-status="expired"]')) {
        if (!card.querySelector('[data-inv="pick"]')) continue;
        if (node.checked) view.selected.add(card.dataset.id);
        else view.selected.delete(card.dataset.id);
      }
      renderList();
    }
  }

  function bindForms() {
    $('inv-account-form').addEventListener('submit', saveAccount);
    $('inv-member-form').addEventListener('submit', saveMember);
    $('inv-confirm-form').addEventListener('submit', submitConfirm);
    $('inv-confirm').addEventListener('close', () => {
      confirmRun = null;
      $('inv-confirm-body').replaceChildren();
    });

    for (const button of document.querySelectorAll('.modal [data-close]')) {
      button.addEventListener('click', () => button.closest('dialog').close());
    }
    // Закрытое окно аккаунта не держит пароль в поле.
    $('inv-account').addEventListener('close', () => {
      $('inv-acc-password').value = '';
      showFormPassword(false);
    });

    $('inv-acc-password-toggle').addEventListener('click', () => {
      showFormPassword($('inv-acc-password').type === 'password');
      $('inv-acc-password').focus();
    });
    $('inv-acc-email').addEventListener('input', paintDuplicate);
    for (const box of document.querySelectorAll('.modal .date')) wireDate(box);

    $('inv-acc-start').addEventListener('input', () => {
      const start = dateOf($('inv-acc-start'));
      if (accountForm.auto && start) setDate($('inv-acc-end'), Core.addMonths(start, 1));
      paintAccountEnd();
    });
    $('inv-acc-end').addEventListener('input', () => {
      const start = dateOf($('inv-acc-start'));
      accountForm.auto = Boolean(start) && dateOf($('inv-acc-end')) === Core.addMonths(start, 1);
      paintAccountEnd();
    });
    $('inv-acc-auto').addEventListener('click', () => {
      setDate($('inv-acc-end'), Core.addMonths(dateOf($('inv-acc-start')), 1));
      accountForm.auto = true;
      paintAccountEnd();
      $('inv-acc-end').focus();
    });

    $('inv-mem-start').addEventListener('input', () => {
      const start = dateOf($('inv-mem-start'));
      if (memberForm.auto && start) setDate($('inv-mem-end'), Core.addMonths(start, 1));
    });
    $('inv-mem-end').addEventListener('input', () => {
      const start = dateOf($('inv-mem-start'));
      memberForm.auto = Boolean(start) && dateOf($('inv-mem-end')) === Core.addMonths(start, 1);
    });
  }

  function bind() {
    $('inv-add').addEventListener('click', () => openAccount(null));
    $('inv-add-first').addEventListener('click', () => openAccount(null));

    $('inv-tiles').addEventListener('change', (event) => {
      if (event.target.name === 'inv-filter') setFilter(event.target.value);
    });
    $('inv-search').addEventListener('input', (event) => {
      view.query = event.target.value;
      view.refind = true;
      renderList();
    });
    $('inv-list').addEventListener('click', onListClick);
    $('inv-list').addEventListener('change', onListChange);

    bindForms();

    // Параметры раздела
    $('invites-warn-days').addEventListener('input', (event) => {
      const text = event.target.value.trim();
      const days = Number(text);
      const valid = /^\d{1,2}$/.test(text) && days <= Core.MAX_WARN_DAYS;
      markInvalid(event.target, !valid);
      if (!valid) return;
      apply((draft) => {
        draft.prefs.warnDays = days;
      });
    });
    $('invites-warn-days').addEventListener('blur', renderSettings);
    $('invites-notify').addEventListener('change', (event) => {
      const notify = event.target.checked;
      apply((draft) => {
        draft.prefs.notify = notify;
      });
    });
    $('invites-export').addEventListener('click', exportInvites);
    $('invites-import').addEventListener('click', startImport);
    $('invites-file').addEventListener('change', (event) => {
      const file = event.target.files && event.target.files[0];
      if (file) readImport(file);
    });

    // Второе открытое окно подхватывает изменения первого.
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local' || !changes[KEY_INVITES]) return;
      const next = Core.normalizeState(changes[KEY_INVITES].newValue);
      if (JSON.stringify(next) === JSON.stringify(state)) return; // это наша собственная запись
      state = next;
      render();
    });

    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) refreshDay();
    });
    window.addEventListener('focus', refreshDay);
  }

  /* ───────────────────────── Запуск ───────────────────────── */

  async function init() {
    buildTiles();
    bind();

    const saved = await storage.get(KEY_INVITES);
    state = Core.normalizeState(saved[KEY_INVITES]);
    render();
    watchMidnight();

    // Окно открыли ради импорта — подводим к кнопке: сам выбор файла может начать только щелчок.
    if (new URLSearchParams(location.search).has('import')) {
      $('invites-settings').scrollIntoView({ block: 'start' });
      $('invites-import').focus({ preventScroll: true });
      toast('Нажмите «Импорт данных» и выберите файл экспорта');
    }
  }

  init();
})();
