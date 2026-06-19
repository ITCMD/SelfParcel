import type { FastifyInstance } from 'fastify';
import { requireAdmin } from '../auth/routes.js';
import { validateModule } from '../carriers/moduleSchema.js';
import { inspectModule } from '../carriers/engine.js';
import { reloadModules } from '../carriers/registry.js';
import {
  countPackagesForCarrier,
  deleteModule,
  getModule,
  listModules,
  resetBuiltinModule,
  setModuleEnabled,
  upsertModule,
} from '../db/modules.js';
import { assertPublicUrl, safeRequest, SsrfError } from '../net/safeFetch.js';

const MAX_MODULE_BYTES = 256_000;

function publicRow(m: ReturnType<typeof getModule>) {
  if (!m) return null;
  return {
    code: m.code,
    name: m.name,
    kind: m.module.kind,
    enabled: Boolean(m.enabled),
    builtin: Boolean(m.builtin),
    sourceUrl: m.source_url,
    fetchedAt: m.fetched_at,
    updatedAt: m.updated_at,
  };
}

export async function registerModuleRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/admin/modules', { preHandler: requireAdmin }, async () => ({
    modules: listModules().map(publicRow),
  }));

  app.get<{ Params: { code: string } }>(
    '/api/admin/modules/:code',
    { preHandler: requireAdmin },
    async (req, reply) => {
      const m = getModule(req.params.code);
      if (!m) return reply.code(404).send({ error: 'Module not found' });
      return { ...publicRow(m), module: m.module };
    },
  );

  // Install from pasted JSON (creates a new custom module).
  app.post<{ Body: { module?: unknown } }>(
    '/api/admin/modules',
    { preHandler: requireAdmin },
    async (req, reply) => {
      const result = validateModule(req.body?.module);
      if (!result.ok) return reply.code(400).send({ error: 'Invalid module', errors: result.errors });
      if (getModule(result.module!.code)) {
        return reply.code(409).send({ error: `A module with code "${result.module!.code}" already exists` });
      }
      upsertModule({ module: result.module!, enabled: true, builtin: false });
      reloadModules();
      return reply.code(201).send(publicRow(getModule(result.module!.code)));
    },
  );

  // Edit an existing module. Keeps the builtin/enabled flags as they were.
  app.put<{ Params: { code: string }; Body: { module?: unknown } }>(
    '/api/admin/modules/:code',
    { preHandler: requireAdmin },
    async (req, reply) => {
      const existing = getModule(req.params.code);
      if (!existing) return reply.code(404).send({ error: 'Module not found' });
      const result = validateModule(req.body?.module, { allowCode: req.params.code });
      if (!result.ok) return reply.code(400).send({ error: 'Invalid module', errors: result.errors });
      if (result.module!.code !== req.params.code) {
        return reply.code(400).send({ error: 'Module code cannot be changed' });
      }
      upsertModule({
        module: result.module!,
        enabled: Boolean(existing.enabled),
        builtin: Boolean(existing.builtin),
        seedVersion: existing.seed_version,
        sourceUrl: existing.source_url,
        fetchedAt: existing.fetched_at,
      });
      reloadModules();
      return publicRow(getModule(req.params.code));
    },
  );

  // Install from a URL (e.g. GitHub raw). SSRF-guarded, and stored disabled so
  // the admin reviews it before enabling.
  app.post<{ Body: { url?: string } }>(
    '/api/admin/modules/install-url',
    { preHandler: requireAdmin },
    async (req, reply) => {
      const url = (req.body?.url ?? '').trim();
      if (!url) return reply.code(400).send({ error: 'url is required' });
      let res;
      try {
        res = await safeRequest(url, { requireHttps: true, maxBytes: MAX_MODULE_BYTES, timeoutMs: 15_000 });
      } catch (err) {
        const msg = err instanceof SsrfError ? err.message : 'Could not fetch the module URL';
        return reply.code(400).send({ error: msg });
      }
      if (res.statusCode !== 200) {
        return reply.code(400).send({ error: `Module URL returned HTTP ${res.statusCode}` });
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(res.body);
      } catch {
        return reply.code(400).send({ error: 'Module URL did not return valid JSON' });
      }
      const result = validateModule(parsed);
      if (!result.ok) return reply.code(400).send({ error: 'Invalid module', errors: result.errors });
      const existing = getModule(result.module!.code);
      if (existing?.builtin) {
        return reply.code(409).send({ error: `Code "${result.module!.code}" is a built-in; reset it instead` });
      }
      upsertModule({
        module: result.module!,
        enabled: false, // stays off until reviewed
        builtin: false,
        sourceUrl: res.finalUrl,
        fetchedAt: new Date().toISOString(),
      });
      reloadModules();
      return reply.code(201).send({ ...publicRow(getModule(result.module!.code)), preview: result.module });
    },
  );

  // Validate only (paste JSON or fetch a URL). Returns a preview, stores nothing.
  app.post<{ Body: { module?: unknown; url?: string } }>(
    '/api/admin/modules/validate',
    { preHandler: requireAdmin },
    async (req, reply) => {
      let candidate = req.body?.module;
      if (req.body?.url) {
        try {
          const res = await safeRequest(req.body.url.trim(), {
            requireHttps: true,
            maxBytes: MAX_MODULE_BYTES,
          });
          candidate = JSON.parse(res.body);
        } catch (err) {
          const msg = err instanceof SsrfError ? err.message : 'Could not fetch/parse the URL';
          return reply.code(400).send({ ok: false, errors: [msg] });
        }
      }
      const result = validateModule(candidate);
      return { ok: result.ok, errors: result.errors, module: result.module ?? null };
    },
  );

  app.post<{ Params: { code: string }; Body: { enabled?: boolean } }>(
    '/api/admin/modules/:code/enable',
    { preHandler: requireAdmin },
    async (req, reply) => {
      if (!getModule(req.params.code)) return reply.code(404).send({ error: 'Module not found' });
      setModuleEnabled(req.params.code, Boolean(req.body?.enabled));
      reloadModules();
      return publicRow(getModule(req.params.code));
    },
  );

  app.post<{ Params: { code: string } }>(
    '/api/admin/modules/:code/reset',
    { preHandler: requireAdmin },
    async (req, reply) => {
      if (!resetBuiltinModule(req.params.code)) {
        return reply.code(400).send({ error: 'Only built-in modules can be reset' });
      }
      reloadModules();
      return publicRow(getModule(req.params.code));
    },
  );

  app.delete<{ Params: { code: string } }>(
    '/api/admin/modules/:code',
    { preHandler: requireAdmin },
    async (req, reply) => {
      const m = getModule(req.params.code);
      if (!m) return reply.code(404).send({ error: 'Module not found' });
      if (m.builtin) {
        return reply
          .code(400)
          .send({ error: 'Built-in modules cannot be deleted; disable or reset instead' });
      }
      const inUse = countPackagesForCarrier(req.params.code);
      if (inUse > 0) {
        return reply
          .code(409)
          .send({ error: `${inUse} package(s) still use this carrier; remove them first` });
      }
      deleteModule(req.params.code);
      reloadModules();
      return { ok: true };
    },
  );

  // Test a module against a real tracking number (works even while disabled).
  // Returns diagnostics (HTTP status, page title, snippet) so selector problems
  // and bot blocks can be told apart.
  app.post<{ Params: { code: string }; Body: { trackingNumber?: string } }>(
    '/api/admin/modules/:code/test',
    { preHandler: requireAdmin },
    async (req, reply) => {
      const m = getModule(req.params.code);
      if (!m) return reply.code(404).send({ error: 'Module not found' });
      const tn = (req.body?.trackingNumber ?? '').trim();
      if (!tn) return reply.code(400).send({ error: 'trackingNumber is required' });
      const debug = await inspectModule(m.module, tn);
      return { debug };
    },
  );
}
