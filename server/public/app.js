(() => {
  'use strict';
  const tokenKey = 'muse.accessToken';
  const state = { accounts: [], selectedId: null, loading: false, offline: false, workspaceOpen: false, workspaceTarget: undefined, launchGeneration: 0 };
  const fingerprintDrafts = new Map();
  const fingerprintPending = new Set();
  let fingerprintViewId = null;
  const fingerprintDefaults = { enabled: false, uaMode: 'system', uaCustom: '', timezoneMode: 'proxy', localeMode: 'proxy', timezone: '', locale: '', platform: '', screenWidth: 0, screenHeight: 0, pixelRatio: 0, hardwareConcurrency: 0, deviceMemory: 0, webglVendor: '', webglRenderer: '', noise: false, audioNoise: false, webrtc: false, webdriver: false, tlsProfile: 'native', workerMode: 'native', fontMode: 'native', webgpuMode: 'native' };
  const fingerprintFields = { enabled: 'fp-enabled', uaMode: 'fp-mode', uaCustom: 'fp-custom', timezoneMode: 'fp-timezone-mode', localeMode: 'fp-locale-mode', timezone: 'fp-timezone', locale: 'fp-locale', platform: 'fp-platform', screenWidth: 'fp-width', screenHeight: 'fp-height', pixelRatio: 'fp-ratio', hardwareConcurrency: 'fp-cores', deviceMemory: 'fp-memory', webglVendor: 'fp-vendor', webglRenderer: 'fp-renderer', noise: 'fp-noise', audioNoise: 'fp-audio', webrtc: 'fp-webrtc', webdriver: 'fp-webdriver', tlsProfile: 'fp-tls', workerMode: 'fp-worker', fontMode: 'fp-font', webgpuMode: 'fp-webgpu' };
  const fingerprintPolicies = { tlsProfile: ['native', 'chrome131', 'chrome142'], workerMode: ['native', 'profile'], fontMode: ['native', 'standard'], webgpuMode: ['native', 'disabled'] };
  const regionModes = ['proxy', 'manual', 'native'];
  const regionStatuses = new Map();
  const regionRequests = new Map();
  const regionSyncs = new Map();
  const regionFeedback = new Map();
  const regionReopens = new Map();
  const regionLabels = { disabled: '指纹覆写已关闭', no_proxy: '未配置代理', unknown: '尚未识别', checking: '正在识别', ready: '已识别', error: '识别失败' };
  let regionViewGeneration = 0;
  const maintenanceDrafts = new Map();
  const maintenancePending = new Set();
  const sessionChecks = new Set();
  const sessionRequests = new Map();
  const sessionStatuses = new Map();
  let maintenanceViewId = null;
  let sessionViewGeneration = 0;
  const sessionLabels = { healthy: '会话有效', auth_expired: '需要登录', blocked: '访问受限', error: '检查失败', disabled: '已停用', unknown: '尚未确认', checking: '正在检查' };
  const drafts = { account: { id: null, version: null }, proxy: { id: null, version: null } };
  const resetDrafts = () => { drafts.account = { id: null, version: null }; drafts.proxy = { id: null, version: null }; };
  function markDraft(kind) {
    const account = selected();
    if (account && drafts[kind].id !== account.id) drafts[kind] = { id: account.id, version: account.version };
  }
  function draftVersion(kind, account) { return drafts[kind].id === account.id ? drafts[kind].version : account.version; }
  let eventController;
  let reconnectTimer;
  const $ = (id) => document.getElementById(id);
  const tokenDialog = $('token-dialog');

  function token() { return sessionStorage.getItem(tokenKey) || ''; }
  function setToken(value) { if (value) sessionStorage.setItem(tokenKey, value); else sessionStorage.removeItem(tokenKey); }
  function setHidden(id, hidden) { const element = $(id); if (element) element.hidden = hidden; }
  function setNotice(message, kind = 'info') { const element = $('notice'); element.textContent = message || ''; element.className = `notice notice-${kind}`; element.hidden = !message; }
  function setConnection(connected) {
    const element = $('connection-state');
    element.textContent = connected ? '在线' : '离线';
    element.className = `status-chip ${connected ? 'status-online' : 'status-offline'}`;
  }
  function escapeHtml(value) { return String(value ?? '').replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[char]); }
  function selected() { return state.accounts.find((account) => account.id === state.selectedId); }
  function fingerprintValues(fp = {}) {
    const values = Object.fromEntries(Object.entries(fingerprintDefaults).map(([key, fallback]) => [key, typeof fallback === 'boolean' ? Boolean(fp?.[key] ?? fallback) : String(fp?.[key] ?? fallback)]));
    for (const key of ['locale', 'timezone']) values[`${key}Mode`] = regionModes.includes(fp?.[`${key}Mode`]) ? fp[`${key}Mode`] : String(fp?.[key] ?? '').trim() ? 'manual' : 'proxy';
    return values;
  }
  function readFingerprint() {
    return Object.fromEntries(Object.entries(fingerprintFields).map(([key, id]) => [key, typeof fingerprintDefaults[key] === 'boolean' ? $(id).checked : $(id).value]));
  }
  function fingerprintStatus(message, kind = '') {
    $('fp-status').textContent = message;
    $('fp-status').className = `fp-status${kind ? ` fp-status-${kind}` : ''}`;
  }
  function fingerprintControls() {
    const account = selected(); const busy = account && fingerprintPending.has(account.id);
    const dirty = account && fingerprintDrafts.has(account.id);
    $('fp-form').setAttribute('aria-busy', String(Boolean(busy)));
    Object.values(fingerprintFields).forEach((id) => { $(id).disabled = Boolean(busy); });
    ['fp-generate', 'fp-reset', 'fp-check'].forEach((id) => { $(id).disabled = !account || Boolean(busy); });
    $('fp-save').disabled = !dirty || Boolean(busy); $('fp-discard').disabled = !dirty || Boolean(busy);
    setHidden('fp-custom-label', $('fp-mode').value !== 'custom');
    for (const key of ['locale', 'timezone']) {
      const readOnly = $(`fp-${key}-mode`).value !== 'manual';
      $(`fp-${key}`).readOnly = readOnly;
      $(`fp-${key}`).setAttribute('aria-readonly', String(readOnly));
    }
    if (account) renderFingerprintRegion(account);
  }
  function renderFingerprint(account) {
    const changed = fingerprintViewId !== account.id; const draft = fingerprintDrafts.get(account.id);
    if (changed || !draft) {
      const values = draft?.values || fingerprintValues(account.fp);
      Object.entries(fingerprintFields).forEach(([key, id]) => {
        if (typeof fingerprintDefaults[key] === 'boolean') $(id).checked = values[key]; else $(id).value = values[key];
        $(id).setAttribute('aria-invalid', 'false');
      });
      $('fp-seed').value = String(draft?.seed ?? account.fp?.seed ?? '');
    }
    fingerprintViewId = account.id;
    if (fingerprintPending.has(account.id)) fingerprintStatus('正在保存指纹…');
    else if (draft && draft.version !== account.version) fingerprintStatus('远端账号已更新；草稿仍保留，保存可能冲突。撤销草稿可载入最新配置。', 'error');
    else fingerprintStatus(draft ? '有未保存的指纹更改。' : account.fp?.enabled ? '已保存 · 指纹覆写已启用。' : '已保存 · 当前使用原生兼容模式。');
    fingerprintControls();
  }
  function markFingerprintDraft() {
    const account = selected(); if (!account || fingerprintPending.has(account.id)) return;
    const previous = fingerprintDrafts.get(account.id);
    const draft = previous || { version: account.version, baseline: fingerprintValues(account.fp), seed: account.fp?.seed };
    draft.values = readFingerprint();
    if (JSON.stringify(draft.values) === JSON.stringify(draft.baseline)) fingerprintDrafts.delete(account.id);
    else fingerprintDrafts.set(account.id, draft);
    Object.values(fingerprintFields).forEach((id) => $(id).setAttribute('aria-invalid', 'false'));
    renderFingerprint(account);
  }
  function validatedFingerprint() {
    const fp = readFingerprint();
    function invalid(key, message) {
      const input = $(fingerprintFields[key]); input.setAttribute('aria-invalid', 'true');
      if (['platform', 'screenWidth', 'screenHeight', 'pixelRatio', 'hardwareConcurrency', 'deviceMemory', 'webglVendor', 'webglRenderer', ...Object.keys(fingerprintPolicies)].includes(key)) $('fp-advanced').open = true;
      if (key === 'uaCustom') setHidden('fp-custom-label', false);
      input.focus(); throw new Error(message);
    }
    if (!['system', 'windows', 'macos', 'android', 'custom'].includes(fp.uaMode)) invalid('uaMode', '请选择有效的浏览器预设。');
    for (const key of ['localeMode', 'timezoneMode']) if (!regionModes.includes(fp[key])) invalid(key, '请选择有效的语言或时区来源。');
    for (const [key, values] of Object.entries(fingerprintPolicies)) if (!values.includes(fp[key])) invalid(key, '请选择有效的高级策略。');
    for (const [key, max] of Object.entries({ uaCustom: 2048, timezone: 128, locale: 128, platform: 128, webglVendor: 256, webglRenderer: 512 })) {
      if (/[\u0000-\u001f\u007f]/.test(fp[key]) || fp[key].length > max) invalid(key, '文本包含控制字符或超过长度上限，请检查对应字段。');
      fp[key] = fp[key].trim();
    }
    if (/[^\u0020-\u007e\u0080-\u00ff]/.test(fp.uaCustom)) invalid('uaCustom', 'User-Agent 请使用有效的 HTTP Latin-1 字符。');
    if (fp.uaMode === 'custom' && !fp.uaCustom) invalid('uaCustom', '自定义模式请填写 User-Agent。');
    if (fp.locale) { try { fp.locale = Intl.getCanonicalLocales(fp.locale)[0]; } catch { invalid('locale', '请输入有效的 BCP 47 语言标签，例如 zh-CN。'); } }
    if (fp.timezone) { try { new Intl.DateTimeFormat('en', { timeZone: fp.timezone }); } catch { invalid('timezone', '请输入有效的 IANA 时区，例如 Asia/Shanghai。'); } }
    for (const [key, max, integer] of [['screenWidth', 16384, true], ['screenHeight', 16384, true], ['pixelRatio', 8, false], ['hardwareConcurrency', 256, true], ['deviceMemory', 8, false]]) {
      fp[key] = fp[key].trim() === '' ? 0 : Number(fp[key]);
      if (!Number.isFinite(fp[key]) || fp[key] < 0 || fp[key] > max || (integer && !Number.isInteger(fp[key]))) invalid(key, `请输入 0 至 ${max} 的${integer ? '整数' : '有效数值'}；0 表示原生。`);
    }
    if (fp.pixelRatio !== 0 && fp.pixelRatio < .25) invalid('pixelRatio', '像素比为 0（原生）或 0.25 至 8。');
    if (![0, .25, .5, 1, 2, 4, 8].includes(fp.deviceMemory)) invalid('deviceMemory', '设备内存请选择 0、0.25、0.5、1、2、4 或 8 GB。');
    return fp;
  }
  async function changeFingerprint(action) {
    const account = selected(); if (!account || fingerprintPending.has(account.id)) return;
    const id = account.id; const generation = state.launchGeneration; const wasOpen = state.workspaceOpen; const workspaceTarget = state.workspaceTarget;
    const draft = fingerprintDrafts.get(id); const version = draft?.version ?? account.version;
    let body; let path = `/api/accounts/${id}`; let method = 'PATCH';
    try {
      if (action === 'save') { body = { fp: validatedFingerprint() }; }
      else if (action === 'generate') {
        const mode = $('fp-mode').value;
        if (!['windows', 'macos', 'android'].includes(mode)) { fingerprintStatus('请先选择 Windows、macOS 或 Android 预设，再重新生成。', 'error'); return; }
        body = { mode }; method = 'POST'; path += '/fingerprint/generate';
      } else body = { fp: null };
    } catch (error) { fingerprintStatus(error.message, 'error'); return; }
    const reopenMessage = wasOpen ? '当前页面会重新打开以应用新配置。' : '下次打开账号页面时生效。';
    if (action === 'generate' && !window.confirm(`重新生成会替换指纹草稿和固定种子，并立即保存；保留账号 Cookie。${reopenMessage}`)) return;
    if (action === 'reset' && !window.confirm(`恢复原生会关闭覆写并重置参数，保留账号、Cookie 和固定种子。${reopenMessage}`)) return;
    if (action === 'save' && wasOpen && !window.confirm(`保存指纹后，${reopenMessage}继续保存？`)) return;
    fingerprintPending.add(id); fingerprintControls(); fingerprintStatus('正在保存指纹…');
    try {
      const result = await api(path, { method, headers: { 'If-Match': String(version ?? '') }, body: JSON.stringify(body) });
      if (!result?.account || result.account.id !== id) throw new Error('Invalid response');
      state.accounts = state.accounts.map((item) => item.id === id && (result.account.version ?? 0) >= (item.version ?? 0) ? result.account : item);
      // Only clear the exact draft that this request saved; newer drafts stay untouched.
      if (fingerprintDrafts.get(id) === draft) fingerprintDrafts.delete(id);
      if (state.selectedId === id) {
        renderAccounts(); renderDetail();
        fingerprintStatus(action === 'reset' ? '已恢复原生，账号、Cookie 与种子保留。' : action === 'generate' ? '新指纹已生成并保存，Cookie 保留。' : '指纹已保存。', 'success');
        if (wasOpen && state.launchGeneration === generation) await launchAccount('muse-workspace', workspaceTarget);
      }
    } catch (error) {
      if (state.selectedId === id && state.launchGeneration === generation) {
        const message = error.status === 409 ? '保存冲突：账号已更新，草稿已保留。撤销草稿后可载入最新配置再重试。' : error.status === 400 ? '指纹参数未通过校验，请检查字段后重试；草稿已保留。' : '指纹操作失败，请检查连接后重试；草稿已保留。';
        fingerprintStatus(message, 'error');
      }
    } finally { fingerprintPending.delete(id); fingerprintControls(); }
  }
  function discardFingerprint() {
    const account = selected(); if (!account || fingerprintPending.has(account.id)) return;
    if (!window.confirm('撤销当前账号的指纹草稿并载入最新配置？')) return;
    fingerprintDrafts.delete(account.id); renderFingerprint(account);
  }
  function regionConfiguration(account) {
    const fp = fingerprintValues(account.fp);
    return JSON.stringify([account.proxy || '', fp.enabled, fp.localeMode, fp.timezoneMode]);
  }
  function regionStatus(account) {
    if (!account.fp?.enabled) return { state: 'disabled' };
    if (!account.proxy) return { state: 'no_proxy' };
    const saved = regionStatuses.get(account.id);
    return saved?.configuration === regionConfiguration(account) ? saved.status : { state: 'unknown' };
  }
  function normalizeRegion(result) {
    const value = result?.region;
    if (!value || !Object.hasOwn(regionLabels, value.state)) throw new Error('Invalid region response');
    const status = { state: value.state, checkedAt: null, ip: null, countryCode: null, timezone: null, locale: null, error: null, stale: value.stale === true };
    if (typeof value.checkedAt === 'number' && Number.isFinite(value.checkedAt) && value.checkedAt >= 0 && !Number.isNaN(new Date(value.checkedAt).getTime())) status.checkedAt = value.checkedAt;
    if (typeof value.ip === 'string' && value.ip.length <= 45 && (/^(?:\d{1,3}\.){3}\d{1,3}$/.test(value.ip) || /^[a-f0-9:]+$/i.test(value.ip) && value.ip.includes(':'))) status.ip = value.ip;
    if (typeof value.countryCode === 'string' && /^[A-Z]{2}$/.test(value.countryCode)) status.countryCode = value.countryCode;
    if (typeof value.locale === 'string' && value.locale.length <= 128) { try { status.locale = Intl.getCanonicalLocales(value.locale)[0] || null; } catch {} }
    if (typeof value.timezone === 'string' && value.timezone.length <= 128 && !/[\u0000-\u001f\u007f<>]/.test(value.timezone)) { try { new Intl.DateTimeFormat('en', { timeZone: value.timezone }); status.timezone = value.timezone; } catch {} }
    if (value.error === 'unsupported_country') status.error = 'unsupported_country';
    else if (value.error !== null && value.error !== undefined || value.state === 'error') status.error = 'lookup_failed';
    return status;
  }
  function regionIsSyncing(account) {
    const pending = regionSyncs.get(account.id);
    return Boolean(pending && pending.generation === regionViewGeneration && pending.configuration === regionConfiguration(account));
  }
  function renderFingerprintRegion(account) {
    const status = regionStatus(account); const draft = fingerprintDrafts.has(account.id);
    const enabled = $('fp-enabled').checked;
    for (const key of ['locale', 'timezone']) {
      const mode = $(`fp-${key}-mode`).value; const manual = $(`fp-${key}`).value.trim();
      let message;
      if (!enabled) message = '原生 · 指纹覆写已关闭，地区策略未启用。';
      else if (mode === 'native') message = '原生 · 保持账号页面的原生行为。';
      else if (mode === 'manual') message = manual ? `${manual} · 手动指定。` : '原生 · 手动值留空。';
      else if (!account.proxy) message = '原生 · 未配置代理，自动项未启用。';
      else if (status.state === 'checking' || regionIsSyncing(account)) message = '正在通过账号代理识别出口地区…';
      else if (status[key]) message = `${status[key]} · 代理出口${key === 'locale' ? '国家默认语言建议' : '时区'}${status.stale ? '（缓存已过期，打开时重查）' : ''}。`;
      else if (key === 'locale' && status.error === 'unsupported_country') message = '此国家暂无默认语言映射，请选择手动语言。';
      else if (status.state === 'error') message = '地区识别失败，请重试；自动项就绪后再打开页面。';
      else message = '等待账号代理出口识别；自动项就绪后生效。';
      $(`fp-${key}-effective`).textContent = `${draft ? '草稿保存后生效' : '生效值'}：${message}`;
    }
  }
  function renderRegion(account) {
    const status = regionStatus(account); const syncing = regionIsSyncing(account);
    const current = syncing ? 'checking' : status.state;
    $('region-state').textContent = regionLabels[current] + (status.stale && current === 'ready' ? ' · 缓存已过期' : '');
    $('region-state').className = `status-chip region-state-${current}`;
    $('region-panel')?.setAttribute('aria-busy', String(syncing));
    $('region-sync').disabled = !account.fp?.enabled || !account.proxy || syncing || current === 'checking';
    $('region-ip').textContent = status.ip || '尚无记录';
    $('region-country').textContent = status.countryCode || '尚无记录';
    $('region-locale').textContent = status.locale || (status.error === 'unsupported_country' ? '请手动指定语言' : '尚无记录');
    $('region-timezone').textContent = status.timezone || '尚无记录';
    $('region-checked').textContent = sessionTimestamp(status.checkedAt, '尚未检测');
    const messages = {
      disabled: '指纹覆写已关闭，不应用地区策略，也不执行地区查询。',
      no_proxy: '未配置代理，自动语言与时区未启用，账号页面保持原生行为，不执行地区查询。',
      unknown: '尚无可用的出口地区记录。点击刷新地区，或在打开账号时通过该账号代理识别。',
      checking: '正在通过当前账号代理识别出口地区，请稍候；手动输入保持原值。',
      ready: '地区来自提供方对代理出口 IP 的识别；建议语言按国家默认语言推断，不代表账号使用者的母语，可手动覆盖。',
      error: '代理出口地区识别失败，请检查已保存的代理后重试；不使用工作台设备或服务器地区回退。',
    };
    const notes = [messages[current]];
    if (status.error === 'unsupported_country') notes.push('此国家暂无默认语言映射，请在语言来源中选择手动并指定语言。');
    if (status.stale) notes.push('缓存已过期，打开页面前会重新识别。');
    notes.push('代理变更或地区刷新后，请重新打开页面以应用新地区。');
    const feedback = regionFeedback.get(account.id);
    if (feedback?.generation === regionViewGeneration && feedback.configuration === regionConfiguration(account)) notes.unshift(feedback.message);
    $('region-note').textContent = notes.join(' ');
    $('region-note').className = `region-note${current === 'error' || feedback ? ' region-note-error' : ' muted'}`;
    const reopen = regionReopens.get(account.id);
    setHidden('region-reopen', !state.workspaceOpen || reopen?.generation !== state.launchGeneration || reopen?.viewGeneration !== regionViewGeneration);
    renderFingerprintRegion(account);
  }
  async function refreshRegion(sync = false) {
    const account = selected(); if (!account) return;
    const id = account.id; const generation = regionViewGeneration; const configuration = regionConfiguration(account);
    const prior = regionRequests.get(id); const pendingSync = regionSyncs.get(id);
    if (sync && (!account.fp?.enabled || !account.proxy || regionIsSyncing(account) || regionStatus(account).state === 'checking')) return;
    if (!sync && (prior?.pending && prior.generation === generation && prior.configuration === configuration || pendingSync?.generation === generation && pendingSync.configuration === configuration)) return;
    const previous = regionStatus(account); const request = { generation, configuration, pending: true };
    regionRequests.set(id, request);
    // A failed manual sync must remain visible after background status reads.
    if (sync) regionFeedback.delete(id);
    if (sync) regionSyncs.set(id, request);
    renderRegion(account);
    const current = () => state.selectedId === id && regionViewGeneration === generation && regionRequests.get(id) === request && regionConfiguration(selected()) === configuration;
    try {
      const result = await api(`/api/accounts/${id}/proxy/region${sync ? '/sync' : ''}`, sync ? { method: 'POST' } : {});
      if (!current()) return;
      const status = normalizeRegion(result);
      regionStatuses.set(id, { configuration, status });
      if (state.workspaceOpen && status.state === 'ready' && !status.stale && (sync || previous.checkedAt && previous.checkedAt !== status.checkedAt)) regionReopens.set(id, { generation: state.launchGeneration, viewGeneration: generation });
    } catch (error) {
      if (!current()) return;
      const message = error.status === 401 ? '工作台连接已过期，请重新输入访问令牌。' : error.status === 403 ? '地区接口访问受限（403）；工作台连接已保留。' : sync ? '地区刷新请求失败，请检查连接后重试。' : '地区状态读取失败，可刷新工作台后重试。';
      regionFeedback.set(id, { generation, configuration, message });
    } finally {
      request.pending = false;
      if (regionSyncs.get(id) === request) regionSyncs.delete(id);
      if (current()) renderRegion(selected());
      else if (state.selectedId === id && regionViewGeneration === generation) renderRegion(selected());
    }
  }
  async function reopenRegionWorkspace() {
    const account = selected(); if (!account) return;
    const reopen = regionReopens.get(account.id);
    if (!state.workspaceOpen || reopen?.generation !== state.launchGeneration || reopen?.viewGeneration !== regionViewGeneration) return;
    regionReopens.delete(account.id);
    await launchAccount('muse-workspace', state.workspaceTarget);
    if (state.selectedId === account.id) renderRegion(selected());
  }
  function maintenanceValues(keepAlive = {}) {
    return { enabled: Boolean(keepAlive?.enabled ?? false), intervalMinutes: String(keepAlive?.intervalMinutes ?? 360), wakeVm: Boolean(keepAlive?.wakeVm ?? false) };
  }
  function readMaintenance() {
    return { enabled: $('session-enabled').checked, intervalMinutes: $('session-interval').value, wakeVm: $('session-wake').checked };
  }
  function maintenanceStatus(message, kind = '') {
    $('session-status').textContent = message;
    $('session-status').className = `session-feedback${kind ? ` session-feedback-${kind}` : ''}`;
  }
  function maintenanceControls() {
    const account = selected(); const busy = account && maintenancePending.has(account.id);
    const dirty = account && maintenanceDrafts.has(account.id);
    $('session-form').setAttribute('aria-busy', String(Boolean(busy)));
    ['session-enabled', 'session-interval', 'session-wake'].forEach((id) => { $(id).disabled = !account || Boolean(busy); });
    $('session-save').disabled = !dirty || Boolean(busy); $('session-discard').disabled = !dirty || Boolean(busy);
    $('session-check').disabled = !account || Boolean(busy) || sessionChecks.has(account.id) || sessionStatuses.get(account.id)?.state === 'checking';
  }
  function renderMaintenance(account) {
    const draft = maintenanceDrafts.get(account.id);
    if (maintenanceViewId !== account.id || !draft) {
      const values = draft?.values || maintenanceValues(account.keepAlive);
      $('session-enabled').checked = values.enabled;
      $('session-interval').value = values.intervalMinutes;
      $('session-wake').checked = values.wakeVm;
      $('session-interval').setAttribute('aria-invalid', 'false');
    }
    maintenanceViewId = account.id;
    if (maintenancePending.has(account.id)) maintenanceStatus('正在保存维护设置…');
    else if (draft && draft.version !== account.version) maintenanceStatus('远端账号已更新；维护草稿仍保留，保存可能冲突。撤销草稿可载入最新设置。', 'error');
    else maintenanceStatus(draft ? '有未保存的维护设置。' : account.keepAlive?.enabled ? '已保存 · 定时检查已启用。' : '已保存 · 定时检查已关闭。');
    renderSessionStatus(account); maintenanceControls();
  }
  function markMaintenanceDraft() {
    const account = selected(); if (!account || maintenancePending.has(account.id)) return;
    const draft = maintenanceDrafts.get(account.id) || { version: account.version, baseline: maintenanceValues(account.keepAlive) };
    draft.values = readMaintenance();
    if (JSON.stringify(draft.values) === JSON.stringify(draft.baseline)) maintenanceDrafts.delete(account.id);
    else maintenanceDrafts.set(account.id, draft);
    $('session-interval').setAttribute('aria-invalid', 'false'); renderMaintenance(account);
  }
  async function saveMaintenance(event) {
    event.preventDefault(); const account = selected(); if (!account || maintenancePending.has(account.id)) return;
    const id = account.id; const generation = sessionViewGeneration; const draft = maintenanceDrafts.get(id);
    if (!draft) return;
    const values = readMaintenance(); const intervalMinutes = Number(values.intervalMinutes);
    if (!values.intervalMinutes.trim() || !Number.isInteger(intervalMinutes) || intervalMinutes < 30 || intervalMinutes > 1440) {
      $('session-interval').setAttribute('aria-invalid', 'true'); $('session-interval').focus();
      maintenanceStatus('检查间隔请输入 30 至 1440 的整数分钟。', 'error'); return;
    }
    const keepAlive = { enabled: values.enabled, intervalMinutes, wakeVm: values.wakeVm };
    maintenancePending.add(id); maintenanceControls(); maintenanceStatus('正在保存维护设置…');
    try {
      const result = await api(`/api/accounts/${id}`, { method: 'PATCH', headers: { 'If-Match': String(draft.version ?? '') }, body: JSON.stringify({ keepAlive }) });
      if (!result?.account || result.account.id !== id) throw new Error('Invalid response');
      state.accounts = state.accounts.map((item) => item.id === id && (result.account.version ?? 0) >= (item.version ?? 0) ? result.account : item);
      if (maintenanceDrafts.get(id) === draft) maintenanceDrafts.delete(id);
      if (state.selectedId === id && sessionViewGeneration === generation) {
        renderDetail(); maintenanceStatus('维护设置已保存。', 'success');
        void refreshSessionStatus();
      }
    } catch (error) {
      if (state.selectedId === id && sessionViewGeneration === generation) {
        maintenanceStatus(error.status === 409 ? '保存冲突：账号已更新，维护草稿已保留。撤销草稿后可载入最新设置再重试。' : error.status === 400 ? '维护参数未通过校验，请检查间隔后重试；草稿已保留。' : '保存维护设置失败，请检查连接后重试；草稿已保留。', 'error');
      }
    } finally { maintenancePending.delete(id); maintenanceControls(); }
  }
  function discardMaintenance() {
    const account = selected(); if (!account || maintenancePending.has(account.id)) return;
    if (!window.confirm('撤销当前账号的维护草稿并载入最新设置？')) return;
    maintenanceDrafts.delete(account.id); renderMaintenance(account);
  }
  function normalizeSessionStatus(result) {
    const status = result?.status && typeof result.status === 'object' ? result.status : result;
    const normalized = { state: Object.hasOwn(sessionLabels, status?.state) ? status.state : 'unknown' };
    for (const key of ['lastCheck', 'nextCheck', 'lastSuccess', 'cookieExpiresAt']) {
      const value = status?.[key];
      normalized[key] = typeof value === 'number' && Number.isFinite(value) && value >= 0 && !Number.isNaN(new Date(value).getTime()) ? value : null;
    }
    const vmLabels = { RUNNING: '运行中', AWAKE: '运行中', SLEEPING: '休眠', STOPPED: '已停止', SUSPENDED: '已挂起', STARTING: '启动中', STOPPING: '停止中', DISABLED: '已停用', PENDING: '准备中', UNKNOWN: '未知' };
    const vmState = typeof status?.vmState === 'string' ? status.vmState.toUpperCase() : '';
    normalized.vmState = Object.hasOwn(vmLabels, vmState) ? vmLabels[vmState] : '未知';
    return normalized;
  }
  function sessionTimestamp(value, fallback) { return value === null || value === undefined ? fallback : new Date(value).toLocaleString('zh-CN'); }
  function renderSessionStatus(account) {
    const status = sessionStatuses.get(account.id) || { state: account.keepAlive?.enabled ? 'unknown' : 'disabled' };
    const current = sessionChecks.has(account.id) ? 'checking' : status.state;
    $('session-state').textContent = sessionLabels[current];
    $('session-state').className = `status-chip session-state-${current}`;
    $('session-last-check').textContent = sessionTimestamp(status.lastCheck, '尚未检查');
    $('session-next-check').textContent = sessionTimestamp(status.nextCheck, '未安排');
    $('session-last-success').textContent = sessionTimestamp(status.lastSuccess, '尚无记录');
    $('session-cookie-expiry').textContent = sessionTimestamp(status.cookieExpiresAt, '未提供到期时间');
    $('session-vm-state').textContent = status.vmState || '未知';
    const messages = { healthy: '最近一次检查会话有效；请以真实到期时间为准。', auth_expired: '账号登录已失效，请打开 Muse 完成账号登录后再检查。', blocked: '访问受限（403）不代表退出登录；请检查网络、代理或稍后重试。', error: '最近一次检查失败，请检查连接后重试。', disabled: '定时检查已停用，仍可手动检查当前会话。', unknown: '尚未确认会话有效性，可点击立即检查。', checking: '正在检查当前账号，请稍候…' };
    $('session-check-status').textContent = messages[current];
    $('session-check-status').className = `session-feedback${['auth_expired', 'blocked', 'error'].includes(current) ? ' session-feedback-error' : ''}`;
  }
  async function refreshSessionStatus(check = false) {
    const account = selected(); if (!account || sessionChecks.has(account.id)) return;
    const id = account.id; const generation = sessionViewGeneration;
    const prior = sessionRequests.get(id);
    if (!check && prior?.pending && prior.generation === generation) return;
    // A new manual check supersedes an older read; account switches invalidate both.
    const request = { generation, pending: true }; sessionRequests.set(id, request);
    if (check) { sessionChecks.add(id); renderSessionStatus(account); }
    else $('session-check-status').textContent = '正在读取会话状态…';
    maintenanceControls();
    const current = () => state.selectedId === id && sessionViewGeneration === generation && sessionRequests.get(id) === request;
    try {
      const result = await api(`/api/accounts/${id}/session${check ? '/check' : ''}`, check ? { method: 'POST' } : {});
      if (!current()) return;
      sessionStatuses.set(id, normalizeSessionStatus(result));
    } catch (error) {
      if (!current()) return;
      request.error = error.status === 403 ? '会话接口访问受限（403）；工作台连接已保留，请检查服务配置。' : error.status === 401 ? '工作台连接已过期，请重新输入访问令牌。' : check ? '会话检查请求失败，请检查连接后重试。' : '会话状态读取失败，可刷新或稍后重试。';
    } finally {
      request.pending = false;
      if (check) sessionChecks.delete(id);
      if (current()) {
        renderSessionStatus(selected());
        if (request.error) { $('session-check-status').textContent = request.error; $('session-check-status').className = 'session-feedback session-feedback-error'; }
      }
      maintenanceControls();
    }
  }
  function accountAvatar(account) {
    const value = String(account.avatar || '').trim();
    if (/^https:\/\//i.test(value)) return `<img src="${escapeHtml(value)}" alt="">`;
    return escapeHtml((value || account.name || '?').slice(0, 1).toUpperCase());
  }
  function translateMessage(message, fallback = '操作失败，请稍后重试。') {
    const text = String(message || '');
    const messages = {
      'Authentication required': '需要重新连接。', 'Invalid request': '请求格式无效。', 'Account not found': '账号不存在。',
      'Account changed. Refresh and retry.': '账号已被更新，请刷新后重试。', 'Operation is not configured': '此操作暂未配置。',
      'Proxy probe failed': '代理检测失败。', 'No alternative proxy': '没有可用的备用代理。', 'Request failed': fallback,
    };
    if (messages[text]) return messages[text];
    if (/Failed to fetch|NetworkError|网络连接/i.test(text)) return '网络连接失败，请检查网络后重试。';
    return text || fallback;
  }
  function apiError(error, fallback) { return translateMessage(error instanceof Error ? error.message : '', fallback); }

  async function api(path, options = {}) {
    const headers = new Headers(options.headers || {});
    headers.set('Accept', 'application/json');
    if (token()) headers.set('Authorization', `Bearer ${token()}`);
    if (options.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
    const response = await authenticatedFetch(path, { ...options, headers });
    if (!response.ok) {
      let message = `请求失败（${response.status}）`;
      try { const body = await response.json(); message = body.error || message; } catch {}
      const error = new Error(message); error.status = response.status; throw error;
    }
    return response.status === 204 ? undefined : response.json();
  }

  function showTokenDialog(message = '') {
    $('token-error').textContent = message;
    $('token-error').hidden = !message;
    if (!tokenDialog.open) tokenDialog.showModal();
    $('token-input').focus();
  }
  function showState(name) { ['loading-state', 'empty-state', 'error-state', 'detail-view'].forEach((id) => setHidden(id, id !== name)); }
  function renderGroups() {
    const select = $('group-select');
    const current = select.value;
    const groups = [...new Set(state.accounts.map((account) => account.group).filter(Boolean))].sort((a, b) => a.localeCompare(b));
    select.innerHTML = '<option value="">全部分组</option>' + groups.map((group) => `<option value="${escapeHtml(group)}">${escapeHtml(group)}</option>`).join('');
    select.value = groups.includes(current) ? current : '';
  }
  function renderAccounts() {
    const query = $('search-input').value.trim().toLowerCase();
    const group = $('group-select').value;
    const accounts = state.accounts.filter((account) => (!group || account.group === group) && (!query || `${account.name} ${account.group} ${(account.tags || []).join(' ')}`.toLowerCase().includes(query)));
    const list = $('account-list');
    list.setAttribute('aria-busy', 'false');
    if (!accounts.length) { list.innerHTML = '<div class="list-empty">没有匹配的账号</div>'; return; }
    list.innerHTML = accounts.map((account) => {
      const active = account.id === state.selectedId;
      return `<button class="account-row ${active ? 'is-active' : ''}" data-account-id="${account.id}" type="button" aria-current="${active ? 'true' : 'false'}"><span class="avatar">${accountAvatar(account)}</span><span class="account-row-copy"><strong>${escapeHtml(account.name)}</strong><small>${escapeHtml(account.group || '未分组')}</small></span><span class="account-dot ${account.logged ? 'is-live' : ''}" title="${account.logged ? '已登录' : '未登录'}"></span>${account.pinned ? '<span class="pin" aria-label="已置顶">★</span>' : ''}</button>`;
    }).join('');
    list.querySelectorAll('[data-account-id]').forEach((button) => button.addEventListener('click', () => selectAccount(Number(button.dataset.accountId))));
  }
  function clearWorkspace() {
    const frame = $('muse-frame');
    if (frame) { frame.src = 'about:blank'; frame.hidden = true; }
    setHidden('workspace-loading', true); setHidden('workspace-empty', false);
    state.workspaceOpen = false;
    state.workspaceTarget = undefined;
    state.launchGeneration += 1;
    resetDrafts();
  }
  function renderDetail() {
    const account = selected();
    if (!account) { showState('empty-state'); return; }
    showState('detail-view');
    $('account-title').textContent = account.name;
    $('account-subtitle').textContent = account.group || '未分组';
    if (drafts.account.id !== account.id) {
      $('name-input').value = account.name || '';
      $('avatar-input').value = account.avatar || '';
      $('account-group-input').value = account.group || '';
      $('tags-input').value = (account.tags || []).join(', ');
      $('pinned-input').checked = Boolean(account.pinned);
    }
    if (drafts.proxy.id !== account.id) {
      $('proxy-input').value = account.proxy || '';
      $('proxy-pool-input').value = (account.proxyPool || []).join(', ');
    }
    renderFingerprint(account); renderMaintenance(account); renderRegion(account);
    $('launch-button').disabled = false; $('delete-button').disabled = false;
    $('account-status').textContent = account.logged ? 'Muse 会话正在使用。' : '当前没有活跃的 Muse 会话。';
  }
  async function selectAccount(id) {
    const oldId = state.selectedId;
    if (oldId === id && selected()) return;
    const wasOpen = state.workspaceOpen; const workspaceTarget = state.workspaceTarget;
    clearWorkspace();
    const generation = state.launchGeneration;
    state.selectedId = id; sessionViewGeneration += 1; regionViewGeneration += 1; renderAccounts(); renderDetail(); void refreshSessionStatus(); void refreshRegion();
    try {
      const result = await api(`/api/accounts/${id}/select`, { method: 'POST' });
      state.accounts = state.accounts.map((account) => account.id === id && (result.account.version ?? 0) >= (account.version ?? 0) ? result.account : account);
      if (state.selectedId !== id || state.launchGeneration !== generation) return;
      renderAccounts(); renderDetail();
      if (wasOpen) await launchAccount('muse-workspace', workspaceTarget);
    } catch (error) { setNotice(apiError(error, '切换账号失败。'), 'error'); }
    $('account-drawer').classList.remove('is-open');
  }
  async function loadAccounts() {
    if (!token()) { showTokenDialog(); return; }
    state.loading = true; setNotice(''); showState('loading-state'); $('account-list').setAttribute('aria-busy', 'true');
    try {
      const result = await api(`/api/accounts?sort=${encodeURIComponent($('sort-select').value)}`);
      state.accounts = Array.isArray(result.accounts) ? result.accounts : [];
      const nextId = state.accounts.some((account) => account.id === state.selectedId) ? state.selectedId : state.accounts[0]?.id ?? null;
      if (state.selectedId !== nextId) { sessionViewGeneration += 1; regionViewGeneration += 1; }
      state.selectedId = nextId;
      renderGroups(); renderAccounts(); setConnection(true); state.offline = false;
      if (state.accounts.length) { renderDetail(); void refreshSessionStatus(); void refreshRegion(); } else showState('empty-state');
    } catch (error) { state.offline = true; setConnection(false); showState('error-state'); $('error-copy').textContent = apiError(error, '检查网络连接，然后重试。'); }
    finally { state.loading = false; }
  }
  async function saveAccount(event) {
    event.preventDefault(); const account = selected(); if (!account) return;
    try {
      const result = await api(`/api/accounts/${account.id}`, { method: 'PATCH', headers: { 'If-Match': String(draftVersion('account', account) ?? '') }, body: JSON.stringify({ name: $('name-input').value.trim(), avatar: $('avatar-input').value.trim(), group: $('account-group-input').value.trim(), tags: $('tags-input').value.split(',').map((tag) => tag.trim()).filter(Boolean), pinned: $('pinned-input').checked }) });
      state.accounts = state.accounts.map((item) => item.id === account.id ? result.account : item); drafts.account = { id: null, version: null }; renderGroups(); renderAccounts(); renderDetail(); setNotice('账号资料已保存。', 'success');
    } catch (error) { setNotice(apiError(error, '保存账号失败。'), 'error'); }
  }
  async function saveProxy(event) {
    event.preventDefault(); const account = selected(); if (!account) return;
    const proxy = $('proxy-input').value.trim(); const proxyPool = $('proxy-pool-input').value.split(',').map((value) => value.trim()).filter(Boolean); const patch = {};
    if (!proxy.includes('***')) patch.proxy = proxy;
    if (!proxyPool.some((value) => value.includes('***'))) patch.proxyPool = proxyPool;
    if (!Object.keys(patch).length) { setNotice('请输入完整的新代理地址，或清空字段移除代理。', 'info'); return; }
    try {
      const result = await api(`/api/accounts/${account.id}`, { method: 'PATCH', headers: { 'If-Match': String(draftVersion('proxy', account) ?? '') }, body: JSON.stringify(patch) });
      state.accounts = state.accounts.map((item) => item.id === account.id && (result.account.version ?? 0) >= (item.version ?? 0) ? result.account : item);
      if (state.selectedId === account.id) { drafts.proxy = { id: null, version: null }; renderAccounts(); renderDetail(); void refreshRegion(); setNotice('代理设置已保存；地区由服务器刷新，已打开页面请重新打开。', 'success'); }
    } catch (error) { setNotice(apiError(error, '保存代理失败。'), 'error'); }
  }
  async function createAccount() {
    const name = window.prompt('请输入账号名称'); if (!name || !name.trim()) return;
    try {
      const wasOpen = state.workspaceOpen;
      clearWorkspace();
      const result = await api('/api/accounts', { method: 'POST', body: JSON.stringify({ name: name.trim() }) });
      state.accounts.push(result.account); state.selectedId = result.account.id; sessionViewGeneration += 1; regionViewGeneration += 1; resetDrafts(); renderGroups(); renderAccounts(); renderDetail(); void refreshSessionStatus(); void refreshRegion(); setNotice('账号已创建。', 'success');
      if (wasOpen) await launchAccount();
    }
    catch (error) { setNotice(apiError(error, '创建账号失败。'), 'error'); }
  }
  async function launchAccount(target = 'muse-workspace', pageTarget) {
    const account = selected(); if (!account) return;
    const accountId = account.id; const generation = ++state.launchGeneration;
    try {
      const result = await api('/api/session', { method: 'POST', body: JSON.stringify({ accountId, ...(pageTarget === 'fingerprint' ? { target: 'fingerprint' } : {}) }) });
      if (!result.url || !result.token) throw new Error('账号页面暂不可用');
      if (state.selectedId !== accountId || state.launchGeneration !== generation) return;
      const form = document.createElement('form'); form.method = 'POST'; form.action = result.url; form.target = target; form.hidden = true;
      if (target === 'muse-workspace') { state.workspaceOpen = true; state.workspaceTarget = pageTarget; setHidden('workspace-empty', true); setHidden('workspace-loading', false); setHidden('muse-frame', false); $('muse-frame').title = pageTarget === 'fingerprint' ? '账号指纹自检' : 'Muse 账号页面'; }
      const input = document.createElement('input'); input.type = 'hidden'; input.name = 'token'; input.value = result.token; form.appendChild(input); document.body.appendChild(form); form.submit(); form.remove();
    } catch (error) { setNotice(apiError(error, '打开 Muse 失败。'), 'error'); }
  }
  async function deleteAccount() {
    const account = selected(); if (!account || !window.confirm(`确定删除账号“${account.name}”？`)) return;
    try { await api(`/api/accounts/${account.id}`, { method: 'DELETE', headers: { 'If-Match': String(account.version ?? '') } }); state.accounts = state.accounts.filter((item) => item.id !== account.id); state.selectedId = state.accounts[0]?.id ?? null; sessionViewGeneration += 1; regionViewGeneration += 1; maintenanceDrafts.delete(account.id); sessionStatuses.delete(account.id); regionStatuses.delete(account.id); regionFeedback.delete(account.id); regionReopens.delete(account.id); clearWorkspace(); renderGroups(); renderAccounts(); state.accounts.length ? renderDetail() : showState('empty-state'); void refreshSessionStatus(); void refreshRegion(); setNotice('账号已删除。', 'success'); }
    catch (error) { setNotice(apiError(error, '删除账号失败。'), 'error'); }
  }
  async function clearCookies() {
    const account = selected(); if (!account || !window.confirm('确定清除当前账号的登录 Cookie？')) return;
    try { await api(`/api/accounts/${account.id}/cookies/clear`, { method: 'POST' }); setNotice('当前账号的 Cookie 已清除。', 'success'); }
    catch (error) { setNotice(apiError(error, '清除 Cookie 失败。'), 'error'); }
  }
  async function testProxy() {
    const account = selected(); if (!account) return; $('proxy-status').textContent = '正在检测代理…';
    try { const result = await api(`/api/accounts/${account.id}/proxy/test`, { method: 'POST' }); if (state.selectedId !== account.id) return; $('proxy-status').textContent = result.ok ? `代理正常 · ${result.latencyMs} ms` : '代理检测失败，请检查已保存的代理。'; void refreshRegion(); }
    catch (error) { if (state.selectedId === account.id) $('proxy-status').textContent = '代理检测请求失败，请检查连接后重试。'; }
  }
  async function failoverProxy() {
    const account = selected(); if (!account) return;
    const id = account.id; const generation = state.launchGeneration;
    $('proxy-status').textContent = '正在切换备用代理…';
    try {
      const result = await api(`/api/accounts/${id}/proxy/failover`, { method: 'POST' });
      if (state.selectedId !== id || state.launchGeneration !== generation) return;
      $('proxy-status').textContent = '备用代理已切换，正在读取出口地区…';
      state.accounts = state.accounts.map((item) => item.id === id && (result.account.version ?? 0) >= (item.version ?? 0) ? result.account : item);
      renderDetail(); setNotice('备用代理已切换。', 'success'); void refreshRegion();
    } catch (error) {
      if (state.selectedId === id && state.launchGeneration === generation) $('proxy-status').textContent = apiError(error, '切换备用代理失败。');
    }
  }
  async function authenticatedFetch(path, options = {}) {
    const headers = new Headers(options.headers || {});
    headers.set('Authorization', `Bearer ${token()}`);
    const response = await fetch(path, { ...options, headers, credentials: 'same-origin' });
    if (response.status === 401) { setToken(''); showTokenDialog('令牌验证失败，请重试。'); const error = new Error('需要重新连接'); error.status = 401; throw error; }
    return response;
  }
  async function exportBackup() {
    try {
      const response = await authenticatedFetch('/api/backup/export');
      if (!response.ok) throw new Error('导出备份失败。');
      const blob = await response.blob(); const link = document.createElement('a'); link.href = URL.createObjectURL(blob); link.download = `muse-backup-${new Date().toISOString().slice(0, 10)}.json`; link.click(); URL.revokeObjectURL(link.href); setNotice('备份已导出。', 'success');
    } catch (error) { setNotice(apiError(error, '导出备份失败。'), 'error'); }
  }
  async function importBackup(file) {
    if (!file) return;
    const mode = $('import-mode').value;
    if (mode === 'replace' && !window.confirm('替换模式会删除当前未包含在备份中的账号，确定继续？')) { $('backup-file').value = ''; return; }
    try {
      const text = await file.text(); const response = await authenticatedFetch(`/api/backup/import?mode=${encodeURIComponent(mode)}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: text });
      if (!response.ok) { let message = '导入备份失败。'; try { message = (await response.json()).error || message; } catch {} throw new Error(message); }
      $('backup-file').value = ''; await loadAccounts(); setNotice('备份已导入。', 'success');
    } catch (error) { setNotice(apiError(error, '导入备份失败。'), 'error'); }
  }
  async function connectSse() {
    if (!token()) return; eventController?.abort(); window.clearTimeout(reconnectTimer); const controller = new AbortController(); eventController = controller;
    try {
      const response = await fetch('/api/events', { headers: { Authorization: `Bearer ${token()}`, Accept: 'text/event-stream' }, signal: controller.signal, credentials: 'same-origin' });
      if (response.status === 401) { setToken(''); showTokenDialog('令牌验证失败，请重试。'); return; }
      if (!response.ok || !response.body) throw new Error('状态流暂不可用'); setConnection(true);
      const reader = response.body.getReader(); const decoder = new TextDecoder(); let buffered = '';
      while (!controller.signal.aborted) { const { value, done } = await reader.read(); if (done) break; buffered += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n'); let boundary;
        while ((boundary = buffered.indexOf('\n\n')) >= 0) { const message = buffered.slice(0, boundary); buffered = buffered.slice(boundary + 2); const data = message.split('\n').filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trim()).join('\n'); if (data) { try { const event = JSON.parse(data); if (event.type !== 'connected' && !state.loading) await loadAccounts(); } catch {} } }
      }
    } catch (error) { /* reconnect below */ }
    if (!controller.signal.aborted && token()) { setConnection(false); reconnectTimer = window.setTimeout(connectSse, 5_000); }
  }
  $('token-form').addEventListener('submit', (event) => { event.preventDefault(); const value = $('token-input').value.trim(); if (!value) return; setToken(value); tokenDialog.close(); loadAccounts().then(connectSse); });
  async function refreshSelectedStatus() {
    const account = selected(); if (!account) return;
    try {
      const result = await api(`/api/accounts/${account.id}/status`);
      state.accounts = state.accounts.map((item) => item.id === account.id ? { ...item, logged: Boolean(result.status?.logged) } : item);
      renderAccounts();
      if (state.selectedId === account.id) $('account-status').textContent = result.status?.logged ? 'Muse 会话正在使用。' : '当前没有活跃的 Muse 会话。';
    } catch (error) { setNotice(apiError(error, '刷新登录状态失败。'), 'error'); }
  }
  $('refresh-button').addEventListener('click', loadAccounts); $('error-retry-button').addEventListener('click', loadAccounts); $('empty-create-button').addEventListener('click', createAccount); $('new-account-button').addEventListener('click', createAccount); $('launch-button').addEventListener('click', () => launchAccount()); $('new-tab-button').addEventListener('click', () => launchAccount('_blank')); $('muse-frame').addEventListener('load', () => { setHidden('workspace-loading', true); void refreshSelectedStatus(); }); $('delete-button').addEventListener('click', deleteAccount); $('clear-cookies-button').addEventListener('click', clearCookies); $('proxy-test-button').addEventListener('click', testProxy); $('proxy-failover-button').addEventListener('click', failoverProxy); $('account-form').addEventListener('submit', saveAccount); $('proxy-form').addEventListener('submit', saveProxy);
  ['name-input', 'avatar-input', 'account-group-input', 'tags-input', 'pinned-input'].forEach((id) => $(id).addEventListener('input', () => markDraft('account')));
  ['proxy-input', 'proxy-pool-input'].forEach((id) => $(id).addEventListener('input', () => markDraft('proxy')));
  Object.values(fingerprintFields).forEach((id) => { $(id).addEventListener('input', markFingerprintDraft); $(id).addEventListener('change', markFingerprintDraft); });
  $('fp-form').addEventListener('submit', (event) => { event.preventDefault(); return changeFingerprint('save'); });
  $('fp-generate').addEventListener('click', () => changeFingerprint('generate'));
  $('fp-reset').addEventListener('click', () => changeFingerprint('reset'));
  $('fp-discard').addEventListener('click', discardFingerprint);
  $('fp-check').addEventListener('click', () => launchAccount('muse-workspace', 'fingerprint'));
  ['session-enabled', 'session-interval', 'session-wake'].forEach((id) => { $(id).addEventListener('input', markMaintenanceDraft); $(id).addEventListener('change', markMaintenanceDraft); });
  $('session-form').addEventListener('submit', saveMaintenance);
  $('session-discard').addEventListener('click', discardMaintenance);
  $('session-check').addEventListener('click', () => refreshSessionStatus(true));
  $('region-sync').addEventListener('click', () => refreshRegion(true));
  $('region-reopen').addEventListener('click', reopenRegionWorkspace);
  $('export-button').addEventListener('click', exportBackup); $('import-button').addEventListener('click', () => $('backup-file').click()); $('backup-file').addEventListener('change', () => importBackup($('backup-file').files?.[0])); $('search-input').addEventListener('input', renderAccounts); $('group-select').addEventListener('change', renderAccounts); $('sort-select').addEventListener('change', loadAccounts); $('drawer-toggle').addEventListener('click', () => { const drawer = $('account-drawer'); const open = drawer.classList.toggle('is-open'); $('drawer-toggle').setAttribute('aria-expanded', String(open)); });
  $('sign-out-button').addEventListener('click', () => { eventController?.abort(); setToken(''); location.reload(); });
  if (token()) loadAccounts().then(connectSse); else showTokenDialog();
})();
