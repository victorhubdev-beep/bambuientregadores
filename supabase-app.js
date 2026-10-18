(() => {
  const config = window.BAMBUI_SUPABASE || {};
  let authFlowType = new URLSearchParams(window.location.hash.slice(1)).get('type') || new URLSearchParams(window.location.search).get('type');
  const client = window.supabase && config.url && config.anonKey
    ? window.supabase.createClient(config.url, config.anonKey)
    : null;
  let user = null;
  let currentProfile = null;
  let stores = [];
  let couriers = [];
  let passwordSetupShown = false;
  window.activeDriver = '';
  document.addEventListener('DOMContentLoaded', () => { window.activeDriver = ''; });

  function notifyUser(message) {
    const toast = document.querySelector('#toast');
    toast.textContent = message;
    toast.style.display = 'block';
    clearTimeout(window.toastTimer);
    window.toastTimer = setTimeout(() => { toast.style.display = 'none'; }, 3800);
  }

  function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
  }

  function renderStoresPage() {
    const container = document.querySelector('#storeRows');
    if (!container) return;
    container.innerHTML = stores.length
      ? stores.map(store => `<tr><td>${escapeHtml(store.name)}</td><td>Comércio local</td><td><span class="status done">Ativa</span></td></tr>`).join('')
      : '<tr><td colspan="3">Nenhuma loja cadastrada no Supabase.</td></tr>';
  }

  function renderCouriersPage() {
    const html = couriers.map(courier => `<div class="rider"><div class="avatar">${escapeHtml(courier.name.split(' ').map(part => part[0]).slice(0, 2).join(''))}</div><div class="rider-info"><strong>${escapeHtml(courier.name)}</strong><small>Conta autenticada pelo Supabase</small></div><span class="pill online">Ativo</span></div>`).join('') || '<div class="empty">Nenhum motoboy ativo cadastrado no Supabase.</div>';
    for (const selector of ['#riderList', '#allRiders']) {
      const container = document.querySelector(selector);
      if (container) container.innerHTML = html;
    }
  }

  async function fetchProfile(userId) {
    return client.from('profiles').select('id,full_name,role,active').eq('id', userId).maybeSingle();
  }

  function showPasswordSetup() {
    if (passwordSetupShown || !client) return;
    passwordSetupShown = true;
    const overlay = document.createElement('div');
    overlay.id = 'passwordSetupOverlay';
    overlay.style.cssText = 'position:fixed;inset:0;z-index:10000;background:#101720b8;display:grid;place-items:center;padding:18px;';
    overlay.innerHTML = '<section style="width:min(100%,430px);background:white;border-radius:14px;padding:24px;box-shadow:0 18px 60px #0004;color:#18212e"><p style="margin:0 0 6px;color:#ed1025;font-size:11px;font-weight:800;letter-spacing:1.3px">BAMBUÍ ENTREGADORES</p><h2 style="margin:0 0 8px">Crie sua senha</h2><p style="margin:0 0 18px;color:#778293">Defina uma senha para concluir seu acesso ao aplicativo.</p><form id="passwordSetupForm" style="display:grid;gap:12px"><label style="font-size:12px;font-weight:700">Nova senha<input name="password" type="password" minlength="8" autocomplete="new-password" required style="display:block;width:100%;margin-top:5px;padding:11px;border:1px solid #dfe5ec;border-radius:8px"></label><label style="font-size:12px;font-weight:700">Confirme a senha<input name="confirmation" type="password" minlength="8" autocomplete="new-password" required style="display:block;width:100%;margin-top:5px;padding:11px;border:1px solid #dfe5ec;border-radius:8px"></label><p id="passwordSetupMessage" style="display:none;margin:0;color:#c90b1c;font-size:12px"></p><button type="submit" style="border:0;border-radius:8px;padding:12px;background:#ed1025;color:white;font-weight:800;cursor:pointer">Salvar senha</button><button id="passwordSetupLogout" type="button" style="border:1px solid #e5e9ef;border-radius:8px;padding:10px;background:white;color:#3d4857;font-weight:700;cursor:pointer">Sair</button></form></section>';
    document.body.append(overlay);
    const form = overlay.querySelector('#passwordSetupForm');
    form.addEventListener('submit', async event => {
      event.preventDefault();
      const values = new FormData(form);
      const password = values.get('password');
      const message = overlay.querySelector('#passwordSetupMessage');
      if (password !== values.get('confirmation')) {
        message.textContent = 'As senhas não coincidem.';
        message.style.display = 'block';
        return;
      }
      const button = form.querySelector('button[type="submit"]');
      button.disabled = true;
      button.textContent = 'Salvando...';
      const { error } = await client.auth.updateUser({ password });
      if (error) {
        button.disabled = false;
        button.textContent = 'Salvar senha';
        message.textContent = `Não foi possível salvar a senha: ${error.message}`;
        message.style.display = 'block';
        return;
      }
      authFlowType = null;
      window.history.replaceState({}, document.title, `${window.location.pathname}${window.location.search}`);
      overlay.remove();
      passwordSetupShown = false;
      const profileResult = await fetchProfile(user.id);
      currentProfile = profileResult.error ? null : profileResult.data;
      notifyUser('Senha criada. Acesso ao aplicativo concluído.');
      if (currentProfile?.active) await loadDeliveries();
    });
    overlay.querySelector('#passwordSetupLogout').addEventListener('click', async () => {
      await client.auth.signOut();
      authFlowType = null;
      window.history.replaceState({}, document.title, `${window.location.pathname}${window.location.search}`);
      overlay.remove();
      passwordSetupShown = false;
    });
  }

  const statusFromDatabase = { pending: 'Pendente', in_progress: 'Em andamento', completed: 'Concluída', cancelled: 'Cancelada' };
  const statusToDatabase = { 'Pendente': 'pending', 'Em andamento': 'in_progress', 'Concluída': 'completed', 'Cancelada': 'cancelled' };

  async function loadOptions() {
    const [storeResult, profileResult] = await Promise.all([
      client.from('stores').select('id,name').eq('active', true).order('name'),
      client.from('profiles').select('id,full_name,role,active')
    ]);
    if (storeResult.error) {
      console.error(storeResult.error);
      notifyUser(`Falha ao carregar lojas: ${storeResult.error.message}`);
    } else {
      stores = storeResult.data || [];
    }
    if (!profileResult.error) {
      couriers = (profileResult.data || [])
        .filter(profile => profile.role === 'courier' && profile.active)
        .map(profile => ({ id: profile.id, name: profile.full_name || profile.name || profile.display_name || profile.email || 'Entregador' }));
    }
    for (const formId of ['quickForm', 'modalForm']) {
      const form = document.querySelector(`#${formId}`);
      const storeSelect = form.elements.store;
      const riderSelect = form.elements.rider;
      storeSelect.replaceChildren(new Option('Loja não definida', ''));
      stores.forEach(store => storeSelect.add(new Option(store.name, store.id)));
      riderSelect.replaceChildren(new Option('Atribuir depois', ''));
      couriers.forEach(courier => riderSelect.add(new Option(courier.name, courier.id)));
    }
    renderStoresPage();
    renderCouriersPage();
  }

  async function addStore() {
    if (!signedIn()) return;
    const name = window.prompt('Nome da loja:')?.trim();
    if (!name) return;
    const { data, error } = await client.from('stores')
      .insert({ name, active: true })
      .select('id,name')
      .single();
    if (error) {
      console.error(error);
      notifyUser(`Falha ao cadastrar loja: ${error.message}`);
      return;
    }
    stores = [...stores, data].sort((left, right) => left.name.localeCompare(right.name, 'pt-BR'));
    for (const formId of ['quickForm', 'modalForm']) {
      const select = document.querySelector(`#${formId}`).elements.store;
      select.add(new Option(data.name, data.id));
    }
    renderStoresPage();
    notifyUser('Loja cadastrada no Supabase.');
  }

  async function loadDeliveries() {
    if (!client || !user) return;
    await loadOptions();
    const { data, error } = await client.from('deliveries')
      .select('id,order_code,customer_name,delivery_address,notes,status,store_id,courier_id,created_at')
      .order('created_at', { ascending: false });
    if (error) {
      console.error(error);
      notifyUser(`Falha ao carregar pedidos: ${error.message}`);
      return;
    }
    const deliveries = data.map(row => ({
      dbId: row.id, id: row.order_code, client: row.customer_name, address: row.delivery_address,
      store: stores.find(store => store.id === row.store_id)?.name || 'Loja não definida',
      storeId: row.store_id, rider: couriers.find(courier => courier.id === row.courier_id)?.name || 'Atribuir depois',
      courierId: row.courier_id, notes: row.notes, status: statusFromDatabase[row.status] || row.status
    }));
    window.deliveries.splice(0, window.deliveries.length, ...deliveries);
    window.render();
  }

  async function saveDelivery(delivery) {
    const values = {
      order_code: delivery.orderCode || `BAM-${Date.now()}`,
      customer_name: delivery.client,
      delivery_address: delivery.address,
      notes: delivery.notes || '',
      status: statusToDatabase[delivery.status] || 'pending',
      store_id: delivery.storeId || null,
      courier_id: delivery.courierId || null
    };
    const request = delivery.dbId
      ? client.from('deliveries').update(values).eq('id', delivery.dbId)
      : client.from('deliveries').insert({ ...values, created_by: user.id }).select('id,order_code').single();
    const { data, error } = await request;
    if (error) {
      console.error(error);
      notifyUser(`Falha ao salvar pedido: ${error.message}`);
      return false;
    }
    if (data && data.id) delivery.dbId = data.id;
    if (data && data.order_code) delivery.id = data.order_code;
    return true;
  }

  function signedIn() {
    if (!client) {
      notifyUser('Adicione a chave pública anon em config.js antes de usar o banco.');
      return false;
    }
    if (!user) {
      notifyUser('Entre com a conta administrativa em Configurações.');
      window.showPage('configuracoes');
      return false;
    }
    if (currentProfile?.role !== 'admin' || !currentProfile.active) {
      notifyUser('Esta ação exige uma conta administrativa ativa.');
      return false;
    }
    return true;
  }

  async function assignCourier(id) {
    if (!signedIn()) return;
    const delivery = window.deliveries.find(row => String(row.id) === String(id));
    if (!delivery) return;
    if (!couriers.length) return notifyUser('Nenhum entregador ativo para atribuir.');
    document.querySelector('#assignCourierOverlay')?.remove();
    const overlay = document.createElement('div');
    overlay.id = 'assignCourierOverlay';
    overlay.style.cssText = 'position:fixed;inset:0;z-index:9999;background:#101720b8;display:grid;place-items:center;padding:18px;';
    overlay.innerHTML = `<section role="dialog" aria-modal="true" aria-labelledby="assignCourierTitle" style="width:min(100%,420px);background:white;border-radius:14px;padding:22px;box-shadow:0 18px 60px #0004;color:#18212e"><p style="margin:0 0 6px;color:#ed1025;font-size:11px;font-weight:800;letter-spacing:1.2px">ATRIBUIR ENTREGA</p><h2 id="assignCourierTitle" style="margin:0 0 6px">Pedido #${escapeHtml(delivery.id)}</h2><p style="margin:0 0 16px;color:#778293">Escolha quem fará esta entrega.</p><form id="assignCourierForm" style="display:grid;gap:12px"><label for="assignCourierSelect" style="font-size:12px;font-weight:700">Entregador</label><select id="assignCourierSelect" required style="width:100%;padding:11px;border:1px solid #dfe5ec;border-radius:8px"><option value="">Atribuir depois</option>${couriers.map(courier => `<option value="${escapeHtml(courier.id)}" ${courier.id === delivery.courierId ? 'selected' : ''}>${escapeHtml(courier.name)}</option>`).join('')}</select><p id="assignCourierMessage" style="display:none;margin:0;color:#c90b1c;font-size:12px"></p><div style="display:flex;gap:8px"><button type="button" id="assignCourierCancel" class="btn btn-light" style="flex:1">Cancelar</button><button type="submit" class="btn btn-primary" style="flex:1">Salvar atribuição</button></div></form></section>`;
    document.body.append(overlay);
    const form = overlay.querySelector('#assignCourierForm');
    form.addEventListener('submit', async event => {
      event.preventDefault();
      const selectedId = overlay.querySelector('#assignCourierSelect').value;
      const courier = couriers.find(item => item.id === selectedId) || null;
      const previousCourierId = delivery.courierId;
      const previousRider = delivery.rider;
      delivery.courierId = courier?.id || null;
      delivery.rider = courier?.name || 'Atribuir depois';
      const button = form.querySelector('button[type="submit"]');
      button.disabled = true;
      button.textContent = 'Salvando...';
      if (!(await saveDelivery(delivery))) {
        delivery.courierId = previousCourierId;
        delivery.rider = previousRider;
        button.disabled = false;
        button.textContent = 'Salvar atribuição';
        return;
      }
      overlay.remove();
      window.render();
      notifyUser(courier ? `Entrega atribuída a ${courier.name}.` : 'Entrega ficou sem entregador.');
    });
    overlay.querySelector('#assignCourierCancel').addEventListener('click', () => overlay.remove());
  }

  async function updateDelivery(id, newStatus) {
    if (!user || !currentProfile?.active || !['admin', 'courier'].includes(currentProfile.role)) {
      notifyUser('Entre com uma conta ativa para atualizar esta entrega.');
      return;
    }
    const delivery = window.deliveries.find(row => String(row.id) === String(id));
    if (!delivery) return;
    const oldStatus = delivery.status;
    delivery.status = newStatus;
    window.render();
    if (await saveDelivery(delivery)) notifyUser(`Pedido #${id}: ${newStatus}.`);
    else { delivery.status = oldStatus; window.render(); }
  }

    window.addEventListener('DOMContentLoaded', () => {
    const courierMode = new URLSearchParams(window.location.search).get('modo') === 'entregador';
    if (courierMode) document.body.classList.add('courier-mode');
    const courierTheme = document.createElement('style');
    courierTheme.textContent = `
      .courier-mode .shell{display:none!important}
      .courier-mode .driver-overlay{display:block!important;min-height:100vh}
      .driver-overlay{background:#f5f6f8;color:#20242c}
      .driver-top{position:sticky;top:0;z-index:3;background:#fff;color:#20242c;border-bottom:1px solid #eceef1;box-shadow:0 2px 10px #18212e0b;padding:12px max(16px,calc((100vw - 600px)/2))}
      .driver-top .brand{padding:0}.driver-top .brand-icon{border-radius:14px}.driver-top .brand small{color:#ed1025}
      .driver-top .btn-light{border-radius:999px;padding:9px 12px}
      .driver-wrap{max-width:600px;padding:18px 14px 90px}
      .driver-hero{position:relative;overflow:hidden;border-radius:22px;padding:22px;background:linear-gradient(135deg,#ed1025 0%,#c50c21 60%,#a5091c 100%);box-shadow:0 12px 28px #c50c212e}
      .driver-hero:after{content:'🏍';position:absolute;right:18px;bottom:-18px;font-size:92px;opacity:.12;transform:rotate(-12deg)}
      .driver-hero .driver-badge{position:relative;z-index:1;background:#ffffff25;color:#fff}
      .driver-hero h2{position:relative;z-index:1;font-size:26px;letter-spacing:-.5px}
      .driver-hero p{position:relative;z-index:1;max-width:360px}
      #driverHome>.metrics{gap:9px;margin:0 0 20px}
      #driverHome>.metrics .metric{border:0;border-radius:16px;padding:13px;box-shadow:0 4px 14px #18212e0b}
      #driverHome>.metrics .metric strong{font-size:26px}
      #driverHome>div[style*="justify-content:space-between"]{margin:20px 0 10px}
      #driverHome>div[style*="justify-content:space-between"] h2{font-size:18px;margin:0}
      .driver-card{border:0;border-radius:18px;padding:17px;margin:11px 0;box-shadow:0 5px 18px #18212e0d}
      .driver-card h3{font-size:17px;margin:13px 0 8px}
      .driver-card p{font-size:13px;line-height:1.55}
      .driver-badge{letter-spacing:.2px}
      .driver-actions{display:grid;grid-template-columns:1fr 1fr;gap:9px}
      .driver-actions .btn{min-height:46px;display:inline-flex;align-items:center;justify-content:center;text-decoration:none;border-radius:11px}
      .driver-login{margin:clamp(28px,9vh,76px) auto 20px;border:0;border-radius:22px;padding:22px;box-shadow:0 8px 28px #18212e0d}
      .driver-login h2{font-size:23px;letter-spacing:-.4px}
      .driver-login .form{padding:12px 0 0}
      .driver-login .btn-primary{min-height:48px;border-radius:11px}
      @media(max-width:680px){.driver-top{padding:11px 12px}.driver-top .brand-icon{width:39px;height:39px}.driver-top .brand strong{font-size:15px}.driver-top .btn-light{font-size:0;width:40px;height:40px;padding:0;display:grid;place-items:center}.driver-wrap{padding:14px 12px 82px}.driver-login{margin:30px auto 18px;padding:19px}.driver-actions{grid-template-columns:1fr}.driver-hero{padding:20px}.driver-hero h2{font-size:24px}#driverHome>.metrics{grid-template-columns:repeat(3,minmax(0,1fr))!important}}
    `;
    document.head.append(courierTheme);
    const driverOverlay = document.querySelector('#driverOverlay');
    if (courierMode) {
      driverOverlay.style.display = 'block';
      const homeButton = driverOverlay.querySelector('.driver-top .btn-light');
      if (homeButton) {
        homeButton.textContent = '← Início';
        homeButton.onclick = () => { window.location.href = '/'; };
      }
    }
    const originalRender = window.render;
    window.render = () => {
      originalRender();
      renderStoresPage();
      renderCouriersPage();
      for (const selector of ['#deliveryRows', '#allDeliveryRows']) {
        const body = document.querySelector(selector);
        if (!body) continue;
        const rows = Array.from(body.rows);
        const deliveries = window.deliveries.slice().reverse();
        rows.forEach((row, index) => {
          const delivery = deliveries[index];
          const actions = row.cells[row.cells.length - 1];
          if (!delivery || !actions || actions.querySelector('[data-assign-delivery]')) return;
          const button = document.createElement('button');
          button.type = 'button';
          button.className = 'mini-btn';
          button.dataset.assignDelivery = delivery.id;
          button.textContent = delivery.courierId ? 'Trocar entregador' : 'Atribuir entregador';
          button.style.marginLeft = '6px';
          actions.append(button);
        });
      }
    };
    const courierHeading = document.querySelector('#page-motoboys .panel-head p');
    if (courierHeading) courierHeading.textContent = 'Entregadores com acesso ativo ao aplicativo.';
    window.addStore = addStore;
    window.assignCourier = assignCourier;
    document.addEventListener('click', event => {
      const button = event.target.closest('[data-assign-delivery]');
      if (button) {
        event.preventDefault();
        event.stopPropagation();
        assignCourier(button.dataset.assignDelivery);
      }
    });
    window.addRider = () => notifyUser('Convide o entregador pelo Supabase Auth para criar um acesso seguro.');

    const driverLogin = document.querySelector('#driverLogin');
    const driverDescription = driverLogin.querySelector('p.sub');
    if (driverDescription) driverDescription.textContent = 'Entre com o e-mail e a senha definidos no convite do Supabase.';
    const driverForm = document.querySelector('#driverLoginForm');
    driverForm.innerHTML = '<div class="field"><label for="courierEmail">E-mail</label><input id="courierEmail" name="email" type="email" autocomplete="username" required placeholder="motoboy@exemplo.com"></div><div class="field"><label for="courierPassword">Senha</label><input id="courierPassword" name="password" type="password" autocomplete="current-password" required placeholder="Sua senha do Supabase"></div><button class="btn btn-primary">Entrar</button>';
    const demoWarning = driverLogin.querySelector('p[style]');
    if (demoWarning) demoWarning.remove();
    driverForm.addEventListener('submit', async event => {
      event.preventDefault();
      event.stopImmediatePropagation();
      if (!client) return notifyUser('A conexão segura do aplicativo não está configurada.');
      const form = new FormData(driverForm);
      const { data, error } = await client.auth.signInWithPassword({ email: form.get('email'), password: form.get('password') });
      if (error) return notifyUser('Não foi possível entrar. Confira o e-mail e a senha definidos após aceitar o convite.');
      const result = await fetchProfile(data.user.id);
      if (result.error || !result.data || result.data.role !== 'courier' || !result.data.active) {
        await client.auth.signOut();
        return notifyUser('Esta conta não está cadastrada como motoboy ativo.');
      }
      user = data.user;
      currentProfile = result.data;
      await loadDeliveries();
      window.driverLogin(result.data.full_name || 'Entregador');
    }, true);

    window.openDriverApp = () => {
      document.querySelector('#driverOverlay').style.display = 'block';
      document.querySelector('#driverLogin').style.display = 'block';
      document.querySelector('#driverHome').style.display = 'none';
      driverForm.reset();
    };
    window.driverLogin = name => {
      window.activeDriver = name;
      document.querySelector('#driverLogin').style.display = 'none';
      document.querySelector('#driverHome').style.display = 'block';
      document.querySelector('#driverGreeting').textContent = `Olá, ${name}!`;
      document.querySelector('#driverHome .driver-badge').textContent = 'ÁREA DO ENTREGADOR';
      window.renderDriverDeliveries();
    };
    window.renderDriverDeliveries = () => {
      if (!window.activeDriver) return;
      const mine = window.deliveries.filter(delivery => delivery.courierId === currentProfile?.id);
      document.querySelector('#driverPending').textContent = mine.filter(delivery => delivery.status === 'Pendente').length;
      document.querySelector('#driverMoving').textContent = mine.filter(delivery => delivery.status === 'Em andamento').length;
      document.querySelector('#driverDone').textContent = mine.filter(delivery => delivery.status === 'Concluída').length;
      document.querySelector('#driverDeliveries').innerHTML = mine.length
        ? mine.slice().reverse().map(delivery => `<article class="driver-card"><div style="display:flex;justify-content:space-between;gap:8px;align-items:center"><span class="driver-badge">Pedido #${escapeHtml(delivery.id)}</span><span class="status ${delivery.status === 'Concluída' ? 'done' : delivery.status === 'Em andamento' ? 'moving' : 'pending'}">${escapeHtml(delivery.status)}</span></div><h3>${escapeHtml(delivery.client)}</h3><p>📍 ${escapeHtml(delivery.address)}</p><p>🏪 ${escapeHtml(delivery.store)}</p><div class="driver-actions"><a class="btn btn-light" href="https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(delivery.address)}" target="_blank" rel="noopener noreferrer">Abrir rota</a><button class="btn btn-primary" onclick="driverAdvance(${JSON.stringify(delivery.id)})" ${delivery.status === 'Concluída' ? 'disabled' : ''}>${delivery.status === 'Pendente' ? 'Iniciar entrega' : delivery.status === 'Em andamento' ? 'Confirmar entrega' : 'Concluída'}</button></div></article>`).join('')
        : '<div class="driver-card"><h3>Nenhuma entrega atribuída</h3><p>Peça ao administrador para atribuir um pedido ao seu nome no painel.</p></div>';
    };
    window.driverLogout = async () => {
      if (client) await client.auth.signOut();
      window.activeDriver = '';
      driverForm.reset();
      document.querySelector('#driverLogin').style.display = 'block';
      document.querySelector('#driverHome').style.display = 'none';
    };
    const closeDriverApp = window.closeDriverApp;
    window.closeDriverApp = async () => {
      if (currentProfile?.role === 'courier' && client) await client.auth.signOut();
      closeDriverApp();
    };

    const authState = document.querySelector('#authState');
    if (!client) {
      authState.textContent = 'Configure a chave anon/publicável em config.js.';
    } else {
      const syncSession = async session => {
        user = session?.user || null;
        currentProfile = null;
        if (user) {
          const result = await fetchProfile(user.id);
          if (!result.error) currentProfile = result.data;
          else console.error(result.error);
        }
        authState.textContent = user ? `Conectado: ${user.email}` : 'Desconectado. Use uma conta criada no Supabase Auth.';
        if (user && ['invite', 'recovery'].includes(authFlowType)) {
          showPasswordSetup();
          return;
        }
        if (user && currentProfile?.active) {
          await loadDeliveries();
          if (courierMode && currentProfile.role === 'courier') window.driverLogin(currentProfile.full_name || 'Entregador');
        }
        else if (!user) {
          stores = [];
          couriers = [];
          window.deliveries.splice(0, window.deliveries.length);
          window.render();
        }
      };
      client.auth.getSession().then(({ data }) => {
        if (!data.session) authFlowType = null;
        syncSession(data.session);
      });
      client.auth.onAuthStateChange((event, session) => {
        if (event === 'SIGNED_OUT') authFlowType = null;
        setTimeout(() => syncSession(session), 0);
      });
    }

    document.querySelector('#authForm').addEventListener('submit', async event => {
      event.preventDefault();
      if (!client) return notifyUser('Configure a chave pública anon em config.js.');
      const form = new FormData(event.target);
      const { data, error } = await client.auth.signInWithPassword({ email: form.get('email'), password: form.get('password') });
      if (error) return notifyUser('Login não realizado. Confira e-mail, senha e usuário cadastrado no Supabase Auth.');
      const result = await fetchProfile(data.user.id);
      if (result.error || !result.data || result.data.role !== 'admin' || !result.data.active) {
        await client.auth.signOut();
        return notifyUser('Esta conta não possui perfil administrativo ativo.');
      }
      user = data.user;
      currentProfile = result.data;
      notifyUser('Login realizado.');
      await loadDeliveries();
    });
    document.querySelector('#signOutBtn').addEventListener('click', async () => {
      if (client) await client.auth.signOut();
    });

    for (const formId of ['quickForm', 'modalForm']) {
      const form = document.querySelector(`#${formId}`);
      form.addEventListener('submit', async event => {
        event.preventDefault();
        event.stopImmediatePropagation();
        if (!signedIn()) return;
        const formData = new FormData(form);
        const delivery = {
          id: `temp-${Date.now()}`, client: formData.get('client').trim(),
          orderCode: `BAM-${Date.now()}`, address: formData.get('address').trim(),
          storeId: formData.get('store') || null,
          store: stores.find(store => store.id === formData.get('store'))?.name || 'Loja não definida',
          courierId: formData.get('rider') || null,
          rider: couriers.find(courier => courier.id === formData.get('rider'))?.name || 'Atribuir depois',
          status: 'Pendente', notes: ''
        };
        if (!delivery.client || !delivery.address) return;
        if (!(await saveDelivery(delivery))) return;
        window.deliveries.push(delivery);
        form.reset();
        window.render();
        if (formId === 'modalForm') window.closeModal();
        notifyUser('Entrega salva no Supabase.');
      });
    }

    window.addEventListener('bambui:advance', event => window.advance(event.detail.id));
    window.advance = async id => {
      const row = window.deliveries.find(item => String(item.id) === String(id));
      if (!row) return;
      const next = row.status === 'Pendente' ? 'Em andamento' : row.status === 'Em andamento' ? 'Concluída' : 'Pendente';
      await updateDelivery(id, next);
    };
    window.driverAdvance = async id => {
      const row = window.deliveries.find(item => String(item.id) === String(id));
      if (!row || currentProfile?.role !== 'courier' || row.courierId !== currentProfile.id || !currentProfile.active) return;
      const next = row.status === 'Pendente' ? 'Em andamento' : 'Concluída';
      await updateDelivery(id, next);
    };
    window.driverLogin = name => {
      window.activeDriver = name;
      document.querySelector('#driverLogin').style.display = 'none';
      document.querySelector('#driverHome').style.display = 'block';
      document.querySelector('#driverGreeting').textContent = `Olá, ${name}!`;
      document.querySelector('#driverHome .driver-badge').textContent = 'ÁREA DO ENTREGADOR';
      window.renderDriverDeliveries();
    };
  });
})();
