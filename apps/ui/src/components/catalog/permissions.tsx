import type { PermissionRequest } from '@kramahq/contract';
import { Badge, Card } from '@/components/ui/primitives';

const groups = [
  ['Tools', ['mcp_server', 'tool']],
  ['Filesystem access', ['workspace']],
  ['Secret references', ['secret_ref']],
  ['Memory scopes', ['memory_scope']],
  ['Scripts', ['script_execution']],
  ['Sources and external hosts', ['network']],
] as const;
export function Permissions({
  permissions,
  granted,
  onChange,
}: {
  permissions: PermissionRequest[];
  granted?: string[];
  onChange?: (ids: string[]) => void;
}) {
  return (
    <div className="flex flex-col gap-4">
      {groups.map(([title, kinds]) => {
        const items = permissions.filter((p) => (kinds as readonly string[]).includes(p.kind));
        if (!items.length) return null;
        return (
          <section key={title}>
            <h3 className="mb-2 text-sm font-medium">{title}</h3>
            <div className="flex flex-col gap-2">
              {items.map((p) => (
                <Card key={p.id} className="p-3">
                  <label className="flex items-start gap-3">
                    {onChange && (
                      <input
                        type="checkbox"
                        className="mt-1 shrink-0 accent-[var(--ink)]"
                        checked={granted?.includes(p.id) ?? false}
                        onChange={(e) =>
                          onChange(
                            e.target.checked
                              ? [...(granted ?? []), p.id]
                              : (granted ?? []).filter((id) => id !== p.id),
                          )
                        }
                        aria-label={`Allow ${p.subject} (${p.kind})`}
                      />
                    )}
                    <span className="min-w-0 flex-1">
                      <span className="flex flex-wrap items-center gap-2">
                        <span className="break-all font-mono text-xs">{p.subject}</span>
                        <Badge tone={p.risk === 'high' ? 'warn' : 'neutral'}>{p.risk} risk</Badge>
                      </span>
                      {p.access && (
                        <span className="mt-1 block break-words text-sm text-ink2">{p.access}</span>
                      )}
                      {p.reason && (
                        <span className="mt-1 block break-words text-xs text-ink3">{p.reason}</span>
                      )}
                      <span className="mt-1 block text-xs text-ink3">
                        Requested by {p.requestedBy}
                      </span>
                    </span>
                  </label>
                </Card>
              ))}
            </div>
          </section>
        );
      })}
      {permissions.length === 0 && (
        <p className="text-sm text-ink3">No additional permissions are declared.</p>
      )}
    </div>
  );
}
