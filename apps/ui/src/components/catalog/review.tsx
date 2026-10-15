import { ApiError } from '@kramahq/sdk';
import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, GitBranch, ShieldCheck } from 'lucide-react';
import {
  applyPreview,
  previewSource,
  useRefreshLibrary,
  type CatalogKind,
  type ReviewResult,
  type SourceDraft,
} from '@/api/catalog';
import { useMe } from '@/api/queries';
import { Badge, Button, Card, Fact } from '@/components/ui/primitives';
import { TeamPanel } from '@/components/team-panel';
import { Permissions } from './permissions';

export const fieldClass = 'h-9 w-full rounded-lg border border-line2 bg-raised px-2.5 text-sm';
const initialDraft: SourceDraft = { url: '', ref: 'HEAD', path: '', id: '', secrets: {} };
export function GitReview({
  kind,
  initial,
  updateId,
  onDone,
  onCancel,
}: {
  kind: CatalogKind;
  initial?: Partial<SourceDraft>;
  updateId?: string;
  onDone: (id: string) => void;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState<SourceDraft>({ ...initialDraft, ...initial });
  const [bindings, setBindings] = useState(() =>
    Object.entries(initial?.secrets ?? {}).map(([name, ref]) => ({ name, ref })),
  );
  const [result, setResult] = useState<ReviewResult>();
  const [granted, setGranted] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [conflict, setConflict] = useState(false);
  const [now, setNow] = useState(Date.now);
  const request = useRef<AbortController | undefined>(undefined);
  const refresh = useRefreshLibrary();
  const me = useMe();
  const canInstall = me.data?.roles.some((r) => r === 'admin' || r === 'owner') ?? false;
  const canPreview =
    me.data?.roles.some((r) => ['admin', 'owner', 'operator', 'author'].includes(r)) ?? false;
  useEffect(() => () => request.current?.abort(), []);
  useEffect(() => {
    if (!result) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [result]);
  const secrets: Record<string, string> = {};
  let bindingError = '';
  for (const row of bindings) {
    if (!row.name.trim() && !row.ref.trim()) continue;
    const name = row.name.trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || !row.ref.trim())
      bindingError = 'Each binding needs a variable name and a secret reference.';
    if (name in secrets) bindingError = 'Each variable can only be bound once.';
    secrets[name] = row.ref.trim();
  }
  const preview = result?.preview;
  const expired = !!preview && Date.parse(preview.expiresAt) <= now;
  const invalid =
    preview?.issues.some((i) => i.severity === 'error') ||
    (result?.kind === 'pack' && !result.preview.engineCompatible) ||
    (result?.kind === 'agent' && !result.preview.definition);
  const answered = !!preview && preview.permissions.every((p) => granted.includes(p.id));
  async function inspect() {
    if (bindingError || !canPreview) return;
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setBusy(true);
    setError('');
    setConflict(false);
    setGranted([]);
    setResult(undefined);
    try {
      const value = await previewSource(kind, { ...draft, secrets }, updateId, controller.signal);
      if (!controller.signal.aborted) {
        setResult(value);
        setNow(Date.now());
      }
    } catch (e) {
      if (!controller.signal.aborted) setError((e as Error).message);
    } finally {
      if (request.current === controller) setBusy(false);
    }
  }
  async function install() {
    if (!result || !answered || invalid || expired || !canInstall || saving || conflict) return;
    setSaving(true);
    setError('');
    try {
      const item = await applyPreview(result, granted, updateId);
      await refresh();
      onDone(item.id);
    } catch (e) {
      setError((e as Error).message);
      setConflict(e instanceof ApiError && e.status === 409);
    } finally {
      setSaving(false);
    }
  }
  return (
    <Card className="p-4 sm:p-6">
      <div className="mb-5 flex items-center gap-3">
        <GitBranch className="size-5 text-ink3" aria-hidden />
        <h2 className="m-0 flex-1 font-serif text-2xl font-normal">
          {updateId
            ? 'Review an update'
            : `Add ${kind === 'pack' ? 'a pack' : 'an agent'} from Git`}
        </h2>
        <Button size="sm" onClick={onCancel} disabled={saving}>
          Close
        </Button>
      </div>
      {!result ? (
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            void inspect();
          }}
        >
          {!updateId && (
            <label className="flex flex-col gap-1.5 text-sm">
              Repository URL
              <input
                autoFocus
                required
                value={draft.url}
                disabled={busy}
                onChange={(e) => setDraft({ ...draft, url: e.target.value })}
                placeholder="https://github.com/your-team/agents.git"
                className={fieldClass}
              />
            </label>
          )}
          {kind === 'agent' && !updateId && (
            <label className="flex flex-col gap-1.5 text-sm">
              Agent ID
              <input
                aria-label="Agent ID"
                required
                value={draft.id}
                pattern="[a-z][a-z0-9-]*/[a-z][a-z0-9-]*"
                disabled={busy}
                onChange={(e) => setDraft({ ...draft, id: e.target.value })}
                placeholder="reviewer/default"
                className={fieldClass}
              />
              <span className="text-xs text-ink3">
                A role and variant, such as reviewer/default.
              </span>
            </label>
          )}
          <div className="grid gap-4 sm:grid-cols-2">
            <label className="flex flex-col gap-1.5 text-sm">
              Git ref
              <input
                value={draft.ref}
                disabled={busy}
                onChange={(e) => setDraft({ ...draft, ref: e.target.value })}
                placeholder="HEAD"
                className={fieldClass}
              />
            </label>
            <label className="flex flex-col gap-1.5 text-sm">
              Path in repository
              <input
                value={draft.path}
                disabled={busy || !!updateId}
                onChange={(e) => setDraft({ ...draft, path: e.target.value })}
                placeholder={kind === 'pack' ? 'packs/my-pack' : 'agents/reviewer'}
                className={fieldClass}
              />
            </label>
          </div>
          {kind === 'agent' && (
            <fieldset className="border-0 p-0">
              <legend className="mb-2 text-sm">
                Secret bindings <span className="text-xs text-ink3">optional</span>
              </legend>
              <p className="text-xs text-ink3">
                Use references already configured on the server. Keep credential values out of this
                form.
              </p>
              <div className="flex flex-col gap-2">
                {bindings.map((row, i) => (
                  <div className="flex flex-wrap gap-2 sm:flex-nowrap" key={i}>
                    <input
                      aria-label={`Variable ${i + 1}`}
                      value={row.name}
                      disabled={busy}
                      placeholder="SERVICE_TOKEN"
                      className={fieldClass}
                      onChange={(e) =>
                        setBindings(
                          bindings.map((r, j) => (j === i ? { ...r, name: e.target.value } : r)),
                        )
                      }
                    />
                    <input
                      aria-label={`Secret reference ${i + 1}`}
                      value={row.ref}
                      disabled={busy}
                      placeholder="service-token"
                      className={fieldClass}
                      onChange={(e) =>
                        setBindings(
                          bindings.map((r, j) => (j === i ? { ...r, ref: e.target.value } : r)),
                        )
                      }
                    />
                    <Button
                      size="sm"
                      disabled={busy}
                      onClick={() => setBindings(bindings.filter((_, j) => i !== j))}
                      aria-label={`Remove binding ${i + 1}`}
                    >
                      Remove
                    </Button>
                  </div>
                ))}
              </div>
              <Button
                size="sm"
                className="mt-2"
                disabled={busy}
                onClick={() => setBindings([...bindings, { name: '', ref: '' }])}
              >
                Add binding
              </Button>
              {bindingError && (
                <p role="alert" className="text-xs text-bad">
                  {bindingError}
                </p>
              )}
            </fieldset>
          )}
          <p className="m-0 text-xs text-ink3">
            {updateId
              ? 'Compare the selected ref with the installed version before applying it.'
              : 'Preview the exact version, tools and access before installing.'}
          </p>
          <div className="flex flex-wrap items-center gap-3">
            <Button
              type="submit"
              variant="primary"
              busy={busy}
              disabled={
                !canPreview ||
                !!bindingError ||
                (!updateId && (!draft.url.trim() || (kind === 'agent' && !draft.id.trim())))
              }
            >
              Preview {updateId ? 'update' : kind}
            </Button>
            {busy && (
              <span role="status" className="text-sm text-ink3">
                Fetching and checking the source…
              </span>
            )}
          </div>
        </form>
      ) : (
        <div className="flex flex-col gap-5">
          <div className="flex flex-wrap items-center gap-2">
            <Badge
              tone={preview!.trust === 'trusted' || preview!.trust === 'verified' ? 'ok' : 'warn'}
            >
              {preview!.trust} source
            </Badge>
            <span className="text-sm text-ink2">
              {result.kind === 'pack'
                ? result.preview.manifest.name
                : (result.preview.definition?.name ?? draft.id)}
            </span>
          </div>
          <dl className="grid gap-3 sm:grid-cols-2">
            <Fact label="Pinned commit">
              <span className="break-all font-mono text-xs" title={preview!.sha}>
                {preview!.sha.slice(0, 12)}
              </span>
            </Fact>
            <Fact label="Review expires">{new Date(preview!.expiresAt).toLocaleTimeString()}</Fact>
          </dl>
          <details className="text-xs text-ink3">
            <summary className="cursor-pointer">Source and review digest</summary>
            <div className="mt-2 break-all font-mono">
              {draft.url}@{draft.ref || 'HEAD'}
              {draft.path && `#${draft.path}`}
              <br />
              {preview!.manifestDigest}
            </div>
          </details>
          {result.kind === 'agent' && result.preview.definition && (
            <div className="text-sm">
              <span className="font-mono">{result.preview.definition.backend.wrapper}</span>
              {result.preview.definition.backend.model &&
                ` · ${result.preview.definition.backend.model}`}
              <p className="text-ink2">{result.preview.definition.description}</p>
              {result.preview.declaredSubAgents.length > 0 && (
                <p className="text-xs text-ink3">
                  Declared peers: {result.preview.declaredSubAgents.map((p) => p.name).join(', ')}.
                  The run’s team determines the active peers.
                </p>
              )}
            </div>
          )}
          {result.kind === 'pack' && !invalid && <TeamPanel pack={result.preview.manifest} />}
          {preview!.issues.length > 0 && (
            <section>
              <h3 className="mb-2 text-sm font-medium">Validation</h3>
              <ul className="m-0 flex list-none flex-col gap-2 p-0">
                {preview!.issues.map((issue, i) => (
                  <li
                    key={i}
                    className={`rounded-lg border p-3 text-sm ${issue.severity === 'error' ? 'border-bad/30 bg-bad/5 text-bad' : 'border-warn/30 bg-warn/5 text-ink2'}`}
                  >
                    <span className="font-mono text-xs">{issue.path}</span>
                    <div>{issue.message}</div>
                  </li>
                ))}
              </ul>
            </section>
          )}
          {preview!.diff && (
            <section>
              <h3 className="mb-2 text-sm font-medium">What changes</h3>
              <ul className="m-0 list-disc pl-5 text-sm text-ink2">
                {preview!.diff.added.map((p) => (
                  <li key={`a${p}`}>Added: {p}</li>
                ))}
                {preview!.diff.removed.map((p) => (
                  <li key={`r${p}`}>Removed: {p}</li>
                ))}
                {preview!.diff.changed.map((p, i) => (
                  <li key={i}>
                    {p.path}: {p.summary}
                  </li>
                ))}
              </ul>
              {!preview!.diff.added.length &&
                !preview!.diff.removed.length &&
                !preview!.diff.changed.length && (
                  <p className="text-sm text-ink3">No configuration changes reported.</p>
                )}
              <p className="text-xs text-ink3">
                {preview!.diff.permissionChanges.length} new or changed permission requests. Review
                the full list below.
              </p>
            </section>
          )}
          {preview!.secretsToBind.length > 0 && (
            <section>
              <h3 className="mb-2 text-sm font-medium">Secret availability</h3>
              <ul className="m-0 list-none p-0">
                {preview!.secretsToBind.map((s) => (
                  <li key={s.ref} className="flex flex-wrap items-center gap-2 py-1 text-sm">
                    <code>{s.ref}</code>
                    <Badge tone={s.bound ? 'ok' : 'warn'}>{s.bound ? 'Bound' : 'Not bound'}</Badge>
                  </li>
                ))}
              </ul>
              <p className="text-xs text-ink3">
                Missing references must be configured on the server before running the agent.
              </p>
            </section>
          )}
          <section>
            <div className="mb-3 flex items-center gap-2">
              <ShieldCheck className="size-4 text-ink3" aria-hidden />
              <h3 className="m-0 text-sm font-medium">Review access</h3>
            </div>
            <Permissions
              permissions={preview!.permissions}
              granted={granted}
              onChange={setGranted}
            />
            <p className="mt-3 text-xs text-ink3">
              Each requested permission needs your consent. A declined request prevents
              installation.
            </p>
          </section>
          {expired && (
            <p role="alert" className="text-sm text-bad">
              This preview has expired. Preview the source again.
            </p>
          )}
          {!canInstall && (
            <p className="text-sm text-ink2">An administrator can install this preview.</p>
          )}
          <div className="flex flex-wrap items-center gap-3">
            <Button
              variant="primary"
              busy={saving}
              disabled={!canInstall || !answered || !!invalid || expired || conflict}
              onClick={() => void install()}
            >
              {updateId ? 'Apply reviewed update' : `Install ${kind}`}
            </Button>
            <Button
              disabled={saving}
              onClick={() => {
                setResult(undefined);
                setGranted([]);
                setError('');
                setConflict(false);
              }}
            >
              <ArrowLeft className="size-3.5" aria-hidden />
              {expired || conflict ? 'Preview again' : 'Edit source'}
            </Button>
            <span className="text-xs text-ink3">
              {granted.length} of {preview!.permissions.length} permissions allowed
            </span>
          </div>
        </div>
      )}
      {error && (
        <p role="alert" className="mt-4 break-words text-sm text-bad">
          {error}
        </p>
      )}
    </Card>
  );
}
