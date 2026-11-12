import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { randomUUID, createHash } from 'node:crypto';

export async function startPortal(options = {}) {
  const state = JSON.parse(await readFile('fixtures/state.json', 'utf8'));
  const sessions = new Map();
  const audit = [];
  const json = (response, value, status = 200) => {
    response.writeHead(status, { 'content-type': 'application/json' });
    response.end(JSON.stringify(value));
  };
  const server = http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url, 'http://localhost');
      const buffers = [];
      for await (const part of request) buffers.push(part);
      const raw = Buffer.concat(buffers);
      const body = raw.length ? JSON.parse(raw) : {};
      const token = /session=([^;]+)/.exec(request.headers.cookie || '')?.[1];
      const identity = sessions.get(token);
      if (request.method === 'POST' && url.pathname === '/api/control') {
        Object.assign(state, body);
        return json(response, { ok: true });
      }
      if (url.pathname === '/api/state') return json(response, { ...state, identity, audit });
      if (url.pathname === '/api/search') {
        const query = url.searchParams.get('q') || '';
        const delay = state.searchDelay?.[query] || 0;
        if (delay) await new Promise(resolve => setTimeout(resolve, delay));
        return json(response, { query, generation: state.generation, candidates: state.suppliers.filter(value =>
          value.name.includes(query) || value.taxId.includes(query)) });
      }
      if (url.pathname === '/api/branches') {
        const subject = url.searchParams.get('subject');
        return json(response, { subject, values: state.branches[subject] || [] });
      }
      if (url.pathname === '/api/selection' && request.method === 'POST') {
        if (!(state.branches[body.subject] || []).some(value => value.id === body.branch)) {
          return json(response, { error: '主体与分支不匹配' }, 409);
        }
        state.selection = body;
        audit.push({ action: 'selection', value: body });
        return json(response, body);
      }
      const allowed = { '/': ['portal.html','text/html; charset=utf-8'], '/client.js': ['client.js','text/javascript'],
        '/service-worker.js': ['service-worker.js','text/javascript'] };
      if (allowed[url.pathname]) {
        const [name,type] = allowed[url.pathname];
        response.setHeader('content-type',type); response.setHeader('cache-control','no-cache');
        return response.end(await readFile(`fixtures/portal/${name}`));
      }
      json(response, { error: '没有这个入口' }, 404);
    } catch (error) { json(response, { error: error.message }, 500); }
  });
  await new Promise(resolve => server.listen(options.port ?? 0, options.host ?? '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${server.address().port}`, state,
    close: () => new Promise(resolve => server.close(resolve)) };
}

if (process.argv[1]?.endsWith('/portal.js')) {
  const portIndex = process.argv.indexOf('--port');
  const port = Number(portIndex >= 0 ? process.argv[portIndex + 1] : process.env.PORT || 4173);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('端口无效');
  const portal = await startPortal({ port });
  console.log(`本地门户：${portal.url}`);
}
