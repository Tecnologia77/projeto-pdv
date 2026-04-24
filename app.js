/* =============================================
   STOCK PDV — app.js
   Sistema completo de Gestão
   ============================================= */
'use strict';

// ═══════════════════════════════
//  STATE
// ═══════════════════════════════
let DB = {
  users: [
    {id:1,nome:'Administrador',login:'admin',senha:'admin123',perfil:'admin',ativo:true,ultimo:''},
    {id:2,nome:'Operador Padrão',login:'op',senha:'op123',perfil:'operador',ativo:true,ultimo:''}
  ],
  categorias: [
    {id:1,nome:'Cerveja'},{id:2,nome:'Destilados'},{id:3,nome:'Sucos e Refrigerantes'},
    {id:4,nome:'Energéticos e Isotônicos'},{id:5,nome:'Gelos'},{id:6,nome:'Água'},
    {id:7,nome:'Descartaveis'},{id:8,nome:'Cigarros'},{id:9,nome:'Carvao Churasco'},{id:10,nome:'Bomboniere'}
  ],
  produtos: [
    {id:1,nome:'Cerveja Fardo á prazo',codigo:'7891991234567',catId:1,unidade:'CX',preco:38.00,precoAtacado:34.00,custo:28.00,estoque:25,estoqueMin:5,foto:'',disp:1},
    {id:2,nome:'Cerveja Long Neck',codigo:'7891991234568',catId:1,unidade:'UN',preco:6.50,precoAtacado:5.50,custo:4.00,estoque:107,estoqueMin:20,foto:'',disp:1},
    {id:3,nome:'Cerveja á Vista',codigo:'7891991234569',catId:1,unidade:'UN',preco:5.50,precoAtacado:4.80,custo:3.50,estoque:38,estoqueMin:20,foto:'',disp:1},
    {id:4,nome:'Cerveja Fardo',codigo:'7891991234570',catId:1,unidade:'CX',preco:36.00,precoAtacado:32.00,custo:26.00,estoque:3,estoqueMin:5,foto:'',disp:1},
    {id:5,nome:'Whisky Jack Daniel\'s',codigo:'7891991234571',catId:2,unidade:'UN',preco:120.00,precoAtacado:105.00,custo:85.00,estoque:12,estoqueMin:3,foto:'',disp:1},
    {id:6,nome:'Vodka Smirnoff',codigo:'7891991234572',catId:2,unidade:'UN',preco:45.00,precoAtacado:40.00,custo:30.00,estoque:20,estoqueMin:5,foto:'',disp:1},
    {id:7,nome:'Coca-Cola 2L',codigo:'7891000412866',catId:3,unidade:'UN',preco:12.00,precoAtacado:10.00,custo:7.50,estoque:67,estoqueMin:10,foto:'',disp:1},
    {id:8,nome:'Red Bull 250ml',codigo:'7500435259552',catId:4,unidade:'UN',preco:12.00,precoAtacado:10.00,custo:8.00,estoque:97,estoqueMin:15,foto:'',disp:1},
    {id:9,nome:'Gelo 5kg',codigo:'7891991234575',catId:5,unidade:'PC',preco:8.00,precoAtacado:6.50,custo:3.00,estoque:0,estoqueMin:10,foto:'',disp:1},
    {id:10,nome:'Água Mineral 500ml',codigo:'7891991234576',catId:6,unidade:'UN',preco:3.00,precoAtacado:2.50,custo:1.50,estoque:60,estoqueMin:20,foto:'',disp:1},
    {id:11,nome:'Descartaveis',codigo:'7891991234577',catId:7,unidade:'PC',preco:34.50,precoAtacado:30.00,custo:22.00,estoque:15,estoqueMin:5,foto:'',disp:1},
    {id:12,nome:'Cigarro Marlboro',codigo:'7891991234578',catId:8,unidade:'PC',preco:14.00,precoAtacado:12.00,custo:9.00,estoque:2,estoqueMin:5,foto:'',disp:1},
    {id:13,nome:'Carvão Churasco 5kg',codigo:'7891991234579',catId:9,unidade:'PC',preco:22.00,precoAtacado:19.00,custo:12.00,estoque:8,estoqueMin:5,foto:'',disp:1},
    {id:14,nome:'Chocolate Bis',codigo:'7891991234580',catId:10,unidade:'UN',preco:4.50,precoAtacado:3.80,custo:2.50,estoque:40,estoqueMin:10,foto:'',disp:1},
  ],
  pedidos: [
    {id:44,tipo:'retirada',cliente:'porta',tel:'11',status:'preparacao',itens:[{prodId:11,qty:1,preco:34.50},{prodId:5,qty:5,preco:120.00},{prodId:6,qty:3,preco:45.00}],pgto:'dinheiro',obs:'',descTipo:'desconto',descUnit:'rs',descVal:0,total:817.15,data:new Date(Date.now()-2*3600000).toISOString()},
    {id:43,tipo:'retirada',cliente:'Adega 93',tel:'',status:'preparacao',itens:[{prodId:7,qty:10,preco:12.00},{prodId:8,qty:5,preco:12.00},{prodId:10,qty:20,preco:3.00}],pgto:'pix',obs:'',descTipo:'desconto',descUnit:'rs',descVal:0,total:228.42,data:new Date(Date.now()-18*3600000).toISOString()},
    {id:42,tipo:'retirada',cliente:'Hiago',tel:'',status:'preparacao',itens:[{prodId:5,qty:1,preco:120.00},{prodId:6,qty:2,preco:45.00}],pgto:'credito',obs:'',descTipo:'desconto',descUnit:'rs',descVal:0,total:229.50,data:new Date(Date.now()-26*3600000).toISOString()},
    {id:41,tipo:'retirada',cliente:'Fabio alambique',tel:'',status:'preparacao',itens:[{prodId:1,qty:5,preco:38.00},{prodId:13,qty:4,preco:22.00}],pgto:'dinheiro',obs:'',descTipo:'desconto',descUnit:'rs',descVal:0,total:568.22,data:new Date(Date.now()-30*3600000).toISOString()},
    {id:40,tipo:'entrega',cliente:'Adega 93',tel:'',status:'preparacao',itens:[{prodId:5,qty:5,preco:120.00},{prodId:6,qty:5,preco:45.00},{prodId:7,qty:10,preco:12.00},{prodId:8,qty:10,preco:12.00}],pgto:'pix',obs:'',descTipo:'desconto',descUnit:'rs',descVal:0,total:1417.80,data:new Date(Date.now()-50*3600000).toISOString()},
  ],
  clientes: [
    {id:1,nome:'Adega 93',tipo:'atacado',tel:'11999990001',doc:'12.345.678/0001-00',end:'Rua das Flores, 93',limite:5000,debito:0,desconto:10},
    {id:2,nome:'porta',tipo:'varejo',tel:'11',doc:'',end:'',limite:500,debito:0,desconto:0},
    {id:3,nome:'Hiago',tipo:'varejo',tel:'11999990003',doc:'',end:'',limite:0,debito:0,desconto:0},
    {id:4,nome:'Fabio alambique',tipo:'atacado',tel:'11999990004',doc:'98.765.432/0001-00',end:'Av. Alambique, 100',limite:8000,debito:200,desconto:12},
  ],
  caixa:{aberto:false,saldoInicial:0,entradas:0,saidas:0,abertura:'',movs:[]},
  config:{
    nome:'Distribuidora Brothers PDV',
    cnpj:'00.000.000/0000-00',
    tel:'(11) 98976-0254',
    end:'',
    descAtacado:15,
    qtdAtacado:10,
    estMin:5,
    semEst:'nao',
    clienteNome:'',
    clienteLogo:'',
    printerName:'',
    autoPrint:'sim'
  },
  nextId:{pedido:45,produto:15,cliente:5,user:3},
  lojaAberta:true
};

let currentUser = null;
let currentPage = 'pedidos';
let currentTipo = 'todos';
let currentPedidoId = null;
let npItems = [];
let npTipo = 'entrega';
let npDescTipo = 'desconto';
let npDescUnit = 'pct';
let npCatFilter = 'todos';
let scanBuffer = '';
let scanLastTs = 0;
const SESSION_KEY = 'stockpdv_session_user';
const FIREBASE_DB_PATH = 'stockpdv_atacado/db';
let firebaseReady = false;
let dbRef = null;
let firebaseSyncBound = false;

// ═══════════════════════════════
//  INIT
// ═══════════════════════════════
async function init(){
  await loadDB();
  startClock();
  restoreSession();
  bindScannerListener();
}

async function loadDB(){
  try{
    await initFirebase();
    if(firebaseReady){
      const snap = await dbRef.once('value');
      const remote = snap.val();
      if(remote && typeof remote==='object'){
        DB = remote;
      } else {
        await dbRef.set(DB);
      }
    } else {
      const s = localStorage.getItem('stockpdv_db');
      if(s) DB = JSON.parse(s);
    }
    normalizeDB();
    const localSnap = localStorage.getItem('stockpdv_db');
    if(!localSnap) localStorage.setItem('stockpdv_db', JSON.stringify(DB));
  }catch(e){}
}
function saveDB(){
  try{ localStorage.setItem('stockpdv_db', JSON.stringify(DB)); }catch(e){}
  if(firebaseReady && dbRef){
    dbRef.set(DB).catch(()=>{});
  }
}

async function initFirebase(){
  try{
    if(firebaseReady || !window.firebase) return;
    const cfg = window.STOCKPDV_FIREBASE_CONFIG;
    if(!cfg || !cfg.apiKey) return;
    if(!window.firebase.apps.length){
      window.firebase.initializeApp(cfg);
    }
    dbRef = window.firebase.database().ref(FIREBASE_DB_PATH);
    firebaseReady = true;
    bindFirebaseSync();
  }catch(e){
    firebaseReady = false;
  }
}

function bindFirebaseSync(){
  if(!firebaseReady || !dbRef || firebaseSyncBound) return;
  firebaseSyncBound = true;
  dbRef.on('value', (snap)=>{
    const remote = snap.val();
    if(!remote || typeof remote!=='object') return;
    DB = remote;
    normalizeDB();
    try{ localStorage.setItem('stockpdv_db', JSON.stringify(DB)); }catch(e){}
    refreshCurrentUI();
  });
}

function refreshCurrentUI(){
  if(document.getElementById('app')?.style.display!=='flex') return;
  if(currentPage==='pedidos') renderPedidos();
  else if(currentPage==='cardapio') renderCardapio();
  else if(currentPage==='estoque') renderEstoque();
  else if(currentPage==='clientes') renderClientes();
  else if(currentPage==='financeiro') renderFinanceiro();
  else if(currentPage==='relatorios') renderRelatorios();
  else if(currentPage==='usuarios') renderUsuarios();
  else if(currentPage==='config') renderConfig();
  checkNotifs();
}

function startClock(){
  function tick(){
    const now = new Date();
    const el = document.getElementById('tbClock');
    if(el) el.textContent = now.toLocaleDateString('pt-BR')+' '+now.toLocaleTimeString('pt-BR',{hour:'2-digit',minute:'2-digit',second:'2-digit'});
    setTimeout(tick,1000);
  }
  tick();
}

// ═══════════════════════════════
//  LOGIN
// ═══════════════════════════════
function renderLogin(){
  document.getElementById('loginScreen').style.display='flex';
  document.getElementById('app').style.display='none';
}

function doLogin(){
  const u = document.getElementById('lu').value.trim();
  const p = document.getElementById('lp').value;
  const user = DB.users.find(x=>x.login===u && x.senha===p && x.ativo);
  if(!user){
    document.getElementById('loginErr').classList.add('show');
    document.getElementById('lp').value='';
    return;
  }
  document.getElementById('loginErr').classList.remove('show');
  currentUser = user;
  user.ultimo = new Date().toLocaleString('pt-BR');
  saveSession();
  saveDB();
  enterApp();
}

function enterApp(){
  document.getElementById('loginScreen').style.display='none';
  document.getElementById('app').style.display='flex';
  // Setup user UI
  document.getElementById('sbAvatar').textContent = currentUser.nome[0].toUpperCase();
  document.getElementById('sbName').textContent = currentUser.nome;
  document.getElementById('sbRole').textContent = currentUser.perfil==='admin'?'Administrador':'Operador';
  // Admin-only items
  const adminEls = document.querySelectorAll('.admin-only');
  adminEls.forEach(el=>el.style.display = currentUser.perfil==='admin'?'':'none');
  // Load first page
  applyBranding();
  go('pedidos');
  checkNotifs();
}

function normalizeDB(){
  DB.config = {
    nome:'Distribuidora Brothers PDV',
    cnpj:'00.000.000/0000-00',
    tel:'(11) 98976-0254',
    end:'',
    descAtacado:15,
    qtdAtacado:10,
    estMin:5,
    semEst:'nao',
    clienteNome:'',
    clienteLogo:'',
    printerName:'',
    autoPrint:'sim',
    ...(DB.config||{})
  };
  DB.produtos = (DB.produtos||[]).map(p=>({
    ...p,
    precoAtacado: (typeof p.precoAtacado==='number' && p.precoAtacado>0) ? p.precoAtacado : (p.preco||0),
    preco: (typeof p.precoAtacado==='number' && p.precoAtacado>0) ? p.precoAtacado : (p.preco||0),
    precoCx5: typeof p.precoCx5==='number' ? p.precoCx5 : 0,
    precoCx10: typeof p.precoCx10==='number' ? p.precoCx10 : 0,
    lotes: normalizeLotes(p.lotes, p.precoCx5, p.precoCx10)
  }));
}

function doLogout(){
  currentUser = null;
  clearSession();
  renderLogin();
  document.getElementById('lu').value='';
  document.getElementById('lp').value='';
}

function restoreSession(){
  try{
    const sid = localStorage.getItem(SESSION_KEY);
    if(!sid){ renderLogin(); return; }
    const id = parseInt(sid,10);
    const user = DB.users.find(u=>u.id===id && u.ativo);
    if(!user){ clearSession(); renderLogin(); return; }
    currentUser = user;
    enterApp();
  }catch(e){
    renderLogin();
  }
}

function saveSession(){
  try{
    if(currentUser?.id) localStorage.setItem(SESSION_KEY, String(currentUser.id));
  }catch(e){}
}

function clearSession(){
  try{ localStorage.removeItem(SESSION_KEY); }catch(e){}
}

function togglePass(){
  const inp = document.getElementById('lp');
  inp.type = inp.type==='password'?'text':'password';
}

// ═══════════════════════════════
//  NAVIGATION
// ═══════════════════════════════
const pageTitles = {
  pedidos:'Pedidos',cardapio:'Cardápio',estoque:'Estoque',clientes:'Clientes / Atacado',
  financeiro:'Financeiro',relatorios:'Relatórios',usuarios:'Usuários',config:'Configurações'
};

function go(page){
  document.querySelectorAll('.page').forEach(p=>p.classList.remove('active'));
  document.querySelectorAll('.ni').forEach(n=>n.classList.remove('active'));
  document.getElementById('page-'+page).classList.add('active');
  const ni = document.querySelector('.ni[data-p="'+page+'"]');
  if(ni) ni.classList.add('active');
  document.getElementById('tbTitle').textContent = pageTitles[page]||page;
  currentPage = page;
  // collapse sidebar on mobile
  if(window.innerWidth<=768) document.getElementById('sidebar').classList.add('collapsed');
  // render page
  if(page==='pedidos') renderPedidos();
  else if(page==='cardapio') renderCardapio();
  else if(page==='estoque') renderEstoque();
  else if(page==='clientes') renderClientes();
  else if(page==='financeiro') renderFinanceiro();
  else if(page==='relatorios') renderRelatorios();
  else if(page==='usuarios') renderUsuarios();
  else if(page==='config') renderConfig();
}

function toggleSB(){
  document.getElementById('sidebar').classList.toggle('collapsed');
}

// ═══════════════════════════════
//  NOTIFICAÇÕES
// ═══════════════════════════════
function checkNotifs(){
  const notifs = [];
  const baixo = DB.produtos.filter(p=>p.estoque>0 && p.estoque<=p.estoqueMin);
  const zero = DB.produtos.filter(p=>p.estoque===0);
  if(zero.length) notifs.push({msg:`${zero.length} produto(s) sem estoque!`,tipo:'danger'});
  if(baixo.length) notifs.push({msg:`${baixo.length} produto(s) com estoque baixo.`,tipo:'warn'});
  const aguard = DB.pedidos.filter(p=>p.status==='aguardando').length;
  if(aguard) notifs.push({msg:`${aguard} pedido(s) aguardando aprovação.`,tipo:'info'});
  const ndot = document.getElementById('ndot');
  if(ndot) ndot.style.display = notifs.length?'block':'none';
  const ndList = document.getElementById('ndList');
  if(ndList){
    if(!notifs.length) ndList.innerHTML='<div class="nd-empty">Nenhuma notificação</div>';
    else ndList.innerHTML = notifs.map(n=>`<div class="nd-item">${n.msg}</div>`).join('');
  }
  // Update estoque badge
  const nb = document.getElementById('nbEstoque');
  if(nb){ const t=baixo.length+zero.length; nb.textContent=t||''; nb.style.display=t?'':'none'; }
  // Update pedidos badge
  const nbP = document.getElementById('nbPedidos');
  const ativos = DB.pedidos.filter(p=>p.status!=='concluido'&&p.status!=='cancelado').length;
  if(nbP){ nbP.textContent=ativos||''; nbP.style.display=ativos?'':'none'; }
}

function toggleNotif(){
  const drop = document.getElementById('notifDrop');
  drop.style.display = drop.style.display==='none'?'block':'none';
}
document.addEventListener('click',e=>{
  const drop = document.getElementById('notifDrop');
  const btn = document.getElementById('notifBtn');
  if(drop && btn && !drop.contains(e.target) && !btn.contains(e.target)){
    drop.style.display='none';
  }
});

// ═══════════════════════════════
//  PEDIDOS
// ═══════════════════════════════
function renderPedidos(){
  const search = (document.getElementById('searchPed')||{}).value?.toLowerCase()||'';
  const ocultar = document.getElementById('ocultarConc')?.checked;
  let peds = [...DB.pedidos].sort((a,b)=>new Date(b.data)-new Date(a.data));
  if(currentTipo!=='todos') peds = peds.filter(p=>p.tipo===currentTipo);
  if(ocultar) peds = peds.filter(p=>p.status!=='concluido'&&p.status!=='cancelado');
  if(search) peds = peds.filter(p=>p.cliente.toLowerCase().includes(search)||String(p.id).includes(search));

  // Status counts
  const all = DB.pedidos;
  document.getElementById('cnt0').textContent = all.filter(p=>p.status==='aguardando').length;
  document.getElementById('cnt1').textContent = all.filter(p=>p.status==='atualizado').length;
  document.getElementById('cnt2').textContent = all.filter(p=>p.status==='preparacao').length;
  document.getElementById('cnt3').textContent = all.filter(p=>p.status==='entrega').length;
  document.getElementById('cnt4').textContent = all.filter(p=>p.status==='pronto').length;
  document.getElementById('cnt5').textContent = all.filter(p=>p.status==='agendado').length;

  // Tab counts
  const ptTodos = document.getElementById('ptTodos');
  const ptRetirada = document.getElementById('ptRetirada');
  const ptEntrega = document.getElementById('ptEntrega');
  if(ptTodos) ptTodos.textContent = all.length;
  if(ptRetirada) ptRetirada.textContent = all.filter(p=>p.tipo==='retirada').length;
  if(ptEntrega) ptEntrega.textContent = all.filter(p=>p.tipo==='entrega').length;

  // Tipo counts bar
  const tcRetirada = document.getElementById('tcRetirada');
  const tcEntrega = document.getElementById('tcEntrega');
  if(tcRetirada) tcRetirada.innerHTML = `Retirada <b>${all.filter(p=>p.tipo==='retirada').length}</b>`;
  if(tcEntrega) tcEntrega.innerHTML = `Entrega <b>${all.filter(p=>p.tipo==='entrega').length}</b>`;

  const list = document.getElementById('pedList');
  if(!peds.length){
    list.innerHTML='<div style="text-align:center;padding:40px;color:var(--dim)">Nenhum pedido encontrado.</div>';
    return;
  }
  list.innerHTML = peds.map(p=>`
    <div class="ped-card${currentPedidoId===p.id?' selected':''}" onclick="selectPedido(${p.id})">
      <div class="pc-top">
        <span class="badge-tipo bt-${p.tipo}">${tipoLabel(p.tipo)}</span>
        <span class="pc-num"># ${p.id} 🖨️</span>
        <span class="badge-status-ped bsp-${p.status}">${statusLabel(p.status)}</span>
      </div>
      <div class="pc-mid">
        <span class="pc-cliente">${p.cliente||'—'}</span>
        <span class="pc-total">${fmtR(p.total)}</span>
      </div>
      <div class="pc-bot">${fmtDate(p.data)}</div>
    </div>
  `).join('');

  if(currentPedidoId) renderPedidoDetail(currentPedidoId);
  checkNotifs();
}

function selectPedido(id){
  currentPedidoId = id;
  renderPedidoDetail(id);
  document.querySelectorAll('.ped-card').forEach(c=>c.classList.remove('selected'));
  const el = document.querySelector(`.ped-card[onclick="selectPedido(${id})"]`);
  if(el) el.classList.add('selected');
}

function renderPedidoDetail(id){
  const p = DB.pedidos.find(x=>x.id===id);
  const det = document.getElementById('pedDetail');
  if(!p){ det.innerHTML='<div class="pd-empty"><span>📋</span><p>Pedido não encontrado.</p></div>'; return; }
  const cli = DB.clientes.find(c=>c.nome===p.cliente);
  const itensHTML = p.itens.map(it=>{
    const prod = DB.produtos.find(pr=>pr.id===it.prodId);
    const unitTxt = `${tierLabelByQty(it.qty, it.prodId)} • ${fmtR(it.preco)}/cx`;
    return `<div class="pd-item-row">
      <div class="pir-qty">${it.qty}x</div>
      <div style="flex:1;display:flex;flex-direction:column">
        <span class="pir-name">${prod?prod.nome:'Produto removido'}</span>
        <small style="color:var(--muted);font-size:.78rem">${unitTxt}</small>
      </div>
      <span class="pir-price">${fmtR(it.preco*it.qty)}</span>
    </div>`;
  }).join('');

  // Action buttons based on status
  let actionBtns = '';
  if(p.status==='aguardando') actionBtns += `<button class="pd-btn-action pd-btn-green" onclick="updStatus(${p.id},'preparacao')">✓ Aceitar Pedido</button>`;
  if(p.status==='preparacao'){
    if(p.tipo==='entrega') actionBtns += `<button class="pd-btn-action pd-btn-green" onclick="updStatus(${p.id},'entrega')">🚚 Saiu para Entrega</button>`;
    else actionBtns += `<button class="pd-btn-action pd-btn-green" onclick="updStatus(${p.id},'pronto')">✅ Pronto para Retirada</button>`;
  }
  if(p.status==='pronto'||p.status==='entrega') actionBtns += `<button class="pd-btn-action pd-btn-green" onclick="updStatus(${p.id},'concluido')">✓ Concluir Pedido</button>`;
  if(p.status!=='concluido'&&p.status!=='cancelado') actionBtns += `<button class="pd-btn-action pd-btn-red" onclick="updStatus(${p.id},'cancelado')">✕ Cancelar Pedido</button>`;

  det.innerHTML = `
    <div class="pd-header">
      <span class="pd-title">Detalhes do pedido # ${p.id}</span>
      <button class="btn-sm-outline" onclick="imprimirPedidoId(${p.id})">🖨️ Imprimir</button>
    </div>
    <div class="pd-section">
      <div class="pd-section-title">Dados do Cliente</div>
      <div class="pd-info-row"><span>Nome</span><span>${p.cliente||'—'}</span></div>
      ${cli?`<div class="pd-info-row"><span>Total de pedidos</span><span>${DB.pedidos.filter(x=>x.cliente===p.cliente).length}</span></div>`:''}
      ${p.tel?`<div class="pd-info-row"><span>Telefone</span><a href="https://wa.me/55${p.tel}" target="_blank" style="color:var(--green)">${p.tel} 📱</a></div>`:''}
    </div>
    <div class="pd-section">
      <div class="pd-section-title">Dados de Pagamento</div>
      <div class="pd-pgto-cards">
        <div class="pd-pgto-card"><span>Pedido</span><strong>${fmtR(p.total)}</strong></div>
        <div class="pd-pgto-card"><span>Total</span><strong>${fmtR(p.total)}</strong></div>
      </div>
      <div class="pd-info-row"><span>Forma</span><span>${pgtoLabel(p.pgto)}</span></div>
      ${p.status==='concluido'?'':'<button class="pd-btn-action pd-btn-outline" onclick="confirmarPgto('+p.id+')">$ Confirmar Pagamento</button>'}
    </div>
    <div class="pd-section">
      <div class="pd-section-title">Detalhes do Pedido</div>
      ${itensHTML}
      ${p.obs?`<div style="font-size:.83rem;color:var(--muted);margin-top:6px">Obs: ${p.obs}</div>`:''}
    </div>
    <div class="pd-actions">${actionBtns}</div>
  `;
}

function updStatus(id, status){
  const p = DB.pedidos.find(x=>x.id===id);
  if(!p) return;
  const prev = p.status;
  p.status = status;
  if(status==='concluido' && prev!=='concluido'){
    // Add to caixa if aberto
    if(DB.caixa.aberto){
      DB.caixa.entradas += p.total;
      DB.caixa.movs.push({hora:new Date().toLocaleTimeString('pt-BR',{hour:'2-digit',minute:'2-digit'}),tipo:'Venda',desc:`Pedido #${p.id} - ${p.cliente||'—'}`,valor:p.total,sign:1});
    }
  }
  saveDB();
  renderPedidos();
  toast(`Pedido #${id} → ${statusLabel(status)}`,'success');
}

function confirmarPgto(id){
  toast('Pagamento confirmado!','success');
  updStatus(id,'concluido');
}

function setTipoTab(el, tipo){
  document.querySelectorAll('.ptab').forEach(b=>b.classList.remove('active'));
  el.classList.add('active');
  currentTipo = tipo;
  renderPedidos();
}

function toggleLoja(){
  DB.lojaAberta = !DB.lojaAberta;
  const btn = document.getElementById('btnLoja');
  if(DB.lojaAberta){ btn.textContent='⏻ FECHAR LOJA'; btn.classList.remove('btn-primary'); btn.classList.add('btn-outline-red'); }
  else { btn.textContent='▶ ABRIR LOJA'; btn.classList.remove('btn-outline-red'); btn.classList.add('btn-primary'); }
  toast(DB.lojaAberta?'Loja aberta!':'Loja fechada!', DB.lojaAberta?'success':'warn');
}

function gSearchFn(){
  const q = document.getElementById('gSearch').value.toLowerCase();
  if(!q) return;
  // simple: search pedidos
  if(currentPage==='pedidos'){ document.getElementById('searchPed').value=q; renderPedidos(); }
  else if(currentPage==='estoque'){ document.getElementById('searchEst').value=q; renderEstoque(); }
  else if(currentPage==='clientes'){ document.getElementById('searchCli').value=q; renderClientes(); }
}

// ═══════════════════════════════
//  NOVO PEDIDO
// ═══════════════════════════════
function openNovoPedido(){
  npItems = [];
  npTipo = 'entrega';
  npDescTipo = 'desconto';
  npDescUnit = 'pct';
  npCatFilter = 'todos';
  document.getElementById('npDescVal').value = '0';
  document.getElementById('npNome').value='';
  document.getElementById('npTel').value='';
  document.getElementById('npEmail').value='';
  document.getElementById('npRua').value='';
  document.getElementById('npNum').value='';
  document.getElementById('npComp').value='';
  document.getElementById('npRef').value='';
  document.getElementById('npBairro').value='';
  document.getElementById('npObs').value='';
  document.getElementById('npScanCode').value='';
  document.getElementById('npScanQty').value='1';
  // Reset tipo buttons
  document.querySelectorAll('.tipo-btn').forEach(b=>b.classList.remove('active'));
  document.querySelector('.tipo-btn[data-tipo="entrega"]').classList.add('active');
  // Reset pgto
  document.querySelectorAll('.pgto-btn').forEach(b=>b.classList.remove('active'));
  document.querySelector('.pgto-btn[data-p="dinheiro"]').classList.add('active');
  // entrega fields
  document.querySelectorAll('.entrega-fields').forEach(r=>r.style.display='grid');
  renderNpCats();
  renderNpProd();
  renderNpItens();
  openModal('modalNovoPedido');
  const scanInput = document.getElementById('npScanCode');
  if(scanInput) scanInput.focus();
}

function setTipoPedido(el){
  document.querySelectorAll('.tipo-btn').forEach(b=>b.classList.remove('active'));
  el.classList.add('active');
  npTipo = el.dataset.tipo;
  document.querySelectorAll('.entrega-fields').forEach(r=>r.style.display=npTipo==='entrega'?'grid':'none');
}

function renderNpCats(){
  const cats = document.getElementById('npCats');
  cats.innerHTML = `<button class="mp-cat-btn${npCatFilter==='todos'?' active':''}" onclick="setNpCat(this,'todos')">Todos</button>`+
    DB.categorias.map(c=>`<button class="mp-cat-btn${npCatFilter===c.id?' active':''}" onclick="setNpCat(this,${c.id})">${c.nome}</button>`).join('');
}

function setNpCat(el, id){
  npCatFilter = id;
  document.querySelectorAll('.mp-cat-btn').forEach(b=>b.classList.remove('active'));
  el.classList.add('active');
  renderNpProd();
}

function renderNpProd(){
  const q = (document.getElementById('npSearch')||{}).value?.toLowerCase()||'';
  const ocultar = document.getElementById('npOcultar')?.checked;
  let prods = DB.produtos;
  if(npCatFilter!=='todos') prods = prods.filter(p=>p.catId===npCatFilter);
  if(ocultar) prods = prods.filter(p=>p.disp&&p.estoque>0);
  if(q) prods = prods.filter(p=>p.nome.toLowerCase().includes(q)||p.codigo.includes(q));
  const grid = document.getElementById('npGrid');
  grid.innerHTML = prods.map(p=>`
    <div class="mp-prod-card" onclick="addNpItem(${p.id})">
      <div class="mp-thumb">${p.foto?`<img src="${p.foto}" style="width:100%;height:100%;object-fit:cover;border-radius:7px"/>`:'🛒'}</div>
      <div>
        <span>${p.nome}</span>
        <small>${fmtR(getBasePrice(p))} ${priceTierHint(p)}</small>
      </div>
    </div>
  `).join('');
}

function addNpItem(prodId){
  const prod = DB.produtos.find(p=>p.id===prodId);
  if(!prod) return;
  const ex = npItems.find(i=>i.prodId===prodId);
  if(ex){
    ex.qty++;
    ex.preco = getPriceByQty(prod, ex.qty);
  } else {
    npItems.push({prodId,qty:1,preco:getPriceByQty(prod,1),nome:prod.nome});
  }
  renderNpItens();
  calcTotal();
}

function addNpItemByCode(code, qty=1){
  const clean = String(code||'').trim();
  if(!clean) return false;
  const prod = DB.produtos.find(p=>String(p.codigo||'')===clean);
  if(!prod){
    playBeep('error');
    toast(`Código ${clean} não encontrado.`, 'error');
    return false;
  }
  for(let i=0;i<qty;i++) addNpItem(prod.id);
  playBeep('ok');
  toast(`Bipado: ${prod.nome} (+${qty})`, 'success');
  return true;
}

function scanCodigoManual(){
  const inp = document.getElementById('npScanCode');
  const qtyEl = document.getElementById('npScanQty');
  const code = inp?.value||'';
  const qty = Math.max(1, parseInt(qtyEl?.value,10)||1);
  const ok = addNpItemByCode(code, qty);
  if(inp){
    inp.value='';
    inp.focus();
  }
  if(ok && qtyEl) qtyEl.value='1';
}

function bindScannerListener(){
  document.addEventListener('keydown', (e)=>{
    const modalOpen = document.getElementById('modalNovoPedido')?.style.display==='flex';
    if(!modalOpen) return;
    const active = document.activeElement;
    const isTypingField = active && (active.tagName==='INPUT' || active.tagName==='TEXTAREA');
    const now = Date.now();
    if(now - scanLastTs > 120) scanBuffer = '';
    scanLastTs = now;

    if(e.key==='Enter'){
      if(!scanBuffer) return;
      const qty = Math.max(1, parseInt(document.getElementById('npScanQty')?.value,10)||1);
      const ok = addNpItemByCode(scanBuffer, qty);
      if(ok) e.preventDefault();
      scanBuffer = '';
      return;
    }
    if(isTypingField) return;
    if(/^[0-9A-Za-z\-]$/.test(e.key)){
      scanBuffer += e.key;
    }
  });
}

function playBeep(kind='ok'){
  try{
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if(!Ctx) return;
    const ctx = new Ctx();
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = 'sine';
    o.frequency.value = kind==='ok' ? 980 : 240;
    g.gain.setValueAtTime(0.0001, ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.08, ctx.currentTime+0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime+0.12);
    o.connect(g);
    g.connect(ctx.destination);
    o.start();
    o.stop(ctx.currentTime+0.13);
  }catch(e){}
}

function renderNpItens(){
  const el = document.getElementById('npItens');
  if(!npItems.length){ el.innerHTML='<div class="md-empty">Nenhum item selecionado</div>'; return; }
  el.innerHTML = npItems.map((it,i)=>`
    <div class="md-item-row">
      <div class="mir-main">
        <span class="mir-name">${it.nome}</span>
        <small class="mir-unit">${tierLabelByQty(it.qty, it.prodId)} • Unitário: ${fmtR(it.preco)}</small>
      </div>
      <div class="mir-qty">
        <button onclick="chgQty(${i},-1)">−</button>
        <span>${it.qty}</span>
        <button onclick="chgQty(${i},1)">+</button>
      </div>
      <span class="mir-price">${fmtR(it.preco*it.qty)}</span>
      <button class="mir-del" onclick="removeNpItem(${i})">🗑</button>
    </div>
  `).join('');
}

function chgQty(i, delta){
  npItems[i].qty = Math.max(1, npItems[i].qty+delta);
  const prod = DB.produtos.find(p=>p.id===npItems[i].prodId);
  if(prod) npItems[i].preco = getPriceByQty(prod, npItems[i].qty);
  renderNpItens(); calcTotal();
}
function removeNpItem(i){ npItems.splice(i,1); renderNpItens(); calcTotal(); }

function calcTotal(){
  let sub = npItems.reduce((a,it)=>a+it.preco*it.qty, 0);
  const dv = parseFloat(document.getElementById('npDescVal')?.value)||0;
  let total = sub;
  if(npDescTipo==='desconto'){
    if(npDescUnit==='pct') total = sub*(1-dv/100);
    else total = sub - dv;
  } else {
    if(npDescUnit==='pct') total = sub*(1+dv/100);
    else total = sub + dv;
  }
  total = Math.max(0, total);
  document.getElementById('npTotal').textContent = fmtR(total);
}

function setDescTab(el){ npDescTipo=el.dataset.t; document.querySelectorAll('.desc-tab').forEach(b=>b.classList.remove('active')); el.classList.add('active'); calcTotal(); }
function setDescUnit(el){ npDescUnit=el.dataset.u; document.querySelectorAll('.desc-unit').forEach(b=>b.classList.remove('active')); el.classList.add('active'); calcTotal(); }
function setPgto(el){ document.querySelectorAll('.pgto-btn').forEach(b=>b.classList.remove('active')); el.classList.add('active'); }

function salvarPedido(){
  if(!npItems.length){ toast('Adicione pelo menos um item!','error'); return; }
  const nome = document.getElementById('npNome').value.trim();
  if(!nome){ toast('Informe o nome do cliente!','error'); return; }
  const pgtoEl = document.querySelector('.pgto-btn.active');
  const pgto = pgtoEl?pgtoEl.dataset.p:'dinheiro';
  const dv = parseFloat(document.getElementById('npDescVal').value)||0;
  let sub = npItems.reduce((a,it)=>a+it.preco*it.qty,0);
  let total = sub;
  if(npDescTipo==='desconto'){ total = npDescUnit==='pct'?sub*(1-dv/100):sub-dv; }
  else { total = npDescUnit==='pct'?sub*(1+dv/100):sub+dv; }
  total = Math.max(0,+total.toFixed(2));

  const ped = {
    id: DB.nextId.pedido++,
    tipo: npTipo,
    cliente: nome,
    tel: document.getElementById('npTel').value.trim(),
    status: 'aguardando',
    itens: npItems.map(i=>({...i})),
    pgto, obs: document.getElementById('npObs').value,
    descTipo: npDescTipo, descUnit: npDescUnit, descVal: dv,
    total, data: new Date().toISOString()
  };
  // Baixar estoque
  ped.itens.forEach(it=>{
    const prod = DB.produtos.find(p=>p.id===it.prodId);
    if(prod && DB.config.semEst==='nao') prod.estoque = Math.max(0, prod.estoque-it.qty);
    else if(prod) prod.estoque = Math.max(0, prod.estoque-it.qty);
  });
  DB.pedidos.unshift(ped);
  saveDB();
  closeModal('modalNovoPedido');
  renderPedidos();
  checkNotifs();
  toast(`Pedido #${ped.id} criado!`, 'success');
  autoPrintPedido(ped);
}

// ═══════════════════════════════
//  CARDÁPIO
// ═══════════════════════════════
function renderCardapio(){
  const q = document.getElementById('searchCard').value.toLowerCase();
  const list = document.getElementById('cardapioList');
  let cats = DB.categorias;
  list.innerHTML = cats.map(cat=>{
    let prods = DB.produtos.filter(p=>p.catId===cat.id);
    if(q) prods = prods.filter(p=>p.nome.toLowerCase().includes(q)||p.codigo.includes(q));
    if(q && !prods.length) return '';
    const prodsHTML = prods.map(p=>`
      <div class="prod-row">
        <div class="prod-thumb">${p.foto?`<img src="${p.foto}" style="width:100%;height:100%;object-fit:cover;border-radius:8px"/>`:'📦'}</div>
        <div class="prod-info">
          <span>${p.nome}</span>
          <small>Cód: ${p.codigo||'—'} • ${p.unidade}</small>
        </div>
        <div class="prod-price" style="border-color:var(--blue)">${fmtR(getBasePrice(p))}</div>
        <div class="prod-row-actions">
          <label class="tgl-label"><input type="checkbox" ${p.disp?'checked':''} onchange="toggleDisp(${p.id})"/><span class="tgl-sl"></span></label>
          <button class="btn-sm-green" onclick="editProduto(${p.id})">Editar</button>
          <span class="btn-sm-outline" style="cursor:pointer;color:var(--green)">+ Novo complemento</span>
        </div>
      </div>
    `).join('');
    return `
      <div class="cat-block">
        <div class="cat-block-hd" onclick="toggleCat(this)">
          <span class="cat-drag">⠿</span>
          <span class="cat-arrow">▼</span>
          <span>${cat.nome}</span>
          <div class="cat-hd-right">
            <span class="cat-count">${prods.length} ${prods.length===1?'item':'itens'}</span>
            <label class="tgl-label" onclick="e=>e.stopPropagation()">
              <input type="checkbox" checked onchange=""/><span class="tgl-sl"></span>
            </label>
            <button class="btn-sm-green" onclick="event.stopPropagation();addItemCat(${cat.id})">Novo item</button>
            <button class="btn-sm-outline" onclick="event.stopPropagation();editCategoria(${cat.id})">⋮</button>
          </div>
        </div>
        <div class="cat-items">${prodsHTML||'<div style="padding:12px 16px;font-size:.85rem;color:var(--dim)">Nenhum item nesta categoria.</div>'}</div>
      </div>
    `;
  }).join('');
}

function toggleCat(hd){
  const block = hd.closest('.cat-block');
  block.classList.toggle('collapsed');
  const items = block.querySelector('.cat-items');
  if(block.classList.contains('collapsed')) items.style.display='none';
  else items.style.display='block';
}

function toggleDisp(id){
  const p = DB.produtos.find(x=>x.id===id);
  if(p){ p.disp=p.disp?0:1; saveDB(); }
}

function addItemCat(catId){
  clearProdForm();
  document.getElementById('mpCat').value = catId;
  document.getElementById('mpTitulo').textContent = 'Novo Produto';
  openModal('modalProduto');
}

// ═══════════════════════════════
//  PRODUTOS
// ═══════════════════════════════
function renderProdCats(selectId){
  const sel = document.getElementById(selectId);
  if(!sel) return;
  sel.innerHTML = DB.categorias.map(c=>`<option value="${c.id}">${c.nome}</option>`).join('');
}

function renderLotesForm(lotes){
  const list = document.getElementById('mpLotesList');
  if(!list) return;
  const rows = (lotes && lotes.length ? lotes : [{qtd:'',preco:''}]);
  list.innerHTML = rows.map((l,idx)=>`
    <div class="lote-row">
      <input type="number" class="input-field" data-lote="qtd" min="1" placeholder="Qtd caixas" value="${l.qtd??''}"/>
      <input type="number" class="input-field" data-lote="preco" min="0" step="0.01" placeholder="Preço do lote (R$)" value="${l.preco??''}"/>
      <button class="lote-del" type="button" onclick="delLoteRow(${idx})">✕</button>
    </div>
  `).join('');
}

function addLoteRow(){
  const cur = collectLotesFromForm(false);
  cur.push({qtd:'',preco:''});
  renderLotesForm(cur);
}

function delLoteRow(idx){
  const cur = collectLotesFromForm(false);
  cur.splice(idx,1);
  renderLotesForm(cur);
}

function collectLotesFromForm(sort=true){
  const list = document.getElementById('mpLotesList');
  if(!list) return [];
  const rows = [...list.querySelectorAll('.lote-row')].map(r=>{
    const qtd = parseInt(r.querySelector('[data-lote="qtd"]')?.value,10);
    const preco = parseFloat(r.querySelector('[data-lote="preco"]')?.value);
    return {qtd,preco};
  }).filter(l=>l.qtd>0 && l.preco>0);
  if(sort) rows.sort((a,b)=>a.qtd-b.qtd);
  return rows;
}

function clearProdForm(){
  ['mpNome','mpCodigo','mpFoto'].forEach(id=>document.getElementById(id).value='');
  ['mpAtacado','mpCusto','mpEstInicial','mpEstMin'].forEach(id=>document.getElementById(id).value='');
  document.getElementById('mpId').value='';
  document.getElementById('mpUnidade').value='UN';
  document.getElementById('mpDisp').value='1';
  renderLotesForm([]);
  renderProdCats('mpCat');
}

function editProduto(id){
  const p = DB.produtos.find(x=>x.id===id);
  if(!p) return;
  clearProdForm();
  document.getElementById('mpTitulo').textContent = 'Editar Produto';
  document.getElementById('mpId').value=p.id;
  document.getElementById('mpNome').value=p.nome;
  document.getElementById('mpCodigo').value=p.codigo;
  renderProdCats('mpCat');
  document.getElementById('mpCat').value=p.catId;
  document.getElementById('mpUnidade').value=p.unidade;
  document.getElementById('mpAtacado').value=getBasePrice(p);
  document.getElementById('mpCusto').value=p.custo;
  renderLotesForm(getProdLotes(p));
  document.getElementById('mpEstInicial').value=p.estoque;
  document.getElementById('mpEstMin').value=p.estoqueMin;
  document.getElementById('mpFoto').value=p.foto||'';
  document.getElementById('mpDisp').value=p.disp;
  openModal('modalProduto');
}

function salvarProduto(){
  const nome = document.getElementById('mpNome').value.trim();
  if(!nome){ toast('Informe o nome do produto!','error'); return; }
  const precoAtacado = parseFloat(document.getElementById('mpAtacado').value)||0;
  if(!precoAtacado){ toast('Informe o preço de atacado!','error'); return; }
  const editId = parseInt(document.getElementById('mpId').value)||0;
  const catId = parseInt(document.getElementById('mpCat').value)||DB.categorias[0]?.id;

  if(editId){
    const p = DB.produtos.find(x=>x.id===editId);
    if(p){
      p.nome=nome; p.codigo=document.getElementById('mpCodigo').value;
      p.catId=catId; p.unidade=document.getElementById('mpUnidade').value;
      p.preco=precoAtacado; p.precoAtacado=precoAtacado;
      p.custo=parseFloat(document.getElementById('mpCusto').value)||0;
      p.lotes=collectLotesFromForm();
      p.precoCx5=(p.lotes.find(l=>l.qtd===5)||{}).preco||0;
      p.precoCx10=(p.lotes.find(l=>l.qtd===10)||{}).preco||0;
      p.estoque=parseInt(document.getElementById('mpEstInicial').value)||0;
      p.estoqueMin=parseInt(document.getElementById('mpEstMin').value)||5;
      p.foto=document.getElementById('mpFoto').value;
      p.disp=parseInt(document.getElementById('mpDisp').value);
    }
    toast('Produto atualizado!','success');
  } else {
    DB.produtos.push({
      id:DB.nextId.produto++, nome, codigo:document.getElementById('mpCodigo').value,
      catId, unidade:document.getElementById('mpUnidade').value,
      preco:precoAtacado, precoAtacado:precoAtacado,
      custo:parseFloat(document.getElementById('mpCusto').value)||0,
      lotes:collectLotesFromForm(),
      precoCx5:0,
      precoCx10:0,
      estoque:parseInt(document.getElementById('mpEstInicial').value)||0,
      estoqueMin:parseInt(document.getElementById('mpEstMin').value)||5,
      foto:document.getElementById('mpFoto').value,
      disp:parseInt(document.getElementById('mpDisp').value)
    });
    const last = DB.produtos[DB.produtos.length-1];
    last.precoCx5=(last.lotes.find(l=>l.qtd===5)||{}).preco||0;
    last.precoCx10=(last.lotes.find(l=>l.qtd===10)||{}).preco||0;
    toast('Produto cadastrado!','success');
  }
  saveDB(); closeModal('modalProduto');
  renderCardapio(); renderEstoque(); checkNotifs();
}

// ═══════════════════════════════
//  CATEGORIAS
// ═══════════════════════════════
function salvarCategoria(){
  const nome = document.getElementById('mcNome').value.trim();
  if(!nome){ toast('Informe o nome!','error'); return; }
  const editId = parseInt(document.getElementById('mcId').value)||0;
  if(editId){
    const c = DB.categorias.find(x=>x.id===editId);
    if(c) c.nome=nome;
    toast('Categoria atualizada!','success');
  } else {
    DB.categorias.push({id:Date.now(),nome});
    toast('Categoria criada!','success');
  }
  saveDB(); closeModal('modalCategoria'); renderCardapio(); renderConfig();
}

function editCategoria(id){
  const c = DB.categorias.find(x=>x.id===id);
  if(!c) return;
  document.getElementById('mcTitulo').textContent='Editar Categoria';
  document.getElementById('mcNome').value=c.nome;
  document.getElementById('mcId').value=c.id;
  openModal('modalCategoria');
}

// ═══════════════════════════════
//  ESTOQUE
// ═══════════════════════════════
function renderEstoque(){
  const q = document.getElementById('searchEst').value.toLowerCase();
  const catF = document.getElementById('filterCatEst').value;
  const stF = document.getElementById('filterStatusEst').value;

  // Populate filter
  const sel = document.getElementById('filterCatEst');
  const curCat = sel.value;
  sel.innerHTML='<option value="">Todas as categorias</option>'+DB.categorias.map(c=>`<option value="${c.id}" ${curCat==c.id?'selected':''}>${c.nome}</option>`).join('');

  let prods = DB.produtos;
  if(q) prods=prods.filter(p=>p.nome.toLowerCase().includes(q)||p.codigo.includes(q));
  if(catF) prods=prods.filter(p=>p.catId==catF);
  if(stF==='ok') prods=prods.filter(p=>p.estoque>p.estoqueMin);
  else if(stF==='baixo') prods=prods.filter(p=>p.estoque>0&&p.estoque<=p.estoqueMin);
  else if(stF==='zero') prods=prods.filter(p=>p.estoque===0);

  // KPIs
  document.getElementById('kTotalItens').textContent = DB.produtos.length;
  document.getElementById('kBaixo').textContent = DB.produtos.filter(p=>p.estoque>0&&p.estoque<=p.estoqueMin).length;
  document.getElementById('kZero').textContent = DB.produtos.filter(p=>p.estoque===0).length;
  document.getElementById('kValor').textContent = fmtR(DB.produtos.reduce((a,p)=>a+p.estoque*p.custo,0));

  const tb = document.getElementById('tbEst');
  tb.innerHTML = prods.map(p=>{
    const cat = DB.categorias.find(c=>c.id===p.catId);
    const st = p.estoque===0?'zero':p.estoque<=p.estoqueMin?'baixo':'ok';
    const stLabel = {ok:'Normal',baixo:'Baixo',zero:'Sem estoque'}[st];
    return `<tr>
      <td><b>${p.nome}</b></td>
      <td><code style="font-size:.78rem">${p.codigo||'—'}</code></td>
      <td>${cat?cat.nome:'—'}</td>
      <td style="font-family:'Syne',sans-serif;font-weight:700">${p.estoque}</td>
      <td style="color:var(--muted)">${p.estoqueMin}</td>
      <td>${fmtR(getBasePrice(p))}</td>
      <td style="color:var(--muted)">${fmtR(p.custo)}</td>
      <td><span class="badge-stock bs-${st}">${stLabel}</span></td>
      <td>
        <div style="display:flex;gap:6px">
          <button class="btn-sm-green" onclick="entradaRapida(${p.id})">+ Entrada</button>
          <button class="btn-sm-outline" onclick="editProduto(${p.id})">Editar</button>
        </div>
      </td>
    </tr>`;
  }).join('');
}

function entradaRapida(id){
  renderProdSel('entProd', id);
  openModal('modalEntrada');
}

function renderProdSel(selId, selectedId){
  const sel = document.getElementById(selId);
  sel.innerHTML = DB.produtos.map(p=>`<option value="${p.id}" ${p.id===selectedId?'selected':''}>${p.nome}</option>`).join('');
}

function salvarEntrada(){
  const prodId = parseInt(document.getElementById('entProd').value);
  const qty = parseInt(document.getElementById('entQtd').value)||0;
  const custo = parseFloat(document.getElementById('entCusto').value)||0;
  if(!qty){ toast('Informe a quantidade!','error'); return; }
  const prod = DB.produtos.find(p=>p.id===prodId);
  if(!prod){ toast('Produto não encontrado!','error'); return; }
  prod.estoque += qty;
  if(custo) prod.custo = custo;
  saveDB(); closeModal('modalEntrada'); renderEstoque(); checkNotifs();
  toast(`+${qty} ${prod.nome} adicionado ao estoque!`,'success');
}

// ═══════════════════════════════
//  CLIENTES
// ═══════════════════════════════
function renderClientes(){
  const q = document.getElementById('searchCli').value.toLowerCase();
  const tf = document.getElementById('filterTipoCli').value;
  let clis = DB.clientes;
  if(q) clis=clis.filter(c=>c.nome.toLowerCase().includes(q)||c.doc.includes(q)||c.tel.includes(q));
  if(tf) clis=clis.filter(c=>c.tipo===tf);

  document.getElementById('kTotalCli').textContent=DB.clientes.length;
  document.getElementById('kAtacado').textContent=DB.clientes.filter(c=>c.tipo==='atacado').length;
  document.getElementById('kVarejo').textContent=DB.clientes.filter(c=>c.tipo==='varejo').length;
  document.getElementById('kDebito').textContent=fmtR(DB.clientes.reduce((a,c)=>a+c.debito,0));

  document.getElementById('tbCli').innerHTML = clis.map(c=>{
    const totalPeds = DB.pedidos.filter(p=>p.cliente===c.nome).length;
    return `<tr>
      <td><b>${c.nome}</b></td>
      <td><span class="badge-stock ${c.tipo==='atacado'?'bs-ok':'bs-baixo'}">${c.tipo==='atacado'?'Atacado':'Varejo'}</span></td>
      <td>${c.tel?`<a href="https://wa.me/55${c.tel.replace(/\D/g,'')}" target="_blank" style="color:var(--green)">${c.tel}</a>`:'—'}</td>
      <td style="font-size:.82rem">${c.doc||'—'}</td>
      <td>${fmtR(c.limite)}</td>
      <td class="${c.debito>0?'tred':''}">${fmtR(c.debito)}</td>
      <td>${totalPeds}</td>
      <td><div style="display:flex;gap:6px">
        <button class="btn-sm-green" onclick="editCliente(${c.id})">Editar</button>
        <button class="btn-sm-outline" onclick="verPedidosCli('${c.nome}')">Pedidos</button>
        <button class="btn-sm-outline" style="color:var(--red)" onclick="deleteCliente(${c.id})">🗑</button>
      </div></td>
    </tr>`;
  }).join('');
}

function salvarCliente(){
  const nome = document.getElementById('clNome').value.trim();
  if(!nome){ toast('Informe o nome!','error'); return; }
  const editId = parseInt(document.getElementById('clId').value)||0;
  const data = {
    nome, tipo:document.getElementById('clTipo').value,
    tel:document.getElementById('clTel').value,
    doc:document.getElementById('clDoc').value,
    end:document.getElementById('clEnd').value,
    limite:parseFloat(document.getElementById('clLimite').value)||0,
    desconto:parseFloat(document.getElementById('clDesc').value)||0,
    debito:0
  };
  if(editId){
    const c = DB.clientes.find(x=>x.id===editId);
    if(c){ Object.assign(c,data); } toast('Cliente atualizado!','success');
  } else {
    DB.clientes.push({id:DB.nextId.cliente++,...data});
    toast('Cliente cadastrado!','success');
  }
  saveDB(); closeModal('modalCliente'); renderClientes();
}

function editCliente(id){
  const c = DB.clientes.find(x=>x.id===id);
  if(!c) return;
  document.getElementById('mclTitulo').textContent='Editar Cliente';
  document.getElementById('clId').value=c.id;
  document.getElementById('clNome').value=c.nome;
  document.getElementById('clTipo').value=c.tipo;
  document.getElementById('clTel').value=c.tel;
  document.getElementById('clDoc').value=c.doc;
  document.getElementById('clEnd').value=c.end;
  document.getElementById('clLimite').value=c.limite;
  document.getElementById('clDesc').value=c.desconto;
  openModal('modalCliente');
}

function deleteCliente(id){
  if(!confirm('Excluir este cliente?')) return;
  DB.clientes = DB.clientes.filter(c=>c.id!==id);
  saveDB(); renderClientes(); toast('Cliente removido.','warn');
}

function verPedidosCli(nome){
  currentTipo='todos';
  document.getElementById('searchPed').value=nome;
  go('pedidos');
}

// ═══════════════════════════════
//  FINANCEIRO
// ═══════════════════════════════
function renderFinanceiro(){
  const cx = DB.caixa;
  document.getElementById('cxStatus').textContent=cx.aberto?'Aberto':'Fechado';
  document.getElementById('cxStatus').className='badge-status '+(cx.aberto?'bs-open':'bs-closed');
  document.getElementById('cxAbertura').textContent=cx.abertura||'—';
  document.getElementById('cxSaldoIni').textContent=fmtR(cx.saldoInicial);
  document.getElementById('cxEntradas').textContent=fmtR(cx.entradas);
  document.getElementById('cxSaidas').textContent=fmtR(cx.saidas);
  document.getElementById('cxSaldo').textContent=fmtR(cx.saldoInicial+cx.entradas-cx.saidas);
  const btnCx = document.getElementById('btnCaixa');
  if(cx.aberto){ btnCx.textContent='🔒 Fechar Caixa'; btnCx.onclick=fecharCaixa; }
  else { btnCx.textContent='Abrir Caixa'; btnCx.onclick=()=>openModal('modalAbrirCaixa'); }
  // Movs
  document.getElementById('tbMovCaixa').innerHTML = cx.movs.slice().reverse().map(m=>`
    <tr>
      <td>${m.hora}</td>
      <td><span class="badge-stock ${m.sign>0?'bs-ok':'bs-zero'}">${m.tipo}</span></td>
      <td>${m.desc}</td>
      <td class="${m.sign>0?'tgreen':'tred'}">${m.sign>0?'+':'−'}${fmtR(Math.abs(m.valor))}</td>
    </tr>
  `).join('') || '<tr><td colspan="4" style="text-align:center;color:var(--dim);padding:20px">Nenhuma movimentação</td></tr>';
  // Resumo pgto
  const pgtos = {};
  DB.pedidos.filter(p=>p.status==='concluido').forEach(p=>{ pgtos[p.pgto]=(pgtos[p.pgto]||0)+p.total; });
  document.getElementById('finResumo').innerHTML = Object.entries(pgtos).map(([k,v])=>`
    <div class="frc-row"><span>${pgtoLabel(k)}</span><span>${fmtR(v)}</span></div>
  `).join('') || '<div style="color:var(--dim);font-size:.83rem">Nenhuma venda concluída</div>';
}

function abrirCaixa(){
  const val = parseFloat(document.getElementById('cxIni').value)||0;
  DB.caixa = {aberto:true,saldoInicial:val,entradas:0,saidas:0,abertura:new Date().toLocaleString('pt-BR'),movs:[]};
  saveDB(); closeModal('modalAbrirCaixa'); renderFinanceiro(); toast('Caixa aberto!','success');
}

function fecharCaixa(){
  if(!DB.caixa.aberto){ toast('Caixa já fechado.','warn'); return; }
  if(!confirm('Fechar o caixa agora?')) return;
  DB.caixa.aberto=false; saveDB(); renderFinanceiro(); toast('Caixa fechado!','warn');
}

function registrarSangria(){
  const val = parseFloat(document.getElementById('sgVal').value)||0;
  const mot = document.getElementById('sgMot').value||'Sangria';
  if(!val){ toast('Informe o valor!','error'); return; }
  DB.caixa.saidas+=val;
  DB.caixa.movs.push({hora:new Date().toLocaleTimeString('pt-BR',{hour:'2-digit',minute:'2-digit'}),tipo:'Sangria',desc:mot,valor:val,sign:-1});
  saveDB(); closeModal('modalSangria'); renderFinanceiro(); toast('Sangria registrada!','warn');
}

function registrarSuprimento(){
  const val = parseFloat(document.getElementById('spVal').value)||0;
  const mot = document.getElementById('spMot').value||'Suprimento';
  if(!val){ toast('Informe o valor!','error'); return; }
  DB.caixa.entradas+=val;
  DB.caixa.movs.push({hora:new Date().toLocaleTimeString('pt-BR',{hour:'2-digit',minute:'2-digit'}),tipo:'Suprimento',desc:mot,valor:val,sign:1});
  saveDB(); closeModal('modalSuprimento'); renderFinanceiro(); toast('Suprimento registrado!','success');
}

// ═══════════════════════════════
//  RELATÓRIOS
// ═══════════════════════════════
function renderRelatorios(){
  const concl = DB.pedidos.filter(p=>p.status==='concluido');
  const today = new Date().toDateString();
  const hoje = concl.filter(p=>new Date(p.data).toDateString()===today);
  const mes = concl.filter(p=>new Date(p.data).getMonth()===new Date().getMonth());
  const totalHoje = hoje.reduce((a,p)=>a+p.total,0);
  const totalMes = mes.reduce((a,p)=>a+p.total,0);
  const lucroEst = concl.reduce((a,p)=>{
    const l = p.itens.reduce((b,it)=>{ const pr=DB.produtos.find(x=>x.id===it.prodId); return b+(pr?(it.preco-pr.custo)*it.qty:0); },0); return a+l;
  },0);
  // Produto mais vendido
  const pCount = {};
  concl.forEach(p=>p.itens.forEach(it=>{ pCount[it.prodId]=(pCount[it.prodId]||0)+it.qty; }));
  const topProdId = Object.entries(pCount).sort((a,b)=>b[1]-a[1])[0];
  const topProd = topProdId?DB.produtos.find(p=>p.id==topProdId[0]):null;
  document.getElementById('rkHoje').textContent=fmtR(totalHoje);
  document.getElementById('rkMes').textContent=fmtR(totalMes);
  document.getElementById('rkProduto').textContent=topProd?`${topProd.nome} (${topProdId[1]} un.)`:'—';
  document.getElementById('rkLucro').textContent=fmtR(lucroEst);
  renderChart();
  renderTopProd();
}

function renderChart(){
  const wrap = document.getElementById('chartWrap');
  const tbody = document.getElementById('tbRelMensal');
  const now = new Date();
  const daysInMonth = new Date(now.getFullYear(),now.getMonth()+1,0).getDate();
  const days = [];
  for(let d=1;d<=daysInMonth;d++) days.push(d);
  const concl = DB.pedidos.filter(p=>p.status==='concluido');
  const maxVal = Math.max(...days.map(d=>{
    const dayPeds = concl.filter(p=>{ const dt=new Date(p.data); return dt.getDate()===d&&dt.getMonth()===now.getMonth(); });
    return dayPeds.reduce((a,p)=>a+p.total,0);
  }),1);
  wrap.innerHTML = days.map(d=>{
    const dayPeds = concl.filter(p=>{ const dt=new Date(p.data); return dt.getDate()===d&&dt.getMonth()===now.getMonth(); });
    const sales = dayPeds.reduce((a,p)=>a+p.total,0);
    const profit = dayPeds.reduce((a,p)=>{
      const l=p.itens.reduce((b,it)=>{ const pr=DB.produtos.find(x=>x.id===it.prodId); return b+(pr?(it.preco-pr.custo)*it.qty:0); },0); return a+l;
    },0);
    const sh = (sales/maxVal*100).toFixed(1);
    const ph = (profit/maxVal*100).toFixed(1);
    return `<div class="chart-bar-wrap" title="Dia ${d}: Vendas ${fmtR(sales)} / Lucro ${fmtR(profit)}">
      <div style="display:flex;gap:1px;height:100%;align-items:flex-end;width:100%">
        <div class="chart-bar cb-sales" style="height:${sh}%;flex:1"></div>
        <div class="chart-bar cb-profit" style="height:${ph}%;flex:1"></div>
      </div>
      <span>${d.toString().padStart(2,'0')}</span>
    </div>`;
  }).join('');
  tbody.innerHTML = days.filter(d=>{
    const dp=concl.filter(p=>{ const dt=new Date(p.data); return dt.getDate()===d&&dt.getMonth()===now.getMonth(); });
    return dp.length>0;
  }).map(d=>{
    const dayPeds = concl.filter(p=>{ const dt=new Date(p.data); return dt.getDate()===d&&dt.getMonth()===now.getMonth(); });
    const sales = dayPeds.reduce((a,p)=>a+p.total,0);
    const desc = dayPeds.reduce((a,p)=>a+(p.descVal||0),0);
    const profit = dayPeds.reduce((a,p)=>{
      const l=p.itens.reduce((b,it)=>{ const pr=DB.produtos.find(x=>x.id===it.prodId); return b+(pr?(it.preco-pr.custo)*it.qty:0); },0); return a+l;
    },0);
    return `<tr><td>${d.toString().padStart(2,'0')}/${(now.getMonth()+1).toString().padStart(2,'0')}</td><td>${dayPeds.length}</td><td>${fmtR(sales)}</td><td>${fmtR(desc)}</td><td class="tgreen">${fmtR(profit)}</td></tr>`;
  }).join('')||'<tr><td colspan="5" style="text-align:center;color:var(--dim);padding:16px">Nenhuma venda no mês</td></tr>';
}

function renderTopProd(){
  const concl = DB.pedidos.filter(p=>p.status==='concluido');
  const pCount = {}, pVal = {};
  concl.forEach(p=>p.itens.forEach(it=>{
    pCount[it.prodId]=(pCount[it.prodId]||0)+it.qty;
    pVal[it.prodId]=(pVal[it.prodId]||0)+it.preco*it.qty;
  }));
  const top = Object.entries(pCount).sort((a,b)=>b[1]-a[1]).slice(0,8);
  document.getElementById('topProd').innerHTML = top.length?top.map(([id,qty],i)=>{
    const p = DB.produtos.find(x=>x.id==id);
    return `<div class="top-prod-item">
      <div class="tpi-rank">${i+1}</div>
      <span class="tpi-name">${p?p.nome:'Produto #'+id}</span>
      <span class="tpi-qtd">${qty} un.</span>
      <span class="tpi-val">${fmtR(pVal[id]||0)}</span>
    </div>`;
  }).join(''):'<div style="text-align:center;color:var(--dim);padding:20px;font-size:.85rem">Nenhuma venda registrada</div>';
}

// ═══════════════════════════════
//  USUÁRIOS
// ═══════════════════════════════
function renderUsuarios(){
  document.getElementById('tbUsers').innerHTML = DB.users.map(u=>`
    <tr>
      <td><b>${u.nome}</b></td>
      <td><code>${u.login}</code></td>
      <td><span class="badge-stock ${u.perfil==='admin'?'bs-ok':'bs-baixo'}">${u.perfil==='admin'?'Admin':'Operador'}</span></td>
      <td style="font-size:.8rem">${u.ultimo||'Nunca'}</td>
      <td><label class="tgl-label"><input type="checkbox" ${u.ativo?'checked':''} onchange="toggleUser(${u.id})"/><span class="tgl-sl"></span></label></td>
      <td><div style="display:flex;gap:6px">
        <button class="btn-sm-green" onclick="editUser(${u.id})">Editar</button>
        ${u.id!==1?`<button class="btn-sm-outline" style="color:var(--red)" onclick="deleteUser(${u.id})">🗑</button>`:''}
      </div></td>
    </tr>
  `).join('');
}

function salvarUser(){
  const nome = document.getElementById('uNome').value.trim();
  const login = document.getElementById('uLogin').value.trim();
  const senha = document.getElementById('uSenha').value;
  if(!nome||!login){ toast('Preencha nome e login!','error'); return; }
  const editId = parseInt(document.getElementById('uId').value)||0;
  if(editId){
    const u = DB.users.find(x=>x.id===editId);
    if(u){ u.nome=nome; u.login=login; if(senha) u.senha=senha; u.perfil=document.getElementById('uPerfil').value; }
    toast('Usuário atualizado!','success');
  } else {
    if(!senha||senha.length<4){ toast('Senha mínima de 4 caracteres!','error'); return; }
    if(DB.users.find(u=>u.login===login)){ toast('Login já existe!','error'); return; }
    DB.users.push({id:DB.nextId.user++,nome,login,senha,perfil:document.getElementById('uPerfil').value,ativo:true,ultimo:''});
    toast('Usuário criado!','success');
  }
  saveDB(); closeModal('modalUser'); renderUsuarios();
}

function editUser(id){
  const u = DB.users.find(x=>x.id===id);
  if(!u) return;
  document.getElementById('muTitulo').textContent='Editar Usuário';
  document.getElementById('uId').value=u.id;
  document.getElementById('uNome').value=u.nome;
  document.getElementById('uLogin').value=u.login;
  document.getElementById('uSenha').value='';
  document.getElementById('uPerfil').value=u.perfil;
  openModal('modalUser');
}

function deleteUser(id){
  if(id===1){ toast('Não é possível excluir o admin!','error'); return; }
  if(!confirm('Excluir este usuário?')) return;
  DB.users=DB.users.filter(u=>u.id!==id);
  saveDB(); renderUsuarios(); toast('Usuário removido.','warn');
}

function toggleUser(id){
  const u = DB.users.find(x=>x.id===id);
  if(u && id!==1) u.ativo=!u.ativo;
  saveDB();
}

// ═══════════════════════════════
//  CONFIG
// ═══════════════════════════════
function renderConfig(){
  const c = DB.config;
  document.getElementById('cfNome').value=c.nome||'';
  document.getElementById('cfCnpj').value=c.cnpj||'';
  document.getElementById('cfTel').value=c.tel||'';
  document.getElementById('cfEnd').value=c.end||'';
  document.getElementById('cfClienteNome').value=c.clienteNome||'';
  document.getElementById('cfClienteLogo').value=c.clienteLogo||'';
  document.getElementById('cfDescAtacado').value=c.descAtacado||15;
  document.getElementById('cfQtdAtacado').value=c.qtdAtacado||10;
  document.getElementById('cfEstMin').value=c.estMin||5;
  document.getElementById('cfSemEst').value=c.semEst||'nao';
  document.getElementById('cfPrinterName').value=c.printerName||'';
  document.getElementById('cfAutoPrint').value=c.autoPrint||'sim';
  renderCatList();
}

function salvarConfig(){
  DB.config = {
    nome:document.getElementById('cfNome').value,
    cnpj:document.getElementById('cfCnpj').value,
    tel:document.getElementById('cfTel').value,
    end:document.getElementById('cfEnd').value,
    descAtacado:parseFloat(document.getElementById('cfDescAtacado').value)||15,
    qtdAtacado:parseInt(document.getElementById('cfQtdAtacado').value)||10,
    estMin:parseInt(document.getElementById('cfEstMin').value)||5,
    semEst:document.getElementById('cfSemEst').value,
    clienteNome:document.getElementById('cfClienteNome').value.trim(),
    clienteLogo:document.getElementById('cfClienteLogo').value.trim(),
    printerName:document.getElementById('cfPrinterName').value.trim(),
    autoPrint:document.getElementById('cfAutoPrint').value
  };
  saveDB();
  applyBranding();
  toast('Configurações salvas!','success');
}

function renderCatList(){
  const list = document.getElementById('catList');
  list.innerHTML = DB.categorias.map(c=>`
    <div class="cat-item">
      <span>${c.nome}</span>
      <button onclick="deleteCat(${c.id})">🗑</button>
    </div>
  `).join('');
}

function addCategoria(){
  const v = document.getElementById('novaCat').value.trim();
  if(!v) return;
  DB.categorias.push({id:Date.now(),nome:v});
  document.getElementById('novaCat').value='';
  saveDB(); renderCatList(); toast('Categoria adicionada!','success');
}

function deleteCat(id){
  if(DB.produtos.find(p=>p.catId===id)){ toast('Categoria possui produtos!','error'); return; }
  DB.categorias=DB.categorias.filter(c=>c.id!==id);
  saveDB(); renderCatList();
}

// ═══════════════════════════════
//  MODAIS
// ═══════════════════════════════
function openModal(id){
  const el = document.getElementById(id);
  if(el){ el.style.display='flex'; }
  // Pre-fill selects if needed
  if(id==='modalProduto') renderProdCats('mpCat');
  if(id==='modalEntrada') renderProdSel('entProd');
  if(id==='modalNovoPedido') return; // handled by openNovoPedido
}
function closeModal(id){
  const el = document.getElementById(id);
  if(el) el.style.display='none';
}
// Close on overlay click
document.addEventListener('click',e=>{
  if(e.target.classList.contains('modal-overlay') && !e.target.classList.contains('full-modal')){
    e.target.style.display='none';
  }
});

// ═══════════════════════════════
//  IMPRIMIR
// ═══════════════════════════════
function imprimirPedidoId(id){
  const p = DB.pedidos.find(x=>x.id===id);
  if(!p) return;
  const itens = p.itens.map(it=>{ const pr=DB.produtos.find(x=>x.id===it.prodId); return `${it.qty}x ${pr?pr.nome:'?'} — ${fmtR(it.preco*it.qty)}`; }).join('\n');
  const headerName = DB.config.clienteNome || DB.config.nome || 'STOCK PDV';
  const logoHTML = DB.config.clienteLogo ? `<div style="text-align:center;margin-bottom:10px"><img src="${DB.config.clienteLogo}" alt="Logo" style="max-width:130px;max-height:60px;object-fit:contain"/></div>` : '';
  const w = window.open('','_blank','width=400,height=600');
  w.document.write(`${logoHTML}<pre style="font-family:monospace;font-size:13px;padding:20px">
================================
      ${headerName}
================================
Pedido: #${p.id}
Tipo: ${tipoLabel(p.tipo)}
Cliente: ${p.cliente||'—'}
Data: ${fmtDate(p.data)}
--------------------------------
${itens}
--------------------------------
TOTAL: ${fmtR(p.total)}
Pagamento: ${pgtoLabel(p.pgto)}
${p.obs?'Obs: '+p.obs:''}
================================
</pre>`);
  w.print(); w.close();
}
function imprimirPedido(){ if(currentPedidoId) imprimirPedidoId(currentPedidoId); }
function imprimirRel(){ window.print(); }

function autoPrintPedido(pedido){
  if(DB.config.autoPrint!=='sim') return;
  if(DB.config.printerName && window.qz){
    imprimirPedidoQz(pedido).catch(()=>{
      toast('Falha ao enviar para QZ Tray. Impressão em navegador aberta.', 'warn');
      imprimirPedidoId(pedido.id);
    });
    return;
  }
  imprimirPedidoId(pedido.id);
}

async function imprimirPedidoQz(p){
  if(!window.qz) throw new Error('QZ Tray indisponível');
  if(!window.qz.websocket.isActive()){
    await window.qz.websocket.connect();
  }
  const config = window.qz.configs.create(DB.config.printerName);
  const texto = montarTextoPedido(p);
  await window.qz.print(config, [{ type:'raw', format:'plain', data:texto }]);
}

function montarTextoPedido(p){
  const headerName = DB.config.clienteNome || DB.config.nome || 'STOCK PDV';
  const itens = p.itens.map(it=>{
    const pr = DB.produtos.find(x=>x.id===it.prodId);
    return `${it.qty}x ${pr?pr.nome:'?'} - ${fmtR(it.preco*it.qty)}`;
  }).join('\n');
  return [
    '================================',
    `      ${headerName}`,
    '================================',
    `Pedido: #${p.id}`,
    `Tipo: ${tipoLabel(p.tipo)}`,
    `Cliente: ${p.cliente||'—'}`,
    `Data: ${fmtDate(p.data)}`,
    '--------------------------------',
    itens,
    '--------------------------------',
    `TOTAL: ${fmtR(p.total)}`,
    `Pagamento: ${pgtoLabel(p.pgto)}`,
    p.obs ? `Obs: ${p.obs}` : '',
    '================================',
    '\n\n\n'
  ].join('\n');
}

// ═══════════════════════════════
//  TOAST
// ═══════════════════════════════
function toast(msg, tipo='info'){
  const el = document.getElementById('toast');
  el.textContent=msg;
  el.className='toast show '+(tipo==='success'?'success':tipo==='error'?'error':tipo==='warn'?'warn':'');
  clearTimeout(el._t);
  el._t=setTimeout(()=>el.classList.remove('show'),3200);
}

// ═══════════════════════════════
//  HELPERS
// ═══════════════════════════════
function getPriceByQty(prod, qty){
  if(!prod) return 0;
  if(prod.unidade==='CX'){
    const lotes = getProdLotes(prod);
    for(let i=lotes.length-1;i>=0;i--){
      if(qty>=lotes[i].qtd) return lotes[i].preco;
    }
  }
  return getBasePrice(prod);
}

function normalizeLotes(rawLotes, legacy5=0, legacy10=0){
  const lotes = Array.isArray(rawLotes) ? rawLotes : [];
  const merged = lotes
    .map(l=>({qtd:parseInt(l.qtd,10),preco:parseFloat(l.preco)}))
    .filter(l=>l.qtd>0 && l.preco>0);
  if(legacy5>0 && !merged.find(l=>l.qtd===5)) merged.push({qtd:5,preco:legacy5});
  if(legacy10>0 && !merged.find(l=>l.qtd===10)) merged.push({qtd:10,preco:legacy10});
  merged.sort((a,b)=>a.qtd-b.qtd);
  return merged;
}

function getProdLotes(prod){
  if(!prod) return [];
  return normalizeLotes(prod.lotes, prod.precoCx5, prod.precoCx10);
}

function priceTierHint(prod){
  const lotes = getProdLotes(prod);
  const hints = lotes.slice(0,4).map(l=>`${l.qtd}+ cx: ${fmtR(l.preco)}`);
  return hints.length ? `• ${hints.join(' | ')}` : '';
}

function tierLabelByQty(qty, prodId){
  const prod = DB.produtos.find(p=>p.id===prodId);
  if(prod && prod.unidade==='CX'){
    const lotes = getProdLotes(prod);
    for(let i=lotes.length-1;i>=0;i--){
      if(qty>=lotes[i].qtd) return `Faixa ${lotes[i].qtd}+ caixas`;
    }
  }
  return 'Faixa padrão';
}

function getBasePrice(prod){
  if(!prod) return 0;
  return (prod.precoAtacado && prod.precoAtacado>0) ? prod.precoAtacado : (prod.preco||0);
}

function applyBranding(){
  const brandName = DB.config.clienteNome || DB.config.nome || 'STOCK PDV';
  const brandEl = document.getElementById('sbBrandName');
  if(brandEl) brandEl.textContent = brandName;
  const logoWrap = document.getElementById('sbLogoWrap');
  if(!logoWrap) return;
  if(DB.config.clienteLogo){
    logoWrap.innerHTML = `<img src="${DB.config.clienteLogo}" alt="Logo" style="width:100%;height:100%;object-fit:cover;border-radius:9px"/>`;
  } else {
    logoWrap.textContent = (brandName[0]||'S').toUpperCase();
  }
}

function fmtR(v){ return 'R$ '+(+v||0).toFixed(2).replace('.',',').replace(/\B(?=(\d{3})+(?!\d))/g,'.'); }
function fmtDate(iso){
  const d=new Date(iso);
  return d.toLocaleString('pt-BR',{day:'2-digit',month:'2-digit',year:'numeric',hour:'2-digit',minute:'2-digit'});
}
function tipoLabel(t){ return {retirada:'RETIRADA',entrega:'ENTREGA'}[t]||t; }
function pgtoLabel(p){ return {dinheiro:'💵 Dinheiro',pix:'⚡ PIX',credito:'💳 Crédito',debito:'💳 Débito',fiado:'📝 Fiado'}[p]||p; }
function statusLabel(s){ return {aguardando:'AGUARDANDO',atualizado:'ATUALIZADO',preparacao:'EM PREPARAÇÃO',entrega:'SAIU P/ ENTREGA',pronto:'PRONTO P/ RETIRADA',concluido:'CONCLUÍDO',cancelado:'CANCELADO',agendado:'AGENDADO'}[s]||s; }

// ═══════════════════════════════
//  START
// ═══════════════════════════════
window.addEventListener('DOMContentLoaded', init);