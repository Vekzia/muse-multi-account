(() => {
  'use strict';
  const tokenKey = 'muse.accessToken';
  const state = { accounts: [], selectedId: null, loading: false, offline: false, workspaceOpen: false, launchGeneration: 0 };
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
      throw new Error(message);
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
    $('launch-button').disabled = false; $('delete-button').disabled = false;
    $('account-status').textContent = account.logged ? 'Muse 会话正在使用。' : '当前没有活跃的 Muse 会话。';
  }
  async function selectAccount(id) {
    const oldId = state.selectedId;
    if (oldId === id && selected()) return;
    const wasOpen = state.workspaceOpen;
    clearWorkspace();
    state.selectedId = id; renderAccounts(); renderDetail();
    try {
      const result = await api(`/api/accounts/${id}/select`, { method: 'POST' });
      state.accounts = state.accounts.map((account) => account.id === id ? result.account : account);
      renderAccounts(); renderDetail();
      if (wasOpen) await launchAccount();
    } catch (error) { setNotice(apiError(error, '切换账号失败。'), 'error'); }
    $('account-drawer').classList.remove('is-open');
  }
  async function loadAccounts() {
    if (!token()) { showTokenDialog(); return; }
    state.loading = true; setNotice(''); showState('loading-state'); $('account-list').setAttribute('aria-busy', 'true');
    try {
      const result = await api(`/api/accounts?sort=${encodeURIComponent($('sort-select').value)}`);
      state.accounts = Array.isArray(result.accounts) ? result.accounts : [];
      state.selectedId = state.accounts.some((account) => account.id === state.selectedId) ? state.selectedId : state.accounts[0]?.id ?? null;
      renderGroups(); renderAccounts(); setConnection(true); state.offline = false;
      if (state.accounts.length) renderDetail(); else showState('empty-state');
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
      state.accounts = state.accounts.map((item) => item.id === account.id ? result.account : item); drafts.proxy = { id: null, version: null }; renderAccounts(); renderDetail(); setNotice('代理设置已保存。', 'success');
    } catch (error) { setNotice(apiError(error, '保存代理失败。'), 'error'); }
  }
  async function createAccount() {
    const name = window.prompt('请输入账号名称'); if (!name || !name.trim()) return;
    try {
      const wasOpen = state.workspaceOpen;
      clearWorkspace();
      const result = await api('/api/accounts', { method: 'POST', body: JSON.stringify({ name: name.trim() }) });
      state.accounts.push(result.account); state.selectedId = result.account.id; resetDrafts(); renderGroups(); renderAccounts(); renderDetail(); setNotice('账号已创建。', 'success');
      if (wasOpen) await launchAccount();
    }
    catch (error) { setNotice(apiError(error, '创建账号失败。'), 'error'); }
  }
  async function launchAccount(target = 'muse-workspace') {
    const account = selected(); if (!account) return;
    const accountId = account.id; const generation = state.launchGeneration;
    try {
      const result = await api('/api/session', { method: 'POST', body: JSON.stringify({ accountId }) });
      if (!result.url || !result.token) throw new Error('账号页面暂不可用');
      if (state.selectedId !== accountId || state.launchGeneration !== generation) return;
      const form = document.createElement('form'); form.method = 'POST'; form.action = result.url; form.target = target; form.hidden = true;
      if (target === 'muse-workspace') { state.workspaceOpen = true; setHidden('workspace-empty', true); setHidden('workspace-loading', false); setHidden('muse-frame', false); }
      const input = document.createElement('input'); input.type = 'hidden'; input.name = 'token'; input.value = result.token; form.appendChild(input); document.body.appendChild(form); form.submit(); form.remove();
    } catch (error) { setNotice(apiError(error, '打开 Muse 失败。'), 'error'); }
  }
  async function deleteAccount() {
    const account = selected(); if (!account || !window.confirm(`确定删除账号“${account.name}”？`)) return;
    try { await api(`/api/accounts/${account.id}`, { method: 'DELETE', headers: { 'If-Match': String(account.version ?? '') } }); state.accounts = state.accounts.filter((item) => item.id !== account.id); state.selectedId = state.accounts[0]?.id ?? null; clearWorkspace(); renderGroups(); renderAccounts(); state.accounts.length ? renderDetail() : showState('empty-state'); setNotice('账号已删除。', 'success'); }
    catch (error) { setNotice(apiError(error, '删除账号失败。'), 'error'); }
  }
  async function clearCookies() {
    const account = selected(); if (!account || !window.confirm('确定清除当前账号的登录 Cookie？')) return;
    try { await api(`/api/accounts/${account.id}/cookies/clear`, { method: 'POST' }); setNotice('当前账号的 Cookie 已清除。', 'success'); }
    catch (error) { setNotice(apiError(error, '清除 Cookie 失败。'), 'error'); }
  }
  async function testProxy() {
    const account = selected(); if (!account) return; $('proxy-status').textContent = '正在检测代理…';
    try { const result = await api(`/api/accounts/${account.id}/proxy/test`, { method: 'POST' }); $('proxy-status').textContent = result.ok ? `代理正常 · ${result.latencyMs} ms` : (result.error || '代理检测失败'); }
    catch (error) { $('proxy-status').textContent = apiError(error, '代理检测失败。'); }
  }
  async function failoverProxy() {
    const account = selected(); if (!account) return; $('proxy-status').textContent = '正在切换备用代理…';
    try { const result = await api(`/api/accounts/${account.id}/proxy/failover`, { method: 'POST' }); state.accounts = state.accounts.map((item) => item.id === account.id ? result.account : item); renderDetail(); setNotice('备用代理已切换。', 'success'); }
    catch (error) { $('proxy-status').textContent = apiError(error, '切换备用代理失败。'); }
  }
  async function authenticatedFetch(path, options = {}) {
    const headers = new Headers(options.headers || {});
    headers.set('Authorization', `Bearer ${token()}`);
    const response = await fetch(path, { ...options, headers, credentials: 'same-origin' });
    if (response.status === 401 || response.status === 403) { setToken(''); showTokenDialog('令牌验证失败，请重试。'); throw new Error('需要重新连接'); }
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
  $('export-button').addEventListener('click', exportBackup); $('import-button').addEventListener('click', () => $('backup-file').click()); $('backup-file').addEventListener('change', () => importBackup($('backup-file').files?.[0])); $('search-input').addEventListener('input', renderAccounts); $('group-select').addEventListener('change', renderAccounts); $('sort-select').addEventListener('change', loadAccounts); $('drawer-toggle').addEventListener('click', () => { const drawer = $('account-drawer'); const open = drawer.classList.toggle('is-open'); $('drawer-toggle').setAttribute('aria-expanded', String(open)); });
  $('sign-out-button').addEventListener('click', () => { eventController?.abort(); setToken(''); location.reload(); });
  if (token()) loadAccounts().then(connectSse); else showTokenDialog();
})();
