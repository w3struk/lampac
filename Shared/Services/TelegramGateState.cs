#nullable enable

namespace Shared.Services;

/// <summary>
/// Единое shared-состояние Telegram auth гейта.
/// Позволяет LampaWeb (и другим модулям) читать состояние гейта без ссылки на модуль TelegramAuth.
/// Единственный writer — TelegramAuth.ModInit.UpdateGateState()
/// (загрузка/hot-reload конфига, после getMe в Спринте 2).
/// Запись происходит только при старте/перезагрузке конфига, чтение — из request-потоков,
/// поэтому простые автосвойства достаточны (см. план, задача 1.1).
/// </summary>
public static class TelegramGateState
{
    public static bool Active { get; set; }

    public static string? BotUsername { get; set; }

    public static string? ServiceName { get; set; }
}
