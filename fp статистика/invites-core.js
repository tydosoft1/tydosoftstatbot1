/*
 * Инвайты: аккаунты с семейной подпиской и их участники.
 * Чистые функции без доступа к странице и хранилищу: их можно запускать в окне расширения,
 * в фоновом скрипте и в Node.
 *
 * Дата здесь — день календаря без времени: строка «ГГГГ-ММ-ДД» по местным часам пользователя.
 * Расчёты идут по номеру дня, поэтому часовой пояс и перевод часов на них не влияют.
 *
 * Статус аккаунта и участника не хранится: он каждый раз считается от сегодняшнего дня.
 * Поэтому «Активные» и «Истёкшие» — один и тот же список аккаунтов, только отобранный по сроку.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else {
    root.InvitesCore = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const VERSION = 1; // версия формата данных в хранилище и в файле экспорта
  const MAX_MEMBERS = 5; // мест в одной семейной подписке
  const DEFAULT_WARN_DAYS = 7; // за сколько дней до конца статус становится «Скоро истекает»
  const MAX_WARN_DAYS = 60;
  const MIN_YEAR = 2000;
  const MAX_YEAR = 2100;
  const DAY_MS = 86400000;

  const FILTERS = ['all', 'active', 'soon', 'expired', 'free', 'full', 'archived'];
  const SORTS = ['end', 'free', 'added'];
  const HISTORY_TYPES = ['purchase', 'renew', 'rebuy', 'edit'];
  const LIMITS = { label: 60, email: 254, password: 256, nickname: 64, accounts: 2000, history: 500 };

  const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  const ID_OK = /^[A-Za-z0-9_.:-]{1,64}$/;

  /* Этапы уведомлений: чем больше номер, тем ближе конец подписки. */
  const STAGE_NONE = 0;
  const STAGE_SOON = 1; // осталось не больше порога «Скоро истекает»
  const STAGE_LAST = 2; // заканчивается завтра или сегодня
  const STAGE_EXPIRED = 3;

  function isNum(n) {
    return typeof n === 'number' && Number.isFinite(n);
  }

  const two = (n) => String(n).padStart(2, '0');

  /** Ошибка с кодом: текст для человека подбирает страница. */
  function fail(code) {
    const error = new Error(code);
    error.code = code;
    throw error;
  }

  /** 1 день, 2 дня, 5 дней */
  function plural(n, one, few, many) {
    const tens = n % 100;
    const units = n % 10;
    if (tens > 10 && tens < 20) return many;
    if (units === 1) return one;
    if (units > 1 && units < 5) return few;
    return many;
  }

  /* ───────────────────────── Даты ───────────────────────── */

  /** Сколько дней в месяце; month — от 1 до 12. */
  function daysInMonth(year, month) {
    return new Date(Date.UTC(year, month, 0)).getUTCDate();
  }

  /** «2026-10-06» → { y, m, d }. Всё, что не является настоящим днём календаря, → null. */
  function parseDate(value) {
    if (typeof value !== 'string') return null;
    const found = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
    if (!found) return null;
    const y = Number(found[1]);
    const m = Number(found[2]);
    const d = Number(found[3]);
    if (y < MIN_YEAR || y > MAX_YEAR || m < 1 || m > 12 || d < 1 || d > daysInMonth(y, m)) return null;
    return { y: y, m: m, d: d };
  }

  const isDate = (value) => parseDate(value) !== null;

  const makeDate = (y, m, d) => String(y).padStart(4, '0') + '-' + two(m) + '-' + two(d);

  /**
   * Сегодняшний день по местным часам.
   * Через toISOString() его брать нельзя: там день по UTC, и ночью он отличается от местного.
   */
  function today(now) {
    const date = now instanceof Date ? now : new Date();
    return makeDate(date.getFullYear(), date.getMonth() + 1, date.getDate());
  }

  /** Номер дня от начала отсчёта. UTC здесь только как календарь без часов. */
  function dayNumber(value) {
    const p = parseDate(value);
    return p ? Math.round(Date.UTC(p.y, p.m - 1, p.d) / DAY_MS) : NaN;
  }

  /** Сколько дней от earlier до later; отрицательное число — later раньше. */
  const diffDays = (later, earlier) => dayNumber(later) - dayNumber(earlier);

  function addDays(value, count) {
    const n = dayNumber(value);
    if (!Number.isFinite(n)) return null;
    const date = new Date((n + count) * DAY_MS);
    return makeDate(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate());
  }

  /**
   * Прибавляет календарные месяцы, а не 30 дней.
   * Если в нужном месяце такого числа нет, берётся его последний день: 31.01 + 1 месяц = 28.02
   * (29.02 в високосный год).
   *
   * anchorDay — число месяца, на которое приходится оплата. Оно возвращает срок на место после
   * короткого месяца: 31.01 → 28.02 → 31.03, а не 28.03. Учитывается, только когда дата стоит на
   * последнем дне месяца, то есть действительно была урезана.
   */
  function addMonths(value, count, anchorDay) {
    const p = parseDate(value);
    if (!p) return null;
    const index = p.y * 12 + (p.m - 1) + count;
    const y = Math.floor(index / 12);
    const m = (index % 12) + 1;
    const cut = p.d === daysInMonth(p.y, p.m);
    const day = cut && Number.isInteger(anchorDay) && anchorDay > p.d && anchorDay <= 31 ? anchorDay : p.d;
    return makeDate(y, m, Math.min(day, daysInMonth(y, m)));
  }

  /** «2026-10-06» → «06.10.2026» */
  function formatDate(value) {
    const p = parseDate(value);
    return p ? two(p.d) + '.' + two(p.m) + '.' + p.y : '—';
  }

  /**
   * Дата, набранная руками, → «ГГГГ-ММ-ДД».
   * Понимает «06.10.2026», «6.10.26», «06/10/2026», «06102026», а ещё «2026-10-06».
   * Порядок всегда день, месяц, год — от языка браузера он не зависит.
   * Пустая строка → '', не дата → null.
   */
  function readDate(text) {
    const value = String(text === null || text === undefined ? '' : text).trim();
    if (value === '') return '';
    const whole = (y, m, d) => {
      const date = makeDate(y, m, d);
      return isDate(date) ? date : null;
    };

    let found = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(value);
    if (found) return whole(Number(found[1]), Number(found[2]), Number(found[3]));

    found = /^(\d{1,2})[.,/\-\s]+(\d{1,2})[.,/\-\s]+(\d{4}|\d{2})$/.exec(value) || /^(\d{2})(\d{2})(\d{4}|\d{2})$/.exec(value);
    if (!found) return null;
    const year = found[3].length === 2 ? 2000 + Number(found[3]) : Number(found[3]);
    return whole(year, Number(found[2]), Number(found[1]));
  }

  /* ───────────────────────── Статусы ───────────────────────── */

  /**
   * Статус по дате окончания: active, soon или expired.
   * День окончания — последний день подписки: «Истёк» наступает на следующий.
   */
  function statusOf(endDate, todayDate, warnDays) {
    const left = diffDays(endDate, todayDate);
    if (Number.isNaN(left) || left < 0) return 'expired';
    return left <= warnDays ? 'soon' : 'active';
  }

  /** Всё, что показывает карточка аккаунта: статус, остаток дней, места и участники. */
  function describeAccount(account, todayDate, warnDays) {
    const members = account.members.map((member) => ({
      member: member,
      status: statusOf(member.endDate, todayDate, warnDays),
      daysLeft: diffDays(member.endDate, todayDate),
    }));
    return {
      account: account,
      status: statusOf(account.subscriptionEndDate, todayDate, warnDays),
      daysLeft: diffDays(account.subscriptionEndDate, todayDate),
      used: account.members.length,
      free: MAX_MEMBERS - account.members.length,
      members: members,
      matched: [],
    };
  }

  /**
   * Сводка раздела. Архив в неё не входит.
   * Участники и свободные места считаются по действующим аккаунтам: место в истёкшей
   * подписке занять нельзя.
   */
  function summarize(state, todayDate) {
    const sum = { total: 0, active: 0, soon: 0, expired: 0, members: 0, freeSeats: 0, withFree: 0, full: 0, archived: 0 };
    for (const account of state.accounts) {
      if (account.archived) {
        sum.archived += 1;
        continue;
      }
      sum.total += 1;
      const status = statusOf(account.subscriptionEndDate, todayDate, state.prefs.warnDays);
      if (status === 'expired') {
        sum.expired += 1;
        continue;
      }
      sum.active += 1;
      if (status === 'soon') sum.soon += 1;
      const used = account.members.length;
      sum.members += used;
      sum.freeSeats += MAX_MEMBERS - used;
      if (used < MAX_MEMBERS) sum.withFree += 1;
      else sum.full += 1;
    }
    return sum;
  }

  /* ───────────────────────── Поиск, фильтры, сортировка ───────────────────────── */

  /** Подходит ли аккаунт под запрос. Возвращает список совпавших участников либо null. */
  function matchQuery(account, query) {
    if (!query) return [];
    const nickQuery = query.replace(/^@+/, '');
    const members = [];
    for (const member of account.members) {
      const nick = member.nickname.toLowerCase();
      // «@alex» и «alex» — один и тот же человек, как бы его ни записали.
      if (nick.includes(query) || (nickQuery && nick.replace(/^@+/, '').includes(nickQuery))) members.push(member.id);
    }
    const own = account.email.toLowerCase().includes(query) || account.label.toLowerCase().includes(query);
    return own || members.length ? members : null;
  }

  function passesFilter(filter, view) {
    if (filter === 'active') return view.status !== 'expired';
    if (filter === 'soon') return view.status === 'soon';
    if (filter === 'expired') return view.status === 'expired';
    if (filter === 'free') return view.status !== 'expired' && view.free > 0;
    if (filter === 'full') return view.status !== 'expired' && view.free === 0;
    return true;
  }

  const byText = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

  function sorter(sort, group) {
    const end = (a, b) => byText(a.account.subscriptionEndDate, b.account.subscriptionEndDate);
    const added = (a, b) => b.account.createdAt - a.account.createdAt;
    if (sort === 'free') return (a, b) => b.free - a.free || end(a, b) || added(a, b);
    if (sort === 'added') return (a, b) => added(a, b) || end(a, b);
    // По дате окончания: у действующих сверху те, что закончатся раньше, у истёкших — те, что закончились позже.
    if (group === 'active') return (a, b) => end(a, b) || added(a, b);
    return (a, b) => end(b, a) || added(a, b);
  }

  /**
   * Отбирает аккаунты для показа и делит их на группы: действующие, истёкшие и архив.
   * hidden — сколько совпадений поиска осталось за пределами выбранного фильтра и в архиве.
   */
  function selectAccounts(state, options, todayDate) {
    const filter = FILTERS.includes(options.filter) ? options.filter : 'all';
    const sort = SORTS.includes(options.sort) ? options.sort : 'end';
    const query = String(options.query || '').trim().toLowerCase();
    const groups = { active: [], expired: [], archived: [] };
    const hidden = { archived: 0, other: 0 };

    for (const account of state.accounts) {
      const matched = matchQuery(account, query);
      if (!matched) continue;
      const view = describeAccount(account, todayDate, state.prefs.warnDays);
      view.matched = matched;
      if (account.archived) {
        if (filter === 'archived') groups.archived.push(view);
        else if (query) hidden.archived += 1;
      } else if (filter === 'archived' || !passesFilter(filter, view)) {
        if (query) hidden.other += 1;
      } else {
        groups[view.status === 'expired' ? 'expired' : 'active'].push(view);
      }
    }
    for (const name of Object.keys(groups)) groups[name].sort(sorter(sort, name));
    return {
      groups: groups,
      hidden: hidden,
      count: groups.active.length + groups.expired.length + groups.archived.length,
    };
  }

  /* ───────────────────────── Данные: чтение и проверка ───────────────────────── */

  const cleanText = (value, max) => (typeof value === 'string' ? value : '').trim().slice(0, max);

  /** Новый случайный идентификатор, которого ещё нет в списке. */
  function freshId(items) {
    let id;
    do {
      id = Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
    } while (items.some((item) => item.id === id));
    return id;
  }

  /**
   * Идентификатор из сохранённых данных, если он годится и не занят, иначе запасной.
   * Запасной зависит только от места в списке, поэтому при каждом чтении получается одним и тем же.
   */
  function claimId(used, candidate, fallback) {
    let id = typeof candidate === 'string' && ID_OK.test(candidate) ? candidate : fallback;
    for (let n = 1; used.has(id); n += 1) id = n === 1 ? fallback : fallback + '-' + n;
    used.add(id);
    return id;
  }

  function defaultPrefs() {
    return { warnDays: DEFAULT_WARN_DAYS, notify: true, sort: 'end' };
  }

  function normalizePrefs(raw) {
    const prefs = defaultPrefs();
    if (raw === null || typeof raw !== 'object') return prefs;
    if (Number.isInteger(raw.warnDays) && raw.warnDays >= 0 && raw.warnDays <= MAX_WARN_DAYS) prefs.warnDays = raw.warnDays;
    if (typeof raw.notify === 'boolean') prefs.notify = raw.notify;
    if (SORTS.includes(raw.sort)) prefs.sort = raw.sort;
    return prefs;
  }

  function emptyState() {
    return { version: VERSION, accounts: [], prefs: defaultPrefs() };
  }

  /**
   * Число месяца, на которое приходится оплата.
   * Срок «покупка + месяц» держится за число покупки; дата окончания, поправленная руками, — за своё.
   */
  function resolveAnchor(startDate, endDate, previous) {
    if (endDate === addMonths(startDate, 1)) return parseDate(startDate).d;
    if (previous && previous.subscriptionEndDate === endDate) return previous.anchorDay;
    return parseDate(endDate).d;
  }

  function normalizeMember(raw, used, index) {
    if (raw === null || typeof raw !== 'object') return null;
    const nickname = cleanText(raw.nickname, LIMITS.nickname);
    if (!nickname || !isDate(raw.endDate)) return null;
    const startDate = isDate(raw.startDate) && raw.startDate <= raw.endDate ? raw.startDate : '';
    return {
      id: claimId(used, raw.id, 'mem-' + index),
      nickname: nickname,
      startDate: startDate,
      endDate: raw.endDate,
      createdAt: isNum(raw.createdAt) ? raw.createdAt : 0,
    };
  }

  function normalizeEntry(raw, used, index) {
    if (raw === null || typeof raw !== 'object') return null;
    if (!HISTORY_TYPES.includes(raw.type) || !isDate(raw.date) || !isDate(raw.endDate)) return null;
    return {
      id: claimId(used, raw.id, 'op-' + index),
      type: raw.type,
      date: raw.date,
      previousEndDate: isDate(raw.previousEndDate) ? raw.previousEndDate : '',
      endDate: raw.endDate,
      at: isNum(raw.at) ? raw.at : 0,
    };
  }

  /**
   * Приводит запись аккаунта к ожидаемому виду. Запись без единой верной даты отбрасывается,
   * остальное чинится: недостающая дата считается от второй, лишние участники не берутся.
   */
  function normalizeAccount(raw, used, index) {
    if (raw === null || typeof raw !== 'object') return null;
    let startDate = isDate(raw.subscriptionStartDate) ? raw.subscriptionStartDate : null;
    let endDate = isDate(raw.subscriptionEndDate) ? raw.subscriptionEndDate : null;
    if (!startDate && !endDate) return null;
    if (!endDate) endDate = addMonths(startDate, 1);
    if (!startDate) startDate = addMonths(endDate, -1);
    if (startDate > endDate) startDate = endDate;

    const createdAt = isNum(raw.createdAt) ? raw.createdAt : 0;

    const memberIds = new Set();
    const members = [];
    for (const item of Array.isArray(raw.members) ? raw.members : []) {
      if (members.length >= MAX_MEMBERS) break;
      const member = normalizeMember(item, memberIds, members.length);
      if (member) members.push(member);
    }

    const entryIds = new Set();
    let history = [];
    for (const item of Array.isArray(raw.renewalHistory) ? raw.renewalHistory : []) {
      const entry = normalizeEntry(item, entryIds, history.length);
      if (entry) history.push(entry);
    }
    if (history.length > LIMITS.history) history = history.slice(-LIMITS.history);
    if (!history.length) {
      history.push({
        id: claimId(entryIds, null, 'op-0'),
        type: 'purchase',
        date: startDate,
        previousEndDate: '',
        endDate: endDate,
        at: createdAt,
      });
    }

    const anchorOk = Number.isInteger(raw.anchorDay) && raw.anchorDay >= 1 && raw.anchorDay <= 31;
    return {
      id: claimId(used, raw.id, 'acc-' + index),
      label: cleanText(raw.label, LIMITS.label),
      email: cleanText(raw.email, LIMITS.email),
      password: typeof raw.password === 'string' ? raw.password.slice(0, LIMITS.password) : '',
      subscriptionStartDate: startDate,
      subscriptionEndDate: endDate,
      anchorDay: anchorOk ? raw.anchorDay : resolveAnchor(startDate, endDate, null),
      archived: raw.archived === true,
      createdAt: createdAt,
      members: members,
      renewalHistory: history,
    };
  }

  /** Сохранённые данные раздела → состояние, с которым работает страница. Испорченное не роняет чтение. */
  function normalizeState(raw) {
    const state = emptyState();
    if (raw === null || typeof raw !== 'object') return state;
    state.prefs = normalizePrefs(raw.prefs);
    const used = new Set();
    const list = Array.isArray(raw.accounts) ? raw.accounts : [];
    for (let index = 0; index < list.length; index += 1) {
      const account = normalizeAccount(list[index], used, index);
      if (account) state.accounts.push(account);
    }
    return state;
  }

  /**
   * Проверка формы аккаунта.
   * Пустая дата окончания считается сама: дата покупки + 1 календарный месяц.
   * Возвращает { ok, errors: { поле: код }, value }.
   */
  function checkAccount(input) {
    const errors = {};
    const value = {
      label: cleanText(input.label, LIMITS.label),
      email: cleanText(input.email, LIMITS.email),
      password: typeof input.password === 'string' ? input.password : '',
      subscriptionStartDate: typeof input.subscriptionStartDate === 'string' ? input.subscriptionStartDate : '',
      subscriptionEndDate: typeof input.subscriptionEndDate === 'string' ? input.subscriptionEndDate : '',
    };

    if (!value.email) errors.email = 'missing';
    else if (!EMAIL.test(value.email)) errors.email = 'invalid';

    if (!value.password) errors.password = 'missing';
    else if (value.password.length > LIMITS.password) errors.password = 'long';

    const startOk = isDate(value.subscriptionStartDate);
    if (!startOk) errors.start = value.subscriptionStartDate ? 'invalid' : 'missing';

    if (!value.subscriptionEndDate) {
      if (startOk) value.subscriptionEndDate = addMonths(value.subscriptionStartDate, 1);
    } else if (!isDate(value.subscriptionEndDate)) {
      errors.end = 'invalid';
    } else if (startOk && value.subscriptionEndDate < value.subscriptionStartDate) {
      errors.end = 'before-start';
    }

    return { ok: Object.keys(errors).length === 0, errors: errors, value: value };
  }

  /** Проверка формы участника: ник и дата «оплачено до» обязательны, дата начала — нет. */
  function checkMember(input) {
    const errors = {};
    const value = {
      nickname: cleanText(input.nickname, LIMITS.nickname),
      startDate: typeof input.startDate === 'string' ? input.startDate : '',
      endDate: typeof input.endDate === 'string' ? input.endDate : '',
    };

    if (!value.nickname) errors.nickname = 'missing';
    if (!isDate(value.endDate)) errors.end = value.endDate ? 'invalid' : 'missing';
    if (value.startDate && !isDate(value.startDate)) errors.start = 'invalid';
    else if (value.startDate && !errors.end && value.endDate < value.startDate) errors.end = 'before-start';

    return { ok: Object.keys(errors).length === 0, errors: errors, value: value };
  }

  /* ───────────────────────── Данные: изменения ─────────────────────────
     Каждая функция правит переданное состояние и бросает ошибку с кодом, если правка невозможна. */

  function findAccount(state, id) {
    const account = state.accounts.find((item) => item.id === id);
    if (!account) fail('account-missing');
    return account;
  }

  function findMember(account, id) {
    const member = account.members.find((item) => item.id === id);
    if (!member) fail('member-missing');
    return member;
  }

  function pushEntry(account, type, date, previousEndDate, endDate, at) {
    const entry = {
      id: freshId(account.renewalHistory),
      type: type,
      date: date,
      previousEndDate: previousEndDate,
      endDate: endDate,
      at: at,
    };
    account.renewalHistory.push(entry);
    if (account.renewalHistory.length > LIMITS.history) account.renewalHistory.shift();
    return entry;
  }

  function createAccount(state, input, at) {
    const checked = checkAccount(input);
    if (!checked.ok) fail('invalid-input');
    if (state.accounts.length >= LIMITS.accounts) fail('accounts-limit');
    const value = checked.value;
    const account = {
      id: freshId(state.accounts),
      label: value.label,
      email: value.email,
      password: value.password,
      subscriptionStartDate: value.subscriptionStartDate,
      subscriptionEndDate: value.subscriptionEndDate,
      anchorDay: resolveAnchor(value.subscriptionStartDate, value.subscriptionEndDate, null),
      archived: false,
      createdAt: at,
      members: [],
      renewalHistory: [],
    };
    pushEntry(account, 'purchase', value.subscriptionStartDate, '', value.subscriptionEndDate, at);
    state.accounts.push(account);
    return account;
  }

  /** Правка аккаунта. Если поменялись даты, это попадает в историю. */
  function updateAccount(state, id, input, todayDate, at) {
    const account = findAccount(state, id);
    const checked = checkAccount(input);
    if (!checked.ok) fail('invalid-input');
    const value = checked.value;
    const previousEndDate = account.subscriptionEndDate;
    const datesChanged =
      value.subscriptionStartDate !== account.subscriptionStartDate || value.subscriptionEndDate !== previousEndDate;

    account.anchorDay = resolveAnchor(value.subscriptionStartDate, value.subscriptionEndDate, account);
    account.label = value.label;
    account.email = value.email;
    account.password = value.password;
    account.subscriptionStartDate = value.subscriptionStartDate;
    account.subscriptionEndDate = value.subscriptionEndDate;
    if (datesChanged) pushEntry(account, 'edit', todayDate, previousEndDate, value.subscriptionEndDate, at);
    return account;
  }

  /** Удаляет аккаунт и возвращает его вместе с местом в списке — чтобы удаление можно было отменить. */
  function deleteAccount(state, id) {
    const index = state.accounts.findIndex((item) => item.id === id);
    if (index < 0) fail('account-missing');
    return { account: state.accounts.splice(index, 1)[0], index: index };
  }

  function restoreAccount(state, removed) {
    if (state.accounts.some((item) => item.id === removed.account.id)) return;
    state.accounts.splice(Math.min(removed.index, state.accounts.length), 0, removed.account);
  }

  /** Архив — ручная отметка. Срок и статус от неё не меняются. */
  function setArchived(state, id, archived) {
    const account = findAccount(state, id);
    account.archived = Boolean(archived);
    return account;
  }

  function addMember(state, accountId, input, at) {
    const account = findAccount(state, accountId);
    if (account.members.length >= MAX_MEMBERS) fail('members-full');
    const checked = checkMember(input);
    if (!checked.ok) fail('invalid-input');
    const member = {
      id: freshId(account.members),
      nickname: checked.value.nickname,
      startDate: checked.value.startDate,
      endDate: checked.value.endDate,
      createdAt: at,
    };
    account.members.push(member);
    return member;
  }

  function updateMember(state, accountId, memberId, input) {
    const member = findMember(findAccount(state, accountId), memberId);
    const checked = checkMember(input);
    if (!checked.ok) fail('invalid-input');
    member.nickname = checked.value.nickname;
    member.startDate = checked.value.startDate;
    member.endDate = checked.value.endDate;
    return member;
  }

  function removeMember(state, accountId, memberId) {
    const account = findAccount(state, accountId);
    const index = account.members.findIndex((item) => item.id === memberId);
    if (index < 0) fail('member-missing');
    return { member: account.members.splice(index, 1)[0], index: index };
  }

  function restoreMember(state, accountId, removed) {
    const account = findAccount(state, accountId);
    if (account.members.some((item) => item.id === removed.member.id)) return;
    if (account.members.length >= MAX_MEMBERS) fail('members-full');
    account.members.splice(Math.min(removed.index, account.members.length), 0, removed.member);
  }

  /* ───────────────────────── Продление ───────────────────────── */

  /**
   * Что станет со сроком после покупки ещё одного месяца; date — день оплаты.
   *
   * Подписка в этот день ещё действовала — месяц прибавляется к дате окончания:
   *   окончание 20.10, оплата 10.10 → 20.11.
   * Подписка уже закончилась — новый месяц считается со дня оплаты:
   *   окончание 20.09, оплата 06.10 → 06.11.
   */
  function planRenewal(account, date) {
    if (date <= account.subscriptionEndDate) {
      return {
        extended: true,
        startDate: account.subscriptionStartDate,
        endDate: addMonths(account.subscriptionEndDate, 1, account.anchorDay),
        anchorDay: account.anchorDay,
      };
    }
    return { extended: false, startDate: date, endDate: addMonths(date, 1), anchorDay: parseDate(date).d };
  }

  /**
   * Записывает покупку ещё одного месяца.
   * expectedEndDate — срок, который человек видел, когда подтверждал продление. Если он уже другой,
   * значит, продление записано раньше, и второй месяц случайно не добавится.
   * В ответе — запись для отмены.
   */
  function renewAccount(state, id, options, at) {
    const account = findAccount(state, id);
    if (!isDate(options.date)) fail('invalid-date');
    if (options.expectedEndDate && options.expectedEndDate !== account.subscriptionEndDate) fail('stale');

    const plan = planRenewal(account, options.date);
    const undo = {
      accountId: account.id,
      startDate: account.subscriptionStartDate,
      endDate: account.subscriptionEndDate,
      anchorDay: account.anchorDay,
      resultEndDate: plan.endDate,
      entryId: '',
    };
    const type = options.type === 'rebuy' && !plan.extended ? 'rebuy' : 'renew';
    const entry = pushEntry(account, type, options.date, account.subscriptionEndDate, plan.endDate, at);
    undo.entryId = entry.id;

    account.subscriptionStartDate = plan.startDate;
    account.subscriptionEndDate = plan.endDate;
    account.anchorDay = plan.anchorDay;
    return { account: account, entry: entry, extended: plan.extended, endDate: plan.endDate, undo: undo };
  }

  /**
   * Возвращает выбранные истёкшие аккаунты в работу: новая дата начала, новый срок, запись в истории.
   * items — [{ id, expectedEndDate }]. Сначала проверяются все, поэтому либо меняются все, либо ни один.
   */
  function rebuyAccounts(state, items, date, at) {
    if (!isDate(date)) fail('invalid-date');
    for (const item of items) {
      const account = findAccount(state, item.id);
      if (item.expectedEndDate && item.expectedEndDate !== account.subscriptionEndDate) fail('stale');
    }
    return items.map((item) => renewAccount(state, item.id, { date: date, type: 'rebuy' }, at));
  }

  /** Отмена продления: прежний срок возвращается, только если после продления аккаунт не меняли. */
  function undoRenewals(state, undos) {
    const pairs = undos.map((undo) => {
      const account = findAccount(state, undo.accountId);
      const last = account.renewalHistory[account.renewalHistory.length - 1];
      if (!last || last.id !== undo.entryId || account.subscriptionEndDate !== undo.resultEndDate) fail('stale');
      return { account: account, undo: undo };
    });
    for (const pair of pairs) {
      pair.account.renewalHistory.pop();
      pair.account.subscriptionStartDate = pair.undo.startDate;
      pair.account.subscriptionEndDate = pair.undo.endDate;
      pair.account.anchorDay = pair.undo.anchorDay;
    }
    return pairs.length;
  }

  /* ───────────────────────── Экспорт и импорт ───────────────────────── */

  /** Всё содержимое раздела одним объектом: аккаунты с паролями, участники, история, настройки. */
  function exportData(state, at) {
    return {
      app: 'tydosoft',
      kind: 'invites',
      version: VERSION,
      exportedAt: new Date(at).toISOString(),
      prefs: Object.assign({}, state.prefs),
      accounts: JSON.parse(JSON.stringify(state.accounts)),
    };
  }

  /** Запись из файла берётся, только если в ней есть email и обе даты, и они не противоречат друг другу. */
  function importableAccount(raw) {
    return (
      raw !== null &&
      typeof raw === 'object' &&
      cleanText(raw.email, LIMITS.email) !== '' &&
      isDate(raw.subscriptionStartDate) &&
      isDate(raw.subscriptionEndDate) &&
      raw.subscriptionStartDate <= raw.subscriptionEndDate
    );
  }

  /**
   * Разбирает файл экспорта и ничего не меняет.
   * Возвращает { ok: true, accounts, rejected, prefs, exportedAt } либо { ok: false, code }.
   */
  function parseImport(content) {
    let data;
    try {
      data = JSON.parse(content);
    } catch (error) {
      return { ok: false, code: 'not-json' };
    }
    if (data === null || typeof data !== 'object' || Array.isArray(data)) return { ok: false, code: 'wrong-format' };
    if (data.kind !== 'invites' || !Array.isArray(data.accounts) || !Number.isInteger(data.version) || data.version < 1) {
      return { ok: false, code: 'wrong-format' };
    }
    if (data.version > VERSION) return { ok: false, code: 'newer-version' };
    if (data.accounts.length === 0) return { ok: false, code: 'empty' };
    if (data.accounts.length > LIMITS.accounts) return { ok: false, code: 'too-many' };

    const used = new Set();
    const accounts = [];
    let rejected = 0;
    for (const raw of data.accounts) {
      // Вторая запись с тем же идентификатором — ошибка в файле: какая из двух верная, неизвестно.
      const repeated = raw !== null && typeof raw === 'object' && typeof raw.id === 'string' && used.has(raw.id);
      const account = !repeated && importableAccount(raw) ? normalizeAccount(raw, used, accounts.length) : null;
      if (!account) {
        rejected += 1;
        continue;
      }
      // У записи без своего идентификатора он будет новым, чтобы не совпасть с уже сохранёнными.
      if (typeof raw.id !== 'string' || raw.id !== account.id) {
        used.delete(account.id);
        account.id = freshId(accounts);
        used.add(account.id);
      }
      accounts.push(account);
    }
    if (!accounts.length) return { ok: false, code: 'no-valid' };

    return {
      ok: true,
      accounts: accounts,
      rejected: rejected,
      prefs: data.prefs !== null && typeof data.prefs === 'object' ? normalizePrefs(data.prefs) : null,
      exportedAt: typeof data.exportedAt === 'string' ? data.exportedAt : '',
    };
  }

  /** Сколько аккаунтов из файла новые, а сколько уже есть в расширении. */
  function countImport(state, accounts) {
    const known = new Set(state.accounts.map((account) => account.id));
    let same = 0;
    for (const account of accounts) {
      if (known.has(account.id)) same += 1;
    }
    return { fresh: accounts.length - same, same: same };
  }

  /**
   * Добавляет аккаунты из файла. Существующие не удаляются никогда; совпавшие заменяются
   * данными из файла, только если options.replace = true. Настройки берутся из файла лишь тогда,
   * когда раздел был пуст, то есть при восстановлении после переустановки.
   */
  function applyImport(state, parsed, options) {
    const replace = Boolean(options && options.replace);
    const wasEmpty = state.accounts.length === 0;
    const places = new Map();
    state.accounts.forEach((account, index) => places.set(account.id, index));

    const result = { added: 0, updated: 0, skipped: 0 };
    for (const account of parsed.accounts) {
      const copy = JSON.parse(JSON.stringify(account));
      if (places.has(copy.id)) {
        if (replace) {
          state.accounts[places.get(copy.id)] = copy;
          result.updated += 1;
        } else {
          result.skipped += 1;
        }
      } else if (state.accounts.length >= LIMITS.accounts) {
        result.skipped += 1;
      } else {
        places.set(copy.id, state.accounts.length);
        state.accounts.push(copy);
        result.added += 1;
      }
    }
    if (wasEmpty && parsed.prefs) state.prefs = normalizePrefs(parsed.prefs);
    return result;
  }

  /* ───────────────────────── Уведомления ───────────────────────── */

  function stageOf(daysLeft, warnDays) {
    if (daysLeft < 0) return STAGE_EXPIRED;
    if (daysLeft <= 1) return STAGE_LAST;
    if (daysLeft <= warnDays) return STAGE_SOON;
    return STAGE_NONE;
  }

  /**
   * О каких подписках пора сказать.
   *
   * marks — что уже учтено: { id аккаунта: { end, stage } }. Об одном сроке каждый этап
   * (скоро закончится, остался день, истекла) сообщается один раз.
   * Срок, который встречается впервые, запоминается молча: человек только что сам его вписал.
   * Аккаунты в архиве не беспокоят.
   *
   * mode: 'show'  — показать и запомнить;
   *       'defer' — сейчас показывать рано (ночь): ничего не запоминать, вернуться позже;
   *       'mute'  — уведомления выключены: запомнить молча.
   * Возвращает { due, marks }: due — что показать, marks — что сохранить.
   */
  function dueNotifications(state, todayDate, marks, mode) {
    const known = marks !== null && typeof marks === 'object' ? marks : {};
    const next = {};
    const due = [];

    for (const account of state.accounts) {
      const end = account.subscriptionEndDate;
      const daysLeft = diffDays(end, todayDate);
      const stage = stageOf(daysLeft, state.prefs.warnDays);
      const mark = known[account.id];
      const seen = mark !== null && typeof mark === 'object' && mark.end === end && Number.isInteger(mark.stage);

      if (!seen || account.archived || mode === 'mute') {
        next[account.id] = { end: end, stage: seen ? Math.max(stage, mark.stage) : stage };
      } else if (stage > mark.stage) {
        if (mode === 'show') {
          due.push({ id: account.id, name: account.email, endDate: end, daysLeft: daysLeft, stage: stage });
          next[account.id] = { end: end, stage: stage };
        } else {
          next[account.id] = { end: end, stage: mark.stage };
        }
      } else {
        next[account.id] = { end: end, stage: mark.stage };
      }
    }

    due.sort((a, b) => a.daysLeft - b.daysLeft || byText(a.name, b.name));
    return { due: due, marks: next };
  }

  function dueText(item) {
    if (item.daysLeft < 0) return 'истекла';
    if (item.daysLeft === 0) return 'закончится сегодня';
    if (item.daysLeft === 1) return 'закончится завтра';
    return 'закончится через ' + item.daysLeft + ' ' + plural(item.daysLeft, 'день', 'дня', 'дней');
  }

  /** Заголовок и текст уведомления. Несколько подписок идут одним уведомлением. */
  function notificationContent(due) {
    if (due.length === 1) {
      const item = due[0];
      return {
        title: item.daysLeft < 0 ? 'Подписка истекла' : 'Подписка скоро закончится',
        message: 'Подписка ' + item.name + ' ' + dueText(item) + '.',
      };
    }
    const shown = 4;
    const lines = due.slice(0, shown).map((item) => item.name + ' — ' + dueText(item));
    if (due.length > shown) lines.push('и ещё ' + (due.length - shown));
    return { title: 'Подписки требуют внимания: ' + due.length, message: lines.join('\n') };
  }

  return {
    VERSION: VERSION,
    MAX_MEMBERS: MAX_MEMBERS,
    DEFAULT_WARN_DAYS: DEFAULT_WARN_DAYS,
    MAX_WARN_DAYS: MAX_WARN_DAYS,
    FILTERS: FILTERS,
    SORTS: SORTS,
    LIMITS: LIMITS,

    plural: plural,

    parseDate: parseDate,
    isDate: isDate,
    today: today,
    daysInMonth: daysInMonth,
    dayNumber: dayNumber,
    diffDays: diffDays,
    addDays: addDays,
    addMonths: addMonths,
    formatDate: formatDate,
    readDate: readDate,

    statusOf: statusOf,
    describeAccount: describeAccount,
    summarize: summarize,
    selectAccounts: selectAccounts,

    emptyState: emptyState,
    normalizeState: normalizeState,
    normalizePrefs: normalizePrefs,
    checkAccount: checkAccount,
    checkMember: checkMember,

    createAccount: createAccount,
    updateAccount: updateAccount,
    deleteAccount: deleteAccount,
    restoreAccount: restoreAccount,
    setArchived: setArchived,
    addMember: addMember,
    updateMember: updateMember,
    removeMember: removeMember,
    restoreMember: restoreMember,

    planRenewal: planRenewal,
    renewAccount: renewAccount,
    rebuyAccounts: rebuyAccounts,
    undoRenewals: undoRenewals,

    exportData: exportData,
    parseImport: parseImport,
    countImport: countImport,
    applyImport: applyImport,

    dueNotifications: dueNotifications,
    notificationContent: notificationContent,
  };
});
