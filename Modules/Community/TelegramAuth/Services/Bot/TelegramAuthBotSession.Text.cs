using Newtonsoft.Json.Linq;
using TelegramAuth;

namespace TelegramAuth.Services.Bot
{
    sealed partial class TelegramAuthBotSession
    {
        static string TruncateForTelegram(string s, int max)
        {
            if (string.IsNullOrEmpty(s))
                return "";
            if (s.Length <= max)
                return s;
            return s.Substring(0, max - 1) + "…";
        }

        static string StripJsonError(string msg)
        {
            if (string.IsNullOrEmpty(msg))
                return "";
            try
            {
                var obj = JObject.Parse(msg);
                if (obj.TryGetValue("detail", out var detail) && detail.Type != JTokenType.Null)
                    return detail.Value<string>() ?? "";
                if (obj.TryGetValue("error", out var error) && error.Type != JTokenType.Null)
                    return error.Value<string>() ?? "";
            }
            catch
            {
                // не JSON — возвращаем вход как есть (fallback)
            }
            return msg.Trim();
        }

        static string EscapeHtml(string s)
        {
            if (string.IsNullOrEmpty(s))
                return "";
            return s
                .Replace("&", "&amp;")
                .Replace("<", "&lt;")
                .Replace(">", "&gt;")
                .Replace("\"", "&quot;");
        }
    }
}
