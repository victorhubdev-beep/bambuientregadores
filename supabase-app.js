(() => {
  const config = window.BAMBUI_SUPABASE || {};
  const client = window.supabase && config.url && config.anonKey
    ? window.supabase.createClient(config.url, config.anonKey)
    : null;
  let user = null;
  window.activeDriver = '';
  document.addEventListener('DOMContentLoaded', () => { window.activeDriver = ''; });

  function notifyUser(message) {
    const toast = document.querySelector('#toast');
    toast.textContent = message;
    toast.style.display = 'block';
    clearTimeout(window.toastTimer);
    window.toastTimer = setTimeout(() => { toast.style.display = 'none'; }, 3800);
  }

  async function loadDeliveries() {
    if (!client || !user) return;
    const { data, error } = await client.from('deliveries')
      .select('id,client,address,store,rider,status,created_at')
      .order('created_at', { ascending: false });
    if (error) {
      console.error(error);
      notifyUser('Falha ao carregar pedidos. Confira a tabela e as políticas RLS.');
      return;
    }
    const deliveries = data.map(row => ({
      dbId: row.id, id: row.id, client: row.client, address: row.address,
      store: row.store, rider: row.rider, status: row.status
    }));
    window.deliveries.splice(0, window.deliveries.length, ...deliveries);
    window.render();
  }

  async function saveDelivery(delivery) {
    const values = {
      client: delivery.client, address: delivery.address, store: delivery.store,
      rider: delivery.rider, status: delivery.status
    };
    const request = delivery.dbId
      ? client.from('deliveries').update(values).eq('id', delivery.dbId)
      : client.from('deliveries').insert({ ...values, created_by: user.id }).select('id').single();
    const { data, error } = await request;
    if (error) {
      console.error(error);
      notifyUser('Falha ao salvar no banco. Confira a tabela e as políticas RLS.');
      return false;
    }
    if (data && data.id) delivery.dbId = data.id;
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
          address: formData.get('address').trim(), store: formData.get('store'),
          rider: formData.get('rider'), status: 'Pendente'
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
