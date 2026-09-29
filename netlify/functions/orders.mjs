// netlify/functions/orders.mjs
//
// Pedidos da Loja Vecorion guardados em Netlify Blobs (loja "vecorion-orders").
//
//   POST  /api/orders              PÚBLICO  — o cliente registra o pedido ao finalizar
//   GET   /api/orders              ADMIN    — lista os pedidos (mais recentes primeiro)
//   POST  /api/orders/:id/status   ADMIN    — muda o status  { status }
//
// "ADMIN" = cabeçalho X-Admin-Token igual à variável de ambiente ADMIN_API_TOKEN.
// Pedidos têm nome, telefone e endereço de clientes (dados pessoais): por isso a
// leitura e a alteração NUNCA ficam abertas. Se ADMIN_API_TOKEN não estiver
// configurada, GET e mudança de status respondem 403; só a criação continua
// funcionando (o cliente ainda envia o pedido pelo WhatsApp normalmente).
//
// O total e os preços são conferidos no servidor com o catálogo atual, então um
// cliente mal-intencionado não consegue registrar um pedido com preço adulterado.

import { getStore } from '@netlify/blobs';
import { createHash, timingSafeEqual } from 'node:crypto';

const ORDERS_STORE = 'vecorion-orders';
const CATALOG_STORE = 'vecorion-store';
const CATALOG_KEY = 'catalog';
const STATUSES = ['novo', 'aguardando_pagamento', 'pagamento_confirmado', 'em_preparacao', 'enviado', 'concluido', 'cancelado'];
const MAX_BODY_BYTES = 20000;
const MAX_ITEMS = 50;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Token',
};

function json(body, status) {
  return new Response(JSON.stringify(body), {
    status: status || 200,
    headers: Object.assign({ 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }, CORS),
  });
}

function sha(s) {
  return createHash('sha256').update(String(s)).digest();
}

// 'ok' | 'sem-token-configurado' | 'negado'
function checkAdmin(req) {
  const required = Netlify.env.get('ADMIN_API_TOKEN');
  if (!required) return 'sem-token-configurado';
  const sent = req.headers.get('x-admin-token') || '';
  return timingSafeEqual(sha(sent), sha(required)) ? 'ok' : 'negado';
}

function adminGate(req) {
  const r = checkAdmin(req);
  if (r === 'ok') return null;
  if (r === 'sem-token-configurado') {
    return json({ error: 'Configure a variável ADMIN_API_TOKEN no Netlify para ver e gerenciar pedidos online.', code: 'no-token' }, 403);
  }
  return json({ error: 'Não autorizado. Verifique a chave de sincronização configurada no painel.', code: 'bad-token' }, 401);
}

function str(v, max) {
  return String(v == null ? '' : v).replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, max);
}

function todayCompactBRT() {
  const d = new Date(Date.now() - 3 * 60 * 60 * 1000); // horário de Brasília (UTC-3)
  return d.getUTCFullYear() + String(d.getUTCMonth() + 1).padStart(2, '0') + String(d.getUTCDate()).padStart(2, '0');
}

function effectivePrice(p) {
  const promo = Number(p.precoPromocional);
  const base = Number(p.preco);
  return promo > 0 && promo < base ? promo : base;
}

async function loadCatalogProducts() {
  try {
    const doc = await getStore({ name: CATALOG_STORE, consistency: 'strong' }).get(CATALOG_KEY, { type: 'json' });
    return (doc && doc.data && Array.isArray(doc.data.products)) ? doc.data.products : [];
  } catch (e) {
    return [];
  }
}

// devolve { order } ou { error }
async function buildOrder(body) {
  const nome = str(body.cliente && body.cliente.nome, 120);
  const whatsapp = str(body.cliente && body.cliente.whatsapp, 30);
  if (!nome) return { error: 'Informe o nome do cliente.' };
  if (whatsapp.replace(/\D/g, '').length < 10) return { error: 'Informe um WhatsApp válido com DDD.' };

  const e = body.entrega || {};
  const entrega = {
    cep: str(e.cep, 12), estado: str(e.estado, 40), cidade: str(e.cidade, 80), bairro: str(e.bairro, 80),
    rua: str(e.rua, 120), numero: str(e.numero, 20), complemento: str(e.complemento, 80),
  };
  for (const k of ['cep', 'estado', 'cidade', 'bairro', 'rua', 'numero']) {
    if (!entrega[k]) return { error: 'Endereço de entrega incompleto.' };
  }

  if (!Array.isArray(body.itens) || body.itens.length < 1 || body.itens.length > MAX_ITEMS) {
    return { error: 'O pedido precisa ter entre 1 e ' + MAX_ITEMS + ' itens.' };
  }
  const products = await loadCatalogProducts();
  const itens = [];
  let total = 0;
  for (const it of body.itens) {
    const qty = Math.floor(Number(it && it.qty));
    if (!(qty >= 1 && qty <= 99)) return { error: 'Quantidade inválida em um dos itens.' };
    const found = it.productId ? products.find((p) => p.id === it.productId) : null;
    let nomeItem = str(it.nome, 160);
    let preco = Number(it.preco);
    if (found) {
      if (found.disponivel === false) return { error: 'O produto "' + str(found.nome, 80) + '" está esgotado.' };
      nomeItem = str(found.nome, 160);
      preco = effectivePrice(found); // preço sempre do catálogo
    }
    if (!nomeItem || !(preco >= 0) || preco > 1000000) return { error: 'Item inválido no pedido.' };
    const variacao = {};
    if (it.variacao && typeof it.variacao === 'object') {
      Object.keys(it.variacao).slice(0, 10).forEach((k) => { variacao[str(k, 40)] = str(it.variacao[k], 60); });
    }
    itens.push({ productId: found ? found.id : null, nome: nomeItem, preco: Math.round(preco * 100) / 100, qty, variacao });
    total += Math.round(preco * 100) * qty;
  }

  return {
    order: {
      cliente: { nome, whatsapp },
      entrega,
      itens,
      total: total / 100,
      status: 'novo',
      criadoEm: Date.now(),
      historico: [{ status: 'novo', em: new Date().toISOString() }],
    },
  };
}

async function createOrder(store, order) {
  const day = todayCompactBRT();
  const prefix = 'order/VEC-' + day + '-';
  let count = 0;
  for await (const page of store.list({ prefix, paginate: true })) count += page.blobs.length;
  for (let attempt = 0; attempt < 15; attempt++) {
    const id = 'VEC-' + day + '-' + String(count + 1 + attempt).padStart(3, '0');
    order.id = id;
    const res = await store.setJSON('order/' + id, order, { onlyIfNew: true });
    if (res.modified) return order;
  }
  throw new Error('Não foi possível gerar um identificador único para o pedido.');
}

async function listOrders(store) {
  const keys = [];
  for await (const page of store.list({ prefix: 'order/', paginate: true })) {
    page.blobs.forEach((b) => keys.push(b.key));
  }
  keys.sort().reverse();
  const recent = keys.slice(0, 500);
  const docs = await Promise.all(recent.map((k) => store.get(k, { type: 'json' })));
  return docs.filter(Boolean).sort((a, b) => (b.criadoEm || 0) - (a.criadoEm || 0));
}

async function updateStatus(store, id, status) {
  if (!STATUSES.includes(status)) return json({ error: 'Status inválido.' }, 400);
  for (let attempt = 0; attempt < 5; attempt++) {
    const cur = await store.getWithMetadata('order/' + id, { type: 'json' });
    if (!cur || !cur.data) return json({ error: 'Pedido não encontrado.' }, 404);
    const order = cur.data;
    order.status = status;
    order.historico = (order.historico || []).concat([{ status, em: new Date().toISOString() }]).slice(-30);
    const res = await store.setJSON('order/' + id, order, { onlyIfMatch: cur.etag });
    if (res.modified) return json(order);
  }
  return json({ error: 'Pedido alterado por outro dispositivo. Tente novamente.' }, 409);
}

export default async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

  let store;
  try {
    store = getStore({ name: ORDERS_STORE, consistency: 'strong' });
  } catch (err) {
    return json({ error: 'Armazenamento indisponível: ' + err.message }, 500);
  }

  const url = new URL(req.url);
  const parts = url.pathname.replace(/\/+$/, '').split('/').filter(Boolean); // ['api','orders',...]
  const rest = parts.slice(2);

  try {
    if (rest.length === 0 && req.method === 'POST') {
      const raw = await req.text();
      if (raw.length > MAX_BODY_BYTES) return json({ error: 'Pedido grande demais.' }, 413);
      let body;
      try { body = JSON.parse(raw); } catch (e) { return json({ error: 'JSON inválido.' }, 400); }
      const built = await buildOrder(body || {});
      if (built.error) return json({ error: built.error }, 400);
      const saved = await createOrder(store, built.order);
      return json(saved, 201);
    }

    if (rest.length === 0 && req.method === 'GET') {
      const denied = adminGate(req);
      if (denied) return denied;
      return json({ orders: await listOrders(store) });
    }

    if (rest.length === 2 && rest[1] === 'status' && req.method === 'POST') {
      const denied = adminGate(req);
      if (denied) return denied;
      let body;
      try { body = await req.json(); } catch (e) { return json({ error: 'JSON inválido.' }, 400); }
      return await updateStatus(store, decodeURIComponent(rest[0]), body && body.status);
    }
  } catch (err) {
    return json({ error: 'Erro interno: ' + err.message }, 500);
  }

  return json({ error: 'Rota não encontrada.' }, 404);
};

export const config = { path: ['/api/orders', '/api/orders/*'] };
