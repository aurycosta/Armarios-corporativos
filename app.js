/* Controle de Armários - offline
   Dados iniciais gerados a partir do seu arquivo colaborador.xlsx
*/
const INITIAL_EMPLOYEES = [{}]
import { initializeApp } from "https://www.gstatic.com/firebasejs/12.8.0/firebase-app.js";
import { getAnalytics } from "https://www.gstatic.com/firebasejs/12.8.0/firebase-analytics.js";
import {
  getDatabase, ref, onValue, set, update, remove, get, child, runTransaction, push, query, limitToLast
} from "https://www.gstatic.com/firebasejs/12.8.0/firebase-database.js";

// Atualizado para o banco armarios-corporativo conforme seu pedido inicial
const firebaseConfig = {
  apiKey: "AIzaSyAVp9c-unMG6LxVTOS0yX5G5KavXAqtyx8",
  authDomain: "armarios-corporativo.firebaseapp.com",
  projectId: "armarios-corporativo",
  storageBucket: "armarios-corporativo.firebasestorage.app",
  messagingSenderId: "586000291300",
  appId: "1:586000291300:web:86d1af40d623698f43a3f1",
  measurementId: "G-ZHY00D62WW",
  databaseURL: "https://armarios-corporativo-default-rtdb.firebaseio.com"
};

const app = initializeApp(firebaseConfig);
try { getAnalytics(app); } catch {}
const db = getDatabase(app);

// === SEGREDO PARA MULTI-LOJAS ===
const lojaAtual = localStorage.getItem('loja_armarios') || "005-LRVCEN";
const basePath = "lojas/" + lojaAtual;

// ===== Helpers/UI =====
const el = (id) => document.getElementById(id);

const tabs = Array.from(document.querySelectorAll(".tab"));
const panels = {
  colabs: el("tab-colabs"),
  lockers: el("tab-lockers"),
  import: el("tab-import"),
  config: el("tab-config"),
  history: el("tab-history"),
};

const modal = el("modal");
const toast = el("toast");
const connStatus = el("connStatus");
// ===== Gate Admin (UI-only) =====
const adminGate = el("adminGate");
const adminPinInput = el("adminPinInput");
const btnAdminEnter = el("btnAdminEnter");
const adminGateMsg = el("adminGateMsg");
const btnAdminLogout = el("btnAdminLogout");

const adminPinConfig = el("adminPinConfig");
const btnSaveAdminPin = el("btnSaveAdminPin");
const btnClearAdminPin = el("btnClearAdminPin");

function isClaimMode(){
  return document.documentElement.classList.contains("claim-mode") || document.body.classList.contains("claim-mode");
}

function hasAdminSession(){
  return localStorage.getItem("adminSession") === "1";
}

function lockAdminIfNeeded(){
  // Se não estiver em modo QR e tiver PIN definido, exige sessão admin
  if(isClaimMode()) return;
  const pin = (state.adminPin || "").trim();
  if(pin && !hasAdminSession()){
    document.documentElement.classList.add("admin-locked");
  }else{
    document.documentElement.classList.remove("admin-locked");
  }
}

btnAdminEnter?.addEventListener("click", ()=>{
  const pin = (state.adminPin || "").trim();
  if(!pin){
    adminGateMsg.textContent = "Nenhum PIN definido em Config.";
    return;
  }
  const typed = String(adminPinInput.value || "").trim();
  if(typed === pin){
    localStorage.setItem("adminSession","1");
    document.documentElement.classList.remove("admin-locked");
    adminGateMsg.textContent = "";
    adminPinInput.value = "";
    showToast("Acesso liberado.");
  }else{
    adminGateMsg.textContent = "PIN incorreto.";
  }
});

btnAdminLogout?.addEventListener("click", ()=>{
  localStorage.removeItem("adminSession");
  showToast("Sessão encerrada.");
  lockAdminIfNeeded();
});

// Config: salvar/remover PIN no Firebase
btnSaveAdminPin?.addEventListener("click", async ()=>{
  try{
    const v = String(adminPinConfig.value || "").trim();
    if(!v) { showToast("Digite um PIN."); return; }
    await set(ref(db, basePath + "/config/adminPin"), v);
    showToast("PIN salvo.");
    adminPinConfig.value = "";
  }catch(err){
    showToast(err?.message || "Erro ao salvar PIN.");
  }
});

btnClearAdminPin?.addEventListener("click", async ()=>{
  try{
    await set(ref(db, basePath + "/config/adminPin"), "");
    localStorage.removeItem("adminSession");
    showToast("PIN removido.");
    lockAdminIfNeeded();
  }catch(err){
    showToast(err?.message || "Erro ao remover PIN.");
  }
});


let state = {
  totalLockers: 300,
  defaultSplit: 150, // 1..X = BAIXO, X+1..total = CIMA (padrão)
  lockerPositions: {}, // override por número: { "42": "CIMA" }
  lockerKeys: {}, // override por número: { "42": 2 } (total de chaves)
  lockerMaint: {}, // { "42": {status:"MANUTENCAO"|"OK", note:"", updatedAt:...} }
  employees: [], // [{cadastro, nome, admissao, cargo, armario, chaveEntregueEm}]
};

function showToast(msg){
  toast.textContent = msg;
  toast.classList.add("show");
  clearTimeout(showToast._t);
  showToast._t = setTimeout(()=>toast.classList.remove("show"), 2600);
}

function normalize(str){
  return (str ?? "")
    .toString()
    .normalize("NFD").replace(/[\u0300-\u036f]/g,"")
    .toLowerCase()
    .trim();
}

function formatDateBR(iso){
  if(!iso) return "";
  // aceita 'YYYY-MM-DD'
  const [y,m,d] = String(iso).split("-");
  if(!y||!m||!d) return String(iso);
  return `${d}/${m}/${y}`;
}

function parseLockerFilter(input){
  const s = normalize(input);
  if(!s) return { type: "all" };
  // "1-50"
  const m = s.match(/^(\d+)\s*-\s*(\d+)$/);
  if(m){
    let a = parseInt(m[1],10), b = parseInt(m[2],10);
    if(Number.isFinite(a)&&Number.isFinite(b)){
      if(a>b) [a,b]=[b,a];
      return { type:"range", a, b };
    }
  }
  // "2xx"
  const m2 = s.match(/^(\d)x{2}$/);
  if(m2){
    const p = parseInt(m2[1],10);
    if(Number.isFinite(p)) return { type:"prefix", p };
  }
  // número exato
  const n = parseInt(s,10);
  if(Number.isFinite(n)) return { type:"one", n };
  return { type:"text", s };
}

function lockerPosition(n){
  const key = String(n);
  const ov = state.lockerPositions?.[key];
  if(ov === "CIMA" || ov === "BAIXO") return ov;
  const split = Number.isFinite(state.defaultSplit) ? state.defaultSplit : Math.floor(state.totalLockers/2);
  return n <= split ? "BAIXO" : "CIMA";
}

// ===== Chaves (cópias) por armário =====

function maintInfoForLocker(n){
  const v = state.lockerMaint ? (state.lockerMaint[String(n)] || state.lockerMaint[n]) : null;
  if(!v) return { status:"OK", note:"" };
  if(typeof v === "string") return { status: v, note:"" };
  return { status: v.status || "MANUTENCAO", note: v.note || "" };
}

function totalKeysForLocker(n){
  const v = state.lockerKeys?.[String(n)];
  const num = Number(v);
  return Number.isFinite(num) && num > 0 ? Math.floor(num) : 1; // padrão: 1 chave
}

function keysInUseForLocker(n, excludeCadastro){
  // Cada armário é único por colaborador, mas a chave pode ou não ter sido entregue.
  // Conta colaboradores com este armário e chaveEntregueEm preenchido.
  let count = 0;
  for(const e of state.employees){
    if(excludeCadastro && String(e.cadastro) === String(excludeCadastro)) continue;
    if(Number.isFinite(e.armario) && e.armario === n && e.chaveEntregueEm){
      count++;
    }
  }
  return count;
}

function keysAvailableForLocker(n, excludeCadastro){
  return totalKeysForLocker(n) - keysInUseForLocker(n, excludeCadastro);
}

async function saveLockerKeys(num, total){
  await set(ref(db, `${basePath}/lockerKeys/${num}`), total);
}

async function logHistoricoChave({ tipo, armario, cadastro, nome, chaveEntregueEm, obs, totalAntes, totalDepois, deltaTotal }){
  // não falha o fluxo principal se o log falhar
  try{
    const payload = {
      ts: Date.now(),
      tipo: String(tipo || ""),
      armario: armario == null ? null : Number(armario),
      cadastro: String(cadastro || ""),
      nome: String(nome || ""),
      chaveEntregueEm: chaveEntregueEm ?? null,
      obs: obs ? String(obs) : "",
      totalAntes: Number.isFinite(totalAntes) ? Number(totalAntes) : null,
      totalDepois: Number.isFinite(totalDepois) ? Number(totalDepois) : null,
      deltaTotal: Number.isFinite(deltaTotal) ? Number(deltaTotal) : null
    };
    await push(ref(db, basePath + "/historicoChaves"), payload);
  }catch(err){
    console.warn("Falha ao registrar histórico:", err);
  }
}


function tagPos(pos){
  const span = document.createElement("span");
  span.className = "tag";
  span.textContent = pos;
  return span;
}

function updateConnBadge(connected){
  if(!connStatus) return;
  if(connected){
    connStatus.textContent = "Online • Firebase (tempo real)";
    connStatus.classList.add("ok");
    connStatus.classList.remove("bad");
  } else {
    connStatus.textContent = "Offline • tentando reconectar…";
    connStatus.classList.remove("ok");
    connStatus.classList.add("bad");
  }
}

// ===== Firebase sync =====
let _seeded = false;

function seedIfEmpty(snapshotVal){
  // Se não existir nenhum colaborador no banco, joga o INITIAL_EMPLOYEES uma vez
  if(_seeded) return;
  _seeded = true;

  if(snapshotVal && Object.keys(snapshotVal).length) return;

  const updates = {};
  for(const e of INITIAL_EMPLOYEES){
    const cadastro = String(e.cadastro).trim();
    if(!cadastro) continue;
    updates[`employees/${cadastro}`] = {
      cadastro,
      nome: e.nome ?? "",
      admissao: e.admissao ?? "",
      cargo: e.cargo ?? "",
      armario: e.armario ?? null,
      chaveEntregueEm: e.chaveEntregueEm ?? null,
    };
  }
  // total/defaultSplit só se não existirem
  updates["config/totalLockers"] = 300;
  updates["config/defaultSplit"] = 150;
  
  // Envia as atualizações salvando dentro da pasta da loja específica
  return update(ref(db, basePath), updates)
    .then(()=>showToast("Base inicial enviada para o Firebase."))
    .catch((err)=>showToast("Não consegui enviar base inicial: " + (err?.message || err)));
}

function startRealtime(){
  // status de conexão (Mantém na raiz para pegar status global)
  onValue(ref(db, ".info/connected"), (snap)=> updateConnBadge(!!snap.val()));

  // config
  onValue(ref(db, basePath + "/config"), (snap)=>{
    const v = snap.val() || {};
    const total = Number(v.totalLockers);
    if(Number.isFinite(total) && total>0) state.totalLockers = Math.floor(total);

    const split = Number(v.defaultSplit ?? v.divisao);
    if(Number.isFinite(split) && split>=0) state.defaultSplit = Math.floor(split);

    const padrao = (v.padraoAte === "CIMA") ? "CIMA" : "BAIXO";
    state.defaultPadraoAte = padrao;

    el("totalInput").value = state.totalLockers;
    el("splitInput").value = state.defaultSplit;
    if(el("padraoAteInput")) el("padraoAteInput").value = state.defaultPadraoAte;
    renderAll();
    // se veio via QR (?claim=1&locker=...), abre o modal depois que os colaboradores carregarem
    if(pendingClaimLocker != null){
      openClaimOnly(pendingClaimLocker);
      pendingClaimLocker = null;
    }
  });

  // locker positions override
  onValue(ref(db, basePath + "/lockerPositions"), (snap)=>{
    state.lockerPositions = snap.val() || {};
    renderAll();
  });

  // locker keys (total de cópias por armário)
  onValue(ref(db, basePath + "/lockerKeys"), (snap)=>{
    state.lockerKeys = snap.val() || {};
    renderAll();
  });


  // histórico de chaves (últimos 200) - APONTADO PARA A LOJA
  onValue(query(ref(db, basePath + "/historicoChaves"), limitToLast(200)), (snap)=>{
    const v = snap.val() || {};
    const arr = [];
    for(const [id, h] of Object.entries(v)){
      if(!h) continue;
      arr.push({
        id,
        ts: Number(h.ts) || 0,
        tipo: String(h.tipo || ""),
        armario: (h.armario == null ? null : Number(h.armario)),
        cadastro: String(h.cadastro || ""),
        nome: String(h.nome || ""),
        chaveEntregueEm: h.chaveEntregueEm ?? null,
        obs: String(h.obs || ""),
        totalAntes: (h.totalAntes == null ? null : Number(h.totalAntes)),
        totalDepois: (h.totalDepois == null ? null : Number(h.totalDepois)),
        deltaTotal: (h.deltaTotal == null ? null : Number(h.deltaTotal)),
      });
    }
    arr.sort((a,b)=> (b.ts||0) - (a.ts||0));
    state.historicoChaves = arr;
    renderHistory();
  }, (err)=>{
    // não trava o app se der erro no histórico
    console.warn("Erro Firebase (historicoChaves):", err);
  });

// ===== LER COLABORADORES DA LOJA LOGADA =====
onValue(ref(db, basePath + "/employees"), (snap) => {
  const v = snap.val();
  
  // Limpa o array atual para não duplicar
  const arr = [];
  
  // Verifica se existem dados
  if (v) {
    // Itera sobre cada cadastro encontrado no Firebase
    Object.keys(v).forEach(key => {
      const e = v[key];
      
      // Filtro de segurança: garante que é um objeto de colaborador e não metadados
      if (typeof e === 'object' && e !== null && e.cadastro) {
        arr.push({
          cadastro: String(e.cadastro),
          nome: e.nome || "",
          admissao: e.admissao || "",
          cargo: e.cargo || "",
          armario: Number.isFinite(e.armario) ? e.armario : null,
          chaveEntregueEm: e.chaveEntregueEm || null,
        });
      }
    });
  }

  // Sanitização: garante que armários inválidos fiquem null
  state.employees = arr.map(e => {
    if (e.armario != null && (e.armario < 1 || e.armario > state.totalLockers)) {
      e.armario = null;
    }
    return e;
  });

  // Debug: se não aparecer no painel, olhe o Console (F12) e veja se esse número está correto
  console.log("Total de colaboradores carregados:", state.employees.length);

  // Atualiza a interface
  refreshKeyEvtEmpOptions();
  renderAll();
  
}, (err) => {
  showToast("Erro ao carregar dados do Firebase: " + err.message);
  console.error(err);
});

}

async function claimLocker(lockerNumber, cadastro){
  const n = Number(lockerNumber);
  if(!Number.isFinite(n)) return;
  const r = ref(db, `${basePath}/lockerIndex/${n}`);
  const res = await runTransaction(r, (current)=>{
    if(current === null || current === cadastro) return cadastro;
    return; // aborta
  });
  if(!res.committed) throw new Error(`Armário ${n} já está em uso.`);
}

async function releaseLocker(lockerNumber, cadastro){
  const n = Number(lockerNumber);
  if(!Number.isFinite(n)) return;
  const r = ref(db, `${basePath}/lockerIndex/${n}`);
  await runTransaction(r, (current)=>{
    if(current === cadastro) return null;
    return current;
  });
}

async function writeEmployee(emp, prevLocker){
  const cadastro = String(emp.cadastro).trim();
  if(!cadastro) throw new Error("Matrícula inválida.");

  const newLocker = emp.armario ?? null;

  // trava de armário
  if(prevLocker != null && prevLocker !== newLocker){
    await releaseLocker(prevLocker, cadastro);
  }
  if(newLocker != null){
    await claimLocker(newLocker, cadastro);
  }

  await set(ref(db, `${basePath}/employees/${cadastro}`), {
    cadastro,
    nome: emp.nome ?? "",
    admissao: emp.admissao ?? "",
    cargo: emp.cargo ?? "",
    armario: newLocker,
    chaveEntregueEm: emp.chaveEntregueEm ?? null,
    updatedAt: Date.now()
  });
}

async function deleteEmployee(cadastro){
  const snap = await get(child(ref(db), `${basePath}/employees/${cadastro}`));
  const emp = snap.val();
  if(emp && emp.armario != null){
    await releaseLocker(emp.armario, String(cadastro));
  }
  await remove(ref(db, `${basePath}/employees/${cadastro}`));
}

async function saveTotalLockers(total){
  await set(ref(db, `${basePath}/config/totalLockers`), total);
}

async function saveDefaultSplit(split){
  await set(ref(db, `${basePath}/config/defaultSplit`), split);
}

async function saveLockerPosition(num, pos){
  await set(ref(db, `${basePath}/lockerPositions/${num}`), pos);
}

// ===== Availability =====
function getUsedLockers(){
  const used = new Set();
  for(const e of state.employees){
    if(Number.isFinite(e.armario)) used.add(e.armario);
  }
  return used;
}

function getFreeLockers(){
  const used = getUsedLockers();
  const free = [];
  for(let i=1;i<=state.totalLockers;i++){
    if(!used.has(i)) free.push(i);
  }
  return free;
}

function updateStats(){
  const used = getUsedLockers().size;
  const free = state.totalLockers - used;
  el("totalLockers").textContent = String(state.totalLockers);
  el("usedLockers").textContent = String(used);
  el("freeLockers").textContent = String(free);

  // alerta compacto no topo: armários sem chave reserva (disponível = 0)
  const zeroPill = document.getElementById("zeroKeysPill");
  const zeroCountEl = document.getElementById("zeroKeysCount");
  if(zeroPill && zeroCountEl){
    const usedSet = getUsedLockers();
    let zeroCount = 0;
    for(const n of usedSet){
      if(keysAvailableForLocker(n) <= 0) zeroCount++;
    }
    zeroCountEl.textContent = String(zeroCount);
    zeroPill.classList.toggle("pulse", zeroCount > 0);
    zeroPill.style.display = "";
    zeroPill.title = zeroCount
      ? `🔔 ${zeroCount} armário(s) sem chave reserva (disponível = 0).`
      : "✅ Todos os armários têm ao menos 1 chave reserva disponível.";
  }
}

function switchTab(name){
  for(const t of tabs){
    t.classList.toggle("active", t.dataset.tab === name);
  }
  for(const [k,p] of Object.entries(panels)){
    p.classList.toggle("active", k === name);
  }
}

tabs.forEach(t => t.addEventListener("click", ()=> { if(document.body.classList.contains("claim-mode")) return; switchTab(t.dataset.tab); }));

// ===== QR / Autoatendimento (por armário) =====
const claimModal = el("claimModal");
const claimOnly = el("claimOnly");
const claimOnlyLocker = el("claimOnlyLocker");
const claimOnlyCadastro = el("claimOnlyCadastro");
const claimOnlyNome = el("claimOnlyNome");
const claimOnlyAgree = el("claimOnlyAgree");
const claimOnlyConfirm = el("claimOnlyConfirm");
const claimOnlyMsg = el("claimOnlyMsg");

const claimForm = el("claimForm");
const claimLockerInput = el("claimLocker");
const claimCadastro = el("claimCadastro");
const claimNome = el("claimNome");
const claimAgree = el("claimAgree");
const claimConfirm = el("claimConfirm");
const claimCancel = el("claimCancel");

const qrFrom = el("qrFrom");
const qrTo = el("qrTo");
const btnGenQR = el("btnGenQR");
const btnPrintQR = el("btnPrintQR");
const qrGrid = el("qrGrid");
const qrHint = el("qrHint");
const qrBaseUrl = el("qrBaseUrl");


let pendingClaimLocker = null;

function buildLockerClaimUrl(n){
  // Preferência de URL pública (para QR funcionar fora do PC)
  const base = (state.publicBaseUrl || localStorage.getItem("publicBaseUrl") || "").trim();
  try{
    if(base){
      const u = new URL(base);
      u.searchParams.set("claim","1");
      u.searchParams.set("locker", String(n));
      return u.toString();
    }
    const u = new URL(window.location.href);
    u.searchParams.set("claim","1");
    u.searchParams.set("locker", String(n));
    u.hash = "";
    return u.toString();
  }catch{
    const originPath = `${location.origin}${location.pathname}`;
    return `${originPath}?claim=1&locker=${n}`;
  }
}

function openClaimModal(lockerNumber){
  if(document.body.classList.contains('claim-mode')) return;
  const n = Number(lockerNumber);
  if(!Number.isFinite(n)) return;

  claimLockerInput.value = String(n);
  claimCadastro.value = "";
  claimNome.value = "";
  claimAgree.checked = false;
  claimConfirm.disabled = true;

  if(!claimModal.open) claimModal.showModal();
  setTimeout(()=> claimCadastro.focus(), 50);
}

function refreshClaimUI(){
  const cad = String(claimCadastro.value ?? "").trim();
  const emp = state.employees.find(e => String(e.cadastro) === cad);
  claimNome.value = emp ? emp.nome : "";
  claimConfirm.disabled = !(emp && claimAgree.checked);
}


function setClaimMode(on){
  document.documentElement.classList.toggle("claim-mode", !!on);
  document.body.classList.toggle("claim-mode", !!on);
}

function openClaimOnly(lockerNumber){
  const n = Number(lockerNumber);
  if(!Number.isFinite(n)) return;
  if(claimOnlyLocker) claimOnlyLocker.value = String(n);
  if(claimOnlyCadastro) claimOnlyCadastro.value = "";
  if(claimOnlyNome) claimOnlyNome.value = "";
  if(claimOnlyAgree) claimOnlyAgree.checked = false;
  if(claimOnlyConfirm) claimOnlyConfirm.disabled = true;
  if(claimOnlyMsg) claimOnlyMsg.textContent = "";
  if(claimOnlyCadastro) setTimeout(()=>claimOnlyCadastro.focus(), 50);
}


function refreshClaimOnlyUI(){
  const cad = String(claimOnlyCadastro?.value ?? "").trim();
  const emp = state.employees.find(e => String(e.cadastro) === cad);
  if(claimOnlyNome) claimOnlyNome.value = emp ? emp.nome : "";
  if(claimOnlyAgree) claimOnlyAgree.checked = true;
  if(claimOnlyConfirm) claimOnlyConfirm.disabled = !emp;
}

claimOnlyCadastro?.addEventListener("input", refreshClaimOnlyUI);
claimOnlyAgree?.addEventListener("change", refreshClaimOnlyUI);

claimOnlyConfirm?.addEventListener("click", async ()=>{
  try{
    claimOnlyConfirm.disabled = true;
    if(claimOnlyMsg) claimOnlyMsg.textContent = "Confirmando…";
    await selfAssignLocker(claimOnlyCadastro.value, claimOnlyLocker.value);
    if(claimOnlyMsg) claimOnlyMsg.textContent = "✅ Confirmado. Você já pode fechar esta página.";
  }catch(err){
    if(claimOnlyMsg) claimOnlyMsg.textContent = err?.message ?? "Não foi possível confirmar.";
    claimOnlyConfirm.disabled = false;
  }
});

claimCadastro?.addEventListener("input", refreshClaimUI);
claimAgree?.addEventListener("change", refreshClaimUI);
claimCancel?.addEventListener("click", ()=> claimModal.close());

async function selfAssignLocker(cadastro, lockerNumber){
  const cad = String(cadastro ?? "").trim();
  const locker = Number(lockerNumber);
  if(!cad) throw new Error("Informe a matrícula.");
  if(!Number.isFinite(locker) || locker < 1) throw new Error("Armário inválido.");

  const current = state.employees.find(e => String(e.cadastro) === cad);
  if(!current) throw new Error("Matrícula não encontrada.");

  const prevLocker = current.armario ?? null;

  // reaproveita as rotinas já existentes (índice + transações)
  await writeEmployee({
    cadastro: current.cadastro,
    nome: current.nome ?? "",
    admissao: current.admissao ?? "",
    cargo: current.cargo ?? "",
    armario: locker,
    chaveEntregueEm: current.chaveEntregueEm ?? null,
  }, prevLocker);

  // registra no mesmo histórico (não muda estrutura)
  await logHistoricoChave({
    tipo: "AUTO_ARMARIO",
    armario: locker,
    cadastro: current.cadastro,
    nome: current.nome,
    obs: "Autoatendimento via QR do armário",
  });

  showToast(`Armário ${locker} associado a ${current.nome}.`);
}

claimForm?.addEventListener("submit", async (e)=>{
  e.preventDefault();
  try{
    claimConfirm.disabled = true;
    await selfAssignLocker(claimCadastro.value, claimLockerInput.value);
    claimModal.close();

    // limpa a URL (tira claim/locker) para não reabrir ao recarregar
    const u = new URL(window.location.href);
    u.searchParams.delete("claim");
    u.searchParams.delete("locker");
    window.history.replaceState({}, "", u.toString());
  }catch(err){
    claimConfirm.disabled = false;
    showToast(err?.message ?? "Não foi possível confirmar o armário.");
  }
});

if(qrBaseUrl){
  // carrega último valor salvo
  qrBaseUrl.value = localStorage.getItem("publicBaseUrl") || state.publicBaseUrl || "";
  qrBaseUrl.addEventListener("change", ()=>{
    const v = (qrBaseUrl.value || "").trim();
    if(v) localStorage.setItem("publicBaseUrl", v);
    else localStorage.removeItem("publicBaseUrl");
  });
}

btnGenQR?.addEventListener("click", ()=>{
  const total = Number(state.totalLockers) || 300;
  // se informado, usa como base (e salva no localStorage)
  if(qrBaseUrl){
    const v = (qrBaseUrl.value || '').trim();
    if(v) localStorage.setItem('publicBaseUrl', v);
  }
  const a = Number(qrFrom.value || 1);
  const b = Number(qrTo.value || Math.min(total, 50));
  const from = Math.max(1, Math.min(a, b));
  const to = Math.min(total, Math.max(a, b));

  qrGrid.innerHTML = "";
  const count = to - from + 1;
  const baseUsed = (qrBaseUrl?.value || state.publicBaseUrl || localStorage.getItem('publicBaseUrl') || '').trim();
  qrHint.textContent = `Gerando ${count} QR(s) — Total configurado: ${total}` + (baseUsed ? ` • Base: ${baseUsed}` : ' • Base: (URL atual)');

  for(let n=from; n<=to; n++){
    const url = buildLockerClaimUrl(n);

    const item = document.createElement("div");
    item.className = "qr-item";

    const top = document.createElement("div");
    top.className = "qr-top";
    top.innerHTML = `<div class="qr-num">Armário ${n}</div><div class="muted small">QR</div>`;

    const box = document.createElement("div");
    box.id = `qr_${n}`;

    const link = document.createElement("div");
    link.className = "qr-url";
    link.textContent = url;

    item.appendChild(top);
    item.appendChild(box);
    item.appendChild(link);
    qrGrid.appendChild(item);

    // QRCode lib (global)
    if(window.QRCode){
      new window.QRCode(box, { text: url, width: 128, height: 128, correctLevel: window.QRCode.CorrectLevel.M });
    }else{
      box.textContent = "Biblioteca QR não carregou.";
    }
  }
});

btnPrintQR?.addEventListener("click", ()=>{
  if(!qrGrid.children.length){
    showToast("Gere os QRs antes de imprimir.");
    return;
  }
  setTimeout(()=>window.print(), 250);
});

// lê URL (?claim=1&locker=82)
(function initClaimFromUrl(){
  const params = new URLSearchParams(window.location.search);
  const claim = params.get("claim");
  const locker = params.get("locker");
  if(String(claim) === "1" && locker){
    pendingClaimLocker = Number(locker);
    setClaimMode(true);
    // se já carregou, abre imediatamente
    if(state.employees?.length){
      openClaimOnly(pendingClaimLocker);
      pendingClaimLocker = null;
    }
  }
})();
// aplica gate admin após identificar modo
lockAdminIfNeeded();


function tdText(text){
  const td = document.createElement("td");
  td.textContent = text ?? "";
  return td;
}

// ===== Render =====
function renderEmployees(){
  const q = normalize(el("searchInput").value);
  const tbody = el("tbody");
  tbody.innerHTML = "";

  const rows = state.employees
    .slice()
    .sort((a,b)=> normalize(a.nome).localeCompare(normalize(b.nome)));

  for(const e of rows){
    const hay = normalize([e.cadastro, e.nome, e.cargo, e.admissao, e.armario].join(" "));
    if(q && !hay.includes(q)) continue;

    const tr = document.createElement("tr");
    tr.dataset.cadastro = e.cadastro;
    tr.id = "row-" + encodeURIComponent(e.cadastro);

    tr.appendChild(tdText(e.cadastro));
    tr.appendChild(tdText(e.nome));
    tr.appendChild(tdText(formatDateBR(e.admissao)));
    tr.appendChild(tdText(e.cargo));

    // Armário (click to edit)
    const tdArm = document.createElement("td");
    const btn = document.createElement("button");
    btn.className = "cell-btn";
    btn.textContent = e.armario ? String(e.armario) : "—";
    btn.title = "Clique para editar";
    btn.addEventListener("click", ()=> openModal(e));
    tdArm.appendChild(btn);
    tr.appendChild(tdArm);

    // Posição
    const tdPos = document.createElement("td");
    if(e.armario){
      tdPos.appendChild(tagPos(lockerPosition(e.armario)));
    } else {
      tdPos.textContent = "—";
    }
    tr.appendChild(tdPos);

    tr.appendChild(tdText(formatDateBR(e.chaveEntregueEm)));

    // actions
    const tdA = document.createElement("td");
    const del = document.createElement("button");
    del.className = "btn btn-danger btn-sm";
    del.textContent = "Excluir";
    del.addEventListener("click", async ()=>{
      if(!confirm(`Excluir ${e.nome} (${e.cadastro})?`)) return;
      try{
        await deleteEmployee(e.cadastro);
        showToast("Excluído.");
      }catch(err){
        showToast("Erro ao excluir: " + (err?.message || err));
      }
    });
    tdA.appendChild(del);
    tr.appendChild(tdA);

    tbody.appendChild(tr);
  }
}

function renderLockers(){
  const filter = parseLockerFilter(el("lockerFilter").value);
  const mode = el("lockerStatus") ? el("lockerStatus").value : "free"; // all | free | used | manutencao

  const usedSet = getUsedLockers();
  const freeList = getFreeLockers();
  const usedList = Array.from(usedSet).sort((a,b)=>a-b);

  let numbers = [];
  
  // AJUSTE DO MODO: Se for "manutencao" ou "all", carregamos todos os números para filtrar depois
  if(mode === "all" || mode === "manutencao"){
    for(let i=1;i<=state.totalLockers;i++) numbers.push(i);
  }else if(mode === "used"){
    numbers = usedList;
  }else{
    numbers = freeList;
  }

  const grid = el("freeGrid");
  grid.innerHTML = "";

  let shown = 0;

  const matches = (n)=>{
    if(!filter || filter.type === "all") return true;
    if(filter.type === "range") return (n >= filter.a && n <= filter.b);
    if(filter.type === "one") return (n === filter.n);
    if(filter.type === "prefix") return (Math.floor(n/100) === filter.p);
    if(filter.type === "text") return String(n).includes(filter.s);
    return true;
  };

  const findEmpByLocker = (n)=>{
    return state.employees.find(e => Number.isFinite(e.armario) && e.armario === n) || null;
  };

  for(const n of numbers){
    if(!matches(n)) continue;

    // VERIFICAÇÃO DE MANUTENÇÃO
    let isMaint = false;
    let mi = null;
    try {
      mi = maintInfoForLocker(n);
      if(mi && mi.status === "MANUTENCAO") {
        isMaint = true;
      }
    } catch(e) {}

    // Se o filtro selecionado for "Em Manutenção" e este armário NÃO estiver em manutenção, pula ele!
    if(mode === "manutencao" && !isMaint) continue;

    // Se o modo for 'manutencao', precisamos descobrir se o armário de manutenção está livre ou ocupado
    const isUsed = (mode === "used") ? true : ((mode === "all" || mode === "manutencao") ? usedSet.has(n) : false);
    const emp = (mode === "free") ? null : findEmpByLocker(n);
    const position = lockerPosition(n);

    const card = document.createElement("div");
    card.className = "free-item " + (isUsed ? "ocupado" : "livre");
    const availKeysNow = keysAvailableForLocker(n);
    if(availKeysNow <= 0) card.classList.add("sem-chave");
    
    // Se estiver em manutenção, adiciona a classe visual amarela
    if(isMaint) {
      card.classList.add("manut");
    }

    card.title = isUsed
      ? `OCUPADO • ${position}
Chaves: ${Math.max(0,(totalKeysForLocker(n)-keysInUseForLocker(n)))}/${totalKeysForLocker(n)} disponíveis
${emp?.nome || "—"} (${emp?.cadastro || ""})`
      : `LIVRE • ${position}
Chaves: ${Math.max(0,(totalKeysForLocker(n)-keysInUseForLocker(n)))}/${totalKeysForLocker(n)} disponíveis
Clique para copiar o número`;

    const num = document.createElement("div");
    num.textContent = String(n);

    const badgeLine = document.createElement("div");
    badgeLine.className = "badge-line";

    const statusTag = document.createElement("span");
    statusTag.className = "tag " + (isUsed ? "warn" : "ok");
    statusTag.textContent = isUsed ? "OCUPADO" : "LIVRE";

    badgeLine.appendChild(statusTag);
    badgeLine.appendChild(tagPos(position));

    // chaves
    const totalKeys = totalKeysForLocker(n);
    const inUseKeys = keysInUseForLocker(n);
    const availKeys = totalKeys - inUseKeys;

    const keyTag = document.createElement("span");
    keyTag.className = "tag " + (availKeys <= 0 ? "danger" : "info");
    keyTag.textContent = `CHAVES ${Math.max(0,availKeys)}/${totalKeys}`;

    badgeLine.appendChild(keyTag);

    // badge de manutenção na tela
    if(isMaint && mi) {
      const mtag = document.createElement("span");
      mtag.className = "tag maint";
      mtag.textContent = "🔧 MANUT";
      if(mi.note) mtag.title = mi.note;
      badgeLine.appendChild(mtag);
    }

    card.appendChild(num);
    card.appendChild(badgeLine);
    if(isUsed){
      const mini = document.createElement("span");
      mini.className = "mini";
      mini.textContent = emp ? `${emp.nome} • ${emp.cadastro}` : "—";
      card.appendChild(mini);
    }

    card.addEventListener("click", async ()=>{
      if(isUsed && emp){
        switchTab("colabs");
        el("searchInput").value = emp.cadastro;
        renderEmployees();
        setTimeout(()=>{
          const row = el("row-" + encodeURIComponent(emp.cadastro));
          if(row){
            row.classList.add("flash");
            row.scrollIntoView({behavior:"smooth", block:"center"});
            setTimeout(()=> row.classList.remove("flash"), 1800);
          }
          openModal(emp);
        }, 80);
      }else{
        try{
          await navigator.clipboard.writeText(String(n));
          showToast(`Armário ${n} copiado. (Livre • ${position})`);
        }catch{
          showToast(`Armário ${n} (Livre • ${position})`);
        }
      }
    });

    grid.appendChild(card);
    shown++;
  }

  const freeCount = freeList.length;
  const usedCount = usedSet.size;
  const total = state.totalLockers;

  const labelMode = mode === "all" ? "no total" : (mode === "used" ? "ocupados" : (mode === "manutencao" ? "em manutenção" : "livres"));
  el("freeSummary").textContent = `${shown} mostrando • ${freeCount} livres • ${usedCount} ocupados • ${total} no total (${labelMode})`;

  state._lastLockerVisible = Array.from(grid.querySelectorAll(".free-item > div:first-child")).map(d=>d.textContent);
}


function renderRiskAndAlerts(){
  // Armários em risco (total = 1)
  const riskGrid = el("riskGrid");
  const riskSummary = el("riskSummary");
  const zeroGrid = el("zeroKeysGrid");
  const zeroSummary = el("zeroKeysSummary");
  if(!riskGrid || !zeroGrid) return;

  riskGrid.innerHTML = "";
  zeroGrid.innerHTML = "";

  const risk = [];
  const zero = [];

  for(let i=1;i<=state.totalLockers;i++){
    const totalK = totalKeysForLocker(i);
    const inUseK = keysInUseForLocker(i);
    const availK = totalK - inUseK;

    if(totalK === 1) risk.push(i);
    // sem reserva quando disponível = 0 (todas em uso) OU quando total = 0
    if((availK <= 0 && totalK > 0 && inUseK > 0) || totalK === 0) zero.push(i);
  }

  if(riskSummary) riskSummary.textContent = `${risk.length} armário(s) com 1 chave (risco).`;
  if(zeroSummary) zeroSummary.textContent = `${zero.length} armário(s) sem chave reserva (disponível = 0) ou total = 0.`;

  const makeCard = (n, kind)=>{
    const div = document.createElement("div");
    div.className = kind === "zero" ? "free-item ocupado" : "free-item";
    div.innerHTML = `<div>${n}</div><span class="mini">${lockerPosition(n)} • chaves ${Math.max(0, keysAvailableForLocker(n))}/${totalKeysForLocker(n)}</span>`;
    div.addEventListener("click", ()=> {
      // ao clicar: vai para aba Armários e filtra pelo número
      switchTab("lockers");
      if(el("lockerFilter")) el("lockerFilter").value = String(n);
      if(el("lockerStatus")) el("lockerStatus").value = "all";
      renderLockers();
      // destaca
      const card = Array.from(el("freeGrid").querySelectorAll(".free-item")).find(c=>c.querySelector("div")?.textContent===String(n));
      if(card){
        card.classList.add("flash");
        setTimeout(()=>card.classList.remove("flash"), 900);
      }
    });
    return div;
  };

  for(const n of risk) riskGrid.appendChild(makeCard(n, "risk"));
  for(const n of zero) zeroGrid.appendChild(makeCard(n, "zero"));

  // alerta automático (toast) quando houver 0 chaves disponíveis
  if(zero.length){
    const sig = zero.slice(0,8).join(",");
    if(state._zeroKeysSig !== sig){
      state._zeroKeysSig = sig;
      showToast(`🔔 Atenção: ${zero.length} armário(s) com 0 chaves disponíveis.`);
    }
  }else{
    state._zeroKeysSig = "";
  }
}

function buildLockerOptions(selected){
  const sel = el("fArmario");
  const used = getUsedLockers();
  const prev = selected != null ? Number(selected) : null;
  sel.innerHTML = "";
  const opt0 = document.createElement("option");
  opt0.value = "";
  opt0.textContent = "(sem armário)";
  sel.appendChild(opt0);

  for(let i=1;i<=state.totalLockers;i++){
    const inUse = used.has(i) && i !== prev;
    const opt = document.createElement("option");
    opt.value = String(i);
    const totalK = totalKeysForLocker(i);
    const inUseK = keysInUseForLocker(i);
    const availK = totalK - inUseK;
    opt.textContent = `${i} • ${lockerPosition(i)} • chaves ${Math.max(0,availK)}/${totalK}`;
    if(inUse){
      opt.disabled = true;
      opt.textContent += " (ocupado)";
    }
    if(prev === i) opt.selected = true;
    sel.appendChild(opt);
  }
}

function renderAll(){
  updateStats();
  renderEmployees();
  renderLockers();
  // mantém alertas/relatórios atualizados (se a aba existir)
  try{ renderRiskAndAlerts(); }catch{}
}

function renderHistory(){
  const body = el("histBody");
  if(!body) return;

  const q = normalize(el("histFilter")?.value || "");
  body.innerHTML = "";

  const rows = (state.historicoChaves || []).filter(h=>{
    if(!q) return true;
    const arm = h.armario == null ? "" : String(h.armario);
    return normalize(arm).includes(q)
      || normalize(h.cadastro).includes(q)
      || normalize(h.nome).includes(q)
      || normalize(h.tipo).includes(q)
      || normalize(h.obs).includes(q);
  });

  for(const h of rows){
    const tr = document.createElement("tr");
    const when = h.ts ? new Date(h.ts).toLocaleString("pt-BR") : "";
    tr.appendChild(tdText(when));
    tr.appendChild(tdText(h.tipo));
    tr.appendChild(tdText(h.armario == null ? "" : String(h.armario)));
    tr.appendChild(tdText(h.cadastro));
    tr.appendChild(tdText(h.nome));
    tr.appendChild(tdText(h.obs));
    body.appendChild(tr);
  }

  // Risco (1 chave)
  renderRiskAndAlerts();
}

// ===== Modal (Novo/Editar) =====
let editing = null; // employee original
function openModal(emp){
  editing = emp ? {...emp} : null;
  el("modalTitle").textContent = emp ? "Editar colaborador" : "Novo colaborador";

  el("fCadastro").value = emp?.cadastro ?? "";
  el("fCadastro").disabled = !!emp; // matrícula não muda

  el("fNome").value = emp?.nome ?? "";
  el("fAdmissao").value = emp?.admissao ?? "";
  el("fCargo").value = emp?.cargo ?? "";
  el("fChave").value = emp?.chaveEntregueEm ?? "";

  buildLockerOptions(emp?.armario ?? null);
  el("fArmario").value = emp?.armario ? String(emp.armario) : "";

  modal.showModal();
}

el("btnAdd").addEventListener("click", ()=> openModal(null));

el("btnSave").addEventListener("click", async (ev)=>{
  ev.preventDefault();

  const cadastro = String(el("fCadastro").value).trim();
  const nome = String(el("fNome").value).trim();
  if(!cadastro || !nome){
    showToast("Informe matrícula e nome.");
    return;
  }

  const admissao = el("fAdmissao").value || "";
  const cargo = String(el("fCargo").value).trim();
  const armarioRaw = el("fArmario").value;
  const armario = armarioRaw ? Number(armarioRaw) : null;
  const chave = el("fChave").value || null;

  const prevLocker = editing?.armario ?? null;

  // validação de chaves (se marcou entrega)
  if(armario != null && chave){
    const exclude = editing?.cadastro ?? null;
    const avail = keysAvailableForLocker(armario, exclude);
    if(avail <= 0){
      showToast(`Sem chave disponível para o armário ${armario}. Faça uma cópia antes ou aumente o total de chaves.`);
      return;
    }
  }

  const emp = { cadastro, nome, admissao, cargo, armario, chaveEntregueEm: chave };

  try{
    await writeEmployee(emp, prevLocker);

    // 📜 histórico de chaves (pegou/devolveu)
    const prevKey = editing?.chaveEntregueEm ?? null;
    const newKey = emp.chaveEntregueEm ?? null;

    if(emp.armario != null){
      if(!prevKey && newKey){
        await logHistoricoChave({ tipo: "PEGOU", armario: emp.armario, cadastro: emp.cadastro, nome: emp.nome, chaveEntregueEm: newKey });
      }else if(prevKey && !newKey){
        await logHistoricoChave({ tipo: "DEVOLVEU", armario: emp.armario, cadastro: emp.cadastro, nome: emp.nome, chaveEntregueEm: prevKey });
      }else if(prevKey && newKey && String(prevKey) !== String(newKey)){
        await logHistoricoChave({ tipo: "ATUALIZOU_DATA", armario: emp.armario, cadastro: emp.cadastro, nome: emp.nome, chaveEntregueEm: newKey });
      }
    }

    modal.close();
    showToast("Salvo em tempo real ✅");
  }catch(err){
    showToast(err?.message || String(err));
  }
});

el("searchInput").addEventListener("input", renderEmployees);
el("btnClearFilters").addEventListener("click", ()=>{
  el("searchInput").value = "";
  renderEmployees();
});
el("lockerFilter").addEventListener("input", renderLockers);
if(el("lockerStatus")) el("lockerStatus").addEventListener("change", renderLockers);

// ===== Locker position override (Cima/Baixo) =====
el("btnSavePos").addEventListener("click", async ()=>{
  const n = Number(el("posNumber").value);
  if(!Number.isFinite(n) || n < 1 || n > state.totalLockers){
    showToast("Número de armário inválido.");
    return;
  }
  const pos = el("posValue").value === "CIMA" ? "CIMA" : "BAIXO";
  try{
    await saveLockerPosition(n, pos);
    showToast(`Posição do armário ${n}: ${pos}`);
  }catch(err){
    showToast("Erro ao salvar posição: " + (err?.message || err));
  }
});

// ===== Chaves por armário (Total de cópias) =====
el("btnSaveKeys").addEventListener("click", async ()=>{
  const n = Number(el("keyNumber").value);
  const total = Number(el("keyTotal").value);
  if(!Number.isFinite(n) || n < 1 || n > state.totalLockers){
    showToast("Número de armário inválido.");
    return;
  }
  // permite 0 para representar "nenhuma chave física disponível" (ex.: chave perdida)
  if(!Number.isFinite(total) || total < 0 || total > 99){
    showToast("Total de chaves inválido (0-99).");
    return;
  }
  // não permite reduzir abaixo das chaves em uso
  const inUse = keysInUseForLocker(n);
  if(total < inUse){
    showToast(`Não dá: já existem ${inUse} chave(s) em uso neste armário.`);
    return;
  }
  try{
    await saveLockerKeys(n, Math.floor(total));
    showToast(`Armário ${n}: total de chaves = ${Math.floor(total)}`);
  }catch(err){
    showToast("Erro ao salvar chaves: " + (err?.message || err));
  }
});

// ===== Controle rápido de chaves (eventos) =====
function todayISO(){
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth()+1).padStart(2,"0");
  const dd = String(d.getDate()).padStart(2,"0");
  return `${yyyy}-${mm}-${dd}`;
}

function refreshKeyEvtEmpOptions(){
  const sel = el("keyEvtEmp");
  if(!sel) return;
  const current = sel.value;
  sel.innerHTML = "<option value=\"\">(selecione)</option>";
  const sorted = [...state.employees].sort((a,b)=> normalize(a.nome).localeCompare(normalize(b.nome)));
  for(const e of sorted){
    const opt = document.createElement("option");
    opt.value = String(e.cadastro);
    const arm = (e.armario != null && Number.isFinite(e.armario)) ? ` • Armário ${e.armario}` : "";
    opt.textContent = `${e.nome} (${e.cadastro})${arm}`;
    sel.appendChild(opt);
  }
  sel.value = current;
}

function clearKeyEvtForm(){
  if(el("keyEvtLocker")) el("keyEvtLocker").value = "";
  if(el("keyEvtType")) el("keyEvtType").value = "ENTREGOU";
  if(el("keyEvtEmp")) el("keyEvtEmp").value = "";
  if(el("keyEvtDate")) el("keyEvtDate").value = todayISO();
  if(el("keyEvtObs")) el("keyEvtObs").value = "";
}

async function handleKeyEvtSave(){
  const locker = Number(el("keyEvtLocker")?.value);
  const tipo = String(el("keyEvtType")?.value || "");
  const cadastro = String(el("keyEvtEmp")?.value || "");
  const date = String(el("keyEvtDate")?.value || "") || todayISO();
  const obs = String(el("keyEvtObs")?.value || "").trim();

  if(!Number.isFinite(locker) || locker < 1 || locker > state.totalLockers){
    showToast("Informe um número de armário válido.");
    return;
  }

  // ações que precisam de colaborador
  const needsEmp = (tipo === "ENTREGOU" || tipo === "DEVOLVEU" || tipo === "PERDEU");
  if(needsEmp && !cadastro){
    showToast("Selecione um colaborador.");
    return;
  }

  const emp = cadastro ? state.employees.find(e=> String(e.cadastro) === cadastro) : null;
  if(needsEmp && !emp){
    showToast("Colaborador não encontrado (recarregue a página)." );
    return;
  }

  // se for com colaborador, o armário precisa bater (evita bagunçar o índice)
  if(needsEmp && (emp.armario == null || Number(emp.armario) !== locker)){
    showToast("Esse colaborador não está com esse armário. Ajuste o armário do colaborador primeiro.");
    return;
  }

  const totalAntes = totalKeysForLocker(locker);
  let totalDepois = totalAntes;
  let deltaTotal = 0;

  try{
    if(tipo === "COPIA_FEITA"){
      totalDepois = Math.max(0, Math.floor(totalAntes) + 1);
      deltaTotal = totalDepois - totalAntes;
      await saveLockerKeys(locker, totalDepois);
      await logHistoricoChave({ tipo, armario: locker, cadastro: "", nome: "", chaveEntregueEm: null, obs, totalAntes, totalDepois, deltaTotal });
      showToast(`Armário ${locker}: cópia registrada (+1).`);
    }

    if(tipo === "ENTREGOU"){
      const hadKey = !!emp.chaveEntregueEm;
      if(!hadKey){
        const avail = keysAvailableForLocker(locker);
        if(avail <= 0){
          showToast("Sem chave reserva disponível para entregar. Registre uma cópia primeiro.");
          return;
        }
      }
      const updated = { ...emp, chaveEntregueEm: date };
      await writeEmployee(updated, updated.armario);
      await logHistoricoChave({
        tipo: hadKey ? "ENTREGOU (2ª via)" : "ENTREGOU",
        armario: locker,
        cadastro: updated.cadastro,
        nome: updated.nome,
        chaveEntregueEm: date,
        obs: obs || (hadKey ? "2ª via" : "")
      });
      showToast(`Chave entregue para ${updated.nome}.`);
    }

    if(tipo === "DEVOLVEU"){
      const updated = { ...emp, chaveEntregueEm: null };
      await writeEmployee(updated, updated.armario);
      await logHistoricoChave({ tipo: "DEVOLVEU", armario: locker, cadastro: updated.cadastro, nome: updated.nome, chaveEntregueEm: null, obs });
      showToast(`Chave devolvida por ${updated.nome}.`);
    }

    if(tipo === "PERDEU"){
      const hadKey = !!emp.chaveEntregueEm;
      const updated = { ...emp, chaveEntregueEm: null };
      // total de chaves diminui (chave física perdida)
      const inUseNow = keysInUseForLocker(locker);
      const inUseAfter = Math.max(0, inUseNow - (hadKey ? 1 : 0));
      totalDepois = Math.max(0, Math.floor(totalAntes) - 1);
      if(totalDepois < inUseAfter) totalDepois = inUseAfter;
      deltaTotal = totalDepois - totalAntes;

      await saveLockerKeys(locker, totalDepois);
      await writeEmployee(updated, updated.armario);
      await logHistoricoChave({
        tipo: "PERDEU",
        armario: locker,
        cadastro: updated.cadastro,
        nome: updated.nome,
        chaveEntregueEm: null,
        obs: obs || "chave perdida",
        totalAntes,
        totalDepois,
        deltaTotal
      });
      showToast(`Perda registrada: ${updated.nome}.`);
    }

    clearKeyEvtForm();
  }catch(err){
    showToast("Erro ao registrar evento: " + (err?.message || err));
  }
}

// liga os inputs do formulário (se existir)
if(el("keyEvtDate")) el("keyEvtDate").value = todayISO();
if(el("btnKeyEvtSave")) el("btnKeyEvtSave").addEventListener("click", (e)=>{ e.preventDefault(); handleKeyEvtSave(); });
if(el("btnKeyEvtClear")) el("btnKeyEvtClear").addEventListener("click", (e)=>{ e.preventDefault(); clearKeyEvtForm(); });

// filtro do histórico
if(el("histFilter")) el("histFilter").addEventListener("input", ()=> renderHistory());
if(el("btnClearHist")) el("btnClearHist").addEventListener("click", (e)=>{
  e.preventDefault();
  el("histFilter").value = "";
  renderHistory();
});

el("btnAddCopy").addEventListener("click", async ()=>{
  const n = Number(el("keyNumber").value);
  if(!Number.isFinite(n) || n < 1 || n > state.totalLockers){
    showToast("Informe o número do armário para adicionar cópia.");
    return;
  }
  const current = totalKeysForLocker(n);
  const next = Math.min(99, current + 1);
  try{
    await saveLockerKeys(n, next);
    el("keyTotal").value = next;
    showToast(`Cópia adicionada. Armário ${n}: total = ${next}`);
  }catch(err){
    showToast("Erro ao adicionar cópia: " + (err?.message || err));
  }
});


// ===== Importar / Exportar =====
function downloadFile(filename, content, mime){
  const blob = new Blob([content], { type: mime });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(()=>URL.revokeObjectURL(a.href), 5000);
}

el("btnExportJson").addEventListener("click", ()=>{
  const payload = {
    exportedAt: new Date().toISOString(),
    config: { totalLockers: state.totalLockers, defaultSplit: state.defaultSplit },
    lockerPositions: state.lockerPositions || {},
    lockerKeys: state.lockerKeys || {},
    employees: state.employees
  };
  downloadFile("armarios-backup.json", JSON.stringify(payload, null, 2), "application/json");
  showToast("Backup JSON gerado.");
});

function xmlEscape(s){
  return String(s ?? "").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;").replace(/'/g,"&apos;");
}

el("btnExportXml").addEventListener("click", ()=>{
  const rows = state.employees.slice().sort((a,b)=>normalize(a.nome).localeCompare(normalize(b.nome)));
  let xml = `<?xml version="1.0" encoding="UTF-8"?>\n<Colaboradores>\n`;
  for(const e of rows){
    xml += `  <Colaborador>\n`;
    xml += `    <Cadastro>${xmlEscape(e.cadastro)}</Cadastro>\n`;
    xml += `    <Nome>${xmlEscape(e.nome)}</Nome>\n`;
    xml += `    <Admissao>${xmlEscape(e.admissao)}</Admissao>\n`;
    xml += `    <Cargo>${xmlEscape(e.cargo)}</Cargo>\n`;
    xml += `    <NumeroDoArmario>${e.armario ?? ""}</NumeroDoArmario>\n`;
    xml += `    <ChaveEntregueEm>${xmlEscape(e.chaveEntregueEm ?? "")}</ChaveEntregueEm>\n`;
    xml += `  </Colaborador>\n`;
  }
  xml += `</Colaboradores>\n`;
  downloadFile("colaboradores.xml", xml, "application/xml");
  showToast("XML exportado.");
});

el("btnImportJson").addEventListener("click", async ()=>{
  const file = el("jsonFile").files?.[0];
  if(!file){ showToast("Selecione um JSON."); return; }
  try{
    const txt = await file.text();
    const data = JSON.parse(txt);
    const updates = {};

    if(data?.config?.totalLockers){
      updates["config/totalLockers"] = Math.floor(Number(data.config.totalLockers));
    }
    if(data?.config?.defaultSplit != null){
      updates["config/defaultSplit"] = Math.floor(Number(data.config.defaultSplit));
    }
    if(data?.lockerPositions && typeof data.lockerPositions === "object"){
      for(const [k,v] of Object.entries(data.lockerPositions)){
        updates[`lockerPositions/${k}`] = (v === "CIMA") ? "CIMA" : "BAIXO";
      }
    }

    if(data?.lockerKeys && typeof data.lockerKeys === "object"){
      for(const [k,v] of Object.entries(data.lockerKeys)){
        const n = Math.floor(Number(k));
        const total = Math.floor(Number(v));
        if(!Number.isFinite(n) || n < 1) continue;
        if(!Number.isFinite(total) || total < 1) continue;
        updates[`lockerKeys/${n}`] = total;
      }
    }

    if(Array.isArray(data?.employees)){
      for(const e of data.employees){
        const cadastro = String(e.cadastro ?? "").trim();
        if(!cadastro) continue;
        updates[`employees/${cadastro}`] = {
          cadastro,
          nome: e.nome ?? "",
          admissao: e.admissao ?? "",
          cargo: e.cargo ?? "",
          armario: (e.armario==null||e.armario==="") ? null : Number(e.armario),
          chaveEntregueEm: e.chaveEntregueEm ?? null,
          updatedAt: Date.now()
        };
      }
    }

    // Salva exatamente na pasta da loja logada
    await update(ref(db, basePath), updates);
    showToast("JSON importado para o Firebase ✅");
  }catch(err){
    showToast("Erro ao importar JSON: " + (err?.message || err));
  }
});

function guessTextContent(node, names){
  for(const nm of names){
    const el = node.getElementsByTagName(nm)[0];
    if(el && el.textContent != null) return el.textContent.trim();
  }
  return "";
}

el("btnImportXlsx")?.addEventListener("click", async () => {
    const file = el("xlsxFile").files?.[0];
    if (!file) { 
        showToast("Selecione um arquivo .xlsx primeiro."); 
        return; 
    }

    const reader = new FileReader();
    reader.onload = async (e) => {
        try {
            const data = new Uint8Array(e.target.result);
            const workbook = XLSX.read(data, { type: 'array' });
            const firstSheetName = workbook.SheetNames[0];
            const worksheet = workbook.Sheets[firstSheetName];
            
            // Converte para JSON
            const json = XLSX.utils.sheet_to_json(worksheet);
            
            // DEBUG: Isso vai mostrar no F12 > Console como o código está enxergando seu Excel
            console.log("Colunas encontradas no Excel:", Object.keys(json[0] || {}));
            console.log("Exemplo de linha:", json[0]);

            const updates = {};
            let count = 0;

// ... dentro do seu loop de importação
for (const row of json) {
  const cadastro = String(row['Cadastro'] ?? row['cadastro'] ?? row['Matricula'] ?? "").trim();
  if (!cadastro) continue;

  // CORREÇÃO: Remova o "employees/" daqui. Deixe apenas a variável 'cadastro'.
  updates[cadastro] = { 
    cadastro: cadastro,
    nome: row['Nome'] ?? row['nome'] ?? "",
    admissao: row['Admissao'] ?? row['admissao'] ?? "",
    cargo: row['Cargo'] ?? row['cargo'] ?? "",
    armario: null,
    chaveEntregueEm: null,
    updatedAt: Date.now()
  };
  count++;
}

// O caminho do ref continua o mesmo:
await update(ref(db, basePath + "/employees"), updates);

            if(count === 0) {
                showToast("Nenhum dado válido encontrado. Verifique os cabeçalhos.");
                return;
            }

            // O update aqui usa basePath/employees, garantindo que vai para a loja correta
            await update(ref(db, basePath + "/employees"), updates);
            
            showToast(`Sucesso! ${count} colaboradores importados.`);
        } catch (err) {
            console.error("Erro na importação:", err);
            showToast("Erro ao ler Excel: " + err.message);
        }
    };
    reader.readAsArrayBuffer(file);
});

// ===== Config =====
el("btnSaveTotal").addEventListener("click", async ()=>{
  const total = Math.floor(Number(el("totalInput").value));
  if(!Number.isFinite(total) || total < 1){
    showToast("Total inválido.");
    return;
  }
  try{
    await saveTotalLockers(total);
    showToast("Total salvo.");
  }catch(err){
    showToast("Erro ao salvar total: " + (err?.message || err));
  }
});

el("btnSaveSplit").addEventListener("click", async ()=>{
  const split = Math.floor(Number(el("splitInput").value));
  if(!Number.isFinite(split) || split < 0){
    showToast("Valor inválido.");
    return;
  }
  const padrao = (el("padraoAteInput")?.value === "CIMA") ? "CIMA" : "BAIXO";
  try{
    // mantém compatibilidade: defaultSplit + grava também (divisao/padraoAte)
    await Promise.all([
      saveDefaultSplit(split),
      set(ref(db, `${basePath}/config/divisao`), split),
      //saveDefaultPadraoAte(padrao)
    ]);
    showToast("Regra padrão salva.");
  }catch(err){
    showToast("Erro ao salvar regra: " + (err?.message || err));
  }
});

// ===== Copy free list =====
el("btnCopyFree").addEventListener("click", async ()=>{
  // copia os números atualmente visíveis na aba Armários
  const grid = el("freeGrid");
  const nums = Array.from(grid.querySelectorAll(".free-item > div:first-child")).map(d=>d.textContent).filter(Boolean);
  const txt = nums.join(", ");
  if(!txt){
    showToast("Nada para copiar.");
    return;
  }
  try{
    await navigator.clipboard.writeText(txt);
    showToast("Lista copiada.");
  }catch{
    downloadFile("armarios-visiveis.txt", txt);
    showToast("Baixei um .txt com a lista.");
  }
});

// ===== Boot =====
startRealtime();
renderAll();

// abrir diretamente /historicoChaves
try{
  if(String(location.pathname||"").toLowerCase().includes("historicochaves")){
    switchTab("history");
  }
}catch{}


// ===== INIT_MAINTENANCE_BLOCK_V1 =====
(function initMaintenanceUI(){
  try{
    const maintNumber = document.getElementById("maintNumber");
    const maintStatus = document.getElementById("maintStatus");
    const maintNote = document.getElementById("maintNote");
    const btnSaveMaint = document.getElementById("btnSaveMaint");
    const btnClearMaint = document.getElementById("btnClearMaint");
    const maintHint = document.getElementById("maintHint");
    if(!btnSaveMaint) return;

    const safeToast = (msg)=>{
      try{ if(typeof showToast === "function") showToast(msg); }catch(e){}
      try{ console.log("[maint]", msg); }catch(e){}
    };

    async function trySet(path, payload){
      return await set(ref(db, path), payload);
    }

    async function saveMaint(n, status, note){
      const payload = { status, note, updatedAt: Date.now() };
      try{
        await trySet(`${basePath}/config/lockerMaint/${n}`, payload);
        return { path:`${basePath}/config/lockerMaint/${n}` };
      }catch(e1){
        await trySet(`${basePath}/lockerMaint/${n}`, payload);
        return { path:`${basePath}/lockerMaint/${n}` };
      }
    }

    btnSaveMaint.addEventListener("click", async ()=>{
      const n = Number(maintNumber?.value);
      const max = Number(state.totalLockers || 0) || null;
      if(!Number.isFinite(n) || n < 1 || (max && n > max)){
        safeToast("Informe um número de armário válido.");
        return;
      }
      const status = String(maintStatus?.value || "OK");
      const note = String(maintNote?.value || "").trim();
      btnSaveMaint.disabled = true;
      try{
        const res = await saveMaint(n, status, note);
        safeToast(status === "MANUTENCAO" ? `Armário ${n} marcado para manutenção.` : `Armário ${n} OK.`);
        if(maintHint) maintHint.textContent = `Salvo em /${res.path}` + (note ? ` • ${note}` : "");
      }catch(err){
        console.error("Erro ao salvar manutenção:", err);
        safeToast("Erro ao salvar manutenção (ver console).");
      }finally{
        btnSaveMaint.disabled = false;
      }
    });

    btnClearMaint?.addEventListener("click", ()=>{
      if(maintNumber) maintNumber.value = "";
      if(maintStatus) maintStatus.value = "OK";
      if(maintNote) maintNote.value = "";
      if(maintHint) maintHint.textContent = "";
    });

    // escuta os dois caminhos (config primeiro)
    try{
      onValue(ref(db, basePath + "/config/lockerMaint"), (snap)=>{
        try{
          state.lockerMaint = snap.val() || {};
          if(typeof renderLockers === "function") renderLockers();
        }catch(e){}
      });
    }catch(e){}
    try{
      onValue(ref(db, basePath + "/lockerMaint"), (snap)=>{
        try{
          const v = snap.val() || {};
          state.lockerMaint = Object.assign({}, v, state.lockerMaint || {});
          if(typeof renderLockers === "function") renderLockers();
        }catch(e){}
      });
    }catch(e){}
  }catch(e){
    console.warn("initMaintenanceUI failed", e);
  }
})();
// ==========================================
// AUTOCOMPLETAR COLABORADOR PELO NÚMERO DO ARMÁRIO
// ==========================================
document.getElementById("keyEvtLocker")?.addEventListener("input", (e) => {
  const lockerNum = Number(e.target.value);
  const selectEmp = document.getElementById("keyEvtEmp");

  if (!selectEmp) return;

  // Se o campo do armário for limpo, volta o select para o padrão
  if (!e.target.value) {
    selectEmp.value = "";
    return;
  }

  // Procura na lista de funcionários quem está com esse armário ativo
  const donoDoArmario = state.employees.find(emp => Number(emp.armario) === lockerNum);

  if (donoDoArmario) {
    // Se achou, seleciona o colaborador usando a matrícula (cadastro) dele como chave
    selectEmp.value = donoDoArmario.cadastro;
  } else {
    // Se digitou um número e ninguém usa esse armário, deixa em branco para você selecionar manualmente
    selectEmp.value = "";
  }
});