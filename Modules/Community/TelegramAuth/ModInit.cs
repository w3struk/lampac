using System;
using System.Collections.Generic;
using Newtonsoft.Json.Linq;
using Shared;
using Shared.Models.AppConf;
using Shared.Models.Events;
using Shared.Models.Module;
using Shared.Models.Module.Interfaces;
using Shared.Services;
using Microsoft.Extensions.DependencyInjection;
using TelegramAuth.Models;
using TelegramAuth.Services;

namespace TelegramAuth
{
    public class ModInit : IModuleLoaded, IModuleConfigure
    {
        public static TelegramAuthConf conf = new();

        public static TelegramAuthStore Store { get; private set; } = null!;

        /// <summary>
        /// Username, резолвленный через getMe (Спринт 2). Ручной bot.username имеет приоритет.
        /// </summary>
        internal static string? _resolvedUsernameCache = null;

        /// <summary>
        /// serviceName из мигрированной legacy-секции LampaWeb.telegramAuthGate
        /// (приоритет над дефолтом в TelegramGateState.ServiceName).
        /// </summary>
        internal static string? _migratedGateServiceName;

        static string? _lastToken;
        static bool _deprecatedBaseUrlWarned;

        public void Loaded(InitspaceModel initspace)
        {
            UpdateConfFromInit();
            EventListener.UpdateInitFile += UpdateConfFromInit;
        }

        /// <summary>
        /// IModuleConfigure: вызывается ДО Loaded (Core/Startup.cs). Конфиг на этом этапе
        /// ещё не загружен в статический conf, поэтому сначала вызываем UpdateConfFromInit(),
        /// затем регистрируем hosted-сервис бота, если он включён.
        /// Hot-reload токена/enable требует перезапуска процесса (бот-поллинг не пересоздаётся).
        /// </summary>
        public void Configure(ConfigureModel app)
        {
            UpdateConfFromInit();

            if (conf.enable && conf.bot.enable && !string.IsNullOrWhiteSpace(conf.bot.token))
                app.services.AddHostedService<TelegramAuthBotHostedService>();
        }

        void UpdateConfFromInit()
        {
            conf = ModuleInvoke.Init("TelegramAuth", new TelegramAuthConf
            {
                enable = false,
                data_dir = null,
                legacy_import_path = "",
                enable_import = true,
                enable_cleanup = true,
                max_active_devices_per_user = 0,
                mutations_api_secret = "",
                owner_telegram_ids = null,
                auto_provision_users = false,
                auto_provision_role = "user",
                auto_provision_lang = "ru",
                auto_provision_expires_days = 0,
                auto_provision_activate_immediately = false,
                accsdb_sync_group_admin = 100,
                accsdb_sync_group_user = 0,
                limit_map = new List<WafLimitRootMap>
                {
                    new("^/tg/auth", new WafLimitMap { limit = 5, second = 1 })
                }
            });

            MigrateLegacyConf();

            // сброс кэша username при смене токена: старый getMe-результат больше не валиден
            if (!string.Equals(_lastToken, conf.bot.token, StringComparison.Ordinal))
            {
                _lastToken = conf.bot.token;
                _resolvedUsernameCache = null;
            }

            if (CoreInit.conf != null && conf.enable)
                CoreInit.conf.accsdb.enable = true;

            Store = new TelegramAuthStore(conf);
            Store.EnsureStorage();
            Store.EnsureOwnerUsersAtStartup();

            UpdateGateState();
            LogStartupChecklist();

            if (conf.enable)
                ApplyWafLimitMapFromConf();
        }

        #region TelegramGateState

        /// <summary>
        /// Единственная точка записи Shared.Services.TelegramGateState.
        /// Вызывается при загрузке/hot-reload конфига; после getMe — из Спринта 2 (2.2).
        /// </summary>
        internal static void UpdateGateState()
        {
            // Active = enable && bot.enable && token задан (IsNullOrWhiteSpace)
            TelegramGateState.Active = conf.enable && conf.bot.enable && !string.IsNullOrWhiteSpace(conf.bot.token);

            // приоритет: ручной bot.username > кэш getMe
            var manualUsername = NormalizeUsername(conf.bot.username);
            TelegramGateState.BotUsername = manualUsername ?? _resolvedUsernameCache;

            // приоритет: мигрированный LampaWeb.telegramAuthGate.serviceName > bot.display_name > дефолт
            TelegramGateState.ServiceName = _migratedGateServiceName ?? conf.bot.display_name ?? "Lampac NextGen Bot";
        }

        #endregion

        #region Миграция legacy-конфигов (TelegramAuthBot.* / LampaWeb.telegramAuthGate.*)

        /// <summary>
        /// Одноразовая миграция старых ключей в новую секцию bot.*
        /// Новая секция bot.* имеет приоритет: legacy пишется только в пустые/дефолтные значения.
        /// Чтение legacy-секций идёт через ModuleInvoke.Init(section, new JObject()): side-effect —
        /// слитая секция записывается в CoreInit.CurrentConf (watcher сериализует его в current.conf).
        /// Чтобы мёртвая секция TelegramAuthBot не всплывала в админке/current.conf,
        /// после маппинга она вычищается из CurrentConf (см. PurgeLegacySectionsFromCurrentConf).
        /// Fallback чтения — прямое чтение CoreInit.CurrentConf[section].
        /// </summary>
        static void MigrateLegacyConf()
        {
            var legacyBot = ReadMergedLegacySection("TelegramAuthBot");
            var legacyLampa = ReadMergedLegacySection("LampaWeb");
            var legacyGate = legacyLampa?["telegramAuthGate"] as JObject;

            // миграция legacy-флагов enabled: выключенный гейт/бот остаётся выключенным,
            // НО только если в новой секции TelegramAuth.bot.enable не задан ЯВНО (новая секция приоритетна).
            var newTelegramAuth = ReadMergedLegacySection("TelegramAuth");
            var botEnableToken = newTelegramAuth?["bot"]?["enable"];
            bool botEnableExplicit = botEnableToken != null && botEnableToken.Type != JTokenType.Null;

            if (!botEnableExplicit)
            {
                if (legacyGate != null && TryGetBool(legacyGate, "enabled", out var gateEnabled) && !gateEnabled) conf.bot.enable = false;
                if (legacyBot != null && TryGetBool(legacyBot, "enable", out var botEnabled) && !botEnabled) conf.bot.enable = false;
            }

            bool migrated = false;

            if (legacyBot != null)
            {
                // bot_token -> bot.token
                if (string.IsNullOrWhiteSpace(conf.bot.token) && TryGetString(legacyBot, "bot_token", out var val))
                {
                    conf.bot.token = val;
                    migrated = true;
                }

                // bot_username -> bot.username (алиас; исторически username резолвился через getMe)
                if (string.IsNullOrWhiteSpace(conf.bot.username) && TryGetString(legacyBot, "bot_username", out val))
                {
                    conf.bot.username = NormalizeUsername(val);
                    migrated = true;
                }

                // bot_display_name / service_display_name -> bot.display_name
                if (string.IsNullOrWhiteSpace(conf.bot.display_name)
                    && (TryGetString(legacyBot, "bot_display_name", out val) || TryGetString(legacyBot, "service_display_name", out val)))
                {
                    conf.bot.display_name = val;
                    migrated = true;
                }

                // bot_admin_chat_ids / admin_chat_ids -> bot.admin_chat_ids
                if ((conf.bot.admin_chat_ids == null || conf.bot.admin_chat_ids.Count == 0)
                    && (TryGetLongList(legacyBot, "bot_admin_chat_ids", out var longList) || TryGetLongList(legacyBot, "admin_chat_ids", out longList)))
                {
                    conf.bot.admin_chat_ids = longList;
                    migrated = true;
                }

                // bot_owner_telegram_ids / owner_telegram_ids -> bot.owner_telegram_ids
                if ((conf.bot.owner_telegram_ids == null || conf.bot.owner_telegram_ids.Count == 0)
                    && (TryGetLongList(legacyBot, "bot_owner_telegram_ids", out longList) || TryGetLongList(legacyBot, "owner_telegram_ids", out longList)))
                {
                    conf.bot.owner_telegram_ids = longList;
                    migrated = true;
                }

                // bot_notify_admins_on_pending_provision / notify_admins_on_pending_provision -> bot.notify_admins_on_pending_provision
                if (conf.bot.notify_admins_on_pending_provision == null
                    && (TryGetBool(legacyBot, "bot_notify_admins_on_pending_provision", out var flag) || TryGetBool(legacyBot, "notify_admins_on_pending_provision", out flag)))
                {
                    conf.bot.notify_admins_on_pending_provision = flag;
                    migrated = true;
                }

                // bot_request_timeout_sec / request_timeout_sec -> bot.request_timeout_sec
                if (conf.bot.request_timeout_sec == null
                    && (TryGetInt(legacyBot, "bot_request_timeout_sec", out var timeout) || TryGetInt(legacyBot, "request_timeout_sec", out timeout)))
                {
                    conf.bot.request_timeout_sec = timeout;
                    migrated = true;
                }

                // mutations_api_secret -> TelegramAuth.mutations_api_secret (только если новый пустой)
                if (string.IsNullOrEmpty(conf.mutations_api_secret) && TryGetString(legacyBot, "mutations_api_secret", out val))
                {
                    conf.mutations_api_secret = val;
                    migrated = true;
                }

                // lampac_base_url больше не используется (in-process режим) — одноразово предупреждаем
                if (!_deprecatedBaseUrlWarned && TryGetString(legacyBot, "lampac_base_url", out _))
                {
                    _deprecatedBaseUrlWarned = true;
                    var warn = "[TelegramAuth] lampac_base_url is deprecated — in-process mode, value ignored";
                    Console.WriteLine(warn);
                    Serilog.Log.Information("{Message}", warn);
                }
            }

            if (legacyGate != null)
            {
                // telegramAuthGate.botUsername/bot_username -> bot.username (override, приоритет над getMe)
                if (string.IsNullOrWhiteSpace(conf.bot.username)
                    && (TryGetString(legacyGate, "botUsername", out var username) || TryGetString(legacyGate, "bot_username", out username)))
                {
                    conf.bot.username = NormalizeUsername(username);
                    migrated = true;
                }

                // telegramAuthGate.serviceName/service_name -> _migratedGateServiceName
                if (_migratedGateServiceName == null
                    && (TryGetString(legacyGate, "serviceName", out var serviceName) || TryGetString(legacyGate, "service_name", out serviceName)))
                {
                    _migratedGateServiceName = serviceName;
                    migrated = true;
                }
            }

            if (migrated)
            {
                var msg = "[TelegramAuth] migrated legacy config: TelegramAuthBot.* / LampaWeb.telegramAuthGate.* -> TelegramAuth.bot.*";
                Console.WriteLine(msg);
                Serilog.Log.Information("{Message}", msg);
            }

            PurgeLegacySectionsFromCurrentConf();
        }

        /// <summary>
        /// ModuleInvoke.Init выше персистит слитые legacy-секции в CoreInit.CurrentConf,
        /// а watcher сериализует CurrentConf в current.conf — секция мёртвого модуля
        /// TelegramAuthBot всплывала в админке (редактор конфига) после каждой загрузки.
        /// Вычищаем её после маппинга. LampaWeb не трогаем — живой модуль.
        /// </summary>
        static void PurgeLegacySectionsFromCurrentConf()
        {
            try
            {
                if (CoreInit.CurrentConf is JObject cc && cc["TelegramAuthBot"] != null)
                {
                    cc.Remove("TelegramAuthBot");
                    Serilog.Log.Debug("[TelegramAuth] purged legacy TelegramAuthBot section from current config snapshot");
                }
            }
            catch { }
        }

        /// <summary>
        /// Чтение legacy-секции: сначала публичный ModuleInvoke.Init с пустым JObject
        /// (вернёт слитую base.conf+init.conf секцию либо пустой JObject),
        /// fallback — уже слитая секция из CoreInit.CurrentConf.
        /// </summary>
        static JObject? ReadMergedLegacySection(string section)
        {
            try
            {
                var merged = ModuleInvoke.Init(section, new JObject());
                if (merged != null && merged.HasValues)
                    return merged;
            }
            catch { }

            try
            {
                if (CoreInit.CurrentConf?[section] is JObject obj && obj.HasValues)
                    return obj;
            }
            catch { }

            return null;
        }

        #endregion

        #region Диагностика старта

        /// <summary>
        /// Диагностический чек-лист старта (план, задача 1.4).
        /// </summary>
        static void LogStartupChecklist()
        {
            var hasToken = !string.IsNullOrWhiteSpace(conf.bot.token);
            var checklist = $"[TelegramAuth] enable={conf.enable}, bot.enable={conf.bot.enable}, token={(hasToken ? "set" : "empty")}, gateActive={TelegramGateState.Active}";
            Console.WriteLine(checklist);
            Serilog.Log.Information("{Message}", checklist);

            if (conf.bot.enable && !hasToken)
            {
                var msg = "[TelegramAuth] ERROR: bot.enable=true, но bot.token пустой — бот и гейт не активны";
                Console.WriteLine(msg);
                Serilog.Log.Error("{Message}", msg);
            }
        }

        #endregion

        static string? NormalizeUsername(string? username)
        {
            var trimmed = username?.Trim().TrimStart('@');
            return string.IsNullOrEmpty(trimmed) ? null : trimmed;
        }

        static bool TryGetString(JObject obj, string key, out string value)
        {
            value = "";
            var token = obj[key];
            if (token == null || token.Type == JTokenType.Null)
                return false;

            var s = token.Value<string>()?.Trim();
            if (string.IsNullOrEmpty(s))
                return false;

            value = s;
            return true;
        }

        static bool TryGetBool(JObject obj, string key, out bool value)
        {
            var token = obj[key];
            if (token != null && token.Type == JTokenType.Boolean)
            {
                value = token.Value<bool>();
                return true;
            }

            value = default;
            return false;
        }

        static bool TryGetInt(JObject obj, string key, out int value)
        {
            var token = obj[key];
            if (token != null && token.Type == JTokenType.Integer)
            {
                var l = token.Value<long>();
                if (l >= int.MinValue && l <= int.MaxValue)
                {
                    value = (int)l;
                    return true;
                }
            }

            value = default;
            return false;
        }

        static bool TryGetLongList(JObject obj, string key, out List<long> value)
        {
            value = new List<long>();
            if (obj[key] is not JArray array)
                return false;

            foreach (var item in array)
            {
                switch (item.Type)
                {
                    case JTokenType.Integer:
                        value.Add(item.Value<long>());
                        break;
                    case JTokenType.String when long.TryParse(item.Value<string>(), out var parsed):
                        value.Add(parsed);
                        break;
                }
            }

            return value.Count > 0;
        }

        void ApplyWafLimitMapFromConf()
        {
            var waf = CoreInit.conf?.WAF?.limit_map;
            if (waf == null)
                return;

            var ours = conf.limit_map ?? new List<WafLimitRootMap>();
            var patterns = new HashSet<string>(StringComparer.Ordinal);
            foreach (var m in ours)
            {
                if (!string.IsNullOrEmpty(m?.pattern))
                    patterns.Add(m.pattern);
            }

            if (patterns.Count == 0)
                return;

            waf.RemoveAll(x => x != null && !string.IsNullOrEmpty(x.pattern) && patterns.Contains(x.pattern));
            foreach (var m in ours)
                waf.Insert(0, m);
        }

        public void Dispose()
        {
            EventListener.UpdateInitFile -= UpdateConfFromInit;
        }
    }
}
