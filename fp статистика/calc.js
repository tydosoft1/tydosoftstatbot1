/*
 * Расчёт прибыли с одного заказа.
 * Чистые функции без доступа к странице и хранилищу: их можно запускать и в браузере, и в Node.
 *
 *   прибыль = цена на площадке − комиссия − подписка (NGN ÷ курс USDT→NGN) − карта на клиента − прокси на клиента
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else {
    root.FPCalc = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const SPACES = /[\s\u00A0\u202F\u2009]/g;

  /** Какой курс нужен, чтобы перевести валюту в доллары. */
  const RATE_KEY = { RUB: 'rub', BYN: 'byn', NGN: 'ngn' };

  function isNum(n) {
    return typeof n === 'number' && Number.isFinite(n);
  }

  /**
   * Разбирает число, введённое руками: «4,50», «1 328,65», «1,328.65».
   * Пустая строка → null, не число → NaN.
   */
  function parseNum(value) {
    if (value === null || value === undefined) return null;
    if (typeof value === 'number') return Number.isFinite(value) ? value : NaN;

    let s = String(value).replace(SPACES, '');
    if (s === '') return null;

    const commas = s.split(',').length - 1;
    const dots = s.split('.').length - 1;

    if (commas > 0 && dots > 0) {
      // Есть оба знака: последний — десятичный, остальные разделяют разряды.
      const decimal = s.lastIndexOf(',') > s.lastIndexOf('.') ? ',' : '.';
      const group = decimal === ',' ? '.' : ',';
      s = s.split(group).join('');
      if (decimal === ',') s = s.replace(',', '.');
    } else if (commas > 1) {
      s = s.split(',').join('');
    } else if (dots > 1) {
      s = s.split('.').join('');
    } else if (commas === 1) {
      s = s.replace(',', '.');
    }

    if (!/^(\d+\.?\d*|\.\d+)$/.test(s)) return NaN;
    return Number(s);
  }

  /**
   * @param {object} input
   * @param {number|null} input.sale          цена на площадке
   * @param {'USD'|'RUB'} input.saleCurrency  валюта цены
   * @param {number|null} input.feePct        комиссия, % от цены (пусто = 0)
   * @param {number|null} input.subNgn        цена подписки в NGN
   * @param {{rub:number|null, ngn:number|null, byn:number|null}} input.rates
   *        rub — рублей за 1 USD, ngn — найр за 1 USDT, byn — бел. рублей за 1 USD
   * @param {{amount:number|null, currency:string, clients:number|null}} input.card
   * @param {{amount:number|null, currency:string, clients:number|null}} input.proxy
   *
   * Значение null означает «не заполнено», NaN — «заполнено неверно».
   * Всё, что посчитать нельзя, в ответе равно null, причины перечислены в issues.
   */
  function compute(input) {
    const issues = [];
    const reported = new Set();
    const report = (field, code) => {
      const key = field + ':' + code;
      if (reported.has(key)) return;
      reported.add(key);
      issues.push({ field: field, code: code });
    };

    const rawRates = input.rates || {};
    const rates = {};
    for (const key of ['rub', 'ngn', 'byn']) {
      const v = rawRates[key];
      if (v === null || v === undefined) rates[key] = null;
      else if (!isNum(v) || v <= 0) rates[key] = NaN;
      else rates[key] = v;
    }

    const rateReady = (key) => {
      if (rates[key] === null) {
        report('rates.' + key, 'missing');
        return false;
      }
      if (!isNum(rates[key])) {
        report('rates.' + key, 'invalid');
        return false;
      }
      return true;
    };

    const toUsd = (amount, currency) => {
      if (currency === 'USD') return amount;
      const key = RATE_KEY[currency];
      if (!key) return null;
      return rateReady(key) ? amount / rates[key] : null;
    };

    // Цена на площадке
    let saleUsd = null;
    const sale = input.sale;
    const saleCurrency = input.saleCurrency || 'USD';
    if (sale === null || sale === undefined) report('sale', 'missing');
    else if (!isNum(sale) || sale < 0) report('sale', 'invalid');
    else saleUsd = toUsd(sale, saleCurrency);

    // Подписка: цена в NGN ÷ курс USDT → NGN
    let subUsd = null;
    const subNgn = input.subNgn;
    const ngnReady = rateReady('ngn');
    if (subNgn === null || subNgn === undefined) report('sub', 'missing');
    else if (!isNum(subNgn) || subNgn < 0) report('sub', 'invalid');
    else if (ngnReady) subUsd = subNgn / rates.ngn;

    // Карта и прокси: полная стоимость ÷ число клиентов
    const perClient = (item, field) => {
      const amount = item ? item.amount : null;
      const clients = item ? item.clients : null;
      let a = 0;
      let c = 1;
      let valid = true;
      if (amount !== null && amount !== undefined) {
        if (!isNum(amount) || amount < 0) {
          report(field + '.amount', 'invalid');
          valid = false;
        } else {
          a = amount;
        }
      }
      if (clients !== null && clients !== undefined) {
        if (!isNum(clients) || clients <= 0) {
          report(field + '.clients', 'invalid');
          valid = false;
        } else {
          c = clients;
        }
      }
      if (!valid) return null;
      if (a === 0) return 0; // нулевому расходу курс не нужен
      const usd = toUsd(a, (item && item.currency) || 'USD');
      return usd === null ? null : usd / c;
    };
    const cardUsd = perClient(input.card, 'card');
    const proxyUsd = perClient(input.proxy, 'proxy');

    // Комиссия
    let feePct = 0;
    const fee = input.feePct;
    if (fee !== null && fee !== undefined) {
      if (!isNum(fee) || fee < 0 || fee >= 100) {
        report('fee', 'invalid');
        feePct = null;
      } else {
        feePct = fee;
      }
    }

    const costUsd =
      subUsd !== null && cardUsd !== null && proxyUsd !== null ? subUsd + cardUsd + proxyUsd : null;
    const feeUsd = saleUsd !== null && feePct !== null ? (saleUsd * feePct) / 100 : null;
    const receivedUsd = feeUsd !== null ? saleUsd - feeUsd : null;
    const profitUsd = receivedUsd !== null && costUsd !== null ? receivedUsd - costUsd : null;

    const inRub = (usd) => (usd !== null && isNum(rates.rub) ? usd * rates.rub : null);
    const inByn = (usd) => (usd !== null && isNum(rates.byn) ? usd * rates.byn : null);

    return {
      ok: profitUsd !== null,
      issues: issues,
      rates: rates,
      feePct: feePct,
      saleUsd: saleUsd,
      feeUsd: feeUsd,
      receivedUsd: receivedUsd,
      subUsd: subUsd,
      cardUsd: cardUsd,
      proxyUsd: proxyUsd,
      costUsd: costUsd,
      costRub: inRub(costUsd),
      profitUsd: profitUsd,
      profitRub: inRub(profitUsd),
      profitByn: inByn(profitUsd),
      marginPct: profitUsd !== null && saleUsd > 0 ? (profitUsd / saleUsd) * 100 : null,
    };
  }

  return { parseNum: parseNum, compute: compute };
});
