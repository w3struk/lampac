using System;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.Extensions.Hosting;
using Telegram.Bot;
using Telegram.Bot.Types;
using TelegramAuth;

namespace TelegramAuth.Services.Bot
{
    public sealed class TelegramAuthBotHostedService : BackgroundService
    {
        const int GetUpdatesLimit = 100;
        const int GetUpdatesTimeoutSeconds = 50;
        static readonly TimeSpan GetUpdatesErrorDelay = TimeSpan.FromSeconds(5);
        static readonly TimeSpan RestartDelay = TimeSpan.FromSeconds(5);

        public TelegramAuthBotHostedService()
        {
        }

        protected override async Task ExecuteAsync(CancellationToken stoppingToken)
        {
            // Изоляция сбоев: перезапуск цикла при исключении (план 2.2).
            while (!stoppingToken.IsCancellationRequested)
            {
                try
                {
                    await RunBotAsync(stoppingToken).ConfigureAwait(false);
                    break;
                }
                catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
                {
                    break;
                }
                catch (Exception ex)
                {
                    TelegramAuthBotSerilog.Log.Error(ex, "CatchId={CatchId}", "id_tgauthbot_execute");
                    try
                    {
                        await Task.Delay(RestartDelay, stoppingToken).ConfigureAwait(false);
                    }
                    catch (OperationCanceledException)
                    {
                        break;
                    }
                }
            }
        }

        async Task RunBotAsync(CancellationToken stoppingToken)
        {
            var conf = ModInit.conf;
            if (!conf.enable || !conf.bot.enable || string.IsNullOrWhiteSpace(conf.bot.token))
            {
                var msg = "TelegramAuth: бот отключён (TelegramAuth.enable=false, bot.enable=false или пустой bot.token); long polling не запущен.";
                Console.WriteLine(msg);
                TelegramAuthBotSerilog.Log.Information("{Message}", msg);
                return;
            }

            var inProcessApi = new TelegramAuthInProcessClient();
            var bot = new TelegramBotClient(conf.bot.token.Trim());
            var displayName = conf.bot.display_name ?? "Lampac NextGen Bot";

            // Ручной bot.username имеет приоритет над getMe — если задан, резолв не нужен.
            bool manualUsernameSet = !string.IsNullOrWhiteSpace(conf.bot.username);

            if (!manualUsernameSet)
            {
                try
                {
                    var getMeTimeout = TimeSpan.FromSeconds(Math.Clamp(ModInit.conf.bot.request_timeout_sec ?? 10, 1, 60));
                    using var cts = new CancellationTokenSource(getMeTimeout);
                    using var linked = CancellationTokenSource.CreateLinkedTokenSource(cts.Token, stoppingToken);
                    var me = await bot.GetMe(linked.Token).ConfigureAwait(false);
                    ModInit._resolvedUsernameCache = me.Username ?? "";
                    TelegramAuthBotSerilog.Log.Information("Telegram OK @{BotUsername}", me.Username);
                }
                catch (Exception ex)
                {
                    // По спеку: при ошибке getMe — warning и ПРОДОЛЖАЕМ (полling работает, гейт активен при наличии токена).
                    TelegramAuthBotSerilog.Log.Warning(ex, "CatchId={CatchId}", "id_tgauthbot_getme");
                    Console.WriteLine("TelegramAuth: GetMe не удался (токен или сеть до api.telegram.org). Продолжаем polling — гейт остаётся активным при наличии токена.");
                }

                // Обновляем shared-состояние после резолва (приоритет: manual > getMe > "").
                ModInit.UpdateGateState();
            }
            else
            {
                ModInit.UpdateGateState();
                TelegramAuthBotSerilog.Log.Warning("TelegramAuth: token not verified via getMe (manual bot.username is set)");
            }

            try
            {
                await bot.DeleteWebhook(dropPendingUpdates: false, stoppingToken).ConfigureAwait(false);
            }
            catch (Exception ex)
            {
                TelegramAuthBotSerilog.Log.Error(ex, "CatchId={CatchId}", "id_tgauthbot_deletewebhook");
            }

            var session = new TelegramAuthBotSession(inProcessApi, displayName);
            var pollMsg =
                $"TelegramAuth: long polling GetUpdates (limit {GetUpdatesLimit}, timeout {GetUpdatesTimeoutSeconds}s).";
            Console.WriteLine(pollMsg);
            TelegramAuthBotSerilog.Log.Information(
                "Long polling GetUpdates limit {Limit} timeout {TimeoutSeconds}s",
                GetUpdatesLimit, GetUpdatesTimeoutSeconds);

            await PollUpdatesAsync(bot, session, stoppingToken).ConfigureAwait(false);
        }

        async Task PollUpdatesAsync(ITelegramBotClient bot, TelegramAuthBotSession session, CancellationToken stoppingToken)
        {
            int? offset = null;
            while (!stoppingToken.IsCancellationRequested)
            {
                Update[] updates;
                try
                {
                    updates = await bot.GetUpdates(
                        offset,
                        limit: GetUpdatesLimit,
                        timeout: GetUpdatesTimeoutSeconds,
                        allowedUpdates: null,
                        cancellationToken: stoppingToken).ConfigureAwait(false);
                }
                catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
                {
                    break;
                }
                catch (Exception ex)
                {
                    TelegramAuthBotSerilog.Log.Error(ex, "CatchId={CatchId}, DelaySeconds={Delay}", "id_tgauthbot_getupdates", GetUpdatesErrorDelay.TotalSeconds);
                    try
                    {
                        await Task.Delay(GetUpdatesErrorDelay, stoppingToken).ConfigureAwait(false);
                    }
                    catch (OperationCanceledException)
                    {
                        break;
                    }

                    continue;
                }

                foreach (var update in updates)
                {
                    offset = update.Id + 1;
                    try
                    {
                        await session.HandleUpdateAsync(bot, update, stoppingToken).ConfigureAwait(false);
                    }
                    catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
                    {
                        throw;
                    }
                    catch (Exception ex)
                    {
                        TelegramAuthBotSerilog.Log.Error(ex, "CatchId={CatchId}, UpdateId={UpdateId}", "id_tgauthbot_update", update.Id);
                    }
                }
            }
        }
    }
}
