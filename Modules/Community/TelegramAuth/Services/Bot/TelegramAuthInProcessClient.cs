using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;
using Newtonsoft.Json.Serialization;
using TelegramAuth;
using TelegramAuth.Models;
using TelegramAuth.Services;

namespace TelegramAuth.Services.Bot
{
    /// <summary>
    /// Тот же публичный API, что использовал LampacTelegramAuthHttpClient,
    /// но реализован in-process через прямые вызовы ModInit.Store (без HTTP и mutations_api_secret).
    /// </summary>
    public interface ITelegramAuthBotBackend
    {
        Task<UserByTelegramDto> GetUserByTelegramAsync(string telegramId, CancellationToken ct);
        Task<DevicesResponseDto> GetDevicesAsync(string telegramId, CancellationToken ct);
        Task<BindCompleteResult> BindCompleteAsync(string uid, string telegramId, string username, CancellationToken ct);
        Task<bool> UnbindDeviceAsync(string telegramId, string uid, CancellationToken ct);
        Task<(bool ok, string detail)> ReactivateDeviceAsync(string telegramId, string uid, CancellationToken ct);
        Task<(bool ok, string detail)> SetDeviceDisplayNameAsync(string uid, string name, CancellationToken ct);
        Task<(ImportResult? result, string? error)> ImportLegacyAsync(CancellationToken ct);
        Task<(int removed, bool disabled)> CleanupDevicesAsync(CancellationToken ct);
        Task<AdminUsersListResponseDto> GetAdminUsersAsync(CancellationToken ct);
        Task<(bool ok, string detail)> SetUserDisabledAsync(string telegramId, bool disabled, CancellationToken ct);
        Task<(bool ok, string detail)> ResolveRegistrationPendingAsync(string telegramId, bool approve, CancellationToken ct);
        Task<AdminUserRowDto> GetAdminUserDetailAsync(string telegramId, CancellationToken ct);
        Task<(bool ok, string detail)> PatchAdminUserAsync(string telegramId, JObject patch, CancellationToken ct);
    }

    sealed class TelegramAuthInProcessClient : ITelegramAuthBotBackend
    {
        static readonly JsonSerializerSettings Camel = new JsonSerializerSettings
        {
            ContractResolver = new CamelCasePropertyNamesContractResolver(),
            NullValueHandling = NullValueHandling.Ignore
        };

        static TelegramAuthStore Store => ModInit.Store;

        public async Task<UserByTelegramDto> GetUserByTelegramAsync(string telegramId, CancellationToken ct)
        {
            try
            {
                var user = Store.FindByTelegramId(telegramId);
                if (user == null)
                    return new UserByTelegramDto { found = false, telegramId = telegramId };

                return new UserByTelegramDto
                {
                    found = true,
                    telegramId = user.TelegramId,
                    username = user.TgUsername,
                    role = user.Role,
                    lang = user.Lang,
                    disabled = user.Disabled,
                    registrationPending = TelegramAuthStore.IsRegistrationPending(user),
                    active = Store.IsActive(user),
                    expiresAt = user.ExpiresAt?.ToString("o"),
                    deviceCount = user.Devices.Count(d => d.Active),
                    maxDevices = Store.GetMaxDevices(user)
                };
            }
            catch (Exception ex)
            {
                TelegramAuthBotSerilog.Log.Error(ex, "GetUserByTelegramAsync failed for {TelegramId}", telegramId);
                return new UserByTelegramDto { found = false, telegramId = telegramId };
            }
        }

        public async Task<DevicesResponseDto> GetDevicesAsync(string telegramId, CancellationToken ct)
        {
            try
            {
                var user = Store.FindByTelegramId(telegramId);
                if (user == null)
                    return null;

                return new DevicesResponseDto
                {
                    telegramId = user.TelegramId,
                    username = user.TgUsername,
                    devices = user.Devices.Select(d => new DeviceDto
                    {
                        uid = d.Uid,
                        name = d.Name,
                        active = d.Active
                    }).ToList()
                };
            }
            catch (Exception ex)
            {
                TelegramAuthBotSerilog.Log.Error(ex, "GetDevicesAsync failed for {TelegramId}", telegramId);
                return null;
            }
        }

        public async Task<BindCompleteResult> BindCompleteAsync(string uid, string telegramId, string username, CancellationToken ct)
        {
            try
            {
                var outcome = Store.BindDevice(telegramId, uid, username, null, "manual-complete");
                return new BindCompleteResult
                {
                    Ok = true,
                    PendingAdminApproval = outcome.PendingAdminApproval
                };
            }
            catch (TelegramAuthBindException ex) when (ex.FailureKind == TelegramAuthBindFailureKind.UserNotFound)
            {
                return new BindCompleteResult();
            }
            catch (TelegramAuthBindException ex) when (ex.FailureKind == TelegramAuthBindFailureKind.UserDisabled)
            {
                return new BindCompleteResult();
            }
            catch (Exception ex)
            {
                TelegramAuthBotSerilog.Log.Error(ex, "BindCompleteAsync failed for {TelegramId}/{Uid}", telegramId, uid);
                return new BindCompleteResult();
            }
        }

        public async Task<bool> UnbindDeviceAsync(string telegramId, string uid, CancellationToken ct)
        {
            try
            {
                var outcome = Store.TryUnbindDevice(telegramId, uid);
                return outcome == TelegramAuthStore.UnbindDeviceOutcome.Ok;
            }
            catch (Exception ex)
            {
                TelegramAuthBotSerilog.Log.Error(ex, "UnbindDeviceAsync failed for {TelegramId}/{Uid}", telegramId, uid);
                return false;
            }
        }

        public async Task<(bool ok, string detail)> ReactivateDeviceAsync(string telegramId, string uid, CancellationToken ct)
        {
            try
            {
                var outcome = Store.TryReactivateDevice(telegramId, uid);
                return (outcome == TelegramAuthStore.ReactivateDeviceOutcome.Ok, DetailFor(outcome));
            }
            catch (Exception ex)
            {
                TelegramAuthBotSerilog.Log.Error(ex, "ReactivateDeviceAsync failed for {TelegramId}/{Uid}", telegramId, uid);
                return (false, ex.Message);
            }
        }

        public async Task<(bool ok, string detail)> SetDeviceDisplayNameAsync(string uid, string name, CancellationToken ct)
        {
            try
            {
                var outcome = Store.TrySetActiveDeviceDisplayName(uid, name);
                return (outcome == TelegramAuthStore.SetDeviceDisplayNameOutcome.Ok, DetailFor(outcome));
            }
            catch (Exception ex)
            {
                TelegramAuthBotSerilog.Log.Error(ex, "SetDeviceDisplayNameAsync failed for {Uid}", uid);
                return (false, ex.Message);
            }
        }

        public async Task<(ImportResult? result, string? error)> ImportLegacyAsync(CancellationToken ct)
        {
            if (!ModInit.conf.enable_import)
                return (null, "import disabled (TelegramAuth.enable_import=false)");

            var legacyPath = ModInit.conf.legacy_import_path?.Trim();
            if (string.IsNullOrEmpty(legacyPath))
                return (null, "legacy_import_path is not configured");

            try
            {
                var result = Store.ImportFromLegacy(legacyPath);
                return (result, null);
            }
            catch (Exception ex)
            {
                return (null, ex.Message);
            }
        }

        public async Task<(int removed, bool disabled)> CleanupDevicesAsync(CancellationToken ct)
        {
            if (!ModInit.conf.enable_cleanup)
                return (0, true);

            try
            {
                return (Store.CleanupInactiveDevices(), false);
            }
            catch (Exception ex)
            {
                TelegramAuthBotSerilog.Log.Warning(ex, "CleanupDevices failed");
                return (0, false);
            }
        }

        public async Task<AdminUsersListResponseDto> GetAdminUsersAsync(CancellationToken ct)
        {
            try
            {
                var users = Store.GetUsers()
                    .OrderBy(u => u.TelegramId, StringComparer.Ordinal)
                    .Select(u => new AdminUserRowDto
                    {
                        telegramId = u.TelegramId,
                        username = u.TgUsername,
                        role = u.Role,
                        disabled = u.Disabled,
                        registrationPending = TelegramAuthStore.IsRegistrationPending(u),
                        active = Store.IsActive(u),
                        expiresAt = u.ExpiresAt?.ToString("o"),
                        deviceCount = u.Devices.Count(d => d.Active),
                        accs = u.Accs == null ? null : new AdminUserAccsBriefDto
                        {
                            group = u.Accs.group,
                            IsPasswd = u.Accs.IsPasswd,
                            ban = u.Accs.ban,
                            ban_msg = u.Accs.ban_msg,
                            comment = u.Accs.comment,
                            ids = u.Accs.ids
                        }
                    }).ToList();

                return new AdminUsersListResponseDto { ok = true, users = users };
            }
            catch (Exception ex)
            {
                TelegramAuthBotSerilog.Log.Error(ex, "GetAdminUsersAsync failed");
                return new AdminUsersListResponseDto { ok = false, users = new List<AdminUserRowDto>() };
            }
        }

        public async Task<(bool ok, string detail)> SetUserDisabledAsync(string telegramId, bool disabled, CancellationToken ct)
        {
            try
            {
                var outcome = Store.TrySetUserDisabled(telegramId.Trim(), disabled);
                return (outcome == TelegramAuthStore.SetUserDisabledOutcome.Ok, DetailFor(outcome));
            }
            catch (Exception ex)
            {
                TelegramAuthBotSerilog.Log.Error(ex, "SetUserDisabledAsync failed for {TelegramId}", telegramId);
                return (false, ex.Message);
            }
        }

        public async Task<(bool ok, string detail)> ResolveRegistrationPendingAsync(string telegramId, bool approve, CancellationToken ct)
        {
            try
            {
                var outcome = approve
                    ? Store.TryApproveRegistrationPending(telegramId.Trim())
                    : Store.TryRejectRegistrationPending(telegramId.Trim());
                return (outcome == TelegramAuthStore.PendingDecisionOutcome.Ok, DetailFor(outcome));
            }
            catch (Exception ex)
            {
                TelegramAuthBotSerilog.Log.Error(ex, "ResolveRegistrationPendingAsync failed for {TelegramId}", telegramId);
                return (false, ex.Message);
            }
        }

        public async Task<AdminUserRowDto> GetAdminUserDetailAsync(string telegramId, CancellationToken ct)
        {
            try
            {
                var user = Store.FindByTelegramId(telegramId.Trim());
                if (user == null)
                    return null;

                return BuildAdminUserDetail(user);
            }
            catch (Exception ex)
            {
                TelegramAuthBotSerilog.Log.Error(ex, "GetAdminUserDetailAsync failed for {TelegramId}", telegramId);
                return null;
            }
        }

        public async Task<(bool ok, string detail)> PatchAdminUserAsync(string telegramId, JObject patch, CancellationToken ct)
        {
            try
            {
                var outcome = Store.TryAdminPatchUser(telegramId.Trim(), patch, out var err);
                if (outcome == TelegramAuthStore.AdminPatchUserOutcome.NotFound)
                    return (false, JsonError("user not found"));
                if (outcome == TelegramAuthStore.AdminPatchUserOutcome.InvalidPayload)
                    return (false, JsonError(err ?? "invalid payload"));

                return (true, JsonConvert.SerializeObject(new { ok = true, telegramId = telegramId.Trim() }, Camel));
            }
            catch (Exception ex)
            {
                TelegramAuthBotSerilog.Log.Error(ex, "PatchAdminUserAsync failed for {TelegramId}", telegramId);
                return (false, ex.Message);
            }
        }

        static AdminUserRowDto BuildAdminUserDetail(TelegramUserRecord user)
        {
            return new AdminUserRowDto
            {
                telegramId = user.TelegramId,
                username = user.TgUsername,
                role = user.Role,
                lang = user.Lang,
                disabled = user.Disabled,
                registrationPending = TelegramAuthStore.IsRegistrationPending(user),
                active = Store.IsActive(user),
                expiresAt = user.ExpiresAt?.ToString("o"),
                deviceCount = user.Devices.Count(d => d.Active),
                maxDevices = Store.GetMaxDevices(user),
                accs = user.Accs == null ? null : new AdminUserAccsBriefDto
                {
                    group = user.Accs.group,
                    IsPasswd = user.Accs.IsPasswd,
                    ban = user.Accs.ban,
                    ban_msg = user.Accs.ban_msg,
                    comment = user.Accs.comment,
                    ids = user.Accs.ids
                },
                devices = user.Devices.Select(d => new DeviceDto
                {
                    uid = d.Uid,
                    name = d.Name,
                    active = d.Active
                }).ToList()
            };
        }

        static string DetailFor<TEnum>(TEnum outcome) where TEnum : struct =>
            JsonConvert.SerializeObject(new { detail = outcome.ToString() }, Camel);

        static string JsonError(string message) =>
            JsonConvert.SerializeObject(new { error = message }, Camel);
    }
}
