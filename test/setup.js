// Подключается до тестов (npm test → node --test --import ./test/setup.js): ожидаемые сроки в тестах
// посчитаны по московскому времени (UTC+3). У рабочей системы по умолчанию — Казахстан (UTC+5).
process.env.BUSINESS_TZ_OFFSET ??= '3';
