'use strict';
/* global chrome, importScripts, InvitesCore */

/*
 * Фоновый скрипт: напоминает о подписках из раздела «Инвайты».
 *
 * Раз в час сверяет сроки аккаунтов с сегодняшним днём и показывает уведомление, когда подписка
 * скоро закончится, когда до конца остался день и когда она истекла. Каждое — один раз на срок;
 * несколько подписок идут одним уведомлением. Ночью не беспокоит: отложенное придёт утром.
 *
 * Данные раздела скрипт только читает. Пишет он лишь свои отметки «о чём уже сказано»,
 * поэтому с окном расширения из-за хранилища не спорит. Пароли в уведомления не попадают.
 */
importScripts('invites-core.js');

const KEY_INVITES = 'invites';
const KEY_MARKS = 'invitesNotified';
const ALARM = 'invites-check';
const PERIOD_MINUTES = 60;
const DAY_STARTS = 9; // уведомления показываются с 9:00
const DAY_ENDS = 22; // и до 22:00 по местному времени
const WINDOW = { type: 'popup', width: 416, height: 680 };

const read = (keys) => new Promise((resolve) => chrome.storage.local.get(keys, (items) => resolve(items || {})));

const write = (items) =>
  new Promise((resolve) => {
    chrome.storage.local.set(items, () => {
      void chrome.runtime.lastError; // отметки не записались — напомним ещё раз при следующей проверке
      resolve();
    });
  });

async function check() {
  const saved = await read([KEY_INVITES, KEY_MARKS]);
  const state = InvitesCore.normalizeState(saved[KEY_INVITES]);
  const hour = new Date().getHours();
  const quiet = hour < DAY_STARTS || hour >= DAY_ENDS;
  const mode = !state.prefs.notify ? 'mute' : quiet ? 'defer' : 'show';

  const result = InvitesCore.dueNotifications(state, InvitesCore.today(), saved[KEY_MARKS], mode);
  if (JSON.stringify(result.marks) !== JSON.stringify(saved[KEY_MARKS] || {})) {
    await write({ [KEY_MARKS]: result.marks });
  }
  if (!result.due.length) return;

  const content = InvitesCore.notificationContent(result.due);
  chrome.notifications.create('invites-' + Date.now(), {
    type: 'basic',
    iconUrl: chrome.runtime.getURL('icons/icon128.png'),
    title: content.title,
    message: content.message,
  });
}

/* Проверки идут строго по очереди: две подряд не покажут одно и то же дважды. */
let queue = Promise.resolve();

function schedule() {
  queue = queue.then(check, check).catch(() => {});
  return queue;
}

function ensureAlarm() {
  chrome.alarms.get(ALARM, (alarm) => {
    if (!alarm) chrome.alarms.create(ALARM, { delayInMinutes: 1, periodInMinutes: PERIOD_MINUTES });
  });
}

chrome.runtime.onInstalled.addListener(() => {
  ensureAlarm();
  schedule();
});

chrome.runtime.onStartup.addListener(() => {
  ensureAlarm();
  schedule();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM) schedule();
});

// Новый или изменённый срок запоминается сразу, как только его сохранили в окне расширения.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes[KEY_INVITES]) schedule();
});

// Щелчок по уведомлению открывает раздел.
function openInvites(id) {
  if (!id.startsWith('invites-')) return;
  chrome.notifications.clear(id);
  chrome.windows.create(Object.assign({ url: chrome.runtime.getURL('popup.html?window&tab=invites') }, WINDOW));
}

chrome.notifications.onClicked.addListener(openInvites);
