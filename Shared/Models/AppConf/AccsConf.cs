using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Primitives;
using System.Collections.Concurrent;

namespace Shared.Models.AppConf;

public class AccsConf
{
    public bool enable { get; set; }

    public string shared_passwd { get; set; }

    public int shared_daytime { get; set; }

    public string whitepattern { get; set; }

    public HashSet<string> white_uids { get; set; }

    public string domainId_pattern { get; set; }

    public int maxip_hour { get; set; }

    public int maxrequest_hour { get; set; }

    public int maxlock_day { get; set; }

    public int blocked_hour { get; set; }

    public string authMesage { get; set; }

    public string denyMesage { get; set; }

    public string denyGroupMesage { get; set; }

    public string expiresMesage { get; set; }

    public Dictionary<string, object> @params { get; set; }

    public Dictionary<string, DateTime> accounts { get; set; } = new Dictionary<string, DateTime>();

    public ConcurrentBag<AccsUser> users { get; set; } = new ConcurrentBag<AccsUser>();

    // Инвентаризация источников записей accsdb (Task 1.1):
    //  1) корневой users.json (CWD процесса; в Docker /lampac/users.json) — файловое происхождение,
    //     reconcile в Core.Program.UpdateUsersDb через ApplyFileSnapshot();
    //  2) init.conf/init.yaml: accsdb.users[] (десериализация) + accounts{} (MergeAccounts) —
    //     защищены _initUidKeys, reconcile их никогда не удаляет;
    //  3) shared_passwd-флоу (/testaccsdb) пишет строку прямо в users.json — файловое происхождение,
    //     отзывается reconcile при исчезновении строки из файла;
    //  4) white_uids/domainId_pattern/bypass_accsdb — не записи users, в reconcile не участвуют.
    // Нормализация ключей везде — ToLowerAndTrim() (как в RefreshUsers/findUser).

    // Синхронизация структурных изменений users и атомарной пересборки _searchUsers.
    private readonly object _usersSync = new object();

    // Снапшот _searchUsers — инстансное (не static) поле: при hot-reload старый инстанс
    // не должен перезаписывать снапшот нового. Читатели видят либо старый, либо новый словарь.
    private IReadOnlyDictionary<string, AccsUser> _searchUsers;

    // Нормализованные ключи id/ids из init-источников (accsdb.users[] + accounts.Keys).
    // Пересобирается RebuildInitUidKeys() из CoreInit.updateConf/updateYamlConf.
    private HashSet<string> _initUidKeys = new HashSet<string>();

    // Ключи последнего УСПЕШНО применённого users.json. null — снапшота ещё не было
    // (bootstrap: первый reconcile после старта/смены инстанса ничего не удаляет).
    private HashSet<string> _fileUidKeys;

    public void RefreshUsers()
    {
        try
        {
            IReadOnlyDictionary<string, AccsUser> snapshot = null;

            if (users != null && users.Count > 0)
            {
                Dictionary<string, AccsUser> _users = new();

                foreach (AccsUser u in users)
                {
                    if (u == null)
                        continue;

                    if (!string.IsNullOrEmpty(u.id))
                        _users[u.id.ToLowerAndTrim()] = u;

                    if (u.ids != null)
                    {
                        foreach (string uid in u.ids)
                        {
                            if (!string.IsNullOrEmpty(uid))
                                _users[uid.ToLowerAndTrim()] = u;
                        }
                    }
                }

                snapshot = _users;
            }

            lock (_usersSync)
                _searchUsers = snapshot;
        }
        catch { }
    }

    /// <summary>
    /// Пересобирает _initUidKeys из init-источников на момент вызова: accsdb.users[] + accounts.Keys.
    /// clear+refill обязателен: updateYamlConf использует PopulateObject в тот же инстанс,
    /// иначе удалённые из init ключи накапливались бы и защищали уже неактуальные записи.
    /// </summary>
    public void RebuildInitUidKeys()
    {
        var keys = new HashSet<string>();

        if (users != null)
        {
            foreach (var u in users)
            {
                if (u == null)
                    continue;

                AddUidKey(keys, u.id);

                if (u.ids != null)
                {
                    foreach (var id in u.ids)
                        AddUidKey(keys, id);
                }
            }
        }

        if (accounts != null)
        {
            foreach (var account in accounts.Keys)
                AddUidKey(keys, account);
        }

        lock (_usersSync)
            _initUidKeys = keys;
    }

    public void MergeAccounts()
    {
        if (accounts == null || accounts.Count == 0)
            return;

        lock (_usersSync)
        {
            users ??= new ConcurrentBag<AccsUser>();

            RefreshUsers();

            foreach (var account in accounts)
            {
                if (findUser(account.Key) is AccsUser user)
                {
                    if (account.Value > user.expires)
                        user.expires = account.Value;
                }
                else
                {
                    users.Add(new AccsUser()
                    {
                        id = account.Key.ToLowerAndTrim(),
                        expires = account.Value
                    });
                }
            }

            RefreshUsers();
        }
    }

    /// <summary>
    /// Hot-reload init.yaml на живом инстансе: populate + MergeAccounts + RebuildInitUidKeys
    /// под _usersSync, чтобы тик UpdateUsersDb не успел добавить файловые записи в _initUidKeys.
    /// </summary>
    public void ApplyYamlReload(Action populate)
    {
        lock (_usersSync)
        {
            populate?.Invoke();
            MergeAccounts();
            RebuildInitUidKeys();
        }
    }

    /// <summary>
    /// Полный reconcile памяти по валидному снапшоту корневого users.json:
    /// update существующих, add новых, затем удаление записей, которые одновременно
    /// (а) были файловыми (все их ключи были в предыдущем _fileUidKeys),
    /// (б) больше не встречаются в файле (ни один ключ не входит в новый fileKeySet) и
    /// (в) не защищены init.conf (ни один ключ не входит в _initUidKeys).
    /// Если у записи пропал только один алиас из ids при живом id — запись остаётся (update уже обновил поле).
    /// </summary>
    public void ApplyFileSnapshot(List<AccsUser> fileUsers)
    {
        if (fileUsers == null)
            fileUsers = new List<AccsUser>();

        var fileKeySet = new HashSet<string>();

        foreach (var user in fileUsers)
        {
            if (user == null)
                continue;

            AddUidKey(fileKeySet, user.id);

            if (user.ids != null)
            {
                foreach (var id in user.ids)
                    AddUidKey(fileKeySet, id);
            }
        }

        List<AccsUser> removed = null;

        lock (_usersSync)
        {
            users ??= new ConcurrentBag<AccsUser>();

            // bootstrap: первый успешный reconcile после старта/смены инстанса — без удалений,
            // иначе стартовый тик снёс бы записи из init.conf.
            bool bootstrap = _fileUidKeys == null;
            HashSet<string> prevFileKeys = _fileUidKeys;
            HashSet<string> initKeys = _initUidKeys ?? new HashSet<string>();

            // update/add — прежняя семантика
            foreach (var user in fileUsers)
            {
                if (user == null)
                    continue;

                try
                {
                    string lookup;
                    if (user.id != null)
                        lookup = user.id;
                    else if (user.ids != null && user.ids.Count > 0)
                        lookup = user.ids[0];
                    else
                        continue; // как раньше: запись без id/ids не добавлялась

                    var find = findUser(lookup);
                    if (find != null)
                    {
                        find.id = user.id;
                        find.ids = user.ids;
                        find.group = user.group;
                        find.IsPasswd = user.IsPasswd;
                        find.expires = user.expires;
                        find.ban = user.ban;
                        find.ban_msg = user.ban_msg;
                        find.comment = user.comment;
                        find.@params = user.@params;
                    }
                    else
                    {
                        users.Add(user);
                    }
                }
                catch (Exception ex)
                {
                    Serilog.Log.Error(ex, "{Class} {CatchId}", "Program", "id_85syu64t");
                }
            }

            // remove — только бывшие файловые записи, не защищённые init
            if (!bootstrap && prevFileKeys != null && prevFileKeys.Count > 0)
            {
                var current = users.ToList();

                foreach (var u in current)
                {
                    var keys = UserKeys(u);
                    if (keys.Count == 0)
                        continue;

                    if (keys.Any(k => initKeys.Contains(k)))
                        continue;

                    if (!keys.All(k => prevFileKeys.Contains(k)))
                        continue;

                    if (keys.Any(k => fileKeySet.Contains(k)))
                        continue;

                    (removed ??= new List<AccsUser>()).Add(u);
                }

                if (removed != null)
                    users = new ConcurrentBag<AccsUser>(current.Except(removed));
            }

            // коммит состава файла — после успешного применения (в т.ч. для валидного [])
            _fileUidKeys = fileKeySet;
        }

        RefreshUsers();

        if (removed != null)
        {
            Serilog.Log.Information("UsersDbReconcile removed={Removed} uids={Uids}",
                removed.Count,
                string.Join(",", removed.Take(5).Select(u => CrypTo.md5(u.id ?? u.ids?.FirstOrDefault() ?? "unknown"))));
        }
    }

    private static void AddUidKey(HashSet<string> keys, string value)
    {
        if (string.IsNullOrEmpty(value))
            return;

        string key = value.ToLowerAndTrim();
        if (!string.IsNullOrEmpty(key))
            keys.Add(key);
    }

    private static HashSet<string> UserKeys(AccsUser user)
    {
        var keys = new HashSet<string>();

        if (user == null)
            return keys;

        AddUidKey(keys, user.id);

        if (user.ids != null)
        {
            foreach (var id in user.ids)
                AddUidKey(keys, id);
        }

        return keys;
    }

    /// <summary>
    /// Немедленное удаление uid из памяти accsdb (Sprint 2), без ожидания reconcile.
    /// Пустой/null uid игнорируется, повторный вызов — no-op, исключений не бросает.
    /// _fileUidKeys не трогаем: файл — источник истины, reconcile вернёт запись,
    /// если она всё ещё есть в файле.
    /// </summary>
    public void RemoveUid(string uid)
    {
        if (string.IsNullOrWhiteSpace(uid))
            return;

        RemoveUids(new[] { uid });
    }

    /// <summary>
    /// Пакетное удаление uid из памяти под _usersSync. Записи, у которых хотя бы один ключ
    /// (id или ids) входит в _initUidKeys, не трогаются вовсе (как в ApplyFileSnapshot).
    /// Записи с нормализованным id == uid удаляются целиком; у остальных uid вычищается из ids
    /// (без учёта регистра); запись без id и ids после вычистки тоже удаляется. Затем users
    /// пересобирается и вызывается RefreshUsers().
    /// </summary>
    public void RemoveUids(IEnumerable<string> uids)
    {
        if (uids == null)
            return;

        var keys = new HashSet<string>();
        foreach (var uid in uids)
        {
            if (string.IsNullOrWhiteSpace(uid))
                continue;

            string key = uid.ToLowerAndTrim();
            if (!string.IsNullOrEmpty(key))
                keys.Add(key);
        }

        if (keys.Count == 0)
            return;

        lock (_usersSync)
        {
            if (users == null || users.Count == 0)
                return;

            var initKeys = _initUidKeys ?? new HashSet<string>();
            var current = users.ToList();
            var kept = new List<AccsUser>(current.Count);
            bool changed = false;

            foreach (var user in current)
            {
                if (user == null)
                {
                    changed = true;
                    continue;
                }

                // record-level защита init-записей (как в ApplyFileSnapshot): если хотя бы один
                // ключ записи пришёл из init.conf/accounts — запись не трогаем вовсе.
                if (UserKeys(user).Any(k => initKeys.Contains(k)))
                {
                    kept.Add(user);
                    continue;
                }

                // удаление записи по id
                if (!string.IsNullOrEmpty(user.id)
                    && keys.Contains(user.id.ToLowerAndTrim()))
                {
                    changed = true;
                    continue;
                }

                // вычистка удаляемых ключей из ids
                bool idsChanged = false;
                if (user.ids != null && user.ids.Count > 0)
                {
                    var newIds = new List<string>(user.ids.Count);

                    foreach (var id in user.ids)
                    {
                        if (string.IsNullOrEmpty(id))
                        {
                            // пустой элемент не несём дальше, но фиксируем изменение, чтобы оно закоммитилось
                            changed = true;
                            idsChanged = true;
                            continue;
                        }

                        string norm = id.ToLowerAndTrim();
                        if (keys.Contains(norm))
                        {
                            changed = true;
                            idsChanged = true;
                            continue;
                        }

                        newIds.Add(id);
                    }

                    if (newIds.Count != user.ids.Count)
                        user.ids = newIds;
                }

                // если после вычистки у записи не осталось ни id, ни ids — удалить её.
                // Проверяем только затронутые записи, чтобы не вычищать посторонние битые.
                if (idsChanged && string.IsNullOrEmpty(user.id) && (user.ids == null || user.ids.Count == 0))
                {
                    changed = true;
                    continue;
                }

                kept.Add(user);
            }

            if (!changed)
                return;

            users = new ConcurrentBag<AccsUser>(kept);
        }

        RefreshUsers();
    }

    public AccsUser findUser(HttpContext httpContext, out string uid)
    {
        if (users == null || users.Count == 0)
        {
            uid = null;
            return null;
        }

        var user = findUser(httpContext.Request.Query["token"]) ??
                   findUser(httpContext.Request.Query["account_email"]) ??
                   findUser(httpContext.Request.Query["uid"]) ??
                   findUser(httpContext.Request.Query["box_mac"]);

        if (user != null)
        {
            uid = user.id;
            return user;
        }

        uid = null;
        return null;
    }

    public AccsUser findUser(StringValues uid)
    {
        if (uid.Count == 0 || _searchUsers == null || _searchUsers.Count == 0)
            return null;

        uid = uid[0].ToLowerAndTrim();
        if (string.IsNullOrEmpty(uid))
            return null;

        if (_searchUsers.TryGetValue(uid, out AccsUser _user))
            return _user;

        return null;
    }
}
