using System.Collections.Generic;
using Shared.Models.AppConf;
using Shared.Models.Module;

namespace TelegramAuth.Models
{
    public class TelegramAuthConf : ModuleBaseConf
    {
        public bool enable { get; set; }

        public string? data_dir { get; set; }

        public string legacy_import_path { get; set; } = "";

        public bool enable_import { get; set; } = true;

        public bool enable_cleanup { get; set; } = true;

        public int max_active_devices_per_user { get; set; }

        public string mutations_api_secret { get; set; } = "";

        public long[]? owner_telegram_ids { get; set; }

        public bool auto_provision_users { get; set; }

        public string auto_provision_role { get; set; } = "user";

        public string auto_provision_lang { get; set; } = "ru";

        public int auto_provision_expires_days { get; set; }

        public bool auto_provision_activate_immediately { get; set; }

        public int accsdb_sync_group_admin { get; set; } = 100;

        public int accsdb_sync_group_user { get; set; }

        /// <summary>
        /// Секция бота (консолидация бывшего отдельного модуля TelegramAuthBot).
        /// </summary>
        public TelegramAuthBotSectionConf bot { get; set; } = new();
    }

    /// <summary>
    /// Подсекция bot.* внутри TelegramAuth (план слияния, задача 1.2).
    /// Все поля nullable/с дефолтами: старые конфиги без секции bot десериализуются в дефолтный объект.
    /// </summary>
    public class TelegramAuthBotSectionConf
    {
        public bool enable { get; set; } = true;

        public string? token { get; set; }

        public string? username { get; set; }

        public string? display_name { get; set; }

        public List<long>? admin_chat_ids { get; set; }

        public List<long>? owner_telegram_ids { get; set; }

        public bool? notify_admins_on_pending_provision { get; set; }

        public int? request_timeout_sec { get; set; }
    }
}
