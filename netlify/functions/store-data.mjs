// netlify/functions/store-data.mjs
//
// Catálogo da Loja Vecorion (store/categories/products/banners) em Netlify Blobs.
//   GET  /api/store-data -> { version, updatedAt, data }      (público: a loja usa isso)
//   POST /api/store-data -> grava { expectedVersion, data }   (protegido por token, se configurado)
//
// Concorrência: a gravação só acontece se (1) o cliente estava na versão atual e
// (2) ninguém gravou entre a leitura e a escrita — garantido de forma atômica pelo
// etag do Blobs (onlyIfMatch / onlyIfNew). Caso contrário devolve 409 com os dados
// mais recentes, em vez de sobrescrever em silêncio.
//
// Se a variável de ambiente ADMIN_API_TOKEN existir, toda gravação exige o mesmo
// valor no cabeçalho X-Admin-Token. Sem ela, a gravação fica aberta a quem tiver a URL.

import { getStore } from '@netlify/blobs';
import { createHash, timingSafeEqual } from 'node:crypto';

const STORE_NAME = 'vecorion-store';
const CATALOG_KEY = 'catalog';
const MAX_BODY_BYTES = 2 * 1024 * 1024;

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Token',
};

function json(body, status) {
  return new Response(JSON.stringify(body), {
    status: status || 200,
    headers: Object.assign({ 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }, CORS_HEADERS),
  });
}

function emptyDoc() {
  return { version: 0, updatedAt: null, data: null };
}

function sha(s) {
  return createHash('sha256').update(String(s)).digest();
}

export default async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  let store;
  try {
    store = getStore({ name: STORE_NAME, consistency: 'strong' });
  } catch (err) {
    // ocorre, por exemplo, se a function rodar fora do ambiente do Netlify
    return json({ error: 'Armazenamento indisponível: ' + err.message }, 500);
  }

  if (req.method === 'GET') {
    let doc;
    try {
      doc = await store.get(CATALOG_KEY, { type: 'json' });
    } catch (err) {
      return json({ error: 'Falha ao ler o armazenamento: ' + err.message }, 500);
    }
    return json(doc || emptyDoc());
  }

  if (req.method === 'POST' || req.method === 'PUT') {
    const requiredToken = Netlify.env.get('ADMIN_API_TOKEN');
    if (requiredToken) {
      const sentToken = req.headers.get('x-admin-token') || '';
      if (!timingSafeEqual(sha(sentToken), sha(requiredToken))) {
        return json({ error: 'Não autorizado. Verifique a chave de sincronização configurada no painel.' }, 401);
      }
    }

    let body;
    try {
      const raw = await req.text();
      if (raw.length > MAX_BODY_BYTES) return json({ error: 'Catálogo grande demais.' }, 413);
      body = JSON.parse(raw);
    } catch (err) {
      return json({ error: 'JSON inválido no corpo da requisição.' }, 400);
    }

    if (!body || typeof body.data === 'undefined' || body.data === null) {
      return json({ error: 'Corpo inválido — esperado { expectedVersion, data }.' }, 400);
    }

    let existing;
    try {
      existing = await store.getWithMetadata(CATALOG_KEY, { type: 'json' });
    } catch (err) {
      return json({ error: 'Falha ao ler o armazenamento: ' + err.message }, 500);
    }
    const current = existing && existing.data ? existing.data : emptyDoc();

    const expectedVersion = typeof body.expectedVersion === 'number' ? body.expectedVersion : current.version;
    if (expectedVersion !== current.version) {
      return json({ error: 'Conflito de versão — os dados foram alterados por outro dispositivo.', current: current }, 409);
    }

    const updated = {
      version: current.version + 1,
      updatedAt: new Date().toISOString(),
      data: body.data,
    };

    let result;
    try {
      result = await store.setJSON(CATALOG_KEY, updated, existing ? { onlyIfMatch: existing.etag } : { onlyIfNew: true });
    } catch (err) {
      return json({ error: 'Falha ao salvar no armazenamento: ' + err.message }, 500);
    }

    if (!result.modified) {
      // alguém gravou entre a leitura e a escrita: devolve o estado real para o cliente se atualizar
      let latest;
      try { latest = await store.get(CATALOG_KEY, { type: 'json' }); } catch (e) { latest = null; }
      return json({ error: 'Conflito de versão — os dados foram alterados por outro dispositivo.', current: latest || emptyDoc() }, 409);
    }

    return json(updated, 200);
  }

  return json({ error: 'Método não suportado.' }, 405);
};

export const config = { path: '/api/store-data' };
