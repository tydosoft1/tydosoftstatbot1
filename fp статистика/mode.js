/* Отдельное окно или всплывающее окно расширения — размеры страницы разные. */
if (new URLSearchParams(location.search).has('window')) {
  document.documentElement.classList.add('in-window');
}
