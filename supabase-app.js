(() => {
  const config = window.BAMBUI_SUPABASE || {};
  const client = window.supabase && config.url && config.anonKey
    ? window.supabase.createClient(config.url, config.anonKey)
    : null;
  let user = null;
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

  const statusFromDatabase = { pending: 'Pendente', in_progress: 'Em andamento', completed: 'Concluída', cancelled: 'Cancelada' };
  const statusToDatabase = { 'Pendente': 'pending', 'Em andamento': 'in_progress', 'Concluída': 'completed', 'Cancelada': 'cancelled' };

  async function loadOptions() {
    const [storeResult, profileResult] = await Promise.all([
      client.from('stores').select('id,name').eq('active', true).order('name'),
      client.from('profiles').select('*')
    ]);
    if (!storeResult.error) stores = storeResult.data || [];
    if (!profileResult.error) {
      couriers = (profileResult.data || [])
        .filter(profile => profile.role === 'courier')
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
    return true;
  }

  async function updateDelivery(id, newStatus) {
    if (!signedIn()) return;
    const delivery = window.deliveries.find(row => String(row.id) === String(id));
    if (!delivery) return;
    const oldStatus = delivery.status;
    delivery.status = newStatus;
    window.render();
    if (await saveDelivery(delivery)) notifyUser(`Pedido #${id}: ${newStatus}.`);
    else { delivery.status = oldStatus; window.render(); }
  }

    window.addEventListener('DOMContentLoaded', () => {
    const authState = document.querySelector('#authState');
    if (!client) {
      authState.textContent = 'Configure a chave anon/publicável em config.js.';
    } else {
      client.auth.getSession().then(async ({ data }) => {
        user = data.session?.user || null;
        authState.textContent = user ? `Conectado: ${user.email}` : 'Desconectado. Use uma conta criada no Supabase Auth.';
        await loadDeliveries();
      });
      client.auth.onAuthStateChange((_event, session) => {
        user = session?.user || null;
        authState.textContent = user ? `Conectado: ${user.email}` : 'Desconectado.';
        if (user) loadDeliveries();
      });
    }

    document.querySelector('#authForm').addEventListener('submit', async event => {
      event.preventDefault();
      if (!client) return notifyUser('Configure a chave pública anon em config.js.');
      const form = new FormData(event.target);
      const { error } = await client.auth.signInWithPassword({ email: form.get('email'), password: form.get('password') });
      if (error) return notifyUser('Login não realizado. Confira e-mail, senha e usuário cadastrado no Supabase Auth.');
      notifyUser('Login realizado.');
      await loadDeliveries();
    });
    document.querySelector('#signOutBtn').addEventListener('click', async () => {
      if (client) await client.auth.signOut();
      user = null;
      authState.textContent = 'Desconectado.';
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
      if (!row || row.rider !== window.activeDriver) return;
      if (!signedIn()) return;
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
