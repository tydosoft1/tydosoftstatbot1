'use strict';
/* global chrome, CATALOG, DEFAULT_RATES, FPCalc */

const { parseNum, compute } = FPCalc;

const RATES_URL = 'https://open.er-api.com/v6/latest/USD';
const KEY_SETTINGS = 'settings';
const KEY_ORDERS = 'orders';
const ORDERS_SHOWN = 200;
const RATES_MAX_AGE = 6 * 60 * 60 * 1000; // сами обновляем курсы не чаще раза в шесть часов
const DOUBLE_CLICK = 450; // мс: повторный щелчок по «Записать заказ» за это время — случайный
const TABS = ['calc', 'params', 'orders', 'invites']; // раздел «Инвайты» живёт в invites.js
const UNIT = { USD: '$', RUB: '₽', BYN: 'BYN', NGN: 'NGN' };
const NBSP = '\u00A0'; // неразрывный пробел
const MINUS = '\u2212'; // типографский минус

/* У каждого открытого окна свой номер: так окно отличает свои записи в хранилище от чужих. */
const INSTANCE = Math.random().toString(36).slice(2);

/* Все тарифы одним списком; ключ тарифа — «раздел/тариф». */
const PLANS = [];
for (const section of CATALOG) {
  for (const plan of section.plans) {
    PLANS.push({ key: section.id + '/' + plan.id, section: section, plan: plan });
  }
}

let settings = null;
let orders = [];
let ratesError = '';

/* ───────────────────────── Мелкие помощники ───────────────────────── */

const $ = (id) => document.getElementById(id);

function el(tag, props, children) {
  const node = document.createElement(tag);
  for (const [name, value] of Object.entries(props || {})) {
    if (name === 'class') node.className = value;
    else if (name === 'text') node.textContent = value;
    else if (name === 'dataset') Object.assign(node.dataset, value);
    else node.setAttribute(name, value);
  }
  if (children) node.append(...children);
  return node;
}

const findPlan = (key) => PLANS.find((p) => p.key === key) || PLANS[0];
const current = () => findPlan(settings.ui.plan);
const priceInputId = (entry) => 'price-' + entry.section.id + '-' + entry.plan.id;

function getPath(obj, path) {
  return path.split('.').reduce((node, key) => (node == null ? undefined : node[key]), obj);
}

function setPath(obj, path, value) {
  const keys = path.split('.');
  const last = keys.pop();
  keys.reduce((node, key) => node[key], obj)[last] = value;
}

/* ───────────────────────── Форматирование ───────────────────────── */

const numberFormats = new Map();

function num(value, maxFrac = 2, minFrac = 0) {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  const id = minFrac + ':' + maxFrac;
  if (!numberFormats.has(id)) {
    numberFormats.set(
      id,
      new Intl.NumberFormat('ru-RU', { minimumFractionDigits: minFrac, maximumFractionDigits: maxFrac })
    );
  }
  return numberFormats.get(id).format(value);
}

function money(value, currency, signed) {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  const cents = Math.round(value * 100);
  const sign = cents < 0 ? MINUS : signed && cents > 0 ? '+' : '';
  return sign + num(Math.abs(cents) / 100, 2, 2) + NBSP + UNIT[currency];
}

function percent(value) {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  const tenths = Math.round(value * 10);
  return (tenths < 0 ? MINUS : '') + num(Math.abs(tenths) / 10, 1, 1) + NBSP + '%';
}

/** Знак суммы после округления до копеек: plus, minus, zero или none (посчитать нельзя). */
function signOf(value) {
  if (value === null || value === undefined || !Number.isFinite(value)) return 'none';
  const cents = Math.round(value * 100);
  if (cents > 0) return 'plus';
  if (cents < 0) return 'minus';
  return 'zero';
}

const signClass = (sign) => (sign === 'plus' ? 'is-plus' : sign === 'minus' ? 'is-minus' : '');

/** 1 заказ, 2 заказа, 5 заказов */
function plural(n, one, few, many) {
  const tens = n % 100;
  const units = n % 10;
  if (tens > 10 && tens < 20) return many;
  if (units === 1) return one;
  if (units > 1 && units < 5) return few;
  return many;
}

/** «на 1 клиента», «на 10 клиентов», «на 2,5 клиента» */
function clientsWord(n) {
  if (!Number.isInteger(n)) return 'клиента';
  return n % 10 === 1 && n % 100 !== 11 ? 'клиента' : 'клиентов';
}

/** Число из сети → текст для поля ввода: 83.691 → «83,69» */
const toField = (value, digits) => value.toFixed(digits).replace('.', ',');

const stampFormat = new Intl.DateTimeFormat('ru-RU', {
  day: 'numeric',
  month: 'short',
  hour: '2-digit',
  minute: '2-digit',
});
const dayFormat = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'short' });
const rowFormat = new Intl.DateTimeFormat('ru-RU', {
  day: '2-digit',
  month: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
});

/* ───────────────────────── Хранилище ───────────────────────── */

const storage = {
  get(keys) {
    return new Promise((resolve) => chrome.storage.local.get(keys, (items) => resolve(items || {})));
  },
  set(items) {
    return new Promise((resolve, reject) => {
      chrome.storage.local.set(items, () => {
        const error = chrome.runtime.lastError;
        if (error) reject(new Error(error.message));
        else resolve();
      });
    });
  },
};

function defaultSettings() {
  const plans = {};
  for (const entry of PLANS) {
    plans[entry.key] = { priceNgn: entry.plan.priceNgn, sale: '', saleCurrency: 'USD' };
  }
  return {
    rates: Object.assign({}, DEFAULT_RATES),
    plans: plans,
    costs: {
      card: { amount: '', currency: 'USD', clients: '1' },
      proxy: { amount: '', currency: 'USD', clients: '1' },
      fee: '',
    },
    ui: { plan: PLANS[0].key },
  };
}

/** Сохранённое накладывается на значения по умолчанию: новые тарифы и поля не теряются. */
function merge(defaults, saved) {
  if (saved === null || typeof saved !== 'object') return defaults;
  const out = {};
  for (const key of Object.keys(defaults)) {
    const base = defaults[key];
    const value = saved[key];
    if (base !== null && typeof base === 'object') out[key] = merge(base, value);
    else out[key] = typeof value === typeof base ? value : base;
  }
  return out;
}

function normalize(saved) {
  const result = merge(defaultSettings(), saved);
  if (!PLANS.some((p) => p.key === result.ui.plan)) result.ui.plan = PLANS[0].key;
  for (const key of Object.keys(result.plans)) {
    if (result.plans[key].saleCurrency !== 'RUB') result.plans[key].saleCurrency = 'USD';
  }
  for (const item of [result.costs.card, result.costs.proxy]) {
    if (!UNIT[item.currency]) item.currency = 'USD';
  }
  if (result.rates.source !== 'manual') result.rates.source = 'api';
  return result;
}

function saveSettings() {
  return storage
    .set({ [KEY_SETTINGS]: Object.assign({}, settings, { writer: INSTANCE }) })
    .catch((error) => toast('Изменения не сохранились: ' + error.message));
}

/* Правки журнала идут по очереди и каждый раз от свежей копии из хранилища,
   чтобы два открытых окна не затирали заказы друг друга. */
let ordersQueue = Promise.resolve();

function mutateOrders(change) {
  const run = async () => {
    const saved = await storage.get(KEY_ORDERS);
    const list = Array.isArray(saved[KEY_ORDERS]) ? saved[KEY_ORDERS] : [];
    const result = change(list);
    await storage.set({ [KEY_ORDERS]: list });
    orders = list;
    renderOrders();
    return result;
  };
  const next = ordersQueue.then(run, run);
  ordersQueue = next.catch(() => {});
  return next;
}

/* ───────────────────────── Расчёт ───────────────────────── */

function inputsFor(key) {
  const plan = settings.plans[key];
  const rates = settings.rates;
  const costs = settings.costs;
  return {
    sale: parseNum(plan.sale),
    saleCurrency: plan.saleCurrency,
    feePct: parseNum(costs.fee),
    subNgn: parseNum(plan.priceNgn),
    rates: { rub: parseNum(rates.rub), ngn: parseNum(rates.ngn), byn: parseNum(rates.byn) },
    card: {
      amount: parseNum(costs.card.amount),
      currency: costs.card.currency,
      clients: parseNum(costs.card.clients),
    },
    proxy: {
      amount: parseNum(costs.proxy.amount),
      currency: costs.proxy.currency,
      clients: parseNum(costs.proxy.clients),
    },
  };
}

const RULES = {
  rate: (n) => n !== null && Number.isFinite(n) && n > 0,
  price: (n) => n === null || (Number.isFinite(n) && n >= 0),
  amount: (n) => n === null || (Number.isFinite(n) && n >= 0),
  clients: (n) => n === null || (Number.isFinite(n) && n > 0),
  pct: (n) => n === null || (Number.isFinite(n) && n >= 0 && n < 100),
};

function markValidity(input) {
  const rule = RULES[input.dataset.rule];
  if (!rule) return;
  if (rule(parseNum(input.value))) input.removeAttribute('aria-invalid');
  else input.setAttribute('aria-invalid', 'true');
}

function describeIssue(issue, entry) {
  const name = entry.plan.name;
  const priceId = priceInputId(entry);
  const known = {
    'sale:missing': ['Введите цену на площадке', 'sale'],
    'sale:invalid': ['Цена на площадке должна быть числом, например 4,50', 'sale'],
    'sub:missing': ['Впишите цену подписки ' + name + ' в NGN', priceId],
    'sub:invalid': ['Цена подписки ' + name + ' должна быть числом', priceId],
    'rates.ngn:missing': ['Впишите курс USDT → NGN', 'rate-ngn'],
    'rates.ngn:invalid': ['Курс USDT → NGN должен быть числом больше нуля', 'rate-ngn'],
    'rates.rub:missing': ['Впишите курс USD → RUB', 'rate-rub'],
    'rates.rub:invalid': ['Курс USD → RUB должен быть числом больше нуля', 'rate-rub'],
    'rates.byn:missing': ['Впишите курс USD → BYN', 'rate-byn'],
    'rates.byn:invalid': ['Курс USD → BYN должен быть числом больше нуля', 'rate-byn'],
    'card.amount:invalid': ['Стоимость карты должна быть числом', 'card-amount'],
    'card.clients:invalid': ['Число клиентов на карту должно быть больше нуля', 'card-clients'],
    'proxy.amount:invalid': ['Стоимость прокси должна быть числом', 'proxy-amount'],
    'proxy.clients:invalid': ['Число клиентов на прокси должно быть больше нуля', 'proxy-clients'],
    'fee:invalid': ['Комиссия должна быть числом меньше 100 %', 'fee'],
  };
  return known[issue.field + ':' + issue.code] || ['Проверьте параметры', 'rate-ngn'];
}

/* ───────────────────────── Построение страницы ───────────────────────── */

function buildSection() {
  const section = current().section;
  const several = CATALOG.length > 1;

  $('section-title').textContent = section.name;
  $('section-title').hidden = several;
  const select = $('section-select');
  select.hidden = !several;
  if (several) {
    if (!select.options.length) {
      for (const item of CATALOG) select.append(el('option', { value: item.id, text: item.name }));
    }
    select.value = section.id;
  }
  $('section-period').textContent = section.period;

  const box = $('plans');
  box.textContent = '';
  box.style.gridTemplateColumns = 'repeat(' + Math.min(section.plans.length, 4) + ', minmax(0, 1fr))';
  for (const entry of PLANS.filter((p) => p.section === section)) {
    box.append(
      el('label', { class: 'plan', dataset: { key: entry.key } }, [
        el('input', { class: 'plan__input', type: 'radio', name: 'plan', value: entry.key }),
        el('span', { class: 'plan__body' }, [
          el('span', { class: 'plan__name', text: entry.plan.name }),
          el('span', { class: 'plan__profit' }),
        ]),
      ])
    );
  }
}

function buildPriceGroups() {
  const box = $('price-groups');
  box.textContent = '';
  for (const section of CATALOG) {
    const cols = el('div', { class: 'cols cols--4' });
    const hints = [];
    for (const entry of PLANS.filter((p) => p.section === section)) {
      const id = priceInputId(entry);
      cols.append(
        el('div', { class: 'field' }, [
          el('label', { class: 'label', for: id, text: entry.plan.name }),
          el('input', {
            class: 'input',
            id: id,
            type: 'text',
            inputmode: 'decimal',
            autocomplete: 'off',
            spellcheck: 'false',
            placeholder: '—',
            'data-path': 'plans.' + entry.key + '.priceNgn',
            'data-rule': 'price',
          }),
        ])
      );
      if (entry.plan.emptyHint) {
        hints.push(el('p', { class: 'hint', text: entry.plan.emptyHint, dataset: { emptyFor: entry.key } }));
      }
    }
    box.append(
      el('div', { class: 'group' }, [
        el('h2', {
          class: 'group__title',
          text: 'Цена подписки ' + section.name + ' за ' + section.period + ', NGN',
        }),
        cols,
        ...hints,
      ])
    );
  }
}

/* ───────────────────────── Заполнение полей ───────────────────────── */

function fillPlanInputs() {
  const plan = settings.plans[settings.ui.plan];
  const sale = $('sale');
  if (sale.value !== plan.sale) sale.value = plan.sale;
  markSale();
  for (const radio of document.getElementsByName('sale-currency')) {
    radio.checked = radio.value === plan.saleCurrency;
  }
}

function markSale() {
  const sale = $('sale');
  if (Number.isNaN(parseNum(sale.value))) sale.setAttribute('aria-invalid', 'true');
  else sale.removeAttribute('aria-invalid');
}

function fillInputs() {
  for (const node of document.querySelectorAll('[data-path]')) {
    const value = String(getPath(settings, node.dataset.path) ?? '');
    if (node.value !== value) node.value = value;
    markValidity(node);
  }
  fillPlanInputs();
}

/* ───────────────────────── Отрисовка ───────────────────────── */

function renderPlans() {
  for (const label of $('plans').children) {
    const key = label.dataset.key;
    const result = compute(inputsFor(key));
    label.dataset.sign = result.ok ? signOf(result.profitUsd) : 'none';
    label.querySelector('.plan__profit').textContent = result.ok ? money(result.profitUsd, 'USD', true) : '—';
    label.querySelector('.plan__input').checked = key === settings.ui.plan;
  }
}

function renderCostNote(note, item, usd, fieldId) {
  note.textContent = '';
  if (item.amount === null || item.amount === 0) {
    note.append(el('button', { class: 'link-btn', type: 'button', text: 'указать', dataset: { goto: fieldId } }));
    return;
  }
  if (usd === null) return;
  const clients = item.clients === null ? 1 : item.clients;
  const parts = [];
  if (item.currency !== 'USD' || clients !== 1) parts.push(num(item.amount, 2) + NBSP + UNIT[item.currency]);
  if (clients !== 1) parts.push('на ' + num(clients, 2) + NBSP + clientsWord(clients));
  note.textContent = parts.join(' ');
}

function renderSheet() {
  const entry = current();
  const input = inputsFor(entry.key);
  const result = compute(input);

  // Цена на площадке
  $('val-sale').textContent = money(result.saleUsd, 'USD');
  $('note-sale').textContent =
    result.saleUsd !== null && input.saleCurrency === 'RUB'
      ? num(input.sale, 2) + NBSP + '₽ ÷ ' + num(result.rates.rub, 4)
      : '';

  // Комиссия видна, только когда она задана
  const hasFee = result.feePct !== null && result.feePct > 0;
  $('row-fee').hidden = !hasFee;
  if (hasFee) {
    $('note-fee').textContent = num(result.feePct, 2) + NBSP + '%';
    $('val-fee').textContent = money(result.feeUsd, 'USD');
  }

  // Подписка
  $('val-sub').textContent = money(result.subUsd, 'USD');
  $('note-sub').textContent =
    result.subUsd !== null ? num(input.subNgn, 2) + NBSP + 'NGN ÷ ' + num(result.rates.ngn, 4) : '';

  // Карта и прокси
  $('val-card').textContent = money(result.cardUsd, 'USD');
  renderCostNote($('note-card'), input.card, result.cardUsd, 'card-amount');
  $('val-proxy').textContent = money(result.proxyUsd, 'USD');
  renderCostNote($('note-proxy'), input.proxy, result.proxyUsd, 'proxy-amount');

  // Итог. Под суммой — она же в рублях и BYN; пока посчитать нельзя, там список того, что заполнить.
  const mark = $('profit');
  mark.textContent = result.ok ? money(result.profitUsd, 'USD', true) : '—';
  mark.dataset.sign = result.ok ? signOf(result.profitUsd) : 'none';
  const other = $('profit-other');
  other.textContent = '';
  other.classList.toggle('is-issues', !result.ok);
  if (result.ok) {
    other.append(
      el('span', { text: result.profitRub === null ? '—' + NBSP + '₽' : money(result.profitRub, 'RUB', true) }),
      el('span', { text: result.profitByn === null ? '—' + NBSP + 'BYN' : money(result.profitByn, 'BYN', true) })
    );
  } else {
    for (const issue of result.issues) {
      const [text, fieldId] = describeIssue(issue, entry);
      other.append(el('button', { class: 'link-btn', type: 'button', text: text, dataset: { goto: fieldId } }));
    }
  }

  $('val-cost').textContent = money(result.costUsd, 'USD');
  $('note-cost').textContent = result.costRub !== null ? money(result.costRub, 'RUB') : '';
  $('val-margin').textContent = percent(result.marginPct);

  $('record').disabled = !result.ok;

  // Вкладка «Параметры»: расход на одного клиента
  $('card-per').textContent = money(result.cardUsd, 'USD');
  $('proxy-per').textContent = money(result.proxyUsd, 'USD');
}

function renderRates() {
  const rates = settings.rates;
  const when = rates.updatedAt ? stampFormat.format(new Date(rates.updatedAt)) : '';
  const manual = rates.source === 'manual';

  // В шапке — коротко, подробности во всплывающей подсказке и в параметрах.
  const stamp = $('rates-stamp');
  stamp.textContent = manual ? 'Курсы вручную' : 'Курсы на ' + dayFormat.format(new Date(rates.updatedAt));
  stamp.title = (manual ? 'Курсы изменены вручную ' : 'Рыночные курсы на ') + when;

  const status = $('rates-status');
  status.classList.toggle('is-error', Boolean(ratesError));
  if (ratesError) {
    status.textContent = ratesError;
  } else if (manual) {
    status.textContent =
      'Курсы изменены вручную ' + when + ' и сами больше не обновляются. «Обновить курсы» вернёт рыночные во все три поля.';
  } else {
    status.textContent =
      'Рыночные курсы на ' + when + ', USDT принят за 1 USD. Обновляются сами. Покупаете валюту через P2P — впишите свой курс.';
  }
}

function renderEmptyHints() {
  for (const hint of document.querySelectorAll('[data-empty-for]')) {
    hint.hidden = settings.plans[hint.dataset.emptyFor].priceNgn.trim() !== '';
  }
}

function renderAll() {
  renderPlans();
  renderSheet();
  renderRates();
  renderEmptyHints();
}

/* ───────────────────────── Заказы ───────────────────────── */

function sumOrders(from) {
  const total = { count: 0, usd: 0, rub: 0, byn: 0 };
  for (const order of orders) {
    if (order.ts < from) continue;
    total.count += 1;
    total.usd += order.profitUsd;
    // Если хотя бы у одного заказа нет суммы в валюте, итог в ней не показываем.
    total.rub = total.rub === null || order.profitRub === null ? null : total.rub + order.profitRub;
    total.byn = total.byn === null || order.profitByn === null ? null : total.byn + order.profitByn;
  }
  return total;
}

function renderOrders() {
  const count = orders.length;

  const badge = $('orders-count');
  badge.hidden = count === 0;
  badge.textContent = String(count);

  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const week = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 6).getTime();
  const totals = $('totals');
  totals.textContent = '';
  for (const [name, from] of [['Сегодня', today], ['7 дней', week], ['Всё время', -Infinity]]) {
    const total = sumOrders(from);
    totals.append(
      el('li', { class: 'totals__item' }, [
        el('span', { class: 'totals__name', text: name }),
        el('span', {
          class: 'totals__count',
          text: total.count + NBSP + plural(total.count, 'заказ', 'заказа', 'заказов'),
        }),
        el('span', {
          class: ('totals__usd ' + signClass(signOf(total.usd))).trim(),
          text: money(total.usd, 'USD', true),
        }),
        el('span', { class: 'totals__other' }, [
          el('span', { text: total.rub === null ? '—' + NBSP + '₽' : money(total.rub, 'RUB', true) }),
          el('span', { text: total.byn === null ? '—' + NBSP + 'BYN' : money(total.byn, 'BYN', true) }),
        ]),
      ])
    );
  }

  const body = $('orders-body');
  body.textContent = '';
  const several = CATALOG.length > 1;
  for (const order of orders.slice(0, ORDERS_SHOWN)) {
    const date = rowFormat.format(new Date(order.ts));
    body.append(
      el('tr', {}, [
        el('td', { class: 'orders__date', text: date }),
        el('td', { text: several ? order.section + ' ' + order.plan : order.plan }),
        el('td', { class: 'num', text: money(order.sale, order.saleCurrency) }),
        el('td', {
          class: ('num ' + signClass(signOf(order.profitUsd))).trim(),
          text: money(order.profitUsd, 'USD', true),
        }),
        el('td', { class: 'orders__del' }, [
          el('button', {
            class: 'del',
            type: 'button',
            title: 'Удалить заказ',
            'aria-label': 'Удалить заказ ' + order.plan + ' от ' + date,
            text: '×',
            dataset: { del: order.id },
          }),
        ]),
      ])
    );
  }

  $('totals').hidden = count === 0;
  $('orders-actions').hidden = count === 0;
  $('orders-table').hidden = count === 0;
  $('orders-empty').hidden = count > 0;
  const more = $('orders-more');
  more.hidden = count <= ORDERS_SHOWN;
  more.textContent = 'Показаны последние ' + ORDERS_SHOWN + ' из ' + count + '. В CSV попадут все.';
  if (count === 0) disarmClear();
}

let lastRecord = { key: '', at: 0 };

async function recordOrder() {
  const entry = current();
  const input = inputsFor(entry.key);
  const result = compute(input);
  if (!result.ok) return;

  // Двойной щелчок не должен записать один и тот же заказ дважды.
  const now = Date.now();
  if (lastRecord.key === entry.key && now - lastRecord.at < DOUBLE_CLICK) return;
  lastRecord = { key: entry.key, at: now };

  const order = {
    id: Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8),
    ts: Date.now(),
    section: entry.section.name,
    plan: entry.plan.name,
    sale: input.sale,
    saleCurrency: input.saleCurrency,
    saleUsd: result.saleUsd,
    feeUsd: result.feeUsd,
    subNgn: input.subNgn,
    ngnRate: result.rates.ngn,
    subUsd: result.subUsd,
    cardUsd: result.cardUsd,
    proxyUsd: result.proxyUsd,
    costUsd: result.costUsd,
    profitUsd: result.profitUsd,
    profitRub: result.profitRub,
    profitByn: result.profitByn,
  };

  try {
    await mutateOrders((list) => list.unshift(order));
  } catch (error) {
    toast('Заказ не записан: ' + error.message);
    return;
  }
  toast('Заказ записан: ' + order.plan + ', ' + money(order.profitUsd, 'USD', true), {
    action: 'Отменить',
    onAction: () => removeOrder(order.id, false),
  });
}

async function removeOrder(id, offerUndo) {
  let removed = null;
  let index = -1;
  try {
    await mutateOrders((list) => {
      index = list.findIndex((order) => order.id === id);
      if (index >= 0) removed = list.splice(index, 1)[0];
    });
  } catch (error) {
    toast('Заказ не удалён: ' + error.message);
    return;
  }
  if (!removed || !offerUndo) return;
  toast('Заказ удалён', {
    action: 'Вернуть',
    onAction: () =>
      mutateOrders((list) => list.splice(Math.min(index, list.length), 0, removed)).catch((error) =>
        toast('Заказ не вернулся: ' + error.message)
      ),
  });
}

let clearTimer = null;

function disarmClear() {
  clearTimeout(clearTimer);
  clearTimer = null;
  const button = $('clear');
  button.textContent = 'Очистить журнал';
  button.classList.remove('is-armed');
}

async function clearOrders() {
  const button = $('clear');
  if (clearTimer === null) {
    // Первый щелчок только взводит кнопку, второй очищает.
    button.textContent = 'Точно очистить?';
    button.classList.add('is-armed');
    clearTimer = setTimeout(disarmClear, 4000);
    return;
  }
  disarmClear();
  try {
    await mutateOrders((list) => {
      list.length = 0;
    });
    toast('Журнал очищен');
  } catch (error) {
    toast('Журнал не очищен: ' + error.message);
  }
}

function csvCell(value) {
  const text = String(value);
  return /[";\r\n]/.test(text) ? '"' + text.replace(/"/g, '""') + '"' : text;
}

function ordersCsv(list) {
  const n = (value, digits) =>
    value === null || value === undefined || !Number.isFinite(value)
      ? ''
      : value.toFixed(digits === undefined ? 2 : digits).replace('.', ',');
  const two = (value) => String(value).padStart(2, '0');
  const stamp = (ts) => {
    const d = new Date(ts);
    return (
      two(d.getDate()) + '.' + two(d.getMonth() + 1) + '.' + d.getFullYear() + ' ' + two(d.getHours()) + ':' + two(d.getMinutes())
    );
  };
  const head = [
    'Дата',
    'Раздел',
    'Тариф',
    'Цена на площадке',
    'Валюта цены',
    'Цена, USD',
    'Комиссия, USD',
    'Подписка, NGN',
    'Курс USDT→NGN',
    'Подписка, USD',
    'Карта, USD',
    'Прокси, USD',
    'Себестоимость, USD',
    'Прибыль, USD',
    'Прибыль, RUB',
    'Прибыль, BYN',
  ];
  const rows = list.map((o) => [
    stamp(o.ts),
    o.section,
    o.plan,
    n(o.sale),
    o.saleCurrency,
    n(o.saleUsd, 4),
    n(o.feeUsd, 4),
    n(o.subNgn),
    n(o.ngnRate, 4),
    n(o.subUsd, 4),
    n(o.cardUsd, 4),
    n(o.proxyUsd, 4),
    n(o.costUsd, 4),
    n(o.profitUsd, 4),
    n(o.profitRub),
    n(o.profitByn),
  ]);
  // BOM и точка с запятой — чтобы Excel открыл файл сразу по столбцам и с кириллицей.
  return '\uFEFF' + [head].concat(rows).map((row) => row.map(csvCell).join(';')).join('\r\n');
}

function exportOrders() {
  if (!orders.length) return;
  const now = new Date();
  const two = (value) => String(value).padStart(2, '0');
  const link = el('a', {
    href: 'data:text/csv;charset=utf-8,' + encodeURIComponent(ordersCsv(orders)),
    download: 'tydosoft-orders-' + now.getFullYear() + '-' + two(now.getMonth() + 1) + '-' + two(now.getDate()) + '.csv',
  });
  document.body.append(link);
  link.click();
  link.remove();
}

/* ───────────────────────── Курсы из сети ───────────────────────── */

/**
 * Забирает курсы из сети.
 * silent — обновление при открытии: без сообщений, и только если курсы не правили вручную.
 */
let refreshing = 0;

function showRefreshing() {
  const busy = refreshing > 0;
  const icon = $('refresh-calc');
  icon.disabled = busy;
  icon.setAttribute('aria-busy', String(busy));
  const link = $('refresh-params');
  link.disabled = busy;
  link.textContent = busy ? 'Обновляю…' : 'Обновить курсы';
}

async function refreshRates(silent) {
  refreshing += 1;
  showRefreshing();
  try {
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), 10000);
    let data;
    try {
      const response = await fetch(RATES_URL, { cache: 'no-store', signal: abort.signal });
      if (!response.ok) throw new Error('HTTP ' + response.status);
      data = await response.json();
    } finally {
      clearTimeout(timer);
    }
    const rates = data && data.rates;
    const valid = data && data.result === 'success' && rates && rates.RUB > 0 && rates.NGN > 0 && rates.BYN > 0;
    if (!valid) throw new Error('unexpected response');
    // Пока шёл запрос при открытии, курс могли вписать руками — тогда сетевой ответ не нужен.
    if (silent && settings.rates.source !== 'api') return;

    settings.rates = {
      rub: toField(rates.RUB, 2),
      ngn: toField(rates.NGN, 2),
      byn: toField(rates.BYN, 4),
      updatedAt: data.time_last_update_unix > 0 ? data.time_last_update_unix * 1000 : Date.now(),
      fetchedAt: Date.now(),
      source: 'api',
    };
    ratesError = '';
    saveSettings();
    fillInputs();
    renderAll();
    if (!silent) toast('Курсы обновлены');
  } catch (error) {
    if (silent) return;
    ratesError = 'Курсы не обновились: сервер курсов не ответил. Остались прежние значения — их можно поправить вручную.';
    renderRates();
    toast('Курсы не обновились, остались прежние');
  } finally {
    refreshing -= 1;
    showRefreshing();
  }
}

/* ───────────────────────── Вкладки и сообщения ───────────────────────── */

function showTab(name) {
  for (const tab of TABS) {
    const selected = tab === name;
    $('tab-' + tab).setAttribute('aria-selected', String(selected));
    $('tab-' + tab).tabIndex = selected ? 0 : -1;
    $('panel-' + tab).hidden = !selected;
  }
  $('main').scrollTop = 0;
}

/** Открывает вкладку, где лежит поле, и ставит в него курсор. */
function focusField(id) {
  const field = $(id);
  if (!field) return;
  showTab(field.closest('.panel').id.replace('panel-', ''));
  field.focus();
  if (typeof field.select === 'function') field.select();
}

let toastTimer = null;

function hideToast() {
  clearTimeout(toastTimer);
  $('toast').hidden = true;
}

function toast(text, options) {
  const action = options && options.action;
  $('toast-text').textContent = text;
  const button = $('toast-action');
  button.hidden = !action;
  button.textContent = action || '';
  button.onclick = action
    ? () => {
        hideToast();
        options.onAction();
      }
    : null;
  $('toast').hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(hideToast, 5000);
}

function redrawMark() {
  const mark = $('profit');
  mark.classList.remove('is-drawing');
  void mark.offsetWidth; // перезапуск анимации
  mark.classList.add('is-drawing');
}

/* ───────────────────────── События ───────────────────────── */

/**
 * Цена, скопированная со страницы вместе с валютой: «449,99 ₽», «$4.50», «450 руб.».
 * Возвращает число текстом и валюту либо null, если это обычное число или не цена вовсе.
 */
function readPastedPrice(text) {
  const trimmed = text.trim();
  const found = trimmed.match(/\d[\d\s\u00A0\u202F.,]*/);
  if (!found) return null;
  const amount = found[0].trim().replace(/[.,]$/, '');
  if (amount === trimmed) return null; // просто число — пусть вставится как обычно
  let currency = null;
  if (/₽|руб|rub/i.test(trimmed)) currency = 'RUB';
  else if (/\$|usd|долл/i.test(trimmed)) currency = 'USD';
  return { amount: amount, currency: currency };
}

/** Валюта цены у текущего тарифа; заодно у тарифов, где цена ещё не вписана. */
function setSaleCurrency(currency) {
  for (const key of Object.keys(settings.plans)) {
    const plan = settings.plans[key];
    if (key === settings.ui.plan || plan.sale.trim() === '') plan.saleCurrency = currency;
  }
}

function selectPlan(key) {
  settings.ui.plan = key;
  saveSettings();
  fillPlanInputs();
  renderAll();
  redrawMark();
}

function bind() {
  document.addEventListener('input', (event) => {
    const node = event.target;
    if (node.id === 'sale') {
      settings.plans[settings.ui.plan].sale = node.value;
      markSale();
    } else if (node.dataset.path) {
      const path = node.dataset.path;
      setPath(settings, path, node.value);
      if (path.startsWith('rates.')) {
        settings.rates.source = 'manual';
        settings.rates.updatedAt = Date.now();
        ratesError = '';
      }
      markValidity(node);
    } else {
      return;
    }
    saveSettings();
    renderAll();
  });

  document.addEventListener('change', (event) => {
    const node = event.target;
    if (node.name === 'plan') {
      selectPlan(node.value);
    } else if (node.name === 'sale-currency') {
      setSaleCurrency(node.value);
      saveSettings();
      renderAll();
    } else if (node.id === 'section-select') {
      const first = PLANS.find((p) => p.section.id === node.value);
      settings.ui.plan = first.key;
      saveSettings();
      buildSection();
      fillPlanInputs();
      renderAll();
      redrawMark();
    }
  });

  document.addEventListener('click', (event) => {
    const goto = event.target.closest('[data-goto]');
    if (goto) {
      focusField(goto.dataset.goto);
      return;
    }
    const del = event.target.closest('[data-del]');
    if (del) {
      removeOrder(del.dataset.del, true);
      return;
    }
    // Тариф выбран мышью — курсор сразу в цену, чтобы её можно было набрать.
    if (event.target.classList.contains('plan__input') && event.detail > 0) {
      $('sale').focus();
      $('sale').select();
    }
  });

  $('sale').addEventListener('paste', (event) => {
    const pasted = readPastedPrice(event.clipboardData ? event.clipboardData.getData('text') : '');
    if (!pasted) return;
    event.preventDefault();
    settings.plans[settings.ui.plan].sale = pasted.amount;
    if (pasted.currency) setSaleCurrency(pasted.currency);
    saveSettings();
    fillPlanInputs();
    renderAll();
  });

  for (const tab of TABS) {
    $('tab-' + tab).addEventListener('click', () => showTab(tab));
  }
  document.querySelector('.tabs').addEventListener('keydown', (event) => {
    const index = TABS.findIndex((tab) => $('tab-' + tab) === document.activeElement);
    if (index < 0) return;
    let next = index;
    if (event.key === 'ArrowRight') next = (index + 1) % TABS.length;
    else if (event.key === 'ArrowLeft') next = (index + TABS.length - 1) % TABS.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = TABS.length - 1;
    else return;
    event.preventDefault();
    showTab(TABS[next]);
    $('tab-' + TABS[next]).focus();
  });

  $('record').addEventListener('click', recordOrder);
  $('refresh-calc').addEventListener('click', () => refreshRates(false));
  $('refresh-params').addEventListener('click', () => refreshRates(false));
  $('export').addEventListener('click', exportOrders);
  $('clear').addEventListener('click', clearOrders);

  $('open-window').addEventListener('click', () => {
    // Окно открывается на той же вкладке, с которой его вызвали.
    const tab = TABS.find((name) => !$('panel-' + name).hidden) || TABS[0];
    const query = tab === TABS[0] ? '?window' : '?window&tab=' + tab;
    chrome.windows.create(
      { url: chrome.runtime.getURL('popup.html' + query), type: 'popup', width: 416, height: 680 },
      () => window.close()
    );
  });

  // Второе открытое окно калькулятора подхватывает изменения первого.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    const changedSettings = changes[KEY_SETTINGS];
    if (changedSettings && changedSettings.newValue && changedSettings.newValue.writer !== INSTANCE) {
      settings = normalize(changedSettings.newValue);
      buildSection();
      fillInputs();
      renderAll();
    }
    const changedOrders = changes[KEY_ORDERS];
    if (changedOrders) {
      orders = Array.isArray(changedOrders.newValue) ? changedOrders.newValue : [];
      renderOrders();
    }
  });
}

/* ───────────────────────── Запуск ───────────────────────── */

async function init() {
  // Отдельное окно может открыться сразу на нужной вкладке: popup.html?window&tab=invites
  const startTab = new URLSearchParams(location.search).get('tab');
  if (TABS.includes(startTab)) showTab(startTab);

  const saved = await storage.get([KEY_SETTINGS, KEY_ORDERS]);
  settings = normalize(saved[KEY_SETTINGS]);
  orders = Array.isArray(saved[KEY_ORDERS]) ? saved[KEY_ORDERS] : [];

  $('about-version').textContent = 'версия ' + chrome.runtime.getManifest().version;
  buildSection();
  buildPriceGroups();
  fillInputs();
  renderAll();
  renderOrders();
  bind();

  $('sale').focus();
  $('sale').select();

  // Курсы из сети подтягиваются сами, пока их не поправили вручную.
  const rates = settings.rates;
  if (rates.source === 'api' && Date.now() - rates.fetchedAt > RATES_MAX_AGE) refreshRates(true);
}

init();
