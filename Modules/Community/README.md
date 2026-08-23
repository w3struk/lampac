# Community: Telegram-авторизация

Модули расположены в **`Modules/Community/`** ([`NextGen.slnx`](../../NextGen.slnx)). Краткая карта и клиентская часть (Lampa). Подробности по API и конфигу — в README соответствующего подмодуля.

## Включение в поставке по умолчанию

В [`config/base.conf`](../../config/base.conf) в **`BaseModule.SkipModules`** по умолчанию указан **`TelegramAuth`** — хост его не загружает, пока вы не уберёте имя из списка. Telegram-бот встроен в модуль `TelegramAuth` как in-process `IHostedService` (секция `bot.enable`). Дополнительно в модуле `TelegramAuth` в **`manifest.json`** должно быть **`"enable": true`**, иначе Roslyn-слой не подхватит проект.

## Состав

| Модуль | Роль |
|--------|------|
| [TelegramAuth](TelegramAuth/README.md) | Хранилище пользователей и устройств, HTTP API `/tg/auth/...`, in-process Telegram-бот (`bot.enable`, long polling) и синхронизация UID в accsdb при `TelegramAuth.enable` |

> **Бот встроен в `TelegramAuth`** как `bot.enable` (in-process `IHostedService`, без отдельного проекта/HTTP-клиента).

**Типовой поток:** клиент получает UID → пользователь открывает бота (`/start <uid>` или отправляет UID) → бот напрямую вызывает хранилище `TelegramAuth` (in-process, без HTTP) → клиент опрашивает `GET /tg/auth/status?uid=...` → после успеха Lampac видит UID в корневом `users.json` (если включены TelegramAuth + accsdb).

## Быстрый старт

1. В `init.conf` (или merge-файле) задать секцию **`TelegramAuth`** (включая вложенную `bot`) по примеру [`TelegramAuth/init.merge.example.json`](TelegramAuth/init.merge.example.json).
2. **`mutations_api_secret`** нужен только для внешнего REST API (`bind/complete` и админки по HTTP); in-process бот им не пользуется. В проде задайте ненулевой секрет, если используете внешние вызовы.
3. Включить модуль в `manifest.json` (`"enable": true`) и убрать `TelegramAuth` из `BaseModule.SkipModules` в `config/base.conf`.
4. Для входа через accsdb: **`TelegramAuth.enable`: `true`** поднимает **`accsdb.enable`** в Core и синхронизирует привязанные UID в корневой **`users.json`**. Без этого API Telegram живёт, но «дверь» accsdb не заведётся из TelegramAuth.
5. Чтобы вход был через Telegram (а не модалку пароля/CUB), активируйте гейт из `TelegramAuth.bot` — см. раздел «Как заменить стандартный deny.js на Telegram» ниже.

## Клиент Lampa: `deny.js` и `telegram_auth_gate.js`

Оба сценария завязаны на **`/testaccsdb`**: если ответ говорит, что нужна авторизация (`accsdb`), клиент блокирует интерфейс и предлагает способ входа.

### Где это подключается

- В **`lampainit.js`** в функции `start()` есть плейсхолдер **`{deny}`**.
- [ApiController.cs](../../LampaWeb/Controllers/ApiController.cs) при **`accsdb.enable`** подставляет в `{deny}` **содержимое файла** `Modules/LampaWeb/plugins/deny.js` (с заменой `{cubMesage}` на `accsdb.authMesage`) — или `telegram_auth_gate.js` при активном гейте (см. ниже). Если accsdb выключен, `{deny}` очищается.
- Скрипт **`telegram_auth_gate.js`** отдаётся отдельным маршрутом **`GET …/telegram_auth_gate.js`** с подстановкой `{localhost}`, `{country}`, `{token}` (как у других плагинов LampaWeb), а также `{botUsername}`/`{serviceName}` из `Shared.Services.TelegramGateState` (через `TelegramGateJs()`). При вставке в `{deny}` сервер подставляет только `{botUsername}`/`{serviceName}` (остальные плейсхолдеры подставляются глобально на этапе сборки `lampainit.js`).

### Что делает `deny.js` (стандарт)

- Вызывает `{localhost}/testaccsdb` (с `account_email`, `uid`, опционально `token` по правилам Core).
- При необходимости авторизации выставляет **`window.start_deep_link`** на экран **denypages**, скрывает `#app`, показывает сообщение и через ~5 с открывает модалку: **пароль Lampac** и опционально **аккаунт CUB**.

### Что делает `telegram_auth_gate.js`

- Тот же запрос к **`/testaccsdb`**, но **не** трогает `start_deep_link` (нет принудительного экрана deny в ядре Lampa).
- Показывает полноэкранный оверлей: **UID устройства**, кнопка «Открыть Telegram», QR (на крупных экранах), опрос **`GET /tg/auth/status?uid=...`** каждые `checkIntervalMs`.
- После успеха пишет профиль в `Lampa.Storage` (`tg_auth_user`), отправляет **`POST /tg/auth/device/name`**, снимает блокировку и делает **перезагрузку на главную** (как после успешного пароля в `deny.js`). Блокировка окончательно снимается после повторного опроса `/testaccsdb` на перезагруженной странице: гейт не использует `start_deep_link` ядра Lampa, поэтому именно reload запускает повторную проверку, которая видит авторизацию. Убедитесь, что подключён ровно один источник гейта, иначе будет двойной опрос `/testaccsdb`.
- В начале файла нужно задать **`CONFIG.botUsername`** и **`CONFIG.serviceName`** (без `@` у имени бота в логике допускается — код обрежет). Актуально только при подключении скрипта вручную (customPlugins или override-файл); при конфиге `TelegramAuth.bot` значения приходят из `TelegramGateState`.

### Как заменить стандартный deny.js на Telegram

Нужно, чтобы при включённом accsdb в `start()` выполнялся **только** сценарий с Telegram, а не модалка пароля/CUB.

**Рекомендуемый способ — секция `TelegramAuth.bot` в конфиге (без правки файлов)**

1. В `init.conf` (или merge-файле) убедитесь, что **`TelegramAuth.enable: true`** и **`accsdb.enable: true`**.
2. В секции `TelegramAuth.bot` задайте **`enable: true`** и непустой **`token`**.
3. Перезапустите LampaWeb (или дождитесь hot-reload конфига; `lampainit.js` кэшируется Staticache ~20с, поэтому смена подхватывается с задержкой ≤20с).

Пример (`init.conf` или merge-файл):
```json
{
  "TelegramAuth": {
    "enable": true,
    "bot": {
      "enable": true,
      "token": "123456:ABC...",
      "username": "",
      "display_name": "Lampac NextGen Bot",
      "admin_chat_ids": [111111111],
      "owner_telegram_ids": [222222222],
      "notify_admins_on_pending_provision": true
    }
  }
}
```

> Гейт активируется при выполнении условий: `accsdb.enable` + `TelegramGateState.Active`, где `TelegramGateState.Active = TelegramAuth.enable && bot.enable && !IsNullOrWhiteSpace(bot.token)`. Иначе — **тихий откат на стандартный `deny.js`** (с одноразовой диагностикой в логе). Поле `bot.username` необязательно: если оно пустое, имя бота резолвится через `getMe` (в течение ≤10с после старта `BotUsername` может быть пустым — гейт всё равно инжектится, но без `@username`; само-заживляется).

Семантика полей `bot`: `enable` — вкл/выкл бота и гейта; `token` — токен BotFather (обязателен); `username` — имя бота **без `@`** (код обрезает ведущий `@`); если пусто — резолвится через `getMe`; `display_name` — отображаемое имя сервиса в текстах оверлея гейта (`ServiceName`); `admin_chat_ids` / `owner_telegram_ids` — ограничения контекста админ-команд; `notify_admins_on_pending_provision` — уведомлять админов о новых заявках; `request_timeout_sec` — таймаут `getMe` (clamp 1..60, дефолт 10).

**Альтернатива — override `telegram_auth_gate.js` через `FileCache`**

Положите свою версию скрипта в `Modules/LampaWeb/plugins/override/telegram_auth_gate.js` (см. корневой `README.md`, раздел override). Подстановка `{botUsername}`/`{serviceName}` из `TelegramGateState` выполняется уже после чтения файла, поэтому override полностью совместим с конфигом `TelegramAuth.bot`. Свежий override вступает в силу до ~10 мин из-за кэша `FileCache`; правка теряется при удалении файла override.

⚠️ **Двойной опрос `/testaccsdb`**: `customPlugins` добавляется независимо от гейта (см. `ApiController.cs`). Актуально только при ручном подключении скрипта, а не при использовании `TelegramAuth.bot`.

<details>
<summary>Прочие / продвинутые варианты</summary>

- **Гейт как отдельный плагин (`customPlugins`)** — очистите `deny.js` и добавьте URL `{localhost}/telegram_auth_gate.js` со `status: 1`; гейт загружается после `start()` вместе с плагинами. Нишевый сценарий; сохраняется предупреждение о двойном опросе выше.
- **Своя ветка / правка исходников** — для разработчиков: точка расширения выбора скрипта для `{deny}` в `ApiController.cs` (блок инъекции гейта).

</details>

### Плейсхолдеры в плагинах

| Плейсхолдер | Где подставляется |
|-------------|-------------------|
| `{localhost}` | Базовый URL Lampac для запросов |
| `{token}` | Из `accsdb.domainId_pattern` (если задан), иначе пусто |
| `{cubMesage}` | Только в **`deny.js`** при вставке в `lampainit` → `accsdb.authMesage` |
| `{botUsername}` | Только в **`telegram_auth_gate.js`** (через `TelegramGateJs()`) из `TelegramGateState.BotUsername` (ручной `bot.username` приоритетнее `getMe`); экранируется `JavaScriptStringEncode` |
| `{serviceName}` | Только в **`telegram_auth_gate.js`** (через `TelegramGateJs()`) из `TelegramGateState.ServiceName` (`bot.display_name` либо миграционный override); экранируется `JavaScriptStringEncode` |

В **`telegram_auth_gate.js`** для подсказок с сервера используются поля ответа **`/testaccsdb`**: `msg`, `denymsg`, `newuid` (как в `deny.js`).

## Миграция со старых конфигов (бывший модуль `TelegramAuthBot` и флаг `LampaWeb.telegramAuthGate`)

> **Приоритет `bot.enable`:** legacy-флаги `enabled=false` (из `LampaWeb.telegramAuthGate` или `TelegramAuthBot`) отключают гейт только пока в новой секции `TelegramAuth.bot` не задан явный `bot.enable`; после задания явного значения новая секция приоритетна и legacy force-off не применяется.

- **(a) Старый `telegramAuthGate.enabled=true` без токена бота.** Раньше это давало сломанный оверлей; теперь при отсутствии `bot.token` гейт не активен и клиент получает стандартный `deny.js`. **Решение:** задайте `TelegramAuth.bot.token` (и `bot.enable: true`).
- **(b) Первые секунды после старта.** При пустом ручном `bot.username` имя бота резолвится через `getMe` (до ~10с). В это окно `BotUsername` может быть пустым, и гейт отдаётся без `@username` — это **само-заживляется ≤20с** (кэш `lampainit.js`), повторный запрос покажет корректное имя.
- **(c) Апгрейд с отдельного модуля `TelegramAuthBot`.** Если старый модуль `TelegramAuthBot` был выведен из `SkipModules` и работал параллельно, после включения нового in-process бота **оба** будут опрашивать один токен → **Telegram 409 conflict**. Новый бот включайте только вместе с этим обновлением (старый проект `TelegramAuthBot` удалён из решения).

Старые ключи мигрируются автоматически (один раз, приоритет у новой секции `bot.*`): `TelegramAuthBot.bot_token` → `bot.token`, `bot_username` → `bot.username`, `bot_display_name`/`service_display_name` → `bot.display_name`, `bot_admin_chat_ids`/`admin_chat_ids` → `bot.admin_chat_ids`, `bot_owner_telegram_ids`/`owner_telegram_ids` → `bot.owner_telegram_ids`, `bot_notify_admins_on_pending_provision` → `bot.notify_admins_on_pending_provision`, `bot_request_timeout_sec` → `bot.request_timeout_sec`; `LampaWeb.telegramAuthGate.botUsername`/`bot_username` → `bot.username` (приоритет над `getMe`), `LampaWeb.telegramAuthGate.serviceName` → `ServiceName` (override `bot.display_name`).

## Документация по модулям

- [TelegramAuth — конфиг, accsdb, API, безопасность, in-process бот](TelegramAuth/README.md)
