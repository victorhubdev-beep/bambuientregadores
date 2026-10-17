(() => {
  const config = window.BAMBUI_SUPABASE || {};
  const client = window.supabase && config.url && config.anonKey
    ? window.supabase.createClient(config.url, config.anonKey)
    : null;
  let user = null;
  let currentProfile = null;
  let stores = [];
  let couriers = [];
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
    const originalRender = window.render;
    window.render = () => {
      originalRender();
      renderStoresPage();
      renderCouriersPage();
    };
    const courierHeading = document.querySelector('#page-motoboys .panel-head p');
    if (courierHeading) courierHeading.textContent = 'Entregadores com acesso ativo ao aplicativo.';
    window.addStore = addStore;
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
      window.renderDriverDeliveries();
    };
    window.renderDriverDeliveries = () => {
      if (!window.activeDriver) return;
      const mine = window.deliveries.filter(delivery => delivery.courierId === currentProfile?.id);
      document.querySelector('#driverPending').textContent = mine.filter(delivery => delivery.status === 'Pendente').length;
      document.querySelector('#driverMoving').textContent = mine.filter(delivery => delivery.status === 'Em andamento').length;
      document.querySelector('#driverDone').textContent = mine.filter(delivery => delivery.status === 'Concluída').length;
      document.querySelector('#driverDeliveries').innerHTML = mine.length
        ? mine.slice().reverse().map(delivery => `<article class="driver-card"><div style="display:flex;justify-content:space-between;gap:8px"><span class="driver-badge">Pedido #${escapeHtml(delivery.id)}</span><span class="status">${escapeHtml(delivery.status)}</span></div><h3>${escapeHtml(delivery.client)}</h3><p>📍 ${escapeHtml(delivery.address)}</p><p>🏪 ${escapeHtml(delivery.store)}</p><div class="driver-actions"><button class="btn btn-primary" onclick="driverAdvance(${JSON.stringify(delivery.id)})" ${delivery.status === 'Concluída' ? 'disabled' : ''}>${delivery.status === 'Pendente' ? 'Iniciar entrega' : delivery.status === 'Em andamento' ? 'Confirmar entrega' : 'Concluída'}</button></div></article>`).join('')
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
        if (user && currentProfile?.active) await loadDeliveries();
        else if (!user) {
          stores = [];
          couriers = [];
          window.deliveries.splice(0, window.deliveries.length);
          window.render();
        }
      };
      client.auth.getSession().then(({ data }) => syncSession(data.session));
      client.auth.onAuthStateChange((_event, session) => {
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
      window.renderDriverDeliveries();
    };
  });
})();
