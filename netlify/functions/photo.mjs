// netlify/functions/photo.mjs
//
// Fotos da Loja Vecorion (produtos, categorias, banners, logo) guardadas como
// arquivos binários no Netlify Blobs — numa loja própria, separada do catálogo
// (vecorion-store) e dos pedidos (vecorion-orders). Isso evita que fotos
// infladas o documento do catálogo (que é baixado inteiro a cada visita).
//
//   GET    /api/photo/:escopo/:donoId/:fotoId/:tamanho   público (a loja usa isso)
//   POST   /api/photo/:escopo/:donoId/:fotoId/:tamanho   protegido por token
//   DELETE /api/photo/:escopo/:donoId/:fotoId            protegido por token
//
// :escopo  = produto | categoria | banner | loja
// :tamanho = f (foto cheia, o app manda redimensionada a ~1600px) | t (miniatura, ~480px)
//
// O front-end já redimensiona e comprime a imagem (canvas -> WebP) antes de
// enviar, então este endpoint só valida tipo/tamanho e guarda os bytes.

import { getStore } from '@netlify/blobs';
import { createHash, timingSafeEqual } from 'node:crypto';

const PHOTOS_STORE = 'vecorion-photos';
const SCOPES = ['produto', 'categoria', 'banner', 'loja'];
const SIZES = ['f', 't'];
const MAX_BYTES = 4 * 1024 * 1024;
const ID_RE = /^[A-Za-z0-9_-]{1,80}$/;
const CONTENT_TYPES = ['image/webp', 'image/jpeg', 'image/png'];

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Token',
};

function json(body, status) {
  return new Response(JSON.stringify(body), { status: status || 200, headers: Object.assign({ 'Content-Type': 'application/json' }, CORS) });
}

function sha(s) { return createHash('sha256').update(String(s)).digest(); }

function authorized(req) {
  const required = Netlify.env.get('ADMIN_API_TOKEN');
  if (!required) return true; // mesma política do resto da loja: sem a variável, fica aberto (documentado no LEIA-ME)
  const sent = req.headers.get('x-admin-token') || '';
  return timingSafeEqual(sha(sent), sha(required));
}

export default async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

  const url = new URL(req.url);
  const parts = url.pathname.replace(/\/+$/, '').split('/').filter(Boolean); // ['api','photo',escopo,donoId,fotoId,tamanho?]
  const scope = parts[2], ownerId = parts[3], photoId = parts[4], size = parts[5];

  if (!SCOPES.includes(scope) || !ID_RE.test(ownerId || '') || !ID_RE.test(photoId || '')) {
    return json({ error: 'Caminho de foto inválido.' }, 400);
  }

  let store;
  try {
    store = getStore({ name: PHOTOS_STORE, consistency: 'strong' });
  } catch (err) {
    return json({ error: 'Armazenamento indisponível: ' + err.message }, 500);
  }

  if (req.method === 'GET') {
    if (!SIZES.includes(size)) return json({ error: 'Tamanho inválido.' }, 400);
    const key = scope + '/' + ownerId + '/' + photoId + '/' + size;
    let res;
    try {
      res = await store.getWithMetadata(key, { type: 'arrayBuffer' });
    } catch (err) {
      return json({ error: 'Falha ao ler a foto: ' + err.message }, 500);
    }
    if (!res || !res.data) return json({ error: 'Foto não encontrada.' }, 404);
    const contentType = (res.metadata && res.metadata.contentType) || 'application/octet-stream';
    return new Response(res.data, {
      status: 200,
      headers: Object.assign({ 'Content-Type': contentType, 'Cache-Control': 'public, max-age=31536000, immutable' }, CORS),
    });
  }

  if (req.method === 'POST') {
    if (!authorized(req)) return json({ error: 'Não autorizado. Verifique a chave de sincronização configurada no painel.' }, 401);
    if (!SIZES.includes(size)) return json({ error: 'Tamanho inválido.' }, 400);
    const contentType = (req.headers.get('content-type') || '').split(';')[0].trim();
    if (!CONTENT_TYPES.includes(contentType)) return json({ error: 'Use uma imagem JPG, PNG ou WebP.' }, 415);

    let buf;
    try {
      buf = await req.arrayBuffer();
    } catch (err) {
      return json({ error: 'Corpo da requisição inválido.' }, 400);
    }
    if (!buf.byteLength) return json({ error: 'Imagem vazia.' }, 400);
    if (buf.byteLength > MAX_BYTES) return json({ error: 'Imagem grande demais (máximo 4MB depois de comprimida).' }, 413);

    const key = scope + '/' + ownerId + '/' + photoId + '/' + size;
    try {
      await store.set(key, buf, { metadata: { contentType } });
    } catch (err) {
      return json({ error: 'Falha ao salvar a foto: ' + err.message }, 500);
    }
    return json({ ok: true }, 201);
  }

  if (req.method === 'DELETE') {
    if (!authorized(req)) return json({ error: 'Não autorizado. Verifique a chave de sincronização configurada no painel.' }, 401);
    try {
      await Promise.all(SIZES.map((s) => store.delete(scope + '/' + ownerId + '/' + photoId + '/' + s).catch(() => {})));
    } catch (err) {
      return json({ error: 'Falha ao excluir a foto: ' + err.message }, 500);
    }
    return json({ ok: true });
  }

  return json({ error: 'Método não suportado.' }, 405);
};

export const config = { path: '/api/photo/*' };
